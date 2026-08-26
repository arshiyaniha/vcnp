'use strict';

/*
 * live-server.js — VCNP live office HTTP server (live-office plan §1.2/D1,
 * Phase 2).
 *
 * SEPARATE PROCESS from the stdio MCP server (src/server.js): this entry
 * NEVER writes to stdout — stdout stays completely silent so the two servers
 * can never be confused; every diagnostic goes to stderr.
 *
 *   bind     127.0.0.1 ONLY (loopback; risk R6)
 *   port     VCNP_OFFICE_PORT (design-doc name) → VCNP_LIVE_PORT (alias)
 *            → 7788 default; 0 = ephemeral (useful for tests)
 *   routes   GET /api/data · GET /api/stream (SSE) · GET /healthz
 *            POST /api/message (Phase 3 chat) · GET /api/inbox (Phase 3)
 *            POST /api/phone → 501 stub until Phase 5
 *            static: office/ then templates/ (read-only, containment-checked)
 *   writes   confined to office/ (mirror regen + .mirrors-stamp only)
 *
 * Exit codes: 0 clean shutdown · 1 bind/startup failure (human-readable
 * stderr reason, e.g. port busy) · 2 invalid configuration.
 *
 * ZERO npm dependencies — Node.js >= 20 stdlib only.
 */

const http = require('http');
const path = require('path');

const store = require('./store');
const compose = require('./live/compose');
const inboxCore = require('./live/inbox-core');
const { createSseHub } = require('./live/sse');
const { startWatcher } = require('./live/watcher');
const { createHttpApi } = require('./live/http-api');

function stderr(msg) {
  process.stderr.write(`[vcnp-live] ${msg}\n`);
}

function resolvePort() {
  const raw = process.env.VCNP_OFFICE_PORT ?? process.env.VCNP_LIVE_PORT;
  if (raw === undefined || raw === '') return 7788;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    stderr(`FATAL: invalid port '${raw}' in VCNP_OFFICE_PORT/VCNP_LIVE_PORT — expected an integer 0-65535`);
    process.exit(2);
  }
  return n;
}

async function main() {
  const port = resolvePort();
  stderr(`workspace: ${store.WORKSPACE}`);
  stderr(`office dir: ${store.OFFICE_DIR} (all writes confined here)`);

  const sse = createSseHub();
  const api = createHttpApi({
    sse,
    port,
    ledgerStats: () => {
      const events = store.readEvents();
      return { events: events.length, seq: events.length, stamp: store.ledgerStamp() };
    },
    // Phase 3 chat writers — same code path as the MCP inbox tools (§3.1).
    postMessage: (args) => inboxCore.postMessage(args),
    inboxProject: (opts) => inboxCore.projectInbox(store.readEvents(), opts),
    staticRoots: [store.OFFICE_DIR, path.join(store.WORKSPACE, 'templates')],
  });

  const server = http.createServer(api.handler);
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const alt = Number.isInteger(port) ? port + 1 : 7789;
      stderr(
        `FATAL: cannot bind 127.0.0.1:${port} — port is busy (EADDRINUSE). ` +
          `Another live server is probably already running. Retry with a free port, e.g.: ` +
          `VCNP_OFFICE_PORT=${alt} npm run live`
      );
    } else if (err && err.code === 'EACCES') {
      stderr(`FATAL: no permission to bind 127.0.0.1:${port} (EACCES) — try a port above 1024`);
    } else {
      stderr(`FATAL: server error: ${(err && err.stack) || err}`);
    }
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const bound = server.address();
  stderr(`live office listening on http://127.0.0.1:${bound.port} (loopback only)`);
  stderr(`SSE stream : http://127.0.0.1:${bound.port}/api/stream`);
  stderr(`health     : http://127.0.0.1:${bound.port}/healthz`);

  // Cross-process refresh (D2b): watch office/ for ledger appends made by MCP
  // sessions or CLI tools; ensure mirrors fresh → compose → SSE broadcast.
  const watcher = startWatcher({
    port: bound.port,
    onRefresh: (payload) => {
      sse.broadcast(payload);
    },
  });
  await watcher.init(); // covers appends made while this server was off
  watcher.start();

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    stderr(`${signal} received — shutting down`);
    watcher.stop();
    sse.close();
    server.close(() => process.exit(0));
    // Hard stop fallback if a socket lingers (SSE clients hold open handles).
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  stderr(`FATAL: ${(err && err.stack) || err}`);
  process.exit(1);
});
