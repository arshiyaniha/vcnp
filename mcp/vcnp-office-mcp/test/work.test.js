'use strict';

/*
 * work.test — Phase 4 "visible work + real meetings" core (live-office plan
 * §2/§7/§1.4):
 *   W1  workLog / meetingStart / meetingEnd validation rejects (bad shapes,
 *       path traversal, unknown task, wrong actor) append NOTHING
 *   W2  happy paths: exact ledger event shapes; mt-NNNN lock allocation;
 *       artifact containment against the real workspace root
 *   W3  concurrency: two parallel meeting_start → exactly ONE wins (single
 *       active meeting rule); parallel work_logs all land with unique ids
 *   W4  projections: active = latest start without end; ended → recent
 *       window; latest-orphan-wins on raw double starts; desk contract
 *       (task artifacts enriched by work_logged, deduped, bounded ≤3)
 *   W5  compose payload carries work + meetings sections; dashboard-data.js
 *       mirror persists them for file:// pages
 *
 * Run: node test/work.test.js   (temp workspace — repo office/ untouched)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vcnp-work-'));
fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
fs.writeFileSync(path.join(ws, 'office', 'events.log.jsonl'), '');
process.env.VCNP_OFFICE_WORKSPACE = ws; // MUST precede src requires

const store = require('../src/store');
const V = require('../src/lib/events-validate');
const work = require('../src/live/work-core');
const compose = require('../src/live/compose');

(async () => {
  /* seed one real doing task with artifacts (board channel stays honest) */
  const tc = await store.taskCreate({
    title: 'Implement work-core',
    assignee_role: 'executor',
    acceptance_criteria: ['module exists', 'tests green'],
    budget_tokens: 5000,
    task_class: 'C2',
  });
  check('seed: task created', tc.ok && tc.task_id === 'T-001', JSON.stringify(tc));
  await store.taskUpdate(tc.task_id, {
    status: 'doing',
    progress_percent: 40,
    artifacts: ['mcp/vcnp-office-mcp/src/live/work-core.js', 'docs/notes.md'],
  });

  /* ---------- W1: validation rejects ---------- */
  const before = store.readEvents().length;
  const badWork = [
    [() => work.workLog({ action_summary: '' }), 'empty summary'],
    [() => work.workLog({ action_summary: 'x'.repeat(301) }), 'oversized summary'],
    [() => work.workLog({ action_summary: 'x', artifact_refs: '../AGENTS.md' }), 'refs not array'],
    [() => work.workLog({ action_summary: 'x', artifact_refs: ['../AGENTS.md'] }), 'traversal ref'],
    [() => work.workLog({ action_summary: 'x', artifact_refs: ['C:\\tmp\\x'] }), 'absolute ref'],
    [() => work.workLog({ action_summary: 'x', artifact_refs: ['/etc/passwd'] }), 'root ref'],
    [() => work.workLog({ action_summary: 'x', code_ref: { path: 'a.js', lines: [9, 3] } }), 'inverted lines'],
    [() => work.workLog({ action_summary: 'x', task_id: 'TASK-9' }), 'bad task id'],
    [() => work.workLog({ action_summary: 'x', task_id: 'T-999' }), 'unknown task'],
    [() => work.workLog({ action_summary: 'x', as_role: 'wizard' }), 'bogus as_role'],
  ];
  for (const [fn, label] of badWork) {
    const r = await fn.call(work);
    check('W1: work_log rejected — ' + label,
      r && r.ok === false && Array.isArray(r.reasons) && r.reasons.length > 0, JSON.stringify(r));
  }
  const badStart = [
    [() => work.meetingStart({ topic: 't', participants: ['qa', 'ceo'] }), 'missing reason'],
    [() => work.meetingStart({ topic: 't', participants: ['qa', 'ceo'], reason: 'party' }), 'bad reason'],
    [() => work.meetingStart({ topic: 't', participants: ['qa'], reason: 'standup' }), 'one participant'],
    [() => work.meetingStart({ topic: 't', participants: ['qa', 'ghost'], reason: 'standup' }), 'unknown role'],
    [() => work.meetingStart({ topic: 't', participants: ['qa', 'qa'], reason: 'standup' }), 'duplicate role'],
    [() => work.meetingStart({ participants: ['qa', 'ceo'], reason: 'standup' }), 'missing topic'],
    [() => work.meetingStart({ topic: 'x'.repeat(201), participants: ['qa', 'ceo'], reason: 'standup' }), 'oversized topic'],
    [() => work.meetingStart({ topic: 't', participants: ['qa', 'ceo'], reason: 'standup', task_id: 'T-777' }), 'unknown agenda task'],
  ];
  for (const [fn, label] of badStart) {
    const r = await fn.call(work);
    check('W1: meeting_start rejected — ' + label, r && r.ok === false, JSON.stringify(r));
  }
  const badEnd = [
    [() => work.meetingEnd({}), 'no active meeting'],
    [() => work.meetingEnd({ meeting_id: 'mt-0042' }), 'unknown meeting id'],
    [() => work.meetingEnd({ meeting_id: 'nope' }), 'malformed id'],
    [() => work.meetingEnd({ outcome_summary: 'x'.repeat(301) }), 'oversized summary'],
  ];
  for (const [fn, label] of badEnd) {
    const r = await fn.call(work);
    check('W1: meeting_end rejected — ' + label, r && r.ok === false, JSON.stringify(r));
  }
  check('W1: rejected inputs appended NOTHING', store.readEvents().length === before,
    String(store.readEvents().length - before));

  /* ---------- W2: happy paths ---------- */
  const wl = await work.workLog({
    action_summary: 'implemented work-core projections',
    artifact_refs: ['mcp/vcnp-office-mcp/src/live/work-core.js', 'docs\\sub\\note.md'],
    task_id: tc.task_id,
    as_role: 'executor',
  });
  check('W2: work_log ok', wl.ok && wl.actor === 'executor' && wl.artifact_count === 2, JSON.stringify(wl));
  const wlEvt = store.readEvents().find((e) => e.action === 'work_logged');
  check('W2: ledger holds exact work_logged shape (actor/task_id/action_summary/artifact_refs)',
    wlEvt && wlEvt.task_id === 'T-001' && Array.isArray(wlEvt.artifact_refs) &&
    wlEvt.artifact_refs.length === 2 && typeof wlEvt.action_summary === 'string');

  const ms = await work.meetingStart({
    topic: 'T-001 qa verdict',
    participants: ['qa', 'executor', 'orchestrator'],
    reason: 'qa_gate',
    task_id: tc.task_id,
    as_role: 'qa',
  });
  check('W2: meeting_start ok with lock-allocated mt-0001',
    ms.ok && ms.meeting_id === 'mt-0001' && ms.actor === 'qa', JSON.stringify(ms));
  const msEvt = store.readEvents().find((e) => e.action === 'meeting_started');
  check('W2: ledger holds exact meeting_started shape (§2 fields)',
    msEvt && msEvt.meeting_id === 'mt-0001' && msEvt.reason === 'qa_gate' &&
    Array.isArray(msEvt.participants) && msEvt.participants.length === 3 &&
    msEvt.topic === 'T-001 qa verdict' && msEvt.task_id === 'T-001');

  {
    const proj = work.projectMeetings(store.readEvents());
    check('W2: projection sees THE active meeting',
      proj.active && proj.active.meeting_id === 'mt-0001' &&
      proj.active.agenda_task_ids.includes('T-001') && proj.recent.length === 0);
    const payload = compose.build({});
    check('W2: compose meetings.active carries topic/participants/agenda',
      payload.meetings.active && payload.meetings.active.topic === 'T-001 qa verdict' &&
      payload.meetings.active.participants.includes('executor') &&
      payload.meetings.active.agenda_task_ids[0] === 'T-001');
    check('W2: compose work.by_role gives executor a REAL desk card',
      payload.work.by_role.executor && payload.work.by_role.executor.task &&
      payload.work.by_role.executor.task.task_id === 'T-001' &&
      payload.work.by_role.executor.artifacts.includes('mcp/vcnp-office-mcp/src/live/work-core.js'));
    check('W2: roles without tasks/work get NO fabricated card',
      payload.work.by_role.ceo === undefined && payload.work.by_role.librarian === undefined);
  }

  /* ---------- W3: concurrency ---------- */
  {
    /* close W2's meeting FIRST (by its starter) — the race below must begin
       from an idle office so exactly ONE of the two parallel starts can win
       under the single-active rule (plan §7.2); the loser must name the
       WINNER's id in its honest rejection. */
    const pre = await work.meetingEnd({ outcome_summary: 'w2 gate closed', as_role: 'qa' });
    check('W3: starter closes mt-0001 before the race', pre.ok && pre.meeting_id === 'mt-0001', JSON.stringify(pre));
    const pair = await Promise.all([
      work.meetingStart({ topic: 'second?', participants: ['ceo', 'planner'], reason: 'explicit', as_role: 'ceo' }),
      work.meetingStart({ topic: 'third?', participants: ['devops', 'rc'], reason: 'explicit', as_role: 'ceo' }),
    ]);
    const winners = pair.filter((r) => r.ok);
    check('W3: two parallel meeting_start → exactly ONE wins (single-active rule)',
      winners.length === 1 && winners[0].meeting_id === 'mt-0002' &&
      pair.some((r) => !r.ok && /already active \(mt-0002\)/.test(r.error || '')),
      JSON.stringify(pair));
    await work.meetingEnd({ outcome_summary: 'cleanup', as_role: 'ceo' }); // winner was started by ceo
    const five = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      work.workLog({ action_summary: 'parallel unit ' + i, as_role: 'librarian' })));
    check('W3: 5 parallel work_logs ALL succeed', five.every((r) => r.ok), JSON.stringify(five.map((r) => r.error)));
    check('W3: parallel work_logged event_ids UNIQUE',
      new Set(five.map((r) => r.event_id)).size === 5);
  }

  /* ---------- W4: lifecycle + desk contract ---------- */
  await work.meetingStart({
    topic: 'T-001 qa verdict',
    participants: ['qa', 'executor', 'orchestrator'],
    reason: 'qa_gate',
    task_id: tc.task_id,
    as_role: 'qa',
  });
  const me = await work.meetingEnd({ outcome_summary: 'verdict: pass', as_role: 'qa' });
  check('W4: starter ends the meeting ok', me.ok && me.meeting_id === 'mt-0003' && me.duration_ms >= 0, JSON.stringify(me));
  {
    const proj = work.projectMeetings(store.readEvents());
    check('W4: ended meeting leaves active set EMPTY and lands in recent window',
      proj.active === null && proj.recent.length === 3 &&
      proj.recent[0].meeting_id === 'mt-0003' &&
      proj.recent[0].ended_ts && proj.recent[0].outcome_summary === 'verdict: pass');
    const payload = compose.build({});
    check('W4: compose mirrors ended state (active null, recent kept)',
      payload.meetings.active === null && payload.meetings.recent.length === 3);
  }
  {
    const r = await work.meetingEnd({});
    check('W4: ending when nothing is active rejected honestly', r.ok === false && /no active meeting/.test(r.error || ''));
  }

  {
    /* raw double-start fixture (bypassing the tool): latest orphan wins */
    await store.appendEventLocked({ actor: 'planner', action: 'meeting_started', meeting_id: 'mt-0004', reason: 'critical_task', participants: ['orchestrator', 'planner'], topic: 'huddle' }, {});
    await store.appendEventLocked({ actor: 'ceo', action: 'meeting_started', meeting_id: 'mt-0005', reason: 'standup', participants: ['ceo', 'security'], topic: 'standup' }, {});
    const proj = work.projectMeetings(store.readEvents());
    check('W4: latest orphan start becomes THE active meeting',
      proj.active && proj.active.meeting_id === 'mt-0005' && proj.active.topic === 'standup');
    const again = await work.meetingStart({ topic: 'x', participants: ['ceo', 'rc'], reason: 'explicit' });
    check('W4: tool refuses to start while an orphan meeting is open',
      again.ok === false && /already active \(mt-0005\)/.test(again.error || ''), JSON.stringify(again));
    const foreign = await work.meetingEnd({ as_role: 'qa' });
    check('W4: NON-starter cannot end the meeting (same-actor rule)',
      foreign.ok === false && /only ceo/.test(foreign.error || ''), JSON.stringify(foreign));
    const bare = await work.meetingEnd({});
    check('W4: bare meeting_end attributes the STARTER honestly',
      bare.ok && bare.actor === 'ceo', JSON.stringify(bare));
    const proj2 = work.projectMeetings(store.readEvents());
    check('W4: every ENDED meeting in recent window, newest-first (tie-safe order)',
      proj2.active === null && proj2.recent.length === 4 &&
      proj2.recent[0].meeting_id === 'mt-0005' &&
      proj2.recent.map((m) => m.meeting_id).join(',') === 'mt-0005,mt-0003,mt-0002,mt-0001',
      JSON.stringify({ active: proj2.active && proj2.active.meeting_id,
        recent: proj2.recent.map((m) => m.meeting_id) }));
    /* mt-0004 stays a SUPERSEDED orphan (a start overtaken by a later start,
       never ended): §1.4 recent holds only meetings with a REAL meeting_ended,
       so it honestly appears in NEITHER window — nothing is fabricated. */
    check('W4: superseded orphan (never ended) appears in NEITHER window',
      !proj2.recent.some((m) => m.meeting_id === 'mt-0004'));
  }

  {
    /* desk contract: dedupe + bound ≤3, enrichment order task→work_logged */
    await work.workLog({
      action_summary: 'more refs',
      artifact_refs: ['docs/notes.md', 'office/BOARD.md', 'src/extra1.js', 'src/extra2.js'],
      as_role: 'executor',
    });
    const desks = work.projectWork(store.readEvents(), store.foldState()).by_role;
    const d = desks.executor;
    check('W4: desk artifacts DEDUPED across task+work_logged and BOUNDED to 3',
      d && d.artifacts.length === 3 &&
      d.artifacts[0] === 'mcp/vcnp-office-mcp/src/live/work-core.js' &&
      d.artifacts[1] === 'docs/notes.md' &&
      d.artifacts[2] === 'office/BOARD.md', JSON.stringify(d && d.artifacts));
    check('W4: last_work_logged carries summary+ts honestly',
      d.last_work_logged && d.last_work_logged.action_summary === 'more refs' && !!d.last_work_logged.ts);
    const lib = desks.librarian;
    /* parallel appends land in LOCK order, not index order — pin the shape,
       never a specific unit number (flake-free honesty) */
    check('W4: role with only work_logged gets honest card (task:null)',
      lib && lib.task === null && /^parallel unit \d$/.test(lib.last_work_logged.action_summary));
    check('W4: backslash refs normalized to forward slashes',
      d.artifacts.every((a) => !a.includes('\\')));
  }

  /* ---------- W5: mirror persistence ---------- */
  {
    const gen = await require('../src/tools/report').generate();
    check('W5: report_generate ok', gen.ok === true);
    const raw = fs.readFileSync(path.join(ws, 'office', 'dashboard-data.js'), 'utf8');
    const json = raw.replace(/^window\.VCNP_DATA = /, '').replace(/;\s*$/, '');
    const data = JSON.parse(json);
    check('W5: dashboard-data.js carries work section for file:// pages',
      data.work && data.work.by_role && !!data.work.by_role.executor);
    check('W5: dashboard-data.js carries meetings section (active null after ends)',
      data.meetings && data.meetings.active === null && data.meetings.recent.length === 4,
      JSON.stringify({ active: data.meetings && data.meetings.active,
        recent: data.meetings && data.meetings.recent && data.meetings.recent.map((m) => m.meeting_id) }));
    const payload = compose.build({});
    check('W5: compose payload shape has BOTH sections side by side',
      'work' in payload && 'meetings' in payload &&
      payload.schema_version === store.SCHEMA_VERSION);
  }

  /* validator sanity pin: traversal helper agrees with write-op rejection */
  check('W5: pure validator rejects what containment rejects',
    V.validateArtifactRefs(['../AGENTS.md']).length > 0 &&
    V.validateArtifactRefs(['ok/relative.js']).length === 0);

  console.log(`\nwork: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
