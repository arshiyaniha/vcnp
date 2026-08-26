'use strict';

/*
 * Post-append mirror hook (live-office plan §4.1a / D2).
 *
 * Registered ONCE per process — explicitly by src/server.js at boot, or
 * lazily by store.flushPostAppendHooks on the first locked append — so that
 * EVERY successful ledger append refreshes the human mirrors:
 *   office/BOARD.md · office/office-live.json · office/dashboard-data.js
 * even when no live server is running.
 *
 * Dedupe (.mirrors-stamp): the file stores the ledger stamp
 * (size:mtime:ctime) as of the last regeneration. When it already matches
 * the current ledger, regeneration is skipped. This also lets the future
 * live-server watcher (plan §4.1b, Phase 2) skip work this hook already did.
 *
 * DEADLOCK SAFETY: the hook runs INSIDE store.withLock. report.generate()
 * only reads the ledger (memoized) and writes mirrors via temp+rename — it
 * never touches lib/lock.js, whose exclusive-create scheme has no
 * re-entrancy (same-PID reacquire spins into the 10 s deadline and throws).
 */

const fs = require('fs');
const store = require('../store');

function readStampFile() {
  try {
    return fs.readFileSync(store.MIRRORS_STAMP_FILE, 'utf8').trim();
  } catch (_) {
    return null; // never regenerated yet
  }
}

function writeStampFile(stamp) {
  try {
    store.ensureOfficeDir();
    store.atomicWriteText(store.MIRRORS_STAMP_FILE, stamp + '\n');
  } catch (_) { /* the stamp is an optimization — never fatal */ }
}

/**
 * Regenerate the mirrors unless the stamp file already matches the ledger.
 * opts.force=true bypasses the check (used after archive/reset truncation,
 * where content changed without going through appendEventLocked).
 */
async function syncMirrors(opts) {
  const stamp = store.ledgerStamp();
  if (!(opts && opts.force) && stamp !== null && stamp === readStampFile()) {
    return { ok: true, skipped: true, reason: '.mirrors-stamp matches ledger' };
  }
  const report = require('../tools/report'); // lazy — avoids the load-time cycle
  const r = await report.generate();
  if (stamp !== null) writeStampFile(stamp);
  return { ...r, skipped: false };
}

/** Hook signature per store.registerPostAppendHook ({ events, state } ignored). */
async function mirrorsHook() {
  return syncMirrors();
}

let registered = false;

/** Idempotent registration; true when this call actually registered. */
function register() {
  if (registered) return false;
  registered = true;
  store.registerPostAppendHook(mirrorsHook);
  return true;
}

module.exports = { register, syncMirrors, mirrorsHook, readStampFile, writeStampFile };
