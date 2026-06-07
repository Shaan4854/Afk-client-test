'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalFollow } } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits } = require('discord.js');

// ===========================================================================
// Cloud & Discord Config (Reads from Environment Variables)
// ===========================================================================
const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1', 
  port: parseInt(process.env.MC_PORT) || 25565,
  baseUsername: process.env.MC_USERNAME || 'CloudBot',
  threads: parseInt(process.env.THREADS) || 1,
  joinDelay: 3,
  version: '1.21.11',
  clientBrand: 'mcc',
  autoEatThreshold: 19,
  attackReach: 3.5,
  discordToken: process.env.DISCORD_TOKEN || '',
  discordChannel: process.env.DISCORD_CHANNEL || ''
};

const bots = []; 
const state = {
  cameraEnabled: true, autoEatEnabled: true, autoRespawnEnabled: true,
  antiAfkEnabled: false, bypassEnabled: true 
};

function log(msg) { console.log(msg); }

// ===========================================================================
// DISCORD BOT SETUP
// ===========================================================================
const discordClient = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

if (CONFIG.discordToken) {
  discordClient.login(CONFIG.discordToken).catch(err => log('[!] Discord Login Failed: ' + err.message));
} else {
  log('[!] No Discord Token provided. Running without Discord.');
}

discordClient.on('ready', () => {
  log(`[+] Discord Bot Online as ${discordClient.user.tag}!`);
});

// Jab Discord me koi message aaye
discordClient.on('messageCreate', (message) => {
  if (message.author.bot) return; // Ignore other bots
  if (message.channel.id !== CONFIG.discordChannel) return; // Sirf apne channel me sunega

  const raw = message.content.trim();
  
  if (raw[0] === '.') {
    handleCommand(raw.slice(1).trim(), message); // Commands handle karega
  } else {
    // Normal message Minecraft me bhej dega
    bots.forEach(b => { if (b.entity) b.chat(raw); });
    message.react('✅');
  }
});

function sendToDiscord(msg) {
  if (discordClient.isReady() && CONFIG.discordChannel) {
    const channel = discordClient.channels.cache.get(CONFIG.discordChannel);
    if (channel) channel.send(`\`[Minecraft]\` ${msg}`);
  }
}

// ===========================================================================
// MINEFLAYER BOT LOGIC
// ===========================================================================
function createBot(botName) {
  const bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: botName,
    auth: 'offline', version: CONFIG.version, respawn: false 
  });

  bot.loadPlugin(pathfinder);
  bots.push(bot); 

  bot.once('spawn', () => {
    log(`[+] ${botName} joined successfully`);
    sendToDiscord(`🟩 **${botName}** has joined the server!`);
    
    const moves = new Movements(bot);
    moves.allowSprinting = true; moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    
    startAntiNaNLoop(bot);
    startHumanCamera(bot);
    startAntiAfk(bot);
    startSonarBypass(bot); 
  });

  bot.on('death', () => {
    sendToDiscord(`💀 **${botName}** died!`);
    if (state.autoRespawnEnabled) setTimeout(() => { if (bot) bot.spawn(); }, 1500);
  });

  setupAutoEat(bot);

  // Minecraft ki chat Discord par bhejna
  if (bots.length === 1) {
    bot.on('messagestr', (message) => { 
      log(`[CHAT] ${message}`);
      sendToDiscord(message);
    });
  }

  bot.on('end', () => {
    log(`[!] ${botName} disconnected. Reconnecting...`);
    sendToDiscord(`🟥 **${botName}** disconnected! Reconnecting...`);
    const index = bots.indexOf(bot);
    if (index > -1) bots.splice(index, 1);
    setTimeout(() => createBot(botName), CONFIG.joinDelay * 1000);
  });
}

