'use strict';

/*
 * live/compose.js — ONE payload builder (live-office plan §1.4, Phase 2).
 *
 * Builds the single JSON payload served by GET /api/data and pushed over
 * GET /api/stream (SSE `payload` events). Field conventions follow the
 * existing `window.VCNP_DATA` mirror (tools/report.js writeDashboardData)
 * so current dashboards consume the payload unchanged:
 *
 *   state         — folded board state (same shape as dashboard-data.js .state)
 *   live          — raw per-role signals (report.deriveOfficeLive; same shape
 *                   as dashboard-data.js .live)
 *   generated_at  — ISO stamp (VCNP_DATA convention)
 *   recent_events — last 25 events as { ts, actor, action, task_id }
 *
 * plus the design-doc additions (§1.4):
 *   schema_version, generated_ts, chat, meetings, phone, server
 *
 * Phase 2 scope: chat / inbox / meetings / phone projections are EMPTY but
 * shape-visible (§1.4) — real projections arrive with Phases 3-5. Nothing
 * synthetic is ever emitted (no fake activity).
 *
 * Reads go exclusively through the memoized engine caches (one disk read per
 * update, plan §1.4 rules); this module NEVER writes.
 */

const store = require('../store');
const report = require('../tools/report');
const inbox = require('./inbox-core');

const RECENT_EVENTS_LIMIT = 25; // parity with tools/report.js

/**
 * Build the composed payload. opts.port is stamped into server.port
 * (null when omitted — e.g. embedded/unit use).
 */
function build(opts) {
  const port = opts && Number.isFinite(opts.port) ? opts.port : null;
  const events = store.readEvents(); // memoized by size+mtime (lib/ledger-engine.js)
  const state = store.foldState();   // memoized fold of DISK truth
  const live = report.deriveOfficeLive(events);
  const recent_events = events.slice(-RECENT_EVENTS_LIMIT).map((e) => ({
    ts: e.ts,
    actor: e.actor,
    action: e.action,
    task_id: e.task_id,
  }));
  const now = new Date().toISOString();
  return {
    schema_version: store.SCHEMA_VERSION,
    generated_ts: now,
    state,
    live,
    generated_at: now,
    recent_events,
    /* Phase 3 (§1.4): REAL chat projections — threads joined server-side,
     * pending counts, and the honest session_active hint. Empty ledger ⇒
     * empty arrays / all-false hints; nothing is ever synthesized. */
    chat: {
      messages: inbox.joinThreads(events, inbox.CHAT_MESSAGES_LIMIT),
      inbox: (() => {
        const proj = inbox.projectInbox(events, {});
        return { total_pending: proj.total_pending, pending_by_role: proj.pending_by_role };
      })(),
      session_active: inbox.deriveSessionActive(events),
    },
    meetings: { active: null, recent: [] },
    phone: { recent: [] },
    server: { live: true, ledger_seq: events.length, port },
  };
}

module.exports = { build, RECENT_EVENTS_LIMIT };
