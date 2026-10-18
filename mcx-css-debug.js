/* 答题屏换皮分档调试面板（2026-10-12）
   为什么要有这一份：style.css 是 user 层样式表，页面的 document.styleSheets 里根本没有它，
   所以控制台/CSSOM 一行都关不掉我们那几节规则。要一档一档关，只能把每一档做成
   html 上的一颗类名，面板改类名＝当场生效。落点见 style.css 里那 49 个
   :where(html:not(.mcx-off-NN)) 门（第 52/52b/53/54 节）。
   第二半（同一轮加的）：CSS 全关掉还不卡的话，代价就在我们挂的观察器/定时器/监听上。
   这份脚本和 content.js、theme-boot.js 跑在同一个扩展世界里，所以在它最前面把
   MutationObserver.prototype.observe、setInterval、addEventListener 包一层，
   就能把后面每个文件挂上来的东西逐个登记、逐个掐掉。站点自己的脚本在另一个世界，
   读不到我们这层的包装，一行都不受影响。
   manifest 里这份必须排在那三份脚本前面，不然 theme-boot.js 的观察器已经挂完了。
   这颗开关只影响我们画的东西：不碰 Canvas 的自动保存，刷新即全部回来。 */
(function () {
  'use strict';

  // 非 Canvas 站点直接退出，绝不包装任何原生 API
  if (typeof window.mcIsCanvas === 'undefined') {
    var h = window.location.hostname.toLowerCase();
    var isAuto = (h === 'instructure.com' || h.endsWith('.instructure.com') ||
                  h === 'canvas.net' || h.endsWith('.canvaslms.com') ||
                  h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
    var customStr = '';
    try { customStr = localStorage.getItem('mc_custom_domains_cache') || ''; } catch (e) {}
    window.mcIsCanvas = isAuto || (customStr && customStr.indexOf(h) !== -1);
  }

  // 检查是否处于一键暂停优化状态 (Pause Modern Canvas)
  var mcPausedUntil = '';
  try { mcPausedUntil = localStorage.getItem('mc_paused_until') || ''; } catch (e) {}
  if (mcPausedUntil) {
    if (mcPausedUntil === '-1') {
      window.mcIsCanvas = false;
      document.documentElement.classList.add('mc-paused');
      return;
    }
    if (mcPausedUntil === 'reload') {
      try { localStorage.removeItem('mc_paused_until'); } catch (e) {}
      try { chrome.storage.local.remove('mc_paused_until'); } catch (e) {}
      window.mcIsCanvas = false;
      document.documentElement.classList.add('mc-paused');
      return;
    }
    var numUntil = Number(mcPausedUntil);
    if (numUntil && Date.now() < numUntil) {
      window.mcIsCanvas = false;
      document.documentElement.classList.add('mc-paused');
      return;
    }
    try { localStorage.removeItem('mc_paused_until'); } catch (e) {}
    try { chrome.storage.local.remove('mc_paused_until'); } catch (e) {}
  } else {
    // 跨域标签页异步同步全局暂停状态，绝不能在此处 remove('mc_paused_until')
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('mc_paused_until', function (res) {
        if (res && res.mc_paused_until) {
          var p = res.mc_paused_until;
          if (p === '-1' || p === 'reload' || (Number(p) && Date.now() < Number(p))) {
            try { localStorage.setItem('mc_paused_until', p); } catch (e) {}
            document.documentElement.classList.add('mc-paused');
          }
        }
      });
    }
  }

  if (!window.mcIsCanvas) return;

  var LS = 'mcx_css_dbg';
  var LSJS = 'mcx_js_dbg';
  var root = document.documentElement;
  var SELF = 'mcx-css-debug.js';

  /* ============ JS 闸门：按文件登记每一颗挂载 ============ */
  var FILES = {};
  var jsBlocked = {};
  try { jsBlocked = JSON.parse(localStorage.getItem(LSJS) || '{}') || {}; } catch (e) { jsBlocked = {}; }

  function caller() {
    var st = (new Error()).stack || '';
    var lines = st.split('\n');
    for (var i = 0; i < lines.length; i++) {
      /* 这一层只有我们自己的脚本会走到，所以栈里第一颗 .js 就是我们的文件。
         写宽一点（不认 chrome-extension:// 前缀）是为了本地那张测试页也能跑同一条路 */
      var m = /\/([\w.-]+\.js):(\d+)/.exec(lines[i]);
      if (m && m[1] !== SELF) return { file: m[1], line: m[2] };
    }
    return { file: '?', line: '?' };
  }

  function note(kind, at) {
    var f = FILES[at.file];
    if (!f) {
      f = FILES[at.file] = { file: at.file, observe: 0, interval: 0, listen: 0 };
      if (onFire) onFire();
    }
    f[kind]++;
  }

  var onFire = null;

  function wrap(fn, kind) {
    return function () {
      var at = caller();
      if (at.file === '?') return fn.apply(this, arguments);
      note(kind, at);
      if (jsBlocked[at.file]) return undefined;
      return fn.apply(this, arguments);
    };
  }

  var rawObserve = MutationObserver.prototype.observe;
  var rawSetInterval = window.setInterval;
  var rawDocAdd = document.addEventListener;

  /* 站点自己的脚本在另一个世界，读不到这层的包装，只登记得到我们自己的文件。
     闸门只在这扇面板要出现的那一趟装，别的地方一行都不包 */
  if (wantsPanel()) {
    MutationObserver.prototype.observe = wrap(rawObserve, 'observe');
    window.setInterval = wrap(rawSetInterval, 'interval');
    document.addEventListener = wrap(rawDocAdd, 'listen');
  }

  /* 每一档：off 时怎么把它关掉，on 时怎么还原 */
  var LAYERS = [
    { id: '52', title: '52 答题屏整屏换皮（卡、工具条、题号栏；菜单在共用的第 56 节，不归这档管）', gate: 'mcx-off-52' },
    { id: '52b', title: '52b 起飞态（Resume 主卡、Prev/Next、提示框）', gate: 'mcx-off-52b' },
    { id: '53', title: '53 打字区退回系统字体（全站打字框都吃这条）', gate: 'mcx-off-53' },
    { id: '54', title: '54 三处细节（Submit 横线、题号竖线、写作区圆角）', gate: 'mcx-off-54' },
    { id: '58', title: '58 测验结果那一屏（主卡、判分表、题块分隔线、分数环）', gate: 'mcx-off-58' },

    { id: 'themed', title: '主题配色总闸 mc-themed（所有吃主题档的颜色）', take: 'mc-themed' },
    { id: 'frost', title: '磨砂 mc-frost（backdrop-filter 那一批）', take: 'mc-frost' },
    { id: 'ring', title: '焦点环 mc-hover-ring', take: 'mc-hover-ring' },
    { id: 'select', title: '下拉胶囊 mc-select-plate', take: 'mc-select-plate' },
    { id: 'link', title: '链接吃强调色 mc-link-accent', take: 'mc-link-accent' },
    { id: 'lti', title: '外部工具那一屏 tint mc-lti-tint', take: 'mc-lti-tint' },
    { id: 'quizzes', title: '测验列表那一节 mc-quizzes-plate', take: 'mc-quizzes-plate' },
    { id: 'assign', title: '作业列表那一节 mc-assignments-plate', take: 'mc-assignments-plate' },
    { id: 'subs', title: '提交详情那一节 mc-submissions-plate', take: 'mc-submissions-plate' },

    { id: 'sheet', title: '主题表 #mc-theme-sheet（129 条，含铺满整页那条字体族）', sheet: '#mc-theme-sheet' },
    { id: 'guard', title: '首帧底色表 #mc-boot-bg-guard', sheet: '#mc-boot-bg-guard' },
    { id: 'vars', title: '根变量表 style[data-bcx-sheet="vars"]', sheet: 'style[data-bcx-sheet="vars"]' },
    { id: 'font', title: '主题字体 link[data-bcx-sheet^="font"]（Google Fonts）', sheet: 'link[data-bcx-sheet^="font"]' },
    { id: 'bc', title: 'BetterCampus 自己那三张表', sheet: 'style[id^="bettercampus"],style[id^="bettercanvas"],style#darkcss' },

    { id: 'plate', title: '我们补在控件上的板子类名 mc-plate-select', unclass: 'mc-plate-select' },
    { id: 'theater', title: '写作框上那颗 EXPAND #canvas-inline-theater-btn', hide: '#canvas-inline-theater-btn' }
  ];

  var state = {};
  try { state = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { state = {}; }

  /* 面板没管过的档＝开着的（美化生效）。
     [实测 2026-10-13 讨论区话题页] 原来这里是在脚本自己跑的那一刻抄一笔"html 上原来有没有这颗类名"，
     再照着它还原。可这份脚本在 manifest 里排在 theme-boot.js 前面（为了包 MutationObserver），
     那一刻 html 上一个类名都还没有，于是 boot 挂的那几颗（mc-select-plate、mc-assignments-plate、
     mc-quizzes-plate、mc-submissions-plate）全被记成"原本就没有"，DOMContentLoaded 那一趟 apply()
     当场把它们摘了＝四节换皮在每一页静默失效，而面板里那四档明明都显示"开"。
     同时挂在 content.js 里的那几颗（mc-themed、mc-frost、mc-hover-ring、mc-link-accent、
     mc-lti-tint）因为 document_idle 又补了一次，才活下来——这就是"只有四颗不见"的全部成因。
     改法：不再照"原来在不在"还原，只还原我们自己摘掉的那几颗。 */
  var taken = {};
  function on(L) { return state[L.id] !== 0; }

  function apply() {
    LAYERS.forEach(function (L) {
      var live = on(L);
      if (L.gate) root.classList.toggle(L.gate, !live);
      if (L.take) {
        // 关：摘掉并记一笔；开：只把我们自己摘掉的那颗放回去，boot 新挂的一律不碰
        if (!live) { if (root.classList.contains(L.take)) { root.classList.remove(L.take); taken[L.id] = true; } }
        else if (taken[L.id]) { root.classList.add(L.take); taken[L.id] = false; }
      }
      if (L.sheet) {
        document.querySelectorAll(L.sheet).forEach(function (n) {
          if (n.sheet) n.sheet.disabled = !live;
          else if (!live && n.parentNode) n.parentNode.removeChild(n);
        });
      }
      if (L.unclass) document.querySelectorAll('.' + L.unclass).forEach(function (n) { n.classList.toggle(L.unclass, live); });
      if (L.hide) document.querySelectorAll(L.hide).forEach(function (n) { n.style.display = live ? '' : 'none'; });
    });
  }

  function save() { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) {} }

  /* 面板只在答题/起飞那一屏自己冒出来，别的地方要显式开 */
  function wantsPanel() {
    if (localStorage.getItem('mcx_css_debug') === '0') return false;
    if (localStorage.getItem('mcx_css_debug') === '1') return true;
    return /\/(taking|launch)\/|\/take(_quiz)?(\/|$)/i.test(location.pathname);
  }

  function box(live) {
    var b = document.createElement('span');
    b.style.cssText = 'display:inline-block;width:30px;height:16px;border-radius:9px;vertical-align:middle;flex:none;' +
      'background:' + (live ? '#2b7abc' : 'rgba(255,255,255,.28)') + ';position:relative';
    var d = document.createElement('span');
    d.style.cssText = 'position:absolute;top:2px;left:' + (live ? '16px' : '2px') +
      ';width:12px;height:12px;border-radius:50%;background:#fff';
    b.appendChild(d);
    return b;
  }

  function build() {
    apply();

    var p = document.createElement('div');
    p.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483600;width:392px;max-height:72vh;' +
      'overflow:auto;background:#1c1f22;color:#f3f4f5;font:13px/1.5 system-ui,sans-serif;' +
      'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:0 0 10px';

    var head = document.createElement('div');
    head.style.cssText = 'position:sticky;top:0;background:#1c1f22;padding:12px 14px 8px;font-weight:600';
    head.textContent = '答题屏换皮分档';
    p.appendChild(head);

    function mkBtn(text, fn) {
      var b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'flex:1;font:inherit;font-weight:400;color:#f3f4f5;cursor:pointer;border-radius:9px;' +
        'padding:7px 8px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16)';
      b.addEventListener('click', fn);
      return b;
    }

    function mkGroup(title) {
      var g = document.createElement('div');
      g.style.cssText = 'padding:12px 14px 4px;color:rgba(243,244,245,.55);font-size:12px;font-weight:600';
      g.textContent = title;
      p.appendChild(g);
      return g;
    }

    function mkRow(title, live, click) {
      var line = document.createElement('div');
      line.style.cssText = 'display:flex;gap:10px;align-items:center;padding:7px 14px;cursor:pointer';
      var t = document.createElement('span');
      t.textContent = title;
      t.style.cssText = 'flex:1';
      var slot = document.createElement('span');
      slot.style.cssText = 'flex:none';
      slot.appendChild(box(live));
      line.appendChild(t);
      line.appendChild(slot);
      line.addEventListener('click', click);
      return { line: line, slot: slot };
    }

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:10px 14px';
    p.appendChild(bar);

    var slots = [];
    var jsBox = document.createElement('div');

    function render() {
      slots.forEach(function (s) { s.el.replaceChildren(box(on(s.L))); });
    }

    function jsTitle(f) {
      var bits = [];
      if (f.observe) bits.push('观察器 ' + f.observe);
      if (f.interval) bits.push('定时器 ' + f.interval);
      if (f.listen) bits.push('监听 ' + f.listen);
      return f.file + ' — ' + bits.join(' · ');
    }

    function renderJs() {
      jsBox.replaceChildren();
      Object.keys(FILES).sort().forEach(function (name) {
        var f = FILES[name];
        var r = mkRow(jsTitle(f), !jsBlocked[name], function () {
          if (jsBlocked[name]) delete jsBlocked[name];
          else jsBlocked[name] = 1;
          saveJs();
          renderJs();
        });
        jsBox.appendChild(r.line);
      });
      if (!Object.keys(FILES).length) {
        var e = document.createElement('div');
        e.style.cssText = 'padding:7px 14px;color:rgba(243,244,245,.5)';
        e.textContent = '还没有登记到挂载';
        jsBox.appendChild(e);
      }
    }

    function saveJs() { try { localStorage.setItem(LSJS, JSON.stringify(jsBlocked)); } catch (e) {} }
    onFire = renderJs;

    function wireAll() {
      bar.replaceChildren(
        mkBtn('全部关', function () {
          LAYERS.forEach(function (L) { state[L.id] = 0; });
          Object.keys(FILES).forEach(function (n) { jsBlocked[n] = 1; });
          save(); saveJs(); apply(); render(); renderJs();
        }),
        mkBtn('全部开', function () {
          LAYERS.forEach(function (L) { state[L.id] = 1; });
          jsBlocked = {};
          save(); saveJs(); apply(); render(); renderJs();
        }),
        mkBtn('收起', function () {
          localStorage.setItem('mcx_css_debug', '0');
          LAYERS.forEach(function (L) { delete state[L.id]; });
          jsBlocked = {};
          save(); saveJs(); apply(); p.remove();
        })
      );
    }

    mkGroup('CSS：这一屏的换皮');
    LAYERS.slice(0, 4).forEach(function (L) {
      var r = mkRow(L.title, on(L), function () { state[L.id] = on(L) ? 0 : 1; save(); apply(); render(); });
      p.appendChild(r.line);
      slots.push({ L: L, el: r.slot });
    });
    mkGroup('CSS：全站总闸和主题表');
    LAYERS.slice(4).forEach(function (L) {
      var r = mkRow(L.title, on(L), function () { state[L.id] = on(L) ? 0 : 1; save(); apply(); render(); });
      p.appendChild(r.line);
      slots.push({ L: L, el: r.slot });
    });
    mkGroup('JS：我们挂上来的观察器、定时器、监听（掐一颗要刷新一次才生效）');
    p.appendChild(jsBox);

    var note = document.createElement('div');
    note.style.cssText = 'padding:8px 14px 0;color:rgba(243,244,245,.6);font-size:12px';
    note.textContent = 'CSS 那一半点一下就当场生效。JS 那一半是"这份脚本以后挂的东西一律不受理"，点完要刷新一次。';
    p.appendChild(note);

    wireAll();
    render();
    renderJs();

    /* content.js 和 theme-boot.js 会自己补 mc-themed / mc-frost 这些类名，
       它们补完我们这一档就被顶回去了。盯住 html 的 class，只在我们管的那几颗上补刀 */
    var busy = false;
    new MutationObserver(function () {
      if (busy) return;
      busy = true;
      requestAnimationFrame(function () { busy = false; apply(); render(); });
    }).observe(root, { attributes: true, attributeFilter: ['class'] });

    /* 主题表那几颗节点 content.js 到 document_idle 才刷，它可能重造一份，
       所以它跑完之后再补一次；只补三趟，不留长期轮询 */
    [400, 1200, 3000].forEach(function (ms) { window.setTimeout(apply, ms); });

    if (document.body) document.body.appendChild(p);
    else rawDocAdd.call(document, 'DOMContentLoaded', function () { document.body.appendChild(p); });
  }

  if (wantsPanel()) build();
  else {
    /* 面板收起来的时候，之前关掉的档还要继续生效，否则一刷新就全回来了 */
    if (document.readyState === 'loading') rawDocAdd.call(document, 'DOMContentLoaded', apply);
    else apply();
  }
})();
