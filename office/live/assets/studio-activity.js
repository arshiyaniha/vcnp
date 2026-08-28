/*
 * studio-activity.js — makes the studio feel like a real, currently-working
 * office instead of static furniture: a small persistent desk card (current
 * task_id + progress, or the latest real work note) above anyone with real
 * work on file (`normalized.roles[r].desk`, plan §7.1 desk contract), and a
 * transient speech bubble with the ACTUAL text of whatever a role's newest
 * real ledger event says (via `meta.recent_events` diffing) — never a fake
 * "..." animation, never invented dialogue. Factored like studio-furniture.js
 * so it can draw directly with studio-renderer.js's own ctx/iso/rr, instead
 * of studio-renderer.js growing past its 500-line cap.
 *
 * Usage (called once from studio-renderer.js's init(), after ctx exists):
 *   var ACT = STUDIO_ACTIVITY.create({ctx: ctx, iso: iso, rr: rr});
 *   ACT.apply(normalized);                 // once per payload tick
 *   ACT.drawDeskCard(p);                   // per character, post-furniture pass
 *   ACT.drawSayBubble(p, performanceNow);  // per character, same pass
 */
(function (global) {
  'use strict';

  var ACTION_FA = {
    task_created: 'تسک تازه ساخت', task_assigned: 'تسک را گرفت', task_updated: 'وضعیت را به‌روزرسانی کرد',
    work_logged: 'کاری را ثبت کرد', message_posted: 'پیامی فرستاد', message_answered: 'پاسخ داد',
    meeting_started: 'جلسه را شروع کرد', meeting_ended: 'جلسه را تمام کرد',
    qa_review_passed: 'تأیید کرد', qa_review_rejected: 'رد کرد', phone_call_received: 'تماس را گرفت',
  };

  function create(H) {
    var ctx = H.ctx, iso = H.iso, rr = H.rr;
    var SEEN_KEYS = new Set();
    var HAS_APPLIED = false;
    var SAY = {};   // role -> {text, until}
    var DESK = {};  // role -> short card text, or null

    function shortFile(p) { var s = String(p || '').split('/'); return s[s.length - 1]; }

    function deskText(desk) {
      if (!desk) return null;
      if (desk.task) {
        var pr = Number.isFinite(desk.task.progress_percent) ? desk.task.progress_percent : 0;
        var n = desk.artifacts && desk.artifacts.length ? ' · ' + shortFile(desk.artifacts[desk.artifacts.length - 1]) : '';
        return desk.task.task_id + ' · ' + pr + '%' + n;
      }
      if (desk.last_work_logged && desk.last_work_logged.action_summary) {
        var t = desk.last_work_logged.action_summary;
        return t.length > 28 ? t.slice(0, 27) + '…' : t;
      }
      return null;
    }

    function apply(n) {
      var roles = (n && n.roles) || {};
      DESK = {};
      Object.keys(roles).forEach(function (r) { DESK[r] = deskText(roles[r] && roles[r].desk); });

      var events = (n && n.meta && n.meta.recent_events) || [];
      events.forEach(function (e) {
        if (!e || !e.actor) return;
        var key = [e.ts, e.actor, e.action, e.task_id].join('|');
        if (SEEN_KEYS.has(key)) return;
        SEEN_KEYS.add(key);
        if (!HAS_APPLIED) return; // cold start: seed only, never speak
        var fa = ACTION_FA[e.action] || String(e.action || '').replace(/_/g, ' ');
        SAY[e.actor] = { text: fa + (e.task_id ? ' — ' + e.task_id : ''), until: global.performance.now() + 4500 };
      });
      HAS_APPLIED = true;
    }

    function drawDeskCard(p) {
      var text = DESK[p.r];
      if (!text) return;
      var g = iso(p.cx, p.cy, 0);
      ctx.save(); ctx.translate(g[0], g[1]);
      ctx.font = '600 9px var(--fa),Tahoma,sans-serif'; ctx.textAlign = 'center'; ctx.direction = 'rtl';
      var w = ctx.measureText(text).width + 12;
      ctx.fillStyle = 'rgba(21,27,43,.82)';
      rr(-w / 2, -96, w, 14, 6); ctx.fill();
      ctx.fillStyle = '#e9edf7'; ctx.fillText(text, 0, -86);
      ctx.restore();
    }

    function drawSayBubble(p, now) {
      var s = SAY[p.r];
      if (!s || now >= s.until) return;
      var g = iso(p.cx, p.cy, 0);
      ctx.save(); ctx.translate(g[0], g[1]);
      ctx.font = '600 9.5px var(--fa),Tahoma,sans-serif'; ctx.textAlign = 'center'; ctx.direction = 'rtl';
      var w = Math.min(150, ctx.measureText(s.text).width + 16);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#cfd7e6'; ctx.lineWidth = 1.2;
      rr(-w / 2, -118, w, 19, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#151b2b'; ctx.fillText(s.text, 0, -105);
      ctx.restore();
    }

    return { apply: apply, drawDeskCard: drawDeskCard, drawSayBubble: drawSayBubble };
  }

  global.STUDIO_ACTIVITY = { create: create };
})(typeof window !== 'undefined' ? window : this);
