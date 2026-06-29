'use strict';
const logger = require('./logger');
const { extractText } = require('./util');
// ─── Resource pack handshake ──────────────────────────────────────────────
//
// Root cause of the hang (confirmed by reading
// node_modules/mineflayer/lib/plugins/resource_pack.js): mineflayer parses
// the server's offer and exposes bot.acceptResourcePack()/denyResourcePack(),
// but never calls either one on its own. A server with
// require-resource-pack=true then sits waiting for a response that never
// arrives — that's the hang. This module is that missing response.
//
// Packet shape confirmed against the actual installed minecraft-data for
// 1.21.8 (proto.types.packet_common_add_resource_pack): uuid, url, hash,
// forced, promptMessage. Same shape on 1.21.11. The packet itself is named
// 'add_resource_pack' on 1.20.3+ (both the play-phase and the newer
// configuration-phase variant) and 'resource_pack_send' on older versions —
// minecraft-protocol only ever emits the one matching the server's actual
// negotiated version, so registering both here is safe regardless of which
// version we end up connecting as.
function register(bot) {
  // Sends one resource_pack_receive response, built fresh from this exact
  // offer's own data each time — not from any shared/internal state that
  // could go stale between the two responses below.
  // result codes (confirmed against the protocol): 0 = SUCCESSFULLY_LOADED,
  // 1 = DECLINED, 2 = FAILED_DOWNLOAD, 3 = ACCEPTED.
  function respond(data, result, label) {
    const payload = { result };
    if (bot.supportFeature('resourcePackUsesHash')) payload.hash = data.hash;
    else if (bot.supportFeature('resourcePackUsesUUID')) payload.uuid = data.uuid;
    try {
      bot._client.write('resource_pack_receive', payload);
      logger.log(`[ResourcePack] Sent ${label}.`);
    } catch (e) {
      logger.log(`[ResourcePack] Failed to send ${label}: ${e.message}`);
    }
  }
  function handleOffer(stage, data) {
    const parts = [`url: ${data.url || '(none)'}`];
    if (data.forced !== undefined) parts.push(`forced: ${data.forced}`);
    if (data.hash) parts.push(`hash: ${data.hash}`);
    if (data.uuid) parts.push(`uuid: ${data.uuid}`);
    logger.log(`[ResourcePack] Offered (${stage}) — ${parts.join(', ')}`);
    // promptMessage is the optional admin-configured chat component
    // explaining why the pack is required — worth surfacing if present.
    if (data.promptMessage) {
      const msg = extractText(data.promptMessage);
      if (msg) logger.log(`[ResourcePack] Server message: ${msg}`);
    }
    // The actual fix: respond. A headless bot has no textures to render
    // either way, so accepting unconditionally is correct — declining
    // would only get it kicked on a server that requires the pack, with
    // no upside. A real client sends ACCEPTED first, then
    // SUCCESSFULLY_LOADED right after — mirrored here.
    logger.log('[ResourcePack] Auto-accepting (headless bot — satisfying the handshake, not rendering anything).');
    respond(data, 3, 'ACCEPTED');
    respond(data, 0, 'SUCCESSFULLY_LOADED');
  }
  // Both listeners are registered regardless of version — only the one
  // matching the server's actual negotiated protocol will ever fire, since
  // minecraft-protocol only emits the packet name that version actually
  // uses ('add_resource_pack' on 1.20.3+, 'resource_pack_send' before that).
  bot._client.on('add_resource_pack',  (data) => handleOffer('play/configuration', data));
  bot._client.on('resource_pack_send', (data) => handleOffer('legacy', data));
  bot._client.on('remove_resource_pack', (data) => {
    logger.log(`[ResourcePack] Server removed ${data.uuid ? 'pack ' + data.uuid : 'all packs'}.`);
  });
}
module.exports = { register };
