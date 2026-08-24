'use strict';

/*
 * VCNP Office store — ledger/state engine.
 *
 * Blueprint: plans/vcnp-vibe-office-plan.md §6 (shared state + concurrency
 * model items 1-5) and skills/core-board-ops/SKILL.md (ledger-first write
 * procedure). ZERO npm dependencies — Node.js >= 20 stdlib only.
 *
 * Concurrency model (plan §6.2):
 *   1. Ledger-first: office/events.log.jsonl is the ONLY source of truth.
 *      Appends are guarded by an exclusive-create lock (office/.lock,
 *      O_EXCL semantics) with retry/backoff and stale-lock takeover after
 *      5 s; the write itself is an O_APPEND-style fs.appendFileSync.
 *   2. Derived state: office/state.json is NEVER written in place — it is
 *      rebuilt from the full ledger into state.json.tmp, then ATOMICALLY
 *      renamed over the old file.
 *   3. Idempotent appends: every event carries a UUID event_id; duplicate
 *      deliveries are detected under the lock and dropped silently.
 *   4. Cross-process truth: there is NO central live view of sessions; each
 *      session's own MCP process writes util events for ITS session, and
 *      gates (task_assign) read the LATEST util event per session from the
 *      ledger — eventually consistent, by design.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';
const STALE_LOCK_MS = 5000;      // stale-lock takeover threshold (hard constraint)
const LOCK_DEADLINE_MS = 10000;  // give up acquiring the lock after 10 s

/* ------------------------------------------------------------------ */
/* Workspace resolution                                                */
/* ------------------------------------------------------------------ */

function resolveWorkspace() {
  const candidates = [];
  if (process.env.VCNP_OFFICE_WORKSPACE) {
    candidates.push(path.resolve(process.env.VCNP_OFFICE_WORKSPACE));
  }
  // Walk up from this file: src -> vcnp-office-mcp -> mcp -> <workspace>
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    dir = path.dirname(dir);
    candidates.push(dir);
  }
  candidates.push(process.cwd());
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'office'))) return c;
    } catch (_) { /* unreadable candidate — skip */ }
  }
  return path.resolve(__dirname, '..', '..', '..');
}

const WORKSPACE = resolveWorkspace();
const OFFICE_DIR = path.join(WORKSPACE, 'office');
const LEDGER_FILE = path.join(OFFICE_DIR, 'events.log.jsonl');
const STATE_FILE = path.join(OFFICE_DIR, 'state.json');
const LOCK_FILE = path.join(OFFICE_DIR, '.lock');
const TELEMETRY_FILE = path.join(OFFICE_DIR, 'telemetry.jsonl');
const MODELS_FILE = path.join(OFFICE_DIR, 'models.json');
const BATCHES_DIR = path.join(OFFICE_DIR, 'batches');
const CACHE_DIR = path.join(BATCHES_DIR, '.cache');
const BOARD_FILE = path.join(OFFICE_DIR, 'BOARD.md');
const OFFICE_LIVE_FILE = path.join(OFFICE_DIR, 'office-live.json');
const ACTIVE_CONTEXT_FILE = path.join(OFFICE_DIR, 'memory-bank', 'activeContext.md');

/* ------------------------------------------------------------------ */
/* Small fs helpers                                                    */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureOfficeDir() {
  fs.mkdirSync(OFFICE_DIR, { recursive: true });
}

function ensureSubdirs() {
  ensureOfficeDir();
  fs.mkdirSync(path.join(OFFICE_DIR, 'memory-bank'), { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** Atomic write: temp file + rename (never write state in place). */
function atomicWriteText(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function atomicWriteJson(file, obj) {
  atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n');
}

/* ------------------------------------------------------------------ */
/* Exclusive-create lock (retry + stale takeover)                      */
/* ------------------------------------------------------------------ */

async function acquireLock() {
  ensureOfficeDir();
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let backoff = 20;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx'); // exclusive create — fails with EEXIST if held
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale-lock takeover: holder crashed or wedged > STALE_LOCK_MS ago.
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* someone else took it */ }
          continue;
        }
      } catch (_) { /* lock vanished — retry immediately */ }
      if (Date.now() > deadline) {
        throw new Error(`could not acquire office lock ${LOCK_FILE} within ${LOCK_DEADLINE_MS}ms`);
      }
      await sleep(backoff + Math.floor(Math.random() * 20)); // small jittered backoff
      backoff = Math.min(backoff * 2, 200);
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* already gone */ }
}

