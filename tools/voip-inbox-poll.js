#!/usr/bin/env node
'use strict';

/*
 * tools/voip-inbox-poll.js — CLI for the real PSTN telephone-exchange intake
 * (extension 108). The actual poll-cycle logic lives in
 * mcp/vcnp-office-mcp/src/live/voip-core.js, shared with the webhook
 * receiver (POST /api/voip-webhook on the live server) so a PBX hook and a
 * standalone cron/loop both drain the SAME way — this file is now just the
 * process wrapper (health/once/forever, exit codes, stdout/stderr).
 *
 * Every message from the remote inbox is a confirmed voice instruction from
 * an authenticated human (the extension requires a PIN before recording).
 * Recordings are 8kHz mono 16-bit PCM WAV, up to 120s, fa-IR. Transcription
 * is OFF on the remote server today — never transcribed locally, never
 * fabricated (plan §6.2/R8): transcript stays null until the remote server
 * itself sends one.
 *
 * Usage:
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js            # run forever
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js --once     # one pass, exit 0
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js --health   # health check only
 *
 * This kit has NO built-in VoIP server — every field below points at YOUR
 * OWN VoIP/PBX inbox. See docs/telephone-exchange-voip-integration.md for
 * the exact HTTP contract your VoIP side needs to expose (health/messages/
 * audio/ack), independent of which PBX software you run.
 *
 * Required env: VOIP_INBOX_BASE (e.g. https://your-host/voip-agent-inbox;
 * VOIP_INBOX_HOST + the default /voip-agent-inbox suffix works too) and
 * VOIP_INBOX_TOKEN (the bearer token — NEVER pass it as a CLI flag, it would
 * leak into the process list and shell history; NEVER commit it; keep it in
 * your own untracked .env / OS environment).
 * Optional env: VOIP_INBOX_TO_ROLE (default "ceo"), VOIP_INBOX_POLL_MS
 * (default 20000, floored at 10000), VOIP_INBOX_LIMIT (default 50),
 * VOIP_INBOX_STATE_FILE (default office/.voip-inbox-cursor.json).
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib + global fetch only.
 */

const path = require('path');
const voip = require(path.join(__dirname, '..', 'mcp', 'vcnp-office-mcp', 'src', 'live', 'voip-core'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(cfg) {
  const h = await voip.fetchHealth(cfg);
  if (h.status !== 200 || !h.body) {
    voip.log(`health check failed: status ${h.status} ${JSON.stringify(h.body)}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(h.body) + '\n');
}

async function runForever(cfg, once) {
  const state = voip.loadState(cfg);
  let backoff = 0;
  for (;;) {
    let result;
    try {
      result = await voip.pollOnce(cfg, state);
    } catch (err) {
      voip.log(`ERROR poll cycle threw: ${(err && err.stack) || err}`);
      result = { advanced: false, hasMore: false, fatal: false };
    }
    if (result.fatal) {
      process.exitCode = 1;
      return;
    }
    if (once) return;

    if (result.hasMore) { backoff = 0; continue; }
    backoff = result.advanced ? 0 : Math.min(voip.MAX_BACKOFF_MS, (backoff || cfg.pollMs) * 2);
    await sleep(backoff || cfg.pollMs);
  }
}

(async () => {
  const cfg = voip.config();
  if (!cfg.base || !cfg.token) {
    process.stderr.write(
      'VOIP_INBOX_BASE (or VOIP_INBOX_HOST) and VOIP_INBOX_TOKEN must both be set — this kit has no\n' +
      'built-in VoIP server; point these at YOUR OWN inbox (see docs/telephone-exchange-voip-integration.md):\n' +
      '  export VOIP_INBOX_BASE=\'https://your-voip-host/voip-agent-inbox\'\n' +
      '  export VOIP_INBOX_TOKEN=\'...\'\n'
    );
    process.exit(1);
  }
  const args = new Set(process.argv.slice(2));
  if (args.has('--health')) return health(cfg);
  return runForever(cfg, args.has('--once'));
})().catch((err) => {
  process.stderr.write(`voip-inbox-poll failed: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