// Start sequence (Auto-start for Cloud)
log(`\n[+] Starting Bot with ${CONFIG.threads} threads...`);
for (let i = 0; i < CONFIG.threads; i++) {
  setTimeout(() => {
    let name = CONFIG.threads > 1 ? `${CONFIG.baseUsername}_${Math.random().toString(36).substring(2, 6)}` : CONFIG.baseUsername;
    createBot(name);
  }, i * CONFIG.joinDelay * 1000);
}

// ===========================================================================
// FEATURES (AutoEat, Bypass, AntiAFK, Camera)
// ===========================================================================
function startSonarBypass(bot) {
  setInterval(() => {
    if (state.bypassEnabled && bot.entity) {
      bot.setControlState('sneak', true);
      setTimeout(() => bot.setControlState('sneak', false), Math.floor(Math.random() * 150) + 50);
    }
  }, Math.floor(Math.random() * 500) + 300);

  setInterval(() => {
    if (state.bypassEnabled && bot.entity) bot.swingArm('right'); 
  }, Math.floor(Math.random() * 3000) + 1500);
}

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
    if (!state.autoEatEnabled || eating || !bot.entity) return;
    if (bot.food === undefined || bot.food >= CONFIG.autoEatThreshold) return;
    const food = bot.inventory.items().find(item => item && item.name && ['apple', 'carrot', 'bread', 'potato', 'beef', 'porkchop', 'chicken', 'melon', 'steak'].some(h => item.name.toLowerCase().includes(h)));
    if (!food) return;
    eating = true;
    try { await bot.equip(food, 'hand'); await bot.consume(); } catch (err) {} finally { eating = false; }
  });
}

function startAntiAfk(bot) {
  setInterval(() => {
    if (state.antiAfkEnabled && bot.entity) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
    }
  }, 30000);
}

function startHumanCamera(bot) {
  setInterval(() => {
    if (state.cameraEnabled && bot.entity) bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch, true);
  }, 4500);
}

// ===========================================================================
// COMMAND HANDLER (Triggered from Discord)
// ===========================================================================
function handleCommand(body, discordMsg) {
  const parts = body.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  const reply = (text) => {
    if (discordMsg) discordMsg.reply(text);
    log(`[Cmd Reply] ${text}`);
  };

  switch (cmd) {
    case 'move':
      const subMove = (args[0] || '').toLowerCase();
      if (subMove === 'stop') { 
        bots.forEach(b => { b.clearControlStates(); if (b.pathfinder) b.pathfinder.setGoal(null); });
        reply('🛑 All bots stopped moving.');
      } else if (subMove === 'forward') {
        bots.forEach(b => { if (b.entity) b.setControlState('forward', true); });
        reply('⬆️ All bots moving forward!');
      } else {
        const x = parseFloat(args[0]), y = parseFloat(args[1]), z = parseFloat(args[2]);
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          bots.forEach(b => { if (b.pathfinder) b.pathfinder.setGoal(new GoalBlock(x, y, z)); });
          reply(`🚶 Pathfinding to ${x}, ${y}, ${z}`);
        }
      }
      break;

    case 'attack':
      bots.forEach(b => {
        if (!b.entity) return;
        const target = b.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.id !== b.entity.id);
        if (target) {
          if (b.entity.position.distanceTo(target.position) <= CONFIG.attackReach) b.attack(target);
          else b.pathfinder.setGoal(new GoalFollow(target, 2), true); 
        }
      });
      reply('⚔️ Attacking nearby targets!');
      break;
      
    case 'help':
      reply('**S+ Discord Commands:**\n`.move forward`, `.move stop`, `.move <x> <y> <z>`, `.attack`\n(Type normally to chat in-game)');
      break;

    default:
      reply('❌ Unknown command. Type `.help`');
  }
}
  version: '1.21.11',
  clientBrand: 'mcc',
  autoEatThreshold: 19,
  attackReach: 3.5
};

const bots = []; 

const state = {
  cameraEnabled: true,
  autoEatEnabled: true,
  autoRespawnEnabled: true,
  antiAfkEnabled: false,
  bypassEnabled: true 
};