/** Run fn while holding the office lock. Releases even if fn throws. */
async function withLock(fn) {
  await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Ledger primitives                                                   */
/* ------------------------------------------------------------------ */

/** Parse the ledger, skipping blank/corrupt lines. Missing file -> []. */
function readEvents() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const out = [];
  const raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_) { /* corrupt line — skip, never crash replay */ }
  }
  return out;
}

/**
 * Append an event. Caller may pass event_id to make retries idempotent:
 * a duplicate event_id is skipped SILENTLY (returns { duplicate: true }).
 * Otherwise a fresh UUID v4 + ISO ts + schema_version are stamped.
 * MUST be called while holding the lock (see appendEvent / withLock).
 */
async function appendEventLocked(fields) {
  ensureOfficeDir();
  const eventId = fields.event_id || crypto.randomUUID();
  const seen = new Set(readEvents().map((e) => e.event_id));
  if (seen.has(eventId)) return { duplicate: true, event_id: eventId };
  const evt = { event_id: eventId, ts: new Date().toISOString(), schema_version: SCHEMA_VERSION };
  if (fields.actor !== undefined) evt.actor = fields.actor;
  if (fields.action !== undefined) evt.action = fields.action;
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'event_id' || k === 'ts' || k === 'schema_version' || k === 'actor' || k === 'action') continue;
    evt[k] = v;
  }
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(evt) + '\n'); // O_APPEND-style append
  rebuildState();
  return { duplicate: false, event: evt };
}

/** Acquire the lock, append, rebuild derived state, release. */
async function appendEvent(fields) {
  return withLock(() => appendEventLocked(fields));
}

/* ------------------------------------------------------------------ */
/* Derived state                                                       */
/* ------------------------------------------------------------------ */

/** Fold the full ledger into a fresh state object and atomically persist it. */
function rebuildState(eventsArg) {
  const events = eventsArg || readEvents();
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
  atomicWriteJson(STATE_FILE, state);
  return state;
}

function getState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return rebuildState();
  }
}

/* ------------------------------------------------------------------ */
/* Envelope validation — lightweight approximation                     */
/* ------------------------------------------------------------------ */

const ENVELOPE_STATUSES = ['done', 'blocked', 'needs_input'];
const BOARD_STATUSES = ['todo', 'doing', 'awaiting_orchestrator', 'review', 'blocked', 'done'];
const TASK_CLASSES = ['C0', 'C1', 'C2', 'C3', 'C4'];
const LEDGER_SOURCES = ['provider_usage', 'ide_export', 'estimated'];

/*
 * HONEST NOTE: skills/core-protocol/references/envelope-schema.json is a full
 * JSON Schema (oneOf over taskBrief/resultReport, if/then, additionalProperties).
 * This validator implements targeted required-field/type/enum/minItems checks
 * against that schema's contracts; it does NOT implement general JSON-Schema
 * evaluation. It rejects everything the schema rejects for these fields, but
 * full spec compliance would require a JSON-Schema library (zero-dep constraint).
 */
const SCHEMA_NOTE =
  'validation is a lightweight approximation of skills/core-protocol/references/envelope-schema.json ' +
  '(required fields / types / enums / minItems / the done->blockers if-then rule); full JSON-Schema ' +
  'evaluation is intentionally not implemented (zero-dependency constraint)';

/** Map a Result-Report status onto the board kanban status (protocol §3). */
function boardStatusForReportStatus(status) {
  if (status === 'done') return 'awaiting_orchestrator'; // written queue
  if (status === 'blocked' || status === 'needs_input') return 'blocked';
  return status;
}

