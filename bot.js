'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');

// ===========================================================================
// CONFIG
// ===========================================================================
const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.MC_PORT, 10) || 25565,
  baseUsername: process.env.MC_USERNAME || 'CloudBot',
  password: '',
  threads: Number.parseInt(process.env.THREADS, 10) || 1,
  joinDelay: 3,
  version: '1.21.11', // USER REQUESTED: 1.21.11
  clientBrand: 'vanilla',
  autoEatThreshold: 18,
  discordToken: process.env.DISCORD_TOKEN || '',
  discordChannel: process.env.DISCORD_CHANNEL || ''
};

const state = {
  cameraEnabled: true,
  autoEatEnabled: true,
  autoRespawnEnabled: true,
  antiAfkEnabled: false,
  bypassEnabled: true
};

const bots = [];
let manualDisconnect = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function getPrimaryBot() {
  return bots.find(b => b && b.entity) || bots[0] || null;
}

// ===========================================================================
// DISCORD BOT
// ===========================================================================
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

if (CONFIG.discordToken) {
  discordClient.login(CONFIG.discordToken).catch(err => {
    log(`[!] Discord login failed: ${err.message}`);
  });
} else {
  log('[!] No Discord token provided. Running without Discord integration.');
}

discordClient.on('ready', () => {
  log(`[+] Discord bot online as ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!CONFIG.discordChannel || message.channel.id !== CONFIG.discordChannel) return;

  const raw = message.content.trim();
  if (!raw) return;

  if (raw.startsWith('.')) {
    await handleCommand(raw.slice(1).trim(), message);
    return;
  }

  bots.forEach(bot => {
    if (bot && bot.entity) {
      try {
        bot.chat(raw);
      } catch (err) {
        log(`[!] Failed to relay Discord chat to ${bot.username}: ${err.message}`);
      }
    }
  });

  try {
    await message.react('💬');
  } catch (_) {}
});

function sendToDiscord(msg) {
  if (!CONFIG.discordChannel) return;
  if (!discordClient.isReady || !discordClient.isReady()) return;

  const channel = discordClient.channels.cache.get(CONFIG.discordChannel);
  if (!channel) return;

  channel.send(`\`[Minecraft]\` ${msg}`).catch(() => {});
}

// ===========================================================================
// MINEFLAYER BOT CREATION
// ===========================================================================
function createBot(botName) {
  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: botName,
    auth: 'offline',
    version: CONFIG.version, // Dynamic config version (1.21.11)
    respawn: false,
    hideErrors: false,
    brand: CONFIG.clientBrand
  });

  bot.loadPlugin(pathfinder);
  bot._timers = [];
  bot._autoLogin = {
    loginSent: false,
    registerSent: false,
    lastAt: 0
  };
  bot._isCleaningUp = false;

  bots.push(bot);
  log(`[~] Connecting ${botName} -> ${CONFIG.host}:${CONFIG.port} with version ${CONFIG.version}`);

  bot.once('spawn', () => {
    log(`[+] ${bot.username} joined successfully`);
    sendToDiscord(`🟩 **${bot.username}** joined **${CONFIG.host}:${CONFIG.port}**`);

    const moves = new Movements(bot);
    moves.allowSprinting = false;
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);

    startAntiNaNLoop(bot);
    startHumanCamera(bot);
    startAntiAfk(bot);
    startSonarBypass(bot);
    setupAutoEat(bot);
  });

  bot.on('messagestr', async (message) => {
    log(`[CHAT:${bot.username}] ${message}`);
    sendToDiscord(`**${bot.username}:** ${message}`);
    await handleAutoLogin(bot, message);
  });

  bot.on('kicked', reason => {
    const readable = safeReason(reason);
    log(`[!] ${bot.username} kicked: ${readable}`);
    sendToDiscord(`🟥 **${bot.username}** kicked: ${readable}`);
  });

  bot.on('error', err => {
    log(`[!] ${bot.username} error: ${safeReason(err)}`);
  });

  bot.on('death', () => {
    sendToDiscord(`💀 **${bot.username}** died.`);
    if (!state.autoRespawnEnabled) return;

    setTimeout(() => {
      try {
        bot.respawn();
      } catch (_) {}
    }, 1500);
  });

  bot.on('end', reason => {
    const readable = safeReason(reason);
    log(`[!] ${bot.username} disconnected: ${readable}`);
    sendToDiscord(`🟥 **${bot.username}** disconnected: ${readable}`);
    cleanupBot(bot);

    if (manualDisconnect) return;

    setTimeout(() => {
      createBot(botName);
    }, CONFIG.joinDelay * 1000);
  });

  return bot;
}

