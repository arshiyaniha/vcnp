'use strict';

/*
 * Ledger/state engine (plan §6.2 items 1-3) — zero dependencies.
 *
 *   1. Ledger-first: events.log.jsonl is the ONLY source of truth. Appends
 *      MUST happen under the office lock (see lib/lock.js).
 *   2. Derived state: state.json is NEVER written in place — temp file +
 *      atomic rename.
 *   3. Idempotent appends: duplicate event_id deliveries are dropped.
 *
 * Performance notes (review finding: "replay runs ~3x per write"):
 *   - appendEventLocked accepts { events } so a caller that already replayed
 *     the ledger under the lock reuses that array — one disk read per write.
 *   - readEvents() memoizes the parsed ledger keyed by size+mtime, so
 *     repeated reads within/across calls skip re-parsing unchanged files.
 *   - foldState() memoizes the folded state the same way; boardRead() no
 *     longer rewrites state.json on every read (reads are side-effect free).
 *   Returned event arrays must be treated as IMMUTABLE by callers.
 */

const fs = require('fs');
const crypto = require('crypto');
const { boardStatusForReportStatus } = require('./envelope');

const SCHEMA_VERSION = '1.0';

function createLedgerEngine(p) {
  const { officeDir, ledgerFile, stateFile } = p;

  const ensureOfficeDir = () => fs.mkdirSync(officeDir, { recursive: true });

  /** Atomic write: temp file + rename (never write state in place). */
  function atomicWriteText(file, text) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  function atomicWriteJson(file, obj) {
    atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n');
  }

  /* ---------------- ledger reading (memoized) ---------------- */

  let readCache = { stamp: null, events: [] };

  function ledgerStamp() {
    try {
      const st = fs.statSync(ledgerFile);
      return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch (_) {
      return null; // missing ledger
    }
  }

  /** Parse the ledger, skipping blank/corrupt lines. Missing file -> []. */
  function readEvents() {
    const stamp = ledgerStamp();
    if (stamp !== null && readCache.stamp === stamp) return readCache.events;
    const out = [];
    if (stamp !== null) {
      for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === 'object') out.push(obj);
        } catch (_) { /* corrupt line — skip, never crash replay */ }
      }
    }
    readCache = { stamp, events: out };
    return out;
  }

  /* ---------------- pure fold: events -> state ---------------- */

  function stateFromEvents(events) {
    const state = {
      schema_version: SCHEMA_VERSION,
      project: { name: null, goal: null, overall_progress: 0 },
      tasks: [],
      events_count: events.length,
    };
    const byId = new Map();
    for (const ev of events) {
      if (ev.action === 'project_bootstrapped' || ev.action === 'board_init') {
        if (ev.project_name) state.project.name = ev.project_name;
        if (ev.goal) state.project.goal = ev.goal;
      } else if (ev.action === 'task_created') {
        const task = {
          task_id: ev.task_id,
          title: ev.title,
          assignee_role: ev.assignee_role || null,
          task_class: ev.task_class || null,
          budget_tokens: ev.budget_tokens || null,
          acceptance_criteria: ev.acceptance_criteria || [],
          context_refs: ev.context_refs || [],
          priority: ev.priority || null,
          definition_of_done: ev.definition_of_done || null,
          status: 'todo',
          progress_percent: 0,
          artifacts: [],
          blockers: [],
          notes_for_qa: '',
          created_ts: ev.ts,
          updated_ts: ev.ts,
          reports: [],
        };
        byId.set(ev.task_id, task);
        state.tasks.push(task);
      } else if (ev.action === 'task_updated') {
        const t = byId.get(ev.task_id);
        if (!t) continue;
        if (ev.board_status) t.status = ev.board_status;
        else if (ev.status) t.status = boardStatusForReportStatus(ev.status);
        if (typeof ev.progress_percent === 'number') t.progress_percent = ev.progress_percent;
        if (Array.isArray(ev.artifacts)) {
          for (const a of ev.artifacts) if (!t.artifacts.includes(a)) t.artifacts.push(a);
        }
        if (Array.isArray(ev.blockers)) t.blockers = ev.blockers.slice();
        if (typeof ev.notes_for_qa === 'string') t.notes_for_qa = ev.notes_for_qa;
        t.updated_ts = ev.ts;
        t.reports.push({ ts: ev.ts, status: ev.status || null, progress_percent: ev.progress_percent ?? null });
      } else if (ev.action === 'task_assigned') {
        const t = byId.get(ev.task_id);
        if (!t) continue;
        if (ev.role) t.assignee_role = ev.role;
        if (ev.session_id) t.assignee_session = ev.session_id;
        t.status = 'doing';
        t.updated_ts = ev.ts;
      }
    }
    const total = state.tasks.length;
    state.project.overall_progress = total
      ? Math.round(state.tasks.reduce((s, t) => s + (t.progress_percent || 0), 0) / total)
      : 0;
    return state;
  }

  let foldCache = { stamp: null, state: null };

  /** Folded current state from DISK truth (memoized). Never persists. */
  function foldState() {
    const stamp = ledgerStamp();
    if (stamp !== null && foldCache.stamp === stamp && foldCache.state) {
      return structuredClone(foldCache.state);
    }
    const state = stateFromEvents(readEvents());
    foldCache = { stamp, state };
    return structuredClone(state);
  }

  /**
   * Fold + atomically persist state.json.
   * With eventsArg (caller-supplied, MUST already include freshly appended
   * events) the fold is computed directly; the memo cache is NOT updated from
   * caller arrays to avoid caching a view that could miss concurrent appends.
   */
  function rebuildState(eventsArg) {
    if (eventsArg) {
      const state = stateFromEvents(eventsArg);
      atomicWriteJson(stateFile, state);
      return state;
    }
    const state = foldState();
    atomicWriteJson(stateFile, state);
    return state;
  }

  function getState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (_) {
      return rebuildState();
    }
  }

  /* ---------------- append primitives ---------------- */

  /**
   * Append an event. Caller may pass event_id for idempotent retries:
   * a duplicate event_id is skipped SILENTLY ({ duplicate: true }).
   * opts.events: pre-read ledger array (same lock scope) — avoids a second
   * full read. MUST be called while holding the office lock.
   */
  async function appendEventLocked(fields, opts) {
    ensureOfficeDir();
    const eventId = fields.event_id || crypto.randomUUID();
    const pre = (opts && Array.isArray(opts.events)) ? opts.events : readEvents();
    const seen = new Set(pre.map((e) => e.event_id));
    if (seen.has(eventId)) return { duplicate: true, event_id: eventId };
    const evt = { event_id: eventId, ts: new Date().toISOString(), schema_version: SCHEMA_VERSION };
    if (fields.actor !== undefined) evt.actor = fields.actor;
    if (fields.action !== undefined) evt.action = fields.action;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'event_id' || k === 'ts' || k === 'schema_version' || k === 'actor' || k === 'action') continue;
      evt[k] = v;
    }
    fs.appendFileSync(ledgerFile, JSON.stringify(evt) + '\n'); // O_APPEND-style append
    rebuildState(pre.concat([evt]));
    return { duplicate: false, event: evt };
  }

  return {
    SCHEMA_VERSION,
    ensureOfficeDir,
    atomicWriteText,
    atomicWriteJson,
    ledgerStamp,
    readEvents,
    stateFromEvents,
    foldState,
    rebuildState,
    getState,
    nextTaskId,
    appendEventLocked,
  };
}

/** Next free T-NNN id given a folded state. Caller MUST hold the lock. */
function nextTaskId(state) {
  let max = 0;
  for (const t of state.tasks || []) {
    const m = /^T-(\d+)$/.exec(t.task_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'T-' + String(max + 1).padStart(3, '0');
}

module.exports = { createLedgerEngine, nextTaskId, SCHEMA_VERSION };
