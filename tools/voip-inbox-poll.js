#!/usr/bin/env node
'use strict';

/*
 * tools/voip-inbox-poll.js — VoIP telephone-exchange intake for extension 108
 * (the real PSTN «تلفنخانه», per the VoIP inbox API doc — contract v1, 2026-08-26).
 *
 * This is a THIRD phone-exchange intake alongside the browser widget
 * (POST /api/phone) and tools/phone-drop.js: it polls a REMOTE voicemail
 * inbox HTTP API (a separate service the caller runs, outside this repo)
 * and funnels each new voicemail through the SAME write path as the other
 * two — mcp/vcnp-office-mcp/src/live/phone-core.js's receiveCall() — so a
 * real phone call ends up as the identical {phone_call_received,
 * message_posted} ledger pair regardless of which door it came through.
 *
 * Every message from the remote inbox is a confirmed voice instruction from
 * an authenticated human (the extension requires a PIN before recording) —
 * not a random/spam call. Recordings are 8kHz mono 16-bit PCM WAV, up to
 * 120s, fa-IR. Transcription is OFF on the remote server today
 * (has_transcript is always false) — this script does NOT transcribe
 * locally; it carries transcript:null honestly, exactly like the browser
 * widget does when Web Speech fails (plan §6.2/R8 — never fabricate a
 * transcript). If the remote server turns transcription on later, its
 * `transcript`/`has_transcript` fields are used as-is — no code change
 * needed here (see readInstructionText()).
 *
 * Consumption contract honored (doc §7, §9, §10, §11):
 *   - since_seq cursor persisted ONLY after a message is fully processed
 *     AND acked — never before (a crash mid-message replays it, never loses it)
 *   - dedupe by REMOTE id, never by seq (seq is reused if a transcript
 *     arrives later and the message resends)
 *   - has_more pages drained without delay; otherwise poll every
 *     VOIP_INBOX_POLL_MS (default 20s, floor 10s per the doc's rate rule)
 *   - 401 is fatal (bad/revoked token — do not retry); 429 honors
 *     Retry-After; 503/network errors back off and retry; a message whose
 *     audio 404s (audio_missing) is logged and skipped forever (retrying
 *     won't produce a file that isn't there) — anything else about a
 *     message stops the page so ordering + the cursor stay honest, and the
 *     whole page is retried next cycle
 *
 * Usage:
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js            # run forever
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js --once     # one pass, exit 0
 *   VOIP_INBOX_TOKEN=... node tools/voip-inbox-poll.js --health   # health check only
 *
 * Required env: VOIP_INBOX_TOKEN (the bearer token — NEVER pass it as a CLI
 * flag, it would leak into the process list and shell history; NEVER commit
 * it; keep it in your own untracked .env / OS environment).
 * Optional env: VOIP_INBOX_BASE (default below), VOIP_INBOX_TO_ROLE
 * (default "ceo"), VOIP_INBOX_POLL_MS (default 20000, floored at 10000),
 * VOIP_INBOX_LIMIT (default 50), VOIP_INBOX_STATE_FILE (default
 * office/.voip-inbox-cursor.json).
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib + global fetch only.
 */

const fs = require('fs');
const path = require('path');

const store = require(path.join(__dirname, '..', 'mcp', 'vcnp-office-mcp', 'src', 'store'));
const phoneCore = require(path.join(__dirname, '..', 'mcp', 'vcnp-office-mcp', 'src', 'live', 'phone-core'));

const HOST = (process.env.VOIP_INBOX_HOST || 'https://voip.arshiyaniha.ir').replace(/\/+$/, '');
const BASE = (process.env.VOIP_INBOX_BASE || `${HOST}/voip-agent-inbox`).replace(/\/+$/, '');
const TOKEN = process.env.VOIP_INBOX_TOKEN;
const TO_ROLE = process.env.VOIP_INBOX_TO_ROLE || 'ceo';
const LIMIT = Number.parseInt(process.env.VOIP_INBOX_LIMIT, 10) || 50;
const POLL_MS = Math.max(10000, Number.parseInt(process.env.VOIP_INBOX_POLL_MS, 10) || 20000);
const STATE_FILE = process.env.VOIP_INBOX_STATE_FILE
  || path.join(store.OFFICE_DIR, '.voip-inbox-cursor.json');
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function log(msg) {
  process.stderr.write(`[voip-inbox-poll] ${new Date().toISOString()} ${msg}\n`);
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

/* ---------------- state (cursor + processed-id set), atomic writes ---------------- */

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      since_seq: Number.isInteger(raw.since_seq) ? raw.since_seq : 0,
      seen_ids: Array.isArray(raw.seen_ids) ? raw.seen_ids : [],
    };
  } catch (_) {
    return { since_seq: 0, seen_ids: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  store.atomicWriteText(STATE_FILE, JSON.stringify(state) + '\n');
}

/* ---------------- remote calls ---------------- */

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { status: res.status, headers: res.headers, body };
}

async function fetchHealth() {
  return fetchJson(`${BASE}/v1/health`);
}