/** Validate task_create input against the Task Brief contract. */
function validateTaskBriefInput(a) {
  const errs = [];
  if (typeof a.title !== 'string' || !a.title.trim()) {
    errs.push("'title' must be a non-empty string (envelope-schema.json #/taskBrief/properties/title, minLength: 1)");
  }
  if (!TASK_CLASSES.includes(a.task_class)) {
    errs.push(`'task_class' must be one of ${TASK_CLASSES.join('|')} (#/taskBrief/properties/taskClass enum)`);
  }
  if (
    !Array.isArray(a.acceptance_criteria) ||
    a.acceptance_criteria.length < 1 ||
    !a.acceptance_criteria.every((x) => typeof x === 'string' && x.trim())
  ) {
    errs.push("'acceptance_criteria' must be an array with at least 1 non-empty string (#/taskBrief/properties/acceptance_criteria, minItems: 1)");
  }
  if (!Number.isInteger(a.budget_tokens) || a.budget_tokens <= 0) {
    errs.push("'budget_tokens' must be an integer > 0 (#/taskBrief/properties/budget_tokens, type: integer, exclusiveMinimum: 0)");
  }
  if (a.assignee_role !== undefined && (typeof a.assignee_role !== 'string' || !a.assignee_role.trim())) {
    errs.push("'assignee_role' must be a non-empty string when provided");
  }
  if (a.priority !== undefined && !['low', 'medium', 'high', 'critical'].includes(a.priority)) {
    errs.push("'priority' must be one of low|medium|high|critical (#/taskBrief/properties/priority enum)");
  }
  if (a.context_refs !== undefined && !(Array.isArray(a.context_refs) && a.context_refs.every((x) => typeof x === 'string' && x))) {
    errs.push("'context_refs' must be an array of non-empty strings (#/taskBrief/properties/context_refs)");
  }
  if (a.definition_of_done !== undefined && (typeof a.definition_of_done !== 'string' || !a.definition_of_done.trim())) {
    errs.push("'definition_of_done' must be a non-empty string (#/taskBrief/properties/definition_of_done, minLength: 1)");
  }
  return errs;
}

/**
 * Validate a Result-Report-shaped task_update patch against the resultReport
 * contract. Unknown keys are rejected (additionalProperties: false).
 */
function validateResultReportPatch(patch) {
  const errs = [];
  const allowed = ['status', 'progress_percent', 'artifacts', 'blockers', 'notes_for_qa', 'board_status'];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) {
      errs.push(`'${k}' is not allowed in a Result Report update (envelope-schema.json #/resultReport, additionalProperties: false)`);
    }
  }
  if (patch.status !== undefined && !ENVELOPE_STATUSES.includes(patch.status) && !BOARD_STATUSES.includes(patch.status)) {
    errs.push(`'status' must be one of ${ENVELOPE_STATUSES.join('|')} (Result Report) or a board status ${BOARD_STATUSES.join('|')} (#/resultReport/properties/status enum)`);
  }
  if (patch.progress_percent !== undefined && (!Number.isInteger(patch.progress_percent) || patch.progress_percent < 0 || patch.progress_percent > 100)) {
    errs.push("'progress_percent' must be an integer between 0 and 100 (#/resultReport/properties/progress_percent, minimum: 0, maximum: 100)");
  }
  if (patch.artifacts !== undefined && !(Array.isArray(patch.artifacts) && patch.artifacts.every((x) => typeof x === 'string' && x))) {
    errs.push("'artifacts' must be an array of non-empty strings (#/resultReport/properties/artifacts)");
  }
  if (patch.blockers !== undefined && !(Array.isArray(patch.blockers) && patch.blockers.every((x) => typeof x === 'string'))) {
    errs.push("'blockers' must be an array of strings (#/resultReport/properties/blockers)");
  }
  if (patch.notes_for_qa !== undefined && typeof patch.notes_for_qa !== 'string') {
    errs.push("'notes_for_qa' must be a string (#/resultReport/properties/notes_for_qa)");
  }
  if (patch.board_status !== undefined && !BOARD_STATUSES.includes(patch.board_status)) {
    errs.push(`'board_status' must be one of ${BOARD_STATUSES.join('|')} (board management vocabulary)`);
  }
  if (patch.status === 'done' && Array.isArray(patch.blockers) && patch.blockers.length > 0) {
    errs.push("'blockers' must be EMPTY when status='done' (envelope-schema.json #/resultReport if/then: status done -> blockers maxItems: 0)");
  }
  return errs;
}

/* ------------------------------------------------------------------ */
/* Domain operations                                                   */
/* ------------------------------------------------------------------ */

