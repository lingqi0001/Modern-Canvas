/* Remote announcements and optional feedback. Content lives on the team's
   endpoint so changing an announcement never requires an extension release.
   Treat this feed as untrusted presentation data: it may announce Canvas
   features and collect voluntary product feedback only. It must never request
   passwords, payment details, grades, or other sensitive student information.
   Any changes to the allowed fields, size limits, display cadence, or response
   payload require a code review and matching privacy-policy update. */
(function () {
  'use strict';
  if (window.self !== window.top || window.MCxRemoteContent) return;
  if (typeof window.mcIsCanvas !== 'undefined') {
    if (!window.mcIsCanvas) return;
  } else {
    var h = window.location.hostname.toLowerCase();
    var isAuto = (h === 'instructure.com' || h.endsWith('.instructure.com') ||
                  h === 'canvas.net' || h.endsWith('.canvaslms.com') || h.indexOf('canvaslms.com') !== -1 ||
                  h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
    var customStr = '';
    try { customStr = localStorage.getItem('mc_custom_domains_cache') || ''; } catch (e) {}
    if (!isAuto && (!customStr || customStr.indexOf(h) === -1)) return;
  }
  try {
    var p = localStorage.getItem('mc_paused_until') || '';
    if (p && (p === '-1' || p === 'reload' || Number(p) > Date.now())) return;
    if (document.documentElement.classList.contains('mc-paused')) return;
  } catch (e) {}

  var STATE_KEY = 'mc_remote_content_state_v1';
  var OVERLAY_ID = 'mcx-remote-content-overlay';
  var endpoint = String((window.MCxRemoteContentConfig || {}).feedUrl || '').trim();
  var feed = [];
  var loadingFeed = null;
  var state = { dismissed: {}, snoozed: {}, completed: {} };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c];
    });
  }
  function uid() { return 'mcx-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function readState() {
    try { state = JSON.parse(localStorage.getItem(STATE_KEY)) || state; } catch (_) {}
    state.dismissed = state.dismissed || {}; state.snoozed = state.snoozed || {}; state.completed = state.completed || {};
  }
  function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) {} }
  function normalize(data) {
    var list = Array.isArray(data) ? data : (data && (data.items || data.content || data.announcements));
    if (!Array.isArray(list)) return [];
    // Keep a small number of entries and accept only known item kinds. Enforce
    // per-field length/option limits here as well as on the Worker before using
    // any newly configured survey; feed-authored IDs can otherwise reappear.
    return list.filter(function (x) { return x && x.id && x.title && x.enabled !== false && (x.kind === 'announcement' || x.kind === 'survey' || !x.kind); }).slice(0, 12);
  }
  function request(url, options) {
    return fetch(url, options).then(function (r) {
      if (!r.ok) throw new Error('Server returned ' + r.status);
      return r.json().catch(function () { return {}; });
    });
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function load(force) {
    if (!force && feed.length) return Promise.resolve(feed);
    // 自动检查和 Settings 入口可能在同一秒触发。它们必须等同一趟网络请求，
    // 不能让先失败的那一趟把空数组画出来、后一趟才把内容放进缓存。
    if (loadingFeed) return loadingFeed;
    if (!/^https:\/\//i.test(endpoint)) return Promise.resolve([]);
    var options = { cache: 'no-store', headers: { Accept: 'application/json' } };
    loadingFeed = request(endpoint, options).catch(function () {
      // Worker 刚部署、网络刚恢复时的首个请求偶尔会失败；只重试一次，
      // 不做轮询，也不把失败的请求一直留在页面上。
      return wait(350).then(function () { return request(endpoint, options); });
    }).then(function (data) {
      feed = normalize(data);
      return feed;
    }).catch(function () {
      return feed;
    });
    return loadingFeed.then(function (items) {
      loadingFeed = null;
      return items;
    }, function () {
      loadingFeed = null;
      return feed;
    });
  }
  function isNewUser() {
    return new Promise(function (resolve) {
      if (!chrome || !chrome.storage || !chrome.storage.local) { resolve(false); return; }
      chrome.storage.local.get('mc_install_at', function (data) {
        var installedAt = Number(data && data.mc_install_at);
        // 没有安装时间说明这是功能发布前已经在用的老用户，绝不把他误当新用户。
        resolve(!!installedAt && Date.now() - installedAt < 24 * 60 * 60 * 1000);
      });
    });
  }
  function markdown(text) {
    var lines = esc(text || '').split(/\r?\n/), out = [], inList = false;
    function inline(s) { return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'); }
    lines.forEach(function (line) {
      var m = line.match(/^[-*]\s+(.+)/);
      if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(m[1]) + '</li>'); return; }
      if (inList) { out.push('</ul>'); inList = false; }
      if (/^###\s+/.test(line)) out.push('<h3>' + inline(line.slice(4)) + '</h3>');
      else if (/^##\s+/.test(line)) out.push('<h2>' + inline(line.slice(3)) + '</h2>');
      else if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    });
    if (inList) out.push('</ul>'); return out.join('');
  }
  function currentItem(id) { return feed.filter(function (x) { return String(x.id) === String(id); })[0] || null; }
  function surveyHtml(item) {
    var q = Array.isArray(item.questions) ? item.questions : [];
    if (!q.length) return '';
    return '<form class="mcx-remote-form">' + q.map(function (x, index) {
      var id = esc(x.id || ('q' + index)), label = '<label class="mcx-remote-question">' + esc(x.label || x.question || '') + (x.required ? '<span aria-hidden="true"> *</span>' : '') + '</label>';
      var opts = Array.isArray(x.options) ? x.options : [];
      if (x.type === 'text' || x.type === 'textarea' || x.type === 'reply') return '<div class="mcx-remote-field">' + label + '<textarea data-question="' + id + '" ' + (x.required ? 'required' : '') + ' placeholder="' + esc(x.placeholder || 'Write your answer') + '"></textarea></div>';
      if (x.type === 'rating') return '<div class="mcx-remote-field">' + label + '<div class="mcx-remote-stars" data-question="' + id + '" role="radiogroup">' + [1,2,3,4,5].map(function (n) { return '<button type="button" data-rating="' + n + '" aria-label="' + n + ' out of 5">★</button>'; }).join('') + '</div></div>';
      return '<div class="mcx-remote-field">' + label + opts.map(function (o, n) { var v = esc(typeof o === 'object' ? o.value : o); var t = esc(typeof o === 'object' ? (o.label || o.value) : o); return '<label class="mcx-remote-option"><input type="' + (x.type === 'multi' ? 'checkbox' : 'radio') + '" name="q-' + id + '" value="' + v + '" data-question="' + id + '"><span>' + t + '</span></label>'; }).join('') + '</div>';
    }).join('') + '<div class="mcx-remote-submit-row"><span class="mcx-remote-status" aria-live="polite"></span><button class="mcx-remote-primary" type="submit">Send feedback</button></div></form>';
  }
  function itemHtml(item) {
    var complete = state.completed[item.id];
    return '<article class="mcx-remote-item" data-item="' + esc(item.id) + '">' +
      '<div class="mcx-remote-kicker">' + esc((item.questions || []).length ? 'ANNOUNCEMENT & FEEDBACK' : 'ANNOUNCEMENT') + '</div><h1>' + esc(item.title) + '</h1>' +
      '<div class="mcx-remote-markdown">' + markdown(item.markdown || item.body || '') + '</div>' +
      ((item.questions || []).length && !complete ? surveyHtml(item) : '') +
      (complete ? '<div class="mcx-remote-complete">Thanks — your feedback was sent.</div>' : '') +
    '</article>';
  }
  function shell(items, canSnooze) {
    return '<div class="mcx-remote-scrim"></div><section class="mcx-remote-panel" role="dialog" aria-modal="true" aria-label="News and feedback">' +
      '<header><div><div class="mcx-remote-eyebrow">MODERN CANVAS</div><div class="mcx-remote-title">News & feedback</div></div><div class="mcx-remote-head-actions">' + (canSnooze ? '<button class="mcx-remote-later" type="button">View later</button>' : '') + '<button class="mcx-remote-close" aria-label="Don\'t show again">×</button></div></header>' +
      '<main>' + (items.length ? items.map(itemHtml).join('') : '<div class="mcx-remote-empty"><h1>Nothing new right now</h1><p>Announcements and optional feedback will appear here when available.</p></div>') + '</main></section>';
  }
  function post(item, type, payload) {
    // Submission is user initiated. Only the selected feedback payload, item
    // ID and random local client ID are sent; never attach Canvas page/student
    // content here. The Worker should document access and deletion/retention.
    var url = endpoint ? endpoint.replace(/\/?$/, '/responses') : '';
    if (!url) return Promise.resolve({ ok: false, error: 'No response endpoint is configured.' });
    return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ itemId: item.id, type: type, payload: payload, clientId: clientId() }) })
      .then(function () { return { ok: true }; })
      .catch(function () { return { ok: false, error: 'Could not reach the feedback server. Please try again.' }; });
  }
  function clientId() { var k = 'mc_remote_content_client_id'; var v = localStorage.getItem(k); if (!v) { v = uid(); localStorage.setItem(k, v); } return v; }
  function close(item) { if (item) { state.dismissed[item.id] = Date.now(); saveState(); } var el = document.getElementById(OVERLAY_ID); if (!el) return; el.classList.remove('open'); setTimeout(function () { el.remove(); }, 300); }
  function viewLater(item) { if (item) { state.snoozed[item.id] = Date.now() + 24 * 60 * 60 * 1000; saveState(); } var el = document.getElementById(OVERLAY_ID); if (!el) return; el.classList.remove('open'); setTimeout(function () { el.remove(); }, 300); }
  function open(items, canSnooze) {
    var old = document.getElementById(OVERLAY_ID); if (old) old.remove();
    var el = document.createElement('div'); el.id = OVERLAY_ID; el.className = 'mcx-remote-overlay'; el.innerHTML = shell(items, canSnooze); document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('open'); });
    el.querySelector('.mcx-remote-close').addEventListener('click', function () { close(canSnooze ? items[0] : null); });
    var later = el.querySelector('.mcx-remote-later'); if (later) later.addEventListener('click', function () { viewLater(items[0]); });
    el.addEventListener('click', function (e) { if (e.target === el) close(canSnooze ? items[0] : null); });
    el.querySelectorAll('.mcx-remote-stars button').forEach(function (b) { b.addEventListener('click', function () { var stars = b.parentNode, value = Number(b.getAttribute('data-rating')); stars.querySelectorAll('button').forEach(function (x) { x.classList.toggle('selected', Number(x.getAttribute('data-rating')) <= value); }); stars.setAttribute('data-value', String(value)); }); });
    el.querySelectorAll('.mcx-remote-form').forEach(function (form) { form.addEventListener('submit', function (e) { e.preventDefault(); var article = form.closest('[data-item]'), item = currentItem(article.getAttribute('data-item')), answers = {}; form.querySelectorAll('[data-question]').forEach(function (input) { var q = input.getAttribute('data-question'); if (input.closest('.mcx-remote-stars')) answers[q] = input.parentNode.getAttribute('data-value') || ''; else if (input.type === 'checkbox') (answers[q] || (answers[q] = [])).push(input.value); else if (input.type !== 'radio' || input.checked) answers[q] = input.value; }); var status = form.querySelector('.mcx-remote-status'), required = (item.questions || []).filter(function (q, index) { var key = q.id || ('q' + index); return q.required && (!answers[key] || (Array.isArray(answers[key]) && !answers[key].length)); }); if (required.length) { status.textContent = 'Please answer the required questions.'; return; } status.textContent = 'Sending…'; post(item, 'survey', { answers: answers }).then(function (result) { if (!result.ok) { status.textContent = result.error; return; } state.completed[item.id] = Date.now(); saveState(); article.outerHTML = itemHtml(item); }); }); });
  }
  function show(fromSettings) { load(true).then(function (items) {
    // 后端没有设置任何有效内容时不自动造一个空公告弹窗。
    if (!items.length && !fromSettings) return;
    if (fromSettings) { open(items, false); return; }
    isNewUser().then(function (newUser) {
      if (newUser) return;
      var now = Date.now();
      var unread = items.filter(function (x) { return !state.dismissed[x.id] && !state.completed[x.id] && Number(state.snoozed[x.id] || 0) <= now; }).slice(0, 1);
      if (unread.length) open(unread, true);
    });
  }); }
  document.addEventListener('mcx-open-remote-content', function () { show(true); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById(OVERLAY_ID)) close(); });
  readState();
  window.MCxRemoteContent = { open: function () { show(true); }, refresh: function () { return load(true); } };
  setTimeout(function () { show(false); }, 1200);
})();
