'use strict';

/*
 * phone.test — Phase 5 telephone exchange «تلفنخانه» (live-office plan
 * §1.4/§2/§6, D5/D6):
 *   T1  validatePhoneCallReceived rejects (ids, audio_ref + traversal, mime,
 *       lang, duration_ms, has_transcript ⇔ transcript consistency)
 *   T2  receiveCall surface rejects HONESTLY — no files, no events
 *       (empty base64, foreign container, mime/container mismatch, oversized)
 *   T3  happy path: synthetic webm → audio + sidecar files + PAIRED ledger
 *       events (phone_call_received + message_posted{channel:"phone"})
 *   T4  no-transcript honesty: transcript null ⇒ has_transcript:false and the
 *       paired message text is '[voice message - no transcript]' VERBATIM
 *   T5  collision suffixes: <stamp>.webm → <stamp>-1.webm → -2 … NEVER
 *       overwrite (allocateAudioName + real back-to-back calls)
 *   T6  compose/projection: phone.recent newest-first with playback URL and
 *       the honest answer join after a REAL inbox_reply
 *   T7  CEO delivery: inbox projections carry the playable audio descriptor
 *       (pending AND answered_recent)
 *   T8  HTTP: POST /api/phone happy → 200 + files + SSE broadcast carrying
 *       the call; 400 invalid_json / bad surface · 413 oversized · 415 wrong
 *       container; GET /api/audio serves EXACT stored bytes; traversal and
 *       non-audio names refused
 *   T9  CLI tools/phone-drop.js (workspace root per §6.4): audio mode emits
 *       the IDENTICAL event shape from a SECOND PROCESS; text mode posts
 *       message_posted{channel:"cli"}
 *
 * Run: node test/phone.test.js   (temp workspace — repo office/ untouched)
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = path.resolve(__dirname, '..');
const ROOT = path.resolve(PKG, '..', '..'); // workspace root (tools/phone-drop.js)

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('PASS: ' + name);
  } else {
    fail += 1;
    console.log('FAIL: ' + name + (extra !== undefined ? ' — ' + extra : ''));
  }
}

/* ---------------- global watchdog ---------------- */
setTimeout(() => {
  process.stderr.write('phone.test: GLOBAL TIMEOUT after 150s\n');
  process.exit(1);
}, 150000).unref();

/* ---------------- helpers ---------------- */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal but honest WebM: real EBML magic + filler bytes (sniff-only). */
function webmBytes(size) {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc((size || 96) - 4, 0x42),
  ]);
}

function tmpWorkspace(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `vcnp-phone-${tag}-`));
  fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'office', 'events.log.jsonl'), '');
  return ws;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function request(port, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const body = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(body); } catch (_) { /* non-JSON body */ }
          resolve({ status: res.statusCode, headers: res.headers, body, buf, json });
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* Raw SSE client (Node 20 has no global EventSource) — same as live-server.js */
function sseConnect(port) {
  const state = { res: null, frames: [], waiters: [] };
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/stream', headers: { Accept: 'text/event-stream' } },
      (res) => {
        state.res = res;
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const frame = {};
            for (const line of raw.split('\n')) {
              const m = /^([A-Za-z]+):\s?(.*)$/.exec(line);
              if (!m) continue;
              if (m[1] === 'data') frame.data = frame.data ? frame.data + '\n' + m[2] : m[2];
              else frame[m[1]] = m[2];
            }
            if (frame.data !== undefined) {
              try { frame.json = JSON.parse(frame.data); } catch (_) { /* keep raw */ }
            }
            state.frames.push(frame);
            const waiters = state.waiters.splice(0);
            for (const w of waiters) w();
          }
        });
        res.on('error', () => {});
        resolve(state);
      }
    );
    req.on('error', reject);
  });
}

function nextFrame(client, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (client.frames.length) { resolve(client.frames.shift()); return; }
    const t = setTimeout(() => reject(new Error('timeout waiting for SSE frame: ' + label)), timeoutMs);
    client.waiters.push(() => {
      clearTimeout(t);
      if (client.frames.length) resolve(client.frames.shift());
    });
  });
}

async function nextPayloadFrame(client, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout waiting for payload frame: ' + label);
    const f = await nextFrame(client, remaining, label);
    if (f.event === 'payload' && f.json) return f;
  }
}

