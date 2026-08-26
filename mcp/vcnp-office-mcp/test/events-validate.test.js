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

console.log(`\nevents-validate: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
