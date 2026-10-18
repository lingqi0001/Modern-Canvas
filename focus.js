/* =========================================================
   Focus：作业页上的一颗番茄钟。

   三块画面共用一份状态
   - 标题右边那颗 Focus 键（只在作业页）
   - 停在 Hub 上方那一块面板（只在有 Hub 的那些页）
   - 可拖、可改大小的悬浮卡（本页悬浮，或固定以后跨页）

   为什么状态住 chrome.storage.local 而不是页面 localStorage
   - "固定到所有网站"要求同一份计时在任意域名下都读得到，页面那一块地盘按源切，
     换一个网站就读不见了。这一格只放课程号、作业号、标题和剩余时间，没有钥匙也没有正文。

   为什么"打勾"要交给 Canvas 那一头做
   - 写 planner override 要带 cookie 里那份 _csrf_token，只有 Canvas 同源的那一趟拿得到。
     所以非 Canvas 页上答"做完了"，只把 pendingTick 写进这一格；任何一张开着的 Canvas 页
     在它的巡检里读走（300 毫秒一趟），走 content.js 那份 mcSetCanvasOverride，不在这儿抄第二份。
     一张 Canvas 页都没开时，这一勾留到他下次打开 Canvas。

   计时不靠 setInterval 累加
   - 落点是一个绝对时刻 endAt，每一秒读 Date.now() 算差。挂后台、休眠、换标签页都不会把
     时间跑慢；暂停时把剩下的量写回 leftMs。
   ========================================================= */
