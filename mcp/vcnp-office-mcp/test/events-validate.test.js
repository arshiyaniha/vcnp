'use strict';

/*
 * events-validate.test — Phase 3 ledger-event validators (live-office plan §2).
 * Pure functions: no workspace, no I/O. Run: node test/events-validate.test.js
 */

const path = require('path');
const V = require(path.join(__dirname, '..', 'src', 'lib', 'events-validate'));

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

const reasonsJoin = (reasons) => (Array.isArray(reasons) ? reasons.join(' | ') : String(reasons));

/* ---------------- message_posted ---------------- */
{
  check('posted: valid minimal input passes', V.validateMessagePosted({ to_role: 'ceo', text: 'سلام' }).length === 0);
  check('posted: every role accepts', V.ROLES.every((r) =>
    V.validateMessagePosted({ to_role: r, text: 'x' }).length === 0));
  check('posted: explicit channels web|cli|phone accept', ['web', 'cli', 'phone'].every((c) =>
    V.validateMessagePosted({ to_role: 'qa', text: 'x', channel: c }).length === 0));
  check('posted: unknown role rejected with to_role reason',
    V.validateMessagePosted({ to_role: 'bigboss', text: 'x' }).some((r) => /to_role/.test(r)),
    reasonsJoin(V.validateMessagePosted({ to_role: 'bigboss', text: 'x' })));
  check('posted: missing role rejected', V.validateMessagePosted({ text: 'x' }).length > 0);
  check('posted: empty text rejected', V.validateMessagePosted({ to_role: 'ceo', text: '' }).length > 0);
  check('posted: whitespace-only text rejected', V.validateMessagePosted({ to_role: 'ceo', text: '   ' }).length > 0);
  check('posted: 2000 chars accepted',
    V.validateMessagePosted({ to_role: 'ceo', text: 'x'.repeat(2000) }).length === 0);
  const overPost = V.validateMessagePosted({ to_role: 'ceo', text: 'x'.repeat(2001) });
  check('posted: 2001 chars rejected with cap reason', overPost.some((r) => /2000/.test(r)), reasonsJoin(overPost));
  check('posted: bad channel rejected',
    V.validateMessagePosted({ to_role: 'ceo', text: 'x', channel: 'sms' }).some((r) => /channel/.test(r)));
  check('posted: non-object input rejected', V.validateMessagePosted(null).length > 0 &&
    V.validateMessagePosted('x').length > 0);
}

/* ---------------- message_answered ---------------- */
{
  check('answered: valid input passes',
    V.validateMessageAnswered({ reply_to: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', text: 'پاسخ' }).length === 0);
  check('answered: 4000 chars accepted',
    V.validateMessageAnswered({ reply_to: 'evt-1', text: 'x'.repeat(4000) }).length === 0);
  const overAns = V.validateMessageAnswered({ reply_to: 'evt-1', text: 'x'.repeat(4001) });
  check('answered: 4001 chars rejected with cap reason', overAns.some((r) => /4000/.test(r)), reasonsJoin(overAns));
  check('answered: missing reply_to rejected', V.validateMessageAnswered({ text: 'x' }).length > 0);
  check('answered: empty reply_to rejected', V.validateMessageAnswered({ reply_to: '', text: 'x' }).length > 0);
  check('answered: empty text rejected', V.validateMessageAnswered({ reply_to: 'evt-1', text: '' }).length > 0);
  check('answered: malformed message_id rejected when provided',
    V.validateMessageAnswered({ reply_to: 'evt-1', text: 'x', message_id: 'm-1' }).some((r) => /message_id/.test(r)));
  check('answered: well-formed message_id accepted',
    V.validateMessageAnswered({ reply_to: 'evt-1', text: 'x', message_id: 'm-0042' }).length === 0);
}

/* ---------------- answering role ---------------- */
{
  check('role: ceo accepted', V.validateAnsweringRole('ceo').length === 0);
  check('role: every registry role accepted', V.ROLES.every((r) => V.validateAnsweringRole(r).length === 0));
  check('role: unknown role rejected', V.validateAnsweringRole('nobody').length > 0);
  check('role: undefined rejected (explicit choice required upstream)',
    V.validateAnsweringRole(undefined).length > 0);
}

/* ---------------- Phase 4: work_logged (plan §2) ---------------- */
{
  const ok = {
    action_summary: 'implemented work-core module',
    artifact_refs: ['mcp/vcnp-office-mcp/src/live/work-core.js'],
    task_id: 'T-001',
  };
  check('work: valid minimal input passes', V.validateWorkLogged({ action_summary: 'did a thing' }).length === 0);
  check('work: full valid input passes', V.validateWorkLogged(ok).length === 0,
    reasonsJoin(V.validateWorkLogged(ok)));
  check('work: omitted artifact_refs passes (rules §2 allow no-artifact units)',
    V.validateWorkLogged({ action_summary: 'x' }).length === 0);
  check('work: empty artifact_refs array passes',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: [] }).length === 0);
  check('work: missing summary rejected', V.validateWorkLogged({}).length > 0);
  check('work: empty summary rejected', V.validateWorkLogged({ action_summary: '' }).length > 0);
  const overWork = V.validateWorkLogged({ action_summary: 'x'.repeat(301) });
  check('work: 301-char summary rejected with cap reason', overWork.some((r) => /300/.test(r)), reasonsJoin(overWork));
  check('work: bad task_id format rejected',
    V.validateWorkLogged({ action_summary: 'x', task_id: 'TASK-1' }).some((r) => /task_id/.test(r)));
  check('work: non-array artifact_refs rejected',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: 'src/app.js' }).some((r) => /artifact_refs/.test(r)));
  check('work: traversal ref rejected',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['../AGENTS.md'] }).some((r) => /\.\./.test(r)),
    reasonsJoin(V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['../AGENTS.md'] })));
  check('work: nested traversal ref rejected',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['src\\..\\..\\secret'] }).length > 0);
  check('work: absolute ref rejected',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['C:\\tmp\\x'] }).length > 0 &&
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['/etc/passwd'] }).length > 0);
  check('work: empty-string ref rejected',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: [''] }).length > 0);
  check('work: valid deep ref accepted',
    V.validateWorkLogged({ action_summary: 'x', artifact_refs: ['office/memory-bank/progress.md'] }).length === 0);
  check('work: code_ref happy path passes',
    V.validateWorkLogged({ action_summary: 'x', code_ref: { path: 'src/a.js', lines: [3, 40] } }).length === 0);
  check('work: code_ref inverted lines rejected',
    V.validateWorkLogged({ action_summary: 'x', code_ref: { path: 'src/a.js', lines: [40, 3] } }).length > 0);
  check('work: code_ref zero line rejected',
    V.validateWorkLogged({ action_summary: 'x', code_ref: { path: 'src/a.js', lines: [0, 5] } }).length > 0);
  check('work: code_ref traversal path rejected',
    V.validateWorkLogged({ action_summary: 'x', code_ref: { path: '../x.js', lines: [1, 2] } }).length > 0);
  check('work: non-object input rejected', V.validateWorkLogged(null).length > 0 &&
    V.validateWorkLogged('x').length > 0);
}

