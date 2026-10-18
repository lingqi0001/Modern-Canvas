/* =========================================================
   同源预览层里的原生 <select> → 我们那颗自定义下拉
   =========================================================
   为什么还要一份只管 iframe 的：整套换皮（theme-boot.js 里那段同名的逻辑＋style.css 第 3054 行
   那 130 行画法）只注进最外层文档——manifest 第一条没写 all_frames，这是故意的
   （见 theater.css 顶上那段：整套灌进别人的帧会把人家的界面一起改）。
   提交正文那一屏（IFRAME#preview_frame，同源）里那颗 "Paper View / Plain Text View" 因此在帧外面
   根本没有对应节点，屏幕上就是浏览器原生的白框＋操作系统画的那份名单。

   这一份只做一件事：只在帧里跑（顶层文档第一行就退出），建同一套节点、同一套类名，
   画法在 preview-frame.css 里，全部前缀 html.bcx-select-frame 这个只有帧里才挂的类名，
   所以它压不到、也覆盖不了顶层那份原封不动的机制。
   真 select 不删，只 opacity:0 藏成占位继续持有 value；选中派发 input/change，Canvas 自己的切换照常。
   ========================================================= */
(function () {
  if (window.self === window.top) return;

  /* [实测 2026-10-11 答题屏] 这一份挂在 every same-origin 帧里，包括四张 TinyMCE 打字帧。
     它下面第 119 行的观察器盯着整棵帧文档，回调 run() 每来一批变动就全文档扫两遍
     （querySelectorAll('.bcx-select-wrap') ＋ querySelectorAll('select')）。
     打字帧里根本没有 <select>，可学生每敲一个字都让这张帧变动一次 → run() 每键被点着白扫。
     这一棵帧整块不进（判据同 theme-frame-boot.js：认外层那颗 iframe 元素的类名/id）。
     交作业预览那张帧（#preview_frame）两个判据都不中，照常换皮。 */
  try {
    var fe = window.frameElement;
    if (fe && (String(fe.className || '').indexOf('tox-edit-area__iframe') >= 0 || /_ifr$/.test(String(fe.id || '')))) return;
  } catch (e) {}

  var root = document.documentElement;
  if (!root) return;
  // 必须外层父页面也是 Canvas，否则在其他网站的内嵌 iframe 中不执行任何操作
  try {
    var parentDoc = window.parent.document;
    if (!parentDoc || !parentDoc.documentElement) return;
    if (parentDoc.documentElement.classList.contains('mc-paused')) return;
    if (!parentDoc.documentElement.classList.contains('bcx-themed') &&
        !parentDoc.documentElement.classList.contains('mcx-canvas-active') &&
        !window.parent.mcIsCanvas) return;
  } catch (e) {
    return;
  }
  root.classList.add('bcx-select-frame');

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
    var willOpen = !wrap.classList.contains('open');
    document.querySelectorAll('.bcx-select-wrap.open').forEach(function (w) {
      if (w !== wrap) closeWrap(w);
    });
    if (wrap._bcxCloseT) { clearTimeout(wrap._bcxCloseT); wrap._bcxCloseT = null; }
    wrap.classList.remove('closing');
    wrap.classList.toggle('open', willOpen);
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
    var lab = wrap.querySelector('.bcx-select-label');
    if (lab && lab.textContent !== text) lab.textContent = text;
    var menu = wrap.querySelector('.bcx-select-menu');
    if (!menu) return;
    var sig = [].map.call(sel.options, function (o) { return o.textContent.trim(); }).join('~|~');
    if (menu._sig !== sig) {
      menu._sig = sig;
      menu.textContent = '';
      [].forEach.call(sel.options, function (o, i) {
        var it = document.createElement('div');
        it.className = 'bcx-select-opt';
        it.setAttribute('role', 'option');
        it.textContent = o.textContent.trim();
        it.addEventListener('click', function (ev) { ev.stopPropagation(); pick(sel, i); });
        menu.appendChild(it);
      });
    }
    [].forEach.call(menu.children, function (it, i) {
      it.classList.toggle('selected', i === sel.selectedIndex);
    });
  }

  function build(sel) {
    var wrap = document.createElement('span');
    wrap.className = 'bcx-select-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('bcx-select-native');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bcx-select-btn';
    var lab = document.createElement('span');
    lab.className = 'bcx-select-label';
    btn.appendChild(lab);
    var menu = document.createElement('div');
    menu.className = 'bcx-select-menu';
    menu.setAttribute('role', 'listbox');
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleWrap(wrap); });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    sel._bcxWrap = wrap;
    wrap._bcxSel = sel;
  }

  function run() {
    // 绝大多数帧里既没有原生下拉、也没有我们建过的壳：先花一次联合查询问一句，
    // 没有就直接退，别让观察器每来一批变动都把整篇文档扫两遍
    if (!document.querySelector('select, .bcx-select-wrap')) return;
    document.querySelectorAll('.bcx-select-wrap').forEach(function (w) {
      var sel = w._bcxSel;
      if (!sel || !sel.isConnected) w.remove();
    });
    document.querySelectorAll('select').forEach(function (sel) {
      if (sel.closest('#bcx-settings')) return;
      var wrap = sel._bcxWrap;
      if (wrap && wrap.isConnected) { sync(sel); return; }
      build(sel);
      sync(sel);
    });
  }

  try {
    run();
    new MutationObserver(run).observe(root, { childList: true, subtree: true });
    document.addEventListener('click', function () {
      document.querySelectorAll('.bcx-select-wrap.open').forEach(closeWrap);
    });
  } catch (e) {
    console.error('[MCX] 预览层下拉引导失败', e);
  }
})();