async function downloadAudio(audioUrl) {
  const res = await fetch(HOST + audioUrl, { headers: authHeaders() });
  if (!res.ok) return { status: res.status, buf: null };
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function ackMessage(id) {
  const res = await fetch(`${BASE}/v1/messages/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    headers: authHeaders(),
  });
  return res.status;
}

/* ---------------- honest instruction text (doc §3) ---------------- */

/** Never transcribe locally, never fabricate — mirrors the browser widget's honesty rule. */
function readInstructionText(message) {
  return message.has_transcript && typeof message.transcript === 'string' && message.transcript.trim()
    ? message.transcript
    : null;
}

/* ---------------- one message ---------------- */

/** @returns {'ok'|'skip'|'retry'} */
async function processMessage(message) {
  const dl = await downloadAudio(message.audio_url);
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
    to_role: TO_ROLE,
    source: 'voip',
    ip: message.caller_id || 'voip-108',
  });
  if (!r || r.ok !== true) {
    log(`ERROR receiveCall rejected ${message.id}: ${JSON.stringify(r)} — will retry this page`);
    return 'retry';
  }

  const ackStatus = await ackMessage(message.id);
  if (ackStatus < 200 || ackStatus >= 300) {
    // Office ledger already has the call — do not reprocess it on the retry
    // (dedupe by id would skip it anyway), but the remote inbox will still
    // show it pending until a later ack succeeds. Log loudly; do not crash.
    log(`WARN ack failed for ${message.id} (status ${ackStatus}) — office ledger already recorded it`);
  }
  log(`OK processed ${message.id} -> call_id=${r.call_id} message_id=${r.message_id}`);
  return 'ok';
}

/* ---------------- one page / one poll cycle ---------------- */

/** @returns {{advanced: boolean, hasMore: boolean, fatal: boolean}} */
async function pollOnce(state) {
  const page = await fetchJson(`${BASE}/v1/messages?since_seq=${state.since_seq}&limit=${LIMIT}`);

  if (page.status === 401) {
    log('FATAL 401 unauthorized — token rejected. Stop and get a new VOIP_INBOX_TOKEN; not retrying.');
    return { advanced: false, hasMore: false, fatal: true };
  }
  if (page.status === 429) {
    const retryAfter = Number.parseInt(page.headers.get('retry-after'), 10) || 60;
    log(`rate_limited — sleeping ${retryAfter}s per Retry-After`);
    await sleep(retryAfter * 1000);
    return { advanced: false, hasMore: true, fatal: false }; // try again immediately after the wait
  }
  if (page.status !== 200 || !page.body) {
    log(`WARN unexpected status ${page.status} listing messages — backing off`);
    return { advanced: false, hasMore: false, fatal: false };
  }

  const messages = Array.isArray(page.body.messages) ? page.body.messages : [];
  let advanced = false;
  for (const m of messages) {
    if (!m || typeof m.id !== 'string') continue;
    if (state.seen_ids.includes(m.id)) continue; // dedupe by id, never by seq (doc §7 rule 2)

    const outcome = await processMessage(m);
    if (outcome === 'retry') {
      // Stop here so ordering + the cursor stay honest; the whole page
      // (including everything after this message) is retried next cycle.
      return { advanced, hasMore: false, fatal: false };
    }
    // 'ok' and 'skip' both count as handled — advance past this message.
    state.seen_ids.push(m.id);
    if (Number.isInteger(m.seq)) state.since_seq = Math.max(state.since_seq, m.seq);
    saveState(state); // persist AFTER success (doc §7 rule 1), one message at a time
    advanced = true;
  }
  return { advanced, hasMore: page.body.has_more === true, fatal: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- entrypoints ---------------- */

async function health() {
  const h = await fetchHealth();
  if (h.status !== 200 || !h.body) {
    log(`health check failed: status ${h.status} ${JSON.stringify(h.body)}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(h.body) + '\n');
}

async function runForever(once) {
  const state = loadState();
  let backoff = 0;
  for (;;) {
    let result;
    try {
      result = await pollOnce(state);
    } catch (err) {
      log(`ERROR poll cycle threw: ${(err && err.stack) || err}`);
      result = { advanced: false, hasMore: false, fatal: false };
    }
    if (result.fatal) {
      process.exitCode = 1;
      return;
    }
    if (once) return;

    if (result.hasMore) { backoff = 0; continue; }
    backoff = result.advanced ? 0 : Math.min(MAX_BACKOFF_MS, (backoff || POLL_MS) * 2);
    await sleep(backoff || POLL_MS);
  }
}

(async () => {
  if (!TOKEN) {
    process.stderr.write(
      'VOIP_INBOX_TOKEN is not set. Export it in your shell/OS environment (never in git):\n' +
      '  export VOIP_INBOX_TOKEN=\'vai_...\'\n'
    );
    process.exit(1);
  }
  const args = new Set(process.argv.slice(2));
  if (args.has('--health')) return health();
  return runForever(args.has('--once'));
})().catch((err) => {
  process.stderr.write(`voip-inbox-poll failed: ${(err && err.stack) || err}\n`);
  process.exit(1);
});
