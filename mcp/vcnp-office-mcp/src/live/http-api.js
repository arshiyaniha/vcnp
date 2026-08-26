'use strict';

/*
 * live/http-api.js — minimal zero-dependency router (live-office plan §1.3,
 * Phase 2 scope).
 *
 * Endpoints:
 *   GET  /api/data     full composed payload (same JSON as SSE `payload`)
 *   GET  /api/stream   text/event-stream (delegated to the SSE hub)
 *   GET  /healthz      { ok, uptime_s, ledger{events,seq,stamp}, sse_clients, port }
 *   POST /api/message  {to_role,text} → validated message_posted append →
 *                      {ok,event_id,message_id} (Phase 3); mirrors + SSE
 *                      broadcast happen automatically downstream (D2)
 *   GET  /api/inbox    ?role=&include_answered=1 → {pending,answered_recent}
 *                      via the SAME projection code as MCP inbox_list (§3.1)
 *   POST /api/phone    {audio_base64, mime, transcript?, lang?, duration_ms}
 *                      → magic-sniffed, size-capped, stored under
 *                      office/phone/<stamp>.<ext> (+ sidecar json), then the
 *                      PAIRED events append under one lock (Phase 5 §6.3/D5);
 *                      mirrors + SSE broadcast happen automatically (D2).
 *                      Without the writer dep it still answers 501 honestly.
 *   GET  /api/audio/<f> audio/webm|mp4|ogg|wav stream — ONLY files inside
 *                      office/phone/ (strict server-generated-name regex +
 *                      realpath containment; traversal → 403/404)
 *   OPTIONS *          204 + CORS preflight (file:// pages have an opaque origin)
 *   GET/HEAD static    office/ subtree first, then templates/ (read-only),
 *                      realpath-contained; traversal attempts → 403
 *
 * CORS: Access-Control-Allow-Origin: * — deliberate per plan §1.3/R6: the
 * server holds no secrets and binds loopback only; POST writers are rate
 * limited (10/min/IP default).
 *
 * Body safety (risk table R5/D5): bodies larger than bodyLimitBytes get 413;
 * malformed JSON on the future POST endpoints gets 400 invalid_json — the
 * stubs validate the contract but never fake an answer.
 *
 * This module deliberately does NOT import src/store — all workspace data
 * flows in via deps (composeBuild / ledgerStats / postMessage / inboxProject),
 * keeping it unit-testable. When a writer dep is missing its route answers
 * 501 {"ok":false,"error":"not_implemented_yet"} — the contract stays visible
 * and nothing fake ever responds.
 */

const fs = require('fs');
const path = require('path');
const compose = require('./compose');

const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024; // D5: ~0.7 MB base64 voice ⇒ generous headroom
const RATE_MAX_DEFAULT = 10;                      // plan §1.3: max 10 msg/min/IP
const RATE_WINDOW_MS_DEFAULT = 60000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

/* Phase 5: /api/audio serves ONLY recorded calls — honest audio mimes
   (static office/ serving keeps its generic table above). */