async function handleAutoLogin(bot, message) {
  if (!CONFIG.password) return;
  if (!message) return;

  const msg = String(message).toLowerCase();
  const now = Date.now();

  if (now - bot._autoLogin.lastAt < 2500) return;

  const needsRegister = [
    '/register', 'register with', 'please register',
    'use /register', 'register <password>', 'registrarse', 'registre-se'
  ].some(x => msg.includes(x));

  const needsLogin = [
    '/login', 'login with', 'please login',
    'use /login', 'log in with', 'logue-se'
  ].some(x => msg.includes(x));

  try {
    if (needsRegister && !bot._autoLogin.registerSent) {
      bot._autoLogin.lastAt = now;
      bot._autoLogin.registerSent = true;
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`);
      sendToDiscord(`🔐 **${bot.username}** auto-register command sent.`);
      await wait(1200);
      bot.chat(`/login ${CONFIG.password}`);
      sendToDiscord(`🔓 **${bot.username}** auto-login command sent after register.`);
      return;
    }

    if (needsLogin && !bot._autoLogin.loginSent) {
      bot._autoLogin.lastAt = now;
      bot._autoLogin.loginSent = true;
      bot.chat(`/login ${CONFIG.password}`);
      sendToDiscord(`🔓 **${bot.username}** auto-login command sent.`);
    }
  } catch (err) {
    log(`[!] Auto-login failed for ${bot.username}: ${err.message}`);
  }
}

function cleanupBot(bot) {
  if (!bot || bot._isCleaningUp) return;
  bot._isCleaningUp = true;

  if (Array.isArray(bot._timers)) {
    for (const timer of bot._timers) clearInterval(timer);
    bot._timers.length = 0;
  }

  const index = bots.indexOf(bot);
  if (index !== -1) bots.splice(index, 1);
}

function registerInterval(bot, fn, ms) {
  const timer = setInterval(fn, ms);
  bot._timers.push(timer);
  return timer;
}

function reconnectAll(reasonText) {
  manualDisconnect = true;
  sendToDiscord(`🔄 Reconnecting bots... ${reasonText}`);

  const snapshot = [...bots];
  snapshot.forEach(bot => {
    try {
      bot.quit(reasonText);
    } catch (_) {}
    cleanupBot(bot);
  });

  bots.length = 0;

  setTimeout(() => {
    manualDisconnect = false;
    for (let i = 0; i < CONFIG.threads; i++) {
      setTimeout(() => {
        const name = CONFIG.threads > 1
          ? `${CONFIG.baseUsername}_${Math.random().toString(36).slice(2, 6)}`
          : CONFIG.baseUsername;
        createBot(name);
      }, i * CONFIG.joinDelay * 1000);
    }
  }, 2000);
}

// ===========================================================================
// FEATURES
// ===========================================================================
function startAntiNaNLoop(bot) {
  bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      p.set(0, 64, 0);
    }
  });
}

function setupAutoEat(bot) {
  let eating = false;

  bot.on('physicsTick', async () => {
    if (!state.autoEatEnabled || eating || !bot.entity) return;
    if (typeof bot.food !== 'number' || bot.food >= CONFIG.autoEatThreshold) return;

    const food = bot.inventory.items().find(item => {
      if (!item?.name) return false;
      const name = item.name.toLowerCase();
      return [
        'apple', 'carrot', 'bread', 'potato', 'baked_potato', 'beef',
        'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken',
        'cooked_chicken', 'melon', 'steak', 'mutton', 'cooked_mutton'
      ].some(x => name.includes(x));
    });

    if (!food) return;

    eating = true;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
    } catch (_) {
      // ignore
    } finally {
      eating = false;
    }
  });
}

function startAntiAfk(bot) {
  registerInterval(bot, () => {
    if (!state.antiAfkEnabled || !bot.entity) return;

    bot.setControlState('jump', true);
    setTimeout(() => {
      try {
        bot.setControlState('jump', false);
      } catch (_) {}
    }, 250);
  }, 45000);
}

function startHumanCamera(bot) {
  registerInterval(bot, () => {
    if (!state.cameraEnabled || !bot.entity) return;

    const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.25;
    const pitch = Math.max(-0.35, Math.min(0.35, bot.entity.pitch + (Math.random() - 0.5) * 0.08));
    bot.look(yaw, pitch, true).catch(() => {});
  }, 7000);
}

function startSonarBypass(bot) {
  registerInterval(bot, () => {
    if (!state.bypassEnabled || !bot.entity) return;

    bot.setControlState('sneak', true);
    setTimeout(() => {
      try {
        bot.setControlState('sneak', false);
      } catch (_) {}
    }, 180);
  }, 30000 + Math.floor(Math.random() * 15000)); 

  registerInterval(bot, () => {
    if (!state.bypassEnabled || !bot.entity) return;

    try {
      bot.swingArm('right');
    } catch (_) {}
  }, 45000 + Math.floor(Math.random() * 20000)); 
}

// ===========================================================================
// DISCORD COMMANDS
// ===========================================================================
async function handleCommand(body, discordMsg) {
  const parts = body.split(/\s+/).filter(Boolean);
  const cmd = (parts.shift() || '').toLowerCase();
  const args = parts;
  const currentBot = getPrimaryBot();

  const reply = async text => {
    if (discordMsg) {
      try {
        await discordMsg.reply(text);
      } catch (_) {}
    }
    log(`[Cmd Reply] ${text}`);
  };

  switch (cmd) {
    case 'connect': {
      const newIp = args[0];
      const newPort = Number.parseInt(args[1], 10) || 25565;
      if (!newIp) return reply('❌ Usage: `.connect <ip> [port]`');

      CONFIG.host = newIp;
      CONFIG.port = newPort;
      await reply(`🔄 Reconnecting to **${CONFIG.host}:${CONFIG.port}** with version **${CONFIG.version}**`);
      reconnectAll(`manual reconnect to ${CONFIG.host}:${CONFIG.port}`);
      break;
    }

    case 'name': {
      const newName = args[0];
      if (!newName) return reply('❌ Usage: `.name <new_name>`');

      CONFIG.baseUsername = newName;
      await reply(`✅ Username updated to **${CONFIG.baseUsername}**. Reconnecting now...`);
      reconnectAll(`username changed to ${CONFIG.baseUsername}`);
      break;
    }

    case 'password': {
      const newPass = args[0];
      if (!newPass) return reply('❌ Usage: `.password <password>`');

      CONFIG.password = newPass;
      await reply('✅ Auto-login password saved in memory. The bot will now use `/register` or `/login` automatically when prompted.');
      break;
    }

    case 'status': {
      if (!currentBot || !currentBot.entity) {
        return reply('❌ Bot is not currently online in Minecraft.');
      }

      const pos = currentBot.entity.position;
      const statusEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('🤖 Bot Status')
        .addFields(
          { name: 'Username', value: currentBot.username || 'Unknown', inline: true },
          { name: 'Health', value: `${Math.round(currentBot.health ?? 0)} / 20`, inline: true },
          { name: 'Food', value: `${Math.round(currentBot.food ?? 0)} / 20`, inline: true },
          { name: 'Coordinates', value: `X: ${Math.floor(pos.x)} | Y: ${Math.floor(pos.y)} | Z: ${Math.floor(pos.z)}`, inline: false },
          { name: 'Server', value: `${CONFIG.host}:${CONFIG.port}`, inline: false },
          { name: 'Version', value: CONFIG.version, inline: true }
        )
        .setTimestamp();

      await discordMsg.channel.send({ embeds: [statusEmbed] });
      break;
    }

    case 'inv': {
      if (!currentBot || !currentBot.entity) {
        return reply('❌ Bot is not currently online in Minecraft.');
      }

      const items = currentBot.inventory.items();
      let invText = items.length
        ? items.map(item => `${item.count}x ${item.displayName}`).join('\n')
        : 'Inventory is empty.';

      if (invText.length > 3800) invText = `${invText.slice(0, 3800)}\n...`;

      const invEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`🎒 Inventory - ${currentBot.username}`)
        .setDescription(`\`\`\`\n${invText}\n\`\`\``)
        .setTimestamp();

      await discordMsg.channel.send({ embeds: [invEmbed] });
      break;
    }

    case 'help': {
      const helpEmbed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🎮 Discord Commands')
        .setDescription([
          '`.connect <ip> [port]` - change server and reconnect',
          '`.name <new_name>` - change Minecraft username and reconnect',
          '`.password <password>` - store auto-login password in memory',
          '`.status` - show bot health, food and coordinates',
          '`.inv` - show current inventory',
          '',
          'Any message without a dot is forwarded to Minecraft chat.'
        ].join('\n'));

      await discordMsg.channel.send({ embeds: [helpEmbed] });
      break;
    }

    default:
      await reply('❌ Unknown command. Use `.help` to view available commands.');
  }
}

// ===========================================================================
// STARTUP
// ===========================================================================
log(`[+] Starting ${CONFIG.threads} bot instance(s)...`);
for (let i = 0; i < CONFIG.threads; i++) {
  setTimeout(() => {
    const name = CONFIG.threads > 1
      ? `${CONFIG.baseUsername}_${Math.random().toString(36).slice(2, 6)}`
      : CONFIG.baseUsername;
    createBot(name);
  }, i * CONFIG.joinDelay * 1000);
}

// ===========================================================================
// SIMPLE WEB SERVER FOR HOSTING PLATFORMS
// ===========================================================================
const app = express();
app.get('/', (_req, res) => res.send('Bot is online and running.'));
app.listen(process.env.PORT || 3000, () => {
  log('[+] Web server started for cloud hosting.');
});
