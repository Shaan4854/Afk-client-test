'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalFollow } } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits } = require('discord.js');

// ===========================================================================
// Cloud & Discord Config (Reads from Render Environment Variables)
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

discordClient.on('messageCreate', (message) => {
  if (message.author.bot) return; 
  if (message.channel.id !== CONFIG.discordChannel) return; 

  const raw = message.content.trim();
  
  if (raw[0] === '.') {
    handleCommand(raw.slice(1).trim(), message); 
  } else {
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

// ===========================================================================
// DUMMY WEB SERVER FOR RENDER 24/7 (DO NOT REMOVE)
// ===========================================================================
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is Online and Running 24/7!'));
app.listen(process.env.PORT || 3000, () => log('[+] Web Server Started for Cloud Hosting.'));