/** Spawn tools/phone-drop.js (workspace root, §6.4) as a SECOND PROCESS. */
function runCli(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'phone-drop.js'), ...args], {
      cwd: ROOT,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: WS },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => {
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch (_) { /* non-JSON */ }
      resolve({ code, json, err });
    });
    c.on('error', (e) => resolve({ code: -1, json: null, err: String(e) }));
  });
}

/* ================= main ================= */

const WS = tmpWorkspace('main');
process.env.VCNP_OFFICE_WORKSPACE = WS; // MUST precede src requires

const store = require('../src/store');
const V = require('../src/lib/events-validate');
const phoneCore = require('../src/live/phone-core');
const inboxCore = require('../src/live/inbox-core');
const compose = require('../src/live/compose');

(async () => {
  await store.bootstrap('Phone Test Project', 'verify phase 5');

  /* ---------- T1: validator rejects ---------- */
  {
    const ok = {
      call_id: 'ph-0001',
      transcript: 'سلام',
      audio_ref: 'office/phone/20260825-181500.webm',
      mime: 'audio/webm',
      duration_ms: 1200,
      lang: 'fa-IR',
      has_transcript: true,
      paired_message_id: 'm-0001',
    };
    check('T1: valid input passes', V.validatePhoneCallReceived(ok).length === 0,
      V.validatePhoneCallReceived(ok).join(' | '));
    check('T1: transcript omitted ⇒ has_transcript must be false',
      V.validatePhoneCallReceived({ ...ok, transcript: undefined, has_transcript: false }).length === 0 &&
      V.validatePhoneCallReceived({ ...ok, transcript: undefined }).length > 0);
    const bad = [
      [{ ...ok, call_id: 'call-9' }, 'malformed call_id'],
      [{ ...ok, audio_ref: 'office/phone/../secret.webm' }, 'traversal audio_ref'],
      [{ ...ok, audio_ref: 'C:\\tmp\\x.webm' }, 'absolute audio_ref'],
      [{ ...ok, audio_ref: 'office/phone/x.txt' }, 'non-audio extension'],
      [{ ...ok, mime: 'video/webm' }, 'video mime'],
      [{ ...ok, mime: 'audio/flac' }, 'unsupported mime'],
      [{ ...ok, duration_ms: -1 }, 'negative duration'],
      [{ ...ok, duration_ms: 1.5 }, 'fractional duration'],
      [{ ...ok, lang: 'not a tag!' }, 'garbage lang'],
      [{ ...ok, has_transcript: false }, 'has_transcript contradicts transcript'],
      [{ ...ok, paired_message_id: 'm-1' }, 'malformed paired_message_id'],
      [{ ...ok, transcript: '' }, 'empty-string transcript'],
      [{ ...ok, transcript: 'x'.repeat(2001) }, 'oversized transcript'],
    ];
    for (const [input, label] of bad) {
      check('T1: rejected — ' + label, V.validatePhoneCallReceived(input).length > 0,
        JSON.stringify(V.validatePhoneCallReceived(input)));
    }
  }

  /* ---------- T2: receiveCall surface rejects — nothing written ---------- */
  {
    const before = store.readEvents().length;
    const bad = [
      [{ mime: 'audio/webm' }, 'missing audio'],
      [{ audio_base64: '!!!not-base64!!!', mime: 'audio/webm' }, 'undecodable base64'],
      [{ audio_base64: Buffer.from('this is plain text, not audio at all').toString('base64'), mime: 'audio/webm' },
        'foreign container (magic sniff)'],
      [{ audio_base64: webmBytes().toString('base64'), mime: 'audio/mp4' }, 'mime/container mismatch'],
      [{ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm', transcript: '   ' }, 'blank transcript'],
      [{ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm', lang: 'nope nope' }, 'bad lang'],
      [{ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm', duration_ms: -5 }, 'bad duration'],
      [{ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm', to_role: 'bigboss' }, 'unknown to_role'],
    ];
    for (const [input, label] of bad) {
      const r = await phoneCore.receiveCall(input);
      check('T2: rejected — ' + label, r && r.ok === false && Array.isArray(r.reasons) && r.reasons.length > 0,
        JSON.stringify(r));
    }
    const big = Buffer.alloc(phoneCore.MAX_AUDIO_BYTES + 1, 0x42);
    const rBig = await phoneCore.receiveCall({
      audio_base64: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), big.subarray(4)]).toString('base64'),
      mime: 'audio/webm',
    });
    check('T2: rejected — decoded audio above the D5 cap (audio_too_large)',
      rBig && rBig.ok === false && rBig.error === 'audio_too_large', JSON.stringify(rBig).slice(0, 160));
    check('T2: rejected inputs appended NOTHING', store.readEvents().length === before,
      String(store.readEvents().length - before));
    check('T2: rejected inputs wrote NO audio files',
      !fs.existsSync(path.join(phoneCore.phoneDir())) ||
      fs.readdirSync(phoneCore.phoneDir()).length === 0,
      JSON.stringify(fs.existsSync(phoneCore.phoneDir()) ? fs.readdirSync(phoneCore.phoneDir()) : []));
  }

  /* ---------- T3: happy path — files + sidecar + PAIRED events ---------- */
  let r1 = null;
  {
    r1 = await phoneCore.receiveCall({
      audio_base64: webmBytes().toString('base64'),
      mime: 'audio/webm',
      transcript: 'سلام، وضعیت پروژه را بگو',
      lang: 'fa-IR',
      duration_ms: 2500,
      ip: '127.0.0.1',
    });
    check('T3: receiveCall ok', r1 && r1.ok === true, JSON.stringify(r1));
    check('T3: lock-allocated ids ph-0001 / m-0001',
      r1.call_id === 'ph-0001' && r1.message_id === 'm-0001',
      JSON.stringify([r1.call_id, r1.message_id]));
    check('T3: response contract {event_id, audio_ref, audio_url, has_transcript}',
      typeof r1.event_id === 'string' &&
      /^office\/phone\/[A-Za-z0-9][A-Za-z0-9_-]*\.webm$/.test(r1.audio_ref) &&
      r1.audio_url === '/api/audio/' + String(r1.audio_ref).split('/').pop() &&
      r1.has_transcript === true, JSON.stringify(r1));
    /* audio_ref is WORKSPACE-relative ("office/phone/<file>") — resolve from
       the workspace root, NOT from OFFICE_DIR (which already ends in office). */
    const audioPath = path.join(store.WORKSPACE, r1.audio_ref.replace(/\//g, path.sep));
    const sidePath = audioPath.replace(/\.webm$/i, '.json');
    check('T3: audio file exists under office/phone/', fs.existsSync(audioPath), audioPath);
    check('T3: sidecar json exists next to it', fs.existsSync(sidePath), sidePath);
    const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
    check('T3: sidecar contract {call_id, ts, mime, duration_ms, lang, transcript, has_transcript, ip, audio_ref, size_bytes, source}',
      ['call_id', 'ts', 'mime', 'duration_ms', 'lang', 'transcript', 'has_transcript', 'ip', 'audio_ref', 'size_bytes', 'source']
        .every((k) => k in side) && side.call_id === 'ph-0001' && side.source === 'web' &&
        side.has_transcript === true && side.ip === '127.0.0.1', JSON.stringify(side));
    const evs = store.readEvents();
    const call = evs.find((e) => e.action === 'phone_call_received');
    const msg = evs.find((e) => e.action === 'message_posted' && e.channel === 'phone');
    check('T3: phone_call_received appended with actor user', !!call && call.actor === 'user');
    check('T3: call fields exact (§2)',
      call.call_id === 'ph-0001' && call.transcript === 'سلام، وضعیت پروژه را بگو' &&
      call.audio_ref === r1.audio_ref && call.mime === 'audio/webm' && call.duration_ms === 2500 &&
      call.lang === 'fa-IR' && call.has_transcript === true && call.paired_message_id === 'm-0001',
      JSON.stringify(call));
    check('T3: PAIRED message_posted {to_role:"ceo", text:<transcript>, channel:"phone"} (§6.3)',
      !!msg && msg.to_role === 'ceo' && msg.text === 'سلام، وضعیت پروژه را بگو' &&
      msg.channel === 'phone' && msg.message_id === call.paired_message_id, JSON.stringify(msg));
  }

  /* ---------- T4: no-transcript honesty ---------- */
  {
    const r = await phoneCore.receiveCall({
      audio_base64: webmBytes().toString('base64'),
      mime: 'audio/webm',
      transcript: null,
      duration_ms: 900,
    });
    check('T4: audio-only call accepted', r && r.ok === true && r.has_transcript === false, JSON.stringify(r));
    const evs = store.readEvents();
    const call = evs.filter((e) => e.action === 'phone_call_received').pop();
    const msg = evs.find((e) => e.action === 'message_posted' && e.message_id === call.paired_message_id);
    check('T4: transcript stays null + has_transcript false (never fabricated)',
      call.transcript === null && call.has_transcript === false, JSON.stringify(call));
    check('T4: paired text is "[voice message - no transcript]" VERBATIM (§6.3)',
      msg.text === phoneCore.NO_TRANSCRIPT_TEXT, JSON.stringify(msg.text));
  }

  /* ---------- T5: collision suffixes — never overwrite ---------- */
  {
    const dir = phoneCore.phoneDir();
    fs.mkdirSync(dir, { recursive: true });
    const n0 = phoneCore.allocateAudioName(dir, '20260825-181500', 'webm', false);
    fs.writeFileSync(path.join(dir, n0), 'x');
    const n1 = phoneCore.allocateAudioName(dir, '20260825-181500', 'webm', false);
    fs.writeFileSync(path.join(dir, n1), 'y');
    const n2 = phoneCore.allocateAudioName(dir, '20260825-181500', 'webm', false);
    check('T5: stamp → stamp-1 → stamp-2 suffixes', n0.endsWith('.webm') &&
      n1 === n0.replace(/\.webm$/, '-1.webm') && n2 === n0.replace(/\.webm$/, '-2.webm'),
      JSON.stringify([n0, n1, n2]));
    check('T5: earlier files never overwritten',
      fs.readFileSync(path.join(dir, n0), 'utf8') === 'x' &&
      fs.readFileSync(path.join(dir, n1), 'utf8') === 'y');
    const a = await phoneCore.receiveCall({ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm' });
    const b = await phoneCore.receiveCall({ audio_base64: webmBytes().toString('base64'), mime: 'audio/webm' });
    check('T5: back-to-back real calls both ok with DISTINCT files',
      a.ok && b.ok && a.audio_ref !== b.audio_ref, JSON.stringify([a.audio_ref, b.audio_ref]));
    check('T5: sniffContainer accepts webm/mp4/ogg magic only',
      phoneCore.sniffContainer(webmBytes()) === 'webm' &&
      phoneCore.sniffContainer(Buffer.concat([Buffer.from('ABCD'), Buffer.from('ftyp'), Buffer.alloc(16)])) === 'mp4' &&
      phoneCore.sniffContainer(Buffer.from('OggS' + 'x'.repeat(20))) === 'ogg' &&
      phoneCore.sniffContainer(Buffer.from('RIFF')) === null);
  }

  /* ---------- T6: projection + honest answer join ---------- */
  {
    const proj = phoneCore.projectPhone(store.readEvents(), {});
    check('T6: recent newest-first (ph-0004 … ph-0001)',
      proj.recent.length === 4 && proj.recent[0].call_id === 'ph-0004' &&
      proj.recent[3].call_id === 'ph-0001', JSON.stringify(proj.recent.map((c) => c.call_id)));
    check('T6: playback URL derived from audio_ref',
      proj.recent.every((c) => c.audio_url === '/api/audio/' + String(c.audio_ref).split('/').pop()));
    check('T6: unanswered calls are honestly unanswered',
      proj.recent.every((c) => c.answered === false));
    const evs = store.readEvents();
    const msgEvt = evs.find((e) => e.action === 'message_posted' && e.message_id === 'm-0001');
    const rep = await inboxCore.replyMessage({ reply_to: msgEvt.event_id, text: 'پاسخ مدیر', as_role: 'ceo' });
    check('T6: REAL ceo reply accepted', rep.ok === true, JSON.stringify(rep));
    const proj2 = phoneCore.projectPhone(store.readEvents(), {});
    const answered = proj2.recent.find((c) => c.call_id === 'ph-0001');
    check('T6: answer joined onto the call (answered_by ceo)',
      answered && answered.answered === true && answered.answered_by === 'ceo' && !!answered.answered_ts,
      JSON.stringify(answered));
    check('T6: others stay «در انتظار نشست» (answered:false)',
      proj2.recent.filter((c) => c.call_id !== 'ph-0001').every((c) => c.answered === false));
  }

  /* ---------- T7: CEO delivery via inbox projections ---------- */
  {
    const pend = inboxCore.projectInbox(store.readEvents(), { role: 'ceo' });
    const withAudio = pend.pending.filter((m) => m.channel === 'phone' && m.audio);
    check('T7: pending phone items carry audio descriptor {call_id, audio_ref, audio_url, has_transcript, transcript}',
      withAudio.length === 3 && withAudio.every((m) =>
        /^ph-\d{4}$/.test(m.audio.call_id) && m.audio.audio_ref.startsWith('office/phone/') &&
        m.audio.audio_url.startsWith('/api/audio/') && typeof m.audio.has_transcript === 'boolean'),
      JSON.stringify(withAudio.map((m) => m.audio)));
    const ans = inboxCore.projectInbox(store.readEvents(), { role: 'ceo', include_answered: true });
    check('T7: answered phone thread keeps its audio in answered_recent',
      ans.answered_recent.length === 1 && ans.answered_recent[0].audio &&
      ans.answered_recent[0].audio.call_id === 'ph-0001' && ans.answered_recent[0].actor === 'ceo',
      JSON.stringify(ans.answered_recent));
    const payload = compose.build({});
    check('T7: compose §1.4 phone section mirrors the projection',
      payload.phone.recent.length === 4 && payload.phone.recent[0].call_id === 'ph-0004');
  }

  /* ---------- T8: HTTP endpoint + playback + SSE ---------- */
  {
    const { createSseHub } = require('../src/live/sse');
    const { startWatcher } = require('../src/live/watcher');
    const { createHttpApi } = require('../src/live/http-api');
    const sse = createSseHub();
    const api = createHttpApi({
      sse,
      port: 0,
      ledgerStats: () => ({ events: store.readEvents().length, seq: store.readEvents().length, stamp: store.ledgerStamp() }),
      postMessage: (args) => inboxCore.postMessage(args),
      inboxProject: (opts) => inboxCore.projectInbox(store.readEvents(), opts),
      postPhoneCall: (args) => phoneCore.receiveCall(args),           // production wiring
      phoneAudioDir: phoneCore.phoneDir(),                            // production wiring
      staticRoots: [path.join(WS, 'office')],
      rateLimitMax: 1000, // dedicated limiter coverage lives in live-server.js C5
    });
    const server = http.createServer(api.handler);
    const port = await listen(server, 0);
    const watcher = startWatcher({ port, onRefresh: (p) => sse.broadcast(p) });
    await watcher.init();
    watcher.start();

    const client = await sseConnect(port);
    await nextPayloadFrame(client, 5000, 'initial snapshot');

    const goodBody = JSON.stringify({
      audio_base64: webmBytes().toString('base64'),
      mime: 'audio/webm',
      transcript: 'تماس از مرورگر',
      lang: 'fa-IR',
      duration_ms: 1400,
    });
    const posted = await request(port, '/api/phone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: goodBody,
    });
    check('T8: POST /api/phone → 200 {ok, call_id, event_id, message_id, audio_ref, audio_url}',
      posted.status === 200 && posted.json.ok === true && posted.json.call_id === 'ph-0005' &&
      typeof posted.json.event_id === 'string' && typeof posted.json.audio_url === 'string',
      JSON.stringify(posted.json));

    const ev = await nextPayloadFrame(client, 10000, 'broadcast after phone post');
    check('T8: SSE broadcast carries phone_call_received in recent_events',
      ev.json.recent_events.some((e) => e.action === 'phone_call_received'));
    check('T8: SSE broadcast carries the refreshed phone.recent window',
      ev.json.phone && ev.json.phone.recent.some((c) => c.call_id === 'ph-0005'),
      JSON.stringify((ev.json.phone || {}).recent || []).slice(0, 200));

    /* playback: served bytes are EXACTLY the stored bytes */
    const storedPath = path.join(store.OFFICE_DIR, 'phone',
      String(posted.json.audio_ref).split('/').pop());
    const played = await request(port, posted.json.audio_url);
    check('T8: GET /api/audio/<file> → 200 audio/webm',
      played.status === 200 && /audio\/webm/.test(played.headers['content-type'] || ''),
      `${played.status} ${played.headers['content-type']}`);
    check('T8: served bytes are byte-for-byte the stored recording',
      played.buf.equals(fs.readFileSync(storedPath)));

    const rej = [
      ['POST /api/phone malformed JSON → 400 invalid_json',
        await request(port, '/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' }),
        (r) => r.status === 400 && r.json && r.json.error === 'invalid_json'],
      ['POST /api/phone foreign container → 415 unsupported_audio',
        await request(port, '/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_base64: Buffer.from('plain text not audio').toString('base64'), mime: 'audio/webm' }) }),
        (r) => r.status === 415 && r.json && r.json.error === 'unsupported_audio'],
      ['POST /api/phone oversized audio → 413',
        await request(port, '/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_base64: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
            Buffer.alloc(phoneCore.MAX_AUDIO_BYTES + 1)]).toString('base64'), mime: 'audio/webm' }) }),
        (r) => r.status === 413],
      ['POST /api/phone bad mime → 400',
        await request(port, '/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_base64: webmBytes().toString('base64'), mime: 'audio/flac' }) }),
        (r) => r.status === 400],
    ];
    for (const [label, r, cond] of rej) check('T8: ' + label, cond(r), JSON.stringify(r.json));

    const trav = await request(port, '/api/audio/..%2F..%2FAGENTS.md');
    check('T8: encoded traversal via /api/audio refused (403/404)',
      trav.status === 403 || trav.status === 404, String(trav.status));
    const sidecarTry = await request(port, '/api/audio/' +
      String(posted.json.audio_ref).split('/').pop().replace(/\.webm$/i, '.json'));
    check('T8: sidecar json NOT served as audio (server-generated audio names only)',
      sidecarTry.status === 404, String(sidecarTry.status));
    const missing = await request(port, '/api/audio/20990101-000000.webm');
    check('T8: missing audio → 404', missing.status === 404);

    client.res.destroy();
    watcher.stop();
    server.close();
    await delay(150);
  }

  /* ---------- T9: CLI intake (workspace root, §6.4) — identical shape ---------- */
  {
    const tmpAudio = path.join(os.tmpdir(), `vcnp-cli-note-${Date.now()}.webm`);
    fs.writeFileSync(tmpAudio, webmBytes());
    const cli = await runCli(['--audio', tmpAudio, '--transcript', 'یادداشت تلفنی از خط فرمان']);
    check('T9: CLI audio mode exits 0 with ok payload',
      cli.code === 0 && cli.json && cli.json.ok === true, JSON.stringify({ code: cli.code, err: cli.err }));
    check('T9: CLI call allocated ph-0006 (same lock-allocated sequence)',
      cli.json && cli.json.call_id === 'ph-0006', JSON.stringify(cli.json));

    const evs = store.readEvents();
    const webCall = evs.find((e) => e.action === 'phone_call_received' && e.call_id === 'ph-0005');
    const cliCall = evs.find((e) => e.action === 'phone_call_received' && e.call_id === 'ph-0006');
    check('T9: CLI event shape IDENTICAL to the web path (same key set)',
      !!cliCall && Object.keys(cliCall).sort().join(',') === Object.keys(webCall).sort().join(','),
      JSON.stringify([Object.keys(cliCall || {}).sort(), Object.keys(webCall).sort()]));
    const cliMsg = evs.find((e) => e.action === 'message_posted' && e.message_id === cliCall.paired_message_id);
    check('T9: CLI paired message identical shape + channel phone',
      cliMsg.channel === 'phone' && cliMsg.to_role === 'ceo' &&
      Object.keys(cliMsg).sort().join(',') ===
      Object.keys(evs.find((e) => e.action === 'message_posted' && e.channel === 'phone')).sort().join(','),
      JSON.stringify(cliMsg));
    const side = JSON.parse(fs.readFileSync(
      path.join(store.OFFICE_DIR, 'phone', String(cliCall.audio_ref).split('/').pop().replace(/\.webm$/i, '.json')), 'utf8'));
    check('T9: CLI sidecar marks source "cli" and ip "cli"',
      side.source === 'cli' && side.ip === 'cli', JSON.stringify(side));

    const cliText = await runCli(['--text', 'پیام متنی از خط فرمان']);
    check('T9: CLI text mode exits 0 (channel cli)',
      cliText.code === 0 && cliText.json && cliText.json.ok === true, JSON.stringify(cliText));
    const txtEv = store.readEvents().find((e) => e.action === 'message_posted' && e.channel === 'cli');
    check('T9: CLI text mode appended message_posted{channel:"cli"} (plan §2)',
      !!txtEv && txtEv.text === 'پیام متنی از خط فرمان', JSON.stringify(txtEv));

    const cliBad = await runCli(['--audio', path.join(os.tmpdir(), 'vcnp-definitely-missing.webm')]);
    check('T9: CLI missing audio file exits 1 honestly', cliBad.code === 1);

    try { fs.unlinkSync(tmpAudio); } catch (_) { /* best effort */ }
  }

  console.log(`\nphone: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
