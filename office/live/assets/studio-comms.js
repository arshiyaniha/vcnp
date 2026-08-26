/*
 * studio-comms.js — the "office feel" DOM layer for the isometric studio
 * view (live-office plan §3/§6, D3/D5, studio follow-up). Canvas-free by
 * design: chat composer, تلفنخانه (telephone exchange) widget, and a small
 * toast-notification system, all built the same way office/dashboard.html's
 * proven Phase 3/5 code does — typed text and recorded audio become REAL
 * message_posted/phone_call_received ledger events via POST /api/message
 * and POST /api/phone; nothing here is optimistic or fabricated. An
 * unanswered thread honestly shows «در انتظار نشست» until a real session
 * replies (chat.session_active, derived from real ledger events) — never a
 * fake typing indicator, never a canned answer.
 *
 * Public API:
 *   VCNPComms.init()               — mount the toast container once at boot
 *   VCNPComms.apply(normalized)    — call every payload tick (SSE/poll)
 *   VCNPComms.toast(text)          — used by studio-renderer.js's hand-off
 *                                    pulse detector too (one toast system)
 *   VCNPComms.mountDossier(el, role) — called by studio-renderer.js's open()
 *                                      to append the chat panel into a
 *                                      selected role's dossier card
 *
 * ZERO npm dependencies — plain DOM + fetch, matches the rest of office/live/.
 */
