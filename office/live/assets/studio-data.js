/*
 * studio-data.js — static layout data for the isometric studio renderer,
 * extracted out of studio-renderer.js (live-office plan §5.1/§5.2, Phase 6
 * follow-up) purely to keep studio-renderer.js under the 500-line cap. No
 * behavior here — just the role roster (visual placement only; mood/energy
 * facts come from the live payload), the floor zones, the meeting-table seat
 * coordinates, and the task-status color/label table shared by the rail and
 * dossier card.
 */
(function (global) {
  'use strict';

  var ROLES = [
    { r: 'ceo', fa: 'مدیرعامل', en: 'CEO', ini: 'مد', c: '#f5a524', gx: 11.5, gy: 1, hair: '#2c2438', skin: '#f4c9a3' },
    { r: 'planner', fa: 'برنامه‌ریز', en: 'PLANNER', ini: 'بر', c: '#8b5cf6', gx: 5.5, gy: 1, hair: '#f0e6ff', skin: '#e6ad82' },
    { r: 'orchestrator', fa: 'هماهنگ‌کننده', en: 'ORCH', ini: 'هم', c: '#3b82f6', gx: 8.5, gy: 1, hair: '#16233f', skin: '#c68a5e' },
    { r: 'executor', fa: 'مجری', en: 'EXECUTOR', ini: 'مج', c: '#10b981', gx: 5.5, gy: 8, hair: '#5b3218', skin: '#f4c9a3' },
    { r: 'qa', fa: 'کنترل کیفیت', en: 'QA', ini: 'کی', c: '#14b8a6', gx: 1, gy: 4, hair: '#3b1f2c', skin: '#8d5a34' },
    { r: 'security', fa: 'امنیت', en: 'SECURITY', ini: 'ام', c: '#f43f5e', gx: 1, gy: 6, hair: '#14121d', skin: '#e6ad82' },
    { r: 'rc', fa: 'کنترل منابع', en: 'RESOURCES', ini: 'من', c: '#ec4899', gx: 1.5, gy: 1, hair: '#7c3016', skin: '#f4c9a3' },
    { r: 'librarian', fa: 'کتابدار', en: 'LIBRARIAN', ini: 'کت', c: '#f97316', gx: 11.5, gy: 5, hair: '#d9d4e6', skin: '#c68a5e' },
    { r: 'devops', fa: 'دواپس', en: 'DEVOPS', ini: 'دو', c: '#6366f1', gx: 0.5, gy: 8.5, hair: '#241c30', skin: '#8d5a34' },
  ];
  var BY = {}; ROLES.forEach(function (p) { BY[p.r] = p; p.hx = p.gx; p.hy = p.gy; p.cx = p.gx; p.cy = p.gy; });

  var ZONES = [
    { id: 'side', fa: 'میزهای کناری', x: 0, y: 0, w: 3, h: 2.6, c: '#ec4899' },
    { id: 'plan', fa: 'ردیف برنامه‌ریزی', x: 3.4, y: 0, w: 6.6, h: 2.6, c: '#8b5cf6' },
    { id: 'ceo', fa: 'دفتر مدیرعامل', x: 10.4, y: 0, w: 3.2, h: 2.6, c: '#f5a524' },
    { id: 'gate', fa: 'گیت کیفیت و امنیت', x: 0, y: 3, w: 3, h: 4, c: '#f43f5e' },
    { id: 'meet', fa: 'اتاق جلسه', x: 3.4, y: 3, w: 6.6, h: 4, c: '#3b82f6' },
    { id: 'lib', fa: 'کتابخانه', x: 10.4, y: 3, w: 3.2, h: 4, c: '#f97316' },
    { id: 'ops', fa: 'دواپس', x: 0, y: 7.4, w: 1.6, h: 2.6, c: '#6366f1' },
    { id: 'rack', fa: 'رک سرور', x: 1.9, y: 7.4, w: 1.1, h: 2.6, c: '#14b8a6' },
    { id: 'exec', fa: 'پادهای مجری', x: 3.4, y: 7.4, w: 6.6, h: 2.6, c: '#10b981' },
    { id: 'rec', fa: 'پذیرش', x: 10.4, y: 7.4, w: 3.2, h: 2.6, c: '#0ea5e9' },
  ];
  var SEATS = [[5.2, 4.1], [6.7, 4.1], [8.2, 4.1], [5.2, 5.9], [6.7, 5.9], [8.2, 5.9]];

  var ST = [['todo', 'انجام‌نشده', '#94a3b8'], ['doing', 'در حال انجام', '#3b82f6'],
    ['awaiting_orchestrator', 'منتظر هماهنگ‌کننده', '#8b5cf6'], ['review', 'بازبینی', '#14b8a6'],
    ['blocked', 'مسدود', '#f43f5e'], ['done', 'انجام‌شده', '#10b981']];

  global.STUDIO_DATA = { ROLES: ROLES, BY: BY, ZONES: ZONES, SEATS: SEATS, ST: ST };
})(typeof window !== 'undefined' ? window : this);
