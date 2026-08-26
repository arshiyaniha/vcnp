'use strict';

/*
 * live-server.test — Phase 2 suite (live-office plan §1.2-§1.4, §4.1b, §4.2).
 *
 * Run: node test/live-server.js   (also wired into `npm test`)
 *
 * Covers:
 *   C1  compose.build() payload shape vs plan §1.4 + window.VCNP_DATA conventions
 *   C2  GET /api/data identical to regenerated dashboard-data.js (modulo server.live)
 *       and stable across calls (modulo volatile timestamps)
 *   C3  SSE: headers, retry hint, initial snapshot, broadcast after a
 *       SECOND-PROCESS ledger append (fixtures/live-probe.js)
 *   C4  watcher dedupe: exactly ONE mirror regen per real append (post-append
 *       hook does it; watcher skips via .mirrors-stamp), duplicates and
 *       unrelated office/ noise trigger nothing
 *   C5  Phase 3 endpoints ACTIVE: POST /api/message validation + append,
 *       GET /api/inbox projection, /api/phone still 501; malformed JSON → 400;
 *       oversized body → 413; rate limit → 429
 *   C9  chat loop e2e: POST → ledger → SSE payload carries the thread →
 *       session-style reply joins the answer; second reply rejected
 *   C6  GET /healthz: ok + uptime + ledger stats off disk
 *   C7  static serving containment: / serves office/dashboard.html,
 *       encoded traversal → 403, missing → 404
 *   C8  real entry process: boots on an EPHEMERAL port (never 7788 in tests),
 *       stdout stays silent, /healthz answers, cross-process append reaches
 *       SSE clients, exits on demand; busy port → non-zero exit + readable
 *       reason; invalid port → exit 2
 *
 * Zero npm dependencies — Node.js >= 20 stdlib only. Servers in tests always
 * bind port 0 (ephemeral); the OS picks the port.
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = path.resolve(__dirname, '..');
const ENTRY = path.join(PKG, 'src', 'live-server.js');
const PROBE = path.join(__dirname, 'fixtures', 'live-probe.js');

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
  process.stderr.write('live-server.test: GLOBAL TIMEOUT after 180s\n');
  process.exit(1);
}, 180000).unref();

/* ---------------- helpers ---------------- */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpWorkspace(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `vcnp-live-${tag}-`));
  fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'office', 'events.log.jsonl'), '');
  return ws;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
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

/** Tiny HTTP client returning { status, headers, body, json }. */
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
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) { /* non-JSON body */ }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Minimal SSE client over raw http (Node 20 has no global EventSource).
 * Frames split on \n\n; fields id/event/retry/data; data parsed as JSON.
 */
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
              if (!m) continue; // comment (": ping") or garbage
              if (m[1] === 'data') frame.data = frame.data ? frame.data + '\n' + m[2] : m[2];
              else frame[m[1]] = m[2];
            }
            if (frame.data !== undefined) {
              try {
                frame.json = JSON.parse(frame.data);
              } catch (_) { /* keep raw */ }
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
    if (client.frames.length) {
      resolve(client.frames.shift());
      return;
    }
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

/** Spawn fixtures/live-probe.js append-once as a SECOND PROCESS. */
function runProbe(ws, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [PROBE, 'append-once', ws, ...args], {
      cwd: PKG,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: ws },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => {
      if (code !== 0) reject(new Error('probe failed: ' + err));
      else resolve(JSON.parse(out.trim().split('\n').pop()));
    });
    c.on('error', reject);
  });
}

function waitForRegex(getText, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const m = re.exec(getText());
      if (m) return resolve(m);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for /' + re.source + '/'));
      setTimeout(poll, 100);
    })();
  });
}

