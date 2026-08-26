'use strict';

/*
 * live/watcher.js — cross-process ledger watcher (plan §4.1b / D2, Phase 2).
 *
 * WHY THE DIRECTORY IS WATCHED, NOT THE FILE: on Windows fs.watch on a single
 * file is unreliable, and every mirror/state write in this repo is
 * temp+rename (atomicWriteText) — a watcher attached to a renamed target
 * loses track of the inode. The doc's prescription is followed exactly:
 * fs.watch(office/) filtered to filename 'events.log.jsonl' (a null filename
 * schedules too — cheap, because the stamp check dedupes), plus an
 * fs.watchFile polling fallback (2 s) for filesystems where directory events
 * get lost (network drives, some AV filters).
 *
 * DEDUPE / WORK GATING — a trigger only means "SOMETHING changed". All work
 * is gated by the ledger stamp (size:mtime:ctime, lib/ledger-engine.js):
 *
 *   stamp === lastSeen                ⇒ nothing new since we last looked
 *                                       → no-op (absorbs debounce bursts and
 *                                       duplicate watch/poller hits)
 *   stamp !== office/.mirrors-stamp   ⇒ mirrors stale → regenerate UNDER the
 *                                       office lock. syncMirrors() itself
 *                                       dedupes against the stamp file, so a
 *                                       regen the appending process already
 *                                       performed via its post-append hook is
 *                                       NOT repeated.
 *   then compose + onRefresh(payload) ⇒ SSE broadcast.
 *
 * Net effect: an append made by the MCP process (which refreshes mirrors via
 * its own hook) costs the live server ZERO regenerations but still produces
 * a broadcast; a raw external append costs exactly ONE locked regen.
 *
 * DEADLOCK SAFETY: handleOnce acquires store.withLock and inside it only
 * calls mirrors.syncMirrors → report.generate, which reads the ledger
 * (memoized) and writes mirrors via temp+rename — it never touches lib/lock,
 * which has no re-entrancy.
 */

const fs = require('fs');
const store = require('../store');
const mirrors = require('../hooks/mirrors');
const compose = require('./compose');

const DEBOUNCE_MS_DEFAULT = 150; // plan §4.1b
const POLL_MS_DEFAULT = 2000;    // plan §4.1b safety net

function positiveInt(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function startWatcher(opts) {
  const debounceMs = positiveInt(opts && opts.debounceMs, DEBOUNCE_MS_DEFAULT);
  const pollMs = positiveInt(opts && opts.pollMs, POLL_MS_DEFAULT);
  const port = opts && Number.isFinite(opts.port) ? opts.port : null;
  const onRefresh = opts && typeof opts.onRefresh === 'function' ? opts.onRefresh : async () => {};
  const officeDir = store.OFFICE_DIR;
  const ledgerFile = store.LEDGER_FILE;

  let lastSeen = null;
  let dirWatcher = null;
  let debounceTimer = null;
  let stopped = true;
  let running = false;
  let rerun = false;

  function stderr(msg) {
    process.stderr.write(`[vcnp-live-watcher] ${msg}\n`);
  }

  /** Collapse bursts of fs.watch/fs.watchFile events into one run. */
  function schedule() {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(false);
    }, debounceMs);
  }

  /**
   * One serialized check. Returns { changed, regenerated }.
   * force=true bypasses only the lastSeen early-return (boot freshness);
   * mirror regeneration stays conditional on the .mirrors-stamp file.
   */
  async function handleOnce(force) {
    const stamp = store.ledgerStamp();
    if (!force && stamp === lastSeen) return { changed: false, regenerated: false };
    let regen = { skipped: true };
    if (stamp !== null) {
      regen = await store.withLock(() => mirrors.syncMirrors());
    }
    lastSeen = stamp;
    const payload = compose.build({ port });
    await onRefresh(payload);
    return { changed: true, regenerated: !regen.skipped };
  }

  /** Serialized runner: coalesces triggers that arrive mid-handling. */
  async function run(force) {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        const r = await handleOnce(force);
        force = false;
        if (r.changed && r.regenerated) stderr(`mirrors regenerated (ledger stamp ${store.ledgerStamp()})`);
      } while (rerun && !stopped);
    } catch (err) {
      stderr(`refresh failed: ${(err && err.stack) || err}`);
    } finally {
      running = false;
    }
  }

  /**
   * Boot-time baseline + freshness: record the current ledger stamp, then
   * run one forced pass so mirrors stale from appends made while the server
   * was off are regenerated before the first client asks.
   */
  async function init() {
    lastSeen = store.ledgerStamp();
    await run(true);
  }

  function start() {
    stopped = false;
    try {
      dirWatcher = fs.watch(officeDir, (_eventType, filename) => {
        // Appends touch events.log.jsonl directly; temp+rename churn on other
        // filenames is filtered out. null filename ⇒ schedule anyway (cheap).
        if (filename === null || filename === 'events.log.jsonl') schedule();
      });
      dirWatcher.on('error', (err) => {
        stderr(`fs.watch error (${(err && err.message) || err}) — polling fallback remains active`);
      });
    } catch (err) {
      dirWatcher = null;
      stderr(`fs.watch could not start (${(err && err.message) || err}) — polling fallback remains active`);
    }
    fs.watchFile(ledgerFile, { interval: pollMs }, (curr, prev) => {
      if (curr.size !== prev.size || curr.mtimeMs !== prev.mtimeMs) schedule();
    });
  }

  function stop() {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (dirWatcher) {
      try {
        dirWatcher.close();
      } catch (_) { /* already closed */ }
      dirWatcher = null;
    }
    fs.unwatchFile(ledgerFile);
  }

  return {
    init,
    start,
    stop,
    flush: () => run(false), // immediate check without waiting for the debounce (tests)
    lastSeen: () => lastSeen,
  };
}

module.exports = { startWatcher, DEBOUNCE_MS_DEFAULT, POLL_MS_DEFAULT };