// ---------------------------------------------------------------------------
// Colored Logging
// ---------------------------------------------------------------------------
const colors = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m'
};
function log(msg, color = colors.reset) { console.log(color + msg + colors.reset); }
function chatLog(msg) { console.log(colors.cyan + '[CHAT] ' + msg + colors.reset); }

// ---------------------------------------------------------------------------
// Bot Creation Logic (Multi-Threaded)
// ---------------------------------------------------------------------------
function createBot(botName) {
  const bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: botName,
    auth: 'offline', version: CONFIG.version, respawn: false 
  });

  bot.loadPlugin(pathfinder);
  bots.push(bot); 

  bot.once('login', () => {
    try {
      const data = Buffer.from(CONFIG.clientBrand, 'utf8');
      const channel = bot.supportFeature && bot.supportFeature('mcChannelDelimiter') ? 'minecraft:brand' : 'MC|Brand';
      if (bot._client && bot._client.writeChannel) bot._client.writeChannel(channel, data);
    } catch (_) {}
  });

  bot.once('spawn', () => {
    log(`[ + ] ${botName} joined successfully`, colors.green);
    
    const moves = new Movements(bot);
    moves.allowSprinting = true;
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    
    startAntiNaNLoop(bot);
    startHumanCamera(bot);
    startAntiAfk(bot);
    startSonarBypass(bot); 
  });

  bot.on('death', () => {
    log(`[!] ${botName} died!`, colors.red);
    if (state.autoRespawnEnabled) {
      setTimeout(() => { if (bot) bot.spawn(); }, 1500);
    }
  });

  setupAutoEat(bot);

  if (bots.length === 1) {
    bot.on('messagestr', (message) => { chatLog(message); });
  }

  bot.on('kicked', (r) => log(`[ - ] ${botName} Kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`, colors.red));
  bot.on('error', (err) => log(`[ - ] ${botName} Error: ${err.message}`, colors.red));
  
  bot.on('end', () => {
    log(`[+] ${botName} disconnected. Reconnecting...`, colors.yellow);
    const index = bots.indexOf(bot);
    if (index > -1) bots.splice(index, 1);
    setTimeout(() => createBot(botName), CONFIG.joinDelay * 1000);
  });
}

function startBotArmy() {
  log(`\n${colors.green}[ + ] Starting Bot with ${CONFIG.threads} threads...${colors.reset}`);
  for (let i = 0; i < CONFIG.threads; i++) {
    setTimeout(() => {
      let name = CONFIG.threads > 1 
        ? `${CONFIG.baseUsername}_${Math.random().toString(36).substring(2, 6)}` 
        : CONFIG.baseUsername;
      createBot(name);
    }, i * CONFIG.joinDelay * 1000);
  }
}

// ---------------------------------------------------------------------------
// Randomized Human Actions
// ---------------------------------------------------------------------------
function startSonarBypass(bot) {
  setInterval(() => {
    if (state.bypassEnabled && bot.entity) {
      bot.setControlState('sneak', true);
      const releaseTime = Math.floor(Math.random() * 150) + 50; 
      setTimeout(() => bot.setControlState('sneak', false), releaseTime);
    }
  }, Math.floor(Math.random() * 500) + 300);

  setInterval(() => {
    if (state.bypassEnabled && bot.entity) {
       bot.swingArm('right'); 
    }
  }, Math.floor(Math.random() * 3000) + 1500);

  setInterval(() => {
     if (state.bypassEnabled && bot.entity && bot.entity.onGround) {
         const directions = ['forward', 'back', 'left', 'right'];
         const dir = directions[Math.floor(Math.random() * directions.length)];
         bot.setControlState(dir, true);
         setTimeout(() => bot.setControlState(dir, false), Math.floor(Math.random() * 100) + 50);
     }
  }, Math.floor(Math.random() * 5000) + 3000); 
}

// ---------------------------------------------------------------------------
// Standard Features
// ---------------------------------------------------------------------------
function startAntiNaNLoop(bot) {
  bot.on('physicsTick', () => {
    if (!bot.entity) return;
    const p = bot.entity.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      p.set(0, 64, 0);
    }
  });
}