(function (global) {
  'use strict';

  var ONLINE = (location.protocol === 'http:' || location.protocol === 'https:');
  var D = { chat: { messages: [], pending_by_role: {}, session_active: {} }, phone: { recent: [] } };
  var SEEN_CALL_IDS = new Set(), SEEN_MSG_IDS = new Set();
  var HAS_APPLIED = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function faTime(ts) { if (!ts) return '—'; var t = String(ts).replace('T', ' '); return t.slice(0, 10) + ' · ' + t.slice(11, 16); }
  function fmtDur(ms) { var s = Math.max(0, Math.round((ms || 0) / 1000)); return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2); }
  function fa(role) { var by = global.STUDIO_DATA && global.STUDIO_DATA.BY; return (by && by[role] && by[role].fa) || role; }
  function sessionActive(role) { return !!(D.chat && D.chat.session_active && D.chat.session_active[role]); }
  function pendingCount(role) { var pb = (D.chat && D.chat.pending_by_role) || {}; return (typeof pb[role] === 'number' && pb[role] > 0) ? pb[role] : 0; }
  function chatThreads(role) { return (D.chat && Array.isArray(D.chat.messages)) ? D.chat.messages.filter(function (m) { return m.to_role === role; }) : []; }

  /* ---------------- toast notifications ---------------- */
  function ensureToastBox() {
    var box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div'); box.id = 'toasts';
      document.body.appendChild(box);
    }
    return box;
  }
  function toast(text) {
    var box = ensureToastBox();
    var el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 400); }, 5000);
  }

  /* ---------------- chat composer (mounted into the dossier) ---------------- */
  function sendChatMessage(role, roleFa) {
    var inp = document.getElementById('chatInput'), err = document.getElementById('chatErr'), btn = document.getElementById('chatSend');
    if (!inp || !err) return;
    err.hidden = true;
    var text = String(inp.value || '').trim();
    if (!text) { err.textContent = 'متن پیام خالی است.'; err.hidden = false; return; }
    if (text.length > 2000) { err.textContent = 'پیام بیش از ۲۰۰۰ نویسه است.'; err.hidden = false; return; }
    if (btn) btn.disabled = true;
    fetch('/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_role: role, text: text }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      if (res.status === 200 && res.j && res.j.ok) { inp.value = ''; }
      else if (res.status === 429) { err.textContent = 'سرعت ارسال زیاد است — کمی صبر کنید.'; err.hidden = false; }
      else if (res.j && Array.isArray(res.j.reasons) && res.j.reasons.length) { err.textContent = 'پیام پذیرفته نشد: ' + res.j.reasons.join('؛ '); err.hidden = false; }
      else { err.textContent = 'ارسال ناموفق بود (کد ' + res.status + ').'; err.hidden = false; }
    }).catch(function () {
      err.textContent = 'ارتباط با سرور برقرار نشد — پیام ارسال نشد.'; err.hidden = false;
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function mountDossier(cardEl, role) {
    var roleFa = fa(role);
    var th = chatThreads(role).slice(-5);
    var h = '<h3>گفتگو' + (pendingCount(role) > 0 ? ' <span class="pnd">' + pendingCount(role) + ' بی‌پاسخ</span>' : '') + '</h3>';
    if (th.length) {
      h += '<div class="clog">';
      th.forEach(function (m) {
        h += '<div class="cl u"><b>شما · ' + esc(faTime(m.ts)) + '</b>' + esc(m.text);
        if (m.answer && m.answer.text != null) {
          h += '<div class="cl a"><b>' + esc(String(m.answer.actor || '')) + ' · ' + esc(faTime(m.answer.ts)) + '</b>' + esc(m.answer.text) + '</div>';
        } else {
          var act = sessionActive(role);
          h += '<span class="pnd' + (act ? ' q' : '') + '">' + (act ? 'در انتظار پاسخ' : 'در انتظار نشست') + '</span>';
        }
        h += '</div>';
      });
      h += '</div>';
    } else {
      h += '<div class="none">هنوز گفتگویی با این نقش ثبت نشده است.</div>';
    }
    if (ONLINE) {
      h += '<form class="cform" id="chatForm"><input id="chatInput" type="text" maxlength="2000" autocomplete="off" ' +
        'placeholder="پیامی برای ' + esc(roleFa) + ' بنویسید…"><button class="btn pri" id="chatSend" type="submit">ارسال</button></form>' +
        '<div class="cerr" id="chatErr" hidden></div>';
    } else {
      h += '<div class="coff">حالت آفلاین (file://) — برای گفتگو سرور زنده را روشن کنید: <code>npm run live</code></div>';
    }
    var wrap = document.createElement('div'); wrap.innerHTML = h;
    cardEl.appendChild(wrap);
    var cf = document.getElementById('chatForm');
    if (cf) cf.addEventListener('submit', function (ev) { ev.preventDefault(); sendChatMessage(role, roleFa); });
  }

  /* ---------------- تلفنخانه (phone) widget ---------------- */
  var PHONE = { state: 'idle', rec: null, chunks: [], mime: 'audio/webm', blob: null, url: null,
    startTs: 0, timer: null, secs: 0, recog: null, recogLive: false, transcript: null, interim: '', speechNote: '', stream: null, sending: false };
  function phoneEl() { return document.getElementById('phoneBox'); }
  function pickMime() {
    if (!global.MediaRecorder) return '';
    var chain = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < chain.length; i++) { try { if (MediaRecorder.isTypeSupported(chain[i])) return chain[i]; } catch (e) { /* unsupported */ } }
    return '';
  }
  function speechCtor() { return global.SpeechRecognition || global.webkitSpeechRecognition || null; }
  function phoneSetErr(t) { var e = document.getElementById('phErr'); if (e) { e.textContent = t || ''; e.hidden = !t; } }
  function renderPhoneRec() {
    var rec = document.getElementById('phoneRec'); if (!rec) return;
    if (PHONE.state === 'idle') {
      if (ONLINE) {
        rec.innerHTML = '<button class="phbtn pri" id="phStart" type="button">☎ تماس با مدیر</button><div class="pherr" id="phErr" hidden></div>';
        var b = document.getElementById('phStart'); if (b) b.addEventListener('click', phoneStart);
      } else {
        rec.innerHTML = '<div class="coff">برای ضبط صدا، سرور محلی را روشن کنید — یا از خط فرمان بفرستید:<br>' +
          '<code>node tools/phone-drop.js --text "پیام"</code></div>';
      }
      return;
    }
    if (PHONE.state === 'recording') {
      rec.innerHTML = '<div class="phrow"><span class="phtime" id="phTime">● ' + esc(fmtDur(PHONE.secs)) + '</span>' +
        '<span class="phnt">در حال ضبط</span><button class="phbtn danger" id="phStop" type="button">پایان ضبط</button></div>' +
        '<div class="phlive" id="phLive"></div><div class="pherr" id="phErr" hidden></div>';
      var s = document.getElementById('phStop'); if (s) s.addEventListener('click', phoneStop);
      phonePaintLive();
      return;
    }
    rec.innerHTML = '<audio id="phPrev" controls src="' + esc(PHONE.url || '') + '"></audio>' +
      '<div class="phmeta"><span>' + esc(fmtDur(PHONE.secs)) + '</span><span>' +
      (PHONE.transcript ? 'متن پیوست شد' : '<span class="phnt">بدون متن — فقط صدا</span>') + '</span></div>' +
      '<div class="phrow"><button class="phbtn pri" id="phSend" type="button">ارسال</button>' +
      '<button class="phbtn" id="phDiscard" type="button">دور انداختن</button></div><div class="pherr" id="phErr" hidden></div>';
    var sd = document.getElementById('phSend'), dc = document.getElementById('phDiscard');
    if (sd) sd.addEventListener('click', phoneSend);
    if (dc) dc.addEventListener('click', phoneDiscard);
  }
  function phonePaintLive() {
    var el = document.getElementById('phLive'); if (!el) return;
    if (PHONE.transcript || PHONE.interim) el.innerHTML = '<b>متن زنده:</b> ' + esc(PHONE.transcript || '') + (PHONE.interim ? ' <i>' + esc(PHONE.interim) + '…</i>' : '');
    else if (PHONE.speechNote) el.innerHTML = '<span class="phnt">' + esc(PHONE.speechNote) + '</span>';
    else el.textContent = 'در حال شنیدن…';
  }
  function phoneStartSpeech() {
    var SR = speechCtor();
    if (!SR) { PHONE.speechNote = 'بدون متن — فقط صدا'; phonePaintLive(); return; }
    var r; try { r = new SR(); } catch (e) { PHONE.speechNote = 'بدون متن — فقط صدا'; phonePaintLive(); return; }
    PHONE.recog = r; PHONE.recogLive = true;
    r.lang = 'fa-IR'; r.interimResults = true; r.continuous = false;
    r.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) { var t = String(res[0].transcript || '').trim(); if (t) PHONE.transcript = ((PHONE.transcript ? PHONE.transcript + ' ' : '') + t).trim(); }
        else interim += String(res[0].transcript || '');
      }
      PHONE.interim = interim.trim(); phonePaintLive();
    };
    r.onerror = function () { PHONE.recogLive = false; PHONE.speechNote = PHONE.transcript ? '' : 'بدون متن — فقط صدا'; phonePaintLive(); };
    r.onend = function () { PHONE.recogLive = false; if (!PHONE.transcript && !PHONE.interim) PHONE.speechNote = 'بدون متن — فقط صدا'; phonePaintLive(); };
    try { r.start(); } catch (e) { PHONE.recogLive = false; PHONE.speechNote = 'بدون متن — فقط صدا'; phonePaintLive(); }
  }
  function phoneStart() {
    if (PHONE.state !== 'idle' || !ONLINE) return;
    phoneSetErr('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !global.MediaRecorder) { phoneSetErr('این مرورگر از ضبط صدا پشتیبانی نمی‌کند.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      PHONE.stream = stream;
      var mime = pickMime(), rec;
      try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }); }
      catch (e) {
        try { rec = new MediaRecorder(stream); }
        catch (e2) { stream.getTracks().forEach(function (t) { t.stop(); }); phoneSetErr('شروع ضبط ممکن نشد.'); return; }
      }
      PHONE.rec = rec; PHONE.chunks = []; PHONE.mime = rec.mimeType || mime || 'audio/webm';
      PHONE.transcript = null; PHONE.interim = ''; PHONE.speechNote = ''; PHONE.startTs = Date.now(); PHONE.secs = 0;
      rec.ondataavailable = function (ev) { if (ev && ev.data && ev.data.size) PHONE.chunks.push(ev.data); };
      rec.onerror = function () { phoneSetErr('خطای ضبط رخ داد — ادامه می‌دهیم.'); };
      rec.onstop = phoneAssemble;
      try { rec.start(); } catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); phoneSetErr('شروع ضبط ممکن نشد.'); return; }
      PHONE.state = 'recording'; phoneStartSpeech(); renderPhoneRec();
      PHONE.timer = setInterval(function () {
        PHONE.secs = Date.now() - PHONE.startTs;
        var t = document.getElementById('phTime'); if (t) t.textContent = '● ' + fmtDur(PHONE.secs);
        if (PHONE.secs >= 120000) phoneStop();
      }, 250);
    }).catch(function (err) {
      phoneSetErr('دسترسی به میکروفون ممکن نشد' + (err && err.name === 'NotAllowedError' ? ' — اجازه داده نشد.' : '.'));
    });
  }
  function phoneStop() {
    if (PHONE.state !== 'recording') return;
    if (PHONE.timer) { clearInterval(PHONE.timer); PHONE.timer = null; }
    try { if (PHONE.recog && PHONE.recogLive) PHONE.recog.stop(); } catch (e) { /* best effort */ }
    try { PHONE.rec.stop(); } catch (e) { phoneAssemble(); }
  }
  function phoneAssemble() {
    if (PHONE.stream) { try { PHONE.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* best effort */ } PHONE.stream = null; }
    var type = String(PHONE.mime || 'audio/webm').split(';')[0];
    PHONE.blob = new Blob(PHONE.chunks, { type: type }); PHONE.chunks = [];
    if (PHONE.url) URL.revokeObjectURL(PHONE.url);
    PHONE.url = URL.createObjectURL(PHONE.blob); PHONE.state = 'preview'; renderPhoneRec();
  }
  function phoneDiscard() {
    if (PHONE.timer) { clearInterval(PHONE.timer); PHONE.timer = null; }
    try { if (PHONE.recog && PHONE.recogLive) PHONE.recog.stop(); } catch (e) { /* best effort */ }
    PHONE.recog = null; PHONE.recogLive = false;
    if (PHONE.stream) { try { PHONE.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* best effort */ } PHONE.stream = null; }
    if (PHONE.url) { URL.revokeObjectURL(PHONE.url); PHONE.url = null; }
    PHONE.blob = null; PHONE.rec = null; PHONE.chunks = [];
    PHONE.transcript = null; PHONE.interim = ''; PHONE.speechNote = ''; PHONE.secs = 0; PHONE.state = 'idle';
    renderPhoneRec();
  }
  function phoneSend() {
    if (PHONE.state !== 'preview' || PHONE.sending || !PHONE.blob) return;
    phoneSetErr(''); PHONE.sending = true;
    var btn = document.getElementById('phSend'); if (btn) btn.disabled = true;
    var fr = new FileReader();
    fr.onload = function () {
      var b64 = String(fr.result || ''), comma = b64.indexOf(','); if (comma > 0) b64 = b64.slice(comma + 1);
      fetch('/api/phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_base64: b64, mime: String(PHONE.mime || 'audio/webm').split(';')[0], transcript: PHONE.transcript || null, lang: 'fa-IR', duration_ms: Math.max(0, Math.round(PHONE.secs)) }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
      }).then(function (res) {
        if (res.status === 200 && res.j && res.j.ok) { toast('☎ تماس شما در تلفنخانه ثبت شد و برای مدیر ارسال گردید.'); phoneDiscard(); }
        else if (res.status === 429) phoneSetErr('سرعت ارسال زیاد است — کمی صبر کنید.');
        else if (res.status === 413) phoneSetErr('حجم صدای ارسالی بیش از حد مجاز است (حداکثر ۱۲۰ ثانیه).');
        else if (res.j && Array.isArray(res.j.reasons) && res.j.reasons.length) phoneSetErr('تماس پذیرفته نشد: ' + res.j.reasons.join('؛ '));
        else phoneSetErr('ارسال ناموفق بود (کد ' + res.status + ').');
      }).catch(function () { phoneSetErr('ارتباط با سرور برقرار نشد — تماس ارسال نشد.'); })
        .then(function () { PHONE.sending = false; var b = document.getElementById('phSend'); if (b) b.disabled = false; });
    };
    fr.onerror = function () { PHONE.sending = false; phoneSetErr('خواندن فایل صوتی ناموفق بود.'); };
    fr.readAsDataURL(PHONE.blob);
  }
  function renderPhoneList() {
    var box = phoneEl(); if (!box) return;
    var list = document.getElementById('phoneList');
    if (!list) { list = document.createElement('div'); list.id = 'phoneList'; list.className = 'phcalls'; box.appendChild(list); }
    var rec = document.getElementById('phoneRec');
    if (!rec) { rec = document.createElement('div'); rec.id = 'phoneRec'; rec.className = 'phrec'; box.insertBefore(rec, list); renderPhoneRec(); }
    var calls = (D.phone && Array.isArray(D.phone.recent)) ? D.phone.recent : [];
    var h = '';
    if (!calls.length) { h = '<div class="none">هنوز تماسی ثبت نشده است.</div>'; }
    else {
      var act = sessionActive('ceo');
      calls.forEach(function (c) {
        h += '<div class="phcall"><div class="phmeta"><span>' + esc(faTime(c.ts)) + '</span><span>' + esc(fmtDur(c.duration_ms)) + '</span>' +
          '<span class="pnd' + (c.answered ? '' : ' q') + '">' + (c.answered ? ('پاسخ ' + esc(c.answered_by || '')) : (act ? 'در صف پاسخ' : 'در انتظار نشست')) + '</span></div>';
        if (c.has_transcript && c.transcript) h += '<div class="phtx">' + esc(c.transcript) + '</div>';
        else h += '<div class="phmeta"><span class="phnt">بدون متن — فقط صدا</span></div>';
        if (ONLINE && c.audio_url) h += '<audio controls preload="none" src="' + esc(c.audio_url) + '"></audio>';
        h += '</div>';
      });
    }
    if (list.__h === h) return;
    list.__h = h; list.innerHTML = h;
  }

  /* ---------------- new-arrival diffing → toasts ---------------- */
  function diffAndToast(n) {
    var calls = (n.phone && n.phone.recent) || [];
    calls.forEach(function (c) {
      if (!c || !c.call_id || SEEN_CALL_IDS.has(c.call_id)) return;
      SEEN_CALL_IDS.add(c.call_id);
      if (HAS_APPLIED) toast('📞 تماس جدید در تلفنخانه — ' + (c.has_transcript && c.transcript ? c.transcript : 'بدون متن، فقط صدا'));
    });
    var msgs = (n.chat && n.chat.messages) || [];
    msgs.forEach(function (m) {
      if (!m || !m.message_id || SEEN_MSG_IDS.has(m.message_id)) return;
      SEEN_MSG_IDS.add(m.message_id);
      if (HAS_APPLIED && !m.answer) toast('💬 پیام جدید برای ' + fa(m.to_role) + ': ' + m.text);
    });
  }

  function apply(normalized) {
    var n = normalized || { chat: { messages: [], pending_by_role: {}, session_active: {} }, phone: { recent: [] } };
    diffAndToast(n);
    D = { chat: n.chat || D.chat, phone: n.phone || D.phone };
    renderPhoneList();
    HAS_APPLIED = true;
  }

  function init() { ensureToastBox(); }

  global.VCNPComms = { init: init, apply: apply, toast: toast, mountDossier: mountDossier };
})(typeof window !== 'undefined' ? window : this);
