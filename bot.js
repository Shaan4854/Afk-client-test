'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.on('uncaughtException', (err) => {
  Logger.error(`Uncaught exception: ${err?.stack || err}`);
  Logger.flush();
});
process.on('unhandledRejection', (reason) => {
  Logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  Logger.flush();
});

// ─── UTILITIES ───────────────────────────────────────────────────────────────

class Utils {
  static humanDelay(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  static versionAtLeast(version, target) {
    if (!version) return false;
    const a = String(version).split('.').map(Number);
    const b = String(target).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] || 0, bv = b[i] || 0;
      if (av !== bv) return av > bv;
    }
    return true;
  }

  static extractText(obj) {
    if (typeof obj === 'string') return obj;
    if (obj?.value !== undefined) return this.extractText(obj.value);
    if (Array.isArray(obj)) return obj.map(this.extractText).join('');
    if (typeof obj === 'object') {
      const parts = [];
      if (obj.text) parts.push(this.extractText(obj.text));
      if (obj.extra) parts.push(this.extractText(obj.extra));
      return parts.join('');
    }
    return '';
  }
}

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

class ConfigManager {
  static CONFIG_FILE = path.join(__dirname, 'bot-config.json');
  static current = {};

  static load() {
    try {
      if (fs.existsSync(this.CONFIG_FILE)) return JSON.parse(fs.readFileSync(this.CONFIG_FILE, 'utf8'));
    } catch {}
    return null;
  }

  static save(cfg) {
    try { fs.writeFileSync(this.CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
  }

  static getPublicConfig() {
    const { password, ...safe } = this.current;
    return safe;
  }

  static async promptSetup() {
    const saved = this.load();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = (q) => new Promise(res => rl.question(q, a => res(a.trim())));

    console.log('\n================================');
    console.log('       MINEFLAYER BOT SETUP     ');
    console.log('================================');

    if (saved) {
      console.log('  Saved config found:');
      console.log(`    Host     : ${saved.host}:${saved.port}`);
      console.log(`    Username : ${saved.username}`);
      console.log(`    Password : ${saved.password ? '(set)' : '(none)'}`);
      console.log(`    Version  : ${saved.version || 'auto-detect'}`);
      console.log(`    Auth     : ${saved.auth}`);
      const use = await prompt('Use saved config? [Y/n]: ');
      if (!use || use.toLowerCase() === 'y') { 
        rl.close(); 
        console.log('================================\n'); 
        this.current = saved;
        return; 
      }
    }

    const host = (await prompt(`Server IP   [${saved?.host || 'localhost'}]: `)) || saved?.host || 'localhost';
    const port = parseInt(await prompt(`Server Port [${saved?.port || 25565}]: `)) || saved?.port || 25565;
    const username = (await prompt(`Username    [${saved?.username || ''}]: `)) || saved?.username || 'Bot_' + Math.floor(Math.random() * 9999);
    const password = (await prompt(`Password    [for /login — blank to skip]: `)) || saved?.password || '';
    const version = (await prompt(`MC Version  [${saved?.version || 'auto-detect'}] (blank = auto): `)) || saved?.version || false;
    
    console.log('  Auth mode: (1) offline  (2) microsoft');
    const authRaw = (await prompt(`Auth mode   [${saved?.auth === 'microsoft' ? '2' : '1'}]: `)) || (saved?.auth === 'microsoft' ? '2' : '1');
    const auth = authRaw === '2' ? 'microsoft' : 'offline';
    const guiPort = parseInt(await prompt(`GUI port    [${saved?.guiPort || 3000}]: `)) || saved?.guiPort || 3000;

    rl.close();
    this.current = { host, port, username, password, version, auth, guiPort };

    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const savePrompt = await new Promise(res => rl2.question('Save config? [Y/n]: ', a => res(a.trim())));
    rl2.close();
    
    if (!savePrompt || savePrompt.toLowerCase() === 'y') {
      this.save(this.current);
      console.log('[Config] Saved to bot-config.json');
    }
    console.log('================================\n');
  }
}

// ─── LOGGING & BUFFERING ─────────────────────────────────────────────────────

class Logger {
  static FLUSH_MS = 80;
  static consoleBuffer = [];
  static socketBuffer = [];
  static timer = null;
  static io = null;

  static init(ioInstance) {
    this.io = ioInstance;
    
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - 1000;
      lastTick = now;
      if (drift > 250) this.warn(`Event loop lagged ~${drift}ms — packets may have bunched up.`);
    }, 1000);
  }

