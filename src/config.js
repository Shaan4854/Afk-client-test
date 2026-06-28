'use strict';

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'bot-config.json');

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

// Interactive first-run / per-launch setup. Returns the resolved config
// object; does NOT touch state.js — index.js is responsible for calling
// state.setConfig() with the result, keeping this module pure I/O.
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
    console.log(`    Version  : ${saved.version || 'auto-detect'}`);
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

  let versionRaw = await prompt(rl, `MC Version  [${saved?.version || 'auto-detect'}] (blank = auto-detect server version): `);
  const version  = versionRaw || saved?.version || false;

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
    console.log('[Config] Saved to bot-config.json');
  }

  console.log('================================\n');
  return cfg;
}

module.exports = { getConfig, loadSavedConfig, saveConfig };