function nextTaskId(state) {
  let max = 0;
  for (const t of state.tasks || []) {
    const m = /^T-(\d+)$/.exec(t.task_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'T-' + String(max + 1).padStart(3, '0');
}

async function bootstrap(project_name, goal) {
  if (typeof project_name !== 'string' || !project_name.trim()) {
    return { ok: false, error: "'project_name' must be a non-empty string" };
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    return { ok: false, error: "'goal' must be a non-empty string" };
  }
  const r = await appendEvent({ actor: 'orchestrator', action: 'board_init', project_name, goal });
  const state = getState();
  return { ok: true, project: state.project, event_id: r.event.event_id };
}

async function taskCreate(args) {
  const errs = validateTaskBriefInput(args);
  if (errs.length) {
    return { ok: false, error: 'invalid Task Brief envelope', reasons: errs, note: SCHEMA_NOTE };
  }
  const state = getState();
  const task_id = nextTaskId(state);
  const r = await appendEvent({
    actor: 'orchestrator',
    action: 'task_created',
    task_id,
    title: args.title,
    assignee_role: args.assignee_role || null,
    task_class: args.task_class,
    acceptance_criteria: args.acceptance_criteria,
    budget_tokens: args.budget_tokens,
    context_refs: args.context_refs || [],
    priority: args.priority || null,
    definition_of_done: args.definition_of_done || null,
  });
  const task = getState().tasks.find((t) => t.task_id === task_id);
  return { ok: true, task_id, task };
}

async function taskUpdate(task_id, patch) {
  const state = getState();
  const task = state.tasks.find((t) => t.task_id === task_id);
  if (!task) {
    return { ok: false, error: `unknown task_id '${task_id}' — board has: ${state.tasks.map((t) => t.task_id).join(', ') || '(no tasks)'}` };
  }
  const errs = validateResultReportPatch(patch);
  if (errs.length) {
    return { ok: false, error: `invalid Result Report envelope for ${task_id}`, reasons: errs, note: SCHEMA_NOTE };
  }
  const boardStatus =
    patch.board_status ||
    (patch.status && ENVELOPE_STATUSES.includes(patch.status) ? boardStatusForReportStatus(patch.status) : undefined);
  const r = await appendEvent({
    actor: 'executor',
    action: 'task_updated',
    task_id,
    status: patch.status,
    board_status: boardStatus,
    progress_percent: patch.progress_percent,
    artifacts: patch.artifacts,
    blockers: patch.blockers,
    notes_for_qa: patch.notes_for_qa,
  });
  const updated = getState().tasks.find((t) => t.task_id === task_id);
  return { ok: true, task_id, board_status: updated.status, progress_percent: updated.progress_percent, event_id: r.event.event_id };
}

/*
 * Util-related ledger events for a session (plan §6.2 item 5, §10 item 4):
 * 'compaction_done' plus any 'util_*' snapshot the session's own MCP process
 * writes while it works. Freshness rule: a compaction_done counts ONLY while
 * it is the LATEST util-related event for that session.
 */
function utilEventsForSession(events, sessionId) {
  return events.filter(
    (e) => e.session_id === sessionId && (e.action === 'compaction_done' || String(e.action || '').startsWith('util_'))
  );
}

async function taskAssign(task_id, role, session_id) {
  const state = getState();
  const task = state.tasks.find((t) => t.task_id === task_id);
  if (!task) {
    return { ok: false, error: `unknown task_id '${task_id}'` };
  }
  if (typeof role !== 'string' || !role.trim()) {
    return { ok: false, error: "'role' must be a non-empty string" };
  }
  const events = readEvents();
  let sid = session_id;
  if (!sid) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.actor === role && ev.session_id) { sid = ev.session_id; break; }
    }
  }
  if (!sid) {
    return {
      ok: false,
      error: `assignment refused: no session with utilization history found for role '${role}'`,
      reasons: [
        `no ledger event carries actor='${role}' together with a session_id`,
        "pass session_id explicitly, or have the target session emit a util event first (event_log with session_id)",
      ],
      gate: 'compaction_freshness',
    };
  }
  const utilEvs = utilEventsForSession(events, sid);
  if (utilEvs.length === 0) {
    return {
      ok: false,
      error: `assignment refused: session '${sid}' has NO util-related events`,
      reasons: [
        'gate requires a valid compaction_done for the target session (plan §10 item 4)',
        'the session must call compaction_ack(session_id, util_after) after its Librarian hand-off',
      ],
      gate: 'compaction_freshness',
    };
  }
  const latest = utilEvs[utilEvs.length - 1];
  if (latest.action !== 'compaction_done') {
    return {
      ok: false,
      error: `assignment refused: freshness rule violated for session '${sid}'`,
      reasons: [
        `latest util-related event is '${latest.action}' at ${latest.ts}, not 'compaction_done'`,
        "a compaction_done counts ONLY while it is the LATEST util-related event for the session (plan §6.2 item 5)",
        'the session must perform its Librarian hand-off and call compaction_ack again',
      ],
      gate: 'compaction_freshness',
    };
  }
  const r = await appendEvent({
    actor: 'orchestrator',
    action: 'task_assigned',
    task_id,
    role,
    session_id: sid,
  });
  return { ok: true, task_id, role, session_id: sid, board_status: 'doing', event_id: r.event.event_id };
}

