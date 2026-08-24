'use strict';

/*
 * Board tools — plan §6.2 table rows: board_init / task_create / task_update /
 * task_assign / board_read.
 *
 * task_update VALIDATES Result-Report-shaped updates against the required
 * fields of skills/core-protocol/references/envelope-schema.json using
 * lightweight required-field/type checks (see store.SCHEMA_NOTE for the
 * honest scope of this approximation).
 *
 * task_assign GATE (plan §6.2 item 5, §10 item 4): refuses assignment until
 * the target session has a valid compaction_done that is still the LATEST
 * util-related event for that session.
 */

const store = require('../store');

const defs = [
  {
    name: 'board_init',
    description:
      'Create or update the office project header (project_name + goal). Appends a board_init event ' +
      'to the ledger and rebuilds office/state.json.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', minLength: 1 },
        goal: { type: 'string', minLength: 1 },
      },
      required: ['project_name', 'goal'],
    },
    handler: async (args) => store.bootstrap(args.project_name, args.goal),
    format: (r) =>
      `Project initialized: "${r.project.name}"\nGoal: ${r.project.goal}\nLedger event: ${r.event_id}`,
  },
  {
    name: 'task_create',
    description:
      'Create a task on the board from Task Brief envelope fields. Validates title, task_class ' +
      '(C0-C4), acceptance_criteria (>= 1), budget_tokens (> 0 integer) against the envelope schema ' +
      '(lightweight approximation). Returns the generated task_id (T-NNN).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignee_role: { type: 'string' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
        budget_tokens: { type: 'integer', exclusiveMinimum: 0 },
        task_class: { enum: ['C0', 'C1', 'C2', 'C3', 'C4'] },
        context_refs: { type: 'array', items: { type: 'string' } },
        priority: { enum: ['low', 'medium', 'high', 'critical'] },
        definition_of_done: { type: 'string' },
      },
      required: ['title', 'assignee_role', 'acceptance_criteria', 'budget_tokens', 'task_class'],
    },
    handler: async (args) => store.taskCreate(args),
    format: (r) =>
      `Created ${r.task_id} "${r.task.title}" [${r.task.task_class}] — role: ${r.task.assignee_role}, ` +
      `budget: ${r.task.budget_tokens} tokens, criteria: ${r.task.acceptance_criteria.length}, status: ${r.task.status}`,
  },
  {
    name: 'task_update',
    description:
      'Update a task with a Result Report (Executor -> Orchestrator). Validated against the ' +
      'resultReport contract: status done|blocked|needs_input, progress_percent 0-100 integer, ' +
      'artifacts string[], blockers string[] (MUST be empty when status=done), notes_for_qa string. ' +
      'status=done moves the task to the awaiting_orchestrator written queue (protocol §3). ' +
      'board_status allows explicit kanban transitions (todo|doing|awaiting_orchestrator|review|blocked|done) ' +
      'for queue draining by the Orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { enum: [...store.ENVELOPE_STATUSES, ...store.BOARD_STATUSES] },
        progress_percent: { type: 'integer', minimum: 0, maximum: 100 },
        artifacts: { type: 'array', items: { type: 'string' } },
        blockers: { type: 'array', items: { type: 'string' } },
        notes_for_qa: { type: 'string' },
        board_status: { enum: store.BOARD_STATUSES },
      },
      required: ['task_id'],
    },
    handler: async (args) => {
      const { task_id, ...patch } = args;
      return store.taskUpdate(task_id, patch);
    },
    format: (r) =>
      `${r.task_id} updated — board status: ${r.board_status}, progress: ${r.progress_percent}% (event ${r.event_id})`,
  },
  {
    name: 'task_assign',
    description:
      'Assign a task to a role session. GATE: refused until the target session has a valid ' +
      'compaction_done that is still the LATEST util-related event for that session (freshness rule). ' +
      'session_id is resolved from the latest ledger event of the role when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        role: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['task_id', 'role'],
    },
    handler: async (args) => store.taskAssign(args.task_id, args.role, args.session_id),
    format: (r) =>
      `${r.task_id} assigned to '${r.role}' (session ${r.session_id}) — status: doing (event ${r.event_id})`,
  },
  {
    name: 'board_read',
    description:
      'Compact board snapshot rebuilt from the ledger: project header, per-status counts, the ' +
      'awaiting_orchestrator written queue, and all tasks in compact form.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => store.boardRead(),
    format: (r) => {
      const lines = [
        `Project: ${r.project.name || '(uninitialized)'} — overall progress ${r.project.overall_progress}%`,
        `Tasks: ${r.counts.total} | ` +
          Object.entries(r.counts.by_status).map(([k, v]) => `${k}:${v}`).join(' '),
      ];
      if (r.queue_awaiting_orchestrator.length) {
        lines.push('Queue (awaiting_orchestrator):');
        for (const q of r.queue_awaiting_orchestrator) {
          lines.push(`  - ${q.task_id} "${q.title}" (${q.assignee_role}, ${q.progress_percent}%)`);
        }
      }
      for (const t of r.tasks) {
        lines.push(`${t.task_id} [${t.status}] ${t.title} — ${t.assignee_role || 'unassigned'}, ${t.task_class || '?'}, ${t.progress_percent}%`);
      }
      return lines.join('\n');
    },
  },
];

module.exports = { defs };
