'use strict';

const { EventEmitter } = require('events');

// Single shared bus between modules. Bot/feature/command code never touches
// socket.io directly — it just emits here. gui.js is the only module that
// knows sockets exist at all, and stdin in index.js feeds commands in the
// same way the GUI does. This is what let us delete the old global mutable
// `currentHandleCommand` function pointer: nothing needs a direct reference
// to "the current command handler" anymore, they just emit('command', str).
module.exports = new EventEmitter();
