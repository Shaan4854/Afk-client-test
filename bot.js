'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalFollow } } = require('mineflayer-pathfinder');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ===========================================================================
// Cloud & Discord Config 
// ===========================================================================
const CONFIG = {
  host: process.env.MC_HOST || '127.0.0.1', 
  port: parseInt(process.env.MC_PORT) || 25565,
  baseUsername: process.env.MC_USERNAME || 'CloudBot',
  password: '', // Auto-Login password memory
  threads: parseInt(process.env.THREADS) || 1,
  joinDelay: 3,
  version: '1.20.4', 
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
    message.react('💬');
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
    sendToDiscord(`🟩 **${botName}** server me join ho gaya hai!`);
    
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
      
      // AUTO-LOGIN SYSTEM
      if (CONFIG.password) {
        const msgLow = message.toLowerCase();
        if (msgLow.includes('/login') || msgLow.includes('login with')) {
          bot.chat(`/login ${CONFIG.password}`);
        } else if (msgLow.includes('/register') || msgLow.includes('register with')) {
          bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`);
        }
      }
    });
  }

  bot.on('end', (reason) => {
    log(`[!] ${botName} disconnected: ${reason}`);
    sendToDiscord(`🟥 **${botName}** disconnected! Reason: ${reason}. Reconnecting...`);
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
// COMMAND HANDLER (Master Remote via Discord)
// ===========================================================================
function handleCommand(body, discordMsg) {
  const parts = body.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  const reply = (text) => {
    if (discordMsg) discordMsg.reply(text);
    log(`[Cmd Reply] ${text}`);
  };

  const currentBot = bots[0];

  switch (cmd) {
    case 'connect':
      const newIp = args[0];
      const newPort = parseInt(args[1]) || 25565;
      if (!newIp) return reply('❌ IP nahi mili! Aise likhein: `.connect <ip> [port]`');
      
      reply(`🔄 Server badal raha hu... Connecting to **${newIp}:${newPort}**`);
      CONFIG.host = newIp;
      CONFIG.port = newPort;
      
      bots.forEach(b => { try { b.quit(); } catch(e){} });
      bots.length = 0; 
      setTimeout(() => createBot(CONFIG.baseUsername), 2000);
      break;

    case 'name':
      const newName = args[0];
      if (!newName) return reply('❌ Naya naam nahi diya! Aise likhein: `.name <NayaNaam>`');
      
      reply(`🔄 Username badal raha hu... Naya naam: **${newName}**. Reconnecting...`);
      CONFIG.baseUsername = newName;
      
      bots.forEach(b => { try { b.quit(); } catch(e){} });
      bots.length = 0; 
      setTimeout(() => createBot(CONFIG.baseUsername), 2000);
      break;

    case 'password':
      const newPass = args[0];
      if (!newPass) return reply('❌ Password nahi diya! Aise likhein: `.password <NayaPassword>`');
      
      CONFIG.password = newPass;
      reply('✅ Auto-Login password set ho gaya! Ab bot jab bhi join karega khud `/login` aur `/register` kar lega.');
      break;

    case 'status':
      if (!currentBot || !currentBot.entity) return reply('❌ Bot abhi Minecraft server me online nahi hai.');
      
      const statusEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🤖 Bot Status Report')
        .addFields(
          { name: 'Username 📛', value: currentBot.username, inline: false },
          { name: 'Health ❤️', value: `${Math.round(currentBot.health)} / 20`, inline: true },
          { name: 'Food 🍖', value: `${Math.round(currentBot.food)} / 20`, inline: true },
          { name: 'Location 📍', value: `X: ${Math.round(currentBot.entity.position.x)} | Y: ${Math.round(currentBot.entity.position.y)} | Z: ${Math.round(currentBot.entity.position.z)}`, inline: false }
        )
        .setTimestamp();
        
      if (discordMsg) discordMsg.channel.send({ embeds: [statusEmbed] });
      break;

    case 'inv':
      if (!currentBot || !currentBot.entity) return reply('❌ Bot abhi Minecraft server me online nahi hai.');
      
      const items = currentBot.inventory.items();
      let invText = items.map(item => `${item.count}x ${item.displayName}`).join('\n');
      if (!invText) invText = 'Bag bilkul khali hai...';

      const invEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🎒 Inventory / Bag')
        .setDescription(`\`\`\`\n${invText}\n\`\`\``);
        
      if (discordMsg) discordMsg.channel.send({ embeds: [invEmbed] });
      break;

    case 'move':
    case 'attack':
      reply('⚙️ Movement & Attack features enabled (Check .help)');
      break;
      
    case 'help':
      const helpEmbed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🎮 Master Remote Commands')
        .setDescription('**Server Setup:**\n`.name <NayaNaam>` - Bot ka naam badlo\n`.password <12345>` - Auto-Login password set karo\n`.connect <ip> <port>` - Kisi bhi server pe bhejo\n\n**Bot Info:**\n`.status` - Health & Location dekho\n`.inv` - Inventory check karo\n\n*(Bina dot "." ke type karoge toh Minecraft me chat jayegi)*');
      
      if (discordMsg) discordMsg.channel.send({ embeds: [helpEmbed] });
      break;

    default:
      reply('❌ Unknown command. Type `.help` for the command list.');
  }
}

// ===========================================================================
// DUMMY WEB SERVER FOR RENDER 24/7
// ===========================================================================
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is Online and Running 24/7!'));
app.listen(process.env.PORT || 3000, () => log('[+] Web Server Started for Cloud Hosting.'));
