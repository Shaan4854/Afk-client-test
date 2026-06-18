'use strict';

const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const readline    = require('readline');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'bot-config.json');

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return null;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

// ─── GUI Server (optional — needs: npm install express socket.io) ─────────────
let io              = null;
let currentHandleCommand = null;
let guiClients      = 0;

function tryStartGUI() {
  try {
    const http       = require('http');
    const express    = require('express');
    const { Server } = require('socket.io');
    const app        = express();
    const srv        = http.createServer(app);
    io               = new Server(srv);

    app.get('/', (_req, res) => res.send(GUI_HTML));

    io.on('connection', socket => {
      guiClients++;
      socket.emit('status',  { connected: !!currentBot, ...CONFIG });
      socket.emit('toggles', safeToggles());
      if (currentBot) { socket.emit('stats', liveStats()); }
      socket.on('command', cmd => {
        if (typeof cmd === 'string' && currentHandleCommand) {
          rawLog(`[GUI] Command: ${cmd}`);
          currentHandleCommand(cmd.trim());
        }
      });
      socket.on('disconnect', () => guiClients--);
    });

    srv.listen(CONFIG.guiPort || 3000, () => {
      rawLog(`[GUI] Dashboard → http://localhost:${CONFIG.guiPort || 3000}`);
    });
  } catch {
    rawLog('[GUI] Web dashboard not available. Run: npm install express socket.io');
  }
}

function emit(event, data) { if (io) io.emit(event, data); }

function safeToggles() {
  return {
    autoEatEnabled:     state.autoEatEnabled,
    antiAfkEnabled:     state.antiAfkEnabled,
    autoRespawnEnabled: state.autoRespawnEnabled,
    cameraEnabled:      state.cameraEnabled,
    attackActive:       state.attackActive,
    loggedIn:           state.loggedIn,
  };
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

async function getConfig() {
  const saved = loadSavedConfig();
  const rl    = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n================================');
  console.log('       MINEFLAYER BOT SETUP     ');
  console.log('================================');

  if (saved) {
    console.log('  Saved config found:');
    console.log(`    Host     : ${saved.host}:${saved.port}`);
    console.log(`    Username : ${saved.username}`);
    console.log(`    Password : ${saved.password ? '(set)' : '(none)'}`);
    console.log(`    Version  : ${saved.version}`);
    console.log(`    Auth     : ${saved.auth}`);
    const use = await prompt(rl, 'Use saved config? [Y/n]: ');
    if (!use || use.toLowerCase() === 'y') { rl.close(); console.log('================================\n'); return saved; }
  }

  let host = await prompt(rl, `Server IP   [${saved?.host || 'localhost'}]: `);
  if (!host) host = saved?.host || 'localhost';

  let portRaw = await prompt(rl, `Server Port [${saved?.port || 25565}]: `);
  const port  = parseInt(portRaw) || saved?.port || 25565;

  let username = await prompt(rl, `Username    [${saved?.username || ''}]: `);
  if (!username) username = saved?.username || 'Bot_' + Math.floor(Math.random() * 9999);

  let password = await prompt(rl, `Password    [for /login — blank to skip]: `);
  if (!password) password = saved?.password || '';

  let versionRaw = await prompt(rl, `MC Version  [${saved?.version || '1.20.1'}]: `);
  const version  = versionRaw || saved?.version || '1.20.1';

  console.log('  Auth mode: (1) offline  (2) microsoft');
  let authRaw = await prompt(rl, `Auth mode   [${saved?.auth === 'microsoft' ? '2' : '1'}]: `);
  if (!authRaw) authRaw = saved?.auth === 'microsoft' ? '2' : '1';
  const auth = authRaw === '2' ? 'microsoft' : 'offline';

  let guiPortRaw = await prompt(rl, `GUI port    [${saved?.guiPort || 3000}]: `);
  const guiPort  = parseInt(guiPortRaw) || saved?.guiPort || 3000;

  rl.close();

  const cfg = { host, port, username, password, version, auth, guiPort };

  const rl2  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const save = await prompt(rl2, 'Save config? [Y/n]: ');
  rl2.close();
  if (!save || save.toLowerCase() === 'y') {
    saveConfig(cfg);
    rawLog('[Config] Saved to bot-config.json');
  }

  console.log('================================\n');
  return cfg;
}

const state = {
  autoEatEnabled:     true,
  antiAfkEnabled:     true,
  autoRespawnEnabled: true,
  cameraEnabled:      true,
  antiAfkTimeout:     null,
  cameraTimeout:      null,
  verifying:          false,
  loggedIn:           false,
  loginSent:          false,
  eating:             false,
  attackActive:       false,
};

let CONFIG            = {};
let currentBot        = null;
let reconnectAttempts = 0;
let statsInterval     = null;

function rawLog(msg) { process.stdout.write(msg + '\n'); }

function log(msg, type) {
  rawLog(msg);
  if (!type) {
    if      (msg.startsWith('[Chat]'))    type = 'chat';
    else if (msg.startsWith('[!]'))       type = 'error';
    else if (msg.startsWith('[Sonar]'))   type = 'sonar';
    else if (msg.startsWith('[Auth]'))    type = 'auth';
    else if (msg.startsWith('[Move]'))    type = 'move';
    else if (msg.startsWith('[Attack]'))  type = 'attack';
    else if (msg.startsWith('[MC]'))      type = 'mc';
    else if (msg.startsWith('[GUI]'))     type = 'gui';
    else                                  type = 'system';
  }
  emit('log', { msg, type, time: new Date().toLocaleTimeString() });
}

const FOOD_PRIORITY = {
  golden_carrot: 10, cooked_porkchop: 9, cooked_beef: 9, cooked_mutton: 9,
  cooked_salmon: 8,  cooked_chicken: 8,  cooked_cod: 7,  cooked_rabbit: 7,
  bread: 6,          baked_potato: 6,    mushroom_stew: 7, rabbit_stew: 8,
  pumpkin_pie: 7,    apple: 5,           sweet_berries: 3, carrot: 3,
  melon_slice: 2,    cookie: 2,          dried_kelp: 1,   chorus_fruit: 1,
};

function bestFood(inventory) {
  return inventory.items()
    .filter(i => FOOD_PRIORITY[i.name] !== undefined)
    .sort((a, b) => (FOOD_PRIORITY[b.name] || 0) - (FOOD_PRIORITY[a.name] || 0))[0] || null;
}

function liveStats() {
  const bot = currentBot;
  if (!bot || !bot.entity) return null;
  const pos = bot.entity.position;
  return {
    health:  Math.round((bot.health  || 0) * 10) / 10,
    food:    Math.round((bot.food    || 0) * 10) / 10,
    xpLevel: bot.experience?.level || 0,
    x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1),
    loggedIn: state.loggedIn,
  };
}