  static scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.FLUSH_MS);
  }

  static flush() {
    this.timer = null;
    if (this.consoleBuffer.length) {
      process.stdout.write(this.consoleBuffer.join('\n') + '\n');
      this.consoleBuffer = [];
    }
    if (this.socketBuffer.length && this.io) {
      this.io.emit('logBatch', this.socketBuffer);
      this.socketBuffer = [];
    }
  }

  static raw(msg) {
    this.consoleBuffer.push(msg);
    this.scheduleFlush();
  }

  static log(msg, type = null, motd = null) {
    this.raw(msg);
    if (!type) {
      if (msg.startsWith('[Chat]')) type = 'chat';
      else if (msg.startsWith('[!]')) type = 'error';
      else if (msg.startsWith('[Sonar]')) type = 'sonar';
      else if (msg.startsWith('[Auth]')) type = 'auth';
      else if (msg.startsWith('[Move]')) type = 'move';
      else if (msg.startsWith('[Attack]')) type = 'attack';
      else if (msg.startsWith('[MC]')) type = 'mc';
      else if (msg.startsWith('[GUI]')) type = 'gui';
      else type = 'system';
    }
    this.socketBuffer.push({ msg, type, motd, time: new Date().toLocaleTimeString() });
    this.scheduleFlush();
  }

  static error(msg) { this.log(`[!] ${msg}`, 'error'); }
  static warn(msg) { this.log(`[!] ${msg}`, 'system'); }
  static info(msg) { this.log(`[*] ${msg}`, 'system'); }
}

// ─── GUI SERVER ──────────────────────────────────────────────────────────────

class DashboardServer {
  static io = null;
  static clients = 0;
  static commandCallback = null;

  static start() {
    try {
      const express = require('express');
      const { Server } = require('socket.io');
      const app = express();
      const srv = http.createServer(app);
      this.io = new Server(srv);

      app.get('/', (_req, res) => res.send(this.getHTML()));

      this.io.on('connection', socket => {
        this.clients++;
        socket.emit('status', { connected: BotController.isConnected(), ...ConfigManager.getPublicConfig() });
        socket.emit('toggles', BotController.getToggles());
        
        if (BotController.isConnected()) {
          socket.emit('stats', BotController.getStats());
        }

        socket.on('command', cmd => {
          if (typeof cmd === 'string' && this.commandCallback) {
            Logger.log(`[GUI] Command: ${cmd}`, 'gui');
            this.commandCallback(cmd.trim());
          }
        });

        socket.on('disconnect', () => this.clients--);
      });

      srv.on('error', (err) => Logger.error(`[GUI] Server error: ${err.message}`));
      srv.listen(ConfigManager.current.guiPort || 3000, () => {
        Logger.info(`[GUI] Dashboard → http://localhost:${ConfigManager.current.guiPort || 3000}`);
      });

      Logger.init(this.io);
      return true;
    } catch {
      Logger.init(null);
      Logger.warn('[GUI] Web dashboard not available. Run: npm install express socket.io');
      return false;
    }
  }

  static emit(event, data) {
    if (this.io) this.io.emit(event, data);
  }

  static onCommand(cb) {
    this.commandCallback = cb;
  }

  static getHTML() {
    return GUI_HTML_PAYLOAD;
  }
}

// ─── BOT BEHAVIOR CONTROLLER ─────────────────────────────────────────────────

class BotController {
  static activeInstance = null;
  static reconnectAttempts = 0;
  
  static FOOD_PRIORITY = {
    golden_carrot: 10, cooked_porkchop: 9, cooked_beef: 9, cooked_mutton: 9,
    cooked_salmon: 8, cooked_chicken: 8, cooked_cod: 7, cooked_rabbit: 7,
    bread: 6, baked_potato: 6, mushroom_stew: 7, rabbit_stew: 8,
    pumpkin_pie: 7, apple: 5, sweet_berries: 3, carrot: 3,
    melon_slice: 2, cookie: 2, dried_kelp: 1, chorus_fruit: 1,
  };

  constructor() {
    this.bot = null;
    this.state = {
      autoEatEnabled: true,
      antiAfkEnabled: true,
      autoRespawnEnabled: true,
      cameraEnabled: true,
      verifying: false,
      loggedIn: false,
      loginSent: false,
      eating: false,
      attackActive: false,
    };
    this.timers = new Set();
    this.intervals = new Set();
    this.swingTickHandler = null;
    this.tickEndSupported = false;
    this.tickEndWorking = true;
  }

  static isConnected() {
    return !!this.activeInstance?.bot?.entity;
  }

  static getToggles() {
    if (!this.activeInstance) return { autoEatEnabled: true, antiAfkEnabled: true, autoRespawnEnabled: true, cameraEnabled: true };
    return {
      autoEatEnabled: this.activeInstance.state.autoEatEnabled,
      antiAfkEnabled: this.activeInstance.state.antiAfkEnabled,
      autoRespawnEnabled: this.activeInstance.state.autoRespawnEnabled,
      cameraEnabled: this.activeInstance.state.cameraEnabled,
      attackActive: this.activeInstance.state.attackActive,
      loggedIn: this.activeInstance.state.loggedIn,
    };
  }

