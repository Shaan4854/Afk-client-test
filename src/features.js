'use strict';

const { goals } = require('mineflayer-pathfinder');

const state  = require('./state');
const logger = require('./logger');
const { humanDelay, bestFood } = require('./util');

// ─── Anti-AFK ───────────────────────────────────────────────────────────────
function doAntiAfkAction() {
  const bot = state.getBot();
  if (!bot || !bot.entity) return;
  const roll = Math.random();
  if (roll < 0.40) {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), humanDelay(150, 250));
  } else if (roll < 0.65) {
    bot.setControlState('sneak', true);
    setTimeout(() => bot.setControlState('sneak', false), humanDelay(300, 700));
  } else if (roll < 0.82) {
    bot.setControlState('forward', true);
    setTimeout(() => bot.setControlState('forward', false), humanDelay(100, 300));
  } else {
    const newPitch = bot.entity.pitch + (Math.random() - 0.5) * 0.5;
    bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.5, Math.max(-1.4, Math.min(1.4, newPitch)), false);
  }
}

function scheduleAntiAfk() {
  state.handles.antiAfkTimeout = setTimeout(() => {
    if (!state.flags.verifying) doAntiAfkAction();
    scheduleAntiAfk();
  }, humanDelay(25000, 45000));
}

function startAntiAfk() {
  stopAntiAfk();
  if (state.flags.antiAfkEnabled) scheduleAntiAfk();
}

function stopAntiAfk() {
  clearTimeout(state.handles.antiAfkTimeout);
  state.handles.antiAfkTimeout = null;
}

// ─── Camera (idle head movement) ───────────────────────────────────────────
function scheduleNextLook() {
  if (!state.flags.cameraEnabled) return;
  state.handles.cameraTimeout = setTimeout(() => {
    const bot = state.getBot();
    if (!state.flags.verifying && bot?.entity) {
      const newPitch = bot.entity.pitch + (Math.random() - 0.5) * (0.15 + Math.random() * 0.35);
      bot.look(bot.entity.yaw + (Math.random() - 0.5) * (0.2 + Math.random() * 0.5), Math.max(-1.5, Math.min(1.5, newPitch)), false);
    }
    scheduleNextLook();
  }, humanDelay(1500, 6500));
}

function startCamera() {
  stopCamera();
  if (state.flags.cameraEnabled) scheduleNextLook();
}

function stopCamera() {
  clearTimeout(state.handles.cameraTimeout);
  state.handles.cameraTimeout = null;
}

// ─── Auto-eat ───────────────────────────────────────────────────────────────
// Called from connection.js's 'health' listener (needs to react to that
// specific event, so it isn't its own start/stop timer like the above two).
function maybeAutoEat() {
  const bot = state.getBot();
  if (!bot || !state.flags.autoEatEnabled || state.flags.verifying || bot.usingHeldItem || state.flags.eating) return;
  if (bot.food < 18) {
    const food = bestFood(bot.inventory);
    if (food) {
      state.flags.eating = true;
      bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {}).finally(() => { state.flags.eating = false; });
    }
  }
}

// ─── Combat ─────────────────────────────────────────────────────────────────
function startAttack() {
  const bot = state.getBot();
  if (!bot) { logger.log('[Attack] Not connected.'); return false; }
  if (state.flags.attackActive) { logger.log('[Attack] Already active. Use .attack stop first.'); return false; }

  const target = bot.nearestEntity(e => e.type === 'mob') ||
                 bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username);
  if (!target) { logger.log('[Attack] No target found.'); return false; }

  logger.log(`[Attack] Targeting ${target.username || target.name || target.type}`);
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  state.flags.attackActive = true;

  let tickCount  = 0;
  let tickNeeded = 12 + Math.floor(Math.random() * 6);
  function swingTick() {
    try {
      if (!target || !bot.entity) { stopAttack(); return; }
      // prismarine-entity flips isValid to false when the server removes the
      // entity (death, despawn, unload) — without this check, GoalFollow has
      // no way to know the target is gone and just keeps reading its stale
      // last-known position forever, so the bot would walk toward a corpse
      // indefinitely instead of the fight actually ending.
      if (!target.isValid) { logger.log('[Attack] Target lost.'); stopAttack(); return; }
      if (target.position.distanceTo(bot.entity.position) > 4.5) { stopAttack(); return; }
      tickCount++;
      if (tickCount >= tickNeeded) {
        bot.attack(target);
        tickCount = 0;
        tickNeeded = 12 + Math.floor(Math.random() * 6);
      }
    } catch (e) {
      // physicsTick fires ~20x/sec — without this, one persistent bad
      // condition here could throw on every single tick instead of failing
      // once and stopping cleanly.
      logger.log(`[!] Combat error: ${e.message}`);
      stopAttack();
    }
  }
  // This listener is tied to `bot`'s own lifecycle: bot.removeAllListeners()
  // in connection.js's 'end' handler removes it automatically on disconnect,
  // so it can't outlive the connection it was created for.
  bot.on('physicsTick', swingTick);
  state.handles.swingTick = swingTick;
  return true;
}

function stopAttack() {
  const bot = state.getBot();
  if (bot) {
    if (state.handles.swingTick) bot.removeListener('physicsTick', state.handles.swingTick);
    // Optional chaining: if the connection died before the pathfinder plugin
    // finished initializing (e.g. ECONNREFUSED on the very first connect
    // attempt), bot.pathfinder may not exist yet. Calling .stop() on it
    // unguarded threw here under exactly that condition during testing.
    bot.pathfinder?.stop?.();
  }
  state.handles.swingTick = null;
  state.flags.attackActive = false;
}

module.exports = {
  startAntiAfk, stopAntiAfk,
  startCamera, stopCamera,
  maybeAutoEat,
  startAttack, stopAttack,
};
