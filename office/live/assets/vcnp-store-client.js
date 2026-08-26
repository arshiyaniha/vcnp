/*
 * vcnp-store-client.js — VCNP_STORE.connect({onPayload, url}) (live-office
 * plan §5.2/D4). Delivers RAW composed payloads (same shape as GET /api/data
 * — plan §1.4) to callers; normalization is the CALLER's job via
 * `VCNP.normalize(payload)` (vcnp-normalize.js) — this module never
 * reshapes data, it only sources it and reports honestly when there is none.
 *
 * onPayload(payload, meta) contract:
 *   payload — the raw composed JSON, or the static `window.VCNP_DATA`
 *             snapshot when nothing live is reachable, or `null` when even
 *             that snapshot does not exist. NEVER a fabricated object.
 *   meta    — { live: boolean, source: 'sse'|'poll'|'offline-snapshot'|'offline-empty' }
 *             `live:false` means "treat this as the honest offline state"
 *             even if `payload` itself still carries `server.live:true` from
 *             a stale snapshot — callers should trust `meta.live`, not
 *             `payload.server.live`, to decide whether to show the offline
 *             badge (plan §5.3 acceptance: "no fake activity").
 *
 * Strategy (plan §5.2):
 *   1. try `new EventSource(base + "/api/stream")` (base = same-origin, or
 *      http://localhost:7788 when opened from file://, or an explicit
 *      `opts.url`).
 *   2. on error → exponential-backoff reconnect (1s→2s→4s→...→max 15s) AND
 *      an IMMEDIATE fallback to 45s polling of `/api/data` (both run
 *      concurrently until SSE recovers).
 *   3. if fetch fails entirely (server off / file:// with no server) → keep
 *      delivering the static `window.VCNP_DATA` snapshot (if any) with
 *      `meta.live=false` — the honest offline badge, never simulated
 *      activity.
 */
(function (global) {
  'use strict';

  var DEFAULT_PORT = 7788;
  var POLL_MS = 45000;
  var BACKOFF_START_MS = 1000;
  var BACKOFF_MAX_MS = 15000;

  function resolveBase(explicit) {
    if (typeof explicit === 'string' && explicit) return explicit.replace(/\/$/, '');
    try {
      if (global.location && global.location.protocol === 'file:') {
        return 'http://localhost:' + DEFAULT_PORT;
      }
    } catch (e) { /* no location (non-browser) */ }
    return ''; // same-origin
  }

  function connect(opts) {
    var o = opts || {};
    var onPayload = typeof o.onPayload === 'function' ? o.onPayload : function () {};
    var base = resolveBase(o.url);
    var stopped = false;
    var es = null;
    var pollTimer = null;
    var reconnectTimer = null;
    var backoff = BACKOFF_START_MS;

    function emit(payload, meta) {
      try {
        onPayload(payload, meta);
      } catch (e) { /* renderer error must not kill the transport loop */ }
    }

    function offlineFallback() {
      var snap = null;
      try {
        snap = global.VCNP_DATA || null;
      } catch (e) { /* ignore */ }
      emit(snap, { live: false, source: snap ? 'offline-snapshot' : 'offline-empty' });
    }

    function poll() {
      if (stopped || typeof global.fetch !== 'function') {
        offlineFallback();
        return;
      }
      global.fetch(base + '/api/data', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (data) {
        if (stopped) return;
        emit(data, { live: true, source: 'poll' });
      }).catch(function () {
        if (!stopped) offlineFallback();
      });
    }

    function startPolling() {
      if (pollTimer || stopped) return;
      poll();
      pollTimer = global.setInterval(poll, POLL_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        global.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) return;
      reconnectTimer = global.setTimeout(function () {
        reconnectTimer = null;
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        openSse();
      }, backoff);
    }

    function openSse() {
      if (stopped) return;
      if (typeof global.EventSource === 'undefined') {
        startPolling(); // no SSE support at all — polling is the only path
        return;
      }
      try {
        es = new global.EventSource(base + '/api/stream');
      } catch (e) {
        startPolling();
        scheduleReconnect();
        return;
      }
      es.addEventListener('payload', function (ev) {
        backoff = BACKOFF_START_MS; // reset backoff on any successful frame
        stopPolling(); // SSE is alive again — polling fallback stands down
        try {
          emit(JSON.parse(ev.data), { live: true, source: 'sse' });
        } catch (e) { /* malformed frame — ignore, keep the connection */ }
      });
      es.onerror = function () {
        startPolling(); // immediate fallback while we try to reconnect
        try { es.close(); } catch (e) { /* already closed */ }
        es = null;
        scheduleReconnect();
      };
    }

    openSse();

    return {
      close: function () {
        stopped = true;
        stopPolling();
        if (reconnectTimer) { global.clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (es) { try { es.close(); } catch (e) { /* ignore */ } es = null; }
      },
    };
  }

  global.VCNP_STORE = { connect: connect };
})(typeof window !== 'undefined' ? window : this);
