'use strict';

/*
 * Exclusive-create office lock (plan §6.2 item 1) — zero dependencies.
 *
 * Hardening over the original implementation:
 *   1. HEARTBEAT: while held, the lock file's mtime is refreshed every second,
 *      so a legitimately slow holder is never evicted by the stale rule.
 *   2. DEAD-HOLDER FAST TAKEOVER: the lock records the holder PID; if that
 *      process no longer exists, the lock is taken over IMMEDIATELY instead
 *      of waiting out STALE_LOCK_MS.
 *   3. Stale-age rule remains as the fallback (crash without cleanup, PID
 *      reuse, unreadable lock content).
 */

const fs = require('fs');
const path = require('path');

const STALE_LOCK_MS = 5000;      // stale-lock takeover threshold (hard constraint)
const LOCK_DEADLINE_MS = 10000;  // give up acquiring the lock after 10 s
const HEARTBEAT_MS = 1000;       // mtime refresh interval while the lock is held

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let heartbeatTimer = null;

/** true / false / null (= cannot determine). EPERM counts as alive. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (err) {
    return err.code === 'EPERM' ? true : false;
  }
}

function startHeartbeat(lockFile) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch (_) { /* lock vanished — acquisition loop will notice */ }
  }, HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let backoff = 20;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx'); // exclusive create — fails with EEXIST if held
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      startHeartbeat(lockFile);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let tookOver = false;
      try {
        const st = fs.statSync(lockFile);
        const age = Date.now() - st.mtimeMs;
        // Dead-holder fast takeover: holder PID gone -> do not wait for staleness.
        let holderDead = false;
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          holderDead =
            raw && typeof raw.pid === 'number' && raw.pid !== process.pid &&
            pidAlive(raw.pid) === false;
        } catch (_) { /* corrupt/unreadable lock — fall back to the age rule */ }
        if (holderDead || age > STALE_LOCK_MS) {
          try { fs.unlinkSync(lockFile); tookOver = true; } catch (_) { /* someone else took it */ }
        }
      } catch (_) { /* lock vanished — retry immediately */ }
      if (tookOver) continue;
      if (Date.now() > deadline) {
        throw new Error(`could not acquire office lock ${lockFile} within ${LOCK_DEADLINE_MS}ms`);
      }
      await sleep(backoff + Math.floor(Math.random() * 20)); // small jittered backoff
      backoff = Math.min(backoff * 2, 200);
    }
  }
}

function releaseLock(lockFile) {
  stopHeartbeat();
  try { fs.unlinkSync(lockFile); } catch (_) { /* already gone */ }
}

/** Run fn while holding the lock at lockFile. Releases even if fn throws. */
async function withLock(lockFile, fn) {
  await acquireLock(lockFile);
  try {
    return await fn();
  } finally {
    releaseLock(lockFile);
  }
}

module.exports = { STALE_LOCK_MS, LOCK_DEADLINE_MS, HEARTBEAT_MS, pidAlive, acquireLock, releaseLock, withLock };
