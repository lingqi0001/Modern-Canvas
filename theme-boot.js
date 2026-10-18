// 防闪：在 document_start 就把留存下来的主题刷上去。
// 这个脚本必须独立于 content.js（那份是 document_idle，等它跑完用户已经看见一帧原生皮肤）。
(function () {
  // 非 Canvas 站点直接退出，不执行任何样式修改与拦截
  if (typeof window.mcIsCanvas === 'undefined') {
    var h = window.location.hostname.toLowerCase();
    var isAuto = (h === 'instructure.com' || h.endsWith('.instructure.com') ||
                  h === 'canvas.net' || h.endsWith('.canvaslms.com') ||
                  h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
    var customStr = '';
    try { customStr = localStorage.getItem('mc_custom_domains_cache') || ''; } catch (e) {}
    window.mcIsCanvas = isAuto || (customStr && customStr.indexOf(h) !== -1);
  }
  if (!window.mcIsCanvas) return;

  var mcPausedUntil = '';
  try { mcPausedUntil = localStorage.getItem('mc_paused_until') || ''; } catch (e) {}
  if (mcPausedUntil) {
    if (mcPausedUntil === 'reload') {
      window.mcIsCanvas = false;
      document.documentElement.classList.add('mc-paused');
      // "Until switch / reload" 生效于本次加载；清理存储以使下次刷新或切换页面自动恢复
      try { localStorage.removeItem('mc_paused_until'); } catch (e) {}
      try { chrome.storage.local.remove('mc_paused_until'); } catch (e) {}
      return;
    }
    if (mcPausedUntil === '-1') {
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
    // 异步同步（处理跨域/新开标签页）：若全局已暂停，补写本域缓存，绝不能反向删除全局存储
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['mc_paused_until'], function (res) {
          var val = res && res.mc_paused_until;
          if (val) {
            var n = Number(val);
            if (val === -1 || val === '-1' || (n && Date.now() < n)) {
              try { localStorage.setItem('mc_paused_until', String(val)); } catch (e) {}
            }
          }
        });
      }
    } catch (e) {}
  }

  // 挂上 Canvas 激活门禁类名，style.css 专属样式才生效
  document.documentElement.classList.add('mcx-canvas-active');

  // Widget Cards 是新版本的默认 Dashboard 体验。显式初始化缺失/无效的设置值，
  // 让新安装和升级后尚无此键的用户都开启；只保留用户明确存下的 '0' 关闭选择。
  try {
    var widgetCardsPref = localStorage.getItem('mc_dash_focus_card');
    if (widgetCardsPref !== '0' && widgetCardsPref !== '1') {
      localStorage.setItem('mc_dash_focus_card', '1');
    }
  } catch (e) {}

  /* Dashboard 首屏的课程卡墙先由 Canvas 绘制，Focus / Grades 虚拟卡则要等 document_idle
     和 Focus 的异步状态读完才插入，期间 Masonry 会先按不完整的卡片列表排一遍。
     在最早的脚本阶段暂时隐去卡片墙，等 content.js 与 Focus 都完成首轮同步后一次揭开，
     避免用户看到原生课程卡先占位、独立卡再插入并推动整面墙的跳动。隐藏只作用于可识别的
     旧版 Dashboard 卡墙；设置为关闭／List view／新版 Dashboard 的其它布局不受影响。 */
  (function () {
    var path = window.location.pathname;
    var isDashboard = path === '/' || /\/dashboard(?:\/|$)/i.test(path) || /^\/courses\/?$/i.test(path);
    if (!isDashboard) return;
    // 不会挂载任何虚拟 Widget 时完全不设门闩。特别是总开关关闭时，
    // wallHost 必然拒绝 Focus/Grades 卡片；若仍等待它们，课程墙只能等兜底超时才出现。
    try {
      if (localStorage.getItem('mc_dash_focus_card') === '0') return;
      function widgetEnabled(locKey, enabledKey) {
        var loc = localStorage.getItem(locKey);
        if (loc === 'off') return false;
        if (loc === 'combined' || loc === 'separate') return true;
        return localStorage.getItem(enabledKey) !== '0';
      }
      if (!widgetEnabled('mc_dash_widget_focus_loc', 'mc_dash_widget_focus') &&
          !widgetEnabled('mc_dash_widget_grades_loc', 'mc_dash_widget_grades')) return;
    } catch (e) {}
    var root = document.documentElement;
    var settled = false;
    var startedAt = Date.now();
    root.classList.add('mcx-dashboard-cards-pending');
    function release() {
      if (settled) return;
      settled = true;
      root.classList.remove('mcx-dashboard-cards-pending');
      try { observer.disconnect(); } catch (e) {}
    }
    var observer;
    try {
      observer = new MutationObserver(function () {
        if (document.querySelector('[data-testid="customize-dashboard-button"], button[aria-label*="old dashboard" i], a[href*="old_dashboard" i]')) {
          release();
          return;
        }
        var buttons = document.querySelectorAll('button, a');
        for (var i = 0; i < buttons.length; i++) {
          if (/switch to old dashboard/i.test(buttons[i].textContent || '')) { release(); return; }
        }
        if (Date.now() - startedAt > 7000) release();
      });
      observer.observe(root, { childList: true, subtree: true });
    } catch (e) {}
    // A script error or unsupported Dashboard must never leave the page hidden.
    window.setTimeout(release, 7000);
    window.__mcxReleaseDashboardCards = release;
  })();

  /* ===== 颜色档位（存档）=====
     和 content.js 那一节同名同算法，两边算出来必须同一格存档，否则首帧贴一份、
     半秒后 content.js 换成另一份＝他说的"每次重载变色一次"。改动必须两边一起做。
     四档：Canvas 自己的色（我们一行都不刷）、存档一、存档二、存档三。 */
  var TIER_KEY = 'bc_colour_tier';
  var SAVE_KEYS = ['mc_save_1', 'mc_save_2', 'mc_save_3'];
  var LEGACY_SAVE_KEYS = ['bcx_save_1', 'bcx_save_2', 'bcx_save_3'];
  // 旧的两份键（镜像键、应用键）只在这里读一次做迁移，删不得：
  // 别的标签页里没重载的旧版脚本还在写它们
  var KEY = 'mc_theme_snapshot_v3';
  var APPLIED_KEY = 'mc_applied_theme_v1';
  var LEGACY_SNAPSHOT_KEYS = ['bcx_applied_theme_v1', 'bcx_theme_snapshot_v3'];

  // 读取本地存档：优先读 mc_save_*，若为空自动回落读 bcx_save_* 并做幂等迁移
  function getThemeSave(index) {
    var val = localStorage.getItem(SAVE_KEYS[index]);
    if (val) return val;
    var oldVal = localStorage.getItem(LEGACY_SAVE_KEYS[index]);
    if (oldVal) {
      try { localStorage.setItem(SAVE_KEYS[index], oldVal); } catch (e) {}
      return oldVal;
    }
    return null;
  }

  function tierInit() {
    var saved = localStorage.getItem(TIER_KEY);
    if (saved === 'canvas' || saved === '1' || saved === '2' || saved === '3') return saved;
    var hasTheme = !!getThemeSave(0);
    if (!hasTheme) {
      var legacy = localStorage.getItem(APPLIED_KEY) || localStorage.getItem(KEY) ||
                   localStorage.getItem(LEGACY_SNAPSHOT_KEYS[0]) || localStorage.getItem(LEGACY_SNAPSHOT_KEYS[1]);
      if (legacy) {
        try { localStorage.setItem(SAVE_KEYS[0], legacy); } catch (e) {}
        hasTheme = true;
      }
    }
    var keep = localStorage.getItem('mc_keep_theme');
    if (keep === null) keep = localStorage.getItem('bcx_keep_theme');
    var tier = keep === '0' || !hasTheme ? 'canvas' : '1';
    try { localStorage.setItem(TIER_KEY, tier); } catch (e) {}
    return tier;
  }

  function tierSlot() {
    var t = tierInit();
    return t === 'canvas' ? 1 : Number(t);
  }

  function saveKey() {
    return SAVE_KEYS[tierSlot() - 1];
  }

  /* 【测试阶段，禁止删除】和 content.js 里那个同名常量是一对，两边都为 false 才算停用。
     贴回 External Extension 主题表原文这条通路已经停用：首帧只刷参数（根变量、字体、
     我们自己从参数编译出的 themeCss）。下面那行 forEach 是留着回退用的路径，
     现在跑不到属于预期状态，用户明确说"贴表机制可以删了"之前不要动它，
     也不要因为它"没效果"就顺手清理掉。要恢复：改成 true（content.js 里那个也要一起改）。 */
  var BCX_PASTE_SHEETS = false;

  var DISPLAY_GROUPS = {
    // Ring Style 是进度指示器的形状，不是卡片左侧色条；这两张表要和 content.js 的 MODERN_SETTINGS 保持一致
    ring_style: { def: 'bar', options: ['bar', 'circle', 'rainbow'] },
    rings_for: { def: 'all', options: ['all', 'active'] },
    date_format: { def: 'absolute', options: ['absolute', 'relative'] },
    grouping: { def: 'on', options: ['on', 'off'] },
    card_layout: { def: 'masonry', options: ['masonry', 'rows'] },
    // 和 content.js 的 MODERN_SETTINGS 同名同一份档（def 也要一起改）；首帧挂类名，设置里改完由那边重算
    course_colour: { def: 'accent', options: ['course', 'accent'] },
    // 卡片分数那一格归谁。和 content.js 那张表同名同 def
    dash_grade_owner: { def: 'ours', options: ['ours', 'bc'] },
    timeframe: { def: 'month', options: ['week', 'month', 'quarter'] },
    week_start: { def: 'rolling', options: ['rolling', 'sunday', 'monday'] },
    // Canvas colours 那一档的深浅色。和 content.js 的 MODERN_SETTINGS 同名同一份档
    colour_mode: { def: 'light', options: ['light', 'dark'] }
  };

  // 模块列表那两趟收放动画（首屏＋Expand／Collapse All）不在这里：那份归 jQuery 管，
  // 只有页面自己的世界读得到它的 jQuery，落点见 modules-fx-guard.js（manifest 里 MAIN world）

  function applyDisplayClasses() {
    var root = document.documentElement;
    var read = function (key) {
      var val = localStorage.getItem(key);
      if (val !== null) return val;
      if (key && key.indexOf('mc_') === 0) {
        return localStorage.getItem('bcx_' + key.slice(3));
      }
      return null;
    };
    root.classList.toggle('bc-hide-feedback-logo', read('bc_keep_feedback_logo') !== '1');
    root.classList.toggle('bc-hide-nav-logo', read('bc_keep_nav_logo') !== '1');
    root.classList.toggle('bc-hide-footer', read('bc_keep_footer') !== '1');
    root.classList.toggle('bc-hide-course-rail', read('bc_show_course_rail') !== '1');
    // 日历那三档（圆角、今天那格的 Accent 描边）以前各有一颗设置开关，2026-10-11 一起删掉＝常开：
    // 首帧就得挂上，晚一帧进页面会先看到一帧直角／一块灰底再翻，那正是这颗类名要解决的问题
    root.classList.add('mc-cal-round');
    /* [BCX calendar page] "这是日历页"的判据换成地址，不再借 content.js 补的 .bc-cal-views。
       那一颗是 document_idle 之后、再等 300 毫秒合并才挂上的，而 theme-calendar.css 圆角整节
       挂在 :has(.bc-cal-views) 上＝进页面先看到一帧直角原生卡，才翻成我们的圆角。
       地址在 document_start 就读得到，比任何 DOM 都早；/courses/123/calendar 也算，
       /calendar_events、/calendar_day 这种不算（要求 calendar 后面就是结尾或斜杠） */
    root.classList.toggle('mc-cal-page', /\/calendar(\/|$)/.test(window.location.pathname));
    // "今天"那一格改用 Accent 描边、并回格子底色（落点 theme-calendar.css 第 11 节）。常开
    root.classList.add('mc-cal-today-ring');
    root.classList.toggle('mc-hover-ring', read('mc_hover_ring') !== '0');
    // 侧栏图上那层磨砂：默认关，所以只有存过 '1' 才挂类名（首帧不挂就不会闪一下再糊）。
    // 落点见 style.css 第 41 节，content.js 的 applyLogoSettings 里是同一句判据
    root.classList.toggle('mc-nav-blur', read('mc_nav_blur') === '1');
    root.classList.toggle('mc-link-accent', read('mc_link_accent') !== '0');
    // 侧栏收起态也要在首帧之前定下来，否则刷新时先闪一帧 200px 宽栏再收到 74px。
    // content.js 那份 setNavMinimized 读到同一个键，算出同一个类名
    root.classList.toggle('mc-nav-min', read('mc_nav_min') === '1');
    root.classList.toggle('mc-lti-tint', read('mc_lti_tint') !== '0');
    root.classList.toggle('mc-lti-notint', read('mc_lti_tint') === '0');
    // InstUI 自己画的那几颗下拉（SimpleSelect）换成我们那颗胶囊，落点见 style.css 的 .mc-plate-select
    root.classList.add('mc-select-plate');
    const isCal = /\/calendar(\/|$)/.test(window.location.pathname);
    // 日历页面不需要这些大页的板子类名，挂在 html 上会导致几十条带 :has() 的规则在日历插入 60 个事件时被疯狂遍历
    if (!isCal) {
      root.classList.add('mc-assignments-plate');
      root.classList.add('mc-syllabus-plate');
      root.classList.add('mc-announcements-plate');
      root.classList.add('mc-course-home-plate');
      root.classList.add('mc-discussions-plate');
      root.classList.add('mc-modules-plate');
      root.classList.add('mc-communications-plate');
      root.classList.add('mc-account-notif-plate');
      root.classList.add('mc-files-plate');
      root.classList.add('mc-profile-settings-plate');
      root.classList.add('mc-people-plate');
      root.classList.add('mc-wiki-plate');
      root.classList.add('mc-quizzes-plate');
      root.classList.add('mc-groups-plate');
      root.classList.add('mc-submissions-plate');
    }

    /* [补回 2026-10-17] 这两颗在 bcx→mc 改名那一笔（1bc309b "testing 94"）里被连着删掉了：
       那笔把 style.css 里 68 处选择器改成了 mc- 前缀，同时把挂类名的这两行删了，
       于是第 24 节（Dashboard List view 顶部那条白栏）和第 25 节（点铃那屏提醒面板）
       整整四天天天不生效，而设置里那两颗勾还挂着、勾了没反应。
       键名跟着改名走（mc_planner_plate／mc_opportunities_plate），read() 里有 bcx_ 回落，
       老存档照旧读得到。这两节的锚全是 Dashboard 独有的 id（#dashboard-planner、
       #opportunities_parent 那几颗），不像上面那批要防 :has，所以按设置挂、不分页。 */
    root.classList.toggle('mc-planner-plate', read('mc_planner_plate') !== '0');
    root.classList.toggle('mc-opportunities-plate', read('mc_opportunities_plate') !== '0');

    /* [2026-10-13 打字卡顿这一刀] 上面那批页锁是"不管来的是哪一页都一律挂"，
       所以 style.css 里那 215 条只能自己现场问"这一页有没有某块内容"：
       html.mc-files-plate:has(#files-table) …。:has() 挂在 html 上＝整页面的肚子，
       每敲一个字 DOM 变一次就要重判一遍，不管命不命中（实测那一屏 Rendering 4,285 毫秒，
       而我们自己的脚本一共只花 9 毫秒）。
       这一批第二颗类名就是替掉那 215 次"现问"：地址在 document_start 就读得到，问一次就够。
       为什么另挂一颗而不直接把页锁改成按地址挂——页锁改成按地址挂会连带收窄那一节里
       不带 :has 的其它规则（测验列表那节 114 行里只有 14 行带 :has），别的页就掉皮。
       所以页锁照旧常挂，CSS 里 :has(某锚点) 换成 :where(.mc-on-某页)，
       :where() 不贡献权重，换完每条规则的权重和原来一字一样。
       两条口径不齐的没并进来，仍走原来的 :has：作业列表（同地址有新旧两代，
       #ag-list 对 assignments-2-student-view）、单页（首页设成页面时地址不带 /wiki） */
    var onPath = function (re) { return re.test(window.location.pathname); };
    root.classList.toggle('mc-on-discussions', onPath(/\/courses\/\d+\/discussion_topics\/?$/));
    /* 讨论区某一条话题那一页（地址带话题号），落点见 style.css 第 55 节。
       这一颗必须写成实类名、不能像上面那批一样套 :where()：第 55 节里"搜索框／两颗下拉收胶囊"
       那条要压过全局 .mc-plate-select 那条 :has(input[data-cid="SimpleSelect"])（权重 (0,4,1)），
       门一旦进 :where() 就不贡献权重，那两条会当场输回去 */
    root.classList.toggle('mc-disc-topic-plate', onPath(/\/courses\/\d+\/discussion_topics\/\d+/));
    root.classList.toggle('mc-on-modules', onPath(/\/courses\/\d+\/modules\/?$/));
    root.classList.toggle('mc-on-communications', onPath(/\/profile\/communication/));
    root.classList.toggle('mc-on-account-notif', onPath(/\/account_notifications/));
    root.classList.toggle('mc-on-files', onPath(/\/files(\/|$)/));
    root.classList.toggle('mc-on-profile-settings', onPath(/\/profile\/settings/));
    root.classList.toggle('mc-on-people', onPath(/\/courses\/\d+\/users\/?$/));
    root.classList.toggle('mc-on-quizzes', onPath(/\/courses\/\d+\/quizzes\/?$/));
    root.classList.toggle('mc-on-groups', onPath(/\/courses\/\d+\/groups\/?$/));
    root.classList.toggle('mc-on-submissions', onPath(/\/assignments\/\d+\/submissions\//));
    root.classList.toggle('mc-on-quiz-results', onPath(/\/assignments\/\d+\/taking\/\d+\/results\/?$/));

    /* 深色只在 Canvas 那一档（或当前存档是空的）才算数，判据和 content.js 的 mcDarkOn 一字一样。
       先算它，因为下面那圈类名里 bc-colour-mode-dark 要用：装了主题还挂它，而主题页本来就有
       mc-themed，style.css 第 36 节那条 html.mc-themed.bc-colour-mode-dark .ic-app-header
       会按权重压过主题表里的 .ic-app-header，侧栏就一直是那层灰黑、主题的侧栏色上不去 */
    var isOff = tierInit() === 'canvas';
    if (!isOff) {
      try {
        var sk = saveKey();
        var sn = JSON.parse(localStorage.getItem(sk) || 'null');
        if (!sn || !Object.keys(sn.vars || {}).length) isOff = true;
      } catch (_) { isOff = true; }
    }

    Object.keys(DISPLAY_GROUPS).forEach(function (key) {
      var meta = DISPLAY_GROUPS[key];
      var saved = read('bc_' + key);
      var value = meta.options.indexOf(saved) !== -1 ? saved : meta.def;
      // 只有深浅色这一档要按生效算，其余显示档照存的值挂
      if (key === 'colour_mode' && !isOff) value = 'light';
      var prefix = 'bc-' + key.replace(/_/g, '-') + '-';
      meta.options.forEach(function (opt) {
        root.classList.toggle(prefix + opt, value === opt);
      });
    });

    /* 那一格本来一行色都不刷，可深色要靠 style.css 里那批挂在 mc-themed 上的换皮规则才成套 */
    if (read('bc_colour_mode') === 'dark' && isOff) {
      root.classList.add('mc-themed');
    }
  }

  // style.css 里隐藏两颗 logo、课程色条和各档显示设置的规则在 document_start 就就绪了，
  // 可开关类名原本要等 document_idle 的 content.js 才挂，于是刷新时会先闪一帧原生 UI。
  // content.js 里那份 applyLogoSettings 照旧保留，它跑到时算出同样的类名，不会打架。
  try {
    applyDisplayClasses();
  } catch (e) {
    console.error('[BCX] 首帧开关类名挂载失败', e);
  }

  /* [BCX calendar toolbar] 顶部那一行缺的两颗类名也提前到它出现的那一帧。
     .bc-cal-views（Week·Month·Agenda 三颗的父层＝分段栏轨道）和 .bc-cal-arrow（左右翻页的圆板）
     原本只有 content.js 的 dressCalendarToolbar 会补，而它排在 document_idle、再等 300 毫秒合并，
     中间那一段就是 Canvas 原样的三颗灰按钮加两颗方块箭头。这里挂一棵临时观察器，站点把这一行
     画出来那一帧就把类名补上：补的是同一个名字，级联一字没动，只是提早一帧。
     箭头里的 ← → 换成 SVG 折角、Today 改成 "Jump to Today" 仍旧归 content.js（那是换内容不是换形状）。
     补满就自己收，最多守 8 秒，不给日历页那棵 React 树长期加活 */
  if (/\/calendar(\/|$)/.test(window.location.pathname)) {
    try {
      var calTagOnce = function () {
        var week = document.querySelector('button#week');
        var bar = week && week.parentElement;
        if (bar && bar.querySelector('#month') && bar.querySelector('#agenda')) bar.classList.add('bc-cal-views');
        var arrows = document.querySelectorAll('button.navigate_prev, a.navigate_prev, button.navigate_next, a.navigate_next');
        for (var i = 0; i < arrows.length; i++) arrows[i].classList.add('bc-cal-arrow');
        return !!document.querySelector('.bc-cal-views') && arrows.length >= 2;
      };
      if (!calTagOnce()) {
        var calTagWatch = new MutationObserver(function () {
          if (!calTagOnce()) return;
          calTagWatch.disconnect();
          clearTimeout(calTagStop);
        });
        calTagWatch.observe(document.documentElement, { childList: true, subtree: true });
        var calTagStop = setTimeout(function () { calTagWatch.disconnect(); }, 8000);
      }
    } catch (e) {}
  }

  function inject(id, attr, text) {
    var node = document.createElement('style');
    if (id) node.id = id;
    if (attr) node.setAttribute('data-bcx-sheet', attr);
    // 自定义主题的贴图在库里，表里写的是 mc-img://<id>/<位置> 的引用，进 DOM 这一刻才展开
    // （快照和库里各存一份 base64 很快就把那一格撑满）。theme-lib.js 排在前面，这里读得到它
    node.textContent = text.indexOf('mc-img://') === -1 ? text
      : (window.mcLib ? window.mcLib.resolve(text) : text);
    (document.head || document.documentElement).appendChild(node);
  }

  /* 首帧注的是存档里已经写好的文本（themeCss 那一整串、rootVars 那一串变量），
     它们不在这颗编译器手里过过，注进去以前先验一遍结构。判据的正本在 theme-lib.js，
     和 content.js 落盘那一条共用。不合格就整串不注：这一屏顶多没刷上主题皮，
     比让存档里一颗 } 替自己开一条新规则（把界面藏掉、改布局、再加一个远程资源）划算。
     只管我们自己这两条通路——BCX_PASTE_SHEETS 那条注的是它整份表原文，按设计就是任意 CSS */
  function sheetOk(text) {
    var g = window.mcCssGuard;
    return !g || g.sheetOk(String(text || ''));
  }
  function injectSheet(id, attr, text) {
    if (!sheetOk(text)) {
      console.warn('[MCX] 首帧那份样式表结构不对，这一张不注入：' + (id || attr || ''));
      return;
    }
    inject(id, attr, text);
  }

  // 槽值 → 根变量表，和 content.js 里的 mcVarsToRoot 同一件事（两份脚本不共享作用域，各留一份）
  function varsToRoot(vars) {
    var out = '';
    var g = window.mcCssGuard;
    if (!vars) return out;
    Object.keys(vars).forEach(function (name) {
      var raw = String(vars[name] || '').trim();
      if (!raw || /[;{}]/.test(raw)) return;
      var token = '--' + (name.indexOf('bc') === 0 ? name : 'bc' + name);
      // 名字是 JSON 里那个 c.slot，值还要拼进 :root{...}，两道都过闸
      if (g && (!g.name(token) || !g.ok(raw))) return;
      out += token + ':' + raw + ';';
    });
    return out;
  }

  /* [BCX nav plate] 侧栏当前项那颗胶囊：底板【合二为一后】就是卡底那一档＝主题给的 cards，
     没有就是 background-0。不再从正文色和两档背景里现场比"谁和侧栏拉得开"（那条让
     "拖 Main text 会改掉胶囊"成立），也不再掺白造档。板上的字按底板自己的明暗翻黑/白。
     这段必须在首帧：content.js 是 document_idle，等它跑到用户已经先看半秒退路色再翻一次。
     判据和 content.js 的 BCX_TOKEN_MAP 那条退路一致，两边算出两个色＝半秒后翻一次色 */
  function navPlateVars(snap) {
    var vars = (snap && snap.vars) || {};
    var slot = function (name) { return String(vars['bc' + name] || vars[name] || ''); };
    // 面板上那颗 "No colour"：这一档他不铺色，胶囊跟着透明（不写行内，让 CSS 退路接上）
    if (snap && snap.clearSlots && snap.clearSlots['background-0']) return null;
    var names = editedFirst(['bccards', 'bcbackground-0'], snap && snap.edits);
    for (var i = 0; i < names.length; i++) {
      var solid = solidOf(slot(names[i].replace(/^bc/, '')));
      if (!solid) continue;
      /* 完全透明就是这一档的最终答案，不再往后找：取色轮那边也是照它画透明。
         这里往后退一档就会和它算出两个结果＝首帧一颗实色、半秒后翻成透明 */
      if (isClear(solid)) return null;
      var rgb = rgbOf(solid);
      if (rgb) return { plate: solid, ink: luminance(rgb) > 0.45 ? '#000000' : '#ffffff' };
    }
    return null;
  }

  function rgbOf(raw) {
    var solid = solidOf(raw);
    if (!solid) return null;
    // document_start 还没有 body，探针只能挂 documentElement（content.js 那份挂 body，同一件事）
    var probe = document.createElement('span');
    probe.style.cssText = 'display:none;color:' + solid;
    document.documentElement.appendChild(probe);
    var parts = getComputedStyle(probe).color.match(/[\d.]+/g);
    probe.remove();
    return parts && parts.length >= 3 ? [Number(parts[0]), Number(parts[1]), Number(parts[2])] : null;
  }

  function luminance(rgb) {
    var f = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  // 一串槽值里最后那颗纯色。和 content.js 的 mcSlotColorOf 逐条对齐：先按顶层逗号拆层
  // （括号里的逗号不算层），再只认"整层就是一颗颜色"的那些，取最后一颗。
  // 两边算法差一点，首帧和半秒后就会算出两个色，又变成变色
  var SOLID_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/i;
  function solidOf(raw) {
    var solids = slotLayersOf(String(raw || '')).filter(function (l) { return SOLID_RE.test(l); });
    return solids.length ? solids[solids.length - 1] : '';
  }

  /* 一串颜色的透明度（0 到 1，认不出返回 null）。上面 rgbOf 只取前三个数字，
     所以主题作者写的 #00000000（完全透明）会被读成"一颗黑"——14/3197 份主题的 cards 档就是它。
     判透明只能另走一条。和 content.js 的 mcAlphaOf 逐字对齐：两边差一点，
     首帧和半秒后取色轮跑完就会算出两个画面 */
  function alphaOf(raw) {
    var v = String(raw || '').trim();
    if (!v) return null;
    var hex8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(v);
    if (hex8) return parseInt(hex8[1], 16) / 255;
    var probe = document.createElement('span');
    probe.style.cssText = 'display:none;color:' + v;
    document.documentElement.appendChild(probe);
    var parts = getComputedStyle(probe).color.match(/[\d.]+/g);
    probe.remove();
    if (!parts) return null;
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }

  function isClear(raw) { return alphaOf(raw) === 0; }

  /* 卡底那一档在屏幕上到底挡住多少（0＝全透，1＝实色）。旧的磨砂门控只认"整串就是一颗纯色"，
     于是渐变、图、以及任何读不出单色的形状一律被算成不透明：那一档明明看得穿，
     屏幕上却只剩一层半透明，挂在类名下面的糊一条都不落。
     现在逐层拆：纯色层取它自己的 alpha；渐变层取它各端里最透的那一颗（要糊就糊身后最差那一端）；
     图层按"挡住"算（作者铺的是一张实图，它身后没有东西可糊）；多层照 CSS 的叠底顺序合成。
     整串是空（这一档压根没写到我们身上）算 0，那一层本来就没画东西。认不出的一律按挡住算，宁可少糊一层。
     和 content.js 的 mcFrostAlphaOf 逐字对齐：两边差一点就是首帧一层实色、半秒后翻成磨砂 */
  var FROST_COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
  function slotLayersOf(v) {
    var layers = [], depth = 0, cur = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) layers.push(cur.trim());
    return layers;
  }
  function frostAlphaOf(raw) {
    var v = String(raw || '').trim();
    if (!v) return 0;
    var through = 1;
    slotLayersOf(v).forEach(function (layer) {
      var a;
      if (/url\(/i.test(layer)) a = 1;
      else if (/gradient/i.test(layer)) {
        a = 1;
        (layer.match(FROST_COLOR_RE) || []).forEach(function (c) {
          var ca = alphaOf(c);
          if (ca !== null && ca < a) a = ca;
        });
      } else a = alphaOf(layer);
      if (a === null || a === undefined) return;
      through *= 1 - a;
    });
    return 1 - through;
  }

  // 快照里那几颗 "No colour"（卡底、控件底板）翻成按 token 索引，和 content.js 的
  // mcClearedTokens 同一件事：两边各认一次档名就会出现首帧一颗实色、半秒后一颗透明
  function clearedTokens(snap) {
    var on = (snap && snap.clearSlots) || {};
    var out = {};
    if (on['background-0']) out['--mc-background-0'] = true;
    if (on.buttons) out['--mc-buttons'] = true;
    return out;
  }

  // 他亲手拧过的那一档排到最前（和 content.js 的 mcEditedFirst 同一件事）：
  // cards 排在 background-0 前面，而面板上"Card and panel fill"那一行改的是 background-0，
  // 不插队就永远轮不到他改的那档＝首帧还是主题那份，得等取色轮跑完才翻
  function editedFirst(names, edits) {
    var on = function (n) { return (edits || {})[String(n).replace(/^bc/, '')] ? 1 : 0; };
    return names.slice().sort(function (a, b) { return on(b) - on(a); });
  }

  /* 带滑杆的那两档，和 content.js 的 BCX_ALPHA_SLOTS 同一份（tint 只有卡底那一档吃：
     控件底板按了 No colour 就是真的不铺板子，坐在它身下那一层上）。
     和 mcFrostFill 逐字对齐：两份脚本差一点就是首帧一层实色、半秒后翻成磨砂 */
  var BCX_CLEAR_ALPHA = 0.6;   // 和 content.js 的 BCX_FROST_CLEAR_ALPHA 同一颗数
  var ALPHA_SLOTS = {
    '--mc-background-0': { key: 'mc_panel_alpha', tint: true },
    '--mc-buttons': { key: 'mc_buttons_alpha', tint: false }
  };
  function slotAlpha(key) {
    // Number(null) 是 0 不是 NaN：没存过这颗键时必须当 100，否则首帧整站一层都不剩
    var saved = localStorage.getItem(key);
    if (saved === null && key && key.indexOf('mc_') === 0) {
      saved = localStorage.getItem('bcx_' + key.slice(3));
    }
    var n = saved === null || saved === '' ? 100 : Number(saved);
    return isNaN(n) ? 100 : Math.max(0, Math.min(100, n));
  }
  function frostFill(baseRgb, clear, pageRgb, slider, tintWhenClear) {
    if (!clear && slider >= 0.999) return null;
    if (clear && !tintWhenClear) return null;
    var base = clear
      ? (pageRgb || [255, 255, 255]).map(function (c) { return c + (255 - c) * 0.12; })
      : baseRgb;
    if (!base) return null;
    var a = (clear ? BCX_CLEAR_ALPHA : 1) * slider;
    var over = pageRgb || [255, 255, 255];
    return {
      css: 'rgba(' + base.map(function (c) { return Math.round(c); }).join(',') + ',' + (Math.round(a * 1000) / 1000) + ')',
      rgb: base.map(function (c, i) { return Math.round(c * a + over[i] * (1 - a)); })
    };
  }

  try {
    /* [防闪核心防御] 当用户选择由 Modern Canvas 绘制界面时（或未让步给 BC 时），
       BetterCampus 会在页面加载过程中异步动态插入 bettercampus-theme-preset、darkcss 等样式表。
       如果在 document_idle (content.js) 之前不拦截，BC 的样式就会在刚进页面时压过 Modern Canvas 闪烁。
       在这里用 document_start 挂全局 MutationObserver，一旦 BC 插入样式表就当场将其 disabled 或将我们那张表推至最后。
       注意：即使用户选的是原生 Canvas 档位（tierInit() === 'canvas'），只要 owner !== 'bc'，
       也必须彻底禁用 BC 样式表，否则 BC 主题会泄露污染原生 Canvas！ */
    (function guardThemeSheetEarly() {
      if (localStorage.getItem('bc_theme_owner') === 'bc') return;

      var neutraliseTheirs = function () {
        var ours = document.getElementById('mc-theme-sheet');
        var theirs = document.querySelectorAll('style[id^="bettercampus"], style[id^="bettercanvas"], style#darkcss');
        if (!theirs.length) return;

        // 将 BetterCampus 注入的主题及暗黑样式表直接禁用，彻底防止其在首屏争抢绘制
        // 同 content.js 的 mcKeepThemeSheetLast：停了 custom-cards 要在 <html> 上留标记，
        // 那一张里还带着它自家两颗卡片按钮的形状，style.css 第 21 节靠这个标记补回来
        var cardsOff = false;
        for (var i = 0; i < theirs.length; i++) {
          var s = theirs[i];
          var sid = String(s.id || '').toLowerCase();
          // 拦截与主题/壁纸/颜色相关的样式表，不影响其核心非样式组件
          if (
            sid === 'darkcss' ||
            sid.indexOf('theme') !== -1 ||
            sid.indexOf('preset') !== -1 ||
            sid.indexOf('custom-cards') !== -1
          ) {
            if (!s.disabled) s.disabled = true;
            if (sid.indexOf('custom-cards') !== -1) cardsOff = true;
          }
        }
        document.documentElement.classList.toggle('mc-bc-cards-off', cardsOff);

        // 确保我们自己的主题样式表与底色守卫始终排在最后，拥有终极覆盖权重
        var guard = document.getElementById('mc-boot-bg-guard');
        var last = theirs[theirs.length - 1];
        if (last && last.parentNode) {
          if (ours && ours.parentNode && !(ours.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING)) {
            last.parentNode.insertBefore(ours, last.nextSibling);
          }
          if (guard && guard.parentNode && !(guard.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING)) {
            last.parentNode.insertBefore(guard, (ours ? ours.nextSibling : last.nextSibling));
          }
        }
      };

      try {
        neutraliseTheirs();
        var obs = new MutationObserver(neutraliseTheirs);
        obs.observe(document.documentElement, { childList: true, subtree: true });
        // 5 秒后页面基本解析稳定，撤掉高频观察，转由 content.js 接管
        setTimeout(function () { obs.disconnect(); }, 5000);
      } catch (_) {}
    })();

    if (tierInit() === 'canvas') return;
    // 页面那一层（底色、侧栏壁纸、卡片贴图、字体）：
    // 如果用户选了 bc，且当前 BC 正在运行，则首帧不贴，让给 BC 刷；
    // 但如果 BC 已经关闭，而用户依然选择了 bc（使用此前记录的主题），则从 mc_bc_recorded_theme 加载并绘制！
    var owner = localStorage.getItem('bc_theme_owner');
    var raw = '';
    if (owner === 'bc') {
      // 检查 BC 是否在页面上
      var bcRunning = !!document.querySelector('bettercanvas-portal, bettercampus-components, bettercampus-element, style[id^="bettercampus"], style[id^="bettercanvas"], style#darkcss');
      if (bcRunning) return;
      raw = localStorage.getItem('mc_bc_recorded_theme') || getThemeSave(tierSlot() - 1);
    } else {
      raw = getThemeSave(tierSlot() - 1);
    }
    var snap = null;
    try { snap = JSON.parse(raw || 'null'); } catch (e) { snap = null; }
    if (!snap) return;

    // 主题表里的背景图要等侧栏节点出现才会开始请求；提前预取，减少刷新时露出原生底色的时间。
    var bootNav = snap.surfaces && snap.surfaces.nav;
    var navImageText = bootNav && [bootNav.layer, bootNav.bg, bootNav.raw].filter(Boolean).join(',');
    var navImageUrls = navImageText && navImageText.match(/url\(\s*(['"]?)(.*?)\1\s*\)/gi);
    if (navImageUrls && navImageUrls.length) {
      var navUrlMatch = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(navImageUrls[navImageUrls.length - 1]);
      var navUrl = navUrlMatch && navUrlMatch[2];
      if (navUrl && /^https?:\/\//i.test(navUrl)) {
        var navPreload = document.createElement('link');
        navPreload.rel = 'preload';
        navPreload.as = 'image';
        navPreload.href = navUrl;
        (document.head || document.documentElement).appendChild(navPreload);
      }
    }
    var navFallback = bootNav && String(bootNav.color || '').trim();
    if (navImageUrls && navImageUrls.length && navFallback && SOLID_RE.test(navFallback)) {
      inject('mc-boot-nav-guard', '', 'html #header.ic-app-header{background-color:' + navFallback + '!important}');
      window.addEventListener('load', function () {
        var guard = document.getElementById('mc-boot-nav-guard');
        if (guard) guard.remove();
      }, { once: true });
    }

    // 1) 它自己那几份主题表原文
    // 【测试阶段，禁止删除】停用中：见文件顶部 BCX_PASTE_SHEETS
    if (BCX_PASTE_SHEETS) (snap.sheets || []).forEach(function (text, i) { inject('', String(i), text); });
    // 2) 根变量。用表而不是行内：行内权重最高，会把旧主题钉死、让 BC 自己换主题也盖不回来
    // 【参数通路】它写在行上的 rootVars 经常是空的（变量在它自己那几张表里，不在行上），
    // 而贴表已经停用，所以缺了就用快照里的槽值现拼一份。style.css 里凡是 var(--bc…) 的规则
    // 全读这一份：缺了侧栏当前项的底板会变透明，而板上的字和图标是钉死的白
    /* 它行上抄来的那一份单独验结构：它不合格就只丢它那半截，别把上面 varsToRoot 现拼的那份
       （style.css 里所有 var(--bc…) 靠它）一起带走 */
    var theirVars = String(snap.rootVars || '');
    if (theirVars && !sheetOk(':root{' + theirVars + '}')) {
      console.warn('[MCX] 抄来的那份根变量结构不对，这一份不用');
      theirVars = '';
    }
    var rootVars = [varsToRoot(snap.vars), theirVars].filter(Boolean).join('');
    if (rootVars) injectSheet('', 'vars', ':root{' + rootVars + '}');
    // [BCX nav plate] 侧栏当前项那颗胶囊的两档色走行内样式，不进上面那张 :root 表：
    // style.css 里的退路挂在 html.mc-themed 上，权重比 :root 高，写在表里会被它压回去，
    // 首帧就还是退路色。content.js 那半秒后跑到时算的是同一套数，值一样就不再动
    var plate = navPlateVars(snap);
    if (plate) {
      document.documentElement.style.setProperty('--mc-nav-plate', plate.plate);
      document.documentElement.style.setProperty('--mc-nav-plate-ink', plate.ink);
    }
    // [BCX accent] 强调色：公告卡左侧那块实心色条、四周那一圈描边读的都是 --mc-links。
    // style.css 里它的退路是正文色（近黑），真值只有 content.js 的取色轮会写行内，而那份是
    // document_idle + 2 秒一轮——于是公告卡首帧是黑的，半秒后才翻成主题色。
    // 候选顺序和 content.js 的 BCX_TOKEN_MAP 一致（bclinks → bctext-0，第一个能用就停），
    // 而且照它一样要求"整串就是一颗纯色"：它那边是 mcToRgb(raw) 判不过就换下一档，
    // 这边要是擅自从渐变里抠出最后一颗，两边算出两个值，半秒后照样翻一次。
    var accentVars = snap.vars || {};
    var accentSlot = function (name) { return String(accentVars['bc' + name] || accentVars[name] || '').trim(); };
    var accentSolid = '';
    ['links', 'text-0'].some(function (name) {
      var raw = accentSlot(name);
      if (raw && SOLID_RE.test(raw)) { accentSolid = raw; return true; }
      return false;
    });
    var accentRgb = rgbOf(accentSolid);
    if (accentRgb) {
      document.documentElement.style.setProperty('--mc-links', accentSolid);
      // 块上那颗符号按强调色自己的明暗翻黑白，阈值和 content.js 的 mcInkOn 同一条线。
      // 那颗"可读性兜底"的开关（mc_set_theme_flip）首帧就要认，不然关着它还会闪一帧翻过的色
      document.documentElement.style.setProperty('--mc-links-ink',
        localStorage.getItem('mc_set_theme_flip') !== '0' && luminance(accentRgb) > 0.45 ? '#000000' : '#ffffff');
    }
    /* [BCX mc tokens] --mc-* 那一整组也在首帧写进行内样式。
       以前这里只预写了两样（侧栏胶囊、强调色），其余全等 content.js 的取色轮——那份是
       document_idle 加 2 秒一轮，所以 Dashboard 搜索框和那颗 ⋮ 首帧读到的是 style.css 里
       :root 的浅色默认值（#f3f4f6 那一档），看起来就是"刷新后先变回原生样式，一秒后才对"。
       这张表和 content.js 的 BCX_TOKEN_MAP 必须逐字对齐：两边算出两个值＝一秒后又翻一次色。 */
    var MC_TOKEN_MAP = {
      '--mc-background-0': ['bccards', 'bcbackground-0'],
      '--mc-background-1': ['bcbackground-1'],
      '--mc-background-2': ['bcbackground-2'],
      '--mc-borders': ['bcborders'],
      '--mc-buttons': ['bcbuttons', 'bcbackground-0'],
      '--mc-links': ['bclinks', 'bctext-0'],
      '--mc-text-0': ['bctext-0'],
      '--mc-text-1': ['bctext-1'],
      '--mc-text-2': ['bctext-2']
    };
    var snapVars = snap.vars || {};
    var pickedMc = {};
    var snapCleared = clearedTokens(snap);
    /* 卡底和页面底撞成一颗时，把卡底往白推一档。门槛、判据、解法逐字对齐 content.js 的
       mcLiftTowardWhite（那边的注释里有实测份数和这两个数为什么分开）。
       首帧不推、等一秒后取色轮再推＝卡片色在页面上当着他的面跳一次 */
    var CARD_LIFT_TRIGGER = 12;
    var CARD_LIFT_GAP = 18;
    var cardLiftOn = localStorage.getItem('mc_set_theme_flip') !== '0';
    function liftTowardWhite(raw, pageRgb) {
      var rgb = raw && SOLID_RE.test(raw) ? rgbOf(raw) : null;
      if (!rgb || !pageRgb || alphaOf(raw) !== 1) return null;
      var p = [rgb[0] - pageRgb[0], rgb[1] - pageRgb[1], rgb[2] - pageRgb[2]];
      var d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
      var gap2 = CARD_LIFT_GAP * CARD_LIFT_GAP;
      if (d2 >= CARD_LIFT_TRIGGER * CARD_LIFT_TRIGGER) return null;
      var v = [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
      var a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      if (a < 1) return null;
      var b = 2 * (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]);
      var disc = b * b - 4 * a * (d2 - gap2);
      if (disc <= 0) return null;
      var k = (-b + Math.sqrt(disc)) / (2 * a);
      if (!(k > 0) || k > 1) return null;
      var dist = function (o) {
        return Math.sqrt((o[0] - pageRgb[0]) * (o[0] - pageRgb[0]) +
          (o[1] - pageRgb[1]) * (o[1] - pageRgb[1]) + (o[2] - pageRgb[2]) * (o[2] - pageRgb[2]));
      };
      var solve = function (t) {
        return rgb.map(function (c, i) { return Math.min(255, Math.round(c + v[i] * t)); });
      };
      // 四舍五入会把"刚好 18"抹成 17 点几，往上补到真过线；补到掺满还不够就交回 null，
      // 让调用方按"推不动"处理（那一批走灰边）。逐字对齐 content.js 的 mcLiftTowardWhite
      var out = solve(k), kk = k;
      for (var g = 0; g < 60 && dist(out) < CARD_LIFT_GAP; g++) {
        kk += 0.002;
        if (kk > 1) return null;
        out = solve(kk);
      }
      if (dist(out) < CARD_LIFT_GAP) return null;
      return '#' + out.map(function (c) {
        return c.toString(16).padStart(2, '0');
      }).join('');
    }
    var cardPageRgb = rgbOf(solidOf(String(snapVars['bcbackground-1'] || snapVars['background-1'] || '')));
    Object.keys(MC_TOKEN_MAP).forEach(function (token) {
      // 面板上那颗 "No colour" 是这一档的最终答案（取色轮那边同一判据，两边不能一个画透明一个画色）
      if (snapCleared[token]) {
        document.documentElement.style.setProperty(token, 'transparent');
        return;
      }
      var names = editedFirst(MC_TOKEN_MAP[token], snap.edits);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var raw = String(snapVars[name] || snapVars[name.replace(/^bc/, '')] || '').trim();
        // 和 content.js 的 mcToRgb 同一条门槛：整串必须就是一颗颜色，渐变和 url 一律不收。
        // 完全透明也照它画（那是作者在这一档放的东西），但它不进 pickedMc——
        // 下游拿它当黑底会挑错字色，那条和取色轮一样
        var rgb = raw && SOLID_RE.test(raw) ? rgbOf(raw) : null;
        if (rgb || (raw && isClear(raw))) {
          // 只有卡底一族推亮（cards、background-0）。他亲手拧过这一档就不再自动推
          var want = raw;
          if (cardLiftOn && rgb && (name === 'bccards' || name === 'bcbackground-0') &&
              !(snap.edits || {})[name.replace(/^bc/, '')]) {
            want = liftTowardWhite(raw, cardPageRgb) || raw;
          }
          document.documentElement.style.setProperty(token, want);
          if (!isClear(want)) {
            var wantRgb = SOLID_RE.test(want) ? rgbOf(want) : null;
            if (wantRgb) pickedMc[token] = wantRgb;
          }
          return;
        }
      }
    });
    // 侧栏文字与图标色：优先从 sidebar-text 槽、surfaces.nav、或 --mc-text-0 继承
    var snapNav = (snap.surfaces && snap.surfaces.nav) || {};
    var slotNavInk = String(snapVars['bcsidebar-text'] || snapVars['sidebar-text'] || (snapNav && (snapNav.text || snapNav.icon)) || '').trim();
    if (slotNavInk && SOLID_RE.test(slotNavInk)) {
      document.documentElement.style.setProperty('--mc-nav-ink', slotNavInk);
      pickedMc['--mc-nav-ink'] = rgbOf(slotNavInk);
    } else if (document.documentElement.style.getPropertyValue('--mc-text-0')) {
      var fallbackNavInk = document.documentElement.style.getPropertyValue('--mc-text-0');
      document.documentElement.style.setProperty('--mc-nav-ink', fallbackNavInk);
      if (pickedMc['--mc-text-0']) pickedMc['--mc-nav-ink'] = pickedMc['--mc-text-0'];
    }
    // 卡底那一档过一遍磨砂。排在整组之后：它要拿页面底那一档当 tint 和合成对象。
    // 侧栏那颗胶囊在上面已经按实色写过一次，这里磨砂真的开着就把那一颗一起改成同一层，
    // 板上的字按合成以后的明暗重翻（content.js 那趟取色算的是同一套数）
    var cardFrost = null;
    Object.keys(ALPHA_SLOTS).forEach(function (token) {
      var rawStr = String(document.documentElement.style.getPropertyValue(token) || '');
      if (!rawStr) return;
      var cfg = ALPHA_SLOTS[token];
      var f = frostFill(rgbOf(rawStr), isClear(rawStr), pickedMc['--mc-background-1'] || null,
        slotAlpha(cfg.key) / 100, cfg.tint);
      if (!f) return;
      document.documentElement.style.setProperty(token, f.css);
      if (token !== '--mc-background-0') return;
      cardFrost = f;
      // 对比度兜底读的是"合成以后眼睛看到的那颗"，不是 tint 本身
      pickedMc[token] = f.rgb;
    });
    if (cardFrost && document.documentElement.style.getPropertyValue('--mc-nav-plate')) {
      // 侧栏那颗胶囊上面按实色写过一次，磨砂真的开着就把它改成同一层，
      // 板上的字按合成以后的明暗重翻（content.js 那趟取色算的是同一套数）
      document.documentElement.style.setProperty('--mc-nav-plate', cardFrost.css);
      document.documentElement.style.setProperty('--mc-nav-plate-ink',
        luminance(cardFrost.rgb) > 0.45 ? '#000000' : '#ffffff');
    }
    /* 类名：判据＝这一档在屏幕上到底挡住多少（frostAlphaOf，逐层拆：纯色看自己、渐变看最透那端、
       图算挡住、什么都没有算全透）。以前只认"整串是一颗纯色"，所以渐变／图／空串这三种
       屏幕上看得穿的形状全被判成不透明，磨砂一条都不落＝他报的"还是透明"。
       读的是行内那一串，读不到再退回计算值：页面那一层归 BetterCampus 时链条可能压根没写到我们身上 */
    var resolvedCard = String(document.documentElement.style.getPropertyValue('--mc-background-0')
      || getComputedStyle(document.documentElement).getPropertyValue('--mc-background-0') || '').trim();
    document.documentElement.classList.toggle('mc-frost', frostAlphaOf(resolvedCard) < 0.98);
    // 可读性兜底：当 Keep text readable (mc_set_theme_flip) 开启时，
    // 若文字色压在 background-1（页面底）或 background-0（卡底）上显色度比（对比度）低于 3:1，
    // 则按背景明暗翻成纯黑（浅底）或纯白（深底）。
    var cardRgb = pickedMc['--mc-background-0'];
    var pageLumRgb = pickedMc['--mc-background-1'];
    if ((cardRgb || pageLumRgb) && localStorage.getItem('mc_set_theme_flip') !== '0') {
      ['--mc-text-0', '--mc-text-1', '--mc-text-2', '--mc-nav-ink'].forEach(function (token) {
        var rgb = pickedMc[token];
        if (!rgb) return;
        var lum = luminance(rgb);
        var pageContrast = 99;
        if (pageLumRgb) {
          var pHi = Math.max(lum, luminance(pageLumRgb)), pLo = Math.min(lum, luminance(pageLumRgb));
          pageContrast = (pHi + 0.05) / (pLo + 0.05);
        }
        var cardContrast = 99;
        if (cardRgb) {
          var cHi = Math.max(lum, luminance(cardRgb)), cLo = Math.min(lum, luminance(cardRgb));
          cardContrast = (cHi + 0.05) / (cLo + 0.05);
        }
        if (pageContrast < 3 || cardContrast < 3) {
          // 黑还是白按"卡底和页面底里更差的那一层"挑，和 content.js 的 mcFlipInk 逐字对齐：
          // 只看先失败的那一层会挑出在另一层上糊掉的那颗色
          var worstOn = function (inkRgb) {
            var inkLum = luminance(inkRgb);
            var worst = 99;
            if (cardRgb) {
              var bLum = luminance(cardRgb);
              worst = Math.min(worst, (Math.max(inkLum, bLum) + 0.05) / (Math.min(inkLum, bLum) + 0.05));
            }
            if (pageLumRgb) {
              var pLum = luminance(pageLumRgb);
              worst = Math.min(worst, (Math.max(inkLum, pLum) + 0.05) / (Math.min(inkLum, pLum) + 0.05));
            }
            return worst;
          };
          var targetInk = worstOn([0, 0, 0]) >= worstOn([255, 255, 255]) ? '#000000' : '#ffffff';
          document.documentElement.style.setProperty(token, targetInk);
        }
      });
    }
    /* [BCX plate-1 ink] 加载时那颗转圈：轨道是页面底那一档（--mc-background-1），
       转的那一段按这颗轨道自己的明暗翻黑／白，阈值和上面侧栏胶囊同一条线。
       档位停在 Canvas colours、或页面那一层交给 External Extension 时这一整段压根不跑，
       所以 style.css 那条留了退路（读不到就用正文色） */
    if (pageLumRgb) {
      document.documentElement.style.setProperty('--mc-plate-1-ink',
        luminance(pageLumRgb) > 0.45 ? '#000000' : '#ffffff');
    }
    /* [BCX link ink] 链接文字专用那一档，和 content.js 里那段逐字对齐：强调色当实心块用时
       块上永远配一颗算好的黑/白字，一旦拿它当文字坐在卡底和页面底上就得自己够 3:1，
       两层都拉得开才用强调色，否则退回正文那一档。首帧不写的话链接要先黑一秒再翻成主题色 */
    var linkAccentRgb = pickedMc['--mc-links'];
    if (linkAccentRgb) {
      var pageLumRgb = pickedMc['--mc-background-1'];
      var linkGuard = localStorage.getItem('mc_set_theme_flip') !== '0';
      var linkOk = !linkGuard;
      if (linkGuard) {
        linkOk = [cardRgb, pageLumRgb].every(function (base) {
          if (!base) return true;
          var hi = Math.max(luminance(linkAccentRgb), luminance(base));
          var lo = Math.min(luminance(linkAccentRgb), luminance(base));
          return (hi + 0.05) / (lo + 0.05) >= 3;
        });
      }
      document.documentElement.style.setProperty('--mc-links-text',
        linkOk ? document.documentElement.style.getPropertyValue('--mc-links') : 'var(--mc-text-0)');
    }
    // 3) 主题字体。它是插 <link> 去 Google Fonts 拉的，不跟样式表一起进来，得单独补
    (snap.fonts || []).forEach(function (href, i) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-bcx-sheet', 'font' + i);
      link.href = href;
      (document.head || document.documentElement).appendChild(link);
    });
    // 4) 我们自己编译的那份（侧栏和整页背景、课程卡图、字体族）。
    //    这一份必须在首帧之前进，否则切页面时又会闪一下原生色
    if (snap.themeCss) injectSheet('mc-theme-sheet', '', snap.themeCss);

    // 【首帧硬核防闪】立即为 html, body 和 #application 等锁定我们快照里的整页大背景 background-1（无则退回 background-0），
    // 不等 content.js。解决"进入页面时 #application 这一层大背景被 BetterCampus 抢先刷色"的问题。
    // 关键修正：页面底色永远是 background-1（Whole background），绝不能把卡底 background-0 涂在 body 上，
    // 否则在二级菜单较长、内容区较短滑动到底部时，页面底部会露出 body 的 background-0！
    var bg0 = (snap.vars && (snap.vars['bcbackground-0'] || snap.vars['background-0'])) || '';
    var bg1 = (snap.vars && (snap.vars['bcbackground-1'] || snap.vars['background-1'])) || '';
    var pageBg = (bg1 && SOLID_RE.test(bg1)) ? bg1 : ((bg0 && SOLID_RE.test(bg0)) ? bg0 : '');
    var appBgRule = '';
    if (pageBg) {
      appBgRule += 'html,body,#application{background-color:' + pageBg + '!important;}';
      /* #wrapper 和 #main 必须一起点名。[实测 2026-10-11 读它包体 9.8.15 all.js @3098700]
         它那颗防闪的粒子写的是 body,#wrapper,#main{background-color:它缓存的那颗色!important}，
         没有 id（所以我们那套按 id 摁表的观察器看不见它）、插在 document_start、而且永不删除。
         这两层在 #application 之上，不画它们＝它那颗色整片盖在我们上面，每一页都中。
         前面多挂一个 html 抬一档权重（它 #wrapper 是 1 个 id，我们是 html＋id），
         这样谁后插都不让。当场反证过：把它的规则贴进页面，屏幕底立刻变它那颗色，
         摘掉立刻回来 */
      appBgRule += 'html #wrapper,html #main{background-color:' + pageBg + '!important;}';
    }
    if (appBgRule) inject('mc-boot-bg-guard', 'bg-guard', appBgRule);


    // 首帧之前就把这个类名挂上，style.css 第 5 节那几条导航配色才不会先闪一帧出来
    document.documentElement.classList.add('mc-themed');
    if (location.pathname.indexOf('/conversations') !== -1) document.documentElement.classList.add('mc-conversations-page');

    // [2026-10-07 性能重磅优化] 拦截通讯录列表/选人浮层的后台 hover 事件
    function mcBlockAddressBookHover(e) {
      try {
        var target = e.target;
        if (!target || !target.closest) return;
        if (
          target.closest('[data-testid*="address-book"]') ||
          (target.closest('span[data-position-content]') && target.closest('span[data-position-content]').querySelector('[data-testid*="address-book"]'))
        ) {
          e.stopPropagation();
        }
      } catch (_) {}
    }
    window.addEventListener('mouseover', mcBlockAddressBookHover, true);
    window.addEventListener('mouseout', mcBlockAddressBookHover, true);
    window.addEventListener('mousemove', mcBlockAddressBookHover, true);

    // 签名跟 content.js 里那套算法保持一致，它跑到时看到一样的值就不会再注一遍
    // 【测试阶段，禁止删除】停用贴表时这边恒写空串，content.js 算出来的也是空串，两边对上就不折腾 DOM
    document.documentElement.dataset.mcSheets = BCX_PASTE_SHEETS
      ? (snap.sheets || []).length + ':' + (snap.sheets || []).reduce(function (n, t) { return n + t.length; }, 0)
      : '';

  } catch (e) {
    console.error('[BCX] 防闪引导失败', e);
  }
})();

/* =========================================================
 * 导航图标尺寸：同样在 document_start 就位（防闪第二例）
 * 学校自己加的 Grades 那颗是一颗没有类名的裸 svg，图形在它自己的画布里只占中间一小块，
 * 被 style.css 那条 22px 槽位锁一钉，看着就比 History/Search 那几颗小一圈。
 * 要补多少只能量出来（图形占画布几成），而量必须等 DOM 出现，所以这份没法写成纯 CSS。
 * 但也不能放在 content.js 里：那份是 document_idle，首帧早就画完了才轮到它，
 * 症状就是"刚进来那颗特别小，等扩展加载完才变正常"。
 * 这里在 document_start 挂观察器，导航一插进 DOM 就在同一帧里量完补上（观察器回调是
 * 微任务，浏览器还没画这一帧），跟别的图标一样是首帧就对的
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  function fitBareNavIcons() {
    var svgs = document.querySelectorAll('.ic-app-header__menu-list-link svg:not([class])');
    for (var i = 0; i < svgs.length; i++) {
      var svg = svgs[i];
      var now = svg.style.transform || 'none';
      if (svg.dataset.mcIconFit === now) continue; // 这一档已经算过：别每次 DOM 变动都重量一遍
      if (!svg.getClientRects().length) continue; // 还没画到屏幕上时 getBBox 会抛，等它出现再量
      var box = null;
      var vb = svg.viewBox && svg.viewBox.baseVal;
      try { box = svg.getBBox(); } catch (e) { box = null; }
      var ratio = (box && box.width && box.height && vb && vb.width && vb.height)
        ? Math.max(box.width / vb.width, box.height / vb.height) : 1;
      // 别的图标是 22px 画布、图形占八九成，也就是光学 19～20px，这一档按 20px 对齐。
      // 用 transform 而不是改宽高：不改宽高就不动那 22px 槽位，右边文字那一列一步都不会偏
      var k = Math.min(1.55, Math.max(1, 20 / ratio / 22));
      svg.style.setProperty('transform', k > 1.02 ? 'scale(' + k.toFixed(3) + ')' : 'none', 'important');
      svg.dataset.mcIconFit = svg.style.transform;
    }
  }

  /* 观察根必须是 documentElement。旧代码是 document.querySelector('#header, .ic-app-header')
     挂上了才 observe——可 document_start 这一刻 Canvas 的 #header 通常还没解析出来，
     if (navRoot) 一判而过，这条观察器压根没挂上：那颗裸 svg 从头没人补，
     只能等后面别的趟路过＝"刚进来那颗看不见，过一会儿才正常"。
     现在是变动一来就在同一帧量完补上；没补全时逐帧追（最多 3 秒，追不到就算了，
     别把 CPU 挂死），补全之后回到 200 毫秒的地板省 CPU。做法抄下面成绩页那一节。 */
  var queued = false, lastAt = 0, retry = 0, navBootAt = Date.now();
  function pendingBareIcons() {
    var svgs = document.querySelectorAll('.ic-app-header__menu-list-link svg:not([class])');
    for (var i = 0; i < svgs.length; i++) if (!svgs[i].dataset.mcIconFit) return true;
    return false;
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(run); } }
  function run() {
    queued = false;
    var chasing = pendingBareIcons() && Date.now() - navBootAt < 3000;
    var wait = chasing ? 0 : lastAt + 200 - Date.now();
    if (wait > 0) { if (!retry) retry = setTimeout(function () { retry = 0; schedule(); }, wait); return; }
    lastAt = Date.now();
    try { fitBareNavIcons(); } catch (e) {}
  }
  var navObs = null;
  try {
    run();
    navObs = new MutationObserver(schedule);
    navObs.observe(document.documentElement, { childList: true, subtree: true });
    // 导航整栏都不出现的场合（嵌在别人页面里、被学校藏掉）3.5 秒后自己收，不给这一棵一直加活
    setTimeout(function () {
      if (navObs) { navObs.disconnect(); navObs = null; }
    }, 3500);
  } catch (e) {
    console.error('[BCX] 导航图标尺寸引导失败', e);
    if (navObs) navObs.disconnect();
  }
})();

/* =========================================================
 * 原生 <select> → 自定义圆角下拉：document_start 就位（防闪第三例）
 * 这套逻辑原先在 content.js（document_idle），成绩页那些 Quarter 选择器要等它跑完才被包成胶囊，
 * 中间闪一帧原生方框。抄 fitBareNavIcons 的做法：document_start 挂观察器，select 一插进 DOM 就在
 * 同一微任务里包好藏掉，浏览器还没画这一帧，所以闪不出来。整段逻辑只此一份，content.js 里已删。
 * 真 select 不删、只 opacity:0 藏成占位继续持有 value；选中时派发 change/input，Canvas 筛选照常生效。
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  // 关的时候先换成 .closing（style.css 那条播 220ms 缩放淡出），结束后再摘 class
  // 回到静置态的 display:none。直接摘 .open 的话那条 display:none 立刻生效＝菜单瞬没，
  // 动画没有东西可画。计时与 CSS 的 220ms 淡出保持一致
  function closeWrap(wrap) {
    if (!wrap || !wrap.isConnected) return;
    if (!wrap.classList.contains('open') && !wrap.classList.contains('closing')) return;
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    if (wrap._bcxCloseT) clearTimeout(wrap._bcxCloseT);
    wrap._bcxCloseT = setTimeout(function () {
      wrap._bcxCloseT = null;
      wrap.classList.remove('closing');
    }, 220);
  }
  function toggleWrap(wrap) {
    var wasOpen = wrap.classList.contains('open');
    document.querySelectorAll('.mc-select-wrap.open').forEach(function (w) { if (w !== wrap) closeWrap(w); });
    // 淡出还没播完就再点开：先把 .closing 和那个定时器摘掉，不然计时到点会把刚点开的那份关掉
    if (wrap._bcxCloseT) { clearTimeout(wrap._bcxCloseT); wrap._bcxCloseT = null; }
    wrap.classList.remove('closing');
    
    // [Bug Fix] 菜单打开前瞬间把 pill 压淡一点，避免 9999px vs 12px 圆角对比产生闪烁感
    // menu-hidden 类用于标记"菜单即将展开但还没画出来"的状态
    var willOpen = !wasOpen;
    wrap.classList.toggle('open', willOpen);
    if (willOpen) {
      // 先加 menu-hidden（菜单出现前的短暂窗口），让 pill 知道要调整
      setTimeout(function () {
        wrap.classList.add('menu-hidden');
      }, 15);
    } else {
      wrap.classList.remove('menu-hidden');
    }
  }
  function pick(sel, idx) {
    if (sel.selectedIndex !== idx) {
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (sel._bcxWrap) closeWrap(sel._bcxWrap);
    sync(sel);
  }
  function sync(sel) {
    var wrap = sel._bcxWrap;
    if (!wrap || !wrap.isConnected) return;
    var cur = sel.options[sel.selectedIndex];
    var text = cur ? cur.textContent.trim() : '';
    var lab = wrap.querySelector('.mc-select-label');
    if (lab && lab.textContent !== text) lab.textContent = text;
    var menu = wrap.querySelector('.mc-select-menu');
    if (!menu) return;
    var sig = [].map.call(sel.options, function (o) { return o.textContent.trim(); }).join('~|~');
    if (menu._sig !== sig) {
      menu._sig = sig;
      menu.textContent = '';
      [].forEach.call(sel.options, function (o, i) {
        var it = document.createElement('div');
        it.className = 'mc-select-opt';
        it.setAttribute('role', 'option');
        it.textContent = o.textContent.trim();
        it.addEventListener('click', function (ev) { ev.stopPropagation(); pick(sel, i); });
        menu.appendChild(it);
      });
    }
    [].forEach.call(menu.children, function (it, i) { it.classList.toggle('selected', i === sel.selectedIndex); });
  }
  function build(sel) {
    var wrap = document.createElement('span');
    wrap.className = 'mc-select-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('mc-select-native');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mc-select-btn';
    var lab = document.createElement('span');
    lab.className = 'mc-select-label';
    btn.appendChild(lab);
    var menu = document.createElement('div');
    menu.className = 'mc-select-menu';
    menu.setAttribute('role', 'listbox');
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleWrap(wrap); });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    sel._bcxWrap = wrap;
    wrap._bcxSel = sel;
  }
  function run() {
    // [实测 2026-10-11 答题屏] 这一趟是"三遍全文档查询"，而打字每敲一个字都带来一批变动
    // → 每帧一趟三遍全扫，两万个节点一页就是这么卡的。先花一次便宜的联合查询问"这页到底有没有
    // 要换皮的东西"，没有就直接退。下拉／药丸以后才出现的话，它插进 DOM 那一刻观察器照样叫醒
    // 这一趟（scheduleRun 挂的是 childList），行为一个字没变
    if (!document.querySelector('select, .mc-select-wrap, input[data-cid$="Select"]')) return;
    document.querySelectorAll('.mc-select-wrap').forEach(function (w) {
      var sel = w._bcxSel;
      if (!sel || !sel.isConnected) w.remove();
    });
    document.querySelectorAll('select').forEach(function (sel) {
      if (sel.closest('.cts-select, .cts-menu, #mc-settings')) return;
      var wrap = sel._bcxWrap;
      if (wrap && wrap.isConnected) { sync(sel); return; }
      build(sel);
      sync(sel);
    });
    // InstUI 自己画的那几颗下拉不是 <select>（它是一颗 input＋data-cid="SimpleSelect"），
    // 上面那段扫不到它。看得见的板子到底在 input 身上还是外面那层 facade 身上，
    // 两种形状我们都见过（Inbox 那三个是 facade 带描边），所以让 JS 判一次往上找最近的
    // facade、找不到就用它爹，CSS 只认我们这一个类名。补过就跳过，免得和观察器互相拉起
    // [实测 2026-10-04] 原来只认 SimpleSelect，结果 Add To Do 那座抽屉里时间那颗是 data-cid="TimeSelect"，
    // 整页只有课程那颗（SimpleSelect）被认到，屏幕上就是"四个框里只有一个换成了药丸"。
    // 后缀认一遍把 TimeSelect／MonthSelect 这些同族一起收进来，仍然只认 input，不会打到 InstUI 的按钮
    document.querySelectorAll('input[data-cid$="Select"]').forEach(function (inp) {
      if (inp.closest('.cts-select, .cts-menu, #mc-settings')) return;
      var box = inp.closest('span[class$="-textInput__facade"]') || inp.parentElement;
      if (box && !box.classList.contains('mc-plate-select')) box.classList.add('mc-plate-select');
    });
    /* 讨论区那座回复框的白板（"Write a reply" 整块）。它自己只带一颗哈希类名
       css-sdn7wy-view--block，CSS 端没有任何稳定口子能选中它（结构上它和分页那颗同形，
       实测 [data-testid="discussion-root-entry-container"] > div > div > span:only-child 命中 2 颗），
       而圆角必须落在它这一层——白板是白/粉的交界，收里面那层编辑器没用。
       所以照上面那颗下拉同一味药：JS 认一次、挂我们自己的类名，CSS 只认这一个。
       [实测 2026-10-13 两种入口分别点开] 顶部回复与"对某条评论 Reply"里，白板都是
       [data-testid="DiscussionEdit-container"] 的亲爹、都只有这一个孩子，所以一条就够。
       只在这一页扫（按地址判），别的页面一颗 DOM 都不问。 */
    if (/\/discussion_topics\/\d+/.test(location.pathname)) {
      document.querySelectorAll('[data-testid="DiscussionEdit-container"]').forEach(function (box) {
        var plate = box.parentElement;
        if (plate && !plate.classList.contains('mc-reply-plate')) plate.classList.add('mc-reply-plate');
      });
      /* 同一条理由：每条发言底下那一行操作（N Replies／Reply／Like／Mark as Unread）
         是 InstUI 的 InlineList，画成 <ul>＋每颗 <li data-testid="desktop-thread-tool">。
         要整行套一颗药丸就得改 <ul>，而它身上只有哈希类名 css-1dsa0if-view--block，
         CSS 端认不到"某颗 li 的爹"，所以照样挂一颗我们的类名，CSS 只认这个。
         [实测 2026-10-13 这一页] 75 颗工具分在 20 行里（每条发言一行，有的行三颗有的四颗），
         所以挂的是爹不是儿子，一行一颗。 */
      document.querySelectorAll('[data-testid="desktop-thread-tool"]').forEach(function (li) {
        var bar = li.parentElement;
        if (bar && !bar.classList.contains('mc-thread-tool-bar')) bar.classList.add('mc-thread-tool-bar');
      });
      /* ⋮ 那座菜单外面还有一层 InstUI ContextView 壳（纯白＋灰边＋4px 方角，比面板大 1px，
         于是粉板四周露出一圈白）。壳在面板往上第二层：中间还夹着一颗 css-<哈希> 的中转 span。
         壳身上只有哈希类名，而这一页别的浮层用的是同一种壳，按类名后缀改会连累它们，
         所以照上面两条同一味药：认结构＋挂我们自己的类名，CSS 只认 mc-menu-shell。
         认之前先验类名后缀（-view--block-contextView__content），对不上就不挂，免得哪天多夹一层挂错。 */
      document.querySelectorAll('[role="menu"][data-cid="Menu"]').forEach(function (menu) {
        var shell = menu.parentElement && menu.parentElement.parentElement;
        if (!shell || !/-view--block-contextView__content$/.test(String(shell.className))) return;
        if (!shell.classList.contains('mc-menu-shell')) shell.classList.add('mc-menu-shell');
      });
    }
  }
  var runQueued = false;
  // [实测 2026-10-06 收件箱页读数] 原来这条观察器每收到一批变动就整趟 run()：加载那 2 秒里跑了 126 趟，
  // 每趟三遍全文档扫描。合并到一帧一趟：rAF 在下一帧绘制之前，所以原生下拉还是闪不出来。
  function scheduleRun() {
    if (runQueued) return;
    if (location.pathname.includes('/conversations') && document.querySelector('.mc-plate-select')) return;
    runQueued = true;
    requestAnimationFrame(function () { runQueued = false; run(); });
  }
  try {
    run();
    new MutationObserver(scheduleRun).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('click', function () {
      document.querySelectorAll('.mc-select-wrap.open').forEach(closeWrap);
    });
  } catch (e) {
    console.error('[BCX] 下拉防闪引导失败', e);
  }
})();

