'use strict';

const bus = require('./bus');

// Writing a log line and pushing it to the GUI on every single event is fine
// in isolation, but under a burst (many events firing in the same few
// milliseconds) those synchronous stdout writes + socket emits can chew up
// enough event-loop time that outgoing game packets queue up and get
// flushed to the server all at once — which looks exactly like a packet
// burst to anti-cheat. Buffer both and flush on a short timer so a burst of
// 500 log lines becomes one write + one bus message instead of 500.
const LOG_FLUSH_MS = 80;

let consoleBuffer   = [];
let socketLogBuffer = [];
let flushTimer       = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
}

function flushLogs() {
  flushTimer = null;
  if (consoleBuffer.length) {
    process.stdout.write(consoleBuffer.join('\n') + '\n');
    consoleBuffer = [];
  }
  if (socketLogBuffer.length) {
    bus.emit('logBatch', socketLogBuffer);
    socketLogBuffer = [];
  }
}

// Console-only line (no GUI broadcast, no type classification). Used for
// things that already get their own structured GUI event, like the raw
// "[Chat] ..." line that's also sent richly via logChat() below.
function rawLog(msg) {
  consoleBuffer.push(msg);
  scheduleFlush();
}

function classify(msg) {
  if      (msg.startsWith('[Chat]'))   return 'chat';
  else if (msg.startsWith('[!]'))      return 'error';
  else if (msg.startsWith('[Sonar]'))  return 'sonar';
  else if (msg.startsWith('[Auth]'))   return 'auth';
  else if (msg.startsWith('[Move]'))   return 'move';
  else if (msg.startsWith('[Attack]')) return 'attack';
  else if (msg.startsWith('[MC]'))     return 'mc';
  else if (msg.startsWith('[GUI]'))    return 'gui';
  return 'system';
}

// Console + GUI log line, auto-classified by prefix unless `type` is given.
function log(msg, type) {
  rawLog(msg);
  socketLogBuffer.push({ msg, type: type || classify(msg), time: new Date().toLocaleTimeString() });
  scheduleFlush();
}

// Raw server chat needs the parsed MOTD-style formatting attached for the
// GUI to render Minecraft color codes, which plain log() doesn't carry.
function logChat(raw, motd) {
  rawLog(`[Chat] ${raw}`);
  socketLogBuffer.push({ msg: raw, motd, type: 'chat', time: new Date().toLocaleTimeString() });
  scheduleFlush();
}

module.exports = { log, rawLog, logChat, flushLogs };
