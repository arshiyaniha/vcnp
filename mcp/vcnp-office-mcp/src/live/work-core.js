'use strict';

/*
 * live/work-core.js — visible work + real meetings domain core
 * (live-office plan §2, §7, Phase 4). Shared by the MCP tools
 * (tools/inbox.js defs) and the composed payload (live/compose.js).
 *
 * PURE projections (no I/O):
 *   nextMeetingId(events)      mt-NNNN allocation from the event list
 *   projectMeetings(events)    { active, recent } view (§1.4/§7.2):
 *                              active = THE LAST meeting_started in ledger
 *                              order IFF it has no meeting_ended (an older
 *                              start stays PERMANENTLY displaced by a
 *                              newer one — it can never resurrect);
 *                              recent = ended meetings, newest-first window.
 *   projectWork(events, state) per-role desk contract (§7.1): current focus
 *                              task + REAL artifact refs (task artifacts
 *                              enriched by latest work_logged), deduped and
 *                              bounded. NOTHING is ever fabricated.
 *
 * WRITE ops (office lock via store.withLock; mirrors + SSE broadcast happen
 * automatically through the post-append hook and the ledger watcher):
 *   workLog({action_summary, artifact_refs?, task_id?, code_ref?, as_role?})
 *       → appends work_logged (validated; artifact_refs re-resolved against
 *         the workspace root — traversal rejected).
 *   meetingStart({topic, participants, reason, task_id?, agenda_task_ids?, as_role?})
 *       → appends meeting_started with a lock-allocated mt-NNNN id.
 *         ONE ACTIVE MEETING at a time (the payload has a single `active`
 *         slot, plan §1.4): a second start while one is open is REJECTED.
 *   meetingEnd({meeting_id?, outcome_summary?, as_role?})
 *       → appends meeting_ended for THE active meeting; only its starter
 *         actor may end it (plan §2 "same actor as start").
 */

const path = require('path');
const store = require('../store');
const report = require('../tools/report');
const V = require('../lib/events-validate');

const MEETINGS_RECENT_LIMIT = 5;  // §1.4 recent window
const DESK_ARTIFACT_LIMIT = 3;    // §7.1: up to 3 artifact chips per desk

/* ---------------- id allocation (caller MUST hold the lock) ------------- */

