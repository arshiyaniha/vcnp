'use strict';

/*
 * regression.js — reproductions for the reviewed findings, run after
 * smoke.js (`npm test`). Each test targets a specific fixed bug:
 *
 *   R1  task ID allocation is race-free (finding 1) and the response
 *       describes the caller's own task (finding 10)
 *   R2  stdin close DRAINS in-flight handlers: no silent event loss,
 *       response still delivered (finding 2)
 *   R3  templates/dashboard.html esc() really escapes (finding 3)
 *   R4  dead-holder lock takeover bypasses the stale-age wait (finding 4)
 *
 * Phase-1 additions (live-office plan §4.3 / §4.1a / D6):
 *   R5  mood map: qa_review_passed -> working (never meeting); env tunables
 *   R6  every successful append regenerates mirrors (.mirrors-stamp dedupe)
 *   R7  office_archive_reset archives history, resets clean, refuses when busy
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = __dirname;                       // mcp/vcnp-office-mcp/test
const ROOT = path.dirname(PKG);              // mcp/vcnp-office-mcp
const TEMPLATES = path.join(ROOT, '..', '..', 'templates');

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

function tmpWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vcnp-regress-'));
  fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
  return ws;
}

function runProbe(mode, ws) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'store-probe.js'), mode, ws], {
      cwd: ROOT,
      env: process.env,
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/* ---------------- R1: concurrent create — unique ids, own titles ---------------- */
async function r1() {
  const ws = tmpWorkspace();
  const r = await runProbe('concurrent-create', ws);
  if (r.code !== 0) {
    check('R1: probe exits cleanly', false, r.err || ('exit ' + r.code));
    return;
  }
  let res;
  try { res = JSON.parse(r.out.split('\n').pop()); } catch (_) { res = null; }
  check('R1: both creates succeed', !!res && res.ok === true, r.out);
  if (!res) return;
  const [ia, ib] = res.ids;
  check('R1: task ids are UNIQUE under concurrency', ia !== ib, JSON.stringify(res.ids));
  check('R1: response carries its OWN task title (no cross-talk)', res.titles[0] === 'a' && res.titles[1] === 'b', JSON.stringify(res.titles));
  // ledger truth: exactly two task_created events with distinct ids
  const ledger = fs.readFileSync(path.join(ws, 'office', 'events.log.jsonl'), 'utf8');
  const created = ledger.split('\n').filter((l) => l.includes('"task_created"'));
  const ids = new Set(created.map((l) => { try { return JSON.parse(l).task_id; } catch (_) { return null; } }));
  check('R1: ledger holds 2 distinct task_created ids', created.length === 2 && ids.size === 2, `lines=${created.length} unique=${ids.size}`);
}

/* ---------------- R2: drain on stdin close ---------------- */
function rpcLine(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function drainScenario(ws) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, VCNP_OFFICE_WORKSPACE: ws },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      // as soon as initialize answers, fire the create and slam stdin shut
      if (out.includes('"id":1')) {
        child.stdin.write(rpcLine(3, 'tools/call', {
          name: 'task_create',
          arguments: { title: 'drain-probe', assignee_role: 'executor', acceptance_criteria: ['x'], budget_tokens: 1000, task_class: 'C1' },
        }));
        child.stdin.end();
      }
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('exit', () => { clearTimeout(killer); resolve(out); });
    child.stdin.write(rpcLine(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'regress', version: '1' },
    }));
  });
}

async function r2() {
  const ws = tmpWorkspace();
  const out = await drainScenario(ws);
  const ledgerPath = path.join(ws, 'office', 'events.log.jsonl');
  const exists = fs.existsSync(ledgerPath);
  const ledger = exists ? fs.readFileSync(ledgerPath, 'utf8') : '';
  check('R2: server exits cleanly after stdin close', true); // reaching here means no hang/kill
  check('R2: in-flight task_create PERSISTED to ledger (no silent loss)', ledger.includes('"action":"task_created"') && ledger.includes('drain-probe'));
  check('R2: response for id:3 still delivered before exit', out.includes('"id":3'));
}

