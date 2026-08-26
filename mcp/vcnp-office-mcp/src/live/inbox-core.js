'use strict';

/*
 * live/inbox-core.js — chat/inbox domain core shared by the MCP tools
 * (tools/inbox.js) and the live HTTP API (GET /api/inbox, POST /api/message)
 * — live-office plan §1.2/§3, Phase 3 "Scenario A honest queue".
 *
 * PURE projections (no I/O):
 *   nextMessageId(events)        m-NNNN allocation from a fresh fold
 *   projectInbox(events, opts)   pending + answered_recent views (§1.3)
 *   joinThreads(events, limit)   chat.messages pairing view (§1.4)
 *   deriveSessionActive(events)  honest session_active hint (§3.2)
 *
 * WRITE ops (office lock via store.withLock; mirrors + SSE broadcast happen
 * automatically through the post-append hook and the ledger watcher):
 *   postMessage({to_role, text, channel})   → appends message_posted
 *   replyMessage({reply_to, text, as_role}) → appends message_answered
 *     FIRST ANSWER WINS: a second reply to the same message_posted is
 *     rejected honestly ({ ok:false, error:'already answered by …' }) —
 *     the check and the append share one locked critical section (plan §3.1/R5).
 *
 * Nothing here ever simulates activity: empty inbox ⇒ empty arrays; the
 * session hint is derived ONLY from real ledger signals.
 */

const store = require('../store');
const report = require('../tools/report');
const V = require('../lib/events-validate');

const CHAT_MESSAGES_LIMIT = 50; // bounded window for composed threads (§1.4)
const ANSWERED_RECENT_LIMIT = 20; // answered_recent window for /api/inbox (§1.3)

/* ---------------- id allocation (caller MUST hold the lock) ------------- */

