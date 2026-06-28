'use strict';

// ─── Runtime config ────────────────────────────────────────────────────────
// Set once at startup from config.js. Holds the account password, so it is
// NEVER spread directly into anything sent to the GUI — always go through
// publicConfig() below.
let CONFIG = {};

// ─── Live connection handle ────────────────────────────────────────────────
// The single source of truth for "is there a connected bot, and which one".
// Every module that needs to act on the bot (features, commands) calls
// getBot() fresh at the moment it acts, instead of closing over a `bot`
// reference captured earlier. That closure-capture pattern is exactly what
// broke things after reconnects before: a setTimeout or listener built
// around the old bot object kept firing against a dead connection and threw.
// Reading getBot() just-in-time means a stale reference is structurally
// impossible — there's only ever one bot, and it's whatever this returns.
let currentBot = null;

let reconnectAttempts = 0;
let statsInterval     = null;

// ─── Feature toggles + connection-lifecycle flags ──────────────────────────
// Plain mutable object, same as before — these are simple booleans flipped
// from many places (commands, events), so accessor functions would just add
// ceremony without adding safety.
const flags = {
  autoEatEnabled:     true,
  antiAfkEnabled:     true,
  autoRespawnEnabled: true,
  cameraEnabled:      true,
  loggedIn:           false,
  loginSent:          false,
  eating:             false,
  attackActive:       false,
  verifying:          false,
};

// ─── Per-connection timer / listener handles ───────────────────────────────
// Centralized so connection.js's 'end' handler can clear all of them in one
// place instead of bugs creeping in from a handle being added somewhere new
// and forgotten during cleanup.
const handles = {
  antiAfkTimeout:       null,
  cameraTimeout:        null,
  verifyTimeout:        null,
  physicsResumeTimeout: null,
  swingTick:            null, // function reference, not a timer
};

function setConfig(cfg) { CONFIG = cfg; }
function getConfig()    { return CONFIG; }

// Anything broadcast to the GUI must come from here, never from spreading
// CONFIG directly — CONFIG.password would otherwise be readable in the
// browser's network tab.
function publicConfig() {
  const { password, ...safe } = CONFIG;
  return safe;
}

function getBot()    { return currentBot; }
function setBot(bot) { currentBot = bot; }

function getReconnectAttempts()     { return reconnectAttempts; }
function incrementReconnectAttempts() { return ++reconnectAttempts; }
function resetReconnectAttempts()   { reconnectAttempts = 0; }

function getStatsInterval()  { return statsInterval; }
function setStatsInterval(i) { statsInterval = i; }

function getToggles() {
  return {
    autoEatEnabled:     flags.autoEatEnabled,
    antiAfkEnabled:     flags.antiAfkEnabled,
    autoRespawnEnabled: flags.autoRespawnEnabled,
    cameraEnabled:      flags.cameraEnabled,
    attackActive:       flags.attackActive,
    loggedIn:           flags.loggedIn,
  };
}

// Called once at the top of each fresh connection (bot.once('spawn')) and
// once on disconnect (bot.on('end')) — keeps the per-connection flag reset
// logic in one place instead of duplicated at both call sites.
function resetConnectionFlags() {
  flags.loggedIn     = false;
  flags.loginSent    = false;
  flags.eating       = false;
  flags.attackActive = false;
  flags.verifying    = false;
}

// Snapshot of live player telemetry for the GUI stats panel / .stats command.
// Lives here (not in connection.js) so gui.js can read it without having to
// require the bot-connection module at all.
function liveStats() {
  const bot = currentBot;
  if (!bot || !bot.entity) return null;
  const pos = bot.entity.position;
  return {
    health:   Math.round((bot.health  || 0) * 10) / 10,
    food:     Math.round((bot.food    || 0) * 10) / 10,
    xpLevel:  bot.experience?.level || 0,
    x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1),
    loggedIn: flags.loggedIn,
  };
}

module.exports = {
  flags,
  handles,
  setConfig,
  getConfig,
  publicConfig,
  getBot,
  setBot,
  getReconnectAttempts,
  incrementReconnectAttempts,
  resetReconnectAttempts,
  getStatsInterval,
  setStatsInterval,
  getToggles,
  resetConnectionFlags,
  liveStats,
};
