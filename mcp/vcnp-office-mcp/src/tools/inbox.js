'use strict';

/*
 * Inbox + presence tools — live-office plan §3.1.
 *
 * Phase 3 "Scenario A honest queue":
 *   inbox_count {role?}            cheap pending counts for charter checkpoints
 *   inbox_list  {role?, limit?}    oldest-first pending message_posted items
 *   inbox_reply {reply_to, text, as_role?}
 *                                  ONE answer per message — first answer wins
 *                                  under the office lock; a second reply is
 *                                  REJECTED honestly ("already answered by …")
 *
 * Phase 4 "visible work + real meetings" (§2/§7 wrappers over event_log):
 *   work_log     {action_summary, artifact_refs?, task_id?, code_ref?, as_role?}
 *   meeting_start{topic, participants, reason, task_id?, agenda_task_ids?, as_role?}
 *   meeting_end  {meeting_id?, outcome_summary?, as_role?}
 *
 * Chat semantics live in live/inbox-core.js; work/meeting semantics live in
 * live/work-core.js. All appends refresh mirrors automatically via the
 * post-append hook. The office NEVER simulates answers, work, or meetings.
 */

const store = require('../store');
const V = require('../lib/events-validate');
const inbox = require('../live/inbox-core');
const work = require('../live/work-core');

async function inboxCount(args) {
  const role = args && typeof args.role === 'string' ? args.role : undefined;
  const proj = inbox.projectInbox(store.readEvents(), { role });
  return {
    ok: true,
    total_pending: proj.total_pending,
    pending_by_role: proj.pending_by_role,
    ...(role ? { role, pending_for_role: proj.pending.length } : {}),
  };
}

async function inboxList(args) {
  const role = args && typeof args.role === 'string' ? args.role : undefined;
  let limit = args && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20;
  if (!(limit > 0)) limit = 20;
  if (limit > 200) limit = 200;
  const proj = inbox.projectInbox(store.readEvents(), { role });
  return {
    ok: true,
    count: Math.min(limit, proj.pending.length),
    total_pending: proj.total_pending,
    pending: proj.pending.slice(0, limit),
  };
}