function nextMessageId(events) {
  let max = 0;
  for (const ev of events) {
    if (!ev || ev.action !== 'message_posted') continue;
    const m = /^m-(\d+)$/.exec(String(ev.message_id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'm-' + String(max + 1).padStart(4, '0');
}

/* ---------------- pure projections ---------------- */

/**
 * Pending = latest-per-thread view over message_posted events that have no
 * later message_answered with the same reply_to. Oldest-first (§3.1).
 */
function projectInbox(events, opts) {
  const o = opts || {};
  const answerFor = new Map(); // reply_to(event_id) -> answer event (latest wins)
  for (const ev of events) {
    if (ev && ev.action === 'message_answered' && typeof ev.reply_to === 'string') {
      answerFor.set(ev.reply_to, ev);
    }
  }
  const pending = [];
  const answered = [];
  for (const ev of events) {
    if (!ev || ev.action !== 'message_posted') continue;
    const ans = answerFor.get(ev.event_id) || null;
    const item = {
      message_id: ev.message_id,
      from: ev.actor || 'user',
      to_role: ev.to_role,
      text: ev.text,
      ts: ev.ts,
      channel: ev.channel || 'web',
      event_id: ev.event_id,
    };
    if (!ans) {
      if (!o.role || o.role === ev.to_role) pending.push(item);
    } else if (!o.role || o.role === ev.to_role) {
      answered.push({
        message_id: ev.message_id,
        reply_to: ev.event_id,
        to_role: ev.to_role,
        asked_ts: ev.ts,
        asked_text: ev.text,
        actor: ans.actor,
        text: ans.text,
        ts: ans.ts,
      });
    }
  }
  const answered_recent = answered.slice(-ANSWERED_RECENT_LIMIT).reverse(); // newest-first
  /* Sparse map per plan §1.4 example ("pending_by_role": { "ceo": 2 }) —
     only roles that actually have unanswered messages appear. */
  const pending_by_role = {};
  for (const p of pending) {
    pending_by_role[p.to_role] = (pending_by_role[p.to_role] || 0) + 1;
  }
  return {
    pending,
    answered_recent,
    total_pending: pending.length,
    pending_by_role,
  };
}
/**
 * chat.messages pairing view (§1.4): each message_posted joined with its
 * message_answered via reply_to — renderers never join events themselves.
 * Oldest→newest, bounded to the last `limit` threads.
 */
function joinThreads(events, limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : CHAT_MESSAGES_LIMIT;
  const answerFor = new Map();
  for (const ev of events) {
    if (ev && ev.action === 'message_answered' && typeof ev.reply_to === 'string') {
      answerFor.set(ev.reply_to, ev);
    }
  }
  const threads = [];
  for (const ev of events) {
    if (!ev || ev.action !== 'message_posted') continue;
    const ans = answerFor.get(ev.event_id) || null;
    threads.push({
      message_id: ev.message_id,
      kind: 'message_posted',
      ts: ev.ts,
      from: ev.actor || 'user',
      to_role: ev.to_role,
      text: ev.text,
      channel: ev.channel || 'web',
      answer: ans ? { ts: ans.ts, actor: ans.actor, text: ans.text } : null,
    });
  }
  return threads.slice(-cap);
}

/**
 * Honest session_active hint (§3.2 honesty invariant): a role counts as
 * session-active ONLY when REAL ledger signals say so within the active
 * window (ACTIVE_THRESHOLD_MIN, same tunable as presence):
 *   - any event authored by the role within the window (live work evidence),
 *     AND
 *   - its latest session_lifecycle event is not an 'end' at-or-after that
 *     latest activity (an explicit end closes the session).
 * No lifecycle data + no recent events ⇒ false ⇒ the UI shows
 * «در انتظار نشست» while messages pend. Presence is NEVER fabricated.
 */
function deriveSessionActive(events, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const T = report.tunables();
  const cutoff = now - T.ACTIVE_THRESHOLD_MIN * 60000;
  const by_role = {};
  for (const r of report.ROLES) by_role[r] = false;
  const lastAny = {};
  const lastLife = {};
  for (const ev of events) {
    if (!ev || typeof ev.actor !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(by_role, ev.actor)) continue;
    lastAny[ev.actor] = ev.ts;
    if (ev.action === 'session_lifecycle' && (ev.phase === 'start' || ev.phase === 'end')) {
      lastLife[ev.actor] = ev;
    }
  }
  for (const r of report.ROLES) {
    const w = lastAny[r];
    if (!w || Date.parse(w) < cutoff) continue;
    const l = lastLife[r];
    if (l && l.phase === 'end' && Date.parse(l.ts) >= Date.parse(w)) continue;
    by_role[r] = true;
  }
  return {
    by_role,
    threshold_min: T.ACTIVE_THRESHOLD_MIN,
    note: 'honest hint derived from real session_lifecycle/work events within the active window — never fabricated',
  };
}

/* ---------------- write ops (locked) ---------------- */

function invalid(reasons) {
  return { ok: false, error: 'invalid message', reasons };
}

/** POST /api/message + CLI intake path. Appends message_posted (plan §2). */
async function postMessage(args) {
  const input = args || {};
  const channel = input.channel === undefined ? 'web' : input.channel;
  const reasons = V.validateMessagePosted({ to_role: input.to_role, text: input.text, channel });
  if (reasons.length) return invalid(reasons);
  return store.withLock(async () => {
    const events = store.readEvents();
    const message_id = nextMessageId(events); // INSIDE the lock — race-free
    const r = await store.appendEventLocked({
      actor: 'user',
      action: 'message_posted',
      message_id,
      to_role: input.to_role,
      text: input.text,
      channel,
    }, { events });
    if (r.duplicate) return { ok: false, error: `duplicate message_posted event ${r.event_id}` };
    return { ok: true, event_id: r.event.event_id, message_id, to_role: input.to_role, ts: r.event.ts };
  });
}

/**
 * MCP inbox_reply path. Under one lock: verify target exists & unanswered
 * (first answer wins), then append message_answered with actor = as_role
 * (default ceo per plan §3.1).
 */
async function replyMessage(args) {
  const input = args || {};
  const asRole = input.as_role === undefined ? 'ceo' : input.as_role;
  const reasons = V.validateMessageAnswered({ reply_to: input.reply_to, text: input.text });
  reasons.push(...V.validateAnsweringRole(asRole));
  if (reasons.length) return invalid(reasons);
  return store.withLock(async () => {
    const events = store.readEvents();
    const target = events.find((e) => e && e.action === 'message_posted' && e.event_id === input.reply_to);
    if (!target) {
      return { ok: false, error: `unknown message '${input.reply_to}' — no message_posted carries this event_id` };
    }
    const existing = events.find((e) => e && e.action === 'message_answered' && e.reply_to === input.reply_to);
    if (existing) {
      return {
        ok: false,
        error: `already answered by ${existing.actor}`,
        reply_to: input.reply_to,
        answered_event_id: existing.event_id,
        answered_ts: existing.ts,
      };
    }
    const r = await store.appendEventLocked({
      actor: asRole,
      action: 'message_answered',
      message_id: target.message_id,
      reply_to: input.reply_to,
      text: input.text,
    }, { events });
    if (r.duplicate) return { ok: false, error: `duplicate message_answered event ${r.event_id}` };
    return {
      ok: true,
      event_id: r.event.event_id,
      reply_to: input.reply_to,
      message_id: target.message_id,
      actor: asRole,
      ts: r.event.ts,
    };
  });
}

module.exports = {
  CHAT_MESSAGES_LIMIT,
  ANSWERED_RECENT_LIMIT,
  nextMessageId,
  projectInbox,
  joinThreads,
  deriveSessionActive,
  postMessage,
  replyMessage,
};
