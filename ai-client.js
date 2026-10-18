/* =========================================================
   AI 调用层。我们不提供任何服务：地址、模型名、key 全部由用户在设置里填，
   请求从这一页直接发给他自己选的那个端点，不经过我们任何服务器。

   2026-10-09 实测：从 hcpss 这一页跨源 fetch，openrouter.ai 回 200、api.openai.com 回 401、
   generativelanguage.googleapis.com 回 403（都是鉴权层的结果，不是 CORS 拒绝）。
   所以这条路不需要 background service worker，也不需要 host_permissions：
   manifest 只多了一格 "storage"，那是给下面这份读写的，不是给网络用的。

   key 存在扩展自己的 chrome.storage.local（study-storage.js），不再写这一页的 localStorage：
   页面存储是全校共用那个域名底下的地盘，站点脚本读得到；扩展存储不是。
   旧数据只在第一次开页时搬一次，搬过去且回读确认过才算搬完，搬不成就原样留着下次再搬。

   读数是有条件的：扩展存储要到 document_idle 才读得回来，所以面板和设置都必须先 await
   MCxAi.load()。没读回来之前这里一律当"还没填"，而画面上写的是"Loading AI settings…"——
   绝不能把"还没读到"报成"没有 key"，那是会让人白重填一遍的假警报。
   ========================================================= */
