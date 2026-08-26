'use strict';

/*
 * rpc-driver.js — minimal stdio JSON-RPC client for vcnp-office-mcp.
 *
 * Usage:
 *   node test/rpc-driver.js <scenario.json> [--timeout-ms=15000]
 *
 * Scenario file: JSON array of steps. Each step is either
 *   { "name": "label", "tool": "<tool-name>", "args": { ... } }   -> tools/call
 *   { "name": "label", "method": "<rpc-method>", "params": {...} } -> raw call
 *   { "raw": "<one line of garbage>" }                             -> raw stdin line
 *   { "waitMs": 500 }                                              -> sleep
 *
 * Output: one block per step with the parsed response (or timeout/error).
 * Exit code: 0 always (findings are read from the printed transcript).
 */

const { spawn } = require('child_process');
const path = require('path');

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error('usage: node test/rpc-driver.js <scenario.json> [--timeout-ms=15000]');
  process.exit(1);
}
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='));
const TIMEOUT_MS = timeoutArg ? Number(timeoutArg.split('=')[1]) || 15000 : 15000;

const steps = require(path.resolve(scenarioPath));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const child = spawn(process.execPath, [SERVER], {
  cwd: path.join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

const pending = new Map(); // id -> { resolve, timer }
let nextId = 1;

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
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }
});

function request(method, params, timeoutMs = TIMEOUT_MS) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ _timeout: true, id, method });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(payload);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Resolve "{{stepName.a.b}}" tokens (full-string only) from prior step results. */
const results = new Map();
function lookup(pathStr) {
  const [name, ...rest] = pathStr.trim().split('.');
  const base = results.has(name) ? results.get(name) : undefined;
  let cur = base;
  for (const key of rest) {
    if (cur && typeof cur === 'object' && key in cur) cur = cur[key];
    else return undefined;
  }
  return cur;
}
function resolveRefs(value) {
  if (typeof value === 'string') {
    const m = value.match(/^\{\{([^}]+)\}\}$/);
    if (m) {
      const v = lookup(m[1]);
      return v === undefined ? value : v;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v);
    return out;
  }
  return value;
}

function print(name, obj) {
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

(async () => {
  await sleep(300); // let server boot

  // --- handshake ---
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'rpc-driver', version: '1.0.0' },
  });
  print('initialize', init.result ? init.result.serverInfo : init);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // --- steps ---
  for (const step of steps) {
    const label = step.name || step.tool || step.method || (step.raw ? 'raw-line' : 'step');
    if (step.waitMs) { await sleep(step.waitMs); continue; }
    if (step.raw !== undefined) {
      child.stdin.write(step.raw.endsWith('\n') ? step.raw : step.raw + '\n');
      print(label, { sent: step.raw });
      continue;
    }
    let res;
    if (step.tool) {
      res = await request('tools/call', { name: step.tool, arguments: resolveRefs(step.args || {}) });
    } else {
      res = await request(step.method, resolveRefs(step.params || {}));
    }
    if (res._timeout) {
      print(label, { TIMEOUT_MS: TIMEOUT_MS, timedOut: true });
      continue;
    }
    if (res.error) {
      print(label, { jsonrpcError: res.error });
      continue;
    }
    const out = { isError: res.result && res.result.isError === true };
    const text = res.result && Array.isArray(res.result.content)
      ? res.result.content.map((c) => c.text).join('\n')
      : JSON.stringify(res.result);
    try { out.parsed = JSON.parse(text); } catch (_) { out.text = text; }
    print(label, out);
    results.set(label, out.parsed !== undefined ? out.parsed : out.text);
  }

  child.stdin.end();
  await sleep(200);
  if (stderrBuf.trim()) {
    console.log('\n=== SERVER STDERR ===');
    console.log(stderrBuf.trim());
  }
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('driver failure:', e && e.stack || e);
  child.kill();
  process.exit(1);
});