/** Compact snapshot for any session (cheap to call, event-driven drains). */
function boardRead() {
  const state = rebuildState();
  const byStatus = {};
  for (const s of BOARD_STATUSES) byStatus[s] = 0;
  for (const t of state.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const queue = state.tasks
    .filter((t) => t.status === 'awaiting_orchestrator')
    .map((t) => ({ task_id: t.task_id, title: t.title, assignee_role: t.assignee_role, progress_percent: t.progress_percent }));
  return {
    ok: true,
    project: state.project,
    counts: { total: state.tasks.length, by_status: byStatus },
    queue_awaiting_orchestrator: queue,
    tasks: state.tasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      status: t.status,
      assignee_role: t.assignee_role,
      task_class: t.task_class,
      budget_tokens: t.budget_tokens,
      progress_percent: t.progress_percent,
      artifacts_count: t.artifacts.length,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Telemetry + model catalog                                           */
/* ------------------------------------------------------------------ */

function appendTelemetryLine(line) {
  ensureOfficeDir();
  fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(line) + '\n');
}

function readTelemetry() {
  if (!fs.existsSync(TELEMETRY_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(TELEMETRY_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_) { /* skip corrupt line */ }
  }
  return out;
}

/** Built-in default catalog (plan §7 example) used when office/models.json is absent. */
const DEFAULT_CATALOG = {
  providers: [
    { id: 'openrouter', base_url_env: 'OPENROUTER_BASE_URL', key_env: 'OPENROUTER_API_KEY', kind: 'openai-compatible' },
    { id: 'local', base_url_env: 'OLLAMA_BASE_URL', key_env: null, kind: 'openai-compatible' },
  ],
  models: [
    { id: 'economy-fast', provider: 'openrouter', model_ref: 'openrouter/economy-fast', in_price: 0.05, out_price: 0.2, ctx: 128000, speed_class: 'fast', quality_tier: 1 },
    { id: 'standard', provider: 'openrouter', model_ref: 'openrouter/standard', in_price: 0.5, out_price: 1.5, ctx: 200000, speed_class: 'medium', quality_tier: 2 },
    { id: 'premium', provider: 'openrouter', model_ref: 'openrouter/premium', in_price: 3.0, out_price: 15.0, ctx: 200000, speed_class: 'slow', quality_tier: 3 },
    { id: 'local-free', provider: 'local', model_ref: 'local/free', in_price: 0, out_price: 0, ctx: 32000, speed_class: 'medium', quality_tier: 1 },
  ],
};

/** Load office/models.json if present, else the built-in defaults. */
function loadCatalog() {
  try {
    const cat = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    if (cat && Array.isArray(cat.models)) return { ...cat, source: 'office/models.json' };
  } catch (_) { /* absent or corrupt -> defaults */ }
  return { ...DEFAULT_CATALOG, source: 'built-in defaults (office/models.json absent)' };
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_NOTE,
  WORKSPACE,
  OFFICE_DIR,
  LEDGER_FILE,
  STATE_FILE,
  LOCK_FILE,
  TELEMETRY_FILE,
  MODELS_FILE,
  BATCHES_DIR,
  CACHE_DIR,
  BOARD_FILE,
  OFFICE_LIVE_FILE,
  ACTIVE_CONTEXT_FILE,
  ENVELOPE_STATUSES,
  BOARD_STATUSES,
  TASK_CLASSES,
  LEDGER_SOURCES,
  ensureOfficeDir,
  ensureSubdirs,
  atomicWriteText,
  atomicWriteJson,
  withLock,
  readEvents,
  appendEvent,
  appendEventLocked,
  rebuildState,
  getState,
  boardStatusForReportStatus,
  validateTaskBriefInput,
  validateResultReportPatch,
  bootstrap,
  taskCreate,
  taskUpdate,
  taskAssign,
  boardRead,
  appendTelemetryLine,
  readTelemetry,
  loadCatalog,
};
