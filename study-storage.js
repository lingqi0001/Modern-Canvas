/* =========================================================
   扩展自己的存储：chrome.storage.local。

   为什么要有这一层
   - AI 的 key、账户清单、聊天历史以前存在 Canvas 那一页的 localStorage 里。
     那一块地盘是"这所学校的域名"共用的：站点自己的脚本、别的扩展、以及任何在这台机器上
     读得到这个域的东西，都看得见它。扩展自己的存储不是同一个源，站点脚本读不到。
   - 所以这一层只管 AI 那几格。主题、颜色、侧栏那些一律不搬，它们不是学生写的东西，
     也没有钥匙，搬了只会多一份会走岔的来源。

   用不了的时候怎么办
   - "storage" 权限没生效、扩展刚重载导致上下文失效、或 Chrome 本身不答理这一格：
     这些都当成"安全存储不可用"。这时只报一句 secure extension storage is unavailable，
     绝不把 key 悄悄退回页面 localStorage——那正是这次要修掉的东西。
   - 内存里那一份缓存照常用，所以面板这一趟还发得出去；它活不过刷新，刷新后要重填。

   迁移的口径
   - 只搬 AI 相关的 key，见 ALLOWLIST。
   - 完成标记 mc_ai_storage_migrated_v1 落在扩展存储里，落成了就不再动。
   - 只填"扩展存储里还没有"的那几格：已经有值的绝不覆盖，那样第二次跑不会把新写的旧数据盖掉。
   - 写完必须回读确认，确认过才挂标记。任何一步没成都不许挂标记，也一律不删 localStorage 里的旧数据，
     于是老用户顶多是"这次没搬成，下次再搬"，不会两头都没有。

   对外的形状
   - get(key, fallback) → Promise，回的是那格里存的值，没有就回 fallback。
   - set(key, value) / remove(key) → Promise，回的是 { ok, error }。失败不抛，因为调用方每一处都要画画面。
   - migrateOnce() → Promise，回 { ok, moved, skipped, error }。
   - getSyncFallback(key, fallback) → 同步值。给"启动阶段就要读数"的那几处用，
     它先看内存缓存，缓存还没有才碰 localStorage，而且只碰不涉密的那几格。
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
  var LOG = '[MCX storage]';
  var MIGRATION_FLAG = 'mc_ai_storage_migrated_v1';
  var NO_STORE = 'secure extension storage is unavailable';

  /* 涉密那一档（secret）判的是"这一段能不能让人读出他账户的钥匙，或他写了什么"：
     账户清单整份带 key、那一格单值的 key、聊天历史是学生的原话。
     这几格在 getSyncFallback 里永远不回退到 localStorage，免得读一次就多续一次命。 */
  var ALLOWLIST = [
    { key: 'mc_ai_consent_v1', secret: true },
    { key: 'mc_ai_slots_v1', secret: true },
    { key: 'mc_ai_profiles_v1', secret: true },
    { key: 'mc_ai_active', secret: true },
    { key: 'mc_ai_key', secret: true },
    { key: 'mc_ai_base', secret: false },
    { key: 'mc_ai_model', secret: false },
    { key: 'mc_ai_provider', secret: false },
    { key: 'mc_ai_last_model', secret: false },
    { key: 'mc_ai_chats_v1', secret: true },
    { key: 'mc_ai_progress_v1', secret: true },
    // 用量那一本账：里面是模型名和触发它的功能名，不带钥匙也不带学生写的原话，
    // 但它是"这台机器上这个人用了什么"的清单，所以照样只住扩展存储，不往页面那一头退
    { key: 'mc_ai_usage_v1', secret: true },
    { key: 'mc_ai_usage_line', secret: false },
    // AI 总开关：正本住在这里，页面那一头那份只是给 document_start 那一批用的同步影子
    { key: 'mc_ai_enabled', secret: false },
    { key: 'mc_ai_format', secret: false },
    { key: 'mc_ai_ocr', secret: false },
    { key: 'mc_ai_history_days', secret: false },
    { key: 'mc_ai_access_code', secret: true },
    // 云端登录会话和自带 key 一样可代表用户身份，绝不能放在 Canvas 页面的 localStorage。
    { key: 'mc_ai_cloud_auth_v1', secret: true }
  ];

  function meta(key) {
    for (var i = 0; i < ALLOWLIST.length; i++) if (ALLOWLIST[i].key === key) return ALLOWLIST[i];
    return null;
  }

  function log() {
    // 这一句永远不许带出 key 或学生的原话：调用方只准传"哪一格、成没成"这样的东西
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function safeMessage(e) {
    return String((e && (e.message || e.name)) || e || 'unknown');
  }

  /* 扩展重载后，旧页面里这一份脚本的上下文已经失效，那时连 chrome 这个属性都读不出来，
     一碰就抛。所以下面每一次取 API 都要罩在 try 里，不能只判 typeof chrome。 */
  function localApi() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
      var l = chrome.storage.local;
      if (typeof l.get !== 'function' || typeof l.set !== 'function' || typeof l.remove !== 'function') return null;
      return l;
    } catch (e) {
      return null;
    }
  }

  function lastErrorText() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime) return '';
      var le = chrome.runtime.lastError;
      return le ? safeMessage(le) : '';
    } catch (e) {
      return safeMessage(e);
    }
  }

  var cache = {};
  var started = null;
  var isLoaded = false;
  var broken = '';

  /* ==== 三条底层调用：一律走回调形状，好把 runtime.lastError 读到 ====
     不 reject：调用方每一处都要在失败时照样把画面画完。 */

  function rawGet(keys) {
    return new Promise(function (resolve) {
      var l = localApi();
      if (!l) { resolve({ ok: false, error: NO_STORE }); return; }
      var settled = false;
      function fin(obj, err) {
        if (settled) return;
        settled = true;
        if (err) resolve({ ok: false, error: err });
        else resolve({ ok: true, obj: obj || {} });
      }
      try {
        l.get(keys, function (obj) { fin(obj, lastErrorText()); });
      } catch (e) {
        fin(null, safeMessage(e));
      }
    });
  }

  function rawSet(obj) {
    return new Promise(function (resolve) {
      var l = localApi();
      if (!l) { resolve({ ok: false, error: NO_STORE }); return; }
      var settled = false;
      function fin(err) {
        if (settled) return;
        settled = true;
        resolve(err ? { ok: false, error: err } : { ok: true });
      }
      try {
        l.set(obj, function () { fin(lastErrorText()); });
      } catch (e) {
        fin(safeMessage(e));
      }
    });
  }

  function rawRemove(keys) {
    return new Promise(function (resolve) {
      var l = localApi();
      if (!l) { resolve({ ok: false, error: NO_STORE }); return; }
      var settled = false;
      function fin(err) {
        if (settled) return;
        settled = true;
        resolve(err ? { ok: false, error: err } : { ok: true });
      }
      try {
        l.remove(keys, function () { fin(lastErrorText()); });
      } catch (e) {
        fin(safeMessage(e));
      }
    });
  }

  function lsGet(key) {
    var v = null;
    try { v = localStorage.getItem(key); } catch (e) { return null; }
    return v == null ? null : v;
  }

  /* 旧那一头是字符串。看着像 JSON 的那几格（账户清单、历史）在搬之前必须还原成结构，
     否则新那一头存的就是"一份字符串套着 JSON"，读的人得猜两次 */
  function fromLegacy(key, raw) {
    var s = String(raw);
    if (!s) return null;
    if (/^[\s]*[[{]/.test(s)) {
      try { return JSON.parse(s); } catch (e) { return s; }
    }
    if (key === 'mc_ai_history_days') {
      var n = Number(s);
      return isNaN(n) ? null : n;
    }
    return s;
  }

  function toLegacyValue(value) {
    if (value !== null && typeof value === 'object') { try { return JSON.stringify(value); } catch (e) { return null; } }
    return String(value);
  }

  function readLegacy() {
    var out = {};
    ALLOWLIST.forEach(function (row) {
      var raw = lsGet(row.key);
      if (raw === null || raw === '') return;
      var v = fromLegacy(row.key, raw);
      if (v !== null && v !== '') out[row.key] = v;
    });
    return out;
  }

  /* 回读是唯一的判据：set 的回调不报错不等于那几格真进了库。
     比对"搬进去的那几格有没有一格不在库里"，比整体快照轻，也够定案。 */
  function verifyWritten(obj) {
    var keys = Object.keys(obj);
    if (!keys.length) return Promise.resolve(true);
    return rawGet(keys).then(function (res) {
      if (!res.ok) return false;
      for (var i = 0; i < keys.length; i++) {
        var want = obj[keys[i]];
        var got = res.obj[keys[i]];
        if (want === undefined) continue;
        if (got === undefined || got === null) return false;
        if (typeof want === 'object') {
          try { if (JSON.stringify(got) !== JSON.stringify(want)) return false; } catch (e) { return false; }
        } else if (String(got) !== String(want)) {
          return false;
        }
      }
      return true;
    });
  }

  function migrateOnce() {
    return rawGet([MIGRATION_FLAG].concat(ALLOWLIST.map(function (r) { return r.key; }))).then(function (res) {
      if (!res.ok) {
        broken = res.error || NO_STORE;
        return { ok: false, moved: [], skipped: [], error: broken };
      }
      var have = res.obj || {};
      var legacy = readLegacy();
      var toWrite = {};
      var moved = [];
      var skipped = [];

      // 如果标记已经存在，但扩展存储里某些列表（如 chats / profiles）实际上是空的或缺失的，
      // 而旧 localStorage 里依然存着数据，则补充迁移，绝不丢弃用户的聊天记录或设置。
      var allowRecheck = !have[MIGRATION_FLAG];
      if (have[MIGRATION_FLAG]) {
        Object.keys(legacy).forEach(function (key) {
          var cur = have[key];
          var curEmpty = cur === undefined || cur === null || (Array.isArray(cur) && cur.length === 0);
          if (curEmpty && legacy[key]) {
            toWrite[key] = legacy[key];
            moved.push(key);
          }
        });
        if (!moved.length) return { ok: true, moved: [], skipped: [], already: true };
      } else {
        Object.keys(legacy).forEach(function (key) {
          // 新那一头已经有值就以它为准：这里绝不回头盖，重跑一次也就是一次空跑
          if (have[key] !== undefined && have[key] !== null) { skipped.push(key); return; }
          toWrite[key] = legacy[key];
          moved.push(key);
        });
      }
      if (!moved.length) {
        // 没东西可搬也要挂标记，否则每次开页都要重读一遍 localStorage
        return rawSet(onlyFlag()).then(function (w) {
          return { ok: !!w.ok, moved: [], skipped: skipped, error: w.error || '' };
        });
      }

      return rawSet(toWrite).then(function (w) {
        if (!w.ok) return { ok: false, moved: moved, skipped: skipped, error: w.error || 'write failed' };
        return verifyWritten(toWrite).then(function (seen) {
          if (!seen) return { ok: false, moved: moved, skipped: skipped, error: 'the write did not read back' };
          return rawSet(onlyFlag()).then(function (f) {
            if (!f.ok) return { ok: false, moved: moved, skipped: skipped, error: f.error || 'flag not written' };
            moved.forEach(function (key) { cache[key] = toWrite[key]; });
            log('moved', moved.length, 'ai key(s) into extension storage');
            return { ok: true, moved: moved, skipped: skipped, error: '' };
          });
        });
      });
    });
  }

  function onlyFlag() {
    var o = {};
    o[MIGRATION_FLAG] = 1;
    return o;
  }

  /* 只有学生自己按了"Clear AI accounts"才走到这里。迁移从不删页面存储那一头，
     因为搬不成时那是唯一的退路；这一颗键按下去的意思就是"两处都别留"。
     没确认搬成过就不许动：那时页面存储是唯一还带着那份配置的地方，删了就是真丢了。 */
  function purgeLegacy(keys) {
    if (!cache[MIGRATION_FLAG]) return { ok: false, removed: [], error: 'the move has not been confirmed yet' };
    var want = keys || ALLOWLIST.map(function (r) { return r.key; });
    var removed = [];
    var failed = [];
    want.forEach(function (key) {
      try {
        localStorage.removeItem(key);
        removed.push(key);
      } catch (e) {
        failed.push(key);
      }
    });
    log('legacy ai rows cleared by request:', removed.length, failed.length ? '(some stayed)' : '');
    return { ok: !failed.length, removed: removed, error: failed.length ? 'some rows could not be cleared' : '' };
  }

  /* 那几颗开关的同步影子要对账。正本在扩展存储里，而 document_start 那一批（侧栏那一行归 nav-boot）
     只读得到页面这一头：他清过 Canvas 的站点数据、或者只在设置里翻过一次而影子没跟上时，
     会出现"设置里明明写着 Off，侧栏那一行又冒出来"。读回来的这一趟顺手按正本补一次影子，
     只在两边确实不同才写。范围收得很死：涉密的那几格一律跳过，值只认 '0'/'1' 那种开关形状，
     地址、模型名、账本这些从来不该往页面这一头写。 */
  function mirrorShadows() {
    ALLOWLIST.forEach(function (row) {
      if (row.secret) return;
      if (!Object.prototype.hasOwnProperty.call(cache, row.key)) return;
      var want = cache[row.key];
      if (want !== '0' && want !== 0 && want !== '1' && want !== 1) return;
      var text = String(want);
      if (lsGet(row.key) === text) return;
      try { localStorage.setItem(row.key, text); } catch (e) {}
    });
  }

  /* 一次读数：先把扩展存储里那几格灌进内存，再搬旧数据。
     顺序要紧：搬之前要能看见"新那一头已经有什么"，否则会把旧的去盖新的。
     搬完不重新读一遍，因为要写的值已经进了 cache（migrateOnce 里那一趟），省一次往返还更准。 */
  function ensureLoaded() {
    if (started) return started;
    started = Promise.resolve()
      .then(function () {
        return rawGet(ALLOWLIST.map(function (r) { return r.key; }).concat([MIGRATION_FLAG]));
      })
      .then(function (res) {
        if (!res.ok) {
          broken = res.error || NO_STORE;
          log('unavailable:', broken);
          return { ok: false };
        }
        var obj = res.obj || {};
        ALLOWLIST.forEach(function (row) {
          if (obj[row.key] !== undefined) cache[row.key] = obj[row.key];
        });
        return migrateOnce();
      })
      .then(function (m) {
        isLoaded = true;
        mirrorShadows();
        if (m && !m.ok && m.error && m.error !== NO_STORE) log('migration left for next time:', m.error);
        return { ok: !!broken ? false : true, migration: m };
      });
    return started;
  }

  /* 同步读数：给 document_idle 那一刻就要画第一批画面、来不及等 Promise 的那几处用。
     缓存里已经有值就用缓存（扩展存储是唯一的准）。
     只有"这一格还没读到过"且"它不涉密"才去碰 localStorage，而且只是读那一次，
     绝不因为读了就往回写——那才是把 key 续命的口子。 */
  function getSyncFallback(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    var row = meta(key);
    // 涉密那一档永远不许从 localStorage 拿：那是"这一格压根不认页面存储"，
    // 而不是"这一格还没读到"
    if (row && !row.secret) {
      var raw = lsGet(key);
      if (raw !== null && raw !== '') return fromLegacy(key, raw);
    }
    return fallback;
  }

  function set(key, value) {
    if (!meta(key)) {
      log('refused: key outside the ai allowlist:', String(key));
      return Promise.resolve({ ok: false, error: 'key not managed by this layer: ' + String(key) });
    }
    // 先落内存再落盘：这一趟的同步读数必须立刻看见自己刚写的值，
    // 否则发送那一颗读到的还是旧 key（异步初始化最要紧的那条风险）
    var prev = cache[key];
    cache[key] = value;
    var obj = {};
    obj[key] = value;
    return rawSet(obj).then(function (res) {
      if (!res.ok) {
        broken = res.error || NO_STORE;
        if (prev === undefined) delete cache[key]; else cache[key] = prev;
        log('write refused:', String(key));
        return { ok: false, error: res.error || NO_STORE };
      }
      broken = '';
      return { ok: true };
    });
  }

  function remove(key) {
    var obj = {};
    var had = Object.prototype.hasOwnProperty.call(cache, key);
    var prev = cache[key];
    delete cache[key];
    obj[key] = null;
    return rawRemove([key]).then(function (res) {
      if (!res.ok) {
        broken = res.error || NO_STORE;
        if (had) cache[key] = prev;
        log('remove refused:', String(key));
        return { ok: false, error: res.error || NO_STORE };
      }
      broken = '';
      return { ok: true };
    });
  }

  function get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      var v = cache[key];
      return Promise.resolve(v === undefined || v === null ? fallback : v);
    }
    // 缓存里没有不等于库里没有：没搬进来的那一格要真去问一次
    return rawGet([key]).then(function (res) {
      if (!res.ok) { broken = res.error || NO_STORE; return fallback; }
      if (res.obj[key] === undefined || res.obj[key] === null) return fallback;
      cache[key] = res.obj[key];
      return res.obj[key];
    });
  }

  /* 那颗开关的同步读法：默认开启，只有存了 '0' 才算关。
     给"document_idle 这一刻就要画画面、等不了 Promise"的两处读数用（排版那一档、OCR 那一档）。 */
  function switchOn(key) {
    return String(getSyncFallback(key, '')) !== '0';
  }

  window.MCxStorage = {
    __mcxLoaded: true,
    flagKey: MIGRATION_FLAG,
    allowlist: ALLOWLIST.map(function (r) { return r.key; }),
    secretKeys: ALLOWLIST.filter(function (r) { return r.secret; }).map(function (r) { return r.key; }),
    ensureLoaded: ensureLoaded,
    migrateOnce: migrateOnce,
    get: get,
    set: set,
    remove: remove,
    getSyncFallback: getSyncFallback,
    switchOn: switchOn,
    purgeLegacy: purgeLegacy,
    loaded: function () { return isLoaded; },
    available: function () { return !!localApi() && !broken; },
    unavailableNote: function () { return broken ? NO_STORE + '. AI settings will need to be entered again after a reload.' : ''; },
    keys: function () { return Object.keys(cache); }
  };

  // 脚本一跑到就发起读数：晚一帧都会让面板多画一屏"Loading AI settings…"
  ensureLoaded();
})();
