/* =========================================================
   Assignment AI Guide：作业页的正式界面。

   它挂在说明正文结束、提交区开始之前，静置只占一行。判值不归它算：
   取数走 assignment-data.js，评分走 assignment-analyze.js，个人门槛走
   assignment-baseline.js，这一份只负责"摆成学生能用的样子"。

   几条自己约束自己的口径：
   - 不接管页面。折叠态一行，不预先塞骨架屏，不因为要问 AI 而晚画 Canvas 的东西。
   - 不许编。交付物、分值、日期只能来自我们真读到的那段字；模型写了没出处的数字，
     那一行不进主界面，进"View details"里被点名。
   - 正式界面不出现 AI Value、Readiness、扣分这些调试词。同一份判值结果两边共用，
     不允许长成两套互相矛盾的算法。
   - 站点的 HTML 一律不当 HTML 用：全部 textContent，SVG 用 createElementNS 画。
   ========================================================= */
(function (root) {
  'use strict';

  // 非 Canvas 站点直接退出，严禁挂载任何 DOM 观察器与定时器
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

  var CACHE_KEY = 'mc_guide_cache_v1';
  var TICK_KEY = 'mc_guide_ticks_v1';
  var HIDDEN_KEY = 'mc_guide_hidden';
  var PROMPT_V = 'guide-v2';
  var SLOT = 'flash';          // 自动那一趟用便宜档；ai-client 自己会退到 Advanced
  var MAX_WHAT = 2;
  var MAX_STEPS = 6;
  var MAX_WATCH = 4;

  var DATA = null, AN = null, BASE = null, DBG = null;

  var S = {
    target: null,
    gen: 0,
    mounted: false,
    card: null,
    anchor: '',
    result: null,
    collected: null,
    loading: false,
    error: '',
    open: false,
    /* 这张卡现在是在页面里还是在 AI 抽屉那座悬浮窗里：借人家那座窗，不自己造 */
    embedded: false,
    notice: '',
    details: false,
    planOpen: false,
    planText: '',
    rec: null,
    cacheHit: false,
    jobs: null,
    // 自动预读只允许同一轮跑一队；读不出的附件记为已尝试，不能一结束又马上重试。
    autoReadGen: 0,
    autoReadTried: {}
  };

  function newJobs() {
    return {
      guide: job(),
      explain: job(),
      plan: job()
    };
  }
  function job() {
    /* calls ＝这一格跑过的每一趟请求，各一项：第一次生成、Re-generate 重问的那一趟。
       以前这里只有一个 usage，第二趟一来就把第一趟顶掉了，屏上看着像重问不花钱 */
    return { text: '', parsed: null, running: false, notice: '', err: '', controller: null, at: 0, from: '', calls: [] };
  }

  /* ==== 小工具 ==== */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  /* AI 抽屉那颗浮窗字形是实心 fill 画的（study-panel 的 svg() 用 fill="currentColor"），
     我这里默认是描线。不分成两种画法，同一颗图标在两个地方会一眼看得出不是一个东西 */
  var FILLED = { floatWin: 1 };

  function icon(name, cls) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls || 'mcx-guide-ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    var filled = !!FILLED[name];
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    if (!filled) {
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.6');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /* 字形和设置面板那一套 AI_ICONS 逐字一样：同一个语义在两个地方长得不一样，他会看见 */
  var ICONS = {
    spark: ['M11 4.2 12.5 8.6 16.9 10 12.5 11.5 11 15.9 9.5 11.5 5.1 10 9.5 8.6z', 'M17.6 14.4 18.3 16.4 20.3 17.1 18.3 17.8 17.6 19.8 16.9 17.8 14.9 17.1 16.9 16.4z'],
    chev: ['M7.6 10.2 12 14.6l4.4-4.4'],
    /* 这颗和 AI 抽屉里那颗"变成悬浮窗"是同一件事，所以字形逐字抄它那一份（study-panel.js 的 ICONS.floatWin），
       不另画一颗：同一个语义在两个地方长得不一样，他会看见 */
    floatWin: ['M4 4h11v3H7v9H4V4zm5 6h11v10H9V10z'],
    check: ['M5.4 12.6 9.8 17 18.6 7.6'],
    circle: ['M20.4 12a8.4 8.4 0 1 1-16.8 0 8.4 8.4 0 0 1 16.8 0z'],
    stop: ['M7.6 7.6h8.8v8.8H7.6z'],
    refresh: ['M3.6 12a8.4 8.4 0 0 1 14.3-6', 'M20.4 12a8.4 8.4 0 0 1-14.3 6', 'M17.9 3.6v4.4h-4.4', 'M6.1 20.4V16h4.4'],
    warn: ['M12 4.6 20.4 19.4H3.6z', 'M12 10v3.4', 'M12 16.4h0.01']
  };

  var GOOGLE_SVG_STR = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;flex:0 0 auto;">'
    + '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>'
    + '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>'
    + '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>'
    + '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>'
    + '</svg>';

  function noticeBlock(msg) {
    var el = h('div', 'mcx-guide-notice');
    el.textContent = String(msg || '');
    if (/User cancelled|failed|error|broke/i.test(String(msg || ''))) {
      el.style.cssText = 'color: #ef4444 !important; font-weight: 500; margin-bottom: 8px;';
    }
    if (/Not signed in yet|sign in with your Google account|AI & Plans|User cancelled sign-in|Sign-in was cancelled/i.test(String(msg || ''))) {
      var actWrap = h('div', 'mcx-ai-error-act');
      var btn = h('button', 'mcx-ai-error-btn');
      btn.type = 'button';
      btn.innerHTML = GOOGLE_SVG_STR + '<span>Sign in with Google</span>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (root.MCxAi && root.MCxAi.loginWithGoogle) {
          root.MCxAi.loginWithGoogle(function (err) {
            if (err) {
              if (S.jobs && S.jobs.guide) {
                S.jobs.guide.notice = 'Sign-in was cancelled. Try again when you are ready.';
                render();
              }
            } else {
              run('guide', true);
            }
          });
        } else if (root.MCxAi && root.MCxAi.promptLogin) {
          root.MCxAi.promptLogin();
        } else {
          try { document.dispatchEvent(new CustomEvent('bcx-open-ai-settings')); } catch (err) {}
        }
      });
      actWrap.appendChild(btn);
      el.appendChild(actWrap);
    }
    return el;
  }

  function act(label, cls, onClick) {
    var b = h('button', 'mcx-guide-act' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  function collapse(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /* 模型偶尔回一句小写开头的步骤，看着就像没写完。这一颗只管把首字母提上去，
     别的字符一个不动：不改标点、不改大小写风格、不重排词，所以看不出是系统动的 */
  function capFirst(s) {
    var t = String(s == null ? '' : s);
    var m = /^(\s*)([a-z])/.exec(t);
    return m ? m[1] + m[2].toUpperCase() + t.slice(m[1].length + 1) : t;
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function store(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; }
  }

  function loadCache() { return store(CACHE_KEY, {}); }
  function saveCache(all) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) {} }

  function cacheKey(mode, customResult) {
    var res = customResult || S.result;
    if (!res) return '';
    var slot = SLOT;
    try {
      if (root.MCxAi && root.MCxAi.config) slot = root.MCxAi.config(SLOT).slot || SLOT;
    } catch (e) {}
    var extra = mode === 'plan' ? (':' + collapse(S.planText || '')) : '';
    return [res.key, res.ctx.fingerprint, mode + extra, PROMPT_V, slot].join('|');
  }

  function cacheRead(mode, customResult) {
    var key = cacheKey(mode, customResult);
    if (!key) return null;
    var row = loadCache()[key];
    return row && row.text ? row : null;
  }

  function cacheWrite(mode, text, calls, poolUsed, customResult) {
    var key = cacheKey(mode, customResult);
    if (!key) return;
    var all = loadCache();
    all[key] = { text: text, at: Date.now(), calls: callsForStore(calls), prompt: PROMPT_V, poolUsed: !!poolUsed };
    /* 老师改了字就多一条旧的永远读不到的：按时间留最近 40 条 */
    var keys = Object.keys(all).sort(function (a, b) { return (all[b].at || 0) - (all[a].at || 0); });
    while (keys.length > 40) { delete all[keys.pop()]; }
    saveCache(all);
  }

  /* 库里那一格存的是每一趟报回来的数，内存里那份带牌号（key）只用来归并同一趟的流式帧。
     旧构建存的是单个 usage，读回来照样排成加法里的一项 */
  function callsForStore(calls) {
    return (Array.isArray(calls) ? calls : []).slice(0, 40).map(function (c) {
      return c && c.usage ? c.usage : c;
    }).filter(function (u) { return u && typeof u === 'object'; });
  }

  function callsFromRow(row) {
    if (row && Array.isArray(row.calls)) return row.calls.slice(0, 40);
    if (row && row.usage && typeof row.usage === 'object') return [row.usage];
    return [];
  }

  /* 勾选跟着内容版本走：老师改了要求，旧的勾不该还亮着 */
  function tickKey() { return S.result ? S.result.key + '|' + S.result.ctx.fingerprint : ''; }
  function ticksRead() { return store(TICK_KEY, {}); }
  function tickWrite(map) { try { localStorage.setItem(TICK_KEY, JSON.stringify(map)); } catch (e) {} }
  function tickOf(i) { var m = ticksRead(); return !!(m[tickKey()] && m[tickKey()][i]); }
  function tickSet(i, on) {
    var m = ticksRead();
    var row = m[tickKey()] || {};
    row[i] = on;
    m[tickKey()] = row;
    tickWrite(m);
  }

  /* 这张卡在不在页面上：AI 总开关排在最前面，它关掉时这张卡当场摘掉（boot 每一轮都问过这里），
     设置里那颗"整个不画"的出口仍是单独一档，两件事不互相覆盖 */
  function visible() {
    if (window.mcAiOn && !window.mcAiOn()) return false;
    try { return localStorage.getItem(HIDDEN_KEY) !== '1'; } catch (e) { return true; }
  }

  /* ==== 挂在哪：拿刚读到的那段字去页面对，不跟选择器赌运气 ==== */

  var FALLBACK = {
    assignment: ['#assignment_description', '#assignment_details', '.assignment-description', '#assignment_show .description', '#module_item_details'],
    quiz: ['#quiz_description', '#quiz_show .quiz-description', '.quiz-description'],
    discussion: ['#discussion_topic .message', '#discussion_topic', '.header-wrapper', '.userMessage']
  };

  /* 通知条里的字不算"说明正文"。[实测 2026-10-13 /courses/296970/discussion_topics/2732239]
     那条话题锁着，Canvas 的 API 把 message 字段回成 "This topic is locked until Oct 13 at 11:20am."
     （45 个字符），同一句话又画成页面上那条 -view-alert；这一页没有别的节点带这句话
     （#discussion_topic、.header-wrapper、h1 全 0 命中）。于是"含这句话且最短的那一颗"
     就是通知里面那层文字 div，卡被插进了通知里。
     两道都要：只跳过"落在通知里面"的那一颗，判据会往上退到装那两条通知的容器
     （当场量到：退到 extra=118 那层，文字是 "You must post before seeing replies…"＝还是通知那一坨）。
     跳过"自己里面就挂着通知"的候选以后，这一页返回 null，卡不挂（而不是挂错地方）。
     只在文字已经命中的那几颗上问这两句，不拿它去扫整棵 DOM（这一趟本来就逐颗读 textContent，
     再叠 4000 次 closest＋子树查询是白付的开销） */
  function inOrOverNotice(el) {
    try {
      if (el.closest && el.closest('[class*="-view-alert"], .ic-flash-message, [role="alert"]')) return true;
      if (el.querySelector && el.querySelector('[class*="-view-alert"], .ic-flash-message')) return true;
    } catch (e) {}
    return false;
  }

  /* Canvas 渲染完会往每个外链里补一句读屏的话（实测 2026-10-13 讨论页：
     `<span class="external_link_icon">Links to an external site.</span>`），API 回来的那段字里没有这一句。
     于是页面上没有任何一颗节点的文字还和那段字连得上，卡第二次找不回锚点：
     进悬浮窗再叉掉之后卡不回归，症状就是这么来的（当场量到：摘掉那两颗 span，卡立刻挂回原处）。
     两头都要摘——只摘页面那一头，老师自己写了这句话时反而连不上。 */
  var INJECTED_A11Y = /\b(links to an external site|opens? in a new (?:window|tab))\b\.?/gi;

  function stripA11y(s) {
    return collapse(String(s).replace(INJECTED_A11Y, ' '));
  }

  /* 页面文字里被站点动过的那一句，判值那一头也要用同一份：
     两边算法不一样，一处挂得上、另一处说找不到 */
  function pageText(el) {
    return stripA11y(el.textContent);
  }

  function matchByText(wantIn) {
    var want = stripA11y(wantIn);
    if (want.length < 40) return null;
    var scope = document.getElementById('wrapper') || document.getElementById('app') || document.body;
    var nodes = [];
    try { nodes = [].slice.call(scope.querySelectorAll('div, section, article, form')); } catch (e) { return null; }
    var head = want.slice(0, 60);
    var best = null, bestExtra = Infinity, seen = 0;
    for (var i = 0; i < nodes.length && seen < 4000; i++) {
      var el = nodes[i];
      if (el.childElementCount > 80) continue;
      seen++;
      var mine = pageText(el);
      if (mine.length < want.length - 4) continue;
      var extra = mine.length - want.length;
      if (extra > 240) continue;
      if (mine.indexOf(head) < 0) continue;
      if (inOrOverNotice(el)) continue;
      if (extra < bestExtra) { bestExtra = extra; best = el; }
    }
    return best;
  }

  /* 我们的卡里有按钮：落进站点那个 form 里面去会被它的提交逻辑一起收走，
     所以只要父级在 form 里，就改成插在整张 form 前面 */
  function safeParent(parent, before) {
    var form = null;
    try { form = (parent.closest && parent.closest('form')) || null; } catch (e) { form = null; }
    if (form && form !== parent && !form.contains(descOf(before))) return { parent: form.parentNode, before: form };
    return { parent: parent, before: before };
  }
  function descOf(n) { return n && n.contains ? n : null; }

  function fallbackNode(kind) {
    var list = FALLBACK[kind] || FALLBACK.assignment;
    for (var i = 0; i < list.length; i++) {
      var node = null;
      try { node = document.querySelector(list[i]); } catch (e) { node = null; }
      if (node && !placeholderBody(node) && collapse(node.textContent).length > 20) return node;
    }
    return null;
  }

  /* Canvas 在没写说明的那一屏自己铺一句占位话（实测 2026-10-13 /courses/296970/assignments/14485465：
     #assignment_show .description 里面就是这一句，53 个字符，比上面 20 字那道门槛高）。
     它不是老师写的正文：拿它当锚点＝把卡挂在"这一页压根没有正文"的那一屏上面 */
  function placeholderBody(node) {
    try { return /^no additional details\b/i.test(collapse(node.textContent)); } catch (e) { return false; }
  }

  /* 作业还没开放那一屏（实测 2026-10-13 /courses/296970/assignments/14485431）Canvas 换了一份
     只有抬头的视图：#content > div.assignment_header > h1#assignment_head + ul#assignment_student_details
     + div.lock_explanation，整块说明都不画。判值那边说这一页有正文（API 的 description 有字）
     却没有一块说明可以挂，就退到抬头那一排后面——他要的是"提交锁了但正文还在的，卡要出现" */
  function lockedHeaderAnchor(ctx) {
    var head = null;
    try { head = document.querySelector('#content > .assignment_header'); } catch (e) { return null; }
    if (!head || !head.parentNode) return null;
    if (collapse((ctx && ctx.body && ctx.body.text) || '').length < 40) return null;
    var before = head.nextSibling || null;
    if (before && before.parentNode !== head.parentNode) before = null;
    return {
      parent: head.parentNode, before: before, node: before || head,
      why: 'right after the assignment header, because this is the not-yet-opened version of the page, which draws no description block at all'
    };
  }

  function findAnchor(ctx) {
    var kind = ctx.kind || 'assignment';
    var want = stripA11y(ctx.body && ctx.body.text || '');
    var desc = matchByText(want);
    if (!desc) desc = fallbackNode(kind);
    if (!desc) {
      var alt = lockedHeaderAnchor(ctx);
      if (alt) return alt;
      return { node: null, why: 'nothing on this page carries the description we read, so there was no safe place to put the card' };
    }
    /* 2026-10-12 他拍的：卡片要在 Due／Points／Submitting 那一行下面、说明正文上面，
       一进页面就先看到要求，不用滚到作业尾巴。所以是"插在说明之前"，不是"插在说明之后"。
       命中的那一块要是连作业标题都带着，插在它前面会盖到作业名上面去，换页面自己的说明块 */
    if (hasTitle(desc)) {
      var alt = fallbackNode(kind);
      if (alt && alt !== desc && !hasTitle(alt)) desc = alt;
      else return { node: null, why: 'the only block carrying that text also carries the assignment title, so putting the card before it would lift it above the name of the assignment' };
    }
    if (!desc.parentNode) return { node: null, why: 'the description block has no parent to insert into' };
    var sp = safeParent(desc.parentNode, desc);
    if (!sp.parent) return { node: null, why: 'the page refused a place right before the description' };
    return {
      parent: sp.parent, before: desc, node: desc,
      why: 'before the description block, so it sits under the due date and points line and above the text you are about to read'
    };
  }

  function hasTitle(node) {
    try { return !!(node.querySelector && node.querySelector('h1')); } catch (e) { return false; }
  }

  /* 读失败的时候更要挂上去：他得看见"这一页我们没读到、为什么没读到"，
     而不是页面安静得像什么都没发生。没有判值结果可用，所以锚点退到说明块本身 */
  function errorAnchor() {
    var kind = (S.target && S.target.kind) || 'assignment';
    var list = FALLBACK[kind] || FALLBACK.assignment;
    for (var i = 0; i < list.length; i++) {
      var node = null;
      try { node = document.querySelector(list[i]); } catch (e) { node = null; }
      if (node && node.parentNode) {
        return { parent: node.parentNode, before: node, node: node, why: 'the page\'s own description block ' + list[i] + ', because there is no description to match against' };
      }
    }
    var t = null;
    try { t = document.querySelector('h1.title, #assignment_show h1, .ic-Layout-wrapper h1, h1'); } catch (e) { t = null; }
    if (t && t.parentNode) {
      return { parent: t.parentNode, before: t.nextSibling || null, node: t, why: 'right after the page title, because the description block was never drawn' };
    }
    return { node: null, why: 'there was no block on this page to attach the failure to' };
  }

  /* 宽度这件事归 assignment-width-boot.js 那一颗（document_start，抄到就拆监听）。
     这里只负责"再核一次"：卡片挂出来、正文被 DesignPlus 收窄、窗口改大小，都叫它一趟。
     不在这一份里再写一份算法——两处量法不一样，两张卡就会一宽一窄。
     但那一颗要是没加载（新文件没进 manifest 这种事真发生过，症状就是卡片回到超宽），
     这里就地补一次：判据完全同一条，抄的是同一个 max-width */
  function syncContentWidth() {
    try {
      if (root.MCxAssignWidth && root.MCxAssignWidth.sync && root.MCxAssignWidth.sync()) return;
    } catch (e) {}
    var k = document.documentElement.style;
    if (k.getPropertyValue('--mcx-card-max-w')) return;
    var names = ['#assignment_show .description', '#assignment_description', '.assignment .description'];
    for (var i = 0; i < names.length; i++) {
      var n = null;
      try { n = document.querySelector(names[i]); } catch (e) { n = null; }
      if (!n) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 200) continue;
      k.setProperty('--mcx-card-max-w', Math.round(r.width) + 'px');
      k.setProperty('--mcx-card-inset-left', '0px');
      return;
    }
  }

  function matchWidth() {
    var card = S.card;
    if (!card) return;
    if (S.embedded) { card.style.maxWidth = ''; card.style.marginLeft = ''; return; }
    syncContentWidth();
    card.style.maxWidth = '';
    card.style.marginLeft = '';
  }

  /* ==== 挂载与卸载 ==== */

  function mount(anchor) {
    if (S.card && S.card.isConnected) return;
    var card = h('div', 'mcx-guide');
    card.setAttribute('data-mcx-guide', '1');
    S.card = card;
    S.anchor = anchor.why || '';
    try {
      if (anchor.before && anchor.before.parentNode === anchor.parent) anchor.parent.insertBefore(card, anchor.before);
      else if (anchor.parent === document.body) anchor.parent.appendChild(card);
      else anchor.parent.appendChild(card);
    } catch (e) {
      S.card = null;
      S.anchor = 'the page refused the insert (' + String((e && e.message) || e) + ')';
      return;
    }
    S.mounted = true;
    matchWidth();
    render();
  }

  function teardown() {
    abortAll();
    if (S.embedded && drawer() && drawer().unembed) { try { drawer().unembed(); } catch (e) {} }
    if (S.card) S.card.remove();
    S.card = null;
    S.mounted = false;
    S.embedded = false;
  }

  function abortAll() {
    if (!S.jobs) return;
    ['guide', 'explain', 'plan'].forEach(function (m) {
      var j = S.jobs[m];
      if (j && j.controller) { try { j.controller.abort(); } catch (e) {} }
      if (j) j.running = false;
    });
  }

  /* ==== 悬浮：不自己造窗，借 AI 抽屉那一座 ====
     它能拖、能改大小、吃主题、带糊，位置还存在 mc_ai_float_geo 那一格里，
     那些全写好了（study-panel.js）。这里只把自己这块卡递过去，再按原样要回来 */

  function drawer() { return root.MCxStudy; }

  function floatIn() {
    var St = drawer();
    if (!St || !St.embed) {
      S.notice = 'The AI panel is unavailable here, so this card cannot float.';
      S.open = true;
      render();
      return;
    }
    var ctx = S.result ? S.result.ctx : null;
    /* 名字交给窗那一行去写（抬头本来就是"这一扇是什么"），窗里这张卡不再自己顶一遍标题；
       onClose 是关窗时把卡还回页面，不然再开这扇窗看到的还是上一页的 */
    if (St.embed(S.card, { floating: true, label: 'Assignment Guide', courseId: ctx ? ctx.courseId : 0, onClose: function () { if (S.embedded) floatOut(); } })) {
      S.embedded = true;
      S.open = true;
      render();
    }
  }

  /* 要回来＝在原来的锚点重新挂一张：内容都在 S.jobs 里，所以不会重新问一次模型 */
  function floatOut() {
    var St = drawer();
    if (St && St.unembed) St.unembed();
    S.embedded = false;
    if (S.card) S.card.remove();
    S.card = null;
    ensureMount();
    render();
  }

  /* ==== 提示那一格：五个状态各说什么，全靠这一颗 ==== */

  function hintCell() {
    var rec = S.rec;
    var j = S.jobs && S.jobs.guide;
    if (S.loading) return h('span', 'mcx-guide-hint', S.readingProgress ? 'Reading files…' : 'Reading page…');
    if (S.error) return h('span', 'mcx-guide-hint is-warn', 'Could not read the page.');
    if (!rec) return act('Summarize', '', function () { run('guide', true); });
    if (j && j.running) return null;
    if (rec.kind === 'need_content') {
      return h('span', 'mcx-guide-hint', S.readingProgress ? 'Reading files…' : 'Open files to include them in the guide.');
    }
    if (j && j.parsed) {
      return null;
    }
    /* 五档在这一格上只剩两种分别：值不值得推荐用字的轻重说，不再换按钮形状 */
    return act('Summarize', rec.kind === 'skip' ? 'is-quieter' : '', function () { run('guide', true); });
  }

  function stepCount() {
    var j = S.jobs && S.jobs.guide;
    if (!j || !j.parsed) return 0;
    return j.parsed.check.length;
  }

  function autoOn() {
    try { return BASE && BASE.autoOn(); } catch (e) { return false; }
  }

  /* ==== 画 ==== */

  function render() {
    var card = S.card;
    if (!card) return;
    var wasScroll = card.scrollTop;
    card.textContent = '';
    card.className = 'mcx-guide' + (S.open ? ' is-open' : '') + (S.embedded ? ' is-embedded' : '') +
      (S.jobs && S.jobs.guide.parsed ? ' is-ready' : '');
    card.setAttribute('data-state', stateName());
    /* 借住在窗里时这张卡不出门：名字由窗那一行抬头写，收起那颗直接去掉
       （他点的：整扇都是你的了，还收什么起），悬浮那颗也不画——窗抬头本来就有两颗，再画就是重复 */
    if (S.embedded) {
      card.appendChild(body());
      matchWidth();
      return;
    }
    /* 门这一行是 div 不是 button：button 里再套 button 浏览器不认，
       而这一行本来就既要点开、又要放那颗 Summarize 和那颗悬浮 */
    var head = h('div', 'mcx-guide-head');
    var hasParsed = !!(S.jobs && S.jobs.guide && S.jobs.guide.parsed);
    var isRunning = !!(S.jobs && S.jobs.guide && S.jobs.guide.running);

    if (!hasParsed && !isRunning) {
      /* 未生成且不在生成中：整行合并为一颗可点击的 "Generate Assignment Guide" 按钮 */
      var btn = h('button', 'mcx-guide-title is-action');
      btn.type = 'button';
      btn.appendChild(icon('spark', 'mcx-guide-mark'));
      btn.appendChild(h('span', null, 'Generate Assignment Guide'));
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        run('guide', true);
      });
      head.appendChild(btn);
    } else {
      /* 正在生成或已有结果：左侧为标题 "Assignment Guide" */
      var mark = h('div', 'mcx-guide-title');
      mark.appendChild(icon('spark', 'mcx-guide-mark'));
      mark.appendChild(h('span', null, 'Assignment Guide'));
      head.appendChild(mark);
      var hint = hintCell();
      if (hint) head.appendChild(hint);
    }
    head.appendChild(h('span', 'mcx-guide-spacer'));
    if (hasParsed) head.appendChild(regenButton());
    var hasContent = hasParsed || isRunning || (S.rec && S.rec.kind === 'need_content') || !!S.error;
    if (hasContent) {
      var che = h('button', 'mcx-guide-chevbtn');
      che.type = 'button';
      che.setAttribute('aria-label', S.open ? 'Collapse the guide' : 'Expand the guide');
      che.title = che.getAttribute('aria-label');
      che.appendChild(icon('chev', 'mcx-guide-chev'));
      che.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleOpen();
      });
      head.appendChild(che);

      head.style.cursor = 'pointer';
      head.addEventListener('click', function (e) {
        if (e.target.closest('button, .mcx-guide-act, input, textarea, a')) return;
        toggleOpen();
      });
    }
    if (S.jobs && S.jobs.guide.parsed) head.appendChild(popButton());
    card.appendChild(head);
    var wrap = h('div', 'mcx-guide-body-wrapper');
    wrap.appendChild(body());
    card.appendChild(wrap);
    matchWidth();
    card.scrollTop = wasScroll;
  }

  function setOpen(val) {
    S.open = !!val;
    var card = S.card;
    if (!card) return;
    if (S.open) {
      card.classList.add('is-open');
    } else {
      card.classList.remove('is-open');
    }
    var che = card.querySelector('.mcx-guide-chevbtn');
    if (che) {
      che.setAttribute('aria-label', S.open ? 'Collapse the guide' : 'Expand the guide');
      che.title = che.getAttribute('aria-label');
    }
  }

  function toggleOpen() {
    setOpen(!S.open);
  }

  function stateName() {
    if (S.loading) return 'reading';
    if (S.error) return 'error';
    if (!S.rec) return 'idle';
    if (S.rec.kind === 'need_content') return 'need-content';
    var j = S.jobs && S.jobs.guide;
    if (j && j.running) return 'generating';
    if (j && j.parsed) return 'ready';
    return 'waiting';
  }

  function regenButton() {
    var b = h('button', 'mcx-guide-pop');
    b.type = 'button';
    var txt = 'Re-generate the guide';
    b.setAttribute('aria-label', txt);
    b.title = 'Re-generate';
    b.appendChild(icon('refresh', 'mcx-guide-popic'));
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      run('guide', true, true);
    });
    return b;
  }

  function popButton() {
    var b = h('button', 'mcx-guide-pop');
    b.type = 'button';
    /* 那句话和 AI 抽屉那颗一字不差：它只说下一站，不报现在这一站 */
    var txt = S.embedded ? 'Turn it back into a card in the page' : 'Turn it into a floating window';
    b.setAttribute('aria-label', txt);
    b.title = txt;
    b.appendChild(icon('floatWin', 'mcx-guide-popic'));
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (S.embedded) floatOut(); else floatIn();
    });
    return b;
  }

  function body() {
    var box = h('div', 'mcx-guide-body');
    if (S.notice) box.appendChild(noticeBlock(S.notice));
    if (S.error) { box.appendChild(errorBlock()); return box; }
    if (!S.rec) { box.appendChild(h('div', 'mcx-guide-line', 'Reading the page first, then this will fill in.')); return box; }
    if (S.rec.kind === 'need_content') { box.appendChild(needBlock()); }

    var j = S.jobs.guide;
    var isRunning = j.running || (S.jobs.explain && S.jobs.explain.running) || (S.jobs.plan && S.jobs.plan.running);
    var isPool = (j.poolUsed || (S.jobs.explain && S.jobs.explain.poolUsed) || (S.jobs.plan && S.jobs.plan.poolUsed) || (root.MCxAi && root.MCxAi.isPoolRouting && root.MCxAi.isPoolRouting()));
    if (isRunning && isPool) {
      var poolNoticeWrap = document.createElement('div');
      poolNoticeWrap.innerHTML = root.MCxAi && root.MCxAi.poolNoticeHtml ? root.MCxAi.poolNoticeHtml() : '';
      if (poolNoticeWrap.firstElementChild) box.appendChild(poolNoticeWrap.firstElementChild);
    }
    if (j.notice) {
      var isLoginNotice = /Not signed in|sign in with|Sign-in was cancelled|User cancelled/i.test(j.notice);
      if (!j.parsed || !isLoginNotice) {
        box.appendChild(noticeBlock(j.notice));
      }
    }
    if (j.parsed) {
      var p = j.parsed;
      if (p.what.length) box.appendChild(whatBlock(p.what));
      if (p.check.length) box.appendChild(checkBlock(p.check));
      if (p.watch.length) box.appendChild(watchBlock(p.watch));
      if (S.jobs.explain.parsed && S.jobs.explain.parsed.plain.length) box.appendChild(plainBlock(S.jobs.explain.parsed.plain));
      if (S.jobs.plan.parsed) box.appendChild(planBlock(S.jobs.plan.parsed));
      if (S.details) box.appendChild(detailsBlock(p));
    }
    /* 那一趟没连上服务：这一屏除了报错本身什么都不画，"还没写过"和那两颗按钮都没有依据 */
    var dead = !!j.err && !j.parsed && !j.running;
    if (!j.parsed && !dead && S.rec.kind !== 'need_content') {
      if (j.running) {
        var prep = h('div', 'mcx-guide-line');
        prep.appendChild(h('span', 'mcx-guide-prep', 'Preparing'));
        prep.appendChild(act('Stop', 'is-quieter', function () { stopJob('guide'); }));
        box.appendChild(prep);
      } else {
        /* 借住在窗里没有那一行门，那颗 Summarize 就得落在正文里，不然这一屏没入口 */
        var line = h('div', 'mcx-guide-line', 'Add a plan to see how it meets the requirements. ');
        if (S.embedded) line.appendChild(act('Summarize', '', function () { run('guide', true); }));
        box.appendChild(line);
      }
    }
    if (dead && S.embedded) {
      var retry = h('div', 'mcx-guide-line');
      retry.appendChild(act('Summarize', '', function () { run('guide', true); }));
      box.appendChild(retry);
    }
    if (!dead) {
      var foot = footer();
      if (foot) box.appendChild(foot);
    }
    return box;
  }

  function block(title) {
    var s = h('div', 'mcx-guide-sec');
    s.appendChild(h('div', 'mcx-guide-secTitle', title));
    return s;
  }

  function whatBlock(lines) {
    var s = block('What to submit');
    lines.slice(0, MAX_WHAT).forEach(function (t) { s.appendChild(h('div', 'mcx-guide-lead', t)); });
    return s;
  }

  function checkBlock(items) {
    var s = block('Your checklist');
    items.forEach(function (it, i) {
      var row = h('div', 'mcx-guide-item' + (tickOf(i) ? ' is-done' : ''));
      var b = h('button', 'mcx-guide-tick');
      b.type = 'button';
      b.setAttribute('role', 'checkbox');
      b.setAttribute('aria-checked', tickOf(i) ? 'true' : 'false');
      b.setAttribute('aria-label', collapse(it));
      b.appendChild(icon(tickOf(i) ? 'check' : 'circle', 'mcx-guide-tickic'));
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        tickSet(i, !tickOf(i));
        render();
      });
      row.appendChild(b);
      row.appendChild(h('span', 'mcx-guide-itemText', it));
      s.appendChild(row);
    });
    return s;
  }

  function watchBlock(lines) {
    var s = block('Before you submit');
    lines.slice(0, MAX_WATCH).forEach(function (it) {
      var row = h('div', 'mcx-guide-watch');
      row.appendChild(icon('warn', 'mcx-guide-warnic'));
      row.appendChild(h('span', 'mcx-guide-watchText', it.text));
      if (it.quote) row.appendChild(h('span', 'mcx-guide-quote', it.quote));
      s.appendChild(row);
    });
    return s;
  }

  function plainBlock(lines) {
    var s = block('In plain words');
    lines.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line', t)); });
    return s;
  }

  function planBlock(p) {
    var j = S.jobs.plan;
    if (j.notice) return noticeBlock(j.notice);
    var s = block('Your plan against the requirements');
    if (!p.ok.length && !p.miss.length && !p.ask.length) {
      s.appendChild(h('div', 'mcx-guide-line', 'No suggestions matched this page.'));
      return s;
    }
    p.miss.forEach(function (t) {
      var row = h('div', 'mcx-guide-watch');
      row.appendChild(icon('warn', 'mcx-guide-warnic'));
      row.appendChild(h('span', 'mcx-guide-watchText', t));
      s.appendChild(row);
    });
    p.ok.forEach(function (t) {
      var row = h('div', 'mcx-guide-line');
      row.appendChild(icon('check', 'mcx-guide-tickic'));
      row.appendChild(h('span', null, t));
      s.appendChild(row);
    });
    p.ask.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line', t)); });
    return s;
  }

  /* 这颗现在住在卡底那一排的最右边（2026-10-13 他点的），展开的内容长在它上面。
     形状跟那一排其它动作一致，只是被推到最右 */
  function detailsToggle() {
    var b = h('button', 'mcx-guide-act is-quiet mcx-guide-more', S.details ? 'Hide Details' : 'More Details');
    b.type = 'button';
    b.addEventListener('click', function (e) { e.preventDefault(); S.details = !S.details; render(); });
    return b;
  }

  /* 这一格原来顶着一句 "Where this came from"：那颗开关已经改叫 More Details 了，
     里面再写一遍同一件事就是多一行字，所以只留内容不留标题 */
  function detailsBlock(p) {
    var s = h('div', 'mcx-guide-sec');
    p.checkpoints.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line', t)); });
    p.questions.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line', 'Not stated on the page: ' + t)); });
    if (p.unverified.length) {
      s.appendChild(h('div', 'mcx-guide-sub', 'Unmatched suggestions are hidden from this list.'));
      p.unverified.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line is-dim', t)); });
    }
    if (p.notes.length) p.notes.forEach(function (t) { s.appendChild(h('div', 'mcx-guide-line is-dim', t)); });
    var used = usageLine();
    if (used) s.appendChild(used);
    callsBlock(s);
    s.appendChild(h('div', 'mcx-guide-src', sourceLine()));
    s.appendChild(h('div', 'mcx-guide-src', 'This is our reading of the page, not the teacher\'s wording. Open the rubric and the files for the exact text.'));
    return s;
  }

  /* 这张卡上每一趟 AI 请求，按发出去的先后排：总结、Re-generate 重问的那一趟、
     Explain simply、Check my plan。后两颗是二级的，只有总结在屏上才会出现，
     所以那两趟以前花的钱压根没地方看；现在它们和总结那一趟排在同一串加法里 */
  function jobCalls(mode) {
    var j = S.jobs && S.jobs[mode];
    return j && j.calls ? j.calls : [];
  }

  function allCalls() {
    return jobCalls('guide').concat(jobCalls('explain'), jobCalls('plan'));
  }

  /* 底下那一行小字：口径和信箱那一屏完全一样。
     钱只认服务自己在回包里报的数，它没报的就只说 token，不拿价目表替它圆场；
     设置里那颗 "Count under each answer" 关掉时这一行也不画 */
  function usageLine() {
    var a = root.MCxAi;
    if (!a || !a.usageSentence) return null;
    if (a.isCloudMode && a.isCloudMode()) return null;
    var line = a.usageSentence(allCalls(), 'This card');
    if (!line) return null;
    return h('div', 'mcx-guide-src', (S.jobs.guide.from === 'cache' ? 'Written earlier on this page' : 'AI-generated') + ' · ' + line);
  }

  /* 加法里每一项是谁：二级按钮那两趟不点名，那一串数就只是"卡用了 1,200"，
     说不清哪一段是他刚按下去的那颗 */
  var CALL_NAMES = { guide: 'Guide', explain: 'Explain simply', plan: 'Check your plan with AI' };

  function callsBlock(s) {
    var a = root.MCxAi;
    if (!a || !a.usageLineOn || !a.usageLineOn()) return;
    if (a.isCloudMode && a.isCloudMode()) return;
    ['guide', 'explain', 'plan'].forEach(function (mode) {
      var calls = jobCalls(mode);
      calls.forEach(function (c) {
        var u = c && c.usage ? c.usage : c;
        var n = a.usageTokens(u);
        if (!n) return;
        var m = a.usageMoney(u);
        s.appendChild(h('div', 'mcx-guide-line is-dim',
          CALL_NAMES[mode] + ' · ' + a.usageNum(n) + ' tokens' + (m !== null ? ' · ' + money(m) : '')));
      });
    });
  }

  function money(n) {
    return (n >= 0.01 ? '$' + n.toFixed(2) : '$' + n.toFixed(4));
  }

  function sourceLine() {
    var ctx = S.result.ctx;
    var bits = ['the description on this page'];
    if (ctx.rubric.status === 'available') bits.push('its grading sheet (' + ctx.rubric.criteria.length + ' criteria)');
    else if (ctx.rubric.status === 'unavailable') bits.push('a grading sheet we were not allowed to read (' + ctx.rubric.why + ')');
    var read = (ctx.resources.files || []).filter(function (f) { return f.status === 'extracted'; });
    if (read.length) bits.push(read.length + ' attachment(s) we read');
    var pages = (ctx.related.pageRefs || []).filter(function (p) { return p.status === 'extracted'; });
    if (pages.length) bits.push(pages.length + ' course page(s) we read');
    return 'Written from: ' + bits.join(', ') + '.';
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function needBlock() {
    var s = block('Modern Canvas Read Files');
    var ctx = S.result.ctx;
    var allFiles = ctx.resources.files || [];
    var unread = allFiles.filter(function (f) { return f.status !== 'extracted'; });
    var readCount = allFiles.length - unread.length;
    var pages = (ctx.related.pageRefs || []).filter(function (p) { return p.status !== 'extracted'; });
    var openable = unread.filter(function (f) { return f.bytes && f.bytes <= DATA.MEASURE_BYTES_CAP; });
    var tooBig = unread.filter(function (f) { return f.bytes && f.bytes > DATA.MEASURE_BYTES_CAP; });

    /* 顶部文案：正在读时显示阅读/下载进度；未在读时按是否全部 <= 8MB 给出状态说明 */
    var leadText = '';
    if (S.loading && S.readingProgress) {
      leadText = S.readingProgress;
    } else if (tooBig.length) {
      leadText = 'Read ' + readCount + ' of ' + allFiles.length + ' files. Choose whether to read the larger files too.';
    } else {
      leadText = 'All files have been read.';
    }
    s.appendChild(h('div', 'mcx-guide-lead', leadText));

    /* 一行三个文件网格：左侧文件名（...截断），右侧大小（居右对齐）；已读居中划线；未读 hover 变为 Read This File */
    var grid = h('div', 'mcx-guide-grid');
    allFiles.forEach(function (f, idx) {
      var isRead = f.status === 'extracted';
      var card = h('div', 'mcx-guide-fileCard' + (isRead ? ' is-read' : ' is-clickable'));
      
      var normalWrap = h('div', 'mcx-guide-fileNormal');
      var nameEl = h('span', 'mcx-guide-fileName', f.name || ('file ' + f.id));
      nameEl.title = f.name || ('file ' + f.id);
      var sizeEl = h('span', 'mcx-guide-fileSize', sizeText(f.bytes) || '');
      normalWrap.appendChild(nameEl);
      normalWrap.appendChild(sizeEl);
      card.appendChild(normalWrap);

      if (!isRead) {
        var hoverEl = h('div', 'mcx-guide-fileHover', 'Read this file');
        card.appendChild(hoverEl);
        card.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          readSingleFile(f, idx);
        });
      }
      grid.appendChild(card);
    });
    s.appendChild(grid);

    pages.slice(0, 4).forEach(function (pg) {
      var row = h('div', 'mcx-guide-row');
      row.appendChild(h('span', 'mcx-guide-rowName', pg.label || pg.pageUrl));
      row.appendChild(h('span', 'mcx-guide-rowSub', 'a course page the instructions point at'));
      s.appendChild(row);
    });

    if (openable.length || pages.length) {
      s.appendChild(act(openable.length
        ? 'Read all ' + openable.length + ' file' + (openable.length > 1 ? 's' : '')
        : 'Open those pages and summarise', '', function () { readThenSummarise(openable, pages); }));
    }

    /* 最下方注明阅读在本地完成，保障隐私 */
    s.appendChild(h('div', 'mcx-guide-src', 'All file reading and text extraction are performed locally in your browser.'));

    return s;
  }

  /* 点击单个文件卡片直接阅读该文件 */
  function readSingleFile(file, idx) {
    var ctx = S.result.ctx;
    var gen = S.gen;
    S.loading = true;
    var allFiles = ctx.resources.files || [];
    var ord = ordinal(idx + 1);
    S.readingProgress = 'Reading file ' + (idx + 1) + ' for this assignment…';
    render();

    function onStep(msg) {
      if (gen !== S.gen) return false;
      var pageMatch = /OCR page (\d+) of (\d+)/i.exec(String(msg || ''));
      if (pageMatch) {
        S.readingProgress = 'Modern Canvas is reading page ' + pageMatch[1] + '/' + pageMatch[2] + ' of the ' + ord + ' file for this assignment.';
      } else {
        S.readingProgress = 'Modern Canvas is reading the ' + ord + ' file for this assignment.';
      }
      render();
      return true;
    }

    var assignTitle = ctx.title || ('Assignment ' + ctx.assignmentId);
    setGlobalReadingStatus('Reading: ' + assignTitle + ' (' + (file.name || 'file') + ')');

    DATA.readFile(file, ctx.courseId, onStep, { assignmentId: ctx.assignmentId, assignmentName: ctx.title || '' }).then(function () {
      setGlobalReadingStatus('');
      if (gen !== S.gen) return;
      S.loading = false;
      S.readingProgress = '';
      rejudge('after reading single file');
    }).catch(function (err) {
      setGlobalReadingStatus('');
      if (gen !== S.gen) return;
      S.loading = false;
      S.readingProgress = '';
      S.jobs.guide.notice = 'Could not read ' + (file.name || 'that file') + '. ' + String((err && err.message) || 'No text was returned.') + ' Try another file or open it in Canvas.';
      render();
    });
  }

  /* 发布全局阅读状态给扩展 Popup 显示 */
  function setGlobalReadingStatus(text) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ mc_reading_assignment_status: text || '' });
      }
    } catch (e) {}
  }

  /* 批量阅读队列 */
  function readThenSummarise(files, pages, automatic) {
    var ctx = S.result.ctx;
    var gen = S.gen;
    var allFiles = ctx.resources.files || [];
    var queue = [];
    var assignTitle = ctx.title || ('Assignment ' + ctx.assignmentId);

    if (automatic) S.autoReadGen = gen;

    files.slice(0, 8).forEach(function (f) {
      var fIndex = allFiles.indexOf(f);
      if (fIndex < 0) fIndex = queue.length;
      queue.push({
        type: 'file',
        item: f,
        ord: ordinal(fIndex + 1),
        fn: function (stepCb) {
          setGlobalReadingStatus('Reading: ' + assignTitle + ' (' + (f.name || ('file ' + (fIndex + 1))) + ')');
          return DATA.readFile(f, ctx.courseId, stepCb, { assignmentId: ctx.assignmentId, assignmentName: ctx.title || '' });
        }
      });
    });

    (pages || []).slice(0, 2).forEach(function (p) {
      queue.push({
        type: 'page',
        item: p,
        ord: 'page',
        fn: function () {
          setGlobalReadingStatus('Reading: ' + assignTitle + ' (course page)');
          return DATA.readPage(p, ctx.courseId);
        }
      });
    });

    S.loading = true;
    var next = 0;

    function step() {
      if (gen !== S.gen) {
        setGlobalReadingStatus('');
        if (automatic && S.autoReadGen === gen) S.autoReadGen = 0;
        return;
      }
      if (next >= queue.length) {
        setGlobalReadingStatus('');
        if (automatic && S.autoReadGen === gen) S.autoReadGen = 0;
        S.loading = false;
        S.readingProgress = '';
        rejudge('after opening the files this page points at');
        if (!automatic && S.rec && S.rec.kind !== 'need_content' && !S.jobs.guide.parsed) {
          run('guide', true);
        }
        return;
      }
      var task = queue[next++];
      if (task.type === 'file') {
        S.readingProgress = 'Reading file ' + task.ord + ' for this assignment…';
      } else {
        S.readingProgress = 'Reading a course page for this assignment…';
      }
      render();

      function onFileStep(msg) {
        if (gen !== S.gen) return false;
        var pageMatch = /OCR page (\d+) of (\d+)/i.exec(String(msg || ''));
        if (pageMatch) {
          S.readingProgress = 'Modern Canvas is reading page ' + pageMatch[1] + '/' + pageMatch[2] + ' of the ' + task.ord + ' file for this assignment.';
        } else {
          S.readingProgress = 'Modern Canvas is reading the ' + task.ord + ' file for this assignment.';
        }
        render();
        return true;
      }

      Promise.resolve(task.fn(onFileStep)).then(step, step);
    }
    step();
  }

  function fileState(f) {
    if (f.status === 'extracted') return 'read';
    if (f.status === 'reading') return 'being read now';
    if (f.status === 'unreadable') return 'Canvas gave it back but no text came out';
    if (f.status === 'unavailable') return 'unavailable';
    return sizeText(f.bytes) || '';
  }

  /* 19733 KB 那种写法没人能一眼看出多大：过 1 MB 就说 MB，一位小数 */
  function sizeText(bytes) {
    var n = Number(bytes) || 0;
    if (!n) return '';
    if (n >= 1024 * 1024) return (Math.round(n / 104857.6) / 10) + ' MB';
    return Math.round(n / 1024) + ' KB';
  }

  function errorBlock() {
    var s = block('Could not read this page');
    s.appendChild(h('div', 'mcx-guide-lead', S.error));
    s.appendChild(h('div', 'mcx-guide-src', 'The card stays out of your way until Canvas answers. Your own submission controls are untouched.'));
    s.appendChild(act('Try again', 'is-quiet', function () { analyze(true); }));
    return s;
  }

  function footer() {
    var f = h('div', 'mcx-guide-foot');
    if (S.rec && S.rec.kind === 'need_content') {
      return f;
    }
    var hasResult = !!(S.jobs && S.jobs.guide && S.jobs.guide.parsed);
    if (!hasResult) return null;
    var e = S.jobs.explain, p = S.jobs.plan;
    if (e.running) f.appendChild(h('span', 'mcx-guide-hint', 'Explaining'));
    else f.appendChild(act('Explain simply', 'is-quiet', function () { 
      var force = !!(e.parsed || e.text);
      run('explain', true, force); 
    }));
    if (p.running) f.appendChild(h('span', 'mcx-guide-hint', 'Checking your plan'));
    else f.appendChild(act('Check your plan with AI', 'is-quiet', function () { S.planOpen = !S.planOpen; if (S.planOpen) S.open = true; render(); }));
    /* 只有当变成悬浮栏模式的时候regenerate才继续保持在卡底这一排 */
    if (S.embedded) f.appendChild(act('Re-generate', 'is-quieter', function () { run('guide', true, true); }));
    f.appendChild(detailsToggle());
    if (S.planOpen) f.appendChild(planInput());
    return f;
  }

  function planInput() {
    var box = h('div', 'mcx-guide-plan');
    var input = h('input', 'mcx-guide-planInput');
    input.type = 'text';
    input.placeholder = 'Describe your plan in one line, such as “intro, three sources, conclusion by Friday”';
    input.value = S.planText;
    input.addEventListener('input', function () { S.planText = input.value; });
    input.addEventListener('keydown', function (e2) {
      if (e2.key === 'Enter') { 
        e2.preventDefault(); 
        var t = collapse(S.planText); 
        if (t) {
          var force = !!(S.jobs.plan.parsed || S.jobs.plan.text);
          run('plan', true, force);
        }
      }
    });
    box.appendChild(input);
    box.appendChild(act('Send', 'is-quiet', function () {
      var t = collapse(S.planText);
      if (!t) { S.jobs.plan.notice = 'Add a plan before checking it against the requirements.'; render(); return; }
      var force = !!(S.jobs.plan.parsed || S.jobs.plan.text);
      run('plan', true, force);
    }));
    return box;
  }

  /* 卡片本身也不该等取数回来才出现：他报的是"再等半秒 AI 面板才显示出来"。
     说明块是页面自己就有的，先按它挂出一行"Reading this page"，判值回来再填内容。
     这不算骨架屏：它就是我们最终那一行，只是话还没说到。 */
  function mountEarly() {
    if (S.card && S.card.isConnected) return;
    var node = fallbackNode(S.target ? S.target.kind : 'assignment');
    if (!node || !node.parentNode) return;
    var sp = safeParent(node.parentNode, node);
    if (!sp.parent) return;
    mount({ parent: sp.parent, before: node, node: node, why: 'put on the page\'s own description block straight away, while the reading was still in flight' });
  }

  /* ==== 这一页的判值：数据层那份共享的 collect，不重复审一遍 ==== */

  function analyze(force) {
    if (!S.target) return;
    var gen = ++S.gen;
    S.loading = true;
    S.error = '';
    render();
    DATA.collect(S.target, function () {}, { force: !!force }).then(function (collected) {
      if (gen !== S.gen) return;
      S.loading = false;
      if (!collected || !collected.ctx) {
        S.error = 'No assignment information was available to review.';
        mountError();
        render();
        return;
      }
      S.collected = collected;
      judge(collected.ctx, 'page opened');
      DATA.countFiles(collected.ctx, function () {}).then(function (m) {
        if (gen !== S.gen) return;
        if (!m.counted && !m.skipped) return;
        rejudge('after counting ' + m.counted + ' file(s)');
      }, function () {});
    }, function (err) {
      if (gen !== S.gen) return;
      S.loading = false;
      S.error = String((err && err.message) || err);
      mountError();
      render();
    });
  }

  function judge(ctx, why) {
    var result = AN.analyze(ctx, weightsFor());
    S.result = result;
    S.rec = BASE.recommend(result);
    /* 缺附件这一档摊开：门那一行只写一句话，唯一的动作在正文里，收着就看不见了 */
    if (S.rec.kind === 'need_content') S.open = true;
    S.auto = autoOn();
    /* 每一页都进样本池，够不够格由 baseline 那一层自己判（不合格它会写下为什么） */
    BASE.record(result, { source: 'page' });
    /* 他拍的口径（2026-10-13）：这一页压根没有正文的时候，这张卡不要出现。
       "提交锁了、正文还在"那种判值不会打这颗标记（它有字可读），照旧出现。
       先 record 再撤：样本池那一层自己会写下为什么不要这条样本，不该由界面层替它决定 */
    if (S.rec.emptyPage) {
      S.anchor = 'not mounted: this page has no description, rubric, file or link to lay out';
      teardown();
      return;
    }
    ensureMount();

    /* 每次进入作业：只要有未提取的 <=8MB 附件就直接开始自动阅读并持久化 */
    tryAutoReadFiles();

    var cached = cacheRead('guide');
    S.cacheHit = !!cached;
    if (cached) {
      S.jobs.guide.text = cached.text;
      S.jobs.guide.poolUsed = !!cached.poolUsed;
      S.jobs.guide.parsed = shape('guide', DBG.parseTags(cached.text), ctx);
      S.jobs.guide.at = cached.at;
      S.jobs.guide.from = 'cache';
      S.jobs.guide.calls = callsFromRow(cached);
      S.jobs.guide.notice = '';
      S.jobs.guide.err = '';
      if (S.auto || (S.rec && S.rec.auto)) S.open = true;
      render();
      return;
    }
    render();
    if (S.rec.auto) {
      S.open = true;
      run('guide', false);
    }

    void why;
  }

  /* 记录作业自动总结次数与正文长度历史 */
  var AUTO_RUN_KEY = 'mc_assign_auto_meta';
  function getAutoMeta() {
    try { return JSON.parse(localStorage.getItem(AUTO_RUN_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveAutoMeta(meta) {
    try { localStorage.setItem(AUTO_RUN_KEY, JSON.stringify(meta)); } catch (e) {}
  }

  function tryAutoReadFiles() {
    // AI 总开关关掉：这一趟自动读附件的活根本不开。设置里那两颗自动开关存的值不动，翻回来照旧
    if (window.mcAiOn && !window.mcAiOn()) return;
    if (BASE && BASE.autoReadOn && !BASE.autoReadOn()) return;
    if (!S.result || !S.result.ctx) return;
    var ctx = S.result.ctx;
    // judge() 会在读完后再次调用这里；同一代次的队列还在时绝不能再开一队。
    if (S.autoReadGen === S.gen) return;
    var unread = (ctx.resources.files || []).filter(function (f) { return f.status !== 'extracted'; });
    var base = String(ctx.courseId || '') + ':' + String(ctx.assignmentId || ctx.id || '');
    var keyOf = function (kind, item) { return base + ':' + kind + ':' + String(item.id || item.url || item.pageUrl || item.name || item.title || 'unknown'); };
    var openable = unread.filter(function (f) {
      return f.bytes && f.bytes <= DATA.MEASURE_BYTES_CAP && !S.autoReadTried[keyOf('file', f)];
    });
    var pages = (ctx.related.pageRefs || []).filter(function (p) { return p.status !== 'extracted' && !S.autoReadTried[keyOf('page', p)]; });
    if (!openable.length && !pages.length) return;

    var key = S.result.key;
    var meta = getAutoMeta();
    var rec = meta[key] || { count: 0, lastBodyLength: (ctx.body && ctx.body.text ? ctx.body.text.length : 0) };

    /* 超过 2 次不再自动 */
    if (rec.count >= 2) return;

    /* 自动在后台静默读取。无论成功还是失败都记为尝试过；用户仍可在卡片上手动重试。 */
    openable.forEach(function (f) { S.autoReadTried[keyOf('file', f)] = 1; });
    pages.forEach(function (p) { S.autoReadTried[keyOf('page', p)] = 1; });
    readThenSummarise(openable, pages, true);
  }

  function rejudge(why) {
    if (!S.collected || !S.collected.ctx) return;
    var before = S.result ? S.result.key + '|' + (S.result.ctx.fingerprint || '') : '';
    var oldLen = (S.result && S.result.ctx && S.result.ctx.body && S.result.ctx.body.text) ? S.result.ctx.body.text.length : 0;
    judge(S.collected.ctx, why || 're-judged');
    var after = S.result.key + '|' + (S.result.ctx.fingerprint || '');
    if (before && before !== after) {
      var newCtx = S.collected.ctx;
      var newLen = (newCtx && newCtx.body && newCtx.body.text) ? newCtx.body.text.length : 0;
      var changeRatio = oldLen > 0 ? Math.abs(newLen - oldLen) / oldLen : (newLen > 0 ? 1 : 0);

      /* 仅当正文内容变化大于 10% 才重新阅读文档 + 总结并覆盖之前；纯 duedate 变化不重置 */
      if (changeRatio > 0.10) {
        S.jobs = newJobs();
        S.details = false;
        var key = newCtx.key;
        var meta = getAutoMeta();
        var rec = meta[key] || { count: 0, lastBodyLength: newLen };
        if (rec.count < 2) {
          rec.count++;
          rec.lastBodyLength = newLen;
          meta[key] = rec;
          saveAutoMeta(meta);
          tryAutoReadFiles();
        }
      }
    }
    if (S.jobs && S.jobs.guide.running) return;
    if (S.rec.auto && !S.jobs.guide.parsed && S.rec.kind !== 'need_content') {
      var m = getAutoMeta();
      var k = S.result.key;
      var itemMeta = m[k] || { count: 0 };
      if (itemMeta.count < 2) {
        itemMeta.count++;
        m[k] = itemMeta;
        saveAutoMeta(m);
        S.open = true;
        run('guide', false);
      }
    }
  }

  /* 调试窗口改了权重时，正式界面也跟着按同一份权重重算，两边永远一个答案 */
  function weightsFor() {
    try {
      if (root.MCxAssignDebug && root.MCxAssignDebug.state && root.MCxAssignDebug.state.weights) return root.MCxAssignDebug.state.weights;
    } catch (e) {}
    return null;
  }

  /* ==== 问 AI ==== */

  function aiReady() {
    if (!root.MCxAi || !root.MCxAi.config) return false;
    try { return !!(root.MCxAi.config(SLOT).key || root.MCxAi.isCloudMode()); } catch (e) { return false; }
  }

  function run(mode, manual, force) {
    if (!S.result) { S.loading = true; render(); return; }
    var j = S.jobs[mode];
    if (j.running) { j.notice = 'This is already running.'; render(); return; }
    if (mode === 'plan' && !collapse(S.planText)) return;
    if (!force) {
      var cached = cacheRead(mode);
      if (cached) {
        j.text = cached.text;
        j.parsed = shape(mode, DBG.parseTags(cached.text), S.result.ctx);
        j.from = 'cache';
        j.at = cached.at;
        j.calls = callsFromRow(cached);
        j.notice = '';
        j.err = '';
        if (manual) S.open = true;
        render();
        return;
      }
    }
    var cfg = null;
    try { cfg = root.MCxAi && root.MCxAi.config(SLOT); } catch (e) {}
    var isCloud = cfg && (cfg.isCloud || (root.MCxAi && root.MCxAi.isCloudMode && root.MCxAi.isCloudMode()));
    if (isCloud && root.MCxAi && root.MCxAi.isUserLoggedIn && !root.MCxAi.isUserLoggedIn() && (!cfg || !cfg.key)) {
      if (manual && root.MCxAi.loginWithGoogle) {
        j.notice = 'Starting Google sign-in…';
        j.err = 'unlogged';
        S.open = true;
        render();
        root.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            j.notice = 'Sign-in was cancelled. Try again when you are ready.';
            j.err = 'unlogged';
            render();
          } else {
            run(mode, true, force);
          }
        });
        return;
      }
      if (manual && root.MCxAi.promptLogin) root.MCxAi.promptLogin();
      j.notice = 'Sign in under Settings → AI & Plans to continue.';
      j.err = 'unlogged';
      if (manual) S.open = true;
      render();
      return;
    }
    if (!aiReady()) {
      if (isCloud && manual && root.MCxAi && root.MCxAi.loginWithGoogle) {
        j.notice = 'Starting Google sign-in…';
        j.err = 'unlogged';
        S.open = true;
        render();
        root.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            j.notice = 'Sign-in was cancelled. Try again when you are ready.';
            j.err = 'unlogged';
            render();
          } else {
            run(mode, true, force);
          }
        });
        return;
      }
      j.notice = isCloud
        ? 'Sign in under Settings → AI & Plans to continue.'
        : 'No AI model is set up. Add a key in AI Settings, then try again.';
      j.err = isCloud ? 'unlogged' : 'nokey';
      /* 没钥匙这件事只有他自己按过才值得把卡摊开告诉他；自动生成那一趟悄悄不发作 */
      if (manual) S.open = true;
      render();
      return;
    }

    var built = buildPrompt(mode);
    j.running = true;
    j.manual = !!manual;
    j.notice = '';
    j.err = '';
    j.text = '';
    j.parsed = null;
    j.controller = new AbortController();
    var gen = S.gen;
    if (manual || (S.rec && S.rec.auto)) S.open = true;
    render();

    function alive() { return gen === S.gen && S.card && S.jobs[mode] === j; }

    root.MCxAi.send({
      profile: SLOT,
      feature: mode === 'explain' ? 'Assignment guide, plain words' : mode === 'plan' ? 'Assignment plan check' : 'Assignment guide',
      model: safeModel(),
      messages: [{ role: 'user', content: built }],
      signal: j.controller.signal,
      onPoolUsed: function (val) {
        if (alive()) {
          j.poolUsed = !!val;
          render();
        }
      },
      onDelta: function (piece) { if (alive()) j.text += piece; },
      onStatus: function (msg) { if (alive()) j.notice = msg; },
      /* 钱那一格只认服务自己在回包里报的数，所以整个对象原样留着，别在这里挑字段把它丢了。
         每一趟各占加法里的一项：Re-generate 那一趟是第二项，不换掉第一项 */
      onUsage: function (u, key) { if (alive()) j.calls = root.MCxAi.usageTrack(j.calls, u, key); }
    }).then(function (full) {
      if (!alive()) return;
      j.running = false;
      j.controller = null;
      if (full && !j.text) j.text = String(full);
      j.parsed = shape(mode, DBG.parseTags(j.text), S.result.ctx);
      j.from = 'model';
      j.at = Date.now();
      if (!j.parsed.failed) cacheWrite(mode, j.text, j.calls, j.poolUsed);
      if (manual || (S.rec && S.rec.auto)) S.open = true;
      render();
    }, function (err) {
      if (!alive()) return;
      j.running = false;
      j.controller = null;
      var d = root.MCxAi.describeError ? root.MCxAi.describeError(err, root.MCxAi.config(SLOT)) : { text: String((err && err.message) || err) };
      if (d.code !== 'abort') {
        j.notice = d.text || 'The request did not finish. Try again.';
        j.err = d.code || 'failed';
      }
      render();
    });
  }

  function safeModel() {
    try { return root.MCxAi.config(SLOT).model; } catch (e) { return undefined; }
  }

  function stopJob(mode) {
    var j = S.jobs && S.jobs[mode];
    if (!j || !j.controller) return;
    try { j.controller.abort(); } catch (e) {}
    j.running = false;
    j.controller = null;
    if (j.text) j.parsed = shape(mode, DBG.parseTags(j.text), S.result.ctx);
    render();
  }

  /* 三种问法共用一份素材，只有任务那一句话不同 */
  function buildPrompt(mode, customCtx) {
    var ctx = customCtx || (S.result && S.result.ctx);
    if (!ctx) return '';
    var lines = [];
    lines.push('You are helping a student see what one Canvas assignment is asking for.');
    if (mode === 'guide') {
      lines.push('Reply only with short tagged lines, nothing else:');
      lines.push('DELIVERABLE: one or two lines on what has to be handed in, including quantity and format only if the page states them');
      lines.push('STEP: three to six short lines in the order to work, each one thing the student can tick off');
      lines.push('GOTCHA: a requirement that is easy to miss, and it must end with the exact wording from the page in <angle brackets>');
      lines.push('CHECKPOINT: up to three lines on where the marks come from, only when a grading sheet is shown below');
      lines.push('OPEN QUESTION: up to two things the page does not actually say');
      lines.push('Hard rules: no JSON, no markdown, no headings, no encouragement, no time estimates, no dates or point values that are not written below.');
      lines.push('If a requirement is already obvious from the page, do not repeat it as a STEP.');
    } else if (mode === 'explain') {
      lines.push('Say the same requirements in plainer, shorter English for a student who finds the wording hard.');
      lines.push('Reply with PLAIN: lines, five at most. Add no requirement that is not below. No time estimates.');
    } else {
      lines.push('A student wrote this plan for the assignment below:');
      lines.push('"""');
      lines.push(collapse(S.planText).slice(0, 600));
      lines.push('"""');
      lines.push('Compare it against the requirements. Reply with tagged lines only:');
      lines.push('OK: a part of the plan that clearly meets a requirement, naming which');
      lines.push('MISS: a requirement the plan does not cover');
      lines.push('ASK: something the plan leaves unclear');
      lines.push('Five lines at most for each. Judge only what is written below; say nothing about quality you cannot check.');
    }
    lines.push('');
    lines.push('Title: ' + ctx.title + '. Page kind: ' + ctx.kind + '.');
    lines.push('Points possible: ' + (ctx.submission.pointsPossible == null ? 'not stated' : ctx.submission.pointsPossible) + '.');
    lines.push('Accepted submission types: ' + (ctx.submission.types.join(', ') || 'not stated') + '.');
    lines.push('Allowed file types: ' + (ctx.submission.allowedExtensions.join(', ') || 'not stated') + '.');
    lines.push('Dates: ' + (ctx.body.datesNote || 'not stated') + '.');
    if (ctx.rubric.status === 'available') {
      lines.push('');
      lines.push('Grading sheet (' + ctx.rubric.criteria.length + ' criteria' + (ctx.rubric.usedForGrading ? ', used for the grade' : ', shown but not used for the grade') + '):');
      ctx.rubric.criteria.forEach(function (c) {
        lines.push('- ' + c.title + (c.points ? ' [' + c.points + ' points]' : '') + (c.details ? ': ' + String(c.details).slice(0, 700) : ''));
      });
    } else if (ctx.rubric.status === 'unavailable') {
      lines.push('');
      lines.push('The rubric could not be read (' + ctx.rubric.why + '). Flag it as an open question; do not guess its criteria.');
    }
    var read = (ctx.resources.files || []).filter(function (f) { return f.text; });
    lines.push('');
    lines.push('Attachments whose text we actually have: ' + (read.length ? read.map(function (f) { return f.name || f.id; }).join(', ') : 'none') + '.');
    read.slice(0, 3).forEach(function (f) { lines.push('--- ' + (f.name || f.id) + ' ---'); lines.push(String(f.text).slice(0, 1800)); });
    var unread = (ctx.resources.files || []).filter(function (f) { return !f.text; });
    if (unread.length) lines.push('Attachments we have NOT read: ' + unread.map(function (f) { return (f.name || f.id); }).join(', ') + '. Do not summarise what they contain.');
    lines.push('');
    lines.push('The assignment description as the student reads it:');
    lines.push('"""');
    lines.push(String(ctx.body.text || '').slice(0, 9000) || '(empty)');
    lines.push('"""');
    return lines.join('\n');
  }

  /* ==== 校验：形状 + 出处 ==== */

  /* 回包不成形状＝失败；写了页面上没有的数字或日子＝不进主列表，只在 details 里点名 */
  function shape(mode, parsed, ctx) {
    var out = {
      what: [], check: [], watch: [], checkpoints: [], questions: [], plain: [],
      ok: [], miss: [], ask: [], unverified: [], notes: [], failed: false
    };
    if (mode === 'explain') {
      out.plain = (parsed.PLAIN || []).concat(parsed.other || []);
      if (!out.plain.length) out.failed = true;
      return out;
    }
    if (mode === 'plan') {
      out.ok = parsed.OK || [];
      out.miss = parsed.MISS || [];
      out.ask = parsed['OPEN QUESTION'] || [];
      return out;
    }
    var ground = groundText(ctx);
    out.what = (parsed.DELIVERABLE || []).slice(0, MAX_WHAT).map(capFirst);
    out.check = (parsed.STEP || []).map(capFirst);
    out.checkpoints = parsed.CHECKPOINT || [];
    out.questions = parsed['OPEN QUESTION'] || [];
    (parsed.GOTCHA || []).forEach(function (line) {
      var m = /<([^>]{6,200})>/.exec(line);
      var quote = m ? collapse(m[1]) : '';
      var text = collapse(line.replace(/<[^>]*>/g, ''));
      if (!quote || ground.indexOf(quote.toLowerCase()) < 0) {
        out.unverified.push('GOTCHA without a quote we can find on the page: ' + line);
        return;
      }
      out.watch.push({ text: capFirst(text), quote: quote });
    });
    if (!out.what.length && !out.check.length) {
      out.failed = true;
      out.notes.push('The reply did not include a deliverable or a next step.');
    }
    out.check = out.check.slice(0, MAX_STEPS);
    if ((parsed.STEP || []).length > MAX_STEPS) out.notes.push('The model wrote ' + parsed.STEP.length + ' steps; only the first ' + MAX_STEPS + ' are shown.');
    var claims = out.what.concat(out.watch.map(function (w) { return w.text + ' ' + w.quote; }));
    claims.forEach(function (line) {
      var bad = unsupportedNumbers(line, ground);
      if (bad.length) out.unverified.push('A number that is not on the page (' + bad.join(', ') + '): ' + line);
    });
    if (parsed.other && parsed.other.length) out.unverified = out.unverified.concat(parsed.other.map(function (t) { return 'Line without a known tag: ' + t; }));
    if (!out.watch.length) out.notes.push('No easy-to-miss requirement stood out that we could point at in the page, so that block is left off.');
    return out;
  }

  /* 只有"事实那一类"行才查数字：步骤里的"3 sources"是干活的说法，不是页面上的要求 */
  function unsupportedNumbers(line, ground) {
    var out = [];
    var lows = ground.toLowerCase();
    String(line).replace(/\d+(?:\.\d+)?/g, function (num) {
      if (lows.indexOf(num) < 0 && Number(num) > 1) out.push(num);
      return num;
    });
    var months = /january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;
    var found = String(line).match(months);
    if (found && !months.test(ground)) out.push(found[0]);
    return out.slice(0, 4);
  }

  function groundText(ctx) {
    var bits = [ctx.body.text || '', ctx.title || ''];
    (ctx.rubric.criteria || []).forEach(function (c) {
      bits.push(c.title + ' ' + (c.details || ''));
      (c.ratings || []).forEach(function (r) { bits.push((r.description || '') + ' ' + (r.long_description || '') + ' ' + (r.points == null ? '' : r.points)); });
    });
    (ctx.resources.files || []).forEach(function (f) { if (f.text) bits.push(f.text.slice(0, 4000)); if (f.name) bits.push(f.name); });
    (ctx.related.pageRefs || []).forEach(function (p) { if (p.text) bits.push(p.text.slice(0, 4000)); });
    return collapse(bits.join(' ')).toLowerCase();
  }

  /* ==== 地址变了就换一份，同一页里 React 重画也得找回来 ==== */

  function ensureMount() {
    if (S.card && S.card.isConnected) return true;
    if (!S.result) return false;
    /* 站点自己把那一块重画掉了会反复回到这里：没正文的那一屏每次都要当场回绝，
       不然 retryAnchor() 那 12 趟会把卡又挂回去 */
    if (S.rec && S.rec.emptyPage) return false;
    var anchor = findAnchor(S.result.ctx);
    if (!anchor.node) { S.anchor = anchor.why; return false; }
    mount(anchor);
    return !!(S.card && S.card.isConnected);
  }

  /* 读失败也要挂得上：拿不到判值就退到说明块或标题那一行，把失败原因写在页面上而不是咽下去 */
  function mountError() {
    if (S.card && S.card.isConnected) { render(); return true; }
    var a = errorAnchor();
    if (!a.node) { S.anchor = a.why; return false; }
    S.open = true;
    mount(a);
    return !!(S.card && S.card.isConnected);
  }

  var lastHref = '';
  var retryTimer = 0;

  function boot() {
    DATA = root.MCxAssignData; AN = root.MCxAnalyze; BASE = root.MCxAssignBaseline; DBG = root.MCxAssignDebug;
    if (!DATA || !AN || !BASE || !DBG) return;
    if (!visible()) { teardown(); return; }
    var target = DATA.currentTarget();
    if (!target) { if (S.card) teardown(); return; }
    if (location.href !== lastHref) {
      lastHref = location.href;
      S.target = target;
      S.gen++;
      S.result = null; S.collected = null; S.rec = null; S.error = ''; S.loading = false;
      S.open = false; S.details = false; S.planOpen = false; S.planText = '';
      S.jobs = newJobs();
      S.notice = '';
      /* 换页时这张卡要是还借在抽屉里，那一扇会留着上一页的答案：先还回去再拆 */
      if (S.embedded && drawer() && drawer().unembed) { try { drawer().unembed(); } catch (e) {} }
      S.embedded = false;
      if (S.card) { S.card.remove(); S.card = null; }
      mountEarly();
      analyze(false);
      retryAnchor();
    } else if (S.result && (!S.card || !S.card.isConnected)) {
      /* 站点自己把那一块重画掉了：找回锚点重挂，内容一个字不重问 */
      ensureMount();
    }
  }

  /* Canvas 的说明常在 collect 之后才由 React 画出来，所以重挂要自己再来几趟 */
  function retryAnchor() {
    var tries = 0;
    clearInterval(retryTimer);
    retryTimer = setInterval(function () {
      tries++;
      if (S.card && S.card.isConnected) { clearInterval(retryTimer); return; }
      if (tries > 12 || !S.result) { clearInterval(retryTimer); return; }
      ensureMount();
    }, 400);
  }

  /* 2026-10-12：把 Canvas 正文上方突兀的锁定提示移到上方的 Due / Points / Submitting / Available 这一栏中，整行加粗显示
     2026-10-13：作业还没开放那一屏没有 #assignment_show，那一排在另一套名字里
     （#content > .assignment_header > ul#assignment_student_details）＝同一句锁定的话，两种版式一起管 */
  function relocateLockNotice() {
    try {
      var overview = document.querySelector('.student-assignment-overview, #content > .assignment_header > #assignment_student_details');
      if (!overview) return;
      if (overview.querySelector('.mcx-lock-overview-item')) return;

      var rootEl = document.getElementById('assignment_show') || document.getElementById('content');
      if (!rootEl) return;

      var walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
      var textNode = null;
      while ((textNode = walker.nextNode())) {
        var p = textNode.parentElement;
        if (!p || p.closest('h1, h2, h3, h4, h5, .assignment-title, .title-content, .student-assignment-overview, .description, #assignment_description, .user_content, .mcx-guide')) continue;
        var val = (textNode.nodeValue || '').trim();
        if (/^This assignment (?:was|is) locked\b/i.test(val)) {
          break;
        }
      }

      if (!textNode) return;

      var lockText = (textNode.nodeValue || '').trim();
      textNode.nodeValue = '';

      var li = document.createElement('li');
      li.className = 'mcx-lock-overview-item';
      li.textContent = lockText;
      overview.appendChild(li);
    } catch (e) {}
  }

  /* 2026-10-12 他页上实测，作业页底部两处白：
       #kl_objectives            rgb(255,255,255) 1100×1302 —— DesignPlus 那块没有类名也没有行内样式，
                                 是它那张外部表按 id 铺的，CSS 认不出"它现在是白的"
       .module-sequence-footer-content  rgb(250,250,249) —— 这颗确实是 --mc-background-1，
                                 他猜对了；不一致是因为这套主题的页面底走的是 --mc-buttons（米色），
                                 而 background-1 是近白，两档本来就不是一层
     浅色那块按大纲页同一办法当场量底色再打标记（.bcx-dp-card＝换档＋收圆，.bcx-dp-plate＝只收圆不动色，
     深色那几条蓝／绿抬头是老师自己选的，底色一律不碰）。 */
  function tagAssignmentPlates() {
    var root = document.getElementById('assignment_show') || document.querySelector('[data-testid="assignments-2-student-view"], .description.user_content, #content');
    if (!root) return;

    /* 极速门禁：普通 Canvas 页面没有 DesignPlus 外壳容器时，0微秒直接退出，绝不空转 */
    var dpContainer = root.querySelector(':is([class*="kl_wrapper"], [id^="kl_"], #dp-wrapper, .dp-wrapper)');
    if (!dpContainer) return;

    var nodes = [];
    try {
      nodes = [].slice.call(dpContainer.parentElement.querySelectorAll(
        ':is([class*="kl_wrapper"], [id^="kl_"], #dp-wrapper, .dp-wrapper) > *'));
    } catch (e) { return; }
    if (!nodes.length) return;
    var needWork = false;
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (!n.classList.contains('mc-dp-card') && !n.classList.contains('bcx-dp-card') && !n.classList.contains('mc-dp-plate') && !n.classList.contains('bcx-dp-plate')) {
        needWork = true;
        break;
      }
    }
    if (!needWork) return;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.classList.contains('mc-dp-card') || el.classList.contains('bcx-dp-card') || el.classList.contains('mc-dp-plate') || el.classList.contains('bcx-dp-plate')) continue;
      var m = null;
      try { m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/); } catch (e) {}
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) < 0.05) continue;
      var lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      if (lum > 0.75) {
        el.classList.add('mc-dp-card', 'bcx-dp-card');
        // 当卡片被确认为白卡并即将铺上深色底（background-0）时，重置卡内文字的对比度标记，
        // 允许智能对比度引擎立即把里面的黑灰字翻成亮白 text-0
        try {
          var subs = el.querySelectorAll('[data-bcx-contrast-done]');
          for (var k = 0; k < subs.length; k++) {
            delete subs[k].dataset.bcxContrastDone;
          }
        } catch (e) {}
      } else {
        el.classList.add('mc-dp-plate', 'bcx-dp-plate');
      }
    }
  }

  var bumpTimer = 0;
  function watchDom() {
    if (!document.body || !root.MutationObserver) return;
    var mo = new root.MutationObserver(function () {
      /* 锁定那行不能等 debounce：它本来就是那一排里的一行字，晚一帧就是"半秒后才冒出来"。
         这颗很便宜（一个 querySelector，只有在栏里还没有那一行时才走一遍文字树），所以当场落 */
      relocateLockNotice();
      clearTimeout(bumpTimer);
      /* 重挂和重量宽度要合并成一趟：DesignPlus 那些块是晚到的，
         它们把正文宽度收窄以后，我们的卡得跟着再收一次 */
      bumpTimer = setTimeout(function () {
        /* 卡片还没挂出来也要重抄一次：正文那块常被 DesignPlus 晚一步收窄 */
        syncContentWidth();
        tagAssignmentPlates();
        if (S.result && S.card && S.card.isConnected) matchWidth();
        if (!S.result) return;
        if (!S.card || !S.card.isConnected) ensureMount();
      }, 100);
    });
    /* characterData 也要看：站点有时先把空壳插好、再往文字节点里写字，
       只盯 childList 就收不到那一趟，症状正是他报的"等半秒" */
    try { mo.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  }

  function startWatch() {
    /* 宽度这件事不能等取数回来：正文那一块的 max-width 是页面自己写的，一眼就能抄走，
       抄早一格，两张卡第一帧就是对的，不会先铺满再缩一下 */
    syncContentWidth();
    boot();
    relocateLockNotice();
    tagAssignmentPlates();
    var tick = function () {
      boot();
      relocateLockNotice();
      tagAssignmentPlates();
      syncContentWidth();
    };
    window.addEventListener('popstate', tick);
    window.addEventListener('hashchange', tick);
    setInterval(tick, 500);
    window.addEventListener('resize', function () {
      clearTimeout(bumpTimer);
      bumpTimer = setTimeout(matchWidth, 200);
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    watchDom();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWatch);
  else startWatch();

  root.MCxAssignGuide = {
    state: S,
    findAnchor: findAnchor,
    syncContentWidth: syncContentWidth,
    shape: shape,
    groundText: groundText,
    unsupportedNumbers: unsupportedNumbers,
    buildPrompt: buildPrompt,
    hintCell: hintCell,
    render: render,
    boot: boot,
    analyze: analyze,
    run: run,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    floatOn: floatIn,
    floatOff: floatOut,
    /* 缓存这两颗和本机断言要用的 teardown 导出来，是为了让断言能直接问"这一版内容存过没有"，
       不是为了给页面上多摆一颗按钮 */
    cacheRead: cacheRead,
    cacheWrite: cacheWrite,
    teardown: teardown,
    triggerBackgroundPreload: triggerBackgroundPreload,
    /* 这张卡是新加的视觉，所以留一颗"整个不画"的出口，藏在设置的 Advanced 那一折里 */
    hide: function () { try { localStorage.setItem(HIDDEN_KEY, '1'); } catch (e) {} teardown(); return 'the card will not appear on assignment pages'; },
    show: function () { try { localStorage.setItem(HIDDEN_KEY, '0'); } catch (e) {} boot(); return 'the card is back'; },
    hidden: function () { return !visible(); }
  };
  root.ModernCanvasAssignmentGuide = root.MCxAssignGuide;

  /* ==== 后台自动分析分数、预读<=8MB文档并分级汇总 ==== */
  var bgPreloadBusy = false;
  var bgPreloadCursor = 0;
  function triggerBackgroundPreload(items) {
    /* AI 总开关关掉：这一趟整块不开。它是那三分钟的轮询和 content.js 现叫的那两颗共同的入口，
       所以拦在这里，两条路一起断，也就不用去摘那个 setInterval（它照跑，只是每一趟直接返回） */
    if (window.mcAiOn && !window.mcAiOn()) return;
    if (bgPreloadBusy || !items || !items.length) return;

    var valid = items.filter(function (it) {
      return it && (it.course_id || it.courseId) && (it.id || it.assignment_id);
    });
    if (!valid.length) return;

    // 滑动窗口：避免每次轮询都重复前几个，每次顺延检查 5 个，循环轮转
    if (bgPreloadCursor >= valid.length) bgPreloadCursor = 0;
    var candidates = valid.slice(bgPreloadCursor, bgPreloadCursor + 5);
    bgPreloadCursor += 5;

    bgPreloadBusy = true;
    var idx = 0;
    function nextItem() {
      if (idx >= candidates.length) {
        bgPreloadBusy = false;
        return;
      }
      var it = candidates[idx++];
      var cId = it.course_id || it.courseId;
      var aId = it.id || it.assignment_id;
      var target = { kind: 'assignment', courseId: Number(cId), id: Number(aId) };

      DATA.collect(target, function () {}, { force: false }).then(function (collected) {
        if (!collected || !collected.ctx) return nextItem();
        var ctx = collected.ctx;
        // 挑选小于 8MB 的未提取附件预读（无论此时是否达到门槛，只要是附件且开启了 autoRead 都提前在本地缓存）
        var autoReadEnabled = (!BASE || !BASE.autoReadOn || BASE.autoReadOn());
        var unread = autoReadEnabled ? (ctx.resources.files || []).filter(function (f) {
          return f.status !== 'extracted' && f.bytes && f.bytes <= DATA.MEASURE_BYTES_CAP;
        }) : [];
        var assignTitle = ctx.title || ('Assignment ' + ctx.assignmentId);
        var readJobs = unread.map(function (f) {
          return function () {
            setGlobalReadingStatus('Reading: ' + assignTitle + ' (' + (f.name || 'file') + ')');
            return DATA.readFile(f, ctx.courseId, null, { assignmentId: ctx.assignmentId, assignmentName: assignTitle }).then(function (res) {
              setGlobalReadingStatus('');
              return res;
            }).catch(function (err) {
              setGlobalReadingStatus('');
              return err;
            });
          };
        });

        function finishPreload() {
          setGlobalReadingStatus('');
          var updatedResult = AN.analyze(ctx, weightsFor());
          var updatedRec = BASE.recommend(updatedResult);
          var autoMeta = getAutoMeta();
          var k = updatedResult.key;
          var curCount = (autoMeta[k] && autoMeta[k].count) || 0;

          // 对于指数达标（Recommended / auto）的作业，自动发送给 AI 汇总（最多自动2次）
          if (updatedRec.auto && curCount < 2) {
            var cached = cacheRead('guide', updatedResult);
            if (!cached) {
              var built = buildPrompt('guide', ctx);
              if (root.MCxAi && root.MCxAi.send && aiReady()) {
                root.MCxAi.send({
                  profile: SLOT,
                  feature: 'Assignment guide background',
                  model: safeModel(),
                  messages: [{ role: 'user', content: built }]
                }).then(function (full) {
                  if (full) {
                    var parsed = shape('guide', DBG.parseTags(String(full)), ctx);
                    if (!parsed.failed) {
                      cacheWrite('guide', String(full), [], false, updatedResult);
                      // 只有真的生成并缓存成功才消耗自动生成次数；未配置、网络失败和空回复都可下次重试。
                      autoMeta[k] = { count: curCount + 1, lastBodyLength: (ctx.body && ctx.body.text ? ctx.body.text.length : 0) };
                      saveAutoMeta(autoMeta);
                    }
                  }
                  nextItem();
                }).catch(function () { nextItem(); });
                return;
              }
            }
          }
          nextItem();
        }

        if (readJobs.length) {
          var rNext = 0;
          function runRead() {
            if (rNext >= readJobs.length) return finishPreload();
            Promise.resolve(readJobs[rNext++]()).then(runRead, runRead);
          }
          runRead();
        } else {
          finishPreload();
        }
      }).catch(function () {
        setGlobalReadingStatus('');
        nextItem();
      });
    }
    nextItem();
  }

  // 每 3 分钟轮询一次背景预载（若用户停留在页面上）
  setInterval(function () {
    try {
      var cachedAssignments = JSON.parse(localStorage.getItem('bc_cache_assignments_v2') || '[]');
      if (Array.isArray(cachedAssignments) && cachedAssignments.length) {
        triggerBackgroundPreload(cachedAssignments);
      }
    } catch (e) {}
  }, 3 * 60 * 1000);
})(typeof window !== 'undefined' ? window : this);
