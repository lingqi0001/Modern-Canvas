/* =========================================================
   聊天历史：一条会话一条，存在扩展自己的 chrome.storage.local（study-storage.js）。

   为什么不是这一页的 localStorage
   - 这一档存的是学生自己写的问句和模型答给他的整段话。页面存储归"这所学校的域名"共用，
     站点脚本读得到；扩展存储不是同一个源。
   - 老版本这里写的是 localStorage，第一次开页由 study-storage.js 搬一次过来，
     搬过去并回读确认过才算搬完，搬不成时旧数据原样留着，下次再搬。

   界面读数是同步的
   - chrome.storage 要到 document_idle 才回得来，而历史那一屏、"存下了没有"那句判据都要同步值。
     所以这一层把库里那一份抄在脑子里（mem），UI 读的一直是脑子。
   - mem 是 null 还是空数组必须分得清：null 是"还没读到过"，那种时候不能报"你还没有存过会话"，
     那是假空状态。读回来一次以后才认空数组。
   - 落盘是异步的，排在一条链上（pending）：连着存两次不许后一次的回调跑在前一次之前。

   库里存什么
   - 存：轮次（问和答）、模型、出处那一份对照表的标题和地址、任务名、时间。
   - 不存：课件正文、图片的 data URL、任何请求头、任何 key。
     读回来的时候也一律照着这张名单挑，认不出来的一律不带进去。
   - 上限两条：条数（最新的 50 条，正在看的那条永远不淘汰）＋时间（默认清 90 天以前，
     在设置的 Privacy & storage 那一节可以改成 30 天或永久）。
   ========================================================= */
