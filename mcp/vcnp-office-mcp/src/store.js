'use strict';

/*
 * VCNP Office store — workspace paths, domain operations, telemetry/catalog.
 * Facade over lib/ modules (lock / ledger-engine / envelope); the public
 * export surface is unchanged, so tools/*.js keep working untouched.
 *
 * Blueprint: plans/vcnp-vibe-office-plan.md §6 (shared state + concurrency
 * model items 1-5) and skills/core-board-ops/SKILL.md (ledger-first write
 * procedure). ZERO npm dependencies — Node.js >= 20 stdlib only.
 *
 * Concurrency model (plan §6.2):
 *   1. Ledger-first: office/events.log.jsonl is the ONLY source of truth.
 *      Appends are guarded by an exclusive-create lock (office/.lock) with
 *      retry/backoff, heartbeat-refreshed stale takeover and dead-holder
 *      fast takeover (lib/lock.js).
 *   2. Derived state: office/state.json is NEVER written in place — temp
 *      file + atomic rename only (lib/ledger-engine.js).
 *   3. Idempotent appends: duplicate event_id deliveries are dropped under
 *      the lock.
 *   4. Cross-process truth: no central live view; gates read the LATEST
 *      util event per session from the ledger — eventually consistent.
 *
 * Race-safety notes (review findings 1 & 10 fixed here):
 *   - Task IDs are allocated INSIDE the lock from a fresh fold, so two
 *     concurrent task_create calls can never both receive T-001.
 *   - Domain ops return values derived from their own locked snapshot /
 *     arguments instead of re-reading shared state after the append, so a
 *     concurrent writer can never make a response describe another task.
 */

const fs = require('fs');
const path = require('path');

const lockLib = require('./lib/lock');
const envelope = require('./lib/envelope');
const { createLedgerEngine } = require('./lib/ledger-engine');

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
const MIRRORS_STAMP_FILE = path.join(OFFICE_DIR, '.mirrors-stamp');
const TELEMETRY_FILE = path.join(OFFICE_DIR, 'telemetry.jsonl');
const MODELS_FILE = path.join(OFFICE_DIR, 'models.json');
const BATCHES_DIR = path.join(OFFICE_DIR, 'batches');
const CACHE_DIR = path.join(BATCHES_DIR, '.cache');
const BOARD_FILE = path.join(OFFICE_DIR, 'BOARD.md');
const OFFICE_LIVE_FILE = path.join(OFFICE_DIR, 'office-live.json');
const ACTIVE_CONTEXT_FILE = path.join(OFFICE_DIR, 'memory-bank', 'activeContext.md');

const engine = createLedgerEngine({ officeDir: OFFICE_DIR, ledgerFile: LEDGER_FILE, stateFile: STATE_FILE });

/* ------------------------------------------------------------------ */
/* Re-exported constants + primitives (stable facade surface)          */
/* ------------------------------------------------------------------ */

const SCHEMA_VERSION = engine.SCHEMA_VERSION;
const {
  ENVELOPE_STATUSES,
  BOARD_STATUSES,
  TASK_CLASSES,
  LEDGER_SOURCES,
  SCHEMA_NOTE,
  boardStatusForReportStatus,
  validateTaskBriefInput,
  validateResultReportPatch,
} = envelope;

const ensureOfficeDir = engine.ensureOfficeDir;