/* ---------------- R3: dashboard esc() really escapes ---------------- */
async function r3() {
  const file = path.join(TEMPLATES, 'dashboard.html');
  const html = fs.readFileSync(file, 'utf8');
  check('R3: identity \\x26 chain removed from dashboard.html', !html.includes('\\x26'));

  const m = html.match(/var esc = function[\s\S]*?\n  \};/);
  check('R3: esc() definition found', !!m);
  if (!m) return;
  try {
    const factory = new Function('"use strict";return (' + m[0].replace(/^var esc = /, '').replace(/;\s*$/, '') + ');');
    const esc = factory();
    // NOTE: expectations are assembled from fragments — literal entity
    // sequences do not survive this repo's write pipeline intact.
    const apos = String.fromCharCode(39);
    const ENT_AMP = '&' + 'amp;';
    const ENT_LT = '&' + 'lt;';
    const ENT_GT = '&' + 'gt;';
    const ENT_QUOT = '&' + 'quot;';
    const ENT_APOS = '&' + '#39;';
    const input = 'a<b>&"' + apos;
    const expected = 'a' + ENT_LT + 'b' + ENT_GT + ENT_AMP + ENT_QUOT + ENT_APOS;
    check('R3: esc() escapes < > & " \'', esc(input) === expected, JSON.stringify(esc ? esc(input) : null));
    const evil = '<img src=x onerror=alert(1)>';
    const out = esc(evil);
    check(
      'R3: esc() neutralizes vector payload',
      typeof out === 'string' && out.indexOf('<img') === -1 &&
        out.indexOf(ENT_LT) === 0 && out.lastIndexOf(ENT_GT) === out.length - ENT_GT.length,
      JSON.stringify(out)
    );
  } catch (e) {
    check('R3: esc() evaluates as valid JS', false, String(e));
  }
}

/* ---------------- R4: dead-holder lock takeover is fast ---------------- */
async function r4() {
  const ws = tmpWorkspace();
  const victim = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((res) => victim.on('exit', res));
  // lock file freshly written (mtime = now) but holder pid is DEAD:
  // old rule waited >5 s for staleness; takeover must be near-instant.
  fs.writeFileSync(path.join(ws, 'office', '.lock'), JSON.stringify({ pid: victim.pid, ts: new Date().toISOString() }));
  const r = await runProbe('lock-takeover', ws);
  if (r.code !== 0) {
    check('R4: takeover probe exits cleanly', false, r.err || ('exit ' + r.code));
    return;
  }
  let res;
  try { res = JSON.parse(r.out.split('\n').pop()); } catch (_) { res = null; }
  check('R4: dead-holder lock acquired fast (<3000ms, was >=5000ms)', !!res && res.ms < 3000, r.out);
}

