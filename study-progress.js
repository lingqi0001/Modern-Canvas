/* =========================================================
   互动练习的那本账：这一门课里哪个知识点答过、答成什么样、下一次该什么时候再看。

   为什么存在扩展自己的 chrome.storage.local（study-storage.js）
   - 这本账记的是"这个学生在哪几个知识点上答错过"。它是学生的东西，不该放在
     全校共用那一个域名底下的页面存储里——站点脚本读得到那一块。
   - 老那一头由 study-storage.js 第一次开页搬一次，搬不成时原样留着，下次再搬；这里从不删它。
   - 读数是同步的：库要异步才回得来，而答完一题当场就要记一笔，所以整本账抄在脑子里（mem），
     落盘排在一条链上异步跑。mem 还是 null 时绝不写盘：那等于拿一份空账去盖库里那本真账。

   存什么：courseId、questionKey、concept、attemptCount、correctCount、lastResult、
   confidence、streak、lastSeenAt、nextReviewAt、sourceTags。
   不存课件正文，不存整份 Canvas 材料，不存图片 base64，永远不存 API key。

   streak 也要存，因为"连着掌握了几次"决定下一档间隔，而它从累计的那两个数推不出来：
   错一次就把连胜清零，之后又连对三次的话，attemptCount 和 correctCount 看不出这三次是连着来的。

   这一份绝不许把复习面板搞崩：读不出、JSON 坏了、配额满了，一律回空账加一句 console，
   屏幕上顶多是"没有进度"，不是白屏。
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
  var KEY = 'mc_ai_progress_v1';
  var VERSION = 1;
  var LOG = '[MCX progress]';
  var SECOND = 1000;
  var MINUTE = 60 * SECOND;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  /* 复习节律，透明到能手算出来：
     还不会 → 10 分钟后；不确定 → 24 小时后；
     第一次掌握 → 3 天后，连着掌握依次 7 天、14 天、30 天；
     做错就把连胜清零，下一档退回 10 分钟重头来。 */
  var WRONG_GAP = 10 * MINUTE;
  var UNCERTAIN_GAP = DAY;
  var MASTER_STEPS = [3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  // 题目攒得再多也不该把这本账撑到读不动：超了就扔最久没碰的那几条
  var RECORD_CAP = 3000;

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function store() { return window.MCxStorage || null; }

  /* mem 是这本账在这一页里的副本：null＝还没读到过，{}＝读到了、确实一条没有。
     这两档必须分开，因为"没读到"时写盘会拿一份空账盖掉库里那本真账。 */
  var mem = null;
  var pending = Promise.resolve();
  var lastWrite = { ok: true, error: '' };

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function tagList(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (t) {
      var s = String(t == null ? '' : t).trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  function wrapKey(courseId, questionKey) {
    return num(courseId) + '|' + questionKey;
  }

  /* 认一道题认成哪一条记录。模型给的 id 有时长有时短、还可能带空格，
     所以只有一眼认得出的那种短码才直接当键用，别的都退回现算的 hash。
     两条路各挂一个前缀，免得模型真写出一个 "h..." 开头的 id 时和 hash 撞车。 */
  function keyForQuestion(question, courseId) {
    var q = question && typeof question === 'object' ? question : {};
    var id = String(q.id == null ? '' : q.id).trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(id)) return 'x:' + id;
    var basis = [courseId, q.concept, q.prompt].map(function (s) {
      return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
    }).join('|');
    return 'h:' + shortHash(basis);
  }

  /* FNV-1a 再叠一遍 djb2：单靠一个 32 位码在一千多道题上会有机会撞，
     两段拼起来还是七个字符，读日志时看得出是哪一道。 */
  function shortHash(s) {
    var text = String(s || '');
    var fnv = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      fnv ^= text.charCodeAt(i);
      fnv = (fnv + ((fnv << 1) + (fnv << 4) + (fnv << 7) + (fnv << 8) + (fnv << 24))) >>> 0;
    }
    var dj = 5381;
    for (var j = 0; j < text.length; j++) {
      dj = (((dj << 5) + dj) + text.charCodeAt(j)) >>> 0;
    }
    return fnv.toString(36) + dj.toString(36).slice(-3);
  }

  function blankRecord(courseId, questionKey, concept, sourceTags) {
    return {
      courseId: num(courseId),
      questionKey: String(questionKey || ''),
      concept: String(concept || '').slice(0, 200),
      attemptCount: 0,
      correctCount: 0,
      lastResult: '',
      confidence: '',
      streak: 0,
      lastSeenAt: 0,
      nextReviewAt: 0,
      sourceTags: tagList(sourceTags)
    };
  }

  // 一条记录认得出来才留：留一条半成品，后面每一屏都会在那个节点上抛错
  function usable(r) {
    return !!r && typeof r === 'object'
      && r.questionKey
      && typeof r.questionKey === 'string';
  }

  function shape(r) {
    var out = blankRecord(r.courseId, r.questionKey, r.concept, r.sourceTags);
    out.attemptCount = Math.max(0, num(r.attemptCount));
    out.correctCount = Math.max(0, num(r.correctCount));
    out.lastResult = ['correct', 'wrong', 'uncertain'].indexOf(r.lastResult) >= 0 ? r.lastResult : '';
    out.confidence = ['mastered', 'uncertain', 'weak'].indexOf(r.confidence) >= 0 ? r.confidence : '';
    out.streak = Math.max(0, num(r.streak));
    out.lastSeenAt = Math.max(0, num(r.lastSeenAt));
    out.nextReviewAt = Math.max(0, num(r.nextReviewAt));
    return out;
  }

  /* 整本账读出来就是一张表，键是 courseId|questionKey。
     任何一步不对都回空表：这本账没了只是屏幕上少一行状态，不该把面板带走。
     库里那一份要异步才回得来，所以这里读的是脑子里那一份（mem）。 */
  function fromRaw(raw) {
    var doc = raw;
    if (typeof raw === 'string') {
      try { doc = JSON.parse(raw); } catch (e) {
        log('stored progress is not readable JSON, starting from nothing');
        return {};
      }
    }
    if (!doc) return {};
    var list = null;
    if (Array.isArray(doc.records)) list = doc.records;
    else if (Array.isArray(doc)) list = doc;   // 万一早期落过一份裸数组
    if (!list) return {};
    var out = {};
    list.forEach(function (r) {
      if (!usable(r)) return;
      var s = shape(r);
      out[wrapKey(s.courseId, s.questionKey)] = s;
    });
    return out;
  }

  function table() {
    return mem === null ? {} : mem;
  }

  /* 从库里把这本账抄进脑子。搬旧数据那一趟由 study-storage.js 在发起读数时一起做。
     已经有脑子就不再对账：这一页里刚记的那一笔可能比库里那份新。 */
  function hydrate() {
    var s = store();
    if (!s) return Promise.resolve({ ok: false, error: 'secure extension storage is unavailable' });
    return s.get(KEY, null).then(function (raw) {
      if (mem === null && raw) mem = fromRaw(raw);
      else if (mem === null) mem = {};
      return { ok: true, count: Object.keys(mem).length };
    }, function (err) {
      if (mem === null) mem = {};
      return { ok: false, error: String((err && err.message) || err || 'could not read learning progress') };
    });
  }

  /* 有没有真读到过一次。没读到过的 0 不等于"这门课没练过"，那一行要说"正在读" */
  function known() { return mem !== null; }

  function saveMap(map) {
    // 最久没碰的先扔：这一本记的是"接下来要复习什么"，久不复习的那条本就没了价值
    var list = Object.keys(map).map(function (k) { return map[k]; });
    if (list.length > RECORD_CAP) {
      list.sort(function (a, b) { return (a.lastSeenAt || 0) - (b.lastSeenAt || 0); });
      list = list.slice(list.length - RECORD_CAP);
    }
    var next = {};
    list.forEach(function (r) { next[wrapKey(r.courseId, r.questionKey)] = r; });
    mem = next;
    var doc = { version: VERSION, records: list };
    var s = store();
    if (!s) {
      lastWrite = { ok: false, error: 'secure extension storage is unavailable' };
      pending = Promise.resolve(lastWrite);
      log('this attempt is not saved:', lastWrite.error);
      return { ok: true, count: list.length, saved: false, error: lastWrite.error, done: pending };
    }
    var snapshot = JSON.stringify(doc);
    pending = pending.then(function () {
      return s.set(KEY, JSON.parse(snapshot));
    }).then(function (res) {
      lastWrite = res && res.ok ? { ok: true, error: '' } : { ok: false, error: String((res && res.error) || 'the write did not go through') };
      if (!lastWrite.ok) log('could not write:', lastWrite.error);
      return lastWrite;
    }, function (err) {
      lastWrite = { ok: false, error: String((err && err.message) || err || 'the write did not go through') };
      return lastWrite;
    });
    return { ok: true, count: list.length, saved: true, done: pending };
  }

  function rowsOf(map, courseId) {
    var cid = num(courseId);
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (r) {
      // courseId 不给（或给了 0）就是全部课程：设置那一屏要报的是整本账
      if (!cid) return true;
      return r.courseId === cid;
    });
  }

  /* 答完一题记一笔。result 是这一题落在掌握哪一档：
     correct（选对）／wrong（选错）／uncertain（简答题他自己选"我不确定"，或答得不确定的那一档）。
     selfRating 是简答题那三颗自评，只登记成 confidence，不改判分那一档。 */
  function recordAttempt(courseId, item) {
    var it = item && typeof item === 'object' ? item : {};
    var key = it.questionKey || keyForQuestion(it, courseId);
    if (!key) return { ok: false, error: 'this question has no key' };
    if (mem === null) {
      /* 还没从库里读到过就记这一笔，等于拿一份"只有这一条"的账去盖库里那本：
         他之前练过的几十条会当场没了。这一趟补发一次读数，这一笔记不上，说一句就好 */
      hydrate();
      return { ok: false, error: 'learning progress has not been read yet' };
    }
    var result = ['correct', 'wrong', 'uncertain'].indexOf(it.result) >= 0 ? it.result : 'uncertain';
    var at = num(it.at) || Date.now();
    var map = table();
    var wk = wrapKey(courseId, key);
    var rec = map[wk] || blankRecord(courseId, key, it.concept, it.sourceTags);
    if (!rec.concept && it.concept) rec.concept = String(it.concept).slice(0, 200);
    if (it.sourceTags) rec.sourceTags = tagList(it.sourceTags);
    rec.attemptCount += 1;
    rec.lastResult = result;
    rec.confidence = ['mastered', 'uncertain', 'weak'].indexOf(it.selfRating) >= 0
      ? it.selfRating
      : (result === 'correct' ? 'mastered' : (result === 'wrong' ? 'weak' : 'uncertain'));
    if (result === 'wrong') {
      rec.streak = 0;
      rec.nextReviewAt = at + WRONG_GAP;
    } else if (result === 'uncertain') {
      rec.streak = 0;
      rec.nextReviewAt = at + UNCERTAIN_GAP;
    } else {
      rec.correctCount += 1;
      rec.streak += 1;
      var idx = Math.min(rec.streak - 1, MASTER_STEPS.length - 1);
      rec.nextReviewAt = at + MASTER_STEPS[Math.max(0, idx)];
    }
    rec.lastSeenAt = at;
    map[wk] = rec;
    var out = saveMap(map);
    out.record = rec;
    if (!out.ok) log('this attempt is not saved:', out.error);
    return out;
  }

  /* 现在该复习的那些，最紧急的排最前。
     到期时间是 0 的那种（从没答过的空壳）不算到期，免得一本空账报出一堆。 */
  function due(courseId, now) {
    var at = num(now) || Date.now();
    return rowsOf(table(), courseId).filter(function (r) {
      return r.attemptCount > 0 && r.nextReviewAt > 0 && r.nextReviewAt <= at;
    }).sort(function (a, b) { return a.nextReviewAt - b.nextReviewAt; });
  }

  /* 这一门课（或全部）的账：练过几题、掌握几题、不确定几题、还不会几题、现在到期的有几题。
     没答过的空壳一律不计，所以没进度时这几个数全 0，屏幕上那一行就不画。 */
  function summary(courseId) {
    var rows = rowsOf(table(), courseId).filter(function (r) { return r.attemptCount > 0; });
    var out = { practiced: rows.length, mastered: 0, uncertain: 0, weak: 0, dueNow: 0, ok: true };
    var at = Date.now();
    rows.forEach(function (r) {
      if (r.lastResult === 'correct') out.mastered++;
      else if (r.lastResult === 'uncertain') out.uncertain++;
      else if (r.lastResult === 'wrong') out.weak++;
      if (r.nextReviewAt > 0 && r.nextReviewAt <= at) out.dueNow++;
    });
    return out;
  }

  function removeSome(courseId) {
    var map = table();
    var wk = Object.keys(map).filter(function (k) {
      return !num(courseId) || num(map[k].courseId) === num(courseId);
    });
    wk.forEach(function (k) { delete map[k]; });
    var out = saveMap(map);
    out.removed = wk.length;
    return out;
  }

  function clearCourse(courseId) {
    if (!num(courseId)) return { ok: false, error: 'no course to clear' };
    return removeSome(courseId);
  }

  function clearAll() {
    // 先数再删：删完这本账就是空的，"清掉了多少条"那句只能靠删之前的数
    var n = rowsOf(table(), 0).length;
    mem = {};
    var s = store();
    if (!s) return { ok: false, removed: n, error: 'secure extension storage is unavailable' };
    var done = s.remove(KEY).then(function (res) {
      lastWrite = res && res.ok ? { ok: true, error: '' } : { ok: false, error: String((res && res.error) || 'could not clear') };
      return lastWrite;
    });
    return { ok: true, removed: n, done: done };
  }

  function count(courseId) {
    return rowsOf(table(), courseId).filter(function (r) { return r.attemptCount > 0; }).length;
  }

  window.MCxProgress = {
    key: KEY,
    version: VERSION,
    hydrate: hydrate,
    known: known,
    recordAttempt: recordAttempt,
    due: due,
    summary: summary,
    clearCourse: clearCourse,
    clearAll: clearAll,
    keyForQuestion: keyForQuestion,
    count: count,
    flush: function () { return pending; },
    lastWriteError: function () { return lastWrite.ok ? '' : lastWrite.error; }
  };

  // 一跑到就发起读数：晚一帧，答完第一题时那本账还在库里，这一笔就记不上
  try { if (store()) hydrate(); } catch (e) {}
})();
