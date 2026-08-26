'use strict';

/*
 * vcnp-office-mcp — MCP server over stdio (plan §6.2).
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (readline).
 * Methods handled: initialize, tools/list, tools/call (+ ping).
 * Notifications (no id / notifications/*): ignored silently.
 * Every tools/call response carries matching id and
 *   { content: [{ type: "text", text: "<human-readable result>" }] }.
 * On stdin close the process exits cleanly (code 0).
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib only.
 * ALL writes are confined to <workspace>/office/ (store.js resolves the
 * workspace from VCNP_OFFICE_WORKSPACE env, the directory layout above this
 * file, or the cwd — in that order).
 * stdout carries ONLY protocol JSON; diagnostics go to stderr.
 */

const readline = require('readline');
const pkg = require('../package.json');

const store = require('./store');
const boardDefs = require('./tools/board').defs;
const ledgerDefs = require('./tools/ledger').defs;
const routerDefs = require('./tools/router').defs;
const batchDefs = require('./tools/batch').defs;
const reportDefs = require('./tools/report').defs;
const compactionDefs = require('./tools/compaction').defs;
const demoResetDefs = require('./tools/demo-reset').defs;
const inboxDefs = require('./tools/inbox').defs;

// Post-append mirror refresh (live-office plan §4.1a): every successful
// ledger append regenerates BOARD.md / office-live.json / dashboard-data.js
// under the office lock, deduped via office/.mirrors-stamp.
require('./hooks/mirrors').register();

const TOOLS = [
  ...boardDefs,
  ...ledgerDefs,
  ...routerDefs,
  ...batchDefs,
  ...reportDefs,
  ...compactionDefs,
  ...demoResetDefs,
  ...inboxDefs,
];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function stderr(msg) {
  process.stderr.write(`[vcnp-office-mcp] ${msg}\n`);
}

/** Render a handler result as human-readable text + isError flag. */
function renderResult(def, res) {
  if (res && typeof res === 'object' && res.ok === false) {
    const parts = [`REJECTED: ${res.error || 'invalid request'}`];
    if (Array.isArray(res.reasons) && res.reasons.length) parts.push(...res.reasons.map((x) => ' - ' + x));
    if (res.note) parts.push('Note: ' + res.note);
    return { isError: true, text: parts.join('\n') };
  }
  if (def && typeof def.format === 'function') {
    try {
      return { isError: false, text: def.format(res) };
    } catch (_) { /* fall through to JSON */ }
  }
  return { isError: false, text: JSON.stringify(res, null, 2) };
}

async function callTool(name, args) {
  const def = byName.get(name);
  if (!def) throw new Error(`unknown tool '${name}'`);
  return renderResult(def, await def.handler(args || {}));
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  // Notifications have no id — ignore them (incl. notifications/initialized).
  if (msg.id === undefined || msg.id === null) return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vcnp-office-mcp', version: pkg.version },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const { isError, text } = await callTool(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'ERROR: ' + err.message }], isError: true },
      });
    }
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

/*
 * Drain-before-exit: every dispatched message's promise is tracked, and
 * shutdown waits (bounded by a grace timeout) for in-flight handlers to
 * finish so a ledger write is never killed mid-flight. Without this,
 * closing stdin while a handler awaited the lock silently lost the
 * request: no response, no ledger event, no error anywhere.
 */
const inflight = new Set();
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch (_) {
    stderr('ignoring non-JSON line');
    return;
  }
  const p = handleMessage(msg);
  inflight.add(p);
  p.finally(() => inflight.delete(p)).catch(() => {});
});

let shuttingDown = false;
function gracefulExit(graceMs) {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), graceMs);
  if (typeof force.unref === 'function') force.unref();
  Promise.allSettled([...inflight]).then(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

rl.on('close', () => gracefulExit(5000)); // client closed stdin — let writes land
process.on('SIGINT', () => gracefulExit(1000));
process.on('SIGTERM', () => gracefulExit(1000));
process.on('unhandledRejection', (err) => stderr('unhandled rejection: ' + ((err && err.stack) || err)));

stderr(`ready — ${TOOLS.length} tools — workspace: ${store.WORKSPACE}`);
