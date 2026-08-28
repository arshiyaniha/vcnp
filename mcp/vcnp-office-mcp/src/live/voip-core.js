'use strict';

/*
 * live/voip-core.js — the reusable poll-cycle logic behind the real PSTN
 * تلفنخانه intake, shared by the standalone CLI (tools/voip-inbox-poll.js)
 * and the webhook receiver (POST /api/voip-webhook, live-server.js): a PBX
 * hook that pings the webhook doesn't need to send us any message content
 * itself — it just tells us "something is new", and we re-fetch from the
 * SAME trusted VoIP inbox API using our own token, exactly like the poller
 * does. That keeps the receiver from ever trusting attacker-suppliable
 * audio/metadata over the webhook itself.
 *
 * See tools/voip-inbox-poll.js's header for the full consumption contract
 * (idempotency by id, cursor persisted only after success, honest
 * audio_missing skip, 401 fatal / 429 Retry-After / other retry). This
 * module IS that contract — the CLI is now a thin wrapper around it.
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib + global fetch only.
 */

const fs = require('fs');
const path = require('path');

const store = require('../store');
const phoneCore = require('./phone-core');

const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Every field here is YOUR OWN VoIP inbox — there is no built-in default
 * server. This kit ships with zero opinion about whose PBX you use; see
 * docs/telephone-exchange-voip-integration.md for the HTTP contract your
 * VoIP/PBX side needs to expose, then set these three env vars to point at
 * it. VOIP_INBOX_BASE/VOIP_INBOX_TOKEN are required — left null (not a
 * placeholder host) when unset, so a misconfigured install fails honestly
 * instead of silently talking to someone else's server.
 */
function config() {
  const host = process.env.VOIP_INBOX_HOST ? process.env.VOIP_INBOX_HOST.replace(/\/+$/, '') : null;
  const base = process.env.VOIP_INBOX_BASE
    ? process.env.VOIP_INBOX_BASE.replace(/\/+$/, '')
    : (host ? `${host}/voip-agent-inbox` : null);
  return {
    host,
    base,
    token: process.env.VOIP_INBOX_TOKEN || null,
    toRole: process.env.VOIP_INBOX_TO_ROLE || 'ceo',
    limit: Number.parseInt(process.env.VOIP_INBOX_LIMIT, 10) || 50,
    pollMs: Math.max(10000, Number.parseInt(process.env.VOIP_INBOX_POLL_MS, 10) || 20000),
    stateFile: process.env.VOIP_INBOX_STATE_FILE || path.join(store.OFFICE_DIR, '.voip-inbox-cursor.json'),
    webhookSecret: process.env.VOIP_WEBHOOK_SECRET || null,
  };
}

function log(msg) {
  process.stderr.write(`[voip-core] ${new Date().toISOString()} ${msg}\n`);
}

function authHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.token}` };
}

/* ---------------- state (cursor + processed-id set), atomic writes ---------------- */

function loadState(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    return {
      since_seq: Number.isInteger(raw.since_seq) ? raw.since_seq : 0,
      seen_ids: Array.isArray(raw.seen_ids) ? raw.seen_ids : [],
    };
  } catch (_) {
    return { since_seq: 0, seen_ids: [] };
  }
}

function saveState(cfg, state) {
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  store.atomicWriteText(cfg.stateFile, JSON.stringify(state) + '\n');
}

/* ---------------- remote calls ---------------- */

async function fetchJson(cfg, url) {
  const res = await fetch(url, { headers: authHeaders(cfg) });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { status: res.status, headers: res.headers, body };
}

async function fetchHealth(cfg) {
  return fetchJson(cfg, `${cfg.base}/v1/health`);
}

async function downloadAudio(cfg, audioUrl) {
  const res = await fetch(cfg.host + audioUrl, { headers: authHeaders(cfg) });
  if (!res.ok) return { status: res.status, buf: null };
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function ackMessage(cfg, id) {
  const res = await fetch(`${cfg.base}/v1/messages/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: authHeaders(cfg),
  });
  return res.status;
}

/** Never transcribe locally, never fabricate — mirrors the browser widget's honesty rule. */
function readInstructionText(message) {
  return message.has_transcript && typeof message.transcript === 'string' && message.transcript.trim()
    ? message.transcript
    : null;
}

