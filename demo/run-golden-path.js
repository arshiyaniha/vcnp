#!/usr/bin/env node
'use strict';

/*
 * VCNP Golden Path Demo — Phase P5 (plan §14 P5).
 *
 * Drives the office store engine DIRECTLY (no MCP transport needed) to prove
 * the full pipeline in one readable run:
 *
 *   idea -> board_init -> task_create x3 (Task Brief envelopes)
 *        -> executor Result Reports (task_update: awaiting_orchestrator)
 *        -> simulated QA pass events
 *        -> Orchestrator drains the written queue (board_status: done)
 *
 * Every office action is printed as a step-by-step trace so a beginner can
 * follow the golden path. The ledger (office/events.log.jsonl) is the only
 * source of truth; office/state.json + BOARD.md are rebuilt from it.
 *
 * Run from anywhere:
 *   node demo/run-golden-path.js
 *
 * NOTE: re-running appends NEW events (tasks get fresh T-NNN ids) — the
 * ledger is append-only by design.
 */

const path = require('path');
const store = require(path.join(__dirname, '..', 'mcp', 'vcnp-office-mcp', 'src', 'store.js'));

/* ------------------------------------------------------------------ */
/* Trace helpers                                                       */
/* ------------------------------------------------------------------ */

const RULE = '='.repeat(64);
const THIN = '-'.repeat(64);
let stepNo = 0;

function step(title) {
  stepNo += 1;
  console.log(`\n${RULE}\nSTEP ${stepNo}: ${title}\n${THIN}`);
}

function toolCall(name, args) {
  console.log(`  [office] ${name}(${JSON.stringify(args)})`);
}

function ok(result, summary) {
  if (result && result.ok === false) {
    console.log(`  [FAIL]  ${JSON.stringify(result)}`);
    throw new Error(`office action failed: ${result.error || 'unknown error'}`);
  }
  console.log(`  [ok]    ${summary}`);
}

function info(text) {
  console.log(`  [info]  ${text}`);
}

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

const PROJECT = { name: 'VCNP Demo Site', goal: 'Prove the golden path' };

// Three executor tasks (class C2 = standard build work). Each Task Brief
// carries acceptance criteria so QA has something concrete to check.
const BRIEFS = [
  {
    title: 'Landing hero section',
    artifacts: ['demo/site/index.html'],
    criteria: [
      'index.html contains a <header>-less semantic <section> hero with one h1 and one CTA link',
      'Markup is RTL-friendly (dir="rtl", logical CSS properties only)',
      'No external dependencies (no CDN fonts/scripts)',
    ],
    notes_for_qa: 'Hero copy + CTA implemented in demo/site/index.html; styles via assets/styles.css tokens.',
  },
  {
    title: 'Features grid',
    artifacts: ['demo/site/index.html', 'demo/site/assets/styles.css'],
    criteria: [
      'Exactly 3 feature cards inside a <section> of <article> elements',
      'Grid collapses to one column under 640px (mobile-first)',
      'Colors/spacing come from the design-system token variables',
    ],
    notes_for_qa: '3-card grid (Speed / Security / Transparency) using token variables.',
  },
  {
    title: 'Contact footer',
    artifacts: ['demo/site/index.html'],
    criteria: [
      '<footer> holds contact email link and short about text',
      'Semantic markup validated (footer > address/p)',
      'Page ends with footer as the last landmark element',
    ],
    notes_for_qa: 'Footer with mailto contact + about line added at end of body.',
  },
];

