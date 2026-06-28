'use strict';

function humanDelay(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

// Exponential backoff with jitter, capped at 2 minutes. attempts starts at 1
// for the first reconnect.
function reconnectDelay(attempts) {
  const base = 7000, cap = 120000;
  return Math.min(base * Math.pow(2, attempts - 1), cap) + Math.floor(Math.random() * 3000);
}

// Compares dotted version strings, e.g. versionAtLeast('1.21.4', '1.21.2') -> true.
function versionAtLeast(version, target) {
  if (!version) return false;
  const a = String(version).split('.').map(Number);
  const b = String(target).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

// Pulls plain text out of a Minecraft chat-component object (or array, or
// already-plain string). Used both for the kicked-reason payload and for
// the MOTD-stripped chat text. Recurses through `extra` arrays.
function extractText(obj) {
  if (typeof obj === 'string') return obj;
  if (obj?.value !== undefined) return extractText(obj.value);
  if (Array.isArray(obj)) return obj.map(extractText).join('');
  if (typeof obj === 'object' && obj !== null) {
    const parts = [];
    if (obj.text)  parts.push(extractText(obj.text));
    if (obj.extra) parts.push(extractText(obj.extra));
    return parts.join('');
  }
  return '';
}

const FOOD_PRIORITY = {
  golden_carrot: 10, cooked_porkchop: 9, cooked_beef: 9, cooked_mutton: 9,
  cooked_salmon: 8,  cooked_chicken: 8,  cooked_cod: 7,  cooked_rabbit: 7,
  bread: 6,          baked_potato: 6,    mushroom_stew: 7, rabbit_stew: 8,
  pumpkin_pie: 7,    apple: 5,           sweet_berries: 3, carrot: 3,
  melon_slice: 2,    cookie: 2,          dried_kelp: 1,   chorus_fruit: 1,
};

function bestFood(inventory) {
  return inventory.items()
    .filter(i => FOOD_PRIORITY[i.name] !== undefined)
    .sort((a, b) => (FOOD_PRIORITY[b.name] || 0) - (FOOD_PRIORITY[a.name] || 0))[0] || null;
}

module.exports = {
  humanDelay,
  reconnectDelay,
  versionAtLeast,
  extractText,
  FOOD_PRIORITY,
  bestFood,
};
