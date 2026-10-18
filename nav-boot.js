/* =========================================================
   侧栏那一列行的自定义：顺序／上下区／显隐 —— 引擎本体
   一份 mc_nav_layout_v1 管这三件事。没存过时一行都不搬，所以默认就是站点自己那一版，
   只有在设置里排完并点 Apply 之后它才开始动手。

   为什么单独一份文件、还排在 document_start：这套逻辑原先整段待在 content.js 里，
   而那份是 document_idle。Canvas 的服务端 HTML 里 #menu 带着它自己那个先后先画出来，
   我们这一版要等 content.js 跑完才摆上去，中间那几秒就是他报的"列表项目顺序不对"。
   现在导航列表一插进 DOM 就在同一个微任务里摆好，浏览器还没画这一帧，闪不出来。
   先例：原生 select 换胶囊那套也是这么搬进 document_start 的（见 theme-boot.js 的"防闪第三例"）。

   引擎只此一份。content.js 里同名那几颗（mcNavHosts／mcNavLive／mcNavLayout／
   mcApplyNavLayout／navToggleEl）现在只是转调这里的薄壳：两边各写一套就是
   "首帧摆一份、半秒后换成另一份"，那比不摆还糟。
   ========================================================= */
(function () {
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

  // 键怎么取：站点那几行用它们自己的地址（换一所学校、行上的文字被改，只要地址没变顺序还在），
  // 没地址的那两颗（Search、Help）用行上的文字；我们自己造的四行用固定名。
  var KEY = 'mc_nav_layout_v1';

  // 那颗在 Canvas 各版本里换过 id 和类名，可访问名一直是 "Minimize global navigation"
  var BCX_NAV_TOGGLE = '#primaryNavToggle, .ic-app-header__menu-list-link--nav-toggle, [data-button="toggle_nav"]';
  var BCX_NAV_TOGGLE_NAMED = '[aria-label*="global navigation" i]';

  function navToggleEl() {
    const exact = document.querySelector(BCX_NAV_TOGGLE);
    if (exact) return exact;
    // 兜底这条最宽：包着整列那层的可访问名也叫 "Global navigation"，选中它会把普通导航行的
    // 点击一起截走、还会把 Settings 插到列表外面去。所以只认里面没有别的导航行的那一颗——
    // 收起那颗里面只有一张图，容器里必然还装着别的行。
    // 第二道排除是给 document_start 用的：这份脚本现在排在解析中途跑，那一列刚开一个头、
    // 里面还一颗行都没解析出来的时候，上面那条"里面没有别的导航行"根本判不出来，
    // 包着整列的那层会被当成收起那颗。直接点名"装着列表的就不是键"，不靠里面有没有行
    const named = [...document.querySelectorAll(BCX_NAV_TOGGLE_NAMED)]
      .find(el => !el.querySelector('.ic-app-header__menu-list-link')
        && !el.querySelector('#menu, #ic-app-header__menu-list'));
    return named || null;
  }
  function mcNavHosts() {
    const top = document.querySelector('#ic-app-header__menu-list, #menu');
    const toggle = navToggleEl();
    const footLi = toggle ? (toggle.closest('li') || toggle) : null;
    return { top: top, bottom: footLi ? footLi.parentNode : null, footLi: footLi };
  }

  function mcNavLabelOf(li) {
    const t = li.querySelector('.menu-item__text');
    return String((t ? t.textContent : li.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 28);
  }

  function mcNavKeyOf(li, footLi) {
    if (!li || li.tagName !== 'LI') return '';
    if (li === footLi) return 'nav:toggle';
    if (li.classList.contains('mc-nav-bc')) return 'ours:bc';
    if (li.classList.contains('mc-nav-courses')) return 'ours:courses';
    if (li.classList.contains('mc-nav-report-item')) return 'ours:report';
    if (li.classList.contains('mc-nav-study-item')) return 'ours:study';
    if (li.classList.contains('mc-nav-settings-item')) return 'ours:settings';
    const a = li.querySelector('a[href]');
    if (a && a.getAttribute('href') !== '#') {
      try { return 'nav:' + new URL(a.href, location.origin).pathname; } catch (e) {}
    }
    const label = mcNavLabelOf(li);
    return label ? 'row:' + label : '';
  }

  // 现场这一列：[{k,label,zone,li}]，按屏幕上的先后排（上区整段在前，下区那段在后）
  function mcNavLive() {
    const hs = mcNavHosts();
    const out = [];
    const seen = {};
    const walk = (host, zone) => {
      if (!host) return;
      Array.prototype.forEach.call(host.children, li => {
        if (li.tagName !== 'LI') return;
        const k = mcNavKeyOf(li, hs.footLi);
        if (!k || seen[k]) return;
        seen[k] = 1;
        out.push({ k: k, label: mcNavLabelOf(li) || k, zone: zone, li: li });
      });
    };
    walk(hs.top, 'top');
    if (hs.bottom !== hs.top) walk(hs.bottom, 'bottom');
    return out;
  }

  function mcNavLayout() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Array.isArray(raw) ? raw : null;
    } catch (e) { return null; }
  }

  /* 把一层的行按目标顺序摆好。先整列比一遍，顺序已经对了就一个节点都不碰——
     这一层挂在 DOM 变动监听上，原地反复插会变成我们和观察器互相触发 */
  function mcNavOrderHost(host, want, tail) {
    if (!host || !want.length) return;
    const set = new Set(want);
    // 只比"布局里点到的那几行"的相对先后。现场还可能有重复地址的行、我们认不出的行，
    // 把它们算进比较会让顺序永远"不对"，于是每一轮都重插一次，和 DOM 变动监听互相触发
    const cur = Array.prototype.filter.call(host.children, li => set.has(li));
    if (cur.length === want.length && cur.every((li, i) => li === want[i])) return;
    let ref = tail && tail.parentNode === host ? tail : null;
    for (let i = want.length - 1; i >= 0; i--) {
      if (want[i].parentNode === host && want[i].nextElementSibling === ref) { ref = want[i]; continue; }
      host.insertBefore(want[i], ref);
      ref = want[i];
    }
  }

  // 落点：每轮在四行各自挂好之后跑，所以这里只管摆位置和显不显示
  function mcApplyNavLayout() {
    const saved = mcNavLayout();
    if (!saved || !saved.length) {
      // 恢复默认＝把键删掉，但藏行是挂在行上的类名：不在这儿摘一遍，站点那几行会一直藏着
      mcNavLive().forEach(r => r.li.classList.remove('mc-nav-row-off'));
      return;
    }
    const hs = mcNavHosts();
    if (!hs.top) return;
    const live = mcNavLive();
    const byKey = {};
    live.forEach(r => { byKey[r.k] = r; });
    const want = { top: [], bottom: [] };
    const planned = {};
    saved.forEach(r => {
      const row = r && byKey[r.k];
      if (!row || planned[r.k]) return;
      planned[r.k] = 1;
      const z = r.zone === 'bottom' && hs.bottom ? 'bottom' : 'top';
      row.li.classList.toggle('mc-nav-row-off', r.on === 0 || r.on === false);
      want[z].push(row.li);
    });
    // 没在布局里出现的行（学校新加的、或我们还没挂上的）留在它现在那一层的末尾，不丢掉也不置顶
    live.forEach(r => {
      if (planned[r.k]) return;
      want[r.zone === 'bottom' && hs.bottom ? 'bottom' : 'top'].push(r.li);
    });
    mcNavOrderHost(hs.top, want.top, null);
    if (hs.bottom && hs.bottom !== hs.top) mcNavOrderHost(hs.bottom, want.bottom, hs.footLi);
  }

  /* =========================================================
     ===== 我们自己在导航里造的那四行的壳 =====
     这四行（Settings／Report a bug／Courses 分区／BetterCampus 分组）加后来补的 Study With AI 那一行，和底部那颗收起键上的字，
     原先全在 content.js 里造，而那份是 document_idle：导航早就画出来了，这四行要等整页解析完
     才补上，中间那半秒就是"侧栏不显示 Courses／BetterCampus／Report a Bug／Settings，
     Collapse 那颗也没有字"。壳是死的，挪到这里首帧就画；点击和每轮要刷的文字仍归 content.js，
     它那些 mount 函数一进来先 querySelector 找现成的那一颗，找得到就只补不重建。
     造壳和判开关读的是同一批键，两边共用一份，不会出现"这里造了、那里又拆掉"。
     ========================================================= */

  // 跟 To-Do 面板原来那颗齿轮是同一份图形，像素一致
  var GEAR_PATH = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';
  // 和那颗齿轮同一套 24×24 实心图形，靠 fill="currentColor" 吃导航的文字色
  var BUG_PATH = 'M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15 1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z';
  // AI 总结那一行：两颗星，和 BetterCampus 分组那颗实心画法一致（fill=currentColor 吃导航文字色）。
  // 行上的字他拍定 "Study With AI"；BC 自己那四行里仍有一颗 Study，两颗挨着时靠名字前缀分
  var STUDY_PATH = 'M11.5 3.2l1.5 4.3 4.3 1.5-4.3 1.5-1.5 4.3-1.5-4.3L5.7 9l4.3-1.5zM18 14.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z';
  /* 这一颗就是我们整个产品里"AI"那个记号。别处要画它必须从这里取同一串路径，
     不许再照着描一份：侧栏那一行和收件箱里那几颗长得不一样是会被看出来的。 */
  window.MCxIcon = { ai: STUDY_PATH };
  var CHEVRON_DOWN = '<svg class="mc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
  var CHEVRON_RIGHT = '<svg class="mc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L14.17 12z"/></svg>';
  // 分区标题那颗图标：毕业帽，跟 Canvas 原生 Courses 那颗同语义。放 .ic-icon-svg 里吃 22px 槽位锁
  var COURSES_ICON = '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L1 8l11 5 9-4.09V14h2V8L12 3zM4 13.18V16c0 1.66 3.58 3 8 3s8-1.34 8-3v-2.82l-8 3.64-8-3.66z"/></svg></span>';
  // 分组标题那颗：星形，跟课程分区那颗毕业帽同一种实心画法（fill=currentColor，跟着标签色走）
  var BC_ICON = '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.6l2.5 6.5 7 .3-5.4 4.4 1.8 6.8L12 17.2 5.9 20.6l1.8-6.8L2.3 9.4l7-.3z"/></svg></span>';

  // 那颗提示：展开态在 "Settings" 下面另起一行写整句话，收起那一列只有 74 像素宽，
  // 字由 CSS 藏掉、只剩一颗点（色跟左边标签同源，走 --mc-nav-ink）
  var CLASH_HTML = '<span class="mc-nav-clash" title="Two themes are painting this page. Click to choose which one.">'
    + '<i class="mc-nav-clash-dot" aria-hidden="true"></i>'
    + '<span class="mc-nav-clash-word">You have two themes activated</span>'
    + '</span>';

  /* 照明不一致那句（深色／浅色和 BetterCampus 对不上）。字是空的，每轮按当前那一档填进去，
     所以不会出现"他翻了档、侧栏还在说另一种模式"。
     这颗不接点：它只说"两边要对齐"，对齐要去哪一颗开关，Settings 那一行本身就会带他进面板 */
  var LIGHTING_HTML = '<span class="mc-nav-lighting">'
    + '<i class="mc-nav-lighting-dot" aria-hidden="true"></i>'
    + '<span class="mc-nav-lighting-word"></span>'
    + '</span>';

  // ===== 侧栏里的 External Extension 分组（Planner / Study / Notes / Grades）=====
  // 这四页是它自绘侧栏里的行，跳转形状＝站内根路径加一个查询参数（External Extensionpage=…）。
  // 但实测（[BCP70]）：把地址栏直接改成那个参数再整页刷新，它不认，只有它自己的点击路由认。
  // 所以我们不跳网址，改成在它的 shadow DOM 里找到那颗 <a> 替用户点一下（同 [BCP69] 那颗齿轮）。
  // 整组只在 BC 在跑时出现（html.mc-bc-live 门控在 style.css 第 5 节末尾），BC 一关四行一起消失。
  var BC_PAGES = [
    { key: 'planner', label: 'Planner', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 15H5V9h14v10z' },
    { key: 'study', label: 'Study', icon: 'M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 4h5v8l-2.5-1.5L6 12V4z' },
    { key: 'notes', label: 'Notes', icon: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' },
    { key: 'grades', label: 'Grades', icon: 'M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z' }
  ];

  // 两颗开关各管一行：关掉＝这一行压根不该在。摘节点归这里，content.js 那边只补内容和点击
  function reportRowOn() { return localStorage.getItem('mc_nav_report_bug') !== '0'; }
  function coursesRowOn() { return localStorage.getItem('mc_sidebar_courses') !== '0'; }
  // AI 总开关关掉时这一行压根不该在：那一颗是画在页面里的 AI 入口，不是设置里的控件
  function studyRowOn() {
    return (!window.mcAiOn || window.mcAiOn()) && localStorage.getItem('mc_ai_entry') !== '0';
  }

  // 侧栏底部那颗：图标右边要有一行常驻的字（跟上面几行一样），可访问名跟着这行字走。
  // Canvas 画的那颗图形各版本不一样（不是 <svg>），所以不去认它的类名，
  // 而是把它连同它的兄弟子节点一起套进我们自己的槽位层——翻箭头翻的是槽位，
  // 不管里面是谁、也不管别的脚本往它身上写过行内 transform，旋转都叠得上、字不会被转倒
  function syncNavToggleLabel() {
    const toggle = navToggleEl();
    if (!toggle) return;
    // 那颗的 id 和类名各版本不一样，CSS 那条箭头翻转靠这个我们自己的类名认它
    toggle.classList.add('mc-nav-toggle');
    const word = document.documentElement.classList.contains('mc-nav-min') ? 'Expand' : 'Collapse';
    // 可访问名保留站点那句 "…global navigation"：认这颗的兜底选择器就是按这句话找的
    // （navToggleEl 的 BCX_NAV_TOGGLE_NAMED），同时它开头就是这行看得见的字，读屏和画面不打架
    const want = word + ' global navigation';
    if (toggle.getAttribute('aria-label') !== want) toggle.setAttribute('aria-label', want);

    let text = toggle.querySelector('.mc-nav-toggle-text');
    if (!text) {
      text = document.createElement('span');
      // 带上 .menu-item__text：字号、左距、富余空间归文字这几条现成规则直接命中，不用另写一档
      text.className = 'menu-item__text mc-nav-toggle-text';
      text.setAttribute('aria-hidden', 'true');
      toggle.appendChild(text);
    }
    if (text.textContent !== word) text.textContent = word;

    let slot = toggle.querySelector('.mc-nav-toggle-slot');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'mc-nav-toggle-slot';
      slot.setAttribute('aria-hidden', 'true');
      toggle.insertBefore(slot, toggle.firstChild);
    }
    // 只搬元素，我们自己的两层原地不动：Canvas 重渲染换新节点后，这一趟会把它收回槽位。
    // 搬完它就不是按钮的子节点了，下一趟没有东西可搬，不会跟变动监听互相触发
    for (const kid of [...toggle.children]) {
      if (kid === slot || kid === text) continue;
      slot.appendChild(kid);
    }
  }

  // Settings 那颗的宿主：底部那颗自己就贴在导航栏最下面，而且它跟上面那几行不在同一层里。
  // 上一版把 Settings 塞进上面那个列表的尾部，结果它停在 Grades 下面、没有沉到底
  function settingsMount() {
    const toggle = navToggleEl();
    const anchor = toggle ? (toggle.closest('li') || toggle) : null;
    const host = anchor ? anchor.parentNode : null;
    if (host) return { host: host, anchor: anchor };
    // 认不出底部那颗才退回导航列表：各版本这一列的 id 不一样
    // （新的是 #ic-app-header__menu-list，老的是 #menu），都不命中就退到"第一颗导航行的爹"
    const firstItem = document.querySelector('.ic-app-header__menu-list-item');
    return { host: document.querySelector('#ic-app-header__menu-list, #menu') || (firstItem && firstItem.parentNode), anchor: null };
  }

  // Courses 分区挂进真正的导航列表 #menu 末尾，这样它紧跟在最后一颗按钮（Grades）下面。
  // 底部那颗收起按钮通常不在 #menu 里（它是 #primaryNavToggle），Settings 那颗是我们钉在 footer 的；
  // 上一版误用了 footer 那层当宿主，才把整个分区甩到底部跟 Settings 挤在一起。
  function coursesMount() {
    const menu = document.querySelector('#ic-app-header__menu-list, #menu');
    if (!menu) {
      const firstItem = document.querySelector('.ic-app-header__menu-list-item');
      return { host: firstItem && firstItem.parentNode, anchor: null };
    }
    // 如果底部自造项（Study / Report / Settings）挂在同一个列表 menu 中，
    // Courses 应当插在它们上方，绝对不能跟 Settings 抢同一个 footLi 或 null 锚点，
    // 否则每一轮 pass 两者都会互换位置（不断 insertBefore），导致 DOM 抖动、hover 丢失及点击事件被中断
    const bottomItem = menu.querySelector('.mc-nav-study-item, .mc-nav-report-item, .mc-nav-settings-item');
    if (bottomItem) return { host: menu, anchor: bottomItem };
    const toggle = navToggleEl();
    const footLi = toggle ? toggle.closest('#ic-app-header__menu-list > li, #menu > li') : null;
    return { host: menu, anchor: footLi || null };
  }

  /* 造一颗导航行：整份照抄 Canvas 自己一行的结构（li > a + 图标容器 + .menu-item__text），
     这样 44px 行高、22px 图标槽位、hover 底色、主题配色那几条规则全部自动命中，不用另写一套侧栏行。
     已经在就只在对位置的时候搬：insertBefore 哪怕原地也会记一次子节点变动，
     而这一层挂在 DOM 变动监听上，原地反复插＝观察器和我们互相触发个没完 */
  function ensureRow(selector, html, host, anchor) {
    if (!host) return null;
    let li = document.querySelector(selector);
    if (!li) {
      // 整串里那颗 <li> 就是这一行本身：借一个临时容器解析一次，把它取出来，不再套一层
      const wrap = document.createElement('ul');
      wrap.innerHTML = html;
      li = wrap.firstElementChild;
      if (!li) return null;
      host.insertBefore(li, anchor || null);
      return li;
    }
    // 如果用户保存了自定义侧栏行序，且节点已经在目标 host 中，不要在这里反复插入移动，
    // 统一交给 mcApplyNavLayout 处理，避免两套调度反复挪动导致元素丢失 hover 和 click 事件
    if (mcNavLayout && mcNavLayout() && li.parentNode === host) {
      return li;
    }
    const inPlace = li.parentNode === host && (anchor ? li.nextElementSibling === anchor : !li.nextElementSibling);
    if (!inPlace) host.insertBefore(li, anchor || null);
    return li;
  }

  function ensureSettingsRow() {
    const m = settingsMount();
    return ensureRow('.mc-nav-settings-item',
      '<li class="ic-app-header__menu-list-item mc-nav-settings-item">'
      + '<a class="ic-app-header__menu-list-link mc-nav-settings-link" role="button" tabindex="0" aria-label="Settings">'
      + '<div class="menu-item-icon-container" role="presentation">'
      + '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="' + GEAR_PATH + '"/></svg></span>'
      + '</div>'
      + '<div class="menu-item__text">Settings</div>'
      + CLASH_HTML
      + '</a></li>', m.host, m.anchor);
  }

  function ensureReportRow() {
    if (!reportRowOn()) {
      const off = document.querySelector('.mc-nav-report-item');
      if (off) off.remove();
      return null;
    }
    // 锚点就是 Settings 那一行本身，插到它前面就是"在它上面"；Settings 还没挂上时这一趟先不做
    const settings = document.querySelector('.mc-nav-settings-item');
    return ensureRow('.mc-nav-report-item',
      '<li class="ic-app-header__menu-list-item mc-nav-report-item">'
      + '<a class="ic-app-header__menu-list-link mc-nav-report-link" role="button" tabindex="0" aria-label="Report a bug">'
      + '<div class="menu-item-icon-container" role="presentation">'
      + '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="' + BUG_PATH + '"/></svg></span>'
      + '</div>'
      + '<div class="menu-item__text">Report a bug</div>'
      + '</a></li>', settings && settings.parentNode, settings);
  }

  // AI 总结那一行：挂在 Report a bug 上面（没有 Report 那行时挂 Settings 上面）。
  // 它的点击不在这里绑——这一份跑在 document_start，面板那份 JS 要 document_idle 才在，
  // 所以 study-panel.js 自己在 document 上代理这颗类名，两边各绑一次会出现"重载扩展前那一帧按下去没反应"
  function ensureStudyRow() {
    if (!studyRowOn()) {
      const off = document.querySelector('.mc-nav-study-item');
      if (off) off.remove();
      return null;
    }
    const report = document.querySelector('.mc-nav-report-item');
    const settings = document.querySelector('.mc-nav-settings-item');
    const anchor = report || settings;
    return ensureRow('.mc-nav-study-item',
      '<li class="ic-app-header__menu-list-item mc-nav-study-item">'
      + '<a class="ic-app-header__menu-list-link mc-nav-study-link" role="button" tabindex="0" aria-label="Study With AI">'
      + '<div class="menu-item-icon-container" role="presentation">'
      + '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="' + STUDY_PATH + '"/></svg></span>'
      + '</div>'
      + '<div class="menu-item__text">Study With AI</div>'
      + '</a></li>', anchor && anchor.parentNode, anchor);
  }

  function ensureCoursesRow() {
    if (!coursesRowOn()) {
      const off = document.querySelector('.mc-nav-courses');
      if (off) off.remove();
      return null;
    }
    const m = coursesMount();
    // 默认收起（他要课程列表进来时是折着的，点标题才展开）。列表本身要问 /api/v1/courses，
    // 那一刻还没到，所以壳里那一列先空着，字由 content.js 填"Loading…"和真正的课程
    return ensureRow('.mc-nav-courses',
      '<li class="ic-app-header__menu-list-item mc-nav-courses mc-collapsed">'
      + '<a class="ic-app-header__menu-list-link mc-nav-courses-head" role="button" tabindex="0" aria-expanded="false">'
      + '<span class="menu-item-icon-container" role="presentation">' + COURSES_ICON + '</span>'
      + '<span class="menu-item__text">Courses</span>'
      + '<span class="mc-nav-courses-caret">' + CHEVRON_DOWN + '</span>'
      + '</a>'
      + '<div class="mc-nav-courses-body"><ul class="mc-nav-courses-list"></ul></div>'
      + '</li>', m.host, m.anchor);
  }

  function ensureBcRow() {
    const m = coursesMount();
    // 位置：挂在课程分区之前（他要这四行在课程列表上面）。课程分区被开关关掉时没挂出来，
    // 就退回原来的锚点（底部那颗收起按钮之前）。
    // mc-nav-bc-none 那颗"BC 到底在不在跑"的判据留给 content.js：它那颗元素本来就晚半秒才出现
    return ensureRow('.mc-nav-bc',
      '<li class="ic-app-header__menu-list-item mc-nav-bc mc-collapsed">'
      + '<a class="ic-app-header__menu-list-link mc-nav-bc-head" role="button" tabindex="0" aria-expanded="false">'
      + BC_ICON
      + '<span class="menu-item__text">BetterCampus</span>'
      + '<span class="mc-nav-bc-caret">' + CHEVRON_DOWN + '</span></a>'
      + '<div class="mc-nav-bc-body"><ul class="mc-nav-bc-list">'
      + BC_PAGES.map(p => '<li class="ic-app-header__menu-list-item mc-nav-bc-item">'
        + '<a class="ic-app-header__menu-list-link mc-bc-row" role="button" tabindex="0" data-bcx-page="' + p.key + '">'
        + '<span class="ic-icon-svg" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="' + p.icon + '"/></svg></span>'
        + '<span class="menu-item__text">' + p.label + '</span></a></li>').join('')
      + '</ul></div></li>', m.host, document.querySelector('.mc-nav-courses') || m.anchor || null);
  }

  /* 侧栏图上那层磨砂用的那层空壳。节点在首帧就挂好，糊不糊全看 html.mc-nav-blur 那条例子：
     开关是 theme-boot.js 在 document_start 定的，节点要等到 document_idle 才出现的话，
     他会先看清一张不糊的图、一秒后才糊上（那种闪他报过很多次）。
     它排在菜单之前、z-index:-1，所以只糊身后那张图，行名和图标照常画在上面 */
  function ensureNavFrost() {
    var header = document.querySelector('.ic-app-header');
    if (!header || header.querySelector(':scope > .mc-nav-frost')) return;
    var plate = document.createElement('div');
    plate.className = 'mc-nav-frost';
    plate.setAttribute('aria-hidden', 'true');
    header.insertBefore(plate, header.firstChild);
  }

  // 新版 Canvas 自己也会提供 Study / Report / Settings / Courses。
  // Courses 必须保留 Canvas 原生行，因为它打开的是 Canvas 自己的课程抽屉，
  // 用户可以在 Canvas 设置里自行关闭；这里只处理会和拓展入口重复的三行。
  function removeNativeDuplicateRows() {
    const custom = [
      ['.mc-nav-study-item', 'Study With AI'],
      ['.mc-nav-report-item', 'Report a bug'],
      ['.mc-nav-settings-item', 'Settings']
    ];
    for (const [customSelector, label] of custom) {
      const own = document.querySelector(customSelector);
      if (!own) continue;
      const host = own.parentElement;
      if (!host) continue;
      [...host.children].forEach(li => {
        if (li === own || li.classList.contains('mc-nav-courses') ||
            li.classList.contains('mc-nav-study-item') ||
            li.classList.contains('mc-nav-report-item') ||
            li.classList.contains('mc-nav-settings-item')) return;
        const text = li.querySelector('.menu-item__text');
        if (text && text.textContent.trim().replace(/\s+/g, ' ') === label) li.remove();
      });
    }
  }

  function ensureNavRows() {
    syncNavToggleLabel();
    if (ensureSettingsRow()) ensureReportRow();
    ensureStudyRow();
    ensureCoursesRow();
    ensureBcRow();
    removeNativeDuplicateRows();
    ensureNavFrost();
  }

  window.mcNav = {
    KEY: KEY,
    toggle: navToggleEl,
    hosts: mcNavHosts,
    labelOf: mcNavLabelOf,
    keyOf: mcNavKeyOf,
    live: mcNavLive,
    layout: mcNavLayout,
    orderHost: mcNavOrderHost,
    apply: mcApplyNavLayout,
    ensureRows: ensureNavRows,
    syncToggleLabel: syncNavToggleLabel,
    settingsMount: settingsMount,
    coursesMount: coursesMount,
    GEAR_PATH: GEAR_PATH,
    BUG_PATH: BUG_PATH,
    CHEVRON_DOWN: CHEVRON_DOWN,
    CHEVRON_RIGHT: CHEVRON_RIGHT,
    CLASH_HTML: CLASH_HTML,
    LIGHTING_HTML: LIGHTING_HTML,
    BC_PAGES: BC_PAGES
  };

  /* 首帧之前摆一次。导航列表是 Canvas 服务端 HTML 里带来的，但它插进 DOM 的时刻仍然
     晚于这份脚本开跑，所以挂观察器等它：回调是微任务，那一帧还没画，摆完也闪不出来。
     摆成功一次就摘掉——后面每一轮的补摆归 content.js（点击和每轮要刷的文字在它那边）。
     3500ms 那颗看门狗和上面导航图标尺寸那节同一个数：这一页始终没有导航列表时（嵌在
     别人页面里、或者被学校整栏藏掉）观察器不能一直开着。 */
  var done = false;
  function tryApply() {
    if (done) return true;
    // 等列表里至少解析出一颗行再动手：这一列刚开一个头的时候它里面是空的，
    // 认收起那颗的兜底（还有下面 settingsMount／coursesMount 认宿主）会判错，
    // 把 Settings 插到列表外面去、还会按整块导航的高度钉死底部那颗的下边距
    if (!document.querySelector('#ic-app-header__menu-list > li, #menu > li')) return false;
    try {
      ensureNavRows();
      if (mcNavLayout()) mcApplyNavLayout();
    } catch (e) { console.error('[BCX] 首帧侧栏行序失败', e); }
    done = true;
    return true;
  }
  var obs = null;
  try {
    if (!tryApply()) {
      obs = new MutationObserver(tryApply);
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { if (obs) { obs.disconnect(); obs = null; } }, 3500);
    }
  } catch (e) {
    console.error('[BCX] 侧栏行序引导失败', e);
    if (obs) obs.disconnect();
  }
})();