/* ------------------------------------------------------------------ */
/* Golden path                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(RULE);
  console.log('VCNP GOLDEN PATH DEMO — idea -> tasks -> build -> QA -> done');
  console.log(`Workspace: ${store.WORKSPACE}`);
  console.log(`Ledger:    ${path.relative(store.WORKSPACE, store.LEDGER_FILE)}`);
  console.log(RULE);

  /* -- 1. Board init ------------------------------------------------ */
  step('Board init — the Orchestrator opens the office for the idea');
  toolCall('board_init', PROJECT);
  const init = await store.bootstrap(PROJECT.name, PROJECT.goal);
  ok(init, `project "${init.project.name}" registered — goal "${init.project.goal}" (event ${init.event_id})`);

  const taskIds = [];

  /* -- 2..4 per task: create -> report -> QA -> done ---------------- */
  for (const brief of BRIEFS) {
    // (a) Orchestrator writes a Task Brief onto the board.
    step(`task_create — "${brief.title}" (executor, C2)`);
    const createArgs = {
      title: brief.title,
      assignee_role: 'executor',
      task_class: 'C2',
      acceptance_criteria: brief.criteria,
      budget_tokens: 12000,
      priority: 'medium',
      definition_of_done: `All acceptance criteria pass and QA approves "${brief.title}".`,
    };
    toolCall('task_create', { ...createArgs, acceptance_criteria: `[${brief.criteria.length} items]` });
    const created = await store.taskCreate(createArgs);
    ok(created, `${created.task_id} created — status: ${created.task.status}, criteria: ${created.task.acceptance_criteria.length}`);
    taskIds.push(created.task_id);

    // (b) Simulated Executor work: files are built, then a Result Report
    //     (status done + progress 100 + artifacts) lands the task on the
    //     Awaiting Orchestrator written queue (protocol §3).
    step(`Result Report — executor hands back "${brief.title}"`);
    toolCall('task_update', {
      task_id: created.task_id,
      status: 'awaiting_orchestrator',
      progress_percent: 100,
      artifacts: brief.artifacts,
      notes_for_qa: brief.notes_for_qa,
    });
    const reported = await store.taskUpdate(created.task_id, {
      status: 'awaiting_orchestrator',
      progress_percent: 100,
      artifacts: brief.artifacts,
      notes_for_qa: brief.notes_for_qa,
    });
    ok(reported, `${reported.task_id} -> board status: ${reported.board_status}, progress: ${reported.progress_percent}% (event ${reported.event_id})`);

    // (c) Simulated QA gate: QA checks the acceptance criteria and passes it.
    step(`QA pass — verdict recorded for ${created.task_id}`);
    toolCall('event_log', { actor: 'qa', action: 'qa_review_passed', detail: { task_id: created.task_id, verdict: 'pass' } });
    const qa = await store.appendEvent({
      actor: 'qa',
      action: 'qa_review_passed',
      task_id: created.task_id,
      verdict: 'pass',
      checked_criteria: brief.criteria.length,
    });
    ok(qa, `QA approved ${created.task_id} (${brief.criteria.length}/${brief.criteria.length} criteria) — event ${qa.event.event_id}`);

    // (d) Orchestrator drains the written queue: task moves to Done.
    step(`Queue drain — Orchestrator marks ${created.task_id} done`);
    toolCall('task_update', { task_id: created.task_id, board_status: 'done' });
    const drained = await store.taskUpdate(created.task_id, { board_status: 'done' });
    ok(drained, `${drained.task_id} -> board status: ${drained.board_status} (event ${drained.event_id})`);
  }

  /* -- 5. Board read ------------------------------------------------ */
  step('board_read — compact snapshot of the finished run');
  const snap = store.boardRead();
  console.log(`  [ok]    Project: ${snap.project.name} — overall progress ${snap.project.overall_progress}%`);
  console.log(`  [ok]    Tasks: ${snap.counts.total} | ${
    Object.entries(snap.counts.by_status).map(([k, v]) => `${k}:${v}`).join(' ')
  }`);
  for (const t of snap.tasks) {
    console.log(`          ${t.task_id} [${t.status}] ${t.title} — ${t.assignee_role}, ${t.progress_percent}%`);
  }

  /* -- 6. Ledger tail ----------------------------------------------- */
  step('Ledger check — every action above was appended to the ledger');
  const events = store.readEvents();
  console.log(`  [ok]    ${events.length} total events in office/events.log.jsonl`);
  console.log('  [ok]    Last 6 events:');
  for (const ev of events.slice(-6)) {
    console.log(`          - ${ev.ts} | ${ev.actor} | ${ev.action}${ev.task_id ? ` | ${ev.task_id}` : ''}`);
  }

  /* -- Summary -------------------------------------------------------*/
  console.log(`\n${RULE}`);
  console.log('GOLDEN PATH COMPLETE');
  console.log(`  Tasks done : ${taskIds.join(', ')}`);
  console.log(`  Site       : demo/site/index.html (+ assets/styles.css)`);
  console.log(`  Mirrors    : office/state.json, office/BOARD.md (run report_generate to refresh)`);
  console.log(`  Ledger     : office/events.log.jsonl (${events.length} events)`);
  console.log(RULE);
}

main().catch((err) => {
  console.error(`\n[GOLDEN PATH FAILED] ${err.message}`);
  process.exitCode = 1;
});