function exited(child, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
      resolve({ code: null, signal: 'timeout' });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

/* ================= main ================= */

async function main() {
  /* ---------- GROUP A: in-process modules against temp workspace A ---------- */
  const wsA = tmpWorkspace('a');
  process.env.VCNP_OFFICE_WORKSPACE = wsA; // MUST precede src requires

  const store = require('../src/store');
  const inboxCore = require('../src/live/inbox-core');
  const reportMod = require('../src/tools/report');
  const mirrors = require('../src/hooks/mirrors');
  const compose = require('../src/live/compose');
  const { createSseHub } = require('../src/live/sse');
  const { startWatcher } = require('../src/live/watcher');
  const { createHttpApi } = require('../src/live/http-api');

  // Seed REAL activity through the domain API (no synthetic payloads ever).
  await store.bootstrap('Live Test Project', 'verify phase 2');
  await store.taskCreate({
    title: 'seed task', assignee_role: 'executor',
    acceptance_criteria: ['x'], budget_tokens: 1000, task_class: 'C1',
  });
  await store.appendEvent({ actor: 'qa', action: 'qa_review_passed', task_id: 'T-001' });

  /* ---- C1: compose payload shape ---- */
  {
    const p = compose.build({ port: 7788 });
    const expected = ['schema_version', 'generated_ts', 'state', 'live', 'generated_at',
      'recent_events', 'chat', 'work', 'meetings', 'phone', 'server'];
    const keys = Object.keys(p);
    check('C1: exact top-level field set (§1.4 + VCNP_DATA conventions)',
      keys.length === expected.length && expected.every((k) => keys.includes(k)), keys.join(','));
    check('C1: schema_version 1.0', p.schema_version === '1.0');
    check('C1: generated_at/generated_ts are ISO',
      !Number.isNaN(Date.parse(p.generated_at)) && !Number.isNaN(Date.parse(p.generated_ts)));
    check('C1: state shape project/tasks/events_count',
      !!p.state.project && Array.isArray(p.state.tasks) && typeof p.state.events_count === 'number');
    check('C1: state.events_count matches ledger (3 events)', p.state.events_count === 3);
    check('C1: live.roles covers all 9 roles', Array.isArray(p.live.roles) && p.live.roles.length === 9);
    check('C1: role signal fields (role/active_role/last_event_time/mood/energy_hint)',
      p.live.roles.every((r) => typeof r.role === 'string' && typeof r.active_role === 'boolean' &&
        Object.prototype.hasOwnProperty.call(r, 'last_event_time') &&
        typeof r.mood === 'string' && typeof r.energy_hint === 'number'));
    check('C1: qa mood "working" after qa_review_passed (Phase-1 fix intact)',
      (p.live.roles.find((r) => r.role === 'qa') || {}).mood === 'working');
    check('C1: recent_events items {ts,actor,action,task_id}',
      p.recent_events.length === 3 && p.recent_events.every((e) =>
        'ts' in e && 'actor' in e && 'action' in e && 'task_id' in e));
    check('C1: recent_events tail is the newest event',
      p.recent_events[p.recent_events.length - 1].action === 'qa_review_passed');
    check('C1: chat = honest empty queue',
      Array.isArray(p.chat.messages) && p.chat.messages.length === 0 &&
      p.chat.inbox.total_pending === 0 && deepEqual(p.chat.inbox.pending_by_role, {}));
    check('C1: chat.session_active honest hint shape (by_role for all 9 roles)',
      p.chat.session_active && p.chat.session_active.by_role &&
      Object.keys(p.chat.session_active.by_role).length === 9 &&
      Object.values(p.chat.session_active.by_role).every((v) => typeof v === 'boolean'));
    check('C1: meetings/phone empty shapes',
      p.meetings.active === null && Array.isArray(p.meetings.recent) && p.meetings.recent.length === 0 &&
      Array.isArray(p.phone.recent) && p.phone.recent.length === 0);
    check('C1: work section shape (§7.1 desk contract; honest silence on empty ledger)',
      p.work && typeof p.work.by_role === 'object' && Object.keys(p.work.by_role).length === 0);
    check('C1: server block {live:true, ledger_seq, port}',
      p.server.live === true && p.server.ledger_seq === 3 && p.server.port === 7788);
  }

  /* ---- boot in-process server A on an ephemeral port ---- */
  const sseA = createSseHub();
  const apiA = createHttpApi({
    sse: sseA,
    port: 0,
    ledgerStats: () => ({
      events: store.readEvents().length,
      seq: store.readEvents().length,
      stamp: store.ledgerStamp(),
    }),
    // Phase 3 wiring — identical to src/live-server.js production deps:
    postMessage: (args) => inboxCore.postMessage(args),
    inboxProject: (opts) => inboxCore.projectInbox(store.readEvents(), opts),
    staticRoots: [path.join(wsA, 'office')],
    rateLimitMax: 1000, // dedicated limiter server covers 429 below
  });
  const serverA = http.createServer(apiA.handler);
  const portA = await listen(serverA, 0);

  // Cross-process refresh wiring (plan D2b): the WATCHER is what converts
  // ledger changes into compose+broadcast; its mirror regeneration stays
  // .mirrors-stamp-deduped. Started before C3 so second-process appends push.
  const watcherA = startWatcher({ port: portA, onRefresh: (payload) => sseA.broadcast(payload) });
  await watcherA.init();
  watcherA.start();

  /* ---- C2: /api/data equals regenerated dashboard-data.js ---- */
  {
    const r = await request(portA, '/api/data');
    check('C2: /api/data 200 application/json',
      r.status === 200 && /application\/json/.test(r.headers['content-type'] || ''), r.status);
    const D = r.json;
    const dashText = fs.readFileSync(path.join(wsA, 'office', 'dashboard-data.js'), 'utf8');
    const V = JSON.parse(dashText.replace(/^window\.VCNP_DATA = /, '').replace(/;\s*$/, ''));
    check('C2: state identical to dashboard-data.js', deepEqual(D.state, V.state));
    check('C2: live.roles identical to dashboard-data.js', deepEqual(D.live.roles, V.live.roles));
    check('C2: recent_events identical to dashboard-data.js', deepEqual(D.recent_events, V.recent_events));
    check('C2: Phase-4 work/meetings identical to dashboard-data.js (file:// parity)',
      deepEqual(D.work, V.work) && deepEqual(D.meetings, V.meetings));
    check('C2: server.live true (mirror snapshot has no server block)', D.server && D.server.live === true);
    const strip = (p) => {
      const c = JSON.parse(JSON.stringify(p));
      delete c.generated_at;
      delete c.generated_ts;
      delete c.live.generated_ts;
      return c;
    };
    const r2 = await request(portA, '/api/data');
    check('C2: stable JSON across calls (modulo volatile timestamps)', deepEqual(strip(D), strip(r2.json)));
  }

  /* ---- C3: SSE snapshot + broadcast after second-process append ---- */
  {
    const client = await sseConnect(portA);
    check('C3: content-type text/event-stream',
      /text\/event-stream/.test(client.res.headers['content-type'] || ''));
    check('C3: cache-control no-cache', /no-cache/.test(client.res.headers['cache-control'] || ''));
    check('C3: connection keep-alive', /keep-alive/i.test(client.res.headers['connection'] || ''));
    const fRetry = await nextFrame(client, 5000, 'retry hint');
    check('C3: reconnect-friendly retry: hint', Number(fRetry.retry) > 0, JSON.stringify(fRetry).slice(0, 80));
    const snap = await nextPayloadFrame(client, 5000, 'initial snapshot');
    check('C3: initial snapshot payload with server.live', snap.json.server.live === true);
    check('C3: snapshot id: == ledger_seq', snap.id === String(snap.json.server.ledger_seq));
    check('C3: snapshot reflects current ledger (seq 3)', snap.json.server.ledger_seq === 3);

    const probe = await runProbe(wsA, ['executor', 'work_logged', 'T-001']); // SECOND process
    check('C3: probe appended in its own process', probe.ok === true);
    const ev = await nextPayloadFrame(client, 10000, 'broadcast after cross-process append');
    check('C3: broadcast after cross-process append (seq 4)', ev.json.server.ledger_seq === 4);
    check('C3: broadcast carries the new event', ev.json.recent_events.some((e) => e.action === 'work_logged'));
    check('C3: broadcast id increments (Last-Event-ID contract)', ev.id === '4');
    /* Phase 4: the SAME frame carries the refreshed visible-work projection */
    check('C3: broadcast carries updated work section (executor desk from real work_logged)',
      ev.json.work && ev.json.work.by_role.executor &&
      ev.json.work.by_role.executor.last_work_logged !== null &&
      ev.json.work.by_role.executor.last_work_logged.ts,
      JSON.stringify(ev.json.work || {}).slice(0, 200));
    check('C3: broadcast meetings stay honest (no meeting events ⇒ active null)',
      ev.json.meetings && ev.json.meetings.active === null);
    client.res.destroy();
    await delay(200);
  }

  /* ---- C4: watcher dedupe — no double regeneration ---- */
  {
    const origGenerate = reportMod.generate;
    let regenCount = 0;
    reportMod.generate = function (...args) {
      regenCount += 1;
      return origGenerate.apply(this, args);
    };
    try {
      await mirrors.syncMirrors({ force: true }); // deterministic fresh baseline
      regenCount = 0;
      await watcherA.flush(); // forced pass with unchanged stamp ⇒ pure no-op
      await delay(300);
      check('C4: no-op trigger leaves fresh mirrors untouched (stamp dedupe)', regenCount === 0, String(regenCount));

      await store.taskCreate({
        title: 'watcher probe', assignee_role: 'planner',
        acceptance_criteria: ['x'], budget_tokens: 10, task_class: 'C1',
      });
      await delay(1400); // debounce 150ms + watch latency + poller slack
      check('C4: exactly ONE regen per real append (hook regenerates, watcher skips)',
        regenCount === 1, String(regenCount));

      const eventsNow = store.readEvents();
      const lastEv = eventsNow[eventsNow.length - 1];
      await store.appendEvent({ ...lastEv, event_id: lastEv.event_id }); // duplicate delivery
      await delay(900);
      check('C4: duplicate event delivery triggers nothing', regenCount === 1, String(regenCount));

      fs.writeFileSync(path.join(wsA, 'office', 'noise.tmp'), 'x'); // unrelated office/ churn
      await delay(900);
      check('C4: unrelated office/ writes are ignored', regenCount === 1, String(regenCount));
    } finally {
      reportMod.generate = origGenerate;
    }
  }

  /* ---- C5: Phase 3 endpoints ACTIVE; phone still stubbed; guards intact ---- */
  {
    let r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'ceo', text: 'سلام از تست C5' }),
    });
    check('C5: POST /api/message happy → 200 {ok,event_id,message_id:m-NNNN}',
      r.status === 200 && r.json.ok === true && typeof r.json.event_id === 'string' &&
      /^m-\d{4}$/.test(r.json.message_id || ''), JSON.stringify(r.json));
    const firstMsgId = r.json.message_id;
    r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'bigboss', text: 'hi' }),
    });
    check('C5: unknown to_role → 400 invalid_message with reasons',
      r.status === 400 && r.json.ok === false && r.json.error === 'invalid_message' &&
      Array.isArray(r.json.reasons) && r.json.reasons.some((x) => /to_role/.test(x)),
      JSON.stringify(r.json));
    r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'ceo', text: '   ' }),
    });
    check('C5: empty (whitespace) text → 400', r.status === 400 && r.json.error === 'invalid_message');
    r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'ceo', text: 'x'.repeat(2001) }),
    });
    check('C5: oversized text (2001 chars) → 400 with cap reason',
      r.status === 400 && Array.isArray(r.json.reasons) && r.json.reasons.some((x) => /2000/.test(x)));
    r = await request(portA, '/api/message', { method: 'POST', body: '{oops' });
    check('C5: malformed JSON body → 400 invalid_json', r.status === 400 && r.json.error === 'invalid_json');
    r = await request(portA, '/api/inbox?role=ceo');
    check('C5: GET /api/inbox → 200 projection listing the posted message pending',
      r.status === 200 && r.json.ok === true && Array.isArray(r.json.pending) &&
      r.json.pending.some((m) => m.message_id === firstMsgId && m.to_role === 'ceo'), r.status);
    check('C5: /api/inbox totals consistent (total_pending == pending.length)',
      typeof r.json.total_pending === 'number' && r.json.total_pending === r.json.pending.length &&
      r.json.pending_by_role.ceo >= 1);
    r = await request(portA, '/api/inbox?role=qa');
    check('C5: /api/inbox role filter keeps only that role',
      r.status === 200 && r.json.pending.every((m) => m.to_role === 'qa'));
    r = await request(portA, '/api/phone', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio_base64: 'AAAA' }),
    });
    check('C5: POST /api/phone → 501 (Phase 5)', r.status === 501 && r.json.error === 'not_implemented_yet');
    r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) }),
    });
    check('C5: oversized body → 413 payload_too_large', r.status === 413 && r.json.error === 'payload_too_large');
    r = await request(portA, '/definitely/not/here');
    check('C5: unknown path → 404 not_found', r.status === 404 && r.json.error === 'not_found');
    r = await request(portA, '/api/data', { method: 'PUT' });
    check('C5: wrong method → 405 method_not_allowed', r.status === 405);
    r = await request(portA, '/', { method: 'OPTIONS' });
    check('C5: OPTIONS preflight → 204 + CORS *',
      r.status === 204 && r.headers['access-control-allow-origin'] === '*');
  }

  /* ---- C5b: rate limiting on the writable surface (valid bodies now land) -- */
  {
    const sseMini = createSseHub();
    const apiMini = createHttpApi({
      sse: sseMini,
      port: 0,
      rateLimitMax: 2,
      rateLimitWindowMs: 60000,
      postMessage: (args) => inboxCore.postMessage(args),
      inboxProject: (opts) => inboxCore.projectInbox(store.readEvents(), opts),
    });
    const srvMini = http.createServer(apiMini.handler);
    const portM = await listen(srvMini, 0);
    const body = JSON.stringify({ to_role: 'ceo', text: 'C5b rate probe' });
    const hdr = { 'content-type': 'application/json' };
    const s1 = await request(portM, '/api/message', { method: 'POST', headers: hdr, body });
    const s2 = await request(portM, '/api/message', { method: 'POST', headers: hdr, body });
    const s3 = await request(portM, '/api/message', { method: 'POST', headers: hdr, body });
    check('C5b: sliding-window limiter → 200,200,429',
      s1.status === 200 && s2.status === 200 && s3.status === 429 && s3.json.error === 'rate_limited',
      `${s1.status},${s2.status},${s3.status}`);
    sseMini.close();
    await new Promise((res) => srvMini.close(res));
  }

  /* ---- C9: chat loop e2e — POST → ledger → SSE payload → session reply ---- */
  {
    const client = await sseConnect(portA);
    await nextPayloadFrame(client, 5000, 'C9 initial snapshot'); // drain snapshot
    const MARK = 'e2e-chat-' + Date.now();
    let r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'orchestrator', text: MARK }),
    });
    check('C9: POST /api/message accepted', r.status === 200 && r.json.ok === true, String(r.status));
    let ev = await nextPayloadFrame(client, 10000, 'C9 broadcast after POST');
    let thread = (ev.json.chat.messages || []).find((m) => m.text === MARK);
    check('C9: broadcast carries the new thread with answer:null',
      !!thread && thread.answer === null && thread.to_role === 'orchestrator' &&
      /^m-\d{4}$/.test(thread.message_id || ''), JSON.stringify(thread || {}).slice(0, 140));
    check('C9: composed inbox counts include the pending message',
      ev.json.chat.inbox.total_pending >= 1 && (ev.json.chat.inbox.pending_by_role.orchestrator || 0) >= 1);

    // Drain EXACTLY like an MCP session would — same core as inbox_reply:
    r = await request(portA, '/api/inbox?role=orchestrator');
    const pend = (r.json.pending || []).find((m) => m.text === MARK);
    check('C9: GET /api/inbox exposes the pending event_id for replying', !!pend && !!pend.event_id);
    const rep = await inboxCore.replyMessage({
      reply_to: pend.event_id, text: 'پاسخ آزمایشی C9', as_role: 'orchestrator',
    });
    check('C9: session-style reply accepted', rep.ok === true, JSON.stringify(rep));
    const rep2 = await inboxCore.replyMessage({
      reply_to: pend.event_id, text: 'تلاش دوم', as_role: 'ceo',
    });
    check('C9: SECOND reply honestly rejected (first-answer-wins)',
      rep2.ok === false && /already answered by orchestrator/.test(rep2.error || ''), JSON.stringify(rep2));

    ev = await nextPayloadFrame(client, 10000, 'C9 broadcast after reply');
    thread = (ev.json.chat.messages || []).find((m) => m.text === MARK);
    check('C9: answer joined into the thread via SSE payload',
      !!thread && !!thread.answer && thread.answer.actor === 'orchestrator' &&
      thread.answer.text === 'پاسخ آزمایشی C9', JSON.stringify((thread || {}).answer || {}));
    check('C9: pending count drops to zero after the answer',
      (ev.json.chat.inbox.pending_by_role.orchestrator || 0) === 0);

    // XSS posture: the ledger stores DATA verbatim; escaping is renderer duty.
    r = await request(portA, '/api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_role: 'ceo', text: '<img src=x onerror=alert(1)>' }),
    });
    check('C9: XSS-looking text accepted as plain data', r.status === 200 && r.json.ok === true);
    const data = await request(portA, '/api/data');
    const xssThread = (data.json.chat.messages || []).find((m) => String(m.text || '').includes('<img'));
    check('C9: /api/data chat shape intact; raw text carried verbatim (esc() renders it safe)',
      data.status === 200 && Array.isArray(data.json.chat.messages) && !!xssThread &&
      typeof data.json.chat.inbox.total_pending === 'number' &&
      !!data.json.chat.session_active && typeof data.json.chat.session_active.by_role === 'object');
    client.res.destroy();
    await delay(200);
  }

  /* ---- C6: /healthz ---- */
  {
    const r = await request(portA, '/healthz');
    const lines = fs.readFileSync(path.join(wsA, 'office', 'events.log.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).length;
    check('C6: ok true + numeric uptime_s',
      r.status === 200 && r.json.ok === true && typeof r.json.uptime_s === 'number' && r.json.uptime_s >= 0);
    check('C6: ledger stats match disk truth',
      r.json.ledger && r.json.ledger.events === lines && r.json.ledger.seq === lines && typeof r.json.ledger.stamp === 'string');
    check('C6: sse_clients reported', typeof r.json.sse_clients === 'number');
  }

  /* ---- C7: static serving + containment ---- */
  {
    fs.writeFileSync(path.join(wsA, 'office', 'dashboard.html'), '<html>VCNP-LIVE-FIXTURE-MARKER</html>');
    let r = await request(portA, '/');
    check('C7: / serves office/dashboard.html',
      r.status === 200 && r.body.includes('VCNP-LIVE-FIXTURE-MARKER'));
    r = await request(portA, '/dashboard.html');
    check('C7: direct file 200 text/html', r.status === 200 && /text\/html/.test(r.headers['content-type'] || ''));
    // NOTE: Node's WHATWG URL parser already collapses %2e%2e SEGMENTS
    // (/x/%2e%2e/y → /x/y), so the first layer of defense is free. A '..'
    // hidden INSIDE a segment (..%2f) survives parsing and must be caught by
    // the realpath-containment gate in http-api.serveStatic.
    r = await request(portA, '/..%2f..%2fAGENTS.md');
    check('C7: encoded traversal (..%2f) → 403 forbidden', r.status === 403 && r.json.error === 'forbidden', r.status);
    r = await request(portA, '/../../../../../../AGENTS.md');
    check('C7: raw dot-dot segments pre-collapsed by URL parser → contained 404',
      r.status === 404 && r.json.error === 'not_found', r.status);
    r = await request(portA, '/missing-file.html');
    check('C7: missing file → 404', r.status === 404);
  }

  watcherA.stop();
  sseA.close();
  await new Promise((res) => serverA.close(res));

  /* ---------- GROUP B: the REAL entry process ---------- */
  const wsB = tmpWorkspace('b');

  /* ---- C8a: boot on ephemeral port, stdout silence, cross-process SSE ---- */
  {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: PKG,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: wsB, VCNP_OFFICE_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    try {
      const m = await waitForRegex(() => stderrBuf, /listening on http:\/\/127\.0\.0\.1:(\d+)/, 12000);
      const portB = Number(m[1]);
      check('C8a: entry binds an ephemeral port (announced on stderr)', portB > 0, String(portB));
      check('C8a: stdout stays completely silent (protocol purity)', stdoutBuf === '', JSON.stringify(stdoutBuf.slice(0, 80)));

      const h = await request(portB, '/healthz');
      check('C8a: /healthz answers ok on the real entry', h.status === 200 && h.json.ok === true);

      const client = await sseConnect(portB);
      await nextPayloadFrame(client, 6000, 'entry snapshot');
      await runProbe(wsB, ['qa', 'work_logged']); // cross-process append
      const evB = await nextPayloadFrame(client, 10000, 'entry broadcast');
      check('C8a: cross-process append reaches SSE via entry watcher (Windows fs.watch)',
        evB.json.recent_events.some((e) => e.action === 'work_logged'));
      client.res.destroy();

      child.kill();
      const r = await exited(child, 8000);
      check('C8a: entry exits on demand (no hang)', r.signal !== 'timeout', JSON.stringify(r));
    } catch (e) {
      check('C8a: entry lifecycle', false, (e && e.message) || String(e));
      try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
    }
  }

  /* ---- C8b: busy port → non-zero exit + human-readable reason ---- */
  {
    const blocker = net.createServer();
    const busyPort = await listen(blocker, 0);
    const child = spawn(process.execPath, [ENTRY], {
      cwd: PKG,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: wsB, VCNP_OFFICE_PORT: String(busyPort) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    const r = await exited(child, 10000);
    check('C8b: bind failure exits NON-ZERO', typeof r.code === 'number' && r.code !== 0,
      JSON.stringify(r) + ' stderr=' + errBuf.slice(0, 120));
    check('C8b: human-readable busy-port diagnostic on stderr', /EADDRINUSE|busy/i.test(errBuf));
    await new Promise((res) => blocker.close(res));
  }

  /* ---- C8c: invalid port configuration → exit code 2 ---- */
  {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: PKG,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: wsB, VCNP_OFFICE_PORT: 'not-a-port' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const r = await exited(child, 8000);
    check('C8c: invalid VCNP_OFFICE_PORT → exit code 2', r.code === 2, JSON.stringify(r));
  }

  /* ---------------- summary ---------------- */
  console.log(`\nlive-server: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