  static getStats() {
    const inst = this.activeInstance;
    if (!inst?.bot?.entity) return null;
    const pos = inst.bot.entity.position;
    return {
      health: Math.round((inst.bot.health || 0) * 10) / 10,
      food: Math.round((inst.bot.food || 0) * 10) / 10,
      xpLevel: inst.bot.experience?.level || 0,
      x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1),
      loggedIn: inst.state.loggedIn,
    };
  }

  registerTimeout(fn, delay) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delay);
    this.timers.add(id);
    return id;
  }

  registerInterval(fn, delay) {
    const id = setInterval(fn, delay);
    this.intervals.add(id);
    return id;
  }

  clearAllTimers() {
    for (const id of this.timers) clearTimeout(id);
    for (const id of this.intervals) clearInterval(id);
    this.timers.clear();
    this.intervals.clear();
  }

  safeChat(msg) {
    try { 
      this.bot.chat(msg); 
      return true; 
    } catch (e) { 
      Logger.error(`Chat send failed: ${e.message}`); 
      return false; 
    }
  }

  connect() {
    const cfg = ConfigManager.current;
    Logger.info(`Connecting to ${cfg.host}:${cfg.port} as '${cfg.username}' (${cfg.auth})...`);
    DashboardServer.emit('status', { connected: false, reconnecting: true, attempt: BotController.reconnectAttempts, ...ConfigManager.getPublicConfig() });

    this.bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      version: cfg.version,
      auth: cfg.auth,
      checkTimeoutInterval: 30000,
      physicsEnabled: true,
      hideErrors: false,
    });

    this.bot.loadPlugin(pathfinder);
    this.bindEvents();
  }

  bindEvents() {
    this.bot.once('spawn', this.onSpawn.bind(this));
    this.bot.on('message', this.onMessage.bind(this));
    this.bot.on('health', this.onHealth.bind(this));
    this.bot.on('death', this.onDeath.bind(this));
    this.bot.on('kicked', this.onKicked.bind(this));
    this.bot.on('end', this.onEnd.bind(this));
    this.bot.on('error', (err) => Logger.error(`Error: ${err.message}`));
    this.bot.on('physicsTick', this.onPhysicsTick.bind(this));
    this.bot.on('forcedMove', this.onForcedMove.bind(this));
  }

  onSpawn() {
    BotController.reconnectAttempts = 0;
    this.state.loginSent = false;
    this.state.eating = false;
    this.tickEndSupported = Utils.versionAtLeast(this.bot.version, '1.21.2');
    
    Logger.info(`Spawned as ${this.bot.username}`);
    
    const movements = new Movements(this.bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    this.bot.pathfinder.setMovements(movements);

    DashboardServer.emit('status', { connected: true, reconnecting: false, username: this.bot.username, ...ConfigManager.getPublicConfig() });
    
    if (!ConfigManager.current.password) this.state.loggedIn = true;
    
    this.registerTimeout(() => {
      if (!this.state.verifying) {
        this.startAntiAfk();
        this.startCamera();
      }
    }, Utils.humanDelay(1500, 3000));

    this.registerInterval(() => {
      const s = BotController.getStats();
      if (s) DashboardServer.emit('stats', s);
    }, 2000);
  }

  onPhysicsTick() {
    if (this.tickEndSupported && this.tickEndWorking) {
      try { this.bot._client.write('tick_end', {}); }
      catch (e) {
        this.tickEndWorking = false;
        Logger.error(`client_tick_end packet rejected (${e.message}) — disabling.`);
      }
    }
  }

  onForcedMove() {
    if (!this.state.verifying) {
      this.state.verifying = true;
      Logger.log('[Sonar] Teleported — letting physics settle...', 'sonar');
      this.bot.pathfinder.stop();
      ['forward','back','left','right','jump','sprint','sneak'].forEach(k => this.bot.setControlState(k, false));
      
      this.bot.physicsEnabled = false;
      this.registerTimeout(() => { this.bot.physicsEnabled = true; }, 150);
    }
    
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      this.state.verifying = false;
      this.verifyTimer = null;
      Logger.log('[Sonar] Verification window passed — resuming.', 'sonar');
    }, Utils.humanDelay(2500, 4500));
  }

  onMessage(jsonMsg) {
    const raw = jsonMsg.toString();
    const motd = typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : raw;
    const text = raw.toLowerCase();
    
    Logger.log(`[Chat] ${raw}`, 'chat', motd);

    if (!raw.includes('<') && !raw.includes('>')) {
      const cfg = ConfigManager.current;
      
      if (cfg.password && !this.state.loggedIn && !this.state.loginSent) {
        if (text.includes('/login') && (text.includes('log in') || text.includes('login') || text.includes('please'))) {
          this.state.loginSent = true;
          this.registerTimeout(() => { 
            this.safeChat(`/login ${cfg.password}`); 
            Logger.log('[Auth] Sent: /login ***', 'auth'); 
          }, Utils.humanDelay(600, 1200));
          return;
        }
        if (text.includes('/register') && (text.includes('register') || text.includes('please'))) {
          this.state.loginSent = true;
          this.registerTimeout(() => { 
            this.safeChat(`/register ${cfg.password} ${cfg.password}`); 
            Logger.log('[Auth] Sent: /register ***', 'auth'); 
          }, Utils.humanDelay(600, 1200));
          return;
        }
      }

      if (!this.state.loggedIn && (text.includes('logged in') || text.includes('welcome back') || text.includes('successfully') || text.includes('authenticated'))) {
        this.state.loggedIn = true;
        Logger.log('[Auth] Logged in successfully.', 'auth');
        DashboardServer.emit('toggles', BotController.getToggles());
        return;
      }

      const verifyMatch = raw.match(/\/verify\s+([A-Za-z0-9_-]{3,32})/);
      if (verifyMatch) {
        this.registerTimeout(() => { 
          this.safeChat(`/verify ${verifyMatch[1]}`); 
          Logger.log(`[Sonar] Sent: /verify ${verifyMatch[1]}`, 'sonar'); 
        }, Utils.humanDelay(800, 1400));
        return;
      }
      if (text.includes('/verify') && (text.includes('type') || text.includes('enter') || text.includes('run'))) {
        this.registerTimeout(() => { 
          this.safeChat('/verify'); 
          Logger.log('[Sonar] Sent: /verify', 'sonar'); 
        }, Utils.humanDelay(900, 1600));
      }
    }
  }

  onHealth() {
    if (!this.state.autoEatEnabled || this.state.verifying || this.bot.usingHeldItem || this.state.eating) return;
    if (this.bot.food < 18) {
      const food = this.bot.inventory.items()
        .filter(i => BotController.FOOD_PRIORITY[i.name] !== undefined)
        .sort((a, b) => (BotController.FOOD_PRIORITY[b.name] || 0) - (BotController.FOOD_PRIORITY[a.name] || 0))[0] || null;

      if (food) {
        this.state.eating = true;
        this.bot.equip(food, 'hand')
          .then(() => this.bot.consume())
          .catch(() => {})
          .finally(() => { this.state.eating = false; });
      }
    }
  }

  onDeath() {
    Logger.error('Bot died.');
    if (this.state.autoRespawnEnabled) {
      this.registerTimeout(() => { 
        this.bot.respawn(); 
        Logger.info('Auto-respawned.'); 
      }, Utils.humanDelay(800, 2500));
    }
  }

  onKicked(reason) {
    let readable;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      readable = Utils.extractText(parsed) || String(reason);
    } catch {
      readable = String(reason);
    }
    
    Logger.error(`Kicked: ${readable}`);
    const lower = readable.toLowerCase();
    
    if (lower.includes('bot verification')) Logger.log('[Sonar] ⚠ Failed: gravity/main check', 'sonar');
    else if (lower.includes('too many')) Logger.log('[Sonar] ⚠ Failed: reconnect rate-limit — backing off', 'sonar');
    else if (lower.includes('captcha')) Logger.log('[Sonar] ⚠ Failed: CAPTCHA (map-image)', 'sonar');
  }

  onEnd(reason) {
    this.teardown();
    
    BotController.reconnectAttempts++;
    const base = 7000, cap = 120000;
    const delay = Math.min(base * Math.pow(2, BotController.reconnectAttempts - 1), cap) + Math.floor(Math.random() * 3000);
    
    Logger.error(`Disconnected: ${reason} (attempt #${BotController.reconnectAttempts}) — reconnecting in ${(delay / 1000).toFixed(1)} s...`);
    DashboardServer.emit('status', { connected: false, reconnecting: true, attempt: BotController.reconnectAttempts, nextRetry: (delay / 1000).toFixed(1), ...ConfigManager.getPublicConfig() });
    
    setTimeout(() => {
      BotController.activeInstance = new BotController();
      BotController.activeInstance.connect();
    }, delay);
  }

  teardown() {
    this.stopAttack();
    this.clearAllTimers();
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch {}
    }
  }

  startAntiAfk() {
    if (!this.state.antiAfkEnabled) return;
    this.registerTimeout(() => {
      if (!this.state.verifying && this.bot.entity) {
        const roll = Math.random();
        if (roll < 0.40) { 
          this.bot.setControlState('jump', true); 
          this.registerTimeout(() => this.bot.setControlState('jump', false), Utils.humanDelay(150, 250)); 
        } else if (roll < 0.65) { 
          this.bot.setControlState('sneak', true); 
          this.registerTimeout(() => this.bot.setControlState('sneak', false), Utils.humanDelay(300, 700)); 
        } else if (roll < 0.82) { 
          this.bot.setControlState('forward', true); 
          this.registerTimeout(() => this.bot.setControlState('forward', false), Utils.humanDelay(100, 300)); 
        } else {
          const newPitch = this.bot.entity.pitch + (Math.random() - 0.5) * 0.5;
          this.bot.look(this.bot.entity.yaw + (Math.random() - 0.5) * 1.5, Math.max(-1.4, Math.min(1.4, newPitch)), false);
        }
      }
      this.startAntiAfk();
    }, Utils.humanDelay(25000, 45000));
  }

  startCamera() {
    if (!this.state.cameraEnabled) return;
    this.registerTimeout(() => {
      if (!this.state.verifying && this.bot.entity) {
        const newPitch = this.bot.entity.pitch + (Math.random() - 0.5) * (0.15 + Math.random() * 0.35);
        this.bot.look(this.bot.entity.yaw + (Math.random() - 0.5) * (0.2 + Math.random() * 0.5), Math.max(-1.5, Math.min(1.5, newPitch)), false);
      }
      this.startCamera();
    }, Utils.humanDelay(1500, 6500));
  }

  stopAttack() {
    if (this.swingTickHandler) {
      this.bot.removeListener('physicsTick', this.swingTickHandler);
      this.swingTickHandler = null;
    }
    this.state.attackActive = false;
    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
    DashboardServer.emit('toggles', BotController.getToggles());
  }

  toggle(key, arg, label) {
    if (arg === 'on') { this.state[key] = true; Logger.log(`[${label}] Enabled.`, 'gui'); }
    else if (arg === 'off') { this.state[key] = false; Logger.log(`[${label}] Disabled.`, 'gui'); }
    else Logger.log(`[${label}] Currently ${this.state[key] ? 'ON' : 'OFF'}`, 'gui');
    DashboardServer.emit('toggles', BotController.getToggles());
  }
}