(function () {
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
  var LOG = '[MCX ai]';
  // 那一行"为什么挑它"最多留这么多字：资料行下面那一小行字只放得下一句
  var REASON_CAP = 120;

  /* 这份文件一直没有这颗：371 行新加那句直接调它，跑起来就是 ReferenceError，
     而它正好落在一条没有 catch 的链上（挑资料那一趟），症状是点完什么都没发生 */
  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  var KEYS = {
    base: 'mc_ai_base',
    model: 'mc_ai_model',
    key: 'mc_ai_key',
    provider: 'mc_ai_provider',
    lastPick: 'mc_ai_last_model'
  };

  /* label／desc／keyUrl 只给设置里那一屏用：下拉每一行两行字（名字＋这一家是什么），
     钥匙那一格旁边那颗"去哪拿 key"跳的就是 keyUrl。没有把握的官方地址一律留空，
     留空就是不画那颗链接，不许猜一个让他撞进陌生的控制台 */
  var PROVIDERS = [
    {
      id: 'openai',
      name: 'OpenAI (official)',
      label: 'OpenAI',
      desc: 'OpenAI official endpoint',
      keyUrl: 'https://platform.openai.com/api-keys',
      base: 'https://api.openai.com/v1',
      defaultModel: 'gpt-6.1-sol',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol ($2/$10 · Balanced, General)' },
        { id: 'gpt-6-luna', name: 'GPT-6 Luna ($0.10/$0.50 · Budget, Fast)' },
        { id: 'gpt-6-astra', name: 'GPT-6 Astra ($10/$50 · Advanced Reasoning)' }
      ]
    },
    {
      id: 'claude',
      name: 'Claude (Anthropic, or a proxy)',
      label: 'Claude',
      desc: 'Anthropic, or a proxy that speaks its API',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      base: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-5-5',
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 ($2/$10 · Recommended)' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 ($0.10+/$0.50+ · Fast & Cheap)' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 ($4/$20 · Deep Reasoning)' },
        { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 ($10/$50 · Full Suite)' }
      ]
    },
    {
      id: 'gemini',
      name: 'Google Gemini (official)',
      label: 'Google Gemini',
      desc: 'Google AI Studio models',
      keyUrl: 'https://aistudio.google.com/apikey',
      base: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-3.8-flash',
      models: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash ($0.75/$3.75 · Fast Multimodal)' },
        { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite ($0.30/$2.50 · Budget)' },
        { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash ($0.75/$3.75)' },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' }
      ]
    },
    {
      id: 'openrouter',
      name: 'OpenRouter (many models, one key)',
      label: 'OpenRouter',
      desc: 'Access models from multiple providers',
      keyUrl: 'https://openrouter.ai/settings/keys',
      base: 'https://openrouter.ai/api/v1',
      defaultModel: 'qwen/qwen3.8-flash',
      models: [
        { id: 'openrouter/free', name: 'OpenRouter Free Router ($0.00 · Auto Best Free)' },
        { id: 'qwen/qwen3.7-flash', name: 'Qwen 3.7 Flash ($0.03/$0.13 · Highly Recommended, 99.9% Uptime)' },
        { id: 'inclusionai/ling-3.0-flash', name: 'Ling 3.0 Flash ($0.021/$0.063 · Ultra Low Cost, 262K)' },
        { id: 'inclusionai/ling-3.0-flash-vl', name: 'Ling 3.0 Flash VL ($0.06/$0.18 · Budget Multimodal)' },
        { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B ($0.03/$0.17 · OpenAI 120B Paid Reliable)' },
        { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B Free ($0.00 · OpenAI 120B MoE Free)' },
        { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code Free ($0.00 · 256K Code Agent)' },
        { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots-3 Note Preview Free ($0.00 · 512K Multimodal)' },
        { id: 'qwen/qwen3.5-flash-02-23', name: 'Qwen 3.5 Flash ($0.065/$0.26 · Reliable Daily)' },
        { id: 'google/gemini-3.5-flash-lite', name: 'Google Gemini 3.5 Flash-Lite ($0.30/$2.50 · Budget Speed)' },
        { id: 'google/gemini-3.8-flash', name: 'Google Gemini 3.8 Flash ($0.75/$3.75 · High Efficiency Workhorse)' },
        { id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1-mini ($0.20/$0.80 · 1M Context)' },
        { id: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash ($0.15/$0.47 · Best Overall)' },
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash ($0.13/$0.52 · Reasoning)' },
        { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash ($0.14/$0.28 · Budget Coding)' }
      ]
    },
    {
      id: 'deepseek',
      name: 'DeepSeek (official)',
      label: 'DeepSeek',
      desc: 'DeepSeek official endpoint',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      base: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-Flash (V4.1 Flash · 1M Context, Speed)' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4 Pro (Flagship Architecture)' }
      ]
    },
    {
      id: 'qwen',
      name: 'Qwen (Alibaba, official)',
      label: 'Qwen',
      desc: 'Alibaba Cloud DashScope',
      keyUrl: '',
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen3.8-flash',
      models: [
        { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash (Fast & Low Cost)' },
        { id: 'qwen3.8-max', name: 'Qwen 3.8 Max (Flagship Reasoning & 1M Context)' },
        { id: 'qwen3.8-plus', name: 'Qwen 3.8 Plus (Balanced Production)' }
      ]
    },
    {
      id: 'kimi',
      name: 'Kimi (Moonshot, official)',
      label: 'Kimi',
      desc: 'Moonshot AI official endpoint',
      keyUrl: 'https://platform.moonshot.ai/console/api-keys',
      base: 'https://api.moonshot.ai/v1',
      defaultModel: 'kimi-k3',
      models: [
        { id: 'kimi-k3', name: 'Kimi K3 (2.8T Params · Deep Reasoning, 1M Context)' },
        { id: 'kimi-k2.6', name: 'Kimi K2.6 (Efficient MoE, Cost-Effective)' },
        { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code (Specialized Coding Agent)' }
      ]
    },
    {
      id: 'xiaomi',
      name: 'Xiaomi MiMo',
      label: 'Xiaomi MiMo',
      desc: 'Xiaomi MiMo endpoint',
      keyUrl: '',
      base: 'https://api.mimo.mi.com/v1',
      defaultModel: 'mimo-v2.6-flash',
      models: [
        { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6 Flash (Omnimodal · High Efficiency)' },
        { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6 Pro (Flagship 1T+ Reasoning)' },
        { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6 Pro UltraSpeed (20x Fast Output)' }
      ]
    },
    {
      id: 'custom',
      name: 'Custom endpoint',
      label: 'Custom endpoint',
      desc: 'Any address that speaks the OpenAI API',
      keyUrl: '',
      base: '',
      defaultModel: '',
      models: []
    }
  ];

  var DEFAULT_BASE = 'https://openrouter.ai/api/v1';
  var DEFAULT_MODEL = 'openai/gpt-4o-mini';
  var CLOUD_GATEWAY = 'https://modern-canvas-beta091.moss104088.workers.dev/v1';
  var CLOUD_AUTH_KEY = 'mc_ai_cloud_auth_v1';

  /* ==== 多份配置 ====
     一份＝名字＋地址＋key。模型不在这里定，发送前那一屏挑（他拍的：一份 key 常常要配好几个模型试）。
     老的那三格单值（mc_ai_base / mc_ai_model / mc_ai_key）第一次读时自动变成 Account 1，
     不然他之前填的东西会在升级那一刻凭空没了 */
  var PROFILE_KEY = 'mc_ai_profiles_v1';
  var ACTIVE_KEY = 'mc_ai_active';
  var MAX_PROFILES = 5;

  function store() { return window.MCxStorage || null; }

  function cloudAuth() {
    var s = store();
    var raw = s && s.getSyncFallback ? s.getSyncFallback(CLOUD_AUTH_KEY, {}) : {};
    return raw && typeof raw === 'object' ? raw : {};
  }

  function cloudToken() { return String(cloudAuth().token || '').trim(); }
  function cloudEmail() { return String(cloudAuth().email || '').trim(); }

  function setCloudAuth(auth) {
    var s = store();
    if (!s || !s.set) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    var next = auth && typeof auth === 'object' ? {
      email: String(auth.email || '').trim(),
      token: String(auth.token || '').trim(),
      userId: String(auth.userId || '').trim()
    } : {};
    return s.set(CLOUD_AUTH_KEY, next);
  }

  function clearCloudAuth() {
    var s = store();
    if (!s || !s.remove) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    return s.remove(CLOUD_AUTH_KEY);
  }

  function cloudAccessCode() {
    var s = store();
    return String(s && s.getSyncFallback ? s.getSyncFallback('mc_ai_access_code', '') : '').trim();
  }

  function setCloudAccessCode(code) {
    var s = store();
    if (!s || !s.set) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    return s.set('mc_ai_access_code', String(code || '').trim());
  }

  /* Older builds kept the cloud session in Canvas localStorage. Move it only after the
     extension store is ready, and erase the page copy only after the secure write succeeds. */
  function migrateLegacyCloudAuth() {
    var old = {};
    try {
      old.email = String(localStorage.getItem('mc_ai_user_email') || '').trim();
      old.token = String(localStorage.getItem('mc_ai_user_token') || '').trim();
      old.userId = String(localStorage.getItem('mc_ai_user_id') || '').trim();
      old.accessCode = String(localStorage.getItem('mc_ai_access_code') || '').trim();
    } catch (e) { return Promise.resolve({ ok: false }); }
    if (!old.email && !old.token && !old.userId && !old.accessCode) return Promise.resolve({ ok: true, skipped: true });
    return Promise.all([setCloudAuth(old), setCloudAccessCode(old.accessCode)]).then(function (rows) {
      var out = rows[0] && rows[0].ok && rows[1] && rows[1].ok ? { ok: true } : { ok: false };
      if (out && out.ok) {
        try {
          localStorage.removeItem('mc_ai_user_email');
          localStorage.removeItem('mc_ai_user_token');
          localStorage.removeItem('mc_ai_user_id');
          localStorage.removeItem('mc_ai_access_code');
        } catch (e) {}
      }
      return out;
    });
  }

  /* mem 是这一页里的那一份权威副本：库里那一头要异步才回得来，而发送那一颗读的是同步值。
     null 和"空的"是两件事——null 是还没读到，空是读到了、确实没填。
     混成一桩就会出现"点发送它回一句没有 key"，而设置里明明写着他的 key。 */
  var mem = { profiles: null, slots: null, active: null, base: null, model: null, key: null, lastModel: null };
  var loadDone = false;
  var putFailed = '';

  function peekStr(key) {
    var s = store();
    if (!s) return null;
    var v = s.getSyncFallback(key, null);
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : String(v);
  }

  /* 只在"这一格还没在自己脑子里落过"的时候才从库里补，force 是 load() 那一趟。
     写失败的时候库里会退回去，而脑子里那份必须留下——他刚粘的 key 不能因为一次写不进去就当场蒸发 */
  function syncFromStore(force) {
    if (!store()) return mem;
    if (force || mem.profiles === null) {
      var list = store().getSyncFallback(PROFILE_KEY, null);
      mem.profiles = Array.isArray(list) ? list.slice(0, MAX_PROFILES) : null;
    }
    // 两档那一格交给 readSlots() 自己填：force 只负责把旧的作废，别在这儿把空白当读过的值
    if (force) mem.slots = null;
    if (force || mem.active === null) mem.active = peekStr(ACTIVE_KEY) || '';
    if (force || mem.base === null) mem.base = peekStr(KEYS.base) || '';
    if (force || mem.model === null) mem.model = peekStr(KEYS.model) || '';
    if (force || mem.key === null) mem.key = peekStr(KEYS.key) || '';
    if (force || mem.lastModel === null) mem.lastModel = peekStr(KEYS.lastPick) || '';
    return mem;
  }

  function put(key, value) {
    var s = store();
    if (!s) {
      putFailed = 'secure extension storage is unavailable';
      return Promise.resolve({ ok: false, error: putFailed });
    }
    return s.set(key, value).then(function (res) {
      putFailed = res && res.ok ? '' : String((res && res.error) || 'the write did not go through');
      if (putFailed) log('settings write did not reach extension storage');
      return res || { ok: false, error: putFailed };
    });
  }

  /* 面板和设置都必须等这一颗：它把扩展存储里那几格读进脑子，顺带把旧数据搬一次。
     读不到也照样回话（loadDone 一样置起来），否则那一屏会一直转在"Loading AI settings…"上 */
  function load() {
    var s = store();
    var chain = s ? s.ensureLoaded() : Promise.resolve({ ok: false });
    /* 那一本用量账跟着那三格设置一起读回来：等这一趟的地方只看一次 loadDone，
       所以用量那一屏不需要"先画一屏空的、读到再补一次"的那种闪。
       读账本这一步就算塌了也不许把 loadDone 卡住，不然整屏转在"Loading AI settings…"上 */
    function done(ok) {
      return Promise.resolve(useLoad()).then(function () {
        loadDone = true;
        return { ok: ok, loaded: true, storageNote: storageNote() };
      }, function () {
        loadDone = true;
        return { ok: ok, loaded: true, storageNote: storageNote() };
      });
    }
    return Promise.resolve(chain).then(function () {
      syncFromStore(true);
      return done(!!s);
    }, function () {
      syncFromStore(true);
      return done(false);
    });
  }

  function storageNote() {
    var s = store();
    if (!s) return 'secure extension storage is unavailable, so a key entered here will not survive a reload.';
    if (!s.available()) return s.unavailableNote();
    if (putFailed) return 'Your last change to these settings did not reach the extension storage: it holds only this page.';
    return '';
  }

  function read(key, def) {
    var v = peekStr(key);
    return (v === null || v === '' ? (def || '') : v);
  }

  function readList() {
    syncFromStore(false);
    var list = mem.profiles;
    if (Array.isArray(list) && list.length) return reconcileLegacy(list.slice(0, MAX_PROFILES));
    // 库里那三格单值先变成 Account 1：他升级前填的东西不能在这一步凭空没了
    if (mem.base || mem.key) {
      var one = [{ id: 'p1', name: 'Account 1', base: mem.base, model: mem.model, key: mem.key }];
      writeList(one);
      return one;
    }
    return [];
  }

  /* 设置里那三格（Base URL／Model／API key）现在还是唯一的写入口，所以它们一改，那一格就得跟着改。
     之前只在名单为空时搬一次：他后来重粘的 key 永远进不了面板，症状是设置里 Test 过了、
     面板一发就 401。只认"整份名单就一格"那一种：多格是账户清单那套界面的地盘，不抢它存的值。
     那一格被清空时不动：留空和"从来没填过"分不开，宁可用着旧 key 也不许把唯一的 key 抹掉 */
  function reconcileLegacy(list) {
    if (list.length !== 1) return list;
    var legacyBase = String(mem.base || '').trim();
    var legacyKey = String(mem.key || '').trim();
    var legacyModel = String(mem.model || '').trim();
    if (!legacyBase && !legacyKey) return list;
    var one = list[0];
    var next = {
      id: one.id,
      name: one.name || 'Account 1',
      base: legacyBase || one.base || '',
      model: legacyModel || one.model || '',
      key: legacyKey || one.key || ''
    };
    // Test 那颗探到的"收不收图"是这一格自己的东西，不该跟着那三格一起被覆写没
    if (typeof one.vision === 'boolean') next.vision = one.vision;
    if (next.base === one.base && next.model === one.model && next.key === one.key) return list;
    writeList([next]);
    return [next];
  }

  function writeList(list) {
    var out = (list || []).slice(0, MAX_PROFILES);
    mem.profiles = out;
    put(PROFILE_KEY, out);
    return out;
  }

  /* ==== 两档模型：Advanced 和 Flash ====
     2026-10-12 把"最多五格账号"换成两档有名字的槽，每一档自己一套地址＋钥匙＋模型。
     为什么钉死两档而不是 N 格：发送前那一屏要摆成两颗能一眼看完的药丸，而"写消息／总结"
     这一类没有选择器的自动调用必须有一个确定的落点（Flash），第三档会让那个落点变成猜。
     老的那份名单（mc_ai_profiles_v1／mc_ai_active）不搬、不读，留在库里不动。 */
  var SLOT_KEY = 'mc_ai_slots_v1';
  var SLOT_IDS = ['advanced', 'flash'];
  var SLOT_NAMES = { advanced: 'Advanced', flash: 'Flash' };
  /* 每一句讲的是这一档什么时候被用到，不是槽名——设置里那一屏要说清代价在哪 */
  var SLOT_USE = {
    advanced: 'The heavier of the two. Study cards and summaries use it when you pick Advanced.',
    flash: 'The quick, cheap one. Every call with no picker uses this: Inbox summaries and reply drafts.'
  };
  /* 云端那一路没有地址和钥匙（走网关＋内测码），所以它的两档只是两个模型名，各存各的一格 */
  var CLOUD_MODEL_KEY = { advanced: 'mc_ai_cloud_model', flash: 'mc_ai_cloud_model_flash' };

  function slotId(id) {
    return SLOT_IDS.indexOf(id) >= 0 ? id : 'flash';
  }

  function blankSlot(id) {
    return { id: id, name: SLOT_NAMES[id], provider: '', base: '', key: '', model: '' };
  }

  function syncSlots(list) {
    var out = [];
    var src = Array.isArray(list) ? list : [];
    SLOT_IDS.forEach(function (id) {
      var found = null;
      /* 按 id 认那一档。原来是"名单里第一个像槽位的就是了"，
         于是 Flash 读回来的是 Advanced 的地址和钥匙，两档在屏上看着各有一档、发出去是同一档 */
      src.forEach(function (p) {
        if (!found && p && p.id === id) found = p;
      });
      var one = found || blankSlot(id);
      out.push({
        id: id,
        name: SLOT_NAMES[id],
        provider: String(one.provider || ''),
        base: String(one.base || '').trim(),
        key: String(one.key || '').trim(),
        model: String(one.model || '').trim(),
        vision: typeof one.vision === 'boolean' ? one.vision : undefined
      });
    });
    return out;
  }

  function readSlots() {
    syncFromStore(false);
    if (!Array.isArray(mem.slots)) {
      var raw = store() ? store().getSyncFallback(SLOT_KEY, null) : null;
      try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch (e) { raw = null; }
      var list = syncSlots(raw);
      /* 库里还没回话（load() 没跑完）时不许落缓存：那两格空白会被当成"读过了"，
         之后就算读到真值也不再看它，症状正是设置里填好了、面板还说没配 */
      if (raw !== null || loadDone || !store()) mem.slots = list;
      return list;
    }
    return mem.slots;
  }

  function writeSlots(list) {
    var out = syncSlots(list);
    mem.slots = out;
    put(SLOT_KEY, out);
    return out;
  }

  function slot(id) {
    var want = slotId(id);
    var list = readSlots();
    for (var i = 0; i < list.length; i++) if (list[i].id === want) return list[i];
    return blankSlot(want);
  }

  /* 只改点到的那几格：名字和没提到的格子留着（Test 探到的"收不收图"就在里面） */
  function saveSlot(id, patch) {
    var want = slotId(id);
    var list = readSlots().map(function (one) {
      if (one.id !== want) return one;
      var next = {
        id: want, name: SLOT_NAMES[want],
        provider: patch && patch.provider !== undefined ? String(patch.provider) : one.provider,
        base: patch && patch.base !== undefined ? String(patch.base).trim() : one.base,
        key: patch && patch.key !== undefined ? String(patch.key).trim() : one.key,
        model: patch && patch.model !== undefined ? String(patch.model).trim() : one.model
      };
      var vision = patch && patch.vision !== undefined ? patch.vision : one.vision;
      if (typeof vision === 'boolean') next.vision = vision;
      return next;
    });
    writeSlots(list);
    return slot(want);
  }

  function slotFilled(p) {
    return !!(p && p.base && p.key && p.model);
  }

  /* 这一档没配就退到另一档：他拍的口径是 Flash 空着时自动调用由 Advanced 顶上，
     两档都空着才回原档——那时报错那一头要说清楚缺的是哪一档，不能猜 */
  function resolveSlot(id) {
    var want = slot(id);
    if (slotFilled(want)) return want;
    var other = slot(want.id === 'flash' ? 'advanced' : 'flash');
    return slotFilled(other) ? other : want;
  }

  /* 云端这一路的两档各自读自己那一格，不互相借：'auto' 本身就是那一屏的第一档，
     借了反而让设置里显示的和真正发的对不上 */
  function cloudModel(id) {
    return String(localStorage.getItem(CLOUD_MODEL_KEY[slotId(id)]) || '').trim();
  }

  /* 设置里那一屏读写云端模型走这两颗，别处不再抄第二份格名。
     空串＝跟着网关那一档走 auto，所以清空是把这一格删掉而不是存一个空值 */
  function getCloudModel(id) {
    return cloudModel(id);
  }

  function setCloudModel(id, value) {
    var v = String(value || '').trim();
    if (v) localStorage.setItem(CLOUD_MODEL_KEY[slotId(id)], v);
    else localStorage.removeItem(CLOUD_MODEL_KEY[slotId(id)]);
    return v;
  }

  /* 云端有没有身份＝三颗任一颗都算：测试码（可选的一档，不再预设 MC8888）、登录令牌、登录邮箱。
     以前各处拿 cfg.key（只有测试码）当"能不能用"，只用 Google 登录、没填过码的人会被判成没登录 */
  function hasCloudAccess() {
    return !!(cloudAccessCode() || DEFAULT_ACCESS_CODE || cloudToken() || cloudEmail());
  }

  /* 这一档能不能发出去，只在这里判一次：云端认身份，自带钥匙那一档认 key */
  function canUseSlot(cfg) {
    if (!cfg) return false;
    return cfg.isCloud ? hasCloudAccess() : !!cfg.key;
  }

  function cloudSlot(id) {
    var want = slotId(id);
    var code = cloudAccessCode() || DEFAULT_ACCESS_CODE;
    return {
      id: want,
      name: SLOT_NAMES[want],
      use: SLOT_USE[want],
      base: CLOUD_GATEWAY,
      model: cloudModel(want) || 'auto',
      key: code,
      filled: hasCloudAccess(),
      isCloud: true
    };
  }

  /* 设置里那一屏读的两档形状：云端读两个模型格，自带钥匙那一读那两格 */
  function slots() {
    if (isCloudMode()) return SLOT_IDS.map(cloudSlot);
    return readSlots().map(function (p) {
      return {
        id: p.id, name: SLOT_NAMES[p.id], use: SLOT_USE[p.id],
        provider: p.provider, base: p.base, key: p.key, model: p.model,
        filled: slotFilled(p),
        vision: typeof p.vision === 'boolean' ? p.vision : undefined
      };
    });
  }

  var DEFAULT_ACCESS_CODE = '';
  function isCloudMode() {
    return (localStorage.getItem('mc_ai_mode') || 'cloud') === 'cloud';
  }

  function getCloudProfile() {
    var code = cloudAccessCode();
    var model = String(localStorage.getItem('mc_ai_cloud_model') || '').trim();
    return {
      id: 'cloud',
      name: 'Modern Canvas AI',
      base: CLOUD_GATEWAY,
      model: model || 'auto',
      key: code,
      filled: hasCloudAccess(),
      isCloud: true
    };
  }

  function profiles() {
    return slots();
  }

  function profileById(id) {
    if (id === 'cloud' || (isCloudMode() && !id)) {
      return getCloudProfile();
    }
    var list = readList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function saveProfile(p) {
    if (p && p.id === 'cloud') {
      if (p.model) localStorage.setItem('mc_ai_cloud_model', p.model);
      return [getCloudProfile()];
    }
    var list = readList();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === p.id) {
        // 在这三格之外重挂一份新对象会把 Test 探到的那一格抹掉，所以在原格子上改
        var keep = list[i];
        keep.name = p.name || keep.name;
        keep.base = (p.base || '').trim();
        keep.model = (p.model || '').trim();
        keep.key = (p.key || '').trim();
        list[i] = keep;
        found = true;
      }
    }
    if (!found) list.push({ id: p.id, name: p.name || ('Account ' + (list.length + 1)), base: (p.base || '').trim(), model: (p.model || '').trim(), key: (p.key || '').trim() });
    return writeList(list);
  }

  function removeProfile(id) {
    return writeList(readList().filter(function (p) { return p.id !== id; }));
  }

  function addSlot() {
    var list = readList();
    if (list.length >= MAX_PROFILES) return null;
    var id = 'p' + (list.length + 1);
    while (profileById(id)) id = 'p' + Math.floor(Math.random() * 900 + 100);
    list.push({ id: id, name: 'Account ' + (list.length + 1), base: '', model: '', key: '' });
    writeList(list);
    return id;
  }

  function activeId() {
    if (isCloudMode()) return 'cloud';
    syncFromStore(false);
    var want = String(mem.active || '');
    var list = readList();
    for (var i = 0; i < list.length; i++) if (list[i].id === want && list[i].base && list[i].key) return list[i].id;
    var usable = list.filter(function (p) { return p.base && p.key; });
    return usable.length ? usable[0].id : '';
  }

  function setActive(id) {
    mem.active = String(id || '');
    put(ACTIVE_KEY, mem.active);
  }

  /* 那一格里可选哪些模型：按地址认到预置那家，认不到就只给"手填"。
     这里不发请求去问它——面板打开那一刻多等一次网络，是他最烦的那种 */
  function modelsFor(base) {
    var b = String(base || '').replace(/\/+$/, '');
    if (b === CLOUD_GATEWAY.replace(/\/+$/, '') || isCloudMode()) {
      var cached = [];
      try {
        var raw = localStorage.getItem('mc_ai_cloud_models_cache');
        if (raw) cached = JSON.parse(raw);
      } catch (e) {}
      if (Array.isArray(cached) && cached.length) return cached;
      return [
        { id: 'auto', name: 'Auto (Gemini 2.5 Flash Lite)' },
        { id: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'qwen/qwen3.7-flash', name: 'Qwen 3.7 Flash' },
        { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' }
      ];
    }
    var hit = null;
    for (var i = 0; i < PROVIDERS.length; i++) {
      var pbase = String(PROVIDERS[i].base || '').replace(/\/+$/, '');
      if (pbase && pbase === b) { hit = PROVIDERS[i]; break; }
    }
    return hit ? hit.models.map(function (m) { return { id: m.id, name: m.name }; }) : [];
  }

  function config(id) {
    /* 云端这一路：地址和内测码两档共用，只有模型分开存，所以这里不换通路，只换那一格 */
    if (isCloudMode() || id === 'cloud') {
      return cloudSlot(id === 'advanced' || id === 'flash' ? id : 'advanced');
    }
    var p = resolveSlot(id);
    return {
      id: p.id,
      name: SLOT_NAMES[p.id],
      provider: p.provider || '',
      base: String(p.base || '').trim().replace(/\/+$/, '') || DEFAULT_BASE,
      model: String(p.model || '').trim() || DEFAULT_MODEL,
      key: String(p.key || '').trim(),
      // 两档都没配时发送那一头会拿默认地址撞一次墙；这一项让调用方先说一句"缺的是哪一档"
      filled: slotFilled(p)
    };
  }

  // Gemini 的 REST 形状和 OpenAI 那套不一样，按地址认，不按用户填的模型名猜
  function isGemini(base) {
    return base.indexOf('generativelanguage.googleapis.com') >= 0 || /\/gemini(\/|$)/i.test(base);
  }

  function isUserLoggedIn() {
    return !!cloudEmail();
  }

  function promptLogin(callback) {
    try {
      if (window.MCxAi && window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(callback);
        return;
      }
      document.dispatchEvent(new CustomEvent('bcx-open-ai-settings'));
    } catch (e) {
      if (typeof callback === 'function') callback(e);
    }
  }

  function describeError(err, cfg) {
    var msg = String((err && err.message) || err || '');
    var status = (err && err.status) || 0;
    if (err && err.name === 'AbortError') return { code: 'abort', text: 'Cancelled' };
    var isCloud = cfg && (cfg.isCloud || isCloudMode());

    if (isCloud && !hasCloudAccess()) {
      return {
        code: 'unlogged',
        unlogged: true,
        text: 'Not signed in yet. Please go to Settings > AI & Plans to sign in with your Google account.'
      };
    }

    if (!canUseSlot(cfg)) {
      return {
        code: 'nokey',
        text: isCloud
          ? 'Not signed in yet. Please go to Settings > AI & Plans to sign in with your Google account.'
          : 'No API key yet. Paste one into the AI row in Settings.'
      };
    }
    if (status === 404) {
      return {
        code: 'notfound',
        text: 'That address has no chat endpoint (404 at ' + ((err && err.endpoint) || 'the AI address in Settings') +
          '). Our own gateway must end with /v1. Check the address in Settings > AI & Plans.'
      };
    }
    if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(msg) && !status) {
      if (isCloud && !isUserLoggedIn()) {
        return {
          code: 'unlogged',
          unlogged: true,
          text: 'Not signed in yet. Please go to Settings > AI & Plans to sign in with your Google account.'
        };
      }
      return {
        code: 'blocked',
        text: 'The request to ' + cfg.base + ' never left this page. Either the network is blocking '
          + 'your machine from reaching it, or there is something wrong with your settings or plan. '
          + 'Try another Base URL and press Test again.'
      };
    }
    if (status === 401 || status === 403) {
      if (isCloud && !isUserLoggedIn()) {
        return {
          code: 'unlogged',
          unlogged: true,
          text: 'Not signed in yet. Please go to Settings > AI & Plans to sign in with your Google account.'
        };
      }
      return {
        code: 'auth',
        text: isCloud
          ? (msg || 'Session expired or invalid (' + status + '). Please sign in again or use the free pool.')
          : 'That endpoint does not accept this key (' + status + '). Check for a stray space and make sure the key belongs to this provider.'
      };
    }
    if (status === 404) return { code: 'model', text: 'That model or path was not found (404). The model name has to be the full name the provider uses, and the Base URL should stop at the version part.' };
    if (status === 429) return { code: 'quota', text: 'Rate limited (429). The quota or speed cap for this provider is reached. Try again later, or pick another model.' };
    if (status >= 500) return { code: 'server', text: 'The provider itself failed (' + status + '). Try again later.' };
    return { code: 'other', text: msg || 'The call failed' };
  }

  /* 有的服务会在回包里带自己的 token 计数（OpenAI 那一套是 usage，Gemini 是 usageMetadata，
     Anthropic 是 input_tokens/output_tokens）。带就报上去，不带就一个字都不报：
     我们没有价目表，也绝不替它编一个数。这里只报它自己数的数，屏上那句会写清是 "provider-reported"。
     钱只有 OpenRouter 会直接给（usage.cost），所以它给了才带，别家那一格压根不存在。
     0 块钱是报过的数（免费路由就是这个价），所以判的是"这个字段在不在"，不是"是不是大于 0"。 */
  function noteUsage(obj, onUsage) {
    if (!onUsage || !obj) return;
    var u = obj.usage || obj.usageMetadata || null;
    if (!u || typeof u !== 'object') return;
    var out = {
      prompt: Number(u.prompt_tokens || u.promptTokenCount || u.input_tokens || u.inputTokenCount) || 0,
      completion: Number(u.completion_tokens || u.candidatesTokenCount || u.output_tokens || u.outputTokenCount) || 0,
      total: Number(u.total_tokens || u.totalTokenCount) || 0
    };
    if (typeof u.cost === 'number' && isFinite(u.cost) && u.cost >= 0) out.cost = u.cost;
    // 缓存进去的那一份和推理用的那一串各是一个价，所以单独报数：详情那一屏要说清这钱花在哪
    var pd = u.prompt_tokens_details || u.input_tokens_details || null;
    if (pd) {
      var cached = Number(pd.cached_tokens || pd.cachedTokenCount || 0);
      if (cached > 0) out.cached = cached;
    }
    var cd = u.completion_tokens_details || null;
    var reasoning = Number((cd && (cd.reasoning_tokens || cd.reasoningTokenCount)) || u.thoughtsTokenCount || 0);
    if (reasoning > 0) out.reasoning = reasoning;
    var cw = Number(u.cache_creation_input_tokens || 0);
    if (cw > 0) out.cacheWrite = cw;
    var cr = Number(u.cache_read_input_tokens || 0);
    if (cr > 0) out.cacheRead = cr;
    /* 实际答的那一个大模型以回包里那句为准：OpenRouter 会在这一行告诉我们它最后换了哪一个，
       而我们请求的那个名字可能早就被它换掉了。挂了名字的号留着，事后可以按它去查那一条生成 */
    var served = String(obj.model || '').slice(0, 120);
    if (served) out.model = served;
    var gid = String(obj.id || '').slice(0, 80);
    if (gid) out.gid = gid;
    if (!out.prompt && !out.completion && !out.total && typeof out.cost !== 'number') return;
    if (!out.total) out.total = out.prompt + out.completion;
    try { onUsage(out); } catch (e) {}
  }

  /* 流式那一趟会来好几份计数（OpenRouter 把总额放在收尾那一帧），所以每来一份并一次：
     哪一个字段这一份带了就以这一份为准，没带的留着上一份的，不能让它被后面的空帧抹掉 */
  var USE_FIELDS = ['prompt', 'completion', 'total', 'cost', 'cached', 'reasoning', 'cacheWrite', 'cacheRead'];

  function mergeUsage(prev, next) {
    if (!prev) return next;
    var out = {};
    USE_FIELDS.forEach(function (k) {
      if (typeof next[k] === 'number') out[k] = next[k];
      else if (typeof prev[k] === 'number') out[k] = prev[k];
    });
    if (next.model || prev.model) out.model = next.model || prev.model;
    if (next.gid || prev.gid) out.gid = next.gid || prev.gid;
    if (!out.total) out.total = (out.prompt || 0) + (out.completion || 0);
    return out;
  }

  /* ==== 用量这一本账 ====
     设置里那个 AI Usage 屏读的是这一份：每一次拿到计数的请求记一条，
     谁触发的、走的哪个地址、最后哪个模型答的、它报没报钱。
     只记自家密钥跑掉的那些：云端那一档花的是订阅额度，不进这本账。
     最近那一列只留 USE_LOG_CAP 条，但总量另有按月和按模型的汇总，
     所以摘掉旧行不会把总数摘没。
     权威只有这一份：每条回复底下那一行走的是另一条路（那个数挂在它自己那一轮上，跟着对话存进库）。
     两处能看到的范围不一样，所以那一屏会把"这里数的是全部请求"写在明处。 */
  var USE_KEY = 'mc_ai_usage_v1';
  var USE_LOG_CAP = 100;
  var use = { known: false, log: [], roll: blankRoll(), putFailed: '' };

  function blankBucket() {
    return { requests: 0, prompt: 0, completion: 0, total: 0, cost: 0, costRequests: 0 };
  }

  function blankRoll() {
    return { all: blankBucket(), months: {}, models: {}, slots: {} };
  }

  function useMonth(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function useBucket(roll, key) {
    if (!roll.months[key]) roll.months[key] = blankBucket();
    return roll.months[key];
  }

  function useModel(roll, model) {
    var name = String(model || 'Unknown model').slice(0, 120);
    if (!roll.models[name]) roll.models[name] = blankBucket();
    return roll.models[name];
  }

  function useSlot(roll, name) {
    var want = String(name || 'Other').slice(0, 30);
    if (!roll.slots[want]) roll.slots[want] = blankBucket();
    return roll.slots[want];
  }

  /* 每一格都过一遍 Number：重算那一趟读的是库里的行，手改过的值不经这一道
     会被加号拼成字符串，那一屏就出现 "0abc tokens" */
  function useBump(bucket, row) {
    bucket.requests += 1;
    bucket.prompt += Number(row.prompt) || 0;
    bucket.completion += Number(row.completion) || 0;
    bucket.total += Number(row.total) || 0;
    if (typeof row.cost === 'number') {
      bucket.cost += Number(row.cost) || 0;
      bucket.costRequests += 1;
    }
  }

  /* 旧账本里云端那些行摘掉，三份汇总照剩下的行重算：汇总里没有分档，
     没法把混进去的云端量单独减掉，只能从留下的这一列重推。
     代价是掉出 100 条以外的那部分也一起没了（自家密钥的旧量同样受影响），
     从这一条起重新记的就都是准的 */
  function useOwnKeyOnly() {
    use.log = use.log.filter(function (r) { return r && r.mode !== 'cloud'; });
    var roll = blankRoll();
    use.log.forEach(function (r) {
      useBump(roll.all, r);
      useBump(useBucket(roll, useMonth(r.at)), r);
      useBump(useModel(roll, r.model), r);
      useBump(useSlot(roll, r.slot), r);
    });
    use.roll = roll;
  }

  function useAdd(row) {
    use.log.unshift(row);
    if (use.log.length > USE_LOG_CAP) use.log.length = USE_LOG_CAP;
    useBump(use.roll.all, row);
    useBump(useBucket(use.roll, useMonth(row.at)), row);
    useBump(useModel(use.roll, row.model), row);
    useBump(useSlot(use.roll, row.slot), row);
    usePut();
  }

  function usePut() {
    var s = store();
    if (!s) {
      use.putFailed = 'secure extension storage is unavailable';
      return Promise.resolve({ ok: false, error: use.putFailed });
    }
    /* 每一趟发送都顺带写一次这本账：写完不等回话（它不许把发送拖住），
       但这一颗要把 Promise 交出去，清理那一颗要靠它把"真清了"判出来 */
    return s.set(USE_KEY, { log: use.log, roll: use.roll }).then(function (res) {
      use.putFailed = res && res.ok ? '' : String((res && res.error) || 'the write did not go through');
      if (use.putFailed) log('usage write did not reach extension storage');
      return res || { ok: false, error: use.putFailed };
    });
  }

  /* 库里那一本读进脑子：开屏那一趟顺带读一次，之后这一屏的读数全是同步的。
     读回来之前 known 是假的，那一屏写的是"正在读"，不能写"一条都没有" */
  function useLoad() {
    var s = store();
    if (!s) {
      use.known = true;
      use.putFailed = 'secure extension storage is unavailable';
      return Promise.resolve();
    }
    return Promise.resolve(s.get(USE_KEY, null)).then(function (v) {
      use.known = true;
      if (!v || typeof v !== 'object') return;
      var roll = v.roll && typeof v.roll === 'object' ? v.roll : null;
      if (Array.isArray(v.log)) use.log = v.log.slice(0, USE_LOG_CAP);
      if (roll && roll.all) {
        use.roll.months = cleanBuckets(roll.months);
        use.roll.models = cleanBuckets(roll.models);
        use.roll.slots = cleanBuckets(roll.slots);
        USE_ZERO_KEYS.forEach(function (k) {
          use.roll.all[k] = Number(roll.all[k]) || 0;
        });
      }
      /* 旧账本里云端和自家混着记过。有那种行才重算：没有就别去动汇总，
         掉出 100 条以外的量只活在汇总里，重算会把它们抹掉 */
      if (use.log.some(function (r) { return r && r.mode === 'cloud'; })) {
        useOwnKeyOnly();
        return usePut();
      }
    }, function () {
      use.known = true;
    });
  }

  /* 库里那一本每一档的数都要重过一遍：手改过的、旧构建留下的、写一半的都可能在某一行留个空。
     少归一遍，那一屏就会把 undefined 加成 NaN，整块汇总变成"NaN tokens" */
  var USE_ZERO_KEYS = ['requests', 'prompt', 'completion', 'total', 'cost', 'costRequests'];

  function cleanBuckets(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach(function (name) {
      var b = obj[name] && typeof obj[name] === 'object' ? obj[name] : {};
      var one = blankBucket();
      USE_ZERO_KEYS.forEach(function (k) {
        one[k] = Number(b[k]) || 0;
      });
      out[name] = one;
    });
    return out;
  }

  function hostOf(base) {
    return String(base || '').replace(/^https?:\/\//, '').split('/')[0];
  }

  function providerOfBase(base) {
    var h = hostOf(base);
    var list = PROVIDERS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].base && hostOf(list[i].base) === h) return list[i].label;
    }
    return h || 'Unknown address';
  }

  var sessionUsage = [];

  function logTokenUsageToConsole(row, isCloud) {
    try {
      var p = Number(row.prompt) || 0;
      var c = Number(row.completion) || 0;
      var tot = Number(row.total) || (p + c);
      var costStr = (typeof row.cost === 'number' && row.cost >= 0) ? (' · $' + row.cost.toFixed(5)) : '';
      var mathStr = (p && c && (p + c === tot))
        ? (p.toLocaleString() + ' in + ' + c.toLocaleString() + ' out = ' + tot.toLocaleString() + ' tokens')
        : (tot.toLocaleString() + ' tokens');

      // 累计本页面会话总 token
      var cumulativeTokens = 0;
      sessionUsage.forEach(function (s) { cumulativeTokens += (Number(s.total) || 0); });
      var cumChain = sessionUsage.map(function (s) { return (Number(s.total) || 0).toLocaleString(); }).join(' + ');
      var cumMath = sessionUsage.length > 1 ? (' (' + cumChain + ' = ' + cumulativeTokens.toLocaleString() + ' tokens session total)') : '';

      var badge = isCloud ? '%c[Modern Canvas AI]%c' : '%c[Custom AI Key]%c';
      var badgeStyle = isCloud 
        ? 'background: #38bdf8; color: #0f172a; font-weight: bold; padding: 2px 6px; border-radius: 4px;'
        : 'background: #10b981; color: #ffffff; font-weight: bold; padding: 2px 6px; border-radius: 4px;';
      var textStyle = 'color: #94a3b8; font-weight: normal;';

      console.groupCollapsed(badge + ' ' + row.feature + ' · ' + mathStr + costStr, badgeStyle, textStyle);
      console.log('%cModel:%c ' + (row.model || 'Unknown'), 'font-weight: bold; color: #38bdf8;', 'color: inherit;');
      console.log('%cTokens Used:%c ' + mathStr, 'font-weight: bold; color: #f59e0b;', 'color: inherit;');
      if (cumMath) {
        console.log('%cSession Cumulative:%c ' + cumMath, 'font-weight: bold; color: #a78bfa;', 'color: inherit;');
      }
      if (costStr) {
        console.log('%cReported Cost:%c ' + costStr.replace(' · ', ''), 'font-weight: bold; color: #34d399;', 'color: inherit;');
      }
      console.log('%cDetailed Usage Object:%c', 'font-weight: bold; color: #94a3b8;', '', row.raw || row);
      console.log('%cTip: Type %cwindow.getAiUsage()%c in console anytime to inspect complete token logs.', 'color: #64748b; font-style: italic;', 'color: #38bdf8; font-weight: bold;', 'color: #64748b; font-style: italic;');
      console.groupEnd();
    } catch (e) {}
  }

  function recordSessionUsage(cfg, opts, u) {
    if (!u) return;
    var isCloud = !!(cfg && (cfg.isCloud || isCloudMode()));
    var entry = {
      time: new Date().toLocaleTimeString(),
      feature: String((opts && opts.feature) || 'AI request'),
      mode: isCloud ? 'cloud' : 'byo',
      model: String((u && u.model) || (cfg && cfg.model) || 'unknown'),
      prompt: useTokensOf({ prompt: u.prompt || u.input_tokens || u.prompt_tokens }),
      completion: useTokensOf({ completion: u.completion || u.output_tokens || u.completion_tokens }),
      total: useTokensOf(u),
      cost: useCostOf(u),
      raw: u
    };
    sessionUsage.push(entry);

    // 每次新询问都自动在控制台输出 token 加法细节与统计
    logTokenUsageToConsole(entry, isCloud);
  }

  function useRecord(cfg, opts, u) {
    if (!u) return;
    recordSessionUsage(cfg, opts, u);
    if (!u.prompt && !u.completion && !u.total && typeof u.cost !== 'number') return;
    /* 云端那一档不进这本账：它花的是订阅额度，不是这把 key。
       那一屏说的是"Tokens used from your own API key"，混进云端的量就成了假话 */
    if (cfg.isCloud || isCloudMode()) return;
    var row = {
      id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      feature: String(opts.feature || 'AI request').slice(0, 60),
      // 这一档是 Advanced 还是 Flash：设置里那一屏按它分行，用户挑的就是这两档
      slot: String(cfg.name || '').slice(0, 30),
      mode: 'byo',
      provider: providerOfBase(cfg.base),
      host: hostOf(cfg.base),
      model: String(u.model || cfg.model || '').slice(0, 120),
      prompt: u.prompt || 0,
      completion: u.completion || 0,
      total: u.total || 0
    };
    if (typeof u.cost === 'number') row.cost = u.cost;
    if (u.cached) row.cached = u.cached;
    if (u.reasoning) row.reasoning = u.reasoning;
    if (u.cacheWrite) row.cacheWrite = u.cacheWrite;
    if (u.cacheRead) row.cacheRead = u.cacheRead;
    if (u.gid) row.gid = u.gid;
    useAdd(row);
  }

  /* 回复底下那一行的开关。正本在扩展自己的存储里，页面那一头只是同步影子，
     和排版、读扫描文件那两颗同一套路子。云端访问（Modern Canvas AI）前端不显示用量。 */
  function usageLineOn() {
    if (isCloudMode()) return false;
    var s = store();
    if (s && s.switchOn) return s.switchOn('mc_ai_usage_line');
    try { return String(localStorage.getItem('mc_ai_usage_line')) !== '0'; } catch (e) { return true; }
  }

  /* ==== 屏上那句"用了多少" ====
     一个界面上常常跑好几趟：第一次总结、Regenerate、追问、二级按钮（Explain simply、
     Check my plan）。以前每一屏只挂"最近那一趟"的数，第二趟一来就把第一趟顶掉了，
     屏上看着像追问没花钱。现在按趟存成一份名单，那句话写成加法：500 + 400 = 900。
     钱还是只认服务自己在回包里报的那一份，它没报的那趟不进加法，也不说成 0。 */
  function useTokensOf(u) {
    if (!u) return 0;
    return Number(u.total) || (Number(u.prompt) || 0) + (Number(u.completion) || 0) || 0;
  }

  function useCostOf(u) {
    return u && typeof u.cost === 'number' && isFinite(u.cost) && u.cost >= 0 ? u.cost : null;
  }

  function useNum(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* 同一趟请求会来好几帧计数（流式收尾那一帧才带总额），所以按"哪一趟"归并：
     同一个 key 后到的覆盖先到的，新 key 另起一项。
     key 由 send() 每一趟自己发，换模型重试的那一趟也是新的一项 */
  function usageTrack(list, u, key) {
    var out = Array.isArray(list) ? list : [];
    if (!u) return out;
    var k = String(key || '');
    if (k) {
      for (var i = 0; i < out.length; i++) {
        if (out[i] && out[i].key === k) { out[i].usage = u; return out; }
      }
    }
    out.push({ key: k || 'u' + Date.now().toString(36) + '-' + out.length, usage: u });
    return out;
  }

  /* 名单里每一项可能是 {key, usage}，也可能是旧的裸 usage 对象（历史库里那种），两种都认 */
  function usageTotals(list) {
    var rows = Array.isArray(list) ? list : [];
    var out = { calls: 0, counted: 0, tokens: 0, cost: 0, costCalls: 0, tokenTerms: [], costTerms: [] };
    rows.forEach(function (r) {
      var u = r && r.usage ? r.usage : r;
      if (!u) return;
      out.calls++;
      var n = useTokensOf(u);
      if (n) {
        out.counted++;
        out.tokens += n;
        out.tokenTerms.push(n);
      }
      var m = useCostOf(u);
      if (m !== null) {
        out.costCalls++;
        out.cost += m;
        out.costTerms.push(m);
      }
    });
    return out;
  }

  /* 一项的时候只报那个数，两项以上才写加法 */
  function useChain(terms, total, fmt) {
    if (terms.length < 2) return fmt(terms[0]);
    var sum = 0;
    terms.forEach(function (n) { sum += n; });
    return terms.map(fmt).join(' + ') + ' = ' + fmt(total || sum);
  }

  function usageBits(list) {
    var t = usageTotals(list);
    var out = [];
    if (t.tokenTerms.length) out.push(useChain(t.tokenTerms, t.tokens, useNum) + ' tokens');
    if (t.costTerms.length) {
      var money = useChain(t.costTerms, t.cost, useMoneyFmt(t.costTerms, t.cost));
      if (t.costCalls < t.counted) money += ' (' + t.costCalls + ' of ' + t.counted + ' calls)';
      out.push(money);
    }
    return out;
  }

  /* 钱的精度：至少要四位（他是从四位那一档读惯的），但每一位数字都得原样写出来。
     不然 0.00042 会被四舍五入成 $0.0004，三项相加就成了
     "$0.0004 + $0.0004 + $0.0004 = $0.0013" 那种屏幕上自己跟自己算不平的账 */
  function useMoneyFmt(terms, total) {
    var dp = total >= 0.01 ? 2 : 4;
    var need = function (n) {
      for (var d = dp; d <= 6; d++) {
        if (Math.abs(Number(n.toFixed(d)) - n) < 1e-9) return d;
      }
      return 6;
    };
    terms.concat([total]).forEach(function (n) { dp = Math.max(dp, need(n)); });
    return function (n) { return '$' + n.toFixed(dp); };
  }

  /* 整句唯一一处拼法：判据（关掉了不出字、没报数也不出字）都挂在这里，
     以后多一屏画这行也不会漏掉开关 */
  function usageSentence(list, label) {
    if (isCloudMode()) return '';
    if (!usageLineOn()) return '';
    var bits = usageBits(list);
    if (!bits.length) return '';
    return (label ? label + ' used ' : 'Used ') + bits.join(' · ');
  }

  function usageRowById(id) {
    for (var i = 0; i < use.log.length; i++) {
      if (use.log[i].id === id) return use.log[i];
    }
    return null;
  }

  function usageRecent(n) {
    return use.log.slice(0, n || USE_LOG_CAP);
  }

  function usageRollRows(which) {
    var map = which === 'slots' ? use.roll.slots : use.roll.models;
    return Object.keys(map).map(function (name) {
      var b = map[name];
      return {
        name: name, requests: b.requests, prompt: b.prompt, completion: b.completion,
        total: b.total, cost: b.cost, costRequests: b.costRequests
      };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function usageClear() {
    use.log = [];
    use.roll = blankRoll();
    var out = { ok: !use.putFailed, error: use.putFailed, done: null };
    var s = store();
    out.done = Promise.resolve(usePut()).then(function (res) {
      if (!res || !res.ok) {
        out.ok = false;
        out.error = String((res && res.error) || use.putFailed || 'it did not answer');
        return out;
      }
      /* 写这一颗答应了不算成：只有回读到的那一格真空了，才能对他说"清了" */
      if (!s) { out.ok = false; out.error = use.putFailed; return out; }
      return Promise.resolve(s.get(USE_KEY, null)).then(function (back) {
        var n = back && Array.isArray(back.log) ? back.log.length : 0;
        out.ok = !back || n === 0;
        if (!out.ok) out.error = 'it still holds ' + n + ' rows';
        return out;
      }, function () {
        out.ok = false;
        out.error = 'the log could not be read back';
        return out;
      });
    });
    return out;
  }

  /* 只报"404"没法定位：同一句 404 可能是钥匙错、地址少一段、或那个 worker 根本不存在。
     这里把主机名和路径挂在错误上（不带查询串、不带钥匙），让屏上那句能点名是哪个地址回的 */
  function endpointOf(url) {
    try { var u = new URL(String(url || '')); return u.hostname + u.pathname; } catch (e) { return ''; }
  }

  function postJson(url, body, headers, signal, onUsage, onPoolUsed) {
    return fetch(url, { redirect: 'error',
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      var poolUsed = res.headers && res.headers.get && (res.headers.get('X-MC-Pool-Used') === 'true');
      if (poolUsed && onPoolUsed) {
        try { onPoolUsed(true); } catch (e) {}
      }
      return res.text().then(function (text) {
        if (!res.ok) {
          var err = new Error(shorten(text) || ('HTTP ' + res.status));
          err.status = res.status;
          err.endpoint = endpointOf(url);
          throw err;
        }
        /* Outside the try on purpose. A throw inside it would be caught two lines down and
           rewritten into "did not return JSON", which is a lie about what happened. */
        var obj = null;
        try { obj = JSON.parse(text); } catch (e) {
          var bad = new Error('That endpoint did not return JSON: ' + shorten(text));
          bad.status = res.status;
          throw bad;
        }
        /* Some gateways answer 200 and put the refusal in the body. Read as an empty answer that
           looks exactly like "the model sent nothing", which is a different cause with a
           different fix, so it has to be named here. */
        if (obj && obj.error) {
          var refused = new Error(providerWords(obj.error) || 'The provider answered with an error');
          refused.status = res.status;
          throw refused;
        }
        noteUsage(obj, onUsage);
        return obj;
      });
    });
  }

  function providerWords(e) {
    if (!e) return '';
    if (typeof e === 'string') return e.slice(0, 300);
    var m = e.message || (e.error && (e.error.message || e.error.code)) || e.code || '';
    return String(m).slice(0, 300) || JSON.stringify(e).slice(0, 300);
  }

  function shorten(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 220 ? t.slice(0, 220) + '…' : t;
  }

  function authHeaders(cfg, extra) {
    var h = { 'Content-Type': 'application/json' };
    var cloudRequest = !!(cfg.isCloud || isCloudMode());
    var userToken = '', userEmail = '', routePref = 'plan', plan = 'free';
    if (cloudRequest) {
      userEmail = cloudEmail();
      userToken = cloudToken();
      try {
        routePref = localStorage.getItem('mc_ai_routing_pref') || 'plan';
        plan = (localStorage.getItem('mc_ai_plan') || 'free').toLowerCase();
      } catch (e) {}
    }
    /* An access code is an optional test credential. When a signed-in user chose
       the shared pool (or is on the free plan, which uses it), do not let an old
       test code override the account and routing headers with an expired Bearer
       key. The gateway still receives the user's session and selected route. */
    var usesPool = cloudRequest && !!(userToken || userEmail) && (routePref === 'pool' || plan === 'free');
    if (isGemini(cfg.base)) {
      // Gemini 走查询串那把 key，头里再带一份反而有的网关会拒
    } else if (!usesPool) {
      h.Authorization = 'Bearer ' + cfg.key;
    }
    // 如果是云端托管模式且用户绑定了账号，附带用户的邮箱和 Token，供网关自动鉴权和按需扣减额度
    if (cloudRequest) {
      if (userEmail) h['X-MC-User-Email'] = userEmail;
      if (userToken) h['X-MC-User-Token'] = userToken;
      h['X-MC-Routing-Pref'] = routePref;
    }
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function geminiUrl(cfg, stream) {
    var path = isGemini(cfg.base)
      ? cfg.base + '/models/' + encodeURIComponent(cfg.model) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent')
      : cfg.base;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(cfg.key);
  }

  /* ==== OpenAI 兼容 ==== */

  function isOrGateway(base) {
    return hostOf(base) === 'openrouter.ai';
  }

  function isAnthropic(base) {
    return hostOf(base) === 'api.anthropic.com' || /\/anthropic(\/|$)/i.test(base);
  }

  function anthropicBody(messages, images, wantStream, maxTokens) {
    var system = [];
    var out = [];
    messages.forEach(function (m, idx) {
      var text = String(m.content || '');
      if (m.role === 'system') { system.push(text); return; }
      var isLast = (idx === messages.length - 1);
      if (isLast && images && images.length) {
        var parts = [];
        images.forEach(function (im) {
          if (im && im.dataUrl) {
            var match = String(im.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2]
                }
              });
            }
          }
        });
        if (text) parts.push({ type: 'text', text: text });
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: parts });
      } else {
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
      }
    });
    var body = { model: '', messages: out, stream: !!wantStream, max_tokens: maxTokens || 1024 };
    if (system.length) body.system = system.join('\n');
    return body;
  }

  function anthropicHeaders(cfg) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }

  function openAiBody(cfg, messages, wantStream, maxTokens) {
    var body = { model: cfg.model, messages: messages, stream: !!wantStream };
    if (maxTokens) body.max_tokens = maxTokens;
    /* OpenRouter 要你点名才在回包里带钱和缓存明细，不点名时流式那一趟基本只有字。
       只给它加：别家见到这个陌生字段会直接回 400，那样连答都拿不到，
       所以云端那个地址也没碰——它后面接的是谁我们不知道，不许拿用户的发送去试。 */
    if (isOrGateway(cfg.base)) body.usage = { include: true };
    return body;
  }

  // 图片走 content 数组那一档；只有 vision 模型认。没有图片时保持纯字符串，
  // 因为有些兼容网关见到数组就报错
  function withImages(messages, images) {
    if (!images || !images.length) return messages;
    var out = messages.map(function (m) { return { role: m.role, content: m.content }; });
    var last = out[out.length - 1];
    var parts = [{ type: 'text', text: String(last.content || '') }];
    images.forEach(function (im) {
      if (im && im.dataUrl) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    });
    last.content = parts;
    return out;
  }

  function geminiParts(messages, images, maxTokens) {
    var system = '';
    var contents = [];
    messages.forEach(function (m) {
      if (m.role === 'system') { system += (system ? '\n' : '') + String(m.content || ''); return; }
      var text = String(m.content || '');
      var parts = [{ text: text }];
      if (images && images.length && m === messages[messages.length - 1]) {
        images.forEach(function (im) {
          if (im && im.dataUrl) parts.push({ inline_data: { mime_type: 'image/jpeg', data: im.dataUrl.split(',')[1] || '' } });
        });
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: parts });
    });
    var body = { contents: contents };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    // 不写这一段的话，那条"回复预算"只作用于 OpenAI 那一支，
    // 挑资料那一趟在 Gemini 上就成了不设防的输出，花的还是用户的钱
    if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
    return body;
  }

  /* SSE 解析：一行 data: {...}，[DONE] 收尾。有的网关不流式，直接把整份 JSON 回过来，
     那种在 onDelta 之前就补一次全量 */
  function readStream(res, onDelta, onUsage) {
    if (!res.body || !res.body.getReader) {
      return res.text().then(function (text) {
        var obj = null;
        try { obj = JSON.parse(text); } catch (e) {}
        noteUsage(obj, onUsage);
        // 只有那份回body根本不是 JSON 时才原样当文字用。
        // 是 JSON 但 content 是空串的话，把整坨响应泼到屏上只会让人以为那就是模型答的
        var t = (obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content)
          || (obj ? '' : text);
        if (t) onDelta(t);
        return t;
      });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var full = '';
    var sawChunk = false;
    /* eat() removes every line it consumes, so by the time the stream ends buf is back to empty
       and a diagnostic built from it prints nothing after the colon. Keep the head of the raw
       body in a separate variable that nothing strips from. */
    var rawHead = '';
    var RAW_CAP = 900;
    var providerErr = '';
    var sawThinking = false;

    function eat() {
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        var obj = null;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        /* OpenRouter reports a refusal mid stream, as one of these data: lines with an error in
           it. It parsed fine and carried no text, so before this line it was dropped on the floor
           and the only thing left to show was "no text". */
        if (obj && obj.error) providerErr = providerWords(obj.error);
        noteUsage(obj, onUsage);
        var piece = '';
        if (obj.choices && obj.choices[0]) {
          var c = obj.choices[0];
          piece = (c.delta && (c.delta.content || c.delta.text)) || (c.message && c.message.content) || '';
          /* A model that thinks before it talks puts the thinking in its own field. That is not
             the answer and must never become the answer, but its presence is the one clue that
             separates this from a gateway that sent nothing at all. */
          if (!piece && c.delta && (c.delta.reasoning || c.delta.reasoning_content)) sawThinking = true;
          if (obj.candidates && obj.candidates[0]) piece = geminiText(obj.candidates[0]);
        } else if (obj.candidates && obj.candidates[0]) {
          piece = geminiText(obj.candidates[0]);
        }
        if (!piece && obj.delta && obj.delta.type === 'text_delta') piece = obj.delta.text || '';
        if (piece) {
          sawChunk = true;
          full += piece;
          onDelta(piece);
        }
      }
    }

    function loop() {
      return reader.read().then(function (r) {
        if (r.done) {
          buf += decoder.decode();
          eat();
          if (!sawChunk && full === '' && buf) {
            var obj = null;
            try { obj = JSON.parse(buf); } catch (e) {}
            var t = (obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '';
            if (t) { full = t; onDelta(t); }
          }
          if (full === '') {
            // 200 但一个字都没有：不抛的话面板就是一片空白，他只会报"总结没出来"，说不到是哪一步。
            // 三种成因在屏幕上必须长得不一样，因为解法完全不同
            var detail = providerErr
              ? 'The provider answered with an error: ' + providerErr
              : (sawThinking
                ? 'The model sent only its own working out and no answer. Pick another model in Settings.'
                : 'Its reply starts with: ' + (shorten(rawHead || buf) || 'nothing at all, an empty body'));
            var err = new Error('That address answered 200 but carried no text. ' + detail);
            err.status = 200;
            throw err;
          }
          return full;
        }
        var chunk = decoder.decode(r.value, { stream: true });
        if (rawHead.length < RAW_CAP) rawHead += chunk.slice(0, RAW_CAP - rawHead.length);
        buf += chunk;
        eat();
        return loop();
      });
    }
    return loop();
  }

  function geminiText(cand) {
    var out = '';
    ((cand && cand.content && cand.content.parts) || []).forEach(function (p) {
      if (p && p.text) out += p.text;
    });
    return out;
  }

  function safeAiUrl(raw) {
    var u;
    try { u = new URL(raw); } catch (_) { throw new Error('Enter a valid HTTPS AI provider address.'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) {
      throw new Error('AI provider addresses must use HTTPS without embedded credentials or a fragment.');
    }
    return u.href;
  }

  var consentPending = {};
  function requestAiConsent(cfg) {
    var target = new URL(safeAiUrl(cfg.base)).origin;
    var cloud = target === new URL(CLOUD_GATEWAY).origin;
    var key = (cloud ? 'cloud:' : 'direct:') + target;
    if (consentPending[key]) return consentPending[key];
    var s = store();
    if (!s) return Promise.reject(new Error('Extension storage is unavailable. Reload before using AI.'));
    consentPending[key] = s.get('mc_ai_consent_v1', {}).then(function (saved) {
      if (saved && saved[key] === true) return;
      var route = cloud
        ? 'Modern Canvas sends your request through its Cloudflare gateway to OpenRouter and the selected model provider. Your account email and sign-in token are sent to the gateway to manage access and credits.'
        : 'Your request and API key are sent directly to ' + target + '. They do not pass through Modern Canvas servers.';
      if (!window.confirm('Allow this AI service to process your material?\n\n' + route +
          '\n\nRequests can include your prompt, selected course and assignment text, rubrics, extracted file text, Inbox messages, and images you choose to include. These services process the material under their own privacy policies; we cannot promise they never retain it or use it for training. Saved chats stay in extension storage on this computer.\n\nChoose OK to allow this destination, or Cancel to send nothing. You can revoke this choice in Settings.')) {
        throw new Error('AI sharing was not approved. No request was sent.');
      }
      var next = Object.assign({}, saved || {}); next[key] = true;
      return s.set('mc_ai_consent_v1', next).then(function (result) {
        if (!result || !result.ok) throw new Error('Could not save your AI sharing choice. No request was sent.');
      });
    }).finally(function () { delete consentPending[key]; });
    return consentPending[key];
  }

  function sendOne(cfg, opts) {
    try { safeAiUrl(cfg.base); } catch (e) { return Promise.reject(e); }
    return requestAiConsent(cfg).then(function () {
      if (opts.signal && opts.signal.aborted) throw new Error('AI request cancelled.');
      return sendOneApproved(cfg, opts);
    });
  }

  function sendOneApproved(cfg, opts) {
    var messages = opts.messages || [];
    var images = (opts.withImages && opts.images) ? opts.images : [];
    var signal = opts.signal;
    var baseClean = String(cfg.base || '').replace(/\/+$/, '');
    var gemini = isGemini(baseClean) || cfg.provider === 'gemini';
    var anthropic = isAnthropic(baseClean) || cfg.provider === 'claude';
    var url, body, headers;

    if (gemini) {
      url = geminiUrl(cfg, opts.stream !== false);
      body = geminiParts(messages, images, opts.maxTokens);
      headers = authHeaders(cfg);
      delete headers.Authorization;
    } else if (anthropic) {
      url = baseClean + '/messages';
      body = anthropicBody(messages, images, opts.stream !== false, opts.maxTokens);
      body.model = cfg.model;
      headers = anthropicHeaders(cfg);
    } else {
      url = baseClean + '/chat/completions';
      body = openAiBody(cfg, withImages(messages, images), opts.stream !== false, opts.maxTokens);
      headers = authHeaders(cfg, opts.stream === false ? {} : {});
    }

    if (opts.stream === false) {
      if (gemini) url = geminiUrl(cfg, false);
      else body.stream = false;
      return postJson(url, body, headers, signal, opts.onUsage, opts.onPoolUsed).then(function (obj) {
        var text = '';
        if (obj && obj.choices && obj.choices[0]) {
          text = (obj.choices[0].message && obj.choices[0].message.content)
            || (obj.choices[0].text) || '';
        } else if (obj && obj.candidates && obj.candidates[0]) {
          text = geminiText(obj.candidates[0]);
        } else if (obj && Array.isArray(obj.content)) {
          text = obj.content.map(function (p) { return p && p.type === 'text' ? p.text || '' : ''; }).join('');
        }
        return String(text || '');
      });
    }

    return fetch(url, { redirect: 'error', method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal })
      .then(function (res) {
        var poolUsed = res.headers && res.headers.get && (res.headers.get('X-MC-Pool-Used') === 'true');
        if (poolUsed && opts.onPoolUsed) {
          try { opts.onPoolUsed(true); } catch (e) {}
        }
        if (!res.ok) {
          return res.text().then(function (text) {
            var err = new Error(shorten(text) || ('HTTP ' + res.status));
            err.status = res.status;
            err.endpoint = endpointOf(url);
            throw err;
          });
        }
        return readStream(res, opts.onDelta || function () {}, opts.onUsage);
      });
  }

  function getFallbackModels(currentModel, isCloud) {
    var candidates = [];
    if (isCloud) {
      // 优先从缓存的 Cloud 允许模型中提取
      var cached = [];
      try {
        var raw = localStorage.getItem('mc_ai_cloud_models_cache');
        if (raw) cached = JSON.parse(raw);
      } catch (e) {}
      if (Array.isArray(cached) && cached.length) {
        cached.forEach(function (m) {
          if (m && m.id && m.id !== 'auto' && m.id !== currentModel) {
            candidates.push(m.id);
          }
        });
      }
      // 兜底常用高可用模型
      var builtins = [
        'qwen/qwen3.7-flash',
        'google/gemini-2.5-flash',
        'anthropic/claude-3.5-haiku',
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen3.5-flash-02-23'
      ];
      builtins.forEach(function (b) {
        if (b !== currentModel && candidates.indexOf(b) < 0) candidates.push(b);
      });
    }
    return candidates;
  }

  /* 每一趟请求的牌号计数：给 onUsage 的第二颗用，同一台里永不重复 */
  var sendSeq = 0;

  function send(opts) {
    /* AI 总开关关掉：这里一律不发。上面那些入口各自已经先拦过一道，这一颗是最后一道，
       防的是以后新加的调用点忘挂门。设置里那两趟（测连接、拉模型名单）走的是 test／fetchModels，
       不经过这里，所以关了总开关也不影响他在那一屏核对配置 */
    if (typeof window.mcAiOn === 'function' && !window.mcAiOn()) {
      var offErr = new Error('AI is off. Turn AI back on in Settings.');
      offErr.code = 'ai_off';
      return Promise.reject(offErr);
    }
    var cfg = config(opts.profile);
    var primaryModel = opts.model || cfg.model || 'auto';
    var isCloud = !!cfg.isCloud || isCloudMode();

    if (isCloud) {
      if (!hasCloudAccess()) {
        var unloggedErr = new Error('Please sign in with Google to use AI.');
        unloggedErr.status = 401;
        unloggedErr.code = 'unlogged';
        unloggedErr.unlogged = true;
        return Promise.reject(unloggedErr);
      }
    }

    // 构建待尝试模型队列：首选模型 -> 备选模型列表
    var queue = [primaryModel];
    if (isCloud) {
      var fallbacks = getFallbackModels(primaryModel, isCloud);
      queue = queue.concat(fallbacks);
    }

    function tryNext(index, lastErr) {
      if (index >= queue.length || index >= 4) { // 最多自动容错尝试 4 个不同模型
        throw lastErr;
      }
      var targetModel = queue[index];
      var attemptCfg = Object.assign({}, cfg);
      attemptCfg.model = targetModel;

      if (index > 0 && opts.onStatus) {
        try { opts.onStatus('Primary model busy, auto-switched to ' + targetModel + '...'); } catch (e) {}
      }

      /* 每一趟自己一份计数：换了模型重试的那一趟不能把上一趟的数带过来，
         否则账本上会写着 B 模型花了 A 模型的 token。
         调用方拿到的是合并后的那一份，所以流式收尾那一帧里的钱也照样送得出去。
         第二颗 attemptKey 是这一趟的牌号：屏上那句加法靠它把"同一趟的好几帧"归成一项，
         regenerate／追问／二级按钮各发各的，所以各有各的牌号 */
      var acc = null;
      var attemptKey = 'a' + Date.now().toString(36) + '-' + (++sendSeq) + '-' + index;
      var attemptOpts = Object.assign({}, opts, {
        onUsage: function (u) {
          acc = mergeUsage(acc, u);
          if (opts.onUsage) { try { opts.onUsage(acc, attemptKey); } catch (e) {} }
        }
      });

      return sendOne(attemptCfg, attemptOpts).then(function (out) {
        useRecord(attemptCfg, opts, acc);
        return out;
      }).catch(function (err) {
        // 如果是用户主动取消 (AbortError) 或 鉴权凭证错误 (401/403/nokey)，不重试
        if (err && (err.name === 'AbortError' || err.status === 401 || err.status === 403)) {
          throw err;
        }
        // 只重试明确可能因模型/网关短暂不可用而恢复的情况。400 等请求错误换模型也不会好，
        // 继续发只会重复消耗用户额度。
        /* 404 不在这一串里：换备选模型只换请求体里那个名字，地址一个字都没变，
           所以"这个地址没有聊天接口"重试多少次都是同一个 404。
           实测他那一屏因此连打四次同一颗 URL（控制台里那一排重复的 404 就是这么来的） */
        var retryable = err && (err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500 || err.status === 200);
        if (!retryable) throw err;
        return tryNext(index + 1, err);
      });
    }

    /* 云端那一趟走一次就记一次：设置里那条额度条读的是这个数。
       只记次数、不记内容，也不等回话，写不进去就当没发生（它不许把发送拖住） */
    function bumpCloudUsage() {
      if (!isCloud) return;
      try {
        var n = Number(localStorage.getItem('mc_ai_cloud_used') || 0);
        if (!isFinite(n) || n < 0) n = 0;
        localStorage.setItem('mc_ai_cloud_used', String(Math.floor(n) + 1));
      } catch (e) {}
    }

    return tryNext(0, new Error('No models available to attempt')).then(function (out) {
      bumpCloudUsage();
      return out;
    });
  }

  /* ==== Test 那颗按钮 ====
     要一次问出三件事，因为用户填错的时候这三种的解法完全不同：
     连通／鉴权、模型名对不对、这把 key 后面的模型吃不吃图。 */

  /* Test 那颗：一次问出两件事，因为用户填错时这两种解法完全不同。
     图片那一趟现在总是跑（传图那颗勾已经挪到发送前一屏，设置里问一次就把结果记在这份配置上，
     面板才知道要不要把那颗勾选灰掉）。
     上一版图片失败那一支只算了 d 没 push 任何东西，症状是 Test 全绿但那把 key 其实不收图 */
  function test(profileId, onStep) {
    var cfg = config(profileId);
    var steps = [];
    var report = { ok: false, profile: cfg.id, cfg: { name: cfg.name, base: cfg.base, model: cfg.model, keySet: !!cfg.key }, steps: steps };

    function step(name) {
      if (onStep) onStep(name);
    }

    if (!cfg.key) {
      steps.push({ name: 'API key', ok: false, text: 'No key set' });
      report.error = describeError(new Error('no key'), cfg);
      return Promise.resolve(report);
    }

    step('Connectivity and key');
    return send({
      profile: profileId,
      feature: 'Connection test',
      messages: [{ role: 'user', content: 'Reply with exactly these two letters: OK' }],
      stream: false,
      maxTokens: 8
    }).then(function (text) {
      steps.push({ name: 'Connectivity and key', ok: true, text: 'OK' });
      report.ok = true;
      return true;
    }, function (err) {
      var d = describeError(err, cfg);
      steps.push({ name: 'Connectivity and key', ok: false, text: d.text, raw: (err && err.message) || '' });
      report.error = d;
      return false;
    }).then(function (firstOk) {
      // 只要第一步没通，立刻停止，绝不再发任何请求
      if (!firstOk) {
        steps.push({ name: 'Image input', ok: false, text: 'Skipped (Connection failed)' });
        return report;
      }
      var pixel = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
      step('Image input');
      return send({
        profile: profileId,
        feature: 'Image support check',
        messages: [{ role: 'user', content: 'What colour is this image? One word.' }],
        images: [pixel],
        withImages: true,
        stream: false,
        maxTokens: 12
      }).then(function (text) {
        steps.push({ name: 'Image input', ok: true, text: 'Supported' });
        report.vision = true;
      }, function (err) {
        var rawMsg = (err && err.message) || '';
        steps.push({ name: 'Image input', ok: false, text: 'Not Supported', raw: rawMsg });
        report.vision = false;
      });
    }).then(function () {
      // 探到的那一项跟着这一档存下来，面板只读它，不再重复问
      if (typeof report.vision === 'boolean' && SLOT_IDS.indexOf(cfg.id) >= 0) saveSlot(cfg.id, { vision: report.vision });
      return report;
    });
  }

  /* ==== 获取可用模型清单（OpenRouter / OpenAI 兼容） ==== */
  function fetchModels(profileId) {
    var cfg = config(profileId);
    try { safeAiUrl(cfg.base); } catch (e) { return Promise.reject(e); }
    if (!cfg.key) return Promise.reject(new Error('No API key provided'));
    var url = cfg.base.replace(/\/+$/, '') + '/models';
    return fetch(url, { redirect: 'error',
      method: 'GET',
      headers: authHeaders(cfg)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = (data && data.data) || (Array.isArray(data) ? data : []);
      return list.map(function (m) {
        return {
          id: m.id || m.name || '',
          name: m.name || m.id || '',
          context: m.context_length || 0,
          pricing: m.pricing || null
        };
      }).filter(function (m) { return !!m.id; });
    });
  }

  /* ==== 让模型从名单里挑资料 ====
     名单是 study-panel.js 先在本地筛过的那一份（最多几十条），这里只喂标题和所属小节，
     正文一条都不读，所以这一趟很便宜。

     要的形状是一行一条："编号: 为什么"。不再要整份 JSON 数组，因为那玩意儿截断一半
     还能被正则捞出一串数字，症状就是"只挑了最前面几条"还不报错；一行一条最差也只是少后面几条 */

  /* 最后一档：它回的就是一串号码。这里只收"单独站着的 1 到 3 位数字"，
     所以 2026 那种四位的、v1.2 那种贴着字母的都不会被当成第 1 条 */
  function numbersInto(ids, seen, text, list) {
    var re = /(^|[^\w.])\d{1,3}(?![\w.])/g;
    var m;
    while ((m = re.exec(String(text || '')))) {
      var digits = /\d{1,3}/.exec(m[0]);
      if (!digits) continue;
      var idx = Number(digits[0]) - 1;
      if (idx < 0 || idx >= list.length || seen[idx]) continue;
      seen[idx] = 1;
      ids.push(list[idx].id);
    }
  }

  /* 它回的形状没法规定死：有人一行一条，有人把三条塞进一行，有人画表格，有人把号码加粗。
     所以只认一件事——"一个号码紧跟一个分隔符"，分隔符有 : . – — ) | * 这几种。
     两头都要卡住：号码前面不能是字母数字（挡掉 v1.2、2026），分隔符后面不能是数字（挡掉 "6:59 PM"）。
     先找出所有号码的位置，理由取到"下一号的开头或这一行结束"为止，这样一行塞两条也拆得开。 */
  var ENTRY_MARK = /(^|[^\w.])\d{1,3}(?!\d)[ \t]*[:.\u2013\u2014)|*](?!\d)[ \t]*/g;
  var SHELL = /^[\s.*\-–—:()\[\]#`|]+/;

  function entriesInto(raw, list, ids, seen, reasons) {
    var text = String(raw || '');
    var hits = [];
    var m;
    ENTRY_MARK.lastIndex = 0;
    while ((m = ENTRY_MARK.exec(text))) {
      var digits = /\d{1,3}/.exec(m[0]);
      if (digits) hits.push({ n: Number(digits[0]), start: m.index + m[1].length, at: m.index + m[0].length });
    }
    hits.forEach(function (h, i) {
      var idx = h.n - 1;
      if (idx < 0 || idx >= list.length || seen[idx]) return;
      var end = text.length;
      var nl = text.indexOf('\n', h.at);
      if (nl >= 0) end = Math.min(end, nl);
      var nx = hits[i + 1];
      if (nx && nx.start < end) end = nx.start;
      seen[idx] = 1;
      ids.push(list[idx].id);
      var why = text.slice(h.at, end).replace(SHELL, '').replace(/\s+/g, ' ').trim().slice(0, REASON_CAP);
      if (why) reasons[list[idx].id] = why;
    });
  }

  /* 一个号码都没认上时最后一档：它多半是照抄了标题。
     标题太短的（"Quiz"、"Notes"）不当判据，否则整门课都能对上 */
  function titlesInto(raw, list, ids, seen) {
    var text = String(raw || '').toLowerCase();
    list.forEach(function (r, i) {
      var title = String(r.title || '').trim().toLowerCase();
      if (seen[i] || title.length < 6) return;
      if (text.indexOf(title) >= 0) {
        seen[i] = 1;
        ids.push(r.id);
      }
    });
  }

  function parsePick(text, list) {
    var ids = [];
    var reasons = {};
    var seen = {};
    var raw = String(text || '');
    var trimmed = raw.trim();
    if (!trimmed) return { ids: ids, reasons: reasons, how: 'empty', preview: '' };
    // 一整串号码、一个字母都没有：那就是它没听"一行一条"那句，退回按号码认
    if (/^[^A-Za-z]*[\d\s,.]+[^A-Za-z]*$/.test(trimmed)) {
      numbersInto(ids, seen, raw, list);
      return { ids: ids, reasons: reasons, how: 'numbers', preview: shorten(raw) };
    }
    entriesInto(raw, list, ids, seen, reasons);
    var how = 'lines';
    if (!ids.length) {
      numbersInto(ids, seen, raw, list);
      how = 'numbers';
    }
    if (!ids.length) {
      titlesInto(raw, list, ids, seen);
      how = 'titles';
    }
    return { ids: ids, reasons: reasons, how: ids.length ? how : 'none', preview: shorten(raw) };
  }

  function pickResources(info) {
    var list = info.resources || [];
    var lines = list.map(function (r, i) {
      return (i + 1) + '. [' + r.kind + '] ' + r.module + ' / ' + r.title;
    }).join('\n');
    var system = 'You pick study materials for a student. Reply with one line per item you choose and nothing else. '
      + 'Each line is: the number, a colon, then up to eight words saying what that item covers for this assessment. '
      + 'Write the number plain at the start of the line, not bold, not in a table. Example line: 4: the impulse examples. '
      + 'Only numbers that are on the list. No intro, no closing remark, no markdown fence. '
      + 'Take what actually covers the listed topics, and when several cover the same topic take them all. '
      + 'Skip forms, surveys, and material from a unit this assessment does not reach.';
    var user = 'Course: ' + info.courseName + '\n'
      + 'Assessment: ' + info.taskName + '\n'
      + 'Its description on Canvas (may be empty):\n' + (info.scopeText || '(empty)') + '\n\n'
      + 'Materials:\n' + lines + '\n\n'
      + 'Now the choices, one per line.';
    // 300 太小：几十条清单刚报到一半就被切断。一行一条之后断的只是尾巴，但预算还是给足
    return send({
      profile: info.profile,
      feature: 'Picking materials',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      signal: info.signal,
      maxTokens: 1600
    }).then(function (text) {
      var picked = parsePick(text, list);
      if (!picked.ids.length) log('nothing in its answer matched this list, what it looked like:', picked.how, '|', picked.preview);
      return { ids: picked.ids, reasons: picked.reasons, how: picked.how, preview: picked.preview };
    });
  }

  /* 设置里那三格唯一的写入口。走这一颗是因为脑子里那一份副本（mem）也必须跟着改：
     只写库的话面板下一次读到的还是旧 key，症状正是"改了 key 还是 401"。
     空串照写：读数那一头把空串当没填，而"删掉这一格"和"从来没填过"在库里分不开 */
  function setSetting(key, value) {
    var v = (value === null || value === undefined) ? '' : String(value).trim();
    var field = key === KEYS.base ? 'base'
      : key === KEYS.model ? 'model'
      : key === KEYS.key ? 'key'
      : key === KEYS.lastPick ? 'lastModel' : '';
    if (!field) return Promise.resolve({ ok: false, error: 'not an AI setting: ' + String(key) });
    mem[field] = v;
    return put(key, v);
  }

  function getSetting(key) {
    var v = peekStr(key);
    return v === null ? '' : v;
  }

  /* 清除是学生按的那颗键，不是迁移顺手动的事：账户、当前选中、那三格单值一起从扩展存储里摘掉，
     脑子里那一份也当场抹干净，免得这一页还当带着旧 key 能用。
     localStorage 那一头只有在这颗键下才动，迁移本身从不删它。 */
  function clearAccounts() {
    mem.profiles = [];
    mem.slots = syncSlots(null);
    mem.active = '';
    mem.base = '';
    mem.model = '';
    mem.key = '';
    mem.lastModel = '';
    var s = store();
    var keys = [SLOT_KEY, PROFILE_KEY, ACTIVE_KEY, KEYS.base, KEYS.model, KEYS.key, KEYS.lastPick, KEYS.provider];
    if (!s) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    return Promise.all(keys.map(function (k) { return s.remove(k); })).then(function (rows) {
      var bad = (rows || []).filter(function (r) { return !(r && r.ok); });
      return { ok: !bad.length, error: bad.length ? String(bad[0].error || 'some rows stayed') : '' };
    });
  }

  /* ---------- 语气这一档 ----------
     两个写信的屏共用这一份：消息页的回信（inbox-ai.js）和给老师写信（study-panel.js）。
     前三档只有名字，playful 多带一个 0 到 100 的调皮程度，别的档没有这颗滑块。
     那五段话只写在这里一次：两处各抄一份，改一档就得记得改两处，两处迟早对不上。
     底线还是那两条，其余尺度交给这一档自己：不写材料里没有的事实，也不动"只写进框里、不自动发送" */
  var TONES = [
    ['formal', 'Formal'],
    ['friendly', 'Friendly'],
    ['concise', 'Concise'],
    ['playful', 'Playful']
  ];
  var PLAYFUL_DEFAULT = 50;
  var PLAYFUL_BANDS = [
    [20, 'Keep it a normal, professional message. One small aside or a single light joke at most.'],
    [40, 'Casual and a bit cheeky. Self-deprecating jokes are welcome. It should still read as '
      + 'something a student would actually send.'],
    [60, 'Clearly playful. Go for jokes, exaggeration and funny comparisons, and a light bit of '
      + 'griping about the workload.'],
    [80, 'Bold. Joke about the assignment, the grade or the school itself, in a way the teacher '
      + 'could laugh at. The actual question still has to come through clearly.'],
    [100, 'As far out as a message a student could really send: melodrama, irony, sarcasm, absurd '
      + 'comparisons, backhanded politeness. Be bold, and do not be afraid of going too far. '
      + 'Just do not insult anyone.']
  ];

  /* 一个数进来，一个 0 到 100 的整数出去。读不到数（没存过、存坏了）用第二颗兜底，
     而不是悄悄变成 0：0 那一档写的是"正经消息"，那是另一种语气，不是没填 */
  function playfulPct(v, fallback) {
    var n = Number(v);
    if (v === '' || v === null || v === undefined || !isFinite(n)) n = Number(fallback);
    if (!isFinite(n)) n = PLAYFUL_DEFAULT;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function toneLabel(tone, pct) {
    for (var i = 0; i < TONES.length; i++) {
      if (TONES[i][0] === tone) {
        return tone === 'playful' ? 'Playful ' + playfulPct(pct) + '%' : TONES[i][1];
      }
    }
    return '';
  }

  function tonePrompt(tone, pct) {
    if (tone !== 'playful') return 'Tone: ' + tone + '.';
    var n = playfulPct(pct);
    for (var i = 0; i < PLAYFUL_BANDS.length; i++) {
      if (n <= PLAYFUL_BANDS[i][0]) return 'Tone: playful. Playfulness ' + n + ' out of 100. ' + PLAYFUL_BANDS[i][1];
    }
    return 'Tone: playful. Playfulness ' + n + ' out of 100. ' + PLAYFUL_BANDS[PLAYFUL_BANDS.length - 1][1];
  }

  /* 刻度拧到那两档要提前说一句，因为发出去的是他自己的收件箱。
     整句（连那颗三角）在这里拼一次：两个屏各自描一遍就会有一天画得不一样，
     而同一颗图标长两个样子比没有图标更糟 */
  var WARN_ICON = '<svg class="mcx-tone-warn-ico" viewBox="0 0 16 16" aria-hidden="true" fill="none" '
    + 'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 2.3 14.5 13.5h-13z"/><path d="M8 6.5v3.1"/><path d="M8 11.7h.01"/></svg>';

  function toneWarn(pct) {
    var n = playfulPct(pct);
    if (n >= 81) return { cls: 'is-unhinged', text: 'Unhinged mode! AI may roast, mock, or get wildly sarcastic.' };
    if (n >= 60) return { cls: 'is-cheeky', text: 'Getting cheeky! AI may tease or use sarcasm.' };
    return { cls: '', text: '' };
  }

  function toneWarnHtml(pct) {
    var w = toneWarn(pct);
    return '<div class="mcx-tone-warn' + (w.cls ? ' ' + w.cls : '') + '" data-tone-warn>' + WARN_ICON +
      '<span class="mcx-tone-warn-text">' + w.text + '</span></div>';
  }

  window.MCxAi = {
    tones: TONES,
    toneLabel: toneLabel,
    tonePrompt: tonePrompt,
    toneWarn: toneWarn,
    toneWarnHtml: toneWarnHtml,
    playfulPct: playfulPct,
    playfulDefault: PLAYFUL_DEFAULT,
    config: config,
    keys: KEYS,
    providers: PROVIDERS,
    profiles: profiles,
    slots: slots,
    slot: slot,
    saveSlot: saveSlot,
    slotFilled: slotFilled,
    slotIds: SLOT_IDS,
    slotNames: SLOT_NAMES,
    slotUse: SLOT_USE,
    getCloudModel: getCloudModel,
    setCloudModel: setCloudModel,
    saveProfile: saveProfile,
    removeProfile: removeProfile,
    addSlot: addSlot,
    activeId: activeId,
    setActive: setActive,
    modelsFor: modelsFor,
    maxProfiles: MAX_PROFILES,
    defaults: { base: DEFAULT_BASE, model: DEFAULT_MODEL },
    load: load,
    settingsLoaded: function () { return loadDone; },
    storageNote: storageNote,
    setSetting: setSetting,
    getSetting: getSetting,
    clearAccounts: clearAccounts,
    send: send,
    /* 设置里那个 AI Usage 屏用的读数口：全部同步，账本在 load() 那一趟已经读进脑子了。
       known 判的是"这一台真读到过一次没有"，没读到过的时候那一屏只许说"正在读" */
    usage: {
      known: function () { return use.known; },
      all: function () { return use.roll.all; },
      month: function () { return useBucket(use.roll, useMonth(Date.now())); },
      monthKey: useMonth,
      models: function () { return usageRollRows('models'); },
      slots: function () { return usageRollRows('slots'); },
      recent: usageRecent,
      row: usageRowById,
      cap: USE_LOG_CAP,
      clear: usageClear,
      note: function () { return use.putFailed; }
    },
    usageLineOn: usageLineOn,
    usageTrack: usageTrack,
    usageTotals: usageTotals,
    usageBits: usageBits,
    usageSentence: usageSentence,
    usageTokens: useTokensOf,
    usageMoney: useCostOf,
    usageNum: useNum,
    isCloudMode: isCloudMode,
    getSessionUsage: function () {
      var tot = { requests: sessionUsage.length, prompt: 0, completion: 0, total: 0, cost: 0, list: sessionUsage.slice() };
      sessionUsage.forEach(function (r) {
        tot.prompt += r.prompt || 0;
        tot.completion += r.completion || 0;
        tot.total += r.total || 0;
        if (typeof r.cost === 'number') tot.cost += r.cost;
      });
      return tot;
    },
    getUsage: function (calls) {
      if (calls) return usageTotals(calls);
      return window.MCxAi.getSessionUsage();
    },
    isOpenRouter: isOrGateway,
    test: test,
    fetchModels: fetchModels,
    pickResources: pickResources,
    parsePick: parsePick,
    describeError: describeError,
    isGemini: isGemini,
    isUserLoggedIn: isUserLoggedIn,
    hasCloudAccess: hasCloudAccess,
    canUseSlot: canUseSlot,
    cloudAuth: cloudAuth,
    setCloudAuth: setCloudAuth,
    clearCloudAuth: clearCloudAuth,
    cloudAccessCode: cloudAccessCode,
    setCloudAccessCode: setCloudAccessCode,
    promptLogin: promptLogin,
    isPoolRouting: function () {
      if (!isCloudMode()) return false;
      try {
        if (!isUserLoggedIn()) return false;
        var pref = localStorage.getItem('mc_ai_routing_pref') || 'plan';
        if (pref === 'pool') return true;
        var p = (localStorage.getItem('mc_ai_plan') || 'free').toLowerCase();
        if (p === 'free') return true;
      } catch (e) {}
      return false;
    },
    poolNoticeHtml: poolNoticeHtml
  };

  /* 这一句只管"是自己在设置里挑了 Free Pool"的那一趟：服务器把回答挤进池子时
     pref 还留在 plan，那一趟不该叫用户去改自己已经挑好的东西 */
  function chosePoolOnPaidPlan() {
    try {
      if (!isUserLoggedIn()) return false;
      if ((localStorage.getItem('mc_ai_plan') || 'free').toLowerCase() === 'free') return false;
      return localStorage.getItem('mc_ai_routing_pref') === 'pool';
    } catch (e) {
      return false;
    }
  }

  function poolNoticeHtml(customText) {
    var text = customText || (chosePoolOnPaidPlan()
      ? "You're subscribed. Since you chose the free pool, we are providing AI for free. It may be slower, and there can be a minute of delay. Select Instant in settings to use your own plan and get our fastest thinking model, which answers in seconds."
      : 'We are providing AI for free. It may be slower, and there can be a minute of delay. Upgrade to get our fastest thinking model, which answers in seconds.');
    var sparkSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto; color:var(--mc-links);"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
    return '<div class="mcx-pool-notice" style="margin: 8px 0 12px; padding: 10px 14px; background: var(--mc-background-2); border-radius: 10px; font-size: 12.5px; line-height: 1.45; color: var(--mc-text-0); display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box;">' +
      '<div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto;">' +
        sparkSvg +
        '<span style="color: var(--mc-text-1);">' + text + '</span>' +
      '</div>' +
      '<button type="button" class="mcx-pool-upgrade-link" style="flex: 0 0 auto; height: 26px; padding: 0 10px; border: none; border-radius: 9999px; background: var(--mc-buttons); color: var(--mc-links); font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s ease; outline: none; display: inline-flex; align-items: center; justify-content: center; line-height: 1;">Upgrade</button>' +
    '</div>';
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.mcx-pool-upgrade-link')) {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('bcx-open-ai-settings'));
    }
  });

  // 在控制台直接暴露便捷调试函数，随时输入 window.getAiUsage() 即可查看统计表格
  window.getAiUsage = function () {
    var u = window.MCxAi ? window.MCxAi.getSessionUsage() : null;
    if (!u) {
      console.warn('Modern Canvas AI client not loaded.');
      return;
    }
    console.log('%c=== Modern Canvas AI Session Token Report ===', 'color: #38bdf8; font-weight: bold; font-size: 13px;');
    console.table(u.list.map(function (item, idx) {
      var p = Number(item.prompt) || 0;
      var c = Number(item.completion) || 0;
      var tot = Number(item.total) || (p + c);
      return {
        '#': idx + 1,
        'Time': item.time,
        'Feature': item.feature,
        'Model': item.model,
        'Prompt (in)': p.toLocaleString(),
        'Completion (out)': c.toLocaleString(),
        'Tokens Used': (p && c) ? (p.toLocaleString() + ' + ' + c.toLocaleString() + ' = ' + tot.toLocaleString()) : tot.toLocaleString(),
        'Cost': (typeof item.cost === 'number' && item.cost >= 0) ? ('$' + item.cost.toFixed(5)) : 'N/A'
      };
    }));
    var pSum = (u.prompt || 0).toLocaleString();
    var cSum = (u.completion || 0).toLocaleString();
    var totSum = (u.total || 0).toLocaleString();
    var costSum = (typeof u.cost === 'number' && u.cost >= 0) ? (' · Cost: $' + u.cost.toFixed(5)) : '';
    console.log('%cTotal Session Tokens:%c ' + pSum + ' in + ' + cSum + ' out = ' + totSum + ' tokens' + costSum, 'font-weight: bold; color: #f59e0b;', 'color: inherit;');
    return u;
  };

  // 脚本一跑到就发起读数：晚一帧，面板那一屏就多转一屏"Loading AI settings…"。
  // 这里只发起，不读结果——读结果的那几处自己 await load()
  try {
    if (store()) {
      store().ensureLoaded().then(function () { return migrateLegacyCloudAuth(); });
    }
  } catch (e) {}
})();

