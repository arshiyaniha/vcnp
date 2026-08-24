'use strict';

/*
 * compaction_ack — deterministic emitter for compaction_done (plan §10 item 4,
 * skills/core-board-ops §compaction_ack).
 *
 * Validates BEFORE appending:
 *   1. util_after must be a number in [0, 0.75].
 *   2. office/memory-bank/activeContext.md must EXIST and its mtime must be
 *      NEWER than the session's latest task_* ledger event (the Librarian
 *      hand-off must have actually happened). No prior task event for the
 *      session -> constraint trivially satisfied.
 * Rejection explains exactly which checks failed. The appended compaction_done
 * counts only while it remains the LATEST util-related event for the session.
 */

const fs = require('fs');
const store = require('../store');

const UTIL_THRESHOLD = 0.75;

/** Timestamp of the session's latest task_* event, or null when it has none. */
function latestTaskEventTs(events, sessionId) {
  let latest = null;
  for (const ev of events) {
    if (ev.session_id === sessionId && String(ev.action || '').startsWith('task_')) {
      const ts = Date.parse(ev.ts);
      if (!Number.isNaN(ts) && (latest === null || ts > latest)) latest = ts;
    }
  }
  return latest;
}

async function ack(args) {
  const { session_id, util_after } = args;
  const reasons = [];

  if (typeof session_id !== 'string' || !session_id.trim()) {
    reasons.push("'session_id' must be a non-empty string");
  }
  if (typeof util_after !== 'number' || !Number.isFinite(util_after) || util_after < 0) {
    reasons.push("'util_after' must be a finite number >= 0");
  } else if (util_after > UTIL_THRESHOLD) {
    reasons.push(
      `'util_after'=${util_after} exceeds the ${UTIL_THRESHOLD} threshold — compaction must bring context ` +
        `utilization to <= ${UTIL_THRESHOLD * 100}% before acknowledging (plan §10 item 4)`
    );
  }

  const sid = typeof session_id === 'string' ? session_id : '';
  let mtimeMs = null;
  if (fs.existsSync(store.ACTIVE_CONTEXT_FILE)) {
    mtimeMs = fs.statSync(store.ACTIVE_CONTEXT_FILE).mtimeMs;
  } else {
    reasons.push(
      'memory-bank file missing: office/memory-bank/activeContext.md — the Librarian hand-off must ACTUALLY ' +
        'update the Memory Bank before compaction can be acknowledged'
    );
  }
  if (sid && mtimeMs !== null) {
    const lastTaskTs = latestTaskEventTs(store.readEvents(), sid);
    if (lastTaskTs !== null && mtimeMs <= lastTaskTs) {
      reasons.push(
        `office/memory-bank/activeContext.md mtime (${new Date(mtimeMs).toISOString()}) is NOT newer than the ` +
          `session's last task event (${new Date(lastTaskTs).toISOString()}) — update the Memory Bank FIRST, then acknowledge`
      );
    }
  }

  if (reasons.length) {
    return {
      ok: false,
      rejected: true,
      error: `compaction_ack REJECTED for session '${sid || '?'}'`,
      reasons,
      gate: 'compaction_boundary',
    };
  }

  const r = await store.appendEvent({
    actor: 'rc',
    action: 'compaction_done',
    session_id: sid,
    util_after,
  });
  return {
    ok: true,
    session_id: sid,
    util_after,
    event_id: r.event.event_id,
    note: 'valid ONLY while it remains the LATEST util-related event for this session (freshness rule)',
  };
}

const defs = [
  {
    name: 'compaction_ack',
    description:
      'Deterministic writer for compaction_done at task boundaries (plan §10 item 4). Validates util_after <= 0.75 ' +
      'AND that office/memory-bank/activeContext.md was modified NEWER than the session\'s last task event, then ' +
      'appends the event atomically. Rejections list exactly what failed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        util_after: { type: 'number', minimum: 0, maximum: 0.75 },
      },
      required: ['session_id', 'util_after'],
    },
    handler: async (args) => ack(args),
    format: (r) =>
      `compaction_done recorded for session '${r.session_id}' (util_after=${r.util_after}, event ${r.event_id}). ${r.note}`,
  },
];

module.exports = { defs, ack, UTIL_THRESHOLD };
