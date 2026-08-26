'use strict';

/*
 * inbox.test — Phase 3 chat loop core (live-office plan §1.4/§2/§3):
 *   I1  postMessage/replyMessage validation rejects (bad role, empty/oversized)
 *   I2  happy posts allocate unique m-NNNN ids INSIDE the lock
 *   I3  concurrent posts never collide on message_id
 *   I4  projectInbox: oldest-first pending, role filter, per-role counts
 *   I5  compose chat shape: threads joined server-side, honest empty hints
 *   I6  inbox_reply first-answer-wins (sequential)
 *   I7  inbox_reply first-answer-wins under CONCURRENCY (double-reply race)
 *   I8  unknown reply target refused honestly
 *   I9  answered thread appears joined in compose; pending counts drop
 *   I10 session_active honesty: derived ONLY from real ledger signals
 *
 * Run: node test/inbox.test.js   (temp workspace — repo office/ untouched)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('PASS: ' + name);
  } else {
    fail += 1;
    console.log('FAIL: ' + name + (extra !== undefined ? ' — ' + extra : ''));
  }
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vcnp-inbox-'));
fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
fs.writeFileSync(path.join(ws, 'office', 'events.log.jsonl'), '');
process.env.VCNP_OFFICE_WORKSPACE = ws; // MUST precede src requires

const store = require('../src/store');
const inbox = require('../src/live/inbox-core');
const compose = require('../src/live/compose');

(async () => {
  /* ---------- I1: validation rejects ---------- */
  const before = store.readEvents().length;
  const bad = [
    [() => inbox.postMessage({ to_role: 'bigboss', text: 'hi' }), 'unknown role'],
    [() => inbox.postMessage({ to_role: 'ceo', text: '' }), 'empty text'],
    [() => inbox.postMessage({ to_role: 'ceo', text: 'x'.repeat(2001) }), 'oversized text'],
    [() => inbox.postMessage({ to_role: 'ceo', text: 'x', channel: 'sms' }), 'bad channel'],
    [() => inbox.replyMessage({ reply_to: '', text: 'x' }), 'empty reply_to'],
    [() => inbox.replyMessage({ reply_to: 'evt-x', text: 'y'.repeat(4001) }), 'oversized answer'],
    [() => inbox.replyMessage({ reply_to: 'evt-x', text: 'x', as_role: 'wizard' }), 'bogus as_role'],
  ];
  for (const [fn, label] of bad) {
    const r = await fn.call(inbox);
    check('I1: rejected — ' + label, r && r.ok === false && Array.isArray(r.reasons) && r.reasons.length > 0,
      JSON.stringify(r));
  }
  check('I1: rejected inputs appended NOTHING', store.readEvents().length === before,
    String(store.readEvents().length - before));

  /* ---------- I2: happy posts, unique ids ---------- */
  const p1 = await inbox.postMessage({ to_role: 'ceo', text: 'اول' });
  const p2 = await inbox.postMessage({ to_role: 'ceo', text: 'دوم' });
  const p3 = await inbox.postMessage({ to_role: 'qa', text: 'سوم', channel: 'cli' });
  check('I2: three posts ok', p1.ok && p2.ok && p3.ok, JSON.stringify([p1, p2, p3]));
  check('I2: message_ids allocated m-0001..3 sequentially',
    [p1, p2, p3].every((p, i) => p.message_id === 'm-' + String(i + 1).padStart(4, '0')),
    JSON.stringify([p1.message_id, p2.message_id, p3.message_id]));
  check('I2: ledger holds message_posted with actor user + channel',
    store.readEvents().filter((e) => e.action === 'message_posted').length === 3 &&
    store.readEvents().some((e) => e.action === 'message_posted' && e.channel === 'cli'));

  /* ---------- I3: concurrent allocation ---------- */
  const five = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    inbox.postMessage({ to_role: 'librarian', text: 'همزمان ' + i })));
  const ids = new Set(five.map((r) => r.message_id));
  check('I3: 5 concurrent posts ALL succeed', five.every((r) => r.ok), JSON.stringify(five.map((r) => r.error)));
  check('I3: concurrent message_ids UNIQUE (lock-allocated)', ids.size === 5, JSON.stringify([...ids]));

  /* ---------- I4: projections ---------- */
  const projAll = inbox.projectInbox(store.readEvents(), {});
  check('I4: total_pending = 8 unanswered', projAll.total_pending === 8, String(projAll.total_pending));
  check('I4: pending_by_role counts (ceo=2, qa=1, librarian=5)',
    projAll.pending_by_role.ceo === 2 && projAll.pending_by_role.qa === 1 && projAll.pending_by_role.librarian === 5,
    JSON.stringify(projAll.pending_by_role));
  check('I4: pending oldest-first', projAll.pending[0].message_id === 'm-0001' &&
    projAll.pending[projAll.pending.length - 1].message_id === 'm-0008');
  const projQa = inbox.projectInbox(store.readEvents(), { role: 'qa' });
  check('I4: role filter keeps only qa items',
    projQa.pending.length === 1 && projQa.pending.every((m) => m.to_role === 'qa'));
  check('I4: pending item fields complete (message_id/from/text/ts/channel/event_id)',
    ['message_id', 'from', 'text', 'ts', 'channel', 'event_id'].every((k) => k in projAll.pending[0]));

  /* ---------- I5: compose chat shape ---------- */
  {
    const payload = compose.build({});
    check('I5: chat.messages length matches threads (8)', payload.chat.messages.length === 8);
    check('I5: thread shape per §1.4 (message_id/kind/ts/from/to_role/text/answer)',
      payload.chat.messages.every((m) => m.kind === 'message_posted' && m.from === 'user' &&
        typeof m.text === 'string' && m.answer === null));
    check('I5: compose inbox totals mirror projection',
      payload.chat.inbox.total_pending === 8 && payload.chat.inbox.pending_by_role.ceo === 2);
    check('I5: honest silence — no lifecycle/work signals ⇒ session_active all false',
      Object.values(payload.chat.session_active.by_role).every((v) => v === false) &&
      payload.chat.session_active.threshold_min > 0);
  }

  /* ---------- I6: first-answer-wins (sequential) ---------- */
  const r1 = await inbox.replyMessage({ reply_to: p1.event_id, text: 'پاسخ اول', as_role: 'ceo' });
  check('I6: first reply ok', r1.ok === true && r1.message_id === 'm-0001' && r1.actor === 'ceo', JSON.stringify(r1));
  const r2 = await inbox.replyMessage({ reply_to: p1.event_id, text: 'پاسخ تکراری', as_role: 'planner' });
  check('I6: second reply REJECTED honestly ("already answered by ceo")',
    r2.ok === false && /already answered by ceo/.test(r2.error || ''), JSON.stringify(r2));
  check('I6: exactly ONE message_answered for the thread',
    store.readEvents().filter((e) => e.action === 'message_answered' && e.reply_to === p1.event_id).length === 1);

  /* ---------- I7: concurrent double-reply ---------- */
  const both = await Promise.allSettled([
    inbox.replyMessage({ reply_to: p2.event_id, text: 'مسابقه A', as_role: 'ceo' }),
    inbox.replyMessage({ reply_to: p2.event_id, text: 'مسابقه B', as_role: 'orchestrator' }),
  ]);
  const winners = both.filter((x) => x.status === 'fulfilled' && x.value.ok === true);
  const losers = both.filter((x) => x.status === 'fulfilled' && x.value.ok === false);
  check('I7: exactly ONE concurrent reply wins', winners.length === 1 && losers.length === 1,
    JSON.stringify(both.map((x) => x.value && x.value.ok)));
  check('I7: loser told WHO answered', losers.length === 1 &&
    /already answered by (ceo|orchestrator)/.test(losers[0].value.error || ''), JSON.stringify(losers[0].value));
  check('I7: ledger keeps exactly one answer for the raced thread',
    store.readEvents().filter((e) => e.action === 'message_answered' && e.reply_to === p2.event_id).length === 1);

  /* ---------- I8: unknown target ---------- */
  const ghost = await inbox.replyMessage({ reply_to: 'no-such-event', text: 'x' });
  check('I8: unknown reply_to refused with clear error', ghost.ok === false && /unknown message/.test(ghost.error));

  /* ---------- I9: answered thread in compose ---------- */
  {
    const payload = compose.build({});
    const t1 = payload.chat.messages.find((m) => m.message_id === 'm-0001');
    const t2 = payload.chat.messages.find((m) => m.message_id === 'm-0002');
    check('I9: answered thread joined with {ts,actor,text}',
      !!t1 && t1.answer && t1.answer.actor === 'ceo' && t1.answer.text === 'پاسخ اول' && typeof t1.answer.ts === 'string',
      JSON.stringify(t1 && t1.answer));
    check('I9: raced thread shows ITS winner only',
      !!t2 && t2.answer && ['ceo', 'orchestrator'].includes(t2.answer.actor));
    check('I9: pending dropped 8 → 6 after two answers (ceo absent from sparse map)',
      payload.chat.inbox.total_pending === 6 && payload.chat.inbox.pending_by_role.ceo === undefined,
      JSON.stringify(payload.chat.inbox));
    const ibox = inbox.projectInbox(store.readEvents(), {});
    check('I9: answered_recent newest-first with pairing fields',
      ibox.answered_recent.length === 2 && ibox.answered_recent[0].reply_to === p2.event_id &&
      typeof ibox.answered_recent[0].asked_text === 'string');
  }

  /* ---------- I10: session_active honesty (pure derivation) ---------- */
  {
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const MIN = 60000;
    const mk = (arr) => inbox.deriveSessionActive(arr, { now });

    check('I10: no signals ⇒ inactive (never fabricated)',
      mk([]).by_role.ceo === false);
    check('I10: fresh session_lifecycle start ⇒ active',
      mk([{ actor: 'ceo', action: 'session_lifecycle', phase: 'start', ts: iso(2 * MIN) }]).by_role.ceo === true);
    check('I10: start older than the active window ⇒ inactive',
      mk([{ actor: 'ceo', action: 'session_lifecycle', phase: 'start', ts: iso(40 * MIN) }]).by_role.ceo === false);
    check('I10: explicit end as latest signal ⇒ inactive despite freshness',
      mk([
        { actor: 'ceo', action: 'work_logged', ts: iso(3 * MIN) },
        { actor: 'ceo', action: 'session_lifecycle', phase: 'end', ts: iso(1 * MIN) },
      ]).by_role.ceo === false);
    check('I10: real work within window ⇒ active (live-session evidence)',
      mk([{ actor: 'qa', action: 'work_logged', ts: iso(4 * MIN) }]).by_role.qa === true);
    check('I10: stale work outside window ⇒ inactive',
      mk([{ actor: 'devops', action: 'work_logged', ts: iso(90 * MIN) }]).by_role.devops === false);
    check('I10: end followed by newer work ⇒ active again (new session)',
      mk([
        { actor: 'rc', action: 'session_lifecycle', phase: 'end', ts: iso(20 * MIN) },
        { actor: 'rc', action: 'task_updated', ts: iso(2 * MIN) },
      ]).by_role.rc === true);
  }

  fs.rmSync(ws, { recursive: true, force: true });
  console.log(`\ninbox: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
