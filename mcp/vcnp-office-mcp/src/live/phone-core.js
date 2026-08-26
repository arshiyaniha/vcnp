'use strict';

/*
 * live/phone-core.js — telephone exchange «تلفنخانه» domain core
 * (live-office plan §1.4, §2, §6, D5 — Phase 5). Shared by the live HTTP API
 * (POST /api/phone via live-server deps) and the CLI intake at workspace root
 * (tools/phone-drop.js) so web and CLI produce IDENTICAL downstream state.
 *
 * PURE projections (no I/O):
 *   nextCallId(events)       ph-NNNN allocation from the event list
 *   projectPhone(events)     { recent:[…] } view per §1.4, enriched with the
 *                            honest answer status of the PAIRED message and
 *                            a playback URL (/api/audio/<file>)
 *
 * Storage contract (§6.3, D5 — all writes under office/phone/):
 *   <UTCstamp>.webm (+ -1/-2… collision suffixes, NEVER overwrite) plus a
 *   sidecar <name>.json {call_id, ts, mime, duration_ms, lang, transcript,
 *   has_transcript, ip, audio_ref, size_bytes, source}. Filenames are
 *   SERVER-GENERATED ONLY (stamp + counter) — no user input ever reaches a
 *   path. Audio bytes are sniffed against container magic (webm EBML / mp4
 *   ftyp / ogg OggS) before anything is written.
 *
 * WRITE op:
 *   receiveCall({audio_base64|audio_buffer, mime, transcript?, lang?,
 *                duration_ms?, to_role?, ip?, source?})
 *     → writes audio + sidecar, then UNDER ONE OFFICE LOCK appends the pair
 *       phone_call_received + message_posted{to_role:'ceo',
 *       text: transcript || '[voice message - no transcript]', channel:'phone'}
 *       (§6.3). Mirrors regen + SSE broadcast happen automatically through the
 *       post-append hook / ledger watcher (D2).
 *
 * Honesty: an absent/failed transcript is carried as transcript:null +
 * has_transcript:false — never fabricated (plan §6.2/R8).
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib only.
 */

const fs = require('fs');
const path = require('path');
const store = require('../store');
const V = require('../lib/events-validate');

const PHONE_DIR_REL = 'office/phone';
const PHONE_RECENT_LIMIT = 8;      // bounded window for composed payload (§1.4)
/* D5: browser uploads (audio_base64 over HTTP, POST /api/phone) are ≤2 min
 * compressed Opus ≈ 0.5 MB, comfortably inside the HTTP body limit (2 MB
 * base64-inflated). The VoIP telephone-exchange intake (voip-inbox-poll.js,
 * KB voice inbox 108) calls receiveCall() directly in-process — same as the
 * CLI — so it never touches that HTTP body limit, but it delivers
 * UNCOMPRESSED 8kHz/16-bit/mono WAV: the documented 120s hard cap on that
 * line is 8000 * 2 * 120 = 1,920,000 bytes. 2 MiB covers the full 120s WAV
 * case plus headroom for the WAV header and any future codec. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MIN_AUDIO_BYTES = 12;        // smallest buffer the magic-sniff can judge
const NO_TRANSCRIPT_TEXT = '[voice message - no transcript]'; // §6.3 verbatim
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);     // Matroska/WebM

function phoneDir() {
  return path.join(store.OFFICE_DIR, 'phone');
}

/* ---------------- id allocation (caller MUST hold the lock) ------------- */

function nextCallId(events) {
  let max = 0;
  for (const ev of events) {
    if (!ev || ev.action !== 'phone_call_received') continue;
    const m = /^ph-(\d+)$/.exec(String(ev.call_id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'ph-' + String(max + 1).padStart(4, '0');
}

/* ---------------- content sniffing + name allocation ---------------- */

/** Container guess from magic bytes only — no decoder, no fabrication. */
function sniffContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_AUDIO_BYTES) return null;
  if (buf.subarray(0, 4).equals(EBML_MAGIC)) return 'webm';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  // RIFF....WAVE — telephony recordings (voip-inbox-poll.js), not a browser
  // MediaRecorder container. Needs both the outer RIFF chunk and the WAVE
  // form type at byte 8, per the standard RIFF/WAVE layout.
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') {
    return 'wav';
  }
  return null;
}

