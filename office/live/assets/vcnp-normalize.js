/*
 * vcnp-normalize.js — shared normalization core (live-office plan §5.2).
 *
 * Both the pixel dashboard (templates/dashboard-pixel.html) and the studio
 * renderer (office/live/studio.html + studio-renderer.js) call
 * `VCNP.normalize(payload)` so neither style scrapes the composed payload
 * (plan §1.4) on its own — one reshape, two renderers, identical facts.
 *
 * The payload's `live.roles[]` entries already carry the REAL mood/energy
 * decision made server-side by mcp/vcnp-office-mcp/src/tools/report.js
 * (`deriveOfficeLive`, tunables in plan §4.3). This module does NOT
 * re-derive that business logic — it reshapes + fills safe defaults, and
 * only falls back to its own decay estimate when a field is genuinely
 * missing (e.g. a hand-built/partial payload in a test or an old snapshot).
 *
 * Nothing here fabricates activity: missing/empty input always normalizes
 * to honest empty/offline shapes, never synthetic ones (plan-wide rule).
 *
 * Exposed as `window.VCNP` (plain global, no module system — matches the
 * zero-build, file://-friendly convention of the prototypes).
 */
(function (global) {
  'use strict';

  /* Single role registry — mirrors tools/report.js ROLES (plan §2). Kept as
     a literal (not fetched) so normalize() works even before any payload
     with real roles has ever arrived. */
  var ROLES = ['ceo', 'planner', 'orchestrator', 'executor', 'qa', 'security', 'rc', 'librarian', 'devops'];

  /* Tunables mirror tools/report.js DEFAULT_TUNABLES (plan §4.3) — used ONLY
     as a fallback decay estimate when a role entry lacks energy_hint/mood
     (defense-in-depth per plan R9, "shared module has unit tests pinning
     energy/mood math to §4.3 constants"). The server-computed values in
     live.roles[] are always preferred when present. */
  var TUNABLES = {
    ACTIVE_THRESHOLD_MIN: 30,
    ENERGY_DECAY_MIN: 100,
    SLEEP_AFTER_MIN: 60,
  };

  var MOOD_FA = {
    working: 'در حال کار', thinking: 'در فکر', coffee: 'قهوه',
    sleeping: 'خواب', meeting: 'جلسه', alert: 'هشدار', talking: 'صحبت', phone: 'تلفن',
    frustrated: 'ناامید',
  };
  var KNOWN_MOODS = { working: 1, thinking: 1, coffee: 1, sleeping: 1, meeting: 1, alert: 1, talking: 1, phone: 1, frustrated: 1 };

  function num(v, dflt) {
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  /**
   * energy(roleEntry, now) → 0..100.
   * Prefers the server-computed `energy_hint`; falls back to a linear decay
   * from `last_event_time` (same shape as the prototypes' own `energy()`)
   * only when the hint is absent — e.g. hand-built payloads in tests.
   */
  function energy(roleEntry, now) {
    var r = roleEntry || {};
    if (typeof r.energy_hint === 'number' && isFinite(r.energy_hint)) {
      return Math.max(0, Math.min(100, Math.round(r.energy_hint)));
    }
    if (!r.last_event_time) return 0;
    var ms = (num(now, Date.now())) - Date.parse(r.last_event_time);
    if (!(ms >= 0)) return 0;
    var ageMin = ms / 60000;
    return Math.max(0, Math.min(100, Math.round(100 - (ageMin * 100) / TUNABLES.ENERGY_DECAY_MIN)));
  }

  /**
   * statusOf(roleEntry, now) → boolean "active" flag.
   * Prefers the server-computed `active_role`; falls back to the same
   * ACTIVE_THRESHOLD_MIN cutoff when only a timestamp is available.
   */
  function statusOf(roleEntry, now) {
    var r = roleEntry || {};
    if (typeof r.active_role === 'boolean') return r.active_role;
    if (!r.last_event_time) return false;
    var ageMin = ((num(now, Date.now())) - Date.parse(r.last_event_time)) / 60000;
    return ageMin >= 0 && ageMin < TUNABLES.ACTIVE_THRESHOLD_MIN;
  }

  /**
   * moodOf(roleEntry) → known mood string, degrading unknown/missing moods
   * to 'working' (plan §4.3: "unknown moods degrade to working in renderers").
   */
  function moodOf(roleEntry) {
    var r = roleEntry || {};
    return KNOWN_MOODS[r.mood] ? r.mood : 'working';
  }

  function safeArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function safeObject(v) {
    return v && typeof v === 'object' ? v : {};
  }

  /**
   * VCNP.normalize(payload) → {roles, tasks, project, chat, meetings, phone, meta}
   * per plan §5.2. `payload` is the composed JSON from GET /api/data, an SSE
   * `payload` frame, or the static window.VCNP_DATA snapshot — all three
   * share the same shape (plan §1.4), so normalize() treats them identically.
   * A missing/malformed payload normalizes to honest empty shapes (never
   * fabricated ones) with `meta.ok = false`.
   */
  function normalize(payload) {
    var now = Date.now();
    var p = safeObject(payload);
    var state = safeObject(p.state);
    var live = safeObject(p.live);
    var liveRolesByName = {};
    safeArray(live.roles).forEach(function (r) {
      if (r && r.role) liveRolesByName[r.role] = r;
    });
    var work = safeObject(p.work);
    var byRoleDesk = safeObject(work.by_role);

    var roles = {};
    ROLES.forEach(function (r) {
      var entry = liveRolesByName[r] || null;
      roles[r] = {
        role: r,
        mood: entry ? moodOf(entry) : 'sleeping',
        mood_fa: MOOD_FA[entry ? moodOf(entry) : 'sleeping'] || MOOD_FA.working,
        energy: entry ? energy(entry, now) : 0,
        active: entry ? statusOf(entry, now) : false,
        last_event_time: entry ? (entry.last_event_time || null) : null,
        desk: byRoleDesk[r] || null,
      };
    });

    var server = safeObject(p.server);
    var chat = safeObject(p.chat);
    var chatInbox = safeObject(chat.inbox);
    var meetings = safeObject(p.meetings);
    var phone = safeObject(p.phone);

    return {
      ok: !!(state && Array.isArray(state.tasks)),
      roles: roles,
      tasks: safeArray(state.tasks),
      project: safeObject(state.project),
      chat: {
        messages: safeArray(chat.messages),
        pending_by_role: safeObject(chatInbox.pending_by_role),
        total_pending: num(chatInbox.total_pending, 0),
        session_active: safeObject(chat.session_active).by_role || {},
      },
      meetings: {
        active: meetings.active || null,
        recent: safeArray(meetings.recent),
      },
      phone: {
        recent: safeArray(phone.recent),
      },
      meta: {
        schema_version: p.schema_version || null,
        generated_ts: p.generated_ts || p.generated_at || null,
        recent_events: safeArray(p.recent_events),
        live: server.live === true,
        ledger_seq: num(server.ledger_seq, 0),
        port: server.port || null,
      },
    };
  }

  global.VCNP = {
    ROLES: ROLES.slice(),
    TUNABLES: TUNABLES,
    MOOD_FA: MOOD_FA,
    energy: energy,
    statusOf: statusOf,
    moodOf: moodOf,
    normalize: normalize,
  };
})(typeof window !== 'undefined' ? window : this);
