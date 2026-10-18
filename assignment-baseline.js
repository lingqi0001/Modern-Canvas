/* =========================================================
   Personal Baseline：每个人自己的推荐门槛。

   为什么要有这一层：固定 AI Value ≥ 50 才推荐，高中生的作业普遍短、要求集中在附件里，
   可能一学期都碰不到那条线；大学生反过来，几乎页页都过线。同一把尺子量两种人，
   对其中一种人一定是坏的。

   三条不许越过的边界：
   - 原始 AI Value 永远不动。这一层只挪"够不够格自动推荐"那条线，0-100 那份判值
     还是判值，跨人比较、调试、回归断言靠的都是它。
   - 门槛只能把 optional 和 recommended 分开。skip 那条线（THRESHOLDS.skipBelow）
     是绝对底线，个人化不许把一份本来"不值得总结"的作业抬成值得。
   - 内容没读全（need_content）永远压过分数。再低的门槛也不许绕过没读的核心附件。

   所有参数集中在下面这一颗 CONFIG 里，将来拿真作业数据校准时只改这里。
   ========================================================= */
(function (root) {
  'use strict';

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

  var CONFIG = {
    storeKey: 'mc_assign_baseline_v1',
    autoKey: 'mc_guide_auto',          // 自动生成那颗开关
    modeKey: 'mc_guide_sensitivity',   // less / adaptive / more
    manualKey: 'mc_guide_manual',      // 手填门槛（空＝不手填）

    sampleWindow: 30,   // 只数最近多少份不同作业
    minSamples: 20,     // 不到这个份数不启用动态校准
    percentile: 80,     // 拿分布的第几百分位当基准
    offset: 2,          // 基准往下挪多少当门槛
    clampLow: 35,       // 自适应门槛的合法下沿
    clampHigh: 55,      // 合法上沿
    defaultThreshold: 50, // 样本不够时用的值（和引擎原来的判据一致）

    smoothAlpha: 0.5,   // 新算出来的目标占几成，旧的占 1-几成
    smoothMaxStep: 5,   // 一次重算最多挪多少分，防止一份极端作业把门槛拖走

    /* 三档灵敏度动的都是"门槛"，不是分数 */
    sensitivity: { less: 6, adaptive: 0, more: -6 },
    hardFloor: 25,      // 任何一档、任何手填都不许低于这条线（＝引擎的 skip 线）
    hardCeil: 60,       // 也不许高到谁都够不着

    modes: ['less', 'adaptive', 'more']
  };

  /* ==== 存取：全在 localStorage，和调试窗口那几格同一个通路，内容只有数 ==== */

  function read() {
    var out = { samples: {}, threshold: null, previous: null, updatedAt: 0 };
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.storeKey) || 'null');
      if (raw && raw.samples && typeof raw.samples === 'object') {
        out.samples = raw.samples;
        out.threshold = typeof raw.threshold === 'number' ? raw.threshold : null;
        out.previous = typeof raw.previous === 'number' ? raw.previous : null;
        out.updatedAt = raw.updatedAt || 0;
      }
    } catch (e) {}
    return out;
  }

  function write(store) {
    store.updatedAt = Date.now();
    try { localStorage.setItem(CONFIG.storeKey, JSON.stringify(store)); } catch (e) {}
    return store;
  }

  function setting(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function putSetting(key, value) {
    try {
      if (value == null || value === '') localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch (e) {}
  }

  /* ==== 这份判值配不配进样本 ==== */

  /* 返回 { ok, why }。why 是要上屏的一句话，不能只说"不合格" */
  function usable(result, opts) {
    opts = opts || {};
    var th = result.thresholds || {};
    if (opts.source === 'test') return { ok: false, why: 'a test run, not a page the student actually read' };
    if (opts.overridden) return { ok: false, why: 'the weights were overridden in the debug window, so this is an experiment, not a measurement' };
    if (result.ctx && result.ctx.lockedForUser) return { ok: false, why: 'Canvas hides this assignment from your account, so what we read is not what a student reads' };
    if ((result.ctx && result.ctx.body && result.ctx.body.chars || 0) < (th.trivialChars || 120)) {
      return { ok: false, why: 'the page carries under ' + (th.trivialChars || 120) + ' characters, too little to say anything about this person’s distribution' };
    }
    if (opts.readErrors) return { ok: false, why: 'the page itself could not be read (' + opts.readErrors + ' request(s) failed), so there is no score to sample' };
    if (result.readiness && typeof result.readiness.score === 'number' && result.readiness.score < (th.readinessMin || 55)) {
      return { ok: false, why: 'Readiness ' + result.readiness.score + ' is under the ' + (th.readinessMin || 55) + ' floor, so the score was computed on partial material' };
    }
    return { ok: true, why: '' };
  }

  /* 一份作业只留一条样本：同一 key 再判一次是覆盖，不是追加。
     老师改了字（指纹变了）也还是覆盖——分布里不该出现"同一份作业的两个版本"。 */
  function record(result, opts) {
    var check = usable(result, opts);
    var store = read();
    var key = String(result.key || '');
    if (!check.ok) {
      noteSkip(key, check.why, result.aiValue);
      return { recorded: false, why: check.why, replaced: false, key: key, state: status(read()) };
    }
    var had = !!store.samples[key];
    var row = {
      aiValue: result.aiValue,
      readiness: result.readiness ? result.readiness.score : null,
      fp: (result.ctx && result.ctx.fingerprint) || '',
      kind: result.kind,
      at: Date.now()
    };
    var before = store.threshold;
    store.samples[key] = row;
    store.previous = before;
    store.threshold = recompute(store, before);
    write(store);
    return {
      recorded: true, why: '', replaced: had, key: key,
      threshold: store.threshold,
      state: status(store)
    };
  }

  /* ==== 那 30 份里取分布 ==== */

  function newest(store, n) {
    var rows = Object.keys(store.samples || {}).map(function (k) {
      var s = store.samples[k];
      return { key: k, aiValue: s.aiValue, at: s.at, readiness: s.readiness };
    });
    rows.sort(function (a, b) { return b.at - a.at; });
    return rows.slice(0, n);
  }

  /* 线性插值的百分位：样本只有 20 个时，"取第 16 个"这种整数做法会抖得很厉害 */
  function percentile(values, p) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    if (v.length === 1) return v[0];
    var rank = (p / 100) * (v.length - 1);
    var lo = Math.floor(rank), hi = Math.ceil(rank);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (rank - lo);
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /* 目标值 → 平滑 → 步长上限。第一次算出来直接采用，不然会从 50 一路往上爬。 */
  function recompute(store, previous) {
    var rows = newest(store, CONFIG.sampleWindow);
    if (rows.length < CONFIG.minSamples) return null;
    var target = clamp(
      Math.round(percentile(rows.map(function (r) { return r.aiValue; }), CONFIG.percentile) - CONFIG.offset),
      CONFIG.clampLow, CONFIG.clampHigh
    );
    if (previous == null) return target;
    var blended = previous + CONFIG.smoothAlpha * (target - previous);
    var step = clamp(blended - previous, -CONFIG.smoothMaxStep, CONFIG.smoothMaxStep);
    return Math.round(previous + step);
  }

  /* ==== 当前生效的门槛：自适应那一层，再叠灵敏度或手填 ==== */

  function status(store) {
    store = store || read();
    var rows = newest(store, CONFIG.sampleWindow);
    var values = rows.map(function (r) { return r.aiValue; });
    var enough = rows.length >= CONFIG.minSamples;
    var p80 = enough ? percentile(values, CONFIG.percentile) : null;
    var rawTarget = enough ? clamp(Math.round(p80 - CONFIG.offset), CONFIG.clampLow, CONFIG.clampHigh) : null;
    var adaptive = store.threshold;
    var mode = CONFIG.modes.indexOf(setting(CONFIG.modeKey, 'adaptive')) >= 0 ? setting(CONFIG.modeKey, 'adaptive') : 'adaptive';
    var manualRaw = setting(CONFIG.manualKey, '');
    var manual = manualRaw === '' ? null : clamp(Math.round(Number(manualRaw)), CONFIG.hardFloor, CONFIG.hardCeil);

    /* 手填是一档独立的选择：填了就不再叠加灵敏度，否则屏上那颗"More"到底降了几分没人说得清 */
    var base = manual != null ? manual : (adaptive != null ? adaptive : CONFIG.defaultThreshold);
    var shift = manual != null ? 0 : CONFIG.sensitivity[mode];
    var threshold = clamp(base + shift, CONFIG.hardFloor, CONFIG.hardCeil);

    return {
      count: rows.length,
      enough: enough,
      window: CONFIG.sampleWindow,
      minSamples: CONFIG.minSamples,
      values: values,
      rows: rows,
      p80: p80 == null ? null : Math.round(p80 * 10) / 10,
      rawTarget: rawTarget,
      adaptive: adaptive,
      previous: store.previous,
      mode: mode,
      manual: manual,
      shift: shift,
      threshold: threshold,
      auto: autoOn(),
      autoRead: autoReadOn(),
      skipped: skippedRows(store)
    };
  }

  /* 被挡在外面的那些作业为什么没进分布——这一份要能在屏上说出口 */
  function skippedRows(store) {
    var out = [];
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.storeKey + '_skipped') || '[]');
      if (Array.isArray(raw)) out = raw.slice(-12);
    } catch (e) {}
    return out;
  }

  function noteSkip(key, why, aiValue) {
    var rows = [];
    try { rows = JSON.parse(localStorage.getItem(CONFIG.storeKey + '_skipped') || '[]'); } catch (e) { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter(function (r) { return !r || r.key !== key; });
    rows.push({ key: key, why: why, aiValue: aiValue, at: Date.now() });
    while (rows.length > 12) rows.shift();
    try { localStorage.setItem(CONFIG.storeKey + '_skipped', JSON.stringify(rows)); } catch (e) {}
  }

  /* ==== 那份判值在这个人身上该落在哪一档 ==== */

  /* 这是 guide 和 debug 共用的唯一一颗判据：正式界面和调试窗口读的是同一个返回，
     不允许两边各写一份 if */
  function recommend(result, st) {
    st = st || status();
    var th = result.thresholds || {};
    var skipFloor = th.skipBelow != null ? th.skipBelow : CONFIG.hardFloor;
    var engineKind = result.decision ? result.decision.kind : 'optional';
    var floor = Math.max(skipFloor, CONFIG.hardFloor);
    var threshold = Math.max(st.threshold, floor);
    var gates = [];

    var notHidden = engineKind !== 'need_content';
    gates.push({
      id: 'readiness',
      label: 'All of it has been read',
      pass: notHidden,
      detail: notHidden
        ? 'Readiness ' + (result.readiness ? result.readiness.score : '—') + ', nothing important is still behind a file we have not opened'
        : 'a blocking gap is still open: ' + ((result.readiness && result.readiness.blocking) || []).map(function (g) { return g.name; }).join(', '),
      canLower: false
    });

    var worthIt = result.aiValue >= skipFloor;
    gates.push({
      id: 'floor',
      label: 'There is something to lay out',
      pass: worthIt,
      detail: 'AI Value ' + result.aiValue + (worthIt ? ' is at or over the fixed floor of ' + skipFloor : ' is under the fixed floor of ' + skipFloor + ', and no personal threshold can lift it over'),
      canLower: false
    });

    var reached = result.aiValue >= threshold;
    gates.push({
      id: 'threshold',
      label: 'It clears your own bar',
      pass: reached,
      detail: 'AI Value ' + result.aiValue + ' against your threshold ' + threshold + ' (raw score unchanged)',
      canLower: true
    });

    gates.push({
      id: 'auto',
      label: 'Auto-generate is switched on',
      pass: !!st.auto,
      detail: st.auto ? 'you turned it on in AI Settings' : 'off, so this page only offers the button, it will not send by itself',
      canLower: false
    });

    var kind;
    if (!notHidden) kind = 'need_content';
    else if (!worthIt) kind = 'skip';
    else kind = reached ? 'recommended' : 'optional';

    var isUnloggedCloud = false;
    try {
      if (root.MCxAi && root.MCxAi.isCloudMode && root.MCxAi.isCloudMode()) {
        if (root.MCxAi.isUserLoggedIn && !root.MCxAi.isUserLoggedIn()) {
          var cfg = root.MCxAi.config ? root.MCxAi.config('assignment') : null;
          if (!cfg || !cfg.key) isUnloggedCloud = true;
        }
      }
    } catch (e) {}

    var auto = notHidden && worthIt && reached && !!st.auto && !isUnloggedCloud;

    return {
      kind: kind,
      engineKind: engineKind,
      /* 引擎那条"这一页压根没东西可读"原样带出去：卡片出不出只问这一颗，
         不在界面层再写一份 if（那样两处会各判各的） */
      emptyPage: !!(result.decision && result.decision.emptyPage),
      aiValue: result.aiValue,
      threshold: threshold,
      rawThreshold: st.threshold,
      adaptive: kind === 'recommended',
      movedBand: kind !== engineKind && engineKind !== 'need_content' && kind !== 'need_content',
      gates: gates,
      auto: auto,
      /* 门槛降下去也救不了的那几条，写成一句话给画面用 */
      blockedBy: gates.filter(function (g) { return !g.pass && !g.canLower; }).map(function (g) { return g.label; })
    };
  }

  /* ==== 设置里那一行小字 ==== */

  function statusLine(st) {
    st = st || status();
    if (!st.enough) return 'Learning your assignments · ' + st.count + '/' + st.minSamples + ' analyzed';
    var from = st.count >= CONFIG.sampleWindow ? 'your last ' + st.count + ' assignments' : st.count + ' assignments';
    var tail = st.manual != null
      ? 'Current threshold: ' + st.threshold + ' (you set this one by hand)'
      : 'Current threshold: ' + st.threshold + (st.mode === 'adaptive' ? '' : ' (' + st.mode + ')');
    return 'Personalized from ' + from + ' · ' + tail;
  }

  /* 计算过程摊开成行：设置里的 Advanced 和调试窗口都读这一份，别各写一套 */
  function explain(st) {
    st = st || status();
    var out = [];
    out.push({ k: 'Samples kept', v: st.count + ' of the newest ' + CONFIG.sampleWindow + ' distinct assignments (min ' + CONFIG.minSamples + ' to calibrate)' });
    out.push({ k: 'Their raw AI Values', v: st.values.length ? st.values.join(', ') : 'none yet' });
    out.push({ k: 'P' + CONFIG.percentile + ' of that spread', v: st.p80 == null ? 'not computed, under ' + CONFIG.minSamples + ' samples' : st.p80 });
    out.push({ k: 'Target before smoothing', v: st.rawTarget == null ? 'n/a' : st.rawTarget + ' (P' + CONFIG.percentile + ' minus ' + CONFIG.offset + ', clamped to ' + CONFIG.clampLow + '–' + CONFIG.clampHigh + ')' });
    out.push({ k: 'Adaptive threshold stored', v: st.adaptive == null ? 'not yet' : st.adaptive + (st.previous == null ? '' : ' (was ' + st.previous + ', one recompute may only move ' + CONFIG.smoothMaxStep + ')' ) });
    out.push({ k: 'Sensitivity', v: st.mode + (st.manual != null ? ', ignored because a manual threshold is set' : ', shift ' + (st.shift > 0 ? '+' : '') + st.shift) });
    out.push({ k: 'Manual override', v: st.manual == null ? 'off' : st.manual });
    out.push({ k: 'Threshold now in force', v: st.threshold + ' (never under ' + Math.max(CONFIG.hardFloor, 25) + ', never over ' + CONFIG.hardCeil + ')' });
    out.push({ k: 'What this layer may change', v: 'only the line between Optional and Recommended. Skip and the Readiness gate are fixed.' });
    if (st.skipped.length) {
      out.push({ k: 'Runs not added to the spread', v: st.skipped.map(function (r) { return (r.key || '?') + ': ' + r.why; }).join(' / ') });
    }
    return out;
  }

  /* ==== 三颗设置的本机读法（正本在 localStorage，和调试窗口那几格同一条通路） ==== */

  /* 正式版：达标后自动触发 AI 总结（达标标准遵循用户设置的 adaptive 分数或 manual 手动阈值） */
  function autoOn() { return setting(CONFIG.autoKey, '1') !== '0'; }
  function setAuto(on) {
    putSetting(CONFIG.autoKey, on ? '1' : '0');
    if (on) putSetting(CONFIG.autoReadKey || 'mc_guide_auto_read', '1');
    return autoOn();
  }
  /* 自动阅读作业文件设置：若 autoOn 开启，则不得关闭（强制为 true） */
  function autoReadOn() {
    if (autoOn()) return true;
    return setting(CONFIG.autoReadKey || 'mc_guide_auto_read', '1') !== '0';
  }
  function setAutoRead(on) {
    if (autoOn()) return true; // 开启自动生成guide时，自动开启阅读，不得关闭
    putSetting(CONFIG.autoReadKey || 'mc_guide_auto_read', on ? '1' : '0');
    return autoReadOn();
  }
  function mode() { var m = setting(CONFIG.modeKey, 'adaptive'); return CONFIG.modes.indexOf(m) >= 0 ? m : 'adaptive'; }
  function setMode(m) { putSetting(CONFIG.modeKey, CONFIG.modes.indexOf(m) >= 0 ? m : 'adaptive'); return mode(); }
  function manualThreshold() { var v = setting(CONFIG.manualKey, ''); return v === '' ? null : Number(v); }
  function setManualThreshold(v) {
    if (v == null || v === '') { putSetting(CONFIG.manualKey, ''); return null; }
    var n = Number(v);
    if (!isFinite(n)) return manualThreshold();
    var value = clamp(Math.round(n), CONFIG.hardFloor, CONFIG.hardCeil);
    putSetting(CONFIG.manualKey, value);
    return value;
  }

  function clear() {
    try {
      localStorage.removeItem(CONFIG.storeKey);
      localStorage.removeItem(CONFIG.storeKey + '_skipped');
    } catch (e) {}
    return { samples: {}, threshold: null, previous: null, updatedAt: 0 };
  }

  /* 门槛挪了多少分、为什么挪：重算前把旧值存进 previous，屏上才说得出"上一档是多少" */
  function recomputeNow() {
    var store = read();
    var before = store.threshold;
    store.previous = before;
    store.threshold = recompute(store, before);
    write(store);
    return status(store);
  }

  var api = {
    CONFIG: CONFIG,
    status: status,
    record: record,
    usable: usable,
    recommend: recommend,
    percentile: percentile,
    statusLine: statusLine,
    explain: explain,
    autoOn: autoOn,
    setAuto: setAuto,
    autoReadOn: autoReadOn,
    setAutoRead: setAutoRead,
    mode: mode,
    setMode: setMode,
    manualThreshold: manualThreshold,
    setManualThreshold: setManualThreshold,
    recomputeNow: recomputeNow,
    clear: clear,
    noteSkip: noteSkip
  };

  if (typeof define === 'function' && define.amd) define([], function () { return api; });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MCxAssignBaseline = api;
})(typeof window !== 'undefined' ? window : global);