function mimeFamily(mime) {
  const m = /^audio\/(webm|mp4|ogg|wav)(;|$)/i.exec(String(mime || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/** UTC stamp YYYYMMDD-HHMMSS — server-generated filenames only (§6.3). */
function utcStamp(d) {
  return new Date(d == null ? Date.now() : d).toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
}

/**
 * First free <stamp>(-N).<ext> inside dir. Pure fs-existence loop: collisions
 * get -1, -2, … suffixes and existing files are NEVER overwritten (task §2).
 * Exported for deterministic collision tests.
 */
function allocateAudioName(dir, stamp, ext, skipExists) {
  const clean = String(stamp).replace(/[^0-9]/g, '').slice(0, 14);
  const e = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase();
  let name = `${clean}.${e}`;
  let i = 0;
  while (!skipExists) {
    try {
      // eslint-disable-next-line no-bitwise
      if (!fs.existsSync(path.join(dir, name))) break;
    } catch (_) { /* unreadable ⇒ treat as taken, keep searching */ }
    i += 1;
    name = `${clean}-${i}.${e}`;
    if (i > 99) throw new Error('office/phone collision overflow (100 files within one second)');
  }
  return name;
}

/** temp file + rename so static/audio readers never see partial bytes. */
function atomicWriteBuf(file, buf) {
  const tmp = `${file}.part-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw err;
  }
}

/* ---------------- pure projection ---------------- */

/**
 * phone.recent (§1.4) newest-first, each entry joined with the answer status
 * of its PAIRED message_posted (via message_answered.reply_to) so renderers
 * never join events themselves. `answered:false` + «در انتظار نشست» semantics
 * are the honest pending state until a real session replies.
 */
function projectPhone(events, opts) {
  const o = opts || {};
  const cap = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : PHONE_RECENT_LIMIT;
  const answerFor = new Map();          // reply_to(event_id) -> answer event
  const msgEventByMessageId = new Map();// message_id -> message_posted event
  const callByPaired = new Map();       // paired_message_id -> call event
  for (const ev of events) {
    if (!ev) continue;
    if (ev.action === 'message_answered' && typeof ev.reply_to === 'string') {
      answerFor.set(ev.reply_to, ev);
    } else if (ev.action === 'message_posted' && typeof ev.message_id === 'string') {
      msgEventByMessageId.set(ev.message_id, ev);
    } else if (ev.action === 'phone_call_received' && typeof ev.paired_message_id === 'string') {
      callByPaired.set(ev.paired_message_id, ev);
    }
  }
  const base = (ref) => String(ref).split('/').pop();
  const recent = [];
  for (let i = events.length - 1; i >= 0 && recent.length < cap; i--) {
    const ev = events[i];
    if (!ev || ev.action !== 'phone_call_received') continue;
    const paired = msgEventByMessageId.get(String(ev.paired_message_id)) || null;
    const ans = paired ? (answerFor.get(paired.event_id) || null) : null;
    recent.push({
      call_id: ev.call_id,
      ts: ev.ts,
      transcript: ev.transcript === undefined ? null : ev.transcript,
      has_transcript: ev.has_transcript === true,
      audio_ref: ev.audio_ref,
      audio_url: '/api/audio/' + base(ev.audio_ref),
      duration_ms: Number.isInteger(ev.duration_ms) ? ev.duration_ms : 0,
      lang: ev.lang || V.LANG_DEFAULT,
      mime: ev.mime || null,
      paired_message_id: ev.paired_message_id,
      answered: !!ans,
      ...(ans ? { answered_ts: ans.ts, answered_by: ans.actor } : {}),
    });
  }
  return { recent };
}

/* ---------------- write op ---------------- */

function fail(error, reasons) {
  return { ok: false, error, reasons };
}

/**
 * Validate the transport surface that does NOT depend on lock-allocated ids.
 * Full event validation runs again inside the lock as defense in depth.
 */
function surfaceReasons(input, container) {
  const reasons = [];
  if (typeof input.mime !== 'string' || !V.MIME_RE.test(input.mime.trim())) {
    reasons.push("'mime' must be audio/webm, audio/mp4, audio/ogg or audio/wav (optional ;codecs=…)");
  } else {
    const fam = mimeFamily(input.mime);
    if (fam !== container) {
      reasons.push(`declared mime family '${fam}' does not match the sniffed container '${container}'`);
    }
  }
  if (input.transcript !== undefined && input.transcript !== null &&
      (typeof input.transcript !== 'string' || input.transcript.trim().length === 0 ||
        input.transcript.length > V.TRANSCRIPT_MAX)) {
    reasons.push(`'transcript' must be a non-empty string of at most ${V.TRANSCRIPT_MAX} characters, or null`);
  }
  const lang = input.lang === undefined ? V.LANG_DEFAULT : input.lang;
  if (typeof lang !== 'string' || !V.LANG_RE.test(lang)) {
    reasons.push("'lang' must be a BCP-47 tag such as fa-IR");
  }
  const dur = input.duration_ms === undefined || input.duration_ms === null ? 0 : input.duration_ms;
  if (!Number.isInteger(dur) || dur < 0) {
    reasons.push("'duration_ms' must be an integer >= 0");
  }
  const role = input.to_role === undefined ? 'ceo' : input.to_role;
  if (!V.ROLES.includes(role)) {
    reasons.push(`'to_role' must be one of ${V.ROLES.join('|')}`);
  }
  return reasons;
}

/**
 * The ONE phone write path (HTTP + CLI). See module header for the contract.
 * Files land first (outside the ledger), then BOTH events append inside a
 * single locked critical section with lock-allocated ph-/m- ids (plan §2).
 */
async function receiveCall(args) {
  const input = args || {};
  const KNOWN_SOURCES = ['cli', 'voip', 'web'];
  const source = KNOWN_SOURCES.includes(input.source) ? input.source : 'web';

  /* ---- decode + sniff BEFORE any disk or ledger effect ---- */
  let b64 = typeof input.audio_base64 === 'string' ? input.audio_base64.trim() : '';
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    b64 = comma > 0 ? b64.slice(comma + 1).trim() : '';
  }
  let buf = null;
  if (b64) {
    if (b64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4) {
      return fail('audio_too_large', [`decoded audio must be at most ${MAX_AUDIO_BYTES} bytes`]);
    }
    buf = Buffer.from(b64, 'base64');
  } else if (Buffer.isBuffer(input.audio_buffer)) {
    buf = input.audio_buffer;
  }
  if (!buf || buf.length === 0) {
    return fail('invalid_phone_call', ["'audio_base64' must be a non-empty base64 string"]);
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    return fail('audio_too_large', [`decoded audio is ${buf.length} bytes; cap is ${MAX_AUDIO_BYTES}`]);
  }
  const container = sniffContainer(buf);
  if (!container) {
    return fail('unsupported_audio', [
      'content does not look like webm/mp4/ogg/wav audio (magic-byte sniff failed)',
    ]);
  }
  const preReasons = surfaceReasons(input, container);
  if (preReasons.length) return fail('invalid_phone_call', preReasons);

  const mime = String(input.mime).trim();
  const transcript =
    typeof input.transcript === 'string' && input.transcript.trim() ? input.transcript.trim() : null;
  const lang = input.lang === undefined ? V.LANG_DEFAULT : input.lang;
  const duration_ms = input.duration_ms === undefined || input.duration_ms === null ? 0 : input.duration_ms;
  const to_role = input.to_role === undefined ? 'ceo' : input.to_role;
  const ip = typeof input.ip === 'string' && input.ip ? input.ip : (source === 'web' ? 'unknown' : source);

  /* ---- storage: office/phone/<stamp>.<ext> + sidecar (never overwrite) ---- */
  const dir = phoneDir();
  fs.mkdirSync(dir, { recursive: true });
  const nowTs = new Date().toISOString();
  const name = allocateAudioName(dir, utcStamp(), container, false);
  const audio_ref = `${PHONE_DIR_REL}/${name}`;
  atomicWriteBuf(path.join(dir, name), buf);
  store.atomicWriteText(
    path.join(dir, name.replace(/\.[a-z0-9]+$/i, '.json')),
    JSON.stringify({
      call_id: null, // patched below once the lock-allocated id exists
      ts: nowTs,
      mime,
      duration_ms,
      lang,
      transcript,
      has_transcript: transcript !== null,
      ip,
      audio_ref,
      size_bytes: buf.length,
      source,
    }) + '\n'
  );

  /* ---- ledger pair under ONE lock (§6.3) ---- */
  try {
    return await store.withLock(async () => {
      const events = store.readEvents();
      const call_id = nextCallId(events);        // INSIDE the lock — race-free
      const message_id = require('./inbox-core').nextMessageId(events);
      const fields = {
        actor: 'user',
        action: 'phone_call_received',
        call_id,
        transcript,
        audio_ref,
        mime,
        duration_ms,
        lang,
        has_transcript: transcript !== null,
        paired_message_id: message_id,
      };
      const reasons = V.validatePhoneCallReceived(fields); // defense in depth
      if (reasons.length) return fail('invalid_phone_call', reasons);
      const rCall = await store.appendEventLocked(fields, { events });
      if (rCall.duplicate) return fail(`duplicate phone_call_received event ${rCall.event_id}`);
      const rMsg = await store.appendEventLocked({
        actor: 'user',
        action: 'message_posted',
        message_id,
        to_role,
        text: transcript || NO_TRANSCRIPT_TEXT,
        channel: 'phone',
      }, { events });
      if (rMsg.duplicate) return fail(`duplicate message_posted event ${rMsg.event_id}`);
      /* sidecar promised the call_id — patch it now that it exists */
      try {
        store.atomicWriteText(
          path.join(dir, name.replace(/\.[a-z0-9]+$/i, '.json')),
          JSON.stringify({
            call_id, ts: nowTs, mime, duration_ms, lang, transcript,
            has_transcript: transcript !== null, ip, audio_ref,
            size_bytes: buf.length, source,
          }) + '\n'
        );
      } catch (_) { /* sidecar patch is best-effort; ledger stays truthful */ }
      return {
        ok: true,
        call_id,
        event_id: rCall.event.event_id,
        message_id,
        to_role,
        audio_ref,
        audio_url: '/api/audio/' + name,
        size_bytes: buf.length,
        has_transcript: transcript !== null,
        ts: rCall.event.ts,
      };
    });
  } catch (err) {
    /* ledger append failed after files landed: honest orphan — the sidecar
     + audio exist but NO event claims them; nothing fake is appended later. */
    return fail('append_failed', [(err && err.message) || String(err)]);
  }
}

module.exports = {
  PHONE_DIR_REL,
  PHONE_RECENT_LIMIT,
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
  NO_TRANSCRIPT_TEXT,
  phoneDir,
  nextCallId,
  sniffContainer,
  mimeFamily,
  utcStamp,
  allocateAudioName,
  projectPhone,
  receiveCall,
};
