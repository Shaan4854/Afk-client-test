'use strict';

const readline = require('readline');

const config     = require('./src/config');
const state      = require('./src/state');
const logger     = require('./src/logger');
const bus        = require('./src/bus');
const gui        = require('./src/gui');
const connection = require('./src/connection');
require('./src/commands'); // subscribes itself to bus.on('command', ...)

// Keeps the process alive through unexpected errors so an overnight AFK
// session doesn't die from one stray exception in a listener.
process.on('uncaughtException', (err) => {
  logger.rawLog(`[!] Uncaught exception: ${err?.stack || err}`);
  logger.flushLogs();
});
process.on('unhandledRejection', (reason) => {
  logger.rawLog(`[!] Unhandled rejection: ${reason?.stack || reason}`);
  logger.flushLogs();
});

// If anything blocks the event loop for a meaningful stretch, outgoing
// packets can queue up and burst out together once it frees up — which is
// exactly what trips a server's packet-timing checks. This makes that
// visible in the bot's own log instead of only showing up as a mystery flag.
let lastTick = Date.now();
setInterval(() => {
  const now   = Date.now();
  const drift = now - lastTick - 1000;
  lastTick    = now;
  if (drift > 250) logger.log(`[!] Event loop lagged ~${drift}ms — packets may have bunched up.`);
}, 1000);

(async () => {
  const cfg = await config.getConfig();
  state.setConfig(cfg);

  await gui.start();      // wait until HTTP server is bound before touching the socket
  connection.connect();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => bus.emit('command', line.trim()));
})();
