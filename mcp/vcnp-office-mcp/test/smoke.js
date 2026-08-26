'use strict';

/*
 * End-to-end smoke test for vcnp-office-mcp.
 *
 * Spawns the real server over stdio against a TEMP workspace (so the repo's
 * office/ stays clean), drives the full MCP handshake + every tool, asserts
 * responses, prints a PASS/FAIL summary and exits 0/1.
 *
 * Zero npm dependencies — Node.js >= 20 stdlib only.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '..');
const SERVER = path.join(PKG_DIR, 'src', 'server.js');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ' — ' + (extra || '')}`);
}

async function main() {
  // ---- temp workspace -------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcnp-office-smoke-'));
  const officeDir = path.join(tmp, 'office');
  fs.mkdirSync(path.join(officeDir, 'memory-bank'), { recursive: true });
  fs.writeFileSync(path.join(officeDir, 'events.log.jsonl'), '');
  const activeContext = path.join(officeDir, 'memory-bank', 'activeContext.md');
  fs.writeFileSync(activeContext, '# Active Context\n');

  // ---- spawn server ---------------------------------------------------
  // Strip provider env vars so the llm_batch "no provider configured" path is
  // deterministic regardless of the developer's machine.
  const env = { ...process.env, VCNP_OFFICE_WORKSPACE: tmp };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_BASE_URL)$/i.test(k)) delete env[k];
  }
  const child = spawn(process.execPath, [SERVER], { cwd: PKG_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  // ---- tiny JSON-RPC client -------------------------------------------
  const pending = new Map();
  let seq = 0;
  child.stdout.setEncoding('utf8');
  let lineBuf = '';
  child.stdout.on('data', (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });

  function request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  const textOf = (res) => (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || '';
  const isError = (res) => !!(res.result && res.result.isError);

  try {
    // 1. initialize -----------------------------------------------------
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vcnp-smoke', version: '1.0.0' },
    });
    check('initialize returns matching id + serverInfo',
      init.id === 1 && init.result && init.result.serverInfo && init.result.serverInfo.name === 'vcnp-office-mcp',
      JSON.stringify(init).slice(0, 200));

    // 2. notifications/initialized — must be ignored silently -----------
    notify('notifications/initialized', {});
    const ping = await request('ping', {});
    check('notification ignored; server still responsive', ping.id === 2 && ping.result !== undefined);

    // 3. tools/list -------------------------------------------------------
    const list = await request('tools/list', {});
    const names = new Set((list.result.tools || []).map((t) => t.name));
    const requiredTools = ['board_init', 'task_create', 'task_update', 'task_assign', 'board_read',
      'ledger_log', 'event_log', 'telemetry_read', 'route_model', 'llm_batch_submit',
      'llm_batch_status', 'report_generate', 'compaction_ack', 'office_archive_reset'];
    const missing = requiredTools.filter((t) => !names.has(t));
    check(`tools/list exposes all ${requiredTools.length} tools`, missing.length === 0, 'missing: ' + missing.join(','));

    // 4. board_init -------------------------------------------------------
    const bi = await request('tools/call', {
      name: 'board_init',
      arguments: { project_name: 'Smoke Project', goal: 'verify P4 server end-to-end' },
    });
    check('board_init ok', !isError(bi) && /Smoke Project/.test(textOf(bi)), textOf(bi));

    // 5. task_create ------------------------------------------------------
    const tc = await request('tools/call', {
      name: 'task_create',
      arguments: {
        title: 'Write a haiku',
        assignee_role: 'executor',
        acceptance_criteria: ['exactly 17 syllables'],
        budget_tokens: 1000,
        task_class: 'C1',
      },
    });
    const taskIdMatch = /T-\d{3}/.exec(textOf(tc));
    const taskId = taskIdMatch ? taskIdMatch[0] : null;
    check('task_create ok and returns T-NNN id', !isError(tc) && !!taskId, textOf(tc));

    // state.json rebuilt atomically from ledger ---------------------------
    const stateOnDisk = JSON.parse(fs.readFileSync(path.join(officeDir, 'state.json'), 'utf8'));
    check('state.json derived from ledger (1 task)',
      Array.isArray(stateOnDisk.tasks) && stateOnDisk.tasks.length === 1 &&
      stateOnDisk.tasks[0].title === 'Write a haiku',
      JSON.stringify(stateOnDisk).slice(0, 200));

    // 6. task_update VALID (Result Report shape) --------------------------
    const tuOk = await request('tools/call', {
      name: 'task_update',
      arguments: {
        task_id: taskId,
        status: 'done',
        progress_percent: 100,
        artifacts: ['demo/haiku.txt'],
        blockers: [],
        notes_for_qa: 'read it aloud',
      },
    });
    check('task_update valid envelope accepted -> awaiting_orchestrator',
      !isError(tuOk) && /awaiting_orchestrator/.test(textOf(tuOk)), textOf(tuOk));

    // 7. task_update INVALID (progress_percent out of range) --------------
    const tuBad = await request('tools/call', {
      name: 'task_update',
      arguments: { task_id: taskId, status: 'done', progress_percent: 150 },
    });
    check('task_update invalid envelope REJECTED with precise message',
      isError(tuBad) && /progress_percent/.test(textOf(tuBad)), textOf(tuBad));

    // 8. unknown tool ------------------------------------------------------
    const unk = await request('tools/call', { name: 'definitely_not_a_tool', arguments: {} });
    check('unknown tool reported as error', isError(unk) && /unknown tool/.test(textOf(unk)), textOf(unk));

    // 9. compaction gate: util event WITHOUT compaction -> assign refused -
    await request('tools/call', {
      name: 'event_log',
      arguments: { actor: 'executor', action: 'util_report', detail: { session_id: 'sess-smoke-1' } },
    });
    const taRefused = await request('tools/call', {
      name: 'task_assign',
      arguments: { task_id: taskId, role: 'executor' },
    });
    check('task_assign REFUSED while latest util event is not compaction_done (freshness gate)',
      isError(taRefused) && /(freshness|compaction_done)/i.test(textOf(taRefused)), textOf(taRefused));

    // 10. compaction_ack invalid (util_after > 0.75) ----------------------
    const caBad = await request('tools/call', {
      name: 'compaction_ack',
      arguments: { session_id: 'sess-smoke-1', util_after: 0.9 },
    });
    check('compaction_ack REJECTED when util_after > 0.75',
      isError(caBad) && /0\.75/.test(textOf(caBad)), textOf(caBad));

    // 11. Librarian hand-off THEN valid compaction_ack --------------------
    fs.appendFileSync(activeContext, '- hand-off: smoke session context summarized\n');
    const caOk = await request('tools/call', {
      name: 'compaction_ack',
      arguments: { session_id: 'sess-smoke-1', util_after: 0.4 },
    });
    check('compaction_ack accepted after Memory Bank update',
      !isError(caOk) && /compaction_done/.test(textOf(caOk)), textOf(caOk));

    // 12. assignment now passes the gate ----------------------------------
    const taOk = await request('tools/call', {
      name: 'task_assign',
      arguments: { task_id: taskId, role: 'executor' },
    });
    check('task_assign succeeds once freshness gate satisfied',
      !isError(taOk) && /doing/.test(textOf(taOk)), textOf(taOk));

    // 13. ledger_log (estimated flagged) + telemetry_read -----------------
    const ll = await request('tools/call', {
      name: 'ledger_log',
      arguments: { role: 'executor', task_id: taskId, tokens_used: 1234, source: 'estimated' },
    });
    check('ledger_log records estimated source but flags it',
      !isError(ll) && /(FLAGGED|تخمینی)/.test(textOf(ll)), textOf(ll));
    const tr = await request('tools/call', { name: 'telemetry_read', arguments: {} });
    check('telemetry_read aggregates tokens + authoritative split',
      !isError(tr) && /1234/.test(textOf(tr)) && /provider_usage/.test(textOf(tr)), textOf(tr));

    // 14. route_model ------------------------------------------------------
    const rm = await request('tools/call', { name: 'route_model', arguments: { task_class: 'C2' } });
    check('route_model picks tier>=2 model for C2',
      !isError(rm) && /tier\s*[2-3]/.test(textOf(rm)), textOf(rm));

    // 15. llm_batch async flow (no provider configured) --------------------
    const bs = await request('tools/call', {
      name: 'llm_batch_submit',
      arguments: { jobs: [{ input: 'hello' }, { input: 'world' }], model_class: 'C1' },
    });
    const batchIdMatch = /B-[A-Za-z0-9-]+/.exec(textOf(bs));
    check('llm_batch_submit returns batch_id instantly',
      !isError(bs) && !!batchIdMatch, textOf(bs));

    let batchDoc = null;
    const jobsJson = path.join(officeDir, 'batches', batchIdMatch[0], 'jobs.json');
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!fs.existsSync(jobsJson)) continue;
      try { batchDoc = JSON.parse(fs.readFileSync(jobsJson, 'utf8')); } catch (_) { continue; }
      if (batchDoc.status !== 'pending') break;
    }
    check('batch worker completed honestly without a provider',
      batchDoc && batchDoc.status === 'failed' &&
      batchDoc.jobs.every((j) => j.status === 'failed' && /no provider configured/i.test(j.error || '')),
      batchDoc ? JSON.stringify(batchDoc.jobs && batchDoc.jobs.map((j) => j.error)) : 'jobs.json never settled');
    const bst = await request('tools/call', { name: 'llm_batch_status', arguments: { batch_id: batchIdMatch[0] } });
    check('llm_batch_status reports failures', !isError(bst) && /failed/.test(textOf(bst)), textOf(bst));

    // 16. report_generate regenerates mirrors ------------------------------
    const rg = await request('tools/call', { name: 'report_generate', arguments: {} });
    const boardMd = fs.readFileSync(path.join(officeDir, 'BOARD.md'), 'utf8');
    const live = JSON.parse(fs.readFileSync(path.join(officeDir, 'office-live.json'), 'utf8'));
    check('report_generate writes BOARD.md with kanban columns + task',
      !isError(rg) && boardMd.includes('Awaiting Orchestrator') && boardMd.includes(taskId),
      boardMd.slice(0, 120));
    check('office-live.json carries raw signals for 9 roles',
      Array.isArray(live.roles) && live.roles.length === 9 &&
      live.roles.every((r) => 'active_role' in r && 'last_event_time' in r && 'mood' in r),
      JSON.stringify(live).slice(0, 160));

    // 17. board_read snapshot ---------------------------------------------
    const br = await request('tools/call', { name: 'board_read', arguments: {} });
    check('board_read compact snapshot shows assigned task',
      !isError(br) && textOf(br).includes(taskId) && /doing:1/.test(textOf(br)), textOf(br));
  } catch (err) {
    check('smoke sequence completed without exception', false, err.message);
  }

  // ---- cleanup ----------------------------------------------------------
  try { child.stdin.end(); } catch (_) { /* already closed */ }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  setTimeout(() => { try { child.kill(); } catch (_) {} }, 2000).unref();
  await exited;

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n========================================');
  console.log(`SMOKE RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${results.length} checks passed)`);
  if (failed > 0 && stderrBuf) console.log('server stderr tail:\n' + stderrBuf.split('\n').slice(-10).join('\n'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
