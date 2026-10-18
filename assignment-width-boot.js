/* =========================================================
   作业页两张卡的宽度，为什么单独一个 document_start 文件：

   2026-10-12 在他页上量到（/courses/296970/assignments/14485504）：
     #assignment_show            1293 宽
     里面 .description           1100 宽，它自己写着 max-width:1100px（DesignPlus／站点那条）
     我们两张卡（Due 那一排 + Assignment Guide）1293 宽
   差的那 193 像素就是他说的"卡片太长了"。

   旧做法是卡片挂出来以后再量兄弟、再写 margin。那一趟要等正文块被排好才知道数，
   症状是他报的"进来先很宽、半秒后才正常"。宽度这件事不需要 API、不需要判值，
   页面自己写着呢，所以放到最早那一帧去抄：document_start 挂一颗监听，抄到就自己拆掉。

   只干这一件事。判值、卡片、磨砂都在 assignment-guide.js 那一份里。
   ========================================================= */
(function (root) {
  'use strict';

  // 非 Canvas 站点直接退出
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

  var KEY_W = '--mcx-card-max-w';
  var KEY_L = '--mcx-card-inset-left';
  /* 按地址认，别的页面一颗监听都不挂 */
  var PAGE = /^\/courses\/\d+\/(assignments|quizzes|discussion_topics)\/\d+/i;
  var NAMED = ['#assignment_show .description', '#assignment_description', '.assignment .description',
    '#quiz_description', '#module_item_details .description'];

  function onPage() {
    try { return PAGE.test(location.pathname || ''); } catch (e) { return false; }
  }

  function ref() {
    for (var i = 0; i < NAMED.length; i++) {
      var n = null;
      try { n = document.querySelector(NAMED[i]); } catch (e) { n = null; }
      /* 宽度 200 以下不算"排好了"：那一档量到的是没布局的壳，抄走就是错的 */
      if (n && n.getBoundingClientRect().width > 200) return n;
    }
    return null;
  }

  function write(k, v) {
    try { if (k.getPropertyValue(KEY_W) !== v) k.setProperty(KEY_W, v); } catch (e) {}
  }

  /* 返回 true 表示"这一页的宽度已经抄到了"，监听可以拆了 */
  function sync() {
    if (!onPage()) return true;
    var r = ref();
    if (!r) return false;
    var box = r.getBoundingClientRect();
    var k = document.documentElement.style;
    write(k, Math.round(box.width) + 'px');
    /* 左边距：卡片和正文同一个起点时是 0。父容器还没布局（宽 0 或比正文窄）时不能拿它当基准 */
    var host = r.parentElement;
    var hr = host ? host.getBoundingClientRect() : null;
    var left = hr && hr.width > box.width ? Math.max(0, Math.round(box.left - hr.left)) : 0;
    try { k.setProperty(KEY_L, left ? left + 'px' : '0px'); } catch (e) {}
    return true;
  }

  var timer = 0;
  function start() {
    if (!onPage()) return;
    if (sync()) return;
    if (!root.MutationObserver) { setTimeout(sync, 120); return; }
    /* 合并成一趟：React 首帧会连着改几百次 DOM，不合并就是他把"卡顿"报过的那件事 */
    var mo = new root.MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = 0;
        if (sync()) { mo.disconnect(); later(); }
      }, 16);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    /* 万一这一页的正文块名字不一样：2 秒后收摊，别把监听留在那儿白跑 */
    setTimeout(function () { if (timer) { clearTimeout(timer); timer = 0; } mo.disconnect(); }, 2500);
  }

  /* 抄到以后还要跟着窗口大小走：正文是 max-width，窗口变窄时它会跟着变 */
  function later() {
    var t = 0;
    root.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(sync, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  root.MCxAssignWidth = { sync: sync, current: function () { try { return document.documentElement.style.getPropertyValue(KEY_W) || ''; } catch (e) { return ''; } } };
})(typeof window !== 'undefined' ? window : this);
