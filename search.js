/* search.js — 全局搜索：一份本地索引 + 挂在搜索框下面的结果框。
 *
 * 为什么要一份本地索引：那颗搜索框（厂商插件 Atomic Search 的自定义元素）只筛它当前那一屏的卡片，
 * 想跳到某一页课件、某一个文件、某一条公告，只能一门课一门课点进去。走服务端搜索又要
 * 等一个来回，打字期间每敲一个字问一次服务器就会卡手。所以这里把能搜的东西一次抓进
 * localStorage，打字的时候只在内存里扫，一个请求都不发。
 *
 * 那颗框不是每台学校都有（它是学校另外装的插件）。没有的时候这一份自己在右上角补一颗，
 * 补出来的那颗接的还是同一套结果框。
 *
 * 索引分片按课程存，每片自带时间戳：过期的那一门课才重取，没过的直接复用，
 * 所以第二次打开搜索基本是零等待。
 *
 * 这颗文件不读 content.js 闭包里的东西，只共用两样：localStorage 的色值缓存
 * （bc_cache_colors_v1，课程卡那颗色点）和 --mc-* 那组根变量（样式在 style.css 第 40 节）。
 */
(function () {
  'use strict';

  // 非 Canvas 站点直接退出，严禁挂载全局搜索 DOM 观察器
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

  // content.js 那一组是 all_frames 注入的，iframe 里也有一份，只让最外面那层管浮层
  if (window.self !== window.top) return;

  const IDX_KEY = 'mcx_search_index_v1';
  const SHARD_TTL = 60 * 60000;          // 一门课的作业／页面／文件／公告存多久
  const COURSE_TTL = 12 * 3600000;       // 课程名单存多久（和侧栏抽屉那档同一个量级）
  const COURSE_BATCH = 3;                // 同时问几门课，一次开几十条请求会把 Canvas 自己拖慢
  const PER_KIND = 15;               // 全量态每一类先给 15 条；挑了类型之后那一类整份摆出来，不截
  const DAY = 86400000;
  // Canvas 页面和站点自身共用同一个 localStorage。搜索只是可再抓的缓存，绝不能把这块地
  // 吃到配额边上，连学生的勾选、折叠状态都写不进去。这个数刻意离常见的 5 MiB 配额留出余量；
  // 字符串按 UTF-16 估算，宁可早一点收缩，也不要等浏览器抛 QuotaExceededError。
  const INDEX_BUDGET_BYTES = 1200 * 1024;

  // 这一份的顺序就是结果框里分组的顺序，也是筛选键那一排的顺序
  const KINDS = {
    course: 'Courses',
    task: 'Work',
    news: 'Announcements',
    discussion: 'Discussions',
    page: 'Pages',
    file: 'Files',
    link: 'Links',
    message: 'Inbox'
  };

  const boxOn = () => localStorage.getItem('mc_search_box') !== '0';
  /* 那四路"名单类"请求（讨论、模块、页面、文件）以前由设置里那颗 Include pages, files,
     discussions and links 管，那颗已经删掉、常开，所以这里不再读那一格 */

  /* ===== 取数 ===== */

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null);
  }

  let store = { host: location.host, at: 0, courses: [], shards: {}, messages: null, messagesAt: 0, messagesUsedAt: 0 };

  function readStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(IDX_KEY) || 'null');
      // 换学校（不同 Canvas 域名）时那份索引整个作废，id 对不上只会搜出错的东西
      if (raw && raw.host === location.host && Array.isArray(raw.courses)) {
        store = {
          host: raw.host, at: raw.at || 0, courses: raw.courses, shards: raw.shards || {},
          messages: Array.isArray(raw.messages) ? raw.messages : null, messagesAt: raw.messagesAt || 0,
          messagesUsedAt: raw.messagesUsedAt || raw.messagesAt || 0
        };
      }
    } catch (e) {}
  }

  function storedBytes(value) {
    return String(value || '').length * 2;
  }

  function serialiseStore() {
    return JSON.stringify(store);
  }

  /* 每片记的是"最后被搜到/更新"的时间。旧版本没有 usedAt 时退回 at，升级后也能直接
     按旧到新收拾，不用迁移。课程名单很小且是索引的骨架，永远不删；可再抓的分片和收件箱
     才是可牺牲的缓存。 */
  function cacheCandidates() {
    const rows = Object.keys(store.shards).map(cid => {
      const sh = store.shards[cid] || {};
      return { kind: 'shard', id: cid, at: sh.usedAt || sh.at || 0 };
    });
    if (Array.isArray(store.messages) && store.messages.length) {
      rows.push({ kind: 'messages', at: store.messagesUsedAt || store.messagesAt || 0 });
    }
    return rows.sort((a, b) => a.at - b.at);
  }

  function evictOldestCache() {
    const row = cacheCandidates()[0];
    if (!row) return false;
    if (row.kind === 'messages') {
      store.messages = null;
      store.messagesAt = 0;
      store.messagesUsedAt = 0;
    } else {
      delete store.shards[row.id];
    }
    return true;
  }

  function trimIndexToBudget() {
    let text = serialiseStore();
    while (storedBytes(text) > INDEX_BUDGET_BYTES && evictOldestCache()) text = serialiseStore();
    return text;
  }

  function writeStore() {
    // 先在正常写入前收缩，而不是等配额异常才临时砍内容。这样搜索缓存始终给其它偏好留位。
    let text = trimIndexToBudget();
    try {
      localStorage.setItem(IDX_KEY, text);
      return true;
    } catch (e) {
      /* 其它 Canvas 数据也可能已经占满这一域。继续逐个淘汰最久未用的可再抓缓存并重试；
         不触碰任何非本索引键。若连一份空搜索索引也存不下，删掉旧索引来归还空间，
         让作业勾选和设置有机会再次落盘。 */
      while (evictOldestCache()) {
        text = serialiseStore();
        try {
          localStorage.setItem(IDX_KEY, text);
          return true;
        } catch (e2) {}
      }
      try { localStorage.removeItem(IDX_KEY); } catch (e3) {}
      return false;
    }
  }

  function courseColor(cid) {
    try {
      const colors = JSON.parse(localStorage.getItem('bc_cache_colors_v1') || '{}');
      return colors['course_' + cid] || colors[String(cid)] || '';
    } catch (e) { return ''; }
  }

  async function ensureCourses() {
    if (store.courses.length && Date.now() - store.at < COURSE_TTL) return store.courses;
    const list = await getJSON('/api/v1/courses?enrollment_state=active&per_page=100');
    if (Array.isArray(list) && list.length) {
      store.at = Date.now();
      store.courses = list.map(c => ({
        id: c.id,
        name: c.name || '',
        code: c.course_code || c.name || '',
        url: c.html_url || ('/courses/' + c.id)
      }));
      // 课程少了一批就把对应那几片丢掉，不然下架的课会一直留在结果里
      const live = new Set(store.courses.map(c => String(c.id)));
      for (const cid of Object.keys(store.shards)) if (!live.has(cid)) delete store.shards[cid];
      writeStore();
    }
    return store.courses;
  }

  // 收件箱不按课程分片：一次请求就能拿全，所以单独一份时间戳
  async function ensureMessages() {
    if (store.messages && Date.now() - store.messagesAt < SHARD_TTL) return;
    const list = await getJSON('/api/v1/conversations?per_page=50&scope=inbox');
    store.messagesAt = Date.now();
    if (Array.isArray(list)) {
      store.messages = list.map(cv => ({
        n: cv.subject || '(no subject)',
        u: '/conversations#filter=type=inbox&conversation_id=' + cv.id,
        d: cv.last_message_at ? Date.parse(cv.last_message_at) : 0
      }));
      store.messagesUsedAt = Date.now();
    } else if (!store.messages) store.messages = [];
  }

  // 一门课的六路名单。任何一路失败只少那一路的结果，不整片作废
  async function fetchShard(cid) {
    const jobs = {
      tasks: getJSON(`/api/v1/courses/${cid}/assignments?per_page=100&order_by=due_at`)
        .then(list => (Array.isArray(list) ? list.map(a => ({
          n: a.name, u: a.html_url, d: a.due_at ? Date.parse(a.due_at) : 0
        })) : [])),
      news: getJSON(`/api/v1/announcements?context_codes[]=course_${cid}&per_page=30&start_date=` +
        encodeURIComponent(new Date(Date.now() - 90 * DAY).toISOString()))
        .then(list => (Array.isArray(list) ? list.map(a => ({
          n: a.title, u: a.html_url, d: a.posted_at ? Date.parse(a.posted_at) : 0
        })) : [])),
      // 2026-10-09 实测：/courses/:id/files 在学生身份下回 403，/courses/:id/pages
      // 在老师关掉 Pages 工具时回 404。这一层是"任一路失败只少那一路的结果"，
      // 错误被吞掉之后，文件那一路从来没出过东西，所以名单改由模块派生（见下面 pageList/fileList 那两行注释）
      discussions: getJSON(`/api/v1/courses/${cid}/discussion_topics?per_page=50`)
        .then(list => (Array.isArray(list) ? list.map(d => ({
          n: d.title, u: d.html_url, d: (d.updated_at || d.posted_at) ? Date.parse(d.updated_at || d.posted_at) : 0
        })) : [])),
      // 一次模块请求当三份名单用（页面、文件、外链）。派生必须排在它 await 之后，
      // 写在前面拿到的是空数组——那种写法不报错，只是那三路永远空着
      modules: getJSON(`/api/v1/courses/${cid}/modules?include[]=items&per_page=100`)
        .then(list => (Array.isArray(list) ? list : [])),
      // 这两个旧端点只当补充来源，不再当唯一来源：学生身份下 files 回 403、
      // pages 在老师关掉 Pages 工具时回 404（getJSON 那一层吞掉错误回 null）。
      // 但老师账户上它们是活的，而它们能看见"没挂进任何模块的那一页"，
      // 只认模块那份名单的话，老师搜这类页面会从有结果变成没结果
      pageList: getJSON(`/api/v1/courses/${cid}/pages?per_page=100`),
      fileList: getJSON(`/api/v1/courses/${cid}/files?per_page=100&sort=updated_at`)
    };
    const [tasks, news, discussions, mods, pageList, fileList] = await Promise.all([
      jobs.tasks, jobs.news, jobs.discussions, jobs.modules, jobs.pageList, jobs.fileList
    ]);
    const pages = [];
    const files = [];
    const links = [];
    const seenUrl = {};
    const add = (bucket, title, url, when) => {
      if (!title || !url || seenUrl[url]) return;
      seenUrl[url] = 1;
      bucket.push({ n: title, u: url, d: when || 0 });
    };
    const LINK_TYPES = ['ExternalTool', 'ExternalUrl', 'Url', 'SubscriptionLaunch', 'BasicLtiLaunch'];
    for (const m of mods) {
      for (const it of m.items || []) {
        if (!it.title) continue;
        if (it.type === 'Page') add(pages, it.title, it.html_url || '');
        else if (it.type === 'File') add(files, it.title, it.html_url || '');
        else if (LINK_TYPES.includes(it.type)) {
          links.push({ n: it.title, u: it.html_url || it.external_url || '', d: 0, m: m.name || '' });
        }
      }
    }
    for (const p of Array.isArray(pageList) ? pageList : []) add(pages, p.title, p.html_url || '', p.updated_at ? Date.parse(p.updated_at) : 0);
    for (const f of Array.isArray(fileList) ? fileList : []) add(files, f.display_name, f.html_url || '', f.updated_at ? Date.parse(f.updated_at) : 0);
    const now = Date.now();
    return { at: now, usedAt: now, tasks, news, pages, files, discussions, links };
  }

  let entries = [];
  let building = null;
  let touchWriteTimer = 0;

  // 搜索时只改几枚时间戳，不能每敲一个字就同步写整份索引；合并成一次延后落盘。
  function scheduleTouchWrite() {
    if (touchWriteTimer) return;
    touchWriteTimer = setTimeout(() => {
      touchWriteTimer = 0;
      writeStore();
    }, 1800);
  }

  function flatten() {
    const out = [];
    for (const c of store.courses) {
      const color = courseColor(c.id);
      out.push({ k: 'course', title: c.name, sub: c.code, url: c.url, due: 0, cid: c.id, color });
      const sh = store.shards[String(c.id)];
      if (!sh) continue;
      const short = c.code || c.name;
      for (const a of sh.tasks || []) out.push({ k: 'task', title: a.n, sub: short, url: a.u, due: a.d || 0, cid: c.id, color });
      for (const a of sh.news || []) out.push({ k: 'news', title: a.n, sub: short, url: a.u, due: a.d || 0, cid: c.id, color });
      for (const a of sh.discussions || []) out.push({ k: 'discussion', title: a.n, sub: short, url: a.u, due: a.d || 0, cid: c.id, color });
      for (const a of sh.pages || []) out.push({ k: 'page', title: a.n, sub: short, url: a.u, due: a.d || 0, cid: c.id, color });
      for (const a of sh.files || []) out.push({ k: 'file', title: a.n, sub: short, url: a.u, due: a.d || 0, cid: c.id, color });
      for (const a of sh.links || []) out.push({ k: 'link', title: a.n, sub: [short, a.m].filter(Boolean).join(' · '), url: a.u, due: 0, cid: c.id, color });
    }
    for (const m of store.messages || []) {
      out.push({ k: 'message', title: m.n, sub: '', url: m.u, due: m.d || 0, cid: 0, color: '' });
    }
    entries = out.filter(e => e.title && e.url);
  }

  async function build() {
    if (building) return building;
    building = (async () => {
      try {
        await Promise.all([ensureCourses(), ensureMessages()]);
        flatten();                       // 先让已有的一份能用，新抓到的逐批补进来
        const stale = store.courses.filter(c => {
          const sh = store.shards[String(c.id)];
          return !sh || Date.now() - sh.at > SHARD_TTL;
        });
        for (let i = 0; i < stale.length; i += COURSE_BATCH) {
          const batch = stale.slice(i, i + COURSE_BATCH);
          await Promise.all(batch.map(async c => {
            store.shards[String(c.id)] = await fetchShard(c.id);
          }));
          flatten();
          writeStore();
          if (open) render();            // 边抓边补：第一门课的名单落地就该看得见
        }
      } finally {
        building = null;
      }
    })();
    return building;
  }

  /* ===== 排序 ===== */

  // 变音符那一整段用码位拼，不写字面字符：字面的组合符号在文件里看不见，谁路过都可能顺手改掉
  const DIACRITIC = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
  // 大小写、音调、全角都先抹平：老师写的 "Élan" 和他打的 "elan" 得撞上
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(DIACRITIC, '');
  }

  // "AP Bio" 和 "APBio" 是一回事，所以再备一份压掉空格连字符的
  function squash(s) {
    return norm(s).replace(/[\s_\-·•:，、]+/g, '');
  }

  function tokens(q) {
    return norm(q).split(/\s+/).filter(Boolean);
  }

  const KIND_WEIGHT = { course: 9, task: 6, news: 4, discussion: 3, page: 3, file: 2, link: 1, message: 2 };

  // 每个词都得撞上，撞不上整条出局；撞得越靠前分越高
  function score(e, toks, toksS, res, now) {
    const title = norm(e.title);
    const titleS = squash(e.title);
    const hay = norm(e.title + ' ' + e.sub);
    let s = KIND_WEIGHT[e.k] || 0;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (title.startsWith(tk)) s += 30;
      else if (res[i].test(title)) s += 20;
      else if (titleS.startsWith(toksS[i])) s += 25;
      else if (title.includes(tk)) s += 12;
      else if (titleS.includes(toksS[i])) s += 10;
      else if (hay.includes(tk)) s += 5;
      else if (squash(hay).includes(toksS[i])) s += 4;
      else return null;
    }
    if (e.k === 'task' && e.due) {
      const days = (e.due - now) / DAY;
      s += days >= 0 ? Math.max(0, 8 - days / 3) : -4;   // 快到期的浮上来，早过期的沉下去
    }
    return s;
  }

  function rank(q) {
    const toks = tokens(q);
    if (!toks.length) return [];
    const toksS = toks.map(t => squash(t));
    // 词首那条判据的正则按查询编一次：放在 score 里就是每条目每词各造一颗，
    // 三千条乘两个词＝一次按键六千颗正则
    const res = toks.map(t => new RegExp('(^|[\\s\\-/(·.,:])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const now = Date.now();
    const hits = [];
    for (const e of entries) {
      const sc = score(e, toks, toksS, res, now);
      if (sc !== null) hits.push({ e, sc });
    }
    hits.sort((a, b) => b.sc - a.sc || a.e.title.localeCompare(b.e.title));
    // 只有确实命中的缓存才续命；建索引时扫到的所有课程不算"最近使用"。
    const usedAt = Date.now();
    const usedCourses = new Set();
    let usedMessages = false;
    hits.forEach(x => {
      if (x.e.k === 'message') usedMessages = true;
      else if (x.e.cid) usedCourses.add(String(x.e.cid));
    });
    usedCourses.forEach(cid => {
      if (store.shards[cid]) store.shards[cid].usedAt = usedAt;
    });
    if (usedMessages) store.messagesUsedAt = usedAt;
    if (usedCourses.size || usedMessages) scheduleTouchWrite();
    return hits.map(x => x.e);
  }

  /* ===== 浮层 ===== */

  const ICONS = {
    course: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20"/>',
    task: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.5 12.2l2.4 2.4 4.8-5"/>',
    news: '<path d="M5 6h11a2 2 0 0 1 2 2v11H7a2 2 0 0 1-2-2z"/><path d="M18 12h1.5a1.5 1.5 0 0 1 1.5 1.5V16"/><path d="M8.5 9.5h6M8.5 13h4"/>',
    discussion: '<path d="M20 11.8a7.5 7.5 0 0 1-11.1 6.6L4.5 19.8l1.4-4.2A7.5 7.5 0 1 1 20 11.8z"/><path d="M9 11.5h6M9 14h3.5"/>',
    link: '<path d="M14 5h5v5"/><path d="M19 5l-7.5 7.5"/><path d="M18 13.5v4.5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 5 18v-8a2.5 2.5 0 0 1 2.5-2.5H12"/>',
    message: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M4 7.5l8 5.5 8-5.5"/>',
    page: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5V8h4"/><path d="M10 12.5h5M10 16h5"/>',
    file: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2.5h5.5A2.5 2.5 0 0 1 20 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/>'
  };

  function icon(kind) {
    const el = document.createElement('span');
    el.className = 'mcx-s-ico';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + (ICONS[kind] || ICONS.page) + '</svg>';
    return el;
  }

  function dateText(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  let panel = null, listEl = null, chipsEl = null, hintEl = null;
  let open = false, active = -1, picked = false, ordered = [];
  // 挑中的类型。空＝一颗都没挑＝全量都摆出来；挑了才只看那几类
  let selKinds = {};

  function mount() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'mcx-search-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Search results');
    chipsEl = document.createElement('div');
    chipsEl.className = 'mcx-s-chips';
    listEl = document.createElement('div');
    listEl.className = 'mcx-s-list';
    listEl.setAttribute('role', 'listbox');
    hintEl = document.createElement('div');
    hintEl.className = 'mcx-s-hint';
    panel.append(chipsEl, listEl, hintEl);
    document.body.appendChild(panel);
    // 点浮层不抢输入框的光标：一抢 blur 就把面板收了，等于点不动
    panel.addEventListener('mousedown', e => e.preventDefault());
    /* 滚轮落在这层就只滚这层：不然指针停在结果框上两指一划，推着身后整页走，
       List view 还会顺手把更早的作业一批批拉进来。preventDefault 要 passive:false 才认 */
    panel.addEventListener('wheel', e => {
      if (!open || !listEl) return;
      e.preventDefault();
      const step = e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * listEl.clientHeight : e.deltaY;
      listEl.scrollTop += step;
    }, { passive: false });
  }

  function place() {
    const inp = boundInput;
    if (!panel || !inp) return;
    /* 锚那颗框的外壳，不锚里面那颗 <input>：外壳和输入框之间隔着十几像素内边距，
       拿输入框定位出来的浮层左边缘就和屏幕上那颗胶囊对不齐（2026-10-16 实测偏 15.75px）。
       拿不到外壳（站点自己那颗没有组件宿主的输入框）才退回输入框本体 */
    const anchor = boundHost && boundHost !== inp && boundHost.getBoundingClientRect
      ? boundHost : inp;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // 右边一路拉到窗口右缘：这块浮层要盖得住右侧那一栏 ToDo，只跟着搜索框的宽度走就还是窄窄一条
    let left = Math.max(16, Math.round(r.left));
    const w = Math.max(380, Math.round(vw - 24 - left));
    left = Math.min(left, Math.max(16, vw - 24 - w));
    // 滚动把那颗框推出屏幕时不收起：跟着框走就一路贴着它，框出界了就钉在窗口上沿等着。
    // 之前就是这里一判"框不在视野里"就 close()，划一下页面结果框当场没了
    const top = Math.round(Math.min(Math.max(r.bottom + 8, 16), vh - 72));
    const maxH = Math.round(Math.max(220, vh - top - 24));
    const st = panel.style;
    // 只在数值真的变了才写：那台观察器会看见我们自己写的这几个属性，照抄一遍就再排一趟
    // 300 毫秒的扫描，面板开着就成了 3 赫兹的空转
    if (st.width !== w + 'px') st.width = w + 'px';
    if (st.left !== left + 'px') st.left = left + 'px';
    if (st.top !== top + 'px') st.top = top + 'px';
    if (st.maxHeight !== maxH + 'px') st.maxHeight = maxH + 'px';
  }

  function kindCounts(hits) {
    const counts = {};
    for (const h of hits) counts[h.k] = (counts[h.k] || 0) + 1;
    return counts;
  }

  function render() {
    if (!panel) return;
    const q = (boundInput && boundInput.value || '').trim();
    const hits = rank(q);
    const counts = kindCounts(hits);
    const chips = Object.keys(KINDS).filter(k => counts[k]).map(k => ({ k, n: counts[k] }));
    const filtering = Object.keys(selKinds).some(k => selKinds[k]);
    // 只有"点它确实会多出东西"的时候才摆那颗 View More：
    // 已经只看这一类时再摆一颗，按下去屏幕什么都不变
    const hasMore = k => !filtering && counts[k] > PER_KIND;

    chipsEl.replaceChildren();
    chipsEl.classList.toggle('filtered', filtering);
    if (chips.length > 1) {
      for (const c of chips) {
        const on = !!selKinds[c.k];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mcx-s-chip' + (on ? ' on' : '');
        b.setAttribute('aria-pressed', String(on));
        b.append(icon(c.k));
        const label = document.createElement('span');
        label.textContent = KINDS[c.k];
        const num = document.createElement('span');
        num.className = 'mcx-s-count';
        num.textContent = String(c.n);
        b.append(label, num);
        b.addEventListener('click', () => {
          selKinds[c.k] = !selKinds[c.k];
          // 挑到一颗不剩就回到"全量"，不造一个什么都不显示的洞
          if (!chips.some(x => selKinds[x.k])) selKinds = {};
          active = -1;
          render();
        });
        chipsEl.appendChild(b);
      }
    }

    /* 全量态每一类各给 15 条，挑了类型之后那一类整份摆出来。
       只按总分砍总条数的话，作业那一类会凭分数把整屏占满，看着就像"默认只搜了一类"。
       分组只是给同一类的几行各配一行标题字，不是一类一个框 */
    const picked = [];
    for (const k of Object.keys(KINDS)) {
      if (filtering && !selKinds[k]) continue;
      let n = 0;
      for (const h of hits) {
        if (h.k !== k) continue;
        if (!filtering && n >= PER_KIND) break;
        picked.push(h);
        n++;
      }
    }
    ordered = picked;
    if (active >= ordered.length) active = ordered.length - 1;

    listEl.replaceChildren();
    if (!ordered.length) {
      const p = document.createElement('p');
      p.className = 'mcx-s-empty';
      // 索引还在抓的时候不说"没有"，那是一句假话
      p.textContent = building && !entries.length
        ? 'Getting search ready…'
        : (q ? 'No matches for “' + q + '”.' : 'Search courses, assignments, and messages');
      listEl.appendChild(p);
    }
    let group = '';
    ordered.forEach((e, i) => {
      if (e.k !== group) {
        group = e.k;
        const kind = group;               // 回调要抓这一颗，group 后面还会被下一组改掉
        const head = document.createElement('div');
        head.className = 'mcx-s-group';
        const label = document.createElement('span');
        label.textContent = KINDS[kind];
        head.appendChild(label);
        if (hasMore(kind)) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'mcx-s-more';
          more.textContent = 'See more results';
          more.addEventListener('click', () => {
            // 等于一步到位地只挑这一类：那一类的其余项当场全出来
            selKinds = { [kind]: true };
            active = -1;
            render();
          });
          head.appendChild(more);
        }
        listEl.appendChild(head);
      }
      listEl.appendChild(rowEl(e, i));
    });
    mark();

    hintEl.textContent = 'Use ↑/↓ to move, Enter to open, and Esc to close.';
  }

  function rowEl(e, i) {
    const row = document.createElement('div');
    row.className = 'mcx-s-row' + (i === active ? ' on' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === active));
    const plate = document.createElement('span');
    plate.className = 'mcx-s-mark';
    plate.append(icon(e.k));
    const txt = document.createElement('span');
    txt.className = 'mcx-s-txt';
    const t = document.createElement('span');
    t.className = 'mcx-s-title';
    t.textContent = e.title;                       // 老师写的内容一律 textContent，不走 innerHTML
    txt.appendChild(t);
    // 第二行只在该有内容的时候才摆：收件箱那些没有课程名，空一行会把行高撑歪
    if (e.color || e.sub) {
      const s = document.createElement('span');
      s.className = 'mcx-s-sub';
      if (e.color) {
        const dot = document.createElement('span');
        dot.className = 'mcx-s-dot';
        dot.style.setProperty('--mcx-s-course', e.color);
        s.appendChild(dot);
      }
      if (e.sub) {
        const sub = document.createElement('span');
        sub.textContent = e.sub;                   // 类型那一档由分组标题说，这里只留课程名
        s.appendChild(sub);
      }
      txt.appendChild(s);
    }
    row.append(plate, txt);
    // 日期只给"到期""发布""最近一封"这三种说得清的，页面和文件的 updated 摆在这儿会被读成截止日
    const when = (e.k === 'task' || e.k === 'news' || e.k === 'message') ? dateText(e.due) : '';
    if (when) {
      const d = document.createElement('span');
      d.className = 'mcx-s-when';
      d.textContent = when;
      row.appendChild(d);
    }
    row.addEventListener('mousemove', () => { if (active !== i) { active = i; mark(); } });
    row.addEventListener('mousedown', ev => { ev.preventDefault(); go(e); });
    return row;
  }

  // 只翻那一行的选中态，不重画整列：重画会让鼠标划过时整块闪
  function mark() {
    if (!listEl) return;
    const rows = listEl.querySelectorAll('.mcx-s-row');
    rows.forEach((el, i) => {
      el.classList.toggle('on', i === active);
      el.setAttribute('aria-selected', String(i === active));
    });
    const on = listEl.querySelector('.mcx-s-row.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function go(e) {
    if (!e || !e.url) return;
    close();
    location.href = new URL(e.url, location.origin).href;
  }

  function show() {
    if (!boxOn()) return;
    mount();
    if (!open) {
      open = true;
      active = -1;
      picked = false;
      selKinds = {};               // 每次重新打开都从"全量结果"开始
      panel.classList.add('on');
      if (boundInput) boundInput.setAttribute('aria-expanded', 'true');
    }
    place();
    render();
    if (!building) build();
  }

  function close() {
    if (!open) return;
    open = false;
    active = -1;
    picked = false;
    selKinds = {};
    if (panel) panel.classList.remove('on');
    if (boundInput) boundInput.setAttribute('aria-expanded', 'false');
  }

  /* ===== 接到 Canvas 那颗搜索框上 ===== */

  let boundInput = null, boundHost = null;

  // 那颗框外面套着组件宿主（shadow root 里的那棵在文档树里够不到，得从 ShadowRoot.host 跳一层）。
  // 点它自带的放大镜不算"点了别的地方"，不能因此收面板
  function widgetHostOf(el) {
    let node = el;
    while (node && node !== document) {
      if (node.nodeType === 1 && (node.id === 'mcx-own-search' || /^ATOMIC-SEARCH-/.test(node.tagName))) return node;
      node = node.parentNode || node.host || null;
    }
    return el.form || el;
  }

  function findInput() {
    // 桌面和移动各一份组件，同一时刻只有一份看得见，用矩形长度挑那一份
    const hosts = document.querySelectorAll('atomic-search-desktop-widget, atomic-search-mobile-widget');
    for (const host of hosts) {
      const root = host.shadowRoot;
      const inp = root && root.querySelector('input[id^="ajas-search"], input[type="search"], input');
      if (inp && inp.getClientRects().length) return inp;
    }
    const plain = document.querySelector('#course_search, input[name="course_search"]');
    return plain && plain.getClientRects().length ? plain : null;
  }

  /* ===== 学校没装那颗框时，我们自己补一颗 =====
     顶上那颗 "Search Canvas" 不是 Canvas 自己的东西：它是厂商插件 Atomic Search（Atomic Jolt）
     往页面里挂的自定义元素，类名前缀 ajas-。学校没装，这个节点就压根不存在，
     也没有第二个"Canvas 原生搜索框"可以被强制显示出来。所以这一档只能我们自己画一颗，
     画完接回上面那套现成的（bind → show → render → place），索引和结果框一行都不改。 */

  const ownOn = () => localStorage.getItem('mc_search_box_own') !== '0';
  let ownBox = null;

  /* 每台学校判一次，判完记住：localStorage 本来就是按域名分的，一个学校一条。
     '1'＝这学校有原生那颗，永远不补；'0'＝确认没有，每次一上来就画；没记过＝还没判，
     先等一小趟（原生那颗是晚挂载的）再下结论。只记一次就够，因为每台学校的插件装没装是固定的。
     两条都带时间戳、过 30 天作废：学校中途装了或撤了那颗插件，判据要能自己翻过来。 */
  const NATIVE_KEY = 'mcx_search_has_native';
  const NATIVE_TTL = 30 * 24 * 3600000;
  const NATIVE_GRACE = 900;
  let judgedAt = 0;

  function verdict() {
    const raw = localStorage.getItem(NATIVE_KEY) || '';
    const i = raw.indexOf(':');
    if (i < 0) return '';
    if (!Number(raw.slice(i + 1)) || Date.now() - Number(raw.slice(i + 1)) > NATIVE_TTL) return '';
    return raw.slice(0, i);
  }
  function setVerdict(v) {
    try { localStorage.setItem(NATIVE_KEY, v + ':' + Date.now()); } catch (e) {}
  }
  // 组件元素在不在，比"它有没有矩形"更早能断定：它和它住的那一排是同一次渲染出来的，
  // 元素已经在了但还没排版出来的那一趟，也算这学校有
  function nativeWidgetMounted() {
    return !!document.querySelector('atomic-search-desktop-widget, atomic-search-mobile-widget');
  }

  // 两颗都在"右上角"：Dashboard 那一排是三颗点左边（那一排右对齐，插到三颗点前面就是中间），
  // 其余页面一律钉最上面那条面包屑行（课程名＋当前页那一行）的右端。
  // 这里不用 .header-bar：那是各页内容区自己的工具条，Modules 那条里面本来就站着 Canvas 自带的
  // 模块搜索框（2026-10-16 ndm 实测撞在一起），而且它比面包屑低一整行，不是"右上角"
  function ownSlot() {
    /* 新版那一屏右上角这一排里没有站点自己那颗三颗点的容器（旧版才有），
       排最后的是我们自己造的那颗 ⋯。认这一排的办法照 content.js 造那颗 ⋯ 用的同一句：
       只认 InstUI 的组件名后缀 -view--flex-flex，不认那串哈希前缀（它会随构建换）。
       插到那颗 ⋯ 的左边＝他拍的"显示在三个点的左侧"。 */
    /* 抬头那颗和"Customize dashboard"在同一排里（实测：那一排的四颗依次是
       抬头／切回旧版／Customize dashboard／我们那颗 ⋯）。
       有的学校不给"切回旧版"那一档＝没有 customize 那颗，所以两颗都认。 */
    const anchor = document.querySelector('[data-testid="customize-dashboard-button"]') ||
      document.querySelector('[data-testid="dashboard-heading"]');
    const row = anchor && anchor.closest ? anchor.closest('span[class*="-view--flex-flex"]') : null;
    if (row) return { host: row, before: document.getElementById('mc-new-dash-options-btn') || null, cls: 'mcx-own-search-newdash' };
    const opts = document.getElementById('DashboardOptionsMenu_Container');
    if (opts && opts.parentNode) return { host: opts.parentNode, before: opts, cls: 'mcx-own-search-dash' };
    const crumb = document.getElementById('breadcrumbs');
    if (crumb) return { host: crumb, before: null, cls: 'mcx-own-search-bar' };
    return null;
  }

  function makeOwn() {
    const wrap = document.createElement('span');
    wrap.className = 'mcx-own-search';
    wrap.id = 'mcx-own-search';
    const inp = document.createElement('input');
    inp.type = 'search';
    inp.className = 'mcx-own-search__inp';
    inp.placeholder = 'Search Canvas';
    inp.setAttribute('aria-label', 'Search Canvas');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('spellcheck', 'false');
    const btn = document.createElement('span');
    btn.className = 'mcx-own-search__btn';
    btn.setAttribute('aria-hidden', 'true');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="M15.4 15.4 20 20"/></svg>';
    btn.addEventListener('click', () => inp.focus());
    inp.dataset.mcxOwn = '1';
    wrap.append(inp, btn);
    return { wrap, inp, host: null, slotCls: '' };
  }

  function ensureOwn() {
    if (!ownOn()) { dropOwn(); return null; }
    // 组件元素已经在了＝这学校装了那颗插件（哪怕这一页它还没排版出来），记下来并且不补
    if (nativeWidgetMounted()) { setVerdict('1'); dropOwn(); return null; }
    if (verdict() === '1') { dropOwn(); return null; }
    const slot = ownSlot();
    if (!slot) { dropOwn(); return null; }
    if (verdict() === '') {
      // 这台学校还没判过：先等一小趟，给晚挂载的原生那颗留时间。判完就落盘，
      // 以后每次进来要么一上来就画、要么永远不画，不再出现"闪出来 0.1 秒"
      if (!judgedAt) { judgedAt = Date.now(); scheduleSweep(); return null; }
      if (Date.now() - judgedAt < NATIVE_GRACE) { scheduleSweep(); return null; }
      setVerdict('0');
    }
    if (!ownBox || !ownBox.wrap.isConnected) ownBox = makeOwn();
    if (ownBox.slotCls !== slot.cls) {
      // 空串不能进 classList：remove('') 在 Chrome 里直接抛 SyntaxError，一抛这一整份就断在顶层
      if (ownBox.slotCls) ownBox.wrap.classList.remove(ownBox.slotCls);
      ownBox.wrap.classList.add(slot.cls);
      ownBox.slotCls = slot.cls;
    }
    if (ownBox.host && ownBox.host !== slot.host) ownBox.host.classList.remove('mcx-own-search-host');
    const host = slot.host;
    if (host !== ownBox.wrap.parentNode) {
      slot.before ? host.insertBefore(ownBox.wrap, slot.before) : host.appendChild(ownBox.wrap);
    } else if (slot.before && ownBox.wrap.nextElementSibling !== slot.before) {
      host.insertBefore(ownBox.wrap, slot.before);
    }
    // 顶行不是 flex，绝对定位才不用猜它内部的排布；position:relative 只在这一颗真的住进去时才挂
    if (!slot.before) host.classList.add('mcx-own-search-host');
    ownBox.host = host;
    return ownBox.inp;
  }

  function dropOwn() {
    if (!ownBox) return;
    if (ownBox.host) ownBox.host.classList.remove('mcx-own-search-host');
    if (ownBox.wrap.parentNode) ownBox.wrap.parentNode.removeChild(ownBox.wrap);
    ownBox = null;
  }

  function bind(inp) {
    if (boundInput === inp) return;
    boundInput = inp;
    if (!inp) { boundHost = null; close(); return; }
    boundHost = widgetHostOf(inp);
    // Canvas 的 React 会把同一个输入框换成一棵新节点，观察器每 300 毫秒扫一趟；
    // 没有这颗标记的话同一颗会被挂上好几套监听，一次按键画好几趟
    if (inp.dataset.mcxSearchBound) return;
    inp.dataset.mcxSearchBound = '1';

    inp.addEventListener('input', () => {
      (inp.value || '').trim() ? show() : close();
    });
    inp.addEventListener('focus', () => { if ((inp.value || '').trim()) show(); });
    inp.addEventListener('keydown', e => {
      if (!open) return;
      const n = listEl.querySelectorAll('.mcx-s-row').length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!n) return;
        e.preventDefault();
        picked = true;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        mark();
      } else if (e.key === 'Enter') {
        // 没按过方向键就把回车留给 Canvas 自己（那颗框原本的动作是筛当前这一屏的卡片），
        // 只在用户明显在挑我们这一列结果时才接管。
        // 我们补的那颗没有"原本的动作"，回车就直接开第一条，不然按下去什么也不发生
        if (!picked || active < 0) {
          if (inp.dataset.mcxOwn && ordered.length) {
            e.preventDefault();
            go(ordered[0]);
          }
          return;
        }
        e.preventDefault();
        go(rowEntry(active));
      } else if (e.key === 'Escape') {
        close();
      }
    });
  }

  // render 里那批行按分组顺序摆，选中项直接按同一份 ordered 取
  function rowEntry(i) {
    return ordered[i] || null;
  }

  function sweep() {
    if (!boxOn()) { close(); return; }
    // 已经接上那颗框、而且它还在页面上：不必再扫一遍 DOM。
    // Canvas 的 React 换节点时旧那颗的 isConnected 当场变 false，才会走下面的重扫
    if (boundInput && boundInput.isConnected && boundInput.getClientRects().length) {
      /* 我们这颗是"没框才补"补出来的，原生那颗可能晚挂载（厂商插件自己 React 画的，
         它比 document_idle 慢就变成同一排两颗并排）。所以绑的是我们这颗时，每趟都要回头
         再看一眼原生在不在——先只查一次标签名（不要版面），它真出现了才走 findInput 换锚。
         2026-10-16 hcpss 实测：一阵一阵，全看那一刻谁先到 */
      if (boundInput.dataset.mcxOwn &&
          document.querySelector('atomic-search-desktop-widget, atomic-search-mobile-widget')) {
        const native = findInput();
        if (native) { setVerdict('1'); dropOwn(); bind(native); if (open) place(); return; }
      }
      if (open) place();
      return;
    }
    const inp = findInput();
    if (inp) { setVerdict('1'); dropOwn(); bind(inp); if (open) place(); return; }
    // 那颗框不在这台学校上：这一趟换成我们自己补的那一颗
    const own = ensureOwn();
    if (own) { bind(own); if (open) place(); return; }
    dropOwn();
    // 只是这一趟没读到矩形（滚动中、组件重排中）时不收面板，只有它真的从文档里没了才收。
    // 上一版这里一判空就 close()，于是划一下页面结果框当场消失
    if (!boundInput || !boundInput.isConnected) close();
    else if (open) place();
  }

  // Canvas 的 React 会随时重画那颗框，观察器合并成 300 毫秒一趟，不逐条变动各跑一趟
  let sweepTimer = 0;
  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => { sweepTimer = 0; sweep(); }, 300);
  }

  document.addEventListener('pointerdown', e => {
    if (!open || !panel) return;
    if (panel.contains(e.target)) return;
    // 点在 shadow root 里的那颗输入框上时，事件的 target 会被改写成宿主元素，
    // 所以要顺着 composedPath 找真正的落点，不然一聚焦就把自己的面板收了
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (boundInput && path.indexOf(boundInput) !== -1) return;
    if (boundHost && path.indexOf(boundHost) !== -1) return;
    close();
  }, true);
  /* 跟随要合帧：这两个监听挂的是 capture，页面里每一个滚动容器（整页、那一栏、抽屉）滚一下都会进来一趟，
     一趟读一次锚点方框＝一次强制布局。排进 rAF 后一帧最多一趟，值没变就一个属性都不写。 */
  let placeQueued = false;
  function queuePlace() {
    if (placeQueued || !open) return;
    placeQueued = true;
    requestAnimationFrame(() => { placeQueued = false; if (open) place(); });
  }
  window.addEventListener('resize', queuePlace);
  window.addEventListener('scroll', queuePlace, true);

  readStore();
  // 只在没有处于纯对话/通讯录等页面时运行全局搜索观测器，避免在打字搜人时产生多余的 sweep 扫描
  if (!location.pathname.includes('/conversations')) {
    new MutationObserver(scheduleSweep).observe(document.documentElement, { childList: true, subtree: true });
    sweep();
    if (boxOn()) setTimeout(() => { if (!building && (findInput() || ensureOwn())) build(); }, 2500);
  }
})();