const defs = [
  {
    name: 'inbox_count',
    description:
      'Cheap pending-inbox counts for charter checkpoint prompts (session start, after milestones, before end). ' +
      'Returns total_pending plus per-role counts of unanswered user messages (message_posted without a later ' +
      'message_answered). Read-only.',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string', description: 'restrict to one office role' } },
    },
    handler: async (args) => inboxCount(args),
    format: (r) => {
      const parts = [`Inbox: ${r.total_pending} pending`];
      if (r.role !== undefined) parts.push(`${r.pending_for_role} for '${r.role}'`);
      const byRole = Object.entries(r.pending_by_role).filter(([, n]) => n > 0);
      parts.push(byRole.length ? 'by role: ' + byRole.map(([k, n]) => `${k}=${n}`).join(', ') : 'by role: (none)');
      return parts.join(' — ');
    },
  },
  {
    name: 'inbox_list',
    description:
      'List PENDING user messages addressed to a role (oldest-first): message_id, from, text, ts, channel, event_id. ' +
      'A message stays listed until some session answers it via inbox_reply — the dashboard honestly shows ' +
      '«در انتظار نشست / awaiting session» meanwhile. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'restrict to one office role' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'default 20' },
      },
    },
    handler: async (args) => inboxList(args),
    format: (r) => {
      if (!r.pending.length) return `Inbox empty (${r.total_pending} pending overall)`;
      const lines = [`${r.count} of ${r.total_pending} pending (oldest first):`];
      for (const p of r.pending) {
        lines.push(`- [${p.message_id}] to ${p.to_role} · ${p.ts} · via ${p.channel}: ${p.text}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'inbox_reply',
    description:
      'Answer ONE pending user message. reply_to = the message_posted event_id (see inbox_list). Appends a ' +
      'message_answered ledger event with actor = as_role (default ceo). FIRST ANSWER WINS: a second reply to the ' +
      'same message is rejected ("already answered by …") — never retry or double-answer. Plain, non-technical ' +
      'language for user-facing answers (CEO duty); operational answers routed to orchestrator stay precise.',
    inputSchema: {
      type: 'object',
      properties: {
        reply_to: { type: 'string', description: "event_id of the message_posted being answered" },
        text: { type: 'string', description: 'answer text, 1..4000 chars' },
        as_role: { type: 'string', description: 'answering role, default ceo' },
      },
      required: ['reply_to', 'text'],
    },
    handler: async (args) => inbox.replyMessage(args || {}),
    format: (r) =>
      `Answered ${r.message_id} as ${r.actor} (event ${r.event_id}) — thread ${r.reply_to} closed`,
  },

  /* ---------- Phase 4: visible work + real meetings (plan §2/§7) ---------- */
  {
    name: 'work_log',
    description:
      'Log ONE meaningful unit of REAL work (plan §2 work_logged): what was actually done, with real ' +
      'workspace-relative artifact paths (no .., nothing fabricated — omit artifact_refs when a unit has none). ' +
      'actor = as_role (default executor; every role logs its own work per the charters). Optional task_id must ' +
      'reference an existing task; optional code_ref {path, lines:[from,to]} may POINT at real source lines ' +
      '(content is never copied into the ledger). Feeds the desk artifact cards on the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        action_summary: { type: 'string', description: 'what was actually done, 1..300 chars' },
        artifact_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'real workspace-relative paths touched by this unit',
        },
        task_id: { type: 'string', description: 'T-NNN the unit belongs to' },
        code_ref: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'workspace-relative file path' },
            lines: {
              type: 'array',
              items: { type: 'integer' },
              minItems: 2,
              maxItems: 2,
              description: '[from, to] 1-based line range',
            },
          },
          required: ['path', 'lines'],
          description: 'optional pointer to real source lines (no content is stored)',
        },
        as_role: { type: 'string', description: 'logging role, default executor' },
      },
      required: ['action_summary'],
    },
    handler: async (args) => work.workLog(args || {}),
    format: (r) =>
      `work_logged as ${r.actor}${r.task_id ? ` on ${r.task_id}` : ''} (event ${r.event_id}) — ${r.artifact_count} artifact ref(s)`,
  },
  {
    name: 'meeting_start',
    description:
      'Start a REAL meeting (plan §2 meeting_started): reason MUST be qa_gate|critical_task|standup|phone|explicit; ' +
      'participants = 2..9 distinct office roles; topic <=200 chars; optional task_id puts that task on the wall-screen ' +
      'agenda. actor = as_role (default orchestrator). Only ONE active meeting exists: starting while another is open ' +
      'is rejected — end it first with meeting_end. Participants walk to the meeting table on the dashboard until ' +
      'meeting_ended arrives.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'meeting topic, 1..200 chars' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 9,
          description: 'distinct office roles taking part',
        },
        reason: { type: 'string', enum: V.MEETING_REASONS, description: 'trigger per plan §7.2' },
        task_id: { type: 'string', description: 'agenda task T-NNN (wall screen shows its progress)' },
        agenda_task_ids: { type: 'array', items: { type: 'string' }, description: 'extra agenda task ids' },
        as_role: { type: 'string', description: 'calling role, default orchestrator' },
      },
      required: ['topic', 'participants', 'reason'],
    },
    handler: async (args) => work.meetingStart(args || {}),
    format: (r) =>
      `Meeting ${r.meeting_id} started (${r.reason}) — "${r.topic}" · ${r.participants.join(', ')} (event ${r.event_id})`,
  },
  {
    name: 'meeting_end',
    description:
      'End THE active meeting (plan §2 meeting_ended): releases the dashboard seats and moves the meeting to the ' +
      'recent window. Only the actor who STARTED it may end it (as_role omitted ⇒ attributed to the starter); ' +
      'meeting_id defaults to the active one and must match it otherwise. outcome_summary <=300 chars is honest ' +
      'and optional.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'mt-NNNN; defaults to THE active meeting' },
        outcome_summary: { type: 'string', description: 'what was concluded, <=300 chars' },
        as_role: { type: 'string', description: 'must equal the starter when provided' },
      },
    },
    handler: async (args) => work.meetingEnd(args || {}),
    format: (r) =>
      `Meeting ${r.meeting_id} ended by ${r.actor} after ${Math.round(r.duration_ms / 1000)}s (event ${r.event_id})`,
  },
];

module.exports = { defs };