/* =========================================================
 * List view 顶部那颗 Today 改文案：document_start 就位（防闪做法同上面几例）
 * content.js 的 dressPlannerToolbar() 也做这件事，但那份跟着 document_idle 注入——
 * [实测 2026-10-04] 这一页 domContentLoaded 702ms、window load 5659ms，而顶部那条工具栏
 * 在 load 之前一两秒就被 React 画出来了，于是屏幕上先是原生的 "Today"，等 content.js 跑到
 * 才翻成 "Jump to Today"（他报的"总要等半秒钟"）。
 * 做法和上面三例一字不差：观察器回调是微任务，那颗按钮一插进 DOM 就在同一帧把文案换掉，
 * "Today" 那一帧根本画不出来。content.js 里那份保留不删（它是兜底，判据相同：
 * 只有正好读到 "Today" 才动，已经换过的读回来是 "Jump to Today" 就不再碰），两边不打架。
 * 这里用 getElementById 而不是 querySelector：这一串挂在整文档的变动观察器上，每批都要跑一遍
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  function labelPlannerToday() {
    var btn = document.getElementById('planner-today-btn');
    if (!btn) return;
    var label = btn.querySelector('[class*="-baseButton__children"]') || btn;
    if (label.textContent.trim() === 'Today') label.textContent = 'Jump to Today';
  }
  // 这一串以前挂在 pathname 含 /planner 上，而仪表盘那颗 Today 在地址 / 上＝判据永远不成立，
  // 防闪那份一次都没跑，屏幕上还是先画 "Today"、等 content.js 的合并趟再翻。
  // 现在跟 content.js 的 isDashboardPage 同一口径：/ 、含 /dashboard 、或地址里没有斜杠
  var path = location.pathname;
  var onDashboard = path === '/' || path.includes('/dashboard') || !path.includes('/');
  if (onDashboard || path.includes('/planner') || location.search.includes('view=planner')) {
    try {
      labelPlannerToday();
      new MutationObserver(labelPlannerToday).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      console.error('[BCX] Today 文案防闪失败', e);
    }
  }
})();

/* =========================================================
 * 旧版课程卡的 custom-card-<id> 钩子：document_start 就位（防闪第四例）
 * 主题给每张卡贴的图和颜色膜，编译出来的规则作用域是 .custom-card-<课程id>，而这个类名
 * 原本由 content.js 的 mcCardHooks() 打——那份是 document_idle 加 2 秒一轮的取色轮，
 * 于是刷新之后整面卡片墙先是 Canvas 原生贴图，等它跑到才换过来（他报的"必须得等 1 秒"）。
 * 抄上面两例的做法：观察器回调是微任务，卡片一插进 DOM 就在同一帧把类名补完，画不出来那一帧。
 * content.js 里那份保留没删（它还要管新版卡那套 wash 类名），两边算的是同一个类名，不打架。
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  function hookOldCards() {
    var cards = document.querySelectorAll('.ic-DashboardCard');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
      var m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (!m) continue;
      var cls = 'custom-card-' + m[1];
      // 加之前先读，避免每次 DOM 变动都写一遍 className（写属性本身又是一次变动）
      if (card.className.indexOf(cls) === -1) card.classList.add(cls);
    }

    // 首帧防缩团防闪烁：一旦卡片在 DOM 诞生，立即在浏览器首画前排好瀑布流位置，杜绝缩成一团！
    if (cards.length && (localStorage.getItem('bc_card_layout') || 'masonry') === 'masonry') {
      var container = document.querySelector('.ic-DashboardCard__box__container');
      if (container && !container.hasAttribute('data-bcx-masonry')) {
        var total = container.clientWidth;
        if (total > 200) {
          var GAP = 16;
          var cols = window.innerWidth >= 1200 ? 4 : window.innerWidth >= 900 ? 3 : 2;
          var tops = new Array(cols).fill(0);
          /* 列宽和横坐标写百分数，和 content.js 那份逐字同一串（那边 2026-10-10 改的：
             像素那一档在侧栏收放／面板推挤的动画里要按帧重排才跟得上，百分数浏览器自己算）。
             两边写的串必须一模一样，否则 content.js 头一趟会把每颗卡的 width 再换一次 */
          var WEXPR = 'calc((100% - ' + GAP * (cols - 1) + 'px) / ' + cols + ')';
          container.setAttribute('data-bcx-masonry', '');
          for (var j = 0; j < cards.length; j++) {
            var c = cards[j];
            c.style.setProperty('width', WEXPR, 'important');
            var minCol = 0;
            for (var k = 1; k < cols; k++) {
              if (tops[k] < tops[minCol] - 0.5) minCol = k;
            }
            c.style.left = minCol ? 'calc(' + minCol + ' * (100% + ' + GAP + 'px) / ' + cols + ')' : '0px';
            c.style.top = Math.round(tops[minCol]) + 'px';
            var h = c.offsetHeight || 250;
            tops[minCol] += h + GAP;
          }
          var maxH = Math.max.apply(null, tops) - GAP;
          if (maxH > 0) container.style.minHeight = Math.round(maxH) + 'px';
          container.dataset.mcGeo = total + 'x' + cards.length;
        }
      }
    }
  }
  /* 这一条观察器以前只在"开页那一刻地址就是首页"时才挂。从别的页面点进首页是不刷新文档的：
     地址变了，这份脚本却早就跑完了，观察器压根没挂上——那一屏卡片只能等 content.js 每 2 秒
     一轮的 mcCardHooks()，中间那段就是报上来的"贴图短暂变回原版"。
     现在无条件挂，判据换成"这一批变动里到底有没有卡片"：非首页没有 .ic-DashboardCard，
     早退立刻返回，不做全页扫、更不读 offsetHeight。 */
  function needsCardHook(ms) {
    for (var i = 0; i < ms.length; i++) {
      var rec = ms[i];
      if (rec.type === 'attributes') {
        // Canvas 重渲染会按它自己那份 class 把整张卡重写一遍，我们的钩子跟着丢；
        // 丢的那一下不是新增节点，只有认属性变动才看得见
        var t = rec.target;
        if (t.nodeType === 1 && t.classList && t.classList.contains('ic-DashboardCard')
          && t.className.indexOf('custom-card-') === -1) return true;
        continue;
      }
      if (rec.type !== 'childList') continue;
      for (var j = 0; j < rec.addedNodes.length; j++) {
        var nd = rec.addedNodes[j];
        if (nd.nodeType !== 1) continue;
        if (nd.matches && nd.matches('.ic-DashboardCard')) return true;
        // 先读一次属性当门：没有子元素的节点（文字那颗 span、svg）根本装不下卡片，
        // 不必再为它跑一遍子树查询
        if (nd.firstElementChild && nd.querySelector && nd.querySelector('.ic-DashboardCard')) return true;
        // 卡先挂上来、里面那颗带 /courses/<id> 的链接后到：只认"新增的是卡片"会漏掉这一批，
        // 而 hookOldCards 判课程号靠的正是那颗链接——漏掉的那一张没有第二次机会补
        if (nd.parentElement && nd.parentElement.closest
          && nd.parentElement.closest('.ic-DashboardCard')) return true;
      }
    }
    return false;
  }
  try {
    hookOldCards();
    new MutationObserver(function (ms) {
      if (needsCardHook(ms)) hookOldCards();
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class']
    });
  } catch (e) {
    console.error('[BCX] 课程卡钩子引导失败', e);
  }
})();

