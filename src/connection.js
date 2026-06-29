'use strict';

const mineflayer  = require('mineflayer');
const mcProtocol  = require('minecraft-protocol');
const { pathfinder, Movements } = require('mineflayer-pathfinder');

const state    = require('./state');
const logger   = require('./logger');
const bus      = require('./bus');
const features = require('./features');
const resourcePack = require('./resourcepack');
const { humanDelay, reconnectDelay, versionAtLeast, extractText } = require('./util');

// ─── Version resolution ──────────────────────────────────────────────────────
// Pings the server before connecting to get its exact Minecraft version.
// This prevents the two most common 1.20+ connection failures:
//   • minecraft:custom_payload — channel-registration packet format mismatch
//   • minecraft:chat_command_signed — signed-command packet format mismatch
// Both are caused by connecting with the wrong protocol version.
//
// Priority: explicit config > server ping > fallback '1.20.4'
async function resolveVersion(host, port, configured) {
  // Explicit version in config always wins — but sanitize it first.
  // A user might type "Paper 1.20.4" or "1.20.4 (MC: 1.20.4)" into the prompt.
  if (configured) {
    const match = String(configured).match(/\d+\.\d+(?:\.\d+)?/);
    const clean = match ? match[0] : String(configured);
    logger.log(`[Version] Using configured version: ${clean}`);
    return clean;
  }

  // Ping the server to read its advertised version string.
  try {
    const info = await new Promise((resolve, reject) => {
      mcProtocol.ping({ host, port, closeTimeout: 6000 }, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const raw   = info?.version?.name;
    const match = raw && String(raw).match(/\d+\.\d+(?:\.\d+)?/);
    if (match) {
      const detected = match[0];
      logger.log(`[Version] Auto-detected from server ping: ${detected} (server reported: "${raw}")`);
      if (!versionAtLeast(detected, '1.20')) {
        logger.log(`[Version] ⚠  Server is ${detected} — below 1.20. Some features (signed chat, tick_end) won't apply.`);
      }
      return detected;
    }
    logger.log(`[Version] Ping returned no usable version string ("${raw}") — using fallback.`);
  } catch (e) {
    logger.log(`[Version] Server ping failed (${e.message}) — using fallback 1.20.4.`);
  }

  return '1.20.4'; // safe default for 1.20+ servers
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Routes chat through the currently-live bot only. A chat queued via
// setTimeout (the delayed login/register/verify replies below) can fire
// after the connection has already dropped; checking against state.getBot()
// here means that just fails quietly instead of throwing on a dead socket.
function safeChat(msg) {
  const bot = state.getBot();
  if (!bot) return false;
  try { bot.chat(msg); return true; }
  catch (e) { logger.log(`[!] Chat send failed: ${e.message}`); return false; }
}

// ─── Main connect loop ───────────────────────────────────────────────────────
async function connect() {
  const CONFIG = state.getConfig();

  // Resolve the version before opening any socket — this is what prevents the
  // custom_payload and chat_command_signed decode errors on the server side.
  const version = await resolveVersion(CONFIG.host, CONFIG.port, CONFIG.version);

  logger.log(`[*] Connecting to ${CONFIG.host}:${CONFIG.port} as '${CONFIG.username}' (${CONFIG.auth}) · MC ${version}...`);
  bus.emit('status', { connected: false, reconnecting: true, attempt: state.getReconnectAttempts(), ...state.publicConfig() });

  const bot = mineflayer.createBot({
    host:                 CONFIG.host,
    port:                 CONFIG.port,
    username:             CONFIG.username,
    version:              version,        // always a real version string now
    auth:                 CONFIG.auth,
    checkTimeoutInterval: 30000,
    physicsEnabled:       true,
    hideErrors:           false,
  });

  state.setBot(bot);
  state.flags.loggedIn = false;
  bot.loadPlugin(pathfinder);
  resourcePack.register(bot);

  // ── tick_end (1.21.2+) ──────────────────────────────────────────────────
  // Since 1.21.2 the real client sends client_tick_end at the end of every
  // tick. GrimAC's TickTimer check uses this to find tick boundaries; without
  // it every position/look packet looks unbounded and gets flagged even at
  // idle. We send it ourselves on servers new enough to expect it.
  let tickEndSupported = false;
  let tickEndWorking   = true;
  bot.on('physicsTick', () => {
    if (!tickEndSupported || !tickEndWorking) return;
    try { bot._client.write('tick_end', {}); }
    catch (e) {
      tickEndWorking = false;
      logger.log(`[!] client_tick_end packet rejected (${e.message}) — disabling for this connection.`);
    }
  });

  // ── forcedMove (Sonar verification) ─────────────────────────────────────
  // Tracks roughly where the bot was as of the last completed tick, purely
  // so the handler below can tell a real verification teleport (large jump)
  // apart from an ordinary in-combat position correction (knockback range —
  // a few blocks even with Knockback II). Confirmed via testing: every hit
  // taken was firing this exact event, and treating it the same as a real
  // teleport (freeze physics, clear controls, stop pathfinder) was eating
  // the bot's knockback on every single hit.
  let lastKnownPos = null;
  bot.on('physicsTick', () => {
    if (bot.entity) lastKnownPos = bot.entity.position.clone();
  });

  const VERIFICATION_JUMP_THRESHOLD = 8; // blocks — well above max plausible knockback, well below a real teleport

  // ── TEMP DEBUG: confirm whether the server sends the bot a velocity ─────
  // packet at all when hit. Remove once we know which side the knockback
  // problem is actually on.
  bot._client.on('entity_velocity', (packet) => {
    if (bot.entity && packet.entityId === bot.entity.id) {
      logger.log(`[Debug] Self velocity packet received: x=${packet.velocity.x} y=${packet.velocity.y} z=${packet.velocity.z}`);
    }
  });

  bot.on('forcedMove', () => {
    const newPos = bot.entity?.position;
    const jumpDistance = (lastKnownPos && newPos) ? lastKnownPos.distanceTo(newPos) : Infinity;

    if (!state.flags.verifying) {
      // Only a large jump *starts* a verification window. A small one (e.g.
      // a knockback-induced correction while just standing around) is left
      // alone entirely — no log, no physics freeze — so physics/knockback
      // plays out naturally instead of being treated as anti-cheat noise.
      if (jumpDistance < VERIFICATION_JUMP_THRESHOLD) return;

      state.flags.verifying = true;
      logger.log('[Sonar] Teleported — letting physics settle...');
      bot.pathfinder.stop();
      ['forward','back','left','right','jump','sprint','sneak'].forEach(k => bot.setControlState(k, false));
      // Disable physics for ~2 ticks only (not the whole verify window) so
      // gravity/knockback still work. Closes the gap where mineflayer's local
      // state is behind the server's chunk data right after a teleport.
      bot.physicsEnabled = false;
      clearTimeout(state.handles.physicsResumeTimeout);
      state.handles.physicsResumeTimeout = setTimeout(() => {
        bot.physicsEnabled = true;
        state.handles.physicsResumeTimeout = null;
      }, 150);
    }
    // Once a verification window is already open, any further forcedMove —
    // regardless of size — extends it. Debounced into one timer instead of
    // stacking one per event.
    clearTimeout(state.handles.verifyTimeout);
    state.handles.verifyTimeout = setTimeout(() => {
      state.flags.verifying = false;
      state.handles.verifyTimeout = null;
      logger.log('[Sonar] Verification window passed — resuming.');
    }, humanDelay(2500, 4500));
  });

  // ── Chat / auth ──────────────────────────────────────────────────────────
  bot.on('message', (jsonMsg) => {
    const raw  = jsonMsg.toString();
    const motd = typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : raw;
    const text = raw.toLowerCase();
    logger.logChat(raw, motd);

    if (raw.includes('<') || raw.includes('>')) return; // player chat

    const cfg = state.getConfig();

    if (cfg.password && !state.flags.loggedIn && !state.flags.loginSent &&
        text.includes('/login') && (text.includes('log in') || text.includes('login') || text.includes('please'))) {
      state.flags.loginSent = true;
      setTimeout(() => { safeChat(`/login ${cfg.password}`); logger.log('[Auth] Sent: /login ***'); }, humanDelay(600, 1200));
      return;
    }
    if (cfg.password && !state.flags.loggedIn && !state.flags.loginSent &&
        text.includes('/register') && (text.includes('register') || text.includes('please'))) {
      state.flags.loginSent = true;
      setTimeout(() => { safeChat(`/register ${cfg.password} ${cfg.password}`); logger.log('[Auth] Sent: /register ***'); }, humanDelay(600, 1200));
      return;
    }
    if (!state.flags.loggedIn && (text.includes('logged in') || text.includes('welcome back') ||
        text.includes('successfully') || text.includes('authenticated'))) {
      state.flags.loggedIn = true;
      logger.log('[Auth] Logged in successfully.');
      bus.emit('toggles', state.getToggles());
      return;
    }
    const verifyMatch = raw.match(/\/verify\s+([A-Za-z0-9_-]{3,32})/);
    if (verifyMatch) {
      setTimeout(() => { safeChat(`/verify ${verifyMatch[1]}`); logger.log(`[Sonar] Sent: /verify ${verifyMatch[1]}`); }, humanDelay(800, 1400));
      return;
    }
    if (text.includes('/verify') && (text.includes('type') || text.includes('enter') || text.includes('run'))) {
      setTimeout(() => { safeChat('/verify'); logger.log('[Sonar] Sent: /verify'); }, humanDelay(900, 1600));
    }
  });

  // ── Spawn ────────────────────────────────────────────────────────────────
  bot.once('spawn', () => {
    state.resetReconnectAttempts();
    state.flags.loginSent = false;
    state.flags.eating    = false;

    // Re-check against negotiated version (bot.version is what the server
    // confirmed, which may differ slightly from what we requested).
    tickEndSupported = versionAtLeast(bot.version, '1.21.2');
    logger.log(`[*] Spawned as ${bot.username} · negotiated MC ${bot.version}${tickEndSupported ? ' · tick_end enabled' : ''}`);

    // Region-protected server safe defaults: never dig/place, GoalNear
    // so a protected block as a destination doesn't stall pathfinding.
    const movements = new Movements(bot);
    movements.canDig           = false;
    movements.allow1by1towers  = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    // Default is unlimited (-1): with digging/towers off above, getting
    // around an obstacle means a real detour (not a shortcut through it),
    // and A* will fully explore every possible detour before picking one —
    // that's the actual cost driver, not per-tick compute speed. Capping
    // this stops it considering routes much longer than the direct
    // distance. Goals that genuinely need a longer detour still work, just
    // slower to resolve; past this radius, [Move] reports noPath instead
    // of hanging silently.
    bot.pathfinder.searchRadius = 32;

    bus.emit('status', { connected: true, reconnecting: false, username: bot.username, version: bot.version, ...state.publicConfig() });
    if (!state.getConfig().password) state.flags.loggedIn = true;

    setTimeout(() => {
      if (!state.flags.verifying) { features.startAntiAfk(); features.startCamera(); }
    }, humanDelay(1500, 3000));

    clearInterval(state.getStatsInterval());
    state.setStatsInterval(setInterval(() => {
      const stats = state.liveStats();
      if (stats) bus.emit('stats', stats);
    }, 2000));
  });

  bot.on('health', () => features.maybeAutoEat());

  bot.on('death', () => {
    logger.log('[!] Bot died.');
    if (state.flags.autoRespawnEnabled) {
      setTimeout(() => {
        const liveBot = state.getBot();
        if (liveBot) { liveBot.respawn(); logger.log('[*] Auto-respawned.'); }
      }, humanDelay(800, 2500));
    }
  });

  bot.on('kicked', (reason) => {
    let readable;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      readable = extractText(parsed) || String(reason);
    } catch {
      readable = String(reason);
    }
    logger.log(`[!] Kicked: ${readable}`);
    const lower = readable.toLowerCase();
    if (lower.includes('bot verification')) logger.log('[Sonar] ⚠  Failed: gravity/main check');
    else if (lower.includes('too many'))    logger.log('[Sonar] ⚠  Failed: reconnect rate-limit — backing off');
    else if (lower.includes('captcha'))     logger.log('[Sonar] ⚠  Failed: CAPTCHA (map-image)');
    else if (lower.includes('resource pack')) logger.log('[ResourcePack] ⚠  Kicked over the resource pack — see [ResourcePack] lines above for what was offered.');
  });

  bot.on('end', (reason) => {
    try {
      features.stopAntiAfk();
      features.stopCamera();
    } catch (e) {
      logger.log(`[!] Error during disconnect cleanup: ${e.message}`);
    }
    state.handles.swingTick = null;

    clearTimeout(state.handles.verifyTimeout);        state.handles.verifyTimeout = null;
    clearTimeout(state.handles.physicsResumeTimeout); state.handles.physicsResumeTimeout = null;
    clearInterval(state.getStatsInterval());
    bot.removeAllListeners();
    // mineflayer/minecraft-protocol can emit a second late 'error' after 'end'
    // (confirmed by testing against a refused port). Keep one quiet listener
    // to absorb it rather than letting Node treat it as an uncaught exception.
    bot.on('error', (err) => logger.rawLog(`[!] (post-disconnect) ${err.message}`));
    state.setBot(null);
    state.resetConnectionFlags();

    const attempt = state.incrementReconnectAttempts();
    const delay   = reconnectDelay(attempt);
    logger.log(`[!] Disconnected: ${reason} (attempt #${attempt}) — reconnecting in ${(delay / 1000).toFixed(1)} s...`);
    bus.emit('status', { connected: false, reconnecting: true, attempt, nextRetry: (delay / 1000).toFixed(1), ...state.publicConfig() });
    setTimeout(connect, delay);
  });

  bot.on('error', (err) => logger.log(`[!] Error: ${err.message}`));

  return bot;
}

module.exports = { connect, safeChat };
