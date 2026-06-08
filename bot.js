'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalFollow } } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');

// ===========================================================================
// CONFIGURATION (Rule 5: Let used for safe mutability)
// ===========================================================================
let CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.MC_PORT, 10) || 25565,
  baseUsername: process.env.MC_USERNAME || 'CloudBot',
  password: '', 
  threads: Number.parseInt(process.env.THREADS, 10) || 1,
  joinDelay: 3,
  version: false, // AUTO-DETECT
  clientBrand: 'mcc', 
  autoEatThreshold: 19, 
  attackReach: 3.5, 
  prefix: '.', 
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
let manualDisconnect = true; 
let isConnecting = false; 
const MAX_RECONNECTS = 5;

const EDIBLE_FOODS = [
  'golden_carrot', 'golden_apple', 'enchanted_golden_apple', 'steak', 
  'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_beef',
  'carrot', 'potato', 'baked_potato', 'bread', 'cooked_chicken', 
  'cooked_cod', 'cooked_rabbit', 'mushroom_stew', 'rabbit_stew', 
  'beetroot_soup', 'apple', 'melon_slice', 'sweet_berries', 
  'glow_berries', 'dried_kelp'
];

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function safeReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

function getPrimaryBot() {
  return bots.find(b => b && b.entity) || bots[0] || null;
}

// ===========================================================================
// DISCORD BOT SETUP
// ===========================================================================
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

if (CONFIG.discordToken) {
  discordClient.login(CONFIG.discordToken).catch(err => log(`[!] Discord login failed: ${err.message}`));
}

discordClient.on('ready', () => log(`[+] Discord bot online as ${discordClient.user.tag}. Waiting for ${CONFIG.prefix}connect command...`));

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!CONFIG.discordChannel || message.channel.id !== CONFIG.discordChannel) return;

  const raw = message.content.trim();
  if (!raw) return;

  if (raw.startsWith(CONFIG.prefix)) {
    await handleCommand(raw.slice(CONFIG.prefix.length).trim(), message);
    return;
  }

  bots.forEach(bot => {
    if (bot && bot.entity) {
      try { bot.chat(raw); } catch (err) { log(`[!] Chat relay failed: ${err.message}`); }
    }
  });
  try { await message.react('💬'); } catch (_) {}
});

function sendToDiscord(msg, isRaw = false) {
  if (!CONFIG.discordChannel || !discordClient.isReady()) return;
  const channel = discordClient.channels.cache.get(CONFIG.discordChannel);
  if (channel) {
    channel.send(isRaw ? msg : `\`[Minecraft]\` ${msg}`).catch(() => {});
  }
}

