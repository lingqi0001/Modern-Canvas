/**
 * Modern Canvas - Fast Recipient & Directory Picker
 * 极速人名/课程通讯录选择器（同时接管写信弹窗与收件箱主工具栏）
 *
 * 核心升级（100% 官方自适应架构）：
 * 1. 深度对接 Canvas 官方专属 GraphQL 引擎: GetInboxAddressBookRecipients
 *    - Level 1: Root (Courses / Groups / Users) —— 自动过滤往期结课
 *    - Level 2: 课程列表（直接由官方 GraphQL 返回当前活跃有效课程）
 *    - Level 3: 官方动态身份分类（全自适应 Teachers / Students / Observers / Sections / Groups / TAs 等）
 *    - Level 4: 角色成员名单（按需极速加载，带全员广播 Context Token）
 * 2. 彻底解决 1400+ 人全校大课发信限制：
 *    - All in Course 注入官方课程级 Token，交由 Canvas 服务端异步群发，永不卡 100 人分页
 * 3. 收件箱主界面精准联动：
 *    - 调取 React Fiber 原生 onSelectedIdsChange 生成 [User ✕] 药丸
 *    - 调取 onUserFilterSelect 自动触发聊天记录检索
 *    - 调取 setIsMenuOpen(false) 彻底杜绝原生卡顿白色菜单弹出
 */
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

  // 暂停状态下不接管原生选人组件
  var mcPausedUntil = '';
  try { mcPausedUntil = localStorage.getItem('mc_paused_until') || ''; } catch (e) {}
  if (mcPausedUntil) {
    if (mcPausedUntil === '-1' || mcPausedUntil === 'reload') return;
    var numUntil = Number(mcPausedUntil);
    if (numUntil && Date.now() < numUntil) return;
  }
  if (document.documentElement.classList.contains('mc-paused')) return;

  // 仅在 Conversations 页面运行
  if (!location.pathname.includes('/conversations')) return;

  // 官方专属 GraphQL 查询语句
  const GET_INBOX_ADDRESS_BOOK_RECIPIENTS_QUERY = `
query GetInboxAddressBookRecipients($userID: ID!, $context: String, $search: String, $afterUser: String, $afterContext: String, $courseContextCode: String!) {
  legacyNode(_id: $userID, type: User) {
    ... on User {
      id
      recipients(context: $context, search: $search) {
        sendMessagesAll
        contextsConnection(first: 20, after: $afterContext) {
          nodes {
            id
            name
            __typename
          }
          pageInfo {
            ...InboxPageInfo
            __typename
          }
          __typename
        }
        usersConnection(first: 20, after: $afterUser) {
          nodes {
            _id
            id
            name
            shortName
            pronouns
            sisId @include(if: false)
            observerEnrollmentsConnection(contextCode: $courseContextCode) {
              nodes {
                associatedUser {
                  _id
                  name
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          pageInfo {
            ...InboxPageInfo
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment InboxPageInfo on PageInfo {
  endCursor
  hasNextPage
  __typename
}
`;

  // 内存高速缓存（0毫秒二次打开）
  const cache = {
    coursesList: null,            // Array of { id, name }
    userGroups: null,             // Array of { id, name, members_count }
    courseRosters: new Map(),     // courseId -> Array<User>
    courseRoles: new Map(),       // courseId -> { rolesMap, sections }
    allUsers: null                // Array<User>
  };

  const gqlCache = new Map();     // GraphQL 结果内存缓存

  let activePicker = null;        // 当前打开的浮层 DOM 引用

  /* 加载态那一行：文字当场在，那颗圈等 200ms 才浮现 */
  function loadingHtml(label) {
    return '<div class="mcx-picker-loading"><span class="mcx-picker-spin" aria-hidden="true"></span><span>' + label + '</span></div>';
  }

  /* HTML 转义 */
  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* 渲染序列号，防止网络异步竞态覆盖 */
  let renderToken = 0;

  /* 获取当前用户 ID */
  let cachedUserId = null;
  async function getCurrentUserId() {
    if (cachedUserId) return cachedUserId;
    if (window.ENV?.current_user_id) return (cachedUserId = String(window.ENV.current_user_id));
    if (window.ENV?.CURRENT_USER_ID) return (cachedUserId = String(window.ENV.CURRENT_USER_ID));
    if (window.ENV?.current_user?.id) return (cachedUserId = String(window.ENV.current_user.id));
    if (window.ENV?.USER?.id) return (cachedUserId = String(window.ENV.USER.id));
    if (window.ENV?.user_id) return (cachedUserId = String(window.ENV.user_id));
    const meta = document.querySelector('meta[name="current-user-id"]');
    if (meta?.content) return (cachedUserId = meta.content);

    try {
      const res = await fetch('/api/v1/users/self');
      if (res.ok) {
        const data = await res.json();
        if (data?.id) return (cachedUserId = String(data.id));
      }
    } catch (e) {}

    return null;
  }

  /* 获取 CSRF Token */
  function getCsrfToken() {
    let token = window.ENV?.AUTHENTICITY_TOKEN || window.ENV?.CSRF_TOKEN || '';
    if (!token) {
      const m = document.cookie.match(/_csrf_token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    return token;
  }

  /**
   * 官方 GraphQL 请求引擎 (GetInboxAddressBookRecipients)
   */
  async function fetchAddressBookGraphQL(options = {}) {
    const {
      context = null,
      search = '',
      courseContextCode = '',
      afterUser = null,
      afterContext = null
    } = options;

    const userId = await getCurrentUserId();
    if (!userId) {
      console.warn('[MCX Picker] User ID not found');
      return null;
    }

    const cacheKey = `${userId}:${context || ''}:${search}:${courseContextCode}:${afterUser || ''}:${afterContext || ''}`;
    if (gqlCache.has(cacheKey)) {
      return gqlCache.get(cacheKey);
    }

    try {
      const csrfToken = getCsrfToken();
      const res = await fetch('/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          operationName: 'GetInboxAddressBookRecipients',
          query: GET_INBOX_ADDRESS_BOOK_RECIPIENTS_QUERY,
          variables: {
            userID: userId,
            context: context || null,
            search: search || '',
            courseContextCode: courseContextCode || '',
            afterUser: afterUser || null,
            afterContext: afterContext || null
          }
        })
      });

      if (!res.ok) {
        console.warn('[MCX Picker] GraphQL HTTP error:', res.status);
        return null;
      }
      const json = await res.json();
      if (json?.errors) {
        console.warn('[MCX Picker] GraphQL schema errors:', json.errors);
      }
      const recipients = json?.data?.legacyNode?.recipients;
      if (recipients) {
        gqlCache.set(cacheKey, recipients);
        return recipients;
      }
    } catch (e) {
      console.warn('[MCX Picker] GraphQL fetch failed, falling back:', e);
    }
    return null;
  }

  /* 头像按需加载 */
  const AVATAR_MAX_IN_FLIGHT = 8;
  let avatarInFlight = 0;
  let avatarPaused = false;
  let avatarBody = null;
  const avatarPending = new Set();
  let avatarWatcher = null;

  function avatarDistance(img) {
    if (!avatarBody) return 0;
    const box = avatarBody.getBoundingClientRect();
    const mid = img.getBoundingClientRect().top + img.offsetHeight / 2;
    if (mid >= box.top && mid <= box.bottom) return 0;
    return mid < box.top ? box.top - mid : mid - box.bottom;
  }

  function avatarStart(img) {
    const url = img.dataset.src;
    img.removeAttribute('data-src');
    avatarInFlight++;
    const settle = ok => {
      if (ok) img.classList.add('is-in');
      else img.remove();
      avatarInFlight--;
      drainAvatarQueue();
    };
    img.addEventListener('load', () => settle(true), { once: true });
    img.addEventListener('error', () => settle(false), { once: true });
    img.src = url;
  }

  function drainAvatarQueue() {
    if (avatarPaused || !avatarBody) return;
    let budget = AVATAR_MAX_IN_FLIGHT - avatarInFlight;
    if (budget <= 0) return;
    avatarPending.forEach(img => {
      if (!img.isConnected || !img.dataset.src) avatarPending.delete(img);
    });
    const ordered = Array.from(avatarPending)
      .map(img => [img, avatarDistance(img)])
      .sort((a, b) => a[1] - b[1]);
    for (const pair of ordered) {
      if (budget <= 0) break;
      budget--;
      avatarPending.delete(pair[0]);
      avatarStart(pair[0]);
    }
  }

  function queueAvatars(scope) {
    const bodyEl = scope.closest ? (scope.closest('.mcx-picker-body') || scope) : scope;
    avatarBody = bodyEl;
    if (!bodyEl._mcxAvatarGate) {
      bodyEl._mcxAvatarGate = true;
      let timer = null;
      bodyEl.addEventListener('scroll', () => {
        avatarPaused = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          avatarPaused = false;
          drainAvatarQueue();
        }, 120);
      }, { passive: true });
    }
    if (!avatarWatcher) {
      avatarWatcher = new IntersectionObserver(entries => {
        let woke = false;
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          avatarWatcher.unobserve(en.target);
          if (en.target.dataset.src) {
            avatarPending.add(en.target);
            woke = true;
          }
        });
        if (woke) drainAvatarQueue();
      }, { rootMargin: '200px' });
    }
    scope.querySelectorAll('img[data-src]').forEach(img => avatarWatcher.observe(img));
  }

  function avatarHtml(user, initials) {
    return `<div class="mcx-picker-avatar">${esc(initials)}` +
      (user.avatar_url ? `<img data-src="${esc(user.avatar_url)}" alt="" decoding="async" loading="lazy" />` : '') +
      '</div>';
  }

  /**
   * 数据规格化（同时兼容 GraphQL 与 REST 数据源）
   */
  function normalizeUser(item) {
    const uid = String(item._id || item.user_id || item.id);
    return {
      _id: uid,
      id: (item.id && String(item.id).length > 20) ? item.id : btoa('MessageableUser-' + uid),
      name: item.name || item.shortName || item.full_name || 'Unknown',
      pronouns: item.pronouns || '',
      avatar_url: item.avatar_url || item.avatarUrl || '',
      type: item.type || 'user',
      common_courses: item.common_courses || null,
      commonCoursesInfo: item.commonCoursesInfo || null,
      user_roles: item.user_roles || item.roles || null
    };
  }

  /**
   * 角色名称规格化（REST 回退方案用）
   */
  function formatRoleDisplayName(role) {
    if (!role) return 'Students';
    const r = String(role).trim();
    const map = {
      'TeacherEnrollment': 'Teachers',
      'StudentEnrollment': 'Students',
      'TaEnrollment': 'Teaching Assistants',
      'ObserverEnrollment': 'Observers',
      'DesignerEnrollment': 'Designers'
    };
    if (map[r]) return map[r];

    let clean = r.replace(/Enrollment$/i, '');
    clean = clean.replace(/([a-z])([A-Z])/g, '$1 $2');
    clean = clean.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (!clean.endsWith('s')) clean += 's';
    return clean;
  }

  /**
   * 角色与上下文图标匹配
   */
  function getContextSvgIcon(nodeId, nodeName) {
    const id = String(nodeId || '').toLowerCase();
    const name = String(nodeName || '').toLowerCase();

    if (id.endsWith('_teachers') || name.includes('teacher') || name.includes('instructor') || name.includes('ta') || name.includes('assistant')) {
      return `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
        </svg>
      `;
    }
    if (id.endsWith('_observers') || name.includes('observer') || name.includes('parent') || name.includes('guardian')) {
      return `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
        </svg>
      `;
    }
    if (id.endsWith('_sections') || name.includes('section') || name.includes('period')) {
      return `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/>
        </svg>
      `;
    }
    if (id.endsWith('_groups') || name.includes('group') || name.includes('club')) {
      return `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
        </svg>
      `;
    }
    return `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
      </svg>
    `;
  }

  /**
   * 判断输入框是否为非收件人输入框（如课程选择框、主题框、邮箱选择框、复选框等）
   */
  function isIgnoredInput(inp) {
    if (!inp) return true;
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'file' || inp.type === 'hidden' || inp.type === 'submit' || inp.type === 'button') {
      return true;
    }
    // 排除任何课程选择框 (All Courses 或 Compose 中的 Course)
    if (inp.matches && (
      inp.matches('[data-testid*="course"]') ||
      inp.matches('[id*="course"]') ||
      inp.matches('[name*="course"]') ||
      inp.matches('[name*="context"]')
    )) {
      return true;
    }
    // 排除邮箱选择框 (Inbox/Unread 等)
    if (inp.matches && (
      inp.matches('[data-testid*="mailbox"]') ||
      inp.matches('[id*="mailbox"]') ||
      inp.matches('[name*="mailbox"]')
    )) {
      return true;
    }
    // 排除主题输入框
    if (inp.matches && (
      inp.matches('[name*="subject"]') ||
      inp.matches('[id*="subject"]') ||
      inp.matches('[data-testid*="subject"]')
    )) {
      return true;
    }
    if (inp.placeholder && /subject|主题|course|课程/i.test(inp.placeholder)) {
      return true;
    }
    return false;
  }

  /**
   * 精准定位写信弹窗中的收件人 To 输入框（彻底避开 Course 选择框与 Subject 框）
   */
  function findComposeToInput(modal) {
    if (!modal) return null;
    // 1. 优先通过官方 testid
    const exact = modal.querySelector('input[data-testid="compose-modal-header-address-book-input"], input[data-testid*="address-book-input"]');
    if (exact && !isIgnoredInput(exact)) return exact;

    // 2. 紧邻 address-button 的输入框
    const addrBtn = modal.querySelector('[data-testid="address-button"]');
    if (addrBtn) {
      const container = addrBtn.closest('[data-cid*="Select"], [class*="-textInput"], [class*="-formControl"]') ||
                        addrBtn.closest('[class*="-view"], div, span, form');
      if (container) {
        const inp = container.querySelector('input');
        if (inp && !isIgnoredInput(inp)) return inp;
      }
    }

    // 3. 兜底扫描 modal 下所有 input，精确过滤掉课程与主题输入框
    const allInputs = Array.from(modal.querySelectorAll('input'));
    return allInputs.find(inp => !isIgnoredInput(inp)) || null;
  }

  /**
   * 干净清空原生输入框并同步 React 状态
   */
  function clearInputValue(input) {
    if (!input) return;
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(input, '');
      } else {
        input.value = '';
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      input.value = '';
    }
  }

  /**
   * 1. 深度解析并定位当前上下文中的收件人输入框（不管是主页面还是写信弹窗，不管是点输入框还是点通讯录按钮）
   */
  function resolveRecipientInput(target) {
    if (!target) return null;

    // 0. 全局坚决排除任何与收件人无关的元素：
    // - 课程选择（Toolbar 的 All Courses 或 Compose Modal 的 Course）
    // - 邮箱选择（Toolbar 的 Inbox/Unread/Starred 等）
    // - 顶部横条操作按钮（撰写 Compose、回复 Reply、全部回复 Reply-All、归档 Archive、删除 Delete、设置 Settings 等）
    // - 邮件会话内容区域（消息正文、会话列表、回复框、详情区）
    // - 任何多行文本输入框 (textarea) 或富文本框
    if (target.closest && (
      target.closest('[data-testid*="course-select"]') ||
      target.closest('[data-testid*="mailbox-select"]') ||
      target.closest('[id*="course-select"]') ||
      target.closest('[id*="mailbox-select"]') ||
      target.closest('[data-testid="compose-button"]') ||
      target.closest('[data-testid="compose"]') ||
      target.closest('[data-testid*="reply"]') ||
      target.closest('[data-testid*="archive"]') ||
      target.closest('[data-testid*="delete"]') ||
      target.closest('[data-testid*="settings"]') ||
      target.closest('[data-testid="message-detail-header-reply-btn"]') ||
      target.closest('[data-testid="message-detail-item-desktop"]') ||
      target.closest('#inbox-conversation-holder') ||
      target.closest('textarea') ||
      target.closest('[role="textbox"]')
    )) {
      return null;
    }

    // A. 写信弹窗上下文 (#compose-message-modal)
    const modal = target.closest ? target.closest('#compose-message-modal') : null;
    if (modal) {
      if (target.matches && isIgnoredInput(target)) {
        return null;
      }

      // 未选课程时严禁返回收件人输入框，防止任何自动弹窗或打字
      if (!isComposeCourseSelected(modal)) {
        return null;
      }

      const toInput = findComposeToInput(modal);
      if (!toInput) return null;

      // 如果点击的是写信弹窗中的通讯录按钮
      if (target.closest && target.closest('[data-testid="address-button"]')) {
        return toInput;
      }

      // 如果点击的是 To 输入框本体
      if (target === toInput || (toInput.contains && toInput.contains(target))) {
        return toInput;
      }

      // 如果点击的是 To 输入框的外层 facade 容器
      const facade = toInput.closest('span[class*="-textInput__facade"]') || toInput.parentElement;
      if (facade && (target === facade || facade.contains(target))) {
        return toInput;
      }

      // 弹窗内的其他元素一律返回 null
      return null;
    }

    // B. 收件箱主页面上下文
    // 1. 如果点击的是主页面的通讯录按钮
    const addrBtn = target.closest ? target.closest('[data-testid="address-button"]') : null;
    if (addrBtn) {
      return document.querySelector('input[data-testid="message-list-actions-address-book-input"]') ||
             document.querySelector('input[data-testid*="address-book-input"]');
    }

    // 2. 定位主页面搜索框
    const mainAddressInput = document.querySelector('input[data-testid="message-list-actions-address-book-input"]') ||
                             document.querySelector('input[data-testid*="address-book-input"]');

    if (mainAddressInput) {
      // 如果目标就是主页面搜索框
      if (target === mainAddressInput || (mainAddressInput.contains && mainAddressInput.contains(target))) {
        return mainAddressInput;
      }
      // 如果目标是该搜索框的 facade 胶囊外壳或其内部放大镜图标等子元素
      const facade = mainAddressInput.closest('span[class*="-textInput__facade"]') || mainAddressInput.parentElement;
      if (facade && (target === facade || facade.contains(target))) {
        return mainAddressInput;
      }
    }

    // 3. 如果当前 target 本身就是具有 address-book-input 属性的输入框
    if (target.matches && target.matches('input[data-testid*="address-book-input"]') && !isIgnoredInput(target)) {
      return target;
    }

    // 主页面其他任何地方一律返回 null，彻底避免误伤 All Courses、Inbox、撰写按钮、回复区等
    return null;
  }

  /**
   * 2. 获取写信弹窗的 React 核心控制器 (tI)
   */
  function getModalState() {
    const modal = document.querySelector('#compose-message-modal');
    if (!modal) return null;

    const candidates = [
      modal.querySelector('[data-cid="ModalBody"]'),
      modal.querySelector('[data-testid="compose-modal-desktop"]'),
      modal.querySelector('[data-testid="compose-modal-header-address-book-input"]'),
      findComposeToInput(modal),
      modal.querySelector('[data-testid="address-button"]'),
      modal
    ].filter(Boolean);

    for (const el of candidates) {
      let cur = el;
      let fiberKey = null;
      while (cur && !fiberKey) {
        fiberKey = Object.getOwnPropertyNames(cur).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (!fiberKey) cur = cur.parentElement;
      }
      if (!fiberKey || !cur) continue;

      let fiber = cur[fiberKey];
      let depth = 0;
      while (fiber && depth < 60) {
        depth++;
        const p = fiber.memoizedProps;
        if (p && typeof p.onSelectedIdsChange === 'function') {
          return {
            fiber: fiber,
            props: p,
            selectedIds: Array.isArray(p.selectedIds) ? p.selectedIds : [],
            onSelectedIdsChange: p.onSelectedIdsChange
          };
        }
        fiber = fiber.return;
      }
    }
    return null;
  }

  /**
   * 2. 获取课程列表（优先使用官方 GraphQL 专有通道，100% 官方有效活跃课程）
   */
  async function fetchCoursesList() {
    if (cache.coursesList) return cache.coursesList;

    // 1. 尝试官方 GraphQL 接口 (GetInboxAddressBookRecipients)
    const gqlData = await fetchAddressBookGraphQL({ context: null });
    if (gqlData?.contextsConnection?.nodes && Array.isArray(gqlData.contextsConnection.nodes)) {
      const courses = gqlData.contextsConnection.nodes.map(n => ({
        id: n.id,
        name: n.name
      }));
      if (courses.length > 0) {
        cache.coursesList = courses;
        return courses;
      }
    }

    // 2. 备用：REST API 过滤往期结课
    try {
      const [activeCoursesRes, recipientsRes] = await Promise.allSettled([
        fetch('/api/v1/courses?enrollment_state=active&state[]=available&per_page=50'),
        fetch('/api/v1/search/recipients?search=&per_page=50')
      ]);

      const activeCourseIds = new Set();
      if (activeCoursesRes.status === 'fulfilled' && activeCoursesRes.value.ok) {
        const activeData = await activeCoursesRes.value.json();
        if (Array.isArray(activeData)) {
          activeData.forEach(c => {
            activeCourseIds.add(String(c.id));
            activeCourseIds.add('course_' + c.id);
          });
        }
      }

      let list = [];
      if (recipientsRes.status === 'fulfilled' && recipientsRes.value.ok) {
        const data = await recipientsRes.value.json();
        if (Array.isArray(data)) {
          list = data.filter(d => {
            const isCourse = d.type === 'context' || String(d.id).startsWith('course_');
            if (!isCourse) return false;
            if (activeCourseIds.size > 0) {
              const rawId = String(d.id).replace('course_', '');
              return activeCourseIds.has(rawId) || activeCourseIds.has(String(d.id));
            }
            return true;
          });
        }
      }

      cache.coursesList = list;
      return list;
    } catch (e) {
      console.warn('[MCX Picker] Failed to fetch courses list:', e);
      return [];
    }
  }

  /**
   * 3. 动态获取用户参与的学生群组/社团 (Groups)
   */
  async function fetchUserGroups() {
    if (cache.userGroups) return cache.userGroups;
    try {
      const res = await fetch('/api/v1/users/self/groups?per_page=50');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          cache.userGroups = data.map(g => ({
            id: g.id,
            name: g.name,
            members_count: g.members_count || 0
          }));
          return cache.userGroups;
        }
      }
    } catch (e) {}
    cache.userGroups = [];
    return [];
  }

  /**
   * 4. 获取群组成员名单
   */
  async function fetchGroupMembers(groupId) {
    try {
      const res = await fetch(`/api/v1/groups/${groupId}/users?per_page=100`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map(normalizeUser);
        }
      }
    } catch (e) {}
    return [];
  }

  /**
   * 5. 获取指定课程的成员花名册（REST 回退方案）
   */
  async function fetchCourseRoster(courseId) {
    const rawCourseId = String(courseId).replace('course_', '');
    if (cache.courseRosters.has(rawCourseId)) {
      return cache.courseRosters.get(rawCourseId);
    }
    try {
      const res = await fetch(`/api/v1/search/recipients?context=${encodeURIComponent('course_' + rawCourseId)}&per_page=100`);
      const data = await res.json();
      const roster = Array.isArray(data)
        ? data.filter(d => d.type !== 'context').map(normalizeUser)
        : [];
      cache.courseRosters.set(rawCourseId, roster);
      return roster;
    } catch (e) {
      console.error('[MCX Picker] Failed to fetch course roster:', e);
      return [];
    }
  }

  /**
   * 6. REST 回退：动态探测课程内身份角色
   */
  async function fetchCourseRolesData(course) {
    const rawCourseId = String(course.id).replace('course_', '');
    if (cache.courseRoles.has(rawCourseId)) {
      return cache.courseRoles.get(rawCourseId);
    }

    const roster = await fetchCourseRoster(course.id);
    const rolesMap = new Map();

    roster.forEach(u => {
      let roles = [];
      if (u.common_courses && typeof u.common_courses === 'object') {
        roles = u.common_courses[rawCourseId] || u.common_courses['course_' + rawCourseId] || [];
      } else if (Array.isArray(u.commonCoursesInfo)) {
        const match = u.commonCoursesInfo.find(c => String(c.course_id || c.id) === rawCourseId);
        if (match && match.roles) roles = match.roles;
      } else if (u.user_roles) {
        roles = Array.isArray(u.user_roles) ? u.user_roles : [u.user_roles];
      }

      if (!Array.isArray(roles) || roles.length === 0) {
        roles = ['StudentEnrollment'];
      }

      roles.forEach(rawRole => {
        const displayName = formatRoleDisplayName(rawRole);
        if (!rolesMap.has(displayName)) {
          rolesMap.set(displayName, []);
        }
        const arr = rolesMap.get(displayName);
        if (!arr.some(x => x._id === u._id)) {
          arr.push(u);
        }
      });
    });

    if (!rolesMap.has('Teachers') || rolesMap.get('Teachers').length === 0) {
      try {
        const tRes = await fetch(`/api/v1/courses/${rawCourseId}/users?enrollment_type[]=teacher&enrollment_type[]=ta&per_page=50`);
        if (tRes.ok) {
          const tData = await tRes.json();
          if (Array.isArray(tData) && tData.length > 0) {
            const teachersList = tData.map(normalizeUser);
            rolesMap.set('Teachers', teachersList);
            if (rolesMap.has('Students')) {
              const studentsList = rolesMap.get('Students').filter(s => !teachersList.some(t => t._id === s._id));
              rolesMap.set('Students', studentsList);
            }
          }
        }
      } catch (err) {}
    }

    let sections = [];
    try {
      const sRes = await fetch(`/api/v1/courses/${rawCourseId}/sections?per_page=50`);
      if (sRes.ok) {
        const sData = await sRes.json();
        if (Array.isArray(sData)) {
          sections = sData.filter(s => s.name).map(s => ({
            id: s.id,
            name: s.name,
            total_students: s.total_students || 0
          }));
        }
      }
    } catch (err) {}

    let groups = [];
    try {
      const gRes = await fetch(`/api/v1/courses/${rawCourseId}/groups?per_page=50`);
      if (gRes.ok) {
        const gData = await gRes.json();
        if (Array.isArray(gData)) {
          groups = gData.filter(g => g.name).map(g => ({
            id: g.id,
            name: g.name,
            members_count: g.members_count || 0
          }));
        }
      }
    } catch (err) {}

    const result = { rolesMap, sections, groups };
    cache.courseRoles.set(rawCourseId, result);
    return result;
  }

  /**
   * 7. 获取全部联系人
   */
  async function fetchAllUsers() {
    if (cache.allUsers && cache.allUsers.length > 0) return cache.allUsers;

    try {
      const courses = await fetchCoursesList();
      const userMap = new Map();

      const rosterPromises = courses.slice(0, 10).map(c => fetchCourseRoster(c.id));
      const rosters = await Promise.allSettled(rosterPromises);

      rosters.forEach(r => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          r.value.forEach(u => {
            if (!userMap.has(u._id)) {
              userMap.set(u._id, u);
            }
          });
        }
      });

      const aggregated = Array.from(userMap.values());
      aggregated.sort((a, b) => a.name.localeCompare(b.name));
      cache.allUsers = aggregated;
      return aggregated;
    } catch (e) {
      console.error('[MCX Picker] Failed to aggregate users:', e);
      return [];
    }
  }

  let bypassingCourseChangeConfirm = false;
  let activeChangeConfirmOverlay = null;
  let activeHintToastTimer = null;

  /**
   * 获取写信弹窗中 Course 下拉框的交互触发节点（facade 或 input）
   */
  function getModalCourseTrigger(modal) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return null;
    const inp = modal.querySelector('[data-testid="course-select-modal"], [data-testid*="course-select"], input[name="context_code"], input[name*="course"]');
    if (inp) {
      const facade = inp.closest('span[class*="-textInput__facade"]') ||
                     inp.closest('span[class*="textInput"]') ||
                     inp.closest('div[class*="-view"]') ||
                     inp.parentElement;
      return facade || inp;
    }
    const labels = Array.from(modal.querySelectorAll('label'));
    const courseLabel = labels.find(l => /^course/i.test((l.textContent || '').trim()));
    if (courseLabel) {
      return courseLabel.querySelector('span[class*="-textInput__facade"], input, select, button') || courseLabel;
    }
    return null;
  }

  /**
   * 8. 获取写信弹窗中已预选的课程 ID
   */
  function getModalSelectedCourseContext() {
    const modal = document.querySelector('#compose-message-modal');
    if (!modal) return null;

    const hiddenContext = modal.querySelector('input[type="hidden"][name="context_code"]');
    if (hiddenContext && hiddenContext.value && (hiddenContext.value.startsWith('course_') || hiddenContext.value.startsWith('group_'))) {
      return hiddenContext.value;
    }

    const courseInput = modal.querySelector('[data-testid="course-select-modal"], [data-testid*="course-select"], input[name="context_code"], input[name*="course"]');
    const courseName = courseInput ? courseInput.value.trim() : '';
    if (!courseName || /^(select course|选择课程|select a course)$/i.test(courseName)) return null;

    const fiberKey = courseInput ? Object.getOwnPropertyNames(courseInput).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')) : null;
    if (fiberKey) {
      let f = courseInput[fiberKey];
      while (f) {
        const p = f.memoizedProps;
        if (p) {
          const opt = p.selectedOption || p.selectedItem || p.value;
          if (opt && opt.id && (String(opt.id).startsWith('course_') || String(opt.id).startsWith('group_'))) return opt.id;
          if (typeof opt === 'string' && (opt.startsWith('course_') || opt.startsWith('group_'))) return opt;
        }
        f = f.return;
      }
    }

    if (cache.coursesList) {
      const hit = cache.coursesList.find(c => c.name && (c.name.includes(courseName) || courseName.includes(c.name)));
      return hit ? hit.id : null;
    }
    return null;
  }

  /**
   * 检查写信弹窗当前是否已选好有效课程
   */
  function isComposeCourseSelected(modal) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return false;

    // 1. 检查是否存在官方课程错误提示 "Please select a course" / "请选择课程"
    const hasCourseError = Array.from(modal.querySelectorAll('[class*="inline-alert"], [class*="errorMessage"], [class*="feedback"], div, span, p')).some(el => {
      const txt = (el.textContent || '').trim().toLowerCase();
      return (txt === 'please select a course' || txt === '请选择课程') && el.offsetParent !== null;
    });
    if (hasCourseError) {
      return false;
    }

    // 2. 检查是否有有效课程上下文
    const courseId = getModalSelectedCourseContext();
    if (courseId) return true;

    // 3. 检查 Course 输入框的实际文字
    const courseInput = modal.querySelector('[data-testid="course-select-modal"], [data-testid*="course-select"], input[name="context_code"], input[name*="course"]');
    if (courseInput) {
      const val = (courseInput.value || '').trim();
      if (!val || /^(select course|选择课程|select a course)$/i.test(val)) {
        return false;
      }
      return true;
    }

    // 4. 原生 select 兜底
    const sel = modal.querySelector('select[name="context_code"], select[name*="course"]');
    if (sel) {
      return !!sel.value && sel.value !== '' && sel.value !== '0';
    }

    return false;
  }

  /**
   * 获取写信弹窗中当前已选收件人数量
   */
  function getComposeRecipientsCount(modal) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return 0;

    const state = getModalState();
    if (state && Array.isArray(state.selectedIds) && state.selectedIds.length > 0) {
      return state.selectedIds.length;
    }

    const toInput = findComposeToInput(modal);
    if (toInput) {
      const toRow = toInput.closest('[data-cid*="Select"], [class*="-textInput"], [class*="-formControl"]') ||
                    toInput.closest('[class*="-view"], div, form');
      if (toRow) {
        const pills = toRow.querySelectorAll('span[data-cid*="Pill"], span[data-cid*="Tag"], span[class*="pill"], span[class*="tag"], .mcx-filter-pill');
        if (pills.length > 0) return pills.length;
        const removeButtons = toRow.querySelectorAll('button[aria-label*="Remove"], button[aria-label*="Delete"], button[aria-label*="remove"], button[class*="close"]');
        if (removeButtons.length > 0) return removeButtons.length;
      }
    }

    return 0;
  }

  /**
   * 提示用户必须先选择课程的浮动气泡与高亮引导
   */
  function showCourseRequiredHint(modal, anchorEl) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return;

    document.querySelectorAll('.mcx-course-hint-toast').forEach(t => t.remove());
    if (activeHintToastTimer) {
      clearTimeout(activeHintToastTimer);
      activeHintToastTimer = null;
    }

    const courseTrigger = getModalCourseTrigger(modal);
    if (courseTrigger) {
      courseTrigger.classList.remove('mcx-pulse-highlight');
      void courseTrigger.offsetWidth;
      courseTrigger.classList.add('mcx-pulse-highlight');
      setTimeout(() => {
        courseTrigger.classList.remove('mcx-pulse-highlight');
      }, 1800);
    }

    const target = anchorEl || findComposeToInput(modal) || modal.querySelector('[data-testid="address-button"]') || courseTrigger;
    if (!target) return;

    const toast = document.createElement('div');
    toast.className = 'mcx-course-hint-toast';
    toast.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>
      <span>Choose a course first</span>
    `;

    modal.appendChild(toast);

    const modalRect = modal.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    toast.style.left = Math.max(16, Math.min(targetRect.left - modalRect.left, modalRect.width - 300)) + 'px';
    toast.style.top = Math.max(10, Math.round(targetRect.bottom - modalRect.top + 6)) + 'px';

    activeHintToastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-4px)';
      setTimeout(() => toast.remove(), 250);
    }, 2500);
  }

  /**
   * 当用户已有收件人并试图更换课程时，弹出二次确认对话框
   */
  function promptChangeCourseConfirm(modal, onConfirm) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return;
    if (activeChangeConfirmOverlay) return;

    const recipientCount = getComposeRecipientsCount(modal);

    const overlay = document.createElement('div');
    overlay.className = 'mcx-course-change-overlay';
    overlay.innerHTML = `
      <div class="mcx-course-change-modal">
        <div class="mcx-change-modal-header">
          <div class="mcx-change-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
            </svg>
          </div>
          <div class="mcx-change-title">Change Course?</div>
        </div>
        <div class="mcx-change-desc">
          Changing the course will remove all <strong>${recipientCount > 0 ? recipientCount : ''}</strong> currently selected recipient(s). Are you sure you want to change course?<br>
          <span style="font-size: 12px; opacity: 0.8; margin-top: 6px; display: block;">更换课程将清空当前已选的收件人，是否继续？</span>
        </div>
        <div class="mcx-change-actions">
          <button type="button" class="mcx-change-btn mcx-change-cancel">Cancel</button>
          <button type="button" class="mcx-change-btn mcx-change-confirm">Clear & Change</button>
        </div>
      </div>
    `;

    modal.appendChild(overlay);
    activeChangeConfirmOverlay = overlay;

    const closeDialog = () => {
      if (activeChangeConfirmOverlay) {
        activeChangeConfirmOverlay.remove();
        activeChangeConfirmOverlay = null;
      }
    };

    overlay.querySelector('.mcx-change-cancel').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    });

    overlay.querySelector('.mcx-change-confirm').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
    });
  }

  /**
   * 清空写信弹窗中的所有已选收件人
   */
  function clearComposeRecipients(modal) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return;

    const state = getModalState();
    if (state && typeof state.onSelectedIdsChange === 'function') {
      try { state.onSelectedIdsChange([]); } catch (e) {}
    }

    const toInput = findComposeToInput(modal);
    if (toInput) {
      clearInputValue(toInput);
      const toRow = toInput.closest('[class*="-view"], div, form');
      if (toRow) {
        toRow.querySelectorAll('.mcx-filter-pill').forEach(el => el.remove());
        toRow.querySelectorAll('button[aria-label*="Remove"], button[aria-label*="Delete"], button[class*="close"]').forEach(btn => {
          try { btn.click(); } catch (e) {}
        });
      }
    }
  }

  /**
   * 动态同步写信弹窗中 To 输入框及通讯录按钮的锁定/启用状态
   */
  function syncComposeModalLockState(modal) {
    if (!modal) modal = document.querySelector('#compose-message-modal');
    if (!modal) return;

    const isSelected = isComposeCourseSelected(modal);
    const toInput = findComposeToInput(modal);
    if (!toInput) return;

    const toRow = toInput.closest('[data-cid*="Select"], [class*="-textInput"], [class*="-formControl"]') ||
                  toInput.closest('span[class*="-textInput__facade"]') ||
                  toInput.parentElement;

    if (!isSelected) {
      if (toRow && !toRow.classList.contains('mcx-to-locked')) {
        toRow.classList.add('mcx-to-locked');
      }
      toInput.placeholder = 'Choose a course first…';
      toInput.setAttribute('aria-disabled', 'true');
    } else {
      if (toRow && toRow.classList.contains('mcx-to-locked')) {
        toRow.classList.remove('mcx-to-locked');
      }
      if (toInput.placeholder === 'Choose a course first…') {
        toInput.placeholder = 'Search for people to add…';
      }
      toInput.removeAttribute('aria-disabled');
    }
  }

  /**
   * 压制原生残留的通讯录菜单 DOM（严格保护 All Courses 与 Inbox 菜单，绝不误伤）
   */
  function suppressNativeMenus() {
    const courseControls = [
      document.querySelector('[data-testid*="course-select"]')?.getAttribute('aria-controls'),
      document.querySelector('[data-testid*="course-select"]')?.getAttribute('aria-owns'),
      document.querySelector('[data-testid*="course-select-modal"]')?.getAttribute('aria-controls'),
      document.querySelector('[data-testid*="course-select-modal"]')?.getAttribute('aria-owns')
    ].filter(Boolean);

    const mailboxControls = [
      document.querySelector('[data-testid*="mailbox-select"]')?.getAttribute('aria-controls'),
      document.querySelector('[data-testid*="mailbox-select"]')?.getAttribute('aria-owns')
    ].filter(Boolean);

    const addrControls = [
      document.querySelector('[data-testid="address-button"]')?.getAttribute('aria-controls'),
      document.querySelector('[data-testid="address-button"]')?.getAttribute('aria-owns'),
      document.querySelector('[data-testid*="address-book-input"]')?.getAttribute('aria-controls'),
      document.querySelector('[data-testid*="address-book-input"]')?.getAttribute('aria-owns')
    ].filter(Boolean);

    document.querySelectorAll('[data-position-content], span[class*="-popover__content"]').forEach(el => {
      // 1. 绝对保护邮箱选择菜单 (Mailbox)，绝不压制，若被误设为 none 则恢复
      if (mailboxControls.some(id => el.id === id || el.querySelector('#' + id)) ||
          el.querySelector('[data-testid*="mailbox"]') ||
          el.querySelector('[id*="mailbox"]')) {
        if (el.style.display === 'none') el.style.display = '';
        return;
      }
      const text = el.textContent || '';
      if (/Inbox|Unread|Starred|Sent|Archived|Submission Comments|收件箱|未读|加星标|已发送|已归档/i.test(text)) {
        if (el.style.display === 'none') el.style.display = '';
        return;
      }

      // 2. 绝对保护课程选择菜单 (Course Select)，绝不压制，若被误设为 none 则恢复
      if (courseControls.some(id => el.id === id || el.querySelector('#' + id)) ||
          el.querySelector('[data-testid*="course-select"]') ||
          el.querySelector('[id*="course-select"]')) {
        if (el.style.display === 'none') el.style.display = '';
        return;
      }
      if (text.includes('All Courses') || text.includes('全部课程')) {
        if (el.style.display === 'none') el.style.display = '';
        return;
      }

      // 3. 绝对保护会话详情工具栏等非通讯录的弹出层
      if (el.querySelector('[data-testid*="message-detail"]')) {
        return;
      }

      // 4. 仅精准压制明确属于通讯录的宿主 popover 或加载中菊花
      const isAddrPopover = addrControls.some(id => el.id === id || el.querySelector('#' + id)) ||
                            el.querySelector('[data-testid*="address-book"]') ||
                            el.querySelector('[id*="address-book"]');

      if (isAddrPopover || (activePicker && (el.querySelector('[data-cid*="Spinner"]') || el.querySelector('[role="progressbar"]')))) {
        el.style.display = 'none';
      }
    });
  }

  /**
   * 9. 打开全能分级选择浮层 (Hierarchical Picker)
   */
  function openPicker(anchorBtn) {
    if (activePicker) {
      closeFastPicker();
      return;
    }

    suppressNativeMenus();

    const isCompose = !!anchorBtn.closest('#compose-message-modal');
    const mode = isCompose ? 'compose' : 'filter';
    const modalState = isCompose ? getModalState() : null;

    // 是否通过独立的通讯录/名单按钮 (address-button) 打开
    const isButtonTrigger = !!(anchorBtn && anchorBtn.closest && anchorBtn.closest('[data-testid="address-button"]'));
    // 单独点击名单按钮打开时显示搜索框；若是原生搜索框打字呼出则作为纯结果下拉，不重复显示内部搜索框
    const showPickerSearch = isButtonTrigger;

    // 统一使用 resolveRecipientInput 解析出宿主输入框
    const hostInput = resolveRecipientInput(anchorBtn);

    const selectedMap = new Map();
    if (isCompose && modalState) {
      (modalState.selectedIds || []).forEach(item => {
        selectedMap.set(String(item._id || item.id), item);
      });
    }

    const picker = document.createElement('div');
    picker.className = 'mcx-recipient-picker';
    activePicker = picker;

    // 防止点击面板内部夺走输入框焦点
    picker.addEventListener('mousedown', e => e.preventDefault());
    document.documentElement.classList.add('mcx-picker-active');
    if (mode === 'filter') {
      document.documentElement.classList.add('mcx-filter-live');
    }

    if (isCompose) {
      const modal = document.querySelector('#compose-message-modal');
      modal.appendChild(picker);

      // 动态根据 To 输入框位置精确定位在其正下方，而不是写死固定高度
      const targetAnchor = hostInput || anchorBtn || modal.querySelector('[data-testid="address-button"]');
      if (targetAnchor) {
        const modalRect = modal.getBoundingClientRect();
        const anchorFacade = targetAnchor.closest ? (targetAnchor.closest('span[class*="-textInput__facade"]') || targetAnchor) : targetAnchor;
        const anchorRect = anchorFacade.getBoundingClientRect();
        picker.style.position = 'absolute';
        picker.style.top = Math.max(100, Math.round(anchorRect.bottom - modalRect.top + 6)) + 'px';
        picker.style.left = Math.max(16, Math.round(anchorRect.left - modalRect.left)) + 'px';
        picker.style.width = Math.min(480, Math.round(modalRect.width - 32)) + 'px';
        picker.style.right = 'auto';
        picker.style.margin = '0';
      }
    } else {
      document.body.appendChild(picker);
      const pill = hostInput && hostInput.closest
        ? (hostInput.closest('span[class*="-textInput__facade"]') || hostInput)
        : null;
      const dropRect = anchorBtn.getBoundingClientRect();
      const leftRect = (pill || anchorBtn).getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.top = (dropRect.bottom + 8) + 'px';
      picker.style.left = Math.max(16, Math.min(leftRect.left, window.innerWidth - 456)) + 'px';
      picker.style.width = '440px';
      /* 关键两行：样式表那条 .mcx-recipient-picker 带着 right:24px + margin:0 auto（写信弹窗居中用的）。
         绝对定位下 left／right／width 三者都指定时 margin:auto 会赢、我们写的 left 被忽略＝整块被居中，
         看着就是偏右。所以 right 和 margin 要一起撤掉 */
      picker.style.right = 'auto';
      picker.style.margin = '0';
    }

    let viewStack = [];
    let currentView = { level: 'root', title: mode === 'compose' ? 'Choose people' : 'Find conversations' };

    const preselectedCourseId = isCompose ? getModalSelectedCourseContext() : null;
    if (preselectedCourseId && cache.coursesList) {
      const courseObj = cache.coursesList.find(c => c.id === preselectedCourseId) || { id: preselectedCourseId, name: 'Current Course' };
      viewStack.push(currentView);
      currentView = { level: 'course_roles', title: courseObj.name, course: courseObj };
    }

    picker.innerHTML = `
      <div class="mcx-picker-header">
        <div class="mcx-picker-header-left">
          <button type="button" class="mcx-picker-back" style="display: none;" aria-label="Back">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
            </svg>
            <span>Back</span>
          </button>
          <div class="mcx-picker-title">
            <span id="mcx-header-title">${esc(currentView.title)}</span>
            ${mode === 'compose' ? `<span class="mcx-picker-badge" id="mcx-picker-count">${selectedMap.size} people selected</span>` : ''}
          </div>
        </div>
        <button type="button" class="mcx-picker-close" aria-label="Close">&times;</button>
      </div>

      ${showPickerSearch ? `<div class="mcx-picker-search-wrap">
        <svg class="mcx-picker-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input type="text" class="mcx-picker-search-input" placeholder="Search people or courses…" autofocus />
      </div>` : ''}

      <div class="mcx-picker-body">
        ${loadingHtml('Loading people and courses…')}
      </div>

      <div class="mcx-picker-footer" style="${mode === 'filter' ? 'display: none;' : 'display: flex;'}">
        <div class="mcx-picker-actions-left">
          <button type="button" class="mcx-picker-text-btn" id="mcx-picker-select-all">Select all</button>
          <button type="button" class="mcx-picker-text-btn" id="mcx-picker-clear-all">Clear</button>
        </div>
        <div class="mcx-picker-actions-right">
          <button type="button" class="mcx-picker-submit-btn">${selectedMap.size > 0 ? `Add ${selectedMap.size} people` : 'Add selected people'}</button>
        </div>
      </div>
    `;

    const backBtn = picker.querySelector('.mcx-picker-back');
    const titleEl = picker.querySelector('#mcx-header-title');
    const countBadge = picker.querySelector('#mcx-picker-count');
    const pickerSearchInput = picker.querySelector('.mcx-picker-search-input');
    const searchInput = showPickerSearch ? pickerSearchInput : hostInput;
    const bodyEl = picker.querySelector('.mcx-picker-body');
    const footerEl = picker.querySelector('.mcx-picker-footer');

    function updateCount() {
      if (countBadge) countBadge.textContent = `${selectedMap.size} people selected`;
      const doneBtn = picker.querySelector('.mcx-picker-submit-btn');
      if (doneBtn) {
        doneBtn.textContent = selectedMap.size > 0 ? `Add ${selectedMap.size} people` : 'Add selected people';
      }
    }

    picker.querySelector('.mcx-picker-close').addEventListener('click', closeFastPicker);
    if (mode === 'compose') {
      picker.querySelector('.mcx-picker-submit-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentModalState = getModalState();
        applyComposeSelection(currentModalState || modalState, selectedMap);
        if (hostInput) {
          clearInputValue(hostInput);
        }
        closeFastPicker();
      });
      picker.querySelector('#mcx-picker-clear-all').addEventListener('click', () => {
        selectedMap.clear();
        updateCount();
        if (currentSearchQuery) {
          handleSearch(currentSearchQuery);
        } else {
          renderView();
        }
      });
    }

    backBtn.addEventListener('click', () => {
      if (viewStack.length > 0) {
        currentView = viewStack.pop();
        searchInput.value = '';
        renderView();
      }
    });

    function navigateTo(view) {
      viewStack.push(currentView);
      currentView = view;
      searchInput.value = '';
      renderView();
    }

    /**
     * 主视图渲染分发
     */
    async function renderView() {
      if (currentSearchQuery) return;
      const myToken = ++renderToken;
      titleEl.textContent = currentView.title;
      backBtn.style.display = viewStack.length > 0 ? 'inline-flex' : 'none';

      if (mode === 'compose') {
        footerEl.style.display = 'flex';
      } else {
        footerEl.style.display = 'none';
      }

      bodyEl.innerHTML = loadingHtml('Loading…');

      switch (currentView.level) {
        case 'root':
          await renderRootView(myToken);
          break;
        case 'courses':
          await renderCoursesListView(myToken);
          break;
        case 'course_roles':
          await renderCourseRolesView(currentView.course, myToken);
          break;
        case 'context_node':
          await renderContextNodeView(currentView.course, currentView.node, myToken);
          break;
        case 'role_members':
          await renderRoleMembersView(currentView.course, currentView.role, currentView.members, myToken);
          break;
        case 'course_sections':
          await renderCourseSectionsView(currentView.course, currentView.sections, myToken);
          break;
        case 'course_groups':
          await renderCourseGroupsView(currentView.course, currentView.groups, myToken);
          break;
        case 'section_members':
          await renderSectionMembersView(currentView.course, currentView.section, myToken);
          break;
        case 'groups':
          await renderGroupsListView(myToken);
          break;
        case 'group_members':
          await renderGroupMembersView(currentView.group, myToken);
          break;
        case 'users':
          await renderUsersListView(myToken);
          break;
      }
    }

    /**
     * Level 1：Root 根目录
     */
    async function renderRootView(myToken) {
      const userGroups = await fetchUserGroups();
      if (currentSearchQuery || (myToken && myToken !== renderToken)) return;

      let groupsHtml = '';
      if (userGroups && userGroups.length > 0) {
        groupsHtml = `
          <div class="mcx-picker-nav-row" id="mcx-nav-groups">
            <div class="mcx-picker-nav-left">
              <div class="mcx-picker-nav-icon">
                ${getContextSvgIcon('_groups', 'Groups')}
              </div>
              <div class="mcx-picker-nav-meta">
                <span class="mcx-picker-nav-title">Groups</span>
                <span class="mcx-picker-nav-desc">${userGroups.length} student groups & clubs</span>
              </div>
            </div>
            <span class="mcx-picker-chevron">&rsaquo;</span>
          </div>
        `;
      }

      bodyEl.innerHTML = `
        <div class="mcx-picker-list">
          <div class="mcx-picker-nav-row" id="mcx-nav-courses">
            <div class="mcx-picker-nav-left">
              <div class="mcx-picker-nav-icon">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/>
                </svg>
              </div>
              <div class="mcx-picker-nav-meta">
                <span class="mcx-picker-nav-title">Courses</span>
                <span class="mcx-picker-nav-desc">Browse rosters by active course</span>
              </div>
            </div>
            <span class="mcx-picker-chevron">&rsaquo;</span>
          </div>

          ${groupsHtml}

          <div class="mcx-picker-nav-row" id="mcx-nav-users">
            <div class="mcx-picker-nav-left">
              <div class="mcx-picker-nav-icon">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                </svg>
              </div>
              <div class="mcx-picker-nav-meta">
                <span class="mcx-picker-nav-title">Users</span>
                <span class="mcx-picker-nav-desc">Browse all contacts</span>
              </div>
            </div>
            <span class="mcx-picker-chevron">&rsaquo;</span>
          </div>
        </div>
      `;

      bodyEl.querySelector('#mcx-nav-courses').addEventListener('click', () => {
        navigateTo({ level: 'courses', title: 'Browse courses' });
      });

      const groupsBtn = bodyEl.querySelector('#mcx-nav-groups');
      if (groupsBtn) {
        groupsBtn.addEventListener('click', () => {
          navigateTo({ level: 'groups', title: 'Browse groups' });
        });
      }

      bodyEl.querySelector('#mcx-nav-users').addEventListener('click', () => {
        navigateTo({ level: 'users', title: 'All people' });
      });
    }

    /**
     * Level 2：Courses 列表（已过滤掉往期结课）
     */
    async function renderCoursesListView() {
      const token = ++renderToken;
      const courses = await fetchCoursesList();
      if (currentSearchQuery || token !== renderToken) return;
      if (courses.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No active courses available.</div>`;
        return;
      }

      bodyEl.innerHTML = '';
      const listEl = document.createElement('div');
      listEl.className = 'mcx-picker-list';

      courses.forEach(c => {
        const row = document.createElement('div');
        row.className = 'mcx-picker-nav-row';
        row.innerHTML = `
          <div class="mcx-picker-nav-left" style="overflow: hidden;">
            <div class="mcx-picker-nav-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
              </svg>
            </div>
            <div class="mcx-picker-nav-meta" style="overflow: hidden;">
              <span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(c.name)}</span>
              ${c.user_count ? `<span class="mcx-picker-nav-desc">${c.user_count} members</span>` : ''}
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;

        row.addEventListener('click', () => {
          navigateTo({ level: 'course_roles', title: c.name, course: c });
        });

        listEl.appendChild(row);
      });

      bodyEl.appendChild(listEl);

      queueAvatars(listEl);
    }

    /**
     * Level 3：课程内三级身份分组（完全动态：由官方 GraphQL 驱动，零硬编码）
     */
    async function renderCourseRolesView(course) {
      const token = ++renderToken;
      const rawCourseId = String(course.id).replace('course_', '');
      const courseKey = 'course_' + rawCourseId;

      // 1. 直接请求官方专有 GraphQL 查询该课程下的所有有效分类
      const gqlData = await fetchAddressBookGraphQL({
        context: courseKey,
        courseContextCode: ''
      });

      if (currentSearchQuery || token !== renderToken) return;

      bodyEl.innerHTML = '';
      const listEl = document.createElement('div');
      listEl.className = 'mcx-picker-list';

      // 仅写信模式提供全课广播 (All in Course)
      if (mode === 'compose') {
        const isCourseSelected = selectedMap.has(courseKey) || selectedMap.has(String(course.id));

        const allRow = document.createElement('div');
        allRow.className = 'mcx-picker-nav-row' + (isCourseSelected ? ' is-selected' : '');
        allRow.innerHTML = `
          <div class="mcx-picker-nav-left" style="overflow: hidden;">
            <input type="checkbox" class="mcx-picker-checkbox" ${isCourseSelected ? 'checked' : ''} />
            <span class="mcx-picker-check"></span>
            <div class="mcx-picker-nav-icon" style="color: var(--mc-text-0);">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            </div>
            <div class="mcx-picker-nav-meta" style="overflow: hidden;">
              <span class="mcx-picker-nav-title">All in ${esc(course.name)}</span>
              <span class="mcx-picker-nav-desc">Entire course broadcast (all members)</span>
            </div>
          </div>
        `;

        allRow.addEventListener('click', (e) => {
          const courseToken = {
            _id: courseKey,
            id: (course.id && String(course.id).length > 20) ? course.id : btoa('Course-' + rawCourseId),
            name: `All in ${course.name}`,
            type: 'context'
          };

          if (e.target.tagName !== 'INPUT') {
            const chk = allRow.querySelector('input');
            if (chk) chk.checked = !chk.checked;
          }
          const chk = allRow.querySelector('input');
          if (chk && chk.checked) {
            selectedMap.set(courseKey, courseToken);
            allRow.classList.add('is-selected');
          } else {
            selectedMap.delete(courseKey);
            selectedMap.delete(String(course.id));
            allRow.classList.remove('is-selected');
          }
          updateCount();
        });

        listEl.appendChild(allRow);
      }

      // 如果 GraphQL 返回了官方节点分类（Teachers, Students, Observers, Sections, Groups 等）
      if (gqlData && gqlData.contextsConnection && Array.isArray(gqlData.contextsConnection.nodes) && gqlData.contextsConnection.nodes.length > 0) {
        gqlData.contextsConnection.nodes.forEach(node => {
          const row = document.createElement('div');
          row.className = 'mcx-picker-nav-row';
          row.innerHTML = `
            <div class="mcx-picker-nav-left">
              <div class="mcx-picker-nav-icon">
                ${getContextSvgIcon(node.id, node.name)}
              </div>
              <div class="mcx-picker-nav-meta">
                <span class="mcx-picker-nav-title">${esc(node.name)}</span>
              </div>
            </div>
            <span class="mcx-picker-chevron">&rsaquo;</span>
          `;

          row.addEventListener('click', () => {
            navigateTo({
              level: 'context_node',
              title: `${node.name} (${course.name})`,
              course: course,
              node: node
            });
          });

          listEl.appendChild(row);
        });

        bodyEl.appendChild(listEl);

        queueAvatars(listEl);
        return;
      }

      // 兜底回退：使用 REST 动态提取的数据
      const roleData = await fetchCourseRolesData(course);
      if (currentSearchQuery || token !== renderToken) return;

      const sortedRoles = Array.from(roleData.rolesMap.keys()).sort((a, b) => {
        if (a === 'Teachers') return -1;
        if (b === 'Teachers') return 1;
        if (a === 'Students') return -1;
        if (b === 'Students') return 1;
        return a.localeCompare(b);
      });

      sortedRoles.forEach(roleName => {
        const members = roleData.rolesMap.get(roleName);
        if (!members || members.length === 0) return;

        const row = document.createElement('div');
        row.className = 'mcx-picker-nav-row';
        row.innerHTML = `
          <div class="mcx-picker-nav-left">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_' + roleName.toLowerCase(), roleName)}
            </div>
            <div class="mcx-picker-nav-meta">
              <span class="mcx-picker-nav-title">${esc(roleName)}</span>
              <span class="mcx-picker-nav-desc">${members.length} members</span>
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;

        row.addEventListener('click', () => {
          navigateTo({
            level: 'role_members',
            title: `${roleName} (${course.name})`,
            course: course,
            role: roleName,
            members: members
          });
        });

        listEl.appendChild(row);
      });

      if (roleData.sections && roleData.sections.length > 0) {
        const secRow = document.createElement('div');
        secRow.className = 'mcx-picker-nav-row';
        secRow.innerHTML = `
          <div class="mcx-picker-nav-left">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_sections', 'Course Sections')}
            </div>
            <div class="mcx-picker-nav-meta">
              <span class="mcx-picker-nav-title">Course Sections</span>
              <span class="mcx-picker-nav-desc">${roleData.sections.length} class periods & sections</span>
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;
        secRow.addEventListener('click', () => {
          navigateTo({
            level: 'course_sections',
            title: `Sections (${course.name})`,
            course: course,
            sections: roleData.sections
          });
        });
        listEl.appendChild(secRow);
      }

      if (roleData.groups && roleData.groups.length > 0) {
        const grpRow = document.createElement('div');
        grpRow.className = 'mcx-picker-nav-row';
        grpRow.innerHTML = `
          <div class="mcx-picker-nav-left">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_groups', 'Student Groups')}
            </div>
            <div class="mcx-picker-nav-meta">
              <span class="mcx-picker-nav-title">Student Groups</span>
              <span class="mcx-picker-nav-desc">${roleData.groups.length} groups & clubs</span>
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;
        grpRow.addEventListener('click', () => {
          navigateTo({
            level: 'groups',
            title: `Groups (${course.name})`,
            course: course
          });
        });
        listEl.appendChild(grpRow);
      }

      bodyEl.appendChild(listEl);

      queueAvatars(listEl);
    }

    /**
     * 通用官方上下文节点视图（自适应递归渲染：可递归渲染下一级分部，或直接渲染人员名单）
     */
    async function renderContextNodeView(course, node) {
      const token = ++renderToken;
      const rawCourseId = String(course.id).replace('course_', '');
      const courseKey = 'course_' + rawCourseId;

      const gqlData = await fetchAddressBookGraphQL({
        context: node.id,
        courseContextCode: ''
      });

      if (currentSearchQuery || token !== renderToken) return;

      // 1. 如果官方后端返回了子上下文（例如 Sections 分部或 Student Groups 分组）
      if (gqlData && gqlData.contextsConnection && Array.isArray(gqlData.contextsConnection.nodes) && gqlData.contextsConnection.nodes.length > 0) {
        bodyEl.innerHTML = '';
        const listEl = document.createElement('div');
        listEl.className = 'mcx-picker-list';

        gqlData.contextsConnection.nodes.forEach(subNode => {
          const row = document.createElement('div');
          row.className = 'mcx-picker-nav-row';
          row.innerHTML = `
            <div class="mcx-picker-nav-left" style="overflow: hidden;">
              <div class="mcx-picker-nav-icon">
                ${getContextSvgIcon(subNode.id, subNode.name)}
              </div>
              <div class="mcx-picker-nav-meta" style="overflow: hidden;">
                <span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(subNode.name)}</span>
              </div>
            </div>
            <span class="mcx-picker-chevron">&rsaquo;</span>
          `;

          row.addEventListener('click', () => {
            navigateTo({
              level: 'context_node',
              title: `${subNode.name} (${course.name})`,
              course: course,
              node: subNode
            });
          });

          listEl.appendChild(row);
        });

        bodyEl.appendChild(listEl);

        queueAvatars(listEl);
        return;
      }

      // 2. 如果官方后端返回了具体人员花名册（例如 Teachers, Students, Observers, Period 1 等）
      if (gqlData && gqlData.usersConnection && Array.isArray(gqlData.usersConnection.nodes)) {
        let users = gqlData.usersConnection.nodes.map(normalizeUser);
        if (users.length === 0) {
          bodyEl.innerHTML = `<div class="mcx-picker-empty">No people found in ${esc(node.name)}.</div>`;
          return;
        }

        // 自动拉取下一页（若有更多人员）
        if (gqlData.usersConnection.pageInfo?.hasNextPage && gqlData.usersConnection.pageInfo.endCursor) {
          (async () => {
            let cursor = gqlData.usersConnection.pageInfo.endCursor;
            let safety = 0;
            while (cursor && safety < 10) {
              safety++;
              const more = await fetchAddressBookGraphQL({
                context: node.id,
                courseContextCode: '',
                afterUser: cursor
              });
              if (!more?.usersConnection?.nodes || more.usersConnection.nodes.length === 0) break;
              const newUsers = more.usersConnection.nodes.map(normalizeUser);
              users = users.concat(newUsers);
              if (currentView.level === 'context_node' && currentView.node?.id === node.id) {
                renderUserItemsList(users);
              }
              if (!more.usersConnection.pageInfo?.hasNextPage) break;
              cursor = more.usersConnection.pageInfo?.endCursor;
            }
          })();
        }

        renderUserItemsList(users);
        return;
      }

      // 3. 兜底回退：如果 GraphQL 没拿到，回退到 REST API 缓存
      const roleData = await fetchCourseRolesData(course);
      if (node.id.endsWith('_teachers') || node.name.includes('Teacher')) {
        const teachers = roleData.rolesMap.get('Teachers') || [];
        renderRoleMembersView(course, 'Teachers', teachers);
      } else if (node.id.endsWith('_students') || node.name.includes('Student')) {
        const students = roleData.rolesMap.get('Students') || [];
        renderRoleMembersView(course, 'Students', students);
      } else if (node.id.endsWith('_observers') || node.name.includes('Observer')) {
        const observers = roleData.rolesMap.get('Observers') || [];
        renderRoleMembersView(course, 'Observers', observers);
      } else if (node.id.endsWith('_sections') || node.name.includes('Section')) {
        renderCourseSectionsView(course, roleData.sections || []);
      } else if (node.id.endsWith('_groups') || node.name.includes('Group')) {
        if (roleData.groups && roleData.groups.length > 0) {
          renderCourseGroupsView(course, roleData.groups);
        } else {
          const userGroups = await fetchUserGroups();
          if (userGroups && userGroups.length > 0) {
            renderCourseGroupsView(course, userGroups);
          } else {
            bodyEl.innerHTML = `<div class="mcx-picker-empty">No student groups in ${esc(course.name)}.</div>`;
          }
        }
      } else {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No people found in ${esc(node.name)}.</div>`;
      }
    }

    /**
     * Level 4：课程内群组列表（REST 回退用）
     */
    async function renderCourseGroupsView(course, groups) {
      bodyEl.innerHTML = '';
      const listEl = document.createElement('div');
      listEl.className = 'mcx-picker-list';

      groups.forEach(grp => {
        const row = document.createElement('div');
        row.className = 'mcx-picker-nav-row';
        row.innerHTML = `
          <div class="mcx-picker-nav-left" style="overflow: hidden;">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_groups', grp.name)}
            </div>
            <div class="mcx-picker-nav-meta" style="overflow: hidden;">
              <span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(grp.name)}</span>
              ${grp.members_count ? `<span class="mcx-picker-nav-desc">${grp.members_count} members</span>` : ''}
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;

        row.addEventListener('click', () => {
          navigateTo({
            level: 'group_members',
            title: `${grp.name} (${course.name})`,
            group: grp
          });
        });

        listEl.appendChild(row);
      });

      bodyEl.appendChild(listEl);
      queueAvatars(listEl);
    }

    /**
     * Level 4：身份角色内具体人员名单（REST 回退用）
     */
    async function renderRoleMembersView(course, roleName, members) {
      if (!members || members.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No ${esc(roleName.toLowerCase())} in this course.</div>`;
        return;
      }
      renderUserItemsList(members);
    }

    /**
     * Level 4：班级分部 Sections 列表（REST 回退用）
     */
    async function renderCourseSectionsView(course, sections) {
      bodyEl.innerHTML = '';
      const listEl = document.createElement('div');
      listEl.className = 'mcx-picker-list';

      sections.forEach(sec => {
        const row = document.createElement('div');
        row.className = 'mcx-picker-nav-row';
        row.innerHTML = `
          <div class="mcx-picker-nav-left" style="overflow: hidden;">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_sections', sec.name)}
            </div>
            <div class="mcx-picker-nav-meta" style="overflow: hidden;">
              <span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(sec.name)}</span>
              ${sec.total_students ? `<span class="mcx-picker-nav-desc">${sec.total_students} students</span>` : ''}
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;

        row.addEventListener('click', () => {
          navigateTo({
            level: 'section_members',
            title: sec.name,
            course: course,
            section: sec
          });
        });

        listEl.appendChild(row);
      });

      bodyEl.appendChild(listEl);

      queueAvatars(listEl);
    }

    /**
     * Level 5：分部内人员列表（REST 回退用）
     */
    async function renderSectionMembersView(course, section) {
      const token = ++renderToken;
      const res = await fetch(`/api/v1/sections/${section.id}/enrollments?per_page=100`);
      if (currentSearchQuery || token !== renderToken) return;
      let members = [];
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          members = data.filter(e => e.user).map(e => normalizeUser(e.user));
        }
      }
      if (members.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No people in ${esc(section.name)}.</div>`;
        return;
      }
      renderUserItemsList(members);
    }

    /**
     * Level 2：Groups 列表
     */
    async function renderGroupsListView() {
      const token = ++renderToken;
      const groups = await fetchUserGroups();
      if (currentSearchQuery || token !== renderToken) return;
      if (!groups || groups.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No groups available.</div>`;
        return;
      }

      bodyEl.innerHTML = '';
      const listEl = document.createElement('div');
      listEl.className = 'mcx-picker-list';

      groups.forEach(g => {
        const row = document.createElement('div');
        row.className = 'mcx-picker-nav-row';
        row.innerHTML = `
          <div class="mcx-picker-nav-left" style="overflow: hidden;">
            <div class="mcx-picker-nav-icon">
              ${getContextSvgIcon('_groups', g.name)}
            </div>
            <div class="mcx-picker-nav-meta" style="overflow: hidden;">
              <span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(g.name)}</span>
              ${g.members_count ? `<span class="mcx-picker-nav-desc">${g.members_count} members</span>` : ''}
            </div>
          </div>
          <span class="mcx-picker-chevron">&rsaquo;</span>
        `;

        row.addEventListener('click', () => {
          navigateTo({
            level: 'group_members',
            title: g.name,
            group: g
          });
        });

        listEl.appendChild(row);
      });

      bodyEl.appendChild(listEl);

      queueAvatars(listEl);
    }

    /**
     * Level 3：Group 内人员列表
     */
    async function renderGroupMembersView(group) {
      const token = ++renderToken;
      const members = await fetchGroupMembers(group.id);
      if (currentSearchQuery || token !== renderToken) return;
      if (members.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No people in ${esc(group.name)}.</div>`;
        return;
      }
      renderUserItemsList(members);
    }

    /**
     * Level 2：全部人员列表 (All Users)
     */
    async function renderUsersListView() {
      const token = ++renderToken;
      const roster = await fetchAllUsers();
      if (currentSearchQuery || token !== renderToken) return;
      if (roster.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No contacts available.</div>`;
        return;
      }

      renderUserItemsList(roster);
    }

    /**
     * 通用人员条目渲染器
     */
    function renderUserItemsList(users, targetContainer) {
      const listEl = targetContainer || document.createElement('div');
      if (!targetContainer) {
        bodyEl.innerHTML = '';
        listEl.className = 'mcx-picker-list';
      }

      users.forEach(user => {
        const key = String(user._id || user.id);
        const isChecked = selectedMap.has(key);

        const row = document.createElement('div');
        row.className = 'mcx-picker-row' + (isChecked ? ' is-selected' : '');
        row.dataset.key = key;

        const initials = user.name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();

        row.innerHTML = `
          ${mode === 'compose' ? `<input type="checkbox" class="mcx-picker-checkbox" ${isChecked ? 'checked' : ''} /><span class="mcx-picker-check"></span>` : ''}
          ${avatarHtml(user, initials)}
          <div class="mcx-picker-user-info">
            <span class="mcx-picker-user-name">${esc(user.name)}</span>
            ${user.pronouns ? `<span class="mcx-picker-user-pronouns">${esc(user.pronouns)}</span>` : ''}
          </div>
        `;

        row.addEventListener('click', (e) => {
          if (mode === 'filter') {
            applyFilterSelection(user, 'user');
            return;
          }

          if (e.target.tagName !== 'INPUT') {
            const chk = row.querySelector('input');
            if (chk) chk.checked = !chk.checked;
          }
          const chk = row.querySelector('input');
          if (chk && chk.checked) {
            selectedMap.set(key, user);
            row.classList.add('is-selected');
          } else {
            selectedMap.delete(key);
            row.classList.remove('is-selected');
          }
          updateCount();
        });

        listEl.appendChild(row);
      });

      if (!targetContainer) {
        bodyEl.appendChild(listEl);
        queueAvatars(listEl);
      }

      queueAvatars(listEl);

      if (mode === 'compose') {
        const selectAllBtn = picker.querySelector('#mcx-picker-select-all');
        if (selectAllBtn) {
          selectAllBtn.onclick = () => {
            users.forEach(u => {
              const k = String(u._id || u.id);
              selectedMap.set(k, u);
            });
            updateCount();
            renderUserItemsList(users);
          };
        }
      }
    }

    /**
     * 全局即时穿透搜索 (Universal Search)
     */
    let searchDebounce = null;
    let currentSearchQuery = '';

    function renderSearchResults(coursesList, usersList, queryText) {
      const inboxSections = (window.mcxInboxSearchSections ? window.mcxInboxSearchSections(queryText) : []);
      if (coursesList.length === 0 && usersList.length === 0 && inboxSections.length === 0) {
        bodyEl.innerHTML = `<div class="mcx-picker-empty">No matches for “${esc(queryText)}”.</div>`;
        return;
      }

        bodyEl.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'mcx-picker-list';

        if (coursesList.length > 0) {
          const cHeader = document.createElement('div');
          cHeader.className = 'mcx-picker-section-title';
          cHeader.textContent = 'Courses in this class';
          wrap.appendChild(cHeader);

          coursesList.forEach(c => {
            const row = document.createElement('div');
            row.className = 'mcx-picker-nav-row';
            row.innerHTML = `
              <div class="mcx-picker-nav-left" style="overflow: hidden;">
                <div class="mcx-picker-nav-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg></div>
                <div class="mcx-picker-nav-meta" style="overflow: hidden;"><span class="mcx-picker-nav-title" style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${esc(c.name)}</span></div>
              </div>
              <span class="mcx-picker-chevron">&rsaquo;</span>
            `;
            row.addEventListener('click', () => {
              navigateTo({ level: 'course_roles', title: c.name, course: c });
            });
            wrap.appendChild(row);
          });
        }

        if (usersList.length > 0) {
          const uHeader = document.createElement('div');
          uHeader.className = 'mcx-picker-section-title';
          uHeader.textContent = 'People';
          wrap.appendChild(uHeader);

          usersList.forEach(u => {
            const key = String(u._id || u.id);
            const isChecked = selectedMap.has(key);
            const row = document.createElement('div');
            row.className = 'mcx-picker-row' + (isChecked ? ' is-selected' : '');
            const initials = u.name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();

            row.innerHTML = `
              ${mode === 'compose' ? `<input type="checkbox" class="mcx-picker-checkbox" ${isChecked ? 'checked' : ''} /><span class="mcx-picker-check"></span>` : ''}
              ${avatarHtml(u, initials)}
              <div class="mcx-picker-user-info"><span class="mcx-picker-user-name">${esc(u.name)}</span>${u.pronouns ? `<span class="mcx-picker-user-pronouns">${esc(u.pronouns)}</span>` : ''}</div>
            `;

            row.addEventListener('click', (ev) => {
              if (mode === 'filter') {
                applyFilterSelection(u, 'user');
                return;
              }

              const isCheckboxClick = ev.target.matches('input[type="checkbox"]') || ev.target.classList.contains('mcx-picker-check');
              const chk = row.querySelector('input[type="checkbox"]');

              if (isCheckboxClick) {
                if (chk && chk.checked) {
                  selectedMap.set(key, u);
                  row.classList.add('is-selected');
                } else {
                  selectedMap.delete(key);
                  row.classList.remove('is-selected');
                }
                updateCount();
              } else {
                // 点击行本身：直接将联系人填入 To 框并关闭选择器
                selectedMap.set(key, u);
                const currentModalState = getModalState();
                applyComposeSelection(currentModalState || modalState, selectedMap);
                if (hostInput) {
                  clearInputValue(hostInput);
                }
                closeFastPicker();
              }
            });
            wrap.appendChild(row);
          });
        }

        inboxSections.forEach(sec => {
          const sHeader = document.createElement('div');
          sHeader.className = 'mcx-picker-section-title';
          sHeader.textContent = sec.title;
          wrap.appendChild(sHeader);

          sec.items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'mcx-picker-nav-row';
            row.innerHTML = `
              <div class="mcx-picker-nav-left" style="overflow: hidden;">
                <div class="mcx-picker-nav-meta" style="overflow: hidden;"><span class="mcx-picker-nav-title">${esc(item.label)}</span>${item.desc ? `<span class="mcx-picker-nav-desc">${esc(item.desc)}</span>` : ''}</div>
              </div>
              <span class="mcx-picker-chevron">&rsaquo;</span>
            `;
            row.addEventListener('click', () => {
              if (window.mcxInboxOpen) window.mcxInboxOpen(item.conv);
              closeFastPicker();
            });
            wrap.appendChild(row);
          });
        });

        bodyEl.appendChild(wrap);
        queueAvatars(wrap);
      }

    function handleSearch(rawQ) {
      const q = (rawQ || '').trim().toLowerCase();

      if (!q) {
        currentSearchQuery = '';
        clearTimeout(searchDebounce);
        titleEl.textContent = currentView.title;
        backBtn.style.display = viewStack.length > 0 ? 'inline-flex' : 'none';
        renderView();
        return;
      }

      if (q === currentSearchQuery) return;
      currentSearchQuery = q;

      backBtn.style.display = 'none';
      titleEl.textContent = 'Results for “' + (rawQ || '').trim() + '”';
      if (mode === 'compose') {
        footerEl.style.display = 'flex';
      }

      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        if (currentSearchQuery !== q) return;

        // 1. 本地快速匹配（课程与已缓存联系人）
        let matchedCourses = [];
        if (cache.coursesList) {
          matchedCourses = cache.coursesList.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
        }

        let matchedUsers = [];
        if (cache.allUsers) {
          matchedUsers = cache.allUsers.filter(u => u.name.toLowerCase().includes(q));
        } else {
          const userMap = new Map();
          cache.courseRosters.forEach(roster => {
            roster.forEach(u => {
              if (u.name.toLowerCase().includes(q) && !userMap.has(u._id)) {
                userMap.set(u._id, u);
              }
            });
          });
          matchedUsers = Array.from(userMap.values());
        }

        // 若本地已有匹配，立即呈现结果；如果完全没有本地缓存，再展示轻量 loading
        if (matchedCourses.length > 0 || matchedUsers.length > 0) {
          renderSearchResults(matchedCourses, matchedUsers.slice(0, 30), (rawQ || '').trim());
        } else if (!bodyEl.querySelector('.mcx-search-results')) {
          bodyEl.innerHTML = loadingHtml('Searching people…');
        }

        // 短于 2 个字符时不发起全局网络暴力检索，保护主线程并避免 Canvas 后端 400 警告
        if (q.length < 2) return;

        // 2. 并行网络检索：GraphQL 索引 + REST 官方全局检索 + 课程列表（互不阻塞）
        try {
          const [gqlData, restData, fetchedCourses] = await Promise.all([
            fetchAddressBookGraphQL({ search: q }).catch(() => null),
            fetch('/api/v1/search/recipients?search=' + encodeURIComponent(q) + '&per_page=30')
              .then(r => r.ok ? r.json() : [])
              .catch(() => []),
            (!cache.coursesList ? fetchCoursesList().catch(() => []) : Promise.resolve(cache.coursesList))
          ]);

          if (currentSearchQuery !== q) return;

          if (Array.isArray(fetchedCourses)) {
            matchedCourses = fetchedCourses.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
          }

          const userMap = new Map();
          matchedUsers.forEach(u => userMap.set(String(u._id || u.id), u));

          // 处理 GraphQL 返回的用户
          if (gqlData?.usersConnection?.nodes && Array.isArray(gqlData.usersConnection.nodes)) {
            gqlData.usersConnection.nodes.forEach(item => {
              const u = normalizeUser(item);
              const key = String(u._id || u.id);
              if (!userMap.has(key)) userMap.set(key, u);
            });
          }

          // 处理 REST 接口返回的用户（官方全员检索兜底，绝不漏人）
          if (Array.isArray(restData)) {
            restData.forEach(item => {
              if (item.type !== 'context') {
                const u = normalizeUser(item);
                const key = String(u._id || u.id);
                if (!userMap.has(key)) userMap.set(key, u);
              } else if (item.name && item.name.toLowerCase().includes(q)) {
                if (!matchedCourses.some(c => String(c.id) === String(item.id))) {
                  matchedCourses.push({ id: item.id, name: item.name });
                }
              }
            });
          }

          matchedUsers = Array.from(userMap.values());
        } catch (err) {
          console.warn('[MCX Picker] Search fetch error:', err);
        }

        if (currentSearchQuery !== q) return;
        renderSearchResults(matchedCourses, matchedUsers.slice(0, 30), (rawQ || '').trim());
      }, 280);
    }

    picker.handleSearch = function(rawQ) {
      if (showPickerSearch && pickerSearchInput && pickerSearchInput.value !== rawQ) {
        pickerSearchInput.value = rawQ;
      }
      handleSearch(rawQ);
    };

    if (pickerSearchInput) {
      pickerSearchInput.addEventListener('input', (e) => {
        e.stopPropagation();
        handleSearch(e.target.value);
      });
    }

    renderView();
    if (showPickerSearch && pickerSearchInput) {
      setTimeout(() => pickerSearchInput.focus(), 60);
    } else if (hostInput && hostInput.value && hostInput.value.trim()) {
      handleSearch(hostInput.value);
    }
  }

  /**
   * 10. 回填写信弹窗 React 状态 (Compose Mode)
   */
  function applyComposeSelection(state, selectedMap) {
    const targetState = (state && typeof state.onSelectedIdsChange === 'function') ? state : getModalState();
    if (!targetState || typeof targetState.onSelectedIdsChange !== 'function') {
      console.warn('[MCX Picker] applyComposeSelection: Could not find onSelectedIdsChange handler');
      return;
    }

    const list = Array.from(selectedMap.values()).map(u => {
      const rawId = String(u._id || u.id || '');
      if (u.type === 'context' || rawId.startsWith('course_') || rawId.startsWith('section_') || rawId.startsWith('group_')) {
        let cleanId = rawId;
        if (cleanId.startsWith('course_')) {
          const num = cleanId.replace('course_', '');
          return {
            _id: cleanId,
            id: (u.id && String(u.id).length > 20) ? u.id : btoa('Course-' + num),
            name: u.name,
            type: 'context'
          };
        }
        return {
          _id: cleanId,
          id: (u.id && String(u.id).length > 20) ? u.id : btoa('Context-' + cleanId),
          name: u.name,
          type: 'context'
        };
      }

      const cleanUserId = rawId.replace(/[^0-9]/g, '') || rawId;
      const relayId = (u.id && String(u.id).length > 20 && !String(u.id).includes(' '))
        ? u.id
        : btoa('MessageableUser-' + cleanUserId);

      return {
        _id: cleanUserId,
        id: relayId,
        name: u.name,
        pronouns: u.pronouns || '',
        avatar_url: u.avatar_url || '',
        type: 'user'
      };
    });

    try {
      targetState.onSelectedIdsChange(list);
    } catch (err) {
      console.error('[MCX Picker] Failed to sync recipients:', err);
    }
  }

  /**
   * 在收件箱主搜索框中渲染清晰可点击的过滤药丸 [User Name ✕]
   * 点击 ✕ 立即清除过滤，无缝退回所有消息
   */
  let activeFilterItem = null;
  let activeFilterClearFn = null;
  let filterPillObserver = null;

  function updateFilterBanner(item) {
    document.querySelectorAll('.mcx-inbox-filter-hint').forEach(el => el.remove());

    if (!item) return;

    const holder = document.querySelector('#inbox-conversation-holder') ||
                   document.querySelector('#conversations') ||
                   document.querySelector('[data-testid="conversation-list"]') ||
                   document.querySelector('#content');
    if (!holder) return;

    const banner = document.createElement('div');
    banner.className = 'mcx-inbox-filter-hint';
    banner.setAttribute('title', `Filtering messages with ${item.name}`);
    banner.innerHTML = `
      <div class="mcx-inbox-filter-hint-left">
        <div class="mcx-inbox-filter-hint-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
          </svg>
        </div>
        <span>Filtering messages with <strong>${esc(item.name)}</strong></span>
      </div>
      <button type="button" class="mcx-inbox-filter-clear">Clear filter</button>
    `;

    banner.querySelector('.mcx-inbox-filter-clear').addEventListener('click', (e) => {
      e.preventDefault();
      clearActiveFilter();
    });

    holder.prepend(banner);
  }

  function mountFilterPill(facade, inputEl, item) {
    if (!inputEl || !item) return;

    const facadeEl = facade || inputEl.closest('span[class*="-textInput__facade"]') || inputEl.parentElement;
    if (facadeEl) {
      facadeEl.style.display = 'flex';
      facadeEl.style.alignItems = 'center';
      facadeEl.style.flexWrap = 'nowrap';
    }

    if (inputEl.parentElement) {
      inputEl.parentElement.style.display = 'flex';
      inputEl.parentElement.style.alignItems = 'center';
      inputEl.parentElement.style.flexWrap = 'nowrap';
    }

    inputEl.style.minWidth = '20px';
    inputEl.style.flex = '1 1 auto';
    inputEl.style.width = 'auto';

    // 移除已有自定义药丸，防止重复堆叠
    document.querySelectorAll('.mcx-filter-pill').forEach(el => el.remove());

    const pill = document.createElement('span');
    pill.className = 'mcx-filter-pill';
    pill.innerHTML = `
      <span class="mcx-filter-pill-name">${esc(item.name)}</span>
      <button type="button" class="mcx-filter-pill-close" aria-label="Clear filter & return to all messages">&times;</button>
    `;

    // 关键：永远使用 insertAdjacentElement('beforebegin')，绝不在非直接父级上调用 insertBefore
    inputEl.insertAdjacentElement('beforebegin', pill);
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, '');
      } else {
        inputEl.value = '';
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      inputEl.value = '';
    }
    inputEl.placeholder = '';
    inputEl.setAttribute('aria-label', `Filtering by ${item.name}`);
    inputEl.title = `Filtering by ${item.name}`;

    const closeBtn = pill.querySelector('.mcx-filter-pill-close');
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearActiveFilter();
    });

    updateFilterBanner(item);
  }

  function clearActiveFilter() {
    activeFilterItem = null;
    document.querySelectorAll('.mcx-filter-pill').forEach(el => el.remove());

    const inp = document.querySelector('[data-testid="message-list-actions-address-book-input"]') ||
                document.querySelector('input[placeholder*="Search"]');
    if (inp) {
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(inp, '');
        } else {
          inp.value = '';
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        inp.value = '';
      }
      inp.placeholder = 'Search people';
      inp.removeAttribute('aria-label');
      inp.removeAttribute('title');
    }

    updateFilterBanner(null);

    if (typeof activeFilterClearFn === 'function') {
      const fn = activeFilterClearFn;
      activeFilterClearFn = null;
      try { fn(); } catch (e) {}
    }
  }

  function renderSearchFilterPill(targetEl, item, onClearCallback) {
    const inputEl = (targetEl && targetEl.matches && targetEl.matches('input'))
      ? targetEl
      : (targetEl && targetEl.querySelector ? targetEl.querySelector('input') : null) ||
        document.querySelector('[data-testid="message-list-actions-address-book-input"]') ||
        document.querySelector('input[placeholder*="Search"]');
    if (!inputEl) return;

    const facade = inputEl.closest('span[class*="-textInput__facade"]') ||
                   inputEl.closest('span[class*="textInput"]') ||
                   inputEl.parentElement;

    activeFilterItem = item;
    activeFilterClearFn = onClearCallback;

    mountFilterPill(facade, inputEl, item);

    // 挂载持久 MutationObserver，防止 React 虚拟 DOM 异步 reconcile 时抹去药丸
    if (!filterPillObserver) {
      filterPillObserver = new MutationObserver(() => {
        if (activeFilterItem) {
          const currentInp = document.querySelector('[data-testid="message-list-actions-address-book-input"]') ||
                             document.querySelector('input[placeholder*="Search"]');
          if (currentInp && !document.querySelector('.mcx-filter-pill')) {
            const currentFacade = currentInp.closest('span[class*="-textInput__facade"]') ||
                                  currentInp.closest('span[class*="textInput"]') ||
                                  currentInp.parentElement;
            mountFilterPill(currentFacade, currentInp, activeFilterItem);
          }
          if (!document.querySelector('.mcx-inbox-filter-hint')) {
            updateFilterBanner(activeFilterItem);
          }
        }
      });
      filterPillObserver.observe(document.body, { childList: true, subtree: true });
    }

    // 键盘支持：当搜索框无字符且按下 Backspace 时，清除药丸恢复所有消息
    inputEl.addEventListener('keydown', (e) => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && !inputEl.value && activeFilterItem) {
        e.preventDefault();
        clearActiveFilter();
      }
    });
  }

  /**
   * 11. 回填收件箱主工具栏过滤 (Filter Mode)
   * 调取原生 onSelectedIdsChange 生成 [User ✕] 药丸并触发检索
   */
  function applyFilterSelection(item, type) {
    try {
      const rawId = String(item._id || item.id || item.user_id);
      const relayId = (item.id && String(item.id).length > 20) ? item.id : btoa('User-' + rawId);
      const formattedItem = {
        _id: rawId,
        id: relayId,
        name: item.name,
        pronouns: item.pronouns || '',
        avatar_url: item.avatar_url || '',
        type: type || item.type || 'user'
      };

      const inp = document.querySelector('[data-testid="message-list-actions-address-book-input"]') ||
                  document.querySelector('input[placeholder*="Search"]');
      const addrBtn = document.querySelector('[data-testid="address-button"]');
      const targetEl = inp || addrBtn;

      let onSelectedIdsChangeFn = null;
      let onUserFilterSelectFn = null;
      let onCourseFilterSelectFn = null;
      let setIsMenuOpenFn = null;

      if (targetEl) {
        let cur = targetEl;
        let fk = null;
        while (cur && !fk) {
          fk = Object.getOwnPropertyNames(cur).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          if (!fk) cur = cur.parentElement;
        }

        if (fk && cur) {
          let f = cur[fk];
          while (f) {
            const p = f.memoizedProps;
            if (p) {
              if (!onSelectedIdsChangeFn && typeof p.onSelectedIdsChange === 'function') {
                onSelectedIdsChangeFn = p.onSelectedIdsChange;
              }
              if (!onUserFilterSelectFn && typeof p.onUserFilterSelect === 'function') {
                onUserFilterSelectFn = p.onUserFilterSelect;
              }
              if (!onCourseFilterSelectFn && typeof p.onCourseFilterSelect === 'function') {
                onCourseFilterSelectFn = p.onCourseFilterSelect;
              }
              if (!setIsMenuOpenFn && typeof p.setIsMenuOpen === 'function') {
                setIsMenuOpenFn = p.setIsMenuOpen;
              }
            }
            f = f.return;
          }
        }
      }

      // 1. 关闭原生弹窗状态
      if (setIsMenuOpenFn) {
        try { setIsMenuOpenFn(false); } catch (e) {}
      }

      // 2. 触发对应的 React 过滤与通讯录状态同步
      if (type === 'course' && onCourseFilterSelectFn) {
        try { onCourseFilterSelectFn(item); } catch (e) {}
      } else {
        if (onSelectedIdsChangeFn) {
          // 清空旧的消息勾选，严禁传入联系人对象（此回调是会话多选控制器，传入对象会导致会话计数变为多选状态从而禁用回复按钮）
          try { onSelectedIdsChangeFn([]); } catch (e) {}
        }
        if (onUserFilterSelectFn) {
          try { onUserFilterSelectFn(formattedItem); } catch (e) {}
        }
      }

      // 3. 在搜索框内部渲染药丸 [User Name ✕]，带完整的清空回退回调
      renderSearchFilterPill(targetEl, formattedItem, () => {
        if (onUserFilterSelectFn) {
          try { onUserFilterSelectFn(null); } catch (e) {}
        }
        if (onSelectedIdsChangeFn) {
          try { onSelectedIdsChangeFn([]); } catch (e) {}
        }
        if (onCourseFilterSelectFn) {
          try { onCourseFilterSelectFn(null); } catch (e) {}
        }
        if (inp) {
          inp.value = '';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        try {
          location.hash = '#filter=type=inbox';
          window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: location.href.replace(/#.*$/, '#filter=type=inbox') }));
        } catch (e) {}
      });

      // 4. 更新 URL Hash 作为 Canvas 官方路由原生联动
      try {
        const targetHash = type === 'course'
          ? `#filter=type=inbox&context=${item.id}`
          : `#filter=type=inbox&user_id=${rawId}`;
        const oldUrl = location.href;
        location.hash = targetHash;
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: oldUrl, newURL: location.href }));
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch (err) {}

      // 5. 失焦原生输入框并压制原生浮层
      if (inp) {
        try { inp.blur(); } catch (e) {}
      }
      suppressNativeMenus();
    } catch (err) {
      console.error('[MCX Picker] Error applying filter selection:', err);
    } finally {
      closeFastPicker();
    }
  }

  /**
   * 12. 关闭浮层
   */
  function closeFastPicker() {
    if (activePicker) {
      activePicker.remove();
      activePicker = null;
    }
    document.documentElement.classList.remove('mcx-picker-active');
    document.documentElement.classList.remove('mcx-filter-live');
  }

  /**
   * 13. 全局精准拦截：同时接管「通讯录按钮」与「收件箱/写信收件人搜索框」
   */
  // 全局捕获 input 事件，驱动极速选择器搜索（不阻断事件传播，确保 React 受控组件同步状态并允许 Backspace 逐字删除）
  document.addEventListener('input', function (e) {
    const modal = e.target && e.target.closest && e.target.closest('#compose-message-modal');
    if (modal) {
      syncComposeModalLockState(modal);
      const toInput = findComposeToInput(modal);
      if (toInput && (e.target === toInput || toInput.contains(e.target))) {
        if (!isComposeCourseSelected(modal)) {
          e.preventDefault();
          e.stopPropagation();
          toInput.value = '';
          toInput.blur();
          showCourseRequiredHint(modal, toInput);
          return;
        }
      }
    }

    const recipInp = resolveRecipientInput(e.target);
    if (recipInp) {
      if (!activePicker) {
        openPicker(recipInp);
      }
      if (activePicker && typeof activePicker.handleSearch === 'function') {
        activePicker.handleSearch(recipInp.value);
      }
    }
  }, true);

  // 输入框获得焦点时压制原生菜单并展开选择器
  document.addEventListener('focusin', function (e) {
    const modal = e.target && e.target.closest && e.target.closest('#compose-message-modal');
    if (modal) {
      syncComposeModalLockState(modal);
      const toInput = findComposeToInput(modal);
      if (toInput && (e.target === toInput || toInput.contains(e.target))) {
        if (!isComposeCourseSelected(modal)) {
          toInput.blur();
          showCourseRequiredHint(modal, toInput);
          return;
        }
      }
    }

    const recipInp = resolveRecipientInput(e.target);
    if (recipInp) {
      suppressNativeMenus();
      if (!activePicker) {
        openPicker(recipInp);
      }
    }
  }, true);

  ['pointerdown', 'mousedown', 'click'].forEach(evtType => {
    document.addEventListener(evtType, function (e) {
      const modal = e.target && e.target.closest && e.target.closest('#compose-message-modal');

      // 1. 写信弹窗中切换课程且已有收件人时的二次确认保护
      if (modal && !bypassingCourseChangeConfirm) {
        const courseTrigger = getModalCourseTrigger(modal);
        const isCourseClick = courseTrigger && (e.target === courseTrigger || courseTrigger.contains(e.target));
        if (isCourseClick) {
          const recipientCount = getComposeRecipientsCount(modal);
          if (recipientCount > 0) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (evtType === 'click') {
              promptChangeCourseConfirm(modal, () => {
                clearComposeRecipients(modal);
                bypassingCourseChangeConfirm = true;
                const courseInp = modal.querySelector('[data-testid="course-select-modal"], [data-testid*="course-select"], input') || courseTrigger;
                if (courseInp) {
                  courseInp.focus();
                  courseInp.click();
                }
                setTimeout(() => { bypassingCourseChangeConfirm = false; }, 600);
              });
            }
            return;
          }
        }
      }

      // 2. 写信弹窗中未选课程时，阻止点击 To 输入框并给出提示
      if (modal && !isComposeCourseSelected(modal)) {
        const toInput = findComposeToInput(modal);
        const isToClick = toInput && (
          e.target === toInput ||
          toInput.contains(e.target) ||
          (e.target.closest && toInput.closest('span[class*="-textInput__facade"]') && e.target.closest('span[class*="-textInput__facade"]') === e.target.closest('span[class*="-textInput__facade"]'))
        );
        if (isToClick) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (evtType === 'click') {
            if (toInput) toInput.blur();
            showCourseRequiredHint(modal, toInput);
          }
          return;
        }
      }

      // 3. 通讯录按钮点击处理
      const addrBtn = e.target && e.target.closest && e.target.closest('[data-testid="address-button"]');
      if (addrBtn) {
        e.stopImmediatePropagation();
        e.stopPropagation();

        // 如果在写信弹窗中且尚未选择课程，阻止打开名单册并给出提示
        if (modal && !isComposeCourseSelected(modal)) {
          e.preventDefault();
          if (evtType === 'click') {
            showCourseRequiredHint(modal, addrBtn);
          }
          return;
        }

        if (evtType === 'pointerdown' || evtType === 'mousedown') {
          e.preventDefault();
          suppressNativeMenus();
        } else {
          e.preventDefault();
          openPicker(addrBtn);
        }
        return;
      }

      // 4. 收件人输入框正常点击打开
      const recipInput = (evtType === 'click') ? resolveRecipientInput(e.target) : null;
      if (recipInput) {
        suppressNativeMenus();
        if (!activePicker) openPicker(recipInput);
      } else if (activePicker) {
        const isInsidePicker = !!e.target.closest('.mcx-recipient-picker');
        const isHostInput = !!resolveRecipientInput(e.target);
        const isAddrBtn = !!e.target.closest('[data-testid="address-button"]');
        if (!isInsidePicker && !isHostInput && !isAddrBtn) {
          closeFastPicker();
        }
      }
    }, true);
  });

  /* 原生那份通讯录菜单在 React 的根容器上收键盘，比挂在 document 冒泡阶段的我们早一帧，
     所以光靠下面那个守卫拦不住它打开。这里在捕获阶段掐掉「会打开／移动那盘菜单」的键：
     只 stopImmediatePropagation、不 preventDefault，字符照样落进输入框（我们的搜索吃 input 事件）。
     方向左右键／Home／End／Backspace／Tab 全部放行＝光标移动和删收件人药丸照旧归 Canvas。 */
  const NATIVE_MENU_OPENER_KEYS = ['ArrowDown', 'ArrowUp', 'Enter'];
  document.addEventListener('keydown', function (e) {
    const inp = e.target;
    if (!inp || !inp.matches || !inp.matches('input[data-testid*="address-book-input"]')) return;
    const key = e.key;
    if (!key) return;
    const isPrintable = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (NATIVE_MENU_OPENER_KEYS.indexOf(key) < 0 && !isPrintable) return;
    e.stopImmediatePropagation();

    // 掐掉之后下面那个冒泡阶段的守卫也收不到了，未选课程那一档的提示在这里补一次
    const modal = inp.closest ? inp.closest('#compose-message-modal') : null;
    if (modal && !isComposeCourseSelected(modal)) {
      inp.blur();
      showCourseRequiredHint(modal, inp);
    }
  }, true);

  // 按 ESC 或相关键盘处理
  document.addEventListener('keydown', function (e) {
    const modal = e.target && e.target.closest && e.target.closest('#compose-message-modal');
    if (modal) {
      const toInput = findComposeToInput(modal);
      const isToTarget = toInput && (e.target === toInput || toInput.contains(e.target));
      if (isToTarget && !isComposeCourseSelected(modal)) {
        e.preventDefault();
        e.stopPropagation();
        toInput.blur();
        showCourseRequiredHint(modal, toInput);
        return;
      }

      const courseTrigger = getModalCourseTrigger(modal);
      const isCourseTarget = courseTrigger && (e.target === courseTrigger || courseTrigger.contains(e.target));
      if (isCourseTarget && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && !bypassingCourseChangeConfirm) {
        const recipientCount = getComposeRecipientsCount(modal);
        if (recipientCount > 0) {
          e.preventDefault();
          e.stopPropagation();
          promptChangeCourseConfirm(modal, () => {
            clearComposeRecipients(modal);
            bypassingCourseChangeConfirm = true;
            e.target.click();
            setTimeout(() => { bypassingCourseChangeConfirm = false; }, 600);
          });
          return;
        }
      }
    }

    if (e.key === 'Escape') {
      if (activeChangeConfirmOverlay) {
        activeChangeConfirmOverlay.remove();
        activeChangeConfirmOverlay = null;
        return;
      }
      if (activePicker) {
        closeFastPicker();
      }
    }
  });

  // 动态监听写信弹窗挂载与状态变更
  const composeModalObserver = new MutationObserver(() => {
    const modal = document.querySelector('#compose-message-modal');
    if (modal) {
      syncComposeModalLockState(modal);
    }
  });
  composeModalObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
