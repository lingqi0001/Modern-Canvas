/* planner 容错：必须跑在页面自己的世界里（React 挂在节点上的 __reactFiber$ 只有主世界读得到）。
   这份不是用"往页面里插 <script>"注进去的 —— 那一条被这站的 CSP 挡了（实测：
   <html data-mcx-nai> 停在 blocked）。manifest 里用 "world": "MAIN" 直接注册，
   扩展自己的脚本不吃页面 CSP。
   为什么要有这一份：点 NEW ACTIVITY → planner 拉新日期 → Canvas 那个"让新活动那条留在视口里"
   的动画跑收尾逻辑，它取"索引最大的那一天"注册的 componentIds，减掉本次回来的 id，
   剩下的拿去查 new-activity-indicator 那张表；那一天若是 calendar_event（没有指示器）
   就查不到 → 读 undefined.index 抛错 → React 错误边界把整棵子树换成空
   ＝ 顶部那条工具栏和那颗折页一起没了，只有刷新能回来。
   只包 getLastComponent：实测 Canvas 那份 chunk 里它总共两个调用点，都在上面那一处；
   getFirstComponent 零调用点，不碰。容错不能塞 null（塞了死在下一句 u.getFocusable()），
   要退回"这张表里最后一个真的指示器"。 */
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

  // 暂停状态下不接管
  var mcPausedUntil = '';
  try { mcPausedUntil = localStorage.getItem('mc_paused_until') || ''; } catch (e) {}
  if (mcPausedUntil) {
    if (mcPausedUntil === '-1' || mcPausedUntil === 'reload') return;
    var numUntil = Number(mcPausedUntil);
    if (numUntil && Date.now() < numUntil) return;
  }
  if (document.documentElement.classList.contains('mc-paused')) return;

  var patched = false;

  function mark(v) { document.documentElement.setAttribute('data-mcx-nai', v); }

  function findRegistry() {
    var anchor = document.querySelector('.planner-day');
    if (!anchor) return null;
    var keys = Object.keys(anchor), key = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0) { key = keys[i]; break; }
    }
    if (!key) return null;
    var root = anchor[key];
    while (root.return) root = root.return;
    var reg = null, seen = 0;
    function isReg(o) {
      try {
        return !!o && typeof o === 'object' && o.self !== o &&
          !!o.registries && !!o.registries['new-activity-indicator'];
      } catch (e) { return false; }
    }
    function scan(v, depth) {
      if (reg || !v || typeof v !== 'object' || depth > 3) return;
      var ks;
      try { ks = Object.keys(v); } catch (e) { return; }
      for (var j = 0; j < ks.length; j++) {
        var x;
        try { x = v[ks[j]]; } catch (e) { continue; }
        if (!x || typeof x !== 'object') continue;
        if (isReg(x)) { reg = x; return; }
        scan(x, depth + 1);
      }
    }
    function walk(f, depth) {
      if (reg || !f || depth > 70 || seen > 6000) return;
      seen++;
      scan(f.memoizedProps, 0);
      scan(f.memoizedState, 0);
      walk(f.child, depth + 1);
      walk(f.sibling, depth + 1);
    }
    walk(root, 0);
    return reg;
  }

  function run() {
    if (patched) return;
    var reg = null;
    try { reg = findRegistry(); }
    catch (e) { mark('seek-err-' + String(e && e.message || e).slice(0, 60)); }
    if (!reg) { setTimeout(run, 2000); return; }
    try {
      var proto = Object.getPrototypeOf(reg);
      var original = proto.getLastComponent;
      if (typeof original !== 'function') { mark('no-method'); return; }
      proto.getLastComponent = function (type, ids) {
        var table = this.registries[type];
        var known = (ids || []).filter(function (id) { return table && table[id]; });
        if (known.length) return original.call(this, type, known);
        var all = this.getSortedComponents(type);
        if (all.length) return all[all.length - 1];
        return {
          component: {
            getFocusable: function () { return null; },
            getScrollable: function () { return null; }
          },
          index: -1,
          componentIds: []
        };
      };
      patched = true;
      mark('on');
    } catch (e2) {
      mark('patch-err-' + String(e2 && e2.message || e2).slice(0, 60));
    }
  }

  mark('seeking');
  /* 最后一道：真点那颗折页之前先补一次。捕获阶段跑在 Canvas 自己的处理器前面，
     所以哪怕上面的轮询全没赶上，这一下也来得及 */
  document.addEventListener('click', function (ev) {
    if (patched) return;
    var t = ev.target;
    if (t && t.closest && t.closest('#new_activity_button')) run();
  }, true);
  run();
})();