function nextMeetingId(events) {
  let max = 0;
  for (const ev of events) {
    if (!ev || ev.action !== 'meeting_started') continue;
    const m = /^mt-(\d+)$/.exec(String(ev.meeting_id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'mt-' + String(max + 1).padStart(4, '0');
}

/* ---------------- pure projections ---------------- */

/**
 * Meetings view (§1.4 meetings / §7.2 rules). THE active meeting is the
 * LAST meeting_started in ledger order IF AND ONLY IF it carries no
 * matching meeting_ended. An older start is PERMANENTLY DISPLACED the
 * moment a newer one lands (single-active office): it can never resurrect
 * as active after the newer meeting ends, and since the write ops can only
 * ever end THE active meeting, a displaced orphan is honestly unendable —
 * it appears in NEITHER window rather than being fabricated as open.
 * Crash-safe by construction; renderers additionally expire a long-open
 * active meeting visually («interrupted» tag).
 */
function projectMeetings(events) {
  const startById = new Map(); // meeting_id -> latest meeting_started
  const endByMeeting = new Map(); // meeting_id -> latest meeting_ended
  const seqOf = new Map(); // meeting_id -> ledger position (tie-break)
  let lastStartId = null; // meeting_id of the LAST meeting_started (ledger order)
  events.forEach((ev, i) => {
    if (!ev || typeof ev.meeting_id !== 'string') return;
    if (ev.action === 'meeting_started') {
      startById.set(ev.meeting_id, ev);
      seqOf.set(ev.meeting_id, i);
      lastStartId = ev.meeting_id;
    } else if (ev.action === 'meeting_ended') {
      endByMeeting.set(ev.meeting_id, ev);
    }
  });
  const baseOf = (meeting_id, start) => {
    const agenda_task_ids = start.task_id ? [start.task_id] : [];
    if (agenda_task_ids.length && Array.isArray(start.agenda_task_ids)) {
      // explicit agenda ids from the caller are honored too (deduped below)
      for (const id of start.agenda_task_ids) {
        if (typeof id === 'string' && !agenda_task_ids.includes(id)) agenda_task_ids.push(id);
      }
    }
    return {
      meeting_id,
      reason: start.reason || null,
      topic: typeof start.topic === 'string' ? start.topic : '',
      participants: Array.isArray(start.participants) ? start.participants.slice() : [],
      task_id: start.task_id || null,
      agenda_task_ids,
      actor: start.actor || null,
      started_ts: start.ts,
    };
  };
  let active = null;
  const lastStart = lastStartId !== null ? startById.get(lastStartId) : null;
  if (lastStart && !endByMeeting.has(lastStartId)) {
    active = { ...baseOf(lastStartId, lastStart), started_event_id: lastStart.event_id };
  }
  const recent = [];
  for (const [meeting_id, start] of startById) {
    const end = endByMeeting.get(meeting_id);
    if (!end) continue; // THE active candidate above, or a displaced orphan
    recent.push({
      ...baseOf(meeting_id, start),
      ended_ts: end.ts,
      outcome_summary: typeof end.outcome_summary === 'string' ? end.outcome_summary : null,
      ended_event_id: end.event_id,
    });
  }
  /* newest-first; ledger position breaks same-millisecond ties so the
     window order is deterministic (events are append-ordered). */
  recent.sort((a, b) =>
    (Date.parse(b.started_ts) - Date.parse(a.started_ts)) ||
    ((seqOf.get(b.meeting_id) || 0) - (seqOf.get(a.meeting_id) || 0)));
  return { active, recent: recent.slice(0, MEETINGS_RECENT_LIMIT) };
}

function normRef(ref) {
  return String(ref || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** Dedupe + bound an artifact list while keeping first-seen order. */
function dedupeRefs(refs, limit) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = normRef(ref).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normRef(ref));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Per-role desk contract (§7.1): normalize(payload).roles[r].desk equivalent,
 * exposed as payload.work.by_role[role] = {task, artifacts[], last_work_logged}.
 * Focus task = assignee's most recently updated doing task (review as
 * fallback); artifacts = that task's real refs enriched by the role's latest
 * work_logged refs — deduped, bounded to DESK_ARTIFACT_LIMIT. A role with no
 * active task but a real work_logged still gets an honest card (task:null).
 */
function projectWork(events, state) {
  const by_role = {};
  for (const r of report.ROLES) by_role[r] = null;

  const lastWork = new Map(); // actor -> latest work_logged event
  for (const ev of events) {
    if (ev && ev.action === 'work_logged' &&
        Object.prototype.hasOwnProperty.call(by_role, ev.actor)) {
      lastWork.set(ev.actor, ev);
    }
  }

  // focus task per role: doing preferred over review, then newest updated_ts
  const rank = (s) => (s === 'doing' ? 0 : 1);
  for (const t of state.tasks || []) {
    if (!t || !t.assignee_role || !Object.prototype.hasOwnProperty.call(by_role, t.assignee_role)) continue;
    if (t.status !== 'doing' && t.status !== 'review') continue;
    const cur = by_role[t.assignee_role];
    if (!cur ||
        rank(t.status) < rank(cur.status) ||
        (rank(t.status) === rank(cur.status) &&
          (Date.parse(t.updated_ts) || 0) > (Date.parse(cur.updated_ts) || 0))) {
      by_role[t.assignee_role] = t;
    }
  }

  const desks = {};
  for (const r of report.ROLES) {
    const task = by_role[r];
    const work = lastWork.get(r) || null;
    if (!task && !work) continue; // honest silence — no card at all
    const merged = [
      ...((task && Array.isArray(task.artifacts) && task.artifacts) || []),
      ...((work && Array.isArray(work.artifact_refs) && work.artifact_refs) || []),
    ];
    desks[r] = {
      task: task ? {
        task_id: task.task_id,
        title: task.title,
        status: task.status,
        progress_percent: typeof task.progress_percent === 'number' ? task.progress_percent : 0,
      } : null,
      artifacts: dedupeRefs(merged, DESK_ARTIFACT_LIMIT),
      last_work_logged: work ? {
        ts: work.ts,
        action_summary: typeof work.action_summary === 'string' ? work.action_summary : '',
        artifact_refs: Array.isArray(work.artifact_refs) ? work.artifact_refs.slice() : [],
        ...(work.code_ref ? { code_ref: work.code_ref } : {}),
      } : null,
    };
  }
  return { by_role: desks };
}

/* ---------------- write ops (locked) ---------------- */

function invalid(error, reasons) {
  return { ok: false, error, reasons };
}

/**
 * Defense-in-depth containment check: the pure validator already rejects
 * '..'/absolute refs; here every ref is ALSO resolved against the real
 * workspace root so nothing outside <workspace> can ever be referenced.
 */
function containmentReasons(refs) {
  const reasons = [];
  const root = path.resolve(store.WORKSPACE);
  for (const ref of refs || []) {
    const resolved = path.resolve(root, String(ref));
    const rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      reasons.push(`'artifact_refs' entry ${JSON.stringify(ref)} resolves outside the workspace`);
    }
  }
  return reasons;
}

/** MCP work_log / charter path. Appends work_logged (plan §2). */
async function workLog(args) {
  const input = args || {};
  const asRole = input.as_role === undefined ? 'executor' : input.as_role;
  const artifactRefs = input.artifact_refs === undefined ? [] : input.artifact_refs;
  const reasons = V.validateWorkLogged({
    task_id: input.task_id,
    action_summary: input.action_summary,
    artifact_refs: artifactRefs,
    code_ref: input.code_ref,
  });
  reasons.push(...V.validateActorRole(asRole));
  reasons.push(...containmentReasons(Array.isArray(artifactRefs) ? artifactRefs : []));
  if (reasons.length) return invalid('invalid work_log input', reasons);

  return store.withLock(async () => {
    const events = store.readEvents();
    if (input.task_id !== undefined) {
      const state = store.foldState();
      if (!state.tasks.some((t) => t.task_id === input.task_id)) {
        return invalid(`unknown task_id '${input.task_id}'`, ["'task_id' must reference a task created via task_create"]);
      }
    }
    const fields = {
      actor: asRole,
      action: 'work_logged',
      action_summary: input.action_summary,
      artifact_refs: Array.isArray(artifactRefs) ? artifactRefs.slice() : [],
    };
    if (input.task_id !== undefined) fields.task_id = input.task_id;
    if (input.code_ref !== undefined) fields.code_ref = input.code_ref;
    const r = await store.appendEventLocked(fields, { events });
    if (r.duplicate) return invalid(`duplicate work_logged event ${r.event_id}`);
    return {
      ok: true,
      event_id: r.event.event_id,
      actor: asRole,
      task_id: input.task_id ?? null,
      artifact_count: fields.artifact_refs.length,
      ts: r.event.ts,
    };
  });
}

/** MCP meeting_start. Appends meeting_started (plan §2, ONE active max). */
async function meetingStart(args) {
  const input = args || {};
  const asRole = input.as_role === undefined ? 'orchestrator' : input.as_role;
  const reasons = V.validateMeetingStarted({
    reason: input.reason,
    participants: input.participants,
    topic: input.topic,
    task_id: input.task_id,
  });
  reasons.push(...V.validateActorRole(asRole));
  if (reasons.length) return invalid('invalid meeting_start input', reasons);

  return store.withLock(async () => {
    const events = store.readEvents();
    const proj = projectMeetings(events);
    if (proj.active) {
      return {
        ok: false,
        error: `meeting already active (${proj.active.meeting_id}) — end it with meeting_end before starting another`,
        meeting_id: proj.active.meeting_id,
        started_ts: proj.active.started_ts,
      };
    }
    if (input.task_id !== undefined) {
      const state = store.foldState();
      if (!state.tasks.some((t) => t.task_id === input.task_id)) {
        return invalid(`unknown task_id '${input.task_id}'`, ["'task_id' must reference a task created via task_create"]);
      }
    }
    const meeting_id = nextMeetingId(events); // INSIDE the lock — race-free
    const fields = {
      actor: asRole,
      action: 'meeting_started',
      meeting_id,
      reason: input.reason,
      participants: input.participants.slice(),
      topic: input.topic,
    };
    if (input.task_id !== undefined) fields.task_id = input.task_id;
    if (Array.isArray(input.agenda_task_ids) && input.agenda_task_ids.length) {
      fields.agenda_task_ids = input.agenda_task_ids.filter((x) => typeof x === 'string').slice(0, 20);
    }
    const r = await store.appendEventLocked(fields, { events });
    if (r.duplicate) return invalid(`duplicate meeting_started event ${r.event_id}`);
    return {
      ok: true,
      event_id: r.event.event_id,
      meeting_id,
      reason: input.reason,
      participants: fields.participants,
      topic: input.topic,
      actor: asRole,
      ts: r.event.ts,
    };
  });
}

/**
 * MCP meeting_end. Ends THE active meeting (or the one named by meeting_id,
 * which must BE the active one). Only the starter actor may end it (§2).
 * as_role omitted ⇒ attributed honestly to the original starter.
 */
async function meetingEnd(args) {
  const input = args || {};
  const reasons = V.validateMeetingEnded({
    meeting_id: input.meeting_id === undefined ? 'mt-0000' : input.meeting_id,
    outcome_summary: input.outcome_summary,
  });
  if (reasons.length) return invalid('invalid meeting_end input', reasons);

  return store.withLock(async () => {
    const events = store.readEvents();
    const proj = projectMeetings(events);
    const activeId = proj.active ? proj.active.meeting_id : null;
    const targetId = input.meeting_id === undefined ? activeId : input.meeting_id;
    if (!activeId || targetId !== activeId) {
      return invalid(
        input.meeting_id === undefined
          ? 'no active meeting to end'
          : `meeting '${input.meeting_id}' is not the active meeting${activeId ? ` (${activeId})` : ''}`,
        ['only the LATEST meeting_started without a matching meeting_ended can be ended (plan §7.2)']
      );
    }
    const starter = proj.active.actor;
    const asRole = input.as_role === undefined ? starter : input.as_role;
    reasons.push(...V.validateActorRole(asRole));
    if (asRole !== starter) {
      return invalid(`only ${starter} (the starter) may end ${activeId}`, [
        `'as_role' must match the meeting_started actor (plan §2 "same actor as start")`,
      ]);
    }
    const fields = { actor: asRole, action: 'meeting_ended', meeting_id: activeId };
    if (input.outcome_summary !== undefined && input.outcome_summary !== null) {
      fields.outcome_summary = input.outcome_summary;
    }
    const r = await store.appendEventLocked(fields, { events });
    if (r.duplicate) return invalid(`duplicate meeting_ended event ${r.event_id}`);
    return {
      ok: true,
      event_id: r.event.event_id,
      meeting_id: activeId,
      actor: asRole,
      duration_ms: Math.max(0, Date.parse(r.event.ts) - Date.parse(proj.active.started_ts)),
      ts: r.event.ts,
    };
  });
}

module.exports = {
  MEETINGS_RECENT_LIMIT,
  DESK_ARTIFACT_LIMIT,
  nextMeetingId,
  projectMeetings,
  projectWork,
  dedupeRefs,
  workLog,
  meetingStart,
  meetingEnd,
};