// ─── COMMAND ROUTER ──────────────────────────────────────────────────────────

class CommandRouter {
  static handle(input) {
    const inst = BotController.activeInstance;
    if (!inst || !inst.bot) {
      Logger.error('Not connected — command ignored.');
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith('.')) {
      inst.safeChat(trimmed);
      Logger.log(`[MC] ▶ ${trimmed}`, 'mc');
      return;
    }

    const parts = trimmed.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const commands = {
      help: () => {
        Logger.info('========== BOT COMMANDS ==========');
        Logger.info('.move forward         -> Walk straight');
        Logger.info('.move stop            -> Freeze bot');
        Logger.info('.move <x> <y> <z>     -> Pathfind to coords');
        Logger.info('.attack               -> Hit nearest mob/player');
        Logger.info('.attack stop          -> Stop attacking');
        Logger.info(`.autoeat [on/off]     -> Auto eating      [${inst.state.autoEatEnabled ? 'ON' : 'OFF'}]`);
        Logger.info(`.antiafk [on/off]     -> Anti-AFK         [${inst.state.antiAfkEnabled ? 'ON' : 'OFF'}]`);
        Logger.info(`.autorespawn [on/off] -> Auto revive      [${inst.state.autoRespawnEnabled ? 'ON' : 'OFF'}]`);
        Logger.info(`.camera [on/off]      -> Head movement    [${inst.state.cameraEnabled ? 'ON' : 'OFF'}]`);
        Logger.info('.respawn              -> Manual respawn');
        Logger.info('.config               -> Show config');
        Logger.info('.stats                -> Show player stats');
        Logger.info('.clear                -> Clear terminal');
        Logger.info('.quit                 -> Disconnect & exit');
        Logger.info('==================================');
      },
      move: () => {
        if (inst.state.verifying) return Logger.log('[Move] Blocked — verification in progress.', 'move');
        if (args[0] === 'forward') { 
          inst.bot.setControlState('forward', true); 
          Logger.log('[Move] Walking forward...', 'move'); 
        }
        else if (args[0] === 'stop') {
          inst.bot.pathfinder.stop();
          ['forward','back','left','right','jump','sprint'].forEach(k => inst.bot.setControlState(k, false));
          Logger.log('[Move] Stopped.', 'move');
        }
        else if (args.length === 3) {
          const [x, y, z] = args.map(Number);
          if ([x,y,z].some(isNaN)) return Logger.log('[Move] Invalid coordinates.', 'move');
          inst.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
          Logger.log(`[Move] Pathfinding to ${x} ${y} ${z}...`, 'move');
        } else Logger.log('[Move] Usage: .move forward | stop | <x> <y> <z>', 'move');
      },
      attack: () => {
        if (args[0] === 'stop') { 
          inst.stopAttack(); 
          Logger.log('[Attack] Stopped.', 'attack'); 
          return; 
        }
        if (inst.state.attackActive) return Logger.log('[Attack] Already active. Use .attack stop first.', 'attack');
        
        const target = inst.bot.nearestEntity(e => e.type === 'mob') || inst.bot.nearestEntity(e => e.type === 'player' && e.username !== inst.bot.username);
        if (!target) return Logger.log('[Attack] No target found.', 'attack');
        
        Logger.log(`[Attack] Targeting ${target.username || target.name || target.type}`, 'attack');
        inst.bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        inst.state.attackActive = true;
        
        let tickCount = 0;
        let tickNeeded = 12 + Math.floor(Math.random() * 6);
        
        inst.swingTickHandler = () => {
          if (!target || !inst.bot.entity || target.position.distanceTo(inst.bot.entity.position) > 4.5) { 
            inst.stopAttack(); 
            return; 
          }
          if (++tickCount >= tickNeeded) {
            inst.bot.attack(target); 
            tickCount = 0; 
            tickNeeded = 12 + Math.floor(Math.random() * 6);
          }
        };
        
        inst.bot.on('physicsTick', inst.swingTickHandler);
        DashboardServer.emit('toggles', BotController.getToggles());
      },
      autoeat: () => inst.toggle('autoEatEnabled', args[0], 'AutoEat'),
      antiafk: () => inst.toggle('antiAfkEnabled', args[0], 'AntiAFK'),
      autorespawn: () => inst.toggle('autoRespawnEnabled', args[0], 'AutoRespawn'),
      camera: () => inst.toggle('cameraEnabled', args[0], 'Camera'),
      respawn: () => { inst.bot.respawn(); Logger.info('Respawn sent.'); },
      clear: () => console.clear(),
      stats: () => {
        const s = BotController.getStats();
        if (!s) return Logger.warn('No bot data yet.');
        Logger.info(`❤ ${s.health}/20  🍖 ${s.food}/20  ✨ Lv.${s.xpLevel}  📍 ${s.x}, ${s.y}, ${s.z}`);
      },
      config: () => {
        const c = ConfigManager.current;
        Logger.info('========== CURRENT CONFIG ==========');
        Logger.info(`  Host     : ${c.host}:${c.port}`);
        Logger.info(`  Username : ${c.username}`);
        Logger.info(`  Password : ${c.password ? '(set)' : '(none)'}`);
        Logger.info(`  Version  : ${c.version || 'auto-detect'}`);
        Logger.info(`  Auth     : ${c.auth}`);
        Logger.info(`  Reconnect: #${BotController.reconnectAttempts}`);
        Logger.info('====================================');
      },
      quit: () => {
        Logger.info('Shutting down...');
        Logger.flush();
        inst.teardown();
        setTimeout(() => process.exit(0), 1000);
      },
      exit: () => commands.quit()
    };

    if (commands[cmd]) commands[cmd]();
    else Logger.warn(`Unknown: .${cmd} (type .help)`);
  }
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

(async () => {
  await ConfigManager.promptSetup();
  
  DashboardServer.onCommand(CommandRouter.handle);
  DashboardServer.start();
  
  BotController.activeInstance = new BotController();
  BotController.activeInstance.connect();
  
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => CommandRouter.handle(line));
})();

