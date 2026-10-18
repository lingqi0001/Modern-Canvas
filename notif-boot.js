// 公告卡的换皮必须在浏览器画它之前完成，所以这份脚本单独跑在 document_start。
// 原来这段住在 content.js 里，而那份是 document_idle —— 公告卡是 Canvas 拉完数据才由 React 插进页面的，
// 往往比 content.js 起跑还早，于是原生尺寸先被画出一帧到几秒，之后才翻成我们的样子。
// 现在 React 一插卡，变动监听的微任务就在同一帧里把它打扮完，原生那一帧根本不进入画面。
(function () {
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

  // 折叠状态用的键：只按标题文字算。打扮之后 React 还会补节点、也会把标题换成另一颗，
  // 所以每次都要现读，不能把第一次算出来的键记死。
  // 先认 Canvas 自己的标题节点，认不到才用我们打过标记的那一行（findNotifTitle 的视觉猜测）。
  // 两种都要挑"有文字的那一颗"：Canvas 会先把标题节点插成空的，这时空节点不能算标题，
  // 否则真正显示标题的那一行会被当成正文隐掉，收起态就什么都不剩了
  function notifTitleEl(notif) {
    let first = null;
    for (const el of notif.querySelectorAll('.ic-notification__title, .header-bar-announcement__title, .canvas-notif-title')) {
      if (el.textContent.trim()) return el;
      if (!first) first = el;
    }
    return first;
  }

  function notifKeyFor(notif) {
    const el = notifTitleEl(notif);
    const text = el ? el.textContent.trim() : '';
    return text ? 'canvas_notif_collapsed_' + text.slice(0, 30).replace(/\s+/g, '_') : '';
  }

  // 把折叠"对"到记忆里的状态：重收一遍要隐的名单、重读一次键。
  // 这一步必须可以反复跑。以前只在打扮那一刻跑一次，而 React 会在我们之后往卡里补正文节点，
  // 那批新节点不在旧名单里，收起的卡就重新张开；标题文字当时还没填实的话，
  // 键也是按猜出来的那一行算的，记忆根本读不到（症状：默认展开，半秒后才收回上一次的状态）
  function syncCollapsed(notif) {
    const titleEl = notifTitleEl(notif);
    if (titleEl) titleEl.classList.add('canvas-notif-title');
    const key = notifKeyFor(notif);
    const collapsed = !!key && localStorage.getItem(key) === 'true';
    const hide = collectCollapseNodes(notif, [
      titleEl,
      notif.querySelector('.canvas-notif-meta'),
      notif.querySelector('.canvas-notif-rail'),
      notif.querySelector('.canvas-notif-accent-rail'),
      notif.querySelector('.canvas-notif-actions')
    ]);
    // 上一轮隐掉、这一轮不再该隐的节点要放回原样（标题换行、React 换个节点都会走到这里）
    const prev = notif._bcxHidden || [];
    const next = new Set(hide);
    for (const el of prev) if (!next.has(el) && el.isConnected) el.style.display = '';
    for (const el of hide) el.style.display = collapsed ? 'none' : '';
    notif._bcxHidden = hide;
    notif.classList.toggle('is-collapsed', collapsed);
    const btn = notif.querySelector('.canvas-notification-collapse-btn');
    if (btn) btn.title = collapsed ? 'Expand' : 'Collapse';
  }

  // 辅助函数：置顶全局通知增加折叠/展开功能，保持 Canvas 原生色框与大圆角，杜绝 UI 重叠
  function enhanceNotifications() {
    const notifications = document.querySelectorAll('#flash_message_holder .ic-notification, #content > .ic-notification, #main > .ic-notification, .ic-notification:not(#right-side *)');
    notifications.forEach(notif => {
      if (notif.closest('#right-side') || notif.closest('.recent_feedback')) return;
      if (!notif.getBoundingClientRect().width) return;
      if (!notif.dataset.canvasEnhanced) {
        // React 常常先把空壳插进来、下一帧才填正文。这时候量不到尺寸也认不出标题，
        // 硬打扮会往错的节点上装按钮。所以先放过这一张，等它有内容了随下一次变动再收。
        const titleEl = findNotifTitle(notif);
        if (!titleEl) return;
        notif.dataset.canvasEnhanced = 'true';

        // 注入折叠切换按钮
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'canvas-notification-collapse-btn';
        collapseBtn.setAttribute('aria-label', 'Toggle announcement');
        collapseBtn.innerHTML = `
          <svg viewBox="0 0 24 24" class="canvas-collapse-arrow">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
          </svg>
        `;

        const railEl = paintAccentRail(notif);
        stampNotifAccent(notif, railEl);
        titleEl.classList.add('canvas-notif-title');
        const metaEl = findNotifMeta(notif);
        if (metaEl) metaEl.classList.add('canvas-notif-meta');

        // 右上角按钮条：把原生关闭按钮接过来，和折叠按钮同排、同尺寸、同一套 hover
        const closeBtn = findCloseButton(notif);
        const actions = document.createElement('div');
        actions.className = 'canvas-notif-actions';
        notif.appendChild(actions);
        actions.appendChild(collapseBtn);
        if (closeBtn) actions.appendChild(closeBtn);

        collapseBtn.addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          const key = notifKeyFor(notif);
          if (!key) return;
          localStorage.setItem(key, notif.classList.contains('is-collapsed') ? 'false' : 'true');
          syncCollapsed(notif);
        });
      }
      syncCollapsed(notif);
    });
  }

  // 只在看得到公告卡的变动上才动手：整页别的节点增删直接跳过，
  // 这条监听会一直开着，不能每次都拿全页选择器扫一遍。
  function touchesNotification(record) {
    const added = record.addedNodes;
    for (let i = 0; i < added.length; i++) {
      const node = added[i];
      if (node.nodeType !== 1) continue;
      if (node.matches('.ic-notification, .ic-notification *')) return true;
      if (node.querySelector('.ic-notification')) return true;
    }
    // 卡已经在页面上、React 只是往里填文字：这时新增的是文本节点，上面那圈认不到，
    // 但被改的那个节点本身就长在卡里，所以再看一层归属
    let target = record.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    return !!(target && target.closest && target.closest('.ic-notification'));
  }

  const observer = new MutationObserver(records => {
    for (let i = 0; i < records.length; i++) {
      if (touchesNotification(records[i])) {
        try { enhanceNotifications(); }
        catch (e) { console.error('[BCX] 公告卡换皮失败', e); }
        return;
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
