/*
 * studio-renderer.js — Canvas2D isometric render loop ported from
 * `a-studio.html` (live-office plan §5.1/§5.2, Phase 6). Iso projection,
 * furniture, character rendering and camera logic stay intact (port, not a
 * rewrite). ONLY change: no `window.VCNP_DATA` reads / no mood+energy
 * re-derivation here — studio.html feeds ALREADY-NORMALIZED data via
 * `VCNPStudio.apply(normalized, meta)` (normalized = `VCNP.normalize(payload)`),
 * so studio and pixel render from identical facts (plan §6 acceptance).
 * Public API: `VCNPStudio.init()` wires the DOM (same ids as the prototype)
 * and starts the loop; `VCNPStudio.apply(normalized, meta)` feeds a snapshot.
 */
(function (global) {
  'use strict';

  var RM = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cv, ctx, DPR = 1, VW = 0, VH = 0;
  /* Static layout data lives in studio-data.js (loaded first) purely to stay
     under the 500-line cap here — roles: visual placement only, mood/energy
     facts come from apply(). */
  var SD = global.STUDIO_DATA || { ROLES: [], BY: {}, ZONES: [], SEATS: [], ST: [] };
  var ROLES = SD.ROLES, BY = SD.BY, ZONES = SD.ZONES, SEATS = SD.SEATS, ST = SD.ST;

  /* ---------- data (fed by apply(), never read from a global) ---------- */
  var D = { ok: false, counts: {}, tasks: [], events: [], progress: 0, roles: {}, live: false, meetings: null, chat: null, phone: null };
  var HAS_APPLIED = false;
  var SEEN_EVENT_KEYS = new Set();

  function ec(e) { return e < 35 ? '#f43f5e' : e < 65 ? '#f5a524' : '#10b981'; }

  /* ---------- isometric ---------- */
  var TW = 62, TH = 31, CAM = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
  var CX0 = 56, CY0 = 132, BASE = 1, RAILW = 328;
  var OFFX = 0;
  function fitBase() {
    var railEl = document.getElementById('rail');
    var railOn = railEl && !railEl.classList.contains('hid');
    var availW = VW - (railOn ? RAILW : 40) - 40, availH = VH - 130;
    BASE = Math.max(.55, Math.min(2.1, Math.min(availW / 810, availH / 560)));
    OFFX = railOn ? -(RAILW / 2 - 10) : 0;
  }
  function camApply() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.translate(VW / 2 + OFFX + CAM.x, VH / 2 + CAM.y);
    var s = BASE * CAM.z; ctx.scale(s, s); ctx.translate(-CX0, -CY0);
  }
  function screenToWorld(px, py) {
    var s = BASE * CAM.z;
    return [(px - (VW / 2 + OFFX + CAM.x)) / s + CX0, (py - (VH / 2 + CAM.y)) / s + CY0];
  }
  function iso(gx, gy, gz) { return [(gx - gy) * TW / 2, (gx + gy) * TH / 2 - (gz || 0)]; }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    var f = function (v) { return Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt)))); };
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function mixc(a, b, t) {
    var A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
    var r = Math.round((A >> 16) + (((B >> 16) - (A >> 16)) * t)), g = Math.round(((A >> 8) & 255) + ((((B >> 8) & 255) - ((A >> 8) & 255)) * t)),
      c = Math.round((A & 255) + (((B & 255) - (A & 255)) * t)); return 'rgb(' + r + ',' + g + ',' + c + ')';
  }

  function tile(gx, gy, w, h, fill, stroke, r) {
    var p = [iso(gx, gy, 0), iso(gx + w, gy, 0), iso(gx + w, gy + h, 0), iso(gx, gy + h, 0)];
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); for (var i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = r || 1.4; ctx.stroke(); }
  }
  function box(gx, gy, w, d, h, base) {
    var t = [iso(gx, gy, h), iso(gx + w, gy, h), iso(gx + w, gy + d, h), iso(gx, gy + d, h)];
    var bl = iso(gx, gy + d, 0), br = iso(gx + w, gy + d, 0), brr = iso(gx + w, gy, 0);
    ctx.beginPath(); ctx.moveTo(t[3][0], t[3][1]); ctx.lineTo(t[2][0], t[2][1]);
    ctx.lineTo(br[0], br[1]); ctx.lineTo(bl[0], bl[1]); ctx.closePath();
    ctx.fillStyle = shade(base, -0.28); ctx.fill();
    ctx.beginPath(); ctx.moveTo(t[1][0], t[1][1]); ctx.lineTo(t[2][0], t[2][1]);
    ctx.lineTo(br[0], br[1]); ctx.lineTo(brr[0], brr[1]); ctx.closePath();
    ctx.fillStyle = shade(base, -0.13); ctx.fill();
    ctx.beginPath(); ctx.moveTo(t[0][0], t[0][1]); for (var i = 1; i < 4; i++) ctx.lineTo(t[i][0], t[i][1]); ctx.closePath();
    ctx.fillStyle = base; ctx.fill();
  }
  function blob(gx, gy, rx, ry, a) {
    var p = iso(gx, gy, 0); var g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rx);
    g.addColorStop(0, 'rgba(21,27,43,' + a + ')'); g.addColorStop(1, 'rgba(21,27,43,0)');
    ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(1, ry / rx); ctx.translate(-p[0], -p[1]);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p[0], p[1], rx, 0, 7); ctx.fill(); ctx.restore();
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* ---------- furniture ---------- */
  /* deskSet/chair/plant/rack/shelf/table/boardFixture now live in
     studio-furniture.js (frees line budget here) — assigned once init()
     creates ctx; see init(). */
  var deskSet, chair, plant, rack, shelf, table, boardFixture;

  /* ---------- character ---------- */
  function person(p, t) {
    var g = iso(p.cx, p.cy, 0), x = g[0], y = g[1], st = p.st, ph = (t / 1000) + p.ph;
    blob(p.cx, p.cy, 26, 13, .20);
    ctx.save(); ctx.translate(x, y);
    ctx.save(); ctx.scale(1, 0.46);
    ctx.strokeStyle = 'rgba(21,27,43,.09)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 6, 27, 0, 7); ctx.stroke();
    ctx.strokeStyle = ec(p.energy); ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 6, 27, Math.PI * 0.62, Math.PI * 0.62 + Math.PI * 1.76 * (p.energy / 100)); ctx.stroke();
    if (p.active) {
      ctx.strokeStyle = 'rgba(16,185,129,.30)'; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.arc(0, 6, 27, 0, 7); ctx.stroke();
    }
    if (p.pulseUntil && global.performance.now() < p.pulseUntil) {
      /* hand-off pulse: real event, transient glow — not a fake meeting. */
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t / 120);
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(0, 6, 34, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    var breathe = Math.sin(ph * 1.6) * 1.1;
    var slump = st === 'sleeping' ? 7 : 0;
    var tilt = st === 'thinking' ? Math.sin(ph * 0.9) * 0.10 - 0.06 : st === 'sleeping' ? 0.30 : 0;
    var lift = st === 'sleeping' ? 4 : 0;
    ctx.fillStyle = shade(p.c, -0.45); rr(-11, -16, 22, 14, 6); ctx.fill();
    var bodyY = -40 + slump + lift + breathe;
    var gr = ctx.createLinearGradient(0, bodyY, 0, bodyY + 30);
    gr.addColorStop(0, shade(p.c, 0.18)); gr.addColorStop(1, p.c);
    ctx.fillStyle = gr; rr(-13, bodyY, 26, 32, 11); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)'; rr(-13, bodyY, 26, 9, 11); ctx.fill();
    var aL = 0, aR = 0;
    if (st === 'working') { aL = Math.sin(ph * 9) * 2.2; aR = Math.sin(ph * 9 + 2) * 2.2; }
    else if (st === 'thinking') { aR = -9; aL = 1; }
    else if (st === 'coffee') { var k = (Math.sin(ph * 1.5) + 1) / 2; aR = -12 * k; }
    else if (st === 'sleeping') { aL = 5; aR = 5; }
    else if (st === 'meeting' || st === 'alert' || st === 'talking' || st === 'phone') { aL = p.speaking ? Math.sin(ph * 4) * 5 - 3 : 1; aR = 1; }
    ctx.fillStyle = shade(p.c, -0.16);
    rr(-17, bodyY + 8 + aL, 7, 17, 3.5); ctx.fill();
    rr(10, bodyY + 8 + aR, 7, 17, 3.5); ctx.fill();
    ctx.fillStyle = p.skin;
    ctx.beginPath(); ctx.arc(-13.5, bodyY + 25 + aL, 3.6, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(13.5, bodyY + 25 + aR, 3.6, 0, 7); ctx.fill();
    if (st === 'coffee') {
      ctx.fillStyle = '#ffffff'; rr(11, bodyY + 19 + aR, 7, 8, 2); ctx.fill();
      ctx.fillStyle = '#8c5a34'; rr(12, bodyY + 20 + aR, 5, 2, 1); ctx.fill();
    }
    ctx.save(); ctx.translate(0, bodyY - 2); ctx.rotate(tilt);
    ctx.fillStyle = 'rgba(21,27,43,.10)'; ctx.beginPath(); ctx.arc(0, 1, 13, 0, 7); ctx.fill();
    ctx.fillStyle = p.skin; ctx.beginPath(); ctx.arc(0, -1, 12.5, 0, 7); ctx.fill();
    ctx.fillStyle = p.hair; ctx.beginPath(); ctx.arc(0, -3, 12.5, Math.PI * 1.02, Math.PI * 2.0); ctx.fill();
    rr(-12.5, -4, 4, 7, 2); ctx.fill(); rr(8.5, -4, 4, 7, 2); ctx.fill();
    ctx.fillStyle = '#151b2b';
    if (st === 'sleeping') { rr(-6.5, 1, 5, 1.6, 1); ctx.fill(); rr(1.5, 1, 5, 1.6, 1); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(-4.5, 1, 1.9, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(4.5, 1, 1.9, 0, 7); ctx.fill(); }
    ctx.fillStyle = 'rgba(244,63,94,.28)'; ctx.beginPath(); ctx.arc(-8.5, 5, 3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(8.5, 5, 3, 0, 7); ctx.fill();
    ctx.restore();
    var top = bodyY - 20;
    if (st === 'thinking') {
      for (var i = 0; i < 3; i++) {
        var a = (Math.sin(ph * 2.2 - i * 0.7) + 1) / 2;
        ctx.fillStyle = 'rgba(139,92,246,' + (0.25 + a * 0.6) + ')';
        ctx.beginPath(); ctx.arc(14 + i * 7, top - 6 - i * 7 - a * 3, 2.2 + i * 0.9, 0, 7); ctx.fill();
      }
    } else if (st === 'sleeping') {
      for (var j = 0; j < 3; j++) {
        var q = ((ph * 0.55 + j * 0.33) % 1);
        ctx.globalAlpha = Math.max(0, 1 - q); ctx.fillStyle = '#6366f1';
        ctx.font = '700 ' + (9 + j * 3) + 'px var(--mn),monospace'; ctx.textAlign = 'center';
        ctx.fillText('z', 15 + q * 12, top - 2 - q * 24);
      }
      ctx.globalAlpha = 1;
    } else if ((st === 'meeting' || st === 'talking' || st === 'alert') && p.speaking) {
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#cfd7e6'; ctx.lineWidth = 1.2;
      rr(-24, top - 20, 48, 17, 8); ctx.fill(); ctx.stroke();
      for (var d2 = 0; d2 < 3; d2++) {
        var bb = (Math.sin(ph * 4 - d2 * 0.8) + 1) / 2;
        ctx.fillStyle = 'rgba(59,130,246,' + (0.3 + bb * 0.6) + ')';
        ctx.beginPath(); ctx.arc(-11 + d2 * 11, top - 11.5, 2.6, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }

  /* Name pill, drawn in its OWN pass after every body (scene(), 2nd loop) so
     a neighboring seated character (SEATS are only ~1.5 iso-units apart)
     never paints over another's label — the original single-pass order made
     labels clip/overlap at the meeting table. */
  function personLabel(p) {
    var g = iso(p.cx, p.cy, 0);
    ctx.save(); ctx.translate(g[0], g[1]);
    ctx.font = '600 11px var(--fa),Tahoma,sans-serif'; ctx.textAlign = 'center'; ctx.direction = 'rtl';
    var w = ctx.measureText(p.fa).width + 16;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.strokeStyle = 'rgba(21,27,43,.10)'; ctx.lineWidth = 1;
    rr(-w / 2, 16, w, 17, 8.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = p.r === SEL ? '#151b2b' : '#3d4763'; ctx.fillText(p.fa, 0, 28.5);
    ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(w / 2 - 6, 24.5, 2.6, 0, 7); ctx.fill();
    ctx.restore();
  }

  /* Zone floor-name text — same fix as personLabel: furniture drawn after
     the zone tile was covering the name, so it moved to this later pass. */
  function zoneLabel(z) {
    var p = iso(z.x + z.w, z.y + 0.02, 0);
    ctx.save();
    ctx.font = '600 10.5px var(--fa),Tahoma,sans-serif'; ctx.direction = 'rtl'; ctx.textAlign = 'right';
    ctx.fillStyle = mixc('#7b869f', z.c, 0.55); ctx.fillText(z.fa, p[0] - 6, p[1] + 14);
    ctx.restore();
  }

  /* ---------- scene ---------- */
  function scene(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, '#f4f6fb'); g.addColorStop(1, '#dfe5f1');
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);
    ctx.save(); camApply();

    ctx.save();
    ctx.shadowColor = 'rgba(21,32,64,.22)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 26;
    tile(-0.5, -0.5, 14.6, 11, '#dfe5f0');
    ctx.restore();
    for (var gx = 0; gx < 14; gx++) for (var gy = 0; gy < 10; gy++)
      if ((gx + gy) % 2 === 0) tile(gx, gy, 1, 1, 'rgba(255,255,255,.42)');

    ZONES.forEach(function (z) {
      tile(z.x, z.y, z.w, z.h, mixc('#eef1f7', z.c, 0.13));
      tile(z.x, z.y, z.w, z.h, null, mixc('#ffffff', z.c, 0.55), 1.6);
      /* Label TEXT moved to zoneLabel(), drawn in the post-furniture pass
         below (real bug: furniture placed after this point in z-order —
         desks/shelves/racks — painted over the zone name otherwise). */
    });

    ctx.globalAlpha = .9;
    (function () {
      var h = 96;
      var a = iso(-0.5, -0.5, 0), b = iso(14.1, -0.5, 0), c2 = iso(14.1, -0.5, h), d = iso(-0.5, -0.5, h);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d[0], d[1]);
      ctx.closePath(); ctx.fillStyle = '#cdd6e6'; ctx.fill();
      var e = iso(-0.5, 10.5, 0), f = iso(-0.5, 10.5, h), i = iso(-0.5, -0.5, h);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(e[0], e[1]); ctx.lineTo(f[0], f[1]); ctx.lineTo(i[0], i[1]);
      ctx.closePath(); ctx.fillStyle = '#c2ccdf'; ctx.fill();
      [[-0.5, 1.4], [-0.5, 5.2], [-0.5, 8.4]].forEach(function (wpos) {
        var q1 = iso(wpos[0], wpos[1], 34), q2 = iso(wpos[0], wpos[1] + 2.2, 34), q3 = iso(wpos[0], wpos[1] + 2.2, 80), q4 = iso(wpos[0], wpos[1], 80);
        ctx.beginPath(); ctx.moveTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]); ctx.lineTo(q3[0], q3[1]); ctx.lineTo(q4[0], q4[1]);
        ctx.closePath(); var sg2 = ctx.createLinearGradient(q4[0], q4[1], q2[0], q2[1]);
        sg2.addColorStop(0, '#d6ecff'); sg2.addColorStop(1, '#eef8ff');
        ctx.fillStyle = sg2; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
      });
      [[2, -0.5], [6.4, -0.5], [10.8, -0.5]].forEach(function (wpos) {
        var p1 = iso(wpos[0], wpos[1], 34), p2 = iso(wpos[0] + 2.4, wpos[1], 34), p3 = iso(wpos[0] + 2.4, wpos[1], 80), p4 = iso(wpos[0], wpos[1], 80);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]);
        ctx.closePath();
        var sg = ctx.createLinearGradient(p4[0], p4[1], p1[0], p1[1]);
        sg.addColorStop(0, '#bfe3ff'); sg.addColorStop(1, '#eaf6ff');
        ctx.fillStyle = sg; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
      });
    })();
    ctx.globalAlpha = 1;

    deskSet(1.1, 0.7, '#ec4899'); plant(2.7, 2.2, 0.9);
    deskSet(5.1, 0.7, '#8b5cf6'); deskSet(8.1, 0.7, '#3b82f6'); boardFixture(7.0, 0.2, t);
    deskSet(11.1, 0.7, '#f5a524'); plant(13.0, 2.1, 1);
    deskSet(0.6, 3.7, '#14b8a6'); deskSet(0.6, 5.7, '#f43f5e');
    table(5.0, 4.4, 3.6, 1.3);
    SEATS.forEach(function (s) { chair(s[0], s[1], '#b6c0d4'); });
    plant(3.9, 3.4, 0.85); plant(9.5, 6.6, 0.85);
    shelf(10.7, 3.4); deskSet(11.1, 5.4, '#f97316');
    rack(2.1, 8.0, t);
    deskSet(0.2, 8.2, '#6366f1');
    deskSet(5.1, 8.0, '#10b981'); deskSet(7.3, 8.0, '#94a3b8'); deskSet(9.0, 8.0, '#94a3b8');
    (function () {
      blob(11.9, 8.5, 70, 34, .18); box(11.0, 8.0, 2.0, 0.7, 26, '#e7ddcd');
      box(11.6, 9.2, 1.4, 0.7, 14, '#8fb6d8'); plant(13.2, 8.2, 1.05);
    })();

    var painted = ROLES.slice().sort(function (a, b) { return (a.cx + a.cy) - (b.cx + b.cy); });
    painted.forEach(function (p) { person(p, t); });
    ZONES.forEach(function (z) { zoneLabel(z); });
    painted.forEach(function (p) { personLabel(p); });
    ctx.restore();
  }

  /* ---------- state ---------- */
  var SEL = null, MEET = [];
  function applyRoles() {
    /* Meeting honesty guard (mirrors office/dashboard.html's proven rule):
       gathering is driven ONLY by a real ACTIVE meeting from the composed
       payload (latest meeting_started without meeting_ended). A start open
       >10 min expires visually; a stale mood:'meeting' with no live meeting
       object honestly degrades to working — nobody fake-gathers. */
    var am = D.meetings && D.meetings.active;
    var mAge = am ? (Date.now() - Date.parse(am.started_ts)) : Infinity;
    var meetLive = !!(am && isFinite(mAge) && mAge >= 0 && mAge < 600000);
    var inMeet = {};
    if (meetLive) am.participants.forEach(function (r) { inMeet[r] = true; });
    MEET = [];
    ROLES.forEach(function (p, i) {
      var r = D.roles[p.r] || {};
      var mood = r.mood || 'sleeping';
      if (mood === 'meeting' && !inMeet[p.r]) mood = 'working';
      p.st = mood; p.energy = typeof r.energy === 'number' ? r.energy : 0;
      p.active = !!r.active; p.last = r.last_event_time || null;
      p.ph = i * 0.7; p.speaking = false;
      if (inMeet[p.r]) MEET.push(p);
    });
    if (meetLive) MEET.sort(function (a, b) { return am.participants.indexOf(a.r) - am.participants.indexOf(b.r); });
    ROLES.forEach(function (p) {
      var want = [p.hx, p.hy];
      if (inMeet[p.r]) { var i = MEET.indexOf(p); if (i < SEATS.length) want = [SEATS[i][0], SEATS[i][1]]; }
      p.tx = want[0]; p.ty = want[1];
    });
    rail();
    if (SEL && BY[SEL]) open(BY[SEL]); /* keep an open dossier's chat/task list live, not frozen at click-time */
  }
  function tickState(t) {
    ROLES.forEach(function (p) { p.cx += (p.tx - p.cx) * 0.06; p.cy += (p.ty - p.cy) * 0.06; });
    if (MEET.length) { var w = MEET[Math.floor(t / 2600) % MEET.length]; MEET.forEach(function (p) { p.speaking = (p === w); }); }
    var f = SEL ? BY[SEL] : null;
    CAM.tz = f ? 1.75 : 1;
    if (f) { var g = iso(f.cx, f.cy, 0), s = BASE * CAM.tz; CAM.tx = -OFFX - (g[0] - CX0) * s; CAM.ty = -(g[1] - CY0) * s + 40; }
    else { CAM.tx = 0; CAM.ty = 0; }
    var k = RM ? 1 : 0.08;
    CAM.z += (CAM.tz - CAM.z) * k; CAM.x += (CAM.tx - CAM.x) * k; CAM.y += (CAM.ty - CAM.y) * k;
  }

  /* ---------- rail + card ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function rail() {
    var el;
    el = document.getElementById('kP'); if (el) el.textContent = D.ok ? D.progress + '٪' : '—';
    el = document.getElementById('kA'); if (el) el.textContent = D.ok ? (D.counts.doing + D.counts.review + D.counts.awaiting_orchestrator) : '—';
    el = document.getElementById('kB'); if (el) el.textContent = D.ok ? D.counts.blocked : '—';
    var tot = D.tasks.length || 1, bar = document.getElementById('bar'), lg = document.getElementById('lgs');
    if (bar && lg) {
      bar.innerHTML = ''; lg.innerHTML = '';
      ST.forEach(function (s) {
        var n = D.counts[s[0]] || 0;
        if (n) {
          var i = document.createElement('i'); i.style.width = (n / tot * 100) + '%'; i.style.background = s[2];
          i.title = s[1] + ': ' + n; bar.appendChild(i);
        }
        lg.innerHTML += '<span><i style="background:' + s[2] + '"></i>' + esc(s[1]) + '<u>' + n + '</u></span>';
      });
    }
    var cw = document.getElementById('crew');
    if (cw) {
      cw.innerHTML = '';
      ROLES.forEach(function (p) {
        var r = D.roles[p.r] || {};
        var pend = (D.chat && D.chat.pending_by_role && D.chat.pending_by_role[p.r]) || 0;
        var d = document.createElement('div'); d.className = 'cr' + (SEL === p.r ? ' sel' : '');
        d.innerHTML = '<span class="av" style="background:' + p.c + '">' + esc(p.ini) + '</span>' +
          '<span class="nm">' + esc(p.fa) + '</span><span class="md">' + esc(r.mood_fa || global.VCNP.MOOD_FA.working) + '</span>' +
          (pend ? '<span class="pend" title="' + pend + ' پیام در انتظار">' + pend + '</span>' : '') +
          '<span class="en"><i style="width:' + p.energy + '%;background:' + ec(p.energy) + '"></i></span>';
        d.onclick = function () { SEL === p.r ? close() : open(p); };
        cw.appendChild(d);
      });
    }
    var ul = document.getElementById('ev');
    if (ul) {
      ul.innerHTML = '';
      D.events.slice(0, 8).forEach(function (e) {
        var who = BY[e.actor];
        ul.innerHTML += '<li><span class="t">' + esc(String(e.ts || '').slice(11, 16)) + '</span>' +
          '<span class="a" style="background:' + (who ? who.c : '#94a3b8') + '">' + esc(who ? who.en : 'SYS') + '</span>' +
          '<span class="x">' + esc(String(e.action || '').replace(/_/g, ' ')) + (e.task_id ? ' · ' + esc(e.task_id) : '') + '</span></li>';
      });
    }
    updateStatusDot();
  }
  function updateStatusDot() {
    var dot = document.querySelector('.pill .dot');
    if (!dot) return;
    dot.style.background = D.live ? '#10b981' : '#f43f5e';
    dot.title = D.live ? 'زنده' : 'حالت آفلاین — از آخرین داده ذخیره‌شده';
  }
  var cardEl;
  function open(p) {
    /* applyRoles() re-calls open() every tick to keep the dossier fresh —
       preserve any in-progress draft so a live update never wipes it. */
    var draftInput = document.getElementById('chatInput');
    var draft = (SEL === p.r && draftInput) ? draftInput.value : '';
    SEL = p.r;
    var ts = D.tasks.filter(function (t) { return t && t.assignee_role === p.r; });
    var r = D.roles[p.r] || {};
    var h = '<button class="close" id="cc">✕</button><div class="hd"><span class="av" style="background:' + p.c + '">' +
      esc(p.ini) + '</span><div><b>' + esc(p.fa) + '</b><small>' + esc(p.en) + '</small></div></div>' +
      '<div class="chips"><span style="color:' + p.c + '">' + esc(r.mood_fa || '') + '</span>' +
      '<span>انرژی ' + p.energy + '٪</span><span>' + (p.active ? 'فعال' : 'بی‌کار') + '</span></div>' +
      '<h3>تسک‌ها (' + ts.length + ')</h3>';
    if (!ts.length) h += '<div style="font-size:11px;color:var(--mut)">تسکی سپرده نشده است.</div>';
    ts.slice(0, 5).forEach(function (t) {
      var m = ST.filter(function (s) { return s[0] === t.status; })[0] || ['', '—', '#94a3b8'];
      h += '<div class="tk"><b>' + esc(t.title || t.task_id) + '</b><div class="m"><i style="background:' + m[2] + '"></i>' +
        esc(m[1]) + '<code>' + esc(t.task_id) + '</code></div></div>';
    });
    cardEl.innerHTML = h; cardEl.hidden = false;
    if (global.VCNPComms) global.VCNPComms.mountDossier(cardEl, p.r);
    if (draft) { var inp2 = document.getElementById('chatInput'); if (inp2) inp2.value = draft; }
    document.getElementById('cc').onclick = close;
    rail();
  }
  function close() { SEL = null; if (cardEl) cardEl.hidden = true; rail(); }

  /* Transient glow (not a fake meeting) for a real task_assigned/task_created
     event; cold-start only seeds SEEN_EVENT_KEYS, never fires. */
  function pulse(roles, ms) {
    var until = global.performance.now() + (ms || 2600);
    (roles || []).forEach(function (r) { if (BY[r]) BY[r].pulseUntil = until; });
  }
  function detectHandoffs(n) {
    var tasksById = {};
    n.tasks.forEach(function (tk) { if (tk && tk.task_id) tasksById[tk.task_id] = tk; });
    var pulseRoles = [];
    (n.meta.recent_events || []).forEach(function (e) {
      if (!e || (e.action !== 'task_assigned' && e.action !== 'task_created')) return;
      var key = [e.ts, e.actor, e.action, e.task_id].join('|');
      if (SEEN_EVENT_KEYS.has(key)) return;
      SEEN_EVENT_KEYS.add(key);
      if (!HAS_APPLIED) return;
      var tk = tasksById[e.task_id];
      if (e.actor) pulseRoles.push(e.actor);
      if (tk && tk.assignee_role) pulseRoles.push(tk.assignee_role);
      if (global.VCNPComms && tk) {
        var fromFa = (BY[e.actor] || {}).fa || e.actor, toFa = (BY[tk.assignee_role] || {}).fa || tk.assignee_role;
        global.VCNPComms.toast('🤝 ' + fromFa + ' تسک «' + (tk.title || e.task_id) + '» را به ' + toFa + ' سپرد');
      }
    });
    if (pulseRoles.length) pulse(pulseRoles, 2600);
  }

  /* ---------- public: apply a normalized snapshot ---------- */
  function apply(normalized, meta) {
    var n = normalized || (global.VCNP ? global.VCNP.normalize(null) : { ok: false, roles: {}, tasks: [], project: {}, meta: {}, meetings: {}, chat: {}, phone: {} });
    var counts = {}; ST.forEach(function (s) { counts[s[0]] = 0; });
    n.tasks.forEach(function (t) { if (t && Object.prototype.hasOwnProperty.call(counts, t.status)) counts[t.status]++; });
    var pr = typeof n.project.overall_progress === 'number' ? n.project.overall_progress
      : (n.tasks.length ? Math.round(counts.done / n.tasks.length * 100) : 0);
    detectHandoffs(n);
    D = {
      ok: !!n.ok,
      counts: counts,
      tasks: n.tasks,
      roles: n.roles,
      progress: pr,
      events: (n.meta.recent_events || []).slice().sort(function (a, b) { return (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0); }),
      live: !!(meta && meta.live),
      meetings: n.meetings || null,
      chat: n.chat || null,
      phone: n.phone || null,
    };
    HAS_APPLIED = true;
    applyRoles();
  }

  /* ---------- boot / interaction wiring ---------- */
  function resize() {
    DPR = Math.min(2, global.devicePixelRatio || 1); VW = innerWidth; VH = innerHeight;
    cv.width = VW * DPR; cv.height = VH * DPR; cv.style.width = VW + 'px'; cv.style.height = VH + 'px';
  }
  function clock() {
    var d = new Date(), el = document.getElementById('clk');
    if (el) el.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function init() {
    cv = document.getElementById('c'); ctx = cv.getContext('2d');
    cardEl = document.getElementById('card');
    var FUR = global.STUDIO_FURNITURE.create({ ctx: ctx, iso: iso, box: box, blob: blob, rr: rr, mixc: mixc });
    deskSet = FUR.deskSet; chair = FUR.chair; plant = FUR.plant; rack = FUR.rack;
    shelf = FUR.shelf; table = FUR.table; boardFixture = FUR.board;
    resize(); fitBase();
    apply(global.VCNP ? global.VCNP.normalize(global.VCNP_DATA || null) : null, { live: false });
    clock(); global.setInterval(clock, 20000);
    global.addEventListener('resize', function () { resize(); fitBase(); });
    var t0 = global.performance.now();
    (function loop() {
      var t = global.performance.now() - t0; tickState(t); scene(t);
      if (!RM) global.requestAnimationFrame(loop);
    })();
    cv.addEventListener('click', function (e) {
      var wpt = screenToWorld(e.clientX, e.clientY), mx = wpt[0], my = wpt[1];
      var best = null, bd = 1e9;
      ROLES.forEach(function (p) {
        var g = iso(p.cx, p.cy, 0);
        var d = Math.pow(mx - g[0], 2) + Math.pow((my - g[1] + 22) / 1.15, 2); if (d < bd) { bd = d; best = p; }
      });
      if (bd < 44 * 44) { SEL === best.r ? close() : open(best); } else close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    var btnRail = document.getElementById('btnRail');
    if (btnRail) btnRail.onclick = function () {
      var r = document.getElementById('rail'); r.classList.toggle('hid');
      this.textContent = r.classList.contains('hid') ? 'نمایش پنل' : 'پنل وضعیت'; fitBase();
    };
  }

  global.VCNPStudio = { init: init, apply: apply, pulse: pulse };
})(typeof window !== 'undefined' ? window : this);
