'use strict';

/*
 * office_archive_reset — honest demo rotation (live-office plan D6, §8 Phase 1).
 *
 * Append-only philosophy: history is ARCHIVED, never destroyed.
 *   1. Refuses while ANOTHER LIVE process holds the office lock (stale/dead
 *      locks are still taken over by lib/lock.js as usual).
 *   2. Under the lock: copies the current ledger byte-for-byte into
 *      office/archive/events-<UTC timestamp>.jsonl (unique name, never
 *      overwritten), then resets the live ledger to EMPTY via atomic write.
 *   3. Optionally bootstraps a fresh project (board_init) so the next
 *      task_create gets a clean T-001.
 *   4. Regenerates all mirrors from the reset state and refreshes
 *      office/.mirrors-stamp (force — truncation bypasses appendEventLocked).
 *
 * Nothing outside the office/ subtree is touched.
 */

const fs = require('fs');
const path = require('path');
const lockLib = require('../lib/lock');
const store = require('../store');

const ARCHIVE_DIR = path.join(store.OFFICE_DIR, 'archive');

function utcStamp(d) {
  const p = (n, w) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}` +
    `-${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}` +
    `-${p(d.getUTCMilliseconds(), 3)}`
  );
}

/** Never overwrite an archive: suffix -1, -2, … on collision. */
function uniqueArchivePath(base) {
  let candidate = `${base}.jsonl`;
  for (let i = 0; fs.existsSync(candidate); i++) candidate = `${base}-${i + 1}.jsonl`;
  return candidate;
}

/** Busy only when the lock holder is another LIVE process. */
function lockBusyError() {
  try {
    const raw = JSON.parse(fs.readFileSync(store.LOCK_FILE, 'utf8'));
    if (raw && typeof raw.pid === 'number' && raw.pid !== process.pid && lockLib.pidAlive(raw.pid) === true) {
      return `office lock is held by another live process (pid ${raw.pid}) — retry once it finishes`;
    }
  } catch (_) { /* no/unreadable/stale lock — not busy */ }
  return null;
}

async function reset(args) {
  args = args || {};
  const busy = lockBusyError();
  if (busy) return { ok: false, error: busy, busy: true };

  const bootstrapName = typeof args.project_name === 'string' ? args.project_name.trim() : '';
  const bootstrapGoal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!!bootstrapName !== !!bootstrapGoal) {
    return {
      ok: false,
      error: "project_name and goal must be given TOGETHER for a post-reset bootstrap (omit both for an empty ledger)",
    };
  }
  const wantsBootstrap = !!bootstrapName;

  return store.withLock(async () => {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    // 1. Archive current ledger content (copy keeps the original bytes).
    let raw = '';
    try { raw = fs.readFileSync(store.LEDGER_FILE, 'utf8'); } catch (_) { /* no ledger yet */ }
    const lines = raw.split('\n').filter((l) => l.trim());
    let archivedFile = null;
    if (lines.length > 0) {
      archivedFile = uniqueArchivePath(path.join(ARCHIVE_DIR, `events-${utcStamp(new Date())}`));
      fs.copyFileSync(store.LEDGER_FILE, archivedFile);
      store.atomicWriteText(store.LEDGER_FILE, ''); // reset live ledger to empty
    }

    // 2. Optional fresh bootstrap (board_init) inside the same critical section.
    let bootstrapEventId = null;
    if (wantsBootstrap) {
      const r = await store.appendEventLocked({
        actor: 'orchestrator',
        action: 'board_init',
        project_name: bootstrapName,
        goal: bootstrapGoal,
      });
      if (!r.duplicate) bootstrapEventId = r.event.event_id;
    }

    // 3. Mirrors from the RESET state + refreshed stamp (still under the lock;
    //    report.generate is lock-free — see hooks/mirrors.js deadlock note).
    const mirrors = await require('../hooks/mirrors').syncMirrors({ force: true });

    return {
      ok: true,
      archived: archivedFile !== null,
      archived_file: archivedFile
        ? path.relative(store.WORKSPACE, archivedFile).split(path.sep).join('/')
        : null,
      events_archived: lines.length,
      reset_to: wantsBootstrap ? 'bootstrap' : 'empty',
      project: wantsBootstrap ? { name: bootstrapName, goal: bootstrapGoal } : null,
      bootstrap_event_id: bootstrapEventId,
      mirrors_regenerated: !(mirrors && mirrors.skipped),
    };
  });
}

const defs = [
  {
    name: 'office_archive_reset',
    description:
      'Rotate the demo ledger honestly (append-only: archive, never destroy). Copies office/events.log.jsonl into ' +
      'office/archive/events-<timestamp>.jsonl, resets the live ledger to empty (or bootstraps a fresh project when ' +
      'project_name+goal are given), then regenerates BOARD.md / office-live.json / dashboard-data.js. REFUSES to run ' +
      'while another live process holds the office lock.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'with goal: bootstrap this fresh project after the reset' },
        goal: { type: 'string', description: 'with project_name: goal for the fresh project' },
      },
    },
    handler: async (args) => reset(args),
    format: (r) =>
      `office_archive_reset ok — ${
        r.archived
          ? `archived ${r.events_archived} event(s) -> ${r.archived_file}`
          : 'ledger was already empty, nothing to archive'
      }; live ledger reset to ${r.reset_to === 'bootstrap' ? `fresh project "${r.project.name}"` : 'empty'}; ` +
      `mirrors regenerated.`,
  },
];

module.exports = { defs, reset, ARCHIVE_DIR };