// ─── GUI HTML PAYLOAD ────────────────────────────────────────────────────────
const GUI_HTML_PAYLOAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mineflayer Bot Console</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2128; --border: #30363d;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
    --purple: #bc8cff; --orange: #ffa657; --text: #e6edf3; --muted: #7d8590;
    --dim: #484f58; --radius: 8px;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 13px; overflow: hidden; }
  .layout { display: grid; grid-template-columns: 200px 1fr 190px; grid-template-rows: 48px 1fr 48px; height: 100vh; gap: 0; }
  header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .header-left { display: flex; align-items: center; gap: 10px; }
  .logo-icon { font-size: 18px; }
  .logo-text { font-weight: 700; font-size: 14px; letter-spacing: .3px; }
  .logo-sub { font-size: 11px; color: var(--muted); }
  .conn-badge { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: var(--panel2); border: 1px solid var(--border); transition: all .3s; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); transition: background .3s; }
  .conn-badge.online { border-color: var(--green); color: var(--green); }
  .conn-badge.online .conn-dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
  .conn-badge.error { border-color: var(--red); color: var(--red); }
  .conn-badge.error .conn-dot { background: var(--red); }
  .conn-badge.waiting { border-color: var(--yellow); color: var(--yellow); }
  .conn-badge.waiting .conn-dot { background: var(--yellow); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .sidebar-left { grid-row: 2; background: var(--panel); border-right: 1px solid var(--border); padding: 14px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
  .section-label { font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 8px; }
  .info-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; }
  .info-key { color: var(--muted); font-size: 11px; }
  .info-val { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat-bar-wrap { margin-bottom: 8px; }
  .stat-bar-label { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
  .stat-bar-track { height: 5px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
  .stat-bar-fill { height: 100%; border-radius: 3px; transition: width .6s ease; }
  .stat-health .stat-bar-fill { background: var(--red); }
  .stat-food .stat-bar-fill { background: var(--orange); }
  .stat-xp .stat-bar-fill { background: var(--green); }
  .pos-box { background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.8; }
  .pos-axis { color: var(--muted); }
  .log-panel { grid-row: 2; background: #000000; display: flex; flex-direction: column; overflow: hidden; }
  .log-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .log-filters { display: flex; gap: 4px; }
  .filter-btn { padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; transition: all .15s; }
  .filter-btn.active { background: var(--panel2); color: var(--text); border-color: var(--dim); }
  .log-output { flex: 1; overflow-y: auto; padding: 10px 14px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.65; display: flex; flex-direction: column; gap: 1px; }
  .log-output::-webkit-scrollbar { width: 5px; }
  .log-output::-webkit-scrollbar-track { background: transparent; }
  .log-output::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  .log-line { display: flex; gap: 8px; align-items: baseline; opacity: 0; animation: fadeIn .15s forwards; }
  .log-time { color: #555555; font-size: 10px; flex-shrink: 0; }
  .log-msg { word-break: break-word; flex: 1; }
  .log-line.chat .log-msg { color: #FFFFFF; }
  .log-line.system .log-msg { color: #55FF55; }
  .log-line.error .log-msg { color: #FF5555; }
  .log-line.sonar .log-msg { color: #FF55FF; }
  .log-line.auth .log-msg { color: #FFAA00; }
  .log-line.move .log-msg { color: #55FFFF; }
  .log-line.attack .log-msg { color: #FF5555; }
  .log-line.gui .log-msg { color: #AAAAAA; }
  .log-line.mc .log-msg { color: #55FF55; font-weight: 500; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(2px)} to{opacity:1;transform:none} }
  .sidebar-right { grid-row: 2; background: var(--panel); border-left: 1px solid var(--border); padding: 14px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { font-size: 12px; }
  .toggle-switch { position: relative; width: 32px; height: 18px; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-track { position: absolute; inset: 0; background: var(--dim); border-radius: 9px; transition: background .2s; }
  .toggle-switch input:checked + .toggle-track { background: var(--green); }
  .toggle-thumb { position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; background: white; border-radius: 50%; transition: transform .2s; }
  .toggle-switch input:checked ~ .toggle-thumb { transform: translateX(14px); }
  .action-btn { width: 100%; padding: 7px 10px; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 12px; text-align: left; margin-bottom: 5px; transition: all .15s; }
  .action-btn:hover { background: var(--bg); border-color: var(--dim); }
  .action-btn .btn-icon { margin-right: 6px; }
  .reconnect-box { background: rgba(210,153,34,.08); border: 1px solid rgba(210,153,34,.3); border-radius: var(--radius); padding: 8px 10px; font-size: 11px; color: var(--yellow); display: none; }
  .reconnect-box.visible { display: block; }
  footer { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--panel); border-top: 1px solid var(--border); }
  .cmd-prompt { color: var(--green); font-family: 'JetBrains Mono', monospace; font-size: 13px; flex-shrink: 0; }
  #cmdInput { flex: 1; background: transparent; border: none; outline: none; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 13px; caret-color: var(--green); }
  #cmdInput::placeholder { color: var(--dim); }
  .send-btn { padding: 6px 14px; background: var(--green); color: #0d1117; border: none; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; transition: opacity .15s; }
  .send-btn:hover { opacity: .85; }
  .empty-state { color: #AAAAAA; font-size: 12px; text-align: center; margin-top: 40px; }
</style>
</head>
<body>
<div class="layout">
  <header>
    <div class="header-left">
      <span class="logo-icon">⛏</span>
      <div><div class="logo-text">Mineflayer Bot Console</div><div class="logo-sub" id="serverLabel">Connecting...</div></div>
    </div>
    <div class="conn-badge" id="connBadge"><div class="conn-dot"></div><span id="connText">Offline</span></div>
  </header>
  <aside class="sidebar-left">
    <div>
      <div class="section-label">Server</div>
      <div class="info-row"><span class="info-key">Host</span><span class="info-val" id="siHost">—</span></div>
      <div class="info-row"><span class="info-key">Port</span><span class="info-val" id="siPort">—</span></div>
      <div class="info-row"><span class="info-key">User</span><span class="info-val" id="siUser">—</span></div>
      <div class="info-row"><span class="info-key">Auth</span><span class="info-val" id="siAuth">—</span></div>
      <div class="info-row"><span class="info-key">Ver.</span><span class="info-val" id="siVer">—</span></div>
    </div>
    <div>
      <div class="section-label">Player Stats</div>
      <div class="stat-bar-wrap stat-health"><div class="stat-bar-label"><span>❤ Health</span><span id="stHealth">—</span></div><div class="stat-bar-track"><div class="stat-bar-fill" id="barHealth" style="width:0%"></div></div></div>
      <div class="stat-bar-wrap stat-food"><div class="stat-bar-label"><span>🍖 Food</span><span id="stFood">—</span></div><div class="stat-bar-track"><div class="stat-bar-fill" id="barFood" style="width:0%"></div></div></div>
      <div class="stat-bar-wrap stat-xp"><div class="stat-bar-label"><span>✨ XP Level</span><span id="stXP">—</span></div><div class="stat-bar-track"><div class="stat-bar-fill" id="barXP" style="width:0%"></div></div></div>
    </div>
    <div>
      <div class="section-label">Position</div>
      <div class="pos-box">
        <div><span class="pos-axis">X </span><span id="posX">—</span></div>
        <div><span class="pos-axis">Y </span><span id="posY">—</span></div>
        <div><span class="pos-axis">Z </span><span id="posZ">—</span></div>
      </div>
    </div>
    <div class="reconnect-box" id="reconnectBox">↺ Reconnecting...<br>Attempt <span id="rcAttempt">—</span> · in <span id="rcDelay">—</span>s</div>
  </aside>
  <main class="log-panel">
    <div class="log-toolbar">
      <div class="log-filters">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="chat" style="color:#FFFFFF">Chat</button>
        <button class="filter-btn" data-filter="error" style="color:#FF5555">Errors</button>
        <button class="filter-btn" data-filter="sonar" style="color:#FF55FF">Sonar</button>
        <button class="filter-btn" data-filter="auth" style="color:#FFAA00">Auth</button>
      </div>
      <button class="filter-btn" id="clearLogBtn">Clear</button>
    </div>
    <div class="log-output" id="logOutput"><div class="empty-state">Waiting for bot to connect...</div></div>
  </main>
  <aside class="sidebar-right">
    <div>
      <div class="section-label">Features</div>
      <div class="toggle-row"><span class="toggle-label">Auto Eat</span><label class="toggle-switch"><input type="checkbox" id="tAutoEat" onchange="sendToggle('autoeat', this.checked)"><div class="toggle-track"></div><div class="toggle-thumb"></div></label></div>
      <div class="toggle-row"><span class="toggle-label">Anti AFK</span><label class="toggle-switch"><input type="checkbox" id="tAntiAfk" onchange="sendToggle('antiafk', this.checked)"><div class="toggle-track"></div><div class="toggle-thumb"></div></label></div>
      <div class="toggle-row"><span class="toggle-label">Auto Respawn</span><label class="toggle-switch"><input type="checkbox" id="tAutoRespawn" onchange="sendToggle('autorespawn', this.checked)"><div class="toggle-track"></div><div class="toggle-thumb"></div></label></div>
      <div class="toggle-row"><span class="toggle-label">Camera</span><label class="toggle-switch"><input type="checkbox" id="tCamera" onchange="sendToggle('camera', this.checked)"><div class="toggle-track"></div><div class="toggle-thumb"></div></label></div>
    </div>
    <div>
      <div class="section-label">Quick Actions</div>
      <button class="action-btn" onclick="send('.stats')"><span class="btn-icon">📊</span>Show Stats</button>
      <button class="action-btn" onclick="send('.respawn')"><span class="btn-icon">💫</span>Respawn</button>
      <button class="action-btn" onclick="send('.attack')"><span class="btn-icon">⚔️</span>Attack Nearest</button>
      <button class="action-btn" onclick="send('.attack stop')"><span class="btn-icon">🛑</span>Stop Attack</button>
      <button class="action-btn" onclick="send('.move stop')"><span class="btn-icon">🚫</span>Stop Moving</button>
      <button class="action-btn" onclick="send('.config')"><span class="btn-icon">⚙️</span>Show Config</button>
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
    const badge = document.getElementById('connBadge');
    const dot = document.getElementById('connText');
    const server = document.getElementById('serverLabel');
    const rcBox = document.getElementById('reconnectBox');

    document.getElementById('siHost').textContent = d.host || '—';
    document.getElementById('siPort').textContent = d.port || '—';
    document.getElementById('siUser').textContent = d.username || '—';
    document.getElementById('siAuth').textContent = d.auth || '—';
    document.getElementById('siVer').textContent = d.version || '—';
    server.textContent = d.host ? d.host + ':' + d.port : 'Connecting...';

    if (d.connected) {
      badge.className = 'conn-badge online'; dot.textContent = 'Online';
      rcBox.classList.remove('visible');
    } else if (d.reconnecting) {
      badge.className = 'conn-badge waiting'; dot.textContent = 'Reconnecting';
      document.getElementById('rcAttempt').textContent = d.attempt || '?';
      document.getElementById('rcDelay').textContent = d.nextRetry || '?';
      rcBox.classList.add('visible');
    } else {
      badge.className = 'conn-badge error'; dot.textContent = 'Offline';
    }
  });

  socket.on('logBatch', arr => {
    const empty = document.querySelector('.empty-state');
    if (empty) empty.remove();
    arr.forEach(d => {
      logLines.push(d);
      if (logLines.length > 2000) logLines.shift();
      appendLogLine(d);
    });
  });

  socket.on('stats', d => {
    document.getElementById('stHealth').textContent = d.health + '/20';
    document.getElementById('stFood').textContent = d.food + '/20';
    document.getElementById('stXP').textContent = 'Lv.' + d.xpLevel;
    document.getElementById('barHealth').style.width = ((d.health / 20) * 100) + '%';
    document.getElementById('barFood').style.width = ((d.food / 20) * 100) + '%';
    document.getElementById('barXP').style.width = Math.min(d.xpLevel * 5, 100) + '%';
    document.getElementById('posX').textContent = d.x;
    document.getElementById('posY').textContent = d.y;
    document.getElementById('posZ').textContent = d.z;
  });

  socket.on('toggles', d => {
    setToggle('tAutoEat', d.autoEatEnabled);
    setToggle('tAntiAfk', d.antiAfkEnabled);
    setToggle('tAutoRespawn', d.autoRespawnEnabled);
    setToggle('tCamera', d.cameraEnabled);
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
      if (ch === '\\u00A7' && i + 1 < str.length) {
        const code = str[i+1].toLowerCase(); i++;
        if (MC_COLORS[code]) { out += close() + '<span style="color:' + MC_COLORS[code] + '">'; spans++; }
        else if (code === 'l') { out += '<span style="font-weight:bold">'; spans++; }
        else if (code === 'o') { out += '<span style="font-style:italic">'; spans++; }
        else if (code === 'n') { out += '<span style="text-decoration:underline">'; spans++; }
        else if (code === 'r') { out += close(); }
      } else {
        if (ch === '&') out += '&amp;';
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
    el.innerHTML = '<span class="log-time">' + escapeHtml(d.time) + '</span><span class="log-msg">' + bodyHtml + '</span>';
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
    const val = input.value.trim();
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