/* ---------------- one message ---------------- */

/** @returns {'ok'|'skip'|'retry'} */
async function processMessage(cfg, message) {
  const dl = await downloadAudio(cfg, message.audio_url);
  if (dl.status === 404) {
    log(`WARN audio_missing for ${message.id} — skipping permanently (nothing to retry)`);
    return 'skip';
  }
  if (dl.status !== 200 || !dl.buf) {
    log(`WARN audio download failed for ${message.id} (status ${dl.status}) — will retry this page`);
    return 'retry';
  }
  if (dl.buf.length !== message.bytes) {
    log(`WARN incomplete download for ${message.id} (${dl.buf.length} != ${message.bytes} bytes) — will retry`);
    return 'retry';
  }

  const r = await phoneCore.receiveCall({
    audio_buffer: dl.buf,
    mime: message.mime || 'audio/wav',
    transcript: readInstructionText(message),
    lang: message.lang || 'fa-IR',
    duration_ms: Number.isInteger(message.duration_ms) ? message.duration_ms : 0,
    to_role: cfg.toRole,
    source: 'voip',
    ip: message.caller_id || 'voip-108',
  });
  if (!r || r.ok !== true) {
    log(`ERROR receiveCall rejected ${message.id}: ${JSON.stringify(r)} — will retry this page`);
    return 'retry';
  }

  const ackStatus = await ackMessage(cfg, message.id);
  if (ackStatus < 200 || ackStatus >= 300) {
    log(`WARN ack failed for ${message.id} (status ${ackStatus}) — office ledger already recorded it`);
  }
  log(`OK processed ${message.id} -> call_id=${r.call_id} message_id=${r.message_id}`);
  return 'ok';
}

/* ---------------- one page / one poll cycle ---------------- */

/** @returns {{advanced: boolean, hasMore: boolean, fatal: boolean, processed: number}} */
async function pollOnce(cfg, state) {
  const page = await fetchJson(cfg, `${cfg.base}/v1/messages?since_seq=${state.since_seq}&limit=${cfg.limit}`);

  if (page.status === 401) {
    log('FATAL 401 unauthorized — token rejected. Stop and get a new VOIP_INBOX_TOKEN; not retrying.');
    return { advanced: false, hasMore: false, fatal: true, processed: 0 };
  }
  if (page.status === 429) {
    const retryAfter = Number.parseInt(page.headers.get('retry-after'), 10) || 60;
    log(`rate_limited — sleeping ${retryAfter}s per Retry-After`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return { advanced: false, hasMore: true, fatal: false, processed: 0 };
  }
  if (page.status !== 200 || !page.body) {
    log(`WARN unexpected status ${page.status} listing messages — backing off`);
    return { advanced: false, hasMore: false, fatal: false, processed: 0 };
  }

  const messages = Array.isArray(page.body.messages) ? page.body.messages : [];
  let advanced = false, processed = 0;
  for (const m of messages) {
    if (!m || typeof m.id !== 'string') continue;
    if (state.seen_ids.includes(m.id)) continue; // dedupe by id, never by seq

    const outcome = await processMessage(cfg, m);
    if (outcome === 'retry') {
      return { advanced, hasMore: false, fatal: false, processed };
    }
    state.seen_ids.push(m.id);
    if (Number.isInteger(m.seq)) state.since_seq = Math.max(state.since_seq, m.seq);
    saveState(cfg, state); // persist AFTER success, one message at a time
    advanced = true;
    if (outcome === 'ok') processed += 1;
  }
  return { advanced, hasMore: page.body.has_more === true, fatal: false, processed };
}

/** Drains every available page once (used by both --once and the webhook). */
async function drainOnce(cfg) {
  const state = loadState(cfg);
  let totalProcessed = 0;
  for (;;) {
    const r = await pollOnce(cfg, state);
    totalProcessed += r.processed;
    if (r.fatal) return { ok: false, error: 'unauthorized', processed: totalProcessed };
    if (!r.hasMore) return { ok: true, processed: totalProcessed };
  }
}

module.exports = {
  MAX_BACKOFF_MS, config, log, loadState, saveState, fetchHealth, pollOnce, drainOnce,
};
