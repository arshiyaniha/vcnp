'use strict';

/*
 * live-probe.js — child-process fixture for test/live-server.js.
 * Usage: node test/fixtures/live-probe.js append-once <workspace> [actor] [action] [task_id]
 *
 * Appends ONE real ledger event through src/store as a SECOND PROCESS —
 * exactly how MCP sessions / CLI tools touch the ledger while the live
 * server runs. Prints a JSON result line and exits 0.
 * The workspace MUST be passed because src/store resolves it at require time.
 */

const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
const ws = process.argv[3];
if (!mode || !ws) {
  console.error('usage: live-probe.js append-once <workspace> [actor] [action] [task_id]');
  process.exit(2);
}
process.env.VCNP_OFFICE_WORKSPACE = ws;

const store = require('../../src/store');

(async () => {
  if (mode === 'append-once') {
    const actor = process.argv[4] || 'executor';
    const action = process.argv[5] || 'work_logged';
    const task_id = process.argv[6];
    fs.mkdirSync(path.join(ws, 'office'), { recursive: true });
    const fields = { actor, action };
    if (task_id) fields.task_id = task_id;
    const r = await store.appendEvent(fields);
    console.log(JSON.stringify({ ok: true, event_id: r.event.event_id, duplicate: !!r.duplicate }));
    process.exit(0);
  }
  console.error('unknown mode: ' + mode);
  process.exit(2);
})().catch((e) => {
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