/* ---------------- Phase 4: meeting_started (plan §2) ---------------- */
{
  const ok = { reason: 'qa_gate', participants: ['qa', 'executor', 'orchestrator'], topic: 'T-001 verdict' };
  check('meet-start: valid input passes', V.validateMeetingStarted(ok).length === 0,
    reasonsJoin(V.validateMeetingStarted(ok)));
  check('meet-start: every enum reason accepts',
    V.MEETING_REASONS.every((reason) =>
      V.validateMeetingStarted({ ...ok, reason }).length === 0));
  check('meet-start: bad reason rejected',
    V.validateMeetingStarted({ ...ok, reason: 'party' }).some((r) => /reason/.test(r)));
  check('meet-start: missing reason rejected', V.validateMeetingStarted({
    participants: ok.participants, topic: 't' }).length > 0);
  check('meet-start: two participants accept (minimum)',
    V.validateMeetingStarted({ ...ok, participants: ['qa', 'ceo'] }).length === 0);
  check('meet-start: single participant rejected',
    V.validateMeetingStarted({ ...ok, participants: ['qa'] }).some((r) => /participants/.test(r)));
  check('meet-start: ten participants rejected',
    V.validateMeetingStarted({ ...ok, participants: [...V.ROLES, 'user'] }).some((r) => /participants/.test(r)));
  check('meet-start: unknown participant role rejected',
    V.validateMeetingStarted({ ...ok, participants: ['qa', 'bigboss'] }).some((r) => /participants\[1\]/.test(r)));
  check('meet-start: repeated participant rejected',
    V.validateMeetingStarted({ ...ok, participants: ['qa', 'qa'] }).some((r) => /repeat/.test(r)));
  check('meet-start: non-array participants rejected',
    V.validateMeetingStarted({ ...ok, participants: 'qa,ceo' }).length > 0);
  check('meet-start: missing topic rejected',
    V.validateMeetingStarted({ reason: 'standup', participants: ['ceo', 'qa'] }).length > 0);
  const overTopic = V.validateMeetingStarted({ ...ok, topic: 'x'.repeat(201) });
  check('meet-start: 201-char topic rejected with cap reason', overTopic.some((r) => /200/.test(r)), reasonsJoin(overTopic));
  check('meet-start: valid task_id accepts',
    V.validateMeetingStarted({ ...ok, task_id: 'T-004' }).length === 0);
  check('meet-start: malformed task_id rejected',
    V.validateMeetingStarted({ ...ok, task_id: 'T1' }).some((r) => /task_id/.test(r)));
  check('meet-start: non-object input rejected', V.validateMeetingStarted(null).length > 0);
}

/* ---------------- Phase 4: meeting_ended (plan §2) ---------------- */
{
  check('meet-end: valid input passes',
    V.validateMeetingEnded({ meeting_id: 'mt-0007' }).length === 0);
  check('meet-end: outcome_summary accepted',
    V.validateMeetingEnded({ meeting_id: 'mt-0007', outcome_summary: 'verdict: pass' }).length === 0);
  check('meet-end: missing meeting_id rejected', V.validateMeetingEnded({}).length > 0);
  check('meet-end: malformed meeting_id rejected',
    V.validateMeetingEnded({ meeting_id: 'meeting-7' }).some((r) => /meeting_id/.test(r)));
  const overOutcome = V.validateMeetingEnded({ meeting_id: 'mt-0001', outcome_summary: 'x'.repeat(301) });
  check('meet-end: 301-char summary rejected with cap reason', overOutcome.some((r) => /300/.test(r)), reasonsJoin(overOutcome));
  check('meet-end: empty-string summary rejected when provided',
    V.validateMeetingEnded({ meeting_id: 'mt-0001', outcome_summary: '' }).length > 0);
  check('meet-end: null summary tolerated (omitted equivalent)',
    V.validateMeetingEnded({ meeting_id: 'mt-0001', outcome_summary: null }).length === 0);
  check('meet-end: non-object input rejected', V.validateMeetingEnded(null).length > 0);
}

console.log(`\nevents-validate: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
