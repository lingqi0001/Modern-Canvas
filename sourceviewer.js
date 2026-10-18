/* 正文里那张照片的查看器：点一张老师上传的图，开一层带进退场动画的板，
   里面能放大缩小、转、下载、"Extract Text"抽字，也能一张一张翻过去。

   只管正文点位（作业说明、大纲、页面、题目、讨论、日历那 22 处）。Files 那一排缩略图、
   头像、课程封面都不归这里：它们要么是 CSS 背景（DOM 里根本没有 img），要么在另一张帧里。

   Canvas 自己的预览要让路：图片被 <a href=".../files/..."> 包住时那一颗点击本来就是它的
   showFilePreview 通路（它往 body 挂 #file_preview_container），我们一个键都不按。

   下载走 canvas-data.js 现成的 MCxData.fetchBytes（同源那一份 /download）；抽字走 MCxData.ocrUrl，
   只递 URL：取字节、解码、压长边都在 ocr-frame.html 那一页做，不在这里再养一帧 tesseract。
   为什么不在页面这一头解码：/files/…/preview 会重定向到文件集群，内容脚本的 fetch 被 CORS 挡，
   退成 <img> 画进画布又会被判污染（toDataURL 抛 Tainted canvases）。 */
(function () {
  'use strict';

  var KEY = 'mc_source_viewer';
  var MIN_SIDE = 48;      // 小于这一边的当行内图标（LTI 那颗 16px 的也是 img）
  var ZOOM_STEP = 1.25;
  var ZOOM_MIN = 0.25;
  var ZOOM_MAX = 8;
  var OCR_SIDE = 2000;    // 抽字前把长边压到这一档：和扫描页那条同一量级，别把 6000px 原图递进引擎
  var GAP_MS = 250;       // 整批下载每张之间歇这一点：全站那条 leaky-bucket 限流按人计数，连 hitting 会 429
  var ENTER_MS = 220;
  var LEAVE_MS = 200;
  var PANE_H = 220;

  var CSS = [
    /* 整块改成全屏磨砂：这一层就是那张糊掉的背景，糊的是页面本身（轻微一档）。
       底色吃 background-0 但往透明方向混：实色一铺就看不见身后糊掉的那一层了 */
    '.mcx-sv{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;',
    'background-color:color-mix(in srgb,var(--mc-background-0,#fff) 74%,transparent);color:var(--mc-text-0,#111);',
    '-webkit-backdrop-filter:blur(14px) saturate(1.3);backdrop-filter:blur(14px) saturate(1.3);',
    'opacity:0;transition:opacity ' + ENTER_MS + 'ms ease}',
    '.mcx-sv.mcx-sv-open{opacity:1}',
    '.mcx-sv.mcx-sv-out{opacity:0;transition-duration:' + LEAVE_MS + 'ms}',
    '.mcx-sv-plate{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;outline:none}',
    /* 工具栏是浮在顶部居中的一颗药丸，× 是右上角独立一颗小圆键。
       两颗都不铺满、都不是一整块大板，共用同一套进退场（淡入＋落下来 8px） */
    /* 层级钉死：图那一片带 transform 时会挤进"定位层"，不压住的话刚弹出来那不到 0.2 秒
       它会盖在工具栏与 × 上面（DOM 顺序在它后面），看着就是一闪 */
    '.mcx-sv-bar,.mcx-sv-x{position:absolute;top:14px;z-index:3;background-color:var(--mc-background-0,#fff);',
    '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 8px 24px rgba(0,0,0,.14);',
    'opacity:0;transition:opacity ' + ENTER_MS + 'ms ease,transform ' + ENTER_MS + 'ms cubic-bezier(.16,1,.3,1)}',
    '.mcx-sv-bar{left:50%;display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;',
    'max-width:calc(100vw - 132px);padding:6px 8px;border-radius:9999px;transform:translate(-50%,-8px)}',
    '.mcx-sv-x{right:16px;width:38px;height:38px;padding:0;transform:translateY(-8px)}',
    '.mcx-sv.mcx-sv-open .mcx-sv-bar{opacity:1;transform:translate(-50%,0)}',
    '.mcx-sv.mcx-sv-open .mcx-sv-x{opacity:1;transform:none}',
    '.mcx-sv-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;',
    'min-width:38px;height:38px;padding:0 12px;border:0;border-radius:12px;cursor:pointer;',
    'background-color:var(--mc-background-0,#fff);color:var(--mc-text-0,#111);',
    'font:400 14px/1 system-ui,-apple-system,"Segoe UI",Roboto,Lato,Arial,sans-serif;',
    'transition:background-color 150ms ease}',
    '.mcx-sv-btn:focus,.mcx-sv-btn:focus-visible{outline:none;box-shadow:none}',
    '.mcx-sv-btn:hover{background-color:var(--mc-tint-press,rgba(128,128,128,.16))}',
    '.mcx-sv-btn[disabled]{opacity:.45;cursor:default}',
    '.mcx-sv-btn[disabled]:hover{background-color:var(--mc-background-0,#fff)}',
    '.mcx-sv-btn.mcx-sv-on{background-color:var(--mc-tint-press,rgba(128,128,128,.2))}',
    /* 圆的那两颗必须排在这条后面：.mcx-sv-btn 与它们权重相同，写在前面会被 12px 那颗盖掉
       （× 之前看着像方块就是这条顺序错了） */
    '.mcx-sv-x{border-radius:50%}',
    '.mcx-sv-btn svg{flex:0 0 auto;display:none}',
    '.mcx-sv-btn:not(.mcx-sv-busy) .mcx-sv-glyph{display:inline-block}',
    '.mcx-sv-btn.mcx-sv-busy .mcx-sv-spin{display:inline-block}',
    '.mcx-sv-spin{animation:mcxSvSpin 1s linear infinite}',
    '@keyframes mcxSvSpin{to{transform:rotate(360deg)}}',
    /* 图周围上面留 74px：药丸与 × 浮在那儿，不许压住图。
       这一层不滚（overflow:hidden）：flex 居中配 overflow:auto 时，放大后往起点那一侧的溢出
       浏览器根本滚不到，抓手就成了摆设 —— 平移自己算，见 clampPan */
    '.mcx-sv-stage{flex:1 1 auto;min-height:0;overflow:hidden;position:relative;z-index:1;',
    'display:flex;align-items:center;justify-content:center;',
    'padding:74px 84px 18px;touch-action:none;user-select:none;-webkit-user-select:none}',
    '.mcx-sv-pan{flex:0 0 auto;display:flex;align-items:center;justify-content:center}',
    /* 图比可用区大时才能拖：光标先给信号 */
    '.mcx-sv-stage.mcx-sv-draggable{cursor:grab}',
    '.mcx-sv-stage.mcx-sv-grabbing{cursor:grabbing}',
    /* 进退场：图这一片只淡入淡出。旋转与缩放挂在盒子的 transform 上，
       那条时钟故意不用带回弹的曲线 —— 转文件时 overshoot 会先转过头再摆回来，看着就像"变形" */
    '.mcx-sv-box{flex:0 0 auto;display:flex;align-items:center;justify-content:center;opacity:0;',
    'transition:opacity ' + ENTER_MS + 'ms ease,transform 220ms cubic-bezier(.3,0,.2,1)}',
    '.mcx-sv.mcx-sv-open .mcx-sv-box{opacity:1}',
    /* 图自己不带 transform：那一颗地盘整个交给盒子，两层不互相盖 */
    '.mcx-sv-img{display:block;-webkit-user-drag:none;user-select:none}',
    /* 抽字那块浮在底部中间，不占版面：一占版面，图就得重摆一次，开一次跳一下 */
    '.mcx-sv-pane{position:absolute;left:50%;bottom:52px;z-index:3;box-sizing:border-box;',
    'width:min(760px,calc(100vw - 96px));height:0;opacity:0;overflow:hidden;padding:0 18px;',
    'background-color:var(--mc-background-0,#fff);border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
    '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transform:translate(-50%,8px);',
    'transition:height ' + ENTER_MS + 'ms cubic-bezier(.16,1,.3,1),opacity ' + ENTER_MS + 'ms ease,',
    'transform ' + ENTER_MS + 'ms cubic-bezier(.16,1,.3,1)}',
    '.mcx-sv-pane.mcx-sv-pane-open{opacity:1;height:' + PANE_H + 'px;padding:14px 18px;transform:translate(-50%,0)}',
    /* 那段字自己滚，滚到底不许把身后的页面带着一起滚。
       描边／轮廓／影子一律显式清零：Canvas 自己的表里有给 pre 画框的那一条，
       节点也换成 div，页面里那些认标签名的规则就找不到地盘了 */
    '.mcx-sv-text{box-sizing:border-box;height:100%;margin:0;padding:0;overflow:auto;overscroll-behavior:contain;',
    'border:0 !important;outline:none !important;box-shadow:none !important;border-radius:0 !important;',
    'background:transparent !important;color:var(--mc-text-0,#111);white-space:pre-wrap;overflow-wrap:anywhere;',
    'font:400 14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Lato,Arial,sans-serif}',
    '.mcx-sv-foot{flex:0 0 auto;position:relative;z-index:2;min-height:34px;display:flex;align-items:center;justify-content:center;',
    'padding:0 18px 12px;text-align:center;overflow-wrap:anywhere;',
    'font:400 13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Lato,Arial,sans-serif;',
    'color:var(--mc-text-1,var(--mc-text-0,#111))}',
    '.mcx-sv-nav{position:fixed;top:50%;z-index:3;transform:translateY(-50%);width:44px;height:44px;padding:0;border-radius:50%;',
    'box-shadow:0 8px 24px rgba(0,0,0,.14)}',
    '.mcx-sv-prev{left:16px}',
    '.mcx-sv-next{right:16px}'
  ].join('\n');

  var ICONS = {
    minus: 'M5 12h14',
    plus: 'M12 5v14M5 12h14',
    rotate: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
    download: 'M12 4v11M7.5 11 12 15.5 16.5 11M5 19h14',
    pack: 'M4 8h16v11H4zM4 8l2.5-4h11L20 8M12 12v4M9.5 14.5 12 17l2.5-2.5',
    text: 'M5 5h14v11H5zM8 9h8M8 12.5h5',
    close: 'M7 7l10 10M17 7 7 17',
    prev: 'M14.5 6 8.5 12l6 6',
    next: 'M9.5 6l6 6-6 6'
  };

  function glyph(name, size) {
    var s = size || 20;
    return '<svg class="mcx-sv-glyph" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + (ICONS[name] || '') + '"/></svg>';
  }

  function spinner() {
    return '<svg class="mcx-sv-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" opacity=".25"/>' +
      '<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function on() {
    return read(KEY) !== '0';
  }

  /* 认图：路径里带 /files/<数字id> 才算 Canvas 存下来的那份（老师从电脑里传上来的）。
     分片库的 id 中间有一个 ~（SHARDID_REGEX），一并收下 */
  var FILE_PATH = /\/files\/(\d+(?:~\d+)?)(?:\/|$|\?)/;
  var BAD_PATH = /\/images\/|\/equation_images\/|\/dist\/|icon_lock|blank\.png|no_pic|play_overlay|\.svg(?:$|\?)/i;
  var BAD_CLASS = ['equation_image', 'ic-Error-img', 'media_comment_thumbnail', 'lti_tool_icon'];

  /* 正文点位那扇门：这一串和 collect() 用的是同一份，两边不会算出两个结果 */
  var BODY_SCOPES = [
    '.user_content',                 // Canvas 自己增强正文也认这颗，全站正文那一大类都在这下面
    '[data-resource-type]',          // assignment.body / syllabus.body / wiki_page.body / assignment.submission
    '.description_content', '.long_description', '.answer_html', '.answer_label', '.quiz_response_text',
    '.question_teaser', '.question_text', '#biography', '.event-detail-overflow',
    '.ic-announcement-row__content', '#full_calendar_event', '.comments'
  ];

  function absUrl(src) {
    try {
      return new URL(src, location.origin).href;
    } catch (e) {
      return '';
    }
  }

  function fileId(url) {
    var m = FILE_PATH.exec(String(url).replace(/^https?:\/\/[^/]+/i, ''));
    return m ? m[1] : '';
  }

  /* 显示照页面那颗 src 用（可能是 /preview，也可能带着 verifier）；
     下载和抽字要原图：/preview 换成 /download，补 download_frd=1，把 InstFS 那两颗缩放参数剥掉。
     verifier 一定留着（剥了学生那头会 403） */
  function originalUrl(url) {
    if (!url) return '';
    var out = url.replace(/\/preview(?=\/|\?|$)/i, '/download');
    if (!/\/download(?=\/|\?|$)/i.test(out)) {
      out = out.replace(/\/files\/(\d+(?:~\d+)?)(?=[/?]|$)/i, '/files/$1/download');
    }
    try {
      var u = new URL(out, location.origin);
      u.searchParams.set('download_frd', '1');
      u.searchParams.delete('geometry');
      u.searchParams.delete('format');
      return u.href;
    } catch (e) {
      return out;
    }
  }

  function inBodyScope(img) {
    for (var i = 0; i < BODY_SCOPES.length; i++) {
      try {
        if (img.closest(BODY_SCOPES[i])) return true;
      } catch (e) { /* 一颗选择器不认就当没命中，别把整轮扫描打断 */ }
    }
    return false;
  }

  function isPhoto(img) {
    if (!img || img.nodeType !== 1 || img.tagName !== 'IMG') return false;
    if (img.closest('.mcx-sv')) return false;
    for (var i = 0; i < BAD_CLASS.length; i++) {
      if (img.classList.contains(BAD_CLASS[i])) return false;
    }
    var raw = img.getAttribute('src') || '';
    if (!raw || /^data:/i.test(raw)) return false;
    var url = absUrl(img.currentSrc || raw);
    if (!url || /^data:/i.test(url) || BAD_PATH.test(url)) return false;
    if (!fileId(url)) return false;
    // 没发布/没权限的那颗不收：Canvas 会往 URL 上挂 hidden=1，并把 alt 换成"This image is currently unavailable"
    if (/[?&]hidden=1\b/.test(url)) return false;
    var alt = String(img.getAttribute('alt') || '').toLowerCase();
    if (alt.indexOf('currently unavailable') >= 0 || alt === 'locked image') return false;
    if (!inBodyScope(img)) return false;
    var r = img.getBoundingClientRect();
    var w = r.width || img.naturalWidth || 0;
    var h = r.height || img.naturalHeight || 0;
    return Math.min(w, h) >= MIN_SIDE;
  }

  /* 这一页上的照片清单：同一颗文件只留第一次出现的那颗（读的顺序就是页面顺序） */
  function collect() {
    var all = document.querySelectorAll('img');
    var seen = {};
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!isPhoto(all[i])) continue;
      var id = fileId(absUrl(all[i].currentSrc || all[i].getAttribute('src')));
      if (!id || seen[id]) continue;
      seen[id] = 1;
      // 页面那颗已经加载好了，宽高先跟它要：新 img 的 load 事件来不及发时也不会先塌一块再跳
      out.push({ el: all[i], id: id, src: absUrl(all[i].currentSrc || all[i].getAttribute('src')), alt: all[i].getAttribute('alt') || '', w: all[i].naturalWidth || 0, h: all[i].naturalHeight || 0 });
    }
    return out;
  }

  /* Canvas 自己的预览：图被 <a href=".../files/..."> 包住时那一颗点击归它；
     它已经把 #file_preview_container 摆出来了也照样让路 */
  function canvasOwnsIt(img) {
    if (document.getElementById('file_preview_container')) return true;
    var a = img.closest('a[href]');
    if (!a) return false;
    if (a.classList.contains('instructure_file_link') || a.classList.contains('file_preview_link')) return true;
    return /\/files\/\d+(?:~\d+)?\b/i.test(absUrl(a.getAttribute('href') || ''));
  }

  function ensureStyle() {
    if (document.getElementById('mcx-sv-style')) return;
    var el = document.createElement('style');
    el.id = 'mcx-sv-style';
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  var ui = null;
  var list = [];
  var opener = null;
  var index = 0;
  var rot = 0;
  var scale = 1;
  var busy = false;
  var closing = false;
  var drag = null;
  var dragged = 0;
  var panX = 0;
  var panY = 0;
  var lock = null;

  function make(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* 图标一律自己描的线（不吃符号字符），字重按他定的那条：弹窗里的键一律不加粗。
     iconOnly 那三颗（上一张／下一张／×）只摆图：名字留在 aria-label 和悬停提示里 */
  function key(name, label, iconName, size, iconOnly) {
    var b = make('button', 'mcx-sv-btn mcx-sv-b-' + name, glyph(iconName, size) + spinner() +
      (iconOnly ? '' : '<span class="mcx-sv-word">' + label + '</span>'));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  }

  /* 滚轮只掐"身后那一页"：图那一片（当平移用）与抽字那块卡片（自己滚）都得放过 */
  function blockBehind(e) {
    if (!ui) return;
    if (e.target && e.target.closest && e.target.closest('.mcx-sv-stage,.mcx-sv-text')) return;
    e.preventDefault();
  }

  /* 平移的边界：图比可用区大多少，就能往那个方向拖多少。图是居中摆的，所以两边各一半。
     每一步都过 num()：一旦让 NaN 进到 panX，往后写出去的 transform 是非法值、
     会被整个丢掉，看着就是"抓手在、图不动"，再也拖不动了 */
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function clampPan() {
    var lx = Math.max(0, (num(ui.shownW) - num(ui.availW)) / 2);
    var ly = Math.max(0, (num(ui.shownH) - num(ui.availH)) / 2);
    panX = Math.min(lx, Math.max(-lx, num(panX)));
    panY = Math.min(ly, Math.max(-ly, num(panY)));
    // 只有真溢出了才给"能拖"的光标，不然摆一颗拖不动的抓手是骗人
    ui.canPan = lx > 0 || ly > 0;
    ui.stage.classList.toggle('mcx-sv-draggable', ui.canPan);
  }

  function applyPan() {
    ui.pan.style.transform = 'translate(' + Math.round(panX) + 'px,' + Math.round(panY) + 'px)';
  }

  function moveBy(dx, dy) {
    if (!ui) return;
    panX = num(panX) + num(dx);
    panY = num(panY) + num(dy);
    clampPan();
    applyPan();
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    if (ui) ui.stage.classList.remove('mcx-sv-grabbing');
  }

  /* 两指：记下每根手指的位置，捏合的距离比就是缩放档 */
  var pointers = [];
  var pinch = null;

  function rememberPointer(e) {
    var at = pointerSlot(e.pointerId);
    var rec = { id: e.pointerId, x: num(e.clientX), y: num(e.clientY) };
    if (at < 0) pointers.push(rec);
    else pointers[at] = rec;
  }

  function pointerSlot(id) {
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].id === id) return i;
    }
    return -1;
  }

  function pinchDistance() {
    if (pointers.length < 2) return 0;
    var a = pointers[0];
    var b = pointers[1];
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  }

  function dropPointer(e) {
    var at = pointerSlot(e.pointerId);
    if (at >= 0) pointers.splice(at, 1);
    if (pointers.length < 2) pinch = null;
  }

  function resetGestures() {
    pointers = [];
    pinch = null;
    endDrag();
  }

  /* 按住图拖＝平移；两指落下＝捏合缩放。平移只动 pan 那一颗，
     缩放与旋转只动盒子那一颗，各层不互相借 */
  function wireDrag(stage) {
    stage.addEventListener('pointerdown', function (e) {
      rememberPointer(e);
      if (pointers.length >= 2) {
        endDrag();   // 第二根手指落下就改判成捏合，单指那一截先撤
        pinch = { d: pinchDistance(), s: num(scale) };
        e.preventDefault();
        return;
      }
      if (e.button !== 0 || !ui.canPan) return;
      drag = { x: num(e.clientX), y: num(e.clientY), px: num(panX), py: num(panY) };
      dragged = 0;
      stage.classList.add('mcx-sv-grabbing');
      e.preventDefault();
    });
    /* 这一层不滚：普通滚轮／双指划当平移；Chrome 把触控板捏合发成 ctrl＋wheel，
       那一种就当缩放，所以不需要另配加减号 */
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        setScale(num(scale) * Math.exp(-num(e.deltaY) * 0.012));
      } else {
        moveBy(-num(e.deltaX), -num(e.deltaY));
      }
    }, { passive: false });
  }

  /* 移动与松手挂在 window 上：拖出或捏出那一层都不能断（侧栏自绘拖那一轮踩过） */
  function onDragMove(e) {
    if (!ui) return;
    if (pointerSlot(e.pointerId) >= 0) rememberPointer(e);
    if (pinch) {
      var d = pinchDistance();
      if (pinch.d > 0 && d > 0) setScale(pinch.s * (d / pinch.d));
      return;
    }
    if (!drag) return;
    var dx = num(e.clientX) - drag.x;
    var dy = num(e.clientY) - drag.y;
    dragged = Math.max(dragged, Math.abs(dx) + Math.abs(dy));
    panX = drag.px + dx;
    panY = drag.py + dy;
    clampPan();
    applyPan();
  }

  function onDragEnd(e) {
    dropPointer(e);
    endDrag();
  }

  /* 开板时把页面钉住（键盘 PageDown 那条也一起断），关掉原样还回去。
     滚动条那一栏的宽度补进右内边距，不然钉住那一瞬整页会横着跳一下 */
  function lockPage() {
    if (lock) return;
    var de = document.documentElement;
    var body = document.body;
    var gutter = window.innerWidth - de.clientWidth;
    lock = {
      de: de,
      deOverflow: de.style.overflow,
      dePad: de.style.paddingRight,
      bodyOverflow: body ? body.style.overflow : ''
    };
    de.style.overflow = 'hidden';
    if (gutter > 0) de.style.paddingRight = gutter + 'px';
    if (body) body.style.overflow = 'hidden';
  }

  function unlockPage() {
    if (!lock) return;
    lock.de.style.overflow = lock.deOverflow || '';
    lock.de.style.paddingRight = lock.dePad || '';
    if (document.body) document.body.style.overflow = lock.bodyOverflow || '';
    lock = null;
  }

  function build() {
    var root = make('div', 'mcx-sv');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Image viewer');

    var plate = make('div', 'mcx-sv-plate');
    plate.tabIndex = -1;

    var bar = make('div', 'mcx-sv-bar');
    var zoomOut = key('zoomout', 'Zoom out', 'minus');
    var zoomIn = key('zoomin', 'Zoom in', 'plus');
    var rotate = key('rotate', 'Rotate', 'rotate');
    var one = key('one', 'Download', 'download');
    var textBtn = key('text', 'Extract Text', 'text');
    var pack = key('pack', 'Download All', 'pack', 19);
    bar.appendChild(zoomOut);
    bar.appendChild(zoomIn);
    bar.appendChild(rotate);
    bar.appendChild(one);
    bar.appendChild(textBtn);
    bar.appendChild(pack);

    var x = key('close', 'Close', 'close', 20, true);
    x.classList.add('mcx-sv-x');

    var stage = make('div', 'mcx-sv-stage');
    var pan = make('div', 'mcx-sv-pan');
    var box = make('div', 'mcx-sv-box');
    var img = make('img', 'mcx-sv-img');
    img.alt = 'Photo';
    img.draggable = false;   // 不关掉浏览器那颗拖影，拖平移会顺手带出一张幽灵图
    box.appendChild(img);
    pan.appendChild(box);
    stage.appendChild(pan);

    var pane = make('div', 'mcx-sv-pane');
    var text = make('div', 'mcx-sv-text');
    pane.appendChild(text);

    var foot = make('div', 'mcx-sv-foot');

    plate.appendChild(bar);
    plate.appendChild(x);
    plate.appendChild(stage);
    plate.appendChild(pane);
    plate.appendChild(foot);

    var prev = key('prev', 'Previous image', 'prev', 22, true);
    prev.classList.add('mcx-sv-nav', 'mcx-sv-prev');
    var next = key('next', 'Next photo', 'next', 22, true);
    next.classList.add('mcx-sv-nav', 'mcx-sv-next');

    root.appendChild(plate);
    root.appendChild(prev);
    root.appendChild(next);

    img.addEventListener('load', paint);
    img.addEventListener('error', function () {
      if (img.__sv_failed) return;
      img.__sv_failed = true;
      say('Could not load this image. Reload the page and try again.');
    });

    zoomOut.addEventListener('click', function () { zoom(1 / ZOOM_STEP); });
    zoomIn.addEventListener('click', function () { zoom(ZOOM_STEP); });
    rotate.addEventListener('click', function () { rot = (rot + 90) % 360; paint(); });
    one.addEventListener('click', function () { downloadOne(one); });
    pack.addEventListener('click', function () { downloadAll(pack); });
    textBtn.addEventListener('click', function () { toggleText(textBtn); });
    x.addEventListener('click', close);
    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    // 点图片周围那一片糊掉的背景（含整块板与留白）算"关掉"，点在图与键上都不算
    root.addEventListener('click', function (e) {
      if (dragged > 4) { dragged = 0; return; }   // 拖完浏览器还会补一颗 click，那颗不算关
      if (e.target === root || e.target === plate || e.target === stage || e.target === box) close();
    });
    // 滚轮落在药丸、×、脚上时掐掉（背景不许跟着滚），落在图上留给图自己滚
    root.addEventListener('wheel', blockBehind, { passive: false });
    root.addEventListener('touchmove', blockBehind, { passive: false });
    wireDrag(stage);

    ui = {
      root: root, plate: plate, bar: bar, stage: stage, pan: pan, box: box, img: img, pane: pane,
      text: text, foot: foot, prev: prev, next: next,
      zoomOut: zoomOut, zoomIn: zoomIn, rotate: rotate, one: one, pack: pack, textBtn: textBtn
    };
    return root;
  }

  /* 计数、进度、报错共用脚上那一行：位置不随内容变，也不会把上面那排键顶走 */
  function say(msg) {
    if (ui) ui.foot.textContent = msg;
  }

  function baseSize() {
    var img = ui.img;
    var item = list[index] || {};
    // 可用区顺手记下来：能拖多远是按这一档算的，两条必须同源
    ui.availW = Math.max(80, ui.stage.clientWidth - 36);
    ui.availH = Math.max(80, ui.stage.clientHeight - 24);
    var nw = img.naturalWidth || item.w || 0;
    var nh = img.naturalHeight || item.h || 0;
    if (!nw || !nh) return { w: 320, h: 220 };
    /* 按"转完之后那一圈"去塞：竖图转 90 度之后照样占满可用区。
       照没转的那一圈塞，一转就凭空小一截，看着像被压扁了 */
    var swap = (rot % 180) !== 0;
    var wide = swap ? nh : nw;
    var tall = swap ? nw : nh;
    var k = Math.min(ui.availW / wide, ui.availH / tall, 1);
    return { w: Math.max(1, Math.round(nw * k)), h: Math.max(1, Math.round(nh * k)) };
  }

  /* 旋转与缩放都落在盒子这一颗 transform 上：盒子的布局那一圈始终是不转的尺寸，
     所以转的时候不会有"容器先跳、图后转"的错位；图自己不带 transform */
  function paint() {
    if (!ui) return;
    var b = baseSize();
    var swap = (rot % 180) !== 0;
    ui.box.style.width = b.w + 'px';
    ui.box.style.height = b.h + 'px';
    ui.img.style.width = b.w + 'px';
    ui.img.style.height = b.h + 'px';
    ui.box.style.transform = 'rotate(' + rot + 'deg) scale(' + scale + ')';
    // 能拖多远按转完、放大后的实际那一圈算
    ui.shownW = (swap ? b.h : b.w) * scale;
    ui.shownH = (swap ? b.w : b.h) * scale;
    clampPan();
    applyPan();
  }

  function setScale(v) {
    var to = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, num(v)));
    if (to === scale) return;
    scale = to;
    paint();
  }

  function zoom(factor) {
    setScale(num(scale) * factor);
  }

  function step(dir) {
    var to = index + dir;
    if (to < 0 || to >= list.length) return;
    show(to);
  }

  /* 忙的时候那颗键自己转圈（不是页面上另摆一圈），同一排键也一起按住，
     免得一张还在读又点第二张 */
  function setBusy(flag, node) {
    busy = flag;
    if (node) node.classList.toggle('mcx-sv-busy', flag);
    if (ui) {
      ui.one.disabled = flag;
      ui.pack.disabled = flag;
    }
  }

  function nameOf(item) {
    var clean = String(item.src || '').split('?')[0].split('#')[0];
    var m = /\/files\/\d+(?:~\d+)?\/([^/?]+)/i.exec(clean);
    // /preview 跟 /download 那两段是路由名不是文件名，别把它当标题写在脚上那一行
    if (m && m[1] && !/^(preview|download|file_preview|inline_view)$/i.test(m[1])) {
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }
    return item.alt || '';
  }

  function safeName(name, item) {
    var base = String(name || '').replace(/[\\/?*:|"'<>]/g, '').replace(/\s+/g, ' ').trim();
    if (base.length > 80) base = base.slice(0, 80);
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
      var ext = (/\.([a-z0-9]{2,5})$/i.exec(String(item.src || '').split('?')[0]) || [])[1];
      base += ext ? '.' + ext.toLowerCase() : '';
    }
    return base || ('canvas-image-' + item.id.replace('~', '-') + '.png');
  }

  function show(i) {
    if (!ui) return;
    var item = list[i];
    if (!item) return;
    index = i;
    rot = 0;
    scale = 1;
    panX = 0;   // 上一张拖到哪儿不能带进这一张
    panY = 0;
    resetGestures();
    ui.img.__sv_failed = false;
    ui.img.removeAttribute('src');
    ui.img.alt = item.alt || 'Photo';
    ui.img.src = item.src;
    // 先按页面那颗的宽高摆好，load 再回来时按真实宽高重算一次
    paint();
    var label = list.length > 1 ? (i + 1) + ' / ' + list.length : '';
    var nm = nameOf(item);
    say(nm ? (label ? label + ' · ' + nm : nm) : label);
    var many = list.length > 1;
    ui.prev.style.display = many ? '' : 'none';
    ui.next.style.display = many ? '' : 'none';
    ui.prev.disabled = !many || i <= 0;
    ui.next.disabled = !many || i >= list.length - 1;
    closeText();
  }

  function closeText() {
    if (!ui) return;
    ui.pane.classList.remove('mcx-sv-pane-open');
    ui.textBtn.classList.remove('mcx-sv-on');
    ui.text.textContent = '';
  }

  function toggleText(node) {
    if (!ui) return;
    if (ui.pane.classList.contains('mcx-sv-pane-open')) {
      closeText();
      return;
    }
    ui.pane.classList.add('mcx-sv-pane-open');
    ui.textBtn.classList.add('mcx-sv-on');
    var item = list[index];
    if (!item) return;
    var D = window.MCxData;
    if (!D || !D.ocrUrl) {
      ui.text.textContent = 'Text reading is unavailable. Reload the page and try again.';
      return;
    }
    var at = index;
    ui.text.textContent = 'Reading text…';
    setBusy(true, node);
    // 只递 URL：取字节、解码、压长边全在扩展页那一头（页面这一头会被 CORS 挡，
    // 降级成 <img> 又会被判画布污染，toDataURL 直接抛）
    D.ocrUrl(item.src, OCR_SIDE).then(function (text) {
      if (!ui || at !== index) return;
      var t = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
      ui.text.textContent = t || 'No text found.';
    }, function (err) {
      var msg = String((err && err.message) || err);
      if (!ui || at !== index) return;
      ui.text.textContent = 'Could not read text from this image.';
      console.warn('[MCX viewer] OCR failed:', msg);
    }).then(function () {
      setBusy(false, node);
    });
  }

  /* 单张：取的是原图那一份（/download?download_frd=1），不是 DOM 里那颗缩放档 */
  function downloadOne(node) {
    var D = window.MCxData;
    var item = list[index];
    if (!D || !D.fetchBytes || !item) return;
    setBusy(true, node);
    say('Reading the file...');
    D.fetchBytes(originalUrl(item.src)).then(function (bytes) {
      if (!ui) return;
      var name = safeName(nameOf(item), item);
      save(new Blob([bytes]), name);
      say(name);
    }, function (err) {
      say('Could not download this photo: ' + String((err && err.message) || err));
      console.warn('[MCX viewer] download failed:', String((err && err.message) || err));
    }).then(function () {
      setBusy(false, node);
    });
  }

  /* 整批：这一页认出来的照片全下来，打成一份 zip。一张一张跑不并发
     （全站那条限流按人计数，一口气放十几颗会撞 429） */
  function downloadAll(node) {
    var D = window.MCxData;
    if (!D || !D.fetchBytes || !list.length) return;
    if (typeof JSZip === 'undefined') {
      say('The zip library is not loaded yet. Reload the page and try again.');
      return;
    }
    setBusy(true, node);
    var zip = new JSZip();
    var used = {};
    var got = 0;
    var failed = 0;
    var total = list.length;
    var run = true;

    function take(i) {
      if (!run) return Promise.resolve();
      if (i >= total) return Promise.resolve();
      var item = list[i];
      return D.fetchBytes(originalUrl(item.src)).then(function (bytes) {
        var base = safeName(nameOf(item), item);
        var m = /^(.*?)(\.[a-z0-9]{2,5})?$/i.exec(base);
        var stem = m[1] || base;
        var ext = m[2] || '';
        var n = 2;
        var name = base;
        while (used[name.toLowerCase()]) {
          name = stem + '-' + n + ext;
          n++;
        }
        used[name.toLowerCase()] = 1;
        zip.file(name, bytes);
        got++;
      }, function () {
        failed++;
      }).then(function () {
        if (ui) say('Collected ' + (got + failed) + ' of ' + total + '...');
        return sleep(GAP_MS).then(function () { return take(i + 1); });
      });
    }

    take(0).then(function () {
      if (!ui) return null;
      if (got === 0) {
        say('None of these photos could be read.');
        return null;
      }
      say('Packing ' + got + ' photo' + (got === 1 ? '' : 's') + '...');
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      if (!blob || !ui) return null;
      save(blob, 'photos-' + slugPage() + '.zip');
      say('Saved ' + got + ' photo' + (got === 1 ? '' : 's') + (failed ? ', ' + failed + ' could not be read.' : '.'));
      return null;
    }, function (err) {
      if (ui) say('Could not build the zip: ' + String((err && err.message) || err));
    }).then(function () {
      run = false;
      setBusy(false, node);
    });
  }

  function slugPage() {
    var s = String(location.pathname || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    return (s || 'canvas').slice(-48);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* 一律先取字节再走 blob：URL 是同源，但 download 属性在别的源上是无效的，
     直接指过去会变成开一张新标签 */
  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = make('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function onClick(e) {
    if (ui || busy || !on()) return;
    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (!img || !isPhoto(img)) return;
    if (canvasOwnsIt(img)) return;
    e.preventDefault();
    e.stopPropagation();
    opener = img;
    list = collect();
    var at = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].el === img) { at = i; break; }
    }
    open(at);
  }

  function open(i) {
    ensureStyle();
    rot = 0;
    scale = 1;
    var root = build();
    // 挂在 html 上而不是 body 上：body 那一层随时可能被站点（或对方扩展）加上 filter/transform，
    // 那会把 position:fixed 的参照物从视口改成它，四角就成了它那块圆角卡的样子
    document.documentElement.appendChild(root);
    lockPage();   // 先钉住页面再量图：钉住会改可视宽度，晚一步图就按错的宽度摆
    show(i);
    // 下一帧才挂 open：同一帧里改，进场那条时钟根本不会启动
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (ui) ui.root.classList.add('mcx-sv-open');
      });
    });
    try {
      ui.plate.focus({ preventScroll: true });
    } catch (e) { /* 旧浏览器不认这个选项，焦点落哪儿都不影响按 Esc 关掉 */ }
  }

  function onKey(e) {
    if (!ui) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // 在抽出来那段字里选东西时，左右键归他，不归翻页
    if (ui.pane.classList.contains('mcx-sv-pane-open') && ui.text.contains(document.activeElement)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }

  /* 关的动画跟开的是同一套机构、同一时长曲线（不是只 fade 一下就摘） */
  function close() {
    if (!ui || closing) return;
    closing = true;
    var root = ui.root;
    var plate = ui.plate;
    var back = opener;
    ui = null;
    list = [];
    busy = false;
    root.classList.remove('mcx-sv-open');
    root.classList.add('mcx-sv-out');
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      if (root.parentNode) root.remove();
      unlockPage();
      if (back && back.isConnected) {
        try { back.focus({ preventScroll: true }); } catch (e) { /* 那颗已被站点换掉了 */ }
      }
      opener = null;
      closing = false;
    }
    var timer = setTimeout(finish, LEAVE_MS + 120);
    root.addEventListener('transitionend', function (ev) {
      if (ev.target !== root && ev.target !== plate) return;
      clearTimeout(timer);
      finish();
    });
  }

  function onResize() {
    if (ui) paint();
  }

  /* 光标那一点提示挂在 hover 上，不给页面批量加类名也不加观察器 */
  function onMouseOver(e) {
    if (ui || !on()) return;
    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img && !img.__sv_hit && isPhoto(img) && !canvasOwnsIt(img)) {
      img.__sv_hit = 1;
      img.style.cursor = 'zoom-in';
    }
  }

  function boot() {
    ensureStyle();
    document.addEventListener('click', onClick, true);
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    // 拖动的移动与松手挂在这里（不是挂在图上）：拖出那一层也不能断
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  try {
    if (window.top === window.self) boot();
  } catch (err) {
    console.error('[MCX viewer] not started:', String((err && err.message) || err));
  }

  // 只有测试会用到这几个：判据正本在文件里那一份，这里不改写一遍
  window.MCxSourceViewer = {
    isPhoto: isPhoto,
    collect: collect,
    originalUrl: originalUrl,
    fileId: fileId,
    canvasOwnsIt: canvasOwnsIt,
    safeName: safeName,
    nameOf: nameOf,
    on: on
  };
})();
