(function () {
  'use strict';

  // 非 Canvas 站点直接退出，不干扰任何其他网页
  if (typeof window.mcIsCanvas !== 'undefined') {
    if (!window.mcIsCanvas) return;
  } else {
    var h = window.location.hostname.toLowerCase();
    var isAuto = (h === 'instructure.com' || h.endsWith('.instructure.com') ||
                  h === 'canvas.net' || h.endsWith('.canvaslms.com') ||
                  h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
    var customStr = '';
    try { customStr = localStorage.getItem('mc_custom_domains_cache') || ''; } catch (e) {}
    if (!isAuto && (!customStr || customStr.indexOf(h) === -1)) return;
  }

  /* "你到底重载了没有"这件事以前只能靠问，而且 manifest 那个版本号没人每轮改，
     1.3.60 已经骗过一次了。所以把批次号直接钉在 <html> 上，外面一读就知道页面上跑的是哪一批：
       data-mcx-build 这一批 content.js 有没有开始跑（挂在最前，后面抛错也还在）
       data-mcx-nai   injecting／on／blocked，见文件末尾 planner 容错那一节
     改完代码要动下面这一行，不然读出来分不出新旧 */
  const BCX_BUILD_TAG = '2026-10-17-R6';
  document.documentElement.setAttribute('data-mcx-build', BCX_BUILD_TAG);

  // 步骤级安全包裹（必须置顶，供整个脚本生命周期内所有挂载和自愈步骤调用）
  function mcStep(name, fn) {
    try {
      if (typeof fn === 'function') fn();
    } catch (e) {
      console.error('[BCX] 步骤失败：' + name, e);
    }
  }

  const isTopWindow = (window.self === window.top);

  // 确保当前域的 mc_custom_domains_cache 与 chrome.storage.sync 保持同步
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['mc_custom_domains'], function (res) {
      if (res && Array.isArray(res.mc_custom_domains)) {
        try {
          var curList = JSON.parse(localStorage.getItem('mc_custom_domains_cache') || '[]');
          var merged = Array.from(new Set(curList.concat(res.mc_custom_domains)));
          localStorage.setItem('mc_custom_domains_cache', JSON.stringify(merged));
        } catch (e) {}
      }
    });
  }

  /* 后台问商店问到的结论就存在 mc_update_available 这一格（见 background.js 那颗 mcSetUpdateFlag）。
     我们只知道"有没有新版"，拿不到商店的版本号。页面这边只维护一个布尔：
     画不画、什么时候画交给 mcUiPass 里那颗 mcUpdateHint，这一格一变就把那一趟排上，
     不在这里直接搭节点，免得和 300 毫秒那一趟抢同一个 id */
  let mcUpdateAvailable = false;
  const MC_UPDATE_HINT_ID = 'mcx-update-hint';
  const MC_UPDATE_DISMISS_KEY = 'mc_update_hint_dismissed_at';
  const MC_UPDATE_REMIND_MS = 7 * 24 * 60 * 60 * 1000;

  function mcReadUpdateFlag(res) {
    const v = res && res.mc_update_available;
    const on = !!(v && v.status);
    if (on === mcUpdateAvailable) return;
    mcUpdateAvailable = on;
    mcScheduleUiPass();
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['mc_update_available'], mcReadUpdateFlag);
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes.mc_update_available) {
          mcReadUpdateFlag({ mc_update_available: changes.mc_update_available.newValue });
        }
      });
    }
  }

  /* 仪表盘这一屏加载时把后台叫醒来问一次（后台睡着时读到的是上一次那一格的值，
     消息一进去 SW 就醒、自己跑一遍检查）。非仪表盘页不发，省得每开一页都问商店一次 */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    const mcPath = window.location.pathname;
    if (mcPath === '/' || mcPath.includes('/dashboard') || !mcPath.includes('/')) {
      try {
        chrome.runtime.sendMessage({ type: 'mc_check_update' }, function (res) {
          if (chrome.runtime.lastError) return;
          mcReadUpdateFlag({ mc_update_available: res && res.update });
        });
      } catch (e) {}
    }
  }

  /* [实测 2026-10-11 日历页] 往 :root 写一颗自定义属性＝所有引用它的规则整棵作废重算
     （这一页一次全页重算实测 69–83ms，摘掉我们那层也有 46–60ms）。取色那一趟每 2 秒把
     30 来颗 token 重写一遍，绝大多数时候一个值都没变，白付 30 次失效。
     读行内值是纯属性读取、不碰布局也不碰样式，比一次重算便宜得多，所以一律先比后写。
     传空值＝撤掉这一颗，本来就空就别动。画面结果与逐条无脑写完全一致 */
  function mcSetRootVar(name, value) {
    const st = document.documentElement.style;
    if (value === null || value === undefined || value === '') {
      if (st.getPropertyValue(name)) st.removeProperty(name);
      return;
    }
    if (st.getPropertyValue(name) === value) return;
    st.setProperty(name, value);
  }

  /* [实测 2026-10-11 答题屏] 这一份以前在每个 TinyMCE 写作帧里都完整跑了一遍：
     帧的地址是 about:blank，上面那颗"在不在 Canvas"的判据里有一条是"页面上有 brandable_css 的表"，
     而 TinyMCE 自己往帧里也引了三张站点表（当场量到），于是四张编辑器帧＝四份 content.js 全套：
     开局整趟 mcUiPass ＋ 头 20 秒每 500ms 一趟 ＋ 每 2 秒取色 ＋ 挂满帧内变动就排班的观察器，
     趟里 pinOurNav 读 getComputedStyle＝每敲一键在该帧强制一次同步重算。
     症状严丝合缝：编辑器开局抢不到主线程＝"Loading…"一直转；打字＝巨卡。
     帧里要的只是"有颜色"，那件事 theme-frame-boot.js（document_start，抄变量＋类名＋主题表）
     和 preview-frame.css 全包了，不需要这一万行。交作业预览那一帧（#preview_frame）同源，
     镜像照样喂到＝行为不变。所以：非顶层窗口，现在一个字节都不许多跑。 */
  if (!isTopWindow) {
    console.info('[MCX] content.js 帧内出口 build=' + BCX_BUILD_TAG);
    return;
  }

  /* [2026-10-11 第六轮 他"好了点但还是卡"] 答题/起飞那一屏（/taking/）交给测验引擎，
     我们只开机刷一次颜色，之后所有周期性重活一律不排——这一屏没有仪表盘卡、没有原生下拉、
     Today 按钮也不在这页，那几颗定时器（每 500ms 的 UI 巡检、每 2 秒的取色轮询、每 1.5 秒的
     卡片趟）加每变动排班的 body 观察器，回调里都带 getComputedStyle/offsetHeight＝强制同步重排，
     跟 Learnosity 自己的重排叠在一起＝越打越卡。纯 CSS 的第 52 节换皮不吃这些，照常生效。 */
  const MCX_QUIET_PAGE = /\/taking\//.test(location.pathname);

  /* =========================================
   * 1. 顶层窗口 (Top Window) 状态机逻辑
   * 状态模式: 'NORMAL' (默认) | 'EXPAND' (网页内全屏) | 'FULLSCREEN' (系统物理全屏)
   * ========================================= */
  if (isTopWindow) {
    let currentMode = 'NORMAL';
    let targetContainer = null;

    function getDocPreviewContainer() {
      const candidates = [
        document.querySelector('.file-preview-holder'),
        document.querySelector('.canvas_file_preview'),
        document.querySelector('#doc_preview'),
        document.querySelector('.ef-file-preview-frame'),
        document.querySelector('.docviewer-holder')
      ];

      for (let el of candidates) {
        if (el && el.offsetParent !== null) {
          return el;
        }
      }

      const iframes = Array.from(document.querySelectorAll('iframe'));
      const previewIframe = iframes.find(f => {
        const src = f.src || '';
        return src.includes('canvadocs') || src.includes('docviewer') || src.includes('file_preview') || src.includes('courses');
      });

      if (previewIframe) {
        return previewIframe.parentElement || previewIframe;
      }

      return null;
    }

    function broadcastState(mode) {
      currentMode = mode;
      document.querySelectorAll('iframe').forEach(f => {
        try {
          f.contentWindow.postMessage({ type: 'CANVAS_VIEW_MODE_CHANGED', mode: mode }, '*');
        } catch (e) {}
      });
      // 下面那圈只发得进 iframe。作业页那两颗就挂在顶层文档自己身上，不顺手叫它一声，
      // 点了 EXPAND 字不会翻成 EXIT
      try { renderButtonsState(mode); } catch (e) {}
      // 外部工具那两颗长在右下角的卡片上，不在 EXPAND_SURFACES 那四种工具条里，
      // 上面那一趟找不到它们，得单独叫一声，否则点了 EXTEND 字不会翻成 EXIT
      try { mcRenderLtiSizeButtons(mode); } catch (e) {}
      window.dispatchEvent(new Event('resize'));
    }

    let switchingToExpand = false;
    // 进原生全屏之前站在哪一档。原生全屏退出来，浏览器只说"全屏没了"，不说它前面是谁。
    // 不记这一笔，"先 EXPAND 再全屏"的人退出全屏会直接掉回普通状态：覆盖还挂在框上，按钮却写着 EXPAND
    let modeBeforeNativeFs = null;
    // 这一轮 EXPAND 要盖哪一块：'editor' 是写作业那个输入框，'viewer' 是文档阅读器。
    // 由发起请求的那一层带上来，退出原生全屏后重新盖回去时还要用它
    let expandSurface = 'viewer';
    let activeEditorId = null;

    function getExpandTarget(surface, editorId) {
      if (surface === 'editor') {
        if (editorId) {
          const exact = document.querySelector('[data-canvas-theater-editor="' + editorId + '"]');
          if (exact) return exact;
        }
        // 编辑器那两颗按钮就在顶层文档里，所以顶层顺着我们自己那颗就能找到要盖的框
        const btn = document.getElementById('canvas-inline-theater-btn');
        const ed = btn && btn.closest('.ic-RichContentEditor, #editCalendarEventFull .rce-wrapper, #new-quizzes-root .rce-wrapper, [data-testid="DiscussionEdit-container"] .rce-wrapper, #wiki_page_body');
        if (ed) return ed;
      }
      if (surface === 'lti') return getLtiExpandTarget();
      return getDocPreviewContainer();
    }

    function applyExpandOverlay(surface, sized) {
      const container = getExpandTarget(surface, activeEditorId);
      if (!container) return false;
      targetContainer = container;
      targetContainer.classList.add('canvas-theater-fullscreen-target');
      // 外部工具这一格另走行内 !important（见 mcLtiOverlayOn 上面那段）：
      // 挂类名那套在这一块页面上没贴住屏幕，换成行内才不用跟站点的规则比权重。
      // 也不给它加 canvas-theater-expand：那一档靠藏掉 #header 让位，
      // 这一格改成把祖先的 z 一起抬上去直接盖住它，藏不回来也不会留下"导航再也不见"
      if (surface === 'lti') return mcLtiOverlayOn(container, sized !== false);
      // 左边那条导航（#header，fixed，z-index 1200）压得住我们：我们这块在 #main 里，
      // 出了 #main 那一层只算 10。藏它的规则落在 theater.css 的 html.canvas-theater-expand #header
      document.documentElement.classList.add('canvas-theater-expand');
      return true;
    }

    function clearExpandOverlay() {
      document.documentElement.classList.remove('canvas-theater-expand');
      mcLtiOverlayOff();
      if (targetContainer) {
        targetContainer.classList.remove('canvas-theater-fullscreen-target');
        targetContainer = null;
      }
      document.querySelectorAll('.canvas-theater-fullscreen-target').forEach(el => {
        el.classList.remove('canvas-theater-fullscreen-target');
      });
    }

    function enterExpand(surface) {
      if (!getExpandTarget(surface, activeEditorId)) return;

      // 如果原本是系统全屏，退出系统全屏，并设置标志位防止 fullscreenchange 把 EXPAND 冲掉
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        switchingToExpand = true;
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen().catch(() => {});
      }

      if (!applyExpandOverlay(surface)) return;
      broadcastState('EXPAND');
    }

    function exitExpand() {
      clearExpandOverlay();
      broadcastState('NORMAL');
    }

    function switchMode(requestedMode, surface, editorId) {
      if (surface) expandSurface = surface;
      if (editorId) activeEditorId = editorId;
      if (requestedMode === 'EXPAND') {
        if (currentMode === 'EXPAND') {
          exitExpand(); // 已经在 EXPAND，点击则退出
        } else {
          enterExpand(expandSurface); // 从 NORMAL 或 FULLSCREEN 直接切到 EXPAND
        }
      } else if (requestedMode === 'FULLSCREEN') {
        if (currentMode === 'FULLSCREEN') {
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen().catch(() => {});
          }
          // 外部工具进全屏时我们给它挂过覆盖层（见下面那两条 lti），退出得一起摘掉。
          // 阅读器／编辑器那一格本来就没挂，这一句对它们是空转
          clearExpandOverlay();
          broadcastState('NORMAL');
        } else {
          // 如果当前是 EXPAND，先解除网页内全屏样式，再进入全屏
          if (currentMode === 'EXPAND') clearExpandOverlay();
          // 外部工具这一格不认"整页全屏"那个退路：找不到那块框就什么都不做，
          // 否则 requestFullscreen 会落到 documentElement 上，屏幕上变成整站放大
          if (expandSurface === 'lti' && !getLtiExpandTarget()) return;
          // 外部工具反过来要先按住那些碍事的祖先，但这一档不钉尺寸：
          // 系统全屏的宽高归浏览器定，我们照 EXTEND 那样钉成"进全屏前的 innerWidth"，
          // 送上屏幕以后就是一块原来大小的框贴在黑底左上角
          if (expandSurface === 'lti') applyExpandOverlay('lti', false);
          const container = getExpandTarget(expandSurface) || document.documentElement;
          if (container.requestFullscreen) {
            container.requestFullscreen().catch(() => {});
          } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen().catch(() => {});
          }
          broadcastState('FULLSCREEN');
        }
      } else if (requestedMode === 'EXIT_ALL') {
        if (currentMode === 'EXPAND') {
          exitExpand();
        } else if (currentMode === 'FULLSCREEN') {
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen().catch(() => {});
          }
          clearExpandOverlay();
          modeBeforeNativeFs = null;
          broadcastState('NORMAL');
        }
      }
    }

    // 监听系统原生全屏变化事件
    function handleFullscreenChange() {
      const isNativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!isNativeFs) {
        // 如果是因为点击了 EXPAND 触发的退出原生全屏，不要把模式刷成 NORMAL
        if (switchingToExpand) {
          switchingToExpand = false;
          // 重新确保 expand 样式仍然生效
          applyExpandOverlay(expandSurface);
          broadcastState('EXPAND');
          return;
        }

        if (currentMode === 'FULLSCREEN') {
          const back = modeBeforeNativeFs;
          modeBeforeNativeFs = null;
          // 原生全屏之前是 EXPAND（编辑器那一颗是 Canvas 自己发起的，我们只是旁观），
          // 退出来要回到 EXPAND 那一档，覆盖本来就还挂着
          if (back === 'EXPAND' && applyExpandOverlay(expandSurface)) {
            broadcastState('EXPAND');
          } else {
            clearExpandOverlay();
            broadcastState('NORMAL');
          }
        }
      } else {
        switchingToExpand = false;
        modeBeforeNativeFs = currentMode;
        broadcastState('FULLSCREEN');
      }
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    // 接收来自当前页面或子 iframe 的模式切换请求
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'CANVAS_REQUEST_MODE') {
        switchMode(e.data.mode, e.data.surface, e.data.editorId);
      } else if (e.data && e.data.type === 'CANVAS_REQUEST_MODE_SYNC') {
        // 那一层把我们插的按钮换掉过，补回来的那颗不知道现在是哪一档，来要一次当前状态
        broadcastState(currentMode);
      } else if (e.data && e.data.type === 'CANVAS_DOCUMENT_THEME_SYNC') {
        broadcastDocumentTheme(localStorage.getItem('mc_lti_tint') === '1');
      } else if (e.data && e.data.type === 'CANVAS_SET_DOCUMENT_THEME') {
        const enabled = !!e.data.enabled;
        localStorage.setItem('mc_lti_tint', enabled ? '1' : '0');
        try { chrome.storage.local.set({ mc_lti_tint: enabled ? '1' : '0' }); } catch (err) {}
        document.documentElement.classList.toggle('mc-lti-tint', enabled);
        document.documentElement.classList.toggle('mc-lti-notint', !enabled);
        applyDirectLtiTint(enabled);
        broadcastDocumentTheme(enabled);
      }
    });

    // 监听 Esc 键统一退出
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        switchMode('EXIT_ALL');
      }
    });
  }

  // Theme Document lives beside the PDF reader controls.  Keep the preference
  // shared with the old external-tool setting so an explicit choice follows the
  // user everywhere, while a missing preference now means off.
  function broadcastDocumentTheme(enabled) {
    document.querySelectorAll('iframe').forEach(f => {
      try { f.contentWindow.postMessage({ type: 'CANVAS_DOCUMENT_THEME_CHANGED', enabled: enabled }, '*'); } catch (e) {}
    });
  }

  /* =========================================
   * 2. 工具栏按钮 (EXPAND & FULLSCREEN) UI 与事件管理
   * ========================================= */

  // 这两颗按钮只该长在"自己就带一颗全屏按钮"的那一块上，目前认两种（顺序就是优先级）：
  //   viewer 文档阅读器（PDF 那一层，工具条在 canvadocs 那个独立页面里）
  //   editor 写作业那个富文本编辑器（底栏里 Canvas 自己就有一颗 Fullscreen）
  // 以前是整张页面扫名字里带 fullscreen 的按钮，所以作业页那颗被我们连功能一起抢走了。
  // 现在先认工具条，认不出按钮就一颗都不造
  const EXPAND_SURFACES = [
    { kind: 'viewer', sel: '.ViewerControls' },
    { kind: 'viewer', sel: '.canvashdr' },
    { kind: 'viewer', sel: '.docviewer-wrapper' },
    { kind: 'editor', sel: '.ic-RichContentEditor, #editCalendarEventFull .rce-wrapper, #new-quizzes-root .rce-wrapper, [data-testid="DiscussionEdit-container"] .rce-wrapper, #wiki_page_body' }
  ];

  function findFullscreenButton(bar) {
    try {
      const elements = Array.from(bar.querySelectorAll('button, a, div[role="button"]'));
      for (let el of elements) {
        if (el.id === 'canvas-inline-theater-btn') continue;
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
        if (label.includes('full screen') || label.includes('fullscreen') || label.includes('全屏')) {
          return el;
        }
      }

      const fsIcon = bar.querySelector('.icon-fullscreen, [class*="fullscreen"]');
      if (fsIcon && fsIcon.closest('button, [role="button"]')) {
        const b = fsIcon.closest('button, [role="button"]');
        if (b && b.id !== 'canvas-inline-theater-btn') return b;
      }
    } catch (e) {}

    return null;
  }

  function getExpandSurface() {
    for (const s of EXPAND_SURFACES) {
      for (const bar of document.querySelectorAll(s.sel)) {
        const btn = findFullscreenButton(bar);
        if (btn) return { kind: s.kind, btn: btn };
      }
    }
    return null;
  }

  // 打扮那颗原生全屏按钮，返回我们写字用的 span（不在就补一个，站点重画后这一趟就补回来）
  //
  // editor 走"只换字"：不抹它的孩子（图标靠 CSS 藏）、不接它的点击，
  // Canvas 自己的全屏行为原样留着。实测它的全屏就是把 .ic-RichContentEditor 这一框送上屏幕，
  // 跟我们 EXPAND 盖的是同一块，两颗按钮不打架
  //
  // viewer 走"接管"：抹掉重画＋自己接管点击。那颗按钮在跨来源的另一层里，它自己发起的
  // 全屏我们这边看不见也退不掉，而 EXPAND 必须和它落在同一个框上才切得动
  function dressFullscreenButton(btn, kind) {
    const relabelOnly = kind === 'editor';
    let span = btn.querySelector('.canvas-custom-fs-text');

    if (!span) {
      if (!relabelOnly) btn.innerHTML = '';
      span = document.createElement('span');
      span.className = 'canvas-custom-fs-text';
      span.textContent = 'FULLSCREEN';
      btn.appendChild(span);
    }

    if (!btn.classList.contains('canvas-unified-btn')) {
      btn.classList.add('canvas-unified-btn');
      if (!relabelOnly) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          try {
            window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'FULLSCREEN' }, '*');
          } catch (err) {}
        }, true);
      }
    }

    return span;
  }

  function renderButtonsState(mode) {
    try {
      const surface = getExpandSurface();
      if (!surface) return;

      const expandBtn = document.getElementById('canvas-inline-theater-btn');
      if (!expandBtn) return;

      const fsTextSpan = dressFullscreenButton(surface.btn, surface.kind);
      // 编辑器那一颗的 title 和高亮归 Canvas 自己（它的提示要跟着它自己的功能变），我们只翻字
      const ours = surface.kind === 'editor';

      if (mode === 'NORMAL') {
        // 两个都是待命状态
        expandBtn.classList.remove('active');
        expandBtn.textContent = 'EXPAND';
        expandBtn.title = 'Expand to page (Esc to exit)';

        fsTextSpan.textContent = 'FULLSCREEN';
        if (!ours) {
          surface.btn.classList.remove('active');
          surface.btn.title = 'Enter Full Screen';
        }
      } else if (mode === 'EXPAND') {
        // 当前是网页内全屏：EXPAND 变 EXIT，FULLSCREEN 保持待命随时允许直接切去真正全屏！
        expandBtn.classList.add('active');
        expandBtn.textContent = 'EXIT';
        expandBtn.title = 'Exit expand mode (Esc)';

        fsTextSpan.textContent = 'FULLSCREEN';
        if (!ours) {
          surface.btn.classList.remove('active');
          surface.btn.title = 'Switch to native full screen';
        }
      } else if (mode === 'FULLSCREEN') {
        // 当前是原生全屏：FULLSCREEN 变 EXIT，EXPAND 保持待命随时允许直接切回网页内全屏！
        fsTextSpan.textContent = 'EXIT';
        if (!ours) {
          surface.btn.classList.add('active');
          surface.btn.title = 'Exit full screen (Esc)';
        }

        expandBtn.classList.remove('active');
        expandBtn.textContent = 'EXPAND';
        expandBtn.title = 'Switch to page expand mode';
      }
    } catch (e) {}
  }

  function setupUnifiedButtons() {
    try {
      const surface = getExpandSurface();
      if (!surface) return;

      const originalBtn = surface.btn;
      if (!originalBtn.parentElement) return;

      let remounted = false;

      // 1. 打扮那颗原生全屏按钮
      if (!originalBtn.classList.contains('canvas-unified-btn') ||
          !originalBtn.querySelector('.canvas-custom-fs-text')) {
        dressFullscreenButton(originalBtn, surface.kind);
        remounted = true;
      }

      // 2. 创建 EXPAND 按钮，并且每趟把它按回原位：紧贴那颗全屏按钮的左边
      //    站点重画底栏时会把它自己的兄弟节点重新插一遍，我们那颗它不认识，就被留在中间，
      //    屏幕上就是 EXPAND 跑到了 +/− 那两颗的左边
      let expandBtn = document.getElementById('canvas-inline-theater-btn');
      if (!expandBtn) {
        expandBtn = document.createElement('button');
        expandBtn.id = 'canvas-inline-theater-btn';
        expandBtn.type = 'button';
        expandBtn.className = 'canvas-unified-btn';
        expandBtn.setAttribute('aria-label', 'Expand to Page');
        expandBtn.title = 'Expand to page (Esc to exit)';
        expandBtn.textContent = 'EXPAND';

        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          try {
            window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'EXPAND', surface: surface.kind }, '*');
          } catch (err) {}
        });

        remounted = true;
      }

      if (originalBtn.previousElementSibling !== expandBtn) {
        originalBtn.parentElement.insertBefore(expandBtn, originalBtn);
      }

      // 站点是 React 的，它重画工具条会把我们插的节点换掉。换掉之后补回来的这颗只会写死 'EXPAND'，
      // 屏幕上就是"已经全屏了按钮还写着 EXPAND"。补回来就向顶层要一次当前状态
      // （顶层自己那一层也一样：postMessage 发给 window.top 就是发给自己，走同一条路）
      if (remounted) {
        try {
          window.top.postMessage({ type: 'CANVAS_REQUEST_MODE_SYNC' }, '*');
        } catch (err) {}
      }
    } catch (e) {}
  }

  const TEXTBOX_THEME_ROOTS = ['.ic-RichContentEditor', '#editCalendarEventFull .rce-wrapper', '#new-quizzes-root .rce-wrapper', '[data-testid="DiscussionEdit-container"] .rce-wrapper', '#wiki_page_body'].join(',');

  function applyTextboxTheme(enabled) {
    localStorage.setItem('mc_textbox_theme', enabled ? '1' : '0');
    document.querySelectorAll(TEXTBOX_THEME_ROOTS).forEach(root => {
      root.classList.toggle('canvas-textbox-theme', enabled);
      const discussionBox = root.closest('[data-testid="DiscussionEdit-container"]');
      const discussionPlate = discussionBox && discussionBox.parentElement;
      if (discussionPlate && discussionPlate.classList.contains('mc-reply-plate')) {
        discussionPlate.classList.toggle('canvas-textbox-theme-plate', enabled);
      }
      const statusbar = root.querySelector('[id^="message-body-"][id$="_statusbar"]') ||
        (discussionBox && discussionBox.querySelector('[id^="message-body-"][id$="_statusbar"]'));
      if (statusbar) statusbar.classList.toggle('canvas-textbox-theme-statusbar', enabled);
      const frame = root.querySelector('iframe.tox-edit-area__iframe, .tox-edit-area iframe');
      try {
        const doc = frame && frame.contentDocument;
        if (!doc) return;
        let sheet = doc.getElementById('canvas-textbox-theme-sheet');
        if (!enabled) { if (sheet) sheet.remove(); return; }
        if (!sheet) { sheet = doc.createElement('style'); sheet.id = 'canvas-textbox-theme-sheet'; doc.head.appendChild(sheet); }
        const css = getComputedStyle(document.documentElement);
        sheet.textContent = 'html,body{background:' + (css.getPropertyValue('--mc-background-0').trim() || '#fff') + ' !important;color:' + (css.getPropertyValue('--mc-text-0').trim() || '#263238') + ' !important}';
      } catch (e) {}
    });
    document.querySelectorAll('.canvas-textbox-theme-btn').forEach(btn => {
      btn.classList.toggle('active', enabled);
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.title = enabled ? 'Textbox theme is on' : 'Textbox theme is off';
    });
  }

  function setupTextboxThemeButtons() {
    const enabled = localStorage.getItem('mc_textbox_theme') === '1';
    document.querySelectorAll(TEXTBOX_THEME_ROOTS).forEach(root => {
      const full = findFullscreenButton(root);
      if (!full || !full.parentElement) return;
      const host = full.parentElement;
      let button = Array.from(host.children).find(el => el.classList && el.classList.contains('canvas-textbox-theme-btn'));
      if (!button) {
        button = document.createElement('button');
        button.type = 'button'; button.className = 'canvas-unified-btn canvas-textbox-theme-btn';
        button.textContent = 'THEME TEXTBOX'; button.setAttribute('aria-label', 'Theme Textbox');
        button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); applyTextboxTheme(localStorage.getItem('mc_textbox_theme') !== '1'); });
        const expand = Array.from(host.children).find(el => el.id === 'canvas-inline-theater-btn' || el.classList.contains('canvas-additional-expand-btn'));
        host.insertBefore(button, expand || full);
      }
    });
    applyTextboxTheme(enabled);
  }

  function setupAdditionalEditorButtons() {
    let next = 0;
    document.querySelectorAll(TEXTBOX_THEME_ROOTS).forEach(root => {
      const full = findFullscreenButton(root);
      if (!full || !full.parentElement) return;
      if (!root.dataset.canvasTheaterEditor) root.dataset.canvasTheaterEditor = 'editor-' + (++next) + '-' + Date.now();
      const editorId = root.dataset.canvasTheaterEditor;
      const host = full.parentElement;
      // The legacy setup owns the first editor's id-based button. Every other
      // RCE gets an instance-scoped control instead of duplicate DOM ids.
      if (!Array.from(host.children).some(el => el.id === 'canvas-inline-theater-btn' || el.classList.contains('canvas-additional-expand-btn'))) {
        const expand = document.createElement('button');
        expand.type = 'button'; expand.className = 'canvas-unified-btn canvas-additional-expand-btn';
        expand.textContent = 'EXPAND'; expand.setAttribute('aria-label', 'Expand to Page');
        expand.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'EXPAND', surface: 'editor', editorId: editorId }, '*');
        });
        host.insertBefore(expand, full);
      }
      dressFullscreenButton(full, 'editor');
    });
  }

  // 监听顶层发出的模式同步广播
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'CANVAS_VIEW_MODE_CHANGED') {
      renderButtonsState(e.data.mode);
    }
  });

  // 自愈：Canvas 换页面时 React 可能把那块全屏容器整个摘走，那时没人调退出，
  // 藏导航的标记就留在 <html> 上了，屏幕上就是"左边导航再也不回来"。容器不在了就把标记摘掉
  function healTheaterExpandClass() {
    if (!isTopWindow) return;
    if (!document.querySelector('.canvas-theater-fullscreen-target')) {
      document.documentElement.classList.remove('canvas-theater-expand');
    }
    mcHealLtiOverlay();
  }

  // iframe 内部按下 Esc
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'EXIT_ALL' }, '*');
    }
  });

  // 全局防止鼠标点击非输入型布局容器（div/span/view）残留焦点触发原生幽灵轮廓框
  window.addEventListener('pointerup', () => {
    try {
      let active = document.activeElement;
      // 穿透 Shadow DOM，获取真正被聚焦的子孙元素（例如原子搜索框内部的真实 input）
      while (active && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      if (!active || active === document.body || active === document.documentElement) return;
      const tag = active.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag)) return;
      if (active.hasAttribute && active.hasAttribute('data-cid')) return;
      if (active.isContentEditable) return;
      if (active.closest && active.closest('span[data-position-content], [role="menu"], [role="listbox"], [role="dialog"], [data-cid], atomic-search-desktop-widget, atomic-search-mobile-widget, form')) return;
      if (active.shadowRoot) return;
      if (active.matches && active.matches('div, span, [class*="view"], [class*="View"]')) {
        active.blur();
      }
    } catch (_) {}
  }, true);

  // 标记发信收件箱页面
  if (location.pathname.includes('/conversations')) {
    document.documentElement.classList.add('mc-conversations-page');
  }

  // [2026-10-07 性能重磅优化] 彻底掐死通讯录列表/选人浮层的后台 hover 事件
  // Canvas 原生 InstUI 组件在每个人名项都挂了 React 状态监听器（onMouseEnter/onHover），
  // 鼠标掠过时触发庞大的 React 状态更新和全局样式重算，单次耗时超 2500ms（2.5 秒）导致界面严重冻结卡死。
  // 在事件捕获阶段直接拦截并掐断 mouseover/mouseout/mousemove，阻止其唤醒 React 后台状态机。
  // 完全保留 click/mousedown/mouseup/pointerdown，确保正常点击人名时原生 Token 气泡 100% 正常生成。
  function mcBlockAddressBookHover(e) {
    try {
      const target = e.target;
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

  // 辅助函数：精准美化顶部课程搜索框为 iOS 胶囊（绝不误伤正文其他无关搜索）
  function beautifyTopHeader() {
    const courseSearch = document.querySelector('#course_search, input[name="course_search"], #course_search_form input');
    if (courseSearch) {
      courseSearch.classList.add('canvas-ios-course-search');
      const form = courseSearch.closest('form');
      if (form) form.classList.add('canvas-ios-search-form');
    }
  }

  // 顶上那颗搜索框是厂商插件 Atomic Search 挂的 atomic-search 自定义元素（不是 Canvas 自己的，
  // 学校没装就没有这个节点），样式关在 open shadow root 里，
  // manifest 注入的 style.css 伸不进去，只能往 shadowRoot 内追加 style 节点。
  // 【和 theme-boot.js 末尾那份逐字对齐】那份在 document_start 就先注一次（防闪第五例），
  // 两边注的是同一个 id，谁先到算谁的；改这里必须同时改那边，否则刷新首帧和一秒后是两个样
  const ATOMIC_SEARCH_CSS = `
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

  /* 站点那句 "Search my courses" 现在名不副实：结果框那一路是跨所有课程找作业、页面、文件、
     收件箱。第一次见到时把原文存进 dataset，设置里关掉结果框就原样还回去。
     和 theme-boot.js 里那几行一字一样：那边管首帧，这边管组件重挂之后 */
  function mcxSearchPlaceholder(inp) {
    if (!inp.dataset.mcxPlaceholder && inp.placeholder) inp.dataset.mcxPlaceholder = inp.placeholder;
    const off = localStorage.getItem('mc_search_box') === '0';
    const want = off ? (inp.dataset.mcxPlaceholder || '') : 'Search Canvas';
    if (inp.placeholder !== want) inp.placeholder = want;
  }

  // Chrome 会把这个输入框的历史搜索词做成自动填充下拉，只能靠 autocomplete 属性压掉
  function silenceAutofill(shadow) {
    const form = shadow.getElementById('ajas-search-form') || shadow.querySelector('form');
    if (form && form.getAttribute('autocomplete') !== 'off') form.setAttribute('autocomplete', 'off');
    shadow.querySelectorAll('input').forEach(inp => {
      if (inp.getAttribute('autocomplete') !== 'off') inp.setAttribute('autocomplete', 'off');
      if (inp.getAttribute('spellcheck') !== 'false') inp.setAttribute('spellcheck', 'false');
      mcxSearchPlaceholder(inp);
    });
  }

  function dressAtomicSearch() {
    if (!isTopWindow) return;
    document.querySelectorAll('atomic-search-desktop-widget, atomic-search-mobile-widget').forEach(host => {
      const shadow = host.shadowRoot;
      if (!shadow) return;
      if (!shadow.getElementById('canvas-atomic-search-css')) {
        const style = document.createElement('style');
        style.id = 'canvas-atomic-search-css';
        style.textContent = ATOMIC_SEARCH_CSS;
        shadow.appendChild(style);
      }
      silenceAutofill(shadow);
      if (!host.dataset.atomicSearchObserved) {
        host.dataset.atomicSearchObserved = 'true';
        new MutationObserver(() => dressAtomicSearch()).observe(shadow, { childList: true, subtree: true });
      }
    });
  }

  // 辅助函数：强力美化 Previous / Next 底部按钮
  function beautifyFooterButtons() {
    // 仅针对翻页页脚容器，绝不在非作业/模块页扫描整页数千个按钮，且使用 textContent 避免触发同步布局
    const footers = document.querySelectorAll('#sequence_footer, .module-sequence-footer, .sequence-footer, .bottom-navigation, .pages-pagination');
    if (!footers.length) return;
    footers.forEach(f => {
      const buttons = f.querySelectorAll('a, button');
      buttons.forEach(el => {
        if (el.classList.contains('Button--icon-action')) return;
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('previous') || text.includes('next')) {
          if (!el.classList.contains('canvas-ios-pill-btn')) {
            el.classList.add('canvas-ios-pill-btn');
          }
        }
      });
    });
  }

  // 为页面所有同源/可访问的 iframe 注入 Modern Canvas 统一定制滚动条
  const BCX_FRAME_SCROLLBAR_CSS = `
    ::-webkit-scrollbar, *::-webkit-scrollbar {
      width: 6px !important;
      height: 6px !important;
      background-color: transparent !important;
    }
    ::-webkit-scrollbar-track, *::-webkit-scrollbar-track {
      background: transparent !important;
    }
    ::-webkit-scrollbar-thumb, *::-webkit-scrollbar-thumb {
      background: rgba(0, 0, 0, 0.22) !important;
      border-radius: 99px !important;
      border: none !important;
      transition: background-color 0.2s ease !important;
    }
    ::-webkit-scrollbar-thumb:hover, *::-webkit-scrollbar-thumb:hover {
      background: rgba(0, 0, 0, 0.42) !important;
    }
    html.bc-colour-mode-dark ::-webkit-scrollbar-thumb,
    html.bc-colour-mode-dark *::-webkit-scrollbar-thumb,
    html.dark ::-webkit-scrollbar-thumb,
    html.dark *::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.22) !important;
    }
    html.bc-colour-mode-dark ::-webkit-scrollbar-thumb:hover,
    html.bc-colour-mode-dark *::-webkit-scrollbar-thumb:hover,
    html.dark ::-webkit-scrollbar-thumb:hover,
    html.dark *::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.42) !important;
    }
  `;

  function dressIframeScrollbars() {
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(f => {
        const inject = () => {
          try {
            const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
            if (!doc) return;
            const target = doc.head || doc.documentElement || doc.body;
            if (!target) return;
            if (doc.getElementById('mc-frame-scrollbar-style')) return;
            const style = doc.createElement('style');
            style.id = 'mc-frame-scrollbar-style';
            style.textContent = BCX_FRAME_SCROLLBAR_CSS;
            target.appendChild(style);
          } catch (e) {
            // 跨域受同源策略限制时静默跳过
          }
        };

        inject();
        if (!f.dataset.mcScrollBound) {
          f.dataset.mcScrollBound = '1';
          f.addEventListener('load', () => {
            setTimeout(inject, 50);
            setTimeout(inject, 500);
            setTimeout(inject, 1500);
          });
        }
      });
    } catch (e) {}
  }

  // 外部工具 (LTI) 第三方 iframe 动态色彩混合应用
  function applyDirectLtiTint(on) {
    // #preview_frame 是 Canvas 自己的提交预览，不是外部 LTI 工具；若被 multiply 混合，
    // 页面底 #FFF6DA 会与自身相乘成 #FFEDBA，误看成 Control fill。
    const previewFrame = document.querySelector('#preview_frame');
    if (previewFrame) previewFrame.style.removeProperty('mix-blend-mode');
    if (!mcHasLtiIframe()) return;
    if (typeof on === 'undefined') {
      on = localStorage.getItem('mc_lti_tint') === '1';
    }
    const iframes = document.querySelectorAll('#main iframe:not(#preview_frame), #content iframe:not(#preview_frame), .tool_content_wrapper iframe:not(#preview_frame), iframe.tool_launch:not(#preview_frame), #tool_content, iframe[src*="external_tools"]:not(#preview_frame)');
    iframes.forEach(f => {
      f.style.setProperty('mix-blend-mode', on ? 'multiply' : 'normal', 'important');
      if (f.parentElement) {
        if (on) {
          f.parentElement.style.setProperty('background-color', 'var(--mc-background-1)', 'important');
        } else {
          f.parentElement.style.removeProperty('background-color');
        }
      }
    });
    const main = document.getElementById('main');
    const content = document.getElementById('content');
    const wrappers = document.querySelectorAll('.tool_content_wrapper');
    [main, content, ...wrappers].forEach(el => {
      if (!el) return;
      if (on) {
        el.style.setProperty('background-color', 'var(--mc-background-1)', 'important');
      } else {
        el.style.removeProperty('background-color');
      }
    });
  }

  // 外部工具 (LTI) 第三方 iframe 右下角色彩优化开关卡片
  let mcLtiDisappearTimer = null;

  function mcHasLtiIframe() {
    return !!(
      document.body.matches('.ic-full-screen-lti-tool, .ic-framed-lti-tool') ||
      document.querySelector('iframe.tool_launch, #tool_content, #external_tools iframe, iframe[src*="external_tools"]') ||
      window.location.pathname.includes('/external_tools/')
    );
  }

  // 要送上屏幕的是"装着 iframe 的那个框"，不是 iframe 自己：iframe 身上那层 mix-blend-mode
  // 只跟同一个层叠上下文里的底色混，框得留在它身后才保得住 Match Theme 那层配色。
  // 认 iframe 的选择器跟 applyDirectLtiTint 用的是同一串，改那边要改这边
  function getLtiExpandTarget() {
    const sel = '#main iframe:not(#preview_frame), #content iframe:not(#preview_frame), .tool_content_wrapper iframe:not(#preview_frame), iframe.tool_launch:not(#preview_frame), #tool_content, iframe[src*="external_tools"]:not(#preview_frame)';
    let best = null;
    let bestArea = 0;
    document.querySelectorAll(sel).forEach(f => {
      const area = f.clientWidth * f.clientHeight;
      if (f.getClientRects().length && area > bestArea) {
        best = f;
        bestArea = area;
      }
    });
    if (!best) return null;
    const wrapper = best.closest('.tool_content_wrapper');
    if (wrapper) return wrapper;
    const holder = best.parentElement;
    // 爹要是 #main / #content 这种整页容器，盖上去等于把旁边那些内容一起送上屏幕，
    // 那种情况宁可让框就是 iframe 自己（底色那档由 mcLtiOverlayOn 直接钉成主题底）
    if (holder && holder !== document.body && !/^(main|content|application)$/.test(holder.id || '')) return holder;
    return best;
  }

  // 卡片上那两颗按钮的字／高亮／提示，跟 PDF 阅读器、编辑器那两颗同一套口径
  let mcLtiSizeMode = 'NORMAL';

  function mcRenderLtiSizeButtons(mode) {
    if (mode) mcLtiSizeMode = mode;
    const card = document.getElementById('mc-lti-toggle-card');
    if (!card) return;
    const expandBtn = card.querySelector('#mc-lti-expand-btn');
    const fsBtn = card.querySelector('#mc-lti-fullscreen-btn');
    if (!expandBtn || !fsBtn) return;
    const m = mcLtiSizeMode;

    expandBtn.classList.toggle('active', m === 'EXPAND');
    expandBtn.textContent = m === 'EXPAND' ? 'EXIT' : 'EXTEND';
    expandBtn.title = m === 'EXPAND' ? 'Exit expand mode (Esc)'
      : m === 'FULLSCREEN' ? 'Switch to page expand mode'
      : 'Expand to page (Esc to exit)';

    fsBtn.classList.toggle('active', m === 'FULLSCREEN');
    fsBtn.textContent = m === 'FULLSCREEN' ? 'EXIT' : 'FULLSCREEN';
    fsBtn.title = m === 'FULLSCREEN' ? 'Exit full screen (Esc)'
      : m === 'EXPAND' ? 'Switch to native full screen'
      : 'Enter full screen';
  }

  // 卡片还在、框却找不到了（比如那一页只有 body 上的类名而没有真 iframe）：这一排不画。
  // 挂类名不写行内：那一排的 display: flex 带 !important，行内不带 !important 压不过它
  function mcSyncLtiSizeRow() {
    const card = document.getElementById('mc-lti-toggle-card');
    if (!card) return;
    const row = card.querySelector('.mc-lti-size-row');
    if (!row) return;
    row.classList.toggle('is-hidden', !getLtiExpandTarget());
  }

  /* --- 展开那一块外部工具：行内 !important 钉死，外加逐层按住碍事的祖先 ---
     为什么不走 theater.css 那条挂类名的路（阅读器／编辑器那一格走的就是它）：
     他那张截图量到的只有两件事——那块框只变宽了，没贴到屏幕左上角，左边导航和顶上那条
     面包屑还在原地。也就是 top/left 那两条没落地，只有宽高落了。至于为什么没落地，
     我这边连不上他那页，没法点名是"被权重更高的作者规则压住"还是"某层祖先抢走了坐标系"，
     所以两条都堵：行内 !important 排在所有作者 !important 之上（治前者），
     祖先那一路逐层按住（治后者），最后再按实测差值兜一次。

     还有一层躲不掉的：iframe 不能搬。搬去 body 是最干净的解法，可 iframe 一换爹整份工具
     重新加载一遍（LTI 还要重新过一次 launch），所以只能从它原位把碍事的祖先一层层按住，
     退出时按存下来的原值逐条还回去。 */
  let mcLtiOverlayState = null;

  function mcPin(el, props) {
    const st = el.style;
    const restore = {};
    Object.keys(props).forEach((prop) => {
      restore[prop] = { value: st.getPropertyValue(prop), priority: st.getPropertyPriority(prop) };
      if (st.getPropertyValue(prop) === props[prop] && restore[prop].priority === 'important') return;
      st.setProperty(prop, props[prop], 'important');
    });
    return restore;
  }

  function mcUnpin(el, restore) {
    if (!el || !restore) return;
    const st = el.style;
    Object.keys(restore).forEach((prop) => {
      if (restore[prop].value) st.setProperty(prop, restore[prop].value, restore[prop].priority);
      else st.removeProperty(prop);
    });
  }

  function mcLtiGeoProps() {
    return {
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%',
      'max-width': 'none',
      'max-height': 'none',
      'min-width': '0px',
      'min-height': '0px',
      margin: '0px',
      padding: '0px',
      'border-radius': '0px',
      // 压过站点自家那几层 chrome（#header 是 1200）；再往上还留给全局提示和右下角那颗卡片，
      // 那两条在下面各钉一档，顺序是 覆盖层 < 全局提示 < 我们那颗卡片
      'z-index': '2147483640'
    };
  }

  // 钉的是像素不是百分比，所以窗口一改大小必须重算：不重算就停在原来那一块，
  // 屏幕上变成右边／下面露出一条底下那页
  function mcLtiApplyGeo(state) {
    const st = state.container.style;
    // 用 clientWidth 不用 innerWidth：后者把竖向滚动条那 15px 也算进去，
    // 就算滚动条已经掐了，这个值在部分情况下还是旧的，右边照样溢出一小条
    st.setProperty('left', '0px', 'important');
    st.setProperty('top', '0px', 'important');
    st.setProperty('width', document.documentElement.clientWidth + 'px', 'important');
    st.setProperty('height', document.documentElement.clientHeight + 'px', 'important');
    // 钉成 0,0 以后再量一次：还是贴不到左上角，说明坐标系被某一层抢走了（哪一层说不准），
    // 按实测差值反推才是准的
    const r = state.container.getBoundingClientRect();
    if (Math.abs(r.left) > 1) st.setProperty('left', (-r.left) + 'px', 'important');
    if (Math.abs(r.top) > 1) st.setProperty('top', (-r.top) + 'px', 'important');
  }

  function mcLtiOverlayOn(container, sized) {
    mcLtiOverlayOff();
    const state = { container, chain: [] };

    const box = {
      // 底色要的是主题那一档，不是 theater.css 给阅读器刷的 #1e1e1e：
      // iframe 身上那层 mix-blend-mode 只跟同一个层叠上下文里的底色混，深灰会把整块工具压黑
      'background-color': 'var(--mc-background-1, #f3f4f6)',
      overflow: 'hidden',
      'box-shadow': 'none',
      border: '0px',
      'box-sizing': 'border-box'
    };
    if (sized) {
      // 先把这一页自己的滚动条掐掉，再量尺寸（量在 mcLtiApplyGeo 里，排在按住祖先之后）。
      // 整块盖住屏幕的时候，底下那页既看不见也不该还能滚，
      // 留着就是右边多出一条没人用的轨道（工具自己文档里那条是它家的，跨源进不去，管不了）。
      // 顺序不能反：滚动条一没，可视区宽出一截，先量后掐就会在右边留下一条透出底下页面的缝。
      // 三个都可能是在滚的那一个：文档、body、Canvas 自己的 #application
      const page = [document.documentElement, document.body, document.getElementById('application')];
      state.page = page.filter(Boolean).map(el => ({ el, restore: mcPin(el, { overflow: 'hidden' }) }));
    }
    state.pinned = mcPin(container, box);

    const frame = container.matches('iframe') ? null : container.querySelector('iframe');
    if (frame) {
      state.frame = frame;
      // Canvas 给这颗 iframe 写的是行内固定高度，不压过去就是"框铺满了、里面还是原来那一小块"
      state.framePinned = mcPin(frame, { width: '100%', height: '100%', border: '0px', margin: '0px', 'border-radius': '0px' });
    }

    let el = container.parentElement;
    while (el && el !== document.body) {
      const cs = window.getComputedStyle(el);
      // 会抢走 position:fixed 坐标系的那几条（有一条不是 none，我们的 0,0 就成了它的 0,0）
      const holdsFrameInPlace = cs.transform !== 'none' || cs.perspective !== 'none' ||
        cs.filter !== 'none' || cs.backdropFilter !== 'none' ||
        /transform|filter|perspective|backdrop/.test(cs.willChange || '') ||
        /(paint|layout|strict|content)/.test(cs.contain || '') ||
        /(layout|size|inline-size)/.test(cs.containerType || '');
      // 自己开一层层叠上下文的（我们的 z 出了这一层就重新计数，压不过 #header）
      const opensLayer = holdsFrameInPlace || cs.isolation === 'isolate' ||
        (cs.mixBlendMode && cs.mixBlendMode !== 'normal') ||
        (cs.willChange && cs.willChange !== 'auto') || parseFloat(cs.opacity) < 1 ||
        (cs.position !== 'static' && cs.zIndex !== 'auto');
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (holdsFrameInPlace || opensLayer || clips) {
        const props = {};
        if (holdsFrameInPlace) {
          Object.assign(props, {
            transform: 'none', perspective: 'none', filter: 'none',
            'backdrop-filter': 'none', 'will-change': 'auto', contain: 'none',
            'container-type': 'normal'
          });
        }
        if (clips) props.overflow = 'visible';
        if (opensLayer) {
          if (cs.position === 'static') props.position = 'relative';
          props['z-index'] = '2147483640';
          if (parseFloat(cs.opacity) < 1) props.opacity = '1';
          if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') props['mix-blend-mode'] = 'normal';
        }
        state.chain.push({ el, restore: mcPin(el, props) });
      }
      el = el.parentElement;
    }

    if (sized) {
      // 尺寸单独一份快照、单独一个函数，是因为窗口改了大小要拿它重算一遍（见 mcLtiApplyGeo）
      state.geoRestore = mcPin(container, mcLtiGeoProps());
      mcLtiApplyGeo(state);
    }

    // 全局提示（Canvas 那条 flash）压在我们底下就成了"有提示看不见"，给它留一层
    const flash = document.getElementById('flash_message_holder');
    if (flash) state.flash = { el: flash, restore: mcPin(flash, { 'z-index': '2147483645' }) };

    // 右下角那颗卡片更要留在上面：展开以后 EXIT 那两颗是唯一的手动退出口
    const card = document.getElementById('mc-lti-toggle-card');
    if (card) state.card = { el: card, restore: mcPin(card, { 'z-index': '2147483646' }) };

    mcLtiOverlayState = state;
    return true;
  }

  function mcLtiOverlayOff() {
    if (!mcLtiOverlayState) return;
    const state = mcLtiOverlayState;
    mcLtiOverlayState = null;
    // 两份快照钉的是同一个框、键不重叠（一份底色那几条，一份尺寸那几条），合在一起一次还回去
    mcUnpin(state.container, Object.assign({}, state.pinned, state.geoRestore));
    mcUnpin(state.frame, state.framePinned);
    state.chain.forEach(step => mcUnpin(step.el, step.restore));
    if (state.flash) mcUnpin(state.flash.el, state.flash.restore);
    if (state.card) mcUnpin(state.card.el, state.card.restore);
    // 最后一步才放页面那三条：先把自己的尺寸还回去，免得还的过程中右边闪出一条缝
    if (state.page) state.page.forEach(step => mcUnpin(step.el, step.restore));
  }

  // 展开期间 Canvas 换页面／React 重画，会把那块框整个摘走。行内样式跟着节点一起没了，
  // 可状态还停在 EXPAND 上，屏幕上就是"工具已经恢复正常、按钮却还写着 EXIT"。
  // 走现成的 EXIT_ALL 那条通路，让状态机自己翻回 NORMAL（顺带把字改回来），不在这里另改一份
  function mcHealLtiOverlay() {
    if (!mcLtiOverlayState) return;
    if (!mcLtiOverlayState.container.isConnected) {
      mcLtiOverlayState = null;
      try {
        window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'EXIT_ALL' }, '*');
      } catch (e) {}
    }
  }

  /* 卡片可以抓着挪，挪到哪下次还在哪。
     位置存 left/top（从屏幕左上角量），不存 bottom/right：窗口改大小以后按左上角收回来最直观。
     写的时候一律带 !important —— .mc-lti-toggle-card 那条作者规则带 !important，
     行内不带 !important 压不过它（这一坑这轮踩过一次了）。
     位移只用 left/top 不碰 transform：那个属性被渐入渐出和按下的 scale 占着。 */
  const MC_LTI_CARD_POS_KEY = 'mc_lti_card_pos';
  let mcLtiCardDragBound = false;
  let mcLtiResizeFrame = 0;

  function mcSetLtiCardSpot(card, left, top) {
    const st = card.style;
    st.setProperty('left', Math.round(left) + 'px', 'important');
    st.setProperty('top', Math.round(top) + 'px', 'important');
    st.setProperty('right', 'auto', 'important');
    st.setProperty('bottom', 'auto', 'important');
  }

  function mcClampLtiCardSpot(card, left, top) {
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - card.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - card.offsetHeight - 8))
    };
  }

  function mcPlaceLtiCard(card) {
    let saved = null;
    try {
      const raw = localStorage.getItem(MC_LTI_CARD_POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.left === 'number' && typeof p.top === 'number') saved = p;
      }
    } catch (e) {}
    if (!saved) return;
    // 存过的那一档可能已经在屏幕外（窗口缩过、换了一台显示器），收回来
    const spot = mcClampLtiCardSpot(card, saved.left, saved.top);
    mcSetLtiCardSpot(card, spot.left, spot.top);
  }

  function mcBindLtiCardDrag(card) {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 那三颗是指定给"手指"的区域，从它们身上按下不挪面板
      if (e.target.closest('.mc-lti-switch, .canvas-unified-btn')) return;
      const rect = card.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      delete card.dataset.mcJustDragged;

      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        card.classList.add('is-dragging');
        // 尺寸用按下那一刻量好的，不在每次 move 里读 offsetWidth：
        // 拖着的过程中板子不会变大小，读一次就是逼浏览器把整页重排一遍
        const left = Math.max(8, Math.min(ev.clientX - grabX, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(ev.clientY - grabY, window.innerHeight - rect.height - 8));
        mcSetLtiCardSpot(card, left, top);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        card.classList.remove('is-dragging');
        if (!moved) return;
        card.dataset.mcJustDragged = '1';
        const after = card.getBoundingClientRect();
        try {
          localStorage.setItem(MC_LTI_CARD_POS_KEY, JSON.stringify({ left: Math.round(after.left), top: Math.round(after.top) }));
        } catch (err) {}
      };
      // 抬到 window 上：面板只有那么大，手一快就移出卡片了
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    if (!mcLtiCardDragBound) {
      mcLtiCardDragBound = true;
      // 窗口变尺寸要办两件事：展开着的那块跟着重算（钉的是像素，不重算就停在原来那一块，
      // 右边／下面露出一条底下那页），以及把卡片收回屏幕内（存的那一档可能已经在屏幕外了）。
      // 合成事件也走这里：状态机每次换档都会 dispatch 一个 resize
      window.addEventListener('resize', () => {
        if (mcLtiResizeFrame) return;
        // 一次变尺寸要量两次布局（覆盖层的差值、卡片的宽高），攒到同一帧里办完
        mcLtiResizeFrame = requestAnimationFrame(() => {
          mcLtiResizeFrame = 0;
          if (mcLtiOverlayState && mcLtiOverlayState.geoRestore) mcLtiApplyGeo(mcLtiOverlayState);
          const live = document.getElementById('mc-lti-toggle-card');
          if (live) mcPlaceLtiCard(live);
        });
      });
    }
  }

  function dressLtiIframeCard() {
    if (!isTopWindow) return;
    const isLti = mcHasLtiIframe();
    const cardId = 'mc-lti-toggle-card';
    const existing = document.getElementById(cardId);

    if (!isLti) {
      if (existing && !existing.classList.contains('is-fading-out')) {
        if (!mcLtiDisappearTimer) {
          // 检测到 iframe 消失后等待 3 秒再渐隐移除
          mcLtiDisappearTimer = setTimeout(() => {
            mcLtiDisappearTimer = null;
            if (!mcHasLtiIframe()) {
              const el = document.getElementById(cardId);
              if (el) {
                el.classList.add('is-fading-out');
                setTimeout(() => {
                  if (el && el.parentNode) el.remove();
                }, 400);
              }
            }
          }, 3000);
        }
      }
      return;
    }

    // iframe 存在：如果有等待消失的倒计时，立即取消
    if (mcLtiDisappearTimer) {
      clearTimeout(mcLtiDisappearTimer);
      mcLtiDisappearTimer = null;
    }

    const isEnabled = localStorage.getItem('mc_lti_tint') === '1';

    if (existing) {
      if (existing.classList.contains('is-fading-out')) {
        existing.classList.remove('is-fading-out');
      }
      applyDirectLtiTint(isEnabled);
      mcSyncLtiSizeRow();
      return;
    }

    const card = document.createElement('div');
    card.id = cardId;
    card.className = 'mc-lti-toggle-card';

    // 第一排：整排可点（以前是整张卡片可点，现在底下多了一排按钮，点按钮不该连配色一起翻）
    const toggleRow = document.createElement('div');
    toggleRow.className = 'mc-lti-toggle-row';
    toggleRow.title = 'Match Theme for External Tool';

    const label = document.createElement('span');
    label.className = 'mc-lti-toggle-label';
    label.textContent = 'Match Theme for External Tool';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mc-lti-switch' + (isEnabled ? ' is-on' : '');
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', isEnabled ? 'true' : 'false');
    btn.setAttribute('aria-label', 'Match Theme for External Tool');

    const thumb = document.createElement('span');
    thumb.className = 'mc-lti-switch-thumb';

    // ✕ 图标 (关闭态)
    const svgOff = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgOff.setAttribute('class', 'mc-lti-icon-off');
    svgOff.setAttribute('viewBox', '0 0 12 12');
    svgOff.setAttribute('width', '9');
    svgOff.setAttribute('height', '9');
    const pathOff = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathOff.setAttribute('d', 'M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5');
    pathOff.setAttribute('fill', 'none');
    pathOff.setAttribute('stroke', 'currentColor');
    pathOff.setAttribute('stroke-width', '2');
    pathOff.setAttribute('stroke-linecap', 'round');
    svgOff.appendChild(pathOff);

    // ✓ 图标 (开启态)
    const svgOn = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgOn.setAttribute('class', 'mc-lti-icon-on');
    svgOn.setAttribute('viewBox', '0 0 12 12');
    svgOn.setAttribute('width', '9');
    svgOn.setAttribute('height', '9');
    const pathOn = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathOn.setAttribute('d', 'M2 6.5 L4.8 9.3 L10 3');
    pathOn.setAttribute('fill', 'none');
    pathOn.setAttribute('stroke', 'currentColor');
    pathOn.setAttribute('stroke-width', '2');
    pathOn.setAttribute('stroke-linecap', 'round');
    pathOn.setAttribute('stroke-linejoin', 'round');
    svgOn.appendChild(pathOn);

    thumb.appendChild(svgOff);
    thumb.appendChild(svgOn);
    btn.appendChild(thumb);

    toggleRow.appendChild(label);
    toggleRow.appendChild(btn);
    card.appendChild(toggleRow);

    // 第二排：把这一块外部工具送上屏幕。两颗按钮走的是 PDF 阅读器、编辑器那两颗同一条
    // 状态机（CANVAS_REQUEST_MODE → switchMode），不另起一套，所以 Esc、原生全屏进出、
    // 藏左边导航那几件事全都跟着现成的走
    const sizeRow = document.createElement('div');
    sizeRow.className = 'mc-lti-size-row';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.id = 'mc-lti-expand-btn';
    expandBtn.className = 'canvas-unified-btn';
    expandBtn.setAttribute('aria-label', 'Expand external tool to page');
    expandBtn.textContent = 'EXTEND';

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.id = 'mc-lti-fullscreen-btn';
    fsBtn.className = 'canvas-unified-btn';
    fsBtn.setAttribute('aria-label', 'Full screen external tool');
    fsBtn.textContent = 'FULLSCREEN';

    const requestSize = (mode) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: mode, surface: 'lti' }, '*');
      } catch (err) {}
    };
    expandBtn.addEventListener('click', requestSize('EXPAND'));
    fsBtn.addEventListener('click', requestSize('FULLSCREEN'));

    sizeRow.appendChild(expandBtn);
    sizeRow.appendChild(fsBtn);
    card.appendChild(sizeRow);

    // 初次挂载时直接根据当前偏好执行一次，确保首屏零延迟生效
    applyDirectLtiTint(isEnabled);

    const toggle = (e) => {
      // 拖完松手那一下浏览器照样会补一个 click，不拦就是"挪个位置顺手把配色翻了"
      if (card.dataset.mcJustDragged === '1') {
        delete card.dataset.mcJustDragged;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const curr = localStorage.getItem('mc_lti_tint') === '1';
      const next = !curr;
      localStorage.setItem('mc_lti_tint', next ? '1' : '0');

      document.documentElement.classList.toggle('mc-lti-tint', next);
      document.documentElement.classList.toggle('mc-lti-notint', !next);

      btn.classList.toggle('is-on', next);
      btn.setAttribute('aria-checked', next ? 'true' : 'false');

      // 直接给 DOM 上的目标 iframe 施加/清除 mix-blend-mode
      applyDirectLtiTint(next);
    };

    toggleRow.addEventListener('click', toggle);
    mcSyncLtiSizeRow();
    mcRenderLtiSizeButtons();

    // 初始从透明平滑渐入
    card.style.opacity = '0';
    card.style.transform = 'translateY(10px)';
    document.body.appendChild(card);
    mcPlaceLtiCard(card);
    mcBindLtiCardDrag(card);
    requestAnimationFrame(() => {
      card.style.opacity = '';
      card.style.transform = '';
    });
  }

  // 辅助函数：监听容器拖拽调节，实时同步内部 iframe 高度，彻底解决拖拽卡死与尺寸脱节
  function syncResizeDimensions() {
    if (!isTopWindow) return;
    const containers = [
      document.querySelector('.file-preview-holder'),
      document.querySelector('.canvas_file_preview'),
      document.querySelector('#doc_preview'),
      document.querySelector('.ef-file-preview-frame'),
      document.querySelector('.docviewer-holder')
    ];

    containers.forEach(box => {
      if (box && !box.dataset.resizeObserved) {
        box.dataset.resizeObserved = 'true';
        const ro = new ResizeObserver(entries => {
          for (let entry of entries) {
            const h = entry.contentRect.height;
            if (h > 100) {
              const iframes = box.querySelectorAll('iframe');
              iframes.forEach(f => {
                f.style.setProperty('height', h + 'px', 'important');
              });
            }
          }
        });
        ro.observe(box);
      }
    });
  }

  // ↓↓↓ 公告卡这一组自 2026-10-03 起不再由本文件调用：整组原样搬到了 notif-boot.js
  // （document_start 注入），这样 React 刚把卡插进来、浏览器还没画那一帧时我们就把它打扮完。
  // 留这份旧拷贝是为了他确认新通路没问题之后好对照，确认后整段删。
  // 找出通知左侧的主题色色块（贴左边缘、上下够长、不含正文的元素）
  function findAccentRail(notif) {
    const boxRect = notif.getBoundingClientRect();
    let found = null;
    notif.querySelectorAll('*').forEach(el => {
      if (found || el.classList.contains('canvas-notification-collapse-btn')) return;
      const rgb = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!rgb) return;
      const [r, g, b, a = 1] = rgb[1].split(',').map(v => parseFloat(v));
      if (a < 0.5 || Math.max(r, g, b) - Math.min(r, g, b) < 30) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.width > 90 || rect.height < 40) return;
      if (rect.left - boxRect.left > 16) return;
      if (el.querySelector('p, li, a, h1, h2, h3, h4')) return;
      found = el;
    });
    // 上面那道"颜色够艳"的筛在深色低饱和的主题上过不了（棕黑这类 RGB 差不到 30），
    // 于是整块色底就铺不出来，只剩 Canvas 自己那层带圆角和留白的图标。退回按 Canvas 写死的层名认一次。
    return found || notif.querySelector('.ic-notification__icon');
  }

  // 在左侧主题色块下方铺一块同色底，上下直接贴满卡片内边缘，做到顶天立地
  function paintAccentRail(notif) {
    const rail = findAccentRail(notif);
    if (!rail) return null;
    if (notif.querySelector('.canvas-notif-accent-rail')) return rail;
    const fill = document.createElement('div');
    fill.className = 'canvas-notif-accent-rail';
    notif.appendChild(fill);
    rail.classList.add('canvas-notif-rail');
    rail.style.setProperty('position', 'relative', 'important');
    rail.style.setProperty('z-index', '1', 'important');
    const sync = () => {
      const boxRect = notif.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      if (!boxRect.width || !railRect.width) return;
      fill.style.setProperty('width', `${railRect.right - boxRect.left}px`, 'important');
    };
    requestAnimationFrame(sync);
    window.addEventListener('resize', sync);
    return rail;
  }

  // Canvas 按通知类型自带一套语义色（提醒橙、信息蓝、成功绿、警告黄）。
  // 把它抄进这张卡自己的变量：没有主题时描边和左侧色块照旧读它，有主题时 style.css 换成主题强调色。
  // 只能写成自定义属性，不能直接写 background-color —— 行内 !important 会盖过主题那条规则。
  function stampNotifAccent(notif, rail) {
    // 挂着主题的这一趟不抄：那时读到的计算值是我们自己刷上去的强调色，抄进"原生色"＝
    // 主题撤掉之后色条还停在旧主题那一档（撤主题那条通路都会重载，所以这里宁可留空让它回退）
    if (document.documentElement.classList.contains('mc-themed')) return;
    const clear = c => c && c !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);
    const block = rail ? getComputedStyle(rail).backgroundColor : '';
    const native = clear(block) ? block : getComputedStyle(notif).borderTopColor;
    if (clear(native)) notif.style.setProperty('--mc-notif-native', native);
  }

  // 标题优先取 Canvas 原生的公告标题节点；认不出时退回“视觉上最靠上的正文行”
  function findNotifTitle(notif) {
    const native = notif.querySelector('.ic-notification__title, .header-bar-announcement__title');
    if (native && native.textContent.trim()) return native;

    let best = null;
    let bestTop = Infinity;
    notif.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, a, li').forEach(el => {
      if (el.closest('.ic-notification__icon, .canvas-notif-actions')) return;
      if (el.matches('button, a, [role="button"]') || el.querySelector('svg')) return; // 图标与按钮不算正文行
      const text = el.textContent.trim();
      if (!text || text.length > 160) return;
      if (el.querySelector('h1, h2, h3, h4, h5, p, ul, ol, li, a')) return; // 只认单行级元素
      const rect = el.getBoundingClientRect();
      if (!rect.height) return;
      if (rect.top < bestTop) {
        bestTop = rect.top;
        best = el;
      }
    });
    return best;
  }

  // “This is an announcement from …” 提示行，折叠时和标题一起留着
  function findNotifMeta(notif) {
    let best = null;
    notif.querySelectorAll('p, span, div, small, time').forEach(el => {
      const text = el.textContent.trim();
      if (!/^this is an announcement/i.test(text)) return;
      if (!best || text.length < best.textContent.trim().length) best = el;
    });
    return best;
  }

  // 按位置认出右上角的原生关闭按钮，不依赖 Canvas 类名
  function findCloseButton(notif) {
    const box = notif.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    notif.querySelectorAll('button, a, [role="button"], span, div').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.width > 44 || rect.height > 44) return;
      const topGap = rect.top - box.top;
      const rightGap = box.right - rect.right;
      if (topGap > 56 || rightGap > 56) return;
      const glyph = el.textContent.trim();
      if (glyph && !/^(close|×|✕|x)$/i.test(glyph)) return; // 原生关闭按钮的文字是屏读标签 “close”
      if (!el.querySelector('svg, i, use')) return;
      if (!el.matches('button, a, [role="button"]')) return; // 只接管真正的可点元素
      const score = topGap + rightGap;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  // 折叠时要隐掉的节点：除标题、提示行、左侧色块、按钮条及其祖先之外的全部后代
  function collectCollapseNodes(notif, keepNodes) {
    const alwaysKeep = '.canvas-notif-rail, .canvas-notif-accent-rail, .canvas-notif-actions';
    const keep = new Set([...keepNodes.filter(Boolean), ...notif.querySelectorAll(alwaysKeep)]);
    [...keep].forEach(node => node.querySelectorAll('*').forEach(child => keep.add(child)));

    // 祖先只自身保持可见，好让标题能显示；它们子树里没被点名的节点照样要隐掉
    const ancestors = new Set();
    keep.forEach(node => {
      for (let el = node.parentElement; el && el !== notif; el = el.parentElement) ancestors.add(el);
    });

    const hide = [];
    notif.querySelectorAll('*').forEach(el => {
      if (!keep.has(el) && !ancestors.has(el)) hide.push(el);
    });
    return hide;
  }

  // 辅助函数：置顶全局通知增加折叠/展开功能，保持 Canvas 原生色框与大圆角，杜绝 UI 重叠
  function enhanceNotifications() {
    const notifications = document.querySelectorAll('#flash_message_holder .ic-notification, #content > .ic-notification, #main > .ic-notification, .ic-notification:not(#right-side *)');
    notifications.forEach(notif => {
      if (notif.closest('#right-side') || notif.closest('.recent_feedback')) return;
      if (notif.dataset.canvasEnhanced) return;
      notif.dataset.canvasEnhanced = 'true';

      const titleEl = findNotifTitle(notif);
      const titleText = (titleEl ? titleEl.textContent : 'Announcement').trim();

      // 本地记忆折叠状态
      const notifKey = 'canvas_notif_collapsed_' + titleText.slice(0, 30).replace(/\s+/g, '_');
      const isCollapsedInitially = localStorage.getItem(notifKey) === 'true';

      // 注入折叠切换按钮
      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'canvas-notification-collapse-btn';
      collapseBtn.title = isCollapsedInitially ? 'Expand' : 'Collapse';
      collapseBtn.setAttribute('aria-label', 'Toggle announcement');
      collapseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" class="canvas-collapse-arrow">
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
        </svg>
      `;

      const railEl = paintAccentRail(notif);
      stampNotifAccent(notif, railEl);

      // 右上角按钮条：把原生关闭按钮接过来，和折叠按钮同排、同尺寸、同一套 hover
      const closeBtn = findCloseButton(notif);
      const actions = document.createElement('div');
      actions.className = 'canvas-notif-actions';
      notif.appendChild(actions);
      actions.appendChild(collapseBtn);
      if (closeBtn) actions.appendChild(closeBtn);

      if (titleEl) titleEl.classList.add('canvas-notif-title');
      const metaEl = findNotifMeta(notif);
      if (metaEl) metaEl.classList.add('canvas-notif-meta');
      const collapseNodes = collectCollapseNodes(notif, [titleEl, metaEl, railEl, actions]);
      const applyCollapsed = collapsed => {
        collapseNodes.forEach(el => {
          el.style.display = collapsed ? 'none' : '';
        });
        notif.classList.toggle('is-collapsed', collapsed);
      };

      collapseBtn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        const isCollapsed = !notif.classList.contains('is-collapsed');
        applyCollapsed(isCollapsed);
        collapseBtn.title = isCollapsed ? 'Expand' : 'Collapse';
        localStorage.setItem(notifKey, isCollapsed ? 'true' : 'false');
      });

      applyCollapsed(isCollapsedInitially);
    });
  }

  // =========================================================
  // 课程二级导航菜单（#left-side）展开与收缩动效增强
  // Canvas 原生点击汉堡按钮时通过 display:none 切换，无法直接产生 CSS 过渡动画。
  // 此处在捕获阶段拦截点击，通过宽度/位移/透明度的平滑过渡类驱动缩放动效。
  // =========================================================
  // =========================================================
  // 待办面板：直接打 Canvas 自己的 planner API，自己算分区
  // =========================================================
  let currentActiveTab = 'assignments'; // 'announcements' | 'assignments' | 'completed' | 'feedback'

  // Logo 显隐设置：默认隐藏，用户在设置面板里可改回保留
  // ===== 显示类设置：全部落在 html 的类名或读取函数上，改完即时生效 =====
  const MODERN_SETTINGS = {
    // Ring Style 指的是进度指示器的形状（一门课一圈，弧长＝该课完成度），不是卡片左侧色条
    ring_style: {
      def: 'bar',
      options: ['bar', 'circle', 'rainbow'],
      text: { bar: 'Progress Bar', circle: 'Circle', rainbow: 'Rainbow' }
    },
    rings_for: { def: 'all', options: ['all', 'active'], text: { all: 'All courses', active: 'Courses with active tasks' } },
    date_format: { def: 'absolute', options: ['absolute', 'relative'], text: { absolute: 'Absolute', relative: 'Relative' } },
    grouping: { def: 'on', options: ['on', 'off'], text: { on: 'Grouped by due date', off: 'One flat list' } },
    // MISSING 那一区落在哪个选项卡，以及过期多久之内还继续提醒
    missing_placement: { def: 'uncompleted', options: ['uncompleted', 'finished'], text: { uncompleted: 'Uncompleted tasks', finished: 'Finished tasks' } },
    missing_range: { def: '1w', options: ['1w', '2w', '3w', '4w'], text: { '1w': '1 week', '2w': '2 weeks', '3w': '3 weeks', '4w': '4 weeks' } },
    missing_on_paper: { def: 'hide', options: ['hide', 'show'], text: { hide: 'Leave them out', show: 'Keep them in MISSING' } },
    // 点待办卡片那一跳落在哪儿。两档，没有第三档：只给真链接挂不挂 target，
    // 卡片本身还是那条链接，所以右键菜单、Ctrl+点击、中键这几样两档下都照旧能用
    card_click: { def: 'same', options: ['same', 'new'], text: { same: 'This tab', new: 'New tab' } },
    // 课程名、卡片左缘那条 6px 色、hover 那一圈外框读的是同一门课的颜色。
    // 默认 accent＝三处一起用主题强调色（落点 style.css 的 html.bc-course-colour-accent），
    // 挑 course 才按每门课自己的颜色走。theme-boot.js 的 DISPLAY_GROUPS 里那个 def 要一起改
    course_colour: { def: 'accent', options: ['course', 'accent'], text: { course: "Each course's colour", accent: 'Theme accent' } },
    // 卡片左上角那一格分数归谁画。ours＝藏它那颗、显示我们那颗（它那颗实测没有行内样式，
    // 一条 !important 压得住，两边落点都是 12px/12px 所以换过来不跳）；
    // bc＝回到"逐张卡让位"那套旧逻辑。def 要和 theme-boot.js 的 DISPLAY_GROUPS 一起改
    dash_grade_owner: { def: 'ours', options: ['ours', 'bc'], text: { ours: 'Modern Canvas', bc: 'BetterCampus' } },
    card_layout: { def: 'masonry', options: ['masonry', 'rows'], text: { masonry: 'Masonry', rows: 'Rows' } },
    timeframe: { def: 'month', options: ['week', 'month', 'quarter'], text: { week: 'Week', month: 'Month', quarter: 'Quarter' } },
    week_start: { def: 'rolling', options: ['rolling', 'sunday', 'monday'], text: { rolling: 'Rolling (Yesterday)', sunday: 'Sunday', monday: 'Monday' } },
    // Canvas colours 那一档的深浅色。三格存档和 BetterCampus 都已经把页面那一层的色定死了，
    // 所以只有停在 Canvas 那一格时这一档才管用（判据见 mcDarkOn）。
    // 落点在 style.css 的 bc-colour-mode-dark 那一节，首帧那半截在 theme-boot.js 的 applyDisplayClasses
    colour_mode: { def: 'light', options: ['light', 'dark'], text: { light: 'Light', dark: 'Dark' } }
  };

  // 主题墙的排序档：和 MODERN_SETTINGS 同一种形状，好共用那颗下拉。
  // 它不进 MODERN_SETTINGS，因为那边每一份会被 applyLogoSettings 拿去挂类名，而排序不驱动样式。
  // popular 是按使用人数排（抓取数据里的 application_count），点赞分另有 s 字段
  const THEME_SORTS = {
    def: 'popular',
    options: ['popular', 'az', 'za'],
    text: { popular: 'Most used', az: 'A to Z', za: 'Z to A' }
  };

  // 课程卡上 Tasks 那一块最多摆几条。1 到 8 每一档都摆得出来，没有"全部"那种兜底档。
  // 和 THEME_SORTS 同一个道理，它不进 MODERN_SETTINGS：那边每一份都会被拿去挂 html 的类名
  const CARD_TASK_LIMIT = {
    def: '3',
    options: ['1', '2', '3', '4', '5', '6', '7', '8'],
    text: { '1': '1 task', '2': '2 tasks', '3': '3 tasks', '4': '4 tasks',
      '5': '5 tasks', '6': '6 tasks', '7': '7 tasks', '8': '8 tasks' }
  };

  /* AI 面板那一屏的形态档和停靠边。它们不进 MODERN_SETTINGS：
     那边每一份都会被 applyLogoSettings 拿去挂 html 的类名，而这两档只是给
     study-panel.js 读数用的（形态落在它自己那三个类名上），没有样式表认那两个类名。
     和 THEME_SORTS、CARD_TASK_LIMIT 同一个道理，共用同一颗下拉的形状 */
  const AI_PANEL_MODE = {
    def: 'docked',
    options: ['docked', 'floating'],
    text: { docked: 'Docked to the page edge', floating: 'Floating window' }
  };

  const AI_PANEL_SIDE = {
    def: 'right',
    options: ['right', 'left'],
    text: { right: 'Right side', left: 'Left side' }
  };

  const AI_PROVIDERS = {
    def: 'openai',
    options: ['openai', 'claude', 'gemini', 'openrouter', 'deepseek', 'qwen', 'kimi', 'xiaomi', 'custom'],
    text: {
      openai: 'OpenAI (Official)',
      claude: 'Claude (Anthropic)',
      gemini: 'Google Gemini',
      openrouter: 'OpenRouter (Multi-model)',
      deepseek: 'DeepSeek',
      qwen: 'Qwen (Alibaba)',
      kimi: 'Kimi (Moonshot)',
      xiaomi: 'Xiaomi MiMo',
      custom: 'Custom endpoint'
    }
  };

  const DASH_WIDGET_LAYOUT = {
    def: 'combined',
    options: ['combined', 'separate'],
    text: { combined: 'Widget Cards (Combined)', separate: 'Separate cards' }
  };

  const GPA_SCORE_DISPLAY = {
    def: 'always',
    options: ['always', 'hover'],
    text: { always: 'Always visible', hover: 'Show on hover only' }
  };

  const DASH_WIDGET_COVER = {
    def: '0',
    options: ['0', '1'],
    text: { '0': 'Off', '1': 'On' }
  };

  function ctsMeta(key) {
    if (key === 'ai_provider') return AI_PROVIDERS;
    if (key === 'ai_panel_mode') return AI_PANEL_MODE;
    if (key === 'ai_panel_side') return AI_PANEL_SIDE;
    if (key === 'theme_sort') return THEME_SORTS;
    if (key === 'theme_owner') return THEME_OWNER;
    if (key === 'colour_tier') return COLOUR_TIERS;
    if (key === 'card_task_limit') return CARD_TASK_LIMIT;
    if (key === 'dash_widget_layout') return DASH_WIDGET_LAYOUT;
    if (key === 'dash_widget_cover') return DASH_WIDGET_COVER;
    if (key === 'gpa_score_display') return GPA_SCORE_DISPLAY;
    return MODERN_SETTINGS[key];
  }

  // 页面那一层（底色、侧栏壁纸、卡片贴图、字体）归谁刷。两档，没有第三档：
  // External Extension 在跑的时候它也在刷这一层，两套叠在一起会出一系列"米色压米色"的东西，
  const THEME_OWNER = {
    get def() {
      return document.documentElement.classList.contains('mc-bc-live') ? 'bc' : 'mc';
    },
    options: ['bc', 'mc'],
    get text() {
      const live = document.documentElement.classList.contains('mc-bc-live');
      return {
        bc: live ? 'Better Campus' : 'Recorded Better Campus Theme',
        mc: 'Modern Canvas'
      };
    }
  };

  function mcHasRecordedBcTheme() {
    try {
      return !!localStorage.getItem('mc_bc_recorded_theme');
    } catch (_) {
      return false;
    }
  }

  function mcPageThemeOwner() {
    return modernSetting('theme_owner');
  }

  /* ===== 颜色档位（存档）=====
     页面上那一份色从哪儿来只有四档：Canvas 自己的色（我们一行都不刷）、存档一、存档二、存档三。
     每一格存档装的是"某份主题的原始色（base）＋你亲手拧过的那几档（edits）"，拧一下当场写进
     正在用的那一格，没有保存键。换一份主题＝把正在用的那一格整格换成新主题的色，你拧过的不保留；
     当时停在 Canvas 那一档就换成存档一，并跟着切过去（不然挑了主题却看不见）。
     以前那颗藏着的总闸 mc_keep_theme（'0'＝什么都不刷）就是这里的 Canvas 档，
     读它的地方全部改成读档位，那颗键只剩迁移时读一次。 */
  const BCX_TIER_KEY = 'bc_colour_tier';
  const BCX_SAVE_KEYS = ['mc_save_1', 'mc_save_2', 'mc_save_3'];
  const BCX_OLD_SAVE_KEYS = ['bcx_save_1', 'bcx_save_2', 'bcx_save_3'];
  // 迁移只抄不删：别的标签页里没重载的旧版脚本还在写这两份键，删了等于把他的主题整个丢掉
  const BCX_LEGACY_KEYS = ['mc_applied_theme_v1', 'mc_theme_snapshot_v3', 'bcx_applied_theme_v1', 'bcx_theme_snapshot_v3'];
  const BCX_CLEARABLE = { 'background-0': '--mc-background-0', buttons: '--mc-buttons' };

  function mcClearedTokens(snap) {
    const out = {};
    const on = (snap && snap.clearSlots) || {};
    for (const slot of Object.keys(BCX_CLEARABLE)) if (on[slot]) out[BCX_CLEARABLE[slot]] = true;
    return out;
  }

  // 统一读取本地存档：mc_ 优先，若无则回落至 bcx_ 并静默复制迁移，防止老存档丢失
  function mcGetThemeSave(index) {
    const val = localStorage.getItem(BCX_SAVE_KEYS[index]);
    if (val) return val;
    const oldVal = localStorage.getItem(BCX_OLD_SAVE_KEYS[index]);
    if (oldVal) {
      try { localStorage.setItem(BCX_SAVE_KEYS[index], oldVal); } catch (e) {}
      return oldVal;
    }
    return null;
  }

  // 读取设置项兜底：mc_ 为空时回落到 bcx_
  function mcReadSetting(key, def) {
    let v = localStorage.getItem(key);
    if (v !== null) return v;
    if (key && key.indexOf('mc_') === 0) {
      v = localStorage.getItem('bcx_' + key.slice(3));
      if (v !== null) {
        try { localStorage.setItem(key, v); } catch (e) {}
        return v;
      }
    }
    return def !== undefined ? def : null;
  }

  // 第一次跑到这一版时把现场搬进存档一。theme-boot.js 里有一份一字一样的，两边算出来必须同一档
  function mcTierInit() {
    const saved = localStorage.getItem(BCX_TIER_KEY);
    if (saved === 'canvas' || saved === '1' || saved === '2' || saved === '3') return saved;
    let hasTheme = !!mcGetThemeSave(0);
    if (!hasTheme) {
      let legacy = null;
      for (const key of BCX_LEGACY_KEYS) {
        legacy = localStorage.getItem(key);
        if (legacy) break;
      }
      if (legacy) {
        try { localStorage.setItem(BCX_SAVE_KEYS[0], legacy); } catch (e) { console.log('[MCX] 存档一放不下', e && e.name); }
        hasTheme = true;
      }
    }
    const keep = mcReadSetting('mc_keep_theme');
    const tier = keep === '0' || !hasTheme ? 'canvas' : '1';
    try { localStorage.setItem(BCX_TIER_KEY, tier); } catch (e) {}
    return tier;
  }

  function mcTier() {
    return mcTierInit();
  }

  // 没有激活自选主题（Canvas 模式，或者当前存档是空的没有任何主题颜色）
  function mcThemeOff() {
    if (mcTier() === 'canvas') return true;
    const info = mcSaveInfo();
    return !info.tiered;
  }

  /* 深浅色这一档：在没有主题（或停在 Canvas colours）时管用。
     深色生效时要把 mc-themed 一起挂上：那 489 条已经写好的换皮规则全挂在它身上 */
  function mcDarkOn() {
    return modernSetting('colour_mode') === 'dark' && mcThemeOff();
  }

  /* 我们这一边现在是哪种照明。只有停在 Canvas colours 那一格、而且他真去动过那颗开关时才算数：
     没动过的话默认值是 light，那不该拿去和竞品比对然后弹提示（等于我们替他的默认值找他麻烦） */
  function mcOurLighting() {
    if (!mcThemeOff()) return '';
    if (localStorage.getItem('bc_colour_mode') === null) return '';
    return modernSetting('colour_mode');
  }

  /* BetterCampus 现在是深还是浅。两个来源，按可靠程度排：
     1) 它写在同源 localStorage 里那份防闪缓存（有 theme_enabled 和 dark_mode 两个字段，
        字段形状之前实测过）。这份只在它自己开了防闪时才写，读不到是常态，不是异常。
     2) 它挂在 <html> 行内样式上的那批 --bc* 槽值（它主题开着才会有）。
        【为什么只读行内，不读 computed】我们深色那一节把同名的一批 --bc* 别名成了自家 token，
        读 computed 会先撞到自己写的这份上＝永远量出"它和我们一样"，那句提示就废了。
     两个都读不到就返回空：那种情况下它没在刷这一页的色。 */
  function mcBcLighting() {
    let cache = null;
    try {
      cache = JSON.parse(localStorage.getItem('_bettercampus_theme_cache') || 'null');
    } catch (e) {
      cache = null;
    }
    if (cache && cache.theme_enabled) {
      if (typeof cache.dark_mode === 'boolean') return cache.dark_mode ? 'dark' : 'light';
      const cached = mcToRgb(String(cache.bg || ''));
      if (cached) return mcLuminance(cached) > 0.5 ? 'light' : 'dark';
    }
    const inline = document.documentElement.style;
    const page = mcToRgb(String(inline.getPropertyValue('--bcbackground-1')
      || inline.getPropertyValue('--bcbackground-0') || '').trim());
    if (page) return mcLuminance(page) > 0.5 ? 'light' : 'dark';
    const ink = mcToRgb(String(inline.getPropertyValue('--bctext-0') || '').trim());
    return ink ? (mcLuminance(ink) > 0.5 ? 'dark' : 'light') : '';
  }

  /* 两边照明对不上＝侧栏 Settings 那一行底下那句提示（落点 style.css 第 37 节）。
     判据两条都要成立，任何一边读不到都不算冲突：
     ① 我们这一格真选过 Dark／Light——mcOurLighting() 只在停在 Canvas colours 那一档、
        而且他动过那颗开关时才给值，没动过的默认值不拿去跟竞品比对；
     ② BC 那边读得出来（mcBcLighting()：它那份防闪缓存，或它钉在 <html> 行内的那批 --bc* 槽值），
        且和我们的不一样。
     中间曾把它撤掉（注释写"BC 样式已隔离控制"），2026-10-17 他点名要回来，所以判据照原样接上 */
  function mcLightingClash() {
    const ours = mcOurLighting();
    if (!ours) return false;
    const bc = mcBcLighting();
    return !!bc && bc !== ours;
  }

  // 正在用的那一格存档的键名。停在 Canvas 档时算存档一：那时候挑主题落的就是它
  function mcTierSlot() {
    const tier = mcTier();
    return tier === 'canvas' ? 1 : Number(tier);
  }

  function mcSaveKey() {
    return BCX_SAVE_KEYS[mcTierSlot() - 1];
  }

  function mcSetTier(value, from) {
    if (value !== 'canvas' && value !== '1' && value !== '2' && value !== '3') return mcTier();
    // 从哪一格来：下拉在调这里之前已经把新值写进键了，所以"上一档"要由面板递进来
    const prev = from === 'canvas' || from === '1' || from === '2' || from === '3'
      ? (from === 'canvas' ? 1 : Number(from)) : mcTierSlot();
    localStorage.setItem(BCX_TIER_KEY, value);
    /* 切进一格空的存档：先把另一格正在用的那份主题的原始色照抄进去（剥掉你拧过的那几档）。
       不这么做的话那一格里没有任何色可刷，点它和点 Canvas 那一档在画面上分不出来。
       重算 vars／底色层／编译表这三样交给 mcCommitSnapshot，不在这儿再拼一遍 */
    if (value !== 'canvas' && !mcSaveInfo(Number(value)).tiered) {
      let src = null;
      try { src = JSON.parse(mcGetThemeSave(prev - 1) || 'null'); } catch (e) { src = null; }
      if (src && src.base) mcCommitSnapshot(Object.assign({}, src, { edits: {}, fontEdit: null }));
    }
    return value;
  }

  // 某一格存档现在装的是什么：有没有主题、那份主题叫什么、你拧过几档。面板那四档的字和
  // "回到主题自带的色"那颗键都要读它，读的是落盘的值，不猜。不传就是正在用的那一格
  function mcSaveInfo(slot) {
    const at = slot || mcTierSlot();
    const empty = { slot: at, tiered: false, title: '', edits: 0 };
    let snap = null;
    try {
      snap = JSON.parse(mcGetThemeSave(at - 1) || 'null');
    } catch (e) { return empty; }
    if (!snap || !Object.keys(snap.vars || {}).length) return empty;
    return {
      slot: at,
      tiered: true,
      title: (snap.imported && (snap.imported.title || snap.imported.code)) || '',
      edits: Object.keys(snap.edits || {}).length + Object.keys(snap.clearSlots || {}).length
    };
  }

  // 顶上三档主题存档的字。Canvas colours 剥离为单独的置顶切换按钮
  const COLOUR_TIERS = {
    def: '1',
    options: ['1', '2', '3'],
    get text() {
      const out = {};
      [1, 2, 3].forEach(function (slot) {
        out[String(slot)] = 'Save ' + slot + (mcSaveInfo(slot).tiered ? '' : ' (empty)');
      });
      return out;
    }
  };

  // 我们到底贴不贴页面那一层。停在 Canvas 那一档时两边都不贴（旧版那颗总闸关掉的那一档），
  // 这一档只管"是我们贴还是交给 External Extension 贴"。
  // 选了交给它、可它没在跑的时候照旧贴我们的：那时候页面上没有第二套主题，
  // 不贴就是整页掉回原生色，比"和它撞车"更难看，而且他哪天把 BC 装回来这一档又自动生效
  //
  // BC 在不在跑，默认读那颗类名。但第一趟取色时类名还没挂上（挂它的是这一趟自己末尾），
  // 读类名就会读成"不在"，于是每次载入都先贴一帧我们的主题、两秒后再撤＝"每次重载变色一次"。
  // 所以第一趟把现场量到的那个值当参数递进来，别处不传、照旧读类名
  function mcPaintsPageTheme(bcLiveNow) {
    if (mcThemeOff()) return false;
    const live = bcLiveNow === undefined
      ? document.documentElement.classList.contains('mc-bc-live')
      : !!bcLiveNow;
    const saved = localStorage.getItem('bc_theme_owner');
    const owner = saved === 'bc' || saved === 'mc' ? saved : (live ? 'bc' : 'mc');
    return owner === 'mc' || !live;
  }

  function modernSetting(key) {
    const meta = ctsMeta(key);
    const saved = localStorage.getItem('bc_' + key);
    return meta.options.indexOf(saved) !== -1 ? saved : meta.def;
  }

  function applyLogoSettings() {
    const root = document.documentElement;
    root.classList.toggle('bc-hide-feedback-logo', localStorage.getItem('bc_keep_feedback_logo') !== '1');
    root.classList.toggle('bc-hide-nav-logo', localStorage.getItem('bc_keep_nav_logo') !== '1');
    root.classList.toggle('bc-hide-footer', localStorage.getItem('bc_keep_footer') !== '1');
    root.classList.toggle('bc-hide-course-rail', localStorage.getItem('bc_show_course_rail') !== '1');
    // 日历那三档（圆角、加载圈、今天那格改用 Accent 描边）以前各有一颗设置开关，
    // 2026-10-11 三颗连说明一起删掉＝常开，所以这里不再读那三格，类名一律挂上
    root.classList.add('mc-cal-round');
    // 日历页判据：theme-boot.js 那份 document_start 的算式一字一样，这边只是让设置里
    // 任何一次重挂都算出同一个结果（值不会变，因为地址在这一页活着的时候不会变）
    root.classList.toggle('mc-cal-page', /\/calendar(\/|$)/.test(window.location.pathname));
    root.classList.add('mc-cal-today-ring');
    // hover 那一圈强调色描边：缺 buttons 档的主题上，控件的 hover 会和身后那一档撞平，靠描边把形状描出来
    root.classList.toggle('mc-hover-ring', mcReadSetting('mc_hover_ring') !== '0');
    // 文字链接吃 Accent 那一档（落点在 style.css 的 mc-link-accent，色值由 --mc-links-text 现算）
    root.classList.toggle('mc-link-accent', mcReadSetting('mc_link_accent') !== '0');
    /* 侧栏图上那层磨砂。判据和 theme-boot.js 的 applyDisplayClasses 一字一样（两边算出两个结果
       ＝首帧糊、一秒后不糊），这边跑一趟是为了他在设置里翻这颗键时当场生效。
       那层空壳节点归 nav-boot.js 挂（它在 document_start 就等得到侧栏），这里只补一颗：
       侧栏被 Canvas 重画掉时把节点放回去，值没变就一个键都不按 */
    const navBlur = mcReadSetting('mc_nav_blur') === '1';
    root.classList.toggle('mc-nav-blur', navBlur);
    const header = document.querySelector('.ic-app-header');
    if (header && !header.querySelector(':scope > .mc-nav-frost')) {
      const plate = document.createElement('div');
      plate.className = 'mc-nav-frost';
      plate.setAttribute('aria-hidden', 'true');
      header.insertBefore(plate, header.firstChild);
    }
    // 给每张课程卡补一圈灰边。算式依赖下面的主题计算，首帧如果底层变量尚未就绪则静默等待 boot 阶段执行
    if (typeof BCX_TOKEN_MAP !== 'undefined') {
      mcStep('mcSyncDashOutline', () => mcSyncDashOutline());
    }
    /* 卡片上那块 Tasks 上不上屏，同时管着 BetterCampus 补在同一处的那段 Due 让不让位
       （落点 style.css 第 37 节）。首帧那半截在 theme-boot.js 的 applyDisplayClasses，
       两边读的是同一个 mc_dash_tasks，判据一字一样 */
    root.classList.toggle('mc-dash-tasks', mcReadSetting('mc_dash_tasks') !== '0');
    /* 第 24／25 节那两档：List view 顶部那条白栏、点铃弹出来那屏提醒面板。
       这两颗类名在 bcx→mc 改名那一笔（1bc309b）里被连着删走，于是设置里那两颗勾没人读＝
       勾了画面不动。首帧那半截在 theme-boot.js 的 applyDisplayClasses，两边判据一字一样 */
    root.classList.toggle('mc-planner-plate', mcReadSetting('mc_planner_plate') !== '0');
    root.classList.toggle('mc-opportunities-plate', mcReadSetting('mc_opportunities_plate') !== '0');
    /* 深浅色翻一下就要当场生效，所以这里连 mc-themed 一起管：那一档要靠挂在它身上的换皮规则
       才成套。摘的时候只摘自己那半截，档位不在 Canvas 那一格或 BC 在跑时那个类名归取色那一趟定，
       这里不抢（抢了会把主题页的配色摘掉） */
    if (mcDarkOn()) root.classList.add('mc-themed');
    else if (mcThemeOff() && !root.classList.contains('mc-bc-live')) root.classList.remove('mc-themed');
    const ltiTintOn = localStorage.getItem('mc_lti_tint') === '1';
    root.classList.toggle('mc-lti-tint', ltiTintOn);
    root.classList.toggle('mc-lti-notint', !ltiTintOn);
    Object.keys(MODERN_SETTINGS).forEach(key => {
      const prefix = 'bc-' + key.replace(/_/g, '-') + '-';
      /* 深浅色这一档只有停在 Canvas 那一格才算数（判据见上面的 mcDarkOn）。装了主题还挂
         bc-colour-mode-dark，而主题页本来就有 mc-themed，style.css 第 36 节那条
         .ic-app-header 就会按权重压过主题表里的那条，侧栏一直是灰黑、主题的侧栏色上不去。
         首帧那半截在 theme-boot.js 的 applyDisplayClasses，两边算的是同一个结果 */
      const value = key === 'colour_mode' && !mcDarkOn() ? 'light' : modernSetting(key);
      MODERN_SETTINGS[key].options.forEach(opt => {
        root.classList.toggle(prefix + opt, value === opt);
      });
    });
  }

  // 全局待办状态数据结构
  let modernAssignments = []; // 全部作业/测验/讨论项目
  let modernAnnouncements = []; // 全部公告项目
  let modernCustomColors = {}; // 课程颜色映射表: { [courseId]: '#hex' }
  let modernApiLoaded = false; // 是否已经成功请求过 API
  let modernIsFetching = false;
  // 这一趟读到一半断了／回包不对：不能让它一直顶着"加载中"，那等于把断网说成还在读。
  // 每次重新发起都清掉，重试那一趟照样能显示"加载中"
  let modernFetchFailed = false;
  // 屏幕上现在这一帧是不是"加载中"。只有画的人自己知道，请求那头猜不出来：
  // 翻到空的那一窗、请求又恰好没读回来，没人补一帧的话那句就永远挂在那
  let mcPaintedLoading = false;

  // 一次都还没读到过（而且这一趟没失败）：这时候面板上任何数字都还是假的
  function mcTodosBlank() {
    return !modernApiLoaded && !modernFetchFailed;
  }

  // 空状态那一格多算一条：翻页重取的那一趟，旧那一窗的名单已经不作数了
  function mcReadingTodos() {
    return modernIsFetching || mcTodosBlank();
  }

  // 课程默认调色板（柔和色板）
  const COURSE_PALETTE = ['#d13438', '#b5830e', '#008ee2', '#2b7a78', '#9333ea', '#e0245e', '#059669', '#d97706'];
  function getCourseColor(courseId, courseName) {
    if (courseId && modernCustomColors[String(courseId)]) {
      return modernCustomColors[String(courseId)];
    }
    const key = String(courseId || courseName || '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = key.charCodeAt(i) + ((hash << 5) - hash);
    }
    const idx = Math.abs(hash) % COURSE_PALETTE.length;
    return COURSE_PALETTE[idx];
  }

  // 本地标记优先：手动点过就以本地记录为准，没点过才看 Canvas 自己的状态。
  // 存 false 是有意义的（“我手动把它放回待办”），所以不能再用删键表示取消。
  // 现在只剩公告的已读走这里：作业那一侧已经改成一律以 Canvas 为准，本地键只能加不能减
  function resolveLocalFlag(localMap, id, canvasFlag) {
    const v = localMap[String(id)];
    return v === undefined ? !!canvasFlag : v === true;
  }

  // 圆圈当前是实心就算“已完成/已读”，点它就是要退回未处理，所以写入的是明确布尔值而不是删键
  function writeLocalFlag(storageKey, id, value) {
    var state = {};
    try {
      state = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
    } catch (e) {
      state = {};
    }
    state[String(id)] = value;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (e) {}
  }

  // ===== 打勾落到哪儿：Canvas 服务端的 planner override，还是只留这台浏览器的本地键 =====
  function mcCanvasSyncOn() {
    return localStorage.getItem('mc_todo_canvas') !== '0';
  }

  // ===== 一条作业现在算不算"待完成"：待办面板和课程卡上那块 Tasks 共用这一份判据 =====
  // 返回 null            = 已完成（Canvas 说交过，或只本地那一档他点过勾）
  // 返回 { drop: true }   = 过期了，但 MISSING 那颗关着／已经超出所选周数：两边都不摆
  // 返回 { missing: true} = 过期还没交，留在待办里
  // 返回 {}               = 还没到期
  function mcTaskState(item, userDoneMap, now) {
    const canvasSync = mcCanvasSyncOn();
    if (item.isSubmitted || (!canvasSync && userDoneMap[String(item.id)] === true)) return null;
    const dueTime = item.due && !isNaN(item.due.getTime()) ? item.due.getTime() : null;
    if (dueTime === null || dueTime >= now.getTime()) return {};
    // 没有东西可交的那种作业（作业页上连上传那一格都没有）过期以后默认不进 MISSING，
    // 直接归到已完成那一侧。设置里翻成"Keep them in MISSING"才摆进去，那种时候
    // Canvas 永远不会替它算提交，只能他自己点勾。他自己把勾取消过的那一条照他说的留在待办里
    const explicitUndone = canvasSync ? item.markedUndone === true : userDoneMap[String(item.id)] === false;
    if (item.noSubmit && !missingOnPaperShown() && !explicitUndone) return null;
    if (!mcMissingOn() || dueTime < now.getTime() - missingRangeDays() * 86400000) return { drop: true };
    return { missing: true };
  }

  // ===== MISSING：过期还没交的那一批，要不要提醒、置顶画在哪个选项卡、过期多久之内还算 =====
  function mcMissingOn() {
    return localStorage.getItem('mc_show_missing') !== '0';
  }

  const MISSING_DAYS = { '1w': 7, '2w': 14, '3w': 21, '4w': 28 };

  function missingRangeDays() {
    return MISSING_DAYS[modernSetting('missing_range')] || 7;
  }

  function missingPlacement() {
    return modernSetting('missing_placement') === 'finished' ? 'finished' : 'uncompleted';
  }

  // 纸面作业过期以后要不要也摆进 MISSING。默认不摆：这种作业 Canvas 永远不会算"已提交"，
  // 摆进去就等于让一批根本没法交的东西常驻在最顶上
  function missingOnPaperShown() {
    return modernSetting('missing_on_paper') === 'show';
  }

  // ===== MISSING 那两条 planner 说不出来的事 =====
  // 一、有没有东西可交：planner 回包里的 plannable 实测只有
  //     id,title,created_at,updated_at,points_possible,due_at,lock_at，不带 submission_types。
  // 二、到底交没交：能考多次的测验，人考过了 planner 还说没交（他报的，截图那两张是
  //     submitted:false／graded:true／score:null，卡片上就是 -/10pts）。所以按作业再问一次
  //     Canvas 自己那份提交记录（作业页和成绩页用的就是它）。
  //     第一版按 workflow_state 名单判，把该 missing 的一批也判成交了，现在只认 submitted_at。
  // 问到的存本地，7 天内不再问；"没交"这一半不存，每次打开重新问。
  // （回包里另有 submissions.missing，但实测 59 条过期项只有 1 条为真：它只在批了迟交政策时才打）
  // 判据换过一次（状态名单→只认 submitted_at），键必须升档：
  // 上一版按错判据写进去的 done:true 会把这些条目藏 7 天。
  // 再升一档是因为这一轮加了"测验尝试"这一路判据，旧的"问过了"记录会让补查早退、日志出不来
  const MC_MISSING_KEY = 'mc_missing_detail_v6';
  const MC_MISSING_TTL = 7 * 86400000;
  // 判据升档时留下的旧档，留着只是占他本地存储
  ['mc_no_submit_types_v1', 'mc_missing_detail_v2', 'mc_missing_detail_v3', 'mc_missing_detail_v4', 'mc_missing_detail_v5']
    .forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });

  function mcMissingStore() {
    try { return JSON.parse(localStorage.getItem(MC_MISSING_KEY) || '{}'); } catch (e) { return {}; }
  }

  function mcMissingSave(store) {
    try { localStorage.setItem(MC_MISSING_KEY, JSON.stringify(store)); } catch (e) {}
  }

  // 测验尝试那份名单要按 user_id 挑出他自己那几次。有的条目连作业 id 都没有，
  // 拿不到提交记录里的 user_id，所以问一次"我是谁"并记在内存里
  let mcMyUserId = null;
  function mcWhoAmI() {
    if (mcMyUserId) return Promise.resolve(mcMyUserId);
    return fetch('/api/v1/users/self', { credentials: 'same-origin' })
      .then(res => res.ok ? res.json() : null)
      .then(j => { if (j && j.id != null) mcMyUserId = j.id; return mcMyUserId; })
      .catch(() => null);
  }

  // 这一条该去问谁。测验在 planner 里挂的是 quiz 自己的 id，只有它同时带回 assignment_id
  // 时才有"作业"可问；拿 quiz 的 id 当作业 id 会问到同一门课里另一颗作业上去
  // （上一版"该 missing 的不 missing"就是这么来的），所以这里拆成两个靶子：
  // aid 问作业＋那份提交记录，quizId 问测验自己的尝试列表
  function mcMissingProbe(item) {
    const id = String(item.id);
    const behind = item.overridePlannableId && item.overridePlannableId !== id
      ? String(item.overridePlannableId) : null;
    const aid = item.type === 'assignment' ? id : behind;
    // 卡片那条链接是 Canvas 自己给的：里面带 /quizzes/<id> 就说明这颗是测验，
    // 不管 planner 把它报成 quiz 还是 assignment（实测 FRQ 3.5 报的是 assignment）
    const m = /\/quizzes\/(\d+)/.exec(item.url || '');
    const quizId = item.type === 'quiz' ? id : (m ? m[1] : null);
    if (!aid && !quizId) return null;
    return { aid, quizId, key: aid ? 'a' + aid : 'q' + quizId };
  }

  // 本地有记录的当场写进条目，这样首帧就画对，不用等网络
  function mcApplyCachedMissing(list) {
    if (!mcMissingOn()) return;
    const store = mcMissingStore();
    const now = Date.now();
    list.forEach(item => {
      const probe = mcMissingProbe(item);
      const hit = probe ? store[probe.key] : null;
      if (!hit || now - hit.at >= MC_MISSING_TTL) return;
      if (typeof hit.no === 'boolean') {
        item.noSubmit = hit.no === true;
        item.noSubmitKnown = true;
      }
      // 他自己把勾取消过的那一条不算：那份提交记录照他说的让位给待办
      if (hit.done === true && !item.isSubmitted && item.markedUndone !== true) item.isSubmitted = true;
    });
  }

  // 只问这一屏用得上的：过期、Canvas 说没交、还在 MISSING 窗口里的那几条
  async function mcResolveMissing() {
    if (!mcMissingOn()) return;
    const now = Date.now();
    const cut = now - missingRangeDays() * 86400000;
    const store = mcMissingStore();
    const todo = [];
    const seen = new Set();
    modernAssignments.forEach(item => {
      // 上一版这里还写着 || item.markedUndone，把"他自己取消过勾"的那一条整个跳过，
      // 连一行日志都不出——Projectile Range 就是这么消失的。现在它照样要问、照样出日志，
      // 但问出来的"交过"不往它身上落（见下面那条 markedUndone 守卫）：
      // 取消过又没勾回去的，照他说的仍然算 missing
      if (item.isSubmitted) return;
      const dueTime = item.due ? item.due.getTime() : null;
      if (dueTime === null || dueTime >= now || dueTime < cut) return;
      const probe = mcMissingProbe(item);
      if (!probe || !item.courseId) return;
      const hit = store[probe.key];
      const fresh = hit && now - hit.at < MC_MISSING_TTL;
      const needTypes = !!probe.aid && (!fresh || typeof hit.no !== 'boolean');
      const needDone = !!probe.aid && (!fresh || hit.done !== true);
      const needQuiz = !!probe.quizId && (!fresh || hit.done !== true);
      if (seen.has(probe.key)) return;
      if (!needTypes && !needDone && !needQuiz) return;
      seen.add(probe.key);
      todo.push({ item, probe, needTypes, needDone, needQuiz });
    });
    if (!todo.length) return;

    const ask = url => fetch(url, { credentials: 'same-origin' })
      .then(async res => {
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: res.status, json, text };
      })
      .catch(err => ({ status: 0, json: null, text: String(err && err.message) }));

    const [results, myUid] = await Promise.all([
      Promise.all(todo.map(t => {
        const base = `/api/v1/courses/${t.item.courseId}`;
        return Promise.all([
          t.needTypes ? ask(`${base}/assignments/${t.probe.aid}`) : null,
          t.needDone ? ask(`${base}/assignments/${t.probe.aid}/submissions/self`) : null,
          t.needQuiz ? ask(`${base}/quizzes/${t.probe.quizId}/submissions?per_page=50`) : null
        ]);
      })),
      todo.some(t => t.needQuiz) ? mcWhoAmI() : Promise.resolve(null)
    ]);

    // 只有真把某条从 MISSING 挪走才重绘，不然白闪一下
    let changed = false;
    for (let i = 0; i < results.length; i++) {
      const pair = results[i];
      const t = todo[i];
      const item = t.item;
      const rTypes = pair[0];
      const rSub = pair[1];
      const rQuiz = pair[2];
      const prev = store[t.probe.key] || {};

      // 一、有没有东西可交。回包必须是我要问的那颗作业，不然整条丢掉
      const aJ = rTypes && rTypes.json && String(rTypes.json.id) === String(t.probe.aid) ? rTypes.json : null;
      const types = aJ ? {
        no: Array.isArray(aJ.submission_types) && aJ.submission_types.every(x => x === 'none' || x === 'on_paper'),
        name: aJ.name
      } : null;

      // 二、那份提交记录。判据只认 submitted_at：状态名和分数都不当"交过"（他拍死的口径），
      // 其余字段原样读进日志，下一轮判据从日志里挑
      const sJ = rSub && rSub.json && String(rSub.json.assignment_id) === String(t.probe.aid) ? rSub.json : null;
      const sub = sJ ? {
        done: !!sJ.submitted_at,
        state: sJ.workflow_state || '-',
        at: sJ.submitted_at ? String(sJ.submitted_at).slice(0, 16) : '-',
        stype: sJ.submission_type || '-',
        attempt: sJ.attempt != null ? sJ.attempt : '-',
        missing: sJ.missing === true,
        grade: sJ.grade == null ? '-' : String(sJ.grade),
        uid: sJ.user_id != null ? sJ.user_id : null
      } : null;

      // 三、测验自己的尝试列表：考没考过只记在这里（作业那份的"提交时间"实测是空的）。
      // planner 把测验报成 assignment 的那一类（实测 FRQ 3.5 就是这样）没有测验 id，
      // 但 Canvas 在提交记录里给了 preview_url，里面就写着 /quizzes/<id>
      let qzId = t.probe.quizId;
      if (!qzId && sJ) {
        const mq = /\/quizzes\/(\d+)/.exec(String(sJ.preview_url || ''));
        if (mq) qzId = mq[1];
      }
      const rAttempts = rQuiz || (qzId
        ? await ask(`/api/v1/courses/${item.courseId}/quizzes/${qzId}/submissions?per_page=50`)
        : null);
      // 只数他 user_id 那几次，万一这颗端点回的是全班，"有人考过"不能当"我考过"
      let quiz = null;
      if (rAttempts) {
        const list = Array.isArray(rAttempts.json) ? rAttempts.json : null;
        const uid = (sub && sub.uid != null) ? sub.uid : myUid;
        const mine = list && uid != null ? list.filter(s => s && String(s.user_id) === String(uid)) : null;
        quiz = {
          status: rAttempts.status,
          count: mine ? mine.length : (list ? `全班 ${list.length} 条里没有我的 user_id` : (uid == null ? '不知道我是谁' : '回包不是名单')),
          // 一次考完交了一定有 finished_at，只点开没交的没有
          taken: !!mine && mine.some(s => !!s.finished_at),
          raw: list ? '' : String(rAttempts.text || '').slice(0, 300)
        };
      }

      const done = (sub && sub.done === true) || (quiz && quiz.taken === true) || prev.done === true;
      const entry = {
        at: now,
        no: types ? types.no : (typeof prev.no === 'boolean' ? prev.no : false),
        done
      };
      store[t.probe.key] = entry;
      if (types && !item.noSubmitKnown) {
        item.noSubmitKnown = true;
        item.noSubmit = types.no === true;
        if (types.no === true) changed = true;
      }
      if (done && !item.isSubmitted && item.markedUndone !== true) {
        item.isSubmitted = true;
        changed = true;
      }
    }
    mcMissingSave(store);
    if (changed) updatePanelDom();
  }

  /* ===== GRADED 那几条到底拿了多少分 =====
     planner 回包里那份 submissions 只有 submitted／graded／late／missing 这几个布尔，
     压根没有分数（Canvas 源码 lib/api/v1/planner_item.rb 的 submission_statuses 里就没写 score 这一项），
     所以批过分的卡片一直画成 "-/25pts"。分数只能按作业再问一次自己那份提交记录——
     作业页和成绩页读的就是它。问到的存本地，24 小时内不再问；重批那一档靠Todolist刷新。 */
  const MC_SCORE_KEY = 'mc_score_cache_v1';
  const MC_SCORE_TTL = 24 * 3600000;

  function mcScoreStore() {
    try { return JSON.parse(localStorage.getItem(MC_SCORE_KEY) || '{}'); } catch (e) { return {}; }
  }

  function mcScoreSave(store) {
    try { localStorage.setItem(MC_SCORE_KEY, JSON.stringify(store)); } catch (e) {}
  }

  // 写成卡片那一行原本的语法（"23/25pts"），字母等级／通过没有满分可比，原样落那一句
  function mcScoreText(sub, item) {
    const num = sub.score != null ? sub.score
      : (sub.grade != null && sub.grade !== '' && isFinite(Number(sub.grade)) ? sub.grade : null);
    if (num != null) {
      const pp = sub.points_possible != null && Number(sub.points_possible) > 0
        ? `${mcFbNum(sub.points_possible)}pts` : item.points;
      return pp ? `${mcFbNum(num)}/${pp}` : mcFbNum(num);
    }
    if (sub.grade != null && sub.grade !== '') return String(sub.grade);
    return '';
  }

  // 本地问过的当场写进条目，首帧就带着分数，不等网络
  function mcApplyCachedScores(list) {
    const store = mcScoreStore();
    list.forEach(item => {
      if (!item.isGraded) return;
      const probe = mcMissingProbe(item);
      const hit = probe ? store[probe.key] : null;
      if (hit && hit.text) item.score = hit.text;
    });
  }

  async function mcResolveScores() {
    const store = mcScoreStore();
    const now = Date.now();
    const todo = [];
    const seen = new Set();
    const skip = {};
    let gradedCount = 0;
    const bump = why => { skip[why] = (skip[why] || 0) + 1; };
    modernAssignments.forEach(item => {
      if (!item.isGraded) return;
      gradedCount++;
      if (!item.courseId) return bump('没有课程 id');
      const probe = mcMissingProbe(item);
      // 只有测验 id、认不出作业 id 的那种不问：拿测验 id 当作业 id 会问到同一门课另一颗作业上
      if (!probe) return bump('认不出 id');
      if (!probe.aid) return bump('只有测验 id');
      if (seen.has(probe.key)) return bump('同一条重复');
      const hit = store[probe.key];
      if (hit && now - hit.at < MC_SCORE_TTL) return bump('24 小时内问过');
      seen.add(probe.key);
      todo.push({ item, probe });
    });
    // 一次最多问 24 颗：Canvas 那个接口按秒限流，铺几十颗会把后面那批打成 403。
    // 挑到期最近的先问，被截掉的那批没写进档，下次刷新照样会再问
    if (todo.length > 24) {
      todo.sort((a, b) => (b.item.due ? b.item.due.getTime() : 0) - (a.item.due ? a.item.due.getTime() : 0));
      todo.length = 24;
    }
    console.log('[MCX score] build', BCX_BUILD_TAG, '·批过分的', gradedCount, '·要问', todo.length,
      todo.length ? '' : '一个都没问：' + (Object.keys(skip).map(k => k + ' ' + skip[k]).join(' / ') || '一条都没判成 graded'));
    if (!todo.length) return;

    const results = await Promise.all(todo.map(t =>
      mcFbAsk(`/api/v1/courses/${t.item.courseId}/assignments/${t.probe.aid}/submissions/self`)));

    const report = [];
    todo.forEach((t, i) => {
      const r = results[i];
      const json = r.ok && r.json && String(r.json.assignment_id) === String(t.probe.aid) ? r.json : null;
      const text = json ? mcScoreText(json, t.item) : '';
      // 只记问到的那次：限流／断网那种"没读到"不能当"没分数"存一天
      if (r.ok) store[t.probe.key] = { at: now, text };
      report.push(`${t.item.title.slice(0, 18)}: ` +
        (!r.ok ? `HTTP ${r.status}` : !json ? '回包对不上 id' : text ? text : `没分数(score=${json.score} grade=${json.grade})`));
      if (!text || t.item.score === text) return;
      t.item.score = text;
      // 只改卡片上那一格文字：整块重建会把这一屏卡片的入场动画再放一遍
      const span = document.querySelector(`#card_${CSS.escape(String(t.item.id))} .custom-todo-pts`);
      if (span) span.textContent = text;
    });
    mcScoreSave(store);
    console.log('[MCX score] 问到的：', report.join(' | '));
  }

  function mcTickNoteHtml() {
    return mcCanvasSyncOn()
      ? 'A tick is saved to your Canvas account, so it looks the same on every computer you sign in from. It is a label only you can see. Your teacher still sees the task as not submitted, and nothing gets uploaded.'
      : 'A tick stays in this browser only, and Canvas never hears about it. Anything Canvas already counts as done still shows as done here.';
  }

  function mcAssignmentById(id) {
    return modernAssignments.find(a => String(a.id) === String(id)) || null;
  }

  // 这一串只在点勾那条链路上出声，用来对着控制台看“点了什么、Canvas 回了什么、到底落没落”
  function mcTickLog(...args) {
    console.log('[BCX tick]', ...args);
  }

  // 写完再回服务器读一次，别拿“请求返回 200”当“状态真的变了”。
  // 只按 id 读那一行：扫 planner/items 会被 per_page 截断（320 天的窗口只回最早 100 条），
  // 近的条目根本不在返回里，于是把写成功误判成没写
  function mcVerifyOverride(overrideId) {
    if (!overrideId) return Promise.resolve({ found: false, reason: 'no-override-id' });
    return fetch(`/api/v1/planner/overrides/${overrideId}`, { credentials: 'same-origin' })
      .then(res => res.ok ? res.json() : { error: 'http-' + res.status })
      .then(o => ({
        found: !!o.id,
        overrideId: o.id || null,
        markedComplete: typeof o.marked_complete === 'boolean' ? o.marked_complete : null,
        dismissed: o.dismissed,
        updatedAt: o.updated_at
      }))
      .catch(err => ({ error: err.message }));
  }

  // Canvas 认的是 cookie 里那份 _csrf_token（它自家前端也是这么拿的）。
  // 实测：这条路由不读 body，参数（含 marked_complete）只能放 URL 查询串，
  // body 无论发 JSON 还是表单编码都收不到值
  function mcCsrfToken() {
    const m = document.cookie.match(/_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function mcForm(params) {
    return Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  }

  // 已经有一行就 PUT 翻值，没有就 POST。取消勾是 PUT 成 false，不删行
  // （实测 External Extension 取消 Projectile Range 那颗勾之后，override 26305673 还在，只是 marked_complete=false）
  async function mcSetCanvasOverride(item, done) {
    const token = mcCsrfToken();
    if (!token) throw new Error('no-assignment-id');
    // 测验和讨论的 override 挂在作业 id 上，不挂在它们自己的 id 上
    // （实测：quiz 1025491 的 override 记的是 assignment 14084154）
    const targetId = item.overridePlannableId || (item.type === 'assignment' ? String(item.id) : null);
    if (!targetId) throw new Error('no-assignment-id');
    // 参数只能走查询串。实测：body 无论发 JSON 还是表单编码，Canvas 都收不到值
    // （POST 回 201、PUT 回 200，但 marked_complete 一直是默认的 false）；
    // 把 marked_complete 放进 URL 才真的写成 true
    const headers = { 'X-CSRF-Token': token };
    const started = Date.now();
    mcTickLog('点的是', item.title, { ourId: item.id, type: item.type, override挂的id: targetId, 已有overrideId: item.overrideId || null, 要写成: done });
    if (item.overrideId) {
      const url = `/api/v1/planner/overrides/${item.overrideId}?` + mcForm({ marked_complete: done });
      const res = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers });
      const text = await res.text().catch(() => '');
      mcTickLog('PUT 参数 marked_complete=' + done, '→', res.status, `(${Date.now() - started}ms)`, text.slice(0, 160));
      if (!res.ok) throw new Error('put-' + res.status);
      const server = await mcVerifyOverride(item.overrideId);
      mcTickLog('服务器现在说', server);
      if (!server.found || server.markedComplete !== done) throw new Error('not-applied');
      return;
    }
    const url = '/api/v1/planner/overrides?' + mcForm({ plannable_type: 'assignment', plannable_id: targetId, marked_complete: done });
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers });
    const text = await res.text().catch(() => '');
    mcTickLog('POST 参数', mcForm({ plannable_type: 'assignment', plannable_id: targetId, marked_complete: done }), '→', res.status, `(${Date.now() - started}ms)`, text.slice(0, 160));
    if (!res.ok) throw new Error('post-' + res.status);
    let created = null;
    try { created = JSON.parse(text); } catch (e) {}
    if (!created || !created.id) {
      mcTickLog('返回里没有 override id，没法复核', text.slice(0, 160));
      throw new Error('not-applied');
    }
    item.overrideId = String(created.id);
    mcTickLog('新建的 override id =', item.overrideId);
    const server = await mcVerifyOverride(item.overrideId);
    mcTickLog('服务器现在说', server);
    if (!server.found || server.markedComplete !== done) throw new Error('not-applied');
  }

  // “说一句、点 OK 收掉”的小弹窗，打勾那条链路上的两种说明共用一座
  function mcSay(id, title, note) {
    if (document.getElementById(id)) return;
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'bc-modal-overlay';
    overlay.innerHTML = `
      <div class="bc-modal-card" role="dialog" aria-label="${title}">
        <div class="bc-modal-title">${title}</div>
        <div class="bc-modal-note">${note}</div>
        <div class="cts-sync-btn" data-say="close">OK</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    const close = () => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 240);
    };
    overlay.querySelector('[data-say]').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  }

  // 写服务端会失败（断网、掉登录、那条不在 Canvas 返回的列表里）。这时勾必须弹回去并且说清楚，
  // 因为本地那档是点下去就一定成的，用户分不清两种模式的差别
  function mcTickFailed(reason) {
    const code = /^put-\d+$/.test(String(reason)) || /^post-\d+$/.test(String(reason)) ? String(reason).split('-')[1] : '';
    const note = reason === 'not-applied'
      ? 'Canvas took the request but the task still reads the way it did, so nothing was marked.'
      : reason === 'gone' || reason === 'no-assignment-id'
        ? 'Canvas has not told us which task this tick belongs to. Press Sync now, then try again.'
        : code
          ? 'Canvas refused the change with code ' + code + '. The task is still marked the way it was.'
          : 'Canvas did not answer. The task is still marked the way it was.';
    mcSay('mc-tickfail-overlay', 'Could not save to Canvas', note);
  }

  // 只本地那一档点到 Canvas 自己标的完成：本地那颗 false 压不住它，那就别假装写本地，直接说清楚
  function mcTickOwnedByCanvas() {
    mcSay('mc-tickowned-overlay', 'Canvas marked this one',
      'Canvas counts this task as done because you submitted it, not from a tick here. With sync off we only change our own ticks, so this one stays as it is. Turn on Sync ticks to Canvas to mark it undone.');
  }

  // ===== 时间窗视图：Day / Week / Month / Custom，默认 Week =====
  const VIEW_LABELS = { day: 'Day', week: 'Week', month: 'Month', custom: 'Custom' };
  let bcViewMenuOpen = false;
  let bcViewOffset = 0; // 往前/往后翻了几个周期，刷新即回到当前周期
  const MC_LOOKBACK_DAYS = 14; // 主请求固定往回看的天数
  let bcViewBackfillKey = ''; // 上一次为时间窗补取过的那一段，没换过就不重复发请求
  let modernRefetchQueued = false; // 取数途中又换了窗口，等这一趟完事再补一趟

  // Dashboard View、时间窗（Week 等）和卡片自己的 ⋮ 菜单共用一个排他层级。
  // 只通过已经确认的 data-testid / 自家 class 认节点，不按颜色、尺寸或动态类名猜测。
  function closeExclusiveDashboardPanels() {
    if (bcViewMenuOpen) closeViewMenu();
    if (mcNewDashMenu) mcNewDashMenuClose();
    const dashTrigger = document.querySelector('[data-testid="dashboard-options-button"]');
    if (dashTrigger && dashTrigger.getAttribute('aria-expanded') === 'true') dashTrigger.click();
  }

  function startOfToday() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function currentViewMode() {
    const mode = localStorage.getItem('bc_view_mode') || 'week';
    return VIEW_LABELS[mode] ? mode : 'week';
  }

  // 一周的起点：Rolling 从昨天起（你定的默认），Sunday / Monday 取最近的那个星期几
  function weekAnchorStart() {
    const day = 86400000;
    const d0 = startOfToday();
    const ws = modernSetting('week_start');
    if (ws === 'rolling') return new Date(d0.getTime() - day);
    const target = ws === 'monday' ? 1 : 0;
    return new Date(d0.getTime() - ((d0.getDay() - target + 7) % 7) * day);
  }

  // Week 与 Month 都从“一周起点”算：Week 走 7 天，Month 走 30 天
  function viewWindow() {
    const mode = currentViewMode();
    const day = 86400000;
    const d0 = startOfToday();
    const anchor = weekAnchorStart();
    let win;
    if (mode === 'day') win = { from: d0, to: new Date(d0.getTime() + day) };
    else if (mode === 'month') win = { from: anchor, to: new Date(anchor.getTime() + 30 * day) };
    else if (mode === 'custom') {
      const from = localStorage.getItem('bc_view_from');
      const to = localStorage.getItem('bc_view_to');
      win = {
        from: from ? new Date(from + 'T00:00:00') : new Date(d0.getTime() - day),
        to: to ? new Date(new Date(to + 'T00:00:00').getTime() + day) : null
      };
    } else win = { from: anchor, to: new Date(anchor.getTime() + 7 * day) };

    if (bcViewOffset) {
      const step = viewPeriodDays(win) * bcViewOffset;
      win = { from: new Date(win.from.getTime() + step * day), to: win.to ? new Date(win.to.getTime() + step * day) : null };
    }
    return win;
  }

  // 一次翻页的跨度：Custom 按自己填的区间长度走，没填结束日就按一周
  function viewPeriodDays(win) {
    const mode = currentViewMode();
    if (mode === 'day') return 1;
    if (mode === 'month') return 30;
    if (mode === 'custom') return win.to ? Math.max(1, Math.round((win.to - win.from) / 86400000)) : 7;
    return 7;
  }

  // 翻页或自定义区间翻到主请求的回看窗口以前时，那一段数据根本没要过。
  // 这里给出需要补取的那一段（只覆盖窗口里落在 14 天以外的那部分，其余主请求已经有了）
  function viewBackfillRange(nowMs) {
    const day = 86400000;
    const mainStart = (nowMs || Date.now()) - MC_LOOKBACK_DAYS * day;
    const win = viewWindow();
    const from = win.from.getTime();
    if (isNaN(from) || from >= mainStart) return null;
    const to = win.to ? win.to.getTime() : from + viewPeriodDays(win) * day;
    const end = Math.max(from, Math.min(to, mainStart));
    return { from: new Date(from).toISOString(), to: new Date(end).toISOString() };
  }

  /* 时间窗挪到了没取过的区间就补一次数据；还在老区间里不动网络 */
  function refetchForViewWindow() {
    const range = viewBackfillRange();
    const key = range ? `${range.from}|${range.to}` : '';
    if (key === bcViewBackfillKey) return;
    fetchPlannerData();
  }

  const VIEW_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // 区间标签直接标右边界：Monday 档就是“周一 - 下周一”，Sunday 档就是“周日 - 下周日”
  function viewRangeLabel() {
    const win = viewWindow();
    const fmt = d => `${VIEW_MONTHS[d.getMonth()]} ${d.getDate()}`;
    if (currentViewMode() === 'day') return fmt(win.from);
    if (!win.to) return `${fmt(win.from)} -`;
    return `${fmt(win.from)} - ${fmt(win.to)}`;
  }

  // 过期没交的那一批不再走时间窗，它们由 MISSING 那一区自己置顶，所以这里只管还没到期的
  function inViewWindow(date) {
    const win = viewWindow();
    if (!date) return true;
    return date >= win.from && (!win.to || date < win.to);
  }

  function buildViewMenuHtml() {
    const mode = currentViewMode();
    const check = '<svg class="bc-view-check" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';
    const row = key => `
      <div class="bc-view-item${mode === key ? ' selected' : ''}" data-view="${key}">
        <span>${VIEW_LABELS[key]}</span>${mode === key ? check : ''}
      </div>`;
    const dates = mode === 'custom' ? `
        <div class="bc-view-dates">
          <input type="date" data-view-date="from" value="${mcEsc(localStorage.getItem('bc_view_from') || '')}">
          <span class="bc-view-to">to</span>
          <input type="date" data-view-date="to" value="${mcEsc(localStorage.getItem('bc_view_to') || '')}">
        </div>` : '';
    return `
      <div class="bc-view-menu">
        ${['day', 'week', 'month', 'custom'].map(row).join('')}${dates}
      </div>`;
  }

  // 菜单挂到 body 上用固定定位：侧栏祖先自带层叠上下文，菜单留在面板里就永远被外层元素压住
  let bcViewMenu = null, bcViewAnchor = null, bcViewPlacing = false, bcViewFollow = null;

  /* 锚点可能被面板重绘换掉（那颗按钮是我们自己画的），所以每次回来重新认一次 */
  function placeViewMenu() {
    bcViewPlacing = false;
    if (!bcViewMenu || !bcViewMenu.isConnected) return;
    if (!bcViewAnchor || !bcViewAnchor.isConnected) bcViewAnchor = document.querySelector('.bc-view-btn');
    if (!bcViewAnchor) return;
    const rect = bcViewAnchor.getBoundingClientRect();
    if (!rect.width) return;
    const w = bcViewMenu.offsetWidth, h = bcViewMenu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8)) + 'px';
    const top = (rect.bottom + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + 'px';
    if (bcViewMenu.style.left !== left) bcViewMenu.style.left = left;
    if (bcViewMenu.style.top !== top) bcViewMenu.style.top = top;
  }

  function queueViewPlace() {
    if (bcViewPlacing) return;
    bcViewPlacing = true;
    requestAnimationFrame(placeViewMenu);
  }

  function openViewMenu(anchor) {
    closeViewMenu();
    closeExclusiveDashboardPanels();
    const holder = document.createElement('div');
    holder.id = 'bc-view-portal';
    holder.innerHTML = buildViewMenuHtml();
    document.body.appendChild(holder);

    const menu = holder.firstElementChild;
    bcViewMenu = menu;
    bcViewAnchor = anchor;
    placeViewMenu();
    if (!bcViewFollow) {
      bcViewFollow = queueViewPlace;
      window.addEventListener('scroll', bcViewFollow, true);
      window.addEventListener('resize', bcViewFollow);
    }
    anchor.classList.add('open');
    bcViewMenuOpen = true;
    bindViewMenu(menu);
  }

  function closeViewMenu() {
    const holder = document.getElementById('bc-view-portal');
    if (holder) {
      // 先改名再播关闭动画：重开时新菜单也叫 bc-view-portal，别让 getElementById 摸到正在淡出的这份
      holder.id = 'bc-view-portal-closing';
      const menu = holder.firstElementChild;
      if (menu) menu.classList.add('closing');
      setTimeout(() => holder.remove(), 220);
    }
    /* 关闭那一趟先散掉跟随：正在淡出的这份不该再被挪，锚点也可能下一帧就没了 */
    if (bcViewFollow) {
      window.removeEventListener('scroll', bcViewFollow, true);
      window.removeEventListener('resize', bcViewFollow);
      bcViewFollow = null;
    }
    bcViewMenu = null;
    bcViewAnchor = null;
    document.querySelectorAll('.bc-view-btn.open').forEach(b => b.classList.remove('open'));
    bcViewMenuOpen = false;
  }

  function bindViewMenu(menu) {
    menu.querySelectorAll('.bc-view-item[data-view]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        localStorage.setItem('bc_view_mode', item.getAttribute('data-view'));
        bcViewOffset = 0;
        closeViewMenu();
        refetchForViewWindow();
        updatePanelDom();
      });
    });
    menu.querySelectorAll('input[data-view-date]').forEach(input => {
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('change', () => {
        localStorage.setItem('bc_view_' + input.getAttribute('data-view-date'), input.value);
        localStorage.setItem('bc_view_mode', 'custom');
        bcViewOffset = 0;
        // 先发起再重绘（面板上那一格和区间标签都跟着变），再把菜单重新挂到新的那颗按钮下面
        refetchForViewWindow();
        updatePanelDom();
        const anchor = document.querySelector('.bc-view-btn');
        if (anchor) openViewMenu(anchor);
      });
    });
  }

  // ===== Canvas 原生「Dashboard Options」弹层（三点按钮那个）=====
  // 那个菜单节点归 React，我们只做三件事：认得出它、往里补那几行快捷开关、给它补关闭动画。

  function modernDashMenu() {
    const item = document.querySelector('[data-testid="card-view-menu-item"]');
    const menu = item && item.closest('div[role="menu"]');
    if (menu) {
      menu.classList.add('mc-dash-options-menu');
      const popover = item.closest('span[data-position-content], span[class*="contextView"]');
      if (popover) popover.classList.add('mc-dash-options-popover');
    }
    return menu;
  }

  // 行结构照 InstUI 自己那套搭（[BCP69] 实测：span[data-cid="MenuItem"] > 一层 span >
  // 图标槽 span + 文字 span，图标槽在未选中行里是空 span 而不是没有），
  // 上面 style.css 里那 170 行「172px 卡 / hover 药丸 / 勾靠右 / 字体」的规则就全部自动吃到，
  // 不用再写第二套。唯一它们没有的是「右侧显示当前值」，那条单独补。
  function mcDashMenuRowHtml(label, opts) {
    const check = opts.checked
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>' : '';
    const value = opts.value ? '<span class="mc-dash-menu-value">' + opts.value + '</span>' : '';
    const toggle = opts.checked !== undefined;
    // data-bcx-menu 是这一行点下去该动哪一档的身份：以前靠"有没有右侧值"分两档够用
    // （只有 Card Layout 带值），四行两种形状混在一起就分不出了
    return '<span data-cid="MenuItem" role="' + (toggle ? 'menuitemcheckbox' : 'menuitem') + '"'
      + (toggle ? ' aria-checked="' + (opts.checked ? 'true' : 'false') + '"' : '')
      + ' data-bcx-menu="' + opts.key + '"'
      + ' class="mc-dash-menu-row' + (opts.value ? ' mc-dash-menu-has-value' : '') + '">'
      + '<span><span>' + check + '</span><span>' + label + '</span>' + value + '</span></span>';
  }

  function mcDashMenuState() {
    return {
      layout: modernSetting('card_layout'),
      grades: localStorage.getItem('mc_dash_grades') === '1',
      // 这一块默认是开的（设置里那颗 defOn），所以只有存过 '0' 才算关
      tasks: localStorage.getItem('mc_dash_tasks') !== '0',
      taskLimit: modernSetting('card_task_limit')
    };
  }

  /* ==================== 课程卡那三行文字 ====================
     三行都是 Canvas 自己画的：.ic-DashboardCard__header-title 是 course.name（学生设过昵称时
     Canvas 把昵称放进同一格），-subtitle 是 course_code，-term 是报名学期。这一节只做两件事：
     按设置藏掉其中几行（至少留一行），和把某一行换成学生自己写的字。
     换字只动这一行里第一个有字的文本节点，不整块 textContent 一盖：标题那层里面还套着链接和
     一层带课程色的 span，盖下去链接和颜色一起没了。 */
  const MC_CARD_TEXT_KEY = 'mc_card_text_v1';
  const MC_CARD_NAME_SYNC_KEY = 'mc_card_name_sync';
  const MC_CARD_LINES = {
    name: { key: 'mc_card_show_name', cls: 'ic-DashboardCard__header-title' },
    code: { key: 'mc_card_show_code', cls: 'ic-DashboardCard__header-subtitle' },
    term: { key: 'mc_card_show_term', cls: 'ic-DashboardCard__header-term' }
  };
  // Canvas 的昵称控制器第一句就是 params[:nickname].length >= 60 → 400，写得进去的最长 59
  const MC_CARD_NAME_MAX = 59;
  const MC_CARD_LINE_MAX = 60;
  /* 这一行原本写的什么，只有节点自己知道。React 换掉节点时这张表跟着多一条新记录，
     所以"撤掉自定义"回到的永远是 Canvas 此刻真画出来的那句，不是我们第一次看见的那句 */
  const mcCardOrig = new WeakMap();

  function mcCardTextMap() {
    try {
      const m = JSON.parse(localStorage.getItem(MC_CARD_TEXT_KEY) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch (e) { return {}; }
  }

  /* 这门课叫什么，只有 Course info 那一屏说了算：侧栏、课程卡读的都是同一格。
     没自定义过就退回 Canvas 那句 */
  function mcCourseName(id, fallback) {
    const rec = mcCardTextMap()[String(id)];
    const v = rec && String(rec.name || '').trim();
    return v || String(fallback || '');
  }

  function mcCardLineOn(field) {
    const meta = MC_CARD_LINES[field];
    // 三颗都是 defOn：没存过＝开，只有存过 '0' 才算关
    return !!meta && localStorage.getItem(meta.key) !== '0';
  }

  // 还亮着的那几行。设置里靠这一句挡住"把最后一行也关掉"
  function mcCardLinesLeft() {
    return Object.keys(MC_CARD_LINES).filter(mcCardLineOn);
  }

  function mcCardLinesApply() {
    const root = document.documentElement;
    root.classList.toggle('mc-card-hide-name', !mcCardLineOn('name'));
    root.classList.toggle('mc-card-hide-code', !mcCardLineOn('code'));
    root.classList.toggle('mc-card-hide-term', !mcCardLineOn('term'));
  }

  function mcCardIdOf(card) {
    if (!card) return '';
    const link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
    return ((link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/) || [])[1])
      || ((card.getAttribute('data-testid') || '').match(/course-grade-card-(\d+)/) || [])[1] || '';
  }

  /* 把一行写成 want（空串＝交回 Canvas 自己的那句）。
     这一趟每 300 毫秒跑一遍，所以每一处写之前先比一次：值没变就一个字节都不动，
     不然我们自己的写入会把变动观察器一直点着。 */
  function mcSetLineText(node, want) {
    if (!node) return;
    let tn = null;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    for (let cur = walker.nextNode(); cur; cur = walker.nextNode()) {
      if (cur.nodeValue && cur.nodeValue.trim()) { tn = cur; break; }
    }
    if (!tn) {
      // Canvas 这一行本来就是空的（比如这门课没有代码），只有要写字时才动它
      if (!want) return;
      if (!mcCardOrig.has(node)) mcCardOrig.set(node, '');
      if (node.textContent !== want) node.textContent = want;
      return;
    }
    const owner = tn.parentNode;
    if (!mcCardOrig.has(owner)) mcCardOrig.set(owner, tn.nodeValue);
    const out = want || mcCardOrig.get(owner);
    if (tn.nodeValue !== out) tn.nodeValue = out;
    // Canvas 给副标题和学期那两行挂了 title 做省略提示，字换了提示不能还是旧的
    for (const el of [node, owner]) {
      if (el.nodeType === 1 && el.hasAttribute('title') && el.getAttribute('title') !== out) {
        el.setAttribute('title', out);
      }
    }
  }

  function mcCardTextApply() {
    mcCardLinesApply();
    const cards = document.querySelectorAll('.ic-DashboardCard, [data-testid^="course-grade-card"]');
    if (!cards.length) return;
    const map = mcCardTextMap();
    for (const card of cards) {
      const id = mcCardIdOf(card);
      const rec = (id && map[id]) || {};
      /* 这门课那一档颜色钉在卡片自己身上：卡上那行课程主标题读的就是它
         （style.css 的 .ic-DashboardCard__header-title，和设置里 Course title colour 那颗开关同一通路）。
         认不出课程号的卡不写，让它留着吃链接色那一档。
         值真的变了才写：这一趟 300 毫秒跑一遍，空写会把变动观察器一直点着 */
      const color = id ? getCourseColor(id, '') : '';
      if (color && card.style.getPropertyValue('--course-color') !== color) {
        card.style.setProperty('--course-color', color);
      }
      const nodes = {};
      for (const field of MC_CARD_ORDER) {
        const line = card.querySelector('.' + MC_CARD_LINES[field].cls);
        nodes[field] = line;
        if (line) mcSetLineText(line, String(rec[field] || '').trim());
      }
      mcCardPromote(card, nodes);
    }
  }

  /* 三行是一套字级，不是三个各管各的开关：藏掉上面那一档，下面那行不只挪上来一格，
     字号那一串要跟着顶上来（主标题没了，副标题就按主标题那一档排，学期按副标题那一档排）。
     这里一个数都不写死，而是把"本该占那一格的那一行"自己的计算值抄过来，
     所以主题给这三行定的大小行高字重全部自动跟，换主题不用回来改这段。
     颜色故意不抄：主题里那三条颜色规则是按"这一行是课名／这一行是代码"写的，
     连颜色一起搬就把他没点名的东西也改了。
     抄的是行内样式，所以必须带 important：BC 那张表里给文字档位写的就是 !important。 */
  const MC_CARD_ORDER = ['name', 'code', 'term'];
  const MC_CARD_TIER_PROPS = ['font-size', 'line-height', 'font-weight', 'letter-spacing', 'text-transform', 'margin-top'];

  function mcCardPromote(card, nodes) {
    // 这一屏里没有的那一行不算一格（有的课压根没有学期那行），否则会把字级错搬一格
    const slots = MC_CARD_ORDER.filter(f => nodes[f]);
    const shown = slots.filter(mcCardLineOn);
    const moved = shown.filter((f, i) => slots[i] !== f);
    const pattern = slots.map(f => (mcCardLineOn(f) ? '1' : '0')).join('');
    /* 档位没翻过就一个字节都不动。但 React 换掉子节点时卡片自己那颗 dataset 还在，
       那一档抄来的行内样式却没了，所以还要确认搬过的那几行身上还带着我们写的字号 */
    if (card.dataset.mcTier === pattern
      && moved.every(f => nodes[f].style.getPropertyValue('font-size'))) return;
    card.dataset.mcTier = pattern;
    // 先把我们自己盖上去的摘干净再读：不摘的话这一遍读到的是上一遍抄来的值，越抄越歪。
    // 只摘真写了的那几条，别给没动过的节点凭空留一颗空 style 属性
    slots.forEach(f => MC_CARD_TIER_PROPS.forEach(k => {
      if (nodes[f].style.getPropertyValue(k)) nodes[f].style.removeProperty(k);
    }));
    const src = {};
    slots.forEach(f => {
      const cs = window.getComputedStyle(nodes[f]);
      src[f] = {};
      MC_CARD_TIER_PROPS.forEach(k => { src[f][k] = cs.getPropertyValue(k); });
    });
    shown.forEach((f, i) => {
      const slot = slots[i];
      if (slot === f || !src[slot]) return;
      MC_CARD_TIER_PROPS.forEach(k => {
        const v = src[slot][k];
        if (v) nodes[f].style.setProperty(k, v, 'important');
      });
    });
  }

  function mcCardTextSet(id, field, value) {
    if (!id || !MC_CARD_LINES[field]) return mcCardTextMap();
    const map = mcCardTextMap();
    const rec = map[String(id)] || {};
    const v = String(value || '').trim().slice(0, field === 'name' ? MC_CARD_NAME_MAX : MC_CARD_LINE_MAX);
    if (v) rec[field] = v; else delete rec[field];
    if (Object.keys(rec).length) map[String(id)] = rec; else delete map[String(id)];
    localStorage.setItem(MC_CARD_TEXT_KEY, JSON.stringify(map));
    return map;
  }

  function mcCardTextClearAll() {
    localStorage.removeItem(MC_CARD_TEXT_KEY);
    return true;
  }

  function mcCardNameSyncOn() {
    return localStorage.getItem(MC_CARD_NAME_SYNC_KEY) === '1';
  }

  let mcCardCourseList = null;
  let mcCardCourseLoading = false;

  /* Course info 那一屏要三样都有：name 认课，code 和 term 拿来当输入框的占位句，
     让他看得见"不填的话屏幕上是什么"。include[]=term 才回学期 */
  function mcCardCoursesLoad() {
    if (mcCardCourseList || mcCardCourseLoading) return;
    mcCardCourseLoading = true;
    fetch('/api/v1/courses?enrollment_state=active&include[]=term&per_page=100', { credentials: 'same-origin' })
      .then(r => {
        // 读不到就当没读到，别把 403 洗成"你没有在上的课"：那一句话会把他支去查错的地方
        if (!r.ok) throw new Error('courses-' + r.status);
        return r.json();
      })
      .then(raw => {
        mcCardCourseList = (raw || []).map(c => ({
          id: String(c.id),
          name: c.name || c.course_code || ('Course ' + c.id),
          code: c.course_code || '',
          term: (c.term && c.term.name) || ''
        })).sort((a, b) => a.name.localeCompare(b.name));
        mcCardCourseLoading = false;
      })
      .catch(() => { mcCardCourseLoading = false; });
  }

  function mcCardCourseRows() {
    if (!mcCardCourseList) { mcCardCoursesLoad(); return { loading: true, rows: [] }; }
    const map = mcCardTextMap();
    return {
      loading: false,
      rows: mcCardCourseList.map(c => ({
        id: c.id, name: c.name, code: c.code, term: c.term,
        over: map[c.id] || {},
        max: { name: MC_CARD_NAME_MAX, code: MC_CARD_LINE_MAX, term: MC_CARD_LINE_MAX }
      }))
    };
  }

  /* 写昵称：参数只能放查询串（和 planner override 那条同一件事，这一版 Canvas 不读 body），
     撤销是 DELETE。写完必须按 id 回读一次：200 不等于值真的变了。 */
  function mcNicknameWrite(id, name) {
    const token = mcCsrfToken();
    if (!token) return Promise.resolve({ ok: false, error: 'no-csrf' });
    const headers = { 'X-CSRF-Token': token };
    const base = '/api/v1/users/self/course_nicknames/' + encodeURIComponent(id);
    const url = name ? base + '?' + mcForm({ nickname: name }) : base;
    return fetch(url, { method: name ? 'PUT' : 'DELETE', credentials: 'same-origin', headers })
      .then(res => {
        if (!res.ok) throw new Error((name ? 'put-' : 'delete-') + res.status);
        return fetch('/api/v1/courses/' + encodeURIComponent(id), { credentials: 'same-origin' });
      })
      .then(r => (r.ok ? r.json() : null))
      .then(c => {
        const server = c && c.name ? String(c.name) : '';
        const want = name || '';
        // 没设昵称时 Canvas 回的 name 本来就是课程全名，所以清空那一路只能报"读回来是什么"
        return { ok: name ? server === want : true, server: server };
      })
      .catch(err => ({ ok: false, error: err.message }));
  }

  // 开这一档＝把已经写下的自定义名字整批送一次；关只是以后不再送，Canvas 已经改掉的留着
  function mcNicknameSyncAll() {
    const map = mcCardTextMap();
    const ids = Object.keys(map).filter(id => map[id] && map[id].name);
    return ids.reduce((chain, id) => chain.then(out => mcNicknameWrite(id, map[id].name).then(r => {
      out.push({ id: id, ok: r.ok, error: r.error || '' });
      return out;
    })), Promise.resolve([])).then(list => list);
  }

  /* Dashboard 卡片 ⋮ > Color 的 Nickname 是 Canvas 原生控件：点 Apply 时 Canvas 会把这一次
     的值直接写到服务器。扩展用户则以 Course info 的本地名字作为日常显示的唯一来源；若不把
     这次修改也存进去，刷新后卡片/侧栏又会显示旧的本地名字。
     只在这颗原生 Apply 上补本地存储，不调用 mcNicknameSyncAll：无论「Send custom names to
     Canvas」是否开启，都只让 Canvas 原生流程同步这一次，不会顺带发送其它课程的名字。 */
  function mcSaveDashboardNickname(apply) {
    const popover = apply.closest('span[data-position-content]');
    if (!popover) return;
    const nickname = popover.querySelector('#NicknameInput');
    const colorInput = popover.querySelector('[id^="ColorPickerCustomInput-course_"]');
    if (!nickname || !colorInput) return;
    const match = String(colorInput.id).match(/^ColorPickerCustomInput-course_(.+)$/);
    if (!match || !match[1]) return;
    mcCardTextSet(match[1], 'name', nickname.value);
    mcStep('mcCardTextApply', () => mcCardTextApply());
  }

  // capture 阶段先记下输入值；随后不拦 Canvas 自己的 click handler，因此它仍负责本次服务器同步。
  document.addEventListener('click', (event) => {
    const node = event.target instanceof Element ? event.target.closest('#ColorPicker__Apply') : null;
    if (node) mcSaveDashboardNickname(node);
  }, true);

  function mcDashMenuRowsHtml(noSeparator) {
    const s = mcDashMenuState();
    return (noSeparator ? '' : '<div data-cid="MenuItemSeparator"></div>')
      + mcDashMenuRowHtml('Card Layout', { key: 'layout', value: MODERN_SETTINGS.card_layout.text[s.layout] })
      + mcDashMenuRowHtml('Show card grades', { key: 'grades', checked: s.grades })
      + mcDashMenuRowHtml('Show card tasks', { key: 'tasks', checked: s.tasks })
      + mcDashMenuRowHtml('Tasks per card', { key: 'limit', value: CARD_TASK_LIMIT.text[s.taskLimit] })
      + mcDashMenuRowHtml('Edit course info', { key: 'courseinfo' })
      + mcDashMenuRowHtml('Widget Settings', { key: 'widgets' });
  }

  // ==================== Dashboard View 菜单的快捷设置（独立监听）====================
  // 原来挂 mcStep 上的那一套太慢：那两行要等 mcUiPass 的合并计时器（300 毫秒，
  // 载入头 20 秒还要等 500 毫秒那一趟），实测点击 +61 毫秒菜单就齐了，+620 毫秒我们才补上。
  //
  // 上一版盯的是三点按钮的子树，实测（[BCP80] 打点）根本不命中：浮层归 React，
  // 它点开时直接往 body 挂一个 span，父链是
  // DIV.css-161w609-menu ← SPAN.css-12mcade ← …contextView__content ← …contextView ← SPAN ← BODY，
  // 按钮那颗节点里没有它。关闭时菜单整块从 DOM 消失（role="menu" 计数 0），
  // 所以每次打开都会新增一个 body 的直接子节点，盯这一层就能每开必中。
  // 菜单和它的原生条目在同一批变动里一起到位，不需要等条目二次填充。
  let mcDashMenuObserver = null;
  function mcDashMenuSetupObserver() {
    if (mcDashMenuObserver) return;
    mcDashMenuObserver = new MutationObserver((mutations) => {
      for (const mo of mutations) {
        for (const node of mo.addedNodes) {
          if (node.nodeType !== 1) continue;
          const item = node.querySelector ? node.querySelector('[data-testid="card-view-menu-item"]') : null;
          if (item) {
            const menu = item.closest('div[role="menu"]');
            if (menu) menu.classList.add('mc-dash-options-menu');
            const popover = item.closest('span[data-position-content], span[class*="contextView"]');
            if (popover) popover.classList.add('mc-dash-options-popover');
            mcDashMenuRows();
            return;
          }
          mcCardMenuInject(node);
        }
      }
    });
    mcDashMenuObserver.observe(document.body, { childList: true });
  }
  // 页面加载时就启动观察器
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mcDashMenuSetupObserver);
  } else {
    mcDashMenuSetupObserver();
  }

  /* ==================== 卡片自己那座 ⋮ 菜单里补一行 ====================
     上面那座菜单管的是整屏视图，这张卡的菜单开的是"这一门课"的改颜色／昵称／挪位置。
     它不针对任何一门课的信息，所以补进去的那一行必须知道刚点的是哪张卡：捕获阶段先听那颗
     按钮，把课程 id 记下来，菜单在同一批变动里冒出来时拿它认身份。
     判据故意不看菜单里写着什么字（那几条是 Canvas 自己的文案，会随版本换），
     只认"刚点过某张卡的那颗按钮 ＋ 此刻冒出来一座 body 级菜单"。记不到 id 就一行都不补 */
  let mcCardMenuId = '';
  let mcCardMenuAt = 0;

  document.addEventListener('pointerdown', (e) => {
    const exclusiveTrigger = e.target && e.target.closest
      ? e.target.closest('[data-testid="dashboard-options-button"], #bc-new-dash-options, .ic-DashboardCard__header-button')
      : null;
    if (exclusiveTrigger) {
      const isCanvasDashboardTrigger = exclusiveTrigger.matches('[data-testid="dashboard-options-button"]');
      if (isCanvasDashboardTrigger) {
        if (bcViewMenuOpen) closeViewMenu();
        if (mcNewDashMenu) mcNewDashMenuClose();
      } else {
        closeExclusiveDashboardPanels();
      }
    }
    const btn = e.target && e.target.closest ? e.target.closest('.ic-DashboardCard__header-button') : null;
    if (!btn) return;
    mcCardMenuId = mcCardIdOf(btn.closest('.ic-DashboardCard'));
    mcCardMenuAt = Date.now();
    /* 观察器只盯 body 的直接子节点（整棵子树都盯代价太大，实测那种写法一次变动要重算半秒）。
       这座菜单要是没被搬到 body 上、而是就地长在卡片里，那一趟就看不见它，所以点完自己找两次。
       两枪都在 1.5 秒那条窗口里，找不到的话就当这一屏没有这一行，不会认错人 */
    setTimeout(mcCardMenuFind, 60);
    setTimeout(mcCardMenuFind, 400);
  }, true);

  function mcCardMenuFind() {
    if (!mcCardMenuId || Date.now() - mcCardMenuAt > 1500) return;
    for (const menu of document.querySelectorAll('div[role="menu"]')) mcCardMenuInject(menu);
  }

  function mcCardMenuInject(added) {
    if (!mcCardMenuId || Date.now() - mcCardMenuAt > 1500) return;
    const menu = (added.matches && added.matches('div[role="menu"]')) ? added
      : (added.querySelector ? added.querySelector('div[role="menu"]') : null);
    if (!menu || menu.classList.contains('mc-dash-options-menu')) return;
    if (menu.querySelector('.mc-card-menu-row')) return;
    const id = mcCardMenuId;
    const holder = document.createElement('div');
    holder.innerHTML = mcDashMenuRowHtml('Edit course info', { key: 'cardtext' });
    const row = holder.firstElementChild;
    if (!row) return;
    row.classList.add('mc-card-menu-row');
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('mc-open-course-info', { detail: { course: id } }));
    });
    menu.appendChild(row);
  }

  function mcDashMenuRows() {
    const menu = modernDashMenu();
    // 已经补过就直接返回（上面观察者会先清空旧的）
    if (!menu || menu.querySelector('.mc-dash-menu-row')) return;
    // Canvas 原生菜单的项可能在 span 里也可能在 div 里，用文本内容识别最稳
    const visibleTexts = [...menu.querySelectorAll('span, div, a, button')]
      .map(el => el.textContent.trim()).filter(Boolean);
    const hasCanvasItems = ['Card View', 'List View'].some(name => visibleTexts.includes(name));
    if (!hasCanvasItems) return; // Canvas 原生菜单还没渲染完，跳过
    const holder = document.createElement('div');
    holder.innerHTML = mcDashMenuRowsHtml();
    while (holder.firstChild) menu.appendChild(holder.firstChild);
    // 绑定标记打在菜单上（同前）
    if (!menu.dataset.mcMenuBound) {
      menu.dataset.mcMenuBound = '1';
      menu.addEventListener('click', mcDashMenuClick);
    }
  }

  // mcStep('mcDashMenuRows', () => mcDashMenuRows()); // 不再走这一套

  function mcDashMenuClick(e) {
    const row = e.target.closest ? e.target.closest('.mc-dash-menu-row') : null;
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = row.getAttribute('data-bcx-menu');
    let keepOpen = false;
    if (kind === 'limit') {
      /* 条数一共八档，点一下就关菜单＝从 3 调到 8 要开合六次。这一行点完就地改右边那颗数字、
         菜单留着，接着点就是往下走一档，到 8 回到 1。别的行仍然点完就关（和选 Card View 同一行为） */
      const opts = CARD_TASK_LIMIT.options;
      const next = opts[(opts.indexOf(modernSetting('card_task_limit')) + 1) % opts.length];
      localStorage.setItem('bc_card_task_limit', next);
      const val = row.querySelector('.mc-dash-menu-value');
      if (val) val.textContent = CARD_TASK_LIMIT.text[next];
      // 必须走完整那一趟：mcMasonryLayout 里面那颗是 quick 档，卡上已经有列表时它会跳过重建，
      // 换了条数却量不到新列表＝屏上还是旧的那几条
      mcCardTasks();
      mcMasonryLayout();
      syncSettingsModalSelect('card_task_limit');
      keepOpen = true;
    } else if (kind === 'tasks') {
      const on = localStorage.getItem('mc_dash_tasks') === '0';
      localStorage.setItem('mc_dash_tasks', on ? '1' : '0');
      // 这颗类名同时管我们那块上不上屏、和 BetterCampus 补在同一处的那段 Due 让不让位，
      // 两样都在 mcCardTasks 开头挂；排格子排在它后面，量到的才是换完的高度
      mcCardTasks();
      mcMasonryLayout();
      syncSettingsModalCheck('mc_dash_tasks', on);
    } else if (kind === 'layout') {
      const next = modernSetting('card_layout') === 'masonry' ? 'rows' : 'masonry';
      localStorage.setItem('bc_card_layout', next);
      applyLogoSettings();
      mcMasonryLayout();
      syncSettingsModalSelect('card_layout');
    } else if (kind === 'courseinfo') {
      // 这一颗不动任何档位，只是把设置开到 Course info 那一屏；菜单照别的行一样当场关
      document.dispatchEvent(new CustomEvent('mc-open-course-info'));
    } else if (kind === 'widgets') {
      document.dispatchEvent(new CustomEvent('mc-open-widget-settings'));
    } else {
      // 默认不显示：只有存过 '1' 才算开（新装的人这一格是空的＝关）
      const on = localStorage.getItem('mc_dash_grades') !== '1';
      localStorage.setItem('mc_dash_grades', on ? '1' : '0');
      /* 他在这一行点的其实是"这一格我要自己管"，所以顺手把归谁翻到 Modern Canvas（他报的第一条 bug：
         归 BetterCampus 时点这一行只会挪我们那颗，页面上换画的还是它的数字）。
         touched 那颗键记下"这是他自己拧的"，以后每次加载第一轮都不替他改。
         会话基线也顺手对齐成它现在的状态，免得下一轮把它当成刚翻的一格 */
      localStorage.setItem('mc_dash_grade_touched', '1');
      bcGradesSeen = document.querySelector('a.bettercampus-card-grade') ||
                     document.querySelector('.bc-new-dash-grade-pill') ? '1' : '0';
      localStorage.setItem('bc_dash_grade_owner', 'ours');
      applyLogoSettings();
      modernGradePills();
      syncSettingsModalCheck('mc_dash_grades', on);
      syncSettingsModalSelect('dash_grade_owner');
    }
    // 点完就地关：和选 Card View 那几行同一个行为（Tasks per card 那一行除外，见上面）
    if (keepOpen) return;
    if (mcNewDashMenu && mcNewDashMenu.contains(row)) { mcNewDashMenuClose(); return; }
    const trig = document.querySelector('[data-testid="dashboard-options-button"]');
    if (trig) trig.click();
  }

  // ==================== 新版 Dashboard 右上角那颗 ⋮ ====================
  // 上面那两行是塞进 Canvas 原生那颗 [data-testid="dashboard-options-button"] 的菜单里的，
  // 而新版这一屏那颗根本不存在（[实测 2026-10-07 ndm] 整页 0 命中）。卡右上角那颗是
  // button.ic-DashboardCard__header-button（图标是字体 i.icon-more、36x36、圆的一圈），
  // 点开的是"改这门课的颜色／昵称／挪位置"，跟视图设置无关，塞不进去。
  // 所以右上角自己造一颗，只摆我们那四行快捷开关（Card Layout / Show card grades /
  // Show card tasks / Tasks per card），行为、存档键、和设置弹窗的同步全部走上面同一套函数。
  // 两座菜单用的是同一个 mcDashMenuRowsHtml，所以加一行两边一起有，不会出现"旧版有新版没有"
  const BCX_NEW_DASH_OPTIONS_ID = 'mc-new-dash-options-btn';
  let mcNewDashMenu = null;

  function mcNewDashOptionsBtn() {
    const anchor = document.querySelector('[data-testid="customize-dashboard-button"]');
    if (!anchor) return;
    // 右上角那一排是 InstUI 的 flex 行（实测 gap 12px、两颗各包在一层 -view-flexItem 里）。
    // 只认组件名后缀 -view--flex-flex，不认那串哈希前缀，它会随构建换
    const row = anchor.closest('span[class*="-view--flex-flex"]');
    if (!row) return;
    const mine = document.getElementById(BCX_NEW_DASH_OPTIONS_ID);
    if (mine) {
      // React 重排可能把我们那颗挤到别处，只保证它仍在这一排的最后一颗之后
      if (mine.parentElement !== row) row.appendChild(mine);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BCX_NEW_DASH_OPTIONS_ID;
    btn.className = 'mc-new-dash-options-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<circle cx="12" cy="5" r="2"></circle>'
      + '<circle cx="12" cy="12" r="2"></circle>'
      + '<circle cx="12" cy="19" r="2"></circle></svg>'
      + '<span class="screenreader-only">Dashboard view options</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (mcNewDashMenu) mcNewDashMenuClose();
      else mcNewDashMenuOpen(btn);
    });
    row.appendChild(btn);
  }

  function mcNewDashMenuOpen(btn) {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.className = 'mc-dash-options-menu mc-new-dash-options-menu';
    // 第一行上面那条分隔线是拿来跟 Canvas 原生那几条隔开的，我们这一座没有别的条目，不要
    menu.innerHTML = mcDashMenuRowsHtml(true);
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.round(r.right - (menu.offsetWidth || 172))) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    mcNewDashMenu = menu;
    btn.setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', mcDashMenuClick);
    // 这一颗自己的 click 已经冒到 document 了，监听器放到下一帧再挂，否则当场把自己关掉
    setTimeout(() => {
      document.addEventListener('click', mcNewDashMenuAway, true);
      document.addEventListener('keydown', mcNewDashMenuKey, true);
      window.addEventListener('scroll', mcNewDashMenuClose, true);
    }, 0);
  }

  function mcNewDashMenuAway(e) {
    if (!mcNewDashMenu) return;
    if (mcNewDashMenu.contains(e.target)) return;
    const btn = document.getElementById(BCX_NEW_DASH_OPTIONS_ID);
    if (btn && btn.contains(e.target)) return;
    mcNewDashMenuClose();
  }

  function mcNewDashMenuKey(e) {
    if (e.key === 'Escape') mcNewDashMenuClose();
  }

  function mcNewDashMenuClose() {
    if (mcNewDashMenu) {
      mcNewDashMenu.remove();
      mcNewDashMenu = null;
    }
    document.removeEventListener('click', mcNewDashMenuAway, true);
    document.removeEventListener('keydown', mcNewDashMenuKey, true);
    window.removeEventListener('scroll', mcNewDashMenuClose, true);
    const btn = document.getElementById(BCX_NEW_DASH_OPTIONS_ID);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // 菜单里改了值，设置弹窗（如果开着）那行显示要跟着改，否则两边说法不一致
  function syncSettingsModalSelect(key) {
    const sel = document.querySelector('.cts-select[data-select="' + key + '"]');
    if (!sel) return;
    // 读 ctsMeta 不读 MODERN_SETTINGS：card_task_limit 那一档不在 MODERN_SETTINGS 里
    // （它不驱动类名，那边每一份都会被 applyLogoSettings 拿去挂类名），照旧写法这一行会抛
    sel.querySelector('.cts-select-value').textContent = ctsMeta(key).text[modernSetting(key)];
    sel.querySelector('.cts-menu').innerHTML = ctsMenuHtml(key);
  }

  function syncSettingsModalCheck(key, on) {
    const input = document.querySelector('.cts-row input[data-setting="' + key + '"]');
    if (input) input.checked = on;
  }

  // 关闭动画：真节点是 React 拆的，CSS 抓不到「正在消失」，只能在它确实没了之后补一份影子播淡出。
  // 播之前必须确认它不在了：没关成的那次点击（比如点在标题行上）要是也补一份，就和真菜单叠成重影。
  // 逐帧盯而不是每 16ms 一轮：轮询最坏要等四轮才反应过来，看着就是「先没了、又冒出来、再淡掉」。
  let mcDashGhostMenu = null;
  function ghostCanvasMenuClose() {
    const trig = document.querySelector('[data-testid="dashboard-options-button"]');
    if (!trig || trig.getAttribute('aria-expanded') !== 'true') return;
    const menu = modernDashMenu();
    if (!menu || menu === mcDashGhostMenu) return;
    mcDashGhostMenu = menu;
    const rect = menu.getBoundingClientRect();
    let frames = 0;
    const check = () => {
      // 已经不是这一轮了（别的一次点击接管了它）就到此为止，不去动别人的状态
      if (mcDashGhostMenu !== menu) return;
      if (menu.isConnected) {
        if (++frames >= 10) mcDashGhostMenu = null;
        else requestAnimationFrame(check);
        return;
      }
      mcDashGhostMenu = null;
      const ghost = menu.cloneNode(true);
      ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('bc-ghost-out');
      ghost.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' +
        rect.width + 'px;margin:0;z-index:99999;pointer-events:none;';
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 200);
    };
    requestAnimationFrame(check);
  }
  document.addEventListener('pointerdown', ghostCanvasMenuClose, true);
  // 我们自己那两行是程序化 trig.click() 关的，没有 pointerdown，所以 click 上也要盯一份
  document.addEventListener('click', ghostCanvasMenuClose, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ghostCanvasMenuClose(); }, true);

  // 讨论话题页每条回复右上角的三点菜单：只在该页锁和展开态触发按钮都命中时补关闭影子。
  // 动画挂在菜单本体，定位留给它外面的 ContextView 壳；点标题未真正关闭时不会留下影子。
  let mcDiscMenuClosePending = null;
  function ghostDiscussionMenuClose() {
    if (!document.documentElement.classList.contains('mc-disc-topic-plate')) return;
    const trigger = Array.from(document.querySelectorAll('[data-testid="thread-actions-menu"][aria-expanded="true"]'))
      .find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    if (!trigger) return;
    const menu = document.querySelector('html.mc-disc-topic-plate [role="menu"][data-cid="Menu"]');
    if (!menu || (mcDiscMenuClosePending && mcDiscMenuClosePending.menu === menu)) return;

    const shell = menu.closest('.mc-menu-shell') || menu;
    const rect = shell.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const ghost = shell.cloneNode(true);
    const ghostMenu = ghost.matches('[role="menu"][data-cid="Menu"]')
      ? ghost
      : ghost.querySelector('[role="menu"][data-cid="Menu"]');
    if (!ghostMenu) return;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('mc-disc-menu-ghost');

    const pending = { menu, ghost };
    mcDiscMenuClosePending = pending;
    let frames = 0;
    const check = () => {
      if (mcDiscMenuClosePending !== pending) return;
      if (menu.isConnected) {
        if (++frames >= 12) mcDiscMenuClosePending = null;
        else requestAnimationFrame(check);
        return;
      }
      mcDiscMenuClosePending = null;
      if (!document.documentElement.classList.contains('mc-disc-topic-plate')) return;
      if (document.querySelector('[data-testid="thread-actions-menu"][aria-expanded="true"]')) return;

      ghost.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' +
        rect.width + 'px;height:' + rect.height + 'px;margin:0;z-index:99999;pointer-events:none;transform:none;';
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 240);
    };
    requestAnimationFrame(check);
  }
  document.addEventListener('pointerdown', ghostDiscussionMenuClose, true);
  document.addEventListener('click', ghostDiscussionMenuClose, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ghostDiscussionMenuClose(); }, true);

  // Dashboard 卡片 Color / Move 菜单：凭稳定的 Tabs + ColorPicker 结构定位，
  // 只对这座卡片菜单做关闭影子；动画放在 contextView__content，外壳的定位矩阵不动。
  let mcDashCardMenuClosePending = null;
  function dashCardMenuPopover() {
    for (const popover of document.querySelectorAll('span[data-position-content]:has([data-cid="Tabs"])')) {
      if (popover.querySelector('.DashboardCardMenu__ColorPicker')) return popover;
    }
    return null;
  }
  function ghostDashCardMenuClose() {
    const popover = dashCardMenuPopover();
    if (!popover || (mcDashCardMenuClosePending && mcDashCardMenuClosePending.popover === popover)) return;
    const rect = popover.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const ghost = popover.cloneNode(true);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('mc-dash-card-menu-ghost');

    const pending = { popover, ghost };
    mcDashCardMenuClosePending = pending;
    let frames = 0;
    const check = () => {
      if (mcDashCardMenuClosePending !== pending) return;
      if (popover.isConnected) {
        if (++frames >= 12) mcDashCardMenuClosePending = null;
        else requestAnimationFrame(check);
        return;
      }
      mcDashCardMenuClosePending = null;
      if (dashCardMenuPopover()) return;

      ghost.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' +
        rect.width + 'px;height:' + rect.height + 'px;margin:0;z-index:99999;pointer-events:none;transform:none;';
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 240);
    };
    requestAnimationFrame(check);
  }
  document.addEventListener('pointerdown', ghostDashCardMenuClose, true);
  document.addEventListener('click', ghostDashCardMenuClose, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') ghostDashCardMenuClose(); }, true);

  // InstUI 那颗下拉（Inbox 顶部 All Courses / Inbox、Edit Event 里的 Frequency 等）关的时候同理：
  // 浮层是 React 拆的，CSS 抓不到「正在消失」，只能在它确实没了之后补一份影子播淡出。
  // 这一颗不学上面那样挂 pointerdown/click/Esc 三个钩子去猜「它会不会关」——点选项、点外面、
  // 按 Esc、再开另一颗，四条关法要各判一次；改成盯 body 的增删：
  // 插进来的那几帧连量三次位置存下来，被摘掉的那一帧拿这份位置造 fixed 影子。
  // 不能等摘的时候现量：节点已经脱离文档，getBoundingClientRect 全 0。
  // 也不能插进来立刻量：实测它插入那一帧 style 还是 null、transform 算出来是 none（＝在页面左上角），
  // 约 9ms 之后 InstUI 才把内联 transform 写进来，立刻量会存到一个错的位置。
  let mcOptOpen = null;
  let mcOptGhost = null;
  function isInstuiOptions(n) {
    // 影子自己也是 span[data-position-content]、里面也带着 [data-cid="Options"]，
    // 所以不加这道排除就是一条自喂的循环：真浮层关→补影子→影子插进 body 被同一个观察器当成
    // "又开了一颗"记下位置→200ms 后影子被摘→又落进"被摘掉"那条分支→再补一份影子……
    // 周期 200ms 无限跑，屏幕上就是"关的时候一直闪"（2026-10-04 他报的这条）。
    return !!n && n.nodeType === 1 && !n.classList.contains('mc-ghost-out') &&
      !!(n.matches && n.matches('span[data-position-content]')) && !!n.querySelector('[data-cid="Options"]');
  }
  // [实测 2026-10-11 /conversations 顶部这两颗] React 挂进 body 的不是浮层本身，是套在它外面
  // 那一层只带 dir="ltr" 的 span：链子是 BODY > SPAN[dir] > SPAN[data-position-content]，
  // 挂进来那一趟壳里已经带着整份选项列表（观察器回调里量到的）。上一版只认被挂上来那一颗自己，
  // 所以这两颗下拉开的时候没记下位置＝关的时候那道 `!r` 守卫直接 return＝没有淡出。
  // 上面那颗 Dashboard 三点菜单早就踩过同一层（见 mcDashMenuSetupObserver 里用 querySelector 找），
  // 这一颗照同一办法先往下找一层再判。
  function instuiOptionsOf(n) {
    if (!n || n.nodeType !== 1) return null;
    if (n.matches && n.matches('span[data-position-content]')) return isInstuiOptions(n) ? n : null;
    const inner = n.querySelector && n.querySelector('span[data-position-content]');
    return isInstuiOptions(inner) ? inner : null;
  }
  function ghostInstuiOptionsClose(node) {
    const key = node.getAttribute('data-position-content');
    // 触发那颗 combobox 还在这页上才补影子：整页换掉时 React 会连着把它也摘了，
    // 那时不该在已经换掉的页面上凭空留一块淡出的菜单。
    // [2026-10-11] 原来这道守卫量的是它的宽度。带 data-position-target 的那一层是
    // formFieldLayout__children 那颗壳（实测：有宽度的是肚子里的 input，壳自己量到 0），
    // 拿它当"看得见"的判据不稳，量到 0 就是影子永远不补。改成只问它在不在文档里，
    // 菜单自己那份矩形下面还有一道 ≥20 的守卫，够拦住乱补。
    const trig = key && document.querySelector('[data-position-target="' + key + '"]');
    if (!trig || !trig.isConnected) return;
    // 是被另一颗顶掉而不是关掉的话也不补，否则一开一关两份菜单叠一下。
    // 这里必须走 isInstuiOptions：用裸 querySelectorAll 的话正在淡出的那份影子会被当成"还活着"，
    // 把紧接着的下一次真关闭吞掉
    const living = [].slice.call(document.querySelectorAll('span[data-position-content]'))
      .some(x => x !== node && isInstuiOptions(x) && x.getBoundingClientRect().width > 0);
    if (living) return;
    const r = node._bcxOptRect;
    if (!r || r.width < 20 || r.height < 20) return;
    const ghost = node.cloneNode(true);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('mc-ghost-out');
    ghost.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' +
      r.width + 'px;margin:0;z-index:99999;pointer-events:none;transform:none;';
    // 快速开关时先摘掉上一份，别叠出两层半透明的菜单
    if (mcOptGhost && mcOptGhost !== ghost) mcOptGhost.remove();
    mcOptGhost = ghost;
    document.body.appendChild(ghost);
    setTimeout(() => {
      if (mcOptGhost === ghost) mcOptGhost = null;
      ghost.remove();
    }, 240);
  }
  new MutationObserver(ms => {
    // 关的那一趟：[实测 2026-10-11 Inbox 顶部这两颗] React 拆的时候发两条记录——先把浮层从
    // 它外面那层壳里摘掉（那条的 target 是壳，不是 body），再把空壳从 body 摘掉。两条都送进
    // 这个回调时，被摘掉的那颗壳里已经什么都没有了，所以"从被摘掉的节点里找浮层"这条路永远
    // 找不到东西＝关闭永远没有淡出。改成问我们自己记着的那一颗还在不在文档里，
    // 这一条对"壳＋浮层"和"浮层直接挂 body"两种形状都成立。
    if (mcOptOpen && !mcOptOpen.isConnected) {
      const gone = mcOptOpen;
      mcOptOpen = null;
      ghostInstuiOptionsClose(gone);
    }
    for (const m of ms) {
      if (m.type !== 'childList' || m.target !== document.body) continue;
      for (const n of m.addedNodes) {
        const pop = instuiOptionsOf(n);
        if (!pop || pop === mcOptOpen) continue;
        mcOptOpen = pop;
        pop._bcxOptRect = null;
        // 用 setTimeout 而不是 rAF 追那笔定位：他这个标签页在后台时 rAF 整个冻住，
        // 一帧都不来，位置永远存不下来，关的时候那道 `!r` 守卫直接 return＝没有关闭动画
        // （2026-10-04 实测：hidden 标签页里 ghost 数一直是 0）。定时器在后台页也会走，
        // 只是被节流到最快 1 秒，而那已经足够——菜单不会在开起来的 1 秒内就被关掉。
        // 30/90/180ms 三档：跳过插入那一帧的错位（实测约 9ms 后 InstUI 才写 transform），
        // 最后一次覆盖前面几档，取到的就是落稳的位置。
        [30, 90, 180].forEach(delay => setTimeout(() => {
          if (pop !== mcOptOpen || !pop.isConnected) return;
          pop._bcxOptRect = pop.getBoundingClientRect();
        }, delay));
      }
      for (const n of m.removedNodes) {
        // 浮层自己就是 body 直接子节点的那种形状（Edit Event 里 Frequency 那颗）走这一条；
        // 上面那道 isConnected 已经处理过的话 mcOptOpen 是 null，这里不会重复补影子
        const pop = instuiOptionsOf(n);
        if (!pop || pop !== mcOptOpen) continue;
        mcOptOpen = null;
        ghostInstuiOptionsClose(pop);
      }
      if (m.addedNodes && m.addedNodes.length) {
        mcScheduleMutedRescue();
      }
    }
  }).observe(document.body, { childList: true });

  /* =========================================================
     全站中性灰次要字与图标（rgb(106, 120, 131) / #6a7883）暗底自动营救引擎
     根据用户指令，将文字与图标一并纳入改色范围，同时配置智能底板判决与性能防护：
     1. 门控：仅在暗底主题激活（mc-themed 且 mcFlipOn）时运行；
     2. 节流：180ms 聚合调度，优先使用 requestIdleCallback 在浏览器空闲时分批处理；
     3. 范围：仅在 Modal、Popover、Tray、Card、Section 等容器中查找；
     4. 永久记忆：处理过的节点打上 data-mc-rescued="1"，原生 CSS 选择器直接跳过，永不重复查询；
     5. 智能亮板判定（mcIsOnLightPlate）：如果图标或文字坐在白底/浅色底板（如白色发信按钮、白色头像圈）上，
        严禁刷白，保留深色图标；坐在暗底上才将中性灰图标提升为可读色；
     6. 精确值校验：仅在 getComputedStyle 的 color 或 fill 确为 'rgb(106, 120, 131)' 时才赋色，
        绝不误伤彩色语义图标（红/绿/蓝）。
     ========================================================= */
  let mcRescueTimer = null;
  const MC_MUTED_RGB = 'rgb(106, 120, 131)';
  const MC_MUTED_RGBA = 'rgba(106, 120, 131, 1)';

  function mcIsOnLightPlate(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches && (cur.matches('[class*="-avatar"]') || cur.matches('[class*="-avatar"] *'))) return true;
      const bg = window.getComputedStyle(cur).backgroundColor;
      const rgb = mcToRgb(bg);
      if (rgb && mcAlphaOf(bg) > 0.45) {
        return mcLuminance(rgb) > 0.55; // 亮度大于 0.55 属于白底/浅色底板，保留深色
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function mcDoMutedTextRescue() {
    if (!document.documentElement.classList.contains('mc-themed')) return;
    if (typeof mcFlipOn === 'function' && !mcFlipOn()) return;

    const containers = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [data-position-content], section[class$="-view"], [class*="-tray"], form, [class*="modal"], [data-cid="ModalBody"], [data-testid*="rubric"], [class*="rubric"], table'
    );
    if (!containers || !containers.length) return;

    for (let c = 0; c < containers.length; c++) {
      const parent = containers[c];
      const candidates = parent.querySelectorAll(
        ':is(label, span, div, p, legend, svg, [class*="-inlineSVG"], i[class*="icon-"]):not([data-mc-rescued]):not(input, textarea, a, a *)'
      );
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        el.dataset.mcRescued = '1';
        
        // 区分图标元素与普通文本元素
        const isIcon = el.tagName === 'svg' || (el.matches && el.matches('[class*="-inlineSVG"], i[class*="icon-"]'));
        if (!isIcon && el.children && el.children.length > 2) continue;

        const style = window.getComputedStyle(el);
        const color = style.color;
        const fill = style.fill;
        const isMuted = (color === MC_MUTED_RGB || color === MC_MUTED_RGBA || fill === MC_MUTED_RGB || fill === MC_MUTED_RGBA);

        if (isMuted) {
          // 如果坐在白底/浅色按钮或头像上，保持深色；只有坐在深色背景上才提升为主题次要字色
          if (!mcIsOnLightPlate(el)) {
            el.style.setProperty('color', 'var(--mc-text-1)', 'important');
            if (isIcon && (fill === MC_MUTED_RGB || fill === MC_MUTED_RGBA)) {
              el.style.setProperty('fill', 'currentColor', 'important');
            }
          }
        }
      }
    }
  }

  function mcScheduleMutedRescue() {
    if (mcRescueTimer) clearTimeout(mcRescueTimer);
    mcRescueTimer = setTimeout(() => {
      mcRescueTimer = null;
      if (window.requestIdleCallback) {
        window.requestIdleCallback(() => mcDoMutedTextRescue(), { timeout: 400 });
      } else {
        requestAnimationFrame(() => mcDoMutedTextRescue());
      }
    }, 180);
  }

  // 点击事件（如打开三点菜单、点击写信信封按钮等）低频触发巡检，无损交互帧率
  document.addEventListener('click', () => mcScheduleMutedRescue(), { passive: true });
  // 初次加载低优先级拉起一次
  setTimeout(() => mcScheduleMutedRescue(), 600);

  // 格式化截止时间：Absolute 出 “10/02 at 11:59pm”，Relative 出 “Today / in 3 days / 4 days ago”
  function formatDueString(date) {
    if (!date || isNaN(date.getTime())) return 'Due Soon';
    if (modernSetting('date_format') === 'relative') {
      const n = new Date();
      const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
      const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const diff = Math.round((that - today) / 86400000);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
      return diff > 0 ? `In ${diff} days` : `${-diff} days ago`;
    }
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    return `${m}/${d < 10 ? '0' + d : d} at ${timeStr}`;
  }

  // 核心分组算法：严格与 External Extension 1:1 对齐
  // 返回: 'DUE SOON' | 'DUE TODAY' | 'DUE TOMORROW' | 'DUE IN X DAYS' | 'DUE LATER'
  function calculateSection(dueDate, now) {
    if (!dueDate || isNaN(dueDate.getTime())) return 'DUE SOON';
    
    // 计算天数差（基于本地日历天起始点）
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfDueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate()).getTime();
    const diffDays = Math.round((startOfDueDay - startOfToday) / 86400000);

    if (diffDays < 0) {
      // 已经过期（Past Due / Overdue）
      return 'DUE SOON';
    } else if (diffDays === 0) {
      // 今天到期
      return 'DUE TODAY';
    } else if (diffDays === 1) {
      // 明天到期
      return 'DUE TOMORROW';
    } else if (diffDays >= 2 && diffDays <= 6) {
      // 2 至 6 天
      return `DUE IN ${diffDays} DAYS`;
    } else {
      // 7 天及以上
      return 'DUE LATER';
    }
  }

  // 从本地 localStorage 加载缓存（秒开，防空白闪烁）
  function loadLocalCache() {
    try {
      const cachedAsgn = localStorage.getItem('bc_cache_assignments_v2');
      if (cachedAsgn) {
        const parsed = JSON.parse(cachedAsgn);
        if (Array.isArray(parsed) && parsed.length > 0) {
          modernAssignments = parsed.map(item => ({
            ...item,
            due: item.due ? new Date(item.due) : null
          }));
          // 缓存那份是上一次 planner 说的"没交"，本地问出来的两条判定要当场补上，
          // 不然考过的测验在首帧又闪一次 MISSING
          mcApplyCachedMissing(modernAssignments);
          mcApplyCachedScores(modernAssignments);
        }
      }
      const cachedAnn = localStorage.getItem('bc_cache_announcements_v1');
      if (cachedAnn) {
        const parsed = JSON.parse(cachedAnn);
        if (Array.isArray(parsed) && parsed.length > 0) {
          modernAnnouncements = parsed.map(item => ({
            ...item,
            date: item.date ? new Date(item.date) : null
          }));
        }
      }
      const cachedColors = localStorage.getItem('bc_cache_colors_v1');
      if (cachedColors) {
        modernCustomColors = JSON.parse(cachedColors);
      }
    } catch (e) {
      console.warn('[MCX] Error loading cache:', e);
    }
  }

  loadLocalCache();

  /* 首帧先画本地缓存，随后 Planner 回包以前这里一直保留那份缓存。以前不管回包是否
     真有变化，都会再整块 innerHTML 一次，造成肉眼可见的第二次绘制。Date 会在 JSON 序列化时
     稳定成 ISO 字符串，正好能和 localStorage 里的快照逐项对比。 */
  function mcTodoDataSignature() {
    return JSON.stringify({
      assignments: modernAssignments,
      announcements: modernAnnouncements,
      colors: modernCustomColors
    });
  }

  // 核心 API 数据抓取与解析引擎（External Extension 原生 API 流程）
  async function fetchPlannerData() {
    if (modernIsFetching) { modernRefetchQueued = true; return; }
    // 上一帧画的是"加载中"（一次都还没读到过）：这一趟哪怕读回来一模一样（真的一条作业都没有），
    // 也必须补一帧，不然那一格会一直顶着"加载中"。要在 modernIsFetching 抬起来之前问
    const blankBeforeFetch = mcTodosBlank();
    modernIsFetching = true;
    modernFetchFailed = false;
    const renderSignatureBeforeFetch = mcTodoDataSignature();

    try {
      const now = new Date();
      // 跨度：往后看多少天由 Timeframe 设置决定，往回看主请求固定 14 天。
      // MISSING 选到 3/4 周时要的是更早那一段，另开一条请求去补：一条只回 100 条，
      // 把主请求的回看窗口拉长会把往后要交的作业挤出那一页
      const aheadDays = { week: 7, month: 30, quarter: 90 }[modernSetting('timeframe')];
      const start = new Date(now.getTime() - MC_LOOKBACK_DAYS * 86400000).toISOString();
      const end = new Date(now.getTime() + aheadDays * 86400000).toISOString();
      const missingDays = mcMissingOn() ? missingRangeDays() : 0;
      const olderStart = missingDays > MC_LOOKBACK_DAYS ? new Date(now.getTime() - missingDays * 86400000).toISOString() : null;
      // 时间窗翻到回看窗口以前：那一段也另开一条。它和 MISSING 那条的区别是
      // 已交过的要留（已完成那一屏翻历史看的就是它们），公告也收（喇叭同一时间窗）
      const viewRange = viewBackfillRange(now.getTime());
      bcViewBackfillKey = viewRange ? `${viewRange.from}|${viewRange.to}` : '';

      let plannerOk = false;
      // 并行请求：Planner Items（近段，外加 MISSING 与时间窗要的那两段更早的）, Custom Colors, Activity Stream
      const [plannerData, olderData, viewData, colorsData, streamData] = await Promise.all([
        fetch(`/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=100`, { credentials: 'same-origin' })
          .then(r => {
            if (r.ok) { plannerOk = true; return r.json(); }
            return [];
          }).catch(() => []),
        olderStart
          ? fetch(`/api/v1/planner/items?start_date=${olderStart}&end_date=${start}&per_page=100`, { credentials: 'same-origin' })
              .then(r => r.ok ? r.json() : [])
              .then(list => (Array.isArray(list) ? list.map(o => ({ ...o, mcOlderOnly: true })) : []))
              .catch(() => [])
          : Promise.resolve([]),
        viewRange
          ? fetch(`/api/v1/planner/items?start_date=${viewRange.from}&end_date=${viewRange.to}&per_page=100`, { credentials: 'same-origin' })
              .then(r => r.ok ? r.json() : []).catch(() => [])
          : Promise.resolve([]),
        fetch('/api/v1/users/self/colors', { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch('/api/v1/users/self/activity_stream?only_active_courses=true', { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : []).catch(() => [])
      ]);

      // 1. 处理自定义颜色
      if (colorsData && colorsData.custom_colors) {
        const colors = {};
        for (const [k, v] of Object.entries(colorsData.custom_colors)) {
          colors[k] = v;
          if (k.startsWith('course_')) {
            colors[k.replace('course_', '')] = v;
          }
        }
        modernCustomColors = colors;
        try {
          localStorage.setItem('bc_cache_colors_v1', JSON.stringify(modernCustomColors));
        } catch (e) {}
      }

      // 2. 遍历 Planner 项。时间窗补的那一段排在最前（同一条以它为准，它不滤已交过的）；
      // MISSING 借来的更早那一段只用来补过期没交的，公告不收（喇叭那一档有自己的窗口）
      const newAssignments = [];
      const newAnnouncements = [];
      const seenAsgnIds = new Set();
      const seenAnnIds = new Set();
      const plannerItems = (Array.isArray(viewData) ? viewData : [])
        .concat(Array.isArray(olderData) ? olderData.filter(item => item.plannable_type !== 'announcement') : [])
        .concat(Array.isArray(plannerData) ? plannerData : []);

      for (const item of plannerItems) {
        const plannable = item.plannable || {};
        const pType = item.plannable_type;

        if (pType === 'announcement') {
          const annId = String(plannable.id || item.plannable_id || '');
          if (!annId || seenAnnIds.has(annId)) continue;
          seenAnnIds.add(annId);

          const directUrl = plannable.html_url || item.html_url || (item.course_id ? `/courses/${item.course_id}/announcements/${annId}` : '');
          const createdAt = plannable.created_at ? new Date(plannable.created_at) : (item.plannable_date ? new Date(item.plannable_date) : null);
          newAnnouncements.push({
            id: annId,
            title: plannable.title || 'Canvas Announcement',
            course: item.context_name || 'Announcement',
            courseId: item.course_id ? String(item.course_id) : '',
            url: directUrl,
            date: createdAt,
            readState: plannable.read_state || 'unread'
          });
          continue;
        }

        // 处理作业、讨论与测验
        if (['assignment', 'quiz', 'discussion_topic', 'discussion'].includes(pType)) {
          const asgnId = String(plannable.id || item.plannable_id || '');
          if (!asgnId || seenAsgnIds.has(asgnId)) continue;
          seenAsgnIds.add(asgnId);

          const title = plannable.title || 'Canvas Assignment';
          const courseName = item.context_name || 'Canvas Course';
          const courseId = item.course_id ? String(item.course_id) : '';
          const directUrl = item.html_url || plannable.linked_object_html_url || (courseId && asgnId ? `/courses/${courseId}/assignments/${asgnId}` : '');

          const dueRaw = item.plannable_date || plannable.due_at || null;
          const dueDate = dueRaw ? new Date(dueRaw) : null;

          // 打分与提交状态：只有真交过、或者他自己打过勾才算完成。
          // 老师批过／系统自动打了分（包括没交给 0 分）不等于交过，这类条目要留在 MISSING 里
          const submissions = item.submissions || {};
          const override = item.planner_override || {};
          const isMarkedOverride = typeof override.marked_complete === 'boolean' ? override.marked_complete : null;

          // 那颗勾是他自己在 Canvas 上留的标记，所以它压过站点那句 submitted：
          // 取消过又没勾回去的，照他说的仍然算 missing（2026-10-05 他原话确认）
          const isSubmitted = isMarkedOverride !== null
            ? isMarkedOverride
            : submissions.submitted === true;

          // 批没批分仍然照 Canvas 说的算（已完成那一屏分 UNGRADED / GRADED 靠它）
          const isGraded = submissions.graded === true || submissions.score != null;
          const scoreVal = submissions.score != null ? submissions.score : null;
          const pointsPossible = plannable.points_possible != null ? plannable.points_possible : null;

          // 有没有能提交的东西：submission_types 只有 none／on_paper（或空）时，
          // 学生在作业页上根本看不到上传那一格，这种过期以后不该算 missing
          const submissionTypes = Array.isArray(plannable.submission_types) ? plannable.submission_types : null;
          const noSubmit = submissionTypes !== null && submissionTypes.every(t => t === 'none' || t === 'on_paper');

          const pointsStr = pointsPossible != null ? `${pointsPossible}pts` : '10pts';
          const scoreStr = scoreVal != null ? `${scoreVal}/${pointsStr}` : `-/${pointsStr}`;

          // 更早那一段只借来认"过期还没交"的那批：那一段里真交过的不收，
          // 否则选了 3/4 周会把已完成选项卡的历史一起撑长
          if (item.mcOlderOnly && isSubmitted) continue;

          newAssignments.push({
            id: asgnId,
            title: title,
            course: courseName,
            courseId: courseId,
            type: pType,
            due: dueDate,
            url: directUrl,
            points: pointsStr,
            score: scoreStr,
            isSubmitted: isSubmitted,
            markedUndone: isMarkedOverride === false,
            noSubmit: noSubmit,
            // 回包到底给没给这个字段。没给＝判不了，不能当成"有东西可交"
            noSubmitKnown: submissionTypes !== null,
            isGraded: isGraded,
            // 日志用：planner 那几句原话，判错时一眼看得出是哪边在说谎
            submissionsRaw: {
              submitted: submissions.submitted === true,
              graded: submissions.graded === true,
              needsGrading: submissions.needs_grading === true,
              excused: submissions.excused === true,
              score: scoreVal
            },
            overridePlannableId: String(plannable.assignment_id || plannable.id || item.plannable_id || ''),
            overrideId: override.id ? String(override.id) : null
          });
        }
      }

      // 3. 从 Activity Stream 补充最新未读公告
      if (Array.isArray(streamData)) {
        for (const item of streamData) {
          if (item.type === 'Announcement' || item.type === 'DiscussionTopic') {
            const annId = String(item.id || item.announcement_id || '');
            if (!annId || seenAnnIds.has(annId)) continue;
            seenAnnIds.add(annId);

            newAnnouncements.push({
              id: annId,
              title: item.title || 'Canvas Announcement',
              course: item.context_name || 'Canvas Announcement',
              courseId: item.course_id ? String(item.course_id) : '',
              url: item.html_url || item.url || '',
              date: item.created_at ? new Date(item.created_at) : null,
              readState: item.read_state || 'unread'
            });
          }
        }
      }

      if (plannerOk || newAssignments.length > 0 || newAnnouncements.length > 0) {
        mcApplyCachedMissing(newAssignments);
        mcApplyCachedScores(newAssignments);
        modernAssignments = newAssignments;
        modernAnnouncements = newAnnouncements;
        modernApiLoaded = true;

        try {
          localStorage.setItem('bc_cache_assignments_v2', JSON.stringify(modernAssignments));
          localStorage.setItem('bc_cache_announcements_v1', JSON.stringify(modernAnnouncements));
        } catch (e) {}

        // 先把"正在取"摘掉再画：这一帧画的就是这趟读回来的东西。顶着一趟已经结束的
        // modernIsFetching 去问"还在加载吗"，判出来的是"在"，而后面再没有第二帧来纠正它
        // （上一版就是这条：翻到没有作业的那一窗，面板永远读 "Loading..."）
        modernIsFetching = false;
        // 缓存和服务器数据完全相同时，首帧已经画过，不再整块重建造成二次闪动。
        // 没有缓存或任一待办/公告/课程色有变化时，签名不同，照常立即更新。
        // 上一帧是"加载中"的那一帧不算数，读回来一模一样也要重画一次
        if (mcTodoDataSignature() !== renderSignatureBeforeFetch || blankBeforeFetch) updatePanelDom();
        // 本地没记录的那几条过期项去问一次作业本身和那份提交，问完自己决定要不要重绘
        mcResolveMissing();
        // 批过分的这一批 planner 给不了分数，另开一趟按作业问自己的提交记录
        mcResolveScores();

        // 3分钟/刷新Todolist时：为新作业提前在后台自动分析分数、预读<=8MB文档与分级处理
        try {
          if (window.MCxAssignGuide && window.MCxAssignGuide.triggerBackgroundPreload) {
            window.MCxAssignGuide.triggerBackgroundPreload(newAssignments);
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn('[MCX] API Fetch Error:', err);
    } finally {
      modernIsFetching = false;
      if (!modernApiLoaded) modernFetchFailed = true; // 这一趟到头也没读到东西：别把断网说成还在读
      // 这一帧还顶着"加载中"就补一帧。成功那一支自己会先画掉它，走到这里已经是
      // 请求失败／回包不对／压根没进成功支——那一窗没东西也要说得出"没有"，不能卡在"加载中"
      if (mcPaintedLoading) updatePanelDom();
      // 这一趟跑着的时候又翻了页：那一窗口的数据这趟没带上，补一趟
      if (modernRefetchQueued) {
        modernRefetchQueued = false;
        fetchPlannerData();
      }
    }
  }

  // 原生 feedback 行：补课程色（色条按需求不出现，颜色由课程名文字和 hover 描边承载），
  // 并接管条目显隐——Canvas 自己只放开前 3 条，其余写在行内 style 里
  const FB_ROW_LIMIT = 10;
  let fbExpanded = false;

  function dressFeedbackRows() {
    const root = document.querySelector('#right-side .recent_feedback');
    if (!root) return;

    // 新旧 Canvas 的反馈卡都以 li.event > a.recent_feedback_icon 表示；新版不少作业链接
    // 不再带 /submissions/:id，不能再从 URL 判断，否则「还有几条」会少算。
    const rows = [...root.querySelectorAll('li.event')].filter(li => li.querySelector('a.recent_feedback_icon'));
    const limit = fbExpanded ? rows.length : Math.min(FB_ROW_LIMIT, rows.length);

    rows.forEach((li, i) => {
      li.classList.add('bc-fb-row');
      const link = li.querySelector('a[href*="/courses/"]');
      const m = link ? link.getAttribute('href').match(/\/courses\/(\d+)/) : null;
      const color = getCourseColor(m ? m[1] : '', '');
      // 只在值真的变了时才写：行内样式重写会再触发观察器，无条件写就成了空转死循环
      if (li.dataset.fbColor !== color) {
        li.dataset.fbColor = color;
        li.style.setProperty('--course-color', color);
      }
      const ctx = li.querySelector('.event-details__context');
      /* 这一行的颜色不再写进行内：那份带 !important 的行内值压在本条上面，
         设置里 Course title colour 翻到哪一档都不动（他报的那一处）。
         颜色统一由 style.css 的 .event-details__context 读上面那颗 --course-color。
         这里只把课名换成 Course info 那一屏起的名字，没起过的交回 Canvas 那句 */
      if (ctx) mcSetLineText(ctx, m ? mcCourseName(m[1], '') : '');
      const want = i < limit ? '' : 'none';
      if (li.style.display !== want) li.style.display = want;
    });

    /* 底部那条展开链接。探针确认：每条反馈都是 li.event > a.recent_feedback_icon，
       footer 则是独立 li > a.more_link。直接认 Canvas 的稳定语义类，不再根据 URL 或文案猜测，
       避免新版作业链接格式变化时把反馈卡误标成整宽的 View More 按钮。 */
    root.querySelectorAll('a.recent_feedback_icon.bc-fb-more').forEach(a => {
      a.classList.remove('bc-fb-more');
      const li = a.closest('li');
      if (li) li.classList.remove('bc-fb-footer');
    });
    const moreLink = root.querySelector('a.more_link');
    if (!moreLink) return;
    moreLink.classList.add('bc-fb-more');
    const footerLi = moreLink.closest('li');
    if (footerLi) footerLi.classList.add('bc-fb-footer');
    const remaining = Math.max(0, rows.length - limit);
    const label = fbExpanded ? 'Show Less' : `View ${remaining} more`;
    if (moreLink.textContent.trim() !== label) moreLink.textContent = label;
    if (!moreLink.dataset.fbBound) {
      moreLink.dataset.fbBound = 'true';
      moreLink.addEventListener('click', e => {
        e.preventDefault();
        fbExpanded = !fbExpanded;
        dressFeedbackRows();
      });
    }
  }

  /* ===== 第四档（反馈）在原生没有反馈块的那些页面上自己画一份 =====
     原生 Recent Feedback 只在部分页面存在（仪表盘有，成绩页／作业详情页没有）。以前这一档
     只做"把原生那块显出来"，原生不在时点它就是整片空。
     能读到反馈原文的端点只有一个（官方文档：conversations 那侧已经不再关联提交记录）：
     按课问 /courses/<id>/students/submissions?include[]=submission_comments（不带 student_ids[] 就是问自己）。
     所以一门课一次请求，只在点开那一档时发，结果整页缓存。收的是窗口内"批过分的"和"有评语的"两类，
     只有分数没评语的那一批同样在列（和原生那份一样）。
     剩余缺口：某门课窗口内既有批过分的作业、又有"只写评语没给分"的提交时，后者不在 graded_since
     的回包里，收不到。空回包时会整份再问一次，非空不会。 */
  const MC_FB_DAYS = 30;
  const MC_FB_CAP = 20;
  let mcFeedback = { state: 'idle', items: [], error: '' };

  function mcNativeFeedbackPresent() {
    return !!document.querySelector('#right-side .recent_feedback');
  }

  // 一次请求，回成 {ok, json, status}：网络挂了不抛，让整批不被一颗带倒
  function mcFbAsk(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(res => res.ok
        ? res.json().then(json => ({ ok: true, json })).catch(() => ({ ok: false, status: res.status }))
        : { ok: false, status: res.status })
      .catch(() => ({ ok: false, status: 0 }));
  }

  // 评论正文是富文本。DOMParser 不取资源也不跑脚本，比塞进 div 安全
  function mcFbPlain(html) {
    const doc = new DOMParser().parseFromString('<div id="mcx-fb">' + String(html || '') + '</div>', 'text/html');
    const box = doc.getElementById('mcx-fb');
    return (box ? box.textContent : '').replace(/\s+/g, ' ').trim();
  }

  const MC_FB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // 分数那一格：Canvas 的 grade 常常只有 "45"，满分值在 points_possible（或作业那份的）上。
  // 两个都拿得到就写 45 / 50；等级类（A-、EX、Complete）没有满分可比，原样写那一个
  function mcFbNum(v) {
    const n = Number(v);
    return isFinite(n) ? String(Math.round(n * 100) / 100) : String(v);
  }

  function mcFbGrade(s, asgn) {
    const pp = s.points_possible != null ? s.points_possible : (asgn ? asgn.points_possible : null);
    const hasGrade = s.grade != null && s.grade !== '';
    const num = s.score != null ? s.score : (hasGrade && isFinite(Number(s.grade)) ? s.grade : null);
    if (num != null && pp != null && Number(pp) > 0) return `${mcFbNum(num)} / ${mcFbNum(pp)}`;
    if (hasGrade) return String(s.grade);
    if (num != null) return mcFbNum(num);
    return '';
  }

  function mcFbDateLabel(d) {
    if (!d || isNaN(d.getTime())) return '';
    if (modernSetting('date_format') === 'relative') {
      const n = new Date();
      const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Yesterday';
      return diff > 1 ? `${diff} days ago` : `${MC_FB_MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
    return `${MC_FB_MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  async function mcFbCourses() {
    if (mcSidebarCourseList && mcSidebarCourseList.length) return mcSidebarCourseList;
    const r = await mcFbAsk('/api/v1/courses?enrollment_state=active&per_page=100');
    if (!r.ok || !Array.isArray(r.json)) return [];
    return r.json.map(c => ({ id: String(c.id), name: c.name || ('Course ' + c.id) }));
  }

  async function mcFetchFeedback() {
    // 起手只翻状态，不自己重绘：调用这一颗的地方（切选项卡／Try again）紧接着都要重建一次，
    // 在这里再画一遍就是同一帧重建两次
    mcFeedback = { state: 'loading', items: mcFeedback.items, error: '' };

    const courses = await mcFbCourses();
    if (!courses.length) {
      mcFeedback = { state: 'error', items: [], error: 'Could not read your courses.' };
      updatePanelDom();
      return;
    }
    const since = new Date(Date.now() - MC_FB_DAYS * 86400000).toISOString();
    const me = await mcWhoAmI();
    // 官方口径：students/submissions 不带 student_ids[] 时回的就是"我自己"的那些提交。
    // include[]=assignment 把作业名和满分值一起带回来，不靠我们再去认
    const fbSuffix = 'include[]=submission_comments&include[]=assignment&per_page=50';
    const pages = await Promise.all(courses.map(async c => {
      const base = `/api/v1/courses/${c.id}/students/submissions`;
      // 先用 graded_since 收窗口内批过分的（一屏作业几百颗的那门课靠它把近期那批捞到前面来）。
      // 它回 200 但是空表时再整份问一次：老师只写评语没给分的那一类不在 graded_since 的结果里
      let r = await mcFbAsk(`${base}?graded_since=${encodeURIComponent(since)}&${fbSuffix}`);
      if (!r.ok || (Array.isArray(r.json) && !r.json.length)) r = await mcFbAsk(`${base}?${fbSuffix}`);
      const list = r.ok && Array.isArray(r.json) ? r.json : [];
      return { ok: r.ok, status: r.status, list: list.map(s => Object.assign({}, s, { mcCourseId: c.id, mcCourseName: c.name })) };
    }));
    // 一门都没问成功＝请求坏了，不能报"没有反馈"。回包是空列表才是真的没有
    if (!pages.some(p => p.ok)) {
      console.log('[MCX] feedback: 全部 ' + courses.length + ' 门课都没读到', pages.map(p => p.status).join(','));
      mcFeedback = { state: 'error', items: [], error: 'Could not read feedback.' };
      updatePanelDom();
      return;
    }

    const items = [];
    pages.flatMap(p => p.list).forEach(s => {
      const comments = (Array.isArray(s.submission_comments) ? s.submission_comments : [])
        .filter(c => c && c.comment && !(me != null && String(c.author_id) === String(me)));
      const last = comments.length
        ? comments.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).pop() : null;
      const asgn = s.assignment || {};
      // 有评语或批过分，两个都没有就不是"反馈"。只有分数没有评语的那一批也要收进来
      // （原生那份就是这样的，之前只收有评语的，等于把大半屏漏掉了）
      const graded = s.workflow_state === 'graded' || (s.grade != null && s.grade !== '');
      if (!last && !graded) return;
      const known = modernAssignments.find(a => String(a.id) === String(s.assignment_id));
      const title = asgn.name || asgn.title || (known ? known.title : '');
      if (!title) return;
      const at = new Date((last && last.created_at) || s.graded_at || s.updated_at || s.submitted_at || '');
      if (isNaN(at.getTime()) || Date.now() - at.getTime() > MC_FB_DAYS * 86400000) return;
      items.push({
        key: `${s.mcCourseId}-${s.id}`,
        // 课名读 Course info 那一屏：和侧栏、卡片上那行同一格，没起过名字才是 Canvas 那句
        course: mcCourseName(s.mcCourseId, s.mcCourseName || (known ? known.course : '')),
        courseId: s.mcCourseId,
        title,
        url: s.html_url || (known ? known.url : ''),
        grade: mcFbGrade(s, asgn),
        comment: last ? mcFbPlain(last.comment) : '',
        author: last ? (last.author_name || '') : '',
        at
      });
    });
    items.sort((a, b) => b.at - a.at);
    console.log('[MCX] feedback:', courses.length + ' courses', items.length + ' rows', items[0] ? 'newest ' + items[0].at.toISOString() : 'no comments in window');
    mcFeedback = { state: 'ready', items: items.slice(0, MC_FB_CAP), error: '' };
    updatePanelDom();
  }

  // 只有真的停在反馈那一档、且这一页没有原生块时才发这批请求
  function mcEnsureFeedback() {
    if (currentActiveTab !== 'feedback' || mcNativeFeedbackPresent()) return;
    if (mcFeedback.state === 'idle') mcFetchFeedback();
  }

  // 站点是 SPA：从仪表盘（有原生反馈）走进课程页（没有）时，currentActiveTab 还停在反馈档，
  // 面板不重建就留下一片空。
  // 比的是"面板现在画的是哪一种"（由 buildPanelHtml 每次渲染时记下），不是"上一次见到的是哪一种"：
  // 上一版在离开反馈档时把记录清了，于是每次切回来都被判成翻了一次＝白重建一遍，列表淡入两下
  let mcFbRenderedSelf = null;
  function mcSyncFeedbackMode() {
    if (currentActiveTab !== 'feedback') return;
    const self = !mcNativeFeedbackPresent();
    if (self === mcFbRenderedSelf) return;
    if (self) mcEnsureFeedback();
    updatePanelDom();
  }

  function mcFeedbackBodyHtml(cardTarget) {
    const f = mcFeedback;
    if (f.state === 'idle' || f.state === 'loading') {
      return `<div class="bc-empty-state">Loading feedback from Canvas...</div>`;
    }
    if (f.state === 'error') {
      return `<div class="bc-empty-state">${mcEsc(f.error || 'Could not read feedback.')} <span class="mc-fb-retry" role="button" tabindex="0">Try again</span></div>`;
    }
    if (!f.items.length) {
      return `<div class="bc-empty-state">No feedback in the last ${MC_FB_DAYS} days.</div>`;
    }
    return `
      <div class="custom-todo-section-group">
        <div class="custom-todo-section-title" data-collapse-target="list_feedback">
          <span>RECENT FEEDBACK</span>
          <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
        </div>
        <div class="custom-todo-list-body" id="list_feedback">
          ${f.items.map(it => {
            const color = getCourseColor(it.courseId, it.course);
            const who = it.author ? `${it.author}: ` : '';
            return `
            <a class="custom-todo-card custom-todo-nav-card" id="fb_${it.key}"${it.url ? ` href="${it.url}"` : ''}${cardTarget} style="--course-color: ${color}; cursor: pointer;">
              <div class="custom-todo-card-left">
                <div class="custom-todo-course-name">${mcEsc(it.course)}</div>
                <div class="custom-todo-card-title">${mcEsc(it.title)}</div>
                ${it.comment ? `<div class="mc-fb-comment">${mcEsc(who + it.comment)}</div>` : ''}
                <div class="custom-todo-card-footer">
                  <span class="custom-todo-date-subtext">${mcFbDateLabel(it.at)}</span>
                  ${it.grade ? `<span class="custom-todo-pts">${mcEsc(it.grade)}</span>` : ''}
                </div>
              </div>
            </a>
            `;
          }).join('')}
        </div>
      </div>`;
  }

  // 第四选项卡 feedback：联动显隐原生 Recent Feedback（只切显隐，不搬运 DOM）
  function syncFeedbackTabView() {
    // 联动的前提是面板在（选项卡是唯一的还原入口）；日历页不挂面板，别把原生区块吞了
    if (!document.getElementById('mc-todo-panel')) return;
    const rightSide = document.getElementById('right-side');
    // 这一页根本没有原生块：联动无从谈起，主体由 mcFeedbackBodyHtml 自己画。
    // 这时不能挂 bc-showing-feedback，那条规则会把面板的下边距收掉（它是给原生块贴着面板用的）
    if (!mcNativeFeedbackPresent()) {
      if (rightSide) rightSide.classList.remove('bc-showing-feedback');
      return;
    }
    const hide = currentActiveTab !== 'feedback';
    // 只改 Feedback 最外层的显隐，避免 Canvas 的嵌套结构叠动画。
    nativeFeedbackAnimationNodes().forEach(node => {
      node.classList.toggle('bc-tab-feedback-hidden', hide);
      node.classList.toggle('bc-tab-feedback-anim', !hide);
    });
    if (!hide) dressFeedbackRows();
    if (rightSide) rightSide.classList.toggle('bc-showing-feedback', !hide);
  }

  // 刷新当前面板 DOM。切栏时 tabs 本身会被保留：滑块必须是同一个节点，才能从
  // 手指连点时的实时位置继续滑，而不是每次重建后从旧档位重新起跑。
  // 卡片上那块 Tasks 和面板读的是同一批数据，所以这一趟一起重算：
  // 点完勾、拉完 planner、翻了任何一档设置，两边不会一个已经刷新、一个还挂着旧的
  function updatePanelDom() {
    const panel = document.getElementById('mc-todo-panel');
    if (panel) {
      panel.innerHTML = buildPanelHtml();
      attachListeners(panel);
      syncTodoCardBorderContrast(panel);
      syncFeedbackTabView();
    }
    mcStep('mcCardTasks', () => mcCardTasks());
  }

  function mcColorChannels(value) {
    const parts = String(value || '').match(/\d+(?:\.\d+)?/g);
    return parts && parts.length >= 3 ? parts.slice(0, 3).map(Number) : null;
  }

  // 卡片与外层背景太接近时，中性分隔线会消失。用一颗临时取样节点读主题
  // 实际解析后的 background-1，只有色差很小时才打开 accent 外框兜底。
  function syncTodoCardBorderContrast(panel) {
    const cardSample = document.createElement('i');
    const surfaceSample = document.createElement('i');
    cardSample.style.cssText = 'position:absolute;visibility:hidden;background:var(--mc-background-0);';
    surfaceSample.style.cssText = 'position:absolute;visibility:hidden;background:var(--mc-background-1);';
    panel.append(cardSample, surfaceSample);
    const card = mcColorChannels(getComputedStyle(cardSample).backgroundColor);
    const surface = mcColorChannels(getComputedStyle(surfaceSample).backgroundColor);
    cardSample.remove();
    surfaceSample.remove();
    const distance = card && surface
      ? Math.hypot(card[0] - surface[0], card[1] - surface[1], card[2] - surface[2])
      : 255;
    panel.classList.toggle('mc-todo-low-contrast', distance < 18);
  }

  function nativeFeedbackAnimationNodes() {
    const root = document.querySelector('#right-side .recent_feedback');
    const title = document.querySelector('#right-side #recent_feedback_title');
    // 只认 Canvas 的稳定锚点。不要再用 [class*="feedback"]：右栏会不断插入
    // 其它反馈相关包装节点，宽选会把不属于 Feedback 列表的动画状态一起接管。
    return [root, title].filter(Boolean).filter(node => node !== title || !root || !root.contains(node));
  }

  // 进度指示器：Ring Style 决定形状（一门课一圈，弧长＝该课完成度），None 只留百分比文字
  const RING_PALETTE = ['#059669', '#d13438', '#d97706', '#008ee2', '#927005', '#9333ea', '#2b7a78', '#cb4740'];

  function buildProgressBlock(activeItems, doneItems, doneCount, totalCount, percent) {
    const style = modernSetting('ring_style');
    // 还没读到过一次的时候，"0%"和"0/0"都是假数字：那一格先说"加载中"。
    // 只认"一次都没读到"，不认"正在重取"——后台刷新那一趟不该把看得见的数字抹掉
    const reading = mcTodosBlank();
    if (style === 'bar') {
      const colorCounts = {};
      doneItems.forEach(item => {
        const c = getCourseColor(item.courseId, item.course);
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      });
      const segs = totalCount === 0 || doneCount === 0 ? '' : Object.keys(colorCounts).map(color =>
        `<div class="progress-course-seg" style="width: ${(colorCounts[color] / totalCount) * 100}%; background-color: ${color};"></div>`).join('');
      return `
        <div class="custom-todo-progress-container">
          <div class="custom-todo-progress-stats">
            <span class="custom-todo-percent${reading ? ' mc-percent-word' : ''}">${reading ? 'Loading...' : percent + '%'}</span>
            ${reading ? '' : `<span class="custom-todo-complete-count">${doneCount}/${totalCount} complete</span>`}
          </div>
          <div class="custom-todo-progress-bar">${segs}</div>
        </div>`;
    }

    const byCourse = {};
    const bucket = item => {
      const key = String(item.courseId || item.course || '');
      if (!byCourse[key]) byCourse[key] = { color: getCourseColor(item.courseId, item.course), done: 0, total: 0, active: 0 };
      return byCourse[key];
    };
    activeItems.forEach(item => { const b = bucket(item); b.total += 1; b.active += 1; });
    doneItems.forEach(item => { bucket(item).total += 1; });
    doneItems.forEach(item => { byCourse[String(item.courseId || item.course || '')].done += 1; });

    let rings = Object.keys(byCourse).map(k => byCourse[k]);
    if (modernSetting('rings_for') === 'active') rings = rings.filter(r => r.active > 0);
    rings.sort((a, b) => b.total - a.total);
    rings = rings.slice(0, 12);

    // 外圈固定、中心留出文字的位置，圈数和粗细自适应，课程再多也不会压到中间的百分比
    const size = 150, center = size / 2, outer = center - 8, hole = 34;
    const step = (outer - hole) / Math.max(rings.length, 1);
    const stroke = Math.min(6, Math.max(2, step * 0.7));
    const half = style === 'rainbow'; // Rainbow 是半圆拱，其余档位是整圈
    const arcs = rings.map((r, i) => {
      const radius = outer - step * (i + 0.5);
      if (radius < 8) return '';
      const circ = 2 * Math.PI * radius;
      const sweep = circ * (half ? 0.5 : 1);
      const pct = r.total ? r.done / r.total : 0;
      const color = style === 'rainbow' ? RING_PALETTE[i % RING_PALETTE.length] : r.color;
      return `<circle class="bc-ring-track" cx="${center}" cy="${center}" r="${radius.toFixed(2)}" stroke-width="${stroke.toFixed(2)}" stroke-dasharray="${sweep.toFixed(2)} ${circ.toFixed(2)}"></circle>`
        + `<circle class="bc-ring-arc" cx="${center}" cy="${center}" r="${radius.toFixed(2)}" stroke="${color}" stroke-width="${stroke.toFixed(2)}" stroke-dasharray="${(sweep * pct).toFixed(2)} ${circ.toFixed(2)}"></circle>`;
    }).join('');

    // 整圆档两行都在圆心；拱形档只把百分比放拱内，计数落到拱脚下
    const centerLines = style === 'rainbow'
      ? `<span class="custom-todo-percent">${percent}%</span>`
      : `<span class="custom-todo-percent">${percent}%</span><span class="custom-todo-complete-count">${doneCount}/${totalCount}</span>`;

    return `
      <div class="bc-progress-ring bc-ring-${style}">
        <svg viewBox="0 0 ${size} ${size}" class="bc-ring-svg">${arcs}</svg>
        <div class="bc-ring-center">${centerLines}</div>
        ${style === 'rainbow' ? `<div class="bc-ring-undercount">${doneCount}/${totalCount}</div>` : ''}
      </div>`;
  }

  // 生成面板 HTML
  function buildPanelHtml() {
    const now = new Date();
    let userDoneMap = {};
    let userAnnReadMap = {};
    try {
      userDoneMap = JSON.parse(localStorage.getItem('mc_todo_local') || '{}') || {};
    } catch (e) {
      userDoneMap = {};
    }
    try {
      userAnnReadMap = JSON.parse(localStorage.getItem('mc_ann_read') || '{}') || {};
    } catch (e) {
      userAnnReadMap = {};
    }
    // 点卡片落在哪一档，由设置里 ToDo list 那一颗决定。挂 target 的是真链接本身：
    // 浏览器自己去开新标签，右键菜单里"在新标签页打开／在当前标签页打开"跟着换位置，
    // Ctrl+点击和中键不用另写代码也一直是"新标签"
    const cardTarget = modernSetting('card_click') === 'new' ? ' target="_blank"' : '';

    // 划分 active / completed。过期还没交的留在 active 里（进度环要算它们），
    // 但另打一个 missing 标记，它们只画在 MISSING 那一区，不再混进 DUE SOON
    const activeAssignments = [];
    const completedAssignments = [];

    modernAssignments.forEach(item => {
      // 完成状态那条链（Canvas 说的交过／只本地那一档他点过的勾／过期那批的出口）
      // 全在 mcTaskState 里，卡片上那块 Tasks 读的是同一份，两边不会一个摆一个不摆
      const state = mcTaskState(item, userDoneMap, now);
      const color = getCourseColor(item.courseId, item.course);
      if (!state) {
        completedAssignments.push(item);
        return;
      }
      if (state.drop) return;
      if (state.missing) {
        activeAssignments.push({ ...item, missing: true, color });
        return;
      }
      // 未完成作业：计算其所处时间分区
      activeAssignments.push({
        ...item,
        section: calculateSection(item.due, now),
        color
      });
    });

    // 百分比和彩条／进度环跟上面那档 Day/Week/Month 一起走，判据是 due date，
    // 和下面卡片列表用的是同一个 inViewWindow。
    // MISSING 那一批不跟窗口（它由 MISSING 那一区自己置顶），但始终算进分母
    const inProgressScope = item => item.missing === true || inViewWindow(item.due);
    const scopedActive = activeAssignments.filter(inProgressScope);
    const scopedDone = completedAssignments.filter(inProgressScope);
    const totalCount = scopedActive.length + scopedDone.length;
    const doneCount = scopedDone.length;
    const percent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    // MISSING 那一区的样子：未完成卡片那一套，最久过期的排最前。
    // 上面选了 Day/Week/Month 也不跟着窗口走，所以画它时不过 inViewWindow
    const missingGroupHtml = list => `
      <div class="custom-todo-section-group">
        <div class="custom-todo-section-title" data-collapse-target="list_missing">
          <span>MISSING</span>
          <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
        </div>
        <div class="custom-todo-list-body" id="list_missing">
          ${[...list].sort((a, b) => a.due - b.due).map(item => `
            <a class="custom-todo-card custom-todo-nav-card" id="card_${item.id}"${item.url ? ` href="${item.url}"` : ''}${cardTarget} style="--course-color: ${item.color}; cursor: pointer;">
              <div class="custom-todo-card-left">
                <div class="custom-todo-course-name">${mcCourseName(item.courseId, item.course)}</div>
                <div class="custom-todo-card-title">${mcEsc(item.title)}</div>
                <div class="custom-todo-card-footer">
                  <span class="custom-todo-due-tag">Due ${formatDueString(item.due)}</span>
                  <span class="custom-todo-pts">${item.isGraded ? item.score : (item.points || '10pts')}</span>
                </div>
              </div>
              <div class="custom-todo-check-circle" data-id="${item.id}" title="Mark as complete"></div>
            </a>
          `).join('')}
        </div>
      </div>
    `;
    const missingPool = activeAssignments.filter(item => item.missing);
    const missingForAssignments = missingPlacement() === 'uncompleted' ? missingPool : [];
    const missingForCompleted = missingPlacement() === 'finished' ? missingPool : [];

    // 未读公告计数
    const unreadAnnCount = modernAnnouncements.filter(a => inViewWindow(a.date) && !resolveLocalFlag(userAnnReadMap, a.id, a.readState === 'read')).length;

    // 1. Header & Progress Bar
    let html = `
      <div class="custom-todo-header">
        <span class="custom-todo-title">Hub</span>
      </div>

      <div class="bc-view-bar">
        <div class="bc-view-wrap">
          <div class="bc-view-btn" title="Filter by date">${VIEW_LABELS[currentViewMode()]}<svg class="bc-view-arrow" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg></div>
        </div>
        <div class="bc-view-nav">
          <div class="bc-view-step" data-view-step="-1" title="Previous">
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L9.83 12z"/></svg>
          </div>
          <span class="bc-view-range">${viewRangeLabel()}</span>
          <div class="bc-view-step" data-view-step="1" title="Next">
            <svg viewBox="0 0 24 24"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L14.17 12z"/></svg>
          </div>
        </div>
      </div>

      ${buildProgressBlock(scopedActive, scopedDone, doneCount, totalCount, percent)}

      <!-- 三分段选项卡 -->
      <div class="custom-todo-tabs" data-active-tab="${currentActiveTab}" role="tablist" aria-label="To Do categories">
        <div class="custom-todo-tab-slider"></div>
        <div class="custom-todo-tab ${currentActiveTab === 'announcements' ? 'active' : ''}" data-tab="announcements" role="tab" aria-selected="${currentActiveTab === 'announcements'}" tabindex="0" title="Announcements">
          <svg class="tab-icon" viewBox="0 0 24 24">
            <path d="M4 10v4h3l5 4V6L7 10H4zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM15 4.5v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
          ${unreadAnnCount > 0 ? `<span class="custom-todo-badge">${unreadAnnCount > 9 ? '9+' : unreadAnnCount}</span>` : ''}
        </div>
        <div class="custom-todo-tab ${currentActiveTab === 'assignments' ? 'active' : ''}" data-tab="assignments" role="tab" aria-selected="${currentActiveTab === 'assignments'}" tabindex="0" title="Assignments">
          <svg class="tab-icon" viewBox="0 0 24 24">
            <path d="M3 17.46v3.79c0 .41.34.75.75.75h3.79c.2 0 .39-.08.53-.22L18.42 11.44l-4.86-4.86L3.22 16.93c-.14.14-.22.33-.22.53zm17.71-8.04a1.25 1.25 0 0 0 0-1.77l-3.36-3.36a1.25 1.25 0 0 0-1.77 0l-1.83 1.83 5.13 5.13 1.83-1.83z"/>
          </svg>
        </div>
        <div class="custom-todo-tab ${currentActiveTab === 'completed' ? 'active' : ''}" data-tab="completed" role="tab" aria-selected="${currentActiveTab === 'completed'}" tabindex="0" title="Completed">
          <svg class="tab-icon" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
          </svg>
        </div>
        <div class="custom-todo-tab ${currentActiveTab === 'feedback' ? 'active' : ''}" data-tab="feedback" role="tab" aria-selected="${currentActiveTab === 'feedback'}" tabindex="0" title="Recent Feedback">
          <svg class="tab-icon" viewBox="0 0 24 24">
            <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
          </svg>
        </div>
      </div>
    `;

    // 2. 根据选项卡渲染主体内容。feedback 那一档分两种：这一页有原生 Recent Feedback 就
    // 联动显隐它（面板不画主体），没有就自己画一份（成绩页／作业详情页就是这一种）
    const fbSelf = currentActiveTab === 'feedback' && !mcNativeFeedbackPresent();
    mcFbRenderedSelf = currentActiveTab === 'feedback' ? fbSelf : null;
    if (currentActiveTab !== 'feedback' || fbSelf) html += `<div class="custom-todo-tab-content">`;

    if (fbSelf) {
      html += mcFeedbackBodyHtml(cardTarget);
    } else if (currentActiveTab === 'announcements') {
      // ===== 喇叭选项卡：公告列表 =====
      const annInView = modernAnnouncements.filter(a => inViewWindow(a.date));
      const unreadAnnouncements = annInView.filter(a => !resolveLocalFlag(userAnnReadMap, a.id, a.readState === 'read'));
      const readAnnouncements = annInView.filter(a => resolveLocalFlag(userAnnReadMap, a.id, a.readState === 'read'));

      if (unreadAnnouncements.length === 0 && readAnnouncements.length === 0) {
        html += `
          <div class="bc-empty-state">
            ${mcReadingTodos() ? 'Loading...' : modernAnnouncements.length === 0 ? 'No announcements found' : 'Nothing in this range.'}
          </div>
        `;
      } else {
        if (unreadAnnouncements.length > 0) {
          html += `
            <div class="custom-todo-section-group">
              <div class="custom-todo-section-title" data-collapse-target="list_ann_unread">
                <span>UNREAD</span>
                <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </div>
              <div class="custom-todo-list-body" id="list_ann_unread">
                ${unreadAnnouncements.map(ann => `
                  <a class="custom-todo-card custom-todo-nav-card announcement-card" id="card_${ann.id}"${ann.url ? ` href="${ann.url}"` : ''}${cardTarget} style="--course-color: ${getCourseColor(ann.courseId, ann.course)}; cursor: pointer;">
                    <div class="custom-todo-card-left">
                      <div class="custom-todo-course-name">${mcCourseName(ann.courseId, ann.course)}</div>
                      <div class="custom-todo-card-title">${ann.title}</div>
                      <div class="custom-todo-card-footer">
                        <span class="custom-todo-date-subtext">${ann.date ? formatDueString(ann.date) : 'Recent'}</span>
                      </div>
                    </div>
                    <div class="custom-todo-check-circle" data-ann-id="${ann.id}" title="Mark as read" style="border-color: #9ca3af !important;"></div>
                  </a>
                `).join('')}
              </div>
            </div>
          `;
        }

        if (readAnnouncements.length > 0) {
          html += `
            <div class="custom-todo-section-group" style="margin-top: 12px;">
              <div class="custom-todo-section-title" data-collapse-target="list_ann_read">
                <span>READ</span>
                <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </div>
              <div class="custom-todo-list-body" id="list_ann_read">
                ${readAnnouncements.map(ann => `
                  <a class="custom-todo-card custom-todo-nav-card announcement-card completed" id="card_${ann.id}"${ann.url ? ` href="${ann.url}"` : ''}${cardTarget} style="--course-color: ${getCourseColor(ann.courseId, ann.course)}; cursor: pointer;">
                    <div class="custom-todo-card-left">
                      <div class="custom-todo-course-name">${mcCourseName(ann.courseId, ann.course)}</div>
                      <div class="custom-todo-card-title">${ann.title}</div>
                      <div class="custom-todo-card-footer">
                        <span class="custom-todo-date-subtext">${ann.date ? formatDueString(ann.date) : 'Recent'}</span>
                      </div>
                    </div>
                    <div class="custom-todo-check-circle filled" data-ann-id="${ann.id}" title="Mark as unread" style="background-color: #9ca3af; border-color: #9ca3af;">
                      <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:#fff;"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
                    </div>
                  </a>
                `).join('')}
              </div>
            </div>
          `;
        }
      }
    } else if (currentActiveTab === 'assignments') {
      // ===== 铅笔选项卡：MISSING 置顶（归这一档时），其余分阶梯：DUE TODAY, DUE TOMORROW, DUE IN X DAYS, DUE LATER =====
      const scheduledActive = activeAssignments.filter(item => !item.missing);
      const visibleActive = scheduledActive.filter(item => inViewWindow(item.due));
      if (missingForAssignments.length > 0) html += missingGroupHtml(missingForAssignments);
      if (scheduledActive.length === 0 && missingPool.length === 0) {
        html += `
          <div class="bc-empty-state">
            ${mcReadingTodos() ? 'Loading...' : 'No active tasks! You are all caught up.'}
          </div>
        `;
      } else if (visibleActive.length === 0 && missingForAssignments.length === 0) {
        html += `
          <div class="bc-empty-state">
            ${mcReadingTodos() ? 'Loading...' : 'Nothing due in this range.'}
          </div>
        `;
      } else if (visibleActive.length > 0) {
        // 标准分组排序规则
        const grouped = modernSetting('grouping') === 'on';
        const sectionOrder = ['DUE SOON', 'DUE TODAY', 'DUE TOMORROW'];
        const regularActive = visibleActive.filter(item => item.section !== 'DUE LATER');
        const dueLaterItems = visibleActive.filter(item => item.section === 'DUE LATER');

        // 统计所有出现的分组
        const sectionSet = new Set(regularActive.map(item => item.section));
        const sortedSections = Array.from(sectionSet).sort((a, b) => {
          const ia = sectionOrder.indexOf(a);
          const ib = sectionOrder.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        });

        // 关掉分组：合成一组不带标题的平铺列表，按到期日从近到远
        const groups = grouped
          ? sortedSections.map(title => ({ title, items: regularActive.filter(item => item.section === title) }))
          : [{ title: null, items: [...visibleActive].sort((a, b) => (a.due ? a.due.getTime() : 0) - (b.due ? b.due.getTime() : 0)) }];

        groups.forEach((group, sIdx) => {
          const secTitle = group.title;
          const items = group.items;
          if (items.length > 0) {
            const listId = 'list_asgn_' + sIdx;
            const isUrgent = secTitle === 'DUE TODAY' || secTitle === 'DUE SOON';
            html += `
              <div class="custom-todo-section-group">
                ${secTitle ? `<div class="custom-todo-section-title" data-collapse-target="${listId}">
                  <span>${secTitle}</span>
                  <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
                </div>` : ''}
                <div class="custom-todo-list-body" id="${listId}">
                  ${items.map(item => {
                    const dueStr = formatDueString(item.due);
                    return `
                      <a class="custom-todo-card custom-todo-nav-card" id="card_${item.id}"${item.url ? ` href="${item.url}"` : ''}${cardTarget} style="--course-color: ${item.color}; cursor: pointer;">
                        <div class="custom-todo-card-left">
                          <div class="custom-todo-course-name">${mcCourseName(item.courseId, item.course)}</div>
                          <div class="custom-todo-card-title">${mcEsc(item.title)}</div>
                          <div class="custom-todo-card-footer">
                            <span class="custom-todo-due-tag ${isUrgent ? '' : 'secondary'}">Due ${dueStr}</span>
                            <span class="custom-todo-pts">${item.points || '10pts'}</span>
                          </div>
                        </div>
                        <div class="custom-todo-check-circle" data-id="${item.id}" title="Mark as complete"></div>
                      </a>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }
        });

        // 底部 DUE LATER 折叠面板（关掉分组时这些条目已经在平铺列表里了）
        if (grouped && dueLaterItems.length > 0) {
          html += `
            <div class="custom-todo-due-later-row" id="custom-due-later-toggle" data-collapse-target="list_due_later">
              <span class="due-later-text">DUE LATER</span>
              <span class="due-later-badge">${dueLaterItems.length}</span>
              <svg class="due-later-arrow" viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
            </div>
            <div class="custom-todo-list-body collapsed" id="list_due_later" style="margin-top: 8px;">
              ${dueLaterItems.map(item => {
                const dueStr = formatDueString(item.due);
                return `
                  <a class="custom-todo-card custom-todo-nav-card" id="card_${item.id}"${item.url ? ` href="${item.url}"` : ''}${cardTarget} style="--course-color: ${item.color}; cursor: pointer;">
                    <div class="custom-todo-card-left">
                      <div class="custom-todo-course-name">${mcCourseName(item.courseId, item.course)}</div>
                      <div class="custom-todo-card-title">${mcEsc(item.title)}</div>
                      <div class="custom-todo-card-footer">
                        <span class="custom-todo-due-tag secondary">Due ${dueStr}</span>
                        <span class="custom-todo-pts">${item.points || '10pts'}</span>
                      </div>
                    </div>
                    <div class="custom-todo-check-circle" data-id="${item.id}" title="Mark as complete"></div>
                  </a>
                `;
              }).join('')}
            </div>
          `;
        }
      }
    } else if (currentActiveTab === 'completed') {
      // ===== 勾勾选项卡：MISSING 置顶（归这一档时），其余是已完成（跟随时间窗，默认 Week） =====
      const completedPool = completedAssignments.filter(item => inViewWindow(item.due));
      if (missingForCompleted.length > 0) html += missingGroupHtml(missingForCompleted);

      if (completedAssignments.length === 0 && missingForCompleted.length === 0) {
        html += `
          <div class="bc-empty-state">
            ${mcReadingTodos() ? 'Loading...' : 'No completed tasks yet. Check off an assignment to see it here!'}
          </div>
        `;
      } else if (completedPool.length === 0 && missingForCompleted.length === 0) {
        html += `
          <div class="bc-empty-state">
            ${mcReadingTodos() ? 'Loading...' : 'Nothing due in this range.'}
          </div>
        `;
      } else if (completedPool.length > 0) {
        // 倒序：到期最近的排最前，没有到期日的沉到组尾
        const byDueDesc = list => [...list].sort((a, b) => {
          const ta = a.due ? a.due.getTime() : -Infinity;
          const tb = b.due ? b.due.getTime() : -Infinity;
          return tb - ta;
        });
        const ungradedItems = byDueDesc(completedPool.filter(item => !item.isGraded));
        const gradedItems = byDueDesc(completedPool.filter(item => item.isGraded));

        if (ungradedItems.length > 0) {
          html += `
            <div class="custom-todo-section-group">
              <div class="custom-todo-section-title" data-collapse-target="list_ungraded">
                <span>UNGRADED</span>
                <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </div>
              <div class="custom-todo-list-body" id="list_ungraded">
                ${ungradedItems.map(item => {
                  const color = getCourseColor(item.courseId, item.course);
                  const dueStr = formatDueString(item.due);
                  return `
                    <a class="custom-todo-card custom-todo-nav-card completed-tab-card" id="card_${item.id}"${item.url ? ` href="${item.url}"` : ''}${cardTarget} style="--course-color: ${color}; cursor: pointer;">
                      <div class="custom-todo-card-left">
                        <div class="custom-todo-course-name">${mcCourseName(item.courseId, item.course)}</div>
                        <div class="custom-todo-card-title completed-title">${mcEsc(item.title)}</div>
                        <div class="custom-todo-card-footer">
                          <span class="custom-todo-due-tag secondary">Due ${dueStr}</span>
                          <span class="custom-todo-pts">${item.score || '-/' + item.points}</span>
                        </div>
                      </div>
                      <div class="custom-todo-check-circle filled" data-id="${item.id}" title="Click to unmark and restore to To-Do" style="cursor: pointer;">
                        <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:#fff;"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
                      </div>
                    </a>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }

        if (gradedItems.length > 0) {
          html += `
            <div class="custom-todo-section-group" style="margin-top: 14px;">
              <div class="custom-todo-section-title" data-collapse-target="list_graded">
                <span>GRADED</span>
                <svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </div>
              <div class="custom-todo-list-body" id="list_graded">
                ${gradedItems.map(item => {
                  const color = getCourseColor(item.courseId, item.course);
                  const dueStr = formatDueString(item.due);
                  return `
                    <a class="custom-todo-card custom-todo-nav-card completed-tab-card" id="card_${item.id}"${item.url ? ` href="${item.url}"` : ''}${cardTarget} style="--course-color: ${color}; cursor: pointer;">
                      <div class="custom-todo-card-left">
                        <div class="custom-todo-course-name">${mcCourseName(item.courseId, item.course)}</div>
                        <div class="custom-todo-card-title completed-title">${mcEsc(item.title)}</div>
                        <div class="custom-todo-card-footer">
                          <span class="custom-todo-due-tag secondary">Due ${dueStr}</span>
                          <span class="custom-todo-pts">${item.score || 'Graded'}</span>
                        </div>
                      </div>
                      <div class="custom-todo-check-circle filled" data-id="${item.id}" title="Click to unmark and restore to To-Do" style="cursor: pointer;">
                        <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:#fff;"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
                      </div>
                    </a>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }
      }
    }

    if (currentActiveTab !== 'feedback' || fbSelf) html += `</div>`;
    mcPaintedLoading = mcReadingTodos();
    return html;
  }

  // 折叠/展开动画：把 height 从当前渲染值过渡到 0（收起）或内容高（展开），
  // 结束后清掉行内 height 交回 CSS（展开=auto，收起=.collapsed 的 height:0）
  function animateCollapse(list, collapse) {
    if (!list) return;
    list.style.height = list.offsetHeight + 'px';
    void list.offsetHeight; // 强制回流，让过渡有起点
    if (collapse) {
      list.classList.add('collapsed');
      list.style.height = '0px';
    } else {
      list.classList.remove('collapsed');
      list.style.height = list.scrollHeight + 'px';
    }
    const done = () => {
      list.style.height = '';
      list.removeEventListener('transitionend', done);
    };
    list.addEventListener('transitionend', done);
  }

  // 切选项卡必须原子地重建面板：原生 Feedback 没有我们自己的内容容器，局部替换
  // 会留下旧的日期筛选锚点并让 body portal 的菜单定位失真。
  const TAB_INDEX = { announcements: 0, assignments: 1, completed: 2, feedback: 3 };

  function animateTodoListEnter(panel) {
    const content = panel && panel.querySelector('.custom-todo-tab-content');
    if (!content) return; // 原生 Feedback 由 Canvas 自己的容器显示，不能碰它的 DOM。
    const cards = [...content.querySelectorAll('.custom-todo-card')];
    cards.forEach((card, index) => {
      if (!card.animate) return;
      const animation = card.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
        {
          duration: 190,
          delay: Math.min(index, 4) * 20,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both'
        }
      );
      animation.onfinish = () => animation.cancel();
    });
  }

  function switchTab(targetTab) {
    if (!targetTab || targetTab === currentActiveTab) return;
    const prevTab = currentActiveTab;
    const oldSlider = document.querySelector('#mc-todo-panel .custom-todo-tab-slider');
    const oldSliderRect = oldSlider && oldSlider.getBoundingClientRect();
    currentActiveTab = targetTab;
    mcEnsureFeedback();
    updatePanelDom();
    const panel = document.getElementById('mc-todo-panel');
    const slider = panel && panel.querySelector('.custom-todo-tab-slider');
    if (slider && oldSliderRect && TAB_INDEX[prevTab] !== undefined) {
      const targetIndex = TAB_INDEX[targetTab];
      const finalRect = slider.getBoundingClientRect();
      const staticLeft = finalRect.left - targetIndex * finalRect.width;
      const from = oldSliderRect.left - staticLeft;
      const animation = slider.animate(
        [{ transform: 'translateX(' + from + 'px)' }, { transform: 'translateX(' + targetIndex * 100 + '%)' }],
        { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
      );
      animation.onfinish = () => animation.cancel();
    }
    animateTodoListEnter(panel);
    // iOS Safari does not expose vibration, so this remains a no-op there; supported
    // devices receive one short, restrained confirmation pulse.
    if (navigator.vibrate) navigator.vibrate(8);
  }

  // 点圆圈那一条链：待办面板和课程卡上那块 Tasks 共用这一份，所以两边点出来的结果一字不差。
  // 落点仍然由 mc_todo_canvas 那一档定（同步＝写 Canvas 的 planner override 并回读核对，
  // 只本地＝写 mc_todo_local）。调用方负责掐掉顺着 <a> 跳走那一下和"这一颗正在飞"的按不动
  async function mcTickAssignment(btn) {
    const id = btn.getAttribute('data-id');
    const done = !btn.classList.contains('filled');
    const item = mcAssignmentById(id);
    if (!mcCanvasSyncOn()) {
      // 只本地这一档：本地那颗 false 压不住 Canvas 自己标的完成（真交过的那批），
      // 所以这种条目本来就没有能取消的勾。宁可说一句，不要点下去看着没反应
      if (!done && item && item.isSubmitted) {
        mcTickLog('只本地这一档，这条是 Canvas 自己标的完成，点不动', item.title);
        mcTickOwnedByCanvas();
        return;
      }
      mcTickLog('同步关着，只写本地键', id, done);
      writeLocalFlag('mc_todo_local', id, done);
      updatePanelDom();
      return;
    }
    if (!item) {
      mcTickLog('列表里没有这条', id, '（缓存比服务器旧，先 Sync now）');
      mcTickFailed('gone');
      return;
    }
    btn.classList.add('mc-tick-pending');
    try {
      await mcSetCanvasOverride(item, done);
      item.isSubmitted = done;
      mcTickLog('面板已按成功刷新', item.title, done ? '→ 已完成' : '→ 退回待办');
      updatePanelDom();
    } catch (err) {
      btn.classList.remove('mc-tick-pending');
      mcTickLog('这一勾没写成，弹回去', err && err.message);
      mcTickFailed(err && err.message);
    }
  }

  // Focus 那一头只知道课程号和作业号，不知道这条在不在待办列表读到的那一窗口里。
  // 列表里有就照面板那颗原样走；没有就直接按号写 override，用的还是同一份 mcSetCanvasOverride。
  // 失败不回面板那句提示：Focus 要把这句话写在自己那块板子上，所以把结果还给调用方
  window.MCxTickForFocus = async function (courseId, assignmentId, title) {
    const id = String(assignmentId || '');
    if (!id) return { ok: false, error: 'no-assignment-id' };
    const item = mcAssignmentById(id);
    if (item && item.isSubmitted) return { ok: true, already: true };
    if (!mcCanvasSyncOn()) {
      writeLocalFlag('mc_todo_local', id, true);
      updatePanelDom();
      return { ok: true, local: true };
    }
    // 站点回包里没有这一条时按号新建：override 挂的就是作业 id，和面板那颗同一个落点
    const target = item || {
      id: id,
      title: title || 'this assignment',
      type: 'assignment',
      courseId: String(courseId || ''),
      overridePlannableId: id,
      overrideId: null,
      isSubmitted: false
    };
    try {
      await mcSetCanvasOverride(target, true);
      if (item) item.isSubmitted = true;
      mcTickLog('Focus 这一勾写成了', target.title);
      updatePanelDom();
      return { ok: true };
    } catch (err) {
      mcTickLog('Focus 这一勾没写成', err && err.message);
      return { ok: false, error: (err && err.message) || 'failed' };
    }
  };

  // 绑定面板事件
  function attachListeners(panel) {
    if (!panel) return;

    // 1. 卡片是真 <a href>：右键才有"在新标签页中打开／复制链接地址"，Ctrl+点击和中键也一起活。
    //    所以这里不再自己写跳转，只保证点打勾那颗时别顺着链接跳走。

    // 2. 切换选项卡
    panel.querySelectorAll('.custom-todo-tab').forEach(tab => {
      if (tab.dataset.todoTabBound === '1') return;
      tab.dataset.todoTabBound = '1';
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetTab = tab.getAttribute('data-tab');
        if (targetTab && targetTab !== currentActiveTab) {
          switchTab(targetTab);
        }
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        switchTab(tab.getAttribute('data-tab'));
      });
    });

    // 3. 打勾圆圈点击：切换 Assignment 完成状态
    panel.querySelectorAll('.custom-todo-check-circle[data-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // 圆圈整颗在 <a> 里面，不掐掉默认动作的话这一点同时会顺着卡片跳去作业页
        e.preventDefault();
        e.stopPropagation();
        if (btn.classList.contains('mc-tick-pending')) return;
        mcTickAssignment(btn);
      });
    });

    // 4. 打勾圆圈点击：切换 Announcement 已读/未读状态
    panel.querySelectorAll('.custom-todo-check-circle[data-ann-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        writeLocalFlag('mc_ann_read', btn.getAttribute('data-ann-id'), !btn.classList.contains('filled'));
        updatePanelDom();
      });
    });

    // 5. 分组标题点击：折叠 / 展开（带高度动画）
    panel.querySelectorAll('.custom-todo-section-title').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = header.getAttribute('data-collapse-target');
        const targetList = targetId ? panel.querySelector('#' + targetId) : null;
        if (!targetList) return;
        const willCollapse = !targetList.classList.contains('collapsed');
        header.classList.toggle('collapsed', willCollapse);
        animateCollapse(targetList, willCollapse);
      });
    });

    // 6. DUE LATER 折叠 / 展开（带高度动画）
    const dueLaterToggle = panel.querySelector('#custom-due-later-toggle');
    if (dueLaterToggle) {
      dueLaterToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = panel.querySelector('#list_due_later');
        if (!target) return;
        const willCollapse = !target.classList.contains('collapsed');
        dueLaterToggle.classList.toggle('expanded', !willCollapse);
        animateCollapse(target, willCollapse);
      });
    }

    // 7. 时间窗视图：菜单挂到 body 上，这里只管开合与翻页
    const viewBtn = panel.querySelector('.bc-view-btn');
    if (viewBtn) {
      viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (bcViewMenuOpen) closeViewMenu();
        else openViewMenu(viewBtn);
      });
    }
    panel.querySelectorAll('.bc-view-step[data-view-step]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        bcViewOffset += Number(btn.getAttribute('data-view-step'));
        // 先发起再画：它要重取的那一窗，画出来就该是"加载中"，而不是上一窗的名单；
        // 不用重取（那一窗本地已经有了）时它当场返回，下面那一帧照样把新窗口的名单画出来
        refetchForViewWindow();
        updatePanelDom();
      });
    });

    // 8. 反馈那一档读失败时的重试：重发那批请求，状态先回到 loading
    const fbRetry = panel.querySelector('.mc-fb-retry');
    if (fbRetry) {
      const go = (e) => {
        e.preventDefault();
        e.stopPropagation();
        mcFeedback = { state: 'idle', items: [], error: '' };
        mcFetchFeedback();
        updatePanelDom();
      };
      fbRetry.addEventListener('click', go);
      fbRetry.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      });
    }
  }

  // 点到别处收起视图菜单。菜单挂在 body 上，不能只靠 stopPropagation：Canvas
  // 有些页面会重派发 click，导致刚点 Week 打开的菜单被同一次点击立刻关掉。
  document.addEventListener('click', (event) => {
    if (!bcViewMenuOpen) return;
    const target = event.target;
    if ((bcViewMenu && bcViewMenu.contains(target)) || (bcViewAnchor && bcViewAnchor.contains(target))) return;
    closeViewMenu();
  });

  // =========================================================
  // 独立设置弹窗（居中卡片 + 模糊遮罩，不随 To-Do 面板重建）
  // =========================================================
  function ctsMenuHtml(key) {
    const meta = ctsMeta(key);
    const current = modernSetting(key);
    const check = '<svg class="cts-menu-check" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';
    return meta.options.map(opt => `
      <div class="cts-menu-item${opt === current ? ' selected' : ''}" data-value="${opt}">
        <span>${meta.text[opt]}</span>${opt === current ? check : ''}
      </div>`).join('');
  }




  // 一份主题落到我们那份快照里，只有这一条通路：设置里的 Import JSON、主题墙里的 Apply、
  // 还有自定义主题这三边共用，写进去的字段、用的翻译函数、开的开关全都一样
  function mcApplyThemeJson(j) {
    const snap = mcThemeFromJson(j);
    if (!Object.keys(snap.vars).length) throw new Error('no colours in this file');
    const prev = mcSnapshot();
    // base ＝这份主题本来的颜色；用户在 Colors 面板改的那几档（edits）永远盖在它上面。
    // 换一份主题＝正在用的那一格整格重来，你上一份的手改不保留（拍板：换主题就换该存档的色）。
    // 但"同一份主题再 Apply 一次"不算换主题：从 Customizer 进去改完贴图保存就是这一种
    // （两边那份 code 一样）。那种情况清了手改，会变成"我换了张图，拧过的色全没了"
    const sameTheme = !!(prev && prev.imported && snap.imported && snap.imported.code
      && prev.imported.code === snap.imported.code);
    snap.base = Object.assign({}, snap.vars);
    snap.edits = sameTheme ? Object.assign({}, prev.edits || {}) : {};
    if (sameTheme && prev.clearSlots) snap.clearSlots = Object.assign({}, prev.clearSlots);
    // 字体那一层和色同一口径：这一格自己挑过的那份留着，主题自带的那份跟着新记录走
    if (sameTheme && prev.fontEdit) snap.fontEdit = prev.fontEdit;
    // 保留下手改就得把这三样按新 base 重算一遍，不然快照里存的是"没拧过的样子"，
    // 下次加载面板上那颗圆点还亮着、页面上却是主题的原始色
    if (sameTheme && Object.keys(snap.edits).length) {
      snap.vars = Object.assign({}, snap.base, mcEditVars(snap.edits));
      snap.surfaces = mcSnapSurfaces(snap);
      mcApplyFontChannel(snap);
      snap.themeCss = mcThemeCss({ surfaces: snap.surfaces, cards: snap.cards || {}, vars: snap.vars });
    }
    // 停在 Canvas 那一档时挑主题＝落进存档一并切过去，不然点了 Apply 页面上什么都不动
    if (mcThemeOff()) mcSetTier('1');
    const text = JSON.stringify(snap);
    const key = mcSaveKey();
    try { localStorage.setItem(key, text); }
    catch (e) { console.log('[MCX] 存档存不下', e && e.name); }
    // 挑了一份主题＝要用我们的：页面那一层这一档当场翻回 Modern Canvas。
    // 不这么办就会出现他刚在墙上点了 Apply、页面却还归 External Extension 刷，看着像 Apply 没生效
    localStorage.setItem('bc_theme_owner', 'mc');
    // 深浅色这一档到这一格就按不动了（色由这份主题定），所以残留的 Dark 顺手复位成 Light，
    // 和设置里拧那颗色时的同一条口径（settings.js 的两处复位）。不复位的话面板上那颗还写着 Dark，
    // 而深色那套 token 会和主题的色抢侧栏那一层
    if (localStorage.getItem('bc_colour_mode') === 'dark') localStorage.setItem('bc_colour_mode', 'light');
    return snap;
  }

  /* 自定义主题（设置里 Themes 那一屏自己建的那一批）也走上面那条 mcApplyThemeJson：
     库里那份记录先由 theme-lib.js 翻译成同一份 JSON 形状，色膜、区域、贴图地址都在里面。
     贴图不进快照，快照里只有 mc-img:// 的引用 */
  function mcApplyCustomTheme(rec) {
    if (!window.mcLib) throw new Error('The theme library is not loaded on this page.');
    return mcApplyThemeJson(window.mcLib.buildThemeJson(rec));
  }




  // 可读性兜底真把文字压成纯黑/纯白时记下用的是哪个，设置弹窗顶上那条提示就靠它决定要不要出现
  let mcInkFix = '';
  // 上一轮取色算出来的那层磨砂底色（没算就是空）。设置顶上那块仿真照抄它，
  // 这样"行上那块方框"和"页面上那层底"是同一串数，不用在面板里再算一遍提亮和 alpha
  let mcLastFrost = '';
  // 每一档"还没过透明度之前"的那一串（链条算出来的原始值）。
  // 滑杆单独跑一趟时要拿它当底：读行内那串的话，行内已经是上一层 rgba，
  // 再乘一次就是二次透明，而且拧回 100 的时候没有原始值可还
  var mcTokenBase = {};



  // [BCP69] 它那颗齿轮是 <button> 里包一颗 svg.lucide-settings：没有 aria-label、没有 title、
  // 里面也没有文字，所以之前"按可访问名找齿轮"必然找不到。它的面板被我们收进隐藏容器后，
  // 直接派发事件点不动（它要自己可见），实测可行的顺序＝临时放行容器 → 补一整套
  // pointer 加 click → 立刻收回容器
  function bcSettingsGear() {
    // 优先扫 bettercampus-element（侧栏里的 Edit Canvas 齿轮），再扫 bettercampus-todo-list（待办列表上的齿轮）
    const hosts = [
      document.querySelector('bettercampus-element'),
      document.querySelector('bettercampus-todo-list'),
      document.querySelector('bettercampus-components')
    ].filter(Boolean);
    for (const host of hosts) {
      const root = host.shadowRoot;
      if (!root) continue;
      for (const svg of root.querySelectorAll('svg')) {
        const cls = String(svg.className && svg.className.baseVal !== undefined ? svg.className.baseVal : svg.className);
        if (cls.indexOf('lucide-settings') === -1) continue;
        const btn = svg.closest('button');
        if (btn) return btn;
      }
    }
    return null;
  }

  function clickBcGear() {
    const btn = bcSettingsGear();
    if (!btn) return false;
    const box = document.getElementById('mc-quarantine');
    const prev = box ? box.style.display : '';
    if (box) box.style.display = 'block';
    const r = btn.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + 6, clientY: r.top + 6, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const init = type.indexOf('pointer') === 0 ? Object.assign({ pointerId: 1, pointerType: 'mouse' }, base) : base;
      btn.dispatchEvent(type.indexOf('pointer') === 0 ? new PointerEvent(type, init) : new MouseEvent(type, init));
    }
    if (typeof btn.click === 'function') btn.click();
    if (box) box.style.setProperty('display', prev || 'none', 'important');
    return true;
  }

  // 放出来期间别再搬回去，否则 hideBcTodo 会在下一次 DOM 变动时立刻抢回来
  let bcPanelRevealed = false;

  function revealBcPanel() {
    const box = document.getElementById('mc-quarantine');
    const wrapper = document.getElementById('right-side-wrapper');
    const hosts = box ? [...box.querySelectorAll('bettercampus-todo-list')] : [];
    if (!wrapper || !hosts.length) return false;
    for (const el of hosts) wrapper.appendChild(el);
    box.remove();
    bcPanelRevealed = true;
    watchBcPopupClosed();
    console.log('[BCP28] 已把 External Extension 面板放回右侧栏，等它的设置弹窗关掉再收');
    return true;
  }

  // 它弹窗的宿主是 bettercanvas-portal（我们探针量过它平时是 0×0）。
  // 这里不看类名也不猜结构，只看几何：portal 的 shadow 里有没有一块高度超过 80 的东西
  function bcPopupOpen() {
    const portal = document.querySelector('bettercanvas-portal');
    const root = portal && portal.shadowRoot;
    if (!root) return false;
    return [...root.children].some(el => el.getBoundingClientRect().height > 80);
  }

  // 深度扫描 Shadow DOM 找到 BetterCampus 设置里的 Themes Tab 并模拟点击
  function clickBcThemesTab() {
    function findThemesButton(node) {
      if (!node) return null;
      if (node.shadowRoot) {
        const res = findThemesButton(node.shadowRoot);
        if (res) return res;
      }
      for (const el of node.querySelectorAll ? node.querySelectorAll('button, [role="tab"], div, span') : []) {
        if ((el.innerText || el.textContent || '').trim() === 'Themes') {
          return el;
        }
        if (el.shadowRoot) {
          const res = findThemesButton(el.shadowRoot);
          if (res) return res;
        }
      }
      return null;
    }

    const portal = document.querySelector('bettercanvas-portal') || document;
    const btn = findThemesButton(portal);
    if (btn) {
      const r = btn.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + 6, clientY: r.top + 6, button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const init = type.indexOf('pointer') === 0 ? Object.assign({ pointerId: 1, pointerType: 'mouse' }, base) : base;
        btn.dispatchEvent(type.indexOf('pointer') === 0 ? new PointerEvent(type, init) : new MouseEvent(type, init));
      }
      if (typeof btn.click === 'function') btn.click();
      return true;
    }
    return false;
  }

  function watchBcPopupClosed() {
    let sawOpen = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (!bcPanelRevealed) { clearInterval(timer); return; }
      if (bcPopupOpen()) sawOpen = true;
      else if (sawOpen) { bcPanelRevealed = false; clearInterval(timer); hideBcTodo(); console.log('[BCP28] 它的弹窗已关，面板收回去'); return; }
      // 三分钟兜底：万一它弹窗不是挂在 portal 里，我们看到的一直是"没开过"，也不能让它面板长住
      if (Date.now() - started > 180000) { bcPanelRevealed = false; clearInterval(timer); hideBcTodo(); console.log('[BCP28] 超过三分钟，面板收回去'); }
    }, 500);
  }



  // 首次使用弹一次：Better Campus 在跑、还没记过选择时才弹。默认＝两套都显示，
  // 这一屏只是问他要不要把重复的那份收走。记过之后不再弹，改主意走设置里那颗开关。
  let bcTodoPopupHandled = false;
  function maybeShowBcTodoPrompt() {
    if (!isTopWindow) return;
    if (bcTodoPopupHandled) return;
    if (localStorage.getItem('bcx_bc_todo_asked') === '1') return;
    if (/\/calendar(\/|$)/.test(location.pathname)) return;
    if (!document.getElementById('right-side-wrapper')) return;
    // 只要检测到 Better Campus 活着（无论组件元素还是样式注入）
    const bcPresent = !!document.querySelector('bettercampus-todo-list, bettercampus-element, bettercampus-components, style[id^="bettercampus"], style[id^="bettercanvas"]');
    if (!bcPresent) return;
    if (document.getElementById('mc-bctodo-overlay')) return;
    openBcTodoPrompt();
  }

  function closeBcTodoPrompt() {
    const overlay = document.getElementById('mc-bctodo-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 240);
  }

  function openBcTodoPrompt() {
    bcTodoPopupHandled = true;
    const overlay = document.createElement('div');
    overlay.id = 'mc-bctodo-overlay';
    overlay.className = 'bc-modal-overlay';
    overlay.innerHTML = `
      <div class="bc-modal-card" role="dialog" aria-label="ToDo list">
        <div class="bc-modal-title">We see that you have Better Campus installed</div>
        <div class="bc-modal-note">Both extensions add a ToDo list, so this page shows two of them right now. Pick which one you want to keep.</div>
        <div class="cts-sync-btn" data-bctodo="hide">Use our ToDo list</div>
        <div class="mc-bctodo-alt" data-bctodo="show">Keep both ToDo lists</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    overlay.querySelectorAll('[data-bctodo]').forEach(btn => {
      btn.addEventListener('click', () => {
        const show = btn.getAttribute('data-bctodo') === 'show';
        localStorage.setItem('bcx_bc_todo', show ? '1' : '0');
        localStorage.setItem('bcx_bc_todo_asked', '1');
        closeBcTodoPrompt();
        hideBcTodo();
        // 答完 ToDo 弹窗后，立刻检查并唤起 Theme 弹窗（如果还没问过）
        setTimeout(() => maybeShowBcThemePrompt(), 300);
      });
    });
  }

  // 首次检测到 Better Campus 在跑时问一次：页面那一层（整页底色、侧栏那张图、卡片上的图、字体）归谁刷。
  // 和上面那颗 ToDo 弹窗同一套规矩：记过选择就不再打扰，改主意走设置里 Theme 那一档。
  // 这一句对所有人都问，不管他有没有选过主题：没选过的人更要问，答完"用我们的"才顺着把他带到主题墙
  // ToDo 那颗还开着的时候不叠第二张：两张同屏会盖住彼此，等那张答完下一趟再问
  let bcThemePopupHandled = false;
  function maybeShowBcThemePrompt() {
    if (!isTopWindow) return;
    if (bcThemePopupHandled) return;
    if (localStorage.getItem('mc_theme_asked') === '1') return;
    const bcLive = document.documentElement.classList.contains('mc-bc-live') ||
      !!document.querySelector('style[id^="bettercampus"], style[id^="bettercanvas"], bettercanvas-portal, bettercampus-components, bettercampus-element');
    if (!bcLive) return;
    if (document.getElementById('mc-bctodo-overlay')) return;
    if (document.getElementById('mc-themeowner-overlay')) return;
    openBcThemePrompt();
  }

  function closeBcThemePrompt() {
    const overlay = document.getElementById('mc-themeowner-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 240);
  }

  function openBcThemePrompt() {
    bcThemePopupHandled = true;
    const overlay = document.createElement('div');
    overlay.id = 'mc-themeowner-overlay';
    overlay.className = 'bc-modal-overlay';
    overlay.innerHTML = `
      <div class="bc-modal-card" role="dialog" aria-label="Theme">
        <div class="bc-modal-title">We see that you have Better Campus installed</div>
        <div class="bc-modal-note">Both extensions can paint the same page, and two themes on one page can disagree. Pick whose theme you want to see.</div>
        <div class="cts-sync-btn" data-bctheme="mc">Use Modern Canvas theme</div>
        <div class="mc-bctodo-alt" data-bctheme="bc">Use Better Campus theme</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    overlay.querySelectorAll('[data-bctheme]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mine = btn.getAttribute('data-bctheme') === 'mc';
        localStorage.setItem('bc_theme_owner', mine ? 'mc' : 'bc');
        localStorage.setItem('mc_theme_asked', '1');
        closeBcThemePrompt();
        // 贴不贴是取色那一趟现算的，当场跑一趟，不等它那 2 秒的轮询
        mcStep('applyModernPalette', () => applyModernPalette());
        // 两种答案都把设置开在主题墙那一屏：让他一眼看到这儿有多少份可以挑。
        // 选了它的也没关系——他在这屏挑一份、或者在 Colours 拧一颗色，那一档当场自己翻回我们
        document.dispatchEvent(new CustomEvent('mc-open-theme-picker'));
      });
    });
  }

  // =========================================================
  // 左侧全局主导航：设置项搬到这里，并接管底部那颗收起/展开
  // =========================================================

  /* 那两句提示的整串标记在 nav-boot.js（造那一行时就要写进去），下面那两处"Canvas 重渲染把
     我们那层摘掉了，补回来"的退路直接读它，不再抄一遍：
     那颗提示：展开态在 "Settings" 下面另起一行写整句话，收起那一列只有 74 像素宽，
     字由 CSS 藏掉、只剩一颗点（色跟左边标签同源，走 --mc-nav-ink）
     照明不一致那句：字是空的，每轮按当前那一档填进去，所以不会出现"他翻了档、侧栏还在说另一种模式"。
     这颗不接点：它只说"两边要对齐"，对齐要去哪一颗开关，Settings 那一行本身就会带他进面板 */

  function mcLightingWord() {
    const name = mcOurLighting() === 'dark' ? 'Dark' : 'Light';
    return 'You need to have BetterCampus and Modern Canvas set to the same lighting for '
      + name + ' mode to apply.';
  }

  // 那颗在 Canvas 各版本里换过 id 和类名，可访问名一直是 "Minimize global navigation"。
  // 认法整份搬进 nav-boot.js 了（侧栏行序引擎要用它认下区那个宿主，那份排在 document_start，
  // 不能反过来等这里），这颗只是转调
  function navToggleEl() {
    return window.mcNav ? window.mcNav.toggle() : null;
  }

  function navMinimized() {
    return document.documentElement.classList.contains('mc-nav-min');
  }

  // 侧栏底部那颗：图标右边要有一行常驻的字（跟上面几行一样），可访问名跟着这行字走。
  // 造壳和翻字整份在 nav-boot.js（那边排在 document_start，收起那颗的字首帧就要有），这里只转调
  function syncNavToggleLabel() {
    if (window.mcNav) window.mcNav.syncToggleLabel();
  }

  // BC 在跑时钉了一条 `#header{width:var(--bcsidebarwidth)!important}`（180px），带 id 的权重压过
  // 我们所有只写类名的规则，收起态钉不回 74px；而它还会删掉我们注入的 <style> 节点（实测两次），
  // 所以样式表这条路在它面前不可靠。宽度由我们写成行内 !important，值直接读 --bc-nav-w
  // （CSS 里那一档已经跟着 mc-nav-min 切换），BC 不在跑时把行内撤掉，交回 CSS
  //
  // 同一批行内 !important 还要钉住可见和可点。它压我们导航那条是
  // `html:not([data-bc-nav-restore]) #header > :not(External Extension-element){opacity:0;pointer-events:none}`
  // 带 id，权重也压过我们样式表里所有只写类名的规则；它自己那套接管逻辑随时会把 data-bc-nav-restore
  // 摘掉重挂（实测：我们只在取色那一轮补一次，最慢 2 秒才补回来）。这个窗口里我们的行就是
  // 看不见也点不动——他报的"hover 特效没了、第二次点了打不开、要再点一次"就是撞上这一枪。
  // pointer-events 会往下继承、opacity 不会但父层为 0 时子层再亮也没用，所以钉在 #header 的直属子节点上
  // 它压制 Canvas 导航（也就是压制我们那套）只靠一条规则：
  // html:not([data-bc-nav-restore]) #header > :not(External Extension-element){opacity:0;pointer-events:none}
  // 它自己留了这个属性当开关，我们挂上它就不压了，我们的导航重新可见。
  // BC 一关就摘掉，不把它的开关留在页面上——但"它这一页到底有没有东西"看的是现场事实，
  // 不看那个会被冻结带走的判定，否则冻结一响我们就等于亲手把导航交回给它摁着。
  function mcNavRestore(bcOnPage) {
    const root = document.documentElement;
    if (bcOnPage) {
      if (!root.hasAttribute('data-bc-nav-restore')) root.setAttribute('data-bc-nav-restore', '');
    } else if (root.hasAttribute('data-bc-nav-restore')) {
      root.removeAttribute('data-bc-nav-restore');
    }
  }

  let mcInkReadAt = 0;

  function pinOurNav() {
    const header = document.getElementById('header') || document.querySelector('.ic-app-header');
    if (!header) return;
    const live = document.documentElement.classList.contains('mc-bc-live');
    const want = live ? getComputedStyle(document.documentElement).getPropertyValue('--bc-nav-w').trim() : '';
    const now = header.style.getPropertyValue('width');
    if (want && now !== want) header.style.setProperty('width', want, 'important');
    else if (!want && now) header.style.removeProperty('width');
    /* 可见和可点这两条以前只在"判定 BC 在跑"时才钉。那就是把自己绑在那个 2 秒一轮的判定上：
       BC 插表的那一刻判定还没翻过来，它那条 opacity:0 已经生效，侧栏就整块看不见（他报的
       "刷新以后啥也不显示"）。现在不分场合一律钉住——我们没有任何一条规则需要把 #header 的
       直属子节点调成半透明，所以钉着不会挡自己的事；BC 真不在时这一行也只是 1 和 auto */
    for (const kid of header.children) {
      if (!kid.style || kid.tagName === 'BETTERCAMPUS-ELEMENT') continue;
      for (const prop of ['opacity', 'pointer-events']) {
        const wantVal = prop === 'opacity' ? '1' : 'auto';
        if (kid.style.getPropertyValue(prop) === wantVal) continue;
        kid.style.setProperty(prop, wantVal, 'important');
      }
    }
    // 图标颜色不自己定档：读站点那一行标签实际算出来的色，写成变量给 style.css 用。
    // 标签是谁画的都行（学校的表、BC 的表、我们抄来的主题都行），图标就永远跟它一个色。
    // 只有底部那颗的文字要摘掉：它自己就是吃 --mc-nav-ink 画的，读它会把这个变量绕回自己身上
    // 答题那一屏不读这一颗：那一页每敲一个字都在重排，这里多一次 getComputedStyle 就是去抢那一帧。
    // 上面那三条行内钉子照旧要钉，它们只读写 style 属性，不碰布局
    if (MCX_QUIET_PAGE) return;
    /* [实测 2026-10-11 日历页] 下面这一次 getComputedStyle 是"读排在写之后"＝强制整页重算
       （这一页一次全页重算实测 69–83ms），而这一趟 300 毫秒排一次，等于每秒抢三枪主线程。
       那颗色只有换主题／BC 换皮才会动，所以给它一道 1500 毫秒的闸：同一趟里被重复叫醒
       （bcxOnBcChrome、setNavMinimized 也点 pinOurNav）一律不重读。
       读到的值照旧走"连续两趟同色才落笔"那一条，两半互不干扰 */
    if (performance.now() - mcInkReadAt < 1500) return;
    mcInkReadAt = performance.now();
    const lab = header.querySelector(
      '.ic-app-header__menu-list-item:not(.ic-app-header__menu-list-item--active) .menu-item__text:not(.mc-nav-toggle-text)');
    if (lab) {
      const ink = getComputedStyle(lab).color;
      const have = document.documentElement.style.getPropertyValue('--mc-nav-ink');
      if (!have && ink) {
        window.__mcxInkPending = null;
        mcSetRootVar('--mc-nav-ink', ink);
      } else if (!ink || ink === have) {
        window.__mcxInkPending = null;
      } else if (window.__mcxInkPending === ink) {
        // [实测 2026-10-06 收件箱页读数] pinOurNav 单趟 118 毫秒：往 :root 写自定义属性会把整页
        // 引用 --mc-* 的规则全部重算一遍。读到的色在两趟之间来回摆时，就成了每秒两三次的全页重算。
        // 所以要求同一个色连续读到两趟才落笔，摆动的值永远写不进去。
        window.__mcxInkPending = null;
        mcSetRootVar('--mc-nav-ink', ink);
      } else {
        window.__mcxInkPending = ink;
      }
    }
  }

  // 把站点原生 <select> 换成我们自己的圆角下拉：这套逻辑已整段搬到 theme-boot.js（document_start）。
  // 原先放在这里（content.js 是 document_idle），成绩页的 Quarter 选择器要等这份跑完才被包成胶囊，
  // 中间会闪一帧原生方框。搬到 document_start 的观察器里就能在 select 插入的同一微任务包好，闪不出来。
  // 这里不再留副本，避免两份各改各的。

  function setNavMinimized(on) {
    document.documentElement.classList.toggle('mc-nav-min', on);
    localStorage.setItem('mc_nav_min', on ? '1' : '0');
    // 栏一收起来，两节的列表在窄栏里是整块藏掉的（style.css 那两条 display:none），
    // 标题那颗箭头还指着"已展开"就是假状态。所以这一趟顺手把两节折回去
    if (on) navCollapseSections();
    pinOurNav();
    syncNavToggleLabel();
    // 卡片墙按容器实际宽度给坐标，导航让出来的这 126px 要重排。
    // 等收起动画跑完再量，中途量到的是过渡中的宽度，会排出一列错的列宽
    setTimeout(mcMasonryLayout, 380);
  }

  function navCollapseSections() {
    for (const sec of document.querySelectorAll('.mc-nav-courses, .mc-nav-bc')) {
      if (sec.classList.contains('mc-collapsed')) continue;
      sec.classList.add('mc-collapsed');
      const head = sec.querySelector('.mc-nav-courses-head, .mc-nav-bc-head');
      if (head) head.setAttribute('aria-expanded', 'false');
    }
  }

  // 折叠态（只剩图标那一档）里点 Courses / External Extension 这两节的标题：先把侧栏展开，再展开这一节。
  // 列表在 74px 里放不下（style.css 那两条 display:none 就是为这个），而用户点这一下要的就是列表本身，
  // 栏宽只是它的前提，所以让这次点击顺手把栏带开，而不是把列表塞窄
  function navRevealList() {
    if (navMinimized()) setNavMinimized(false);
  }

  // 侧栏那颗 Settings：造壳和摆位置在 nav-boot.js（首帧就要有这一行），这一趟只补两处
  // 每轮会变的字，和量一次底部那颗的高度给 CSS 当 Settings 的下边距
  function mountNavSettingsItem() {
    if (window.mcNav) window.mcNav.ensureRows();
    const li = document.querySelector('.mc-nav-settings-item');
    if (!li) return;
    const anchor = window.mcNav ? window.mcNav.settingsMount().anchor : null;
    /* 那一行提示（点＋"You have two themes activated"）：两套主题同时在刷这一页时才看得见
       （露不露归 CSS 的 html.mc-theme-clash 管，收起态由 CSS 把字藏掉只留点）。
       点它＝"我要去看怎么定"，所以除了开面板还要落到 Theme 那一档——面板本身由 settings.js
       在捕获阶段接整行点开，这里只补"落到哪一档"那一步。
       老节点里没有就补一个：这一行是我们造的，Canvas 重渲染换了爹得自己补回来 */
    const link = li.querySelector('.mc-nav-settings-link') || li;
    if (!link.dataset.mcSettingsBound) {
      link.dataset.mcSettingsBound = '1';
      link.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.mc-nav-clash')) return;
        try { link.blur(); } catch (_) {}
        if (window.mcSettingsPanel && typeof window.mcSettingsPanel.toggle === 'function') {
          window.mcSettingsPanel.toggle();
        } else if (window.mcSettingsPanel && typeof window.mcSettingsPanel.open === 'function') {
          window.mcSettingsPanel.open();
        }
      });
    }
    let clash = li.querySelector('.mc-nav-clash');
    if (!clash) {
      const wrap = document.createElement('div');
      wrap.innerHTML = window.mcNav.CLASH_HTML;
      clash = wrap.firstChild;
      link.appendChild(clash);
    }
    if (!clash.dataset.mcBound) {
      clash.dataset.mcBound = '1';
      clash.addEventListener('click', () => document.dispatchEvent(new CustomEvent('mc-open-theme-owner')));
    }
    /* 照明不一致那句（第 37 节）：造法照上面那颗 clash 抄——每轮补一次，Canvas 重渲染换了爹自己补回来。
       字每轮按当前那一档填，所以不会出现"他翻了档、侧栏还在说另一种模式"。这颗不接点：
       它只说"两边要对齐"，对齐去哪颗开关，Settings 那一行本身就会带他进面板。
       露不露归 html.mc-lighting-clash 管（CSS 默认 display:none），所以节点常驻不碍事 */
    let lighting = li.querySelector('.mc-nav-lighting');
    if (!lighting && window.mcNav) {
      const lwrap = document.createElement('div');
      lwrap.innerHTML = window.mcNav.LIGHTING_HTML;
      lighting = lwrap.firstChild;
      link.appendChild(lighting);
    }
    if (lighting) {
      const lword = lighting.querySelector('.mc-nav-lighting-word');
      if (lword) lword.textContent = mcLightingWord();
    }
    document.documentElement.classList.toggle('mc-lighting-clash', mcLightingClash());
    // 这一行在列表里排到哪儿都不决定它在屏幕上的位置——CSS 把它 fixed 到导航栏底部了。
    // 但 DOM 里它得紧跟在正常那几行后面，Tab 键的顺序才是" Grades 之后是 Settings"。
    // 底部那颗多高量一次就够：CSS 要拿它顶出 Settings 的下边距。
    // 只认一颗 <li>，而且量出整块导航那种高度就不钉：这个值是量一次就锁在行内样式上的，
    // 认错了宿主一次就整页都歪着（收起那颗一行 44px，超过 120 就不可能是它）
    if (anchor && anchor.tagName === 'LI' && !li.style.getPropertyValue('--mc-nav-foot-h')) {
      const h = Math.round(anchor.getBoundingClientRect().height);
      if (h > 8 && h < 120) li.style.setProperty('--mc-nav-foot-h', h + 'px');
    }
    syncNavToggleLabel();
  }

  // 收集表（Google 表单）。改地址只动这一行
  const BCX_REPORT_BUG_URL = 'https://forms.gle/sjxgESmtHWQ9S6XH6';

  // Settings 上面那颗 Report a bug：点了开一张新标签去填收集表。
  // 造壳／摆位置／那颗开关关掉时摘掉，全在 nav-boot.js（和 Settings 那一行同一趟），这里只转调
  function mountNavReportItem() {
    if (window.mcNav) window.mcNav.ensureRows();
  }

  // ===== 侧栏课程手风琴 =====
  // 独立可折叠的 Courses 分区，挂在现有导航按钮下方（顶部那排按钮不碰、不折叠）。
  // 每门课一行：色点 + 名字 + 箭头；展开是五个跳转（Home/Modules/Files/Assignments/Grades）。
  // 数据走 /api/v1/courses，五个链接按 Canvas 固定路径拼，不额外请求。
  // 分区那颗箭头和标题图标跟着壳一起搬进 nav-boot.js 了，画课程行时读它那份（同一个数）
  const BCX_COURSE_LINKS = [
    { label: 'Home', path: '' },
    { label: 'Modules', path: '/modules' },
    { label: 'Files', path: '/files' },
    { label: 'Assignments', path: '/assignments' },
    { label: 'Grades', path: '/grades' }
  ];
  let mcSidebarCourseList = null;
  let mcSidebarCoursesLoading = false;

  function mcEsc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* =========================================================
     ===== 侧栏那一列行的自定义：顺序／显隐／上下区 =====
     一份 mc_nav_layout_v1 管这三件事。没存过时引擎一行都不搬，所以默认就是你现在看到的这一版，
     只有你在设置里排完并点 Apply 之后它才开始动手（Apply 会重读页面，侧栏只在刷新那一刻变成新顺序，
     不存在"拖一半被我们搬回去"那种撞车）。

     键怎么取：站点那几行用它们自己的地址（换一所学校、行上的文字被改，只要地址没变顺序还在），
     没地址的那两颗（Search、Help）用行上的文字；我们自己造的四行用固定名。

     上下区就是两个宿主，不是 CSS 定位：上区是导航列表（新版 #ic-app-header__menu-list、
     老版 #menu），下区是收起那颗所在的那一层——Settings 和 Report a bug 今天就插在那一层、
     排在收起那颗前面，收起那颗永远留在最后（下区那两行的下边距是量它的高度算的）。

     引擎本体在 nav-boot.js（排在 document_start 那一组，为的是首帧就摆好，见那份文件开头）。
     这一节剩下的是界面那一半：设置里那一屏的草稿、存盘、恢复默认。
     ========================================================= */
  // 键名跟着 nav-boot.js 走：那一份按这颗读布局，两边各写一个字面量就是存的和读的不是同一格
  const BCX_NAV_LAYOUT_KEY = (window.mcNav && window.mcNav.KEY) || 'mc_nav_layout_v1';
  // 不给藏的两颗：Settings 是打开这座面板唯一的入口，收起那颗是下区的锚
  const BCX_NAV_NO_HIDE = ['ours:settings', 'nav:toggle'];
  // 我们自己造的那四行：现场没挂上来（被藏了、或这一页还没挂）也要在草稿里占一格，
  // 不然"藏起来"就变成"设置里再也找不到它"
  const BCX_NAV_OURS = [
    { k: 'ours:bc', label: 'BetterCampus' },
    { k: 'ours:courses', label: 'Courses list' },
    { k: 'ours:report', label: 'Report a bug' },
    { k: 'ours:study', label: 'Study With AI' },
    { k: 'ours:settings', label: 'Settings' }
  ];

  /* 引擎本体（认宿主／认键／读现场／摆顺序）整份在 nav-boot.js，那边排在 document_start，
     这样导航列表一插进 DOM 就按他排好的先后画，不会先闪几秒 Canvas 自己那个顺序
     （这份是 document_idle）。下面三颗只是转调，签名和以前一样，这一节往后的用法一行没改。
     window.mcNav 读不到只发生在嵌进别人页面的那一帧：那里压根没有 #menu，
     返回空清单／没有布局可读，和以前"找不到就一行不动"的结果是同一个 */
  function mcNavLive() {
    return window.mcNav ? window.mcNav.live() : [];
  }

  function mcNavLayout() {
    return window.mcNav ? window.mcNav.layout() : null;
  }

  // 设置那一屏的草稿：存过的按存的顺序摆，页面上新冒出来、没存过的补在末尾（上区）
  function mcNavDraft() {
    const live = mcNavLive();
    const byKey = {};
    live.forEach(r => { byKey[r.k] = r; });
    const rows = [];
    const used = {};
    const oursLabel = {};
    BCX_NAV_OURS.forEach(o => { oursLabel[o.k] = o.label; });
    (mcNavLayout() || []).forEach(r => {
      if (!r || used[r.k] || r.k === 'nav:toggle') return;
      // 节点不在了也照样留一格：藏起来的行（我们自己那四行是整颗摘掉的）要是从清单里消失，
      // 他就再也没有地方把它勾回来
      if (!byKey[r.k] && !oursLabel[r.k]) return;
      used[r.k] = 1;
      rows.push({ k: r.k,
        label: oursLabel[r.k] || (byKey[r.k] && byKey[r.k].label) || r.k,
        zone: r.zone === 'bottom' ? 'bottom' : 'top',
        on: r.on !== 0 && r.on !== false });
    });
    live.forEach(r => {
      if (used[r.k] || r.k === 'nav:toggle') return;
      used[r.k] = 1;
      // 标签优先用我们那份：站点那行也叫 Courses，两颗挤在一起分不清是谁
      rows.push({ k: r.k, label: oursLabel[r.k] || r.label, zone: r.zone, on: true });
    });
    return rows;
  }

  // 摆位置那一半也在 nav-boot.js（见上面那三颗转调的注释）。这一颗每轮在四行各自挂好之后跑，
  // 所以引擎跑起来时我们自己那几行已经在现场了，摆出来的是完整那一版
  function mcApplyNavLayout() {
    if (window.mcNav) window.mcNav.apply();
  }

  /* 设置里那一档现在拖一下就落盘、勾一下就落盘，不等 Apply 也不刷新页面，所以"把行摆成新顺序"
     这一趟得由存盘自己叫：面板开着的时候那条 300 毫秒的合并轮询是停的
     （mcSettingsPanelOpen 挡的），不叫它就得等关掉面板之后才补跑，那一段就是"拖了怎么没动"。
     这一串和 mcUiPass 头上那五行是同一批、同一顺序：先把行挂齐，再摆顺序 */
  function mcNavApplyNow() {
    mcStep('mountNavSettingsItem', () => mountNavSettingsItem());
    mcStep('mountNavReportItem', () => mountNavReportItem());
    mcStep('mountSidebarCourses', () => mountSidebarCourses());
    mcStep('mountBcPagesSection', () => mountBcPagesSection());
    mcStep('mcApplyNavLayout', () => mcApplyNavLayout());
  }

  /* 存：整份草稿写进那一个键，并把两颗旧开关跟着改写一次，
     省得"列表里勾掉了、设置里那颗开关还亮着"这种两处不一致 */
  function mcNavSave(rows) {
    const out = (rows || []).map(r => ({ k: r.k, zone: r.zone === 'bottom' ? 'bottom' : 'top',
      on: r.on === 0 || r.on === false ? 0 : 1 }));
    localStorage.setItem(BCX_NAV_LAYOUT_KEY, JSON.stringify(out));
    const flag = k => { const r = out.find(x => x.k === k); return r ? r.on : 1; };
    localStorage.setItem('mc_nav_report_bug', String(flag('ours:report')));
    localStorage.setItem('mc_sidebar_courses', String(flag('ours:courses')));
    localStorage.setItem('mc_ai_entry', String(flag('ours:study')));
    mcNavApplyNow();
    return out;
  }

  function mcNavReset() {
    localStorage.removeItem(BCX_NAV_LAYOUT_KEY);
    // 恢复默认是整栏的事：抽屉里那列课程的先后和"藏了哪几门"也一起清掉
    localStorage.removeItem(BCX_NAV_COURSE_ORDER_KEY);
    localStorage.removeItem(BCX_NAV_COURSE_HIDE_KEY);
  }

  /* 抽屉里课程的先后和显隐，两份都在设置那一屏里改，Apply 之后重读页面才生效。
     顺序存 id 数组：没排过的课按名字排在排过的后面（新选的课不该插到中间去）。
     名字不在这里：那一格归 Course info 那屏（见 mcCourseName）。 */
  const BCX_NAV_COURSE_ORDER_KEY = 'mc_nav_course_order';
  const BCX_NAV_COURSE_HIDE_KEY = 'mc_nav_course_hide';

  function mcNavCourseOrder() {
    try {
      const ids = JSON.parse(localStorage.getItem(BCX_NAV_COURSE_ORDER_KEY) || '[]');
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch (e) { return []; }
  }

  function mcNavCourseHidden() {
    try {
      const ids = JSON.parse(localStorage.getItem(BCX_NAV_COURSE_HIDE_KEY) || '[]');
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch (e) { return []; }
  }

  function mcSortSidebarCourses(list) {
    const order = mcNavCourseOrder();
    if (!order.length || !list) return list || [];
    const rank = {};
    order.forEach((id, i) => { rank[id] = i; });
    return list.slice().sort((a, b) => {
      const ra = rank[String(a.id)];
      const rb = rank[String(b.id)];
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  // 设置那一屏读这份：按现在的先后排好，带上现在这一栏会显示的名字和有没有被勾掉。
  // 勾掉的那几门照样在这一屏里占一格，否则他再也没有地方把它勾回来
  function mcNavCourseRows() {
    const hidden = {};
    mcNavCourseHidden().forEach(id => { hidden[id] = 1; });
    return mcSortSidebarCourses(mcSidebarCourseList || []).map(c => ({
      id: String(c.id), name: mcCourseName(c.id, c.name), on: !hidden[String(c.id)]
    }));
  }

  function mcNavCourseSave(order, hidden) {
    localStorage.setItem(BCX_NAV_COURSE_ORDER_KEY, JSON.stringify((order || []).map(String)));
    localStorage.setItem(BCX_NAV_COURSE_HIDE_KEY,
      JSON.stringify([...new Set((hidden || []).map(String))]));
    // 落盘之后当场重画那一列：抽屉里的行是按这份排的，等下一轮轮询就是"拖了没动"。
    // 课程还没读回来时不动那份 null，它一回来自己会排（mcLoadSidebarCourses 头上）
    if (mcSidebarCourseList) mcSidebarCourseList = mcSortSidebarCourses(mcSidebarCourseList);
    renderSidebarCourses();
    return true;
  }

  async function mcLoadSidebarCourses() {
    if (mcSidebarCourseList || mcSidebarCoursesLoading) return;
    mcSidebarCoursesLoading = true;
    try {
      // enrollment_state=active：Canvas 默认会把过往学期/已结束的选课也带回来，只留在读的课
      const r = await fetch('/api/v1/courses?enrollment_state=active&per_page=100', { credentials: 'same-origin' });
      if (r.ok) {
        const raw = await r.json();
        mcSidebarCourseList = mcSortSidebarCourses((raw || [])
          .map(c => ({ id: String(c.id), name: c.name || c.course_code || ('Course ' + c.id) }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      }
    } catch (e) {}
    mcSidebarCoursesLoading = false;
    renderSidebarCourses();
  }

  // 折叠栏里那一行要放课程图。Canvas 自己一门课都没传封面（实测 /api/v1/courses 和单课详情里
  // 连 image_download_url 这个字段都不存在），所以图只能取主题给这门课配的首页卡图：
  // 快照里是 cards[课程id].img = url("…")，剥掉这层 url() 壳才是能塞进 <img> 的地址
  function modernCourseImg(id) {
    const rec = mcCardSnapshot && mcCardSnapshot[String(id)];
    const raw = rec && rec.img;
    if (!raw || raw === 'none') return '';
    const m = String(raw).match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
    return m ? m[1] : '';
  }

  function sidebarCourseRowHtml(c) {
    const links = BCX_COURSE_LINKS.map(l =>
      '<a class="menu-item__text mc-course-link" href="/courses/' + c.id + l.path + '">' + mcEsc(l.label) + '</a>'
    ).join('');
    // 整行照抄 Canvas 一行：li.ic-app-header__menu-list-item > a.ic-app-header__menu-list-link
    // + .menu-item__text。这样 44px 行高、hover 底板、主题的标签色全部自动命中。
    // 展开区分两层：外层 .mc-course-sub-inner 只管缩放/淡入动画（不能带 link 类，否则被 transform:none 锁死）；
    // 内层 .mc-course-sub-theme 挂 link 类，只为让主题的 .ic-app-header__menu-list-link .menu-item__text 标签色够到子链接
    // 图位只有配了封面的课才有：没配图的那门课连这个节点都不画，名字照旧直接贴到行的左内边距
    // 课程行不再画那颗封面图：这一列每行都要是纯文字，图标统一去掉。
    // 名字＝Course info 那一屏给这门课起的名字，没起过就是 Canvas 那句
    return '<li class="ic-app-header__menu-list-item mc-nav-course">'
      + '<a class="ic-app-header__menu-list-link mc-course-row" role="button" tabindex="0" aria-expanded="false">'
      + '<span class="menu-item__text">' + mcEsc(mcCourseName(c.id, c.name)) + '</span>'
      + '<span class="mc-course-caret">' + window.mcNav.CHEVRON_RIGHT + '</span>'
      + '</a>'
      + '<div class="mc-course-sub"><div class="mc-course-sub-inner">'
      + '<div class="mc-course-sub-theme ic-app-header__menu-list-link">' + links + '</div>'
      + '</div></div>'
      + '</li>';
  }

  function renderSidebarCourses() {
    const sec = document.querySelector('.mc-nav-courses');
    if (!sec) return;
    const list = sec.querySelector('.mc-nav-courses-list');
    if (!list) return;
    if (!mcSidebarCourseList) {
      if (!list.querySelector('.mc-nav-courses-empty')) list.innerHTML = '<div class="mc-nav-courses-empty">Loading…</div>';
      return;
    }
    // 签名＝哪几门课上屏 + 各自现在显示的那句名字。只记课程数的话，换一套带卡图的主题时行不会重建，
    // 折叠栏里就还是光秃秃那一行字（这一层挂在轮询上，每 500ms 会进来一次，不能空转重写）。
    // 名字也算进签名：Course info 那一屏改完是当场落盘的，这一栏要跟着换，不等刷新
    const hidden = {};
    mcNavCourseHidden().forEach(id => { hidden[id] = 1; });
    const shown = mcSidebarCourseList.filter(c => !hidden[String(c.id)]);
    const sig = shown.map(c => c.id + '|' + mcCourseName(c.id, c.name)).join(',');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = shown.map(sidebarCourseRowHtml).join('');
  }

  function mountSidebarCourses() {
    // 壳和那颗"关掉就摘掉"的开关在 nav-boot.js；这一趟负责第一次挂上点击、和把课程填进去
    if (window.mcNav) window.mcNav.ensureRows();
    const sec = document.querySelector('.mc-nav-courses');
    if (!sec) return;
    if (!sec.dataset.mcNavBound) {
      sec.dataset.mcNavBound = '1';
      const head = sec.querySelector('.mc-nav-courses-head');
      const toggleSection = () => {
        navRevealList();
        const collapsed = sec.classList.toggle('mc-collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
      };
      head.addEventListener('click', toggleSection);
      // 课程行是 innerHTML 重建的，点击用委托挂在分区这一层，重建后仍然有效
      sec.addEventListener('click', e => {
        const row = e.target.closest ? e.target.closest('.mc-course-row') : null;
        if (!row) return;
        const course = row.closest('.mc-nav-course');
        if (!course) return;
        const open = course.classList.toggle('open');
        row.setAttribute('aria-expanded', String(open));
      });
      // 行和标题都是 <a role=button>，没 href 时回车不自动变 click，键盘补一条
      sec.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const t = e.target;
        if (t === head) { e.preventDefault(); toggleSection(); return; }
        if (t.closest && t.closest('.mc-course-row')) { e.preventDefault(); t.click(); }
      });
    }
    renderSidebarCourses();
    if (!mcSidebarCourseList) mcLoadSidebarCourses();
  }

  // ===== 侧栏里的 External Extension 分组（Planner / Study / Notes / Grades）=====
  // 这四页是它自绘侧栏里的行，跳转形状＝站内根路径加一个查询参数（External Extensionpage=…）。
  // 但实测（[BCP70]）：把地址栏直接改成那个参数再整页刷新，它不认，只有它自己的点击路由认。
  // 所以我们不跳网址，改成在它的 shadow DOM 里找到那颗 <a> 替用户点一下（同 [BCP69] 那颗齿轮）。
  // 整组只在 BC 在跑时出现（html.mc-bc-live 门控在 style.css 第 5 节末尾），BC 一关四行一起消失。
  // 那四行的壳和名单跟着造壳一起搬进 nav-boot.js 了

  // 它那颗 <a> 在 External Extension-element 的 shadow root 里；顺手把别的宿主也扫一遍，
  // 它哪天换容器不至于整组失灵
  function bcPageLink(key) {
    const hosts = ['bettercampus-element', 'bettercampus-components', 'bettercanvas-sidebar'].map(t => document.querySelector(t));
    for (const h of hosts) {
      const root = h && (h.shadowRoot || h);
      if (!root || !root.querySelectorAll) continue;
      const hit = [...root.querySelectorAll('a[href]')].find(a => (a.getAttribute('href') || '').indexOf('bettercampuspage=' + key) !== -1);
      if (hit) return hit;
    }
    return null;
  }

  // BC 的自绘侧栏藏不掉：它会重写自己宿主的 style 属性（我们写进去的行内 display 一次就被抹掉），
  // 还会删掉 head 里它不认识的 <style> 节点，所以"藏起来"的写法活不过它下一次自愈
  // （他看到的"过 3～7 秒又变回它的"）。唯一它改不了的是它爹是谁——整颗搬进我们的隐藏容器，
  // 和压它待办面板同一招。实测搬完 20 多秒它没有再造一颗，不构成拉锯；仍给次数封顶做保险。
  // 【已停用，留着备查】下面这套"搬进隐藏容器"实测会让它自己把那四行页面链接卸载掉
  // （shadow 从 366 个节点掉到 137，Not found 就是这么来的），所以改成 style.css 里的原地透明化。
  // 不再被任何地方调用；要回退就把 mcStep('hideBcSidebar', …) 加回去。
  let mcSidebarMoves = 0;

  function hideBcSidebar() {
    const el = document.querySelector('#header > bettercampus-element');
    if (!el) return;
    if (mcSidebarMoves >= 20) return;
    let box = document.getElementById('mc-nav-quarantine');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mc-nav-quarantine';
      box.style.setProperty('display', 'none', 'important');
      document.body.appendChild(box);
    }
    if (el.parentElement === box) return;
    box.appendChild(el);
    mcSidebarMoves++;
    console.log('[BCP72] 已把 External Extension 的侧栏搬进隐藏容器，第', mcSidebarMoves, '次');
  }

  // 它那颗齿轮实测只认一整套 pointer＋mouse＋click（只派发 click 它不动），这里同一套写法。
  // 它的侧栏现在是"原地透明化"（style.css 的 mc-bc-live 那组），元素还在 #header 里、也有尺寸，
  // 所以这些链接照样能派发（之前把它整颗搬进隐藏容器，它自己把那四行卸载了，链接根本不存在）
  function dispatchBcClick(link) {
    const r = link.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: (r.left || 20) + 6, clientY: (r.top || 20) + 6, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const init = type.indexOf('pointer') === 0 ? Object.assign({ pointerId: 1, pointerType: 'mouse' }, base) : base;
      link.dispatchEvent(type.indexOf('pointer') === 0 ? new PointerEvent(type, init) : new MouseEvent(type, init));
    }
  }

  function clickBcPageLink(link) { dispatchBcClick(link); }

  // 它那四行只在它自己侧栏「Show hidden」展开的状态下存在（收起时 shadow 里一条都扫不到）。
  // 借不到就替它点一下那颗展开，等它渲染完再找一次
  function bcExpandHiddenGroup() {
    const host = document.querySelector('bettercampus-element');
    const root = host && host.shadowRoot;
    if (!root) return false;
    const btn = [...root.querySelectorAll('button,a,[role=button]')].find(e => /show hidden/i.test((e.textContent || '').trim().slice(0, 20)));
    if (!btn) return false;
    dispatchBcClick(btn);
    return true;
  }

  // 它那个全屏页画在 test-element 的 shadow 里：一层 fixed 盒子＋一个跨域 iframe（ext.External Extension.com）。
  // 宿主自己是 0×0，所以"它到底开没开"不能读宿主尺寸（我这么量过一次，量出假的"没开"）。
  // 改成看屏幕正中是不是被它盖住——这也正是用户看得见的那件事：它开着的时候我们那四行在它底下，
  // 连点都点不到（实测 elementFromPoint 命中的就是 test-element）
  function bcPageOpen() {
    const host = document.querySelector('test-element');
    if (!host) return false;
    // 命中屏幕正中那一颗，往上爬（跨过 shadow 边界靠 root.host），爬到它＝它盖住了画面＝开着
    let node = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
    for (let d = 0; d < 14 && node; d++) {
      if (node === host) return true;
      const root = node.getRootNode ? node.getRootNode() : null;
      node = node.parentElement || (root && root.host) || null;
    }
    return false;
  }

  function openBcPage(row) {
    const key = row.dataset.mcPage;
    const label = row.querySelector('.menu-item__text');
    // 借不到／没打开都别静默失败：这一行的文字临时换成提示，两秒半后换回来
    const flash = text => {
      if (!label || row.dataset.mcBusy) return;
      row.dataset.mcBusy = label.textContent;
      label.textContent = text;
      setTimeout(() => {
        label.textContent = row.dataset.mcBusy;
        delete row.dataset.mcBusy;
      }, 2500);
    };
    // 它随时可能把导航压成不可点（那一枪落下来我们这行连 click 都收不到），
    // 所以先把行内 !important 钉回去再派发
    pinOurNav();
    let looked = 0;
    const send = link => {
      let tries = 0;
      const check = () => {
        if (bcPageOpen()) return;
        if (++tries > 2) { flash('Not opened'); return; }
        // 它自己那份"开没开"的状态会留在已开（实测：关掉它之后地址还停在 ?External Extension=open），
        // 这一枪打过去它只是把状态又设成关，画面什么都没发生——所以要补到真的开出来
        clickBcPageLink(link);
        setTimeout(check, 700);
      };
      setTimeout(check, 700);
      clickBcPageLink(link);
    };
    const look = () => {
      const link = bcPageLink(key);
      if (link) { send(link); return; }
      // 它那四行只在它侧栏「Show hidden」展开时存在：第二趟还找不到就替它点开再等
      if (looked === 1 && !bcExpandHiddenGroup()) { flash('Not found'); return; }
      if (++looked > 4) { flash('Not found'); return; }
      setTimeout(look, 250);
    };
    look();
  }

  // BC 在跑时把它的自绘侧栏挪到屏幕外，屏幕上是我们的导航。
  // 为什么是"挪走"而不是"遮掉"：display / opacity / visibility / 摘节点四种写法全被它顶回来，
  // 连行内 !important 都压得住（实测，见 style.css 第 [BCP72] 条），只有换个爹它没办法。
  // 挪走不影响借它的链接开页面：实测挪到屏幕外之后它展开的那四行照样在（167×32），点 Planner 地址照切。
  // 注意别指望把容器尺寸传给宿主：它 :host{all:initial!important} 在级联里排在我们文档 !important 之上，
  // 宿主实测 0×0，那四行在不在只看它自己「Show hidden」开没开，跟容器尺寸无关。
  // 次数封顶只是防拉锯（它 10 秒内会自己再造一颗）。以前是"一共 60 次，用完就永久不管"，
  // 于是标签页开得够久就会看见它那一套侧栏停在屏上（他报的这一种）。
  // 现在改成按时间放行：头 12 次不限速，往后每 20 秒允许再挪一次——它再造一颗，最迟 20 秒回去
  let mcParkMoves = 0;
  let mcParkAt = 0;

  function parkBcSidebar(force) {
    const el = document.querySelector('bettercampus-element');
    if (!el) return;
    const now = Date.now();
    if (!force && mcParkMoves >= 12 && now - mcParkAt < 20000) return;
    let box = document.getElementById('mc-offscreen');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mc-offscreen';
      document.body.appendChild(box);
    }
    if (el.parentElement === box) return;
    box.appendChild(el);
    mcParkMoves++;
    mcParkAt = now;
    if (mcParkMoves <= 6) console.log('[BCP73] 已把 External Extension 的侧栏挪到屏幕外，第', mcParkMoves, '次');
  }

  function mountBcPagesSection() {
    // 壳在 nav-boot.js（四行首帧就在，露不露归 CSS 的 html.mc-bc-live 管）。
    // 这一趟补两件事：BC 到底在不在跑（它那颗元素本来就晚半秒才出现），和第一次挂上点击
    if (window.mcNav) window.mcNav.ensureRows();
    const sec = document.querySelector('.mc-nav-bc');
    if (!sec) return;
    // 只要它那颗侧栏元素还在（被我们挪到屏幕外也算在），这四行就借得到：
    // 它自己把「Show hidden」收起来时那四行会暂时不在，openBcPage 会先替它点开再找一次。
    // 元素整个不在＝BC 没在跑，这时整组不出现
    sec.classList.toggle('mc-nav-bc-none', !document.querySelector('bettercampus-element'));
    if (sec.dataset.mcNavBound) return;
    sec.dataset.mcNavBound = '1';
    sec.addEventListener('click', e => {
      const head = e.target.closest ? e.target.closest('.mc-nav-bc-head') : null;
      if (head) {
        navRevealList();
        const collapsed = sec.classList.toggle('mc-collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
        return;
      }
      const row = e.target.closest ? e.target.closest('.mc-bc-row') : null;
      if (row) openBcPage(row);
    });
    sec.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target;
      if (!t.closest) return;
      const head = t.closest('.mc-nav-bc-head');
      if (head) { e.preventDefault(); head.click(); return; }
      const row = t.closest('.mc-bc-row');
      if (row) { e.preventDefault(); row.click(); }
    });
  }

  // 原生那颗点了没反应：它靠给 .ic-app-header 加 --minimized 类来收窄，而我们的导航宽是
  // !important 的 200px、文字层也被钉成常驻，它那一套收起样式全部被压平。
  // 这里在事件链路最外层截下来自己接管，状态记在我们自己的键上，不再依赖它那个类
  document.addEventListener('click', (e) => {
    const toggle = navToggleEl();
    if (!toggle || !toggle.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setNavMinimized(!navMinimized());
  }, true);



  document.addEventListener('click', (e) => {
    if (!openReportBugAt(e.target)) return;
    e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!openReportBugAt(e.target)) return;
    e.preventDefault();
  });

  // 用户手势里开新标签，浏览器不会拦；返回 false 表示这一下不是点在我们那颗上
  function openReportBugAt(node) {
    const link = node && node.closest ? node.closest('.mc-nav-report-link') : null;
    if (!link) return false;
    window.open(BCX_REPORT_BUG_URL, '_blank');
    return true;
  }

  setNavMinimized(localStorage.getItem('mc_nav_min') === '1');

  // 判断当前是否处于做测验/考试（Take Quiz）页面：
  // 例如 /courses/300107/quizzes/1025556/take，做题界面不展示待办，避免干扰
  function isTakingQuiz() {
    return /\/quizzes\/[^\/]+\/take(_quiz)?(\/|$)/i.test(location.pathname)
      || (location.pathname.includes('/quizzes/') && /\/take(\/|$)/i.test(location.pathname))
      || !!document.getElementById('submit_quiz_form');
  }

  // 右侧栏里那几块"侧栏配件"：学校 logo、被我们顶掉的原生 To Do、Recent Feedback
  // （含选项卡隐藏态），以及整块只有一排 button-sidebar-wide 链接的（仪表盘的 View Grades、
  // 课程 home 的 View Course Stream/Calendar/Notifications）。这些排在面板上面没意义。
  // 判据是在真实页面上量出来的：仪表盘／课程 home 的右侧栏除这些以外是空的，
  // 成绩页那块 #student-grades-right-content（Total、What-If、Show All Details）
  // 里面混着非 button-sidebar-wide 的按钮，所以不会被当成配件。
  const MC_SIDEBAR_FURNITURE = '.ic-sidebar-logo, .Sidebar__TodoListContainer, .todo-list, ' +
    '[class*="TodoList"], [data-testid="todo-list"], .recent_feedback, [class*="feedback"]';

  /* 空壳不算内容：作业页那台没有提交记录时，#right-side 里只剩一颗空的 #sidebar_content
     （实测 240x20，里面一个字符都没有），它既没文字也没图形，却把面板挤到第二格，
     再叠上 style.css 那条 24px 上边距，于是 Hub 的顶边比页面标题低一截。
     Dashboard 那一屏右侧栏本来就是空的，所以只有这一页看着没事。 */
  function isEmptySidebarShell(el) {
    return !el.textContent.trim() &&
      !el.querySelector('img, svg, video, canvas, iframe, table, a, button, input, select');
  }

  function isSidebarFurniture(el) {
    if (el.matches(MC_SIDEBAR_FURNITURE) || el.classList.contains('bc-tab-feedback-hidden')) return true;
    if (isEmptySidebarShell(el)) return true;
    const links = el.querySelectorAll('a, button');
    if (links.length === 0) return false;
    return [...links].every(a => a.classList.contains('button-sidebar-wide'));
  }

  // 右侧栏里页面自己的内容（成绩汇总、作业分数与提交记录、测验尝试结果）
  function nativeSidebarContent(rightSide) {
    return [...rightSide.children].filter(el =>
      el.id !== 'mc-todo-panel' &&
      !el.matches('bettercampus-todo-list, #mc-bctodo-overlay') &&
      !isSidebarFurniture(el)
    );
  }

  // 判断当前页面是否应让原生侧边栏内容置顶：作业详情页（/courses/:id/assignments/:id）与
  // 测验详情页（/courses/:id/quizzes/:id）的原生栏里有分数和提交记录，必须排在面板上面
  function shouldPrioritizeNativeSidebar() {
    if (/\/courses\/\d+\/(assignments|quizzes)\/\d+/i.test(location.pathname)) return true;
    const rightSide = document.getElementById('right-side');
    if (!rightSide) return false;
    return !!rightSide.querySelector('.submission-details, #quiz-summary, .quiz-summary, #quiz_history, .quiz-history, [class*="submission-details"]');
  }

  // 待办面板排版定位：右侧栏只要有页面自己的内容，面板就排到它下面；
  // 只剩侧栏配件（或整栏本来就空的）才回到第一位。
  // 上一版只认作业/测验详情页那一条判据，成绩页（/courses/:id/grades/:id）不在里面，
  // 于是 902px 高的面板把 Total 和那几颗按钮整块推到折叠屏以下
  function placeModernCanvasTodoPanel(panel, rightSide) {
    let content = nativeSidebarContent(rightSide);
    if (content.length === 0 && shouldPrioritizeNativeSidebar()) {
      // 作业/测验详情页那两档是他验过的画面，配件判据万一在那两屏判错，照旧排到原生内容之后
      // （空壳除外：它不是"判错的配件"，它就是没东西，排到它下面只会把面板顶低一截）
      content = [...rightSide.children].filter(el =>
        el.id !== 'mc-todo-panel' &&
        !el.matches('bettercampus-todo-list, #mc-bctodo-overlay') &&
        !el.classList.contains('bc-tab-feedback-hidden') &&
        !isEmptySidebarShell(el));
    }
    if (content.length > 0) {
      const lastNative = content[content.length - 1];
      if (panel.previousElementSibling !== lastNative) {
        lastNative.after(panel);
      }
      return;
    }
    if (rightSide.firstChild !== panel) {
      rightSide.insertBefore(panel, rightSide.firstChild);
    }
  }

  /* 这一页有没有那一列，看的是量到的尺寸，不是节点存不存在。
     新版那一屏 #right-side 那个壳还在，但整列没摆出来（宽度 0、或者被推到屏幕外）：
     往里挂等于挂在一个看不见的地方。
     只卡宽度和位置，不卡高度——那一列本来就是空的时候量出来就是几十像素。
     2026-10-16 hcpss 作业页实测：#right-side 240x20、display:block、里面只有一颗空的
     #sidebar_content，正是"该给我们站"的那一格；上一版把 height>60 也加进来，
     于是大批作业页的 Hub 面板整个不见了（他报"很多地方的 hub 面板都没掉了"）。 */
  function mcSidebarVisible(el) {
    if (!el) return false;
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 120) return false;
    return r.right > 8 && r.left < (window.innerWidth || 1280) - 40;
  }

  // 顶层挂载入口
  function renderModernCanvasTodoList() {
    if (!isTopWindow) return;
    // 日历页（全局 /calendar 和课程内 /courses/x/calendar）不挂面板：
    // 主体本来就是日程，右侧再摆一份待办是重复信息
    if (/\/calendar(\/|$)/.test(location.pathname)) return;
    // 做测验/考试界面不挂面板，若已被挂载则移除
    if (isTakingQuiz()) {
      const panel = document.getElementById('mc-todo-panel');
      if (panel) panel.remove();
      return;
    }
    const rightSide = document.getElementById('right-side');
    if (!mcSidebarVisible(rightSide)) return;

    let panel = document.getElementById('mc-todo-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mc-todo-panel';
      panel.className = 'custom-todo-panel';
      panel.innerHTML = buildPanelHtml();
      attachListeners(panel);
      placeModernCanvasTodoPanel(panel, rightSide);
      syncFeedbackTabView();
      // 上一站停在反馈档、这一页又没有原生块时，首帧画的是 loading，这里把请求发出去
      mcEnsureFeedback();

      // 初次挂载时启动 API 抓取
      fetchPlannerData();
    } else {
      placeModernCanvasTodoPanel(panel, rightSide);
    }
  }

  /* 两颗键叫的是同一个抽屉、同一屏"写信"，不一样的只有落点和带不带作业：
     成绩页那颗＝在整门课里挑几条作业；提交详情页那颗＝锁在这一条上。
     板子和 Print Grades 同款走的是 mc-plate-btn 那一档（成绩页那颗由 theme-boot 第 4 步的名单补，
     我们自己建的这颗直接带上，同一份样式表规则，不写第二套）；
     墨色那条行内 !important 是照 theme-boot 的 inkOn 抄的，样式表那条压不住站点主按钮配白字的写法。
     图标取侧栏 AI 那一行同一份路径（window.MCxIcon.ai），不另描一份；
     那颗不能带 .icon-printer，否则站点会再画一台打印机在字前面。 */
  function mcTeacherBtnAt(row, id, label, courseId, panelOpts) {
    // AI 总开关关掉：这两颗（成绩页 Message Your Teacher、提交详情页 Ask Your Teacher）都不该在，
    // 已经挂在页面上的那颗也当场摘掉，不等他重新载入
    if (window.mcAiOn && !window.mcAiOn()) {
      const gone = document.getElementById(id);
      if (gone) gone.remove();
      return;
    }
    let btn = document.getElementById(id);
    if (!btn) {
      btn = document.createElement('a');
      btn.id = id;
      btn.className = 'Button mc-plate-btn mc-message-teacher';
      btn.href = '#';
      const ai = (window.MCxIcon && window.MCxIcon.ai) || '';
      btn.innerHTML = (ai ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + ai + '"/></svg>' : '') +
        '<span>' + label + '</span>';
      btn.style.setProperty('color', 'var(--mc-text-0)', 'important');
      row.appendChild(btn);
    } else if (btn.parentElement !== row) {
      // 站点把那一行重渲染过：只把自己挪回去，不重建（重建会打断正悬在上面那只手）
      row.appendChild(btn);
    }
    if (btn.dataset.mcxBound) return;
    btn.dataset.mcxBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.MCxStudy) return;
      window.MCxStudy.open(courseId, panelOpts);
    });
  }

  // 每门课成绩页顶部那颗 Print Grades 右边的 Message Your Teacher。
  // 落点是在他页面上量到的：a#print-grades-button 住在 #print-grades-button-container
  // （.ic-Action-header__Secondary，一条右对齐的行）里面，我们排在它后面，
  // 那条行自己就把 Print Grades 往左挪了，不用另算位置。
  function mcMessageTeacherBtn() {
    if (!/^\/courses\/\d+\/grades(\/|$)/i.test(location.pathname)) return;
    const print = document.getElementById('print-grades-button');
    const row = print && (print.closest('#print-grades-button-container') || print.parentElement);
    if (!row) return;
    const m = location.pathname.match(/\/courses\/(\d+)/i);
    mcTeacherBtnAt(row, 'mc-message-teacher-btn', 'Message Your Teacher',
      m ? Number(m[1]) : 0, { mode: 'teacher' });
  }

  /* 提交详情页那一颗 Ask Your Teacher，落在抬头那一行的成绩格右边。
     [实测 2026-10-10 /courses/296970/assignments/14752971/submissions/473100]
     .submission-details-header__heading-and-grades 本来就是 display:flex，
     里面 1457x49：H1 "Submission Details" 1339 宽＋DIV.submission-details-header__grade-summary 119 宽，
     所以 append 一颗进去就贴着成绩排，不用另算位置。
     作业名从 h2.submission-details-header__heading 拿（同一颗类名有两份：H1 是页名、H2 才是作业名），
     它只是名单里认不到这一条时的退路，正常一路是 API 那一行 */
  function mcAskTeacherBtn() {
    const m = location.pathname.match(/^\/courses\/(\d+)\/assignments\/(\d+)\/submissions\//i);
    if (!m) return;
    const row = document.querySelector('.submission-details-header__heading-and-grades');
    if (!row) return;
    const nameEl = document.querySelector('h2.submission-details-header__heading');
    mcTeacherBtnAt(row, 'mc-ask-teacher-btn', 'Ask Your Teacher', Number(m[1]),
      { mode: 'teacher', assignmentId: Number(m[2]), assignmentName: nameEl ? String(nameEl.textContent).trim() : '' });
  }

  // 每一步单独包起来，而且要用箭头函数转一手：
  // mcStep('x', x) 这种写法是在把参数交出去之前就去读 x 这个标识符，
  // 函数不存在时抛的 ReferenceError 发生在 try 外面，罩不住，整个 IIFE 照样死
  // （fitBareNavIcons 被删掉之后就是这么把面板挂载一起带走的）。
  // 写成 () => x() 之后，读不到名字这件事本身才会落进 try 里
  // ===== 我们给站点补的那套 UI，多久补一趟 =====
  // 站点是 React 的，一秒能报几十批 DOM 变动。以前每报一批就把下面整串跑一遍，
  // 实测：载入后前 20 秒里每 3 秒有 539 毫秒是长任务，20 秒那档轮询一停只剩 70 毫秒。
  // 所以改成"变动只记账，300 毫秒合并跑一趟"。
  // 取色（applyModernPalette）和瀑布流（mcMasonryLayout）不放进这一串：
  // 它们各自有 2 秒／1.5 秒的慢轮询，而且比这一串里任何一步都贵，挂在变动上等于把贵的那步放大几十倍
  // Dashboard 的 List view 顶部那颗 Today：原生只写 "Today"，看不出要点什么。
  // 日历页那颗同名按钮已经由 dressCalendarToolbar 改成 "Jump to Today"，这一颗是另一套组件
  // （InstUI 的 #planner-today-btn，文字在它内层 span[class$="-baseButton__children"] 身上），
  // 所以单独补一次。React 重渲染会把文字换回去，判据就是"只有正好是 Today 才改"，
  // 已经改过的那一趟读回来是 "Jump to Today"，不再动它
  function dressPlannerToolbar() {
    const btn = document.querySelector('#planner-today-btn');
    if (btn) {
      const label = btn.querySelector('[class$="-baseButton__children"]') || btn;
      if (label.textContent.trim() === 'Today') label.textContent = 'Jump to Today';
    }
    // Schedule 那一屏下面那颗是同一件东西换了个挂载点（#weekly-header-active-button，
    // 站点自己给它挂了 data-testid="jump-to-today-button"）。这颗身上叠着一层 1x1 的
    // 读屏文字，可见那层反而是 aria-hidden 的 span，所以只能点名可见那层改：
    // 整颗写 textContent 会把读屏那层洗掉
    const wk = document.querySelector('#weekly-header-active-button');
    if (!wk) return;
    const faces = wk.querySelectorAll('span[aria-hidden="true"]');
    for (let i = 0; i < faces.length; i++) {
      const s = faces[i];
      if (s.childElementCount === 0 && s.textContent.trim() === 'Today') s.textContent = 'Jump to Today';
    }
  }

  // =========================================================================
  // 轻量高性能智能文字对比度引擎（精准作用于用户自定义富文本和测验/作业描述）
  // 1. 绝不扫描 #content / #main / modules / grades 巨型列表，消除 Layout Thrashing
  // 2. 带 data-bcx-contrast-done 防重复标记，避免轮询重复运算
  // 3. 智能判断底色：坐落在暗底上采用 --mc-text-0，坐落在自排版浅色白底上采用深色
  // =========================================================================
  let mcContrastRunning = false;

  function adaptContentTextContrastScoped() {
    if (localStorage.getItem('mc_smart_contrast') === '0') return;
    if (!document.documentElement.classList.contains('mc-themed') || mcContrastRunning) return;
    
    // 性能守卫：如果本页压根没有富文本或作业/测验描述容器，0 开销立即返回，绝不在讨论/模块/成绩等大页面做全树扫描
    const container = document.querySelector('.user_content, .quiz_description, #submission_details, .submission_details');
    if (!container) return;
    
    // 严密限制在自定义内容容器内
    const targets = document.querySelectorAll(`
      .user_content p:not([data-bcx-contrast-done]),
      .user_content span:not([data-bcx-contrast-done]),
      .user_content h1:not([data-bcx-contrast-done]),
      .user_content h2:not([data-bcx-contrast-done]),
      .user_content h3:not([data-bcx-contrast-done]),
      .user_content h4:not([data-bcx-contrast-done]),
      .user_content h5:not([data-bcx-contrast-done]),
      .user_content li:not([data-bcx-contrast-done]),
      .quiz_description p:not([data-bcx-contrast-done]),
      .quiz_description span:not([data-bcx-contrast-done]),
      #submission_details p:not([data-bcx-contrast-done]),
      #submission_details span:not([data-bcx-contrast-done]),
      .submission_details p:not([data-bcx-contrast-done]),
      .submission_details span:not([data-bcx-contrast-done])
    `);
    if (!targets.length) return;

    mcContrastRunning = true;
    try {
      // 快速判断是否有显式白底/亮底祖先（优先从 inline style 快速匹配，若需 getComputedStyle 限制最多向上 3 层）
      const isOverLightBg = el => {
        // 如果当前元素位于我们已经铺了暗色卡底的容器中，绝不判定为亮底！
        if (el.closest('.mc-dp-card, .mc-dp-card')) return false;

        let cur = el;
        let depth = 0;
        while (cur && depth < 3 && cur !== document.body && cur !== document.documentElement) {
          if (cur.style && cur.style.backgroundColor) {
            const s = cur.style.backgroundColor.toLowerCase();
            if (s === '#fff' || s === '#ffffff' || s === 'white' || s.includes('255, 255, 255')) return true;
          }
          const bg = window.getComputedStyle(cur).backgroundColor;
          const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (m) {
            const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
            if (a > 0.2) {
              const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
              const lum = 0.2126 * (r/255) + 0.7152 * (g/255) + 0.0722 * (b/255);
              return lum > 0.5; // 明亮背景
            }
          }
          cur = cur.parentElement;
          depth++;
        }
        return false;
      };

      // 每次分批最多处理 60 个，完全不占用渲染主线程
      const batch = Array.from(targets).slice(0, 60);
      for (const node of batch) {
        node.dataset.mcContrastDone = '1';
        if (node.querySelector('p, div, table, ul, ol')) continue;
        if (node.closest('button, [class*="-pill"], .btn, svg, a')) continue;

        if (isOverLightBg(node)) {
          node.style.setProperty('color', '#1f2937', 'important');
        } else {
          node.style.setProperty('color', 'var(--mc-text-0)', 'important');
        }
      }

    } finally {
      mcContrastRunning = false;
    }
  }

  // 教学大纲正文里老师自己勾了"卡片底"的那几块（DesignPlus 排的）：白底既不在行内 style 也没有类名，
  // 是 designplus 那张外部表按 id 铺的（实测 300107：#kl_objectives／#kl_custom_block_0／#kl_custom_block_2
  // 各 rgb(245,245,245)、直角；同页另外五块和抬头那条蓝底都是透明或深色）。
  // 每门课的块名不一样，CSS 也读不出"它现在是白的"，所以只能当场量一次底色再打标记。
  // 浅色那几块打 .mc-dp-card（换档＋收圆），自己带深色板子的（抬头那条蓝底 #0064a4）只打
  // .mc-dp-plate＝只收圆、底色一律不动。透明的那几块两个都不打：块与块之间没有间隙，
  // 跟着铺上会在接缝处露出页面底，一排圆角咬在一起＝看着像坏了。
  function tagDesignPlusCards() {
    if (!document.documentElement.classList.contains('mc-syllabus-plate')) return;
    const root = document.getElementById('course_syllabus');
    if (!root) return;
    root.querySelectorAll(':is([id^="kl_wrapper_"], #dp-wrapper) > *').forEach(el => {
      if (el.classList.contains('mc-dp-card') || el.classList.contains('mc-dp-card') || el.classList.contains('mc-dp-plate') || el.classList.contains('mc-dp-plate')) return;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.05)) return;
      const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      if (lum > 0.75) {
        el.classList.add('mc-dp-card', 'mc-dp-card');
      } else {
        el.classList.add('mc-dp-plate', 'mc-dp-plate');
      }
    });
  }

  /* 首页卡底那条横向滚动条越过我们的 16px 圆角：Chrome 不拿元素的 border-radius 去裁它自家的
     滑块（改法在 style.css 第 22 节末尾，那里有实测）。要改的是"正在滚的那一层"，而它可能是
     卡片自己、卡片里面某层、也可能是卡片外面那层 wrapper —— 只写 CSS 后代选择器就会漏掉最后
     一种，上一版就是这么没打上。所以当场认：卡片区里凡是"横向装不下＋自己会滚＋够宽"的层，
     打 .mc-hscroll 给样式表点名，不再赌它是哪一层。
     "够宽"是硬条件：窄件的滑块本来只有几十像素，再被左右各 16px 透明边吃掉就整条消失＝内容
     再也滚不出来。先读 clientWidth／scrollWidth 这两个本地量，过了才去算 computed style。 */
  function tagCourseHomeScrollers() {
    if (!document.documentElement.classList.contains('mc-course-home-plate')) return;
    const page = document.getElementById('wiki_page_show');
    if (!page) return;
    const wall = ':is([id^="kl_wrapper_"], #dp-wrapper)';
    // 卡片自己／卡里一层／卡片外面那层 wrapper／再外面那层正文滚动层，四种都可能
    const nodes = [page, ...page.querySelectorAll('.show-content, ' + wall + ', ' + wall + ' > *, ' + wall + ' > * > *')];
    for (const el of nodes) {
      if (el.dataset.mcHs) continue;
      if (el.clientWidth < 320 || el.scrollWidth <= el.clientWidth + 2) continue;
      const ox = getComputedStyle(el).overflowX;
      if (ox !== 'auto' && ox !== 'scroll') continue;
      el.dataset.mcHs = '1';
      el.classList.add('mc-hscroll');
    }
  }

  /* 设置面板开着的那一段时间：背后这一整页被糊住的遮罩盖着，一行都看不见，
     所以"为把页面摆好"而常开的那几趟在这一段不跑（判据只看面板在不在，
     面板自己那一座是 settings.js 搭的，跟这几趟无关）。
     挂在哪三处：变动监听排的那一趟、每 2000 毫秒读色那一趟、每 1500 毫秒重排卡片那一趟。
     面板上翻任一档要的效果全走 afterCheck 里那些直接调用，不靠这几趟，所以该当场变的照变。
     为什么值得停：这几趟里全是 getComputedStyle／innerText 这种强制整页同步重算的读
     （同一件事在通讯录那一处早就量过并写在 mcUiPass 头上的注释里）。
     会不会留下没皮的东西：不会自愈不了——面板节点从 body 上摘掉那一下本身就是一次子节点变动，
     当场把这一趟排上，最晚 300 毫秒后补跑。 */
  function mcSettingsPanelOpen() {
    return !!document.getElementById('mc-set-overlay');
  }

  /* 仪表盘右上角那条"有新版了"的磨砂提示。三个条件全过才画：
       后台真从商店拿到 update_available／restart_required（开发者方式装的那份永远不会有）
       设置里 mc_update_hint 没关
       距上次 × 掉超过一周（不是永久静音，他可能只是当时随手叉掉）
     文案不能写"点这里更新"：重载扩展这件事扩展自己做不到，商店那条路也得重启浏览器才生效。
     节点直挂 body，一层位移都不套：糊底要落在最外那块板上，套在 translate 过的祖先里取不到样 */
  function mcUpdateHintDismissed() {
    let at = 0;
    try { at = Number(localStorage.getItem(MC_UPDATE_DISMISS_KEY) || 0); } catch (e) {}
    return at > 0 && (Date.now() - at) < MC_UPDATE_REMIND_MS;
  }

  function mcUpdateHint() {
    if (!isTopWindow) return;
    const el = document.getElementById(MC_UPDATE_HINT_ID);
    const want = mcUpdateAvailable
      && mcReadSetting('mc_update_hint', '1') !== '0'
      && !mcUpdateHintDismissed();
    if (!want) {
      // 正在播那一下退场动画的节点别抢掉，让它的 setTimeout 自己摘
      if (el && !el.classList.contains('mcx-update-hint-out')) el.remove();
      return;
    }
    if (el) return;

    const plate = document.createElement('div');
    plate.id = MC_UPDATE_HINT_ID;
    plate.className = 'mcx-update-hint';
    plate.setAttribute('role', 'status');

    const mark = document.createElement('span');
    mark.className = 'mcx-update-hint-mark';
    mark.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><path d="M5 19.5h14" /></svg>';

    const txt = document.createElement('div');
    txt.className = 'mcx-update-hint-txt';
    const title = document.createElement('strong');
    title.textContent = 'A newer version is ready';
    const line = document.createElement('span');
    line.textContent = 'Chrome has it downloaded already. Update now to switch to it.';
    txt.appendChild(title);
    txt.appendChild(line);

    /* 那颗键干的是动作本身：chrome.runtime.reload() 让 Chrome 把已经下好的那个包换上，
       不用重启浏览器，也开不了 chrome://extensions（扩展打不开任何 chrome:// 页面）。
       换完这一页自己刷一次，皮就是新版的了；其它标签页不动它们自己——
       那些页里可能正写着作业，替人家刷新会丢没存的东西 */
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'mcx-update-hint-go';
    go.textContent = 'Update now';
    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = 'Updating';
      try {
        chrome.runtime.sendMessage({ type: 'mc_reload_extension' }, function () {
          void chrome.runtime.lastError;
          // 等后台那一头把扩展卸了再刷这一页，早一步会把旧版重新加载回来
          setTimeout(function () { window.location.reload(); }, 500);
        });
      } catch (e) {
        setTimeout(function () { window.location.reload(); }, 500);
      }
    });
    txt.appendChild(go);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mcx-update-hint-close';
    close.setAttribute('aria-label', 'Hide for a week');
    close.textContent = '×';
    close.addEventListener('click', function () {
      try { localStorage.setItem(MC_UPDATE_DISMISS_KEY, String(Date.now())); } catch (e) {}
      plate.classList.add('mcx-update-hint-out');
      setTimeout(function () {
        const now = document.getElementById(MC_UPDATE_HINT_ID);
        if (now) now.remove();
      }, 250);
    });

    plate.appendChild(mark);
    plate.appendChild(txt);
    plate.appendChild(close);
    document.body.appendChild(plate);
  }

  function mcUiPass() {
    // [2026-10-07 实测] 通讯录名单每追加一批，长任务就成串出现（1908/1841/1877、2552/2862/2785），
    // 一段 2～3 秒 ≈ 二三十次全页重算挤在同一段里。这一趟 Pass 每 300 毫秒跑一次，
    // 里面 pinOurNav 读 getComputedStyle、beautifyFooterButtons 读 innerText，
    // 每一趟都强制一次同步重算，而它自己写的类名又让下一趟继续脏。
    // 这一趟干的活全在导航栏、侧栏、待办、抽屉上，没有一样是通讯录浮层里需要的，
    // 所以浮层开着的时候整趟不跑；关掉它浮层里的皮一条不掉（那些是纯 CSS）。
    if (document.querySelector('[data-testid="address-book-popover"]')) return;
    const path = window.location.pathname;
    const isCalendarPage = path.includes('/calendar');
    const isPlannerPage = path.includes('/planner');
    const isCoursesPage = path.includes('/courses');
    const isDashboardPage = path === '/' || path.includes('/dashboard') || !path.includes('/');

    mcStep('markAccountNavAvatar', () => markAccountNavAvatar());
    mcStep('hideBcTodo', () => hideBcTodo());
    mcStep('mcKeepThemeSheetLast', () => mcKeepThemeSheetLast());
    mcStep('mountNavSettingsItem', () => mountNavSettingsItem());
    mcStep('mountNavReportItem', () => mountNavReportItem());
    mcStep('mountSidebarCourses', () => mountSidebarCourses());
    mcStep('mountBcPagesSection', () => mountBcPagesSection());
    // 四行都挂好之后再摆一次顺序：引擎只在你 Apply 过之后才动手（没存过布局就整趟跳过）
    mcStep('mcApplyNavLayout', () => mcApplyNavLayout());
    mcStep('pinOurNav', () => pinOurNav());
    mcStep('parkBcSidebar', () => parkBcSidebar());
    mcStep('dressAtomicSearch', () => dressAtomicSearch());

    // 仅在日历/日程相关页面才执行日历工具条和日期选择器
    if (isCalendarPage) {
      mcStep('dressCalendarDatepicker', () => dressCalendarDatepicker());
      mcStep('dressCalendarToolbar', () => dressCalendarToolbar());
      mcStep('dressCalendarSidebarLinks', () => dressCalendarSidebarLinks());
      mcStep('mcCalendarLoading', () => mcCalendarLoading());
    }
    // 这颗 Today 在仪表盘的 List view 上（#planner-today-btn），不在 /planner 那一页。
    // 上一版把它挂在 isPlannerPage 里，而仪表盘地址是 /，判据永远不成立＝改名一次都没跑过。
    // 函数自己会"找不到那颗就直接返回"，所以两页都放行
    if (isDashboardPage || isPlannerPage) {
      mcStep('dressPlannerToolbar', () => dressPlannerToolbar());
    }

    // 剧院模式与编辑器全屏按钮只在文档/作业相关页面寻找，仪表盘无此结构
    if (!isDashboardPage) {
      mcStep('setupUnifiedButtons', () => setupUnifiedButtons());
      mcStep('setupAdditionalEditorButtons', () => setupAdditionalEditorButtons());
      mcStep('setupTextboxThemeButtons', () => setupTextboxThemeButtons());
      mcStep('healTheaterExpandClass', () => healTheaterExpandClass());
      mcStep('beautifyFooterButtons', () => beautifyFooterButtons());
    }

    mcStep('beautifyTopHeader', () => beautifyTopHeader());
    mcStep('dressLtiIframeCard', () => dressLtiIframeCard());
    mcStep('dressIframeScrollbars', () => dressIframeScrollbars());

    // 待办面板在"有右侧栏的那一页"都要挂。上一版把它和下面三颗一起收进 isDashboardPage，
    // 课程 home 页（/courses/<id>）就只剩站点自己那份 To Do：style.css 那条藏原生 To Do 的规则
    // 判据是 #right-side:has(#mc-todo-panel)，面板没落地它整条不吃，站点那份就一直摆在那。
    // 函数自己会挡：没有 #right-side 直接返回，答题页/日历页也不挂，所以非仪表盘页多这一趟只是一次取值。
    // 首次挂载会 fetchPlannerData()，而这一页要画面板本来就缺这批数据
    mcStep('renderModernCanvasTodoList', () => renderModernCanvasTodoList());

    // Focus 那块面板要插在 Hub 上方那一格，所以必须排在上面这一趟之后：
    // 早一趟 Hub 还没落地，插进去的位置就是错的
    mcStep('mcFocusCanvasPass', () => { if (window.MCxFocus) window.MCxFocus.canvasPass(); });

    // 成绩页那两颗键：那一屏在 isHeavyListPage 里，这一串在它下面跑得慢一点（1500 毫秒一趟），
    // 但它是"看见就能点"的东西，站点自己那行抬头也是异步画出来的，所以跟着这一串就够
    mcStep('mcMessageTeacherBtn', () => mcMessageTeacherBtn());
    mcStep('mcAskTeacherBtn', () => mcAskTeacherBtn());

    // 首用弹窗与仪表盘那三行菜单只在仪表盘
    if (isDashboardPage) {
      mcStep('maybeShowBcTodoPrompt', () => maybeShowBcTodoPrompt());
      mcStep('maybeShowBcThemePrompt', () => maybeShowBcThemePrompt());
      mcStep('mcDashMenuRows', () => mcDashMenuRows());
      mcStep('mcNewDashOptionsBtn', () => mcNewDashOptionsBtn());
      mcStep('mcUpdateHint', () => mcUpdateHint());
      // 卡上那三行的显隐和自定义文字。面板开着时这一趟不排（mcScheduleUiPass 挡的），
      // 所以设置里改完要另外直接叫一次 mcCardTextApply，不能等这一趟
      mcStep('mcCardTextApply', () => mcCardTextApply());
    }

    mcStep('syncFeedbackTabView', () => syncFeedbackTabView());
    mcStep('mcSyncFeedbackMode', () => mcSyncFeedbackMode());

    // 抽屉展开时才有 portal，平时无需频繁查找
    if (document.getElementById('nav-tray-portal')) {
      mcStep('dressDrawerAllCourses', () => dressDrawerAllCourses());
      mcStep('dressTrayCourses', () => dressTrayCourses());
    }

    // 大纲正文那几块白卡先打标，排在下面那颗之前：改色引擎读的是"这块现在什么底"，
    // 晚一步就把字判成深色压在卡底上（它一旦判过就给节点挂 data-bcx-contrast-done，本页不再回头）
    mcStep('tagDesignPlusCards', () => tagDesignPlusCards());
    mcStep('tagCourseHomeScrollers', () => tagCourseHomeScrollers());

    // 智能文字对比度适配：轻量、无感、仅处理富文本
    mcStep('adaptContentTextContrastScoped', () => adaptContentTextContrastScoped());
  }

  let mcPassTimer = null;

  /* 卡上那三行的文字不能等这一串 300 毫秒的合并：仪表盘的卡是 React 晚一步画出来的，
     合并落下来之前他看到的就是 Canvas 原生的课名，才翻成我们那份（他报的"要等半秒"）。
     所以"这一批里出现了卡"就当场只跑改名这一件事，别的全照旧排队。
     我们自己写进去的那一批变动会把观察器再叫醒一次，第二趟逐格比对完什么都不改就停 */
  function mcCardsInBatch(mutations) {
    if (!mutations || !Array.isArray(mutations)) return false;
    for (const m of mutations) {
      const n = m.target;
      if (n && n.nodeType === 1) {
        if (n.closest && n.closest('.ic-DashboardCard')) return true;
        if (n.querySelector && n.querySelector('.ic-DashboardCard')) return true;
      }
      for (const add of (m.addedNodes || [])) {
        if (add.nodeType !== 1) continue;
        if (add.matches && add.matches('.ic-DashboardCard')) return true;
        if (add.querySelector && add.querySelector('.ic-DashboardCard')) return true;
      }
    }
    return false;
  }

  /* BC 什么时候动手没有规律：它比我们晚 3～5 秒挂载，元素被我们挪走以后约 10 秒自己再造一颗，
     还随时把 data-bc-nav-restore 那颗开关摘掉重挂。而"补导航"这三件事以前全跟着
     2 秒一轮的取色循环和合并 300 毫秒的那一趟走，所以刷新以后落在哪一格，看的是最后一个动手的是谁：
     它刚插表、我们还没补＝侧栏整块看不见；它刚造出侧栏、我们还没挪＝看见它那一套。
     这一条只认"这一批变动碰到了 BC 的东西"，碰到了就当场把三件事做一遍，不排队。
     它自己插拔得很密，所以再加一道 400 毫秒的闸 */
  function bcxTouchBcChrome(mutations) {
    if (!mutations || !Array.isArray(mutations)) return false;
    const BC = 'bettercampus-element, bettercanvas-portal, bettercampus-components, style[id^="bettercampus"], style[id^="bettercanvas"]';
    const isBc = (n) => !!(n && n.nodeType === 1 && n.matches && n.matches(BC));
    for (const m of mutations) {
      if (m.target === document.documentElement && m.attributeName === 'data-bc-nav-restore') return true;
      if (isBc(m.target) || isBc(m.target && m.target.parentElement)) return true;
      for (const n of m.addedNodes || []) if (isBc(n)) return true;
      for (const n of m.removedNodes || []) if (isBc(n)) return true;
    }
    return false;
  }

  let mcChromeAt = 0;

  function bcxOnBcChrome() {
    const now = Date.now();
    if (now - mcChromeAt < 400) return;
    mcChromeAt = now;
    const on = !!document.querySelector('bettercampus-element, bettercanvas-portal, bettercampus-components');
    // 这一颗类名平时归 applyModernPalette 写（2 秒一轮，还带一道止损冻结）。答题那一屏那条轮询
    // 不挂，所以这里按现场事实补一次。只加不减：减归那条轮询和冻结管，两处抢同一颗类名就会闪
    if (on) document.documentElement.classList.add('mc-bc-live');
    mcStep('mcNavRestore', () => mcNavRestore(on));
    mcStep('parkBcSidebar', () => parkBcSidebar());
    mcStep('pinOurNav', () => pinOurNav());
  }

  function mcScheduleUiPass(mutations) {
    if (mutations && Array.isArray(mutations)) {
      const allInIsland = mutations.every(m => {
        const target = m.target;
        if (!target || !target.closest) return false;
        // [实测 2026-10-11 答题屏] 新版答题那一整块（#new-quizzes-root）也算"这一趟管不着的岛"：
        // 打字时字数统计每敲一个字换一次文本，观察器就每键收到一批变动，300 毫秒一趟的 Pass 里
        // pinOurNav 读 getComputedStyle、beautifyFooterButtons 读 innerText＝每趟一次强制同步重算
        // （跟上面通讯录那条同一个病）。这一趟没有任何一样活落在答题岛里，整批在里面就直接不排。
        // 首趟和头 20 秒的轮询照跑，岛外任何变动也照常叫醒
        // [实测 2026-10-11 日历页] 月历那一整块是同一座岛，而且更凶：翻一次月＝一趟 745 条变动
        // （React 摘掉 98 颗事件条、挂上 52 颗），那一趟里我们没有任何一样活落在格子里——
        // 事件条的皮全是 theme-calendar.css 纯 CSS 画的，JS 一颗节点都不碰。
        // 岛＝#calendar-app 及其子树，外加拖拽排课容器与右侧日历。日历内部大量事件变动绝不触发全局重排
        return !!target.closest('span[data-position-content], [role="dialog"], [role="menu"], [data-testid*="address-book"], #new-quizzes-root, #calendar-app, #calendar-drag-and-drop-container, #minical, .mini_calendar');
      });
      if (allInIsland) return;
    }
    // 碰到 BC 的东西＝导航归谁这件事刚被改过，这一条排在"面板开着就不做"前面：
    // 面板盖着的时候也要把导航摆回对的那一边，不然关掉面板第一眼还是错的
    if (bcxTouchBcChrome(mutations)) bcxOnBcChrome();
    // 面板开着＝那一页整块被糊住的遮罩盖着，这一趟不排
    if (mcSettingsPanelOpen()) return;
    // 卡刚画出来的那一批不排队：改名这一件事当场做，别的东西照旧等合并
    if (mcCardsInBatch(mutations)) mcStep('mcCardTextApply', () => mcCardTextApply());
    if (mcPassTimer) return;
    mcPassTimer = setTimeout(() => { mcPassTimer = null; mcUiPass(); }, 300);
  }

  // 头 20 秒保障挂载与自愈（首页保障 TodoList、侧边栏 Settings/Report、瀑布流与 Logo）
  // 在 Modules/Grades 巨型列表页面只轻量校对，避免重复计算
  mcUiPass();
  const isHeavyListPage = window.location.pathname.includes('/modules') || window.location.pathname.includes('/grades');
  const isDash = window.location.pathname === '/' || window.location.pathname.includes('/dashboard');
  let dashStableCount = 0;
  if (!MCX_QUIET_PAGE) {
    const interval = setInterval(() => {
      if (mcSettingsPanelOpen()) return;
      // 如果已经在页面上并且一切挂齐，就不需要高频重跑
      if (isHeavyListPage && document.querySelector('.mc-nav-settings-item')) {
        return;
      }
      // 仪表盘如果关键元素已就绪（设置齿轮 + TodoList + 课程分区），连续稳定 3 次后即可静默，彻底释放 CPU
      if (isDash && document.querySelector('.mc-nav-settings-item') && document.querySelector('#modern-canvas-todolist') && document.querySelector('.mc-nav-courses')) {
        dashStableCount++;
        if (dashStableCount >= 3) return;
      }
      mcUiPass();
    }, isHeavyListPage ? 1500 : 500);
    setTimeout(() => clearInterval(interval), 20000);
  }

  // External Extension 的待办面板。默认＝两套都显示（它的面板放在我们整块之下），
  // 只有他明确选过"只用我们的"（bcx_bc_todo='0'）才收走。
  // 为什么不用 CSS 藏：探针 [BCP14]/[BCP22] 证实它就是 #right-side-wrapper 的直接子节点，
  // 约 640ms 出现、4.4s 长到 1332px；表内 display:none !important 在这页不吃（宿主 computed 仍是
  // inline，它自己写行内 !important，行内 !important 赢过样式表 !important）。
  // 所以不抢样式优先级了：把它这颗节点搬进我们自己的隐藏容器。它重写自己的 style 也逃不出隐藏祖先。
  function bcTodoWantsShow() {
    return localStorage.getItem('bcx_bc_todo') !== '0';
  }

  // 永久共存：把它的待办面板放到右侧栏最后（我们的面板之下），每趟校对一次位置，
  // 被 React 挪走就补回来。不走 revealBcPanel 那条"临时放出＋3 分钟收回"的路，
  // 也不碰 bcPanelRevealed，否则用户从"都显示"切回"只用我们的"时会被挡住收不回去。
  function showBcTodoPermanent() {
    const wrapper = document.getElementById('right-side-wrapper');
    if (!wrapper) return;
    let bc = wrapper.querySelector(':scope > bettercampus-todo-list');
    if (!bc) {
      bc = document.querySelector('bettercampus-todo-list');
      if (!bc) {
        const box = document.getElementById('mc-quarantine');
        if (box) bc = box.querySelector('bettercampus-todo-list');
      }
    }
    if (!bc) return;
    if (bc.parentElement !== wrapper || bc !== wrapper.lastElementChild) {
      wrapper.appendChild(bc);
      console.log('[BCX] 把 External Extension 待办放到右侧栏末尾（我们那块之下）');
    }
    const box = document.getElementById('mc-quarantine');
    if (box && !box.children.length) box.remove();
  }

  function hideBcTodo() {
    if (bcTodoWantsShow()) { showBcTodoPermanent(); return; }
    if (bcPanelRevealed) return;
    const hosts = document.querySelectorAll('bettercampus-todo-list');
    if (!hosts.length) return;
    let box = document.getElementById('mc-quarantine');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mc-quarantine';
      box.hidden = true;
      box.style.setProperty('display', 'none', 'important');
      document.body.appendChild(box);
    }
    const moves = Number(box.dataset.mcMoves) || 0;
    if (moves > 40) return;
    for (const el of hosts) {
      if (el.parentElement === box) continue;
      box.dataset.mcMoves = String((Number(box.dataset.mcMoves) || 0) + 1);
      box.appendChild(el);
    }
  }

  // ===== 借 External Extension 的配色 =====
  // 它的主题落地成一整套 --bc* 自定义属性（它代码里 r+="--bc"+token+":"+value+";"），
  // 每个 token 还额外有一个 -ungradient 版本＝把渐变和背景图扒掉后剩下的纯色，我们要的是纯色。
  // 我们只读这些值写进自己的 --mc-* token（见 style.css 顶部），画法一行不改。
  /* 那 12 档槽名。以前它和旧主题墙（btx* 那一批）放在一起，2026-10-13 删旧墙时被一起带走了，
     可它管的不只是那一屏：mcEditVars 认档、mcSetSlotColor 认档、mcThemeSlotRows 逐档出行
     都读它——一没就是 Theme Customizer 整屏只剩壳子（那十一行连字体那一行都搭不出来）。
     现在挪到这张表旁边，和退路链同一处 */
  const BTX_SLOTS = ['background-0', 'background-1', 'background-2', 'cards', 'borders',
    'links', 'buttons', 'text-0', 'text-1', 'text-2', 'sidebar', 'sidebar-text'];

  const BCX_TOKEN_MAP = {
    // 一颗变量对一档色，名字就是那一档的槽名。同名合并过的三对（原来的 card-hover 与
    // done-card、ink 与 ink-strong、ink-3 与 done-ink）本来就吃同一档，不再各留一个名字
    '--mc-background-0': ['bccards', 'bcbackground-0'],
    '--mc-background-1': ['bcbackground-1'],
    '--mc-background-2': ['bcbackground-2'],
    '--mc-borders': ['bcborders'],
    '--mc-buttons': ['bcbuttons', 'bcbackground-0'],
    '--mc-links': ['bclinks', 'bctext-0'],
    '--mc-text-0': ['bctext-0'],
    '--mc-text-1': ['bctext-1'],
    '--mc-text-2': ['bctext-2'],
    // 【收口】--mc-press 从这张表里退回来。它以前挂的是 borders，于是"Lines"那一行会顺手改掉
    // 按钮按下的颜色，而控件一族被拆给两档管。现在 style.css 里由 --mc-background-2 往正文色提一档算，
    // 控件那一族（底板、轨道、按下）全部只跟 buttons/background-2 这一条线走
  };

  const mcRgbCache = new Map();
  function mcToRgb(raw) {
    if (mcRgbCache.has(raw)) return mcRgbCache.get(raw);
    let out = null;
    // 只接受单个颜色；渐变、url(...) 这类复合值一律不要
    if (typeof raw === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/i.test(raw.trim())) {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:none;color:' + raw;
      document.body.appendChild(probe);
      const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
      probe.remove();
      if (parts && parts.length >= 3) out = parts.slice(0, 3).map(Number);
    }
    mcRgbCache.set(raw, out);
    return out;
  }

  /* 一串颜色里的透明度（0 到 1，认不出来返回 null）。
     上面那条 mcToRgb 只取前三个数字，所以主题作者写的 #00000000（完全透明）会被它读成
     "成功读到一颗黑"，那颗透明色就一路当黑用：侧栏胶囊被拼成实心黑、正文兜底按黑底挑白字。
     3197 份主题里有 14 份的 cards 档就是这颗（Ghibli、Steven Universe、Pink Cheetah 等），
     作者的意思是"这一档我不铺色"，不是"铺黑色"。判透明只能另走一条。 */
  const mcAlphaCache = new Map();
  function mcAlphaOf(raw) {
    if (mcAlphaCache.has(raw)) return mcAlphaCache.get(raw);
    let out = null;
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v) {
      const hex8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(v);
      if (hex8) out = parseInt(hex8[1], 16) / 255;
      else {
        const probe = document.createElement('span');
        probe.style.cssText = 'display:none;color:' + v;
        document.body.appendChild(probe);
        const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
        probe.remove();
        if (parts && parts.length >= 4) out = Number(parts[3]);
        else if (parts && parts.length >= 3) out = 1;
      }
    }
    mcAlphaCache.set(raw, out);
    return out;
  }

  // 作者在这一档放的是"完全透明"（#00000000、rgba(…,0)、或者干脆一颗 transparent）
  function mcIsClear(raw) { return mcAlphaOf(raw) === 0; }

  /* 卡底那一档在屏幕上到底挡住多少（0＝全透，1＝实色）。旧的磨砂门控只认"整串就是一颗纯色"，
     于是渐变、图、以及任何读不出单色的形状一律被算成不透明：那一档明明看得穿，
     屏幕上却只剩一层半透明，挂在类名下面的糊一条都不落。
     现在逐层拆：纯色层取它自己的 alpha；渐变层取它各端里最透的那一颗（要糊就糊身后最差那一端）；
     图层按"挡住"算（作者铺的是一张实图，它身后没有东西可糊）；多层照 CSS 的叠底顺序合成。
     整串是空（这一档压根没写到我们身上）算 0，那一层本来就没画东西。认不出的一律按挡住算，宁可少糊一层。
     和 theme-boot.js 的 frostAlphaOf 逐字对齐：两边差一点就是首帧一层实色、半秒后翻成磨砂 */
  function mcFrostAlphaOf(raw) {
    const v = String(raw || '').trim();
    if (!v) return 0;
    let through = 1;
    for (const layer of mcSlotLayers(v)) {
      let a;
      if (/url\(/i.test(layer)) a = 1;
      else if (/gradient/i.test(layer)) {
        a = 1;
        for (const c of layer.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) || []) {
          const ca = mcAlphaOf(c);
          if (ca !== null && ca < a) a = ca;
        }
      } else a = mcAlphaOf(layer);
      if (a === null || a === undefined) continue;
      through *= 1 - a;
    }
    return 1 - through;
  }

  // 任何合法单色 → #rrggbb。抓取通路抄回来的 computed 值常常是 rgb(52.013663222240645, …)
  // 这种带小数的串，而 CSS 的 rgb() 不接受小数：原样涂进色块＝非法、整块不显，
  // 喂进取色器＝读不出色相只能停在左上白，摆在文字位＝一长串还随拖动变长变短把整行顶得换行跳动。
  // 所以出面板之前一律收成 #rrggbb（读不出单色的，比如整串是渐变，返回空让调用方自己判）
  function mcHexOf(raw) {
    const rgb = mcToRgb(raw);
    if (!rgb) return '';
    return '#' + rgb.slice(0, 3).map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
  }

  function mcLuminance(rgb) {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }

  function modernContrast(a, b) {
    const [hi, lo] = [mcLuminance(a), mcLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // 一次快照就变成本地的：只要页面上读到它的 --bc* 值，就把这一组槽位值存下来。
  // 之后 External Extension 关掉、甚至卸载掉，我们仍然保持你最后用的那一套。
  // 快照里除了色，还存图：页面背景层、侧栏背景层、以及每张课程卡最终用的图和叠加色
  // （它自己是按课程序号取模分配 c[e%c.length]，单独设过图的课另算，所以我们抄结果不抄规则）
  //
  // 存到哪儿由上面那四档定（mcSaveKey）：一格存档就是一个键，读和写都只认它。
  // 以前这里在"应用键 mc_applied_theme_v1"和"抓取镜像键 mc_theme_snapshot_v3"之间挑，
  // 分两键是为了挡住别的标签页里旧版脚本把用户选的主题顶掉；现在三格存档各自独立，
  // 那两份旧键只剩迁移时读一次（BCX_LEGACY_KEYS），镜像再怎么写也动不到他的存档。
  function mcWriteSnapshot(text) {
    const key = mcSaveKey();
    try { localStorage.setItem(key, text); }
    catch (e) { console.log('[MCX] 存档存不下', e && e.name); }
  }
  const BCX_IMAGE_VARS = ['bcbackground-image', 'bcbackground-image-layer', 'bcbackground-image-filter',
    'bcbackground-0', 'bcsidebar', 'bcsidebar-image-layer', 'bcsidebar-filter'];
  // 这一档不映射成 --mc-* token（我们面板用不上），但侧栏的文字和图标要靠它：
  // 页面上导航图标的 fill 是 Canvas 自己写的白，BC 也不动它，照 computed 抄只会把白存下来。
  // 导入 JSON 那条通路一直用的是 sidebar-text，两边统一读这一档
  const BCX_EXTRA_VARS = ['bcsidebar-text'];

  // 把槽值拼成一份根变量表（--bctext-0:…;--bcbackground-0:…;）。
  // 以前这份是抄它写在行上的行内变量，可它的变量绝大多数在它自己那几张 <style> 里，不在行上。
  // 贴表停用之后那些表不会再回来，BC 一关页面上就没有 --bc* 了，style.css 里凡是 var(--bc…)
  // 的规则全部落空：侧栏当前项那颗底板变透明，而板上的字和图标是我们钉死的白
  // ＝"图标全白、hover 没动效，但还能点"。变量本身就是参数，我们自己拼得出来。
  function mcVarsToRoot(vars) {
    const names = window.mcCssGuard && window.mcCssGuard.name;
    let out = '';
    for (const name of Object.keys(vars || {})) {
      const raw = String(vars[name] || '').trim();
      if (!raw || /[;{}]/.test(raw)) continue;
      // 名字本身也是 JSON 里那个 c.slot：带 { } 就能替自己开一条声明
      const token = '--' + (name.indexOf('bc') === 0 ? name : 'bc' + name);
      if (names && !names(token)) continue;
      out += token + ':' + raw + ';';
    }
    return out;
  }

  // 卡片头部那一层：老版是 header_image / header_hero；新版 BC 自己给
  // course-grade-card > span > span:first-child > div 挂上 bc-grade-card-header
  function modernCardHeader(card) {
    return card.querySelector('.bc-grade-card-header, .ic-DashboardCard__header_image, .ic-DashboardCard__header_hero')
      || card.querySelector(':scope > span > span:first-child > div')
      || card.firstElementChild;
  }

  function mcCardTheme() {
    const cards = {};
    for (const card of document.querySelectorAll('.ic-DashboardCard, [data-testid^="course-grade-card"]')) {
      const link = card.querySelector('a[href*="/courses/"]');
      const id = (link && (link.getAttribute('href').match(/\/courses\/(\d+)/) || [])[1])
        || ((card.getAttribute('data-testid') || '').match(/course-grade-card-(\d+)/) || [])[1];
      const header = id && modernCardHeader(card);
      if (!header) continue;
      // 它把图写在 ::before、颜色膜写在 ::after，元素自己是 background:none，
      // 所以只读元素本身的 computed background 会一张都抓不到
      const before = getComputedStyle(header, '::before');
      const after = getComputedStyle(header, '::after');
      const own = getComputedStyle(header).backgroundImage;
      const img = before.backgroundImage && before.backgroundImage !== 'none' ? before.backgroundImage
        : (own && own !== 'none' ? own : '');
      const film = after.backgroundImage && after.backgroundImage !== 'none' ? after.backgroundImage : '';
      if (!img && !film) continue;
      cards[id] = { img, film, filter: before.filter && before.filter !== 'none' ? before.filter : '' };
    }
    return cards;
  }

  // 色槽的值可能是 "url(..), linear-gradient(..), #fff" 这种叠层，按顶层逗号拆开：
  // 图层进 background-image，最后一个纯色进 background-color
  function mcSplitSlot(v) {
    const layers = [];
    let depth = 0, cur = '';
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) layers.push(cur.trim());
    const isImg = (l) => /^(url|linear-gradient|radial-gradient|repeating|conic)/i.test(l);
    return { imgs: layers.filter(isImg), color: layers.filter(l => !isImg(l)).pop() || '' };
  }

  function mcHexAlpha(hex, a255) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
    return hex + Math.max(0, Math.min(255, a255)).toString(16).padStart(2, '0');
  }

  // 把一个纯色往白方向掺 k（0..1）。不是纯色（渐变、带图的串）就返回空，让调用方自己回退
  function mcMixWhite(raw, k) {
    const rgb = raw ? mcToRgb(raw) : null;
    if (!rgb) return '';
    const mix = c => Math.round(c + (255 - c) * k);
    return '#' + [mix(rgb[0]), mix(rgb[1]), mix(rgb[2])].map(c => c.toString(16).padStart(2, '0')).join('');
  }

  // 字体：抓到的 JSON 有时只有 family 没有 link，那就自己拼一条 Google Fonts 的地址，
  // 不然 CSS 里写了字族名、机器上又没装，最后还是回退成默认字体。
  // 应用一份主题和详情里预览那份字，用的是这同两条规则
  // 抓到的 family 名十有八九自带一层引号（'Playfair Display'）：原样拼进地址 Google 直接回 400，
  // 原样拼进 CSS 又成了 ''Playfair Display'' 这种非法值。所以先剥干净，要引号的地方再加回去
  function mcFontName(font) {
    return String((font && font.family) || '').trim().replace(/^['"]+/, '').replace(/['"]+$/, '');
  }

  function mcFontLinks(font) {
    const rawLink = String((font && font.link) || '').trim();
    if (/^https?:/i.test(rawLink)) return [rawLink];
    if (rawLink) return ['https://fonts.googleapis.com/css2?family=' + rawLink.replace(/^.*[?&]family=/, '').replace(/^&/, '')];
    const fam = mcFontName(font).replace(/[^\w .-]/g, '');
    return fam
      ? ['https://fonts.googleapis.com/css2?family=' + fam.replace(/\s+/g, '+') + ':wght@400;500;600;700&display=swap']
      : [];
  }

  function mcFontFamily(font) {
    const fam = mcFontName(font);
    return fam && /[\s]/.test(fam) ? "'" + fam + "'" : fam;
  }

  // 一份字体记录＝{family, link}。两样都空就是这份主题没带字体（库里 33 主题全是这种情况），
  // 那 Default 那一档指的就是 Canvas 自己的字。
  // 字族名最后会拼进编译出来的那条 CSS（body 的全后代那条规则），抓来的 JSON 和面板里粘进来的
  // 都算外部输入，所以这里剥掉能把自己那份表劈开的字符；中文／日韩字族名照旧留得住
  function mcFontRecord(font) {
    const family = mcFontName(font).replace(/[{}<>;"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const link = String((font && font.link) || '').trim().slice(0, 300);
    return (family || /^https?:/i.test(link)) ? { family: family, link: link } : null;
  }

  /* 快照里没记 baseFont 的那一批（这个字段加进来之前存的，还有 BC 在跑时那面镜像每三秒抄的）：
     把现在生效的那份认作"这页自带的"，Default 才有东西可回。
     字族名只从地址的 family= 参数读，不读页面上量到的整条字体栈——那条可能已经是我们自己刷上去的 */
  function mcFontFromLinks(links) {
    const href = String((links || [])[0] || '');
    if (!/^https?:/i.test(href)) return null;
    let fam = '';
    const m = href.match(/family=([^:&]+)/i);
    if (m) {
      try { fam = decodeURIComponent(m[1]).replace(/\+/g, ' '); } catch (e) { fam = m[1]; }
    }
    return mcFontRecord({ family: fam, link: href });
  }

  // 把抓取工具那份主题 JSON 翻译成我们快照的结构。它那份 JSON 里有 12 个色槽、字体、
  // 卡图数组和叠色参数，够我们自己算出配色，不需要再贴 External Extension 的样式表
  function mcThemeFromJson(j) {
    /* 槽值在这里就是最后一道"原文进得来"的门：这一份 JSON 可能来自远程桶、来自别人发你的文件、
       也可能来自设置里粘进来的那一段。值脏的这一档整档不收（宁可少一档色），
       因为编译那一步还要把它拼进样式表，脏值拼出来的不是"一条非法声明"而是"多一条规则" */
    const guard = window.mcCssGuard;
    const slots = {};
    for (const c of (j.colors || [])) {
      if (!c || !c.slot) continue;
      const value = String(c.value || '').trim();
      if (guard && (!guard.name('--bc' + c.slot) || !guard.ok(value))) continue;
      slots[c.slot] = value;
    }
    // 【合二为一】cards 这一档不再由我们造：主题给了就照用，没给就由 BCX_TOKEN_MAP 退到
    // background-0。面板上它也不单列一行，那一行现在就是 background-0
    const vars = {};
    for (const k of Object.keys(slots)) vars['bc' + k] = slots[k];
    const rootVars = Object.keys(slots).map(k => '--bc' + k + ':' + slots[k] + ';').join('');
    const ex = j.exports || {};
    // 自定义主题那份是 mc-img://<id>/<位置> 的引用（真图在库里，见 theme-lib.js），
    // 抓取那份是 https，手工带进来的还有 data:，我们自己打包那份（themes/modern-canvas/）
    // 在页面上读出来是 chrome-extension://，这四种都得放行
    const usable = u => /^(https?:|data:|mc-img:|chrome-extension:|chrome:)/i.test(String(u || ''))
      // 地址会被写成 url("这一颗")，带引号／括号／尖括号就能把自己从那对引号里跳出去。
      // 正经地址这些全是要百分号编码的，所以一律不收（data: 里的分号在引号内，不受影响）
      && !/["'{}<>\\]/.test(String(u || ''));
    const imgs = (j.images || []).filter(x => x && x.url && usable(x.url));
    const cardImgs = (ex.custom_cards && ex.custom_cards.length
      ? ex.custom_cards
      : imgs.filter(x => /卡片|card/i.test(String(x.role || ''))).map(x => x.url)).filter(usable);
    const alpha = Math.round((ex.disable_color_overlay ? 0 : (typeof ex.card_overlay_opacity === 'number' ? ex.card_overlay_opacity : 65)) / 100 * 255);
    const cols = (ex.card_colors || []).filter(c => /^#[0-9a-f]{6}$/i.test(c));
    // 色膜颜色和卡上标题的颜色在抓取那份 JSON 里是同一个数组；自定义主题分开给两份
    // （深膜配深字就什么都看不见），那边多一颗 card_title_colors
    const titleCols = (ex.card_title_colors || []).filter(c => /^#[0-9a-f]{6}$/i.test(c));
    const one = mcHexAlpha(cols[0] || '#000000', alpha);
    const film = !one ? '' : (ex.gradient_cards && cols.length > 1
      ? 'linear-gradient(135deg,' + cols.map(c => mcHexAlpha(c, alpha) || one).join(',') + ')'
      : 'linear-gradient(135deg,' + one + ',' + one + ')');
    // 字体先收成一份干净记录，链接和 CSS 里那串字族名都从它来（两边不同源就会出现链接拉的是
    // 一个名字、CSS 写的是另一个名字）
    const baseFont = mcFontRecord(j.font);
    const famCss = mcFontFamily(baseFont);
    const fontLinks = mcFontLinks(baseFont);
    // 区域：自定义主题在这儿带"这张图用的是哪一块"（模式 + 焦点），抓取那份没有这一项，
    // 照旧是铺满看中间
    const reg = j.regions || {};
    const navReg = reg.sidebar || null;
    // 槽值本身就是一条完整的 background 简写（"linear-gradient(..), center url(..)"），
    // 整串交给 background 才对。之前想拆成"图层 + 纯色"两半，结果第二层开头是位置关键字
    // center，既没被认成图、又被当成颜色写进 background-color（非法，浏览器整条丢），
    // 侧栏那张平铺的图就是这么没的。顺带：不写 background-repeat 就是平铺，跟它一致。
    // 整页大背景优先使用 background-1（Whole background），缺失时退回 background-0 兜底。
    const pageBgRaw = slots['background-1'] || slots['background-0'] || '';
    const surfaces = {
      body: { raw: pageBgRaw, size: 'cover', pos: 'center', attach: 'fixed', font: famCss },
      app: { raw: pageBgRaw, size: 'cover', pos: 'center', attach: 'fixed' },
      nav: {
        raw: slots.sidebar || '',
        size: (navReg && navReg.size) || 'cover',
        pos: (navReg && navReg.pos) || 'center',
        repeat: (navReg && navReg.repeat) || '',
        /* 一律 scroll：侧栏这张图的尺寸和位置必须按侧栏自己那个框算。
           fixed 是钉在【视口】上的，于是 cover 拿整屏 1500×900 去铺，侧栏只截到最左边
           260 那一条＝他说的"铺满了还在继续放大"。自建主题那支早就改成 scroll 了，
           抓取那批以前故意留着 fixed 不动，结果炸的就是这一批 */
        attach: 'scroll',
        // Apply 那一刻由设置面板在那张图上采好的三颗底（平均／最暗／最亮）。
        // 抓取来的那份没有这一项，自定义主题那份也没有：拿不到就是空，兜底照旧不翻
        samples: (j.samples && Array.isArray(j.samples.sidebar)) ? j.samples.sidebar : [],
        text: slots['sidebar-text'] || '',
        icon: slots['sidebar-text'] || ''
      }
    };
    return {
      vars, rootVars, surfaces,
      cards: {},
      dash: { images: cardImgs, film, filter: '', colors: titleCols.length ? titleCols : cols,
        regions: Array.isArray(reg.cards) ? reg.cards : [] },
      fonts: fontLinks,
      // 字体分两层，和色一样：baseFont＝这份主题自带的（空＝它没带，那就是 Canvas 自己的字），
      // fontEdit＝他在 Theme Customizer 那一屏挑的那份。null 和"没这个字段"不是一回事：
      // 后者是旧快照或 BC 镜像抄来的，那一份没人能替它决定 Default 指哪儿，所以那条通道不碰它
      baseFont: mcFontRecord(j.font),
      fontEdit: null,
      sheets: [],
      imported: { title: j.title || '', code: j.code || '' },
      themeCss: mcThemeCss({ surfaces, cards: {}, vars })
    };
  }

  // 导入的主题没有"课程 id → 图"这张表（那是 BC 按课程现生成的），所以按它的规则补：卡图对课程序号取模。
  // 课程要页面渲染出来才有，所以这步只能在跑到时做，不能放在导入那一刻
  function mcExpandImportedCards(stored) {
    const dash = stored && stored.dash;
    if (!dash || !dash.images || !dash.images.length) return;
    const ids = [];
    for (const card of document.querySelectorAll('[data-testid^="course-grade-card"]')) {
      const m = (card.getAttribute('data-testid') || '').match(/course-grade-card-(\d+)/);
      if (m) ids.push(m[1]);
    }
    for (const card of document.querySelectorAll('.ic-DashboardCard')) {
      const link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
    }
    // List view 单独开着的时候上面那两颗都可能还没画，课程要从这一屏自己认出来，
    // 否则这批课程 id 进不了表，下面那套 custom-card-<id> 规则一条也不会生成
    for (const group of document.querySelectorAll('.planner-grouping')) {
      const link = group.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
    }
    if (!ids.length) return;
    const cards = stored.cards || {};
    const colors = dash.colors && dash.colors.length ? dash.colors : [];
    // 每张图用的是哪一块：和 images 同下标，由 mcThemeFromJson 从 j.regions 带进来
    const regions = dash.regions && dash.regions.length ? dash.regions : [];
    let changed = false;
    ids.forEach((id, i) => {
      if (cards[id] && cards[id].img) return;
      const at = i % dash.images.length;
      const reg = regions[at] || null;
      cards[id] = {
        img: 'url("' + dash.images[at] + '")',
        film: dash.film || '',
        filter: dash.filter || '',
        color: colors.length ? colors[at % colors.length] : '',
        size: reg && reg.size ? reg.size : '',
        pos: reg && reg.pos ? reg.pos : '',
        repeat: reg && reg.repeat ? reg.repeat : ''
      };
      changed = true;
    });
    if (!changed) return;
    stored.cards = cards;
    mcWriteSnapshot(JSON.stringify(stored));
    mcCardSnapshot = cards;
  }

  /* 一次性补存量：卡名那颗白。
     以前自定义主题算卡名颜色时假设"标题压在贴图上"（按色膜深浅翻黑或白），
     实测他这版旧卡 DOM 里标题是排在图下面的一行、坐的是卡身底色，那颗白就是白压粉看不见。
     算法已经改成跟正文那一档走，但快照是改之前 Apply 时写进去的，里面躺着一颗 #ffffff
     （他页面上量到 dash.colors 和 10 张卡的 cards[].color 全是 #ffffff）——
     光改算法不动这份存量，他重载完还是白的。所以这里按库里那份主题现在的算法重算一次，
     只动 color：不动你拧过的那几档、也不动每张卡分到哪张图。跑过一次就记个键。 */
  function mcRepairCardTitleColors(stored) {
    if (localStorage.getItem('mcx_title_repair_v1') === '1') return;
    localStorage.setItem('mcx_title_repair_v1', '1');
    const code = String((stored && stored.imported && stored.imported.code) || '');
    if (!stored || !window.mcLib || code.indexOf('mc:') !== 0) return;
    const rec = window.mcLib.get(code.slice(3));
    if (!rec) return;
    const fresh = mcThemeFromJson(window.mcLib.buildThemeJson(rec));
    const colors = (fresh.dash && fresh.dash.colors) || [];
    const images = (fresh.dash && fresh.dash.images) || [];
    if (!colors.length) return;
    stored.dash = Object.assign({}, stored.dash, { colors });
    let changed = false;
    for (const id of Object.keys(stored.cards || {})) {
      const entry = stored.cards[id];
      const img = String((entry && entry.img) || '');
      let at = -1;
      for (let i = 0; i < images.length; i++) if (img.indexOf(images[i]) !== -1) { at = i; break; }
      const want = colors[at === -1 ? 0 : at % colors.length];
      if (want && entry.color !== want) { entry.color = want; changed = true; }
    }
    if (changed) mcWriteSnapshot(JSON.stringify(stored));
  }

  /* 从真卡片身上量出来的那串封面图，按出现的先后去重：课程是按顺序拿图的
     （第 i 门课拿第 i 张，铺完回卷），所以这串去重表就是那份主题的图序。
     快照里那份 dash.images 只有导入主题才有，量不到的时候这串是唯一可靠的来源。
     和 mcCardTheme() 一样要读 ::before／::after：图在那两层上，元素自己是 background:none */
  function mcCardArtSequence() {
    const out = [];
    const seen = {};
    const cards = document.querySelectorAll('.ic-DashboardCard, [data-testid^="course-grade-card"]');
    for (const card of cards) {
      if (card.classList.contains('mcx-focus-vcard')) continue;
      const header = modernCardHeader(card);
      if (!header) continue;
      let before, after, own;
      try {
        before = getComputedStyle(header, '::before');
        after = getComputedStyle(header, '::after');
        own = getComputedStyle(header);
      } catch (e) { continue; }
      const img = before.backgroundImage && before.backgroundImage !== 'none' ? before.backgroundImage
        : (own.backgroundImage && own.backgroundImage !== 'none' ? own.backgroundImage : '');
      if (!img || img === 'none' || seen[img]) continue;
      seen[img] = 1;
      out.push({
        img: img,
        film: after.backgroundImage && after.backgroundImage !== 'none' ? after.backgroundImage : '',
        filter: before.filter && before.filter !== 'none' ? before.filter : '',
        size: before.backgroundSize || '', pos: before.backgroundPosition || '', repeat: before.backgroundRepeat || ''
      });
    }
    return out;
  }

  /* Focus 那张虚拟卡的封面：主题给课程卡配图是按顺序发的，所以"下一张"＝第 n 张，
     n＝这一屏真课程卡的张数。先读快照里那份图序（有 regions 就连取哪一块一起跟过来），
     没有就量真卡片身上那串。两条都拿不到才真的没图 */
  function mcCardArtAt(at) {
    // 先量真卡片身上那串：那一串上的地址是编译时解析过的，一定是能加载的那一个。
    // 快照里 dash.images 对打包主题写的是裸文件名（只有 Apply 那一刻才换成扩展绝对地址），
    // 直接塞进 background-image 会按当前页面的域名去解＝一张图都加载不出来
    const seq = mcCardArtSequence();
    if (seq.length) return seq[Math.max(0, at) % seq.length];
    const stored = mcSnapshot();
    const dash = stored && stored.dash;
    if (dash && dash.images && dash.images.length) {
      const i = Math.max(0, at) % dash.images.length;
      const reg = (dash.regions && dash.regions[i]) || null;
      return {
        img: 'url("' + dash.images[i] + '")',
        film: dash.film || '',
        filter: dash.filter || '',
        size: (reg && reg.size) || '',
        pos: (reg && reg.pos) || '',
        repeat: (reg && reg.repeat) || ''
      };
    }
    const cards = (stored && stored.cards) || {};
    const ids = Object.keys(cards);
    for (let k = 0; k < ids.length; k++) {
      const rec = cards[ids[(Math.max(0, at) + k) % ids.length]];
      if (rec && rec.img && rec.img !== 'none') return rec;
    }
    return null;
  }

  function mcSnapshot() {
    // 读的就是正在用的那一格存档（改色、抓取镜像都写回同一格）
    // 如果用户在 BC 关闭后选择了继续使用记录的 BC 主题，优先返回 recorded 快照
    try {
      const live = document.documentElement.classList.contains('mc-bc-live');
      const owner = localStorage.getItem('bc_theme_owner');
      if (!live && owner === 'bc') {
        const recorded = JSON.parse(localStorage.getItem('mc_bc_recorded_theme') || 'null');
        if (recorded) return recorded;
      }
      return JSON.parse(localStorage.getItem(mcSaveKey()) || 'null') || null;
    } catch (e) { return null; }
  }

  /* ===== 设置里 Colors 面板改色 =====
     一份快照分三层：base ＝这份主题本来的颜色，edits ＝用户亲手改的那几档，
     vars ＝两者合起来、所有渲染代码实际读的那一份。
     分这三层是因为 BC 在后台每三秒会把页面上的颜色重新抄一遍进快照，
     不分开的話用户改的那一档下一轮就被抄回来的原色顶掉了。 */

  // 槽值可以是一长串（壁纸 url + 渐变 + 最后一层纯色）。改色只换纯色那一层，图层原样留着，
  // 否则改一次页面底色就把主题自带的壁纸整张抹掉。
  // 这里不能用 mcSplitSlot：它按 isImg 认图层，而 "center url(..)" 这种开头带位置关键字的层
  // 会被它认成颜色（这个坑已经踩过一次，见上面 mcThemeFromJson 里那段注释）
  function mcSlotLayers(v) {
    const layers = [];
    let depth = 0, cur = '';
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) layers.push(cur.trim());
    return layers;
  }

  // 一串槽值里最后那颗纯色；整串都是图就返回空（这一档取色器没东西可选）
  function mcSlotColorOf(raw) {
    const solids = mcSlotLayers(String(raw || '')).filter(l => mcToRgb(l));
    return solids.length ? solids[solids.length - 1] : '';
  }

  function mcSlotHasImage(raw) {
    return mcSlotLayers(String(raw || '')).some(l => !mcToRgb(l) && !mcIsClear(l));
  }

  /* 一颗槽值里"能拿来当底比"的所有颜色。以前只认"整串就是一颗颜色"，于是侧栏那一档
     写成 url(图) 或 linear-gradient(a,b) 时兜底拿到空串＝那道 3:1 根本没判，
     字色完全照主题作者给的那颗（实测一份浅蓝天空图配 #f7fbff 的字，压到图上只有 2.00:1，
     压在那块近白的云上 1.00:1，整条栏看不见字）。
     现在把多层简写逐层拆：纯色层直接要，渐变层要它两端，图层留给采样（nav.samples，
     由设置面板在 Apply 那一刻采好写进存档）。一颗都拆不出来就返回空，照旧不翻 */
  function mcSlotColorSamples(raw) {
    const out = [];
    for (const layer of mcSlotLayers(String(raw || ''))) {
      const one = mcToRgb(layer);
      if (one) { out.push(one); continue; }
      if (!/gradient/i.test(layer)) continue;
      for (const c of layer.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) || []) {
        const rgb = mcToRgb(c);
        if (rgb) out.push(rgb);
      }
    }
    return out;
  }

  // 一颗根变量名（'bccards'）对回档名（'cards'）
  function mcSlotOfVar(name) { return String(name).replace(/^bc/, ''); }

  // 他亲手拧过的那一档排到最前。没拧过的保持原顺序（sort 在 V8 里是稳定的）
  function mcEditedFirst(names, edits) {
    const on = name => (edits && edits[mcSlotOfVar(name)] ? 1 : 0);
    return names.slice().sort((a, b) => on(b) - on(a));
  }

  /* ===== 卡底和页面底撞成一颗色时，把卡底往白推一档 =====
     抓来的 3197 份主题里有 402 份把 background-0（卡底）和 background-1（页面底）给成一模
     一样的色，色差小于 1 的有 500 份。两层同色时整面卡片墙就是一片——Canvas 原生靠
     .ic-DashboardCard 那颗 box-shadow 把卡分出来，而我们在 style.css 第 24 节把它撤了。
     这里不改作者的色相，只在"实在分不开"的那几份上把卡底沿往白的方向推到刚好分得开。
     门槛用 RGB 距离，和悬浮待办面板那颗（syncTodoCardBorderContrast）同一把尺，但拆成两个数：
     12 是"要不要出手"，18 是"出手之后要拉开到多少"。两个数分开是有原因的——Canvas 原生那对
     搭配（页面 #fafaf9、卡片纯白）自己就只有 9.2，照 18 判会把"白卡压在浅灰底上"这种
     本来分得开的正常搭配也算成撞色，实测 3197 份里要多误伤 66 份（其中 50 份是白卡浅灰底）。
     纯白和近白的卡底往白没有余量，推不动，那一批交给 mc-dash-outline 那圈现成的灰边。
     他亲手拧过卡底这一档就不再自动推，以他拧的那颗为准。
     这一档不另配开关，跟着 Keep text readable 那颗走（mcFlipOn）：它管的就是"两层分不开"
     这一类问题，文字翻黑白和卡底推亮是同一件事的两个画法，配两颗只会让人猜该按哪一颗。
     theme-boot.js 里有一份逐字对齐的首帧版，两边算出两个色＝刷新先看到一个色再翻一次 */
  const MC_CARD_LIFT_TRIGGER = 12;
  const MC_CARD_LIFT_GAP = 18;

  function mcRgbGap(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
  }

  /* 把一颗实色沿"往白"推，推到和 pageRgb 的距离刚好 MC_CARD_LIFT_GAP，取最小的那一档推力。
     本来就分得开（不到 MC_CARD_LIFT_TRIGGER 那根出手线）、往白推到头也不够、或者这一串
     压根不是一颗实色（渐变、图、带透明），一律返回 null 让调用方照原色画 */
  function mcLiftTowardWhite(raw, pageRgb) {
    const rgb = mcToRgb(raw);
    if (!rgb || !pageRgb || mcAlphaOf(raw) !== 1) return null;
    const p = [rgb[0] - pageRgb[0], rgb[1] - pageRgb[1], rgb[2] - pageRgb[2]];
    const d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    const trig2 = MC_CARD_LIFT_TRIGGER * MC_CARD_LIFT_TRIGGER;
    const gap2 = MC_CARD_LIFT_GAP * MC_CARD_LIFT_GAP;
    if (d2 >= trig2) return null;
    // 往白掺 k 之后离页面底的距离，是关于 k 的二次方程，解出刚好够线的那一根
    const v = [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
    const a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (a < 1) return null;
    const b = 2 * (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]);
    const disc = b * b - 4 * a * (d2 - gap2);
    if (disc <= 0) return null;
    const k = (-b + Math.sqrt(disc)) / (2 * a);
    if (!(k > 0) || k > 1) return null;
    const dist = o => Math.sqrt((o[0] - pageRgb[0]) ** 2 + (o[1] - pageRgb[1]) ** 2 + (o[2] - pageRgb[2]) ** 2);
    const solve = t => rgb.map((c, i) => Math.min(255, Math.round(c + v[i] * t)));
    // 四舍五入会把"刚好 18"抹成 17 点几，往上补到真过线；补到掺满还不够就交回 null，
    // 让调用方按"推不动"处理（那一批走灰边）
    let out = solve(k), kk = k;
    for (let g = 0; g < 60 && dist(out) < MC_CARD_LIFT_GAP; g++) {
      kk += 0.002;
      if (kk > 1) return null;
      out = solve(kk);
    }
    if (dist(out) < MC_CARD_LIFT_GAP) return null;
    return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('');
  }

  // 链条里赢的那一档是卡底一族（cards 或 background-0）才推。控件底板退到 background-0 时
  // 跟着一起推，这样卡片和坐在它身上的按钮、开关还是同一层色
  function mcCardLiftOf(name, raw, pageRaw, edited) {
    if (edited || !mcFlipOn()) return raw;
    if (name !== 'bccards' && name !== 'bcbackground-0') return raw;
    return mcLiftTowardWhite(raw, mcToRgb(mcSlotColorOf(String(pageRaw || '')))) || raw;
  }

  // 撞色又推不动（纯白那一批）＝该由那圈灰边来分界。判据和上面同一份数，不另算一遍
  function mcCardFillNeedsOutline(vars, edits, cleared) {
    if (!mcFlipOn()) return false;
    if (cleared && cleared['--mc-background-0']) return false;
    const bag = vars || {};
    const on = edits || {};
    const pageRgb = mcToRgb(mcSlotColorOf(String(bag['bcbackground-1'] || '')));
    if (!pageRgb) return false;
    for (const name of mcEditedFirst(BCX_TOKEN_MAP['--mc-background-0'], on)) {
      const v = String(bag[name] || '').trim();
      if (!v || !mcToRgb(v) || mcIsClear(v)) continue;
      if (on[mcSlotOfVar(name)]) return false;
      return mcRgbGap(mcToRgb(v), pageRgb) < MC_CARD_LIFT_TRIGGER && !mcLiftTowardWhite(v, pageRgb);
    }
    return false;
  }

  /* 那圈灰边到底挂不挂：停在 Canvas 那一档（卡片白、页面也白，一直没有分界）是旧的那半截，
     装着我们主题但卡底推不动（纯白那一批）是新增的半截。两处调用（applyLogoSettings 和
     每两秒那趟取色）都走这里，算式在 theme-boot.js 没有对应的一份——首帧不挂，
     和 Canvas 那一档一直是同一个时机，不闪 */
  function mcSyncDashOutline(snapIn) {
    // 每两秒那趟取色自己已经解析过一份快照，顺手传进来，别再 JSON.parse 一遍
    const snap = snapIn === undefined ? mcSnapshot() : snapIn;
    const vars = snap && snap.vars;
    document.documentElement.classList.toggle('mc-dash-outline',
      mcReadSetting('mc_dash_outline') !== '0' && (mcThemeOff() ||
        (vars ? mcCardFillNeedsOutline(vars, snap.edits || {}, mcClearedTokens(snap)) : false)));
  }

  /* 一颗 token 到底吃哪一串：链条照 BCX_TOKEN_MAP（卡底那档是 cards → background-0，
     控件底板是 buttons → background-0），他拧过的那一档插到最前。
     取色轮、面板上每一行、theme-boot 首帧三处共用这一条判据，差一点就是"行上写一个色、
     页面画另一个色"（Ghibli 上两处都撞过：卡底行显示他拧的色而页面透明，
     Control fill 行显示 no colour 而页面拿卡底在画）。
     面板上那一行也走这里，所以它报的就是页面上真正画出来的那颗（推过之后的），不撒谎。
     返回空串＝这一串读不出东西（压根没写，或者整串是图） */
  function mcChainRaw(token, vars, edits, cleared) {
    if (cleared && cleared[token]) return 'transparent';
    for (const name of mcEditedFirst(BCX_TOKEN_MAP[token], edits)) {
      const v = String((vars || {})[name] || '').trim();
      if (v && (mcToRgb(v) || mcIsClear(v))) {
        return mcCardLiftOf(name, v, (vars || {})['bcbackground-1'],
          !!(edits || {})[mcSlotOfVar(name)]);
      }
    }
    return '';
  }

  // 卡底那一档里"能拿来当底色比"的那颗：完全透明（作者没在这一档铺色）返回空串，
  // 调用方按"这一层没有底"处理。透明当黑底比会挑错字色，还会把侧栏胶囊拼成实心黑
  function mcCardBaseFor(vars, edits, snap) {
    const raw = mcChainRaw('--mc-background-0', vars, edits, mcClearedTokens(snap));
    return mcIsClear(raw) ? '' : mcSlotColorOf(raw);
  }

  /* ===== "磨砂"：哪几档有自己那根透明度滑杆 =====
     卡底那一档按了 No colour 不是"一团空气"，而是拿页面底提一档当 tint 压到 60%（看得见一层浅底）。
     控件底板按了 No colour 就是真的不铺板子，坐在它身下那一层上，所以它不吃 tint。
     两档各一根滑杆（0 到 100，默认 100＝一行都不多写），拧多少就把上面那一层再乘多少 */
  const BCX_FROST_LIFT = 0.12;
  /* 这一档透明时叠的那层底有多实：0.6。
     观感照的是全局搜索那颗（他认的那一份）＝半透明底＋身后那一层被糊掉，
     不是把底铺实。所以"读得穿"的成因永远是那一层糊没挂对地方，不是这颗数太小：
     糊必须挂在一个区域最外面那块板子上，挂在带位移的祖先肚子里取不到身后那一页 */
  const BCX_FROST_CLEAR_ALPHA = 0.6;
  const BCX_ALPHA_SLOTS = {
    '--mc-background-0': { slot: 'background-0', key: 'mc_panel_alpha', tint: true },
    '--mc-buttons': { slot: 'buttons', key: 'mc_buttons_alpha', tint: false }
  };
  function mcSlotAlpha(cfg) {
    // 没存过的时候 localStorage 返回 null，而 Number(null) 是 0 不是 NaN——
    // 直接 Number() 会把"没拧过"当成"拧到 0"，整站一层都不剩（实测首帧全透明）
    const saved = localStorage.getItem(cfg.key);
    if (saved === null || saved === '') return 100;
    const n = Number(saved);
    return isNaN(n) ? 100 : Math.max(0, Math.min(100, n));
  }
  function mcFrostFill(baseRgb, isClear, pageRgb, slider, tintWhenClear) {
    if (!isClear && slider >= 0.999) return null;
    if (isClear && !tintWhenClear) return null;
    const base = isClear
      ? (pageRgb || [255, 255, 255]).map(c => c + (255 - c) * BCX_FROST_LIFT)
      : baseRgb;
    if (!base) return null;
    const a = (isClear ? BCX_FROST_CLEAR_ALPHA : 1) * slider;
    const over = pageRgb || [255, 255, 255];
    return {
      css: 'rgba(' + base.map(c => Math.round(c)).join(',') + ',' + (Math.round(a * 1000) / 1000) + ')',
      rgb: base.map((c, i) => Math.round(c * a + over[i] * (1 - a)))
    };
  }

  // 一颗 token 链条算出来的原始串，过一遍它自己那根滑杆以后该画成什么。
  // 拖动预览和落盘取色都走这一条：两边各算就会出现"拖动时一个样、松手另一个样"
  function mcTokenCss(token, rawStr, pageRgb) {
    const cfg = BCX_ALPHA_SLOTS[token];
    if (!cfg || !rawStr) return rawStr;
    const f = mcFrostFill(mcToRgb(rawStr), mcIsClear(rawStr), pageRgb, mcSlotAlpha(cfg) / 100, cfg.tint);
    return f ? f.css : rawStr;
  }

  /* 带滑杆的那两档各过一遍自己的透明度，顺带同步侧栏那颗胶囊和 mc-frost 那个类名。
     抽成一个函数是因为设置里那根滑杆只改这一件事：整轮取色要抄卡图、比对页面变量，
     为了一颗透明度每挪 5% 跑它一趟不值当。
     底一律读 mcTokenBase（链条算出来的原始那一串），不读行内：行内可能已经是上一层 rgba，
     再乘一次就是二次透明，而且拧回 100 的时候没有原始值可还。
     返回卡底那一档的合成结果（没算＝null），调用方拿它去喂对比度兜底 */
  function mcApplyAlphaPass(pageRgb) {
    const k = document.documentElement.style;
    let cardFrost = null;
    for (const token of Object.keys(BCX_ALPHA_SLOTS)) {
      const base = String(mcTokenBase[token] || '');
      if (!base) continue;
      const cfg = BCX_ALPHA_SLOTS[token];
      const f = mcFrostFill(mcToRgb(base), mcIsClear(base), pageRgb, mcSlotAlpha(cfg) / 100, cfg.tint);
      const want = f ? f.css : base;
      if (k.getPropertyValue(token) !== want) k.setProperty(token, want);
      if (token === '--mc-background-0') cardFrost = f;
    }
    mcLastFrost = cardFrost ? cardFrost.css : '';
    /* 这个类名是给"哪几块要真挂模糊"那一步用的开关（这一步先只挂底色透明度）。
       判据是量这一档在屏幕上到底挡住多少（mcFrostAlphaOf 逐层拆），不再只认"上面那一步算没算出磨砂"，
       也不再把"读不出单色"直接判成不透明：磨砂那一步有好几条路根本不会跑（这一档整串是图或渐变、
       透明度滑杆拧到 0、页面那一层归 BC 时链条读不回颜色），于是屏幕上明明看得穿，类名却缺席，
       挂在它下面的磨砂规则一条都不落＝他报的"还是透明"。 */
    const resolvedCard = String(k.getPropertyValue('--mc-background-0')
      || getComputedStyle(document.documentElement).getPropertyValue('--mc-background-0') || '').trim();
    document.documentElement.classList.toggle('mc-frost', mcFrostAlphaOf(resolvedCard) < 0.98);
    // 侧栏那颗胶囊【收口】钉死吃卡底那一档：磨砂开着写同一串（它才和旁边的卡片是同一层），
    // 关着写合成前那颗实色。板上的字按底板自己的明暗翻黑/白，和强调色那颗勾同一个 helper。
    // 值没变就不写：行内样式每写一次都会再触发一轮 DOM 变动监听
    const plateRgb = cardFrost ? cardFrost.rgb : mcToRgb(String(mcTokenBase['--mc-background-0'] || ''));
    const plateSolid = cardFrost ? cardFrost.css : (plateRgb ? 'rgb(' + plateRgb.join(',') + ')' : '');
    for (const pair of [['--mc-nav-plate', plateSolid],
      ['--mc-nav-plate-ink', plateRgb ? mcInkOn('', plateRgb) : '']]) {
      const now = k.getPropertyValue(pair[0]);
      const want = pair[1] || '';
      if (want && now !== want) k.setProperty(pair[0], want);
      else if (!want && now) k.removeProperty(pair[0]);
    }
    return cardFrost;
  }

  function mcRecolorSlot(raw, color) {
    const keep = mcSlotLayers(String(raw || '')).filter(l => !mcToRgb(l));
    return keep.length ? keep.join(',') + ',' + color : color;
  }

  // edits 的键是槽名（'text-0'），并进 vars 时要换成 var 名（'bctext-0'）。
  // 只认那 12 档，别的键一律不接（用户能写进来的只有这一批）
  function mcEditVars(edits) {
    const out = {};
    for (const slot of Object.keys(edits || {})) {
      const value = String(edits[slot] || '').trim();
      if (value && /^[#\w-]+$/.test(value) && BTX_SLOTS.indexOf(slot) !== -1) out['bc' + slot] = value;
    }
    return out;
  }

  // 用改过的色重画三层底。只对改过的那一档动手，没改的档一行都不碰：
  // 抓取来的 surfaces 里 color/bg/layer 是三秒前从页面上量的真值，没理由被我们重算一遍
  function mcSnapSurfaces(snap) {
    const edits = snap.edits || {};
    const cleared = snap.clearSlots || {};
    const s = Object.assign({}, snap.surfaces || {});
    const paint = (key, slot) => {
      const src = s[key];
      if (!src) return;
      const rec = Object.assign({}, src);
      // 那颗 "No colour" 也走这条：它以前只把 token 翻成透明，可这一档要是画着一幅图，
      // 图还在下面盖着＝按下去画面一动不动，和"挑了色却没反应"是同一个病。
      // 摊掉图之后剩下什么？图那串简写自己底下那颗色（url(图),#eeeeee → #eeeeee），
      // 读不出纯色才真给透明——不然"我不要这张图"会变成整片浏览器的白
      const own = String(rec.raw || rec.color || '');
      const value = edits[slot] || (cleared[slot] ? (mcSlotColorOf(own) || 'transparent') : '');
      if (!value && !rec.flat) return;
      if (!value) { delete rec.flat; s[key] = rec; return; }
      /* 【带图的档现在能改成色了】sidebar 1067/3197 份、background-0 63 份在这一档放的是一幅图
         （或一层渐变）。以前把新色拼到图层最下面（mcRecolorSlot），图盖在上面＝按下去什么都不变，
         所以那两行整行被锁住、值那一列写 picture。现在改成"摊平"：这一档只画他挑的那颗色。
         原来那串 raw/bg/layer 一个字都不动地留在记录里，只多挂一个 flat 标记——
         撤掉改动就是摘标记，图当场回来，不用重新抄一遍那幅图 */
      if (mcSlotHasImage(rec.raw) || rec.bg || rec.layer) {
        rec.color = value;
        rec.flat = true;
      } else if (rec.raw) {
        rec.raw = mcRecolorSlot(rec.raw, value);
        delete rec.flat;
      } else {
        rec.color = value;
        delete rec.flat;
      }
      s[key] = rec;
    };
    paint('body', 'background-0');
    paint('app', 'background-1');
    paint('nav', 'sidebar');
    const ink = edits['sidebar-text'];
    if (ink && s.nav) s.nav = Object.assign({}, s.nav, { text: ink, icon: ink });
    return s;
  }

  /* 字体这条通道只有一个写者：他挑的那份优先，没有就回到这份主题自带的。
     两条落点都要一起翻——插 <link> 拉字族那份读 fonts，写 body 字族那条规则读 surfaces.body.font，
     少翻一条就是"链接挂了但页面上还是老字体"或者反过来。
     没记过这两层字段的快照（旧存档、BC 每三秒抄的那份镜像）一个字都不改：
     那份的 surfaces.body.font 是从页面上量回来的整条字体栈，我们没有权利拿空串把它抹掉 */
  function mcApplyFontChannel(snap) {
    const write = (font) => {
      snap.fonts = mcFontLinks(font);
      if (snap.surfaces && snap.surfaces.body) snap.surfaces.body.font = mcFontFamily(font);
    };
    if (snap.fontEdit) write(snap.fontEdit);
    else if (snap.baseFont !== undefined) write(snap.baseFont);
  }

  /* 设置里 Theme Customizer 那一行字体的唯一落盘口：交一份 {family, link}，或者交 null 回到自带的。
     第一次动它先把当前生效的那份补记成"自带的"，这样老快照上那颗 Default 也回得去 */
  function mcSetFont(input) {
    const snap = mcSnapshot();
    if (!snap) return null;
    if (snap.baseFont === undefined) snap.baseFont = mcFontFromLinks(snap.fonts);
    snap.fontEdit = input ? mcFontRecord(input) : null;
    return mcCommitSnapshot(snap);
  }

  function mcResetFont() {
    const snap = mcSnapshot();
    if (!snap || !snap.fontEdit) return snap;
    if (snap.baseFont === undefined) snap.baseFont = mcFontFromLinks(snap.fonts);
    snap.fontEdit = null;
    return mcCommitSnapshot(snap);
  }

  // 那一行要知道的两件事：现在生效的是不是他挑的，以及 Default 那颗指的是哪一份
  function mcFontState() {
    const snap = mcSnapshot();
    if (!snap) return { edit: null, base: null };
    return {
      edit: snap.fontEdit || null,
      base: snap.baseFont === undefined ? mcFontFromLinks(snap.fonts) : (snap.baseFont || null)
    };
  }

  /* 把正在用的这一格改指向库里的一份记录（"收进库"那一步的收尾）。
     不改任何颜色和图，只换 imported.code：换完之后他在这格里拧过的色、按掉的 No colour
     还在，而稍后 Apply 那份副本时 code 对得上，走的是"同一份主题再 Apply"那条，不会被清 */
  function mcAdoptThemeRecord(id, title) {
    const snap = mcSnapshot();
    if (!snap || !id) return null;
    snap.imported = { title: String(title || (snap.imported && snap.imported.title) || ''), code: 'mc:' + id };
    mcWriteSnapshot(JSON.stringify(snap));
    return snap;
  }

  // 存快照 + 当场画上，改一档和撤一档走同一条，别留两套房
  function mcCommitSnapshot(snap) {
    if (!snap.base) snap.base = Object.assign({}, snap.vars || {});
    snap.edits = snap.edits || {};
    snap.vars = Object.assign({}, snap.base, mcEditVars(snap.edits));
    // 【合二为一】卡底不再单独一档，也不再往白里掺：主题给了 cards 就用它给的，没给就直接吃
    // background-0（BCX_TOKEN_MAP 那条退路），和面板上那一行"Card and panel fill"是同一颗色
    // BC 的主题表读的是 --bcX-ungradient（把渐变剥掉那档纯色），只写 --bcX 的话改色不显，
    // 所以改过的那一档补一个同名 -ungradient 的纯色兄弟
    const slots = Object.keys(snap.edits);
    for (const slot of slots) {
      const value = snap.vars['bc' + slot];
      if (value && mcToRgb(value)) snap.vars['bc' + slot + '-ungradient'] = value;
    }
    // 行上抄来的那份 rootVars 里还带着这一档的旧色，排在后面会把新色顶掉，先摘掉
    snap.rootVars = mcStripSlots(snap.rootVars, slots);
    snap.surfaces = mcSnapSurfaces(snap);
    mcApplyFontChannel(snap);
    snap.themeCss = mcThemeCss({ surfaces: snap.surfaces, cards: snap.cards || {}, vars: snap.vars });
    mcWriteSnapshot(JSON.stringify(snap));
    // 立刻生效，不要求他刷新：根变量、编译出来的那份表，两边都按签名强制重来一遍。
    // 那份表只在 BC 不在的时候贴（BC 在跑时它自己画，我们贴上去的一份会留在页面上不动，
    // 它换主题就不跟了）——判据用每两秒刷一次的那个类名，和别处同一颗开关
    mcVarSig = null;
    applyThemeRootVars([mcVarsToRoot(snap.vars), snap.rootVars].filter(Boolean).join(''));
    mcThemeSheetSig = null;
    const bcLive = document.documentElement.classList.contains('mc-bc-live');
    mcStep('applyModernThemeSheet', () => applyModernThemeSheet(!bcLive));
    // 字族名写进那份表只是半件事：那份字得有人去下载。这一条和上面那条同一档开关，
    // BC 在跑时它自己拉它的字体，我们的链接排它后面就是两套字抢同一层
    mcStep('applyThemeFonts', () => applyThemeFonts(!bcLive && Array.isArray(snap.fonts) ? snap.fonts : []));
    return snap;
  }

  // 从一串 --bcX:v; 里把改过的那几档摘掉（档名和它的 -ungradient 兄弟一起）
  function mcStripSlots(raw, slots) {
    const text = String(raw || '');
    if (!text || !slots || !slots.length) return text;
    const drop = {};
    for (const slot of slots) {
      drop['--bc' + slot] = 1;
      drop['--bc' + slot + '-ungradient'] = 1;
    }
    return text.split(';').filter(pair => {
      const name = pair.slice(0, pair.indexOf(':')).trim();
      return name && !drop[name];
    }).join(';');
  }

  function mcSetSlotColor(slot, hex) {
    const snap = mcSnapshot();
    if (!snap || BTX_SLOTS.indexOf(slot) === -1 || !hex) return null;
    // 【带图的档现在能改了】以前这一档直接拒（新色拼到图层最下面，图盖在上面＝按下去没反应），
    // 面板那行跟着锁住、值那一列写 picture。现在由 mcSnapSurfaces 把那一档摊平：
    // 只画他挑的这颗色，图先不画，撤掉改动就回来（判据和落点都在那儿，面板不另算一份）
    snap.edits = Object.assign({}, snap.edits || {}, { [slot]: hex });
    // 拧了色＝这一档他要一颗实色，那颗 "No colour" 当场撤掉，不用他再去按第二下
    if (snap.clearSlots) delete snap.clearSlots[slot];
    return mcCommitSnapshot(snap);
  }

  /* 面板上那颗 "No colour"：这一档他不铺色，别跟着链条往后借。
     存成一个独立标记（clearSlots），不写进那一档的槽值——background-0 那颗槽值还同时管着
     body 的底色（mcThemeCss 里 body{background-color:--bcbackground-0}），
     往里塞 transparent 会把页面底也一起捅穿，露出浏览器的白底 */
  function mcSetSlotClear(slot, on) {
    const snap = mcSnapshot();
    if (!snap || !BCX_CLEARABLE[slot]) return null;
    snap.clearSlots = Object.assign({}, snap.clearSlots || {});
    if (on) snap.clearSlots[slot] = true;
    else delete snap.clearSlots[slot];
    return mcCommitSnapshot(snap);
  }

  // 撤掉一档＝回到这份主题本来的颜色（base），不是回到"我们上次写进去的那一份"
  function mcResetSlotColors(slots) {
    const snap = mcSnapshot();
    if (!snap) return null;
    const edits = Object.assign({}, snap.edits || {});
    const one = Array.isArray(slots) && slots.length ? slots : Object.keys(edits);
    one.forEach(slot => delete edits[slot]);
    snap.edits = edits;
    // 那一行的"撤回去"要连那颗 "No colour" 一起撤：一个键管一行，不留第二处状态。
    // 只撤这一次点到的那几档，撤别的行不该顺手把它清了
    if (snap.clearSlots) {
      one.forEach(slot => delete snap.clearSlots[slot]);
      if (!Object.keys(snap.clearSlots).length) delete snap.clearSlots;
    }
    return mcCommitSnapshot(snap);
  }

  // 面板上那 12 行的初始值
  function mcThemeSlotRows() {
    const snap = mcSnapshot();
    const vars = (snap && snap.vars) || {};
    const edits = (snap && snap.edits) || {};
    const cleared = mcClearedTokens(snap);
    const out = {};
    for (const slot of BTX_SLOTS) {
      const ownRaw = String(vars['bc' + slot] || '');
      const token = BCX_TOKEN_MAP['--mc-' + slot] ? '--mc-' + slot : '';
      // 每一行报的都是页面上真正在用的那一串（整条退路链，加他拧过的那档最前）。
      // 以前只报自己那一串，于是两处对不上：卡底行写他拧的色而页面是透明；
      // Control fill 行写 no colour 而页面拿卡底那一档在画（3197 份里 3096 份没有 buttons 档）
      const raw = token ? mcChainRaw(token, vars, edits, cleared) : ownRaw;
      // 收成 #rrggbb 再交给面板（理由见 mcHexOf：抓取值是带小数的 rgb 串，直接用会连累色块、
      // 取色器初值、行高三个地方）。收不出单色（整串是渐变/图）时 color 为空，仍照 hasImage 显示。
      // 有效值是透明也报空：那颗斜纹方框和"no colour"那一列就是给它用的
      const seeThrough = mcIsClear(raw);
      const color = seeThrough ? '' : mcHexOf(mcSlotColorOf(raw));
      out[slot] = {
        color,
        rgb: color ? mcToRgb(color) : null,
        // clear 是"他显式按了那颗 No colour"，和 seeThrough（这一档现在看不看得穿）分开报：
        // 前者管那颗键的按下态，后者管方框和值那一列
        clear: !!(token && cleared[token]),
        // 这份主题本来在这一档放的是不是一幅图（base 那份，不带他拧的改动）。
        // 面板拿它决定那句话说的是"挑一颗色会把图撤掉"还是"图已经被换掉了"
        baseImage: mcSlotHasImage(String((snap.base && snap.base['bc' + slot]) || '')),
        seeThrough,
        edited: !!edits[slot] || !!(token && cleared[token]),
        // 那颗"这幅图占着这一档、没有色可改"的锁只看这一档自己那一串（图盖在色上面，改了也不显）
        hasImage: mcSlotHasImage(ownRaw)
      };
    }
    return out;
  }

  /* 拖动取色器的那几百毫秒里不写快照（每挪一像素存一次 localStorage、重编译一份表，代价太大），
     先把这一组色盖成一份临时样式表，松手那一刻才落进快照。
     临时表里的每条都带 !important：content.js 是往 <html> 的行内样式写这些 token 的，
     行内不带 important 会被样式表带 important 的那条顶掉（样式表 > 行内 只在两边都不带 important 时反过来）*/
  let mcColorPreviewNode = null;
  function mcSlotPreviewCss(edits) {
    // 拖动预览那一份也是拼进 <style> 的文本，和落盘那一条同一道值闸（判据只有一份，在 theme-lib.js）
    const guard = window.mcCssGuard;
    const val = raw => (guard ? guard.value(raw) : String(raw == null ? '' : raw));
    const v = mcEditVars(edits);
    const keys = Object.keys(v);
    if (!keys.length) return '';
    const snap = mcSnapshot() || {};
    // 这一份是"改完以后的那一档"和快照里其余档合起来的样子，和落盘那一刻算的是同一件事
    const eff = Object.assign({}, snap.vars || {}, v);
    let root = '';
    for (const name of keys) {
      const token = '--' + name;
      const value = val(v[name]);
      if (!value || (guard && !guard.name(token))) continue;
      root += token + ':' + value + '!important;';
    }
    const previewCleared = mcClearedTokens(snap);
    const mergedEdits = Object.assign({}, snap.edits || {}, edits);
    const previewPageRgb = mcToRgb(mcSlotColorOf(eff['bcbackground-1'] || '') || '') || null;
    for (const token of Object.keys(BCX_TOKEN_MAP)) {
      // 只重画这一趟草稿牵到的那几颗 token（其余留在行内，别拿快照去覆盖从页面上读来的值）。
      // 但牵到的那些要按整条链重算，判据和落盘同一份：以前这里只看"草稿里有这一档就归它"，
      // 于是拖卡底那一档会把控件底板一起带着走，松手又弹回它自己那颗 buttons——
      // 他说的"调节过程中跟着变，结束就恢复"就是这一条
      const touched = previewCleared[token] || BCX_TOKEN_MAP[token].some(name => v[name]);
      if (!touched) continue;
      const rawStr = previewCleared[token] ? 'transparent' : mcChainRaw(token, eff, mergedEdits, {});
      const css = val(mcTokenCss(token, rawStr, previewPageRgb));
      if (css) root += token + ':' + css + '!important;';
    }
    // 兜底规则（文字在卡底上太淡就翻成纯黑或纯白）住在 applyModernPalette 里，
    // 那一条是每两秒跑一趟的，等不到它：拖动时不一起算，松手才翻＝画面跳一下
    const flipOn = mcFlipOn();
    const accent = v['bclinks'];
    if (flipOn && accent) {
      const rgb = mcToRgb(accent);
      if (rgb) root += '--mc-links-ink:' + mcInkOn(accent, rgb) + '!important;';
    }
    // 【合二为一】卡底＝面板那一行、取色轮、首帧四处共用的那一条判据（拧过的那档排最前、
    // 完全透明不当黑底使）。这里自己排一遍就会和落盘算出两个结果＝拖动一个色、松手另一个色
    const cardRaw = mcChainRaw('--mc-background-0', eff,
      Object.assign({}, snap.edits || {}, edits), mcClearedTokens(snap));
    const cardRgb = flipOn && !mcIsClear(cardRaw) ? mcToRgb(cardRaw || '') : null;
    // 同一档字也坐在页面底上。这里只看卡底会和落盘那份算出两个结果＝拖动一个色、松手另一个色
    const flipPageRgb = flipOn ? mcToRgb(mcSlotColorOf(eff['bcbackground-1'] || '') || '') : null;
    if (cardRgb || flipPageRgb) {
      const flip = (token, slot) => {
        const rgb = mcToRgb(String(eff['bc' + slot] || ''));
        if (!rgb) return;
        const pageContrast = flipPageRgb ? modernContrast(rgb, flipPageRgb) : 99;
        const cardContrast = cardRgb ? modernContrast(rgb, cardRgb) : 99;
        if (pageContrast < 3 || cardContrast < 3) root += token + ':' + mcFlipInk([cardRgb, flipPageRgb]) + '!important;';
      };
      flip('--mc-text-0', 'text-0');
      flip('--mc-text-1', 'text-1');
      flip('--mc-text-2', 'text-2');
    }
    // 链接文字那一档也要跟着实时走。两个分支都得写：不写的那一支会被上面注释说的那条
    // "行内不带 important 顶不过表里带 important 的"反过来咬一口，表里没有＝行内那份旧的还在
    const accentLinkRgb = mcToRgb(String(accent || ''));
    if (accentLinkRgb) {
      const pageRgb = flipOn ? mcToRgb(mcSlotColorOf(eff['bcbackground-1'] || '') || '') : null;
      const linkOk = !flipOn
        || ((!cardRgb || modernContrast(accentLinkRgb, cardRgb) >= 3)
          && (!pageRgb || modernContrast(accentLinkRgb, pageRgb) >= 3));
      const linkVal = linkOk ? val(accent) : 'var(--mc-text-0)';
      if (linkVal) root += '--mc-links-text:' + linkVal + '!important;';
    }
    let css = ':root{' + root + '}';
    /* 那三层底要单独钉：这一档在主题里是一幅图（或一层渐变）时，光补一条 background-color 没用——
       编译表那条是 background 简写，侧栏那张图还另有单独一条 background-image 排在后面，
       图盖在新色上面＝拖动过程中页面一动不动，松手才翻（落盘那条走的是同一个判据：mcSnapSurfaces 的 flat）。
       选择器前面多挂一层 html 抬权重，压得过表里那条 #application */
    const surf = (key) => (snap.surfaces && snap.surfaces[key]) || {};
    const covered = (rec) => mcSlotHasImage(rec.raw) || !!rec.bg || !!rec.layer;
    // 每一条选择器自己带 html，不能整串前面拼一个：那一串里除第一个以外全变成 html html #wrapper＝不命中
    const floor = (sel, rawValue, key) => {
      const value = val(rawValue);
      if (!value) return '';
      return sel.map(one => one ? 'html ' + one : 'html').join(',') + '{background-color:' + value
        + '!important' + (covered(surf(key)) ? ';background-image:none!important' : '') + '}';
    };
    const pageVal = v['bcbackground-1'] || (!eff['bcbackground-1'] ? v['bcbackground-0'] : '');
    if (pageVal) css += floor(['', 'body', '#application', '#wrapper', '#main'], pageVal, 'app');
    if (v['bcsidebar']) css += floor(['.ic-app-header'], v['bcsidebar'], 'nav');
    if (v['bcsidebar-text']) {
      const snap = mcSnapshot();
      const nav = (snap && snap.surfaces && snap.surfaces.nav) || {};
      const ink = val(flipOn ? mcSidebarInk(v['bcsidebar'] || nav.color || nav.raw || '', v['bcsidebar-text'], nav.samples) : v['bcsidebar-text']);
      if (!ink) return css;
      css += ':root{--mc-nav-ink:' + ink + '!important;}'
        + '.ic-app-header__menu-list-link{color:' + ink + '!important;}'
        + '.ic-app-header__menu-list-link .menu-item__text{color:' + ink + '!important;}'
        + '.ic-app-header__menu-list-link .ic-icon-svg,.ic-app-header__menu-list-link svg,'
        + '.ic-app-header__menu-list-link svg *,'
        + '.mc-nav-courses-caret,.mc-nav-bc-caret,.mc-course-caret,.mc-chev,'
        + '.ic-app-header .ic-icon-svg,.menu-item-icon-container svg{color:' + ink
        + '!important;fill:' + ink + '!important;}';
    }
    return css;
  }

  function mcPreviewSlotColors(edits) {
    const css = mcSlotPreviewCss(edits);
    if (!css) {
      if (mcColorPreviewNode) { mcColorPreviewNode.remove(); mcColorPreviewNode = null; }
      return;
    }
    if (!mcColorPreviewNode) {
      mcColorPreviewNode = document.createElement('style');
      mcColorPreviewNode.id = 'mc-color-preview';
      document.head.appendChild(mcColorPreviewNode);
    }
    mcColorPreviewNode.textContent = css;
  }

  // 一块色上面放黑字还是白字。强调色那颗勾、色板上的十六进制都读这一条
  function mcInkOn(raw, rgb) {
    const probe = rgb || mcToRgb(raw);
    return probe && mcLuminance(probe) > 0.45 ? '#000000' : '#ffffff';
  }

  // 可读性兜底要翻成纯黑还是纯白：同一档字色同时坐在卡底和页面底上，所以按"两层里更差的那一层"
  // 挑，谁在更差那层上还更高就用谁。只看先失败的那一层会挑出在那层读得清、在另一层糊掉的颜色
  // （实测这套主题：卡底浅粉、页面底中粉，纯白的淡字只看页面底会被判成该配白，落到浅卡上就没了）
  function mcFlipInk(bases) {
    const on = (bases || []).filter(Boolean);
    if (!on.length) return '#000000';
    const worst = ink => on.reduce((min, base) => Math.min(min, modernContrast(ink, base)), 99);
    return worst([0, 0, 0]) >= worst([255, 255, 255]) ? '#000000' : '#ffffff';
  }

  /* 侧栏字色在它那块底上分不开时翻成纯黑或纯白（3:1，和正文那几档同一道线）。
     底可以有好几颗：槽值拆出来的（纯色或渐变两端）＋那张图上采下来的三颗
     （整张平均、最暗那 10%、最亮那 10%，由设置面板在 Apply 时写进存档的 nav.samples）。
     判"读不读得清"只看代表性的那一颗：采到过图就按整张平均，没采到就按槽值拆出来的那些。
     不按图的最暗／最亮那端判，是因为一张花图里总有一两颗星或一块云，
     那样任何字色都会被判不合格、每份图主题的字都会被强翻成纯黑纯白，主题那一档等于作废。
     真要到翻的地步，挑黑还是白按全部底（含那两端）里最差对比度取更高那颗，和正文同一口径。
     一颗底都拿不到（图读不到像素、槽值又整串是 url）就原样交回主题那颗，绝不猜。
     编译那份表、取色轮那份内联表、拖动时的临时预览都读这一条，三边不会一个翻一个不翻 */
  function mcSidebarInk(baseRaw, label, samples) {
    const ink = mcToRgb(label);
    if (!ink) return label;
    const slotBases = mcSlotColorSamples(baseRaw);
    const pic = (Array.isArray(samples) ? samples : []).filter(rgb => Array.isArray(rgb) && rgb.length >= 3);
    // 这一档画着一张图、又还没采到像素：不判。拿渐变两端当底是假底——图层排在渐变上面，
    // 眼睛看到的是那张图，"白字压深蓝渐变 4.45:1 合格"这种结论会把真糊的那批全放过
    const hasPicture = /url\(/i.test(String(baseRaw || ''));
    const judge = pic.length ? [pic[0]] : (hasPicture ? [] : slotBases);
    if (!judge.length) return label;
    const bases = slotBases.concat(pic);
    const worst = judge.reduce((min, base) => Math.min(min, modernContrast(ink, base)), 99);
    return worst < 3 ? mcFlipInk(bases) : label;
  }

  /* 侧栏那一档整串是图、存档里又没有那三颗采样：就地补采一次。
     只在 Apply 那一刻采是不够的——他在这条改动之前就已经 Apply 过的那份存档里永远没有 samples，
     换安装方式、从别的格子读回旧档也一样缺。采到之后把三颗写回存档，并照新底重编译一份
     themeCss，下一次加载首帧就是最终字色，不会先白一下再翻黑一下。
     读不到像素（外链被 CORS 挡）就一颗都不写，上面那条判色自己会选择不判 */
  var mcNavSampleAt = 0, mcNavSampleTried = '';
  function mcNavSamplePass(snap) {
    if (!snap || !snap.surfaces || !snap.surfaces.nav) return;
    if (!window.mcLib || !window.mcLib.samplePicture) return;
    const nav = snap.surfaces.nav;
    if (nav.samples && nav.samples.length) return;
    // 这一档被他摊平了＝那张图根本不画，采它的像素没有意义（还会顺手重写一次存档、重编译一份表）
    if (nav.flat) return;
    const raw = String((snap.vars && snap.vars.bcsidebar) || nav.raw || '');
    const m = /url\(\s*['"]?([^'")]+)/i.exec(raw);
    if (!m) return;
    const url = m[1];
    // 一颗地址一趟只试一次：读不到的那种（外链被 CORS 挡）每两秒重试会刷满控制台
    if (mcNavSampleTried === url) return;
    const now = Date.now();
    if (now - mcNavSampleAt < 5000) return;
    mcNavSampleAt = now;
    mcNavSampleTried = url;
    window.mcLib.samplePicture(url).then(rgb => {
      if (!rgb || !rgb.length) { console.log('[MCX] sidebar picture: 读不到像素，这一档不判色', url.slice(0, 90)); return; }
      const cur = mcSnapshot();
      if (!cur || !cur.surfaces || !cur.surfaces.nav) return;
      if (cur.surfaces.nav.samples && cur.surfaces.nav.samples.length) return;
      cur.surfaces.nav.samples = rgb;
      // cards 传空对象：Apply 那一刻编译 themeCss 就是这么调的（每张卡的图由另一条通路写），
      // 这里多塞就会给新版卡补出一批原本不存在的规则
      cur.themeCss = mcThemeCss({ surfaces: cur.surfaces, cards: {}, vars: cur.vars });
      mcWriteSnapshot(JSON.stringify(cur));
      console.log('[MCX] sidebar picture: 采到三颗底，重跑一轮取色', JSON.stringify(rgb));
      mcStep('applyModernPalette', () => applyModernPalette());
    });
  }

  /* 那三条"分不开就翻成纯黑/纯白"的可读性兜底（正文 3:1、侧栏 3:1、强调块上那颗符号）
     统一由这一颗开关管。开＝照旧护住可读性；关＝一档只管一档，主题给什么色就上什么色，
     代价是浅底配浅字那种组合会重新糊掉（当初加它就是这个原因）。
     四条落点都读这一颗：取色轮、编译那份表、拖动时的临时预览、首帧引导脚本，
     漏一条就会出现"面板说关了、页面上还在翻" */
  function mcFlipOn() { return localStorage.getItem('mc_set_theme_flip') !== '0'; }

  /* 那一行改了以后页面上真会发生什么。兜底规则（文字太淡就翻成纯黑或纯白、线档退档）
     住在上面那段 applyModernPalette 里，所以这句判断也只能写在这份文件：
     面板那边抄一份阈值，改天这边动一下阈值就两边各说一套。
     太淡那一句说的是"他看得见的那个变化"，不是"对比度不够" */
  function mcSlotHint(slot, hex) {
    // 那三条兜底关着的时候页面不会翻色，这句提示就成了假警报
    if (!mcFlipOn()) return '';
    const snap = mcSnapshot();
    const vars = (snap && snap.vars) || {};
    const edits = (snap && snap.edits) || {};
    const value = hex || vars['bc' + slot] || '';
    if (slot === 'links') {
      const rgb = mcToRgb(value);
      if (!rgb) return '';
      // 这一档现在也当链接文字用，而链接文字要坐的底色比色块那一档挑得多：卡底和页面底两层
      // 都得拉得开才敢上强调色（判据和下面 applyModernPalette 里那段一样）。
      // 够不开的时候屏幕上看得见的是"链接还是正文那个色"，这句就说这件事
      if (localStorage.getItem('mc_link_accent') !== '0') {
        const cardBg = mcToRgb(mcCardBaseFor(vars, edits, snap));
        const pageBg = mcToRgb(mcSlotColorOf(edits['background-1'] || vars['bcbackground-1'] || ''));
        const faint = (cardBg && modernContrast(rgb, cardBg) < 3)
          || (pageBg && modernContrast(rgb, pageBg) < 3);
        if (faint) return 'Too faint on the plates to read as link text, so links keep the main text colour.';
      }
      return mcLuminance(rgb) > 0.45
        ? 'Light enough that the mark on it turns black rather than white.'
        : '';
    }
    // 文字压在哪一档上：卡底那一档就是面板上"Card and panel fill"那一行报的那一颗
    if (slot !== 'text-0' && slot !== 'text-1' && slot !== 'text-2' && slot !== 'sidebar-text') return '';
    const fg = mcToRgb(value);
    const bg = mcToRgb(slot === 'sidebar-text'
      ? mcSlotColorOf(edits.sidebar || vars.bcsidebar || '')
      : mcCardBaseFor(vars, edits, snap));
    if (!fg || !bg) return '';
    if (modernContrast(fg, bg) >= 3) return '';
    const ink = mcLuminance(bg) > 0.5 ? 'black' : 'white';
    return 'Too faint on the ' + (slot === 'sidebar-text' ? 'sidebar' : 'plates')
      + ' at this shade, so the page paints that text ' + ink + ' instead of your colour.';
  }

  /* 这一档在这份主题里是空的，页面上它退到哪一档。句子给 Colors 面板那一行用，
     判据不另写一份：退路链就是 BCX_TOKEN_MAP 里那一串，链上排在它后面的就是它借的那档。
     background-0 特殊：它没有档可借，退的是 style.css 里那条"往 Whole background 掺白"的磨砂 */
  const MC_SLOT_LABEL = {
    'background-0': 'Card and panel fill', 'background-1': 'Whole background', 'background-2': 'Track',
    'text-0': 'Main text', 'text-1': 'Second text', 'text-2': 'Faint text',
    'borders': 'Lines', 'links': 'Accent', 'buttons': 'Control fill'
  };
  function mcSlotFallbackNote(slot) {
    const token = BCX_TOKEN_MAP['--mc-' + slot] ? '--mc-' + slot : '';
    // 那两档有那颗 "No colour"，所以"为什么这一行是空的"有三种答案，得说清是哪一种：
    // 他自己按了、作者给的就是透明、或者它借了别的档
    if (token && BCX_CLEARABLE[slot]) {
      const snap = mcSnapshot();
      if (snap && mcClearedTokens(snap)[token]) {
        return slot === 'buttons'
          ? 'You set this to no colour. Buttons and fields stop painting a plate and sit on the surface behind them.'
          : 'Frosted is on. Those panels let the page behind them show through as a soft wash.';
      }
      if (snap && mcIsClear(mcChainRaw(token, snap.vars, snap.edits, {}))) {
        return slot === 'buttons'
          ? 'This theme paints no colour here. Buttons sit on the surface behind them.'
          : 'This theme paints no colour here, so those panels go frosted. Set a colour to make them solid.';
      }
    }
    if (slot === 'background-0') return 'Falls back to a lighter mix of Whole background.';
    // 侧栏那两档不借别的槽：没写就是站点自己画的那块深蓝（整串是图的那种走另一条，面板显示 picture）
    if (slot === 'sidebar' || slot === 'sidebar-text') return 'Falls back to the colour Canvas paints there.';
    // 控件底板退两档：裸的落在卡底那一档，坐在卡片里的那些落在内容区那一档
    // （style.css 里那批容器各重声明了一次 --mc-buttons，判据在那边）
    if (slot === 'buttons') return 'Falls back to Card and panel fill, and to Whole background inside cards.';
    for (const token of Object.keys(BCX_TOKEN_MAP)) {
      const chain = BCX_TOKEN_MAP[token];
      const at = chain.indexOf('bc' + slot);
      if (at === -1 || at === chain.length - 1) continue;
      const next = chain[at + 1].replace(/^bc/, '');
      return 'Falls back to ' + (MC_SLOT_LABEL[next] || next) + '.';
    }
    return 'Falls back to the plain no-theme colour.';
  }

  // 渲染快照里的课程卡图：只在"读不到页面变量"的时候画（BC 开着时它自己会画，双画会叠层）。
  // 它把图放 ::before、颜色膜放 ::after，伪元素没法写行内样式，所以我们用两个同层同 z-index 的
  // 子 div 顶上去，画法跟它一致（图 z-index 0、膜 z-index 1、都 pointer-events:none）。
  function applyModernCardImages(allow) {
    const snap = allow && mcPaintsPageTheme() ? mcSnapshot() : null;
    const cards = snap && snap.cards ? snap.cards : null;
    for (const card of document.querySelectorAll('.ic-DashboardCard, [data-testid^="course-grade-card"]')) {
      const link = card.querySelector('a[href*="/courses/"]');
      const id = (link && (link.getAttribute('href').match(/\/courses\/(\d+)/) || [])[1])
        || ((card.getAttribute('data-testid') || '').match(/course-grade-card-(\d+)/) || [])[1];
      const header = id && modernCardHeader(card);
      if (!header) continue;
      const entry = cards && cards[id];
      const sig = entry ? entry.img + '|' + entry.film + '|' + entry.filter : '';
      if (header.dataset.mcCardImg === sig) continue;
      header.dataset.mcCardImg = sig;
      const img = header.tagName === 'IMG' ? header : header.querySelector('img');
      let layer = header.querySelector(':scope > .mc-card-img');
      let film = header.querySelector(':scope > .mc-card-film');
      if (!entry) {
        for (const prop of ['position', 'overflow', 'background']) header.style.removeProperty(prop);
        if (layer) layer.remove();
        if (film) film.remove();
        if (img) img.style.removeProperty('display');
        continue;
      }
      header.style.setProperty('position', 'relative', 'important');
      header.style.setProperty('overflow', 'hidden', 'important');
      header.style.setProperty('background', 'none', 'important');
      if (img) img.style.setProperty('display', 'none', 'important');
      if (!layer) { layer = document.createElement('div'); layer.className = 'mc-card-img'; header.appendChild(layer); }
      layer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;'
        + 'background-image:' + (entry.img || 'none') + ' !important;background-size:cover !important;'
        + 'background-position:center !important;background-repeat:no-repeat !important;'
        + 'filter:' + (entry.filter || 'none') + ' !important';
      if (entry.film) {
        if (!film) { film = document.createElement('div'); film.className = 'mc-card-film'; header.appendChild(film); }
        film.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;'
          + 'background:' + entry.film + ' !important';
      } else if (film) film.remove();
    }
  }

  // ===== 整份搬它的主题 =====
  // 它的主题落地就是「几份 <style> 原文 + 写在根上的一组 --bc* 变量」：
  // 哪张 Canvas 元素吃哪个槽全写死在那几张表里（"background-0":'#announcementWrapper > div > div, #breadcrumbs, …'），
  // 所以它切页面不掉色。我们不再逐元素抄最终值（那样永远有抄漏的白块），改成整份存、整份贴。
  const BCX_SHEET_LIMIT = 1200000;

  /* 【测试阶段，禁止删除】贴回它样式表原文这条通路已停用，但不删。
     现在的口径：External Extension 在后台跑时我们只记参数（槽值 vars、根变量 rootVars、
     surfaces、卡图 cards、字体 fonts），渲染一律用我们自己从参数编译出的 themeCss，
     跟设置里"导入 JSON"那条通路同一套形状、同一份存储（正在用的那一格存档，见 mcSaveKey）、同一段渲染代码。
     下面 mcThemeSheets 的收集循环、applyModernSheets 的注入分支、还有 theme-boot.js
     里对应那一段，全是为对照和回退留着的路径。它们现在跑不到属于预期状态，不是死代码：
     在用户明确说"贴表机制可以删了"之前，任何清理、重构、瘦身都不许动这一块。
     要恢复：把这个常量改成 true（theme-boot.js 里同名常量也要一起改）。 */
  const BCX_PASTE_SHEETS = false;

  function mcThemeSheets() {
    const sheets = [];
    let total = 0;
    // 【测试阶段，禁止删除】开关关掉时这段整块不跑，sheets 留空数组：
    // 快照的字段形状不变，只是不再存它的表原文（顺带也不会再撑爆 localStorage）
    if (BCX_PASTE_SHEETS) for (const st of document.querySelectorAll('style')) {
      const text = st.textContent || '';
      // 它那份 External Extension-todo-styles 里除了侧栏显隐，还夹着"隐藏 Canvas 原生待办"两条
      // （.Sidebar__TodoListContainer 和 widget-container-todo_list-widget-*）。
      // 那两件事我们从来不要（我们的面板跟原生是共存的），所以整份不收
      if (st.id === 'bc-todo-styles') continue;
      // 只收它主题那几份（一定含 --bc）。之前多带一条 .ic- 的判断会把 Canvas 自己注入的
      // 行内样式也捞进来，那是站点自己的规则，我们不该存也不该重贴
      if (!text.includes('--bc')) continue;
      if (text.length > 300000 || total + text.length > BCX_SHEET_LIMIT) continue;
      total += text.length;
      sheets.push(text);
    }
    // 根上的 --bc* 变量可能是行内写的（不在任何 style 节点里），单独抄一份
    let rootVars = '';
    for (const el of [document.documentElement, document.body, document.getElementById('wrapper'), document.getElementById('application')]) {
      if (!el || !el.style || !el.style.cssText) continue;
      const mine = el.style.cssText.split(';').filter(p => p.trim().indexOf('--bc') === 0).join(';');
      if (mine) { rootVars = mine; break; }
    }
    // 字体是它插一个 <link> 去 Google Fonts 拉的，不是 <style>，上面那些表抓不到它
    const fonts = [...document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="fonts.gstatic"]')]
      .map(l => l.getAttribute('href')).filter(Boolean);
    return { sheets, rootVars, fonts };
  }

  let mcSheetVars = [];
  let mcVarSig = null;
  let mcFontSig = null;

  // 根变量和字体链接是两条独立通道。导入主题时它的表是空的，可这两样照样得有：
  // 我们编译那份表里到处是 var(--bc…)，变量一没就全落空，字体链接一没就拉不下来。
  // 之前它们跟"它的表"共用一个签名，表一空就被连坐删掉，而且此后永远补不回来
  /* 自定义主题的贴图在库里，快照和编译出来的表里只写 mc-img://<id>/<位置> 的引用
     （一张 300KB 的图抄进库、surfaces、cards、themeCss 四份，那一格很快就装不下）。
     引用只在写进 DOM 这一刻展开，落盘的那份永远是短的。展开的算法在 theme-lib.js，
     它不在（比如这帧还没有它）就原样返回，页面顶多少一张图，色照旧 */
  function mcResolve(css) {
    const text = String(css == null ? '' : css);
    if (text.indexOf('mc-img://') === -1) return text;
    return window.mcLib ? window.mcLib.resolve(text) : text;
  }

  /* 一条 --bcX:v; 串按顶层分号拆开。不能裸 split(';')：展开成真的图之后值是
     url("data:image/jpeg;base64,…")，里面那个分号会把这一条从中间劈断，
     剩下半截 setProperty 静默收下但不生效＝这一档变量整个没了 */
  function mcSplitVars(raw) {
    const text = String(raw || '');
    const out = [];
    let cur = '', quote = '', depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function applyThemeRootVars(raw) {
    if (raw === mcVarSig) return;
    mcVarSig = raw;
    for (const name of mcSheetVars) document.documentElement.style.removeProperty(name);
    mcSheetVars = [];
    if (!raw) {
      document.querySelectorAll('style[data-bcx-sheet="vars"]').forEach(n => n.remove());
      return;
    }
    for (const pair of mcSplitVars(raw)) {
      const idx = pair.indexOf(':');
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name.indexOf('--bc') !== 0 || !value) continue;
      document.documentElement.style.setProperty(name, mcResolve(value));
      mcSheetVars.push(name);
    }
  }

  function applyThemeFonts(links) {
    // 答题屏（MCX_QUIET_PAGE）连字体 link 都不挂：那条按需分包的 Google 字体是"新字形才卡"的根，
    // 第 53 节已把这一屏强制成系统字，这里干脆连下载都不发起，彻底断掉字体子集请求
    if (MCX_QUIET_PAGE) {
      document.querySelectorAll('link[data-bcx-sheet]').forEach(n => n.remove());
      mcFontSig = '';
      return;
    }
    const sig = links.join('|');
    if (sig === mcFontSig) return;
    mcFontSig = sig;
    document.querySelectorAll('link[data-bcx-sheet]').forEach(n => n.remove());
    links.forEach((href, i) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-bcx-sheet', 'font' + i);
      link.href = href;
      document.head.appendChild(link);
    });
  }

  function applyModernSheets(allow) {
    const snap = allow && mcPaintsPageTheme() ? mcSnapshot() : null;
    // 【测试阶段，禁止删除】BCX_PASTE_SHEETS 为 false 时这里读到空数组，
    // 于是签名恒为 ''，下面那段"整份贴回它的表"进不去，同时还会把旧版贴进来的节点撤掉。
    const sheets = BCX_PASTE_SHEETS && snap && Array.isArray(snap.sheets) ? snap.sheets : [];
    const sig = allow && sheets.length ? String(sheets.length) + ':' + sheets.reduce((n, t) => n + t.length, 0) : '';
    // 注表和撤表按签名走，不每次动 DOM；但下面补钩子那段必须每次都跑，
    // 因为 Canvas 重渲染会把卡片换掉、类名跟着丢
    if (document.documentElement.dataset.mcSheets !== sig) {
      document.documentElement.dataset.mcSheets = sig;
      // 只收它的表原文（属性值是编号的那批），字体和根变量另有通道
      document.querySelectorAll('[data-bcx-sheet]').forEach(n => {
        if (/^\d+$/.test(n.getAttribute('data-bcx-sheet') || '')) n.remove();
      });
      // 【测试阶段，禁止删除】这一支是被 BCX_PASTE_SHEETS 停用的"贴它的表原文"，
      // 现在恒不执行；主题靠下面 applyModernThemeSheet 那份从参数编译的表来画
      if (sig) {
        sheets.forEach((text, i) => {
          const node = document.createElement('style');
          node.setAttribute('data-bcx-sheet', String(i));
          node.textContent = text;
          document.head.appendChild(node);
        });
      } else if (allow) {
        // 只在 BC 不在的时候收我们自己的钩子；它活着时这些类名是它加的，不能碰
        for (const h of document.querySelectorAll('[class*="bc-new-grade-card-"]')) {
          h.classList.remove('bc-grade-card-header');
          for (const cls of [...h.classList]) if (cls.indexOf('bc-new-grade-card-') === 0) h.classList.remove(cls);
        }
      }
    }
    // 【参数通路】它写在行上的 rootVars 经常是空的（那些变量在它自己那几张表里，不在行上）。
    // 贴表停用之后没人替我们带它们回来，所以缺了就用快照里的槽值现拼一份，
    // 否则 BC 一关，style.css 里所有 var(--bc…) 一起落空（侧栏白图标那条）
    // 两份合起来用：先用快照里的槽值铺一整套，再把它行上抄来的那几个盖在后面（同一条规则里
    // 后写的赢）。以前是"有行上那份就不铺整套"，结果行上只写了三五个，缺的那些
    // 让 style.css 里"background-0 缺了退 cards"的规则集体退档，日历板被我补出来的那档刷成白
    applyThemeRootVars(allow && snap ? [mcVarsToRoot(snap.vars), snap.rootVars].filter(Boolean).join('') : '');
    applyThemeFonts(allow && snap && Array.isArray(snap.fonts) ? snap.fonts : []);
  }

  // 把 surfaces 和 cards 编译成一份样式表（跟 BC 自己的做法一样）。
  // 之前是往元素上写行内样式，Canvas 切页面会重渲染换掉节点、行内样式跟着消失，
  // 要等 content.js 补，中间那一帧就是原生皮肤。
  // 编译结果直接存进快照，这样 document_start 的引导脚本能在首帧之前把它注上。
  function mcThemeCss(data) {
    /* 拼接那一步的闸：这一份表是把槽值原文一条条拼起来的，一颗值里带 } 就能把当前这条声明
       提前关掉、后半截变成新选择器（red;}body{display:none}/* 就是把整页界面藏掉）。
       正本在 theme-lib.js 的 mcCssGuard，两处主题脚本共用一份判据；这里绕一层 window 读，
       是因为 picture-slot 那支测试会把本函数单独抠出去跑，那个环境里没有模块级作用域。 */
    const guard = (typeof window !== 'undefined' && window.mcCssGuard && window.mcCssGuard.value)
      || function (v) { return v == null ? '' : String(v); };
    const s = (data && data.surfaces) || {};
    const cards = (data && data.cards) || {};
    const vars = (data && data.vars) || {};
    // 两层底色以槽值为准（和导入 JSON 同一批数）。BC 不一定把 background-1 刷在我们抄 computed 的
    // 那一层上，照抄常常只剩一层：症状＝日历页和待办面板整片同一个 #edfaff，轨道和选中那颗胶囊
    // 看不出边界。槽里没有这一档时才退回抄来的 computed
    const tier = (key, slot) => {
      const raw = vars[slot];
      if (!raw || !mcToRgb(raw)) return;
      s[key] = Object.assign({}, s[key], { color: raw });
    };
    const pageSlot = (vars['bcbackground-1'] && mcToRgb(vars['bcbackground-1'])) ? 'bcbackground-1' : 'bcbackground-0';
    tier('body', 'bcbackground-0');
    tier('app', pageSlot);
    let css = '';
    const surfaceRule = (sel, rec) => {
      if (!rec) return '';
      // 每一项都过闸（值脏了这一档就没值，走它本来就有的退路，不替它编一条新的）
      const color = guard(rec.color), raw = guard(rec.raw), bg = guard(rec.bg);
      const size = guard(rec.size), pos = guard(rec.pos), repeat = guard(rec.repeat);
      const attach = guard(rec.attach), text = guard(rec.text), font = guard(rec.font);
      let one = sel + '{';
      if (rec.flat) {
        // 这一档被摊平了（他在这一行挑了一颗色，或按了 No colour）：主题那幅图、那层渐变整层不画，
        // 只画这颗色。原来那串还原样留在快照里，撤掉改动（摘 flat）图就回来
        if (color) one += 'background-color:' + color + '!important;';
      } else if (raw) {
        // 导入的主题走这条：槽值是完整简写，整串给 background
        one += 'background:' + raw + '!important;';
        if (size) one += 'background-size:' + size + '!important;';
        if (pos) one += 'background-position:' + pos + '!important;';
        if (repeat) one += 'background-repeat:' + repeat + '!important;';
        if (attach) one += 'background-attachment:' + attach + '!important;';
      } else {
        if (color) one += 'background-color:' + color + '!important;';
        if (bg) {
          one += 'background-image:' + bg + '!important;';
          one += 'background-size:' + (size || 'auto') + '!important;';
          one += 'background-repeat:' + (repeat || 'repeat') + '!important;';
          one += 'background-position:' + (pos || '0% 0%') + '!important;';
        }
      }
      if (text) one += 'color:' + text + '!important;';
      if (font) one += 'font-family:' + font + '!important;';
      return one + '}';
    };
    css += surfaceRule('body', s.body);
    /* 关键修正：页面大背景（s.app）必须全屏通铺到 html, body, #application 以及 #wrapper, #main。
       解决短内容页面在下滑到底部时漏出 body 卡底色的问题。
       保留前面的 surfaceRule('body', s.body) 确保单测断言兼容，本条靠后写且带 html 从而最终生效 */
    const pageRec = (s.app && (s.app.raw || s.app.color || s.app.bg)) ? s.app : s.body;
    css += surfaceRule('html, body, #application', pageRec);
    /* 页面底那一档还要落在 #wrapper 和 #main 上，两个理由：
       1) 它那颗防闪粒子（读包体 9.8.15 all.js @3098700）写的就是 body,#wrapper,#main，
          这两层在 #application 之上，我们不画＝被它整片盖住；
       2) 这两层今天在我们页面上是 transparent，画上和 #application 同一档，
          落定的画面一个字都不变，只是把那一层从"让给它"变成"我们自己占"。
       选择器前面多挂一层 html 抬权重，谁后插都不让。值走同一颗 s.app，
       所以图主题也不会出现两层各一套底 */
    css += surfaceRule('html #wrapper, html #main', pageRec);
    // 字族只写在 body 上是没用的：Canvas 大量元素自己写了 LatoWeb，继承传不下去。
    // 要生效得连后代一起点名，同时把图标字体排除掉，否则 icon 字体会被换成主题字族、图标全变成方框
    const fam = guard(s.body && s.body.font);
    if (fam) css += 'body,body :not(script):not(style):not(noscript):not(template):not(svg):not(svg *)'
      + ':not(i):not([class*="fa-"]):not([class*="icon"]){font-family:' + fam + '!important}';
    // 老快照里存着 attach: 'fixed'（那是这一档以前的默认值），编译这一刻一律当 scroll 处理，
    // 不然已经装上的主题要重新 Apply 一次才修好
    css += surfaceRule('.ic-app-header',
      s.nav && Object.assign({}, s.nav, { attach: s.nav.attach === 'fixed' ? 'scroll' : s.nav.attach }));
    if (s.nav) {
      // 字色必须点到这三个节点本身：Canvas 在它们上面直写了白色，
      // 只写在 .ic-app-header 上靠继承传不下去（底翻浅了字还白，就是这条）
      // sidebar-text 这一档优先（两条通路同一个来源）；抓来的 computed 只当兜底，
      // 因为 BC 活着时导航图标的 fill 就是 Canvas 的原生白，照它抄等于把白存进快照
      const slot = (data.vars && data.vars['bcsidebar-text']) || '';
      let label = slot || s.nav.text || s.nav.icon;
      let glyph = slot || s.nav.icon || s.nav.text;
      // 两样都没抓到（BC 当时没刷这两层，或快照是加字段之前的旧格式）就按侧栏底色翻纯黑/纯白。
      // 停在 Canvas 的原生白上＝浅底侧栏整栏文字图标看不见，而它照样能点，最难查的那种
      if (!label && !glyph) {
        const base = mcToRgb(String(s.nav.color || '').split(',')[0].trim())
          || mcToRgb(String(s.nav.raw || '').trim());
        if (base) {
          const ink = mcLuminance(base) > 0.5 ? '#000000' : '#ffffff';
          label = ink; glyph = ink;
        }
      }
      // 侧栏身后那一档底：抓取时量到的 computed 底色优先，没有才拆槽值里的纯色
      const navBase = mcSlotColorOf(s.nav.color || '') || mcSlotColorOf(s.nav.raw || '');
      // 翻色那一步不吃"拆出来的一颗"，吃整串＋那张图的采样：
      // 侧栏写成 url(图),linear-gradient(..) 时上面那颗是空串，兜底就再也没判过
      const navBaseRaw = s.nav.color || s.nav.raw || '';
      // 摊平以后那张图根本不画了，它的采样就不能再当底：不然他挑的实心色明明读得清，
      // 却被图上一个亮斑判成"看不见字"，把字翻成黑/白
      const navSamples = s.nav.flat ? [] : s.nav.samples;
      // 有了字色也还要过一遍对比：Colors 面板里可以把侧栏字色调到和底色分不开，
      // 那种情况下翻成纯黑或纯白，和正文那几档同一道 3:1、同一个理由
      if (label && mcFlipOn()) {
        label = mcSidebarInk(navBaseRaw, label, navSamples);
        glyph = mcSidebarInk(navBaseRaw, glyph, navSamples);
      }
      if (label) {
        label = guard(label);
        glyph = guard(glyph);
      }
      if (label) {
        css += ':root{--mc-nav-ink:' + label + '!important;}';
        css += '.ic-app-header__menu-list-link{color:' + label + '!important;}';
        css += '.ic-app-header__menu-list-link .menu-item__text{color:' + label + '!important;}';
      }
      // 自动四周光：侧栏文字压在花壁纸上会糊。方向按"字比它身后那档底亮还是暗"定，
      // 不是拿字自己的亮度比固定阈值：深色主题给的暖灰字（亮度 0.24）坐在近黑的底（0.07）上，
      // 比阈值那一档会被判成"深字"配一圈白光，而白光比字本身还亮＝笔画之间的黑缝被抬成灰，
      // 整行像蒙了一层雾。字比底亮就给深色光，字确实比底暗才给浅色光。
      // 量不到底色时（槽值整串是图）才退回原来那档 0.3。
      // 无偏移、单层、低透明度＝只提辨识度、不加重量。课程行/子链接同为 .menu-item__text，自动罩住。
      const labelRgb = mcToRgb(String(label));
      if (labelRgb) {
        const baseRgb = mcToRgb(navBase);
        const inkLighter = baseRgb ? mcLuminance(labelRgb) >= mcLuminance(baseRgb)
          : mcLuminance(labelRgb) >= 0.3;
        const glow = inkLighter ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.6)';
        const halo = inkLighter ? 'rgba(0,0,0,.28)' : 'rgba(255,255,255,.3)';
        css += '.ic-app-header__menu-list-link .menu-item__text{text-shadow:0 0 2px ' + glow + ',0 0 7px ' + halo + '!important}';
      }
      // 图标改成"按位置"认：导航行里的任何 svg 都算，带不带 .ic-icon-svg 类都一样
      // （[BCP51]：学校自己加的那颗是裸 svg，按类名打就漏了它）
      if (glyph) {
        css += '.ic-app-header__menu-list-link .ic-icon-svg,.ic-app-header__menu-list-link svg,'
          + '.ic-app-header__menu-list-link svg *,.menu-item-icon-container,.mc-nav-courses-caret,'
          + '.mc-nav-bc-caret,.mc-course-caret,.mc-chev,.ic-app-header .ic-icon-svg{color:' + glyph + '!important}';
        // 图标是实心 fill 画的（[BCP50] 量到 stroke=none、fill 是写死的白/品牌蓝），
        // 只给 color 它不跟，得直接点 fill。因为 stroke 是 none，换 fill 不会把描线图标糊成色块
        css += '.ic-app-header__menu-list-link .ic-icon-svg,.ic-app-header__menu-list-link svg,'
          + '.ic-app-header__menu-list-link svg *,.ic-app-header .ic-icon-svg,.mc-chev,'
          + '.menu-item-icon-container svg{fill:' + glyph + '!important}';
      }
    }
    // 图片始终在展开宽度的画布上 cover；侧栏变窄只裁画布，不重新计算图片尺寸。
    const navImageRaw = s.nav && !s.nav.flat && [s.nav.layer && s.nav.bg ? s.nav.layer + ',' + s.nav.bg : '',
      s.nav.layer, s.nav.bg, s.nav.raw].find(value => /url\(|image-set\(/i.test(String(value || '')));
    const navImage = navImageRaw ? guard(navImageRaw) : '';
    if (navImage) {
      css += 'html .ic-app-header{background-image:none!important;overflow-x:hidden!important;isolation:isolate!important}';
      css += 'html .ic-app-header::after{content:"";position:fixed;top:0;left:0;width:200px;height:100vh;'
        + 'clip-path:inset(0 max(0px, calc(200px - var(--bc-nav-w))) 0 0);'
        + 'transition:clip-path 320ms cubic-bezier(0.4, 0, 0.2, 1);pointer-events:none;z-index:-1;'
        + (navImageRaw === s.nav.raw ? 'background:' : 'background-image:') + navImage + '!important;'
        + 'background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important}';
    } else if (s.nav && s.nav.layer && !s.nav.flat) {
      const navLayer = guard(s.nav.layer);
      if (navLayer) css += '.ic-app-header{background-image:' + navLayer + '!important;'
        + 'background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important}';
    }
    for (const key of Object.keys(cards)) {
      /* 这一段的规则名和值都是拼出来的：课程 id 只能是一串 [-\w]（Canvas 的 id 就是数字），
         形状不对就整张跳过；每一颗值先过闸再拼。两张表里的卡图/色膜/滤镜是从页面量回来的
         computed 值或主题 JSON，都算外部输入 */
      if (!/^[\w-]+$/.test(String(key))) continue;
      const e = cards[key] || {};
      const img = guard(e.img), film = guard(e.film), filter = guard(e.filter), color = guard(e.color);
      const size = guard(e.size), pos = guard(e.pos), repeat = guard(e.repeat);
      const id = key;
      const hook = '.bc-new-grade-card-' + id;
      // 只作用在新版卡上。之前还并了一条 .ic-DashboardCard:has(...) 的旧版选择器，
      // 那条会把下面这套（含 background:none）套到旧版 DOM 上，正是 6 张卡塌成 0 高的原因；
      // 旧版有它自己那套 custom-card-<id> 的规则，由抄来的那份表负责
      const scope = hook;
      // This CSS behavior is adapted from Better Canvas's bundled h(sel, rec)
      // output (all.js @1438645), then scoped and integrated with our theme
      // model below. It is compatibility-derived code, not an original
      // implementation claim; see the project's license/provenance review.
      // 下面这一整块是 BC 打包代码里 h(sel, rec) 的原样输出（all.js @1438645），逐条对齐：
      // 1) 没图时它整条 background-image 都不写，只留 ::after 那层色膜 —— 卡片高度靠子元素撑着，不会塌
      // 2) 藏掉 Canvas 自己那层 absolute + opacity<1 的 wash
      // 3) 把 header 的每个子元素 position:relative; z-index:2 抬到贴图之上，标题才压在图上而不是被盖住
      const imgRule = img && img !== 'none' ? 'background-image:' + img + '!important;' : '';
      // 这一块图用的是原图哪一处：由那份主题的区域设定给（见 mcExpandImportedCards），
      // 没给就是老行为——铺满、看中间
      const geo = 'background-size:' + (size || 'cover') + '!important;'
        + 'background-position:' + (pos || 'center') + '!important;'
        + (repeat ? 'background-repeat:' + repeat + '!important;' : '');
      css += scope + '{position:relative!important;overflow:hidden!important;background:none!important}';
      css += hook + '::before{content:"";position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;'
        + imgRule + geo
        + (filter && filter !== 'none' ? 'filter:' + filter + '!important;' : '') + '}';
      css += hook + '::after{content:"";position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;'
        + 'background:' + (film || 'none') + '!important}';
      css += hook + ' > .bc-grade-card-wash{display:none!important}';
      css += hook + ' > *:not(.bc-grade-card-wash){position:relative;z-index:2}';
      // 旧版卡（.ic-DashboardCard）再画一套：BC 原文 @2170400，作用域是 .custom-card-<id>，
      // 图放 __header_image / __header_hero 的 ::before、色膜放 ::after、标题跟着换色。
      // 导入主题时我们不再贴它的表，所以这套得自己生成，不然旧版首页只有配色没有贴图
      const oc = '.custom-card-' + id;
      const ohead = oc + ' .ic-DashboardCard__header_image,' + oc + ' .ic-DashboardCard__header_hero';
      if (color) css += oc + ' .ic-DashboardCard__header-title span,' + oc + ' .ic-DashboardCard__header-title,' + ohead + '{color:' + color + '!important}';
      // 往外溢 1px：[BCP67] 量到这两颗图层比卡片窄 1.5px（左右各差 0.75），卡片自己的白底
      // 从缝里露出来。溢出的部分由 .ic-DashboardCard 的 overflow:hidden + 圆角裁掉
      css += oc + ' .ic-DashboardCard__header_image::before,' + oc + ' .ic-DashboardCard__header_hero::before{content:"";position:absolute;top:-1px;left:-1px;width:calc(100% + 2px);height:calc(100% + 2px);z-index:0;'
        + (img ? 'background-image:' + img + '!important;' : '') + geo.replace(/;$/, '')
        + (filter && filter !== 'none' ? ';filter:' + filter + '!important' : '') + '}';
      if (film) css += oc + ' .ic-DashboardCard__header_image::after,' + oc + ' .ic-DashboardCard__header_hero::after{content:"";position:absolute;top:-1px;left:-1px;width:calc(100% + 2px);height:calc(100% + 2px);z-index:1;background:' + film + '!important}';
      /* 这一行以前还多钉了一条 position:relative（BC 原文那么写）。实测它会把旧版卡顶歪：
         Canvas 的 __header_image 本来就是 absolute + 铺满卡头，改成 relative 之后它变成
         正常流里一个"高 100%"的块，卡头被撑高，那颗本来就绝对定位在卡头下沿的白字标题
         就掉到卡身那档粉底上＝他截图里"课程名变白、压在粉上看不见"。
         我们那两层 ::before／::after 要的是"有一个定过位的祖先"，而 __header_image 自己
         就是 absolute、卡头 .ic-DashboardCard__header 是 relative，两条都够，不需要我们再钉。 */
      css += ohead + '{background-color:transparent!important}';
      /* List view 左边那颗课程块：站点把课程封面直接画在 a.Grouping-styles__hero 自己的
         background-image 上（[实测 2026-10-06] inst-fs-iad-prod.inscloudgate.net 那张），
         所以这里不换图层、只换它自己那一条 background-image，尺寸和取哪一块跟卡视图同源。
         故意不做的事：卡视图那套 ::before／::after（贴图＋色膜）——这一屏的 hero 里面还排着
         课程代码那颗标签，叠两层绝对定位的皮会把它们一起盖掉。色膜（film）和滤镜（filter）
         这两样因此没跟过来，卡图本身是跟到底的 */
      const pg = '.planner-grouping.custom-card-' + id;
      const pgh = pg + ' .Grouping-styles__hero';
      if (img && img !== 'none') {
        css += pgh + '{background-image:' + img + '!important;' + geo + '}';
        /* 站点在贴图上又刷了一层课程色（[实测 2026-10-06] span.Grouping-styles__overlay，
           整块盖住 hero，底色＝那一门课自己的颜色，量到 rgb(50,74,77) 那一档）。
           2026-10-06 他点名：有贴图就别再叠原始 UI 那层颜色。
           所以这一条只在真的换上图的时候摘；没图的主题留着它，画面跟原生一致。
           只摘底色，节点留着——它自己那份尺寸可能就是 hero 的高度来源 */
        css += pg + ' .Grouping-styles__overlay{background:none!important}';
      }
      // 课程代码那颗字的颜色跟卡视图同一个来源（那份主题的"卡片标题"那一档），不是课程自带的颜色
      if (color) css += pg + ' .Grouping-styles__title{color:' + color + '!important}';
    }
    return css;
  }

  let mcThemeSheetSig = null;
  function applyModernThemeSheet(allow) {
    const snap = allow && mcPaintsPageTheme() ? mcSnapshot() : null;
    // 有卡图或 surfaces 就现场重新编译，不用旧的 themeCss 串：
    // 那样改编译规则（比如给侧栏文字补四周光）不用重载扩展、也不用重抓快照就能生效。
    // 以前只认 cards，结果没卡图的主题永远走旧串、改了编译器也不生效
    const compiled = !!(snap && (snap.cards || snap.surfaces));
    let css = compiled ? mcThemeCss({ surfaces: snap.surfaces, cards: snap.cards, vars: snap.vars })
      : (snap && snap.themeCss ? snap.themeCss : '');
    /* 只有"用存档里那份现成的表"这一支要再验一遍结构（旧存档、BC 活着时每三秒抄的那面镜像都算）：
       文本不在这颗编译器手里过过，值级那道闸管不到它。现场编译那一条每个值都进过闸，
       再判一次只会把"我们自己少写一条规则"的风险加进来，不重复判 */
    if (!compiled && css && window.mcCssGuard && !window.mcCssGuard.sheetOk(css)) {
      console.warn('[MCX] 存档里那份主题表结构不对，这一趟不注入');
      css = '';
    }
    if (css === mcThemeSheetSig) return;
    mcThemeSheetSig = css;
    let node = document.getElementById('mc-theme-sheet');
    if (!css) {
      if (node && document.readyState !== 'complete') {
        // 完整刷新时 BC 的主题图可能还在加载。首帧引导已贴的图先留到 load，
        // 避免 document_idle 抢先撤表，侧栏短暂露出 Canvas 原生底色。
        window.addEventListener('load', () => {
          if (mcThemeSheetSig === '' && node.isConnected) node.remove();
        }, { once: true });
      } else if (node) node.remove();
      return;
    }
    if (!node) {
      node = document.createElement('style');
      node.id = 'mc-theme-sheet';
      document.head.appendChild(node);
    }
    // 只有写进 DOM 那一刻才展开引用；回写进快照的那份保持带引用，落盘的字才小
    node.textContent = mcResolve(css);
    // 顺手把这份编译结果存回快照，theme-boot.js 下次页面一开就直接用它，不用等 content.js
    if ((snap.cards || snap.surfaces) && css !== snap.themeCss) {
      snap.themeCss = css;
      mcWriteSnapshot(JSON.stringify(snap));
    }
  }

  /* 【已撤 2026-10-11】这里原本有一颗 mcxPinPageLayers()：把 body 和 #application 的底色
     写成行内 !important。撤的原因不是算法错，是它一上屏就把"只有成绩页翻色"变成"每一页都翻"，
     而且没有任何一次在他页面上的读数能证明它该赢。留这段字给下一轮：
     行内 !important 压得住它的表和它的行内声明，但同时压得住的东西比我们以为的多
     （包括它活着时本来该露出来的那一层），所以这颗钉子必须先在真页面上量到"谁在画这一层"再放。
     已量的事实：原生成绩页从 #content 往上到 #application 全是 transparent，
     看得见的底只有 body 那一颗；首页那份存档 b0=#f8fcff b1=#dcefff、imported=true、owner=mc，
     它的三张主题表在我们这套跑起来时是 [OFF]，我们的 mc-theme-sheet／mc-boot-bg-guard 排在它们后面 */

  /* 它到底有没有在画这一页：节点在、表也开着，才算"页面上有它的色可抄"。
     这一串 id 判据与下面 mcKeepThemeSheetLast 停表那一条同一批，两边必须一起改——
     这边认得比那边松，就会在表被摁住的时候仍然跑去抄，抄回一页没上漆的原生色写进存档 */
  function mcThemeSheetPainting() {
    const theirs = document.querySelectorAll('style[id^="bettercampus"], style[id^="bettercanvas"], style#darkcss');
    for (const s of theirs) {
      const sid = String(s.id || '').toLowerCase();
      if (sid === 'darkcss' || sid.indexOf('theme') !== -1 || sid.indexOf('preset') !== -1
        || sid.indexOf('custom-cards') !== -1) {
        if (!s.disabled) return true;
      }
    }
    return false;
  }

  /* 当页面归我们管（owner !== 'bc'）时，全面压制 BetterCampus 注入的主题及暗黑样式表。
     不仅在我们有主题时排在最后，而且直接将它的 theme 样式表 disabled，
     彻底杜绝用户选择“原生 Canvas 配色”或“浅色/深色”时被 BC 主题样式表泄漏污染的问题！ */
  function mcKeepThemeSheetLast() {
    const owner = localStorage.getItem('bc_theme_owner');
    if (owner === 'bc') {
      // 归 BC 管时，若它的样式表被误 disable，则恢复
      const theirs = document.querySelectorAll('style[id^="bettercampus"], style[id^="bettercanvas"], style#darkcss');
      for (const s of theirs) {
        if (s.disabled) s.disabled = false;
      }
      document.documentElement.classList.remove('mc-bc-cards-off');
      return;
    }

    const theirs = document.querySelectorAll('style[id^="bettercampus"], style[id^="bettercanvas"], style#darkcss');
    if (!theirs.length) return;

    /* 那张 custom-cards 表不只管颜色：它自家两颗按钮（卡右上角的加号、标题行下面的铅笔）的
       形状也写在同一张表里。整张一停，那两颗退回浏览器默认的 button 样子＝灰底黑框的方片，
       还从右上角掉进正文流里。所以停表这一趟顺手在 <html> 上挂个标记，让 style.css 第 21 节
       那组补偿只在标记在的时候生效；归 BC 管（表没停）时它自己的规则照旧，一条都不抢 */
    let cardsOff = false;
    for (const s of theirs) {
      const sid = String(s.id || '').toLowerCase();
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

    const ours = document.getElementById('mc-theme-sheet');
    if (!ours || !ours.parentNode) return;
    const last = theirs[theirs.length - 1];
    if (ours.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING) return;
    if (last.parentNode) last.parentNode.insertBefore(ours, last.nextSibling);
    else document.head.appendChild(ours);
  }

  // 我们那份表里课程卡是以 .bc-new-grade-card-<id> 为作用域的，
  // 这个类名 BC 在时由它加、不在时要我们自己加（Canvas 重渲染会丢，所以每次跑都补一遍）
  function mcCardHooks() {
    // 新版卡（data-testid=course-grade-card-<id>）才认 .bc-new-grade-card-<id> 这套作用域；
    // 旧版 .ic-DashboardCard 认的是 custom-card-<id>（BC 原文 @2169813）。
    // 把新版类名挂到旧版 DOM 上，那条 146px 高度规则不成立、background:none 又生效，header 直接压成 0。
    for (const card of document.querySelectorAll('[data-testid^="course-grade-card"]')) {
      const id = ((card.getAttribute('data-testid') || '').match(/course-grade-card-(\d+)/) || [])[1];
      if (!id) continue;
      const header = modernCardHeader(card);
      if (!header) continue;
      header.classList.add('bc-grade-card-header', 'bc-new-grade-card-' + id);
      // BC 那句 display:none 是靠它运行时给 Canvas 那层 wash 打的标记，我们这边也得自己找：
      // 它的判据就是"绝对定位 + 内联 opacity 小于 1 的直接子元素"
      for (const kid of header.children) {
        if (kid.classList.contains('bc-grade-card-wash')) break;
        if (kid.style.position === 'absolute' && kid.style.opacity !== '' && Number(kid.style.opacity) < 1) {
          kid.classList.add('bc-grade-card-wash');
          break;
        }
      }
    }
    for (const card of document.querySelectorAll('.ic-DashboardCard')) {
      const link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (m) card.classList.add('custom-card-' + m[1]);
    }
    // List view 左边那一列课程块（[实测 2026-10-06] div.Grouping-styles__root.planner-grouping，
    // 里面 a.Grouping-styles__hero 自己带课程封面的 background-image）。
    // 挂同一颗 custom-card-<id>，上面编译出来的那套卡图和标题色就能同时落在这一屏。
    // 同时把这门课的颜色写成 --course-color：这一屏里每条提醒上面那行小字课程名读它，
    // 于是设置里 "Course title colour" 那颗开关（落点 style.css 的 bc-course-colour-accent）
    // 也管得到这一屏。值跟侧栏抽屉、卡上那个圈同一个 getCourseColor，不打架。
    // 只在真的变了才写：这一趟每 300 毫秒跑一遍，每批都写行内＝白刷样式
    for (const group of document.querySelectorAll('.planner-grouping')) {
      const link = group.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (!m) continue;
      group.classList.add('custom-card-' + m[1]);
      const color = getCourseColor(m[1]);
      if (color && group.style.getPropertyValue('--course-color') !== color) {
        group.style.setProperty('--course-color', color);
      }
    }
  }


  /* ===== 卡片上的分数药丸 =====
     DOM 层级、内联样式值逐条对齐。 */

  /* 本次加载里"上一次见到它在不在画"。null＝还没读到过（第一轮只记基线，不替他改开关）。
     故意不进 localStorage：重载以后卡片是重新长出来的，留着旧值会把"页面还没到"当成"它翻了开关" */
  let bcGradesSeen = null;

  let modernGrades = {};
  try { modernGrades = JSON.parse(localStorage.getItem('mc_grades_v1') || '{}') || {}; } catch (e) { modernGrades = {}; }

  async function mcLoadGrades() {
    try {
      const r = await fetch('/api/v1/courses?include[]=total_scores&per_page=100', { credentials: 'same-origin' });
      if (!r.ok) return;
      const list = await r.json();
      const next = {};
      for (const c of list || []) {
        const en = (c.enrollments || []).find(e => e.type === 'StudentEnrollment' || e.role === 'StudentEnrollment') || (c.enrollments || [])[0];
        if (!en) continue;
        const g = (en.grades || {}).current_grade;
        const s = (en.grades || {}).current_score != null ? (en.grades || {}).current_score : en.computed_current_score;
        const v = (g !== '' && g != null) ? g : (s != null ? Number(s).toFixed(2) : null);
        if (v != null) next[String(c.id)] = String(v).replace(/%$/, '');
      }
      const j = JSON.stringify(next);
      if (j !== JSON.stringify(modernGrades)) {
        modernGrades = next;
        try { localStorage.setItem('mc_grades_v1', j); } catch (e) {}
      }
      modernGradePills();
    } catch (e) {}
  }

  function formatGradeLabel(val) {
    if (val == null || val === '') return '--';
    const s = String(val).trim();
    if (s.endsWith('%')) return s;
    if (/^\d+(\.\d+)?$/.test(s)) return s + '%';
    return s;
  }

  function modernGradePills() {
    const hover = localStorage.getItem('mc_dash_grade_hover') === '1';
    // 这一格归谁画（设置里 Card grades shown by，两份表在 content.js 和 theme-boot.js）
    const gradeOurs = modernSetting('dash_grade_owner') === 'ours';
    const bcLive = document.documentElement.classList.contains('mc-bc-live');
    /* 它此刻到底有没有在卡片上画分数。[实测 2026-10-06] 它关掉那一档时那颗是从 DOM 消失，
       不是留着被隐藏，所以"节点在不在"就是判据，不用去读计算样式 */
    const bcShows = !!document.querySelector('a.bettercampus-card-grade') ||
                    !!document.querySelector('.bc-new-dash-grade-pill');
    /* 跟随：只在它翻那一格的时候跟。判读前提两个——它在跑，而且卡片已经画出来了
       （它的分数要等卡片，没卡片时读到"它没画"其实是"页面还没到"）。
       本次加载的第一轮只记基线：他自己拧过（三个点里那行，或者设置里那一格）就不替他改，
       没拧过的新装才按它当前状态摆一次。之后每轮只在和基线不一样时写，一样就一个字都不动，
       否则他在三个点里刚关掉的会被每轮按回去，那是他报的第二条 bug。
       归 BetterCampus 那一档完全不跟，那套逻辑要和旧版一字不差 */
    if (gradeOurs && bcLive && document.querySelector('.ic-DashboardCard')) {
      const bcNow = bcShows ? '1' : '0';
      if (bcGradesSeen === null) {
        bcGradesSeen = bcNow;
        if (!localStorage.getItem('mc_dash_grade_touched')) localStorage.setItem('mc_dash_grades', bcNow);
      } else if (bcNow !== bcGradesSeen) {
        bcGradesSeen = bcNow;
        localStorage.setItem('mc_dash_grades', bcNow);
      }
    }
    // 默认关：这一格没存过值（新装）也算关，要手动开
    const hide = localStorage.getItem('mc_dash_grades') !== '1';
    // 旧版：Canvas 卡上没有分数位，BC 是自己造一颗 <a> 绝对定位在左上角（原文 .External Extension-card-grade）
    for (const card of document.querySelectorAll('.ic-DashboardCard')) {
      const link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      if (!m) continue;
      /* External Extension 自己造的那颗分数（原文 .External Extension-card-grade，挂在卡片左上角，
         和我们的位置一模一样）已经在的话，这张卡就不补我们那颗，已补的撤掉。
         两颗叠在同一处＝文字互相压出重影。它出现得比我们晚，所以每轮都要重判。
         归我们那一档时不让位：它那颗由 style.css 的 bc-dash-grade-owner-ours 那条藏掉，这一格改画我们的 */
      if (!gradeOurs && card.querySelector('.bettercampus-card-grade')) {
        const ours = card.querySelector(':scope > .mc-card-grade');
        if (ours) ours.remove();
        continue;
      }
      card.style.position = 'relative';
      let pill = card.querySelector(':scope > .mc-card-grade');
      if (!pill) {
        pill = document.createElement('a');
        pill.className = 'mc-card-grade';
        pill.href = '/courses/' + m[1] + '/grades';
        card.appendChild(pill);
      }
      const txt = formatGradeLabel(modernGrades[m[1]]);
      if (pill.textContent !== txt) pill.textContent = txt;
      pill.classList.toggle('mc-card-grade-hover', hover);
      pill.style.display = hide ? 'none' : '';
    }
    // 新版：Canvas 自己渲染了 span[data-testid="course-<id>-grade"]，BC 只改写它的文字并给宿主打标记
    const spans = document.querySelectorAll('span[data-testid$="-grade"]');
    for (const span of spans) {
      const m = (span.getAttribute('data-testid') || '').match(/course-(\d+)-grade/);
      if (!m) continue;
      const pill = span.closest("div[style*='position: absolute']");
      // 它接管过这颗药丸＝宿主被它挂了 bc-new-dash-grade-pill（它也是改写 Canvas 那颗 span 的文字）。
      // 这时候文字和显隐都别再动，否则我们"关成绩"那颗开关会把它画出来的成绩一起抹掉。
      // 归我们那一档时照旧动：这一代它没有自己的节点，抢回这一格只能靠把文字覆盖成我们的数，
      // 它那条 hover-only 的 opacity 由 style.css 抬权重压掉
      if (!gradeOurs && pill && pill.classList.contains('bc-new-dash-grade-pill')) continue;
      const g = formatGradeLabel(modernGrades[m[1]]);
      if (g !== '--' && span.textContent !== g) span.textContent = g;
      if (!pill) continue;
      pill.classList.add('mc-dash-grade-pill');
      pill.style.display = hide ? 'none' : '';
    }
    const css = hover ? '.mc-dash-grade-pill { opacity: 0 !important; transition: opacity 200ms !important; }\n\t\t\tdiv[data-testid^="course-grade-card"]:hover .mc-dash-grade-pill { opacity: 1 !important; }' : '';
    let node = document.getElementById('mc-dash-grade-styles');
    if (css) {
      if (!node) {
        node = document.createElement('style');
        node.id = 'mc-dash-grade-styles';
        document.head.appendChild(node);
      }
      if (node.textContent !== css) node.textContent = css;
    } else if (node && node.textContent) node.textContent = '';
  }

  /* ===== 课程卡上那块 Tasks =====
     摆在那排课程快捷图标（nav.ic-DashboardCard__action-container）下面，一条＝这门课还没交的一项。
     左边那颗圆圈和待办面板里同一颗是同一个控件：走 mcTickAssignment 那一条链，写 Canvas 的
     override 还是只留这台浏览器的本地键，照旧由设置里 Sync ticks to Canvas 那一档定。
     条数上限 card_task_limit（1-8，默认 3），总开关 mc_dash_tasks（默认开，同时管着把
     BetterCampus 补在同一处的那段 Due 藏起来）。该摆哪几条读 mcTaskState，和面板同一份判据，
     不会出现"面板里没有、卡片上单摆一条"。
     这一趟只挂在 1500 毫秒那条慢轮询和"数据／勾／设置变了"那几个点上：往 Canvas 那棵
     React 树里塞节点，挂到 DOM 变动监听上会和它的重渲染互相触发（分数药丸那一节实测过） */
  const MC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let mcTasksOpen = {}; // 只记他手动收起过的那几张：{ [courseId]: false }，其余默认展开

  function mcDashTasksOn() { return localStorage.getItem('mc_dash_tasks') !== '0'; }

  function mcDashTaskLimit() {
    const n = Number(modernSetting('card_task_limit'));
    return n >= 1 && n <= 8 ? n : 3;
  }

  // 卡片那一行窄，摆不开 "10/07 at 11:59 PM" 那么长。选了 Relative 就照面板那套说法走
  function mcCardDueLabel(due) {
    if (!due || isNaN(due.getTime())) return 'Due soon';
    if (modernSetting('date_format') === 'relative') return formatDueString(due);
    return MC_MONTHS[due.getMonth()] + ' ' + due.getDate();
  }

  // 这门课现在摆哪几条：过期的排最前，其余按到期日从近到远，最后截到设置里那一档
  function mcCourseTasks(courseId, userDoneMap) {
    const now = new Date();
    const out = [];
    modernAssignments.forEach(item => {
      if (String(item.courseId) !== String(courseId)) return;
      const state = mcTaskState(item, userDoneMap, now);
      if (!state || state.drop) return;
      // 时间窗跟着待办面板顶上那颗 Day / Week / Month 走：面板选了 10/5 - 10/12，
      // 卡片上就不该摆两周后的东西。过期那一批和面板一样不过这个窗口，它归 MISSING 那颗管
      if (!state.missing && !inViewWindow(item.due)) return;
      out.push({ item, missing: state.missing === true });
    });
    const dueTime = item => (item.due && !isNaN(item.due.getTime()) ? item.due.getTime() : Infinity);
    out.sort((a, b) => (a.missing !== b.missing ? (a.missing ? -1 : 1) : dueTime(a.item) - dueTime(b.item)));
    return out.slice(0, mcDashTaskLimit());
  }

  function mcCardTaskRowHtml(entry) {
    const item = entry.item;
    // 点整行落在哪儿跟着设置里那颗 Card Opens In：这里给的也是真链接，
    // 右键菜单、Ctrl+点击、中键那几样不用另写代码
    const target = modernSetting('card_click') === 'new' ? ' target="_blank"' : '';
    return '<div class="mc-card-task-row">' +
      // 圆圈的颜色不写在这：整块自己带 --course-color，设置里 Course colour 切到
      // Theme accent 时样式表把那颗变量重定义一次，圆圈跟着翻
      '<div class="custom-todo-check-circle mc-card-task-dot" data-id="' + mcEsc(item.id) + '"' +
        ' title="Mark as complete"></div>' +
      '<a class="mc-card-task-link" href="' + mcEsc(item.url || '') + '"' + target + '>' +
        '<span class="mc-card-task-name">' + mcEsc(item.title) + '</span>' +
        '<span class="mc-card-task-due">' + mcCardDueLabel(item.due) + '</span>' +
      '</a>' +
    '</div>';
  }

  function mcCardTasksHtml(tasks) {
    // 没有待完成的那一条时不再"标题＋一句空状态"两行叠着：那句话直接当标题，箭头和点击一起撤掉
    const head = '<div class="mc-card-tasks-head"' + (tasks.length ? ' data-mc-tasks-toggle="1"' : '') + '>' +
      '<span>' + (tasks.length ? 'Tasks' : 'Tasks are done') + '</span>' +
      (tasks.length ? '<svg class="section-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' : '') +
      '</div>';
    // 列表那一层永远在（空的时候它就是空的）：它带 overflow:hidden 和面板那条 0.32s 高度过渡，
    // 所以"这一张卡长高了"永远有东西可以动画，不会出现一种状态没得过渡、只能整块怼进去
    return head + '<div class="custom-todo-list-body mc-card-tasks-list">' +
      (tasks.length ? tasks.map(mcCardTaskRowHtml).join('') : '') + '</div>';
  }

  // 卡片在瀑布流里是脚本给坐标的：它长高缩矮那 320 毫秒，下面那几张得跟着挪，
  // 不然先叠住再跳开。墙那层的观察器只认子节点增删，认不到高度变化，所以这里自己按时钟补一趟。
  // 一整面墙共用这一条时钟：一次刷新可能四五张卡同时长高，各起一条 rAF 就变成一帧排四五趟
  let mcPumpUntil = 0;
  let mcPumpOn = false;

  function mcWallPump() {
    mcPumpUntil = Math.max(mcPumpUntil, Date.now() + 460);
    if (mcPumpOn) return;
    mcPumpOn = true;
    const step = () => {
      mcStep('mcMasonryLayout', () => mcMasonryLayout());
      if (Date.now() < mcPumpUntil) requestAnimationFrame(step);
      else mcPumpOn = false;
    };
    requestAnimationFrame(step);
  }

  /* 换内容时高度从旧值走到新值，别一下怼进来：列表那一层带 overflow:hidden，
     所以这一段看起来就是"一条条往下露出来"。瀑布流那边同时按帧重排（mcWallPump），
     下面那几张跟着往下挪，16 的间距一路都是匀的，不会先叠住再跳开
     ——2026-10-06：这一份现在没人调用（数据到齐那一趟用它＝闪"消失再展开"的成因之一，
     已经摘掉调用点）。他确认这轮不闪之后就整条删掉 */
  function mcMorphList(list, fromH) {
    if (!list || Math.abs(list.offsetHeight - fromH) < 2) return;
    list.style.height = fromH + 'px';
    void list.offsetHeight;
    list.style.height = list.scrollHeight + 'px';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      list.style.height = '';
      list.removeEventListener('transitionend', done);
    };
    list.addEventListener('transitionend', done);
    // 标签页在后台时过渡可能被整个跳过，transitionend 就不会来：那会儿行内高度得自己摘掉，
    // 不然这块会一直钉在动画起点那个值上
    setTimeout(done, 500);
    mcWallPump();
  }

  // quick＝只补"这张卡还没有那块"的，已有的不重算。瀑布流量高度之前先跑它一趟，
  // 于是卡片第一次被排进格子的时候高度就已经是带 Tasks 的最终高度＝不会先按矮的排、
  // 等这块上一屏再叠到下面那张头上（他报的"加载时卡片重叠在一起然后再移开"）
  function mcCardTasks(quick) {
    const on = mcDashTasksOn();
    // 这颗类名同时管两件事：我们那块上不上屏，和 BetterCampus 补在同一处的 Due 让不让位
    document.documentElement.classList.toggle('mc-dash-tasks', on);
    const cards = document.querySelectorAll('.ic-DashboardCard');
    if (!cards.length) return;
    // 本地那份打勾记录十张卡共用，读一次就够（面板那一趟也是这么读的）
    let userDoneMap = {};
    try { userDoneMap = JSON.parse(localStorage.getItem('mc_todo_local') || '{}') || {}; } catch (e) {}
    for (const card of cards) {
      const box = card.querySelector(':scope > .mc-card-tasks');
      // 只有设置里把这块关掉才摘它。认不出课程号不算"该摘"：卡片正被 React 重渲染、链接
      // 恰好不在的那一趟，按旧写法会把已经上屏的那块删掉，下一趟再补回来
      // ＝他报的"tasks 先显示一次、刷新过程中消失、又重新显示"
      if (!on) { if (box) box.remove(); continue; }
      // 课程号三个来源依次试：链接 href（正常情况）、theme-boot 在 document_start 就给每张卡
      // 补上的 custom-card-<id> 类名、这块自己上一次记住的号
      let courseId = '';
      const link = card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]');
      const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
      const cm = (card.className || '').match(/custom-card-(\d+)/);
      if (m) courseId = m[1];
      else if (cm) courseId = cm[1];
      else if (box) courseId = box.dataset.mcCourse || '';
      if (!courseId) continue;
      if (quick && box) continue;
      const tasks = mcCourseTasks(courseId, userDoneMap);
      // 这门课那一档颜色。面板那颗圆圈和卡片这颗读的是同一个 getCourseColor，
      // 两边不会一个红一个蓝。它进签名：Canvas 的自定义色是晚一步才拉回来的，
      // 不进签名的话这一趟会判定"没变"、卡片上一直挂着首帧那档哈希色
      const courseColor = getCourseColor(courseId, '');
      // 只有这一张卡该摆的东西真的变了才重搭：这一趟 1500 毫秒跑一次，
      // 每趟都重建会把展开动画的中间帧抹掉，也会让他刚点开的列表跳回顶部
      const sig = courseColor + '|' + tasks.map(e => e.item.id + (e.item.isSubmitted ? 'd' : '') + (e.missing ? 'm' : '')).join(',');
      if (box && box.dataset.mcSig === sig) continue;
      /* 复用原来那一颗节点，不摘掉再挂新的：换整块＝这张卡上有一帧是空的，而我们没法保证
         那一帧不被画出去（Canvas 的 React 也在同一棵子树里改节点）。他报的"先显示一次、
         刷新过程中消失、再重新显示"就是这一摘一挂。内容写进原来那颗节点，浏览器在同一帧里
         换完，中间没有空帧；高度变化由尺寸观察器接住，墙跟着挪 */
      const node = box || document.createElement('div');
      if (!box) node.className = 'mc-card-tasks';
      node.dataset.mcSig = sig;
      node.dataset.mcCourse = courseId;
      node.style.setProperty('--course-color', courseColor);
      node.innerHTML = mcCardTasksHtml(tasks);
      if (!box) {
        const nav = card.querySelector(':scope > .ic-DashboardCard__action-container');
        if (nav && nav.nextSibling) card.insertBefore(node, nav.nextSibling);
        else card.appendChild(node);
      }
      const list = node.querySelector('.mc-card-tasks-list');
      // 收起这一档只对真有几条作业的卡有意义（空的那张卡标题就是那句 done，没有可收的东西）
      if (list && tasks.length && mcTasksOpen[courseId] === false) list.classList.add('collapsed');
      // 数据到齐这一趟不做"从旧高度走到新高度"那段动画：它的起点是旧列表的高度，而旧列表
      // 正好是空的（或者已经被换掉）时量到 0，于是那几条先被裁没再展开＝看着像消失了一次。
      // 展开收起的动画只留给他点标题那一下（走 animateCollapse）
      mcWallPump();
      const head = node.querySelector('[data-mc-tasks-toggle]');
      if (head) {
        head.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          if (!list) return;
          const collapse = !list.classList.contains('collapsed');
          mcTasksOpen[courseId] = !collapse;
          animateCollapse(list, collapse);
          mcWallPump();
        });
      }
      node.querySelectorAll('.mc-card-task-dot[data-id]').forEach(dot => {
        dot.addEventListener('click', e => {
          // 圆圈在整行那条链接里面，不掐掉默认动作的话这一点同时会顺着链接跳去作业页
          e.preventDefault();
          e.stopPropagation();
          if (dot.classList.contains('mc-tick-pending')) return;
          mcTickAssignment(dot);
        });
      });
    }
  }

  /* ===== 卡片墙瀑布流 =====
     [BCP62] 实测：.ic-DashboardCard__box__container 就是整面卡片墙（一个容器直接装 10 张卡，
     907x961，position:static），不是一行一个容器。所以定位基准用它自己：这一层在页面里的位置
     一动不动，第一行的起始高度跟原来一样，不会顶到 Dashboard 标题那行；只是卡片从"跟着行走"
     改成"脚本给坐标"，往当前最矮的那一列放。
     不搬 Canvas 的节点（React 拥有的节点搬走会被它重渲染打回来）。
     开关是这一层上的 data-bcx-masonry：脚本没跑起来时属性不存在，画面还是 style.css 那套弹性行。 */
  var BCX_MASONRY_GAP = 16;
  // 一张卡在墙里的身份：aria-label（实测十颗都有值且互不相同）。拿不到就退到课程号，
  // 再拿不到就返回空串＝这一张不进列归属表，每趟按最矮那一列现算
  function mcCardKey(c) {
    const lb = c.getAttribute('aria-label');
    if (lb) return lb;
    const link = c.querySelector('.ic-DashboardCard__link') || c.querySelector('a[href*="/courses/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/courses\/(\d+)/);
    return m ? 'course-' + m[1] : '';
  }
  function mcMasonryField(field, forceReflow) {
    const cards = Array.prototype.slice.call(field.children).filter(el => el.classList.contains('ic-DashboardCard'));
    const total = field.clientWidth;
    if (!cards.length || total < 200) return;
    // 列数跟 style.css 里那两个断点用同一把尺子（都按窗口宽度），不然脚本和样式给的列数会打架
    const cols = window.innerWidth >= 1200 ? 4 : window.innerWidth >= 900 ? 3 : 2;
    /* 列宽和横坐标一律写成百分数，不写成量出来的像素。侧栏收放、AI 面板推挤那两段里，墙的宽度
       每帧都在变：像素那一档必须有人按帧重排才跟得上，上一版给墙挂了尺寸观察器按帧重排，
       代价是每一帧读十张卡的高度＋写三十个行内值＝全页强制重排，动画一路掉帧（他报的"很卡"）。
       百分数由浏览器自己按容器宽算，容器怎么变它都不用 JS 插手，这一趟只在
       "换列数／换卡片／某张卡长高了"时才需要跑。
       竖坐标不能这么写：那是各张卡的高度累加，高度只有像素可说——
       而它只在某张卡真的换行长高时才要重算，那种时刻尺寸观察器会报 */
    const wExpr = 'calc((100% - ' + BCX_MASONRY_GAP * (cols - 1) + 'px) / ' + cols + ')';
    for (const c of cards) {
      // 必须带 important：卡片本体那条规则写着 width:auto!important，普通行内值压不过它，
      // 列宽会被丢掉、卡片各自按内容收缩然后互相叠住（上一版就是这么砸的）
      if (c.style.width !== wExpr) c.style.setProperty('width', wExpr, 'important');
    }
    // 用 offsetHeight 不用矩形：矩形会把 transform 算进去，卡片一动画就跟着变，
    // 高度签名会一路误报"变了"
    const hs = cards.map(c => c.offsetHeight);
    const labels = cards.map(c => mcCardKey(c));
    // 已经定位好、而且列数/张数/顺序/每一张的高度都没变才跳过。
    // 墙宽不再算进来：横坐标现在吃的是百分数，容器宽变了坐标不用重发。
    // 顺序必须算进来：Canvas 排卡片靠的就是把节点在墙里搬来搬去（实测拖一次搬 254 次），
    // 只量张数的话搬完我们不再重发坐标，那张卡还钉在旧格子上、和占着那一格的卡叠在一起
    // ＝屏幕上凭空少一张。
    // 高度更要算进来：External Extension 会往卡片里面补一段 Due（待办列表），卡凭空长高几十到几百像素，
    // 而列数/张数/顺序一个都没变。上一版签名里没有高度，这一趟直接 return，
    // 下面那一格还钉在按旧高度算出来的位置上＝两张卡叠在一起（他截图里就是这样）。
    const wKey = cols + 'x' + cards.length + 'x' + hs.join('.') + 'x' + labels.join('|');
    // 下面那两半"卡片得有行内坐标"是必须的：Canvas 重渲染会换成一批没有坐标的新节点，
    // 而新节点量出来的高度跟旧的完全一样，只看签名就会判定"没变"直接 return，
    // 卡片永远停在叠着的那一坨
    if (!forceReflow && field.dataset.mcGeo === wKey && cards[0] && cards[0].style.top && cards[cards.length - 1].style.top) {
      return;
    }
    field.dataset.mcGeo = wKey;
    if (!field.hasAttribute('data-bcx-masonry')) field.setAttribute('data-bcx-masonry', '');
    /* 列的归属只在"换了卡片、换了顺序、列数变了"时才重算。墙宽不在这把尺子里：滚动条一进一出
       就把墙宽改掉十几像素，那一趟会误判成换了一面墙、整叠重新分列＝横向跳一次。
       高度变了更不能重算：一张卡展开就把自己那一列撑高，greedy 会把下面那张判给另一列
       ＝他报的"展开 tasks 导致下面的卡片左右移动"。
       而且重算时不再整叠推倒：列号存在墙自己身上这张按课程身份索引的表里。旧版存在每颗卡自己的
       dataset 上，而 Canvas 加载时一路重渲染、卡片节点被换成新的＝dataset 丢＝每来一批就整叠重分
       ＝底部那几张反复左右横跳。认得的卡保留原列，只给新面孔挑当下最矮那一列；
       只有它们之间的先后顺序真的变了（他拖了卡）才整叠重排。
       列数变了是唯一的例外，必须推倒重分：认得的卡保留原列这条规则在换列数时会把卡钉死在
       左边那几列（3 列缩成 2 列再放大回 3 列，第 3 列从来没人被分过去＝墙右边空出一整条）*/
    const placeKey = cards.length + 'x' + cols + 'x' + labels.join('|');
    let colMap = null;
    try { colMap = JSON.parse(field.dataset.mcColMap || 'null'); } catch (e) { colMap = null; }
    if (!colMap || typeof colMap !== 'object') colMap = {};
    if (forceReflow || field.dataset.mcPlace !== placeKey) {
      if (forceReflow || field.dataset.mcPlaceCols !== String(cols)) colMap = {};
      else {
        const knownOrder = labels.filter(l => l && colMap[l] != null).join('|');
        if (knownOrder !== Object.keys(colMap).join('|')) colMap = {};
      }
      field.dataset.mcPlace = placeKey;
      field.dataset.mcPlaceCols = String(cols);
      const probe = new Array(cols).fill(0);
      cards.forEach((c, i) => {
        const lb = labels[i];
        let col = lb && colMap[lb] != null ? Number(colMap[lb]) : -1;
        if (col < 0 || col >= cols) {
          col = 0;
          for (let k = 1; k < cols; k++) if (probe[k] < probe[col] - 0.5) col = k;
        }
        if (lb) colMap[lb] = col;
        c.dataset.mcCol = String(col);
        probe[col] += hs[i] + BCX_MASONRY_GAP;
      });
      field.dataset.mcColMap = JSON.stringify(colMap);
    }
    const tops = new Array(cols).fill(0);
    const pos = [];
    cards.forEach((c, i) => {
      const lb = labels[i];
      let col = lb && colMap[lb] != null ? Number(colMap[lb]) : Number(c.dataset.mcCol) || 0;
      col = Math.max(0, Math.min(cols - 1, col));
      pos.push([c, col, tops[col]]);
      tops[col] += hs[i] + BCX_MASONRY_GAP;
    });
    const fRect = field.getBoundingClientRect();
    for (const p of pos) {
      const cb = p[0].offsetParent;
      let dx = 0, dy = 0;
      // 基准本该是这一层自己；万一它上面还有别的定位祖先把卡片抢走了，差值自动补回来
      if (cb && cb !== field) {
        const r = cb.getBoundingClientRect();
        dx = r.left - fRect.left;
        dy = r.top - fRect.top;
      }
      // 一格＝(100% ＋ 一条间隙) 摊成 cols 份：列宽是 100% 减掉间隙再等分，加上它右边那条缝，
      // 化简正好是这个式子。第 0 列不用算，写死 0
      let left = p[1] ? 'calc(' + p[1] + ' * (100% + ' + BCX_MASONRY_GAP + 'px) / ' + cols + ')' : '0px';
      if (dx) {
        const d = Math.round(Math.abs(dx));
        left = left === '0px' ? (dx < 0 ? '-' + d + 'px' : d + 'px')
          : 'calc(' + p[1] + ' * (100% + ' + BCX_MASONRY_GAP + 'px) / ' + cols + ' ' + (dx < 0 ? '-' : '+') + ' ' + d + 'px)';
      }
      p[0].style.left = left;
      p[0].style.top = Math.round(p[2] - dy) + 'px';
    }
    // 卡片全退出文档流了，墙的高度得我们自己顶上，不然整块塌成 0、下面的内容跟着往上跳。
    // 只在值真的变了才写：拖拽期间这一趟会按帧跑，反复写同一个值等于每帧白重排一次整面墙
    const h = Math.max.apply(null, tops) - BCX_MASONRY_GAP;
    const mh = (h > 0 ? Math.round(h) : 0) + 'px';
    if (field.style.minHeight !== mh) field.style.minHeight = mh;
  }

  // 设置里选 Rows 时要把我们写的行内值全部撤掉，卡片才回到弹性行
  function mcMasonryOff(field) {
    if (!field.hasAttribute('data-bcx-masonry')) return;
    field.removeAttribute('data-bcx-masonry');
    field.style.removeProperty('min-height');
    for (const c of Array.prototype.slice.call(field.children)) {
      if (!c.classList.contains('ic-DashboardCard')) continue;
      c.style.removeProperty('width');
      c.style.removeProperty('left');
      c.style.removeProperty('top');
    }
  }

  /* Canvas 排卡片靠的就是把节点在墙里搬来搬去（实测拖一次搬 254 次），只靠 1500 毫秒那一趟
     根本跟不上：搬过去的卡还钉在我们上一次发给它的格子里，跟占着那一格的卡叠在一起，
     屏幕上就是凭空少一张，要等下一趟才分开。所以给每一面墙挂一条观察器，
     它搬一次我们下一帧就重排一次，让位反馈也画得出来。
     要带 subtree：External Extension 补那段 Due 是往卡片里面挂节点，墙这一层的直接子节点没动，
     只认 childList 第一层的话它把卡撑高了我们也收不到通知（只能等慢轮询那一趟）。
     只认子节点增删、不认属性：我们写的就是行内样式，认属性等于自己触发自己；
     我们自己往卡里补的那颗贴图层和分数药丸确实会多触发一帧，但那一趟量出来签名一样就直接返回。
     一帧最多排一趟（rAF 合并），拖得再快也不会堆成几十次连续强制重排。 */
  var mcWallSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
  var mcWallQueued = false;
  var mcWallForceReflow = false;
  var mcWallLastRun = 0;

  // 一帧最多排一趟：几条来源（节点增删、卡片换高度）同一帧里都只落进同一次重排
  function mcWallQueue(forceReflow) {
    if (forceReflow === true) mcWallForceReflow = true;
    if (mcWallQueued) return;
    mcWallQueued = true;
    requestAnimationFrame(mcWallFlush);
  }

  function mcWallFlush() {
    mcWallQueued = false;
    // 时间地板：一趟要读 10 个矩形、写 30 个属性，全是强制同步重排。拖得再猛也压到 40 毫秒
    // 一趟（25 次/秒），再多就是把自己跑成卡顿，屏幕上却看不出更快
    const now = performance.now();
    if (now - mcWallLastRun < 40) {
      mcWallQueued = true;
      requestAnimationFrame(mcWallFlush);
      return;
    }
    mcWallLastRun = now;
    const forceReflow = mcWallForceReflow;
    mcWallForceReflow = false;
    mcStep('mcMasonryLayout', () => mcMasonryLayout(forceReflow));
  }

  /* 卡片是脚本给坐标的（绝对定位），它自己长高缩矮推不动下面那一张。墙那层的观察器只认节点
     增删，可加载时卡片真正的高度变化大多不是节点增删：作业数据晚到一步，那块 Tasks 从
     "Tasks are done"变成几条待办；展开动画走完、行内高度被摘掉那一下；贴图和
     BetterCampus 补进来的 Due 换掉高度。这些时刻没人重排，下面那一张就继续钉在按旧高度算出来的
     格子里＝两张卡叠在一起，要等 1500 毫秒那一趟才分开。所以给每一张卡挂尺寸观察器。
     只认高度真的变了：我们写列宽时宽度也会报一次，那一趟量出来高度没变就不排，不会自己触发自己 */
  var mcCardSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
  var mcCardRo = typeof ResizeObserver === 'function' ? new ResizeObserver(function (entries) {
    var grew = false;
    for (const en of entries) {
      const el = en.target;
      const h = String(el.offsetHeight);
      if (el.dataset.mcRoH === h) continue;
      el.dataset.mcRoH = h;
      grew = true;
    }
    if (grew) mcWallQueue();
  }) : null;

  function mcMasonryWatch() {
    if (!mcWallSeen) return;
    for (const field of document.querySelectorAll('.ic-DashboardCard__box__container')) {
      if (mcWallSeen.has(field)) continue;
      mcWallSeen.add(field);
      new MutationObserver(mcWallQueue).observe(field, { childList: true, subtree: true });
    }
    if (!mcCardRo) return;
    for (const card of document.querySelectorAll('.ic-DashboardCard__box__container .ic-DashboardCard')) {
      if (mcCardSeen.has(card)) continue;
      mcCardSeen.add(card);
      // 挂上时先记一档当下的高度：尺寸观察器一开始就会补报一次，那一次不算"长高了"
      card.dataset.mcRoH = String(card.offsetHeight);
      mcCardRo.observe(card);
    }
  }

  function mcMasonryLayout(forceReflow) {
    const widgetDragging = !!(window.MCxFocus && window.MCxFocus.isWallDragging && window.MCxFocus.isWallDragging());
    if (!widgetDragging) mcMasonryWatch();
    // 排格子之前先把缺的那块 Tasks 补上：这一趟量的是卡片当下的高度，
    // 那块要是排完之后才出现，第一趟就是按"没有 Tasks 的矮卡"定的位置＝两张卡叠在一起，
    // 等下一趟才分开。补在量之前，卡片第一次落格就已经带着它最终的高度
    if (!widgetDragging) mcStep('mcCardTasks', () => mcCardTasks(true));
    // Card Layout 这条设置：默认 masonry（瀑布流），选 rows 就是一行一行
    const on = modernSetting('card_layout') === 'masonry';
    for (const field of document.querySelectorAll('.ic-DashboardCard__box__container')) {
      if (on) mcMasonryField(field, !!forceReflow);
      else mcMasonryOff(field);
    }
  }

  /* ===== 贴图那层的可点和 hover 暗角 =====
     [BCP61] 实测：贴图（__header_image / __header_hero）不在 a.ic-DashboardCard__link 里面，
     链接只包住标题那一条，所以原生点贴图不跳。这里在贴图最上面补一颗我们自己的层，
     它同时干两件事：点一下进这门课、hover 时压一圈内阴影。
     阴影画在这颗层上而不是画在贴图元素上，是因为主题把贴图分成了图层和色膜两层，
     画在底下的会被它们压住看不见。 */
  function modernCardCoverLayer() {
    for (const card of document.querySelectorAll('.ic-DashboardCard, [data-testid^="course-grade-card"]')) {
      const cover = card.querySelector('.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero');
      if (!cover || cover.querySelector(':scope > .mc-card-cover')) continue;
      const layer = document.createElement('div');
      layer.className = 'mc-card-cover';
      cover.appendChild(layer);
    }
  }

  document.addEventListener('click', e => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const layer = e.target && e.target.closest ? e.target.closest('.mc-card-cover') : null;
    if (!layer) return;
    const card = layer.closest('.ic-DashboardCard, [data-testid^="course-grade-card"]');
    const link = card && (card.querySelector('.ic-DashboardCard__link') || card.querySelector('a[href*="/courses/"]'));
    if (!link) return;
    e.preventDefault();
    link.click();
  });

  // BC 开着时它给这几层刷背景，一关就露回白。它那几个 --bcsidebar / --bcbackground-image* 变量
  // 不一定在我们扫的根上，所以这里跟卡图一样：直接抄画面上最终渲染出来的背景。
  function mcSurfaceTheme() {
    const out = {};
    const grab = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      // 背景要整组抄。上一版只抄了 image 再自己硬写 cover/no-repeat，
      // 结果它本来是平铺的小图被我们拉成一张巨大的
      const rec = {
        color: cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '',
        bg: cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : '',
        size: cs.backgroundSize, repeat: cs.backgroundRepeat, pos: cs.backgroundPosition,
        font: cs.fontFamily && cs.fontFamily !== 'none' ? cs.fontFamily : '',
        layer: before.backgroundImage && before.backgroundImage !== 'none' ? before.backgroundImage : '',
        filter: before.filter && before.filter !== 'none' ? before.filter : ''
      };
      const label = el.querySelector('.menu-item__text');
      if (label) rec.text = getComputedStyle(label).color;
      // 图标是实心 fill 画的（[BCP50]：stroke=none，fill 写死；我们后来也是点 fill 才换得动）。
      // 原来这里只读 color，抓到的是 Canvas 自己那层原生白，BC 一关我们再把白写回去
      // ＝侧栏图标全白。所以先认 svg 的 fill，fill 不是颜色才退 color；
      // 排在第一个的 .ic-icon-svg 是 HTML 容器，它的 fill 是无意义的默认黑，所以要挑到 svg 这一层
      const icon = el.querySelector('svg.ic-icon-svg, .ic-icon-svg svg, .menu-item-icon-container svg, .ic-icon-svg');
      if (icon) {
        const ics = getComputedStyle(icon);
        const isSvg = String(icon.tagName).toLowerCase().indexOf('svg') === 0;
        const paint = isSvg ? ics.fill : '';
        rec.icon = (paint && paint !== 'none' && mcToRgb(paint) ? paint : '') || ics.color || '';
      }
      return rec.color || rec.bg || rec.layer ? rec : null;
    };
    const nav = grab(document.querySelector('.ic-app-header'));
    const body = grab(document.body);
    const app = grab(document.getElementById('application'));
    if (nav) out.nav = nav;
    if (body) out.body = body;
    if (app) out.app = app;
    return out;
  }

  function applyModernSurfaces(allow) {
    const snap = allow && mcPaintsPageTheme() ? mcSnapshot() : null;
    const s = snap && snap.surfaces ? snap.surfaces : null;
    const nav = document.querySelector('.ic-app-header');
    const targets = [['body', document.body], ['app', document.getElementById('application')], ['nav', nav]];
    for (const [key, el] of targets) {
      if (!el) continue;
      const rec = s && s[key];
      const sig = rec ? [rec.color, rec.bg, rec.size, rec.repeat, rec.pos, rec.layer, rec.filter, rec.text, rec.icon].join('|') : '';
      if (el.dataset.mcSurface === sig) continue;
      el.dataset.mcSurface = sig;
      const labels = el.querySelectorAll('.menu-item__text');
      const icons = el.querySelectorAll('.ic-icon-svg, .menu-item-icon-container');
      if (!rec) {
        for (const prop of ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'background-attachment']) el.style.removeProperty(prop);
        const layer = el.querySelector(':scope > .mc-surface-layer');
        if (layer) layer.remove();
        labels.forEach(n => n.style.removeProperty('color'));
        icons.forEach(n => n.style.removeProperty('color'));
        continue;
      }
      if (rec.color) el.style.setProperty('background-color', rec.color, 'important');
      if (rec.bg) {
        // 尺寸/平铺/位置一律照抄，不再自己猜 cover
        el.style.setProperty('background-image', rec.bg, 'important');
        if (rec.size || key === 'nav' && /url\(|image-set\(/i.test(rec.bg))
          el.style.setProperty('background-size', key === 'nav' && /url\(|image-set\(/i.test(rec.bg) ? 'auto 100%' : rec.size, 'important');
        if (rec.repeat) el.style.setProperty('background-repeat', rec.repeat, 'important');
        if (rec.pos) el.style.setProperty('background-position', rec.pos, 'important');
        // 它自己只给 body 和 #application 上 fixed，侧栏不上 —— 窄栏用 fixed 会把图钉到视口上错位
        if (key !== 'nav') el.style.setProperty('background-attachment', 'fixed', 'important');
      }
      // 文字和图标颜色也要跟着翻，否则浅底配原生白字直接糊掉
      if (rec.text) labels.forEach(n => n.style.setProperty('color', rec.text, 'important'));
      if (rec.icon) icons.forEach(n => n.style.setProperty('color', rec.icon, 'important'));
      // 侧栏那张图它画在 ::before（z-index -1 + isolation:isolate），伪元素写不了行内，用子层等价顶替
      if (rec.layer && key === 'nav') {
        el.style.setProperty('position', 'relative', 'important');
        el.style.setProperty('isolation', 'isolate', 'important');
        let layer = el.querySelector(':scope > .mc-surface-layer');
        if (!layer) { layer = document.createElement('div'); layer.className = 'mc-surface-layer'; el.insertBefore(layer, el.firstChild); }
        layer.style.cssText = 'content:"";position:absolute;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;'
          + 'background:' + rec.layer + ' center / cover no-repeat !important;'
          + 'filter:' + (rec.filter || 'none') + ' !important';
        if (/url\(|image-set\(/i.test(rec.layer)) {
          layer.style.setProperty('background-size', 'auto 100%', 'important');
        }
      }
    }
  }


  let mcLivePrev = null;
  let modernFlips = [];
  let mcFrozen = false;
  // var 不是随手写的：折叠栏那行课程图要在侧栏行里读这份卡图表，而第一趟 mcUiPass 是同步跑的、
  // 排在这条声明前面几十行。let 的话那一趟会撞 TDZ 抛 ReferenceError（被 mcStep 吞掉＝课程分区第一趟挂不出来）
  var mcCardSnapshot = {};
  let mcThemeSnapshot = { sheets: [], rootVars: '' };
  let mcLastCardScrape = 0;
  function applyModernPalette() {
    // 这一趟开头就要知道 BC 在不在跑（下面 paints 和读色那一条都归它判），
    // 而那颗类名要到这一趟末尾才挂上。判据和末尾那一条一字一样，只是提前量一次
    const bcLiveNow = !!document.querySelector('style[id^="bettercampus"], style[id^="bettercanvas"], bettercanvas-portal, bettercampus-components, bettercampus-element');
    const roots = [document.documentElement, document.body, document.getElementById('wrapper'), document.getElementById('application')].filter(Boolean);
    const computed = roots.map(el => getComputedStyle(el));
    const stored = mcThemeOff() ? null : mcSnapshot();
    // 用户明确应用/导入过一份主题（快照带 imported）＝这份主题归用户说了算。
    // 直接读原始快照判，不看 keep_theme：那颗开关关掉只是"暂时别贴我们的色"，
    // 不代表用户没选过主题——要是这里读成 null，抓取就会把他选的那份当镜像覆盖掉（就是"选完被复原"）
    const rawSnap = mcSnapshot();
    // 侧栏是图、存档里没采样：这一趟顺手补一次（采到了会自己再跑一趟取色）
    mcStep('mcNavSamplePass', () => mcNavSamplePass(rawSnap));
    const userOwns = !!(rawSnap && rawSnap.imported);
    const snap = stored && stored.vars ? stored.vars : null;
    // 页面那一层交给 External Extension 时，我们自家面板（待办列表、搜索框、那一排按钮、侧栏那颗胶囊）
    // 也要跟着它的色走：只把它的主题让给 Canvas 页面、面板还留着我们自己那份主题，
    // 画面就是半新半旧，比两套撞在一起还怪。所以这一趟读谁的颜色跟着这一档翻
    const paints = mcPaintsPageTheme(bcLiveNow);
    const live = {};
    const readVar = name => {
      // 用户明确应用/导入过主题（快照带 imported）＝这份是权威，不再优先读页面上的 --bc*。
      // 理由：External Extension 就算被关掉、组件被摘走，它那份 :root 变量表仍可能留在页面上，
      // 里面是上一套主题的色。[实测 2026-10-04] 换成花卉那套之后页面上还挂着一份 21KB 的
      // 旧表，新主题没有 buttons 这一档，退到 background-2 时就被旧表的 #c7d0a2 顶掉了。
      // 快照里那份 vars 已经合过用户在 Colors 面板改的档（mcCommitSnapshot），所以这里读它就够。
      // 但这一条只在"我们自己在刷页面"时成立：交给它的时候反过来，优先读页面上它那份
      if (userOwns && paints) return (snap && snap[name]) || '';
      for (const s of computed) {
        const solid = s.getPropertyValue('--' + name + '-ungradient').trim();
        const val = solid || s.getPropertyValue('--' + name).trim();
        if (val) { live[name] = val; return val; }
      }
      return (snap && snap[name]) || '';
    };
    const picked = {};
    // 这一轮从主题档算出来的原始串，按 token 存一份。可读性兜底关掉时要拿它把行内值还回去：
    // 兜底以前是直接改写同一颗行内属性的，光靠 removeProperty 会一直空到下一轮（两秒）＝闪一下
    const tokenRaw = {};
    const editedSlots = (stored && stored.edits) || {};
    // 他按下过哪几档的 "No colour"（卡底、控件底板）。判据和面板那 12 行共用 mcClearedTokens
    const clearedTokens = mcClearedTokens(stored);
    let count = 0;
    for (const token of Object.keys(BCX_TOKEN_MAP)) {
      // 他拧过的那一档排到最前。判据和面板那一行共用 mcEditedFirst，两边各写一套就是
      // "拖动时有变化、松手跳回去"：cards 排在 background-0 前面，而面板上那一行改的是
      // background-0，不插队就永远轮不到他改的那档
      let raw = '';
      let wonName = '';
      for (const name of mcEditedFirst(BCX_TOKEN_MAP[token], editedSlots)) {
        const v = readVar(name);
        // 一颗完全透明的色也算"读到了"，照作者给的画（14/3197 份主题的 cards 档就是 #00000000，
        // 他给卡片铺了图，这一档透明才透得出图）。但它不进 picked：下游拿它当黑底会挑错色
        if (v && (mcToRgb(v) || mcIsClear(v))) { raw = v; wonName = name; break; }
      }
      // 卡底撞页面底时往白推一档。面板那一行、theme-boot 首帧算的是同一份数，差一点就是
      // "行上写一个色、页面画另一个色"
      if (raw) {
        raw = mcCardLiftOf(wonName, raw, readVar('bcbackground-1'),
          !!editedSlots[mcSlotOfVar(wonName)]);
      }
      // 面板上那颗 "No colour" 是这一档的最终答案，不再往链条后面找
      if (clearedTokens[token]) raw = 'transparent';
      if (!raw) { mcSetRootVar(token, ''); continue; }
      mcSetRootVar(token, raw);
      tokenRaw[token] = raw;
      // 记下"还没过透明度之前"的那一串，滑杆单独跑一趟时要拿它当底
      mcTokenBase[token] = raw;
      count++;
      if (!mcIsClear(raw)) picked[token] = mcToRgb(raw);
    }
    /* 带滑杆的那两档（卡底、控件底板）各过一遍自己的透明度，顺带把侧栏那颗胶囊和 mc-frost
       那个类名同步好。排在整组之后：tint 和合成都要拿页面底那一档，那颗得先算出来 */
    const cardFrost = mcApplyAlphaPass(picked['--mc-background-1'] || null);
    if (cardFrost) {
      tokenRaw['--mc-background-0'] = cardFrost.css;
      // 对比度兜底读的是"合成以后眼睛实际看到的那颗"，不是 tint 本身：
      // 半透明的底还按实色比，挑出来的字色就是糊的
      picked['--mc-background-0'] = cardFrost.rgb;
    }
    // 卡底这一档刚被推过／被拧过，那圈灰边该不该挂要跟着重判一次。
    // 只在 applyLogoSettings 里判的话，他在 Colors 面板拧一颗色之后这一圈不会当场回来
    mcStep('mcSyncDashOutline', () => mcSyncDashOutline(rawSnap));
    // 【合二为一】这里原来有一段"cards 缺档就掺 0.72 白造一档"。现在卡底直接吃 background-0
    // （BCX_TOKEN_MAP 那条退路负责），不再自己造色，面板上也只剩一行管它
    // 强调色那颗白勾：用户在 Colors 面板里可以把强调色调得很浅，浅到底上看不见白勾。
    // 勾的颜色按强调色自己的明暗翻（浅底压深、深底提白），和"色块上放反色符号"那一条一致。
    // 开关关掉时这一条也不写，勾停在 CSS 那套回退上
    if (mcFlipOn() && picked['--mc-links']) {
      mcSetRootVar('--mc-links-ink', mcInkOn('', picked['--mc-links']));
    }
    const snapVars = (stored && stored.vars) || {};
    const sNav = (stored && stored.surfaces && stored.surfaces.nav) || {};
    const slotNavInk = snapVars['bcsidebar-text'] || snapVars['sidebar-text'] || (sNav && (sNav.text || sNav.icon)) || '';
    if (slotNavInk) {
      const navBaseRaw = snapVars.bcsidebar || (sNav && (sNav.color || sNav.raw)) || '';
      const navSamples = (sNav && sNav.flat) ? [] : ((sNav && sNav.samples) || []);
      const navInk = mcFlipOn() ? mcSidebarInk(navBaseRaw, slotNavInk, navSamples) : slotNavInk;
      if (navInk) mcSetRootVar('--mc-nav-ink', navInk);
    }
    // [BCX nav plate] 侧栏当前项那颗胶囊跟着卡底那一档走，那一步抽在 mcApplyAlphaPass 里了
    // （设置里那根滑杆单独跑那一趟时也要同步它，两边不能一个改一个不改）
    // BC 活着没有，必须用 DOM 事实判断，而且不能用"文里有没有 --bc 子串"：
    // 我们自己的 style.css 里有 142 处 --mc-*，它的表也含 --bc，那样判断会把自己认成 BC，
    // 于是撤表→再认成 BC→再注回，画面在两种状态之间来回闪。
    // 它注入的样式表 id 一律以 External Extension / bettercanvas 开头，这个我们不会用。
    // 「BC 在跑」的判据：它自己注入的样式表 id，或者它那几个常驻自定义元素。
    // 只要它在跑我们就不贴，避免我们这份快照盖在它当前主题上面（快照可能是旧主题）
    let bcLive = !!document.querySelector('style[id^="bettercampus"], style[id^="bettercanvas"], bettercanvas-portal, bettercampus-components, bettercampus-element');
    // 止损：万一判定又被什么东西带得来回翻，宁可稳定用我们自己的主题，
    // 也绝不让画面在两种状态之间跳
    if (mcLivePrev !== null && mcLivePrev !== bcLive) {
      modernFlips.push(Date.now());
      modernFlips = modernFlips.filter(t => Date.now() - t < 10000);
      if (modernFlips.length > 6 && !mcFrozen) {
        mcFrozen = true;
        console.warn('[BCX] 判定 10 秒内翻转超过 6 次，已冻结为「BC 不在」，只走我们自己的主题');
      }
    }
    mcLivePrev = bcLive;
    /* 现场那一份判定（有没有它的表和元素）先单独留着。下面那个冻结只该管"我们贴不贴表"，
       不该顺手把整条侧栏弄没——它一冻结就把那颗开关属性摘掉，BC 那条 opacity:0 就一直在，
       症状就是刷新以后侧栏只剩一张主题图、一行字都没有（他报的那一种） */
    const bcRaw = bcLive;
    if (mcFrozen) bcLive = false;
    const fromLive = bcLive;
    // BC 在跑时它会把左侧全局导航改成自己的样式，我们那颗 Settings 排在里面出不来，
    // 所以那颗按钮这时挪到待办面板右上角；BC 一关就回侧栏。两头都只看这个类名
    document.documentElement.classList.toggle('mc-bc-live', fromLive);
    // 导航可见性只看现场事实，不看冻结
    mcNavRestore(bcRaw);
    // 主题生效＝BC 在跑，或者我们正用留存下来的那份，或者 Canvas 那一档选了深色。挂个类名给 style.css 用：
    // 我们自己在第 5 节里给导航写的那几条配色，这时要让路给抄来的表
    document.documentElement.classList.toggle('mc-themed', fromLive || !!stored || mcDarkOn());
    // 两套主题同时在刷这一页（它在跑、这一层也归我们刷）＝侧栏 Settings 那一行右上角给一个点。
    // 只在真抢起来时露：BC 不在跑不露，他把这一层让给 BC 了也不露（那时候没得抢）
    document.documentElement.classList.toggle('mc-theme-clash', fromLive && paints);
    /* 抄它那份色之前，先问一句"它那张主题表现在到底有没有在画这一页"。
       fromLive 只认它那几颗节点在不在，不认表有没有被摁住（owner 归我们的时候
       mcKeepThemeSheetLast 会把它的主题表整张 disabled）。表摁着的时候这一页就是没上漆的样子，
       这时候抄色抄到的是 Canvas 原生色，而下面那一步会把它当成"它正在用的主题"整格写回存档，
       base 那层一起覆盖＝首页那一屏的色被这份坏存档带着走，看起来就是我们自己把颜色弄坏了。
       注意不能改成"看这一层归谁刷"：没挑主题、正靠镜像跟着它走的那种状态是合法产品态，
       那一档要照抄，只有"表被摁住＝没东西可抄"才该跳过 */
    if (fromLive && !userOwns && mcThemeSheetPainting()) {
      // 图那几个槽要的是原始串（含渐变和 url），不是 -ungradient 那个纯色
      for (const name of BCX_IMAGE_VARS.concat(BCX_EXTRA_VARS)) {
        for (const s of computed) {
          const val = s.getPropertyValue('--' + name).trim();
          if (val) { live[name] = val; break; }
        }
      }
      // 抓整份主题要逐层量样式、还要序列化上 MB 的文本，代价不低，而这段挂在 DOM 变动监听上，
      // 所以三秒一次
      const now = Date.now();
      if (!mcLastCardScrape || now - mcLastCardScrape > 3000) {
        mcLastCardScrape = now;
        const fresh = mcCardTheme();
        // 三秒窗口可能截到只渲染完一半的首页，逐条合并：新抓到的这张没图就保留旧的那张，
        // 别让一次不完整扫描把已留存的图清空
        for (const k of Object.keys(fresh)) {
          if ((!fresh[k].img || fresh[k].img === 'none') && mcCardSnapshot[k] && mcCardSnapshot[k].img) {
            fresh[k] = mcCardSnapshot[k];
          }
        }
        mcCardSnapshot = fresh;
        mcThemeSnapshot = mcThemeSheets();
        const surfaces = mcSurfaceTheme();
        // 用户在 Colors 面板手改的那几档要活过这一轮抄色：base 记原始值，vars 记合起来的值。
        // 不在这里合，下一轮抄色就把他改的色顶回主题本来的样子
        const prevSnap = mcSnapshot();
        const edits = (prevSnap && prevSnap.edits) || {};
        const merged = Object.assign({}, live, mcEditVars(edits));
        const mergedSnap = { base: live, edits, vars: merged, surfaces, cards: mcCardSnapshot };
        const mergedSurfaces = mcSnapSurfaces(mergedSnap);
        // 【测试阶段，禁止删除】sheets 这个字段照留（现在恒为空数组），别当没人用的字段清掉：
        // 贴表那条通路只是停用，回退要靠它。这份记录真正存的是参数＝vars 槽值 + rootVars 根变量
        // + surfaces 底色和图 + cards 卡图 + fonts 字体 + themeCss 我们自己编译的那份，
        // 和设置里"导入 JSON"产出的形状一致，两条通路共用同一份存储、同一段渲染代码
        const nextSnap = {
          vars: merged,
          base: live,
          edits,
          // 万一这轮在竞态窗口里跑了（userOwns 判定没赶上），也要把"用户选过哪份主题"的标记留住，
          // 否则标记一丢，之后每轮都当镜像处理，等于把用户选的主题永久盖掉
          imported: (prevSnap && prevSnap.imported) || undefined,
          // 那几颗 "No colour" 也是这一格存档的状态。这一份 next 是整格重写的，不在这儿带上，
          // 后台每三秒抄色就把他按下的那颗透明撤回去（画面隔三秒自己闪回实色）
          clearSlots: (prevSnap && prevSnap.clearSlots) || undefined,
          cards: mcCardSnapshot,
          surfaces: mergedSurfaces,
          sheets: mcThemeSnapshot.sheets,
          rootVars: mcStripSlots(mcThemeSnapshot.rootVars, Object.keys(edits)),
          fonts: mcThemeSnapshot.fonts,
          // 这一格是 BC 在刷页面时抄来的镜像：baseFont 故意不带（没这个字段＝字体那条通道不动它，
          // 抄回来的那条字体栈留着）。他挑过的字体要一路带下去，等页面那一层翻回我们时就能画上
          fontEdit: (prevSnap && prevSnap.fontEdit) || null
        };
        mcApplyFontChannel(nextSnap);
        nextSnap.themeCss = mcThemeCss({ surfaces: nextSnap.surfaces, cards: mcCardSnapshot, vars: merged });
        const next = JSON.stringify(nextSnap);
        if (next !== localStorage.getItem(mcSaveKey())) {
          mcWriteSnapshot(next);
        }
        // 记录用户最后一次在 BetterCampus 中使用的主题（含壁纸、侧栏贴图、卡片图、配色等），
        // 这样即使日后关闭或卸载 BetterCampus，用户依然可以在 Modern Canvas 中选择并继续使用这份主题
        try { localStorage.setItem('mc_bc_recorded_theme', next); } catch (e) {}
      }
    } else {
      const stored = mcSnapshot();
      if (stored && stored.cards) {
        mcCardSnapshot = stored.cards;
      }
      // 先把存量里那颗白补掉，再补卡图：这样这一趟新分到图的课用的就是补好的颜色
      if (stored) mcStep('mcRepairCardTitleColors', () => mcRepairCardTitleColors(stored));
      if (stored) mcStep('mcExpandImportedCards', () => mcExpandImportedCards(stored));
    }
    // 主题的正文色未必在我们取到的卡底上读得清，太淡就按卡片明暗翻成纯黑或纯白。
    // 线划在 3:1（WCAG 给大号字和图形的底线）。原来是 4.5:1，实测太狠：主题自带的正文色
    // 落在浅卡底上普遍只有 3.5 到 4.5（Chiikawa 那套是 3.93），照 4.5 会把整片正文压成纯黑，
    // 主题色等于没装上。
    // 提示只跟正文那两档（ink / ink-strong）挂钩：最浅那档是日期、分数这类小字，
    // 它被压不压都不改变"读起来是主题色还是黑字"这件事，跟着报警就是假警报
    const card = picked['--mc-background-0'];
    const pageBg = picked['--mc-background-1'];
    mcInkFix = '';
    const inkTokens = ['--mc-text-0', '--mc-text-1', '--mc-text-2'];
    if (!mcFlipOn()) {
      // 开关关着：把这几颗行内值还成主题档自己那颗色（不是删掉，删了要等下一轮才补回来＝闪两秒）
      for (const token of inkTokens) {
        if (tokenRaw[token]) mcSetRootVar(token, tokenRaw[token]);
      }
    } else if (card || pageBg) {
      for (const token of inkTokens) {
        const textRgb = picked[token];
        if (!textRgb) continue;
        const pageContrast = pageBg ? modernContrast(textRgb, pageBg) : 99;
        const cardContrast = card ? modernContrast(textRgb, card) : 99;
        if (pageContrast < 3 || cardContrast < 3) {
          // 黑还是白按"两层底里更差的那一层"挑，谁在更差那层上还更高就用谁
          const ink = mcFlipInk([card, pageBg]);
          mcSetRootVar(token, ink);
          if (!mcInkFix && token === '--mc-text-0') {
            mcInkFix = ink === '#000000' ? 'black' : 'white';
          }
        }
      }
    }
    // 强调色是实心块，块上那颗符号按它自己的明度翻黑或白（浅主题上白勾会糊）
    const accent = picked['--mc-links'];
    mcSetRootVar('--mc-links-ink', !mcFlipOn()
      ? '#ffffff'
      : (accent && mcLuminance(accent) > 0.45 ? '#000000' : '#ffffff'));
    // 公告卡那根色条和块里那颗图标：BC 有一条带 id 的宽口子（#announcementWrapper > div > div
    // 铺 background-0），我们只写类名的规则权重压不过它，两边都带 !important 时按权重分胜负。
    // 所以有主题时直接写行内 !important，这是唯一稳赢的写法。值没变就不写（写属性会再触发一次
    // DOM 变动，会和观察器互相拉起）；主题撤了就把行内删掉，让 CSS 那套回退链自己接上原生色
    const accentRaw = accent ? 'rgb(' + accent.join(',') + ')' : '';
    /* [BCX link ink] 链接文字专用那一档（theme-boot.js 里有一份逐字对齐的，两边算出两个值
       ＝刷新后翻一次色）。强调色当实心块用时，块上永远配一颗算好的黑/白字，所以它不用自己够
       对比度；一旦拿它当文字坐在卡底和页面底上，那层保护就没了：主题库 3190 份里 1425 份的
       Accent 放在白卡上拉不到 3:1，一堆干脆就是纯白。所以两层都得拉得开才敢用，
       不然退回正文那一档（上面那圈兜底已经把它翻成读得清的了）*/
    const linkReadable = !mcFlipOn() || (accent
      && (!card || modernContrast(accent, card) >= 3)
      && (!pageBg || modernContrast(accent, pageBg) >= 3));
    if (accent) {
      mcSetRootVar('--mc-links-text', linkReadable ? accentRaw : 'var(--mc-text-0)');
    } else {
      mcSetRootVar('--mc-links-text', '');
    }
    // 外壳同理：BC 那条口子铺的就是它自己那档页面底，所以有它时卡片会跟页面同一个色，
    // 只剩正文那一小块是我们的卡底（style.css 那条两个类名，赢过 BC 的单类名），
    // 一张卡两种底。卡底也写行内 !important，整张才统一回我们那一档
    const cardRaw = picked['--mc-background-0'] && mcToRgb(picked['--mc-background-0']) ? 
      'rgb(' + mcToRgb(picked['--mc-background-0']).join(',') + ')' : '';
    for (const k of document.querySelectorAll('.ic-notification')) {
      const now = k.style.getPropertyValue('--mc-notif-rail');
      if (accentRaw && now !== accentRaw) k.style.setProperty('--mc-notif-rail', accentRaw);
      else if (!accentRaw && now) k.style.removeProperty('--mc-notif-rail');
      // BC 开着时才刷背景颜色（theme-boot 里也有相同的门控逻辑）
      if (fromLive) {
        const nowShell = k.style.getPropertyValue('background-color');
        if (cardRaw && nowShell !== cardRaw) k.style.setProperty('background-color', cardRaw, 'important');
        else if (!cardRaw && nowShell) k.style.removeProperty('background-color');
      }
      // Canvas 原生的左侧竖条要贴主题强调色（从 .ic-notification__icon 到 .canvas-notif-* 都点名，防止类名变）
      // 【为什么两块都得写行内】[实测 2026-10-05] BC 那张表里有一条带 id 的
      //   `#announcementWrapper > div > div{background:var(--bcbackground-0)!important}`，
      //   权重＝1 个 id，压过我们样式表里任何只写类名的规则（我们最高那条也才 4 个类名），
      //   于是中间那块图标座被刷成卡底，而顶天立地的竖条还是强调色＝竖条正中露出一段卡底色。
      //   行内 !important 在作者层里排最高，实测（先把过渡摘掉，免得读到过渡起点值）
      //   同一条调用里写进去立刻从卡底粉读成强调绿，所以这两块由这里钉住。
      //   上一版是"有竖条就只刷竖条、并把图标块先前写的行内色摘掉"，交给样式表那条透明接管——
      //   那条正是被上面这个 id 压掉的，摘掉行内＝把这块交回给 BC，所以随之删掉那条规则。
      //   两块吃的是同一趟里的同一个 accentRaw，不会再出现换主题那一瞬各拿一套色的旧问题
      const railEl = k.querySelector('.canvas-notif-accent-rail');
      const railTargets = [railEl, k.querySelector('.ic-notification__icon'),
        k.querySelector('.canvas-notif-icon'), k.querySelector('.canvas-notif-rail')];
      for (const el of railTargets) {
        if (!el) continue;
        if (accentRaw) {
          const nowRail = el.style.getPropertyValue('background-color');
          if (nowRail !== accentRaw) el.style.setProperty('background-color', accentRaw, 'important');
        } else if (el.style.getPropertyValue('background-color')) {
          el.style.removeProperty('background-color');
        }
      }
    }
    // BC 活着且用户没自己选主题时传 false，把我们之前贴的撤掉，别跟它抢同一层。
    // 但用户明确应用/导入过（userOwns）就照贴：那份主题归他说了算，BC 在跑也不该盖回去。
    // 上面那一档（paints）压过这一条：他说了"页面交给 External Extension"，我们就不贴，
    // 连卡片那些钩子也不挂，免得挂一半
    const paint = paints && (!fromLive || userOwns);
    applyModernSheets(paint);
    applyModernThemeSheet(paint);
    if (paint) mcStep('mcCardHooks', () => mcCardHooks());

    // BC 动态注入时立刻检查是否需要唤起初次设置弹窗
    if (fromLive) {
      maybeShowBcTodoPrompt();
      maybeShowBcThemePrompt();
    }
    // 这一趟算完的最终色抄一份给扩展自己的 popup
    mcPublishPopupTheme();
  }

  /* ==== popup 那九档色 ====
     popup 是另一个文档：读不到这一页 <html> 上的 --mc-*，也读不到 Canvas 源那份 localStorage
     （跨源），所以只能靠 chrome.storage.local 传一格。写的是行内那一份＝这一趟的最终答案，
     包含磨砂合成和可读性兜底翻过的色，popup 那边不用再算一遍。
     这一趟挂在 DOM 变动监听上，所以先比字符串，一样就不写 */
  var mcPopupThemeSent = '';
  function mcPublishPopupTheme() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    const st = document.documentElement.style;
    const out = {};
    let n = 0;
    for (const token of Object.keys(BCX_TOKEN_MAP)) {
      const raw = String(st.getPropertyValue(token)).trim();
      if (raw) { out[token] = raw; n++; }
    }
    if (!n) return;
    const text = JSON.stringify(out);
    if (text === mcPopupThemeSent) return;
    mcPopupThemeSent = text;
    try { chrome.storage.local.set({ mc_popup_theme_v1: out }); } catch (e) {}
  }

  // 首次读取只能放在这里：上面那组 BCX_TOKEN_MAP 是 const，不提升，
  // 放在更早的初始化那一串里会抛 ReferenceError，把后面整个脚本一起打断
  mcStep('applyModernPalette-boot', () => applyModernPalette());
  mcStep('applyLogoSettings', () => applyLogoSettings());


  // 课程 / Groups 抽屉顶部那条 "All Courses"、"All Groups"：认文本不认类名（抽屉里每个课程也是
  // a.view-link，按类名改会连课程列表一起变成按钮），加类后由 CSS 套 View Grades 那颗的同一条规则
  function dressDrawerAllCourses() {
    const tray = document.getElementById('nav-tray-portal');
    if (!tray) return;
    const link = [...tray.querySelectorAll('a')].find(a => /^(All Courses|All Groups)$/.test(a.textContent.trim()));
    if (link && !link.classList.contains('bc-drawer-all-courses')) link.classList.add('bc-drawer-all-courses');
  }

  // 抽屉里的课程行：一行一卡 + 左侧课程色条，颜色查我们自己的色表（与 feedback 行同一份），
  // 色条是否出现由设置里 "Course colour bar" 那个开关统一管
  // 并在课程右下角添加三个可点击的快捷跳转图标（Modules / Assignments / Grades）
  function dressTrayCourses() {
    const tray = document.getElementById('nav-tray-portal');
    if (!tray) return;
    // Assignments / Grades 两颗直接用 Canvas 自家的 InstUI 图标字形（MIT 授权），
    // 与 dashboard 卡片底部那排同源。它们是 evenodd 实心路径，只能 fill 不能 stroke，
    // 描边会把实心字形描成双框（上一版那两颗就是这么糊的）。
    const ICON_ASSIGNMENT = 'M1468.214 0v564.698h-112.94V112.94H112.94v1694.092h1242.334v-225.879h112.94v338.819H0V0h1468.214Zm129.428 581.311c22.137-22.136 57.825-22.136 79.962 0l225.879 225.879c22.023 22.023 22.023 57.712 0 79.848l-677.638 677.637c-10.616 10.504-24.96 16.49-39.98 16.49h-225.88c-31.17 0-56.469-25.299-56.469-56.47v-225.88c0-15.02 5.986-29.364 16.49-39.867Zm-155.291 314.988-425.895 425.895v146.031h146.03l425.895-425.895-146.03-146.03Zm-764.714 346.047v112.94H338.82v-112.94h338.818Zm225.88-225.88v112.94H338.818v-112.94h564.697Zm734.106-315.44-115.424 115.425 146.03 146.03 115.425-115.423-146.031-146.031ZM1129.395 338.83v451.758H338.82V338.83h790.576Zm-112.94 112.94H451.759v225.878h564.698V451.77Z';
    const ICON_GRADEBOOK = 'M1801.441 0v1920H219.03v-439.216h-56.514c-31.196 0-56.515-25.299-56.515-56.47 0-31.172 25.319-56.47 56.515-56.47h56.514V1029.02h-56.514c-31.196 0-56.515-25.3-56.515-56.471 0-31.172 25.319-56.47 56.515-56.47h56.514V577.254h-56.514c-31.196 0-56.515-25.299-56.515-56.47 0-31.172 25.319-56.471 56.515-56.471h56.514V0h1582.412Zm-113.03 112.941H332.06v351.373h56.515c31.196 0 56.514 25.299 56.514 56.47 0 31.172-25.318 56.47-56.514 56.47H332.06v338.824h56.515c31.196 0 56.514 25.3 56.514 56.471 0 31.172-25.318 56.47-56.514 56.47H332.06v338.824h56.515c31.196 0 56.514 25.299 56.514 56.47 0 31.172-25.318 56.471-56.514 56.471H332.06v326.275h1356.353V112.94Zm-508.803 225.883v112.94H671.373v677.648h677.647V734.118h112.94v508.235H558.432v-903.53h621.177Zm207.326 75.817 79.85 79.85-432.452 432.451-224.866-224.979 79.85-79.85 145.016 145.13 352.602-352.602Z';
    // History 与 Help 两个抽屉都共用 #nav-tray-portal 和同一套 ListItem 结构：
    // History 的行是"最近看过的资源"，Help 面板里的资源卡 href 也带 /courses/号（学校把指南挂在课程里），
    // 两者都不是课程行，右下角那三颗课程快捷图标对它们没意义
    const isHistoryTray = /recent history/i.test(tray.textContent);
    const isHelpTray = /other resources/i.test(tray.textContent);
    [...tray.querySelectorAll('li[data-cid="ListItem"]')].forEach(li => {
      if (isHelpTray) return;
      const link = li.querySelector('a[data-cid="Link"]');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/courses\/(\d+)/);
      const courseId = m ? m[1] : '';
      // Groups 抽屉与课程抽屉同构（li[data-cid=ListItem] > a[data-cid=Link]），行是 /groups/<号>，
      // 没有课程色可查，所以和 History 那些不指向课程的行一样走通用卡（色条/描边吃主题强调一档）。
      // 那颗 "All Groups" 的 href 是光秃秃的 /groups，不进这一档，由上面 dressDrawerAllCourses 刷成按钮
      const isGroup = /\/groups\/\d+/.test(href);
      // History 里也有不指向课程的行（外部工具、个人文件），没有课程色可查，做成卡后由
      // .bc-tray-generic 那条规则补色；课程抽屉只列课程，不在那里放宽筛子
      const generic = !courseId;
      if (generic && !isHistoryTray && !isGroup) return;
      li.classList.add('bc-tray-course');
      li.classList.toggle('bc-tray-generic', generic);
      const color = generic ? '' : getCourseColor(courseId, '');
      
      // 只在值真的变了时才写：行内样式重写会再触发观察器，无条件写就成了空转死循环
      if (color && li.dataset.trayColor !== color) {
        li.dataset.trayColor = color;
        li.style.setProperty('--course-color', color);
      }

      if (isHistoryTray || !courseId) return;

      // 添加快捷跳转图标容器（在卡片内容里）
      let iconContainer = li.querySelector('.bc-course-icons');
      if (!iconContainer) {
        iconContainer = document.createElement('div');
        iconContainer.className = 'bc-course-icons';
        
        if (courseId) {
          iconContainer.innerHTML = `
            <button class="bc-icon-module" type="button" aria-label="Modules">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5.4 2.6h13.2v18.8H5.4zM8.4 7.6h7.2M8.4 12h7.2M8.4 16.4h4.4"/>
              </svg>
            </button>
            <button class="bc-icon-assignment" type="button" aria-label="Assignments">
              <svg viewBox="0 0 1920 1920" aria-hidden="true">
                <path fill-rule="evenodd" d="${ICON_ASSIGNMENT}"/>
              </svg>
            </button>
            <button class="bc-icon-grade" type="button" aria-label="Grades">
              <svg viewBox="0 0 1920 1920" aria-hidden="true">
                <path fill-rule="evenodd" d="${ICON_GRADEBOOK}"/>
              </svg>
            </button>
          `;
          li.appendChild(iconContainer);
          
          // 绑定点击事件
          iconContainer.querySelector('.bc-icon-module').addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.href = `/courses/${courseId}/modules`;
          });
          iconContainer.querySelector('.bc-icon-assignment').addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.href = `/courses/${courseId}/assignments`;
          });
          iconContainer.querySelector('.bc-icon-grade').addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.href = `/courses/${courseId}/grades`;
          });
        }
      }
    });
  }

  // ==================== 抽屉打开这一帧就把行补完（独立监听）====================
  // 课程 / History / Account 那块抽屉原来只有 mcUiPass 一条路：站点报变动先记帐、
  // 300 毫秒之后合并跑一趟，载入头 20 秒还要等 500 毫秒那一趟。我们的行卡给它加了
  // 上下各 10px 内边距＋9px 下外边距（见 style.css 里 li.bc-tray-course 那组），
  // 一整列因此比原生高出一截；不溢出的列表被补完之后才溢出＝滚动条在抽屉弹出来之后
  // 过 0.1～1 秒才冒头，这就是他报的那条。
  // 观察器回调是微任务，浏览器还没画这一帧，在这一趟里补完＝首帧就有滚动条。
  // 跟 Dashboard View 三点菜单那颗同一个办法（见 mcDashMenuSetupObserver）。
  // 不复用 body 上的 subtree 监听：那一条要把全站变动都过一遍，单独盯这棵子树更省。
  let mcTrayObserver = null;
  let mcTrayBound = null;

  function mcTrayDressNow() {
    mcStep('dressDrawerAllCourses', () => dressDrawerAllCourses());
    mcStep('dressTrayCourses', () => dressTrayCourses());
  }

  function mcTrayBind() {
    const tray = document.getElementById('nav-tray-portal');
    if (!tray || tray === mcTrayBound) return;
    if (mcTrayObserver) mcTrayObserver.disconnect();
    mcTrayBound = tray;
    mcTrayObserver = new MutationObserver(mcTrayDressNow);
    mcTrayObserver.observe(tray, { childList: true, subtree: true });
    // 绑上的这一刻先补一趟：刷新页面时抽屉可能已经是开着的
    mcTrayDressNow();
  }

  // 首趟和挂观察器分开罩：首趟抛错也不能让观察器挂不上，否则这一节整页再也不会补
  try { mcTrayBind(); } catch (e) { console.error('[BCX] 抽屉首趟补装失败', e); }
  try {
    // 门户本身也可能是点开才挂到 body 上的（React 会把整块摘掉再挂回来），
    // 所以盯 body 这一层的子节点增删（不扫子树，变动很少）
    new MutationObserver(() => mcTrayBind()).observe(document.body, { childList: true });
  } catch (e) { console.error('[BCX] 抽屉门户观察器挂不上', e); }

  // ==================== jQuery UI 那座弹窗关闭那一下的淡出 ====================
  // [实测 2026-10-07 连接器，日历页 #create_new_event_link 开→点 ×] 这一族只有"进"有动画：
  // 开的时候面板挂我们的 mcDialogIn、遮罩挂 mcOverlayIn；点 × 那一刻量到的是
  // 面板一笔行内 display:none（opacity 全程 1、getAnimations() 空），遮罩被站点整个摘掉。
  // 也就是"正在消失"这一帧根本不存在，CSS 接不上，所以两条通路各补一次，时长和曲线跟开那一头一字不差：
  //   ① 面板：不克隆。它是 jQuery 复用的常驻节点，克隆会造出重复 id（我们和站点都有按 id 找它的代码）。
  //      改成在观察器这一帧（微任务，还没画）把 display 放回来、把透明度收到 0，收完原样交还站点那一笔行内样式。
  //      站点若在淡的中间又把它打开，观察器会看见一次不是我们写的变动＝立刻收手，把这三条行内属性摘掉。
  //   ② 遮罩：站点是摘节点的，只能补一份影子淡出。判据只有一条——节点离开文档那一刻算出来的透明度
  //      还是满的才补，已经淡下去的（InstUI 那座确认弹窗自己会淡）不补第二遍。
  (function mcDialogCloseFade() {
    const MS = 240;
    const CURVE = 'cubic-bezier(0.16, 1, 0.3, 1)';
    // 我们自己摘掉的那些节点会在观察器里再报一趟，得认得出来，不然淡完又淡一遍
    const mcRemovedFading = new WeakSet();

    // 我们和站点改的是同一颗行内 style，观察器分不出是谁改的，所以拿"最后一次看到的字符串"当凭据：
    // 自己写完就把它记下来，下一趟读到的还是这一串＝是我们自己，直接过
    function write(node, fn) { fn(); node.__bcxSig = node.getAttribute('style'); }

    function stopFade(node) {
      const st = node.__bcxFading;
      if (!st) return;
      node.__bcxFading = null;
      clearTimeout(st.timer);
      write(node, () => {
        node.style.removeProperty('opacity');
        node.style.removeProperty('transition');
        node.style.removeProperty('pointer-events');
        node.style.removeProperty('animation');
      });
    }

    function startFade(node) {
      stopFade(node);
      const before = node.getAttribute('style') || '';
      const st = { timer: 0 };
      node.__bcxFading = st;
      // animation 那条必须一起按掉：面板回到渲染树会把我们给它补的进入动画再播一遍，
      // 而"正在跑的动画"在层叠里压过普通行内声明，淡出的 opacity:0 会被它盖住＝关闭变成再弹一次
      write(node, () => {
        node.style.removeProperty('display');
        node.style.setProperty('pointer-events', 'none');
        node.style.setProperty('animation', 'none', 'important');
        node.style.setProperty('opacity', '1');
        node.style.setProperty('transition', 'opacity ' + MS + 'ms ' + CURVE);
      });
      // 起点那一笔要先进一次层叠，不然同一趟里改成 0 就是"同一个值"＝不播。
      // 用一次强制回流而不是 requestAnimationFrame：后台标签页里 rAF 不跑，
      // 而收尾那笔定时器原来挂在 rAF 里面，那样弹窗会被我们一直钉在画面上
      node.getBoundingClientRect();
      write(node, () => node.style.setProperty('opacity', '0'));
      st.timer = setTimeout(() => {
        if (node.__bcxFading !== st) return;
        node.__bcxFading = null;
        write(node, () => node.setAttribute('style', before));
      }, MS + 40);
    }

    function bindDialog(node) {
      if (node.__bcxDlgBound) return;
      node.__bcxDlgBound = true;
      node.__bcxSig = node.getAttribute('style');
      let open = node.style.display !== 'none';
      new MutationObserver(() => {
        const sig = node.getAttribute('style');
        if (sig === node.__bcxSig) return;
        node.__bcxSig = sig;
        if (node.style.display !== 'none') {
          if (node.__bcxFading) stopFade(node);
          open = true;
          return;
        }
        if (!open) return;
        open = false;
        startFade(node);
      }).observe(node, { attributes: true, attributeFilter: ['style'] });
    }

    // 第二类消失：节点被整个摘出文档（jQuery 的遮罩、InstUI 的浮层、TinyMCE 那座对话框）。
    // 不克隆——克隆会丢输入框里的值（色板那四格 R／G／B／# 会先空一下）还会造出重复 id。
    // 改成把站点刚摘掉的那一颗自己钉回 body 上，淡完再真的摘走。
    // 三样都是 position:fixed，换爹不掉画面；原来的爹可能同一批一起被摘，所以不往回插。
    function fadeRemoved(node) {
      if (mcRemovedFading.has(node)) return;
      // 面板那一头正在用 display:none 那条路淡，别两头一起上
      if (node.__bcxFading) return;
      if (parseFloat(getComputedStyle(node).opacity || '1') < 0.9) return;
      mcRemovedFading.add(node);
      write(node, () => {
        node.style.setProperty('pointer-events', 'none');
        // 进入动画要按掉：回到渲染树会重播一遍，而"正在播的动画"压得住下面那笔 opacity:0
        node.style.setProperty('animation', 'none', 'important');
        node.style.setProperty('opacity', '1');
        node.style.setProperty('transition', 'opacity ' + MS + 'ms ' + CURVE);
      });
      document.body.appendChild(node);
      if (node.getBoundingClientRect().width < 2) {
        // 站点摘掉之前先把行内宽高压成 0px（实测 jQuery 的遮罩 width:0px; height:0px），得自己铺满
        write(node, () => {
          node.style.setProperty('position', 'fixed', 'important');
          node.style.setProperty('inset', '0', 'important');
          node.style.setProperty('width', 'auto', 'important');
          node.style.setProperty('height', 'auto', 'important');
        });
      }
      node.getBoundingClientRect();
      write(node, () => node.style.setProperty('opacity', '0'));
      setTimeout(() => {
        node.remove();
        write(node, () => {
          node.style.removeProperty('opacity');
          node.style.removeProperty('transition');
          node.style.removeProperty('pointer-events');
          node.style.removeProperty('animation');
          node.style.removeProperty('position');
          node.style.removeProperty('inset');
          node.style.removeProperty('width');
          node.style.removeProperty('height');
        });
      }, MS + 40);
    }

    // TinyMCE 那座（色板／插入链接那一类）不在 body 底下，插在建编辑器那个坑里，
    // 所以 body 那一颗观察器看不到它：见到一颗就把它的爹盯上，等它被摘的那一趟
    function bindWrapWatch(parent) {
      if (parent.__bcxWrapBound) return;
      parent.__bcxWrapBound = true;
      new MutationObserver((ms) => {
        const wrap = parent.__bcxWrap;
        if (!wrap) return;
        for (const m of ms) {
          for (const n of m.removedNodes) {
            if (n !== wrap) continue;
            parent.__bcxWrap = null;
            fadeRemoved(wrap);
            return;
          }
        }
      }).observe(parent, { childList: true });
    }

    function sweepWraps() {
      document.querySelectorAll('.tox-dialog-wrap').forEach((wrap) => {
        // 这座有两种收法，都接：摘节点走 fadeRemoved，写 display:none 走 bindDialog 那一条
        bindDialog(wrap);
        const parent = wrap.parentElement;
        if (!parent) return;
        parent.__bcxWrap = wrap;
        bindWrapWatch(parent);
      });
    }

    function sweep() {
      document.querySelectorAll('.ui-dialog').forEach(bindDialog);
      sweepWraps();
    }

    // 弹窗开着的这几秒里盯住它：变动观察器只认已经挂上的那颗，所以开的一瞬间要先进一趟
    setInterval(sweepWraps, 400);
    sweep();

    new MutationObserver((ms) => {
      sweep();
      ms.forEach((m) => {
        m.removedNodes.forEach((n) => {
          if (n.nodeType === 1 && n.matches && n.matches('.ui-widget-overlay, span[class*="-mask"]')) fadeRemoved(n);
        });
      });
    }).observe(document.body, { childList: true });
  })();

  // ==================== 铃那颗的提醒面板：右边缘跟工具栏对齐 ====================
  // [实测 2026-10-06，真点一次铃之后逐颗读矩形] 面板自然停在右边缘 925.3，
  // 而工具栏那条的右边缘是 953.3＝差 28 像素。
  // 落点只加在外壳 span[class$="-contextView"] 那颗：它是 position:absolute，
  // 动它＝整块浮层平移，不碰文档流（实测挪完 scrollWidth 1701 ＜ 视口 1707，没撑出横向滚动）。
  // ★ 里面那颗 contextView__content 是 position:relative、在文档流里，
  //   上一版往它身上加位移＝把整页撑爆，永远不要动它。
  // ★ 差值从"工具栏右边缘 − 铃那颗右边缘"算，不去量面板自己：面板的自然右边缘就是铃的右边缘
  //   （实测两颗都是 925.3），而面板刚挂载那一帧 InstUI 还没把它摆好，量它必然慢一帧
  //   ＝他报的"刚打开的一瞬间错位"。观察器回调是微任务，浏览器还没画这一帧，这里写进去当帧就对。
  const mcOppShiftDone = new WeakSet();

  function mcOppShiftMeasure(wrap, plate) {
    // 这一排四颗里只有铃那颗既没 id 也没 data-testid
    // （前三颗实测是 #planner-today-btn / [data-testid=add-to-do-button] / [data-testid=show-my-grades-button]）
    const buttons = [...plate.querySelectorAll('button')];
    const bell = buttons.find(b => !b.id && !b.getAttribute('data-testid')) || buttons[3];
    if (!bell) return;
    const d = Math.round(plate.getBoundingClientRect().right - bell.getBoundingClientRect().right);
    if (Math.abs(d) > 240) return;
    wrap.style.setProperty('--mc-opp-shift', d + 'px');
  }

  function mcAlignOpportunities() {
    const panel = document.getElementById('opportunities_parent');
    if (!panel) return;
    const shell = panel.closest('[class*="contextView__content"]');
    const wrap = shell && shell.closest('[class$="-contextView"]');
    if (!wrap || mcOppShiftDone.has(wrap)) return;
    const plate = document.querySelector('.ic-Dashboard-header__actions .PlannerHeader-styles__root');
    if (!plate) return;
    mcOppShiftDone.add(wrap);
    mcOppShiftMeasure(wrap, plate);
  }

  try {
    // 面板每次点铃才挂上来，所以盯 body 这一层的子节点增删（不扫子树）；
    // 量过的那颗壳记在 WeakSet 里，之后每次变动只剩一次 getElementById
    new MutationObserver(() => mcStep('alignOpportunities', mcAlignOpportunities))
      .observe(document.body, { childList: true });
  } catch (e) { console.error('[BCX] 提醒面板对齐观察器挂不上', e); }

  // 点 NEW ACTIVITY 会带走整条工具栏：那是 Canvas 自己的 planner 收尾逻辑抛错，
  // 补丁在 planner-guard.js（manifest 里以 "world": "MAIN" 注册，页面 CSP 挡不到它）。
  // 挂上没有看 <html data-mcx-nai>：seeking／on／seek-err-…／patch-err-…／no-method。

  // 日历页的日期弹层（jQuery UI datepicker，挂在 body 上）：
  // 原生上/下月箭头是图标字体字符，在这套主题下渲染成一条细线，换成内联 SVG 折角；
  // 弹层和工具条的样式都在 style.css 的日历一节里，这里只补 DOM 换不掉的东西
  function dressCalendarDatepicker() {
    const dp = document.getElementById('ui-datepicker-div');
    if (!dp) return;
    dp.querySelectorAll('a.ui-datepicker-prev, a.ui-datepicker-next').forEach(a => {
      if (a.querySelector('svg')) return;
      const d = a.classList.contains('ui-datepicker-next') ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6';
      a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    });
  }

  // 日历工具条的 Week/Month/Agenda：给它们共同的父层打个类，
  // CSS 认这个类把三颗收进一条灰底分段栏；认不到三兄弟就不打，避免误伤别的容器
  // 日历工具条三件事（每帧重做，Canvas 重渲染后文本会还原）：
  // 1) 给 Week/Month/Agenda 的父层打 bc-cal-views（分段栏 + "这是日历页"的判据）
  // 2) Today 按钮文字改成自解释的 "Jump to Today"（原生只写 Today，新用户看不懂）
  // 3) 左右翻页原生是 ← → 直线箭头（中间那横杠不好看），换成朝左/朝右的 SVG 折角（chevron）
  function dressCalendarToolbar() {
    // 这两张表必须待在函数体里。它们原先声明在函数外、却排在文件开头那次
    // dressCalendarToolbar() 调用之后，const 在那一刻还没初始化：
    // 只要 Canvas 的 Today 按钮在那次调用时已经画出来，读它们就抛 ReferenceError，
    // 整个 IIFE 当场中止，后面的 500ms 轮询、DOM 变动监听、待办面板挂载全都跑不上
    const ARROW_PATHS = {
      'Previous Month': 'M14.5 6.5L9 12l5.5 5.5',
      'Next Month': 'M9.5 6.5L15 12l-5.5 5.5'
    };
    // Canvas 那两颗翻页按钮的稳定类名，跟我们已经用的 navigate_today 同一族。
    // 之前只按可访问名认，结果漏了它们：名字是 aria-labelledby 从别的节点算出来的，
    // aria-label、title、textContent 三条都取不到值
    const ARROW_CLASSES = { navigate_prev: 'Previous Month', navigate_next: 'Next Month' };

    const today = document.querySelector('button.navigate_today');
    if (!today) return;
    if (today.textContent.trim() === 'Today') today.textContent = 'Jump to Today';

    const week = document.querySelector('button#week');
    const bar = week && week.parentElement;
    if (bar && bar.querySelector('#month') && bar.querySelector('#agenda')) bar.classList.add('bc-cal-views');

    const tagArrow = (el, label) => {
      const path = ARROW_PATHS[label];
      if (!path || el.dataset.bcArrow) return;
      el.dataset.bcArrow = '1';
      el.classList.add('bc-cal-arrow');
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    };
    for (const cls of Object.keys(ARROW_CLASSES)) {
      for (const el of document.querySelectorAll('button.' + cls + ', a.' + cls)) tagArrow(el, ARROW_CLASSES[cls]);
    }
    // 别的页面（作业编辑器那条日期条）那两颗没有 navigate_* 类，仍按可访问名兜底
    for (const el of document.querySelectorAll('button, a')) {
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      if (ARROW_PATHS[name]) tagArrow(el, name);
    }
  }

  // 日历侧栏里的"孤身"超链接（顶部学校系统日历、底部 Calendar Feed 等）改成胶囊按钮：
  // 学校名会变，文字不能当判据；认结构——侧栏容器里不挂在 ul/ol/table 中、且有文字的独立 a。
  // 课程色点那些行链接都在列表里，天然被排除。加类后由 CSS 套 View Grades 那颗的同一条规则
  function dressCalendarSidebarLinks() {
    const side = document.getElementById('sidebar_content') || document.getElementById('right-side');
    if (!side || !document.getElementById('minical')) return; // #minical 是日历侧栏的稳定锚点
    // 【[BCP79]】底部那颗 "Calendar Feed" 不是 <a>，是 <button class="Button Button--link">
    // （170x39、radius 3px、0.667px 描边），上一版只收 a 所以它一直没被收进胶囊那条规则。
    // 这一版一起收。侧栏里"孤身"的可点元素目前就三颗：两颗 a ＋ 这颗 button，不会误伤
    [...side.querySelectorAll('a, button')].forEach(a => {
      if (a.closest('ul, ol, table')) return;
      if (!a.textContent.trim()) return;
      a.classList.add('bc-cal-side-link');
    });
  }

  /* [MCX calendar loading] 日历的服务慢，事件回包之前主日历是一整块空的奶油色，看着像页面坏了。
     判据只用看得见的东西：视图已经画出来、里面还一颗事件条都没有＝还在等回包。
     事件一到就收；等了 12 秒还是空的，说明这个月本来就没东西，也收——不能让圈一直转。
     250 毫秒以内不出圈，免得网络快的时候只是抖一下（和待办那批加载态同一口径）。
     这里只翻 html 上的一颗类名，圈本身是 CSS 画的（theme-calendar.css 最后一节）：
     不往 Canvas 那棵 React 树里塞节点，塞进去会被我们自己的变动监听反复触发。
     换月／换视图要重新起算，认的是看得见的两样：顶部那个月份标题（.navigation_title_text，
     翻月必变）和第一格的 data-date，外加视图节点本身被换掉（切 Week/Month/Agenda）。
     [探针 2026-10-06] 这两个读数在真页上量过：标题 "March 2024"、第一格 data-date="2024-02-25"。
     不认"网格里有变动"：渲染变动比 250 毫秒的地板还密时，起算点会被一直往后推，圈永远凑不满；
     也不认"事件从有变没"：他在右侧取消勾选某本日历也会瞬间清空网格，那不是在等回包 */
  var MC_CAL_SPIN_MIN_MS = 250;
  var MC_CAL_SPIN_MAX_MS = 12000;
  var mcCalSpinView = null;
  var mcCalSpinKey = '';
  var mcCalSpinSince = 0;
  var mcCalSpinSettled = false;
  var mcCalSpinTimer = null;
  function mcCalendarLoading() {
    const root = document.documentElement;
    // 三种视图的类名照 BC 那份选择器清单点名（清单里就这三档，不赌 fullcalendar 的通用类）
    const view = document.querySelector('#calendar-app :is(.fc-month-view, .fc-agendaWeek-view, .fc-agendaDay-view)');
    // 加载圈以前由设置里那颗 Loading spinner 管，那颗已经删掉＝常开
    if (!view) {
      root.classList.remove('mc-cal-loading');
      return;
    }
    const title = document.querySelector('.navigation_title_text');
    const firstDay = view.querySelector('.fc-day');
    const key = (title ? title.textContent.trim() : '') + '|' +
      (firstDay ? (firstDay.getAttribute('data-date') || '') : '');
    if (view !== mcCalSpinView || key !== mcCalSpinKey) {
      mcCalSpinView = view;
      mcCalSpinKey = key;
      mcCalSpinSince = performance.now();
      mcCalSpinSettled = false;
    }
    const hasEvents = !!view.querySelector('.fc-event');
    const calApp = document.getElementById('calendar-app');
    if (calApp) calApp.classList.toggle('mc-cal-has-today', !!view.querySelector('.fc-today.fc-day'));
    // 这一轮回过一次事件就不再当"在等回包"：他在右侧取消勾选某本日历会把网格瞬间清空，
    // 那不是在加载，不该转圈（假页量到的误报）。换月／换视图会把这一条翻回去重新算
    if (hasEvents) mcCalSpinSettled = true;
    const waited = performance.now() - mcCalSpinSince;
    const busy = !hasEvents && !mcCalSpinSettled &&
      waited >= MC_CAL_SPIN_MIN_MS && waited <= MC_CAL_SPIN_MAX_MS;
    root.classList.toggle('mc-cal-loading', busy);
    /* 只要还在这一轮的空窗里就一直自己追一枪（150 毫秒），到点才翻得动牌子：
       面板开着时不要追枪，避免与面板抢主线程 */
    if (!hasEvents && !mcCalSpinSettled && waited <= MC_CAL_SPIN_MAX_MS && !mcCalSpinTimer && !mcSettingsPanelOpen()) {
      mcCalSpinTimer = setTimeout(() => { mcCalSpinTimer = null; mcCalendarLoading(); }, 150);
    }
  }

  // Account 那行那颗"人头"其实是 Canvas 的用户头像 <img>（[BCP63]：容器里是 div.fs-exclude + img + 徽标 + 文字层）。
  // 它被压成竖椭圆是我们的锅：图标槽位锁把装着它的容器钉成 22px 宽，头像跟着缩。
  // 上一版整颗隐掉是错的（隐完头像就没地方看了）。这版不隐，只打一个类，交给 CSS 把头像挪到行末、恢复成正圆。
  function markAccountNavAvatar() {
    document.querySelectorAll('.ic-app-header__menu-list-link').forEach(row => {
      const label = row.querySelector('.menu-item__text');
      if (!label || !/^account$/i.test(label.textContent.trim())) return;
      // 只点名这一行自己的那一层容器和那颗头像。Account 展开后的子菜单（Profile / Settings / Logout）
      // 也在这棵子里面，规则写宽了会连子菜单里的图标一起变成 26px 圆（Logout 那颗就是这么圆的）。
      // querySelector 取文档序第一个，子菜单的容器排在后面，所以拿到的就是这一行自己的
      const box = row.querySelector('.menu-item-icon-container');
      const img = box && box.querySelector('img');
      if (!box || !img) return;
      // 头像可能包在一层壳里（[BCP63] 量到容器里第一层是 div.fs-exclude），
      // order 只在同一层 flex 里成立，所以要给"容器直属的那一层"打标记，不是给 img 本身
      let slot = img;
      while (slot.parentElement && slot.parentElement !== box) slot = slot.parentElement;
      box.classList.add('mc-nav-avatar-box');
      slot.classList.add('mc-nav-avatar-slot');
      img.classList.add('mc-nav-avatar');
    });
  }

  // 站点报变动只记账，300 毫秒合并跑一趟（这一串的定义在面板挂载那一节，理由也写在那儿）
  // 答题屏（MCX_QUIET_PAGE）不挂这颗：它的活全在侧栏/首页卡，这一屏用不上，留着只会跟引擎抢重排
  const observer = new MutationObserver(mcScheduleUiPass);
  if (!MCX_QUIET_PAGE) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    /* 但答题那一屏不是"什么都不用管"：那颗开关属性、把它的侧栏挪走、钉住我们这一列，
       以前全挂在 2 秒取色轮询和整页观察器上，这两条在 /taking/ 都不挂，
       所以他一打开答题页侧栏就变成 BC 那一套，而且停在屏上不会自己回来。
       这里只补一条很窄的：盯 <head> 的表、#header 的子节点、和那颗开关属性本身，
       回调只做"把导航摆回对的一边"这三件事，400 毫秒一道闸。
       答题引擎要躲的那些重活（每 500ms 的 UI 巡检、每 2 秒的整页取色）一样都不给它加 */
    try {
      const bcObs = new MutationObserver((muts) => { if (bcxTouchBcChrome(muts)) bcxOnBcChrome(); });
      bcObs.observe(document.head, { childList: true });
      bcObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bc-nav-restore'] });
      const hdr = document.getElementById('header');
      bcObs.observe(hdr || document.body, { childList: true });
      // 它可能比这条观察器还早就插好了：先补一次，再在它挂载那几秒里各补一次
      bcxOnBcChrome();
      setTimeout(() => { mcChromeAt = 0; bcxOnBcChrome(); }, 1500);
      setTimeout(() => { mcChromeAt = 0; bcxOnBcChrome(); }, 4000);
    } catch (e) { console.log('[BCX] 答题页那条窄观察器没挂上：', e && e.message); }
  }
  mcStep('markAccountNavAvatar', () => markAccountNavAvatar());

  /* 【2026-10-11 这一条加过又撤了，字留在这里给下一轮】
     加过的是：一条常开的 <head> 观察器，专叫 mcKeepThemeSheetLast()（摁住它那张主题表
     ＋把我们那张表挪到最后），理由是那一趟的两个触发源都在 <body>，而它把表插进 <head>。
     撤的原因＝加了以后他页面上"刷新就是它的色"照旧，没有任何一次读数证明它生效过。
     已经排除的方向（都有证据，别再重新发明）：
       1) 它首帧往页面那两层写行内——否证。读它包体 9.8.15 all.js @3259791 / @3411928，
          四处 style.setProperty("background-image", …, "important") 落点全是课程卡
          （article.course-element-card、collectCards() 那批），一处都不在 body / #application
       2) 我们自己在 body / #application 钉行内 !important——试过，把"只有非首页翻色"
          变成"每页都翻"，已撤，见上面 mcxPinPageLayers 那条批注
       3) 摁表摁得太勤把抄色的输入源掐掉、把没上漆的原生色写进存档——这条是真的，
          已经用下面 mcThemeSheetPainting 那道门槛堵住，不撤 */

  // 它换主题只是改 :root 上的变量，不一定产生子节点变动，所以再挂一条常开的慢轮询
  // 答题屏不挂：每 2 秒一趟 applyModernPalette 带强制取色，跟引擎重排对抢；开机已刷过一次
  if (!MCX_QUIET_PAGE) {
    setInterval(() => {
      if (mcSettingsPanelOpen()) return;
      mcStep('applyModernPalette', () => applyModernPalette());
    }, 2000);
  }
  // 分数药丸是往 Canvas 自己那棵 React 树里塞节点，挂在 DOM 变动监听上会和它的
  // 重渲染互相触发（表现就是首页一直转圈）。所以只走慢轮询
  // [实测 2026-10-06 收件箱页读数] 这一趟四颗函数查的全是首页卡片的选择器，
  // 可它在每一页都白跑（读数里非首页也一直见 mcCardTasks +4次）。
  // 不能整条按地址关掉：从别处点进首页是不刷新的，那样卡片就没有 Tasks 和排版。
  // 改成先花一次 querySelector 问"这页有没有卡片"，没有就直接返回。
  if (!MCX_QUIET_PAGE) {
    setInterval(() => {
      if (mcSettingsPanelOpen()) return;
      if (!document.querySelector('.ic-DashboardCard, [data-testid^="course-grade-card"]')) return;
      mcStep('modernGradePills', () => modernGradePills());
      // 先摆内容再量高度：那块 Tasks 是这一趟才长出来的，排在它前面量就等于按矮卡定格子，
      // 下面那一张当场叠上来（他截图里每一列第一张被第二张压住那行字，就是这么来的）
      mcStep('mcCardTasks', () => mcCardTasks());
      mcStep('mcMasonryLayout', () => mcMasonryLayout());
      mcStep('modernCardCoverLayer', () => modernCardCoverLayer());
    }, 1500);
  }
  mcStep('modernCardCoverLayer', () => modernCardCoverLayer());
  mcStep('mcCardTasks', () => mcCardTasks());
  // 开局这一趟排版是必须的，不能等 1500 毫秒那一趟：theme-boot.js 那份 document_start 的早期
  // 排版里没有这块 Tasks（它排在 content.js 之前，读不到 Tasks 的判据），它按矮卡排好之后
  // 我们才把 Tasks 补上＝整面墙空着等下一次重排，就是"先摆好、突然多出 tasks、再重摆"那一下
  mcStep('mcMasonryLayout', () => mcMasonryLayout());
  /* 卡片比 content.js 晚到怎么办：文档级再挂一条早观察器，卡片一诞生就补 Tasks 并重排。
     这一趟是同步跑的，不走 rAF 那条合并路：rAF 落在下一帧，那一帧已经把"没有 Tasks 的矮卡"
     画到屏幕上了，16 毫秒后整面墙再往下挪一次＝他报的那一下重摆。挂上每面墙自己的观察器
     （mcMasonryWatch）之后这条立刻断开，不给首页那棵一直变的 React 树长期加活 */
  if ((() => { const p = window.location.pathname; return p === '/' || p.includes('/dashboard') || !p.includes('/'); })()) {
    try {
      const mcWallEarly = new MutationObserver(() => {
        const field = document.querySelector('.ic-DashboardCard__box__container');
        if (!field || !field.querySelector('.ic-DashboardCard')) return;
        if (!mcWallSeen || mcWallSeen.has(field)) { mcWallEarly.disconnect(); return; }
        mcStep('mcMasonryLayout', () => mcMasonryLayout());
      });
      mcWallEarly.observe(document.documentElement, { childList: true, subtree: true });
      // 万一这一页压根没有卡片墙（他停在别的首页样式上），8 秒后自己收
      setTimeout(() => mcWallEarly.disconnect(), 8000);
    } catch (e) {}
  }
  // 答题屏（MCX_QUIET_PAGE）不挂这颗：mcMasonryLayout 没早退，每被 resize 点一次就
  // mcMasonryWatch＋mcCardTasks＋查一遍卡片容器，这一屏压根没有卡片墙＝拖一次窗口白跑几十趟＝缩放巨卡
  if (!MCX_QUIET_PAGE) {
    window.addEventListener('resize', () => mcStep('mcMasonryLayout', () => mcMasonryLayout()));
  }
  mcStep('mcLoadGrades', () => mcLoadGrades());
  setInterval(() => mcStep('mcLoadGrades', () => mcLoadGrades()), 300000);
  setInterval(() => mcStep('dressLtiIframeCard', () => dressLtiIframeCard()), 1500);
  setInterval(() => mcStep('dressIframeScrollbars', () => dressIframeScrollbars()), 2000);
  mcStep('dressIframeScrollbars', () => dressIframeScrollbars());

  // settings.js 是另一个文件，看不到这个闭包里的东西，所以把设置面板要用的这几个名字交出去。
  // 那边没读到 window.mcHost 就整个不接管，点开还是这座老弹窗。
  window.mcHost = {
    step: mcStep,
    MODERN_SETTINGS: MODERN_SETTINGS,
    ctsMeta: ctsMeta,
    ctsMenuHtml: ctsMenuHtml,
    modernSetting: modernSetting,
    applyLogoSettings: applyLogoSettings,
    applyModernPalette: applyModernPalette,
    modernGradePills: modernGradePills,
    mountSidebarCourses: mountSidebarCourses,
    hideBcTodo: hideBcTodo,
    updatePanelDom: updatePanelDom,
    fetchPlannerData: fetchPlannerData,
    isFetching: () => modernIsFetching,
    mcMasonryLayout: mcMasonryLayout,
    mcQueueMasonryLayout: mcWallQueue,
    mcReflowMasonryLayout: () => mcMasonryLayout(true),
    bcxMasonryLayout: mcMasonryLayout,
    /* AI 面板停靠那一档要收窄应用侧栏时借的就是站点自己这一颗：连那颗键的文案、
       两节列表的折叠、卡片墙的重排一起走。那边自己 toggle 类名会留下箭头指着假状态，
       所以这一颗要交出去，同一份机制只留一个入口 */
    setNavMinimized: setNavMinimized,
    // 课程卡上那块 Tasks：设置里翻了总开关或条数要当场重搭，那边不自己算该摆哪几条
    mcCardTasks: mcCardTasks,
    // 右上角那条更新提示：面板开着的时候页面那趟轮询是停的，所以设置里翻了要当场叫一次
    mcUpdateHint: mcUpdateHint,
    mcSnapshot: mcSnapshot,
    // Focus 那张虚拟卡的封面：按主题配图那串顺序往后接一格
    mcCardArtAt: mcCardArtAt,
    mcApplyThemeJson: mcApplyThemeJson,
    // 拼样式表那一步：tests/theme-css-guard-test.js 要能直接喂一份脏 cards 给它
    mcThemeCss: mcThemeCss,
    // 设置里 Themes 那一屏自建的主题：先翻译成那份 JSON 再走上面同一条通路
    mcApplyCustomTheme: mcApplyCustomTheme,
    // "收进库"之后把这一格改指向那份副本（只换 code，色和图都不动）
    mcAdoptThemeRecord: mcAdoptThemeRecord,
    // 颜色档位（Canvas 那一档＋三格存档）：顶上那颗下拉、那颗"回到主题自带的色"都读这几条
    mcTier: mcTier,
    mcSetTier: mcSetTier,
    mcThemeOff: mcThemeOff,
    // 深浅色那颗开关的生效判据（设置里那行的按不动态和说明都读它）
    mcDarkOn: mcDarkOn,
    // 侧栏那一列行的自定义：草稿（现场那几行＋存过的顺序）、落盘、恢复默认。
    // 草稿要把 DOM 节点剥掉再交出去，那边只拿得到 {k,label,zone,on,hideable}
    mcNavDraft: () => mcNavDraft().map(r => ({ k: r.k, label: r.label, zone: r.zone, on: r.on,
      hideable: BCX_NAV_NO_HIDE.indexOf(r.k) === -1 })),
    mcNavSaved: mcNavLayout,
    mcNavSave: mcNavSave,
    mcNavReset: mcNavReset,
    // 抽屉里那列课程：现成的先后＋显示的名字＋有没有勾掉，和存这两份的通路
    mcNavCourseRows: mcNavCourseRows,
    mcNavCourseSave: mcNavCourseSave,
    /* 课程卡那三行：现成的课（Canvas 的 name／code／学期）＋已存的自定义、存单格、清整批、
       当场生效那一趟，和要不要把名字送进 Canvas 的那颗键。还有一件只有这边数得到的：
       现在还剩几行亮着——设置里靠它挡住"把最后一行也关掉" */
    mcCardCourseRows: mcCardCourseRows,
    mcCardTextSet: mcCardTextSet,
    mcCardTextClearAll: mcCardTextClearAll,
    mcCardTextApply: () => mcStep('mcCardTextApply', () => mcCardTextApply()),
    mcCardLinesLeft: mcCardLinesLeft,
    mcCardNameSyncOn: mcCardNameSyncOn,
    mcNicknameWrite: mcNicknameWrite,
    mcNicknameSyncAll: mcNicknameSyncAll,
    MC_CARD_NAME_MAX: MC_CARD_NAME_MAX,
    // 两边照明对不对得上：侧栏那句提示和设置里那句说明共用这一份判据，不各算一遍
    mcOurLighting: mcOurLighting,
    mcBcLighting: mcBcLighting,
    mcLightingClash: mcLightingClash,
    mcSaveInfo: mcSaveInfo,
    // 设置里 Colors 面板改色要用的这几条（改哪一档、当场预览、撤回去）
    mcThemeSlotRows: mcThemeSlotRows,
    mcSetSlotColor: mcSetSlotColor,
    mcSetSlotClear: mcSetSlotClear,
    // 每一档自己那根透明度滑杆（0 到 100，默认 100＝一行都不多写）。整站一颗，不跟着存档分格
    mcSlotAlpha: function (slot) {
      const cfg = BCX_ALPHA_SLOTS['--mc-' + slot];
      return cfg ? mcSlotAlpha(cfg) : 100;
    },
    mcSetSlotAlpha: function (slot, v) {
      const cfg = BCX_ALPHA_SLOTS['--mc-' + slot];
      if (!cfg) return null;
      const n = Math.max(0, Math.min(100, Number(v) || 0));
      localStorage.setItem(cfg.key, String(n));
      // 只重跑透明度那一趟（顺带把侧栏那颗胶囊和类名同步好），不跑整轮取色
      mcApplyAlphaPass(mcToRgb(String(mcTokenBase['--mc-background-1'] || '')) || null);
      return n;
    },
    // 上一轮算出来的那层磨砂底色（空＝没算）：设置顶上那块仿真照抄它，两边不会各算一份
    mcFrostCss: () => mcLastFrost,
    mcResetSlotColors: mcResetSlotColors,
    mcPreviewSlotColors: mcPreviewSlotColors,
    mcSlotHint: mcSlotHint,
    mcSlotFallbackNote: mcSlotFallbackNote,
    // BC 在不在跑：设置里 Theme 那一档的说明、那颗"打开 External Extension 设置"的键都读它
    bcxBcLive: () => document.documentElement.classList.contains('mc-bc-live'),
    mcHasRecordedBcTheme: mcHasRecordedBcTheme,
    // 两套主题正在抢同一层（它在跑、这一层也归我们刷）：设置里那颗"打开我们的主题墙"只在真抢起来时摆
    mcThemeClash: () => document.documentElement.classList.contains('mc-theme-clash'),
    // 页面那一层现在归谁（'bc' / 'mc'）：面板上那一行的当前档和它下面那句说明都读它。
    // 以前这里还往外露一颗 mcThemeLocked 让面板锁 Colors / Themes，那条已经跟着
    // "挑了就自动翻回我们"这条规矩撤掉了，不要再加回来
    mcPageThemeOwner: mcPageThemeOwner,
    mcThemeEdited: () => {
      const snap = mcSnapshot();
      return !!(snap && ((snap.edits && Object.keys(snap.edits).length)
        || Object.keys(snap.clearSlots || {}).length || snap.fontEdit));
    },
    mcInkOn: mcInkOn,
    mcFontName: mcFontName,
    mcFontLinks: mcFontLinks,
    mcFontFamily: mcFontFamily,
    // Theme Customizer 那一屏那一行字体：挑一份、回到自带的、读现在这两层分别是什么
    mcSetFont: mcSetFont,
    mcResetFont: mcResetFont,
    mcFontState: mcFontState,
    clickBcGear: clickBcGear,
    clickBcThemesTab: clickBcThemesTab,
    revealBcPanel: revealBcPanel,
    bcPopupOpen: bcPopupOpen,
    mcTickNoteHtml: mcTickNoteHtml,
    mcTickLog: mcTickLog,
    getInkFix: () => mcInkFix
  };
  window.bcxHost = window.mcHost;


})();