(function () {
  // 非 Canvas 站点直接退出
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
  var KEY = 'mc_ai_chats_v1';
  var DAYS_KEY = 'mc_ai_history_days';
  var CAP = 50;
  var DEFAULT_DAYS = 90;
  var DAY_MS = 86400000;
  var LOG = '[MCX history]';
  /* 一答留这么多字。总结正常就几千字，真超出去的形状是"有人把整份课件抄进了答案"——
     那正是这一档禁止入库的东西，砍掉尾巴而不是照存 */
  var ANSWER_CAP = 60000;
  /* 图片的 base64 一张就是几十万字，它本来就是从课件里抠出来的，绝不该进历史那一格 */
  var DATA_IMAGE = /data:image\/[a-z0-9.+\-%]+;base64,[A-Za-z0-9+/=\s]+/gi;

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function store() { return window.MCxStorage || null; }

  var mem = null;
  var pending = Promise.resolve();
  var lastWrite = { ok: true, error: '' };

  function usable(s) {
    return !!s && typeof s.id === 'string' && s.courseId
      && Array.isArray(s.turns) && s.turns.length
      && s.turns.some(function (t) { return t && t.a; });
  }

  function plain(text, cap) {
    var t = String(text == null ? '' : text).replace(DATA_IMAGE, '[picture]');
    var n = Number(cap) || ANSWER_CAP;
    return t.length > n ? t.slice(0, n) : t;
  }

  /* 覆盖表按名单再削一遍：十二格考点、每格两条出处、每条摘录两百字封顶。
     这一格里永远不许出现正文，它存的是"哪个考点有没有材料撑"这件事 */
  var COV_STATUS = { covered: 1, weak: 1, none: 1 };

  function compactCoverage(raw) {
    var rows = Array.isArray(raw) ? raw : [];
    return rows.slice(0, 12).map(function (c) {
      return {
        name: plain(c.name, 160),
        status: COV_STATUS[c.status] ? c.status : 'none',
        parts: (Array.isArray(c.parts) ? c.parts : []).slice(0, 2).map(function (p) {
          return {
            title: plain(p.title, 200),
            module: plain(p.module, 200),
            tag: String(p.tag || '').slice(0, 16),
            url: String(p.url || '').slice(0, 500),
            excerpt: plain(p.excerpt, 200)
          };
        })
      };
    });
  }

  function compactSent(raw) {
    var s = raw && typeof raw === 'object' ? raw : null;
    if (!s) return null;
    return {
      items: Number(s.items) || 0, sentItems: Number(s.sentItems) || 0, parts: Number(s.parts) || 0,
      concepts: Number(s.concepts) || 0, covered: Number(s.covered) || 0, weak: Number(s.weak) || 0,
      tokens: Number(s.tokens) || 0,
      missing: (Array.isArray(s.missing) ? s.missing : []).slice(0, 12).map(function (x) { return plain(x, 160); })
    };
  }

  /* 那一轮的用量：只留几个数，模型名以外的东西一个都不进库。
     没有报数的那一轮留 null，不许在这里补一个 0，因为回复底下那一行要分得清"报了 0"和"没报" */
  function plainUsage(raw) {
    var u = raw && typeof raw === 'object' ? raw : null;
    if (!u) return null;
    var out = {};
    var got = false;
    [['prompt', 0], ['completion', 0], ['total', 0], ['cached', 0], ['reasoning', 0]].forEach(function (pair) {
      var n = Number(u[pair[0]]);
      if (isFinite(n) && n >= 0) { out[pair[0]] = Math.floor(n); got = true; }
    });
    var c = Number(u.cost);
    if (isFinite(c) && c >= 0) { out.cost = c; got = true; }
    return got ? out : null;
  }

  /* 那一串请求的计数：每一趟一项，屏上那句加法（500 + 400 = 900）读的就是这一列。
     旧库里存的是每一轮单个 usage，读的时候顺手折成一项，所以那一列不会凭空空掉 */
  function compactCalls(raw) {
    var rows = Array.isArray(raw) ? raw : [];
    return rows.slice(0, 40).map(function (c) {
      return plainUsage(c && c.usage ? c.usage : c);
    }).filter(function (u) { return u; });
  }

  /* 照名单重建一条。写进来的人是谁都不信：库里那一格只准有这些字段，
     多出来的（正文、请求头、key）在这里被摘掉 */
  function sanitize(sess) {
    var sources = {};
    var raw = sess.sources && typeof sess.sources === 'object' ? sess.sources : {};
    Object.keys(raw).forEach(function (tag) {
      var s = raw[tag];
      if (!s || typeof s !== 'object') return;
      sources[String(tag)] = {
        title: plain(s.title, 200),
        module: plain(s.module, 200),
        kind: String(s.kind || ''),
        url: String(s.url || '').slice(0, 500),
        chars: Number(s.chars) || 0
      };
    });
    return {
      id: String(sess.id),
      courseId: Number(sess.courseId) || 0,
      courseName: plain(sess.courseName, 200),
      title: plain(sess.title || 'Saved chat', 200),
      template: String(sess.template || ''),
      createdAt: Number(sess.createdAt) || 0,
      updatedAt: Number(sess.updatedAt) || Number(sess.createdAt) || 0,
      assessments: (Array.isArray(sess.assessments) ? sess.assessments : []).slice(0, 20).map(function (x) { return plain(x, 200); }),
      sources: sources,
      coverage: compactCoverage(sess.coverage),
      sent: compactSent(sess.sent),
      turns: sess.turns.filter(function (t) { return t && t.a; }).map(function (t) {
        return {
          q: plain(t.q, 4000), a: plain(t.a), model: String(t.model || '').slice(0, 120),
          /* 每一轮自己那几趟；旧库里那一格只有一个 usage，就折成加法里的一项 */
          calls: compactCalls(t.calls && t.calls.length ? t.calls : (t.usage ? [t.usage] : []))
        };
      }),
      // 整场那一份单独留：被 Again 换掉的那一轮已经不在 turns 里，它的钱要靠这一格留住
      calls: compactCalls(sess.calls)
    };
  }

  /* 保留期。库里那一格是数字：30、90、0（0＝永久）。
     读到别的东西一律回到默认那一档，不许出现"填错了就永远不删"的意外 */
  function retentionDays() {
    var s = store();
    var v = s ? s.getSyncFallback(DAYS_KEY, null) : null;
    if (v === null || v === undefined || v === '') return DEFAULT_DAYS;
    var n = Number(v);
    if (isNaN(n) || n < 0) return DEFAULT_DAYS;
    return n;
  }

  function prune(list, keepId) {
    var days = retentionDays();
    if (!days) return list;
    var floor = Date.now() - days * DAY_MS;
    // 手上正打开的那一条不受保留期限制：他点开一条三个月前的接着问，
    // 不该在保存那一刻就被"过期"抹掉（上限那一条本来就让着它，这里要让得一致）
    return list.filter(function (s) { return s.id === keepId || (s.updatedAt || 0) >= floor; });
  }

  function fromDisk(raw) {
    var list = raw;
    if (typeof raw === 'string') {
      try { list = JSON.parse(raw); } catch (e) { list = null; }
    }
    if (!Array.isArray(list)) return [];
    // 认不出来的一条直接丢：留着一份坏数据，列表那一屏就会在某个节点上抛错
    return prune(list.filter(usable).map(sanitize));
  }

  function hydrate() {
    var s = store();
    if (!s) {
      if (mem === null) mem = [];
      return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    }
    return s.get(KEY, []).then(function (raw) {
      // 已经有脑子就不再对账：这一页里刚删掉的那一条，库里可能还排在异步那一步前面，
      // 一合并就把他删掉的东西还回来了
      if (mem === null) mem = fromDisk(raw);
      return { ok: true, count: mem.length };
    }, function (err) {
      if (mem === null) mem = [];
      return { ok: false, error: String((err && err.message) || err || 'could not read saved chats') };
    });
  }

  function read() {
    if (mem === null) return [];
    return mem.slice();
  }

  function queueWrite() {
    var s = store();
    var snapshot = JSON.stringify(mem || []);
    if (!s) {
      lastWrite = { ok: false, error: 'secure extension storage is unavailable' };
      pending = Promise.resolve(lastWrite);
      return pending;
    }
    pending = pending.then(function () {
      return s.set(KEY, JSON.parse(snapshot));
    }).then(function (res) {
      lastWrite = res && res.ok ? { ok: true, error: '' } : { ok: false, error: String((res && res.error) || 'the write did not go through') };
      if (!lastWrite.ok) log('could not write:', lastWrite.error);
      return lastWrite;
    }, function (err) {
      // 这一链上不许留一个没人接的失败：它挂在异步尾巴上，甩出去就是一条看不懂的报错
      lastWrite = { ok: false, error: String((err && err.message) || err || 'the write did not go through') };
      return lastWrite;
    });
    return pending;
  }

  function byNewest(a, b) { return b.updatedAt - a.updatedAt; }

  /* 存或原地更新一条。keepId 是"正在看的那一条"，淘汰最旧时永远绕开它。
     返回值还是同步那一套（画面当场要用 count），落库成没成挂在 done 上，
     因为异步那一步失败时答案已经在他屏幕上了——那一屏绝不能因为存不下就撤掉 */
  function save(sess, keepId) {
    if (!usable(sess)) return { ok: false, error: 'nothing to save yet', count: read().length, dropped: 0 };
    var clean = sanitize(sess);
    var list = read();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === clean.id) { list[i] = clean; found = true; break; }
    }
    if (!found) list.push(clean);
    list = prune(list, keepId);
    list.sort(byNewest);
    var dropped = 0;
    while (list.length > CAP) {
      var cut = list.length - 1;
      // 手上这一条永远不删：它正好排在最旧那一头时，就往旁边挪一位删它前面那条
      if (list[cut].id === keepId) cut--;
      if (cut < 0 || list[cut].id === keepId) break;
      list.splice(cut, 1);
      dropped++;
    }
    mem = list;
    return { ok: true, dropped: dropped, count: list.length, done: queueWrite() };
  }

  function get(id) {
    var hit = read().filter(function (s) { return s.id === id; })[0];
    return hit || null;
  }

  function remove(id) {
    var list = read().filter(function (s) { return s.id !== id; });
    mem = list;
    return { ok: true, count: list.length, done: queueWrite() };
  }

  /* 清的是扩展存储里那一格。页面存储那一头由 study-storage.js 的搬表管着，
     这一颗不碰它：他刚搬完又立刻清掉另一头，回头发现两边都没了 */
  function clear() {
    mem = [];
    var s = store();
    if (!s) return { ok: false, count: 0, error: 'secure extension storage is unavailable', done: Promise.resolve({ ok: false }) };
    var done = s.remove(KEY).then(function (res) {
      lastWrite = res && res.ok ? { ok: true, error: '' } : { ok: false, error: String((res && res.error) || 'could not clear') };
      return lastWrite;
    });
    return { ok: true, count: 0, done: done };
  }

  function list() { return read().sort(byNewest); }

  function forCourse(courseId) {
    var cid = Number(courseId) || 0;
    if (!cid) return list();
    return read().filter(function (s) { return Number(s.courseId) === cid; }).sort(byNewest);
  }

  function count() { return read().length; }

  /* 有没有真读到过一次。没读到过的空不等于"没存过"，那一屏要说"Reading saved chats…" */
  function known() { return mem !== null; }

  function setRetention(days) {
    var n = Number(days);
    if (isNaN(n) || n < 0) n = DEFAULT_DAYS;
    var s = store();
    if (!s) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    return s.set(DAYS_KEY, n).then(function (res) {
      if (res && res.ok && mem !== null) {
        mem = prune(mem);
        queueWrite();
      }
      return res;
    });
  }

  window.MCxHistory = {
    key: KEY,
    daysKey: DAYS_KEY,
    cap: CAP,
    defaultDays: DEFAULT_DAYS,
    hydrate: hydrate,
    known: known,
    save: save,
    get: get,
    remove: remove,
    clear: clear,
    list: list,
    forCourse: forCourse,
    count: count,
    retentionDays: retentionDays,
    setRetention: setRetention,
    sanitize: sanitize,
    flush: function () { return pending; },
    lastWriteError: function () { return lastWrite.ok ? '' : lastWrite.error; }
  };

  // 一跑到就发起读数：晚一帧，历史那一屏就要多画一屏"Reading saved chats…"
  try { if (store()) hydrate(); } catch (e) {}
})();