(function () {
  'use strict';

  /* 固定到所有网站那一档，background 会把这份脚本补投到"扩展重载之前就开着"的那些页面上。
     那些页里可能已经跑着一份了：投第二份会画出第二块卡，所以先认一下门牌 */
  if (window.__mcxFocusBooted) return;
  window.__mcxFocusBooted = 1;

  var CANVAS = window.mcIsCanvas === true;
  /* 补投进"扩展重载之前就开着"的那些页面时，那份判据脚本也没在里面跑过，
     window.mcIsCanvas 是 undefined。就地按地址补一次，不然那一页会把自己当外站 */
  if (typeof window.mcIsCanvas === 'undefined') {
    var _h = String(window.location.hostname || '').toLowerCase();
    CANVAS = _h === 'instructure.com' || /\.instructure\.com$/.test(_h) || _h === 'canvas.net' ||
      /\.canvaslms\.com$/.test(_h) || _h.indexOf('.canvas.') !== -1 || _h.indexOf('-canvas.') !== -1;
  }
  var SKEY = 'mc_focus_state';
  var PKEY = 'mc_focus_presets';
  var GKEY = 'mc_focus_float';
  /* 每次进入 Dashboard 都从 Widget Cards 列表开始；打开状态只在当前页有效，
     不应随着 localStorage 跨次访问记住某一张具体卡片。 */
  if (CANVAS && (/^\/$/.test(location.pathname) || /^\/courses\/?$/i.test(location.pathname) || /\/dashboard(?:\/|$)/i.test(location.pathname))) {
    try { localStorage.setItem('mc_dash_focus_open', '0'); } catch (e) {}
  }
  /* 上一次这一坨是停在面板档还是悬浮档。新开一趟照它摆，默认（从没关过）＝面板 */
  var HKEY = 'mc_focus_shape';
  var WALL_POS_KEY = 'mc_focus_dashboard_position_v1';
  /* Dashboard 的展开状态是当前标签页展示偏好，不属于共享计时会话。 */
  var DASH_DISMISSED_KEY = 'mc_dash_focus_dismissed_sid';
  var DASH_FLOAT_DISMISSED_KEY = 'mc_dash_focus_float_dismissed_sid';
  var dashboardWasActive = false;
  var dashboardEntryPending = false;
  var DEFAULT_PRESETS = [15, 30, 60];
  var SUBMIT_POLL = 15000;
  var C = 2 * Math.PI * 54;
  var FLOAT_W = 248;
  /* 悬浮卡能拧的大小只有这一档：再小圆里的字挤成一团，再大就是一块空板 */
  var MIN_W = 224, MAX_W = 340, MIN_H = 300, MAX_H = 520;
  var OUT_MS = 320;

  var S = null;
  var presets = DEFAULT_PRESETS.slice();
  var geo = null;
  var loaded = false;
  var surfaces = { dock: null, float: null, card: null };
  var tickTimer = 0;
  var pollAt = 0;
  var structKey = '__none__';
  var focusWidgetEntrance = false;
  var assignmentCache = {};
  /* 加减档当前那一格。0＝这一趟还没拧过，那就落在三档的第一档上 */
  var stepMin = 0;
  var lastShape = 'docked';
  var anchorLogged = false;
  var wallDragSource = false;
  /* 手输的上限按他说的"小于 500"，所以封顶 499；加减档和它同一条线，不然减到 5 就卡住 */
  var STEP_MIN = 1, STEP_MAX = 499;

  function curStep() {
    return stepMin || presets[0] || 25;
  }

  /* ==== 扩展存储：拿不到就当这一格不存在，绝不抛 ==== */

  function store() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
      return chrome.storage.local;
    } catch (e) { return null; }
  }

  function clearError() {
    try { void chrome.runtime.lastError; } catch (e) {}
  }

  function read(keys, cb) {
    var a = store();
    if (!a) { cb({}); return; }
    try { a.get(keys, function (got) { clearError(); cb(got || {}); }); } catch (e) { cb({}); }
  }

  function write(obj, cb) {
    var a = store();
    if (!a) { if (cb) cb(false); return; }
    try { a.set(obj, function () { clearError(); if (cb) cb(true); }); } catch (e) { if (cb) cb(false); }
  }

  function erase(key) {
    var a = store();
    if (!a) return;
    try { a.remove(key, clearError); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ==== 读数 ==== */

  function presetList() {
    var raw = '';
    try { raw = localStorage.getItem(PKEY) || ''; } catch (e) {}
    var nums = String(raw).split(/[^0-9]+/).map(Number).filter(function (n) { return n >= STEP_MIN && n <= STEP_MAX; });
    if (!nums.length) return DEFAULT_PRESETS.slice();
    return nums.slice(0, 3);
  }

  function switchOn() {
    try { return localStorage.getItem('mc_focus_on') !== '0'; } catch (e) { return true; }
  }

  /* Dashboard 上的 widgets 开关：默认开（只有存过 '0' 才算关）。
     它只管墙上那张卡，管不到作业页那颗键和面板 */
  function widgetOn() {
    try {
      if (localStorage.getItem('mc_dash_focus_card') === '0') return false;
      return true;
    } catch (e) { return true; }
  }

  function focusLoc() {
    try {
      var loc = localStorage.getItem('mc_dash_widget_focus_loc');
      if (loc === 'combined' || loc === 'separate' || loc === 'off') return loc;
      var on = localStorage.getItem('mc_dash_widget_focus') !== '0';
      if (!on) return 'off';
      var layout = localStorage.getItem('bc_dash_widget_layout') || 'combined';
      return layout === 'separate' ? 'separate' : 'combined';
    } catch (e) { return 'combined'; }
  }

  function gradesLoc() {
    try {
      var loc = localStorage.getItem('mc_dash_widget_grades_loc');
      if (loc === 'combined' || loc === 'separate' || loc === 'off') return loc;
      var on = localStorage.getItem('mc_dash_widget_grades') !== '0';
      if (!on) return 'off';
      var layout = localStorage.getItem('bc_dash_widget_layout') || 'combined';
      return layout === 'separate' ? 'separate' : 'combined';
    } catch (e) { return 'combined'; }
  }

  function widgetLayout() {
    return focusLoc() === 'separate' ? 'separate' : 'combined';
  }

  function focusWidgetOn() {
    return focusLoc() !== 'off';
  }

  function dashboardWidgetOwnsSurface() {
    return isDashboardPage() && widgetOn() && focusLoc() === 'combined' && !wallHidden();
  }

  function gradesWidgetOn() {
    return gradesLoc() !== 'off';
  }

  function separateCoverOn() {
    try {
      var bcVal = localStorage.getItem('bc_dash_widget_cover');
      if (bcVal === '1') return true;
      if (bcVal === '0') return false;
      var mcVal = localStorage.getItem('mc_dash_widget_cover');
      if (mcVal === '1') return true;
      if (mcVal === '0') return false;
      var h = window.mcHost;
      if (h && h.modernSetting) return h.modernSetting('dash_widget_cover') === '1';
      return false;
    } catch (e) { return false; }
  }

  function remaining(s, now) {
    if (!s) return 0;
    if (s.running && s.endAt) return Math.max(0, s.endAt - (now || Date.now()));
    return Math.max(0, s.leftMs || 0);
  }

  function fmt(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (sec < 10 ? '0' : '') + sec;
    return (h > 0 ? h + ':' + mm : mm) + ':' + ss;
  }

  /* 询问句里要点名是哪一份作业。太长就掐掉：这里不用 CSS 省略号，
     那一档会把作业名切成半个词，读起来像出了错 */
  function shortTitle(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    if (s.length <= 46) return s;
    return s.slice(0, 45).replace(/[\s,;:]+$/, '') + '…';
  }

  /* ==== 图标：线条跟文字同色 ==== */

  var IC = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    float: '<rect x="3.5" y="5" width="11" height="9" rx="2"/><path d="M9 17.5h9.5V8"/>',
    pin: '<path d="M11 3.5l1.5 4L16.5 9l-4 1.5L11 14.5 9.5 10.5 5.5 9l4-1.5z"/><path d="M17.5 14l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
    pause: '<path d="M9.5 5v14M14.5 5v14"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    stop: '<path d="M6.5 6.5h11v11h-11z"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    /* 图钉：上面那颗钉帽是个梯形，针往下扎。以前画的是两颗星，看着像"AI"不像"钉住" */
    pin: '<path d="M8.5 3.5h7l-1 5.2 2.8 2.6H6.7l2.8-2.6z"/><path d="M12 11.3v9.2"/>',
    /* 闹钟：一颗钟面＋两根指针＋顶上两颗铃＋底下一双脚。
       它是 Focus 这一件事的记号，三个入口（标题那颗键、墙上缩起来那一行、List view 那条横栏）
       画的是同一份，不各画各的 */
    alarm: '<circle cx="12" cy="13.4" r="6.4"/><path d="M12 10.2v3.2l2.4 1.6"/>' +
      '<path d="M7.5 8.9L5.1 6.5M16.5 8.9l2.4-2.4"/><path d="M7.5 17.9l-2.3 2.4M16.5 17.9l2.3 2.4"/>'
  };

  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  /* ==== 画面 ==== */

  function headHtml(s, isStandalone) {
    var floating = s.mode === 'float';
    var canDock = dockable();
    var closeBtn = isStandalone ? '' : ('<button type="button" class="mcx-focus-ib" data-act="close" aria-label="Close" title="Close this panel">' + svg(IC.close) + '</button>');
    return '<div class="mcx-focus-head">' +
      '<span class="mcx-focus-title">Focus</span>' +
      '<span class="mcx-focus-actions">' +
        closeBtn +
        '<button type="button" class="mcx-focus-ib' + (floating ? ' is-on' : '') + '" data-act="float" ' +
          'aria-label="Floating window" title="' + (floating ? (canDock ? 'Dock it back above the Hub' : 'Close this window') : 'Turn it into a floating window') + '">' + svg(IC.float) + '</button>' +
        '<button type="button" class="mcx-focus-ib' + (s.pin ? ' is-on' : '') + '" data-act="pin" ' +
          'aria-label="Keep it on screen" title="' + (s.pin ? 'Stop keeping it on screen' : 'Keep it on screen as you move around') + '">' + svg(IC.pin) + '</button>' +
      '</span>' +
    '</div>';
  }

  /* 自己挑时长这一格不许用浏览器的输入框：站点那一条 input 规则带着 !important，
     我们那层板子被压回一张白板（实测过一轮）。这一格用可编辑文字做，板子是自己的 */
  function pickHtml() {
    var pills = presets.map(function (m) {
      return '<button type="button" class="mcx-focus-pill" data-start="' + m + '">' + m + '</button>';
    }).join('');
    return '<div class="mcx-focus-pick">' +
      '<div class="mcx-focus-pills">' + pills + '</div>' +
      '<div class="mcx-focus-step">' +
        '<button type="button" class="mcx-focus-arrow" data-step="-5" aria-label="Five minutes less">' + svg(IC.minus) + '</button>' +
        '<span class="mcx-focus-readout">' +
          '<span class="mcx-focus-num" contenteditable="plaintext-only" role="textbox" inputmode="numeric" ' +
            'aria-label="Minutes">' + curStep() + '</span>' +
          '<span class="mcx-focus-unit">min</span>' +
        '</span>' +
        '<button type="button" class="mcx-focus-arrow" data-step="5" aria-label="Five minutes more">' + svg(IC.plus) + '</button>' +
        '<button type="button" class="mcx-focus-go" data-act="gostep">Start</button>' +
      '</div>' +
    '</div>';
  }

  function stepLabels() {
    var text = String(curStep());
    [surfaces.dock, surfaces.float, surfaces.card].forEach(function (el) {
      if (!el) return;
      var n = el.querySelector('.mcx-focus-num');
      if (n && document.activeElement !== n) n.textContent = text;
    });
  }

  /* 敲进去的只认数字，最多三位；回车＝认数并直接开跑，Esc＝回到敲之前那一格，
     点到别处去＝认数但不自己开跑 */
  function bindStep(el) {
    var n = el.querySelector('.mcx-focus-num');
    if (!n) return;
    var before = curStep();
    n.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        n.blur();
        start(commit(n));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        n.textContent = String(before);
        n.blur();
      }
    });
    n.addEventListener('input', function () {
      var digits = String(n.textContent || '').replace(/[^0-9]/g, '').slice(0, 3);
      if (n.textContent !== digits) {
        n.textContent = digits;
        var r = document.createRange();
        r.selectNodeContents(n);
        r.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    });
    n.addEventListener('focus', function () { before = curStep(); });
    n.addEventListener('blur', function () { commit(n); });
  }

  function commit(n) {
    var v = parseInt(String(n ? n.textContent : ''), 10);
    if (!v || isNaN(v)) v = stepMin || presets[0] || 25;
    stepMin = Math.max(STEP_MIN, Math.min(STEP_MAX, v));
    stepLabels();
    return stepMin;
  }

  function runHtml(s) {
    var left = remaining(s);
    var frac = s.totalMs > 0 ? Math.max(0, Math.min(1, left / s.totalMs)) : 0;
    return '<div class="mcx-focus-ring">' +
        '<svg viewBox="0 0 120 120" aria-hidden="true">' +
          '<circle class="mcx-focus-track" cx="60" cy="60" r="54"/>' +
          '<circle class="mcx-focus-arc" cx="60" cy="60" r="54" stroke-dasharray="' + C.toFixed(2) + '" ' +
            'stroke-dashoffset="' + (C * (1 - frac)).toFixed(2) + '"/>' +
        '</svg>' +
        '<div class="mcx-focus-time">' + fmt(left) + '</div>' +
      '</div>' +
      '<div class="mcx-focus-ctrl">' +
        '<button type="button" class="mcx-focus-btn2" data-act="toggle">' +
          svg(s.running ? IC.pause : IC.play) + '<span>' + (s.running ? 'Pause' : 'Resume') + '</span></button>' +
        '<button type="button" class="mcx-focus-btn2" data-act="stop">' +
          svg(IC.stop) + '<span>Finish</span></button>' +
      '</div>' +
      (s.note ? '<div class="mcx-focus-note">' + esc(s.note) + '</div>' : '');
  }

  function askPinHtml() {
    return '<div class="mcx-focus-q">Keep this timer on screen while you work. Where should it follow you?</div>' +
      '<div class="mcx-focus-opts">' +
        '<button type="button" class="mcx-focus-opt" data-pin="canvas"><span class="mcx-focus-opt-name">Only in Canvas</span></button>' +
        '<button type="button" class="mcx-focus-opt" data-pin="all"><span class="mcx-focus-opt-name">On All Sites</span></button>' +
      '</div>' +
      '<button type="button" class="mcx-focus-quiet" data-act="cancelask">Cancel</button>';
  }

  function askFinishHtml(s) {
    return '<div class="mcx-focus-q">Did you finish “' + esc(shortTitle(s.title)) + '”?</div>' +
      '<div class="mcx-focus-opts">' +
        '<button type="button" class="mcx-focus-opt" data-act="yes"><span class="mcx-focus-opt-name">Yes, mark it done</span></button>' +
        '<button type="button" class="mcx-focus-opt" data-act="no"><span class="mcx-focus-opt-name">Not yet</span></button>' +
      '</div>';
  }

  function bodyHtml(s) {
    if (s.ask === 'pin') return askPinHtml();
    if (s.ask === 'finish') return askFinishHtml(s);
    if (!s.totalMs) return pickHtml();
    return runHtml(s);
  }

  function cardHtml(s, isStandalone) {
    return headHtml(s, isStandalone) + '<div class="mcx-focus-body">' + bodyHtml(s) + '</div>';
  }

  /* 只有这几样变了才值得重建节点。秒数不在里面：那一格每一秒都要动，
     重建会把描边那一圈从满圈重跑一次 */
  function structureOf(s) {
    return [s.ask || '', s.mode, s.pin || '', s.hidden ? 'h' : '', s.totalMs ? (s.running ? 'r' : 'p') : 'pick',
      s.note || '', presets.join(',')].join('|');
  }

  /* ==== 悬浮卡的位置与手势 ==== */

  function clampGeo(g) {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    g.w = Math.max(MIN_W, Math.min(g.w || FLOAT_W, Math.min(MAX_W, Math.max(MIN_W, vw - 16))));
    // 0＝没拧过高，那一格留给内容自己撑；一旦拧过就按档收着
    if (g.h) g.h = Math.max(MIN_H, Math.min(g.h, Math.min(MAX_H, Math.max(MIN_H, vh - 16))));
    g.x = Math.max(8 - (g.w - 120), Math.min(g.x || 0, Math.max(8, vw - 120)));
    g.y = Math.max(0, Math.min(g.y || 0, Math.max(0, vh - 56)));
    return g;
  }

  function homeGeo() {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    return { x: Math.max(8, vw - FLOAT_W - 24), y: Math.max(8, Math.round(vh * 0.18)), w: FLOAT_W, h: 0 };
  }

  function placeFloat(el) {
    if (!geo) geo = homeGeo();
    clampGeo(geo);
    el.style.left = Math.round(geo.x) + 'px';
    el.style.top = Math.round(geo.y) + 'px';
    el.style.width = Math.round(geo.w) + 'px';
    el.style.height = geo.h ? Math.round(geo.h) + 'px' : '';
  }

  function saveGeo() {
    if (!geo) return;
    var o = {};
    o[GKEY] = { x: Math.round(geo.x), y: Math.round(geo.y), w: Math.round(geo.w), h: Math.round(geo.h || 0) };
    write(o);
  }

  /* 两个下角都能拧：只给右下角一颗的话，想把卡往左挪着放大就得先搬一次窗口。
     左下那颗拧的是宽度的同时要带着左边缘走，右边缘那一条留在原地 */
  /* 整块窗口都能抓（里面那几颗键和两个下角除外），所以"hover 变抓手"这句话是真的：
     只让抬头能拖、整块却画着手形，那是骗人的光标 */
  function bindGestures(el) {
    var grips = el.querySelectorAll('[data-edge]');

    function start(e, kind) {
      if (e.button !== 0 || !geo) return;
      if (e.target.closest && e.target.closest('button, input, [data-edge], [contenteditable]')) return;
      var g0 = { x: geo.x, y: geo.y, w: geo.w, h: geo.h || el.offsetHeight };
      var sx = e.clientX, sy = e.clientY;
      var pending = null, frame = 0;
      el.classList.add('is-dragging');
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}

      function pump() {
        frame = 0;
        var ev = pending;
        pending = null;
        if (!ev) return;
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (kind === 'move') {
          geo.x = g0.x + dx;
          geo.y = g0.y + dy;
          el.style.transform = 'translate3d(' + Math.round(geo.x - g0.x) + 'px,' + Math.round(geo.y - g0.y) + 'px,0)';
          return;
        }
        var w = kind === 'sw' ? g0.w - dx : g0.w + dx;
        geo.w = w;
        geo.h = g0.h + dy;
        clampGeo(geo);
        if (kind === 'sw') geo.x = g0.x + (g0.w - geo.w);
        el.style.left = Math.round(geo.x) + 'px';
        el.style.width = Math.round(geo.w) + 'px';
        el.style.height = Math.round(geo.h) + 'px';
      }
      function move(ev) { pending = ev; if (!frame) frame = requestAnimationFrame(pump); }
      function done() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        if (frame) cancelAnimationFrame(frame);
        clampGeo(geo);
        el.style.transform = '';
        placeFloat(el);
        el.classList.remove('is-dragging');
        saveGeo();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
      e.preventDefault();
    }

    el.addEventListener('pointerdown', function (e) { start(e, 'move'); });
    for (var i = 0; i < grips.length; i++) {
      (function (grip) {
        grip.addEventListener('pointerdown', function (e) {
          // 不掐掉这一颗，这一点会顺着冒到上面那一颗，变成"拧大小的同时在搬窗口"
          e.stopPropagation();
          start(e, grip.getAttribute('data-edge'));
        });
      })(grips[i]);
    }
  }

  function gripsHtml() {
    return '<div class="mcx-focus-grip" data-edge="sw" aria-hidden="true"></div>' +
      '<div class="mcx-focus-grip" data-edge="se" aria-hidden="true"></div>';
  }

  /* ==== 挂载与卸载 ==== */

  function destroy(which) {
    if (which === 'card' && extraCombinedCard && (!widgetOn() || gradesLoc() !== 'combined')) {
      if (extraCombinedCard.parentNode) extraCombinedCard.parentNode.removeChild(extraCombinedCard);
      extraCombinedCard = null;
    }
    var s = surfaces[which];
    if (!s) return;
    surfaces[which] = null;
    structKey = '__none__';
    if (!s.parentNode) return;
    /* 淡出之前先按现在这一份状态重画一次。上一版没重画：在别处取消固定以后，
       这一页那颗要消失的卡把图钉还亮着的那张脸留到动画结束＝他报的"本页还显示正在被固定"。
       重画以后里面那几颗没再绑事件也不要紧：.is-leaving 那条已经把 pointer-events 关了 */
    /* 挂在外面的模块（Grading）要在这颗离场之前把自己的节点和类名收干净：
       它那份面板是按"这一屏上只有我一块卡"设计的，退场那张留着一份＝屏幕上两份 */
    if (window.MCxGrading && window.MCxGrading.release) window.MCxGrading.release(s);
    {
      var slot = which === 'card' ? s.querySelector('.mcx-focus-slot') : null;
      /* 卡片那一格只换里面那一格。上一版整块 innerHTML 覆盖，把封面那一层一起抹了＝
         他看到的"图片先消失，然后卡片再消失"。
       原来这一趟只在 S 有值时跑：没有会话时那颗卡带着上一份脸淡出，
       Grading 挂在它身上的 mcx-g-open 也一路留在页面上 */
      if (slot) slot.innerHTML = slotHtml(S);
      else if (S) {
        s.innerHTML = (which === 'float' ? gripsHtml() : '') + cardHtml(S);
        if (which === 'float') bindGestures(s);
        bindStep(s);
      }
    }
    // 退场要播完才能摘节点。摘掉 id 是让它当场从"这一页的那一块"里除名：
    // 下一趟巡检要找的是 surfaces，不是页面上那一颗，两边不会撞
    s.removeAttribute('id');
    s.classList.add('is-leaving');
    var gone = false;
    var drop = function () { if (gone) return; gone = true; if (s.parentNode) s.parentNode.removeChild(s); };
    s.addEventListener('animationend', drop);
    setTimeout(drop, OUT_MS + 140);
  }

  function mountDock() {
    var slot = dockSlot();
    if (!slot) return null;
    var right = slot.host;
    var el = surfaces.dock;
    if (!el) {
      // 上一块还在播退场动画就重开：先把那颗摘干净，不然它会占着位置把新的一块顶下去
      var stale = right.querySelectorAll('.mcx-focus-card.is-leaving');
      for (var i = 0; i < stale.length; i++) {
        if (stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
      }
      el = document.createElement('div');
      el.id = 'mcx-focus-panel';
      el.className = 'mcx-focus-card mcx-focus-dock';
      /* 这一格不带封面：墙上那张卡才需要抄课程卡的封面高度，
         这条横栏（List view 的入口／跑起来以后停靠的面板）里面只有内容 */
      el.innerHTML = '<div class="mcx-focus-slot"></div>';
      surfaces.dock = el;
      bindCard(el);
      structKey = '__none__';
    }
    /* 判"到没到位"要拿它自己后面那颗比，不能拿"是不是第一个"比：
       那一列里本来就有站点自己的块，拿第一个比就永远不等，于是每趟重插＝每趟重放动画 */
    if (el.parentNode !== right || el.nextElementSibling !== slot.before) right.insertBefore(el, slot.before);
    return el;
  }

  function mountFloat() {
    var el = surfaces.float;
    if (!el) {
      el = document.createElement('div');
      el.id = 'mcx-focus-float';
      el.className = 'mcx-focus-card mcx-focus-float';
      surfaces.float = el;
      bindCard(el);
      structKey = '__none__';
    }
    if (!el.isConnected) {
      document.body.appendChild(el);
      placeFloat(el);
    }
    applyTheme(el);
    return el;
  }

  /* 那一列在不在屏幕上：只卡宽度和位置，不卡高度——空栏目量出来就是几十像素 */
  function onScreen(el) {
    if (!el) return false;
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 120) return false;
    return r.right > 8 && r.left < (window.innerWidth || 1280) - 40;
  }

  /* 停靠格在哪：优先我们那块 Hub 板前面，Hub 面板这一页没挂上时退到那一列自己的最前面。
     以前只认 Hub 板，于是"我们的面板没开"被当成"这页没有右栏"——
     右边明明一整列空着，悬浮那颗却只能收起（2026-10-16 他报） */
  function dockSlot() {
    var hub = document.getElementById('mc-todo-panel');
    if (hub && onScreen(hub.parentNode)) return { host: hub.parentNode, before: hub };
    var right = document.getElementById('right-side');
    if (onScreen(right)) {
      /* 那一列里"站点自己的第一块"才算落点，得跳过我们自己的卡：
         不然这一句每次算出来的都是我们刚插进去的那颗，mountDock 每趟都重插一遍，
         而搬动节点＝重放进场动画＝他看到的"一直闪烁重复展开"（2026-10-16） */
      var first = right.firstElementChild;
      while (first && first.classList.contains('mcx-focus-card')) first = first.nextElementSibling;
      return { host: right, before: first };
    }
    return null;
  }

  function hubPresent() { return !!dockSlot(); }

  /* 有没有"停靠"这一档：Dashboard 上是那张虚拟卡当停靠档，别处是 Hub 上方那一格 */
  function dockable() {
    return !!wallHost() || hubPresent();
  }

  /* ==== Dashboard 上那张虚拟卡 ====
     它是一张真卡片：挂 .ic-DashboardCard、排在所有课程后面，所以现有的瀑布流、列归属、
     卡片换高度的重排全部把它当同伙。封面按主题配图那串顺序往后接一格；
     下面不排课程名也不排 Tasks，排的就是 Focus 那一块。翻成悬浮窗时这张卡从墙上摘掉。
     新版那两页签（Dashboard｜Courses）里，Courses 页签挂的就是同一面 .ic-DashboardCard 墙
     （2026-10-18 ndm 实测：容器、卡类名、卡头、fiber 上的 moveCard/totalCards 全和旧版一致），
     所以这里一律只看"这一屏有没有一面量得到的墙"，不看页面上有没有 Customize 那颗整页级的键。 */

  /* 这一屏是不是"那张墙卡本该在、只是被站点藏起来了"＝List view 的 Dashboard：
     课程卡节点还留着，量出来却是 0×0。只有这一屏才把入口改站 Hub 上方那一格。
     作业页那一屏压根没有课程卡节点，不该去占那一格
     （我上一版没分这两件事，结果那条横栏把标题上那颗键顶掉了）。 */
  /* 那面卡墙在哪：只认 .ic-DashboardCard__box__container 这一层，卡片得是它的直接子节点。
     新版 Dashboard 页签里"课程成绩"那个小组件也挂 data-testid=course-grade-card-<id>，
     可它住在一格 CSS 网格里，不是墙（2026-10-18 ndm 实测：上一版按"有没有这种节点"找墙，
     于是我们那张卡被排进那个网格的最后一格，量出来 262x722，落在整屏最下面）。 */
  function wallField() {
    var fields = document.querySelectorAll('.ic-DashboardCard__box__container');
    for (var i = 0; i < fields.length; i++) {
      var kids = fields[i].children;
      var real = [];
      for (var k = 0; k < kids.length; k++) {
        var c = kids[k];
        if (c.classList.contains('mcx-focus-vcard')) continue;
        var testid = c.getAttribute('data-testid') || '';
        if (!c.classList.contains('ic-DashboardCard') && testid.indexOf('course-grade-card-') !== 0) continue;
        real.push(c);
      }
      if (real.length) return { field: fields[i], cards: real };
    }
    return null;
  }

  function wallHidden() {
    if (!CANVAS || !switchOn() || !widgetOn()) return false;
    var w = wallField();
    if (!w) return false;
    return !onScreen(w.cards[0]);
  }

  function wallHost() {
    if (!CANVAS || !switchOn() || !widgetOn()) return null;
    var w = wallField();
    if (!w) return null;
    var real = w.cards;
    var last = real[real.length - 1];
    /* 节点在，不等于那面墙在。List view 底下站点把整面墙藏了（课程卡节点还留着、量出来 0×0），
       上一版判的是"有没有节点"，于是这张卡被挂进一个看不见的子树＝List view 根本没有入口
       （2026-10-17 hcpss 实测：11 颗课程卡全是 0×0，我们那颗也跟着 0×0）。
       现在按屏幕上量得到才算这一屏有墙。 */
    if (!onScreen(last)) return null;
    var parent = w.field;
    if (!parent || parent === document.body) return null;
    return { parent: parent, last: last, cards: real, count: real.length };
  }

  function isDashboardWidget(el) {
    if (!el || !el.closest) return false;
    if (el.closest('.mcx-focus-vcard')) return true;
    if (!el.closest('.mcx-focus-dock')) return false;
    return wallHidden() || /^\/(?:courses|dashboard)\/?$/i.test(location.pathname);
  }

  function wallPosition() {
    try {
      var raw = localStorage.getItem(WALL_POS_KEY);
      var n = raw == null ? NaN : Number(raw);
      return isFinite(n) && n >= 0 ? Math.floor(n) : -1;
    } catch (e) { return -1; }
  }

  function wallInsertBefore(host) {
    var index = wallPosition();
    return index >= 0 && index < host.cards.length ? host.cards[index] : host.last.nextSibling;
  }

  /* Widget 使用 pointer 手势，避免启动 Canvas 的 React DnD backend。
     拖动中仅在插入槽变化时移动扩展节点；原生课程节点仍由 Canvas 管理。 */
  function bindWallDrag(el, customPosKey) {
    if (el.dataset.mcxWallDragBound) return;
    el.dataset.mcxWallDragBound = '1';
    var posKey = customPosKey || WALL_POS_KEY;
    el.addEventListener('mcx-wall-course-drop', function (event) {
      var result;
      try { result = JSON.parse(event.detail); } catch (e) { return; }
      if (!result || !Number.isInteger(result.position) || result.position < 0) return;
      try { localStorage.setItem(posKey, String(result.position)); } catch (e) {}
      el.removeAttribute('data-mcx-course-drop-pending');
      canvasPass();
      relayoutWall();
    });
    el.draggable = false;
    el.addEventListener('dragstart', function (event) { event.preventDefault(); });
    el.addEventListener('pointerdown', function (down) {
      if (down.button !== 0 || down.isPrimary === false || wallDragSource) return;
      var target = down.target instanceof Element ? down.target : null;
      if (!target || target.closest('button, a, input, textarea, select, [contenteditable], [role="button"]')) return;
      var parent = el.parentNode;
      var cards = Array.from(parent.children).filter(function (c) {
        return c !== el && c.matches('.ic-DashboardCard, [data-testid^="course-grade-card"]');
      });
      if (!cards.length) return;
      down.preventDefault();
      var ghost = null, active = false, index = null, frame = 0;
      var finished = false;
      var x = down.clientX, y = down.clientY;
      var origin = el.getBoundingClientRect();
      var originalNext = el.nextSibling;
      var previewIndex = cards.filter(function (c) {
        return !!(c.compareDocumentPosition(el) & 4);
      }).length;
      var originalIndex = previewIndex;
      var scrollStartX = window.scrollX, scrollStartY = window.scrollY;
      var slots = null;
      var wallBounds = null;
      function placePreview(before) {
        if (before === el || before === el.nextSibling) return;
        parent.insertBefore(el, before);
        // 与墙的 MutationObserver 共用同一个队列，避免每次换位同步排一次、下一帧又排一次。
        if (window.mcHost && window.mcHost.mcQueueMasonryLayout) window.mcHost.mcQueueMasonryLayout();
        else relayoutWall();
      }
      function render() {
        frame = 0;
        if (!el.isConnected || el.parentNode !== parent) { finish(false); return; }
        ghost.style.transform = 'translate3d(' + (x - down.clientX) + 'px,' + (y - down.clientY) + 'px,0)';
        var sx = window.scrollX, sy = window.scrollY;
        var bounds = { left: wallBounds.left - sx, right: wallBounds.right - sx,
          top: wallBounds.top - sy, bottom: wallBounds.bottom - sy };
        index = null;

        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
        var originalX = x + window.scrollX - scrollStartX;
        var originalY = y + window.scrollY - scrollStartY;
        if (originalX >= origin.left && originalX <= origin.right &&
            originalY >= origin.top && originalY <= origin.bottom) {
          index = originalIndex;
          if (index !== previewIndex) {
            previewIndex = index;
            placePreview(cards[index] || cards[cards.length - 1].nextSibling);
          }
          return;
        }
        var nearest = null, distance = Infinity;
        cards.forEach(function (c, i) {
          if (!c.isConnected || c.parentNode !== parent) return;
          var slot = slots[i];
          var r = { left: slot.left - window.scrollX, right: slot.right - window.scrollX, top: slot.top - window.scrollY, bottom: slot.bottom - window.scrollY, width: slot.width, height: slot.height };
          if (!r.width || !r.height) return;
          var dx = Math.max(r.left - x, 0, x - r.right);
          var dy = Math.max(r.top - y, 0, y - r.bottom);
          var d = dx * dx + dy * dy;
          if (d < distance) { distance = d; nearest = { r: r, i: i }; }
        });
        if (!nearest) return;
        var r = nearest.r;
        // 在卡片范围内按左右半边插入；从上下间隙进入则按上下方向。
        var vertical = y < r.top || y > r.bottom;
        var before = vertical ? y < r.top : x < r.left + r.width / 2;
        index = nearest.i + (before ? 0 : 1);
        if (index !== previewIndex) {
          previewIndex = index;
          placePreview(cards[index] || cards[cards.length - 1].nextSibling);
        }
      }
      function move(event) {
        if (event.pointerId !== down.pointerId) return;
        x = event.clientX; y = event.clientY;
        if (!active && Math.hypot(x - down.clientX, y - down.clientY) < 7) return;
        event.preventDefault();
        if (!active) {
          active = true;
          wallDragSource = true;
          var bounds = parent.getBoundingClientRect();
          wallBounds = { left: bounds.left + window.scrollX, right: bounds.right + window.scrollX,
            top: bounds.top + window.scrollY, bottom: bounds.bottom + window.scrollY };
          slots = cards.map(function (c) {
            var r = c.getBoundingClientRect();
            return { left: r.left + window.scrollX, right: r.right + window.scrollX,
              top: r.top + window.scrollY, bottom: r.bottom + window.scrollY,
              width: r.width, height: r.height };
          });
          ghost = el.cloneNode(true);
          ghost.classList.remove('ic-DashboardCard');
          ghost.classList.add('mcx-wall-ghost');
          ghost.removeAttribute('id');
          ghost.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
          ghost.setAttribute('aria-hidden', 'true');
          ghost.inert = true;
          var cs = getComputedStyle(el);
          ghost.style.cssText = '';
          ['background', 'color', 'border-radius', 'font', 'box-shadow'].forEach(function (name) {
            ghost.style.setProperty(name, cs.getPropertyValue(name));
          });
          ghost.style.setProperty('position', 'fixed', 'important');
          ghost.style.setProperty('left', origin.left + 'px', 'important');
          ghost.style.setProperty('top', origin.top + 'px', 'important');
          ghost.style.setProperty('width', origin.width + 'px', 'important');
          ghost.style.setProperty('height', origin.height + 'px', 'important');
          document.body.appendChild(ghost);
          el.classList.add('mcx-wall-dragging');
        }
        if (!frame) frame = requestAnimationFrame(render);
      }
      function finish(commit) {
        if (finished) return;
        finished = true;
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('resize', cancel);
        window.removeEventListener('keydown', key);

        if (commit && active && index !== null && el.isConnected && el.parentNode === parent &&
            cards.every(function (c) { return c.isConnected && c.parentNode === parent; })) {
          var before = cards[index] || cards[cards.length - 1].nextSibling;
          if (before !== el && before !== el.nextSibling) parent.insertBefore(el, before);
          try { localStorage.setItem(posKey, String(index)); } catch (e) {}
          relayoutWall();
        } else if (active && el.isConnected && el.parentNode === parent) {
          placePreview(originalNext && originalNext.parentNode === parent ? originalNext : null);
        }
        function clearPreview() {
          if (ghost) ghost.remove();
          el.classList.remove('mcx-wall-dragging');
          wallDragSource = false;
        }
        clearPreview();
      }
      function up(event) {
        if (event.pointerId !== down.pointerId) return;
        if (active) { x = event.clientX; y = event.clientY; if (frame) cancelAnimationFrame(frame); render(); }
        finish(true);
      }
      function cancel() { finish(false); }
      function key(event) { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('blur', cancel);
      window.addEventListener('resize', cancel);
      window.addEventListener('keydown', key);
    });
  }
  /* 封面多高不写死：抄这一屏真卡片那一格自己的计算高度，换主题跟着走 */
  function coverHeight(last) {
    try {
      var hd = last.querySelector('.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero, .bc-grade-card-header');
      var h = hd ? hd.offsetHeight : 0;
      if (h > 20) return h;
    } catch (e) {}
    return 146;
  }

  function widgetSettingsButtonHtml() {
    return '<button type="button" class="mcx-widget-settings" data-act="widget-settings" aria-label="Widget Settings" title="Widget Settings"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>';
  }

  function cardCoverHtml() {
    return '<div class="mcx-focus-cover"></div>';
  }

  function cardShell() {
    return widgetSettingsButtonHtml() + cardCoverHtml() + '<div class="mcx-focus-slot"></div>';
  }

  function openWidgetSettings() {
    document.dispatchEvent(new CustomEvent('mc-open-widget-settings'));
  }

  function bindWidgetSettingsCard(el) {
    if (!el || el.dataset.mcxWidgetSettingsBound) return;
    el.dataset.mcxWidgetSettingsBound = '1';
    el.addEventListener('click', function (e) {
      var button = e.target.closest ? e.target.closest('.mcx-widget-settings') : null;
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      openWidgetSettings();
    });
  }

  function paintCover(el, host) {
    var c = el.querySelector('.mcx-focus-cover');
    if (!c) return;
    var art = null;
    try { art = window.mcHost && window.mcHost.mcCardArtAt ? window.mcHost.mcCardArtAt(host.count) : null; } catch (e) {}
    if (!art && host.cards && host.cards.length) {
      for (var ci = 0; ci < host.cards.length; ci++) {
        var crd = host.cards[ci];
        var hd = crd.querySelector('.bc-grade-card-header, .ic-DashboardCard__header_image, .ic-DashboardCard__header_hero') || crd.firstElementChild;
        if (hd) {
          try {
            var bStyle = window.getComputedStyle(hd, '::before');
            var aStyle = window.getComputedStyle(hd, '::after');
            var oStyle = window.getComputedStyle(hd);
            var bgImg = (bStyle.backgroundImage && bStyle.backgroundImage !== 'none') ? bStyle.backgroundImage
              : ((oStyle.backgroundImage && oStyle.backgroundImage !== 'none') ? oStyle.backgroundImage : '');
            if (bgImg && bgImg !== 'none') {
              art = {
                img: bgImg,
                film: (aStyle.backgroundImage && aStyle.backgroundImage !== 'none') ? aStyle.backgroundImage : '',
                filter: (bStyle.filter && bStyle.filter !== 'none') ? bStyle.filter : '',
                size: bStyle.backgroundSize || 'cover',
                pos: bStyle.backgroundPosition || 'center',
                repeat: bStyle.backgroundRepeat || 'no-repeat'
              };
              break;
            }
          } catch (e2) {}
        }
      }
    }
    var h = coverHeight(host.last);
    var sig = h + '|' + (art ? [art.img, art.film, art.filter, art.size, art.pos, art.repeat].join('|') : 'none');
    if (c.dataset.mcSig === sig) return;
    c.dataset.mcSig = sig;
    c.style.height = h + 'px';
    c.style.setProperty('--mcx-fc-img', (art && art.img) || 'none');
    c.style.setProperty('--mcx-fc-film', (art && art.film) || 'none');
    c.style.setProperty('--mcx-fc-filter', (art && art.filter && art.filter !== 'none') ? art.filter : 'none');
    c.style.setProperty('--mcx-fc-size', (art && art.size) || 'cover');
    c.style.setProperty('--mcx-fc-pos', (art && art.pos) || 'center');
    c.style.setProperty('--mcx-fc-repeat', (art && art.repeat) || 'no-repeat');
  }

  function relayoutWall() {
    try { if (window.mcHost && window.mcHost.mcMasonryLayout) window.mcHost.mcMasonryLayout(); } catch (e) {}
  }

  /* 虚拟卡可能刚插入、还没完成这一趟 paint。等当前同步绘制结束后再量，
     否则 Masonry 会拿空壳高度排位，后续内容长出来时就只会把卡片往下推。 */
  function queueRelayoutWall() {
    try {
      if (window.mcHost && window.mcHost.mcQueueMasonryLayout) {
        window.mcHost.mcQueueMasonryLayout(true);
        return;
      }
      if (window.mcHost && window.mcHost.mcMasonryLayout) {
        window.requestAnimationFrame(function () {
          if (window.mcHost && window.mcHost.mcReflowMasonryLayout) window.mcHost.mcReflowMasonryLayout();
          else relayoutWall();
        });
      }
    } catch (e) {}
  }

  function mountCard(host) {
    if (!widgetOn()) return null;
    var fLoc = focusLoc();
    var separate = fLoc === 'separate';
    if (fLoc === 'off') {
      if (surfaces.card) destroy('card');
      return null;
    }
    if (separate && S && S.mode === 'float') {
      if (surfaces.card) destroy('card');
      return null;
    }
    if (!separate && fLoc !== 'combined' && gradesLoc() !== 'combined') {
      if (surfaces.card) destroy('card');
      return null;
    }
    var el = surfaces.card;
    var coverOn = !separate || separateCoverOn();
    if (!el) {
      el = document.createElement('div');
      el.className = 'ic-DashboardCard mcx-focus-vcard' + (separate ? ' mcx-focus-standalone' : ' mcx-focus-combined') + (coverOn ? ' has-cover' : '');
      el.setAttribute('aria-label', 'Focus');
      el.innerHTML = separate && !coverOn
        ? widgetSettingsButtonHtml() + '<div class="mcx-focus-slot"></div>'
        : cardShell();
      surfaces.card = el;
      bindCard(el);
      bindWallDrag(el);
      structKey = '__none__';
    } else {
      el.classList.toggle('mcx-focus-standalone', separate);
      el.classList.toggle('mcx-focus-combined', !separate);
      el.classList.toggle('has-cover', coverOn);
      if (!coverOn) {
        var cov = el.querySelector('.mcx-focus-cover');
        if (cov) cov.remove();
      } else if (!el.querySelector('.mcx-focus-cover')) {
        var holder = document.createElement('div');
        holder.innerHTML = cardCoverHtml();
        var cov = holder.firstChild;
        el.insertBefore(cov, el.firstChild);
      }
    }
    if ((wallDragSource || el.hasAttribute('data-mcx-course-drop-pending')) && el.parentNode === host.parent) return el;
    var before = wallInsertBefore(host);
    if (el.parentNode !== host.parent || (before !== el && before !== el.nextSibling)) {
      host.parent.insertBefore(el, before);
      queueRelayoutWall();
    }
    if (coverOn) paintCover(el, host);
    return el;
  }

  var extraCombinedCard = null;

  function syncExtraCombinedCard(host) {
    var fLoc = focusLoc();
    var gLoc = gradesLoc();
    var need = widgetOn() && host && gLoc === 'combined' && fLoc !== 'combined';
    if (!need) {
      if (extraCombinedCard) {
        if (extraCombinedCard.parentNode) extraCombinedCard.parentNode.removeChild(extraCombinedCard);
        extraCombinedCard = null;
        queueRelayoutWall();
      }
      return;
    }
    if (!extraCombinedCard) {
      var el = document.createElement('div');
      el.className = 'ic-DashboardCard mcx-focus-vcard mcx-focus-combined has-cover';
      el.setAttribute('aria-label', 'Widgets');
      el.innerHTML = widgetSettingsButtonHtml() + cardCoverHtml() + '<div class="mcx-focus-slot"><div class="mcx-g-host"></div></div>';
      extraCombinedCard = el;
      bindCard(el);
      bindWallDrag(el);
    }
    var before = wallInsertBefore(host);
    if (extraCombinedCard.parentNode !== host.parent || (before !== extraCombinedCard && before !== extraCombinedCard.nextSibling)) {
      host.parent.insertBefore(extraCombinedCard, before);
      queueRelayoutWall();
    }
    paintCover(extraCombinedCard, host);
    if (window.MCxGrading && window.MCxGrading.sync) window.MCxGrading.sync(extraCombinedCard);
  }

  /* 只认作业自己那一屏：作业号得是地址最后那一段。
     测验的"开始/答题"那一屏是 /assignments/<号>/taking/<号>，那一屏不该有这颗键
     （2026-10-16 他报的就是这一屏）；作业列表 /assignments 没带号，本来也不算。
     两处都用这一颗，别各写一份正则写歪。 */
  function assignmentPath() {
    var m = /\/courses\/(\d+)\/assignments\/(\d+)\/?$/i.exec(location.pathname);
    return m ? { courseId: m[1], assignmentId: m[2] } : null;
  }

  /* 停靠那一格只认它自己的那一页：作业页本身。
     不固定就只在这一页出现——这是这一轮他拍的口径 */
  function atHome() {
    if (!CANVAS || !S || !S.assignmentId) return false;
    var hit = assignmentPath();
    return !!hit && hit.assignmentId === String(S.assignmentId);
  }

  /* 固定管的是"跟不跟到别的页面去"，和悬浮那档是两颗独立的键 */
  function inScope() {
    return !!(S && S.pin && (S.pin === 'all' || CANVAS));
  }

  function isDashboardPage() {
    return CANVAS && (/^\/$/.test(location.pathname) || /^\/courses\/?$/i.test(location.pathname) || /\/dashboard(?:\/|$)/i.test(location.pathname));
  }

  function resetDashboardToWidgetList(session) {
    if (!isDashboardPage()) {
      dashboardWasActive = false;
      return;
    }
    if (!dashboardWasActive) {
      dashboardWasActive = true;
      dashboardEntryPending = true;
    }
    if (!dashboardEntryPending) return;
    try { localStorage.setItem('mc_dash_focus_open', '0'); } catch (e) {}
    if (session && session.sid && widgetOn() && focusLoc() === 'combined') {
      try { sessionStorage.setItem(DASH_DISMISSED_KEY, String(session.sid)); } catch (e) {}
    }
    dashboardEntryPending = false;
  }

  /* Assignment 会话在它自己的作业页和 Dashboard 总览页都可见；其他页面仍由固定范围决定。 */
  function homeHere() {
    if (!CANVAS) return false;
    /* 作业里启动的会话，只有回到它自己的 Assignment 才算本地页面；
       Dashboard 及其他 Canvas 页要由 pin 范围决定是否跟随。Dashboard 自己启动的会话仍以 Dashboard 为家。 */
    if (S && S.assignmentId) return atHome() || isDashboardPage();
    /* 合并卡的本地收起标记不应阻止独立卡或悬浮窗落在当前 Dashboard。 */
    if (S && !S.hidden && !(focusLoc() === 'combined' && dashDismissed(S)) && (wallHost() || wallHidden())) return true;
    return atHome();
  }

  function allowed(which) {
    if (!S || S.hidden || !switchOn()) return false;
    /* Dashboard 上按 × 只关闭本标签页的悬浮层；共享会话仍保留 float，
       其他页面可以继续显示它自己的悬浮窗。 */
    if (which === 'float' && CANVAS && dashFloatDismissed(S) && (wallHost() || wallHidden())) return false;
    /* Canvas 上先按用户选的形态走：docked 在每个被固定的 Canvas 页面都停 Hub 上方，
       float 才在这些页面显示悬浮窗。All Sites 扩展到其他网站时统一用悬浮窗。 */
    if (which === 'dock') return S.mode === 'docked' && CANVAS && hubPresent() && (homeHere() || inScope());
    if (S.mode === 'docked') return !CANVAS && inScope();
    return inScope() || homeHere();
  }

  /* 要问一句的时候手上可能没有画面（× 收起过）：先让自己重新露出来 */
  function reveal() {
    if (S) S.hidden = false;
  }

  /* × 在 Dashboard 上不是把卡收走（卡是常驻的），是缩成"入口"那一档：
     只剩封面加一行 Focus，点它再展开回面板 */
  function entryHtml() {
    return '<button type="button" class="mcx-focus-entry" data-act="expand">' + svg(IC.alarm) +
      '<span>Focus</span></button>';
  }

  /* 这一趟要么正显示在这张卡里，要么已经搬到别处（悬浮窗／被收起）＝卡缩成入口 */
  /* 换档只写里面那一格。上一版整块 innerHTML 重搭，把封面那颗节点也换掉了＝
     背景图重新解析一次＝他看到的"图片先闪没" */
  /* 重建正文时把外面模块那一格先摘出来、写完再放回去：
     连它一起 innerHTML 掉，对面就得整块重画＝闪一下、hover 丢、aria-live 把同一个数再念一遍 */
  function keepGuest(slot) {
    if (focusLoc() === 'separate') return null;
    var g = slot.querySelector(':scope > .mcx-g-host');
    return g && g.parentNode === slot ? g : null;
  }
  function writeSlot(el, s) {
    var slot = el.querySelector('.mcx-focus-slot');
    var separate = el.classList.contains('mcx-focus-standalone') || focusLoc() === 'separate';
    if (!slot) {
      /* 退场那一次重画走的是 innerHTML 整块覆盖，会把这一格连壳一起吃掉，
         下一趟就得按这一颗自己的形状补壳：墙上那张卡带封面，那条横栏不带 */
      el.innerHTML = (el.classList.contains('mcx-focus-dock') || separate)
        ? '<div class="mcx-focus-slot"></div>' : cardShell();
      slot = el.querySelector('.mcx-focus-slot');
    }
    var guest = keepGuest(slot);
    slot.innerHTML = slotHtml(s, separate);
    if (guest && !separate) slot.appendChild(guest);
    if (focusWidgetEntrance) {
      var body = slot.querySelector('.mcx-focus-body');
      if (body) {
        body.classList.add('is-entering');
        focusWidgetEntrance = false;
      }
    }
    bindStep(el);
  }

  /* Canvas Dashboard 卡片会在捕获阶段处理课程卡点击。文档级捕获监听器先识别
     Widget 的 Focus 入口并截断传播，避免 Canvas 抢先处理卡片导航或遮掉外层委托。 */
  function bindFocusEntryClicks() {
    if (document.documentElement.dataset.mcxFocusEntryClicksBound) return;
    document.documentElement.dataset.mcxFocusEntryClicksBound = '1';
    document.addEventListener('click', function (e) {
      var entry = e.target && e.target.closest ? e.target.closest('.mcx-focus-entry') : null;
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      if (S && CANVAS && isDashboardWidget(entry)) {
        /* 有一个未固定到 Dashboard 的 Assignment 会话时，slotHtml 会按作用范围把它
           隐去，只留下 Dashboard 自己的 Focus 入口。点入口应打开本地的时长选择器，
           不能尝试恢复那份仍不可见的 Assignment 会话（否则点击被消费、画面原样不动）。 */
        if (S.assignmentId && !homeHere() && !inScope()) {
          focusWidgetEntrance = true;
          setDashOpen(true);
          return;
        }
        setDashDismissed(S, false);
        focusWidgetEntrance = true;
        save(Object.assign({}, S, { hidden: false, mode: 'docked' }));
      } else if (S) {
        save(Object.assign({}, S, { hidden: false, mode: 'docked' }));
      } else {
        setDashOpen(true);
      }
    }, true);
  }

  function slotHtml(s, isStandalone) {
    if (s && s.assignmentId && !homeHere() && !inScope()) {
      /* 未固定的 Assignment 会话本身不跨页显示；但用户可以在 Dashboard 的 Focus 卡
         主动点图钉并选定作用范围。只显示范围选择，不显示作业名或计时，选 Canvas 后
         storage.onChanged 会把同一会话同步到这张卡。 */
      if (!isStandalone && focusLoc() === 'combined' && s.ask === 'pin') {
        return cardHtml(Object.assign({}, idleState(), { ask: 'pin' }), false);
      }
      s = null;
    }
    if (isStandalone) return cardHtml(s || idleState(), true);
    if (focusLoc() !== 'combined') return '';
    if (!s) return (dashOpen() || focusWidgetEntrance) ? cardHtml(idleState(), false) : entryHtml();
    if (dashDismissed(s)) return entryHtml();
    return (s.hidden || s.mode === 'float') ? entryHtml() : cardHtml(s, false);
  }

  function dashDismissed(s) {
    try { return !!(s && s.sid && sessionStorage.getItem(DASH_DISMISSED_KEY) === String(s.sid)); }
    catch (e) { return false; }
  }

  function dashFloatDismissed(s) {
    try { return !!(s && s.sid && sessionStorage.getItem(DASH_FLOAT_DISMISSED_KEY) === String(s.sid)); }
    catch (e) { return false; }
  }

  function setDashFloatDismissed(s, dismissed) {
    try {
      if (dismissed && s && s.sid) sessionStorage.setItem(DASH_FLOAT_DISMISSED_KEY, String(s.sid));
      else sessionStorage.removeItem(DASH_FLOAT_DISMISSED_KEY);
    } catch (e) {}
    structKey = '__none__';
    canvasPass();
  }

  function setDashDismissed(s, dismissed) {
    try {
      if (dismissed && s && s.sid) sessionStorage.setItem(DASH_DISMISSED_KEY, String(s.sid));
      else sessionStorage.removeItem(DASH_DISMISSED_KEY);
    } catch (e) {}
    structKey = '__none__';
    canvasPass();
  }

  /* 墙上那张卡默认只摆"入口"那一档，不把挑时长那一屏摊开：他一进 Dashboard 就看见一整块
     现成内容＝他报的"刚进入 dashboard 就开始显示 focus 界面（已经展开具体内容）"。
     点入口展开、× 缩回去，这个选择记在本地（只有 '1' 算展开，没记过＝缩着）。 */
  function dashOpen() {
    try { return localStorage.getItem('mc_dash_focus_open') === '1'; } catch (e) { return false; }
  }
  function setDashOpen(v) {
    try { localStorage.setItem('mc_dash_focus_open', v ? '1' : '0'); } catch (e) {}
    if (v) focusWidgetEntrance = true;
    /* 活动会话存在时也要重建卡片正文：原结构键只看共享会话形状，
       但 Dashboard 本地展开态变化不会改变会话本身。 */
    structKey = '__none__';
    canvasPass();
  }

  /* 卡上没在跑的时候摆的是"挑时长"那一屏：这张卡是常驻的，不能空着 */
  function idleState() {
    return { totalMs: 0, running: false, mode: 'docked', pin: '', ask: '', note: '', hidden: false };
  }

  function paint() {
    var host = wallHost();
    if (!S) {
      destroy('float');
      var idle;
      if (host) {
        destroy('dock');
        idle = mountCard(host);
      } else {
        destroy('card');
        /* 没有那面墙＝Dashboard 摆在 List view：入口改站 Hub 上方那一格，一条横栏。
           点它摊成面板、面板上按 × 又缩回这条栏，走的是同一格、同一个 mc_dash_focus_open。
           这一支里绝不能再无条件 destroy('dock')：那条横栏就住在这个格子里，
           拆了重搭＝进场动画每 300 毫秒重放一遍＝他报过的"一直闪烁重复展开"。 */
        idle = focusLoc() !== 'off' && wallHidden() && !dashboardWidgetOwnsSurface() ? mountDock() : (destroy('dock'), null);
      }
      var coverOn = focusLoc() !== 'separate' || separateCoverOn();
      var ikey = 'idle|' + (focusLoc() === 'separate' ? 'separate' : (dashOpen() ? 'open' : 'entry')) + '|' + (coverOn ? 'cov' : 'nocov') + '|' + presets.join(',');
      /* 空档那一屏不能每 300 毫秒重搭一次：他正在那一格里敲分钟数，重搭会把字和光标一起吃掉 */
      if (idle && ikey !== structKey) {
        writeSlot(idle, null);
      }
      if (idle && idle === surfaces.card && coverOn) paintCover(idle, host);   // 封面只属于墙上那张卡
      structKey = idle ? ikey : '__none__';
      if (window.MCxGrading && window.MCxGrading.sync) window.MCxGrading.sync(idle);
      syncExtraCombinedCard(host);
      releaseDashboardCardsAfterLayout(host);
      stopTick();
      syncButton();
      return;
    }
    /* 这张卡在 Dashboard 上是常驻的：这一趟搬去悬浮窗、或者被 × 收起，它都留在原位缩成入口。
       但如果是 Separate 卡片独立显示模式，点悬浮窗时卡片应从 Dashboard 消失；从悬浮窗 × 掉时再恢复回到 Dashboard */
    var separate = focusLoc() === 'separate';
    var shouldMountCard = host && !(separate && S && S.mode === 'float');
    var card = shouldMountCard ? mountCard(host) : (destroy('card'), null);
    /* 那一格在 List view 底下就是"那颗入口"本身：这一趟被 × 收起、或者搬到悬浮窗去了，
       它也得留在原地缩成一条横栏，不然这一屏就什么都没有了
       （2026-10-17 他报"到底在哪啊"——上一版只在"完全没有会话"时才画这条横栏，
         而他按过 × 之后那一趟是"存在但收起"，于是墙没有、横栏也没有）。
       里面画入口还是画面板，slotHtml 自己按状态分，这里只管这一格在不在。 */
    var dock = null;
    if (card) destroy('dock');
    else if (!dashboardWidgetOwnsSurface() && (allowed('dock') || (switchOn() && widgetOn() && wallHidden()))) dock = mountDock();
    else destroy('dock');
    var flt = allowed('float') ? mountFloat() : (destroy('float'), null);
    var key = structureOf(S) + '|' + (focusLoc() === 'separate' ? 'sep' : 'com') + '|' + (separateCoverOn() ? 'cov' : 'nocov');
    var rebuild = key !== structKey;
    if (card || dock || flt) {
      [card, dock, flt].forEach(function (el) {
        if (!el) return;
        var coverOn = focusLoc() !== 'separate' || separateCoverOn();
        if (rebuild) {
          if (el === card) {
            writeSlot(el, S);
            if (coverOn) paintCover(el, host);
          } else if (el === dock) {
            /* 那一格也走 writeSlot：里面该摆面板还是只剩一行入口，是 slotHtml 按状态分的，
               上一版这里直接 innerHTML = cardHtml(S)，等于把"收起／悬浮时缩成入口"这条规则
               在横栏上漏掉了 */
            writeSlot(el, S);
          } else {
            el.innerHTML = (el === flt ? gripsHtml() : '') + cardHtml(S);
            if (el === flt) bindGestures(el);
            bindStep(el);
          }
        } else {
          fill(el);
          if (el === card && coverOn) paintCover(el, host);
        }
        el.classList.toggle('is-paused', !S.running && !!S.totalMs);
      });
      structKey = key;
    } else {
      structKey = '__none__';
    }
    if (window.MCxGrading && window.MCxGrading.sync) window.MCxGrading.sync(card || dock);
    syncExtraCombinedCard(host);
    releaseDashboardCardsAfterLayout(host);
    syncButton();
    // 一格都不在屏幕上也要留着这一秒一趟：到点要问、交了要收
    if (S.running) startTick(); else stopTick();
  }

  /* 首屏门闩需等 Focus 异步状态读完，且 Focus/Grades 虚拟卡已进入真实卡墙后再放行。
     Masonry 的完整重排同步执行；再等两帧确保浏览器用最终尺寸完成布局后揭开。 */
  var dashboardRevealQueued = false;
  function releaseDashboardCardsAfterLayout(wall) {
    if (!CANVAS || dashboardRevealQueued || !window.__mcxReleaseDashboardCards) return;
    var root = document.documentElement;
    if (!root || !root.classList.contains('mcx-dashboard-cards-pending')) return;
    var path = location.pathname;
    if (!(path === '/' || /\/dashboard(?:\/|$)/i.test(path) || /^\/courses\/?$/i.test(path))) return;
    // 总开关关闭时无需等虚拟卡：wallHost 本来就会拒绝挂载，若仍按单项默认值等待，
    // 页面会一直被首屏门闩挡到兜底超时（用户探针：mc_dash_focus_card='0'）。
    var wantsWidget = widgetOn() && (focusLoc() !== 'off' || gradesLoc() !== 'off');
    var hasCourseCards = !!wallField();
    // Focus/Grades 启用但 Canvas 还没把课程卡墙挂好时继续等待下一轮 canvasPass；
    // 禁用所有独立卡片时无需等墙，避免挡住普通 Dashboard。
    if (wantsWidget && hasCourseCards && !wall && !wallHidden()) return;
    dashboardRevealQueued = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        dashboardRevealQueued = false;
        if (!root.classList.contains('mcx-dashboard-cards-pending')) return;
        try {
          if (window.mcHost && window.mcHost.mcMasonryLayout) window.mcHost.mcMasonryLayout(true);
        } catch (e) {}
        window.__mcxReleaseDashboardCards();
      });
    });
  }

  /* 每一秒只改圈和字，不重建节点 */
  function fill(el) {
    var left = remaining(S);
    var t = el.querySelector('.mcx-focus-time');
    if (t) t.textContent = fmt(left);
    var arc = el.querySelector('.mcx-focus-arc');
    var frac = S.totalMs > 0 ? Math.max(0, Math.min(1, left / S.totalMs)) : 0;
    if (arc) arc.setAttribute('stroke-dashoffset', (C * (1 - frac)).toFixed(2));
  }

  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(onTick, 1000);
  }

  function stopTick() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  function onTick() {
    if (!S || !S.running) { stopTick(); return; }
    if (remaining(S) <= 0) { expire(); return; }
    if (surfaces.dock && surfaces.dock.isConnected) fill(surfaces.dock);
    if (surfaces.float && surfaces.float.isConnected) fill(surfaces.float);
    if (surfaces.card && surfaces.card.isConnected) fill(surfaces.card);
    pollSubmit();
  }

  /* ==== 动作 ==== */

  function newSid() { return Date.now() + '-' + Math.floor(Math.random() * 1e6); }

  /* 离开 Canvas 以后那些 --mc-* 变量根本不存在，卡会掉回 CSS 里的退路值＝一块纯白板。
     钉住的时候在 Canvas 这一头把正在用的那几档原样抄进状态，
     到别的站点上贴回卡自己：连 alpha 一起抄，所以那边也还是吃主题色的磨砂 */
  var THEME_VARS = ['--mc-background-0', '--mc-text-0', '--mc-text-1', '--mc-borders', '--mc-tint-press'];

  function canvasTheme() {
    if (!CANVAS) return null;
    try {
      var cs = getComputedStyle(document.documentElement);
      var out = {};
      var any = false;
      THEME_VARS.forEach(function (v) {
        var val = String(cs.getPropertyValue(v) || '').trim();
        if (val) { out[v] = val; any = true; }
      });
      return any ? out : null;
    } catch (e) { return null; }
  }

  function applyTheme(el) {
    var t = S && S.theme;
    if (!t || CANVAS) return;
    try {
      THEME_VARS.forEach(function (v) { if (t[v]) el.style.setProperty(v, t[v]); });
    } catch (e) {}
    el.classList.add('is-away');
  }

  /* 这一条作业是谁：页面上量到的最准，量不到才沿用上一份（换页时 S 还在） */
  function identity() {
    var page = CANVAS ? assignmentOnPage() : null;
    var aid = page ? page.assignmentId : (S && S.assignmentId) || '';
    var known = aid ? onPaperOf(aid) : null;
    if (known === null && S && typeof S.onPaper === 'boolean') known = S.onPaper;
    var out = {
      host: CANVAS ? location.origin : (S && S.host) || '',
      courseId: page ? page.courseId : (S && S.courseId) || '',
      assignmentId: aid,
      title: (page && page.title) || (S && S.title) || 'this assignment',
      onPaper: known
    };
    if (CANVAS) out.theme = canvasTheme();
    return out;
  }

  /* 点 Focus 先落在挑时长那一屏：三档快捷和自己填都住在这一屏，
     挑完才变成"一个圆圈加两颗键"那一屏 */
  function openPick() {
    var page = CANVAS ? assignmentOnPage() : null;
    var mine = !!(S && S.totalMs && page && String(S.assignmentId) === String(page.assignmentId));
    if (mine) {
      // 已经在跑自己这一条：× 收起过的那一趟重新展开，形态（悬浮／固定）照它收起来之前的样子
      save(Object.assign({}, S, { hidden: false, ask: '', note: '' }));
      return;
    }
    // 另一条作业上按下的那颗只管这一条作业：上一趟就此换掉，不做"你还有别的没跑完"那种追问
    var base = identity();
    base.sid = newSid();
    base.totalMs = 0;
    base.endAt = null;
    base.leftMs = 0;
    base.running = false;
    // 这一页站不住停靠那一格＝没得挑，直接进悬浮窗
    base.mode = (lastShape === 'float' || !dockable()) ? 'float' : 'docked';
    base.pin = (S && S.pin) || '';
    base.hidden = false;
    base.ask = '';
    base.note = '';
    save(base);
  }

  function start(minutes) {
    var m = Math.max(STEP_MIN, Math.min(STEP_MAX, Math.round(minutes)));
    stepMin = m;
    var ms = m * 60000;
    var next = Object.assign({}, S || {}, identity(), {
      sid: (S && S.sid) || newSid(),
      totalMs: ms,
      endAt: Date.now() + ms,
      leftMs: ms,
      running: true,
      mode: S && S.mode === 'float' ? 'float' : 'docked',
      hidden: false,
      ask: '',
      note: ''
    });
    if (!next.pin) next.pin = (S && S.pin) || '';
    save(next);
  }

  function togglePause() {
    if (!S || !S.totalMs) return;
    var left = remaining(S);
    if (S.running) save(Object.assign({}, S, { running: false, endAt: null, leftMs: left }));
    else save(Object.assign({}, S, { running: true, endAt: Date.now() + left, leftMs: left }));
  }

  /* 到点：纸面作业要问一句做完没，其余的直接收 */
  function expire() {
    if (!S) return;
    if (S.onPaper === true) {
      reveal();
      save(Object.assign({}, S, { running: false, endAt: null, leftMs: 0, ended: true, ask: 'finish' }));
      return;
    }
    endSession();
  }

  function finish() {
    if (!S) return;
    if (!S.totalMs) { endSession(); return; }
    if (S.onPaper === true) {
      var left = remaining(S);
      reveal();
      save(Object.assign({}, S, { running: false, endAt: null, leftMs: left, ended: true, ask: 'finish' }));
      return;
    }
    endSession();
  }

  function answerFinish(yes) {
    var s = S;
    if (!s) return;
    if (yes) requestTick(s);
    else endSession();
  }

  function requestTick(s) {
    if (CANVAS && window.MCxTickForFocus) {
      var fail = function () {
        if (S && S.sid === s.sid) {
          // 这一句还挂着 note，所以"问完就翻篇"那条规则会放过它：话得让人看见
          save(Object.assign({}, S, { ask: '', note: 'Could not mark it done. Tick it in the Hub if it is still on your list.' }));
        }
      };
      try {
        Promise.resolve(window.MCxTickForFocus(s.courseId, s.assignmentId, s.title)).then(function (r) {
          if (!r || !r.ok) fail();
          else endSession();
        }, fail);
      } catch (e) { fail(); }
      return;
    }
    // 不在 Canvas 这一头：只留这一笔账，画面当场收掉，等 Canvas 那一页来读
    var pending = Object.assign({}, s, {
      ask: '', pendingTick: true, running: false, endAt: null, leftMs: 0, hidden: true, sid: s.sid + '-tick'
    });
    S = pending;
    destroy('dock');
    destroy('float');
    stopTick();
    var o = {};
    o[SKEY] = pending;
    write(o);
  }

  function save(next) {
    /* 0:00 那一问没人答就翻篇：× 掉、搬上悬浮、解开固定，走的都是这一条。
       留着一张 00:00 的板子等于告诉人家"这一趟还没完"，它其实已经完了。
       那一笔等着 Canvas 补的勾（pendingTick）不算，它得留着 */
    if (next && !next.pendingTick && !next.note && next.ask !== 'finish' &&
        (next.ended || (!next.running && next.totalMs && !next.leftMs))) {
      endSession();
      return;
    }
    S = next;
    structKey = '__none__';
    var o = {};
    o[SKEY] = next;
    write(o);
    var m = next && next.mode;
    if ((m === 'docked' || m === 'float') && m !== lastShape) {
      lastShape = m;
      var h = {};
      h[HKEY] = m;
      write(h);
    }
    paint();
  }

  function endSession() {
    S = null;
    destroy('dock');
    destroy('float');
    stopTick();
    structKey = '__none__';
    erase(SKEY);
    // 会话结束后立即重画当前页面的空闲入口/独立卡片；只恢复标题键会让
    // Dashboard 上的 Focus 卡要等下一次外部巡检才出现。
    if (CANVAS) paint();
    syncButton();
  }

  function setPin(scope) {
    if (!S) return;
    var next = Object.assign({}, S, { ask: '', pin: scope });
    if (CANVAS) next.theme = canvasTheme() || S.theme;
    save(next);
    if (scope === 'all') broadcast();
    else unpinAllSites();
  }

  /* 已经开着的页面里没有我们那份脚本（它是在扩展重载之前打开的），
     光改存储它们不会动。请后台把这一份补投进去，替他省掉逐个刷新那一步 */
  function broadcast() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'mc_focus_broadcast' }, clearError);
      }
    } catch (e) {}
  }

  function unpinAllSites() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'mc_focus_unpin_all' }, clearError);
      }
    } catch (e) {}
  }

  function bindCard(el) {
    if (el.dataset.mcxBound) return;
    el.dataset.mcxBound = '1';
    bindFocusEntryClicks();
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act],[data-start],[data-step],[data-pin]') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.start) {
        var v = Number(b.dataset.start);
        if (!v || isNaN(v)) return;
        start(v);
        return;
      }
      if (b.dataset.step) {
        stepMin = Math.max(STEP_MIN, Math.min(STEP_MAX, curStep() + Number(b.dataset.step)));
        stepLabels();
        return;
      }
      if (b.dataset.pin) { setPin(b.dataset.pin); return; }
      var act = b.dataset.act;
      if (act === 'widget-settings') {
        openWidgetSettings();
        return;
      }
      if (act === 'expand' && window.MCxGrading && window.MCxGrading.close) window.MCxGrading.close();
      if (act === 'expand') {
        /* 点入口＝把这一趟请回这张卡里。它可能正在悬浮窗上跑着，也可能被 × 收起过，
           两种都回到"卡里展开的面板"，否则缩档条件还在，点一下等于没点 */
        if (S && CANVAS && isDashboardWidget(b)) {
          setDashDismissed(S, false);
          focusWidgetEntrance = true;
          save(Object.assign({}, S, { hidden: false, mode: 'docked' }));
        } else if (S) save(Object.assign({}, S, { hidden: false, mode: 'docked' }));
        else setDashOpen(true);   // 没在跑：点入口只是把这一格摊开，卡本身不动那颗开关
      } else if (act === 'gostep') start(curStep());
      else if (act === 'toggle') togglePause();
      else if (act === 'stop') finish();
      else if (act === 'yes') answerFinish(true);
      else if (act === 'no') answerFinish(false);
      else if (act === 'pin') {
        // 固定只管"跟不跟到别的页面去"，和悬浮那档是两颗互不越权的键：
        // 上一版把这两件事绑在一起，钉住以后那颗悬浮就再也按不动了
        if (!S) return;
        if (S.pin) save(Object.assign({}, S, { pin: '', ask: '', note: '' }));
        else save(Object.assign({}, S, { ask: S.ask === 'pin' ? '' : 'pin', note: '' }));
      } else if (act === 'float') {
        // 没开计时也能先搬成悬浮窗：搬过去的是"挑时长"那一屏
        if (!S) {
          openPick();
          if (S) save(Object.assign({}, S, { mode: 'float' }));
          return;
        }
        /* 这一页没有"停在 Hub 上方"那一档（整列右侧栏不存在）：想取消悬浮，
           就只能收起回那颗键。他拍的：这种页面点开就是强制悬浮窗 */
        if (S.mode === 'float' && !dockable()) {
          save(Object.assign({}, S, { ask: '', note: '', hidden: true }));
          return;
        }
        if (S.mode === 'float') {
          var sepMode = widgetLayout() === 'separate';
          if (sepMode && !S.totalMs && !S.running) {
            save(null);
          } else {
            save(Object.assign({}, S, { mode: 'docked', hidden: false, ask: '', note: '' }));
          }
          return;
        }
        save(Object.assign({}, S, { mode: 'float', ask: '', note: '' }));
      } else if (act === 'close') {
        var dashboardFloat = !!(CANVAS && focusLoc() !== 'off' && b.closest('.mcx-focus-float') && (wallHost() || wallHidden()));
        if (S && dashboardFloat) {
          /* 這顆是本 Dashboard 自己的悬浮窗：只在本标签页收起，其他页面照旧浮着。 */
          setDashFloatDismissed(S, true);
          return;
        }
        if (S && CANVAS && isDashboardWidget(b) && S.assignmentId && !homeHere() && !inScope()) {
          /* 这里展开的是 Dashboard 本地选择器；× 只收起这个选择器，
             不能把仍在 Assignment 运行的共享会话标成 Dashboard 已关闭。 */
          setDashOpen(false);
          return;
        }
        if (S && CANVAS && isDashboardWidget(b)) {
          /* Dashboard × 只收起本标签页的卡；作业页共享会话和悬浮窗继续运行。 */
          setDashDismissed(S, true);
          return;
        }
        if (!S) {
          /* × 在 Dashboard 上既不是删卡、也不是去拧设置里那颗开关
             （我上一版就是这么错的：一按整张卡从墙上消失＝他报"入口卡片怎么不见了"）。
             它做的是把这一格从"摊开的内容"缩回"只剩 Focus 入口"。
             没会话时手上只有两种画面：墙上那张卡、List view 那条横栏，两件事一样，不用分。 */
          setDashOpen(false);
          return;
        }
        var separate = focusLoc() !== 'combined';
        if (separate && S.mode === 'float') {
          // 未选组合卡时，悬浮窗 × 回到独立卡或 Hub 停靠位，不把会话留在隐身悬浮状态。
          if (!S.totalMs && !S.running) {
            save(null);
          } else {
            save(Object.assign({}, S, { mode: 'docked', hidden: false, ask: '', note: '' }));
          }
          return;
        }
        // × 只是藏起来，计时继续在后台跑；形态原样留着，那颗 Focus 回到标题上，点它还原
        save(Object.assign({}, S, { ask: '', note: '', hidden: true }));
      } else if (act === 'cancelask') {
        if (S) save(Object.assign({}, S, { ask: '', note: '' }));
      }
    }, true);
  }

  /* ==== 作业本身：是不是纸面、交没交 ==== */

  function onPaperOf(aid) {
    var hit = assignmentCache[String(aid)];
    return hit && typeof hit.onPaper === 'boolean' ? hit.onPaper : null;
  }

  function askApi(path) {
    try {
      return fetch(path, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function cacheHit(key) {
    if (!assignmentCache[key]) assignmentCache[key] = { at: 0 };
    return assignmentCache[key];
  }

  function loadAssignment(courseId, aid) {
    if (!CANVAS || !courseId || !aid) return;
    var key = String(aid);
    var hit = cacheHit(key);
    if (hit.at > Date.now() - 600000) return;
    hit.at = Date.now();
    askApi('/api/v1/courses/' + courseId + '/assignments/' + key).then(function (a) {
      if (!a || String(a.id) !== key) { hit.at = 0; return; }
      var types = Array.isArray(a.submission_types) ? a.submission_types : [];
      hit.onPaper = types.length > 0 && types.every(function (t) { return t === 'none' || t === 'on_paper'; });
      hit.title = a.name || '';
      if (S && String(S.assignmentId) === key) {
        var patch = {};
        if (typeof S.onPaper !== 'boolean') patch.onPaper = hit.onPaper;
        if (!S.title && hit.title) patch.title = hit.title;
        if (patch.onPaper !== undefined || patch.title) save(Object.assign({}, S, patch));
      }
    });
  }

  /* 交了就是这件事做完了，不再问"做完没"：那一问只留给纸面作业，
     那种作业 Canvas 永远不会替它算提交 */
  function pollSubmit() {
    if (!CANVAS || !S || !S.running || !S.assignmentId || !S.courseId) return;
    if (Date.now() - pollAt < SUBMIT_POLL) return;
    pollAt = Date.now();
    var cid = S.courseId, key = String(S.assignmentId), sid = S.sid;
    askApi('/api/v1/courses/' + cid + '/assignments/' + key + '/submissions/self').then(function (sub) {
      if (!sub || String(sub.assignment_id) !== key) return;
      cacheHit(key).submitted = !!sub.submitted_at;
      if (sub.submitted_at && S && S.sid === sid && S.running) endSession();
    });
  }

  /* ==== Canvas 页上的那颗键和那块面板 ==== */

  /* 我们那颗键就挂在这一行里面，它的文字"Focus"不能算进标题：
     不算掉的话下一趟就认不出这一行，会把键摘掉再挂上＝每 300 毫秒闪一次 */
  function titleText(el) {
    var t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (el.querySelector && el.querySelector('.mcx-focus-launch')) t = t.replace(/ ?Focus$/, '');
    return t;
  }

  /* 标题那一行归谁画。老那一屏有 h1.title；新版那一屏（测验套壳的 assignments 地址）
     抬头是 InstUI 的 Heading，类名带哈希、没有 h1，所以拿"整段文字正好等于作业名"来认，
     并且只取最深那一层＝标题自己。面包屑里那条同名的是链接，跳过 */
  function titleAnchor(name) {
    var h = null;
    try { h = document.querySelector('h1.title, #assignment_show h1, .assignment_header h1, #assignment_head'); } catch (e) {}
    if (h && h.parentNode) return { node: h, loose: false };
    var box = null;
    try {
      box = document.querySelector('[data-testid="assignments-2-student-view"]') || document.getElementById('content');
    } catch (e) {}
    var want = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return box && box.parentNode ? { node: box, loose: true } : null;
    var root = null;
    try {
      root = document.querySelector('[data-testid="assignments-2-student-view"]') || document.getElementById('content');
    } catch (e) {}
    if (!root) return null;
    var nodes = root.querySelectorAll('h1, h2, h3, h4, p, div, span');
    var deep = null;
    var head = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.tagName === 'A' || (el.closest && el.closest('a'))) continue;
      // 面包屑那条也是这一串字，但它里面是链接：标题那一行里面不该有链接
      if (el.querySelector('a')) continue;
      if (titleText(el).toLowerCase() !== want) continue;
      if (!deep || deep.contains(el)) deep = el;
      if (/^H[1-4]$/.test(el.tagName) && (!head || head.contains(el))) head = el;
    }
    if (head || deep) return { node: head || deep, loose: false };
    /* 一个都没认出来（标题那一行里混了别的字，文字对不上）：挂到这一屏最外面那一块的顶上。
       宁可位置糙一点，也不能让某一份作业干脆没有这颗键＝他报的"另一份就不显示" */
    return box && box.parentNode ? { node: box, loose: true } : null;
  }

  /* API 还没回名字时的第二个名字来源：面包屑最后一条就是这一份作业的名字。
     只拿它当"要找的那串字"，不当挂载点（它里面是链接） */
  function crumbName() {
    var items = [];
    try {
      items = document.querySelectorAll('#breadcrumbs li, [data-testid="breadcrumbs"] li');
    } catch (e) { return ''; }
    if (!items.length) return '';
    return String(items[items.length - 1].textContent || '').replace(/\s+/g, ' ').trim();
  }

  function assignmentOnPage() {
    var m = assignmentPath();
    if (!m) return null;
    var hit = assignmentCache[String(m.assignmentId)];
    var name = hit && hit.title ? String(hit.title) : crumbName();
    var a = titleAnchor(name);
    var node = a && a.node && a.node.parentNode ? a.node : null;
    return {
      courseId: m.courseId,
      assignmentId: m.assignmentId,
      node: node,
      // 挂到整块顶上那一档，键要排在那一块的最前面才看得见；挂在标题行里就排在文字后面
      prepend: !!(a && a.loose),
      title: (node && !a.loose ? titleText(node) : '') || name
    };
  }

  /* 那颗键和那块面板互斥：面板在屏幕上（哪一格都一样）键就不摆。
     挂在 paint() 尾巴上，因为"面板在不在"只有那一趟算得准 */
  function syncButton() {
    if (!CANVAS) return;
    var page = assignmentOnPage();
    var el = document.getElementById('mcx-focus-btn');
    var show = switchOn() && !!page && !!page.node && !!page.node.parentNode
      && !surfaces.dock && !surfaces.float && !surfaces.card;
    if (!show) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'mcx-focus-btn';
      el.className = 'mcx-focus-launch';
      /* 字还是那三个字：认标题行靠的是"整段文字等于作业名"，那颗键的文字要能照原样扣掉 */
      el.innerHTML = svg(IC.alarm) + '<span>Focus</span>';
      el.dataset.mcxBound = '1';
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var p = assignmentOnPage();
        if (p) loadAssignment(p.courseId, p.assignmentId);
        openPick();
      });
    }
    /* 挂到了哪一行我在他页面上看不见，让它自己报一次：每份作业加载后只说一遍 */
    if (!anchorLogged) {
      anchorLogged = true;
      console.log('[MCX focus]', {
        url: location.pathname,
        landedOn: String(page.node.className || page.node.tagName || '').slice(0, 56),
        atTop: !!page.prepend,
        name: String(page.title || '').slice(0, 48)
      });
    }
    if (el.parentNode !== page.node) page.node.insertBefore(el, page.prepend ? page.node.firstChild : null);
    else if (page.prepend && page.node.firstChild !== el) page.node.insertBefore(el, page.node.firstChild);
    else if (!page.prepend && page.node.lastChild !== el) page.node.appendChild(el);
  }

  function canvasPass() {
    if (!CANVAS) return;
    resetDashboardToWidgetList(S);
    var next = presetList();
    if (next.join(',') !== presets.join(',')) { presets = next; structKey = '__none__'; }
    var page = assignmentOnPage();
    if (page && switchOn()) loadAssignment(page.courseId, page.assignmentId);
    paint();
  }

  /* ==== 跨页同步 ==== */

  function adopt(next) {
    if (!next || typeof next !== 'object') {
      S = null;
      destroy('dock');
      destroy('float');
      stopTick();
      structKey = '__none__';
      if (CANVAS) paint();
      return;
    }
    S = next;
    structKey = '__none__';
    if (S.pendingTick) {
      if (!CANVAS || !window.MCxTickForFocus) { paint(); return; }
      window.MCxTickForFocus(S.courseId, S.assignmentId, S.title);
      endSession();
      return;
    }
    if (S.running && S.endAt && S.endAt - Date.now() <= 0) { paint(); expire(); return; }
    paint();
  }

  function boot() {
    read([SKEY, GKEY, HKEY], function (got) {
      loaded = true;
      presets = presetList();
      var g = got && got[GKEY];
      geo = (g && typeof g.x === 'number') ? g : null;
      var hs = got && got[HKEY];
      if (hs === 'float' || hs === 'docked') lastShape = hs;
      var st = got && got[SKEY];
      if (st && typeof st === 'object' && !st.pendingTick &&
          (st.ended || (!st.running && st.totalMs && !st.leftMs))) {
        // 上一趟跑到 0:00，那句"做完没"没人答就切了页、关了标签：这一趟当它已经结束，
        // 下次点 Focus 是全新的一趟，不是掀开一张 00:00 的旧板子
        erase(SKEY);
        if (CANVAS) canvasPass();
      } else if (st && typeof st === 'object') {
        resetDashboardToWidgetList(st);
        S = st;
        if (CANVAS && st.assignmentId && !st.pendingTick) loadAssignment(st.courseId, st.assignmentId);
        adopt(st);
      } else if (CANVAS) {
        canvasPass();
      }
    });
    try {
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local') return;
          if (changes[SKEY]) { adopt(changes[SKEY].newValue); return; }
          if (changes[GKEY] && changes[GKEY].newValue) {
            /* 这一格必须先收下来，不管这一页此刻有没有悬浮卡。
               上一版只在"有卡"的时候才更新，于是没开着卡的那些页面永远停在旧读数＝
               他报的"不同网页显示大小居然不一样"（同一份档，有的 248 有的 300）*/
            geo = changes[GKEY].newValue;
            if (surfaces.float) placeFloat(surfaces.float);
          }
          if (changes[HKEY] && typeof changes[HKEY].newValue === 'string') {
            lastShape = changes[HKEY].newValue;
          }
        });
      }
    } catch (e) {}
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        if (S && S.running) onTick();
      });
    } catch (e) {}
  }

  window.MCxFocus = {
    isWallDragging: function () { return wallDragSource; },
    canvasPass: canvasPass,
    state: function () { return S; },
    loaded: function () { return loaded; },
    presets: function () { return presets.slice(); },
    wallHost: wallHost,
    bindWallDrag: bindWallDrag,
    paintCover: paintCover,
    widgetSettingsButtonHtml: widgetSettingsButtonHtml,
    bindWidgetSettingsCard: bindWidgetSettingsCard,
    relayoutWall: relayoutWall
  };

  boot();
})();