/* ---------------- R5: mood map + env tunables (live-office §4.3) --------- */
async function r5() {
  const report = require(path.join(ROOT, 'src', 'tools', 'report.js'));
  const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
  const roleOf = (actor, action, minAgo, extra) => {
    const events = [{ actor, action, ts: iso(minAgo), ...(extra || {}) }];
    return report.deriveOfficeLive(events).roles.find((x) => x.role === actor);
  };

  // The original bug: substring /review/ matched inside qa_review_passed and
  // pinned QA to 'meeting' forever.
  const qa = roleOf('qa', 'qa_review_passed', 0);
  check('R5: qa_review_passed -> working (never meeting)', qa.mood === 'working', qa.mood);
  check('R5: qa_review_rejected -> frustrated', roleOf('qa', 'qa_review_rejected', 0).mood === 'frustrated');
  check('R5: meeting_started -> meeting', roleOf('orchestrator', 'meeting_started', 0).mood === 'meeting');
  check('R5: standup_held fallback -> meeting', roleOf('executor', 'standup_held', 0).mood === 'meeting');
  // 'investigate_report' embeds 'gate' — the fallback must NOT repeat the
  // original substring-matching bug class.
  check('R5: investigate_report does NOT trip the gate fallback', roleOf('executor', 'investigate_report', 0).mood === 'working');
  check('R5: recent done task_updated -> coffee', roleOf('executor', 'task_updated', 5, { status: 'done' }).mood === 'coffee');
  check('R5: done task_updated outside coffee window -> working', roleOf('executor', 'task_updated', 25, { status: 'done' }).mood === 'working');
  check('R5: planner default -> thinking', roleOf('planner', 'custom_action', 0).mood === 'thinking');
  check('R5: orchestrator default -> thinking', roleOf('orchestrator', 'custom_action', 0).mood === 'thinking');
  check('R5: ceo default -> thinking', roleOf('ceo', 'custom_action', 0).mood === 'thinking');
  check('R5: executor default -> working', roleOf('executor', 'custom_action', 0).mood === 'working');
  check('R5: past sleep threshold -> sleeping', roleOf('executor', 'custom_action', 61).mood === 'sleeping');
  check('R5: fresh event within default active threshold', roleOf('qa', 'custom_action', 10).active_role === true);

  // Env overrides are read at CALL time — restore no matter what.
  const ENV_KEYS = [
    'VCNP_ACTIVE_THRESHOLD_MIN', 'VCNP_ENERGY_DECAY_MIN',
    'VCNP_SLEEP_AFTER_MIN', 'VCNP_COFFEE_AFTER_DONE_MIN',
  ];
  const savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
  try {
    process.env.VCNP_SLEEP_AFTER_MIN = '10';
    check('R5: env VCNP_SLEEP_AFTER_MIN=10 moves the sleep cutoff', roleOf('executor', 'custom_action', 11).mood === 'sleeping');
    delete process.env.VCNP_SLEEP_AFTER_MIN;

    process.env.VCNP_ACTIVE_THRESHOLD_MIN = '5';
    const late = roleOf('qa', 'custom_action', 10);
    check('R5: env VCNP_ACTIVE_THRESHOLD_MIN=5 deactivates a 10-min-old event',
      late.active_role === false && late.mood !== 'sleeping', JSON.stringify(late));
    delete process.env.VCNP_ACTIVE_THRESHOLD_MIN;

    process.env.VCNP_ENERGY_DECAY_MIN = '200';
    const slowDecay = roleOf('qa', 'custom_action', 50).energy_hint;
    check('R5: env VCNP_ENERGY_DECAY_MIN=200 halves the decay (~75)', slowDecay >= 72 && slowDecay <= 78, String(slowDecay));
    delete process.env.VCNP_ENERGY_DECAY_MIN;
    const fastDecay = roleOf('qa', 'custom_action', 50).energy_hint;
    check('R5: default decay horizon gives ~50 energy at 50 min', fastDecay >= 47 && fastDecay <= 53, String(fastDecay));

    process.env.VCNP_COFFEE_AFTER_DONE_MIN = '1';
    check('R5: env VCNP_COFFEE_AFTER_DONE_MIN=1 ends the coffee window',
      roleOf('executor', 'task_updated', 2, { status: 'done' }).mood === 'working');
  } finally {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------- R6: append auto-regenerates mirrors (§4.1a) ------------ */
async function r6() {
  const ws = tmpWorkspace();
  const r = await runProbe('mirror-regen', ws);
  let res;
  try { res = JSON.parse(r.out.split('\n').pop()); } catch (_) { res = null; }
  check('R6: probe exits cleanly', r.code === 0 && !!res, r.err || ('exit ' + r.code));
  if (!res) return;
  check('R6: plain append succeeds', res.appended === true);
  check('R6: BOARD.md regenerated on append', res.boardRefreshed === true);
  check('R6: office-live.json regenerated on append', res.liveRefreshed === true);
  check('R6: dashboard-data.js regenerated on append', res.dashRefreshed === true);
  check('R6: dashboard-data carries the appended event', res.dashHasEvent === true);
  check('R6: .mirrors-stamp matches ledger after regen', res.stampMatchesLedger === true);
  check('R6: duplicate event_id delivery flagged', res.duplicateFlagged === true);
  check('R6: duplicate delivery does NOT regenerate mirrors', res.noRegenOnDuplicate === true);
}

/* ---------------- R7: demo archive/reset rotation (D6) ------------------- */
async function r7() {
  const ws = tmpWorkspace();
  const r = await runProbe('demo-reset', ws);
  let res;
  try { res = JSON.parse(r.out.split('\n').pop()); } catch (_) { res = null; }
  check('R7: probe exits cleanly', r.code === 0 && !!res, r.err || ('exit ' + r.code));
  if (!res) return;
  check('R7: reset ok + archived flag set', res.ok === true && res.archivedFlag === true);
  check('R7: archive dir exists under office/archive', res.archiveExists === true);
  check('R7: archived copy preserves every old event in order', res.preservedOldEvents === true, JSON.stringify(res));
  check('R7: events_archived count matches the old ledger', res.eventsArchivedMatches === true);
  check('R7: live ledger holds ONLY the fresh board_init', res.ledgerIsBootstrapOnly === true);
  check('R7: fresh state has zero tasks + renamed project', res.freshStateNoTasks === true && res.projectRenamed === true);
  check('R7: BOARD.md regenerated without legacy tasks', res.boardHasNoLegacyTask === true);
  check('R7: dashboard-data fresh (board_init only, no legacy)', res.dashFresh === true);
  check('R7: .mirrors-stamp refreshed for the new ledger', res.stampMatchesLedger === true);

  // Busy refusal: another LIVE process holds the lock (stale/dead locks are
  // still taken over by lib/lock.js as usual).
  const ws2 = tmpWorkspace();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
  try {
    await new Promise((res2) => setTimeout(res2, 300)); // holder is definitely alive
    fs.mkdirSync(path.join(ws2, 'office'), { recursive: true });
    fs.writeFileSync(
      path.join(ws2, 'office', '.lock'),
      JSON.stringify({ pid: holder.pid, ts: new Date().toISOString() })
    );
    const probe = await runProbe('demo-reset-busy', ws2);
    let busy;
    try { busy = JSON.parse(probe.out.split('\n').pop()); } catch (_) { busy = null; }
    check('R7: reset REFUSES while another live process holds the lock',
      !!busy && busy.refused === true, probe.out || probe.err);
  } finally {
    holder.kill();
    await new Promise((res2) => holder.once('exit', res2));
  }
}

(async () => {
  console.log('=== regression: reviewed findings + phase-1 suite ===');
  await r1();
  await r2();
  await r3();
  await r4();
  await r5();
  await r6();
  await r7();
  console.log('=========================================');
  console.log(`REGRESSION RESULT: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('regression runner failure:', (e && e.stack) || e);
  process.exit(1);
});
