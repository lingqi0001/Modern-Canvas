/* 模块列表的收放动画归 jQuery 管，不归 CSS 管。
   [实测 2026-10-05] 站点用的是 slideToggle：它把 height 一行行写成行内样式逐帧改，
   所以 style.css 里那条 `.context_module .content{transition:none}` 管不到它——那条掐的是 CSS 过渡。
   theme-boot.js 上一版试过关它（jQuery.fx.off），两条路都是空转：
   一是往页面里插 <script> 被这站的 CSP 挡死（planner-guard.js 头上有同一条实测），
   二是那份跑在隔离世界，那里的 window.jQuery 不是页面这一份。
   所以这一份注册在 manifest 的 MAIN world 里，并且抢在其它脚本之前装。

   只占两段时间，其余一律不碰：
   1) 刚进页面那一下——站点按上次的状态把每条模块挨个 slideUp，屏幕上就是"先展开再收回"；
   2) 顶部 Expand All／Collapse All 那一下——一次几十条同时 tween＝卡死。
   单点某一条标题那颗不动它，那一档动画保留（他拍的板）。 */
(function () {
  'use strict';

  // 非 Canvas 站点直接退出
  var h = window.location.hostname.toLowerCase();
  var isAuto = (h === 'instructure.com' || h.endsWith('.instructure.com') ||
                h === 'canvas.net' || h.endsWith('.canvaslms.com') ||
                h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
  var customStr = '';
  try { customStr = localStorage.getItem('mc_custom_domains_cache') || ''; } catch (e) {}
  if (!isAuto && (!customStr || customStr.indexOf(h) === -1)) return;

  // 暂停状态下不接管原生动画
  var mcPausedUntil = '';
  try { mcPausedUntil = localStorage.getItem('mc_paused_until') || ''; } catch (e) {}
  if (mcPausedUntil) {
    if (mcPausedUntil === '-1' || mcPausedUntil === 'reload') return;
    var numUntil = Number(mcPausedUntil);
    if (numUntil && Date.now() < numUntil) return;
  }
  if (document.documentElement.classList.contains('mc-paused')) return;

  // 只在课程页占这段：模块列表只出现在 /courses/<id>（home 和 modules 两种）
  if (!/\/courses\/\d/.test(location.pathname)) return;

  var jq = null;
  var originalOff = false;
  var releaseTimer = null;

  function hold(ms) {
    if (!jq || !jq.fx) return;
    jq.fx.off = true;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(release, ms);
  }

  function release() {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    if (jq && jq.fx) jq.fx.off = originalOff;
  }

  function attach(v) {
    if (!v || v === jq || !v.fx) return;
    jq = v;
    originalOff = !!jq.fx.off;
    // 首屏那一下：站点的初始收放在 DOMContentLoaded 上跑，所以这段一直占到它跑完再放 800 毫秒。
    // 等到这里时已经 ready 了＝那一趟早跑完，不再占
    if (document.readyState === 'loading') {
      jq.fx.off = true;
      document.addEventListener('DOMContentLoaded', function () { hold(800); });
    }
  }

  // 页面那份 jQuery 是稍后才赋到 window 上的，所以先埋一个赋值陷阱；定义不了就退回轮询
  var pollTimer = null;
  try {
    if (window.jQuery) {
      attach(window.jQuery);
    } else {
      var stored = undefined;
      Object.defineProperty(window, 'jQuery', {
        configurable: true,
        get: function () { return stored; },
        set: function (v) { stored = v; attach(v); }
      });
      pollTimer = setInterval(function () {
        if (jq) { clearInterval(pollTimer); pollTimer = null; return; }
        if (window.jQuery) { clearInterval(pollTimer); pollTimer = null; attach(window.jQuery); }
      }, 50);
      setTimeout(function () { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }, 5000);
    }
  } catch (e) {}

  // 捕获阶段跑在站点自己的处理器之前，所以这一下点完就已经是终态，一条一条滑的没有
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('#expand_collapse_all')) return;
    hold(600);
  }, true);
})();
