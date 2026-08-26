'use strict';

/*
 * store-probe.js — child-process fixture for regression.js.
 * Usage: node test/fixtures/store-probe.js <mode> [workspace]
 *   mode = concurrent-create | lock-takeover
 * The workspace MUST be passed because src/store resolves it at require time.
 */

const mode = process.argv[2];
const ws = process.argv[3];
if (!ws) {
  console.error('workspace argument required');
  process.exit(2);
}
process.env.VCNP_OFFICE_WORKSPACE = ws;

const store = require('../../src/store');

(async () => {
  if (mode === 'concurrent-create') {
    // Fires two creates whose sync prologue completes before either takes the
    // lock — exactly the interleaving that used to hand out duplicate T-001s.
    const brief = (title) => ({
      title,
      assignee_role: 'executor',
      acceptance_criteria: ['x'],
      budget_tokens: 1000,
      task_class: 'C1',
    });
    const [a, b] = await Promise.all([
      store.taskCreate(brief('a')),
      store.taskCreate(brief('b')),
    ]);
    console.log(JSON.stringify({
      ok: !!(a.ok && b.ok),
      ids: [a.task_id, b.task_id],
      titles: [a.task && a.task.title, b.task && b.task.title],
    }));
    process.exit(0);
  }

  if (mode === 'lock-takeover') {
    // Caller pre-creates office/.lock holding a DEAD pid; acquisition must
    // bypass the 5 s stale-age wait via dead-holder takeover.
    const t0 = Date.now();
    await store.withLock(async () => {});
    console.log(JSON.stringify({ ms: Date.now() - t0 }));
    process.exit(0);
  }

  if (mode === 'mirror-regen') {
    // Phase 1 auto-regen (live-office plan §4.1a): a plain successful append
    // must refresh ALL mirrors + refresh .mirrors-stamp; a duplicate event_id
    // delivery must NOT regenerate anything.
    const fs = require('fs');
    const path = require('path');
    const officeDir = path.join(ws, 'office');
    fs.mkdirSync(officeDir, { recursive: true });
    const ledgerPath = path.join(officeDir, 'events.log.jsonl');
    if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, '');
    const mirrors = require('../../src/hooks/mirrors');
    await mirrors.syncMirrors({ force: true }); // baseline mirrors + stamp
    const snap = (f) => {
      const p = path.join(officeDir, f);
      return { text: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs };
    };
    const before = {
      board: snap('BOARD.md'),
      live: snap('office-live.json'),
      dash: snap('dashboard-data.js'),
    };
    await new Promise((r) => setTimeout(r, 60));
    const app = await store.appendEvent({ actor: 'qa', action: 'qa_review_passed', task_id: 'T-001' });
    const after = {
      board: snap('BOARD.md'),
      live: snap('office-live.json'),
      dash: snap('dashboard-data.js'),
    };
    const stampAfterAppend = fs.readFileSync(path.join(officeDir, '.mirrors-stamp'), 'utf8').trim();
    await new Promise((r) => setTimeout(r, 60));
    const dup = await store.appendEvent({
      actor: 'qa', action: 'qa_review_passed', task_id: 'T-001', event_id: app.event.event_id,
    });
    const boardAfterDup = fs.statSync(path.join(officeDir, 'BOARD.md')).mtimeMs;
    console.log(JSON.stringify({
      appended: app.duplicate === false,
      boardRefreshed: after.board.mtime > before.board.mtime,
      liveRefreshed: after.live.mtime > before.live.mtime,
      dashRefreshed: after.dash.mtime > before.dash.mtime,
      dashHasEvent: after.dash.text.includes('qa_review_passed'),
      stampMatchesLedger: stampAfterAppend === store.ledgerStamp(),
      duplicateFlagged: dup.duplicate === true,
      noRegenOnDuplicate: boardAfterDup === after.board.mtime,
    }));
    process.exit(0);
  }

  if (mode === 'demo-reset') {
    // Phase 1 D6: archive rotation keeps history intact, resets clean, and
    // regenerates the mirrors for the fresh ledger.
    const fs = require('fs');
    const path = require('path');
    const officeDir = path.join(ws, 'office');
    fs.mkdirSync(officeDir, { recursive: true });
    fs.writeFileSync(path.join(officeDir, 'events.log.jsonl'), '');
    await store.bootstrap('Stale Demo', 'old goal');
    await store.taskCreate({
      title: 'legacy task', assignee_role: 'executor',
      acceptance_criteria: ['x'], budget_tokens: 10, task_class: 'C1',
    });
    const ledgerPath = path.join(officeDir, 'events.log.jsonl');
    const oldLines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
    const demoReset = require('../../src/tools/demo-reset');
    const r = await demoReset.reset({ project_name: 'Fresh Demo', goal: 'clean slate' });
    const archivedText = r.archived_file
      ? fs.readFileSync(path.join(ws, ...r.archived_file.split('/')), 'utf8')
      : '';
    const archivedLines = archivedText.split('\n').filter((l) => l.trim());
    const newLines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
    const state = JSON.parse(fs.readFileSync(path.join(officeDir, 'state.json'), 'utf8'));
    const board = fs.readFileSync(path.join(officeDir, 'BOARD.md'), 'utf8');
    const dash = fs.readFileSync(path.join(officeDir, 'dashboard-data.js'), 'utf8');
    const stamp = fs.readFileSync(path.join(officeDir, '.mirrors-stamp'), 'utf8').trim();
    console.log(JSON.stringify({
      ok: r.ok === true,
      archivedFlag: r.archived === true,
      archiveExists: fs.existsSync(demoReset.ARCHIVE_DIR),
      preservedOldEvents: oldLines.length > 0 && archivedLines.length === oldLines.length &&
        archivedLines[0] === oldLines[0],
      eventsArchivedMatches: r.events_archived === oldLines.length,
      ledgerIsBootstrapOnly: newLines.length === 1 &&
        newLines[0].includes('"board_init"') && newLines[0].includes('Fresh Demo'),
      freshStateNoTasks: Array.isArray(state.tasks) && state.tasks.length === 0,
      projectRenamed: !!(state.project && state.project.name === 'Fresh Demo'),
      boardHasNoLegacyTask: !board.includes('legacy task'),
      dashFresh: dash.includes('board_init') && !dash.includes('legacy task'),
      stampMatchesLedger: stamp === store.ledgerStamp(),
    }));
    process.exit(0);
  }

  if (mode === 'demo-reset-busy') {
    // Caller pre-writes office/.lock holding a LIVE foreign pid: the reset
    // must refuse instead of taking over a live holder's lock.
    const demoReset = require('../../src/tools/demo-reset');
    const r = await demoReset.reset({});
    console.log(JSON.stringify({ refused: r.ok === false && r.busy === true, error: r.error || null }));
    process.exit(r.ok === false && r.busy === true ? 0 : 1);
  }

  console.error('unknown mode: ' + mode);
  process.exit(2);
})().catch((e) => {
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