/* =========================================================
 * Dashboard 那颗搜索框：document_start 就位（防闪第五例）
 * 它是 atomic-search 自定义元素，样式关在 open shadow root 里，manifest 注入的 style.css
 * 伸不进去，只能往 shadowRoot 内追加一个 style 节点。原本这一注是 content.js 的
 * dressAtomicSearch() 干的（document_idle + 300ms 合并那一趟），所以刷新后搜索框会先闪
 * 一帧组件自带的白底蓝放大镜。
 * 下面这份 CSS 和 content.js 的 ATOMIC_SEARCH_CSS 必须逐字对齐——两份都注同一个 id
 * （canvas-atomic-search-css），谁先到就用谁的，后到的那份看到节点已存在就跳过。
 * 里面读的是 --mc-* 那组变量：自定义属性穿得过 shadow 边界，值由本文件上面那段在首帧写好。
 * content.js 那份保留（它还要管 autocomplete 和 shadow 内的重挂观察器）。
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  var CSS = `
    input[id^="ajas-search"] {
      box-sizing: border-box !important;
      height: 36px !important;
      border: none !important;
      border-radius: 999px !important;
      background: var(--mc-buttons) !important;
      padding: 2px 42px 0 16px !important;
      line-height: 34px !important;
      color: var(--mc-text-0) !important;
      box-shadow: none !important;
      outline: none !important;
      transition: background-color 0.15s ease, box-shadow 0.15s ease !important;
    }
    input[id^="ajas-search"]::placeholder {
      color: var(--mc-text-1) !important;
      opacity: 1 !important;
    }
    input[id^="ajas-search"]:hover,
    input[id^="ajas-search"]:focus,
    input[id^="ajas-search"]:focus-visible,
    input[id^="ajas-search"][aria-expanded="true"] {
      background: var(--mc-buttons) !important;
      box-shadow: inset 0 0 0 1.5px var(--mc-hover-ring) !important;
      outline: none !important;
    }
    .ajas-search-widget__btn-group {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      height: 100% !important;
      top: 0 !important;
      bottom: 0 !important;
    }
    .ajas-search-widget__btn--search {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 0 !important;
      margin: 0 !important;
      height: 100% !important;
    }
    .ajas-search-widget__btn--search svg,
    .ajas-search-logo {
      display: block !important;
      margin: auto !important;
    }
    .ajas-search-logo .logo-rect { fill: none !important; }
    .ajas-search-logo .logo-path {
      fill: var(--mc-text-1) !important;
      transition: fill 0.15s ease !important;
    }
    .ajas-search-widget__btn--search:hover .logo-path,
    .ajas-search-widget__btn--search:focus-visible .logo-path {
      fill: var(--mc-text-0) !important;
    }
  `;
  function dress() {
    var hosts = document.querySelectorAll('atomic-search-desktop-widget, atomic-search-mobile-widget');
    for (var i = 0; i < hosts.length; i++) {
      var shadow = hosts[i].shadowRoot;
      // 组件在构造函数里就建了 open shadow root，但没建好也不能抛，判一下再走
      if (!shadow) continue;
      /* 站点那句 "Search my courses" 名不副实：结果框那一路跨所有课程找作业、页面、文件、收件箱。
         和 content.js 的 mcxSearchPlaceholder 一字一样：这边管首帧不闪原文，那边管组件重挂之后 */
      var ins = shadow.querySelectorAll('input');
      for (var j = 0; j < ins.length; j++) {
        var inp = ins[j];
        if (!inp.dataset.mcxPlaceholder && inp.placeholder) inp.dataset.mcxPlaceholder = inp.placeholder;
        var off = localStorage.getItem('mc_search_box') === '0';
        var want = off ? (inp.dataset.mcxPlaceholder || '') : 'Search Canvas';
        if (inp.placeholder !== want) inp.placeholder = want;
      }
      if (shadow.getElementById('canvas-atomic-search-css')) continue;
      var style = document.createElement('style');
      style.id = 'canvas-atomic-search-css';
      style.textContent = CSS;
      shadow.appendChild(style);
    }
  }
  var searchObs = null;
  try {
    dress();
    searchObs = new MutationObserver(dress);
    searchObs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () {
      if (searchObs) { searchObs.disconnect(); searchObs = null; }
    }, 4000);
  } catch (e) {
    console.error('[BCX] 搜索框防闪引导失败', e);
  }
})();