const FOOD_HINTS = ['apple', 'carrot', 'bread', 'potato', 'beef', 'porkchop', 'chicken', 'melon', 'steak'];
function setupAutoEat(bot) {
  let eating = false;
  bot.on('physicsTick', async () => {
    if (!state.autoEatEnabled || eating || !bot.entity) return;
    if (bot.food === undefined || bot.food >= CONFIG.autoEatThreshold) return;
    const food = bot.inventory.items().find(item => item && item.name && FOOD_HINTS.some(h => item.name.toLowerCase().includes(h)));
    if (!food) return;
    eating = true;
    try { await bot.equip(food, 'hand'); await bot.consume(); } catch (err) {}
    finally { eating = false; }
  });
}

function startAntiAfk(bot) {
  setInterval(() => {
    if (state.antiAfkEnabled && bot.entity) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
    }
  }, 30000);
}

function startHumanCamera(bot) {
  setInterval(() => {
    if (state.cameraEnabled && bot.entity) {
      bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch, true);
    }
  }, 4500);
}

function getToggleState(arg, currentState) {
  if (arg === 'on') return true;
  if (arg === 'off') return false;
  return !currentState; 
}

// ---------------------------------------------------------------------------
// CLI Setup & Prompts
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let setupStage = 'username';

console.clear();
log("==========================================", colors.cyan);
log("       ADVANCED MINEFLAYER BOT S+         ", colors.cyan);
log("==========================================\n", colors.cyan);
process.stdout.write("Bot name? (Prefix): ");

rl.on('line', (line) => {
  const raw = line.trim();

  if (setupStage === 'username') {
    if (!raw) { process.stdout.write("Bot name? (Prefix): "); return; }
    CONFIG.baseUsername = raw;
    setupStage = 'ip';
    process.stdout.write("IP:Port? ");
    return;
  }

  if (setupStage === 'ip') {
    if (!raw) { process.stdout.write("IP:Port? "); return; }
    const parts = raw.split(':');
    CONFIG.host = parts[0];
    if (parts[1]) CONFIG.port = parseInt(parts[1], 10);
    setupStage = 'threads';
    process.stdout.write("Thread count? ");
    return;
  }

  if (setupStage === 'threads') {
    CONFIG.threads = parseInt(raw) || 1;
    setupStage = 'delay';
    process.stdout.write("Join delay (min 3 sec)? ");
    return;
  }

  if (setupStage === 'delay') {
    let delay = parseInt(raw) || 3;
    if (delay < 3) {
      process.stdout.write("Join delay too low! Enter at least 3 seconds: ");
      return;
    }
    CONFIG.joinDelay = delay;
    setupStage = 'chat';
    startBotArmy();
    setTimeout(() => rl.setPrompt('> '), 1000);
    return;
  }

  // --- GAME CHAT & COMMANDS LOGIC ---
  if (!raw) { rl.prompt(); return; }
  
  if (raw[0] === '.') {
    handleCommand(raw.slice(1).trim());
  } else {
    bots.forEach(b => { if (b.entity) b.chat(raw); });
  }
  setTimeout(() => rl.prompt(), 100);
});

