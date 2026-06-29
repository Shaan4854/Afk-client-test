# Mineflayer Bot — modular rewrite

Same bot, split into focused modules instead of one ~1100-line file. Every
command, GUI feature, and behavior from the single-file version still works
exactly the same — this is a reorganization + bug-fix pass, not a feature
change.

## Layout

```
index.js              entry point: loads config, starts GUI + bot, wires stdin
src/
  bus.js              shared event bus — decouples bot logic from the GUI
  state.js             single source of truth: config, live bot handle, toggles, timers
  util.js              pure helpers (no bot/GUI dependency): delays, version compare,
                        chat-component text extraction, food priority
  logger.js             buffered console + GUI logging (burst protection)
  config.js             interactive setup wizard, bot-config.json load/save
  connection.js          owns the mineflayer connection: connect/reconnect, protocol
                        compat shims, auth + Sonar /verify chat handling
  resourcepack.js         resource pack handshake (accept + detailed logging)
  features.js            anti-AFK, camera, auto-eat, combat — all read state.getBot()
                        fresh instead of closing over a bot reference
  commands.js             .move / .attack / .help / toggles / .stats / .config / .quit
  gui.js                  Express + Socket.io dashboard server
  dashboard.html          the dashboard itself — now a real .html file, not a JS string
test/
  smoke.js                npm test — see "Testing" below
```

## Setup on Termux

```
pkg install nodejs
cd mineflayer-bot
npm install
npm start
```

First run walks you through the same setup wizard as before (host, port,
username, password, version, auth mode, GUI port) and offers to save it to
`bot-config.json`.

## Testing

```
npm test
```

Runs `test/smoke.js` — no real Minecraft server needed. It checks that the
dashboard serves correctly, the account password never leaks into anything
sent to the GUI, GUI-issued commands reach the bot, and that a failed/refused
connection attempt doesn't crash the process and still schedules a reconnect.
Worth running after any future edit — that last check exists because exactly
that scenario crashed the process during this rewrite (see below).

## What changed from the single-file version

**Bugs fixed (found by writing this rewrite + the test suite, not just by
reading the code — see the relevant comments in `src/connection.js` and
`src/features.js` for the failing scenario each one was caught with):**

- A refused/failed connection attempt could crash the whole process.
  mineflayer can emit a second, late `'error'` event after `'end'` fires
  (observed during testing against a refused port, with version
  auto-detection on). `bot.removeAllListeners()` stripped the error handler
  before that second emission, and Node treats an `'error'` event with zero
  listeners as fatal. Fixed by leaving one quiet listener in place after
  teardown.
- Disconnect cleanup called `bot.pathfinder.stop()` unconditionally; if the
  connection died before the pathfinder plugin finished initializing,
  `bot.pathfinder` doesn't exist yet and this threw — which, depending on
  ordering, could itself have blocked the reconnect that follows it. Cleanup
  is now wrapped so a failure in one teardown step can never block scheduling
  the next reconnect.
- Auto-respawn's delayed `bot.respawn()` call (after a death) closed over the
  bot from the moment of death; if the connection dropped during that 0.8–2.5s
  delay, it would throw on a dead connection instead of just skipping.
- The account password was being spread (`...CONFIG`) into every status
  payload sent to GUI clients — visible in the browser's network tab.
- Verification (`forcedMove`) was disabling physics for the entire 2.5–4.5s
  verify window instead of a brief ~150ms settle, killing gravity/knockback
  for multiple seconds on every teleport.
- `kicked` handler crashed if the server sent the disconnect reason as an
  already-parsed object instead of a JSON string.
- The GUI's `http.Server` had no `'error'` listener, so a port already in
  use (`EADDRINUSE`) crashed the whole process instead of just failing to
  start the dashboard.
- No process-level `uncaughtException`/`unhandledRejection` handlers existed
  at all — added so a stray error can't end an overnight AFK session.
- `.move <x> <y> <z>` used `GoalBlock`, which can stall forever if that exact
  block isn't reachable (e.g. region-protected areas); switched to
  `GoalNear`.
- Combat never noticed when its target died or despawned — only stopped on
  distance, so the pathfinder kept "following" a corpse's last known
  position forever. `entity.isValid` (confirmed via the installed
  `prismarine-entity` source) now ends the fight as soon as the target is
  actually gone.
- `.move <x> <y> <z>` gave no feedback at all if no path existed — the bot
  would just stand there. Added one-shot, self-removing feedback for that
  command specifically, so it can't spam logs later when combat/anti-afk
  reuse the same pathfinder.
- Command dispatch had no error boundary — a throw in any single command
  would propagate out of whatever called it (the GUI socket handler or
  stdin's readline listener, neither of which protects itself). One
  try/catch around dispatch now contains that to a log line instead.
- **Every hit the bot took was silently eating its own knockback.** The
  server sends a position correction in response to combat knockback, same
  as it does for a real verification teleport — and the old code treated
  every `forcedMove` identically: freeze physics, clear all controls, stop
  pathfinder. That's exactly backwards for a knockback-range correction;
  it should just be left alone so physics plays out naturally. Fixed by
  gating the freeze on jump distance (confirmed via testing): only a large
  jump (~8+ blocks, well above max plausible knockback, well below a real
  teleport) starts a verification window now. Once one *is* open, further
  corrections of any size still extend it, same as before — this only
  changes what's allowed to start one.
- Adopted a version-autodetect addition (pings the server before connecting
  instead of leaving `version` unset): besides fixing protocol-mismatch
  errors, it also means mineflayer's own internal auto-version-ping path —
  the actual source of the double-`'error'`-after-`'end'` crash bug from
  the previous round — never runs anymore, since `version` is now always a
  concrete string. That crash is avoided structurally rather than just
  absorbed; the absorbing listener stays as cheap insurance regardless.
- **Bot hung/failed to join on servers requiring a resource pack.** Root
  cause confirmed by reading mineflayer's own plugin source
  (`lib/plugins/resource_pack.js`): it parses the server's offer and
  exposes `bot.acceptResourcePack()`, but never calls it automatically —
  nothing here was either, so a server with `require-resource-pack=true`
  was left waiting indefinitely for a response that never came. New
  `src/resourcepack.js` sends that response (always accept — headless bot
  has no textures to render either way) and logs every stage using the
  real field names confirmed against the installed minecraft-data for
  1.21.8 (`uuid`, `url`, `hash`, `forced`, `promptMessage`). Also tags a
  resource-pack-related kick message in the existing kicked handler for a
  clear error if it still fails.

**Architecture:**

- **No more stale bot references.** Previously, command handling and the
  anti-AFK/camera/combat loops closed over a `bot` variable captured at
  connect time; after a reconnect, anything still holding the old reference
  would throw on a dead socket. Every feature and command now calls
  `state.getBot()` fresh at the moment it acts, so there's only ever one
  live bot and a stale reference is structurally impossible — not just
  patched around.
- **GUI fully decoupled from bot logic.** `gui.js` is now the only file that
  knows Socket.io exists. Everything else just emits on a shared bus
  (`src/bus.js`); this also let the old global `currentHandleCommand`
  function-pointer (which had the same stale-reference problem as above) be
  deleted entirely — both stdin and the GUI now feed commands into the same
  `bus.emit('command', str)`.
- **Dashboard HTML is a real `.html` file**, not a JS template string —
  easier to edit, no backtick-escaping concerns.
- Removed `guiClients` — it was incremented/decremented but never read
  anywhere; deleting it changes no behavior.

Nothing else changed: same commands, same dashboard layout/toggles, same
timing constants, same Sonar verification flow, same food priority list.