function ensureSubdirs() {
  ensureOfficeDir();
  fs.mkdirSync(path.join(OFFICE_DIR, 'memory-bank'), { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const atomicWriteText = engine.atomicWriteText;
const atomicWriteJson = engine.atomicWriteJson;
const readEvents = engine.readEvents;
const rebuildState = engine.rebuildState;
const getState = engine.getState;
const nextTaskId = engine.nextTaskId;
const ledgerStamp = engine.ledgerStamp;

/* ------------------------------------------------------------------ */
/* Post-append mirror hooks (live-office plan §4.1a/D2)                */
/* ------------------------------------------------------------------ */

const postAppendHooks = [];
let appendDirty = false;
let mirrorsHookEnsured = false;

/**
 * Register fn to run after successful non-duplicate appends at the END of
 * the current withLock critical section — while the office lock is STILL
 * HELD. fn receives ({ events, state }) and MUST NOT acquire the office
 * lock itself: lib/lock.js has no re-entrancy (same-PID reacquire is
 * excluded), so a nested withLock would spin into its 10 s deadline.
 */
function registerPostAppendHook(fn) {
  if (typeof fn === 'function' && !postAppendHooks.includes(fn)) postAppendHooks.push(fn);
}

/**
 * Wrapped engine primitive: marks the locked section dirty on a REAL append.
 * Duplicate event_id deliveries stay silent → no mirror regen (plan §10).
 */
async function appendEventLocked(fields, opts) {
  const r = await engine.appendEventLocked(fields, opts);
  if (!r.duplicate) appendDirty = true;
  return r;
}

/** Load src/hooks/mirrors.js once, lazily (runtime require — cycle-safe). */
function ensureMirrorsHook() {
  if (mirrorsHookEnsured) return;
  mirrorsHookEnsured = true;
  try { require('./hooks/mirrors').register(); } catch (_) { /* mirrors stay manual */ }
}

/**
 * Flush queued hooks once per lock section, UNDER the lock, after fn
 * settled (finally: even an op that appended and then threw still refreshes
 * the mirrors). Best-effort: a hook failure never fails the ledger write
 * that already succeeded, nor masks the caller's own exception.
 */
async function flushPostAppendHooks() {
  if (!appendDirty) return;
  appendDirty = false;
  try { ensureMirrorsHook(); } catch (_) { /* ignore */ }
  if (postAppendHooks.length === 0) return;
  let snapshot;
  try {
    snapshot = { events: readEvents(), state: engine.foldState() };
  } catch (_) {
    return;
  }
  for (const hook of postAppendHooks) {
    try {
      await hook(snapshot);
    } catch (err) {
      process.stderr.write(`[vcnp-office-mcp] post-append hook failed: ${(err && err.message) || err}\n`);
    }
  }
}

/**
 * Acquire the office lock, run fn, flush post-append hooks (still under the
 * lock), always release.
 */
function withLock(fn) {
  return lockLib.withLock(LOCK_FILE, async () => {
    try {
      return await fn();
    } finally {
      await flushPostAppendHooks();
    }
  });
}

/** Acquire the lock, append, rebuild derived state, release. */
async function appendEvent(fields) {
  return withLock(() => appendEventLocked(fields));
}

/* ------------------------------------------------------------------ */
/* Domain operations                                                   */
/* ------------------------------------------------------------------ */

async function bootstrap(project_name, goal) {
  if (typeof project_name !== 'string' || !project_name.trim()) {
    return { ok: false, error: "'project_name' must be a non-empty string" };
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    return { ok: false, error: "'goal' must be a non-empty string" };
  }
  return withLock(async () => {
    const events = readEvents();
    const before = engine.stateFromEvents(events);
    const r = await appendEventLocked({ actor: 'orchestrator', action: 'board_init', project_name, goal }, { events });
    return {
      ok: true,
      project: { name: project_name, goal, overall_progress: before.project.overall_progress },
      event_id: r.event.event_id,
    };
  });
}

async function taskCreate(args) {
  const errs = validateTaskBriefInput(args);
  if (errs.length) {
    return { ok: false, error: 'invalid Task Brief envelope', reasons: errs, note: SCHEMA_NOTE };
  }
  return withLock(async () => {
    const events = readEvents();
    const state = engine.stateFromEvents(events);
    const task_id = nextTaskId(state); // INSIDE the lock — race-free (finding 1)
    const r = await appendEventLocked({
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
    }, { events });
    if (r.duplicate) return { ok: false, error: `duplicate task_created event ${r.event_id}` };
    // Deterministic response built from OUR request + OUR event timestamp —
    // never re-reads shared state (finding 10).
    const ts = r.event.ts;
    const task = {
      task_id,
      title: args.title,
      assignee_role: args.assignee_role || null,
      task_class: args.task_class,
      budget_tokens: args.budget_tokens,
      acceptance_criteria: args.acceptance_criteria.slice(),
      context_refs: (args.context_refs || []).slice(),
      priority: args.priority || null,
      definition_of_done: args.definition_of_done || null,
      status: 'todo',
      progress_percent: 0,
      artifacts: [],
      blockers: [],
      notes_for_qa: '',
      created_ts: ts,
      updated_ts: ts,
      reports: [],
    };
    return { ok: true, task_id, task };
  });
}

async function taskUpdate(task_id, patch) {
  return withLock(async () => {
    const events = readEvents();
    const state = engine.stateFromEvents(events);
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
    const r = await appendEventLocked({
      actor: 'executor',
      action: 'task_updated',
      task_id,
      status: patch.status,
      board_status: boardStatus,
      progress_percent: patch.progress_percent,
      artifacts: patch.artifacts,
      blockers: patch.blockers,
      notes_for_qa: patch.notes_for_qa,
    }, { events });
    if (r.duplicate) return { ok: false, error: `duplicate task_updated event ${r.event_id}` };
    return {
      ok: true,
      task_id,
      board_status: boardStatus || task.status,
      progress_percent: typeof patch.progress_percent === 'number' ? patch.progress_percent : task.progress_percent,
      event_id: r.event.event_id,
    };
  });
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
  return withLock(async () => {
    const events = readEvents();
    const state = engine.stateFromEvents(events);
    const task = state.tasks.find((t) => t.task_id === task_id);
    if (!task) {
      return { ok: false, error: `unknown task_id '${task_id}'` };
    }
    if (typeof role !== 'string' || !role.trim()) {
      return { ok: false, error: "'role' must be a non-empty string" };
    }
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
    const r = await appendEventLocked({
      actor: 'orchestrator',
      action: 'task_assigned',
      task_id,
      role,
      session_id: sid,
    }, { events });
    if (r.duplicate) return { ok: false, error: `duplicate task_assigned event ${r.event_id}` };
    return { ok: true, task_id, role, session_id: sid, board_status: 'doing', event_id: r.event.event_id };
  });
}

/** Compact snapshot for any session (cheap to call, side-effect free). */
function boardRead() {
  const state = engine.foldState();
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
  MIRRORS_STAMP_FILE,
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
  registerPostAppendHook,
  ledgerStamp,
  readEvents,
  appendEvent,
  appendEventLocked,
  rebuildState,
  getState,
  stateFromEvents: engine.stateFromEvents,
  foldState: engine.foldState,
  nextTaskId,
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
