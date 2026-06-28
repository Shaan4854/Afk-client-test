'use strict';

// Lightweight smoke tests — no real Minecraft server required. Run with:
//   npm test
// Covers the two things most likely to silently break in this codebase:
//   1) the GUI dashboard (serves correctly, never leaks the password, and
//      commands sent over the socket reach the bot's command bus)
//   2) connection resilience (a refused/failed connection must never crash
//      the process, and must still schedule a reconnect)
//
// (2) exists because exactly this scenario crashed the process during
// development: mineflayer can emit a second, late 'error' event after
// 'end' fires, and removing all listeners on disconnect silently dropped
// that second error — Node treats an 'error' event with no listeners as
// fatal. See the comment in src/connection.js's 'end' handler.

const assert = require('assert');
const http   = require('http');
const { io: ioClient } = require('socket.io-client');

const GUI_TEST_PORT = 34567;
const FAIL = [];

function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { FAIL.push(label); console.error(`[FAIL] ${label}: ${e.message}`); }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function testGui() {
  const state = require('../src/state');
  state.setConfig({
    host: 'test.example', port: 25565, username: 'TestBot',
    password: 'sekret123', auth: 'offline', guiPort: GUI_TEST_PORT,
  });

  const bus = require('../src/bus');
  require('../src/commands'); // wires bus.on('command', ...)
  const gui = require('../src/gui');

  const receivedCommands = [];
  bus.on('command', cmd => receivedCommands.push(cmd));

  gui.start();
  await new Promise(r => setTimeout(r, 300)); // let the server finish binding

  const page = await httpGet(`http://localhost:${GUI_TEST_PORT}/`);
  check('dashboard HTML serves with 200', () => assert.strictEqual(page.status, 200));
  check('dashboard contains expected markup', () =>
    assert.ok(page.body.includes('Mineflayer Bot Console') && page.body.includes('id="cmdInput"')));

  const client = ioClient(`http://localhost:${GUI_TEST_PORT}`, { transports: ['websocket'] });
  const statusPromise  = new Promise(resolve => client.once('status', resolve));
  const togglesPromise = new Promise(resolve => client.once('toggles', resolve));

  const status = await statusPromise;
  check('status payload never includes the password field', () =>
    assert.strictEqual(status.password, undefined));

  const toggles = await togglesPromise;
  check('toggles payload reflects default feature state', () =>
    assert.strictEqual(toggles.autoEatEnabled, true));

  client.emit('command', '.help');
  await new Promise(r => setTimeout(r, 150));
  check('GUI-issued command reaches the shared command bus', () =>
    assert.ok(receivedCommands.includes('.help')));

  client.close();
}

async function testConnectionResilience() {
  const state      = require('../src/state');
  const logger     = require('../src/logger');
  const connection = require('../src/connection');

  state.setConfig({ host: '127.0.0.1', port: 25599, username: 'TestBot', password: '', auth: 'offline', guiPort: 0 });

  let sawReconnectScheduled  = false;
  let sawLateErrorAbsorbed   = false;
  const origLog    = logger.log;
  const origRawLog = logger.rawLog;
  logger.log    = (msg, type) => { if (msg.includes('reconnecting in'))   sawReconnectScheduled = true; return origLog(msg, type); };
  logger.rawLog = (msg)       => { if (msg.includes('post-disconnect'))   sawLateErrorAbsorbed  = true; return origRawLog(msg); };

  connection.connect(); // will fail immediately — nothing is listening on 127.0.0.1:25599
  await new Promise(r => setTimeout(r, 4000));

  logger.log    = origLog;
  logger.rawLog = origRawLog;

  check('a refused connection does not crash the process', () => {}); // implicit: we got here at all
  check('a failed connection still schedules a reconnect', () => assert.ok(sawReconnectScheduled));
  check('bot reference is cleared after disconnect', () => assert.strictEqual(state.getBot(), null));
  check('late post-disconnect error event is absorbed, not fatal', () => assert.ok(sawLateErrorAbsorbed));
}

(async () => {
  await testGui();
  await testConnectionResilience();

  console.log(`\n${FAIL.length === 0 ? 'ALL SMOKE TESTS PASSED' : `${FAIL.length} TEST(S) FAILED: ${FAIL.join(', ')}`}`);
  process.exit(FAIL.length === 0 ? 0 : 1);
})().catch(err => {
  console.error('Smoke test runner crashed:', err);
  process.exit(1);
});
