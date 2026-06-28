'use strict';

const fs   = require('fs');
const path = require('path');

const bus    = require('./bus');
const state  = require('./state');
const logger = require('./logger');

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

let io = null;

// Starts the optional web dashboard. Mirrors the original behavior exactly:
// if express/socket.io aren't installed, the bot still runs fine headless —
// we just log that the GUI isn't available instead of crashing the process.
function start() {
  try {
    const http       = require('http');
    const express     = require('express');
    const { Server }  = require('socket.io');

    const dashboardHtml = fs.readFileSync(DASHBOARD_PATH, 'utf8');

    const app = express();
    const srv = http.createServer(app);
    io        = new Server(srv);

    app.get('/', (_req, res) => res.send(dashboardHtml));

    io.on('connection', socket => {
      socket.emit('status',  { connected: !!state.getBot(), ...state.publicConfig() });
      socket.emit('toggles', state.getToggles());
      const stats = state.liveStats();
      if (stats) socket.emit('stats', stats);

      socket.on('command', cmd => {
        if (typeof cmd !== 'string') return;
        logger.log(`[GUI] Command: ${cmd}`);
        bus.emit('command', cmd.trim());
      });
    });

    // http.Server emits 'error' asynchronously (e.g. EADDRINUSE) — without
    // a listener for it, that's an uncaught exception that kills the whole
    // process, not just the GUI.
    srv.on('error', (err) => logger.rawLog(`[GUI] Server error: ${err.message}`));
    srv.listen(state.getConfig().guiPort || 3000, () => {
      logger.rawLog(`[GUI] Dashboard → http://localhost:${state.getConfig().guiPort || 3000}`);
    });
  } catch {
    logger.rawLog('[GUI] Web dashboard not available. Run: npm install express socket.io');
  }
}

// The only place in the whole app that touches socket.io directly. Every
// other module just emits on the bus; this forwards it outward.
bus.on('logBatch', batch  => { if (io) io.emit('logBatch', batch); });
bus.on('status',   payload => { if (io) io.emit('status',   payload); });
bus.on('toggles',  payload => { if (io) io.emit('toggles',  payload); });
bus.on('stats',    payload => { if (io) io.emit('stats',    payload); });

module.exports = { start };
