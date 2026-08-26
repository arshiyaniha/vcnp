'use strict';

/*
 * live/sse.js — Server-Sent Events hub (live-office plan §4.2, Phase 2).
 *
 * Wire contract for GET /api/stream:
 *   retry: 3000            — reconnect hint, sent once on connect
 *   id: <ledger_seq>       — monotonic per payload; clients replay it as
 *                            Last-Event-ID. The server is STATELESS: on
 *                            reconnect it simply resends the current FULL
 *                            payload (no replay buffer needed, plan §4.2).
 *   event: payload         — data: one-line JSON, byte-for-byte the same
 *                            composition GET /api/data returns.
 *   : ping                 — heartbeat comment every 15 s keeps proxies /
 *                            Windows idle sockets alive.
 *
 * Zero dependencies. Clients are raw `res` sockets tracked in a Set and
 * removed on close/error; broadcast() fans out to whatever remains.
 */

const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_RETRY_MS = 3000;

function positiveInt(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function createSseHub(opts) {
  const heartbeatMs = positiveInt(opts && opts.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const retryMs = positiveInt(opts && opts.retryMs, DEFAULT_RETRY_MS);
  const clients = new Set();
  let closed = false;

  function drop(res) {
    clients.delete(res);
  }

  /** Write one SSE frame; silently drops dead sockets. */
  function write(res, frame) {
    if (closed || res.destroyed || res.writableEnded) {
      drop(res);
      return false;
    }
    try {
      res.write(frame);
      return true;
    } catch (_) {
      drop(res);
      return false;
    }
  }

  function payloadFrame(payload) {
    const seq = payload && payload.server ? payload.server.ledger_seq : 0;
    return `id: ${seq}\nevent: payload\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  /**
   * Attach an inbound GET /api/stream request. Response headers per §4.2.
   * When handleOpts.snapshot is provided it is pushed immediately so a fresh
   * client renders before the next ledger change.
   */
  function handle(req, res, handleOpts) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`retry: ${retryMs}\n\n`);
    clients.add(res);
    req.on('close', () => drop(res));
    res.on('close', () => drop(res));
    res.on('error', () => drop(res));
    if (handleOpts && handleOpts.snapshot) write(res, payloadFrame(handleOpts.snapshot));
  }

  /** Fan the composed payload out to every connected client. */
  function broadcast(payload) {
    const frame = payloadFrame(payload);
    let reached = 0;
    for (const res of Array.from(clients)) {
      if (res.destroyed) {
        drop(res);
        continue;
      }
      if (write(res, frame)) reached += 1;
    }
    return reached;
  }

  const heartbeat = setInterval(() => {
    for (const res of Array.from(clients)) {
      if (res.destroyed) {
        drop(res);
        continue;
      }
      write(res, ': ping\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref(); // pings must never keep the process alive on their own

  function clientCount() {
    return clients.size;
  }

  function close() {
    closed = true;
    clearInterval(heartbeat);
    for (const res of Array.from(clients)) {
      try {
        res.end();
      } catch (_) { /* already gone */ }
    }
    clients.clear();
  }

  return { handle, broadcast, clientCount, close };
}

module.exports = { createSseHub, DEFAULT_HEARTBEAT_MS, DEFAULT_RETRY_MS };