function handleCommand(body) {
  const parts = body.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'say':
      const msg = args.join(' ');
      bots.forEach(b => { if (b.entity) b.chat(msg); });
      break;

    case 'move':
      const subMove = (args[0] || '').toLowerCase();
      if (subMove === 'stop') { 
        bots.forEach(b => {
          b.clearControlStates(); 
          if (b.pathfinder) b.pathfinder.setGoal(null); 
        });
        log('[Cmd] All bots stopped moving.', colors.yellow);
      } 
      else if (subMove === 'forward') {
        bots.forEach(b => { if (b.entity) b.setControlState('forward', true); });
        log('[Cmd] All bots moving forward!', colors.green);
      } 
      else {
        const x = parseFloat(args[0]), y = parseFloat(args[1]), z = parseFloat(args[2]);
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          bots.forEach(b => { if (b.pathfinder) b.pathfinder.setGoal(new GoalBlock(x, y, z)); });
          log(`[Cmd] All bots pathfinding to ${x}, ${y}, ${z}`, colors.green);
        }
      }
      break;

    case 'attack':
      bots.forEach(b => {
        if (!b.entity) return;
        const target = b.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.id !== b.entity.id);
        if (target) {
          const dist = b.entity.position.distanceTo(target.position);
          if (dist <= CONFIG.attackReach) b.attack(target);
          else b.pathfinder.setGoal(new GoalFollow(target, 2), true); 
        }
      });
      log(`[Cmd] All bots are attacking nearby targets!`, colors.yellow);
      break;

    case 'bypass':
      state.bypassEnabled = getToggleState((args[0] || '').toLowerCase(), state.bypassEnabled);
      log(`[Cmd] Advanced Human Actions are ${state.bypassEnabled ? 'ON' : 'OFF'}`, colors.cyan);
      break;

    case 'autoeat':
      state.autoEatEnabled = getToggleState((args[0] || '').toLowerCase(), state.autoEatEnabled);
      log(`[Cmd] AutoEat is ${state.autoEatEnabled ? 'ON' : 'OFF'}`, colors.cyan);
      break;

    case 'antiafk':
      state.antiAfkEnabled = getToggleState((args[0] || '').toLowerCase(), state.antiAfkEnabled);
      log(`[Cmd] AntiAFK is ${state.antiAfkEnabled ? 'ON' : 'OFF'}`, colors.cyan);
      break;

    case 'autorespawn':
      state.autoRespawnEnabled = getToggleState((args[0] || '').toLowerCase(), state.autoRespawnEnabled);
      log(`[Cmd] AutoRespawn is ${state.autoRespawnEnabled ? 'ON' : 'OFF'}`, colors.cyan);
      break;

    case 'camera':
      state.cameraEnabled = getToggleState((args[0] || '').toLowerCase(), state.cameraEnabled);
      log(`[Cmd] Human Camera Look is ${state.cameraEnabled ? 'ON' : 'OFF'}`, colors.cyan);
      break;

    case 'clear':
      console.clear();
      break;

    case 'help':
      log('\n==== S+ BOT COMMANDS ====', colors.yellow);
      log('.say <msg>            -> Make all bots chat');
      log('.move forward         -> All bots walk forward');
      log('.move stop            -> Freeze all bots');
      log('.attack               -> All bots hit nearest target');
      log(`.bypass [on/off]      -> Toggle Human Actions    [${state.bypassEnabled ? 'ON' : 'OFF'}]`);
      log(`.autoeat [on/off]     -> Toggle AutoEat          [${state.autoEatEnabled ? 'ON' : 'OFF'}]`);
      log(`.antiafk [on/off]     -> Toggle AntiAFK jump     [${state.antiAfkEnabled ? 'ON' : 'OFF'}]`);
      log(`.autorespawn [on/off] -> Toggle auto revive      [${state.autoRespawnEnabled ? 'ON' : 'OFF'}]`);
      log(`.camera [on/off]      -> Toggle human look       [${state.cameraEnabled ? 'ON' : 'OFF'}]`);
      log('.clear                -> Clean terminal');
      log('.quit                 -> Exit script');
      log('=========================\n', colors.yellow);
      break;

    case 'quit':
    case 'exit':
      log('[Cmd] Shutting down all bots...', colors.red);
      bots.forEach(b => b.quit());
      setTimeout(() => process.exit(0), 1000);
      break;

    default:
      log(`[Cmd] Unknown command. Type .help`, colors.red);
  }
}
// Dummy Web Server for Render 24/7 Uptime
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is Online and Running 24/7!'));
app.listen(process.env.PORT || 3000, () => log('[+] Web Server Started for Cloud Hosting.'));
