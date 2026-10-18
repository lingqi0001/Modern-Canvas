/* =========================================================
   同源帧的主题预铺：把外层文档算好的那一层色，在首帧之前抄进帧里
   =========================================================
   症状：进提交详情那一屏时，中间那块作业内容先白一下才变成主题的色（他报的"刚进入短暂原版 UI"）。
   成因（实测 2026-10-05 /courses/298732/assignments/14226757/submissions/473100）：
     那一层是 Canvas 另开的同源页（IFRAME#preview_frame，src 带 ?preview=1）。
     帧自己的 first paint 在 700ms，而给帧刷色的是 content.js，那条挂的是 document_idle
     （帧的 domContentLoaded 804ms、load 1086ms）＝**帧画完了我们才到**，中间那一段就是原生色。
     顶层文档没有这个问题：theme-boot.js 是 document_start，首帧之前就把行内 --mc-* 写好了。
   为什么不把 theme-boot.js 整条开 all_frames：它里面十几段（下拉换皮、导航图标、Today 文案、
   各种门控类名）都是给最外层画的，灌进每一张帧＝连别人的界面一起改（同 theater.css 顶上那条理由）。
   也不重算一遍颜色：拆哪一档、黑还是白那套算法在 theme-boot.js 和 content.js 里已经必须逐字对齐两份，
   再加第三份就是第三次翻车点。这一份**只抄不算**：读外层 <html> 行内那些 --开头 的属性和
   已经注好的 #mc-theme-sheet 原文，原样贴进帧里，值必然一致，content.js 晚一步跑到时看到的也是同一套数。
   顶层文档第一行退出；父页跨源读不到也退出（读不到＝不动，不猜）。
   ========================================================= */
(function () {
  if (window.self === window.top) return;

  // [实测 2026-10-11 答题屏] 这一份把主题表也原样抄进了 TinyMCE 的写作帧：表头一条就是
  // body{background:…!important}，写作区整片被刷成主题底档（他报的"输入区还是那个色"），
  // 而且表里那批宽选择器让帧内每敲一个字都重算一遍文档样式＝打字卡的来源之一。
  // 写作纸永远不该跟主题走（同 preview-frame.css 对作业白纸拍的板）→ 这一棵帧整个不进。
  // 帧自己的 document 没有类名可认，认的是它在外面那棵树上的 iframe 元素：
  // 类 tox-edit-area__iframe 或 id 以 _ifr 结尾（submission_body_ifr、rceTextArea_<uuid>_ifr 都是）。
  // 交作业预览那一帧（#preview_frame，src 是同源页）两个判据都不中，防闪照旧。
  try {
    var fe = window.frameElement;
    if (fe && (String(fe.className || '').indexOf('tox-edit-area__iframe') >= 0 || /_ifr$/.test(String(fe.id || '')))) return;
  } catch (e) {}

  var root = document.documentElement;
  var isDocumentViewer = /(?:canvadocs|docviewer)/i.test(location.hostname + location.pathname);
  // PDF documents opt in through the toolbar switch. Other Canvas frames retain
  // their existing first-paint theme mirroring behaviour.
  var documentThemeAllowed = !isDocumentViewer;
  var mirroredProps = [];
  var parentDoc;
  try {
    parentDoc = window.parent.document;
  } catch (e) {
    return;
  }
  if (!parentDoc || !parentDoc.documentElement) return;
  if (parentDoc.documentElement.classList.contains('mc-paused')) return;
  // 必须外层父页面也是 Canvas (带有 mc-themed 或满足 Canvas 域名)，否则在其他网站的内嵌 iframe 中不执行
  if (!parentDoc.documentElement.classList.contains('mc-themed') &&
      !parentDoc.documentElement.classList.contains('mcx-canvas-active') &&
      !window.parent.mcIsCanvas) return;

  function mirror() {
    if (!documentThemeAllowed) return;
    var ph = parentDoc.documentElement;
    try {
      for (var i = 0; i < ph.style.length; i++) {
        var prop = ph.style[i];
        if (prop.indexOf('--') !== 0) continue;
        var val = ph.style.getPropertyValue(prop);
        if (val && root.style.getPropertyValue(prop) !== val) {
          root.style.setProperty(prop, val, ph.style.getPropertyPriority(prop));
          if (mirroredProps.indexOf(prop) === -1) mirroredProps.push(prop);
        }
      }
      if (ph.classList.contains('mc-themed')) root.classList.add('mc-themed');
      if (ph.classList.contains('mcx-canvas-active')) root.classList.add('mcx-canvas-active');
      if (ph.classList.contains('bc-colour-mode-dark')) root.classList.add('bc-colour-mode-dark');
      var sheet = parentDoc.getElementById('mc-theme-sheet');
      if (sheet && sheet.textContent) {
        var mine = document.getElementById('mc-theme-sheet');
        if (!mine) {
          mine = document.createElement('style');
          mine.id = 'mc-theme-sheet';
          (document.head || root).appendChild(mine);
        }
        if (mine.textContent !== sheet.textContent) mine.textContent = sheet.textContent;
      }
    } catch (e) {
      // 父页中途被换掉／导航走了：不动，等 content.js 那一轮照常刷
    }
  }

  function setDocumentTheme(enabled) {
    if (!isDocumentViewer) return;
    documentThemeAllowed = !!enabled;
    if (documentThemeAllowed) {
      mirror();
      return;
    }
    root.classList.remove('mc-themed', 'mcx-canvas-active', 'bc-colour-mode-dark');
    mirroredProps.forEach(function (prop) { root.style.removeProperty(prop); });
    mirroredProps = [];
    var sheet = document.getElementById('mc-theme-sheet');
    if (sheet) sheet.remove();
  }

  try {
    if (isDocumentViewer) {
      // Stored in extension storage so the canvadocs origin sees the same choice
      // as its Canvas parent; no entry means the requested default, off.
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['mc_lti_tint'], function (state) {
          setDocumentTheme(state && state.mc_lti_tint === '1');
        });
      }
      window.addEventListener('message', function (event) {
        if (event.data && event.data.type === 'CANVAS_DOCUMENT_THEME_CHANGED') {
          setDocumentTheme(!!event.data.enabled);
        }
      });
    } else {
      mirror();
    }
    new MutationObserver(mirror).observe(parentDoc.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class']
    });
  } catch (e) {
    console.error('[MCX] 帧内主题预铺失败', e);
  }
})();