/* =========================================================
 * 成绩页那一排（三颗按钮／三个筛选框／权重表）的防闪引导
 * content.js 那份是 document_idle 才跑到，于是首帧先画站点那套方框、半秒后才换成胶囊
 * ＝他报的"刚进入会闪回 Canvas 自带的造型"。做法和上面几例一样：观察器回调是微任务，
 * 节点一进 DOM 就在同一帧把类名补上，那一帧画不出来。样式一律在 style.css，这里只加类。
 * 按钮与筛选框：站点那边给不出可靠类名（InstUI 的类是哈希的），所以按"屏幕上那行字"认。
 * 权重表不用这条路：站点在 grade_summary.html.erb:67 给了 #assignments-not-weighted，表自己是 table.summary，
 * 样式直接认这两层，不再有"文字＋几何挑表"那一趟。
 * ========================================================= */
(function () {
  if (!window.mcIsCanvas) return;
  var PLATE = 'mc-plate-btn', BAND = 'mc-grades-filter', FLAT = 'mc-flat-select';
  // 这一页下半块那几颗纯文字按钮。What-If 那颗屏幕上带弯引号，站点两种都写过，
  // 所以 row() 先把弯引号洗成直引号，名单里只留直引号那一份。
  // 最后那颗是我们自己补在 Print Grades 右边的 Message Your Teacher：
  // 它要走和 Print Grades 一模一样的换皮，所以必须也在这份名单里，不在就会一个胶囊一个方框
  var WANT = ['Print Grades', 'Show All Details', 'Apply', 'Revert to Actual Score',
    'Show Saved "What-If" Scores', 'Message Your Teacher'];
  /* 这一排筛选框是条件渲染的（源码 ui/shared/.../SelectMenuGroup.tsx:218 与 :236）：
     只有一门课的学校不画 Course 那颗，没开时段的学校不画 Grading Period 那颗，
     有的学校第三颗写的是 Student。所以这一串只是"可能出现的名字"，实到几个算几个 */
  var SAY = ['Grading Period', 'Course', 'Arrange By', 'Student'];
  document.documentElement.classList.add('mc-grades-plate');
  function row(s) { return String(s == null ? '' : s).replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); }
  /* 站点自己的其它语言文案大小写不一样（en-GB 写 "Show all details"、en-AU 把 Print Grades
     写成 "Print Marks"）：按屏幕上那行字认的时候统一折成小写再比 */
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  function ownText(el) {
    var parts = [];
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) parts.push(el.childNodes[i].textContent);
    return row(parts.join(' ')) || row(el.innerText || el.textContent || '') || row(el.value || '');
  }
  // Apply 那颗的整块文字是 "ApplyApply filters. Note: clicking this button will cause the
  // page to reload."——站点在按钮里塞了一条只给读屏器看的说明，整块相等这条判据会被它顶掉，
  // 所以除了正好相等，也认"以这句话开头、后面还跟着一句"
  function isText(el, txt) {
    var t = lower(ownText(el)), want = lower(txt);
    if (t === want) return true;
    if (t.length <= want.length || t.slice(0, want.length) !== want) return false;
    /* 浏览器里两个 span 之间 innerText 会插一个换行（row() 收成一个空格），
       但 textContent 那条路没有这个空格：站点把读屏说明紧贴在字后面时读到的是
       "ApplyApply filters. Note:…"，charAt(5) 是 'A' 不是空格＝判据当场落空，
       那一颗就一直是原生方框。所以空格和"后面又重复一遍这句话"两种都算 */
    var rest = t.slice(want.length);
    return /^\s/.test(rest) || rest.indexOf(want) === 0;
  }
  function add(el, cls) { if (el && !el.classList.contains(cls)) el.classList.add(cls); }
  /* 墨色再补一条行内 !important：样式表那条压不住站点主按钮配白字那种写法时，
     行内 !important 压得住。值没变就不写（写属性本身又是一次 DOM 变动，会和观察器互相拉起）*/
  function inkOn(el) {
    var want = 'var(--mc-text-0)';
    if (el.style.getPropertyValue('color') !== want) el.style.setProperty('color', want, 'important');
  }
  function labelOf(scope, txt) {
    var all = scope.querySelectorAll('label, span, div, p, h2, h3'), hit = null, want = lower(txt);
    for (var i = 0; i < all.length; i++) if (lower(row(all[i].textContent)) === want) hit = all[i];
    return hit;
  }
  var foundWant = [], wantDone = 0, stalled = 0, bandResolved = false;
  function dress(scope) {
    // 1) 三颗纯文字按钮：整页也就几十颗按钮，每趟都扫（右侧那一块比筛选条晚挂，
    //    只补一次就会漏掉它们——上一版就是这么漏的）
    // 不只认 <button>：站点这两颗是链接做的按钮（<a class="no-print">那一类，可访问树上
    // 也报成 button），按 tag 筛就会漏——Apply 上一版就是这么漏掉的。文字必须整句相等，
    // 所以放宽到所有链接／按钮也不会牵连别的东西
    if (wantDone < WANT.length) {
      var btns = scope.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], .Button');
      for (var i = 0; i < btns.length; i++) {
        for (var k = 0; k < WANT.length; k++) {
          if (isText(btns[i], WANT[k])) { add(btns[i], PLATE); inkOn(btns[i]); foundWant[k] = true; break; }
        }
      }
      var now = foundWant.filter(Boolean).length;
      /* 这一趟没捡到新的、而且筛选框那组已经补全：那就停。
         按文字扫全页按钮是这一串里最贵的一步，站点每动一次属性都要重跑一遍的话，
         打字那一趟的样式重算又要被我们叠一层 */
      if (now === wantDone && bandResolved) stalled++;
      else stalled = 0;
      if (stalled >= 3) wantDone = WANT.length;
      else wantDone = now;
    }
    // 2) 权重表：认那行标题，然后按"在标题下面、行数少（这张五行）、没铺满整块"挑表。
    //    不写成"从标题往上爬找第一张表"——爬过头就爬到整页那张作业大表上了
    // [MC 2026-10-15] 下面这段"文字+几何认权重表"整段停用：样式已改成直接认站点自己的
    // #assignments-not-weighted table.summary（canvas-lms app/views/gradebooks/grade_summary.html.erb:67 与
    // courses/_sidebar_weighting.html.erb:25）。等你在页面上验过排版没变，这段再删。