// ===========================================================================
// MINEFLAYER BOT CREATION & LOGIC
// ===========================================================================
function createBot(botName, attempt = 0) {
  const bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: botName,
    auth: 'offline', version: CONFIG.version, respawn: false,
    hideErrors: false, brand: CONFIG.clientBrand
  });

  bot.loadPlugin(pathfinder);
  bot._timers = [];
  bot._cameraTimer = null; 
  bot._autoLogin = { loginSent: false, registerSent: false, lastAt: 0 };
  bot._isCleaningUp = false;
  bot._lastHealth = 20; 
  bot._lastDamageTime = 0;
  bot._isPanicEating = false;
  bot._attackLoopActive = false; 
  bot._strafing = false; 
  bot._attackIdleCycles = 0; 

  bots.push(bot);
  log(`[~] Connecting ${botName} -> ${CONFIG.host}:${CONFIG.port} (Attempt ${attempt + 1}/${MAX_RECONNECTS})`);

  bot.once('spawn', () => {
    attempt = 0; 
    bot._lastHealth = 20;
    bot._lastDamageTime = 0;
    bot._isPanicEating = false;
    bot._attackLoopActive = false;
    bot._strafing = false;
    bot._attackIdleCycles = 0;
    log(`[+] ${bot.username} joined successfully`);
    sendToDiscord(`🟩 **${bot.username}** joined **${CONFIG.host}:${CONFIG.port}**`);

    const moves = new Movements(bot);
    moves.allowSprinting = true; moves.canDig = false;
    bot.pathfinder.setMovements(moves);

    startAntiNaNLoop(bot);
    startHumanCamera(bot); 
    startAntiAfk(bot);
    startSonarBypass(bot);
    setupAutoEat(bot);
  });

  bot.on('message', async (jsonMsg) => {
    const rawStr = jsonMsg.toString();
    if (!rawStr || !rawStr.trim()) return;

    log(`[CHAT:${bot.username}] ${rawStr}`);

    const ansiStr = jsonMsg.toAnsi();
    sendToDiscord(`\`\`\`ansi\n${ansiStr}\n\`\`\``, true);

    await handleAutoLogin(bot, rawStr);
  });

  bot.on('health', async () => {
    if (bot.health < bot._lastHealth - 0.5) {
      const damageTime = Date.now(); 

      // Randomized Damage Reaction
      try {
        bot.setControlState('back', true);
        const reactionTime = 200 + Math.random() * 500; 
        setTimeout(() => {
          try { bot.setControlState('back', false); } catch (_) {}
        }, reactionTime);

        bot.look(
          bot.entity.yaw + (Math.random() - 0.5) * 0.3,
          bot.entity.pitch,
          true
        ).catch(() => {});
      } catch (_) {}

      // Panic eating isolation epoch verification
      if (bot.health <= 6 && !bot._isPanicEating && state.autoEatEnabled && (damageTime - bot._lastDamageTime > 1500)) {
        bot._isPanicEating = true;
        try {
          const emergencyFood = bot.inventory.items().find(item => 
            item?.name && EDIBLE_FOODS.slice(0, 3).some(f => item.name.toLowerCase().includes(f))
          ) || bot.inventory.items().find(item => 
            item?.name && EDIBLE_FOODS.some(f => item.name.toLowerCase().includes(f))
          );

          if (emergencyFood) {
            sendToDiscord(`🚨 **Emergency Eat:** \`${bot.username}\` is low on health! Panic eating ${emergencyFood.displayName}...`);
            await bot.equip(emergencyFood, 'hand');
            await bot.consume();
          }
        } catch (_) {} finally {
          bot._isPanicEating = false;
        }
      }

      if (bot.health < 10) { 
        sendToDiscord(`⚠️ **ALERT:** \`${bot.username}\` is taking severe damage! Health: ${Math.round(bot.health)}/20 ❤️`);
      }

      bot._lastDamageTime = damageTime; 
    }
    bot._lastHealth = bot.health;
  });

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (bot._strafing) return; 

    try {
      const attacker = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.id !== bot.entity.id && bot.entity.position.distanceTo(e.position) < 7);
      if (attacker) {
        bot.lookAt(attacker.position.offset(0, attacker.height, 0), true).catch(() => {});

        bot._strafing = true;
        const strafeDir = Math.random() > 0.5 ? 'left' : 'right';
        bot.setControlState(strafeDir, true);
        setTimeout(() => {
          try { bot.setControlState(strafeDir, false); } catch (_) {}
          bot._strafing = false; 
        }, 300 + Math.random() * 300);
      }
    } catch (_) {}
  });

  bot.on('kicked', reason => {
    log(`[!] ${bot.username} kicked: ${safeReason(reason)}`);
    sendToDiscord(`🟥 **${bot.username}** kicked: ${safeReason(reason)}`);
  });

  bot.on('error', err => {
    log(`[!] ${bot.username} error: ${safeReason(err)}`);
  });

  bot.on('death', () => {
    sendToDiscord(`💀 **${bot.username}** died.`);
    bot._attackLoopActive = false; 
    if (state.autoRespawnEnabled) setTimeout(() => { try { bot.respawn(); } catch (_) {} }, 1500);
  });

  bot.on('end', reason => {
    log(`[!] ${bot.username} disconnected: ${safeReason(reason)}`);
    sendToDiscord(`🟥 **${bot.username}** disconnected: ${safeReason(reason)}`);
    cleanupBot(bot);

    if (!manualDisconnect) {
      attempt++;
      if (attempt >= MAX_RECONNECTS) {
        log(`[!] Max reconnect attempts reached for ${bot.username}. Stopping auto-reconnect.`);
        sendToDiscord(`🚨 **Emergency Stop:** \`${bot.username}\` reached max retries (${MAX_RECONNECTS}/${MAX_RECONNECTS}). Auto-reconnect disabled.`);
      } else {
        setTimeout(() => createBot(botName, attempt), CONFIG.joinDelay * 1000);
      }
    }
  });

  return bot;
}