const PHONE_AUDIO_TYPES = {
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const PHONE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(webm|mp4|ogg|wav)$/;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function intOpt(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function createHttpApi(deps) {
  const d = deps || {};
  if (!d.sse) throw new Error('createHttpApi requires deps.sse');
  const sse = d.sse;
  const port = Number.isFinite(d.port) ? d.port : null;
  const composeBuild = typeof d.composeBuild === 'function' ? d.composeBuild : (o) => compose.build(o);
  const ledgerStats = typeof d.ledgerStats === 'function' ? d.ledgerStats : () => ({ events: 0, seq: 0, stamp: null });
  const postMessage = typeof d.postMessage === 'function' ? d.postMessage : null;
  const inboxProject = typeof d.inboxProject === 'function' ? d.inboxProject : null;
  const staticRoots = Array.isArray(d.staticRoots) ? d.staticRoots.map((r) => path.resolve(r)) : [];
  const postPhoneCall = typeof d.postPhoneCall === 'function' ? d.postPhoneCall : null;
  const phoneAudioDir =
    typeof d.phoneAudioDir === 'string' && d.phoneAudioDir ? path.resolve(d.phoneAudioDir) : null;
  const bodyLimit = intOpt(d.bodyLimitBytes, DEFAULT_BODY_LIMIT_BYTES);
  const rateMax = intOpt(d.rateLimitMax, RATE_MAX_DEFAULT);
  const rateWindowMs = intOpt(d.rateLimitWindowMs, RATE_WINDOW_MS_DEFAULT);
  const startedAt = Date.now();

  const hits = new Map(); // ip -> [timestamps within window]

  /* ---------------- response helpers ---------------- */

  function baseHeaders(extra) {
    return Object.assign(
      {
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
      extra
    );
  }

  function send(res, status, headers, body) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, baseHeaders(headers));
    res.end(body);
  }

  function sendJson(res, status, obj) {
    send(
      res,
      status,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(obj) + '\n'
    );
  }

  const notImplemented = (res) => sendJson(res, 501, { ok: false, error: 'not_implemented_yet' });

  /* ------------- rate limiting (sliding window per IP) ------------- */

  function rateLimited(req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < rateWindowMs);
    if (arr.length >= rateMax) {
      hits.set(ip, arr);
      return true;
    }
    arr.push(now);
    hits.set(ip, arr);
    return false;
  }

  /* ------------- body reading with hard size cap ------------- */

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          tooLarge = true;
          chunks.length = 0;
          req.resume(); // discard the rest without buffering it
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }));
      req.on('error', reject);
    });
  }

  /** Empty body ≙ {}; anything else must be valid JSON or → 400 invalid_json. */
  function parseJsonBody(body) {
    if (!body.text.trim()) return {};
    try {
      return JSON.parse(body.text);
    } catch (_) {
      throw new HttpError(400, 'invalid_json');
    }
  }

  /* ------------- static serving (containment-checked) ------------- */

  function serveStatic(pathname, req, res) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (_) {
      throw new HttpError(400, 'bad_path');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'bad_path');
    if (decoded === '/' || decoded === '') decoded = '/dashboard.html';
    const rel = decoded.replace(/\//g, path.sep);

    let escaped = false;
    for (const root of staticRoots) {
      const target = path.resolve(root, '.' + rel);
      const contained = target === root || target.startsWith(root + path.sep);
      if (!contained) {
        escaped = true; // traversal attempt — never fall through to another root
        continue;
      }
      let st;
      try {
        st = fs.statSync(target);
      } catch (_) {
        continue;
      }
      if (!st.isFile()) continue;
      const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Content-Length': String(st.size),
        'Cache-Control': 'no-cache',
      };
      if (req.method === 'HEAD') {
        send(res, 200, headers);
        return;
      }
      res.writeHead(200, baseHeaders(headers));
      const stream = fs.createReadStream(target);
      stream.on('error', () => {
        try {
          res.destroy();
        } catch (_) { /* socket already gone */ }
      });
      stream.pipe(res);
      return;
    }
    throw new HttpError(escaped ? 403 : 404, escaped ? 'forbidden' : 'not_found');
  }

  /* ------- Phase 5: playback of stored calls (office/phone ONLY) ------- */

  function servePhoneAudio(rawName, req, res) {
    if (!phoneAudioDir) {
      notImplemented(res);
      return;
    }
    let name;
    try {
      name = decodeURIComponent(String(rawName));
    } catch (_) {
      throw new HttpError(400, 'bad_path');
    }
    /* Layer 1: server-generated names only — the strict regex rejects
     * separators, '..', encoded traversal, everything, BEFORE any fs call. */
    if (!PHONE_NAME_RE.test(name)) throw new HttpError(404, 'not_found');
    /* Layer 2: resolve + realpath containment inside office/phone/ (R4). */
    const target = path.resolve(phoneAudioDir, name);
    if (!target.startsWith(phoneAudioDir + path.sep)) throw new HttpError(403, 'forbidden');
    let real;
    let realRoot;
    try {
      real = fs.realpathSync(target);
      realRoot = fs.realpathSync(phoneAudioDir);
    } catch (_) {
      throw new HttpError(404, 'not_found'); // missing dir/file — no info leak
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new HttpError(403, 'forbidden');
    }
    let st;
    try {
      st = fs.statSync(real);
    } catch (_) {
      throw new HttpError(404, 'not_found');
    }
    if (!st.isFile()) throw new HttpError(404, 'not_found');
    const type = PHONE_AUDIO_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': String(st.size),
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'none',
    };
    if (req.method === 'HEAD') {
      send(res, 200, headers);
      return;
    }
    res.writeHead(200, baseHeaders(headers));
    const stream = fs.createReadStream(real);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (_) { /* socket already gone */ }
    });
    stream.pipe(res);
  }

  /* ------------- routing ------------- */

  async function route(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    if (req.method === 'OPTIONS') {
      send(res, 204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      return;
    }

    if (p === '/api/stream') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      sse.handle(req, res, { snapshot: composeBuild({ port }) });
      return;
    }

    if (p === '/api/data') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      sendJson(res, 200, composeBuild({ port }));
      return;
    }

    if (p === '/healthz') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      sendJson(res, 200, {
        ok: true,
        uptime_s: Math.round((Date.now() - startedAt) / 100) / 10,
        ledger: ledgerStats(),
        sse_clients: sse.clientCount(),
        port,
      });
      return;
    }

    /* ---- Phase 3 chat loop (plan §1.3) — writer injected via deps; without
       one the routes keep answering 501 honestly (nothing fake responds). --- */

    if (p === '/api/inbox') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      if (!inboxProject) {
        notImplemented(res);
        return;
      }
      const role = u.searchParams.get('role') || undefined;
      const includeAnswered =
        ['1', 'true'].includes((u.searchParams.get('include_answered') || '').toLowerCase());
      const proj = inboxProject({ role, include_answered: includeAnswered });
      sendJson(res, 200, {
        ok: true,
        pending: proj.pending,
        answered_recent: includeAnswered ? proj.answered_recent : [],
        total_pending: proj.total_pending,
        pending_by_role: proj.pending_by_role,
      });
      return;
    }

    if (p === '/api/message') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (rateLimited(req)) {
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      const body = await readBody(req, bodyLimit);
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        return;
      }
      const parsed = parseJsonBody(body);
      if (!postMessage) {
        notImplemented(res);
        return;
      }
      const r = await postMessage({ to_role: parsed.to_role, text: parsed.text, channel: 'web' });
      if (r && r.ok) {
        sendJson(res, 200, { ok: true, event_id: r.event_id, message_id: r.message_id });
        return;
      }
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_message',
        reasons: (r && r.reasons) || [(r && r.error) || 'rejected'],
      });
      return;
    }

    /* ---- Phase 5 telephone exchange (plan §6.3/D5): playback + intake ---- */

    if (p.startsWith('/api/audio/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      servePhoneAudio(p.slice('/api/audio/'.length), req, res);
      return;
    }

    if (p === '/api/phone') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      if (rateLimited(req)) {
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      const body = await readBody(req, bodyLimit);
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        return;
      }
      const parsed = parseJsonBody(body);
      if (!postPhoneCall) {
        notImplemented(res); // contract visible, nothing fake answers
        return;
      }
      const r = await postPhoneCall({
        audio_base64: parsed.audio_base64,
        mime: parsed.mime,
        transcript: parsed.transcript === undefined ? null : parsed.transcript,
        lang: parsed.lang,
        duration_ms: parsed.duration_ms,
        ip: (req.socket && req.socket.remoteAddress) || 'unknown',
        source: 'web',
      });
      if (r && r.ok) {
        sendJson(res, 200, {
          ok: true,
          call_id: r.call_id,
          event_id: r.event_id,
          message_id: r.message_id,
          audio_ref: r.audio_ref,
          audio_url: r.audio_url,
        });
        return;
      }
      const status = r && r.error === 'audio_too_large' ? 413
        : (r && r.error === 'unsupported_audio') ? 415
        : 400;
      sendJson(res, status, {
        ok: false,
        error: (r && r.error) || 'invalid_phone_call',
        reasons: (r && r.reasons) || [(r && r.error) || 'rejected'],
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && staticRoots.length > 0) {
      serveStatic(p, req, res);
      return;
    }
    throw new HttpError(404, 'not_found');
  }

  function handler(req, res) {
    route(req, res).catch((err) => {
      const isHttp = err instanceof HttpError;
      if (!isHttp) {
        process.stderr.write(`[vcnp-live-api] ${(err && err.stack) || err}\n`);
      }
      try {
        sendJson(res, isHttp ? err.status : 500, { ok: false, error: isHttp ? err.code : 'internal_error' });
      } catch (_) { /* socket gone */ }
    });
  }

  return { handler };
}

module.exports = {
  createHttpApi,
  HttpError,
  DEFAULT_BODY_LIMIT_BYTES,
  RATE_MAX_DEFAULT,
  RATE_WINDOW_MS_DEFAULT,
};