function reconnectDelay() {
  const base = 7000, cap = 120000;
  return Math.min(base * Math.pow(2, reconnectAttempts - 1), cap) + Math.floor(Math.random() * 3000);
}

function humanDelay(min, max) { return Math.floor(Math.random() * (max - min)) + min; }

function extractText(obj) {
  if (typeof obj === 'string') return obj;
  if (obj?.value !== undefined) return extractText(obj.value);
  if (Array.isArray(obj)) return obj.map(extractText).join('');
  if (typeof obj === 'object') {
    const parts = [];
    if (obj.text)  parts.push(extractText(obj.text));
    if (obj.extra) parts.push(extractText(obj.extra));
    return parts.join('');
  }
  return '';
}

function createBot() {
  log(`[*] Connecting to ${CONFIG.host}:${CONFIG.port} as '${CONFIG.username}' (${CONFIG.auth})...`);
  emit('status', { connected: false, reconnecting: true, attempt: reconnectAttempts, ...CONFIG });

  const bot = mineflayer.createBot({
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    version:  CONFIG.version,
    auth:     CONFIG.auth,
    checkTimeoutInterval: 30000,
    physicsEnabled: true,
    hideErrors:     false,
  });

  currentBot = bot;
  state.loggedIn = false;
  bot.loadPlugin(pathfinder);

  bot.on('forcedMove', () => {
    state.verifying = true;
    log('[Sonar] Teleported — letting physics settle...');
    bot.pathfinder.stop();
    ['forward','back','left','right','jump','sprint','sneak'].forEach(k => bot.setControlState(k, false));
    setTimeout(() => { state.verifying = false; log('[Sonar] Verification window passed — resuming.'); }, humanDelay(2500, 4500));
  });

  bot.on('message', (jsonMsg) => {
    const raw  = jsonMsg.toString();
    const motd = typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : raw;
    const text = raw.toLowerCase();
    rawLog(`[Chat] ${raw}`);
    emit('log', { msg: raw, motd, type: 'chat', time: new Date().toLocaleTimeString() });

    if (!raw.includes('<') && !raw.includes('>')) {
      if (CONFIG.password && !state.loggedIn && !state.loginSent &&
          text.includes('/login') && (text.includes('log in') || text.includes('login') || text.includes('please'))) {
        state.loginSent = true;
        setTimeout(() => { bot.chat(`/login ${CONFIG.password}`); log('[Auth] Sent: /login ***'); }, humanDelay(600, 1200));
        return;
      }
      if (CONFIG.password && !state.loggedIn && !state.loginSent &&
          text.includes('/register') && (text.includes('register') || text.includes('please'))) {
        state.loginSent = true;
        setTimeout(() => { bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`); log('[Auth] Sent: /register ***'); }, humanDelay(600, 1200));
        return;
      }
      if (!state.loggedIn && (text.includes('logged in') || text.includes('welcome back') ||
          text.includes('successfully') || text.includes('authenticated'))) {
        state.loggedIn = true;
        log('[Auth] Logged in successfully.');
        emit('toggles', safeToggles());
        return;
      }
      const verifyMatch = raw.match(/\/verify\s+([A-Za-z0-9_-]{3,32})/);
      if (verifyMatch) {
        setTimeout(() => { bot.chat(`/verify ${verifyMatch[1]}`); log(`[Sonar] Sent: /verify ${verifyMatch[1]}`); }, humanDelay(800, 1400));
        return;
      }
      if (text.includes('/verify') && (text.includes('type') || text.includes('enter') || text.includes('run'))) {
        setTimeout(() => { bot.chat('/verify'); log('[Sonar] Sent: /verify'); }, humanDelay(900, 1600));
      }
    }
  });

  bot.once('spawn', () => {
    reconnectAttempts = 0;
    state.loginSent = false;
    state.eating    = false;
    log(`[*] Spawned as ${bot.username}`);
    bot.pathfinder.setMovements(new Movements(bot));
    emit('status', { connected: true, reconnecting: false, username: bot.username, ...CONFIG });
    if (!CONFIG.password) state.loggedIn = true;
    setTimeout(() => { if (!state.verifying) { startAntiAfk(); startCamera(); } }, humanDelay(1500, 3000));
    clearInterval(statsInterval);
    statsInterval = setInterval(() => { const s = liveStats(); if (s) emit('stats', s); }, 2000);
  });

  bot.on('health', () => {
    if (!state.autoEatEnabled || state.verifying || bot.usingHeldItem || state.eating) return;
    if (bot.food < 18) {
      const food = bestFood(bot.inventory);
      if (food) {
        state.eating = true;
        bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { state.eating = false; });
      }
    }
  });

  bot.on('death', () => {
    log('[!] Bot died.');
    if (state.autoRespawnEnabled) setTimeout(() => { bot.respawn(); log('[*] Auto-respawned.'); }, humanDelay(800, 2500));
  });

  bot.on('kicked', (reason) => {
    let readable = reason;
    try { readable = extractText(JSON.parse(reason)); } catch {}
    log(`[!] Kicked: ${readable}`);
    if (readable.toLowerCase().includes('bot verification')) log('[Sonar] ⚠  Failed: gravity/main check');
    else if (readable.toLowerCase().includes('too many'))    log('[Sonar] ⚠  Failed: reconnect rate-limit — backing off');
    else if (readable.toLowerCase().includes('captcha'))     log('[Sonar] ⚠  Failed: CAPTCHA (map-image)');
  });

  bot.on('end', (reason) => {
    stopAntiAfk(); stopCamera();
    clearInterval(statsInterval);
    bot.removeAllListeners();
    currentBot = null; state.loggedIn = false; state.loginSent = false;
    state.eating = false; state.attackActive = false;
    reconnectAttempts++;
    const delay = reconnectDelay();
    log(`[!] Disconnected: ${reason} (attempt #${reconnectAttempts}) — reconnecting in ${(delay / 1000).toFixed(1)} s...`);
    emit('status', { connected: false, reconnecting: true, attempt: reconnectAttempts, nextRetry: (delay / 1000).toFixed(1), ...CONFIG });
    setTimeout(createBot, delay);
  });

  bot.on('error', (err) => log(`[!] Error: ${err.message}`));

  function scheduleAntiAfk() {
    if (!state.antiAfkEnabled) return;
    state.antiAfkTimeout = setTimeout(() => {
      if (!state.verifying) doAntiAfkAction();
      scheduleAntiAfk();
    }, humanDelay(25000, 45000));
  }

  function doAntiAfkAction() {
    const roll = Math.random();
    if      (roll < 0.40) { bot.setControlState('jump',    true); setTimeout(() => bot.setControlState('jump',    false), humanDelay(150, 250)); }
    else if (roll < 0.65) { bot.setControlState('sneak',   true); setTimeout(() => bot.setControlState('sneak',   false), humanDelay(300, 700)); }
    else if (roll < 0.82) { bot.setControlState('forward', true); setTimeout(() => bot.setControlState('forward', false), humanDelay(100, 300)); }
    else {
      const newPitch = bot.entity.pitch + (Math.random() - 0.5) * 0.5;
      bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.5, Math.max(-1.4, Math.min(1.4, newPitch)), false);
    }
  }

  function startAntiAfk() { stopAntiAfk(); if (state.antiAfkEnabled) scheduleAntiAfk(); }
  function stopAntiAfk()  { clearTimeout(state.antiAfkTimeout); state.antiAfkTimeout = null; }

  function startCamera() {
    stopCamera();
    if (!state.cameraEnabled) return;
    function scheduleNextLook() {
      if (!state.cameraEnabled) return;
      state.cameraTimeout = setTimeout(() => {
        if (!state.verifying && bot.entity) {
          const newPitch = bot.entity.pitch + (Math.random() - 0.5) * (0.15 + Math.random() * 0.35);
          bot.look(bot.entity.yaw + (Math.random() - 0.5) * (0.2 + Math.random() * 0.5), Math.max(-1.5, Math.min(1.5, newPitch)), false);
        }
        scheduleNextLook();
      }, humanDelay(1500, 6500));
    }
    scheduleNextLook();
  }
  function stopCamera() { clearTimeout(state.cameraTimeout); state.cameraTimeout = null; }

  function stopAttack() {
    if (state._swingTick) bot.removeListener('physicsTick', state._swingTick);
    state._swingTick = null; state.attackActive = false; bot.pathfinder.stop();
  }

  function toggle(key, arg, label, onCb, offCb) {
    if      (arg === 'on')  { state[key] = true;  onCb?.();  log(`[${label}] Enabled.`);  }
    else if (arg === 'off') { state[key] = false; offCb?.(); log(`[${label}] Disabled.`); }
    else log(`[${label}] Currently ${state[key] ? 'ON' : 'OFF'}`);
    emit('toggles', safeToggles());
  }

  function handleCommand(input) {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith('.')) {
      bot.chat(trimmed);
      log(`[MC] ▶ ${trimmed}`, 'mc');
      return;
    }

    const parts = trimmed.slice(1).split(' ');
    const cmd   = parts[0].toLowerCase();
    const args  = parts.slice(1);

    switch (cmd) {
      case 'help':
        log('================================');
        log('          BOT COMMANDS          ');
        log('================================');
        log('.move forward         -> Walk straight');
        log('.move stop            -> Freeze bot');
        log('.move <x> <y> <z>     -> Pathfind to coords');
        log('.attack               -> Hit nearest mob/player');
        log('.attack stop          -> Stop attacking');
        log(`.autoeat [on/off]     -> Auto eating      [${state.autoEatEnabled     ? 'ON' : 'OFF'}]`);
        log(`.antiafk [on/off]     -> Anti-AFK         [${state.antiAfkEnabled     ? 'ON' : 'OFF'}]`);
        log(`.autorespawn [on/off] -> Auto revive      [${state.autoRespawnEnabled ? 'ON' : 'OFF'}]`);
        log(`.camera [on/off]      -> Head movement    [${state.cameraEnabled      ? 'ON' : 'OFF'}]`);
        log('.respawn              -> Manual respawn');
        log('.config               -> Show config');
        log('.stats                -> Show player stats');
        log('.clear                -> Clear terminal');
        log('.quit                 -> Disconnect & exit');
        log('================================');
        break;

      case 'move':
        if (state.verifying) { log('[Move] Blocked — verification in progress.'); break; }
        if      (args[0] === 'forward') { bot.setControlState('forward', true); log('[Move] Walking forward...'); }
        else if (args[0] === 'stop')    {
          bot.pathfinder.stop();
          ['forward','back','left','right','jump','sprint'].forEach(k => bot.setControlState(k, false));
          log('[Move] Stopped.');
        }
        else if (args.length === 3) {
          const [x, y, z] = args.map(Number);
          if ([x,y,z].some(isNaN)) { log('[Move] Invalid coordinates.'); break; }
          bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
          log(`[Move] Pathfinding to ${x} ${y} ${z}...`);
        } else log('[Move] Usage: .move forward | stop | <x> <y> <z>');
        break;

      case 'attack': {
        if (args[0] === 'stop') { stopAttack(); log('[Attack] Stopped.'); break; }
        if (state.attackActive) { log('[Attack] Already active. Use .attack stop first.'); break; }
        const target = bot.nearestEntity(e => e.type === 'mob') ||
                       bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
        if (!target) { log('[Attack] No target found.'); break; }
        log(`[Attack] Targeting ${target.username || target.name || target.type}`);
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        state.attackActive = true;
        let tickCount  = 0;
        let tickNeeded = 12 + Math.floor(Math.random() * 6);
        function swingTick() {
          if (!target || !bot.entity || target.position.distanceTo(bot.entity.position) > 4.5) { stopAttack(); return; }
          tickCount++;
          if (tickCount >= tickNeeded) {
            bot.attack(target); tickCount = 0; tickNeeded = 12 + Math.floor(Math.random() * 6);
          }
        }
        bot.on('physicsTick', swingTick);
        state._swingTick = swingTick;
        emit('toggles', safeToggles());
        break;
      }

      case 'autoeat':     toggle('autoEatEnabled',     args[0], 'AutoEat');                                break;
      case 'antiafk':     toggle('antiAfkEnabled',     args[0], 'AntiAFK',     startAntiAfk, stopAntiAfk); break;
      case 'autorespawn': toggle('autoRespawnEnabled',  args[0], 'AutoRespawn');                            break;
      case 'camera':      toggle('cameraEnabled',       args[0], 'Camera',      startCamera,  stopCamera);  break;

      case 'respawn': bot.respawn(); log('[*] Respawn sent.'); break;
      case 'clear':   console.clear(); break;

      case 'stats': {
        const s = liveStats();
        if (!s) { log('[Stats] No bot data yet.'); break; }
        log(`[Stats] ❤ ${s.health}/20  🍖 ${s.food}/20  ✨ Lv.${s.xpLevel}  📍 ${s.x}, ${s.y}, ${s.z}`);
        break;
      }

      case 'config':
        log('================================');
        log(`  Host     : ${CONFIG.host}:${CONFIG.port}`);
        log(`  Username : ${CONFIG.username}`);
        log(`  Password : ${CONFIG.password ? '(set)' : '(none)'}`);
        log(`  Version  : ${CONFIG.version}`);
        log(`  Auth     : ${CONFIG.auth}`);
        log(`  Reconnect: #${reconnectAttempts}`);
        log('================================');
        break;

      case 'quit':
      case 'exit':
        log('[Cmd] Shutting down...');
        stopAttack(); bot.removeAllListeners(); bot.quit();
        setTimeout(() => process.exit(0), 1000);
        break;

      default:
        log(`[Cmd] Unknown: .${cmd}  (type .help)`);
    }
  }

  currentHandleCommand = handleCommand;
  return handleCommand;
}

// ─── GUI HTML ─────────────────────────────────────────────────────────────────
const GUI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mineflayer Bot Console</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0d1117;
    --panel:     #161b22;
    --panel2:    #1c2128;
    --border:    #30363d;
    --green:     #3fb950;
    --red:       #f85149;
    --yellow:    #d29922;
    --blue:      #58a6ff;
    --purple:    #bc8cff;
    --orange:    #ffa657;
    --text:      #e6edf3;
    --muted:     #7d8590;
    --dim:       #484f58;
    --radius:    8px;
  }

  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 13px; overflow: hidden; }

  .layout { display: grid; grid-template-columns: 200px 1fr 190px; grid-template-rows: 48px 1fr 48px; height: 100vh; gap: 0; }

  header {
    grid-column: 1 / -1;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px;
    background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .header-left  { display: flex; align-items: center; gap: 10px; }
  .logo-icon    { font-size: 18px; }
  .logo-text    { font-weight: 700; font-size: 14px; letter-spacing: .3px; }
  .logo-sub     { font-size: 11px; color: var(--muted); }
  .conn-badge   { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: var(--panel2); border: 1px solid var(--border); transition: all .3s; }
  .conn-dot     { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); transition: background .3s; }
  .conn-badge.online  { border-color: var(--green); color: var(--green); }
  .conn-badge.online .conn-dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
  .conn-badge.error   { border-color: var(--red);   color: var(--red); }
  .conn-badge.error .conn-dot { background: var(--red); }
  .conn-badge.waiting { border-color: var(--yellow); color: var(--yellow); }
  .conn-badge.waiting .conn-dot { background: var(--yellow); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  .sidebar-left {
    grid-row: 2;
    background: var(--panel); border-right: 1px solid var(--border);
    padding: 14px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
  }

  .section-label { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px; }

  .info-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; }
  .info-key { color: var(--muted); font-size: 11px; }
  .info-val { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .stat-bar-wrap  { margin-bottom: 8px; }
  .stat-bar-label { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
  .stat-bar-track { height: 5px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
  .stat-bar-fill  { height: 100%; border-radius: 3px; transition: width .6s ease; }
  .stat-health .stat-bar-fill { background: var(--red); }
  .stat-food   .stat-bar-fill { background: var(--orange); }
  .stat-xp     .stat-bar-fill { background: var(--green); }

  .pos-box  { background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.8; }
  .pos-axis { color: var(--muted); }

  /* ── Log panel: pure black background like MC chat ── */
  .log-panel {
    grid-row: 2;
    background: #000000;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .log-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .log-filters { display: flex; gap: 4px; }
  .filter-btn {
    padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent;
    color: var(--muted); font-size: 11px; cursor: pointer; transition: all .15s;
  }
  .filter-btn.active { background: var(--panel2); color: var(--text); border-color: var(--dim); }
  .log-output {
    flex: 1; overflow-y: auto; padding: 10px 14px;
    font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.65;
    display: flex; flex-direction: column; gap: 1px;
  }
  .log-output::-webkit-scrollbar       { width: 5px; }
  .log-output::-webkit-scrollbar-track { background: transparent; }
  .log-output::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

  .log-line { display: flex; gap: 8px; align-items: baseline; opacity: 0; animation: fadeIn .15s forwards; }
  .log-time { color: #555555; font-size: 10px; flex-shrink: 0; }
  .log-msg  { word-break: break-word; flex: 1; }

  /* ── Exact Minecraft §color palette ── */
  .log-line.chat    .log-msg { color: #FFFFFF; }   /* §f white  — normal chat  */
  .log-line.system  .log-msg { color: #55FF55; }   /* §a green  — system info  */
  .log-line.error   .log-msg { color: #FF5555; }   /* §c red    — errors/kicks */
  .log-line.sonar   .log-msg { color: #FF55FF; }   /* §d pink   — sonar events */
  .log-line.auth    .log-msg { color: #FFAA00; }   /* §6 gold   — auth/login   */
  .log-line.move    .log-msg { color: #55FFFF; }   /* §b aqua   — movement     */
  .log-line.attack  .log-msg { color: #FF5555; }   /* §c red    — combat       */
  .log-line.gui     .log-msg { color: #AAAAAA; }   /* §7 gray   — gui/internal */
  .log-line.mc      .log-msg { color: #55FF55; font-weight: 500; } /* §a green — sent cmds */

  @keyframes fadeIn { from{opacity:0;transform:translateY(2px)} to{opacity:1;transform:none} }

  .sidebar-right {
    grid-row: 2;
    background: var(--panel); border-left: 1px solid var(--border);
    padding: 14px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
  }

  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 0; border-bottom: 1px solid var(--border);
  }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { font-size: 12px; }
  .toggle-switch { position: relative; width: 32px; height: 18px; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-track { position: absolute; inset: 0; background: var(--dim); border-radius: 9px; transition: background .2s; }
  .toggle-switch input:checked + .toggle-track { background: var(--green); }
  .toggle-thumb { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; background: white; border-radius: 50%; transition: transform .2s; }
  .toggle-switch input:checked ~ .toggle-thumb { transform: translateX(14px); }

  .action-btn {
    width: 100%; padding: 7px 10px; border: 1px solid var(--border); background: var(--panel2);
    color: var(--text); border-radius: 6px; cursor: pointer; font-size: 12px;
    text-align: left; margin-bottom: 5px; transition: all .15s;
  }
  .action-btn:hover { background: var(--bg); border-color: var(--dim); }
  .action-btn .btn-icon { margin-right: 6px; }

  .reconnect-box {
    background: rgba(210,153,34,.08); border: 1px solid rgba(210,153,34,.3);
    border-radius: var(--radius); padding: 8px 10px; font-size: 11px;
    color: var(--yellow); display: none;
  }
  .reconnect-box.visible { display: block; }

  footer {
    grid-column: 1 / -1;
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    background: var(--panel); border-top: 1px solid var(--border);
  }
  .cmd-prompt { color: var(--green); font-family: 'JetBrains Mono', monospace; font-size: 13px; flex-shrink: 0; }
  #cmdInput {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 13px;
    caret-color: var(--green);
  }
  #cmdInput::placeholder { color: var(--dim); }
  .send-btn {
    padding: 6px 14px; background: var(--green); color: #0d1117;
    border: none; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer;
    transition: opacity .15s;
  }
  .send-btn:hover { opacity: .85; }

  .empty-state { color: #AAAAAA; font-size: 12px; text-align: center; margin-top: 40px; }
</style>
</head>
<body>
<div class="layout">

  <header>
    <div class="header-left">
      <span class="logo-icon">⛏</span>
      <div>
        <div class="logo-text">Mineflayer Bot Console</div>
        <div class="logo-sub" id="serverLabel">Connecting...</div>
      </div>
    </div>
    <div class="conn-badge" id="connBadge">
      <div class="conn-dot"></div>
      <span id="connText">Offline</span>
    </div>
  </header>

  <aside class="sidebar-left">
    <div>
      <div class="section-label">Server</div>
      <div class="info-row"><span class="info-key">Host</span><span class="info-val" id="siHost">—</span></div>
      <div class="info-row"><span class="info-key">Port</span><span class="info-val" id="siPort">—</span></div>
      <div class="info-row"><span class="info-key">User</span><span class="info-val" id="siUser">—</span></div>
      <div class="info-row"><span class="info-key">Auth</span><span class="info-val" id="siAuth">—</span></div>
      <div class="info-row"><span class="info-key">Ver.</span><span class="info-val"  id="siVer">—</span></div>
    </div>

    <div>
      <div class="section-label">Player Stats</div>
      <div class="stat-bar-wrap stat-health">
        <div class="stat-bar-label"><span>❤ Health</span><span id="stHealth">—</span></div>
        <div class="stat-bar-track"><div class="stat-bar-fill" id="barHealth" style="width:0%"></div></div>
      </div>
      <div class="stat-bar-wrap stat-food">
        <div class="stat-bar-label"><span>🍖 Food</span><span id="stFood">—</span></div>
        <div class="stat-bar-track"><div class="stat-bar-fill" id="barFood" style="width:0%"></div></div>
      </div>
      <div class="stat-bar-wrap stat-xp">
        <div class="stat-bar-label"><span>✨ XP Level</span><span id="stXP">—</span></div>
        <div class="stat-bar-track"><div class="stat-bar-fill" id="barXP" style="width:0%"></div></div>
      </div>
    </div>

    <div>
      <div class="section-label">Position</div>
      <div class="pos-box">
        <div><span class="pos-axis">X </span><span id="posX">—</span></div>
        <div><span class="pos-axis">Y </span><span id="posY">—</span></div>
        <div><span class="pos-axis">Z </span><span id="posZ">—</span></div>
      </div>
    </div>

    <div class="reconnect-box" id="reconnectBox">
      ↺ Reconnecting...<br>
      Attempt <span id="rcAttempt">—</span> · in <span id="rcDelay">—</span>s
    </div>
  </aside>

  <main class="log-panel">
    <div class="log-toolbar">
      <div class="log-filters">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="chat"  style="color:#FFFFFF">Chat</button>
        <button class="filter-btn" data-filter="error" style="color:#FF5555">Errors</button>
        <button class="filter-btn" data-filter="sonar" style="color:#FF55FF">Sonar</button>
        <button class="filter-btn" data-filter="auth"  style="color:#FFAA00">Auth</button>
      </div>
      <button class="filter-btn" id="clearLogBtn">Clear</button>
    </div>
    <div class="log-output" id="logOutput">
      <div class="empty-state">Waiting for bot to connect...</div>
    </div>
  </main>

  <aside class="sidebar-right">
    <div>
      <div class="section-label">Features</div>
      <div class="toggle-row">
        <span class="toggle-label">Auto Eat</span>
        <label class="toggle-switch">
          <input type="checkbox" id="tAutoEat" onchange="sendToggle('autoeat', this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
      </div>
      <div class="toggle-row">
        <span class="toggle-label">Anti AFK</span>
        <label class="toggle-switch">
          <input type="checkbox" id="tAntiAfk" onchange="sendToggle('antiafk', this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
      </div>
      <div class="toggle-row">
        <span class="toggle-label">Auto Respawn</span>
        <label class="toggle-switch">
          <input type="checkbox" id="tAutoRespawn" onchange="sendToggle('autorespawn', this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
      </div>
      <div class="toggle-row">
        <span class="toggle-label">Camera</span>
        <label class="toggle-switch">
          <input type="checkbox" id="tCamera" onchange="sendToggle('camera', this.checked)">
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
        </label>
      </div>
    </div>

    <div>
      <div class="section-label">Quick Actions</div>
      <button class="action-btn" onclick="send('.stats')">   <span class="btn-icon">📊</span>Show Stats</button>
      <button class="action-btn" onclick="send('.respawn')"> <span class="btn-icon">💫</span>Respawn</button>
      <button class="action-btn" onclick="send('.attack')">  <span class="btn-icon">⚔️</span>Attack Nearest</button>
      <button class="action-btn" onclick="send('.attack stop')"><span class="btn-icon">🛑</span>Stop Attack</button>
      <button class="action-btn" onclick="send('.move stop')"><span class="btn-icon">🚫</span>Stop Moving</button>
      <button class="action-btn" onclick="send('.config')">  <span class="btn-icon">⚙️</span>Show Config</button>
    </div>
  </aside>

  <footer>
    <span class="cmd-prompt">&gt;</span>
    <input id="cmdInput" type="text" placeholder="Type to chat / type /command / use .help for bot commands" autocomplete="off" spellcheck="false">
    <button class="send-btn" onclick="sendInput()">Send</button>
  </footer>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let activeFilter = 'all';
  let logLines = [];

  socket.on('status', d => {
    const badge  = document.getElementById('connBadge');
    const dot    = document.getElementById('connText');
    const server = document.getElementById('serverLabel');
    const rcBox  = document.getElementById('reconnectBox');

    document.getElementById('siHost').textContent = d.host   || '—';
    document.getElementById('siPort').textContent = d.port   || '—';
    document.getElementById('siUser').textContent = d.username || '—';
    document.getElementById('siAuth').textContent = d.auth   || '—';
    document.getElementById('siVer').textContent  = d.version || '—';
    server.textContent = d.host ? d.host + ':' + d.port : 'Connecting...';

    if (d.connected) {
      badge.className = 'conn-badge online'; dot.textContent = 'Online';
      rcBox.classList.remove('visible');
    } else if (d.reconnecting) {
      badge.className = 'conn-badge waiting'; dot.textContent = 'Reconnecting';
      document.getElementById('rcAttempt').textContent = d.attempt || '?';
      document.getElementById('rcDelay').textContent   = d.nextRetry || '?';
      rcBox.classList.add('visible');
    } else {
      badge.className = 'conn-badge error'; dot.textContent = 'Offline';
    }
  });

  socket.on('log', d => {
    const empty = document.querySelector('.empty-state');
    if (empty) empty.remove();
    logLines.push(d);
    if (logLines.length > 2000) logLines.shift();
    appendLogLine(d);
  });

  socket.on('stats', d => {
    document.getElementById('stHealth').textContent = d.health + '/20';
    document.getElementById('stFood').textContent   = d.food   + '/20';
    document.getElementById('stXP').textContent     = 'Lv.' + d.xpLevel;
    document.getElementById('barHealth').style.width = ((d.health / 20) * 100) + '%';
    document.getElementById('barFood').style.width   = ((d.food   / 20) * 100) + '%';
    document.getElementById('barXP').style.width     = Math.min(d.xpLevel * 5, 100) + '%';
    document.getElementById('posX').textContent = d.x;
    document.getElementById('posY').textContent = d.y;
    document.getElementById('posZ').textContent = d.z;
  });

  socket.on('toggles', d => {
    setToggle('tAutoEat',     d.autoEatEnabled);
    setToggle('tAntiAfk',     d.antiAfkEnabled);
    setToggle('tAutoRespawn', d.autoRespawnEnabled);
    setToggle('tCamera',      d.cameraEnabled);
  });

  const MC_COLORS = {
    '0':'#000000','1':'#0000AA','2':'#00AA00','3':'#00AAAA',
    '4':'#AA0000','5':'#AA00AA','6':'#FFAA00','7':'#AAAAAA',
    '8':'#555555','9':'#5555FF','a':'#55FF55','b':'#55FFFF',
    'c':'#FF5555','d':'#FF55FF','e':'#FFFF55','f':'#FFFFFF',
  };
  function motdToHtml(str) {
    if (!str) return '';
    let out = ''; let spans = 0;
    const close = () => { let s = ''; for (let j=0;j<spans;j++) s+='</span>'; spans=0; return s; };
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\u00A7' && i + 1 < str.length) {
        const code = str[i+1].toLowerCase(); i++;
        if (MC_COLORS[code]) { out += close() + '<span style="color:' + MC_COLORS[code] + '">'; spans++; }
        else if (code === 'l') { out += '<span style="font-weight:bold">'; spans++; }
        else if (code === 'o') { out += '<span style="font-style:italic">'; spans++; }
        else if (code === 'n') { out += '<span style="text-decoration:underline">'; spans++; }
        else if (code === 'r') { out += close(); }
      } else {
        if      (ch === '&') out += '&amp;';
        else if (ch === '<') out += '&lt;';
        else if (ch === '>') out += '&gt;';
        else out += ch;
      }
    }
    return out + close();
  }

  function appendLogLine(d) {
    if (activeFilter !== 'all' && d.type !== activeFilter) return;
    const el = document.createElement('div');
    el.className = 'log-line ' + (d.type || 'system');
    el.dataset.type = d.type || 'system';
    const bodyHtml = (d.type === 'chat' && d.motd) ? motdToHtml(d.motd) : escapeHtml(d.msg);
    el.innerHTML = '<span class="log-time">' + escapeHtml(d.time) + '</span>' +
                   '<span class="log-msg">'  + bodyHtml + '</span>';
    const out = document.getElementById('logOutput');
    out.appendChild(el);
    out.scrollTop = out.scrollHeight;
    while (out.childElementCount > 500) out.removeChild(out.firstChild);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      const out = document.getElementById('logOutput');
      out.innerHTML = '';
      logLines.forEach(d => { if (activeFilter === 'all' || d.type === activeFilter) appendLogLine(d); });
    });
  });

  document.getElementById('clearLogBtn').addEventListener('click', () => {
    logLines = [];
    document.getElementById('logOutput').innerHTML = '<div class="empty-state">Log cleared.</div>';
  });

  function send(cmd) { socket.emit('command', cmd); }

  function sendInput() {
    const input = document.getElementById('cmdInput');
    const val   = input.value.trim();
    if (!val) return;
    send(val);
    input.value = '';
  }

  function sendToggle(feature, on) { send('.' + feature + ' ' + (on ? 'on' : 'off')); }
  function setToggle(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }

  document.getElementById('cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendInput(); });
</script>
</body>
</html>`;

// ─── Entry point ──────────────────────────────────────────────────────────────
(async () => {
  CONFIG = await getConfig();
  tryStartGUI();
  const handleCommand = createBot();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => handleCommand(line.trim()));
})();