// ===========================================================================
// AUTO-LOGIN SYSTEM
// ===========================================================================
async function handleAutoLogin(bot, message) {
  if (!CONFIG.password || !message) return;
  const msg = String(message).toLowerCase();
  const now = Date.now();

  if (now - bot._autoLogin.lastAt < 2500) return;

  const needsRegister = ['/register', 'register with', 'please register', 'register <password>'].some(x => msg.includes(x));
  const needsLogin = ['/login', 'login with', 'please login'].some(x => msg.includes(x));

  try {
    if (needsRegister && !bot._autoLogin.registerSent) {
      bot._autoLogin.lastAt = now; bot._autoLogin.registerSent = true;
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`);
      sendToDiscord(`🔐 Auto-registering...`);
      await wait(1200);
      bot.chat(`/login ${CONFIG.password}`);
      return;
    }

    if (needsLogin && !bot._autoLogin.loginSent) {
      bot._autoLogin.lastAt = now; bot._autoLogin.loginSent = true;
      bot.chat(`/login ${CONFIG.password}`);
      sendToDiscord(`🔓 Auto-login command sent.`);
    }
  } catch (err) {}
}

function cleanupBot(bot) {
  if (!bot || bot._isCleaningUp) return;
  bot._isCleaningUp = true;
  for (const timer of bot._timers) clearInterval(timer);
  bot._timers.length = 0;

  if (bot._cameraTimer) clearTimeout(bot._cameraTimer); 

  bot._attackLoopActive = false;
  bot._strafing = false;

  const index = bots.indexOf(bot);
  if (index !== -1) bots.splice(index, 1);
}

function registerInterval(bot, fn, ms) {
  const timer = setInterval(fn, ms);
  bot._timers.push(timer);
}

function reconnectAll(reasonText) {
  manualDisconnect = true;
  sendToDiscord(`⏳ Disconnecting... ${reasonText}. Waiting 10 seconds to clear ghost players...`);
  [...bots].forEach(bot => { try { bot.quit(reasonText); } catch (_) {} cleanupBot(bot); });
  bots.length = 0;

  setTimeout(() => {
    manualDisconnect = false;
    sendToDiscord(`🚀 Reconnecting now...`);
    for (let i = 0; i < CONFIG.threads; i++) {
      const name = CONFIG.threads > 1 ? `${CONFIG.baseUsername}_${Math.random().toString(36).slice(2, 6)}` : CONFIG.baseUsername;
      setTimeout(() => createBot(name, 0), i * CONFIG.joinDelay * 1000);
    }
  }, 10000); 
}

// ===========================================================================
// FEATURES 
// ===========================================================================
function startAntiNaNLoop(bot) {
  bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) p.set(0, 64, 0);
  });
}

function setupAutoEat(bot) {
  let eating = false;
  bot.on('physicsTick', async () => {
    if (!state.autoEatEnabled || eating || !bot.entity || bot.food >= CONFIG.autoEatThreshold || bot._isPanicEating) return;
    
    const food = bot.inventory.items().find(item => 
      item?.name && EDIBLE_FOODS.some(foodName => item.name.toLowerCase().includes(foodName))
    );
    if (!food) return;

    eating = true;
    try { await bot.equip(food, 'hand'); await bot.consume(); } catch (_) {} finally { eating = false; }
  });
}

function startAntiAfk(bot) {
  registerInterval(bot, () => {
    if (state.antiAfkEnabled && bot.entity) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 250);
    }
  }, 45000);
}

function startHumanCamera(bot) {
  const cameraRoutine = () => {
    if (manualDisconnect || bots.indexOf(bot) === -1) return;
    
    // FIX 3: Stochastic skip simulation (15% chance to replicate human gaze distraction)
    if (Math.random() < 0.15) {
      const nextInterval = 5000 + Math.random() * 6000;
      bot._cameraTimer = setTimeout(cameraRoutine, nextInterval);
      return;
    }

    if (state.cameraEnabled && bot.entity) {
      if (!bot._lastDamageTime || (Date.now() - bot._lastDamageTime >= 3000)) {
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.25;
        const pitch = Math.max(-0.35, Math.min(0.35, bot.entity.pitch + (Math.random() - 0.5) * 0.08));
        bot.look(yaw, pitch, true).catch(() => {});
      }
    }
    
    const nextInterval = 5000 + Math.random() * 6000; 
    bot._cameraTimer = setTimeout(cameraRoutine, nextInterval);
  };
  
  cameraRoutine();
}

function startSonarBypass(bot) {
  registerInterval(bot, () => {
    if (state.bypassEnabled && bot.entity) {
      bot.setControlState('sneak', true);
      setTimeout(() => { try { bot.setControlState('sneak', false); } catch (_) {} }, 180);
    }
  }, 30000 + Math.floor(Math.random() * 15000)); 

  registerInterval(bot, () => {
    if (state.bypassEnabled && bot.entity) { try { bot.swingArm('right'); } catch (_) {} }
  }, 45000 + Math.floor(Math.random() * 20000)); 
}

// ===========================================================================
// DISCORD COMMAND HANDLER
// ===========================================================================
async function handleCommand(body, discordMsg) {
  const parts = body.split(/\s+/).filter(Boolean);
  const cmd = (parts.shift() || '').toLowerCase();
  const args = parts;
  const currentBot = getPrimaryBot();

  const reply = async text => {
    if (discordMsg) try { await discordMsg.reply(text); } catch (_) {}
    log(`[Cmd Reply] ${text}`);
  };

  switch (cmd) {
    case 'connect':
      if (isConnecting) return reply('⏳ Connection process already active. Please wait!');
      
      isConnecting = true;
      try {
        const newIp = args[0] || CONFIG.host;
        const newPort = Number.parseInt(args[1], 10) || CONFIG.port;
        
        CONFIG.host = newIp; 
        CONFIG.port = newPort;
        manualDisconnect = false;

        if (bots.length > 0) {
          await reply('⏳ Cleaning up previous instances. Waiting 10s for ghost-player protection...');
          [...bots].forEach(b => { try { b.quit(); } catch (_) {} cleanupBot(b); });
          bots.length = 0;
          await wait(10000); 
        }

        await reply(`🚀 Connecting to **${CONFIG.host}:${CONFIG.port}**...`);
        for (let i = 0; i < CONFIG.threads; i++) {
          const name = CONFIG.threads > 1 ? `${CONFIG.baseUsername}_${Math.random().toString(36).slice(2, 6)}` : CONFIG.baseUsername;
          setTimeout(() => createBot(name, 0), i * CONFIG.joinDelay * 1000);
        }
      } finally {
        isConnecting = false; 
      }
      break;

    case 'quit':
    case 'disconnect':
      if (bots.length === 0) return reply('❌ Bot is already offline.');
      manualDisconnect = true; 
      [...bots].forEach(b => { 
        try { b.quit('Disconnected by Master Remote'); } catch (_) {} 
        if (b.pathfinder) b.pathfinder.setGoal(null); // Clear targets on hard stop
        cleanupBot(b); 
      });
      bots.length = 0;
      await reply(`🛑 Bot disconnected. Use \`${CONFIG.prefix}connect\` to join.`);
      break;

    case 'name':
      if (!args[0]) return reply(`❌ Usage: \`${CONFIG.prefix}name <new_name>\``);
      CONFIG.baseUsername = args[0];
      if (bots.length === 0) {
        await reply(`✅ Username updated to **${CONFIG.baseUsername}**.`);
      } else {
        await reply(`✅ Username updated to **${CONFIG.baseUsername}**. Reconnecting...`);
        reconnectAll(`username changed`);
      }
      break;

    case 'password':
      if (!args[0]) return reply(`❌ Usage: \`${CONFIG.prefix}password <password>\``);
      CONFIG.password = args[0];
      await reply('✅ Auto-login password saved!');
      break;

    case 'mc':
    case 'chat':
      const textToSay = args.join(' ');
      if (!textToSay) return reply(`❌ Usage: \`${CONFIG.prefix}mc <text/command>\``);
      bots.forEach(b => { if (b && b.entity) b.chat(textToSay); });
      await discordMsg.react('✅');
      break;

    case 'experimentalgravity':
      const toggle = (args[0] || 'on').toLowerCase();
      if (toggle === 'off') {
        bots.forEach(b => { if (b.physics) b.physics.gravity = 0; });
        await reply('🛸 **[Experimental] Anti-Gravity ON:** Fall damage bypassed!');
      } else {
        bots.forEach(b => { if (b.physics) b.physics.gravity = 0.08; }); 
        await reply('🌍 **Gravity ON:** Back to normal physics.');
      }
      break;

    case 'status':
      if (!currentBot || !currentBot.entity) return reply('❌ Bot is not currently online in Minecraft.');
      const pos = currentBot.entity.position;
      const statusEmbed = new EmbedBuilder()
        .setColor(0x2ecc71).setTitle('🤖 Bot Status')
        .addFields(
          { name: 'Username', value: currentBot.username || 'Unknown', inline: true },
          { name: 'Health', value: `${Math.round(currentBot.health ?? 0)} / 20 ❤️`, inline: true },
          { name: 'Food', value: `${Math.round(currentBot.food ?? 0)} / 20 🍖`, inline: true },
          { name: 'Location', value: `X: ${Math.floor(pos.x)} | Y: ${Math.floor(pos.y)} | Z: ${Math.floor(pos.z)} 📍`, inline: false },
          { name: 'Server', value: `${CONFIG.host}:${CONFIG.port}`, inline: true },
          { name: 'Threads', value: `${bots.length}/${CONFIG.threads}`, inline: true }
        ).setTimestamp();
      await discordMsg.channel.send({ embeds: [statusEmbed] });
      break;

    case 'inv':
      if (!currentBot || !currentBot.entity) return reply('❌ Bot is not currently online in Minecraft.');
      const items = currentBot.inventory.items();
      let invText = items.length ? items.map(item => `${item.count}x ${item.displayName}`).join('\n') : 'Inventory is empty...';
      if (invText.length > 3800) invText = `${invText.slice(0, 3800)}\n...`;
      const invEmbed = new EmbedBuilder()
        .setColor(0x3498db).setTitle(`🎒 Inventory - ${currentBot.username}`)
        .setDescription(`\`\`\`\n${invText}\n\`\`\``).setTimestamp();
      await discordMsg.channel.send({ embeds: [invEmbed] });
      break;

    case 'move':
      const subMove = (args[0] || '').toLowerCase();
      if (subMove === 'stop') { 
        bots.forEach(b => { b.clearControlStates(); if (b.pathfinder) b.pathfinder.setGoal(null); });
        await reply('🛑 All bots stopped moving.');
      } else if (subMove === 'forward') {
        bots.forEach(b => { if (b.entity) b.setControlState('forward', true); });
        await reply('⬆️ Moving forward!');
      } else {
        const x = parseFloat(args[0]), y = parseFloat(args[1]), z = parseFloat(args[2]);
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          bots.forEach(b => { if (b.pathfinder) b.pathfinder.setGoal(new GoalBlock(x, y, z)); });
          await reply(`🚶 Pathfinding to X: ${x}, Y: ${y}, Z: ${z}`);
        } else {
          await reply(`❌ Usage: \`${CONFIG.prefix}move forward\` | \`${CONFIG.prefix}move stop\` | \`${CONFIG.prefix}move <x> <y> <z>\``);
        }
      }
      break;

    case 'attack':
      const subArg = (args[0] || '').toLowerCase();
      if (subArg === 'stop') {
        // FIX 2: Safely break attack loop AND instantly drop active pathfinder goals/controls across threads
        bots.forEach(b => { 
          b._attackLoopActive = false; 
          try {
            if (b.pathfinder) b.pathfinder.setGoal(null);
            b.clearControlStates();
          } catch (_) {}
        });
        await reply('🛑 Combat execution loop terminated and navigation targets purged.');
        break;
      }

      bots.forEach(async (b) => {
        if (!b.entity) return;
        if (b._attackLoopActive) return; 
        
        b._attackLoopActive = true;
        
        const attackRoutine = async () => {
          if (manualDisconnect || bots.indexOf(b) === -1 || !b._attackLoopActive) {
            b._attackLoopActive = false;
            return; 
          }

          // FIX 1: Pause attack looping state to let panic eating clear item buffer safely
          if (b._isPanicEating) {
            setTimeout(attackRoutine, 1000);
            return;
          }
          
          const target = b.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.id !== b.entity.id);
          if (target) {
            b._attackIdleCycles = 0; 
            const distance = b.entity.position.distanceTo(target.position);
            
            if (distance <= CONFIG.attackReach) {
              const baseDelay = 250; 
              const randomJitter = Math.random() * 450; 
              await wait(baseDelay + randomJitter);
              try { b.attack(target); } catch (_) {}
              setTimeout(attackRoutine, 50); 
            } else if (distance < 12 && b.pathfinder) {
              b.pathfinder.setGoal(new GoalFollow(target, 2), true); 
              setTimeout(attackRoutine, 500); 
            } else {
              setTimeout(attackRoutine, 1000); 
            }
          } else {
            b._attackIdleCycles++;
            if (b._attackIdleCycles > 300) { 
              sendToDiscord(`⚔️ No valid attack targets found within the last 5 minutes for **${b.username}**.`);
              b._attackIdleCycles = 0;
            }
            setTimeout(attackRoutine, 1000); 
          }
        };
        
        await attackRoutine();
      });
      await reply('⚔️ Commencing dynamic, loop-managed humanized attack routines.');
      break;

    case 'help':
      const helpEmbed = new EmbedBuilder()
        .setColor(0xf1c40f).setTitle('🎮 Master Remote Commands')
        .setDescription([
          '**Server Control:**',
          `\`${CONFIG.prefix}connect <ip>\` - Connect to server`,
          `\`${CONFIG.prefix}quit\` - Disconnect from server`,
          `\`${CONFIG.prefix}name <name>\` - Change username`,
          `\`${CONFIG.prefix}password <pass>\` - Auto-login pass`,
          '',
          '**Chat & Info:**',
          `\`${CONFIG.prefix}mc <text>\` - Send raw command safely`,
          `\`${CONFIG.prefix}status\` - Health/Food/Loc/Threads`,
          `\`${CONFIG.prefix}inv\` - View Inventory`,
          '',
          '**Action & Hacks:**',
          `\`${CONFIG.prefix}move forward\` / \`stop\` / \`<x> <y> <z>\``,
          `\`${CONFIG.prefix}attack\` - Start continuous combat loop`,
          `\`${CONFIG.prefix}attack stop\` - Stop continuous combat loop`,
          `\`${CONFIG.prefix}experimentalgravity off/on\` - [Experimental] Anti-fall damage`,
          '',
          '*(Raw messages without prefix are forwarded to Minecraft chat)*'
        ].join('\n'));
      await discordMsg.channel.send({ embeds: [helpEmbed] });
      break;

    default:
      await reply(`❌ Unknown command. Use \`${CONFIG.prefix}help\``);
  }
}

// ===========================================================================
// STARTUP 
// ===========================================================================
log(`[+] Discord Web Server is Online. Waiting for '${CONFIG.prefix}connect' command to join Minecraft...`);

// ===========================================================================
// WEB SERVER 
// ===========================================================================
const app = express();
app.get('/', (_req, res) => res.send('Discord Master Remote is Online! Waiting for connect command.'));
app.listen(process.env.PORT || 3000, () => log('[+] Web server started.'));
