/* Modern Inbox: our own conversation list and reading pane on /conversations.
   Canvas keeps the toolbar (star, archive, delete, reply all live there); this file owns the
   two panes under it. Anything that writes to Canvas is verified by reading it back. */
(function () {
  'use strict';

  // 非 Canvas 站点直接退出
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

  if (window.top !== window) return;

  var KEY = 'mc_inbox_new_ui';
  var OLD_KEY = 'mc_inbox_own_list';
  var HIDE_CLASS = 'mc-inbox-own-list';
  var PAGE = '/conversations';
  var PER_PAGE = 30;
  var PANE_CLASS = 'mcx-inbox-native-pane';

  var state = {
    items: [], next: null, loading: false, loaded: false, error: '',
    sel: {}, me: null, open: 0, detail: null, detailFor: 0,
    detailError: '', mode: 'sender', replyTo: 0, expanded: false, sending: false, sendErr: '',
    draft: {}, files: {}, attachErr: '',
    view: 'list', shelf: 'all', followOpen: false, lensOpen: false, confirm: false,
    remindOpen: false, remindErr: '', remindNote: '',
    since: 0, firstNew: 0, q: '', search: null, scope: '',
    menu: 0, confirmDelete: 0, menuErr: ''
  };
  var root = null;
  var pane = null;
  /* The reply box is drawn into a host on <body> rather than into the column. A backdrop-filter
     can only sample down to the nearest ancestor that is itself a backdrop root, and the column is
     one: it carries its own blur and it scrolls. Mounted on <body> it sees the page, which is the
     only arrangement measured to take a sample here. */
  var host = null;
  var hostRo = null;
  var paneRo = null;
  var placeQueued = false;
  var scrollBound = null;

  /* Everything below Follow Up, Resources and What's New lives in this browser only. Nothing
     here is sent to Canvas and no message content leaves the machine. */
  var FU_KEY = 'mc_inbox_follow_v1';
  var RES_KEY = 'mc_inbox_res_v1';
  var SEEN_KEY = 'mc_inbox_seen_v1';

  function jread(key) {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    return v && typeof v === 'object' ? v : null;
  }

  function jwrite(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      console.log('[MCX inbox] browser storage is full, this index was not kept');
      return false;
    }
  }

  function followList() {
    var v = jread(FU_KEY);
    return Array.isArray(v) ? v : [];
  }

  function resIndex() {
    return jread(RES_KEY) || {};
  }

  function seenMap() {
    return jread(SEEN_KEY) || {};
  }

  /* ---------- search, notes ---------- */

  function matches(hay, q) {
    return String(hay || '').toLowerCase().indexOf(q) >= 0;
  }

  function itemHits(it, q) {
    return matches(it.subject, q) || matches(people(it), q) || matches(it.last_message, q) || matches(it.context_name, q);
  }

  function followHits(x, q) {
    return matches(x.subj, q) || matches(x.course, q) || matches(x.note, q);
  }

  function resHits(x, q) {
    return matches(x.label, q) || matches(x.course, q) || matches(x.sender, q) || matches(x.subj, q);
  }

  /* Writing the note never repaints: rebuilding the row would drop the caret mid-word. */
  function setNote(convId, text) {
    var list = followList();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].conv) === String(convId)) {
        list[i].note = text;
        jwrite(FU_KEY, list);
        return;
      }
    }
  }

  function noteInputHtml(convId, note) {
    return '<input type="text" class="mcx-inbox-noteip" data-note="' + convId + '" value="' + esc(note || '') + '" placeholder="Add a private note…">';
  }

  function fuRowHtml(it) {
    return '<div class="mcx-inbox-fu" data-fu="' + it.conv + '">' +
      '<div class="mcx-inbox-fumain">' +
      '<div class="mcx-inbox-fusubj">' + esc(it.subj) + '</div>' +
      '<div class="mcx-inbox-fumeta">' + (it.course ? esc(mcCourseLabel(it.course, '')) + ' · ' : '') + 'until ' + esc(groupLabel(it.until)) + '</div>' +
      noteInputHtml(it.conv, it.note) +
      '</div>' +
      '<button type="button" class="mcx-inbox-fudone" data-follow-clear="' + it.conv + '">Mark as done</button>' +
      '</div>';
  }

  function shelfRowHtml(it) {
    return '<div class="mcx-inbox-shelf" data-fu="' + it.conv + '">' +
      '<span class="mcx-inbox-shelfkind">' + esc(kindWord(it)) + '</span>' +
      '<div class="mcx-inbox-shelfmain">' +
      '<div class="mcx-inbox-shelflabel">' + esc(it.label) + '</div>' +
      '<div class="mcx-inbox-shelfmeta">' + esc([mcCourseLabel(it.course, it.code), it.sender].filter(Boolean).join(' · ')) + '</div>' +
      '</div>' +
      '<span class="mcx-inbox-shelfwhen">' + esc(groupLabel(it.at)) + '</span>' +
      '<a class="mcx-inbox-lensopen" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">' + icon('open') + '</a>' +
      '</div>';
  }

  function searchHtml() {
    var q = state.q;
    var fu = followList().filter(function (x) { return followHits(x, q); });
    var res = shelfItems().filter(function (x) { return resHits(x, q); });
    var msg = state.items.filter(function (it) { return itemHits(it, q); });
    if (!fu.length && !res.length && !msg.length) {
      return '<div class="mcx-inbox-note">No matches in messages, resources, or reminders.</div>';
    }
    var html = '';
    if (fu.length) {
      html += '<div class="mcx-inbox-grp"><span>Follow Up ' + fu.length + '</span></div>';
      for (var i = 0; i < fu.length; i++) html += fuRowHtml(fu[i]);
    }
    if (res.length) {
      html += '<div class="mcx-inbox-grp"><span>Resources ' + res.length + '</span></div>';
      for (var j = 0; j < res.length; j++) html += shelfRowHtml(res[j]);
    }
    if (msg.length) {
      html += '<div class="mcx-inbox-grp"><span>Messages ' + msg.length + '</span></div>';
      for (var k = 0; k < msg.length; k++) html += rowHtml(msg[k]);
    }
    return html;
  }

  function getActiveScope() {
    // 1. 从 URL hash 读取 (例如 #filter=type=unread 或 #filter=type=starred)
    var hash = String(location.hash || '');
    var m = hash.match(/type=([a-z_]+)/i);
    if (m && m[1]) {
      var t = m[1].toLowerCase();
      if (t === 'unread' || t === 'starred' || t === 'sent' || t === 'archived' || t === 'submission_comments') {
        return t;
      }
    }
    // 2. 从 Canvas 顶部原生下拉选择框 (mailbox-select) 读取文本或选项
    var mb = document.querySelector('[data-testid*="mailbox-select"]') ||
             document.querySelector('input[id*="mailbox-select"]') ||
             document.querySelector('select[name="scope"]');
    if (mb) {
      var val = String(mb.value || mb.getAttribute('value') || '').toLowerCase().trim();
      if (!val) {
        var facade = mb.closest('label, span, div');
        if (facade) val = String(facade.textContent || '').toLowerCase().trim();
      }
      if (val.indexOf('unread') >= 0) return 'unread';
      if (val.indexOf('starred') >= 0) return 'starred';
      if (val.indexOf('sent') >= 0) return 'sent';
      if (val.indexOf('archived') >= 0) return 'archived';
      if (val.indexOf('submission') >= 0) return 'submission_comments';
    }
    return '';
  }

  function buildConversationsUrl(scopeVal) {
    var url = '/api/v1/conversations?per_page=' + PER_PAGE;
    var s = scopeVal !== undefined ? scopeVal : state.scope;
    if (s && s !== 'inbox') {
      url += '&scope=' + encodeURIComponent(s);
    }
    return url;
  }

  function reloadListForScope() {
    var nextScope = getActiveScope();
    /* 原来这里只看 state.loaded。第一趟还在飞的时候它是 false，而这一颗被 DOM 变动监听一遍遍
       叫起来（schedule()），于是同一档被反复"清空＋重开"，几趟回包各追加一次＝行重复。
       现在这一档已经在取就不再动它，也不再抹 state.loading（那是让第二趟起飞的钥匙）。 */
    if (nextScope === state.scope && (state.loaded || state.loading)) return;
    state.scope = nextScope;
    state.items = [];
    state.next = null;
    state.loaded = false;
    state.error = '';
    paintList();
    load(buildConversationsUrl(nextScope), true);
  }

  var boundMailbox = null;
  function bindMailboxSelect() {
    var mb = document.querySelector('[data-testid*="mailbox-select"]') ||
             document.querySelector('input[id*="mailbox-select"]') ||
             document.querySelector('select[name="scope"]');
    if (mb && mb !== boundMailbox) {
      boundMailbox = mb;
      mb.addEventListener('change', function () {
        setTimeout(reloadListForScope, 60);
      });
      mb.addEventListener('input', function () {
        setTimeout(reloadListForScope, 60);
      });
    }
  }

  /* Canvas' own search box stays the one place you type. We only read it. */
  function bindSearch() {
    bindMailboxSelect();
    var box = document.querySelector('[data-testid="message-list-actions-address-book-input"]');
    if (!box || box === state.search) return;
    state.search = box;
    box.addEventListener('input', function () {
      state.q = String(box.value || '').trim().toLowerCase();
      paintList();
    });
  }

  function on() {
    if (localStorage.getItem(KEY) === null) return localStorage.getItem(OLD_KEY) !== '0';
    return localStorage.getItem(KEY) !== '0';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
    });
  }

  function meId() {
    if (state.me !== null) return Promise.resolve(state.me);
    var env = window.ENV || {};
    var guess = env.current_user_id || env.CURRENT_USER_ID || (env.current_user && env.current_user.id) || env.user_id || '';
    if (guess) { state.me = String(guess); return Promise.resolve(state.me); }
    return fetch('/api/v1/users/self', { credentials: 'same-origin' }).then(function (r) {
      return r.json();
    }).then(function (d) {
      state.me = String(d.id || '');
      return state.me;
    }, function () {
      state.me = '';
      return '';
    });
  }

  function csrf() {
    var env = window.ENV || {};
    var t = env.AUTHENTICITY_TOKEN || env.CSRF_TOKEN || '';
    if (!t) {
      var m = String(document.cookie).match(/_csrf_token=([^;]+)/);
      if (m) t = decodeURIComponent(m[1]);
    }
    return t;
  }

  /* ---------- reading a message body ----------
     Canvas hands back either plain text or the teacher's rich text. Plain text keeps its own
     line breaks, so anything that has no markup in it is not run through the sanitizer. */
  var OK_TAGS = {
    A: 1, ABBR: 1, B: 1, BLOCKQUOTE: 1, BR: 1, CAPTION: 1, CODE: 1, COL: 1, COLGROUP: 1,
    DD: 1, DIV: 1, DL: 1, DT: 1, EM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1,
    I: 1, IMG: 1, LI: 1, OL: 1, P: 1, PRE: 1, S: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1,
    TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, U: 1, UL: 1
  };
  var OK_STYLE = {
    'background-color': 1, 'border-collapse': 1, 'border-color': 1, 'border-left': 1,
    'border-spacing': 1, 'border-style': 1, 'border-width': 1, 'caption-side': 1,
    'font-family': 1, 'font-size': 1, 'font-style': 1, 'font-weight': 1, 'letter-spacing': 1,
    'line-height': 1, 'list-style-type': 1, 'margin-bottom': 1, 'margin-left': 1,
    'margin-right': 1, 'margin-top': 1, 'max-width': 1, 'min-height': 1, 'padding-bottom': 1,
    'padding-left': 1, 'padding-right': 1, 'padding-top': 1, 'text-align': 1, 'text-decoration': 1,
    'text-indent': 1, 'vertical-align': 1, 'white-space': 1, 'word-spacing': 1, width: 1, height: 1
  };

  /* Everything else that is not on the list is unwrapped so its words survive. These are thrown
     away whole, because their text is code rather than something a teacher meant to read. */
  var DROP_TAGS = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  function safeUrl(u, tag) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (s.indexOf('javascript:') === 0 || s.indexOf('data:') === 0 || s.indexOf('vbscript:') === 0) return '';
    return s;
  }

  function cleanStyle(el) {
    var keep = [];
    for (var i = 0; i < el.style.length; i++) {
      var prop = el.style[i];
      if (OK_STYLE[prop]) keep.push(prop + ':' + el.style.getPropertyValue(prop));
    }
    el.setAttribute('style', keep.join(';'));
    if (!keep.length) el.removeAttribute('style');
  }

  function scrub(node) {
    var kids = Array.prototype.slice.call(node.children);
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!OK_TAGS[el.tagName]) {
        if (DROP_TAGS[el.tagName]) { el.parentNode.removeChild(el); continue; }
        scrub(el);
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.parentNode.removeChild(el);
        continue;
      }
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var a = 0; a < attrs.length; a++) {
        var name = attrs[a].name.toLowerCase();
        var value = attrs[a].value;
        if (name.indexOf('on') === 0) { el.removeAttribute(attrs[a].name); continue; }
        if (name === 'src' || name === 'href') {
          var ok = safeUrl(value, el.tagName);
          if (!ok) { el.removeAttribute(attrs[a].name); continue; }
          el.setAttribute(name, ok);
          if (name === 'href') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
          continue;
        }
        if (name === 'style') { cleanStyle(el); continue; }
        if (name === 'class' || name === 'id' || name === 'colspan' || name === 'rowspan' ||
            name === 'align' || name === 'valign' || name === 'width' || name === 'height' ||
            name === 'alt' || name === 'title' || name === 'srcset') continue;
        el.removeAttribute(attrs[a].name);
      }
      if (el.tagName === 'IMG' && !el.getAttribute('src')) { el.parentNode.removeChild(el); continue; }
      scrub(el);
    }
  }

  /* A teacher typing "HIMA JAIN <hima.jain@me.com>" puts angle brackets in plain text. Only
     something that really looks like a tag counts as markup, otherwise that address is eaten. */
  function isMarkup(s) {
    return /<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/i.test(s);
  }

  function bodyHtml(raw) {
    var s = String(raw || '');
    if (!isMarkup(s)) {
      return '<p>' + esc(s).split('\n\n').join('</p><p>').split('\n').join('<br>') + '</p>';
    }
    var doc = new DOMParser().parseFromString('<div id="mcx-body">' + s + '</div>', 'text/html');
    var box = doc.getElementById('mcx-body');
    scrub(box);
    return box.innerHTML;
  }

  /* ---------- list ---------- */

  function parseNext(header) {
    if (!header) return null;
    var parts = header.split(',');
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].split(';');
      if (seg.length !== 2) continue;
      if (seg[1].indexOf('rel="next"') >= 0) return seg[0].replace(/^[ ,]*</, '').replace(/>[ ,]*$/, '').trim();
    }
    return null;
  }

  /* [实测 2026-10-13] starred 那一档只有 3 条会话，DOM 里却是 9 行＝同一批叠了三遍，
     点中一条有三行一起翻成选中档。成因是挂载那条尾巴在 Canvas 把我们那一栏摘掉过一次之后会
     再跑一趟 load，而 load 是无脑 concat（另一处隐患：换档重载以前会把 state.loading 抹成
     false，让还在飞的那趟和这一趟一起起飞）。现在三道保险：挂载只在真的没数据时才取；
     被更新一趟超了的回包丢掉；追加只认没见过的 id。
     顺带一条：这一档 Canvas 根本不发 rel="next"（实测只有 current/first/last），
     所以"这一页一条新的都没有就把 next 掐掉"是第三道保险，不是当前这条 bug 的成因。 */
  var reqSeq = 0;

  function load(url, force) {
    if (state.loading && !force) return Promise.resolve();
    var seq = ++reqSeq;
    state.loading = true;
    state.error = '';
    paintList();
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var next = parseNext(r.headers.get('link'));
      return r.json().then(function (d) { return { d: d, next: next }; });
    }).then(function (o) {
      if (seq !== reqSeq) return;
      var got = Array.isArray(o.d) ? o.d : [];
      var have = {};
      for (var i = 0; i < state.items.length; i++) have[state.items[i].id] = 1;
      var fresh = got.filter(function (it) { return it && !have[it.id]; });
      state.items = state.items.concat(fresh);
      state.next = fresh.length ? o.next : null;
      state.loading = false;
      state.loaded = true;
      paintList();
      decidePolarity();
      openFromHash();
      scanNext();
    }, function (e) {
      if (seq !== reqSeq) return;
      state.loading = false;
      state.loaded = true;
      state.error = String(e && e.message || e);
      paintList();
    });
  }

  function dayStart(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ms) {
    var now = dayStart(Date.now());
    var day = dayStart(ms);
    var diff = Math.round((now - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    var d = new Date(ms);
    var opts = d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  function clockLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    if (dayStart(d.getTime()) !== dayStart(Date.now())) return groupLabel(ms);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }

  function fullStamp(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return groupLabel(ms) + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }

  function people(item) {
    var list = item.participants || [];
    var others = list.filter(function (p) { return String(p.id) !== String(state.me); });
    if (!others.length) others = list;
    var names = others.slice(0, 2).map(function (p) { return p.name || p.full_name || ''; }).filter(Boolean);
    if (!names.length) return String(item.subject || '');
    var rest = others.length - names.length;
    return rest > 0 ? names.join(', ') + ', +' + rest : names.join(', ');
  }

  /* 课名一律走用户自己起的那个名字（设置里那颗键写进 Canvas 的 course nickname）。
     Canvas 在自己接口的 context_name 里回的还是官方全名，所以要现查那张表；
     表还没读回来时先照原样画，读完那一趟会重画一次 */
  function mcCourseLabel(name, code) {
    var fn = window.MCxData && window.MCxData.courseLabel;
    if (!fn) return String(name || '');
    return fn(name, code ? String(code).replace(/^course_/, '') : '');
  }

  function mcNicknamesOnce() {
    var api = window.MCxData;
    if (!api || !api.nicknames || mcNickLoaded) return;
    mcNickLoaded = true;
    api.nicknames().then(function (map) {
      if (!map || !Object.keys(map).length) return;
      paintList();
      paintPane();
    });
  }
  var mcNickLoaded = false;

  function initials(item) {
    var list = item.participants || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) !== String(state.me)) {
        var nm = String(list[i].name || list[i].full_name || '');
        if (nm) return nm.charAt(0);
      }
    }
    return '';
  }

  function icon(name) {
    /* The AI mark is not ours to redraw here: it is the same glyph the sidebar row carries,
       taken from the one place that defines it. It is filled on a 24 grid there, so it stays
       filled on a 24 grid here rather than being traced into a 16 grid outline. */
    if (name === 'spark') {
      var ai = window.MCxIcon && window.MCxIcon.ai;
      return ai
        ? '<svg class="mcx-inbox-ico is-ai" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="' + ai + '"/></svg>'
        : '';
    }
    var path = {
      star: '<path d="M8 1.8l1.98 4.01 4.42.64-3.2 3.12.76 4.4L8 11.9l-3.96 2.07.76-4.4-3.2-3.12 4.42-.64L8 1.8z"/>',
      starFill: '<path fill="currentColor" stroke="currentColor" d="M8 1.8l1.98 4.01 4.42.64-3.2 3.12.76 4.4L8 11.9l-3.96 2.07.76-4.4-3.2-3.12 4.42-.64L8 1.8z"/>',
      x: '<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>',
      media: '<rect x="1.8" y="4" width="8.4" height="7.2" rx="1.6"/><path d="M10.2 7.1l3.4-2v5.8l-3.4-2"/>',
      clip: '<path d="M13.6 7.2l-5.1 5.1a3.1 3.1 0 01-4.4-4.4l5.5-5.5a2.1 2.1 0 013 3L7 11.4a1.1 1.1 0 01-1.5-1.5l4.8-4.8"/>',
      reply: '<path d="M6.4 3.6L2.8 7.2l3.6 3.6"/><path d="M2.8 7.2h6a4.4 4.4 0 014.4 4.4v.8"/>',
      send: '<path d="M2.6 8.2l11-5.4-4.3 11-1.6-4.3z"/>',
      person: '<circle cx="8" cy="5.4" r="2.6"/><path d="M3 14.2c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2"/>',
      clock: '<circle cx="8" cy="8" r="6.1"/><path d="M8 4.4V8l2.5 1.6"/>',
      chev: '<path d="M4.6 6.6L8 10l3.4-3.4"/>',
      chevR: '<path d="M6.6 4.6L10 8l-3.4 3.4"/>',
      dots: '<circle cx="8" cy="3.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="12.6" r="1.15" fill="currentColor" stroke="none"/>',
      open: '<path d="M9.4 2.8h3.8v3.8"/><path d="M13.2 2.8L7.6 8.4"/><path d="M11.4 9.6v3.6H2.8V4.6h3.6"/>',
      folder: '<path d="M2.2 4.6h4l1.3 1.6h6.3v7.2H2.2z"/>',
      back: '<path d="M9.6 3.8L5.4 8l4.2 4.2"/>',
      link: '<path d="M6.6 9.4l2.8-2.8"/><path d="M5.6 7.2l-1.3 1.3a2.3 2.3 0 003.2 3.2l1.3-1.3"/><path d="M10.4 8.8l1.3-1.3a2.3 2.3 0 00-3.2-3.2L7.2 5.6"/>',
      check: '<path d="M3.4 8.4l3 3 6.2-6.6"/>',
      adjust: '<path d="M2.6 5.2h6.2M11.8 5.2h1.6M2.6 10.8h1.6M7.2 10.8h6.2"/><circle cx="10.4" cy="5.2" r="1.5"/><circle cx="5.4" cy="10.8" r="1.5"/>',
      again: '<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.6 2.6v3.1h-3.1"/>',
      cal: '<rect x="2.2" y="3.4" width="11.6" height="10.4" rx="2.2"/><path d="M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4"/>'
    }[name] || '';
    return '<svg class="mcx-inbox-ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }

  function sizeText(bytes) {
    var n = Number(bytes) || 0;
    if (!n) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    i = Math.max(0, Math.min(i, 3));
    return (i ? (n / Math.pow(1024, i)).toFixed(1) : n) + ' ' + units[i];
  }

  /* ---------- pulling the useful parts out of a message ---------- */

  var VIDEO_HOST = ['youtube.com', 'youtu.be', 'vimeo.com', 'media_objects', '/media/'];
  var DOC_EXT = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.key', '.pages', '.zip', '.csv', '.txt'];

  function kindOf(url) {
    var s = String(url || '').toLowerCase();
    for (var i = 0; i < VIDEO_HOST.length; i++) if (s.indexOf(VIDEO_HOST[i]) >= 0) return 'video';
    for (var j = 0; j < DOC_EXT.length; j++) if (s.indexOf(DOC_EXT[j]) >= 0) return 'doc';
    if (s.indexOf('forms.gle') >= 0 || s.indexOf('docs.google.com') >= 0) return 'doc';
    return 'link';
  }

  function linkList(raw) {
    var s = String(raw || '');
    var out = [];
    if (!isMarkup(s)) {
      var words = s.split(/\s+/);
      for (var i = 0; i < words.length; i++) {
        var w = words[i].replace(/[),.;]+$/, '');
        if (/^https?:\/\//i.test(w)) out.push({ url: w, label: w });
      }
      return out;
    }
    var doc = new DOMParser().parseFromString('<div id="mcx-l">' + s + '</div>', 'text/html');
    var as = doc.querySelectorAll('a[href]');
    for (var k = 0; k < as.length; k++) {
      var url = safeUrl(as[k].getAttribute('href'), 'A');
      if (!url) continue;
      var txt = String(as[k].textContent || '').replace(/\s+/g, ' ').trim();
      out.push({ url: url, label: txt || url });
    }
    return out;
  }

  function dateList(raw) {
    var s = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/gi, ' ');
    var found = [];
    var named = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,\s*\d{4})?\b/gi;
    var m;
    while ((m = named.exec(s))) if (found.indexOf(m[0]) < 0) found.push(m[0]);
    // 严格匹配日月或年月日，月必须 1-12，日必须 1-31，排斥 0/0 或前后紧跟运算符/比值的假日期
    var numeric = /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/(?:20\d{2}|\d{2}))?\b/g;
    while ((m = numeric.exec(s))) {
      // 避免题号如 "Problem 3/10" 或分式/比率
      var idx = m.index;
      var before = s.slice(Math.max(0, idx - 10), idx).toLowerCase();
      if (!/(?:problem|question|task|step|no|#|\bpage|\bp\.)\s*$/i.test(before)) {
        if (found.indexOf(m[0]) < 0) found.push(m[0]);
      }
    }
    return found.slice(0, 6);
  }

  function lensOf(d) {
    var msgs = d.messages || [];
    var links = [];
    var files = [];
    var dates = [];
    var seenUrl = {};
    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];
      var ls = linkList(msg.body);
      for (var a = 0; a < ls.length; a++) {
        if (seenUrl[ls[a].url]) continue;
        seenUrl[ls[a].url] = 1;
        ls[a].msg = msg.id;
        ls[a].kind = kindOf(ls[a].url);
        links.push(ls[a]);
      }
      var atts = msg.attachments || [];
      for (var b = 0; b < atts.length; b++) {
        var au = safeUrl(atts[b].url, 'A');
        if (!au || seenUrl[au]) continue;
        seenUrl[au] = 1;
        files.push({ url: au, label: atts[b].display_name || atts[b].filename || 'attachment', msg: msg.id, kind: 'file' });
      }
      var ds = dateList(msg.body);
      for (var c = 0; c < ds.length; c++) if (dates.indexOf(ds[c]) < 0) dates.push(ds[c]);
    }
    return { links: links, files: files, dates: dates };
  }

  function harvest(d) {
    var l = lensOf(d);
    var items = [];
    for (var i = 0; i < l.files.length && items.length < 20; i++) {
      items.push({ kind: 'file', label: String(l.files[i].label || '').slice(0, 100), url: String(l.files[i].url || '').slice(0, 250) });
    }
    for (var j = 0; j < l.links.length && items.length < 30; j++) {
      items.push({ kind: l.links[j].kind, label: String(l.links[j].label || '').slice(0, 100), url: String(l.links[j].url || '').slice(0, 250) });
    }
    var idx = resIndex();
    var newest = (d.messages || [])[0] || {};
    idx[d.id] = {
      conv: d.id,
      subj: String(d.subject || '(no subject)').slice(0, 120),
      course: String(d.context_name || '').slice(0, 60),
      code: String(d.context_code || ''),
      sender: String(nameOf(d, newest.author_id) || '').slice(0, 50),
      at: Date.parse(d.last_message_at || '') || Date.now(),
      items: items
    };
    var keys = Object.keys(idx);
    // 保持最多 150 个会话的资源索引，防止撑爆 5MB localStorage
    if (keys.length > 150) {
      keys.sort(function (a, b) { return (idx[a].at || 0) - (idx[b].at || 0); });
      for (var x = 0; x < keys.length - 150; x++) delete idx[keys[x]];
    }
    if (!jwrite(RES_KEY, idx)) {
      // 容灾熔断：若仍触发 QuotaExceeded，主动砍半老数据保全核心配置
      var halfKeys = Object.keys(idx);
      halfKeys.sort(function (a, b) { return (idx[a].at || 0) - (idx[b].at || 0); });
      for (var h = 0; h < Math.floor(halfKeys.length / 2); h++) delete idx[halfKeys[h]];
      jwrite(RES_KEY, idx);
    }
  }

  /* Without this the shelf only ever knows about messages he happened to click. These are read
     a few at a time, always with auto_mark_as_read=false, so scanning can never turn an unread
     dot into a read one. */
  var scanning = false;

  function updateShelfBadge() {
    if (!root) return;
    var badge = root.querySelector('[data-shelf] .mcx-inbox-paneln');
    var idx = resIndex();
    var n = 0;
    Object.keys(idx).forEach(function (k) { n += (idx[k].items || []).length; });
    if (scanning) {
      if (!badge) {
        var btn = root.querySelector('[data-shelf]');
        if (btn) {
          var span = document.createElement('span');
          span.className = 'mcx-inbox-paneln';
          span.textContent = 'Checking for attachments…';
          var chev = btn.querySelector('.mcx-inbox-panelchev');
          if (chev) btn.insertBefore(span, chev);
          else btn.appendChild(span);
        }
      } else {
        badge.textContent = 'Checking for attachments…';
      }
    } else if (badge) {
      badge.textContent = n ? String(n) : '';
      if (!n) badge.remove();
    }
  }

  function scanNext() {
    if (scanning) return;
    var map0 = resIndex();
    if (!state.items.some(function (it) { return !map0[it.id]; })) return;
    scanning = true;
    updateShelfBadge();
    var rounds = 0;
    function step() {
      var map = resIndex();
      var todo = state.items.filter(function (it) { return !map[it.id]; });
      if (!todo.length || rounds++ > 40) {
        scanning = false;
        updateShelfBadge();
        return;
      }
      var batch = todo.slice(0, 3);
      Promise.all(batch.map(function (it) {
        var h = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        var tok = csrf();
        if (tok) h['X-CSRF-Token'] = tok;
        return fetch('/api/v1/conversations/' + it.id + '?format=json&auto_mark_as_read=false', { credentials: 'same-origin', headers: h })
          .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
      })).then(function (got) {
        for (var i = 0; i < got.length; i++) {
          if (!got[i]) continue;
          harvest(got[i]);
          if (got[i].id === state.open && !state.detail) {
            state.detail = got[i];
            state.detailFor = got[i].id;
            paintPane();
          }
        }
        // 静默更新资源徽标，绝不再无脑触发 paintList() 重刷整个左侧会话列表！
        updateShelfBadge();
        setTimeout(step, 400);
      });
    }
    step();
  }

  function kindWord(it) {
    if (it.kind === 'video') return 'Video';
    if (it.kind === 'file') return 'File';
    if (it.kind === 'doc') return 'Doc';
    return 'Link';
  }

  /* ---------- follow up ---------- */

  function followFor(convId) {
    var list = followList();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].conv) === String(convId)) return list[i];
    }
    return null;
  }

  function addFollow(convId, days) {
    var list = followList();
    if (followFor(convId)) return;
    var item = byId(convId);
    var d = state.detail;
    list.push({
      id: 'fu' + Date.now(),
      conv: convId,
      subj: (d && d.subject) || (item && item.subject) || '(no subject)',
      course: (d && d.context_name) || (item && item.context_name) || '',
      note: '',
      until: Date.now() + days * 86400000
    });
    jwrite(FU_KEY, list);
    state.followOpen = true;
    paintList();
    repaintComposer();
    /* The note box is right there the moment you add one, so it takes the caret.
       It moved into the Remind panel with the pill, so the box is in the composer now. */
    var ni = document.querySelector('.mcx-inbox-composer [data-remind-note]');
    if (ni) ni.focus();
  }

  /* keepComposer 只有 Remind 面板里那颗 Remove 会传：清单和左边那一栏要当场就落（不等动画），
     但写信板那块板子得先缩完再拆，缩完那一趟由调用方接着重建。 */
  function clearFollow(convId, keepComposer) {
    jwrite(FU_KEY, followList().filter(function (x) { return String(x.conv) !== String(convId); }));
    paintList();
    if (!keepComposer) repaintComposer();
  }

  /* Changing the day is a real move now that the panel shows what it is set to: addFollow skips
     when the message is already on the list, which would make every chip after the first one look
     dead. This writes the same row either way. */
  function setFollow(convId, days) {
    var hit = followFor(convId);
    if (!hit) { addFollow(convId, days); return; }
    var list = followList();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].conv) === String(convId)) list[i].until = Date.now() + days * 86400000;
    }
    jwrite(FU_KEY, list);
    paintList();
    repaintComposer();
  }

  function daysUntil(ms) {
    return Math.max(1, Math.ceil((ms - Date.now()) / 86400000));
  }

  function isoDay(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function isoDaysFromNow(days) {
    return isoDay(Date.now() + days * 86400000);
  }

  function followPanelHtml() {
    var list = followList();
    var html = '<button type="button" class="mcx-inbox-panel' + (state.followOpen ? ' is-open' : '') + '" data-follow-toggle>' +
      icon('clock') + '<span class="mcx-inbox-panelname">Follow Up</span>' +
      (list.length ? '<span class="mcx-inbox-paneln">' + list.length + '</span>' : '') +
      '<span class="mcx-inbox-panelchev">' + icon('chev') + '</span></button>';
    html += '<div class="mcx-inbox-fus"><div class="mcx-inbox-fusin">';
    if (!list.length) {
      html += '<div class="mcx-inbox-note">No reminders yet. Open a message and choose Remind below the reply box.</div>';
    }
    for (var i = 0; i < list.length; i++) html += fuRowHtml(list[i]);
    return html + '</div></div>';
  }

  /* Remind Yourself moved onto the pill row under the thread, between the reply targets and AI
     Reply: that is the row he is already looking at when he decides what to do with this message.
     The list itself still lives in the Follow Up panel at the top of the column. */
  function remindPillHtml(d) {
    var lit = state.remindOpen || !!followFor(d.id);
    return '<button type="button" class="mcx-inbox-mode' + (lit ? ' on' : '') + '" data-remind>' +
      icon('clock') + (state.remindOpen ? 'Close Remind' : 'Remind') + '</button>';
  }

  var REMIND_QUICK = [[1, 'Tomorrow'], [2, 'In 2 days'], [3, 'In 3 days'], [5, 'In 5 days']];

  function remindPanelHtml(d) {
    if (!state.remindOpen) return '';
    var hit = followFor(d.id);
    var now = hit ? daysUntil(hit.until) : 0;
    var html = '<div class="mcx-inbox-remind' + (hit ? ' is-on' : '') + '">' +
      '<div class="mcx-inbox-remindhead">' + (hit
        ? 'On your list until ' + esc(groupLabel(hit.until))
        : 'Bring this back when you want it') + '</div>' +
      '<div class="mcx-inbox-remindchips">';
    for (var i = 0; i < REMIND_QUICK.length; i++) {
      html += '<button type="button" class="mcx-inbox-chip' + (now === REMIND_QUICK[i][0] ? ' on' : '') +
        '" data-remind-set="' + REMIND_QUICK[i][0] + '">' + REMIND_QUICK[i][1] + '</button>';
    }
    html += '</div>' +
      '<label class="mcx-inbox-aifield is-date"><span>Or choose a date</span>' +
      '<input type="date" class="mcx-inbox-aitxt" data-remind-date min="' + isoDaysFromNow(1) +
      '" value="' + (hit ? isoDay(hit.until) : '') + '"></label>' +
      /* 备注那一格以前只在"已经在清单上"时才出现，而且是列表里那种透明小框。
         现在它一直有，并且和"加进日历"那张卡里的输入框同一副长相（同一个类、同一档底色和边框），
         同一屏里两个能打字的地方不该长得不一样。 */
      '<label class="mcx-inbox-aifield"><span>Note</span>' +
      '<input type="text" class="mcx-inbox-aitxt" data-remind-note placeholder="Add a reminder note…" value="' +
      esc(hit ? hit.note : state.remindNote) + '"></label>' +
      '<div class="mcx-inbox-aifoot">' +
      (state.remindErr ? '<span class="mcx-inbox-reminderr">' + esc(state.remindErr) + '</span>' : '') +
      (hit ? '<button type="button" class="mcx-inbox-aibtn" data-remind-clear="' + d.id + '">Remove reminder</button>' : '') +
      '<button type="button" class="mcx-inbox-aibtn" data-remind-cancel>Cancel</button>' +
      '<button type="button" class="mcx-inbox-aigen" data-remind-go>Set</button>' +
      '</div></div>';
    return html;
  }

  /* ---------- what the message actually hands you ---------- */

  function lensHtml(l) {
    var videos = 0;
    var docs = l.files.length;
    for (var i = 0; i < l.links.length; i++) {
      if (l.links[i].kind === 'video') videos++;
      else if (l.links[i].kind === 'doc') docs++;
    }
    /* Dates are not this card's business any more: they live in the Dates Mentioned plate, which
       is one card whether the model found them or the page did. Counting them here would be a
       number describing something no longer drawn in this box. */
    var counts = [];
    if (l.links.length) counts.push(l.links.length + (l.links.length === 1 ? ' link' : ' links'));
    if (l.files.length) counts.push(l.files.length + (l.files.length === 1 ? ' attachment' : ' attachments'));
    if (videos) counts.push(videos + (videos === 1 ? ' video' : ' videos'));
    var items = l.files.concat(l.links);
    if (!counts.length) return '';
    var html = '<div class="mcx-inbox-lens">' +
      '<div class="mcx-inbox-lenscount">' + esc(counts.join('  ·  ')) + '</div>';
    if (items.length) {
      /* 收着的时候不再数"四条"，而是让 CSS 掐到三行：这一栏宽的时候一行就摆得下三条，
         按条数切会变成"三行只露一行半"。到底有没有被掐掉的东西，由 lensTrim() 量出来决定
         那颗键露不露，不在这里猜列数。 */
      html += '<div class="mcx-inbox-lenslist' + (state.lensOpen ? '' : ' is-clamped') + '">';
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        html += '<div class="mcx-inbox-lensitem" data-jump="' + it.msg + '">' +
          '<span class="mcx-inbox-lenskind">' + esc(kindWord(it)) + '</span>' +
          '<span class="mcx-inbox-lenslabel" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' +
          '<a class="mcx-inbox-lensopen" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">' + icon('open') + '</a>' +
          '</div>';
      }
      html += '</div>';
      if (items.length > 3) {
        html += '<button type="button" class="mcx-inbox-lensmore" data-lens>' +
          (state.lensOpen ? 'Show fewer' : 'Show all ' + items.length) + '</button>';
      }
    }
    return html + '</div>';
  }

  /* Canvas decides who receives a reply. This only says how many people are in the thread and
     makes the choice explicit; it never claims to know the final recipient list. */
  function confirmHtml(d) {
    var n = (d.participants || []).length;
    return '<div class="mcx-inbox-check">' +
      '<div class="mcx-inbox-checkhead">Check your recipients</div>' +
      '<div class="mcx-inbox-checkbody">' + n + ' people are in this conversation. Canvas decides who actually receives it.</div>' +
      '<div class="mcx-inbox-checkrow">' +
      '<button type="button" class="mcx-inbox-mode on" data-confirm="sender">Reply to sender</button>' +
      '<button type="button" class="mcx-inbox-mode" data-confirm="all">Reply all, ' + n + '</button>' +
      '<button type="button" class="mcx-inbox-mode" data-confirm="cancel">Not now</button>' +
      '</div></div>';
  }

  /* ---------- resource shelf ---------- */

  function shelfEntryHtml() {
    var idx = resIndex();
    var n = 0;
    Object.keys(idx).forEach(function (k) { n += (idx[k].items || []).length; });
    return '<button type="button" class="mcx-inbox-panel" data-shelf>' + icon('folder') +
      '<span class="mcx-inbox-panelname">Inbox Resources</span>' +
      (scanning ? '<span class="mcx-inbox-paneln">Scanning</span>'
        : (n ? '<span class="mcx-inbox-paneln">' + n + '</span>' : '')) +
      '<span class="mcx-inbox-panelchev">' + icon('chevR') + '</span></button>';
  }

  function shelfItems() {
    var idx = resIndex();
    var out = [];
    Object.keys(idx).forEach(function (k) {
      var c = idx[k] || {};
      (c.items || []).forEach(function (it) {
        out.push({
          conv: c.conv, subj: c.subj, course: c.course, sender: c.sender, at: c.at || 0,
          kind: it.kind, label: it.label, url: it.url
        });
      });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out;
  }

  function shelfCount(all, chip) {
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      var k = all[i].kind;
      if (chip === 'all' || k === chip || (chip === 'doc' && k === 'file')) n++;
    }
    return n;
  }

  function shelfRowsHtml() {
    var all = shelfItems();
    var rows = [];
    for (var j = 0; j < all.length; j++) {
      var k = all[j].kind;
      if (state.shelf !== 'all' && !(k === state.shelf || (state.shelf === 'doc' && k === 'file'))) continue;
      rows.push(all[j]);
    }
    if (!rows.length) {
      return '<div class="mcx-inbox-note">No saved resources yet. Open a message with an attachment or link to add it here.</div>';
    }
    var html = '';
    for (var r = 0; r < rows.length; r++) html += shelfRowHtml(rows[r]);
    return html;
  }

  function shelfHtml() {
    var all = shelfItems();
    var chips = [['all', 'All'], ['doc', 'Documents'], ['link', 'Links'], ['video', 'Videos']];
    var html = '<div class="mcx-inbox-shelfbar"><button type="button" class="mcx-inbox-back" data-back>' +
      icon('back') + 'Messages</button></div>';
    html += '<div class="mcx-inbox-chips">';
    for (var i = 0; i < chips.length; i++) {
      html += '<button type="button" class="mcx-inbox-chip' + (state.shelf === chips[i][0] ? ' on' : '') +
        '" data-chip="' + chips[i][0] + '">' + chips[i][1] + ' ' + shelfCount(all, chips[i][0]) + '</button>';
    }
    html += '</div>';
    html += '<div class="mcx-inbox-shelflist">' + shelfRowsHtml() + '</div>';
    var n = Object.keys(resIndex()).length;
    html += '<div class="mcx-inbox-shelfnote">Built by reading ' + n + (n === 1 ? ' message' : ' messages') +
      '. New ones are read in the background as the list loads. Nothing here is sent anywhere, it is all kept on this computer.</div>';
    return '<div class="mcx-inbox-shelfview">' + html + '</div>';
  }

  function rowHtml(item) {
    var t = item.last_message_at ? Date.parse(item.last_message_at) : 0;
    var cls = ['mcx-inbox-row'];
    if (item.workflow_state === 'unread') cls.push('is-unread');
    if (state.sel[item.id]) cls.push('is-checked');
    if (state.open === item.id) cls.push('is-open');
    var props = item.properties || [];
    return '<div class="' + cls.join(' ') + '" data-row="' + item.id + '">' +
      '<div class="mcx-inbox-cell">' +
      '<div class="mcx-inbox-leftcol">' +
      '<input type="checkbox" class="mcx-inbox-cb" data-cb="' + item.id + '"' + (state.sel[item.id] ? ' checked' : '') + '>' +
      '<button type="button" class="mcx-inbox-starbtn' + (item.starred ? ' is-starred' : '') + '" data-star="' + item.id + '" aria-label="' + (item.starred ? 'Unstar' : 'Star') + '" title="' + (item.starred ? 'Unstar' : 'Star') + '">' +
      icon(item.starred ? 'starFill' : 'star') +
      '</button>' +
      '</div>' +
      '<span class="mcx-inbox-av" data-av="' + item.id + '">' + esc(initials(item)) + '</span>' +
      '<div class="mcx-inbox-main">' +
      '<div class="mcx-inbox-people">' + esc(people(item)) + '</div>' +
      '<div class="mcx-inbox-subj">' + esc(item.subject || '(no subject)') + '</div>' +
      '<div class="mcx-inbox-prev">' + esc(item.last_message || '') + '</div>' +
      '<div class="mcx-inbox-meta">' +
      (item.context_name ? '<span class="mcx-inbox-course">' + esc(mcCourseLabel(item.context_name, item.context_code)) + '</span>' : '') +
      (props.indexOf('attachment') >= 0 ? '<span class="mcx-inbox-tag">' + icon('clip') + '</span>' : '') +
      '</div></div>' +
      '<div class="mcx-inbox-side"><span class="mcx-inbox-time">' + esc(clockLabel(t)) + '</span></div>' +
      '</div></div>';
  }

  /* The ring waits 200ms before it appears so a fast reply never flashes a spinner, but the
     row itself is there from the first frame. Both panes use this same line. */
  function loadingRow(label) {
    return '<div class="mcx-inbox-load"><span class="mcx-inbox-spin"></span>' + esc(label || 'Loading…') + '</div>';
  }

  function paintAvatars() {
    if (!root) return;
    root.querySelectorAll('[data-av]').forEach(function (el) {
      var id = parseInt(el.getAttribute('data-av'), 10);
      for (var i = 0; i < state.items.length; i++) {
        if (state.items[i].id === id && state.items[i].avatar_url) {
          var img = new Image();
          img.className = 'mcx-inbox-avimg';
          img.alt = '';
          img.src = state.items[i].avatar_url;
          img.onload = function () { el.textContent = ''; el.appendChild(img); };
          break;
        }
      }
    });
  }

  /* An empty list says nothing useful if it just says "no messages" while you are looking at the
     unread filter. The sentence names whichever box is currently filtered. */
  function emptyText() {
    var s = state.scope;
    if (s === 'unread') return 'No unread messages.';
    if (s === 'starred') return 'No starred messages.';
    if (s === 'archived') return 'No archived messages.';
    if (s === 'sent') return 'No sent messages.';
    if (s === 'submission_comments') return 'No comments';
    return 'Your Inbox is empty.';
  }

  function paintList() {
    if (!root) return;
    if (state.q) {
      root.innerHTML = searchHtml();
      paintAvatars();
      return;
    }
    if (state.view === 'shelf') {
      root.innerHTML = shelfHtml();
      return;
    }
    var html = '';
    if (!state.loaded && state.loading) {
      html = loadingRow();
    } else if (state.error && !state.items.length) {
      html = '<div class="mcx-inbox-note">Could not load messages. <button type="button" class="mcx-inbox-retry" data-retry>Try again.</button></div>';
    } else if (!state.items.length) {
      html = state.loaded ? '<div class="mcx-inbox-note">' + esc(emptyText()) + '</div>' : loadingRow();
    } else {
      var last = '';
      for (var i = 0; i < state.items.length; i++) {
        var item = state.items[i];
        var label = groupLabel(item.last_message_at ? Date.parse(item.last_message_at) : 0);
        if (label !== last) {
          last = label;
          html += '<div class="mcx-inbox-grp"><span>' + esc(label) + '</span></div>';
        }
        html += rowHtml(item);
      }
      if (state.loading) html += loadingRow('Loading more messages…');
    }
    root.innerHTML = followPanelHtml() + shelfEntryHtml() + html;
    paintAvatars();
  }

  /* ---------- reading pane ---------- */

  function byId(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function nameOf(d, id) {
    if (!d) return '';
    var list = d.participants || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === String(id)) return list[i].name || list[i].full_name || '';
    }
    return '';
  }

  function visibleText(d, m) {
    var ids = m.participating_user_ids || [];
    var others = ids.filter(function (x) { return String(x) !== String(state.me); });
    if (String(m.author_id) === String(state.me)) {
      return others.length ? 'sent to ' + nameOf(d, others[0]) + (others.length > 1 ? ' and ' + (others.length - 1) + ' more' : '') : 'only you can see this';
    }
    if (others.length <= 1) return 'visible to you only';
    var aud = (d.audience || []).length;
    if (ids.length >= aud) return 'visible to all ' + ids.length + ' in this thread';
    return 'visible to ' + ids.length + ' people';
  }

  /* Canvas says why it refused, in JSON when it can and in an HTML page when it cannot. */
  function why(t) {
    var s = String(t || '');
    try {
      var d = JSON.parse(s);
      if (d && d.errors) {
        return d.errors.map(function (e) { return e.message || String(e); }).join(' ').slice(0, 180);
      }
      if (d && d.error) return String(d.error).slice(0, 180);
    } catch (e) {}
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  /* ---------- the per message menu ----------
     Canvas draws its own ⋯ inside the half of the page we hide, so the actions are rebuilt here.
     Anything with a documented endpoint goes straight to the API and is read back before the
     screen changes. Forward has no public endpoint, so it is handed to Canvas' own control. */

  function fireSeq(el) {
    for (var s = 0; s < SEQ.length; s++) {
      el.dispatchEvent(new MouseEvent(SEQ[s], { bubbles: true, cancelable: true, view: window }));
    }
  }

  function patchConv(id, pairs, field, want, after) {
    var body = pairs.map(function (kv) {
      return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
    }).join('&');
    var headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': csrf()
    };
    fetch('/api/v1/conversations/' + id, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: Object.assign({}, headers, {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      }),
      body: body
    }).then(function (pr) {
      return fetch('/api/v1/conversations/' + id + '?format=json&auto_mark_as_read=false', { credentials: 'same-origin', headers: headers })
        .then(function (r) {
          return r.json().then(function (d) { return { put: pr.status, get: r.status, d: d }; });
        });
    }).then(function (o) {
      if (String(o.d[field]) !== String(want)) {
        state.menuErr = 'Canvas did not update ' + field + '. It is still ' + o.d[field] + '.';
        paintPane();
        return;
      }
      state.menuErr = '';
      if (after) after(o.d);
    }, function (e) {
      state.menuErr = 'Could not connect to Canvas. No changes were made.';
      paintPane();
    });
  }

  function removeConv(id) {
    var headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': csrf()
    };
    fetch('/api/v1/conversations/' + id, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf() }
    }).then(function (pr) {
      return fetch('/api/v1/conversations/' + id + '?format=json&auto_mark_as_read=false', { credentials: 'same-origin', headers: headers })
        .then(function (r) { return { put: pr.status, get: r.status }; }, function () { return { put: pr.status, get: 0 }; });
    }).then(function (o) {
      if (o.get < 400) {
        state.menuErr = 'Canvas still hands back that conversation (HTTP ' + o.get + '), so it is staying in the list.';
        paintPane();
        return;
      }
      state.items = state.items.filter(function (it) { return it.id !== id; });
      jwrite(FU_KEY, followList().filter(function (x) { return String(x.conv) !== String(id); }));
      var idx = resIndex();
      delete idx[id];
      jwrite(RES_KEY, idx);
      state.menu = 0;
      state.confirmDelete = 0;
      state.open = 0;
      state.detail = null;
      state.detailFor = 0;
      paintList();
      paintPane();
    }, function () {
      state.menuErr = 'Could not connect to Canvas. The conversation was not deleted.';
      paintPane();
    });
  }

  function handoverForward(d, m) {
    if (!d) return;
    if (!m) m = targetMsg(d);
    var subj = d.subject || '';
    if (!/^fwd:/i.test(subj)) subj = 'Fwd: ' + subj;
    var senderName = m ? (nameOf(d, m.author_id) || 'Unknown') : '';
    var dateStr = (m && m.created_at) ? new Date(m.created_at).toLocaleString() : '';
    var rawBody = m ? (m.body || '') : '';
    /* 这儿不能开 div.innerHTML：解析那一刻就发图片请求，元素上那句 onerror 会在我们这个
       隔离世界里跑。整仓同一件事的通路是 MCxData.htmlToText（走 DOMParser），它没挂上时
       自己用 DOMParser，不再抄第三种办法 */
    var bodyText = '';
    if (window.MCxData && window.MCxData.htmlToText) {
      try { bodyText = String(window.MCxData.htmlToText(rawBody) || ''); } catch (e) { bodyText = ''; }
    }
    if (!bodyText) {
      try {
        var parsed = new DOMParser().parseFromString('<body>' + rawBody + '</body>', 'text/html');
        bodyText = String(parsed.body && parsed.body.textContent || '');
      } catch (e) { bodyText = ''; }
    }
    bodyText = bodyText.trim();
    var fwdText = '\n\n---------- Forwarded message ---------\n' +
      'From: ' + senderName + '\n' +
      (dateStr ? 'Date: ' + dateStr + '\n' : '') +
      'Subject: ' + (d.subject || '(no subject)') + '\n\n' +
      bodyText;

    function applyToModal(modal) {
      if (!modal) return false;
      var subjInp = modal.querySelector('input[data-testid*="subject" i], input[name="subject"], input[placeholder*="subject" i]');
      if (!subjInp) {
        var inputs = modal.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          var tid = (inp.getAttribute('data-testid') || '').toLowerCase();
          var name = (inp.name || '').toLowerCase();
          if (tid.indexOf('address') >= 0 || tid.indexOf('course') >= 0 || name.indexOf('course') >= 0 || name.indexOf('context') >= 0) continue;
          if (inp.type === 'hidden' || inp.type === 'checkbox') continue;
          subjInp = inp;
          break;
        }
      }
      if (subjInp) {
        try {
          var sSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (sSetter && sSetter.set) sSetter.set.call(subjInp, subj);
          else subjInp.value = subj;
          subjInp.dispatchEvent(new Event('input', { bubbles: true }));
          subjInp.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          subjInp.value = subj;
        }
      }

      var bodyInp = modal.querySelector('textarea');
      if (bodyInp) {
        try {
          var tSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (tSetter && tSetter.set) tSetter.set.call(bodyInp, fwdText);
          else bodyInp.value = fwdText;
          bodyInp.dispatchEvent(new Event('input', { bubbles: true }));
          bodyInp.dispatchEvent(new Event('change', { bubbles: true }));
          bodyInp.focus();
          bodyInp.setSelectionRange(0, 0);
        } catch (e) {
          bodyInp.value = fwdText;
        }
      }
      return true;
    }

    var openModal = document.querySelector('#compose-message-modal');
    if (openModal && openModal.offsetParent !== null) {
      applyToModal(openModal);
      return;
    }

    var cBtn = document.querySelector('[data-testid="compose-button"], [data-testid="compose"], [data-testid*="compose" i], button[aria-label*="compose" i], button[title*="compose" i], a[aria-label*="compose" i], a[title*="compose" i], #compose-btn, a[href*="conversations/new"]');
    if (cBtn) {
      try { cBtn.click(); } catch (e) {}
      fireSeq(cBtn);
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        var modal = document.querySelector('#compose-message-modal');
        if (modal) {
          var bodyInp = modal.querySelector('textarea');
          var subjInp = modal.querySelector('input[data-testid*="subject" i], input[name="subject"], input[placeholder*="subject" i]');
          if (bodyInp || subjInp || tries >= 15) {
            clearInterval(timer);
            applyToModal(modal);
            return;
          }
        }
        if (tries >= 25) {
          clearInterval(timer);
          var box = composerEl('.mcx-inbox-input');
          if (box) {
            box.value = fwdText;
            box.focus();
          }
        }
      }, 100);
    } else {
      var box = composerEl('.mcx-inbox-input');
      if (box) {
        box.value = fwdText;
        box.focus();
      }
    }
  }

  function msgMenuHtml(d, m) {
    var isUnread = d.workflow_state === 'unread';
    var items = [
      ['all', 'Reply all'],
      ['forward', 'Forward'],
      [d.starred ? 'unstar' : 'star', d.starred ? 'Unstar' : 'Star'],
      [isUnread ? 'read' : 'unread', isUnread ? 'Mark as read' : 'Mark as unread'],
      d.workflow_state === 'archived' ? ['unarchive', 'Move back to Inbox'] : ['archive', 'Archive']
    ];
    var html = '<div class="mcx-inbox-menu" role="menu">';
    for (var i = 0; i < items.length; i++) {
      html += '<button type="button" role="menuitem" class="mcx-inbox-menuitem" data-menu="' + items[i][0] + '" data-msg="' + m.id + '">' + esc(items[i][1]) + '</button>';
    }
    if (state.confirmDelete === m.id) {
      html += '<div class="mcx-inbox-menuask">Delete this conversation? This cannot be undone.' +
        '<button type="button" class="mcx-inbox-mode on" data-menu="delete-yes" data-msg="' + m.id + '">Delete</button>' +
        '<button type="button" class="mcx-inbox-mode" data-menu="close">Cancel</button></div>';
    } else {
      html += '<button type="button" role="menuitem" class="mcx-inbox-menuitem" data-menu="delete" data-msg="' + m.id + '">Delete</button>';
    }
    if (state.menuErr) html += '<div class="mcx-inbox-menuerr">' + esc(state.menuErr) + '</div>';
    return html + '</div>';
  }

  /* The message menu is drawn on <body>, not inside the row. Inside the column it could never
     frost anything: the column carries its own blur and it scrolls, and such an ancestor is a
     sampling boundary, so a backdrop-filter below it only sees that column's own flat fill.
     Out here it samples the page. The cost is that a row-anchored float would drift off its row
     when the column scrolls, so scrolling closes it, which is what Canvas' own menu does. */
  var menuHost = null;
  var menuScroller = null;
  var menuCloseTimer = null;

  function menuHostEl() {
    if (menuHost) return menuHost;
    menuHost = document.createElement('div');
    menuHost.className = 'mcx-inbox-menu-host';
    /* The row's delegated handlers live on the column. Out here they would never fire, so the
       host gets the same click handler and the menu's own buttons keep working. */
    menuHost.addEventListener('click', onPaneClick);
    document.body.appendChild(menuHost);
    return menuHost;
  }

  function placeMenu() {
    if (!menuHost || !pane || !menuHost.childElementCount) return;
    var dots = pane.querySelector('[data-msg="' + state.menu + '"] .mcx-inbox-mdots') ||
      pane.querySelector('.mcx-inbox-mdots');
    if (!dots) { dropMenu(); return; }
    var r = dots.getBoundingClientRect();
    if (!r.width) { dropMenu(); return; }
    var box = menuHost.firstElementChild;
    var w = box.offsetWidth, h = box.offsetHeight;
    /* 只写真的动了的那个数：菜单挂在 body 上，重贴一趟不该让菜单自己的板子重新排一次。 */
    var left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
    var top = Math.round(r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    if (menuHost.style.left !== left) menuHost.style.left = left;
    if (menuHost.style.top !== top) menuHost.style.top = top;
  }

  /* 菜单是按那一刻三个点的位置贴上去的，而那一栏刚点开的几帧里还会自己长一次（AI 板子的高度
     是慢慢补回来的，实测过约半秒才稳）。所以开菜单之后补贴几帧，让它始终跟着那颗点走。
     滚动是另一回事：那一栏一滚就收，和 Canvas 自己的菜单一样。 */
  function settleMenu() {
    if (!window.requestAnimationFrame) return;
    var frames = 4;
    (function step() {
      if (!frames-- || !menuHost || !menuHost.childElementCount) return;
      window.requestAnimationFrame(function () {
        if (!menuHost || !menuHost.childElementCount) return;
        placeMenu();
        step();
      });
    })();
  }

  function dropMenu() {
    if (menuScroller) {
      window.removeEventListener('scroll', menuScroller, true);
      menuScroller = null;
    }
    if (menuHost) {
      var menu = menuHost.querySelector('.mcx-inbox-menu');
      if (menu && !menu.classList.contains('mcx-inbox-menu-closing') &&
          !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        if (menuCloseTimer) clearTimeout(menuCloseTimer);
        var ghost = menu.cloneNode(true);
        ghost.setAttribute('aria-hidden', 'true');
        ghost.classList.add('mcx-inbox-menu-closing');
        menuHost.innerHTML = '';
        menuHost.appendChild(ghost);
        menuHost.hidden = false;
        menuCloseTimer = setTimeout(function () {
          menuCloseTimer = null;
          if (!menuHost || menuHost.firstElementChild !== ghost) return;
          menuHost.innerHTML = '';
          menuHost.hidden = true;
        }, 240);
      } else {
        if (menuCloseTimer) clearTimeout(menuCloseTimer);
        menuCloseTimer = null;
        menuHost.innerHTML = '';
        menuHost.hidden = true;
      }
    }
  }

  function renderMenu(d) {
    var msgs = d ? (d.messages || []) : [], m = null;
    for (var i = 0; i < msgs.length; i++) {
      if (String(msgs[i].id) === String(state.menu)) m = msgs[i];
    }
    if (!m) { dropMenu(); return; }
    var h = menuHostEl();
    if (menuCloseTimer) clearTimeout(menuCloseTimer);
    menuCloseTimer = null;
    h.innerHTML = msgMenuHtml(d, m);
    h.hidden = false;
    placeMenu();
    settleMenu();
    if (!menuScroller) {
      /* capture catches the column's own scroll as well as the page's: either one closes it */
      menuScroller = function () {
        state.menu = 0;
        state.menuErr = '';
        paintPane();
      };
      window.addEventListener('scroll', menuScroller, { capture: true, passive: true });
    }
  }

  function msgHtml(d, m, isRoot) {
    var mine = String(m.author_id) === String(state.me);
    var cls = ['mcx-inbox-msg'];
    if (isRoot) cls.push('is-root');
    if (mine) cls.push('is-self');
    var atts = m.attachments || [];
    var attHtml = '';
    for (var a = 0; a < atts.length; a++) {
      var at = atts[a];
      var href = safeUrl(at.url, 'A');
      attHtml += '<a class="mcx-inbox-att" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
        icon('clip') + '<span>' + esc(at.display_name || at.filename || 'attachment') + '</span>' +
        (at.size ? '<span class="mcx-inbox-attsz">' + esc(sizeText(at.size)) + '</span>' : '') + '</a>';
    }
    var who = nameOf(d, m.author_id) || 'Unknown';
    return '<article class="' + cls.join(' ') + '" data-msg="' + m.id + '">' +
      '<div class="mcx-inbox-mhead">' +
      '<span class="mcx-inbox-mav">' + esc(mine ? 'You' : who.charAt(0)) + '</span>' +
      '<div class="mcx-inbox-mwho">' +
      '<div class="mcx-inbox-mname">' + esc(mine ? 'You' : who) + (m.generated ? '<span class="mcx-inbox-mrole">Automatic</span>' : '') + '</div>' +
      '<div class="mcx-inbox-msub">' + esc(fullStamp(m.created_at)) + ' · ' + esc(visibleText(d, m)) + '</div>' +
      '</div>' +
      '<span class="mcx-inbox-macts">' +
      (isRoot ? '<button type="button" class="mcx-inbox-mreply" data-reply="' + m.id + '">' + icon('reply') + 'Reply</button>' : '') +
      '<button type="button" class="mcx-inbox-mdots" data-menubtn="' + m.id + '" aria-label="More options for this message">' + icon('dots') + '</button>' +
      '</span>' +
      '</div>' +
      '<div class="mcx-inbox-mbody">' + bodyHtml(m.body) + '</div>' +
      (m.media_comment ? '<div class="mcx-inbox-mmedia">Voice or video message</div>' : '') +
      (attHtml ? '<div class="mcx-inbox-matts">' + attHtml + '</div>' : '') +
      (!isRoot ? '<div class="mcx-inbox-mfoot"><button type="button" class="mcx-inbox-mreply" data-reply="' + m.id + '">' + icon('reply') + 'Reply</button></div>' : '') +
      '</article>';
  }

  function recipientsHtml(d) {
    var list = (d && d.participants) || [];
    var others = list.filter(function (p) { return p && String(p.id) !== String(state.me); });
    if (!others.length) others = list.filter(Boolean);
    if (!others.length) return '';
    var nameOfP = function (p) { return p ? (p.name || p.full_name || 'User') : ''; };
    if (!state.expanded && others.length > 3) {
      return '<span class="mcx-inbox-recs">' + esc(others.slice(0, 3).map(nameOfP).join(', ')) +
        '</span><button type="button" class="mcx-inbox-recmore" data-recs>show all ' + others.length + '</button>';
    }
    return '<span class="mcx-inbox-recs">' + esc(others.map(nameOfP).join(', ')) + '</span>' +
      (others.length > 3 ? '<button type="button" class="mcx-inbox-recmore" data-recs>show fewer</button>' : '');
  }

  /* Which message a reply is aimed at: the one whose Reply was pressed, otherwise the newest
     message that is not my own. Falling back to msgs[0] when I wrote the last one would make
     "Reply to sender" silently mean everybody. Canvas' own array is newest first. */
  function targetMsg(d) {
    var msgs = d.messages || [];
    if (!msgs.length) return null;
    if (state.replyTo) {
      for (var i = 0; i < msgs.length; i++) if (msgs[i].id === state.replyTo) return msgs[i];
    }
    for (var j = 0; j < msgs.length; j++) {
      if (String(msgs[j].author_id) !== String(state.me)) return msgs[j];
    }
    return msgs[0];
  }

  /* One place to look for a reply-box node: it lives on <body>, not in the column. */
  function composerEl(sel) {
    return (host && host.querySelector(sel)) || null;
  }

  function placeComposer() {
    placeQueued = false;
    if (!host || !pane || !pane.isConnected) return;
    var st = host.style;
    var r = pane.getBoundingClientRect();
    if (!r.width) return;
    var left = Math.round(r.left) + 'px';
    /* pane.clientWidth is the width excluding vertical scrollbar.
       Subtract extra breathing room (e.g. 14px) from the right so the floating composer
       never touches or overlaps the scrollbar track or window edge. */
    var rightGap = 16;
    var w = Math.max(100, (pane.clientWidth || r.width) - rightGap);
    var width = Math.round(w) + 'px';
    var bottom = Math.round(Math.max(0, window.innerHeight - r.bottom)) + 'px';
    /* Only write what moved: a scroll or resize pass that changes nothing must not cost a restyle,
       and the column's own scroll never reaches here at all. */
    if (st.left !== left) st.left = left;
    if (st.width !== width) st.width = width;
    if (st.bottom !== bottom) st.bottom = bottom;
    /* A hidden host measures nothing, and that is the case with no conversation open: the reserve
       has to go back to zero or the column keeps a blank strip the height of the last reply box. */
    var pad = (host.offsetHeight ? host.offsetHeight : 0) + 'px';
    if (pane.style.paddingBottom !== pad) pane.style.paddingBottom = pad;
  }

  function queuePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(placeComposer);
  }

  function composerHost() {
    if (host) return host;
    host = document.createElement('div');
    host.className = 'mcx-inbox-composer-host';
    /* The column's three delegated handlers have to be bound here too: the reply box is no longer
       inside the column, so its clicks would never reach them. */
    host.addEventListener('click', onPaneClick);
    host.addEventListener('input', onPaneInput);
    host.addEventListener('change', onPaneChange);
    document.body.appendChild(host);
    if (window.ResizeObserver) {
      hostRo = new ResizeObserver(queuePlace);
      hostRo.observe(host);
    }
    return host;
  }

  function renderComposer(html) {
    var h = composerHost();
    h.innerHTML = html || '';
    h.hidden = !html;
    queuePlace();
  }

  /* 写信板里会改变板子高度的那两块浮层：AI 回复那一块、Remind 那一块。
     整栏是 innerHTML 重建的，高度不接管＝板子当场跳到新尺寸，里面那些药丸和输入框跟着被顶一下。
     所以重建前先量一次旧高度，重建后把每一块从旧高度推到它自己的新高度。
     推的动作和时长都在 inbox-ai.js 的 slidePlate 里，两块共用同一份，不再抄第二份：
     AI 回复那一块他早就用上了，Remind 那一块以前只是没人把节点递过去。 */
  var PLATE_SEL = ['.mcx-inbox-aireply', '.mcx-inbox-remind'];

  function plateHeights() {
    var out = [];
    for (var i = 0; i < PLATE_SEL.length; i++) {
      var n = composerEl(PLATE_SEL[i]);
      out.push(n ? n.offsetHeight : 0);
    }
    return out;
  }

  function growPlates(froms) {
    var w = window.mcxInboxAi;
    if (!w || !w.growPlate) return;
    for (var i = 0; i < PLATE_SEL.length; i++) {
      /* 节点没在这趟里出现就跳过：growPlate 拿不到第二个参数会退回它自己那块 AI 板子，
         两块都传过去会让 AI 那一块白推一次 */
      var n = composerEl(PLATE_SEL[i]);
      if (n) w.growPlate(froms[i], n);
    }
  }

  /* 收起必须先缩再重建：innerHTML 一跑那块板就没有节点可缩了（AI 那一块同一句话）。
     只递 Remind 那一块的节点，收 Remind 不该把 AI 那一块一起收掉。 */
  function collapseRemindPlate(done) {
    var w = window.mcxInboxAi;
    var n = w && w.collapsePlate ? composerEl('.mcx-inbox-remind') : null;
    if (!n) { done(); return; }
    w.collapsePlate(done, n);
  }

  /* 只重画写信板。换回复对象／开合 Remind 那一块都只改这一排里的东西，
     走 paintPane 会把上面那几张卡（What changed 那些）一起拆掉重建：
     重建那一帧磨砂重新取样＝他看到的闪 0.3 秒；而且整栏 momentarily 空掉，
     滚动位置被浏览器钳一次＝他报的"往上往下跳过去那一下"。 */
  function repaintComposer() {
    if (!pane) return;
    var d = state.detail;
    var froms = plateHeights();
    renderComposer(d && state.open ? composerHtml(d) : '');
    growPlates(froms);
  }

  function composerHtml(d) {
    var last = targetMsg(d);
    var sender = last ? nameOf(d, last.author_id) : '';
    var audience = (d.audience || []).length;
    var many = audience > 2 && String(last && last.author_id) !== String(state.me);
    var modeBtns = '';
    if (sender && String(last.author_id) !== String(state.me)) {
      modeBtns += '<button type="button" class="mcx-inbox-mode' + (state.mode === 'sender' ? ' on' : '') + '" data-mode="sender">Reply to ' + esc(sender) + '</button>' +
        (many ? '<button type="button" class="mcx-inbox-mode' + (state.mode === 'all' ? ' on' : '') + '" data-mode="all">Reply all, ' + audience + ' people</button>' : '');
    }
    /* AI Reply sits with the two target pills rather than on a line of its own. The row is always
       drawn, because on a message where there is no one to answer the other two are empty and a
       button that only exists in some states is a button he has to hunt for. The state of the
       reply flow rides on the right hand end of that same row. Remind is the middle of the three:
       it used to be a line of its own at the bottom of the resources card, far from the box he is
       typing in. */
    var pills = '<div class="mcx-inbox-modes">' + modeBtns + remindPillHtml(d) + aiReplyTrigger() +
      aiReplyStatus() + '</div>';
    var aiWaiting = aiStage() === 'waiting';
    var chips = '';
    var mine = state.files[state.open] || [];
    for (var f = 0; f < mine.length; f++) {
      var rec = mine[f];
      chips += '<span class="mcx-inbox-file">' + icon('clip') +
        '<span>' + esc(rec.name) + '</span>' +
        '<span class="mcx-inbox-attsz">' + (rec.uploading ? 'Uploading' : esc(sizeText(rec.size))) + '</span>' +
        (rec.uploading ? '' : '<button type="button" class="mcx-inbox-filex" data-detach="' + rec.tmp + '" aria-label="Remove">' + icon('x') + '</button>') +
        '</span>';
    }
    var panels = remindPanelHtml(d) +
      (state.confirm ? confirmHtml(d) : '') +
      aiReplyPanel() +
      (chips ? '<div class="mcx-inbox-files">' + chips + '</div>' : '');
    var bodyWrap = panels ? '<div class="mcx-inbox-composer-body">' + panels + '</div>' : '';
    return '<div class="mcx-inbox-composer">' + pills +
      bodyWrap +
      '<div class="mcx-inbox-crow">' +
      '<textarea class="mcx-inbox-input" rows="2" placeholder="' + (aiWaiting ? 'Drafting your reply…' : 'Write a message…') + '"' +
      (state.sending || aiWaiting ? ' disabled' : '') + '>' + esc(state.draft[state.open] || '') + '</textarea>' +
      '<button type="button" class="mcx-inbox-clip" data-attach aria-label="Add attachment">' + icon('clip') + '</button>' +
      '<button type="button" class="mcx-inbox-clip" data-media aria-label="Record audio or video" title="Record audio or video">' + icon('media') + '</button>' +
      '<button type="button" class="mcx-inbox-send"' + (state.sending || aiWaiting ? ' disabled' : '') + '>' + icon('send') + 'Send</button>' +
      '</div>' +
      '<input type="file" class="mcx-inbox-fileinput" multiple>' +
      (state.sending ? '<div class="mcx-inbox-cnote">Sending</div>' : '') +
      (state.attachErr ? '<div class="mcx-inbox-cerr">' + esc(state.attachErr) + '</div>' : '') +
      (state.sendErr ? '<div class="mcx-inbox-cerr">' + esc(state.sendErr) + '</div>' : '') +
      '</div>';
  }

  /* The composer is rebuilt on every repaint, so whatever is typed has to be kept here or
     pressing a mode pill would eat the half-written reply. */
  function saveDraft() {
    var box = composerEl('.mcx-inbox-input');
    if (box && state.open) state.draft[state.open] = box.value;
  }

  function noteFrom(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return false;
    var convId = t.getAttribute('data-note');
    if (!convId) return false;
    setNote(parseInt(convId, 10), t.value);
    /* The same note has a box in the list and a box in the reading pane. Repainting would drop the
       caret mid-word, so the other one is written in place instead. Without this the left row
       keeps showing the note as it was when that column last drew, which reads as "my note was
       never saved" the moment you look across. */
    if (/^\d+$/.test(convId)) {
      var twins = document.querySelectorAll('[data-note="' + convId + '"]');
      for (var i = 0; i < twins.length; i++) {
        if (twins[i] !== t) twins[i].value = t.value;
      }
    }
    return true;
  }

  /* 面板里那颗备注框。它和列表／阅读栏那两颗不是一回事：还没加进清单时根本没有行可写，
     所以字先存在 state 里，Set 那一趟再落；已经在清单上就直接落，两边都同步左边列表那一颗
     （重画会踢掉光标，所以照 noteFrom 的写法就地改值）。 */
  function remindNoteFrom(e) {
    var t = e.target;
    if (!t || !t.getAttribute || !t.hasAttribute('data-remind-note')) return false;
    state.remindNote = String(t.value || '');
    if (followFor(state.open)) setNote(state.open, state.remindNote);
    var other = document.querySelector('[data-note="' + state.open + '"]');
    if (other && other !== t) other.value = t.value;
    return true;
  }

  function writeRemindNote() {
    if (!followFor(state.open)) return;
    setNote(state.open, state.remindNote);
  }

  function onListInput(e) {
    noteFrom(e);
  }

  function onPaneInput(e) {
    if (window.mcxInboxAi && window.mcxInboxAi.paneInput(e)) return;
    if (remindNoteFrom(e)) return;
    if (noteFrom(e)) return;
    if (e.target && e.target.classList && e.target.classList.contains('mcx-inbox-input')) {
      state.draft[state.open] = e.target.value;
    }
  }

  /* The AI plate and the reply helper both live in inbox-ai.js. They are reached through these
     two lines so this file stays the only one that owns when the column is repainted. */
  function ai() {
    return window.mcxInboxAi && window.mcxInboxAi.on() ? window.mcxInboxAi : null;
  }

  function aiPlate(d, rawDates) {
    var w = ai();
    return w ? w.plateHtml(d, rawDates) : '';
  }

  function aiReplyTrigger() {
    var w = ai();
    return w ? w.replyTrigger() : '';
  }

  function aiReplyPanel() {
    var w = ai();
    return w ? w.replyPanel() : '';
  }

  function aiReplyStatus() {
    var w = window.mcxInboxAi;
    return w ? w.replyStatus() : '';
  }

  function aiStage() {
    var w = window.mcxInboxAi;
    return w ? w.replyStage() : '';
  }

  function aiPlateHeight() {
    var w = window.mcxInboxAi;
    return w ? w.plateHeight() : 0;
  }

  function aiGrowPlate(from) {
    var w = window.mcxInboxAi;
    if (w) w.growPlate(from);
  }

  /* The plates are our own nodes, so the wall can be packed as soon as this column exists. It has
     to happen after innerHTML and before anything measures the column below it. */
  /* 摘要墙要等节点进了文档才量得到宽度 */
  function aiWall() {
    var w = ai();
    if (w && w.wallPaint) w.wallPaint();
  }

  /* 收着的时候露三行。行高不写死：这一条的高度是那颗 26px 的打开键顶出来的，
     字号一档一变（实测他那一屏一行 35px，不是我以为的 30px），硬写高度就会把第三行切成半截。
     所以量前三行自己占多高：第四行的起点减掉第一行的起点，再减掉一条行缝。
     列数也不在这里重算——CSS 的 minmax 才是写规则的那个人。 */
  var lensRo = null;
  var lensQueued = false;

  function lensTrim() {
    if (!pane) return;
    var list = pane.querySelector('.mcx-inbox-lenslist.is-clamped');
    var more = pane.querySelector('.mcx-inbox-lensmore');
    if (!list || !more) {
      /* 展开那一趟、或这一封根本没有名单：观察器要摘掉，不然它守着一颗已经不在文档里的节点 */
      if (lensRo) lensRo.disconnect();
      return;
    }
    var kids = list.children;
    var tops = [];
    for (var i = 0; i < kids.length; i++) {
      if (tops.indexOf(kids[i].offsetTop) < 0) tops.push(kids[i].offsetTop);
    }
    if (tops.length <= 3) {
      list.style.maxHeight = '';
      more.hidden = true;
      return;
    }
    var gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    list.style.maxHeight = (tops[3] - tops[0] - gap) + 'px';
    more.hidden = false;
    if (!lensRo && window.ResizeObserver) {
      lensRo = new window.ResizeObserver(function () {
        if (lensQueued || !window.requestAnimationFrame) return;
        lensQueued = true;
        window.requestAnimationFrame(function () { lensQueued = false; lensTrim(); });
      });
    }
    if (lensRo) lensRo.observe(list);
  }

  function paintPane() {
    try {
      _paintPaneInner();
    } catch (err) {
      console.error('[MCX inbox] paintPane render error:', err);
      if (pane) {
        var itm = state.open ? byId(state.open) : null;
        pane.innerHTML = '<div class="mcx-inbox-head"><div class="mcx-inbox-hwho">' + esc(itm ? mcCourseLabel(itm.context_name, itm.context_code) : '') + '</div>' +
          '<h1 class="mcx-inbox-hsubj">' + esc(itm ? itm.subject : '') + '</h1></div>' +
          '<div class="mcx-inbox-note">Could not open this conversation. ' + esc(err && err.message || String(err)) +
          ' <button type="button" class="mcx-inbox-retry" data-retry-detail>Try again.</button></div>';
      }
    }
  }

  function _paintPaneInner() {
    if (!pane) return;
    var item = state.open ? byId(state.open) : null;
    if (!state.open) {
      pane.innerHTML = '<div class="mcx-inbox-empty">Choose a message to read.</div>';
      renderComposer('');
      renderMenu(null);
      return;
    }
    if (state.detailFor !== state.open || !state.detail) {
      pane.innerHTML = '<div class="mcx-inbox-head"><div class="mcx-inbox-hwho">' + esc(item ? mcCourseLabel(item.context_name, item.context_code) : '') + '</div>' +
        '<h1 class="mcx-inbox-hsubj">' + esc(item ? item.subject : '') + '</h1></div>' +
        (state.detailError
          ? '<div class="mcx-inbox-note">Could not open this message. <button type="button" class="mcx-inbox-retry" data-retry-detail>Try again.</button></div>'
          : loadingRow());
      renderComposer('');
      renderMenu(null);
      return;
    }
    var d = state.detail;
    var msgs = (d.messages || []).slice().reverse();
    var html = '<div class="mcx-inbox-head"><div>' +
      '<div class="mcx-inbox-hwho">' + esc(mcCourseLabel(d.context_name || (item && item.context_name) || '', d.context_code || (item && item.context_code) || '')) + ' · ' + recipientsHtml(d) + '</div>' +
      '<h1 class="mcx-inbox-hsubj">' + esc(d.subject || '(no subject)') + '</h1>' +
      '</div></div>';
    /* One pass over the thread's text, because two things read it: the dates plate below, and the
       AI plate that takes the dates over once a summary is on screen. */
    var lens = lensOf(d);
    var aiDates = !!(ai() && window.mcxInboxAi.insightsShown());
    html += aiPlate(d, aiDates ? lens.dates : []);
    if (!aiDates && window.mcxInboxAi) html += window.mcxInboxAi.datesCardHtml(d, [], lens.dates, false);
    html += lensHtml(lens);
    if (state.since && state.firstNew) {
      html += '<div class="mcx-inbox-since">' + state.since + (state.since === 1 ? ' message' : ' messages') +
        ' since your last visit <button type="button" class="mcx-inbox-jumpnew" data-jumpmsg="' + state.firstNew + '">Jump to the first new message</button></div>';
    }
    html += '<div class="mcx-inbox-msgs">';
    for (var i = 0; i < msgs.length; i++) {
      if (i === 1 && msgs.length > 1) html += '<div class="mcx-inbox-divider"><i></i><span>' + (msgs.length - 1) + (msgs.length === 2 ? ' reply' : ' replies') + '</span><i></i></div>';
      html += msgHtml(d, msgs[i], i === 0);
    }
    html += '</div>';
    /* The reply box is not part of this string: it is drawn on <body> so it can frost the page
       behind it. See composerHost(). */
    var aiFrom = aiPlateHeight();
    pane.innerHTML = html;
    aiWall();
    lensTrim();
    renderComposer(composerHtml(d));
    renderMenu(d);
    /* The AI plate is rebuilt along with the rest of the column, so the height it held a moment
       ago is the only thing that says whether this press opened it, resized it or left it alone. */
    aiGrowPlate(aiFrom);
  }

  /* What's New is ours and lives in this browser only. It compares the newest message we had
     already shown against what the thread holds now, which is a different question from
     Canvas' own unread flag and does not touch it. */
  function noteVisit(d, quiet) {
    var seen = seenMap();
    var prev = String(seen[d.id] || '');
    var newest = prev;
    var newer = [];
    (d.messages || []).forEach(function (m) {
      var at = String(m.created_at || '');
      if (at > newest) newest = at;
      if (prev && at > prev) newer.push(m);
    });
    newer.sort(function (a, b) {
      return String(a.created_at) < String(b.created_at) ? -1 : 1;
    });
    state.since = (quiet || !prev) ? 0 : newer.length;
    state.firstNew = (quiet || !prev || !newer.length) ? 0 : newer[0].id;
    if (newest && newest !== prev) {
      seen[d.id] = newest;
      jwrite(SEEN_KEY, seen);
    }
  }

  var detailReqSeq = 0;

  function loadDetail(id) {
    if (state.detailFor === id && state.detail) { paintPane(); return; }
    var seq = ++detailReqSeq;
    state.detailFor = id;
    state.detail = null;
    state.detailError = '';
    state.mode = 'sender';
    state.replyTo = 0;
    state.expanded = false;
    state.sendErr = '';
    state.since = 0;
    state.firstNew = 0;
    state.confirm = false;
    state.lensOpen = false;
    state.menu = 0;
    state.confirmDelete = 0;
    state.menuErr = '';
    paintPane();

    var headers = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };
    var tok = csrf();
    if (tok) headers['X-CSRF-Token'] = tok;

    fetch('/api/v1/conversations/' + id + '?format=json&auto_mark_as_read=false', {
      credentials: 'same-origin',
      headers: headers
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (seq !== detailReqSeq || String(state.open) !== String(id)) return;
      if (!d || typeof d !== 'object') throw new Error('Invalid conversation data');
      d.messages = Array.isArray(d.messages) ? d.messages : [];
      d.participants = Array.isArray(d.participants) ? d.participants : [];
      d.workflow_state = 'read';
      var itm = byId(id);
      if (itm) itm.workflow_state = 'read';
      flipLocal(id);
      state.detail = d;
      try { noteVisit(d); } catch (err) { console.error('[MCX inbox] noteVisit failed', err); }
      try { harvest(d); } catch (err) { console.error('[MCX inbox] harvest failed', err); }
      try {
        var w = window.mcxInboxAi;
        if (w) w.onDetail(d);
      } catch (err) {
        console.error('[MCX inbox] onDetail failed', err);
      }
      paintPane();
    }).catch(function (e) {
      if (seq !== detailReqSeq || String(state.open) !== String(id)) return;
      state.detailError = String(e && e.message || e);
      paintPane();
    });
  }

  /* Canvas does not read the address bar, and its own row ignores a plain click, so the only
     thing that moves its read state is the full pointer sequence on the row's inner node. */
  var SEQ = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

  function markRead(id) {
    var twin = document.querySelector('[data-testid="open-conversation-for-' + id + '"]');
    var row = twin && (twin.closest('[data-testid="conversationListItem-Item"]') || twin.closest('[data-testid="conversation"]'));
    if (!row) return false;
    for (var s = 0; s < SEQ.length; s++) {
      row.dispatchEvent(new MouseEvent(SEQ[s], { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }

  /* Recording audio or video stays Canvas' own media picker, so this hands over to its reply
     box rather than rebuilding that. It answers the conversation Canvas itself has selected,
     which is the row we clicked for Canvas' first 20 messages. */
  function openNativeReply() {
    var btn = document.getElementById('reply-to-message');
    if (!btn) {
      state.attachErr = 'Canvas did not leave a reply box on this page.';
      paintPane();
      return;
    }
    state.attachErr = '';
    for (var s = 0; s < SEQ.length; s++) {
      btn.dispatchEvent(new MouseEvent(SEQ[s], { bubbles: true, cancelable: true, view: window }));
    }
  }

  function flipLocal(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) state.items[i].workflow_state = 'read';
    }
    var row = root && root.querySelector('[data-row="' + id + '"]');
    if (row) row.classList.remove('is-unread');
  }

  /* Past Canvas' own 20 rows there is no row left to click, so this asks the API instead.
     A 200 proves nothing on its own, so the answer is read back before the dot moves. */
  function markReadApi(id) {
    var h = {
      'X-CSRF-Token': csrf(),
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    };
    fetch('/api/v1/conversations/' + id, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: h,
      body: 'conversation%5Bworkflow_state%5D=read'
    }).then(function () {
      var getH = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      var tok = csrf();
      if (tok) getH['X-CSRF-Token'] = tok;
      return fetch('/api/v1/conversations/' + id + '?format=json&auto_mark_as_read=false', { credentials: 'same-origin', headers: getH });
    }).then(function (r) {
      return r.json();
    }).then(function (d) {
      if (d && d.workflow_state === 'read') {
        flipLocal(id);
      }
    }, function (e) {
      console.log('[MCX inbox] mark read request failed, id=' + id + ' ' + String(e && e.message));
    });
  }

  /* Canvas' own rows carry the real read state on their unread badge. Which way aria-pressed
     points is not documented, so it is worked out from the API snapshot we already have instead
     of being guessed at. Re-derived on every list load so a wrong guess cannot stick. */
  var unreadPressedMeansUnread = null;

  function twins() {
    var out = [];
    var marks = document.querySelectorAll('[data-testid^="open-conversation-for-"]');
    for (var i = 0; i < marks.length; i++) {
      var id = parseInt(String(marks[i].getAttribute('data-testid')).replace('open-conversation-for-', ''), 10);
      var row = marks[i].closest('[data-testid="conversation"]');
      var badge = row ? row.querySelector('[data-testid="unread-badge"]') : null;
      if (id && badge) out.push({ id: id, badge: badge });
    }
    return out;
  }

  function decidePolarity() {
    var list = twins();
    var agree = 0;
    var disagree = 0;
    for (var i = 0; i < list.length; i++) {
      var item = byId(list[i].id);
      if (!item) continue;
      var pressed = list[i].badge.getAttribute('aria-pressed') === 'true';
      if (pressed === (item.workflow_state === 'unread')) agree++;
      else disagree++;
    }
    if (agree + disagree >= 3) unreadPressedMeansUnread = agree >= disagree;
  }

  function syncReadStates() {
    if (!root || unreadPressedMeansUnread === null) return;
    var list = twins();
    for (var i = 0; i < list.length; i++) {
      var unread = (list[i].badge.getAttribute('aria-pressed') === 'true') === unreadPressedMeansUnread;
      var item = byId(list[i].id);
      if (item && (item.workflow_state === 'unread') !== unread) {
        item.workflow_state = unread ? 'unread' : 'read';
      }
      var mine = root.querySelector('[data-row="' + list[i].id + '"]');
      if (mine && mine.classList.contains('is-unread') !== unread) {
        mine.classList.toggle('is-unread', unread);
      }
    }
  }

  function openConversation(id) {
    id = Number(id) || 0;
    if (!id) return;
    hashOpened = id;
    var itm0 = byId(id);
    var isUnread = (itm0 && itm0.workflow_state === 'unread') || (state.detail && state.detail.id === id && state.detail.workflow_state === 'unread');
    if (state.open === id && state.detail && !isUnread) { paintPane(); return; }
    if (state.open === id && state.detailFor === id && !state.detailError) {
      // 当前会话正在加载中，绝不重复清空打断！
      return;
    }
    saveDraft();
    state.view = 'list';
    state.open = id;
    state.detail = null;
    state.detailFor = 0;
    state.replyTo = 0;
    state.sendErr = '';
    /* A picker left open on the previous message must not follow this one: the pill reads the
       follow list of whichever message is open, so the panel would show a stale day. */
    state.remindOpen = false;
    state.remindErr = '';
    try { markRead(id); } catch (e) {}
    markReadApi(id);
    flipLocal(id);
    syncOpen();
    loadDetail(id);
    if (pane) pane.scrollTop = 0;
  }

  /* Canvas ignores a conversation id in the address bar, we do not: that is how the global
     search box hands a specific message over to this page. */
  var hashOpened = 0;

  function openFromHash() {
    var part = String(location.hash).split('conversation_id=')[1];
    if (!part) return;
    var id = parseInt(part.split('&')[0], 10);
    if (!id || id === hashOpened) return;
    hashOpened = id;
    openConversation(id);
  }

  /* ---------- sending ---------- */

  function recipientsFor(d) {
    var last = targetMsg(d);
    var mine = last && String(last.author_id) === String(state.me);
    if (state.mode === 'all' || !last || mine) {
      return (d.audience || []).filter(function (x) { return String(x) !== String(state.me); });
    }
    return [last.author_id];
  }

  function sendReply(text, forced) {
    var d = state.detail;
    if (!d || state.sending) return;
    /* In a thread with more than two people, make the choice explicit once before sending. */
    if (!forced && !state.confirm && (d.participants || []).length > 2) {
      saveDraft();
      state.confirm = true;
      state.sendErr = '';
      paintPane();
      var box = composerEl('.mcx-inbox-input');
      if (box) box.focus();
      return;
    }
    state.confirm = false;
    var to = recipientsFor(d);
    if (!to.length) { state.sendErr = 'No one to send this to.'; paintPane(); return; }
    var ready = [];
    var pending = false;
    (state.files[d.id] || []).forEach(function (x) {
      if (x.id) ready.push(x.id);
      else if (x.uploading) pending = true;
    });
    if (pending) {
      state.sendErr = 'A file is still going up. Give it a second.';
      paintPane();
      return;
    }
    state.sending = true;
    state.sendErr = '';
    paintPane();
    /* Official endpoint for answering inside an existing thread. The create endpoint needs a
       conversation key that neither the list nor the detail response hands back, so going
       through it would silently start a separate message instead. */
    var pairs = [['body', text]];
    for (var i = 0; i < to.length; i++) pairs.push(['recipients[]', to[i]]);
    for (var k = 0; k < ready.length; k++) pairs.push(['attachment_ids[]', ready[k]]);
    var body = pairs.map(function (kv) {
      return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
    }).join('&');
    fetch('/api/v1/conversations/' + d.id + '/add_message', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': csrf(),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: body
    }).then(function (r) {
      return r.text().then(function (t) { return { st: r.status, ok: r.ok, t: t }; });
    }).then(function (o) {
      state.sending = false;
      if (!o.ok) {
        state.sendErr = 'Canvas could not send your message (' + o.st + '). ' + why(o.t);
        paintPane();
        return;
      }
      delete state.draft[d.id];
      state.files[d.id] = [];
      /* 静默刷新当前会话与消息列表，杜绝全屏清空闪烁 (Zero Flicker) */
      fetch('/api/v1/conversations/' + d.id + '?auto_mark_as_read=false', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (freshDetail) {
          if (freshDetail && state.open === d.id) {
            state.detail = freshDetail;
            state.detailFor = freshDetail.id;
            noteVisit(freshDetail, true);
            harvest(freshDetail);
            /* The thread moved, so the cached summary no longer describes all of it. Drop it from
               the plate and let him press Summarize: re-running on every reply he sends would
               spend his money without being asked. */
            if (window.mcxInboxAi) window.mcxInboxAi.reset(freshDetail);
            paintPane();
          }
        });
      // 静默拉取最新列表，拉到数据后再平滑替换，避免摧毁现有列表 DOM
      fetch('/api/v1/conversations?per_page=' + PER_PAGE, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) return;
          state.next = parseNext(r.headers.get('link'));
          return r.json();
        })
        .then(function (freshItems) {
          if (Array.isArray(freshItems)) {
            state.items = freshItems;
            paintList();
            decidePolarity();
          }
        });
      paintPane();
    }, function (e) {
      state.sending = false;
      state.sendErr = 'Could not connect to Canvas. Your message was not sent.';
      paintPane();
    });
  }

  /* ---------- attachments ----------
     Canvas takes files in three hops: ask for an upload slot in the "conversation attachments"
     folder, post the bytes to the url it hands back, then reference the id when sending.
     Each hop reports what Canvas actually said, so a failure names the hop instead of looking
     like our own bug. */
  var tmpSeq = 0;

  function dropFile(convId, tmp) {
    var list = state.files[convId] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].tmp === tmp) { list.splice(i, 1); return; }
    }
  }

  function uploadFile(convId, file) {
    var list = state.files[convId] || (state.files[convId] = []);
    var rec = { tmp: 'f' + (++tmpSeq), name: file.name, size: file.size, uploading: true, id: 0 };
    list.push(rec);
    state.attachErr = '';
    paintPane();
    fetch('/api/v1/users/self/files', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': csrf(),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: 'name=' + encodeURIComponent(file.name) +
        '&size=' + encodeURIComponent(file.size) +
        '&content_type=' + encodeURIComponent(file.type || 'application/octet-stream') +
        '&parent_folder_path=' + encodeURIComponent('conversation attachments')
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error('step 1 got ' + r.status + '. ' + why(t));
        var j = null;
        try { j = JSON.parse(t); } catch (e) {}
        if (!j || !j.upload_url) throw new Error('step 1 handed back no upload url');
        return j;
      });
    }).then(function (j) {
      var fd = new FormData();
      var params = j.upload_params || {};
      Object.keys(params).forEach(function (k) { fd.append(k, params[k]); });
      fd.append('file', file);
      return fetch(j.upload_url, { method: 'POST', body: fd });
    }).then(function (r) {
      return r.text().then(function (t) {
        var id = 0;
        var j = null;
        try { j = JSON.parse(t); } catch (e) {}
        if (j) id = (j.attachment && j.attachment.id) || j.id || 0;
        if (!id) {
          var m = /<id>(\d+)<\/id>/.exec(t);
          if (m) id = m[1];
        }
        if (!id) throw new Error('step 2 got ' + r.status + ' and no attachment id');
        rec.uploading = false;
        rec.id = id;
        paintPane();
      });
    }, function (e) {
      dropFile(convId, rec.tmp);
      state.attachErr = 'That file did not go up. ' + String(e && e.message || e);
      paintPane();
    });
  }

  function onPaneChange(e) {
    if (!e.target || !e.target.classList || !e.target.classList.contains('mcx-inbox-fileinput')) return;
    var convId = state.open;
    var picked = e.target.files || [];
    for (var i = 0; i < picked.length; i++) uploadFile(convId, picked[i]);
    e.target.value = '';
  }

  /* ---------- mount ---------- */

  /* The two native halves have no id and no testid, only hashed classes, so they are found by
     structure: everything already in the row that holds the list column and the reading pane.
     Our own two nodes go into that same row as direct children, otherwise the native column
     grows to fill the space its hidden neighbour left and centres our list inside it. */
  function flexRow(holder) {
    var item = holder.parentElement;
    return item && item.parentElement ? item.parentElement : null;
  }

  function markNative(flex) {
    var kids = flex.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== root && kids[i] !== pane && !kids[i].classList.contains(PANE_CLASS)) {
        kids[i].classList.add(PANE_CLASS);
      }
    }
    /* Both of our columns scroll on their own, which needs a row with a definite height. The
       row's own height comes from content once the native half is hidden, so the distance from
       the top of the window is measured here rather than guessed at in the stylesheet. */
    flex.classList.add('mcx-inbox-flex');
    var box = flex.getBoundingClientRect();
    var top = Math.round(box.top + window.scrollY);
    if (top > 0) flex.style.setProperty('--mcx-inbox-top', top + 'px');
    if (window.mcxInboxAi) window.mcxInboxAi.bind(window.mcxInboxHost);
  }

  function mount() {
    if (!on()) return;
    if (location.pathname.indexOf(PAGE) !== 0) { unmount(); return; }
    var holder = document.getElementById('inbox-conversation-holder');
    if (!holder) return;
    var flex = flexRow(holder);
    if (!flex) return;
    if (root && root.isConnected && pane && pane.isConnected) {
      syncOpen();
      syncReadStates();
      markNative(flex);
      bindSearch();
      openFromHash();
      queuePlace();
      return;
    }
    if (!root) {
      root = document.createElement('div');
      root.className = 'mcx-inbox-list';
      root.addEventListener('click', onClick);
      root.addEventListener('input', onListInput);
      root.addEventListener('scroll', onListScroll, { passive: true });
    }
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'mcx-inbox-thread';
      pane.addEventListener('click', onPaneClick);
      pane.addEventListener('input', onPaneInput);
      pane.addEventListener('change', onPaneChange);
      if (window.ResizeObserver) {
        /* Covers the drawer opening, the column being resized and the window changing shape. */
        paneRo = new ResizeObserver(queuePlace);
        paneRo.observe(pane);
      }
    }
    if (!scrollBound) {
      scrollBound = function () { queuePlace(); };
      window.addEventListener('scroll', scrollBound, true);
    }
    flex.insertBefore(root, flex.firstChild);
    flex.appendChild(pane);
    markNative(flex);
    bindSearch();
    document.documentElement.classList.add(HIDE_CLASS);
    mcNicknamesOnce();
    paintList();
    paintPane();
    meId().then(function () {
      state.scope = getActiveScope();
      /* 走到这里不一定是第一次挂载：Canvas 把我们那一栏摘掉过一次时，上面那颗
         "root 还在文档里吗"的闸门会失效，于是这条尾巴又跑一趟。名单还在 state 里，
         再要一次就是同一批会话往 state.items 上叠第二份（实测叠成三份，
         点中一条有三行一起变选中档）。只有真的没数据、也没在取，才开这一趟。 */
      if (!state.items.length && !state.loading) load(buildConversationsUrl());
    });
  }

  function unmount() {
    document.documentElement.classList.remove(HIDE_CLASS);
    if (scrollBound) {
      window.removeEventListener('scroll', scrollBound, true);
      scrollBound = null;
    }
    if (hostRo) { hostRo.disconnect(); hostRo = null; }
    if (paneRo) { paneRo.disconnect(); paneRo = null; }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    if (pane && pane.parentNode) pane.parentNode.removeChild(pane);
    var marked = document.querySelectorAll('.' + PANE_CLASS);
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove(PANE_CLASS);
    root = null;
    pane = null;
    state.items = [];
    state.next = null;
    state.loaded = false;
    state.loading = false;
    state.error = '';
    state.open = 0;
    state.detail = null;
    state.detailFor = 0;
  }

  function syncOpen() {
    if (!root) return;
    root.querySelectorAll('[data-row]').forEach(function (el) {
      el.classList.toggle('is-open', parseInt(el.getAttribute('data-row'), 10) === state.open);
    });
  }

  function onClick(e) {
    if (e.target.closest('a')) return;
    var cb = e.target.closest('[data-cb]');
    if (cb) {
      var cid = parseInt(cb.getAttribute('data-cb'), 10);
      if (cb.checked) state.sel[cid] = 1; else delete state.sel[cid];
      var row = cb.closest('[data-row]');
      if (row) row.classList.toggle('is-checked', !!cb.checked);
      e.stopPropagation();
      return;
    }
    var starBtn = e.target.closest('[data-star]');
    if (starBtn) {
      e.stopPropagation();
      var sid = parseInt(starBtn.getAttribute('data-star'), 10);
      var itm = byId(sid);
      var newStarred = !(itm && itm.starred);
      if (itm) itm.starred = newStarred;
      if (state.detail && state.detail.id === sid) state.detail.starred = newStarred;
      starBtn.classList.toggle('is-starred', newStarred);
      starBtn.setAttribute('aria-label', newStarred ? 'Unstar' : 'Star');
      starBtn.setAttribute('title', newStarred ? 'Unstar' : 'Star');
      starBtn.innerHTML = icon(newStarred ? 'starFill' : 'star');
      patchConv(sid, [['conversation[starred]', newStarred ? 'true' : 'false']], 'starred', newStarred, function (fresh) {
        if (itm) itm.starred = fresh.starred;
        if (state.detail && state.detail.id === sid) state.detail.starred = fresh.starred;
        paintList();
      });
      return;
    }
    var ft = e.target.closest('[data-follow-toggle]');
    if (ft) {
      /* Only the class moves here. Repainting would insert the row already in its end state and
         the open animation would never play. */
      state.followOpen = !state.followOpen;
      ft.classList.toggle('is-open', state.followOpen);
      return;
    }
    if (e.target.closest('[data-shelf]')) {
      state.view = 'shelf';
      paintList();
      return;
    }
    if (e.target.closest('[data-back]')) {
      var sv = root.querySelector('.mcx-inbox-shelfview');
      if (sv) sv.classList.add('is-out');
      setTimeout(function () {
        state.view = 'list';
        paintList();
      }, 190);
      return;
    }
    var chip = e.target.closest('[data-chip]');
    if (chip) {
      state.shelf = chip.getAttribute('data-chip');
      var bar = chip.closest('.mcx-inbox-chips');
      if (bar) {
        bar.querySelectorAll('.mcx-inbox-chip').forEach(function (c) {
          c.classList.toggle('on', c.getAttribute('data-chip') === state.shelf);
        });
      }
      var listEl = root.querySelector('.mcx-inbox-shelflist');
      if (listEl) {
        listEl.innerHTML = shelfRowsHtml();
      } else {
        paintList();
      }
      return;
    }
    var done = e.target.closest('[data-follow-clear]');
    if (done) {
      e.stopPropagation();
      clearFollow(parseInt(done.getAttribute('data-follow-clear'), 10));
      return;
    }
    var fu = e.target.closest('[data-fu]');
    if (fu) {
      openConversation(parseInt(fu.getAttribute('data-fu'), 10));
      return;
    }
    if (e.target.closest('[data-retry]')) {
      state.loaded = false;
      load(buildConversationsUrl());
      return;
    }
    var rowEl = e.target.closest('[data-row]');
    if (rowEl) openConversation(parseInt(rowEl.getAttribute('data-row'), 10));
  }

  function flash(el) {
    if (!el) return;
    el.classList.add('is-flash');
    setTimeout(function () { el.classList.remove('is-flash'); }, 1600);
  }

  /* The lens only points at the original sentence, it never rewrites it. */
  function jumpTo(msgId, url) {
    if (!pane) return;
    var msg = pane.querySelector('[data-msg="' + msgId + '"]');
    if (!msg) return;
    var target = msg;
    if (url) {
      var links = msg.querySelectorAll('.mcx-inbox-mbody a');
      for (var i = 0; i < links.length; i++) {
        if (links[i].getAttribute('href') === url) { target = links[i]; break; }
      }
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(target);
  }

  function runMenu(act, msgId) {
    var d = state.detail;
    if (!d) return;
    var msgs = d.messages || [];
    var m = null;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].id === msgId) m = msgs[i];
    }
    if (!m) m = targetMsg(d);
    if (act === 'close') {
      state.menu = 0;
      state.confirmDelete = 0;
      dropMenu();
      return;
    }
    if (act === 'all') {
      state.menu = 0;
      dropMenu();
      state.mode = 'all';
      /* Only the reply box reads state.mode, so only the reply box is redrawn. Rebuilding the
         column would move everything above it for no reason. */
      repaintComposer();
      var box = composerEl('.mcx-inbox-input');
      if (box) box.focus();
      return;
    }
    if (act === 'forward') {
      state.menu = 0;
      dropMenu();
      handoverForward(d, m);
      return;
    }
    if (act === 'star' || act === 'unstar') {
      var on = act === 'star';
      state.menu = 0;
      dropMenu();
      patchConv(d.id, [['conversation[starred]', on ? 'true' : 'false']], 'starred', on, function (fresh) {
        d.starred = fresh.starred;
        var item = byId(d.id);
        if (item) item.starred = fresh.starred;
        paintList();
      });
      return;
    }
    if (act === 'unread' || act === 'read' || act === 'archive' || act === 'unarchive') {
      var want = act === 'unread' ? 'unread' : (act === 'read' ? 'read' : (act === 'archive' ? 'archived' : 'read'));
      state.menu = 0;
      dropMenu();
      patchConv(d.id, [['conversation[workflow_state]', want]], 'workflow_state', want, function (fresh) {
        d.workflow_state = fresh.workflow_state;
        var item = byId(d.id);
        if (item) item.workflow_state = fresh.workflow_state;
        paintList();
      });
      return;
    }
    if (act === 'delete') {
      state.confirmDelete = msgId;
      state.menuErr = '';
      /* The ask lives in the menu, which is not part of the column: redrawing the column would
         shift the anchor under the menu and, in a scrolled column, clamp the scroll position,
         which closes the menu before he can answer the ask. */
      renderMenu(d);
      return;
    }
    if (act === 'delete-yes') {
      state.menu = 0;
      state.confirmDelete = 0;
      removeConv(d.id);
    }
  }

  function onDocClick(e) {
    if (!state.menu) return;
    if (e.target.closest('[data-menubtn]') || e.target.closest('.mcx-inbox-menu')) return;
    state.menu = 0;
    state.confirmDelete = 0;
    state.menuErr = '';
    /* 光把状态归零不够：菜单挂在 body 上，不在这次重画里，点外面它会一直留在那儿。 */
    dropMenu();
  }

  function onPaneClick(e) {
    if (e.target.closest('a')) return;
    if (window.mcxInboxAi && window.mcxInboxAi.paneClick(e)) return;
    var mb = e.target.closest('[data-menubtn]');
    if (mb) {
      var mid = parseInt(mb.getAttribute('data-menubtn'), 10);
      /* 这一颗只管开／收菜单，所以菜单自己重画就够了，绝不能重建整栏。整栏一重画：
         那一摞卡片的高度当场晃 31 像素（实测 scrollHeight 1262→1231，过两帧又回到 1262），
         三个点跟着挪，而菜单已经按旧位置贴好了，结果就是它压在三个点上面；
         要是这一栏正滚到底，同一趟重排还会把 scrollTop 夹回去＝他看见"页面往上跳一下"，
         并派一个 scroll 事件，而"一滚就收"正好把刚打开的那份菜单关掉＝"第一次点没反应"。 */
      state.menu = state.menu === mid ? 0 : mid;
      state.confirmDelete = 0;
      state.menuErr = '';
      if (state.menu) renderMenu(state.detail); else dropMenu();
      return;
    }
    var mi = e.target.closest('[data-menu]');
    if (mi) {
      runMenu(mi.getAttribute('data-menu'), parseInt(mi.getAttribute('data-msg'), 10));
      return;
    }
    var conf = e.target.closest('[data-confirm]');
    if (conf) {
      var act = conf.getAttribute('data-confirm');
      state.confirm = false;
      if (act === 'cancel') { paintPane(); return; }
      state.mode = act;
      var box0 = composerEl('.mcx-inbox-input');
      var txt = box0 ? String(box0.value).trim() : '';
      if (!txt) {
        state.sendErr = 'Write something first.';
        paintPane();
        return;
      }
      sendReply(txt, true);
      return;
    }
    var lensMore = e.target.closest('[data-lens]');
    if (lensMore) {
      state.lensOpen = !state.lensOpen;
      paintPane();
      return;
    }
    var jumpNew = e.target.closest('[data-jumpmsg]');
    if (jumpNew) {
      jumpTo(parseInt(jumpNew.getAttribute('data-jumpmsg'), 10), '');
      return;
    }
    var jump = e.target.closest('[data-jump]');
    if (jump) {
      jumpTo(parseInt(jump.getAttribute('data-jump'), 10), '');
      return;
    }
    var fClear = e.target.closest('[data-follow-clear]');
    if (fClear) {
      clearFollow(parseInt(fClear.getAttribute('data-follow-clear'), 10));
      return;
    }
    /* Remind: the pill opens the picker, a quick chip or Set writes the day, Remove takes it off.
       The old [data-follow] branch lived here; the line it served is gone. */
    var remind = e.target.closest('[data-remind]');
    if (remind) {
      var wasOpen = state.remindOpen;
      state.remindOpen = !wasOpen;
      state.remindErr = '';
      /* 打开那一趟把已有那条的备注抄进 state：还没加进清单时没有行可写，
         他打的字要先留住，等 Set 那一趟一起落 */
      if (!wasOpen) {
        var rHit = followFor(state.open);
        state.remindNote = rHit ? String(rHit.note || '') : '';
        repaintComposer();
        return;
      }
      /* 收这一头要先缩再拆：innerHTML 一跑那块板就没有节点可缩了。
         开的那一头不用单独做事——repaintComposer 里那两块板子都从旧高度推过去 */
      collapseRemindPlate(repaintComposer);
      return;
    }
    var rSet = e.target.closest('[data-remind-set]');
    if (rSet) {
      state.remindErr = '';
      /* Stays open on purpose: the head line above the chips is what says which day it is now, and
         closing the panel would take that confirmation away with it. */
      setFollow(state.open, Number(rSet.getAttribute('data-remind-set')) || 1);
      writeRemindNote();
      return;
    }
    var rClear = e.target.closest('[data-remind-clear]');
    if (rClear) {
      var rClearId = parseInt(rClear.getAttribute('data-remind-clear'), 10);
      state.remindOpen = false;
      clearFollow(rClearId, true);
      collapseRemindPlate(repaintComposer);
      return;
    }
    if (e.target.closest('[data-remind-cancel]')) {
      state.remindOpen = false;
      state.remindErr = '';
      collapseRemindPlate(repaintComposer);
      return;
    }
    if (e.target.closest('[data-remind-go]')) {
      var day = composerEl('[data-remind-date]');
      var iso = day ? String(day.value || '') : '';
      var at = iso ? new Date(iso + 'T12:00:00').getTime() : 0;
      if (!at || isNaN(at)) {
        state.remindErr = 'Pick a day first';
        repaintComposer();
        return;
      }
      state.remindErr = '';
      setFollow(state.open, Math.max(1, Math.ceil((at - Date.now()) / 86400000)));
      writeRemindNote();
      return;
    }
    var recs = e.target.closest('[data-recs]');
    if (recs) {
      state.expanded = !state.expanded;
      paintPane();
      return;
    }
    var mode = e.target.closest('[data-mode]');
    if (mode) {
      state.mode = mode.getAttribute('data-mode');
      repaintComposer();
      return;
    }
    var med = e.target.closest('[data-media]');
    if (med) {
      openNativeReply();
      return;
    }
    var att = e.target.closest('[data-attach]');
    if (att) {
      var fi = composerEl('.mcx-inbox-fileinput');
      if (fi) fi.click();
      return;
    }
    var det = e.target.closest('[data-detach]');
    if (det) {
      dropFile(state.open, det.getAttribute('data-detach'));
      state.attachErr = '';
      paintPane();
      return;
    }
    var rep = e.target.closest('[data-reply]');
    if (rep) {
      state.mode = 'sender';
      state.replyTo = parseInt(rep.getAttribute('data-reply'), 10) || 0;
      paintPane();
      var box = composerEl('.mcx-inbox-input');
      if (box) box.focus();
      return;
    }
    if (e.target.closest('[data-retry-detail]')) {
      var id = state.open;
      state.detailFor = 0;
      loadDetail(id);
      return;
    }
    if (e.target.closest('.mcx-inbox-send')) {
      var input = composerEl('.mcx-inbox-input');
      var text = input ? String(input.value).trim() : '';
      if (!text) {
        state.sendErr = 'Write something first.';
        paintPane();
        return;
      }
      sendReply(text);
    }
  }

  function onListScroll() {
    if (!state.next || state.loading) return;
    if (root.scrollTop + root.clientHeight > root.scrollHeight - 320) load(state.next);
  }

  var timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      mount();
      bindMailboxSelect();
      reloadListForScope();
    }, 300);
  }

  function onNavStateChange() {
    schedule();
    setTimeout(reloadListForScope, 50);
  }

  function watch() {
    /* One pass costs more than it looks: mount() re-measures this column and the composer host.
      Canvas reports a batch for every node the site's own overlays add, so opening the two
      selects on this toolbar used to schedule a pass that landed 300ms into the menu's own
      180ms entrance. content.js guards the same way in mcScheduleUiPass: a batch that lives
      entirely inside an overlay is not our business. */
    new MutationObserver(function (ms) {
      var inOverlay = ms.length > 0 && ms.every(function (m) {
        var t = m.target;
        return t && t.closest && t.closest('span[data-position-content], [role="dialog"], [role="menu"], [data-testid*="address-book"]');
      });
      if (inOverlay) return;
      schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', onNavStateChange);
    window.addEventListener('popstate', onNavStateChange);
    document.addEventListener('click', onDocClick);
  }

  /* inbox-ai.js draws two blocks inside the column this file owns and repaints through this one
     bridge. It gets no other way to reach the thread, the token or the composer, so there is only
     ever one place that decides when the reading pane is rebuilt. */
  window.mcxInboxHost = {
    detail: function () { return state.detail; },
    saveDraft: saveDraft,
    paintPane: paintPane,
    paneNode: function () { return pane; },
    composerNode: function () { return host; },
    nameOf: nameOf,
    icon: icon,
    csrf: csrf,
    addFollow: addFollow,
    /* Three ways to touch the reply box, because the AI writes into it in place: read what is in
       it, replace it, and update it without a repaint while a draft is streaming in. */
    draftText: function () {
      saveDraft();
      return String(state.draft[state.open] || '');
    },
    /* One way to put text into the reply box, and it writes both copies every time. If it only
       wrote the state copy, the next paintPane would run saveDraft, read the stale node, and put
       the old text back. */
    writeDraft: function (text) {
      var t = String(text || '');
      state.draft[state.open] = t;
      var box = composerEl('.mcx-inbox-input');
      if (box) box.value = t;
    }
  };

  /* the settings panel calls this so flipping the switch takes effect without a reload */
  window.mcxInboxSet = function () {
    if (on()) mount(); else unmount();
  };

  /* The address book popup asks us for its Inbox sections instead of keeping a second copy of
     the matching rules. Each row opens the conversation that carries the thing. */
  window.mcxInboxSearchSections = function (query) {
    if (!on()) return [];
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    var out = [];
    var fu = followList().filter(function (x) { return followHits(x, q); });
    if (fu.length) {
      out.push({
        title: 'Follow Up',
        items: fu.map(function (x) {
          return {
            conv: x.conv,
            label: x.subj,
            desc: (x.course ? x.course + ' · ' : '') + 'until ' + groupLabel(x.until) + (x.note ? ' · ' + x.note : '')
          };
        })
      });
    }
    var res = shelfItems().filter(function (x) { return resHits(x, q); });
    if (res.length) {
      out.push({
        title: 'Resources',
        items: res.slice(0, 12).map(function (x) {
          return {
            conv: x.conv,
            label: x.label,
            desc: kindWord(x) + (x.course ? ' · ' + x.course : '') + (x.sender ? ' · ' + x.sender : '')
          };
        })
      });
    }
    var msg = state.items.filter(function (it) { return itemHits(it, q); });
    if (msg.length) {
      out.push({
        title: 'Messages',
        items: msg.map(function (it) {
          return {
            conv: it.id,
            label: it.subject || '(no subject)',
            desc: people(it) + (it.context_name ? ' · ' + it.context_name : '')
          };
        })
      });
    }
    return out;
  };

  window.mcxInboxOpen = function (convId) {
    state.view = 'list';
    state.q = '';
    if (state.search) state.search.value = '';
    openConversation(Number(convId) || 0);
  };

  function start() {
    if (location.pathname.indexOf(PAGE) !== 0) return;
    mount();
    watch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
