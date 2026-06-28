'use strict';

const { goals } = require('mineflayer-pathfinder');

const state    = require('./state');
const logger   = require('./logger');
const bus      = require('./bus');
const features = require('./features');
const { safeChat } = require('./connection');

function toggle(key, arg, label, onCb, offCb) {
  if      (arg === 'on')  { state.flags[key] = true;  onCb?.();  logger.log(`[${label}] Enabled.`);  }
  else if (arg === 'off') { state.flags[key] = false; offCb?.(); logger.log(`[${label}] Disabled.`); }
  else logger.log(`[${label}] Currently ${state.flags[key] ? 'ON' : 'OFF'}`);
  bus.emit('toggles', state.getToggles());
}

function handleCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return;

  // state.getBot() is read fresh here rather than captured once — this is
  // what makes the whole command path immune to the "stale bot reference
  // after reconnect" bug class, instead of needing a one-off guard.
  const bot = state.getBot();
  if (!bot) { logger.log('[!] Not connected — command ignored.'); return; }

  try {
    dispatch(bot, trimmed);
  } catch (e) {
    // handleCommand is called directly from a socket.io 'command' listener
    // or readline's 'line' listener — neither wraps its own listeners in
    // try/catch, so an uncaught throw here would otherwise propagate out
    // of whichever one called us. One guard here protects every command at
    // once instead of needing it bolted onto each case individually.
    logger.log(`[!] Command error: ${e.message}`);
  }
}

function dispatch(bot, trimmed) {
  if (!trimmed.startsWith('.')) {
    safeChat(trimmed);
    logger.log(`[MC] ▶ ${trimmed}`, 'mc');
    return;
  }

  const parts = trimmed.slice(1).split(' ');
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);

  switch (cmd) {
    case 'help':
      logger.log('================================');
      logger.log('          BOT COMMANDS          ');
      logger.log('================================');
      logger.log('.move forward         -> Walk straight');
      logger.log('.move stop            -> Freeze bot');
      logger.log('.move <x> <y> <z>     -> Pathfind to coords');
      logger.log('.attack               -> Hit nearest mob/player');
      logger.log('.attack stop          -> Stop attacking');
      logger.log(`.autoeat [on/off]     -> Auto eating      [${state.flags.autoEatEnabled     ? 'ON' : 'OFF'}]`);
      logger.log(`.antiafk [on/off]     -> Anti-AFK         [${state.flags.antiAfkEnabled     ? 'ON' : 'OFF'}]`);
      logger.log(`.autorespawn [on/off] -> Auto revive      [${state.flags.autoRespawnEnabled ? 'ON' : 'OFF'}]`);
      logger.log(`.camera [on/off]      -> Head movement    [${state.flags.cameraEnabled      ? 'ON' : 'OFF'}]`);
      logger.log('.respawn              -> Manual respawn');
      logger.log('.config               -> Show config');
      logger.log('.stats                -> Show player stats');
      logger.log('.clear                -> Clear terminal');
      logger.log('.quit                 -> Disconnect & exit');
      logger.log('================================');
      break;

    case 'move':
      if (state.flags.verifying) { logger.log('[Move] Blocked — verification in progress.'); break; }
      if (args[0] === 'forward') {
        bot.setControlState('forward', true);
        logger.log('[Move] Walking forward...');
      } else if (args[0] === 'stop') {
        bot.pathfinder.stop();
        ['forward','back','left','right','jump','sprint'].forEach(k => bot.setControlState(k, false));
        logger.log('[Move] Stopped.');
      } else if (args.length === 3) {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some(isNaN)) { logger.log('[Move] Invalid coordinates.'); break; }
        // GoalNear arrives reliably even when the exact block is unreachable
        // (e.g. inside a region-protected area) — GoalBlock can stall forever.
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
        logger.log(`[Move] Pathfinding to ${x} ${y} ${z}...`);

        // One-shot feedback for *this* goal only: previously a "no path"
        // result was silent — the bot would just stand there with no
        // explanation. Self-removes on the first terminal result so it
        // can't keep firing (and spamming logs) once combat/anti-afk reuse
        // the same pathfinder later. 'partial' means astar is still
        // searching — only success/timeout/noPath are terminal.
        const onPathUpdate = (results) => {
          if (results.status === 'noPath')        logger.log('[Move] No path found to that location.');
          else if (results.status === 'timeout')  logger.log('[Move] Pathfinding timed out — target may be unreachable.');
          if (results.status !== 'partial') bot.removeListener('path_update', onPathUpdate);
        };
        bot.on('path_update', onPathUpdate);
      } else {
        logger.log('[Move] Usage: .move forward | stop | <x> <y> <z>');
      }
      break;

    case 'attack':
      if (args[0] === 'stop') { features.stopAttack(); logger.log('[Attack] Stopped.'); break; }
      if (features.startAttack()) bus.emit('toggles', state.getToggles());
      break;

    case 'autoeat':     toggle('autoEatEnabled',     args[0], 'AutoEat');                                                  break;
    case 'antiafk':     toggle('antiAfkEnabled',     args[0], 'AntiAFK',     features.startAntiAfk, features.stopAntiAfk); break;
    case 'autorespawn': toggle('autoRespawnEnabled', args[0], 'AutoRespawn');                                               break;
    case 'camera':      toggle('cameraEnabled',      args[0], 'Camera',      features.startCamera,  features.stopCamera);  break;

    case 'respawn': bot.respawn(); logger.log('[*] Respawn sent.'); break;
    case 'clear':   console.clear(); break;

    case 'stats': {
      const s = state.liveStats();
      if (!s) { logger.log('[Stats] No bot data yet.'); break; }
      logger.log(`[Stats] ❤ ${s.health}/20  🍖 ${s.food}/20  ✨ Lv.${s.xpLevel}  📍 ${s.x}, ${s.y}, ${s.z}`);
      break;
    }

    case 'config': {
      const cfg = state.getConfig();
      logger.log('================================');
      logger.log(`  Host     : ${cfg.host}:${cfg.port}`);
      logger.log(`  Username : ${cfg.username}`);
      logger.log(`  Password : ${cfg.password ? '(set)' : '(none)'}`);
      logger.log(`  Version  : ${cfg.version || 'auto-detect'}`);
      logger.log(`  Auth     : ${cfg.auth}`);
      logger.log(`  Reconnect: #${state.getReconnectAttempts()}`);
      logger.log('================================');
      break;
    }

    case 'quit':
    case 'exit':
      logger.log('[Cmd] Shutting down...');
      logger.flushLogs();
      features.stopAttack();
      bot.removeAllListeners();
      bot.quit();
      setTimeout(() => process.exit(0), 1000);
      break;

    default:
      logger.log(`[Cmd] Unknown: .${cmd}  (type .help)`);
  }
}

bus.on('command', handleCommand);

module.exports = { handleCommand };
