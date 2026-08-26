'use strict';

/*
 * Inbox tools — live-office plan §3.1, Phase 3 "Scenario A honest queue".
 *
 *   inbox_count {role?}            cheap pending counts for charter checkpoints
 *   inbox_list  {role?, limit?}    oldest-first pending message_posted items
 *   inbox_reply {reply_to, text, as_role?}
 *                                  ONE answer per message — first answer wins
 *                                  under the office lock; a second reply is
 *                                  REJECTED honestly ("already answered by …")
 *
 * All semantics live in live/inbox-core.js (shared with GET /api/inbox and
 * POST /api/message). Replies append message_answered events; the post-append
 * hook refreshes mirrors automatically. The office NEVER simulates answers.
 */

const store = require('../store');
const inbox = require('../live/inbox-core');

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
];

module.exports = { defs };
