/*
 * studio-furniture.js — static furniture drawing primitives for the
 * isometric studio renderer, extracted out of studio-renderer.js (live-office
 * plan §5.1/§5.2, Phase 6 follow-up) purely to stay under the 500-line cap
 * there. Pure port — same math, same pixel output — just factored behind a
 * small factory so these functions can close over the SAME canvas context
 * and iso-projection helpers studio-renderer.js already owns, instead of
 * re-deriving/duplicating them here.
 *
 * Usage (called once from studio-renderer.js's init(), after ctx exists):
 *   var FUR = STUDIO_FURNITURE.create({ctx: ctx, iso: iso, box: box, blob: blob, rr: rr, mixc: mixc});
 *   var deskSet = FUR.deskSet, chair = FUR.chair, plant = FUR.plant,
 *       rack = FUR.rack, shelf = FUR.shelf, table = FUR.table, board = FUR.board;
 */
(function (global) {
  'use strict';

  function create(H) {
    var ctx = H.ctx, iso = H.iso, box = H.box, blob = H.blob, rr = H.rr, mixc = H.mixc;

    function deskSet(gx, gy, c) {
      blob(gx + 0.5, gy + 0.35, 42, 20, 0.16);
      box(gx, gy, 1.15, 0.62, 17, '#e7ddcd');
      var m = iso(gx + 0.9, gy + 0.2, 17);
      ctx.save(); ctx.translate(m[0], m[1]);
      ctx.fillStyle = '#2b3347'; rr(-13, -26, 26, 18, 3); ctx.fill();
      ctx.fillStyle = mixc('#0f1729', c, 0.35); rr(-11, -24, 22, 14, 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.16)'; rr(-9, -22, 12, 2, 1); ctx.fill(); rr(-9, -18, 16, 2, 1); ctx.fill();
      ctx.fillStyle = '#2b3347'; rr(-2, -8, 4, 5, 1); ctx.fill(); rr(-8, -4, 16, 3, 1.5); ctx.fill();
      ctx.restore();
      var k = iso(gx + 0.35, gy + 0.42, 17);
      ctx.fillStyle = '#cbd3e2'; ctx.save(); ctx.translate(k[0], k[1]); ctx.transform(1, .5, -1, .5, 0, 0);
      rr(-11, -5, 22, 10, 2); ctx.fill(); ctx.restore();
    }
    function chair(gx, gy, c) { blob(gx, gy, 20, 10, .14); box(gx - 0.22, gy - 0.22, 0.44, 0.44, 9, c || '#aeb8cd'); }
    function plant(gx, gy, s) {
      s = s || 1; blob(gx, gy, 20 * s, 10 * s, .15);
      box(gx - 0.16, gy - 0.16, 0.32, 0.32, 9 * s, '#c58a5a');
      var p = iso(gx, gy, 9 * s); ctx.save(); ctx.translate(p[0], p[1]);
      ctx.fillStyle = '#2f9e6b'; ctx.beginPath(); ctx.ellipse(0, -9 * s, 11 * s, 13 * s, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#3fbf83'; ctx.beginPath(); ctx.ellipse(-5 * s, -14 * s, 7 * s, 8 * s, -.4, 0, 7); ctx.fill();
      ctx.fillStyle = '#57d69a'; ctx.beginPath(); ctx.ellipse(6 * s, -12 * s, 6 * s, 7 * s, .5, 0, 7); ctx.fill();
      ctx.restore();
    }
    function rack(gx, gy, t) {
      blob(gx + 0.35, gy + 0.6, 30, 15, .18);
      box(gx, gy, 0.7, 0.7, 54, '#39415c');
      var p = iso(gx + 0.35, gy + 0.35, 54); ctx.save(); ctx.translate(p[0], p[1]);
      for (var i = 0; i < 6; i++) {
        var on = Math.sin(t / 260 + i * 1.7) > 0;
        ctx.fillStyle = 'rgba(255,255,255,.10)'; rr(-13, -46 + i * 7, 26, 5, 2); ctx.fill();
        ctx.fillStyle = on ? '#3fbf83' : 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.arc(-9, -43.5 + i * 7, 1.6, 0, 7); ctx.fill();
        ctx.fillStyle = i % 3 ? 'rgba(255,255,255,.25)' : '#f5a524'; ctx.beginPath(); ctx.arc(-4, -43.5 + i * 7, 1.4, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
    function shelf(gx, gy) {
      blob(gx + 0.4, gy + 0.5, 30, 15, .16);
      box(gx, gy, 0.8, 0.5, 46, '#b98a5e');
      var p = iso(gx + 0.4, gy + 0.25, 46), cols = ['#f43f5e', '#3b82f6', '#10b981', '#f5a524', '#8b5cf6', '#14b8a6'];
      ctx.save(); ctx.translate(p[0], p[1]);
      for (var s = 0; s < 3; s++) for (var b = 0; b < 7; b++) {
        ctx.fillStyle = cols[(s * 3 + b) % 6]; rr(-13 + b * 4, -40 + s * 13, 3, 10, 1); ctx.fill();
      }
      ctx.restore();
    }
    function table(gx, gy, w, d) {
      blob(gx + w / 2, gy + d / 2, 90, 44, .18);
      box(gx, gy, w, d, 15, '#e2d6c4');
      var p = iso(gx + w / 2, gy + d / 2, 15); ctx.save(); ctx.translate(p[0], p[1]);
      ctx.fillStyle = 'rgba(21,27,43,.06)'; ctx.beginPath(); ctx.ellipse(0, 0, 58, 28, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#3b82f6'; rr(-30, -8, 20, 12, 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(6, -2, 4, 0, 7); ctx.fill();
      ctx.fillStyle = '#f5a524'; ctx.beginPath(); ctx.arc(22, 4, 4, 0, 7); ctx.fill();
      ctx.restore();
    }
    function board(gx, gy, t) {
      blob(gx + 0.4, gy + 0.3, 26, 13, .14);
      box(gx, gy, 0.12, 0.9, 60, '#cfd7e6');
      var p = iso(gx + 0.06, gy + 0.45, 60); ctx.save(); ctx.translate(p[0], p[1]);
      ctx.fillStyle = '#12192b'; rr(-4, -46, 8, 44, 3); ctx.fill();
      var txtc = ['#3fbf83', '#7cc4ff', '#ffd27a'];
      for (var i = 0; i < 5; i++) {
        var w = 3 + ((Math.floor(t / 700) + i) % 3);
        ctx.fillStyle = txtc[i % 3]; ctx.globalAlpha = .85; rr(-2.5, -42 + i * 8, w, 3, 1.5); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.restore();
    }

    return { deskSet: deskSet, chair: chair, plant: plant, rack: rack, shelf: shelf, table: table, board: board };
  }

  global.STUDIO_FURNITURE = { create: create };
})(typeof window !== 'undefined' ? window : this);