//    if (!document.querySelector('.' + TABLE)) {
//      var head = labelOf(scope, 'Assignments are weighted by group:');
//      if (head) {
//        var hr = head.getBoundingClientRect(), tbs = scope.querySelectorAll('table'), tb = null, top = 1e9;
//        for (i = 0; i < tbs.length; i++) {
//          var r = tbs[i].getBoundingClientRect();
//          if (tbs[i].rows.length < 2 || tbs[i].rows.length > 10) continue;
//          if (r.width < 80 || r.height < 20) continue;
//          if (r.top < hr.bottom - 6) continue;
//          if (Math.abs(r.left - hr.left) > 60) continue;
//          if (r.top < top) { top = r.top; tb = tbs[i]; }
//        }
//        if (tb) add(tb, TABLE);
//      }
//    }
    // 3) 三个下拉：补全过就整段跳过（这一段要按文字扫全页标签，是这一串里最贵的）
    var band = document.querySelector('.' + BAND);
    if (band && band.hasAttribute('data-mc-grades')) return;
    /* 原来要 SAY[0] 和 SAY[2] 两颗同时存在才往下走：只有一门课的学校没有 Course 那颗，
       整组筛选就一行不画，只剩全局那条矮一档的兜底＝同一排按钮 42 高、下拉矮一截 */
    var present = [];
    for (i = 0; i < SAY.length; i++) { var lab = labelOf(scope, SAY[i]); if (lab) present.push(lab); }
    /* 这一页压根没有筛选框（普通课只画 Arrange By，一颗都不画的情形也存在）。
       记一笔"筛选这一关已经定论"，否则上面那颗停手判据永远不成立，
       站点每动一次属性就要重扫一遍全页按钮——打字那一趟又被我们叠一层 */
    if (!present.length) { bandResolved = true; return; }
    band = present[0].parentElement;
    for (i = 0; i < 5 && band; i++) { if (band.contains(present[present.length - 1])) break; band = band.parentElement; }
    if (!band || !band.contains(present[present.length - 1])) { band = present[0].parentElement || present[0]; }
    add(band, BAND);
    var bandW = band.getBoundingClientRect().width;
    var cands = [], raw = band.querySelectorAll('select, [role="combobox"], [aria-haspopup="true"]');
    for (i = 0; i < raw.length; i++) if (!raw[i].closest('.mc-select-wrap')) cands.push(raw[i]);
    var claimed = [], hit = 0;
    present.forEach(function (lab) {
      var lr = lab.getBoundingClientRect(), best = null, bestDx = 1e9;
      cands.forEach(function (c) {
        if (claimed.indexOf(c) >= 0) return;
        var r = c.getBoundingClientRect();
        if (r.width < 40 || r.height < 16) return;
        if (r.top < lr.bottom - 6) return;
        var dx = Math.abs(r.left - lr.left);
        if (dx < bestDx) { bestDx = dx; best = c; }
      });
      if (!best) return;
      claimed.push(best);
      var box = best, cur = best.parentElement;
      while (cur && cur !== band) {
        var r2 = cur.getBoundingClientRect();
        if (!(r2.height > 0 && r2.height <= 64 && r2.width >= 80 && r2.width <= bandW - 8)) break;
        box = cur;
        cur = cur.parentElement;
      }
      if (box !== band) { add(box, FLAT); hit++; }
    });
    if (hit >= present.length) { band.setAttribute('data-mc-grades', '1'); bandResolved = true; }
  }
  function pass() {
    if (!/\/courses\/\d+\/grades/.test(location.pathname)) return;
    // 整份文档当范围：这一页下半块那几颗在右侧那一栏里，#content 在不在、包不包得住它
    // 我这一趟读不到你的页面，按文字认的筛子本来就很窄（整页按钮也就几十颗），不必再自己加一层
    dress(document);
    if (!mcGradesLogged) {
      mcGradesLogged = true;
      console.log('[BCP83] 成绩页引导跑过一趟：按钮', document.querySelectorAll('.' + PLATE).length,
        '颗／胶囊', document.querySelectorAll('.' + FLAT).length,
        '颗／表', document.querySelectorAll('#assignments-not-weighted table.summary').length,
        '张／行', document.querySelectorAll('table').length);
    }
  }
  var mcGradesLogged = false;
  // 站点是 React 的，一秒能报几十批变动；这一串要按文字扫页面，所以合并到每帧一趟、
  // 两趟之间最少隔 200 毫秒。跳过的那一趟自己再补一次定时器，不然最后一批变动会被漏掉
  var queued = false, lastAt = 0, retry = 0, bootAt = Date.now();
  // 那道 200 毫秒的地板是给"已经补全、只是站点偶尔重画"那种情况省 CPU 的。
  // 首屏还没补全时它会把刚插进来的节点压住 200 毫秒再上类＝屏幕上就是原生方框闪 0.2 秒。
  // 所以：没补全时每帧跑一趟（最多追 3 秒，追不到就算了，别把 CPU 挂死），补全之后才回到 200 毫秒
  function dressed() {
    return !!document.querySelector('.' + BAND + '[data-mc-grades]') &&
      !!document.querySelector('.' + PLATE);
  }
  function run() {
    queued = false;
    var full = dressed();
    var wait = full ? lastAt + 200 - Date.now() : 0;
    if (wait > 0) { if (!retry) retry = setTimeout(function () { retry = 0; schedule(); }, wait); return; }
    lastAt = Date.now();
    try { pass(); } catch (e) {}
    if (!full && Date.now() - bootAt < 3000) schedule();
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(run); } }
  // 仅在成绩页挂载此观察器，绝不污染仪表盘与通用页面
  if (/\/courses\/\d+\/grades/.test(location.pathname)) {
    try { pass(); } catch (e) { console.error('[BCX] 成绩页引导首趟失败', e); }
    try {
      /* 原来只听 childList：站点那一排筛选是"节点早就在、style 后开来"
         （index.jsx:691 ← SelectMenuGroup.tsx:96 componentDidMount 才显形），
         隐藏期间量到的宽都是 0，候选全被 r.width < 40 筛掉；3 秒一放弃就再也没有变动来重跑，
         症状是慢机器上整排筛选不换皮，等他点开菜单才突然变成胶囊 */
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) {
      console.error('[BCX] 成绩页引导挂不上观察器', e);
    }
  }
})();
