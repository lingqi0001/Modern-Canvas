/* =========================================================
   Assignment 详情页的 Debug 测试窗口。

   它不是产品界面，是我们拿真作业验判值准不准的仪表：所有类型的作业详情页（普通作业、
   测验、讨论、带附件或评分表的）都挂同一颗药丸，点开是七档读数。
   取数走 assignment-data.js，判值走 assignment-analyze.js，这一份只负责摆出来。

   几条自己约束自己的口径：
   - 每一次判值都留档（run），点 chips 切换对比；改了权重重跑就是新的一条，
     不然调完算法看不到"上一条判成了什么"。
   - 站点给的任何 HTML／JSON 一律 textContent 上屏，零 innerHTML。
   - AI 那一档把发出去的原文完整摆出来，回包解析不了的行单独摆出来，不悄悄丢。
   ========================================================= */
(function (root) {
  'use strict';

  // 非 Canvas 站点直接退出，严禁挂载轮询与调试面板
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

  var DATA = null;   // MCxAssignData，boot 时再取，避免加载顺序写死
  var AN = null;     // MCxAnalyze
  var WEIGHTS_KEY = 'mc_assign_weights';
  var OPEN_KEY = 'mc_assign_debug_open';
  /* 这颗窗口是新加的视觉，所以自带一颗关掉它的键；关掉后连药丸一起摘，
     要再叫回来是 MCxAssignDebug.enable()，不用他记住某个存储键的名字 */
  var ENABLE_KEY = 'mc_assign_debug';
  var TABS = [
    { id: 'overview', label: 'Summary' },
    { id: 'raw', label: 'Data' },
    { id: 'structure', label: 'Content structure' },
    { id: 'sources', label: 'Materials' },
    { id: 'scores', label: 'Score details' },
    { id: 'decision', label: 'Result' },
    { id: 'ai', label: 'Test AI' }
  ];

  var S = {
    target: null,
    mounted: false,
    open: false,
    gen: 0,
    tab: 'overview',
    stage: '',
    loading: false,
    error: '',
    runs: [],
    runIndex: -1,
    weights: null,
    collected: null,
    submission: null,
    siblings: null,
    drag: null,
    ai: { text: '', lines: null, running: false, notice: '', slot: 'advanced', showPrompt: false, usage: null, controller: null, started: 0, prompt: '' }
  };

  /* ==== 小工具 ==== */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function btn(label, cls, onClick) {
    var b = h('button', 'mcx-adb-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function kv(name, value, cls) {
    var row = h('div', 'mcx-adb-kv' + (cls ? ' ' + cls : ''));
    row.appendChild(h('span', 'mcx-adb-k', name));
    row.appendChild(h('span', 'mcx-adb-v', value == null ? '—' : String(value)));
    return row;
  }

  function section(title, note) {
    var box = h('div', 'mcx-adb-sec');
    box.appendChild(h('div', 'mcx-adb-secTitle', title));
    if (note) box.appendChild(h('div', 'mcx-adb-secNote', note));
    return box;
  }

  function json(text) {
    var pre = h('pre', 'mcx-adb-json', text);
    return pre;
  }

  function dump(label, value, limit) {
    var cap = limit || 20000;
    var s = '';
    try { s = JSON.stringify(value, null, 2); } catch (e) { s = String(value); }
    if (s == null) s = 'undefined';
    var box = h('div', 'mcx-adb-dump');
    box.appendChild(h('div', 'mcx-adb-dumpHead', label + ' · ' + s.length + ' characters'));
    if (s.length > cap) {
      box.appendChild(json(s.slice(0, cap) + '\n\n… cut at ' + cap + ' characters, the rest is still in Canvas'));
      box.appendChild(h('div', 'mcx-adb-warn', 'Showing the first ' + cap + ' of ' + s.length + ' characters.'));
    } else {
      box.appendChild(json(s));
    }
    return box;
  }

  function pct(n) { return Math.round(clamp(n, 0, 1) * 100) + '%'; }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function clock(ts) {
    var d = new Date(ts);
    function two(v) { return (v < 10 ? '0' : '') + v; }
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /* ==== 挂载 ==== */

  var pill = null;
  var panel = null;
  var keyBound = false;

  function mount() {
    if (S.mounted) return;
    S.mounted = true;

    pill = h('button', 'mcx-adb-pill');
    pill.type = 'button';
    pill.setAttribute('aria-label', 'Open the assignment analysis test window');
    pill.addEventListener('click', function () { setOpen(true); });
    document.body.appendChild(pill);

    panel = h('div', 'mcx-adb-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Assignment analysis test window');
    var head = h('div', 'mcx-adb-head');
    head.appendChild(h('div', 'mcx-adb-title', 'Assignment analysis'));
    var actions = h('div', 'mcx-adb-actions');
    actions.appendChild(btn('Re-analyze', 'mcx-adb-quiet', function () { analyze(true, 'manual Re-analyze'); }));
    var hide = btn('Hide', 'mcx-adb-quiet', function () { setOpen(false); });
    actions.appendChild(hide);
    var close = btn('Close', 'mcx-adb-quiet', function () { setOpen(false); });
    actions.appendChild(close);
    head.appendChild(actions);
    head.addEventListener('pointerdown', startDrag);
    panel.appendChild(head);

    var tabs = h('div', 'mcx-adb-tabs');
    TABS.forEach(function (t) {
      var b = h('button', 'mcx-adb-tab');
      b.type = 'button';
      b.textContent = t.label;
      b.dataset.tab = t.id;
      b.addEventListener('click', function () { S.tab = t.id; draw(); });
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    var runs = h('div', 'mcx-adb-runs');
    runs.appendChild(h('span', 'mcx-adb-runsLabel', 'Runs'));
    var runsList = h('div', 'mcx-adb-runsList');
    runsList.className = 'mcx-adb-runsList';
    runs.appendChild(runsList);
    panel.appendChild(runs);

    var body = h('div', 'mcx-adb-body');
    panel.appendChild(body);

    var foot = h('div', 'mcx-adb-foot');
    panel.appendChild(foot);

    document.body.appendChild(panel);
    /* 这座窗口会被摘掉再挂回来（关掉那颗键、换页、控制台 enable），
       按键监听只挂一次，不然每来回一趟就多一份 */
    if (!keyBound) {
      keyBound = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && S.open) setOpen(false);
      });
    }
    panel.addEventListener('wheel', containScroll, { passive: false });
    draw();
  }

  /* 面板里滚到顶/底就别把滚动传给页面（和 AI 抽屉同一口径） */
  function containScroll(e) {
    var scroller = e.target && e.target.closest ? e.target.closest('.mcx-adb-body') : null;
    if (!scroller) return;
    var up = e.deltaY < 0;
    var top = scroller.scrollTop <= 0;
    var bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    if ((up && top) || (!up && bottom)) e.preventDefault();
  }

  function startDrag(e) {
    if (e.target.closest('button')) return;
    var rect = panel.getBoundingClientRect();
    S.drag = {
      id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top,
      left: rect.left, top: rect.top, moved: false
    };
    panel.classList.add('is-dragging');
    panel.setPointerCapture && panel.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag, { once: true });
    e.preventDefault();
  }

  /* 拖的那几帧只写 transform，松手才落回 left/top：
     每帧写 left/top 会整棵子树重排，那就是他报过的"拖着卡" */
  function onDrag(e) {
    if (!S.drag || !panel) return;
    S.drag.moved = true;
    var x = Math.round(clamp(e.clientX - S.drag.dx, 8, window.innerWidth - 80));
    var y = Math.round(clamp(e.clientY - S.drag.dy, 8, window.innerHeight - 60));
    panel.style.transform = 'translate3d(' + (x - S.drag.left) + 'px,' + (y - S.drag.top) + 'px,0)';
  }

  function endDrag() {
    if (!S.drag) return;
    var t = panel ? panel.style.transform : '';
    var m = /translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/.exec(t || '');
    if (panel) panel.classList.remove('is-dragging');
    if (m && S.drag.moved && panel) {
      panel.style.left = Math.round(S.drag.left + Number(m[1])) + 'px';
      panel.style.top = Math.round(S.drag.top + Number(m[2])) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    if (panel) panel.style.transform = '';
    window.removeEventListener('pointermove', onDrag);
    S.drag = null;
  }

  function setOpen(open) {
    S.open = open;
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) {}
    draw();
    if (open && !S.runs.length && !S.loading) analyze(false, 'first open');
  }

  /* ==== 一趟判值 ==== */

  function setStage(text) {
    S.stage = text || '';
    if (S.open) draw();
  }

  function analyze(force, why) {
    if (!S.target) return;
    S.loading = true;
    S.error = '';
    /* Canvas 是同页应用：作业 A 的读数还在路上时点了作业 B，
       晚到的那份回包不许把 B 的画面盖成 A。每一步先问代次。 */
    var gen = ++S.gen;
    setStage('reading this assignment from Canvas');

    DATA.collect(S.target, function (label) {
      if (gen !== S.gen) return;
      setStage('reading: ' + label);
    }, { force: !!force }).then(function (collected) {
      if (gen !== S.gen) return;
      S.loading = false;
      if (!collected || !collected.ctx) {
        S.error = 'No assignment details were returned.';
        drawPill();
        return;
      }
      S.collected = collected;
      var stored = DATA.cacheRead(collected.ctx.key);
      var cacheState = !stored ? { hit: false, why: 'no stored verdict for this assignment id yet' }
        : stored.fingerprint !== collected.ctx.fingerprint
          ? { hit: false, why: 'the teacher changed the wording since the last run (fingerprint differs), so the stored verdict is stale' }
          : { hit: true, why: 'same fingerprint as the run from ' + clock(stored.at), row: stored };
      if (force && stored && stored.fingerprint === collected.ctx.fingerprint) {
        cacheState.hit = false;
        cacheState.why = 'a stored verdict existed (' + clock(stored.at) + ', ' + stored.decision + ') but Re-analyze was pressed, so it was ignored';
      }
      var run = pushRun(collected.ctx, null, why || 'auto', cacheState);
      DATA.cacheWrite(collected.ctx.key, {
        fingerprint: collected.ctx.fingerprint, at: Date.now(),
        decision: run.result.decision.kind, aiValue: run.result.aiValue, readiness: run.result.readiness.score
      });
      /* 这一份也喂个人基准：同一份作业再判一次是覆盖那一条，不会多算一样。
         但手改过权重的那几趟属于实验，进了样本就会把门槛带跑，所以标出来让它进不去 */
      if (root.MCxAssignBaseline) {
        var added = root.MCxAssignBaseline.record(run.result, { source: 'debug', overridden: !!S.weights });
        S.baselineAdded = added.recorded;
        S.baselineWhy = added.why || '';
      }
      drawPill();
      draw();
      /* 分先画出来，材料随后量：量这一步要下课件的字节，不能让他对着空白等 */
      DATA.countFiles(collected.ctx, function (f) {
        if (gen !== S.gen) return;
        setStage('counting ' + (f.name || f.id));
      }).then(function (m) {
        if (gen !== S.gen) return;
        if (!m.counted && !m.skipped) return;
        rejudge('after counting ' + m.counted + ' file(s) of material');
      });
      DATA.submissionState(collected.ctx.courseId, collected.ctx.assignmentId).then(function (s) {
        if (gen !== S.gen) return;
        S.submission = s;
        if (S.open && S.tab === 'overview') draw();
      });
    }, function (err) {
      if (gen !== S.gen) return;
      S.loading = false;
      S.error = String((err && err.message) || err);
      draw();
      drawPill();
      DATA.log('analysis failed', S.error);
    });
  }

  /* 每次判值都留一条，改权重重跑、读完附件重跑都是新的一条 */
  function pushRun(ctx, weights, why, cacheState) {
    var result = AN.analyze(ctx, weights);
    result.runWhy = why;
    result.cache = cacheState || { hit: false, why: 'not checked on this run' };
    S.runs.push({ at: Date.now(), why: why, result: result });
    if (S.runs.length > 12) S.runs.shift();
    S.runIndex = S.runs.length - 1;
    return S.runs[S.runs.length - 1];
  }

  function rejudge(why) {
    if (!S.collected) return;
    pushRun(S.collected.ctx, S.weights, why, { hit: false, why: 'a fresh judgement of the same data, nothing re-read from Canvas' });
    draw();
    drawPill();
  }

  function live() {
    return S.runs.length ? S.runs[Math.min(S.runIndex, S.runs.length - 1)].result : null;
  }

  /* ==== 药丸 ==== */

  function drawPill() {
    if (!pill) return;
    var r = live();
    pill.textContent = '';
    if (S.loading) {
      pill.appendChild(h('span', 'mcx-adb-pillWord', 'Assignment analysis, reading'));
      pill.classList.remove('is-skip', 'is-recommended');
      return;
    }
    pill.appendChild(h('span', 'mcx-adb-pillWord', 'Assignment analysis'));
    if (r) {
      var label = { skip: 'not worth a summary', optional: 'summary available', recommended: 'worth a summary', need_content: 'missing content' }[r.decision.kind] || r.decision.kind;
      pill.appendChild(h('span', 'mcx-adb-pillBadge', label + ' · ' + r.aiValue));
      pill.classList.toggle('is-skip', r.decision.kind === 'skip');
      pill.classList.toggle('is-recommended', r.decision.kind === 'recommended');
    } else {
      pill.appendChild(h('span', 'mcx-adb-pillBadge', 'not run yet'));
    }
  }

  /* ==== 画面 ==== */

  function draw() {
    if (!S.mounted) return;
    panel.classList.toggle('is-open', S.open);
    pill.hidden = S.open;
    drawPill();
    var tabsBar = panel.querySelector('.mcx-adb-tabs');
    if (tabsBar) {
      Array.prototype.forEach.call(tabsBar.children, function (b) {
        b.classList.toggle('is-on', b.dataset.tab === S.tab);
      });
    }
    drawRuns();
    var body = panel.querySelector('.mcx-adb-body');
    body.textContent = '';
    var foot = panel.querySelector('.mcx-adb-foot');
    foot.textContent = '';
    foot.appendChild(btn('Stop showing this window on assignment pages', 'mcx-adb-quiet', function () {
      try { localStorage.setItem(ENABLE_KEY, 'off'); } catch (e) {}
      teardown();
    }));
    foot.appendChild(h('span', 'mcx-adb-footNote', 'To bring it back on this page, run in the console: '));
    foot.appendChild(h('code', 'mcx-adb-code', 'ModernCanvasAssignmentDebug.enable()'));

    if (S.error) {
      body.appendChild(h('div', 'mcx-adb-error', 'This run failed: ' + S.error));
      body.appendChild(h('div', 'mcx-adb-note', 'Nothing here is a simulation. The window shows the request list below so the failing step can be named.'));
      if (S.collected) renderRaw(body, S.collected);
      return;
    }
    if (S.loading) {
      body.appendChild(h('div', 'mcx-adb-loading', S.stage || 'working'));
      return;
    }
    var r = live();
    if (!r) {
      body.appendChild(h('div', 'mcx-adb-empty', 'Press Re-analyze to read this assignment.'));
      return;
    }
    var renderer = {
      overview: renderOverview, raw: renderRaw, structure: renderStructure,
      sources: renderSources, scores: renderScores, decision: renderDecision, ai: renderAI
    }[S.tab];
    renderer(body, r);
  }

  function drawRuns() {
    var host = panel.querySelector('.mcx-adb-runsList');
    if (!host) return;
    host.textContent = '';
    if (!S.runs.length) { host.appendChild(h('span', 'mcx-adb-runsNone', 'none yet')); return; }
    S.runs.forEach(function (run, i) {
      var chip = h('button', 'mcx-adb-runChip' + (i === S.runIndex ? ' is-on' : ''),
        '#' + (i + 1) + ' ' + clock(run.at) + ' · ' + run.result.decision.kind + ' · ' + run.result.aiValue);
      chip.type = 'button';
      chip.title = run.why;
      chip.addEventListener('click', function () { S.runIndex = i; draw(); });
      host.appendChild(chip);
    });
  }

  /* ---- 概览 ---- */

  function renderOverview(body, r) {
    var ctx = r.ctx;
    if (ctx.body.parseFailed) {
      body.appendChild(h('div', 'mcx-adb-error', 'The description HTML could not be parsed on this machine: ' + ctx.body.parseFailed + '. Everything below this line is therefore counted as missing, not as absent.'));
    }
    var s = section('What this page is');
    s.appendChild(kv('Title', ctx.title));
    s.appendChild(kv('Page kind', ctx.kind));
    s.appendChild(kv('Canvas ids', 'course ' + ctx.courseId + ' · assignment ' + ctx.assignmentId));
    s.appendChild(kv('Detected task type', r.taskType.primary + ' (top guess of ' + (r.taskType.candidates.length || 1) + ')'));
    s.appendChild(kv('Description text', ctx.body.chars + ' characters, ' + r.contentUnits + ' content line(s) of ' + r.totalUnits + ' read off the HTML'));
    s.appendChild(kv('Where the text came from', ctx.htmlSource));
    var mat = ctx.material || {};
    s.appendChild(kv('Material behind the page', mat.counted
      ? mat.counted + ' file(s) counted without opening: ' + mat.pages + ' page(s), about ' + (mat.textChars || 0).toLocaleString() + ' characters' +
        (mat.picturePages ? ', ' + mat.picturePages + ' page(s) of those are pictures' : '') +
        (mat.media ? ', ' + mat.media + ' embedded image(s)' : '') + (mat.skipped ? ', ' + mat.skipped + ' file(s) too big to count' : '')
      : (mat.files ? mat.files + ' file(s) linked, still to be counted' : 'nothing is linked behind this page')));
    s.appendChild(kv('Fingerprint', ctx.fingerprint));
    s.appendChild(kv('Verdict cache', r.cache.why + (r.cache.hit ? ' (Layer 0). The page data was re-read anyway: this window always reads live.' : '')));
    body.appendChild(s);

    var d = section('The three numbers');
    d.appendChild(gauge('AI Value', r.aiValue, 'is it worth a call'));
    d.appendChild(gauge('Task Complexity', r.complexity, 'how much work the assignment itself is'));
    d.appendChild(gauge('Content Readiness', r.readiness.score, 'how much of it we can actually see'));
    body.appendChild(d);

    var dec = section('Decision');
    var badge = h('div', 'mcx-adb-decision is-' + r.decision.kind, decisionLabel(r.decision.kind));
    dec.appendChild(badge);
    dec.appendChild(h('div', 'mcx-adb-reason', r.decision.reason));
    var flip = h('div', 'mcx-adb-note', r.decision.flip);
    dec.appendChild(flip);
    body.appendChild(dec);

    var sub = section('Your own state on it', 'not part of the judgement, it only explains the page');
    if (!S.submission) sub.appendChild(h('div', 'mcx-adb-note', S.loading ? 'reading…' : 'still reading, or Canvas would not answer'));
    else {
      sub.appendChild(kv('Submitted', S.submission.submittedAt ? S.submission.submittedAt : 'not submitted'));
      sub.appendChild(kv('Grade', S.submission.grade || (S.submission.state ? S.submission.state : 'none yet')));
      sub.appendChild(kv('Teacher comments', S.submission.comments.length ? S.submission.comments.length + ' message(s)' : 'none'));
    }
    body.appendChild(sub);

    var miss = r.readiness.gaps.filter(function (g) { return g.weight > 0; });
    var g = section('What we are missing', miss.length ? '' : 'nothing on the checklist is short');
    if (!miss.length) g.appendChild(h('div', 'mcx-adb-ok', 'Every check on the readiness list came back full.'));
    miss.forEach(function (it) {
      g.appendChild(kv(it.name, pct(it.score) + ' · ' + it.detail + ' · ' + it.why));
    });
    body.appendChild(g);
  }

  function decisionLabel(kind) {
    return {
      skip: 'Skip, no AI call is worth it here',
      optional: 'Optional, offer it but do not push',
      recommended: 'Recommended, this one is worth laying out',
      need_content: 'Need content, something has to be read first'
    }[kind] || kind;
  }

  function gauge(name, value, note) {
    var row = h('div', 'mcx-adb-gauge');
    row.appendChild(h('span', 'mcx-adb-gaugeName', name));
    var bar = h('div', 'mcx-adb-gaugeBar');
    var fill = h('div', 'mcx-adb-gaugeFill');
    fill.style.width = clamp(value, 0, 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(h('span', 'mcx-adb-gaugeNum', String(value)));
    row.appendChild(h('span', 'mcx-adb-gaugeNote', note));
    return row;
  }

  /* ---- 原始数据 ---- */

  function renderRaw(body, r) {
    var collected = S.collected;
    var access = collected.access || [];
    var s = section('Every request this page took', 'status, bytes and milliseconds, in the order they went out');
    var table = h('div', 'mcx-adb-requests');
    access.forEach(function (rec) {
      var row = h('div', 'mcx-adb-req' + (rec.ok ? ' is-ok' : ' is-bad'));
      row.appendChild(h('span', 'mcx-adb-reqStatus', rec.ok ? String(rec.status) : (rec.status || 'fail')));
      row.appendChild(h('span', 'mcx-adb-reqLabel', rec.label));
      row.appendChild(h('span', 'mcx-adb-reqUrl', rec.url));
      row.appendChild(h('span', 'mcx-adb-reqMs', (rec.ms || 0) + ' ms' + (rec.size ? ' · ' + rec.size + ' bytes' : '')));
      if (!rec.ok) {
        row.appendChild(h('span', 'mcx-adb-reqWhy', rec.error || 'failed'));
        if (rec.bodyHead) row.appendChild(h('span', 'mcx-adb-reqHead', 'body starts: ' + rec.bodyHead));
      }
      table.appendChild(row);
    });
    s.appendChild(table);
    body.appendChild(s);

    if (S.error) body.appendChild(h('div', 'mcx-adb-error', S.error));

    var t = section('The assignment object exactly as Canvas sent it');
    t.appendChild(dump('assignment', collected.raw.assignment));
    if (collected.raw.quiz) t.appendChild(dump('quiz', collected.raw.quiz));
    if (collected.raw.newQuiz) t.appendChild(dump('new quiz', collected.raw.newQuiz));
    if (collected.raw.discussion) t.appendChild(dump('discussion topic', collected.raw.discussion));
    body.appendChild(t);

    var h2 = section('description, the raw HTML string');
    h2.appendChild(h('div', 'mcx-adb-note', 'Shown as text on purpose. This window never puts Canvas HTML into the page.'));
    h2.appendChild(dump('rawHTML', collected.ctx.body.rawHTML, 12000));
    body.appendChild(h2);
  }

  /* ---- 结构 ---- */

  function renderStructure(body, r) {
    var st = r.ctx.structure;
    var s = section('What the HTML broke into');
    s.appendChild(kv('Headings', (st.headings || []).length));
    s.appendChild(kv('Lists', (st.lists || []).length + ' (' + (st.lists || []).map(function (l) { return l.type + ' ' + l.items.length; }).join(', ') + ')'));
    s.appendChild(kv('Tables', st.tables));
    s.appendChild(kv('Images', st.images));
    s.appendChild(kv('Same-site links', (st.links || []).length));
    s.appendChild(kv('Week or phase labels', st.weeks));
    s.appendChild(kv('Lines marked as school boilerplate', r.boilerplateUnits + ' of ' + r.totalUnits));
    body.appendChild(s);

    var u = section('Every line the engine read', 'the path in front of each one is what an evidence row points back to');
    var list = h('div', 'mcx-adb-units');
    (r.ctx.units || []).forEach(function (unit) {
      var row = h('div', 'mcx-adb-unit' + (unit.boilerplate ? ' is-boiler' : ''));
      row.appendChild(h('span', 'mcx-adb-unitPath', unit.path));
      row.appendChild(h('span', 'mcx-adb-unitKind', unit.kind + (unit.bold ? ' · bold: ' + unit.bold : '')));
      row.appendChild(h('span', 'mcx-adb-unitText', unit.text));
      if (unit.boilerplate) row.appendChild(h('span', 'mcx-adb-unitFlag', 'the whole line is a standing notice (' + unit.boilerplate + '), its must / rule words are not counted'));
      else if ((unit.boilerCut || []).length) {
        /* 混写的段落：摘掉免责声明，真要求留在正文里继续算，两句都要看得见 */
        row.appendChild(h('span', 'mcx-adb-unitFlag', 'cut out of this line: ' + unit.boilerCut.map(function (c) { return '"' + c.text + '" (' + c.why + ')'; }).join(' ')));
      }
      list.appendChild(row);
    });
    u.appendChild(list);
    body.appendChild(u);
  }

  /* ---- 来源与按需读数 ---- */

  function renderSources(body, r) {
    var ctx = r.ctx;
    var files = ctx.resources.files || [];
    var s = section('Files referenced by the description', 'names and sizes only until you press Read: this window never downloads on its own');
    if (!files.length) s.appendChild(h('div', 'mcx-adb-ok', 'No Canvas file link was found in the description HTML.'));
    var notProbed = files.filter(function (f) { return f.status === 'discovered'; }).length;
    if (notProbed) {
      s.appendChild(h('div', 'mcx-adb-warn', notProbed + ' of these links were never asked about: this window reads at most 8 file records per page, so a page of fifteen links does not fire fifteen requests. Their Read button still works, it fetches the record along with the text.'));
    }
    files.forEach(function (f) {
      var row = h('div', 'mcx-adb-src');
      row.appendChild(h('span', 'mcx-adb-srcName', f.name || f.label || ('file ' + f.id)));
      row.appendChild(h('span', 'mcx-adb-srcMeta', 'id ' + f.id + ' · ' + (f.ext || f.mime || 'type not read') + ' · ' + (f.bytes ? Math.round(f.bytes / 1024) + ' KB' : 'size not read') + (f.locked ? ' · locked for you' : '')));
      row.appendChild(h('span', 'mcx-adb-srcStatus', statusText(f)));
      if (f.measure && !f.measure.skipped) {
        row.appendChild(h('span', 'mcx-adb-srcMeasure', 'counted without opening: ' + (f.measure.pages || 0) + ' page(s), ' +
          (f.measure.chars || 0).toLocaleString() + ' characters' +
          (f.measure.picturePages ? ', ' + f.measure.picturePages + ' page(s) that are pictures' : '') +
          (f.measure.media ? ', ' + f.measure.media + ' embedded image(s)' : '') +
          (f.measure.note ? ' (' + f.measure.note + ')' : '')));
      } else if (f.measure) {
        row.appendChild(h('span', 'mcx-adb-srcMeasure is-skipped', 'not counted: ' + f.measure.skipped));
      }
      if (f.status === 'metadata_loaded') row.appendChild(btn('Read it', 'mcx-adb-quiet', function () { readOne(f, 'file'); }));
      else if (f.status === 'reading') row.appendChild(h('span', 'mcx-adb-note', 'reading…'));
      s.appendChild(row);
      if (f.text) s.appendChild(dump('extracted text from ' + (f.name || f.id), f.text, 4000));
    });
    body.appendChild(s);

    var pages = ctx.related.pageRefs || [];
    var p = section('Other Canvas pages the description points at', 'the instructions sometimes live here instead');
    if (!pages.length) p.appendChild(h('div', 'mcx-adb-ok', 'No link to another course page.'));
    pages.forEach(function (pg) {
      var row = h('div', 'mcx-adb-src');
      row.appendChild(h('span', 'mcx-adb-srcName', pg.label || pg.pageUrl));
      row.appendChild(h('span', 'mcx-adb-srcMeta', 'page url ' + pg.pageUrl));
      row.appendChild(h('span', 'mcx-adb-srcStatus', statusText(pg)));
      if (pg.status === 'discovered') row.appendChild(btn('Read it', 'mcx-adb-quiet', function () { readOne(pg, 'page'); }));
      p.appendChild(row);
      if (pg.text) p.appendChild(dump('page text ' + pg.pageUrl, pg.text, 4000));
    });
    body.appendChild(p);

    var ex = ctx.resources.external || [];
    var e = section('Links that leave Canvas', 'we cannot read these from here, and the requirement may be behind one');
    if (!ex.length) e.appendChild(h('div', 'mcx-adb-ok', 'Nothing points outside Canvas.'));
    ex.forEach(function (l) {
      var row = h('div', 'mcx-adb-src');
      row.appendChild(h('span', 'mcx-adb-srcName', l.label || l.url));
      row.appendChild(h('span', 'mcx-adb-srcMeta', l.name + ' · ' + l.host));
      row.appendChild(h('span', 'mcx-adb-srcStatus', 'not readable from this extension'));
      e.appendChild(row);
    });
    body.appendChild(e);

    var m = section('Module context', 'one read of the whole module chain, so it is behind a button');
    if (!S.siblings) m.appendChild(btn('Read the module this sits in', 'mcx-adb-quiet', function () {
      var gen = S.gen;
      DATA.moduleSiblings(ctx.courseId, ctx.assignmentId).then(function (res) {
        if (gen !== S.gen) return;
        S.siblings = res;
        draw();
      });
    }));
    else {
      m.appendChild(h('div', 'mcx-adb-note', 'request: ' + S.siblings.record.url + ' · ' + (S.siblings.record.ok ? 'HTTP ' + S.siblings.record.status + ' in ' + S.siblings.record.ms + ' ms' : S.siblings.record.error)));
      if (S.siblings.list) m.appendChild(dump('module item sequence', S.siblings.list, 6000));
    }
    body.appendChild(m);
  }

  function statusText(item) {
    var map = {
      discovered: 'found, not read yet',
      metadata_loaded: 'name and size read, text not read',
      reading: 'reading…',
      extracted: 'text extracted, ' + (item.chars || 0) + ' characters',
      partial: 'only part of it could be read: ' + (item.why || ''),
      unreadable: 'could not be read: ' + (item.why || 'no text came out of it'),
      unavailable: 'Canvas would not give it: ' + (item.why || 'refused')
    };
    return map[item.status] || item.status || 'unknown';
  }

  function readOne(item, what) {
    draw();
    var gen = S.gen;
    var job = what === 'file' ? DATA.readFile(item, S.collected.ctx.courseId) : DATA.readPage(item, S.collected.ctx.courseId);
    job.then(function () {
      /* 读的那几秒里他可能已经点到别的作业：那份正文belongs to the page we left */
      if (gen !== S.gen) return;
      rejudge('after reading ' + (what === 'file' ? 'file ' : 'page ') + (item.name || item.label || item.pageUrl || item.id));
    });
  }

  /* ---- 评分：检测器、证据、权重、公式 ---- */

  function renderScores(body, r) {
    var w = section('Weights on this run', 'change a number and re-judge: it becomes a new run, the old one stays comparable');
    DIMENSION_FORM(w, r);
    body.appendChild(w);

    r.dimensions.forEach(function (dim) {
      var s = section(dim.label + ' · ' + dim.raw + ' points that count for AI Value out of ' + dim.cap + ' → ' + dim.norm + ' → ' + dim.contribution + ' of the AI Value' +
        (dim.workOnly ? ', another ' + dim.workOnly + ' counted as work only' : ''),
        dim.note + (dim.workOnly ? '. The items worth nothing here are the ones the teacher already laid out: more work for the student, nothing an AI could add.' : ''));
      var hits = r.signals.filter(function (sig) { return sig.dim === dim.id; });
      if (!hits.length) s.appendChild(h('div', 'mcx-adb-ok', 'Nothing on this page fed this detector. It contributes 0, and that is not the same as a penalty.'));
      hits.forEach(function (sig) { s.appendChild(signalRow(sig)); });
      body.appendChild(s);
    });

    var pen = section('Negative signals, counted separately', 'these subtract; a detector that found nothing simply adds nothing');
    if (!r.penalties.length) pen.appendChild(h('div', 'mcx-adb-ok', 'No penalty fired.'));
    r.penalties.forEach(function (p) {
      var box = h('div', 'mcx-adb-signal is-minus');
      box.appendChild(h('div', 'mcx-adb-signalRule', p.label + ' · ' + p.points + ' points'));
      box.appendChild(h('div', 'mcx-adb-signalFormula', p.formula));
      (p.evidence || []).forEach(function (ev) {
        box.appendChild(h('div', 'mcx-adb-evidence', (ev.path ? ev.path + ': ' : '') + ev.evidence));
      });
      pen.appendChild(box);
    });
    pen.appendChild(h('div', 'mcx-adb-total', 'Penalties total ' + r.penaltyTotal + ' points, of a floor at ' + (-AN.PENALTY_CAP) + ' the engine will not go past'));
    var bo = r.bonus || { points: 0, count: 0, ids: [] };
    pen.appendChild(h('div', 'mcx-adb-total' + (bo.points ? ' is-plus' : ''), bo.points
      ? 'Multi-max bonus +' + bo.points + ': ' + bo.count + ' dimensions reached their own cap at the same time (' + bo.ids.join(', ') + '). Two do not qualify, three give +4 each up to +12.'
      : 'Multi-max bonus 0: only ' + bo.count + ' dimension(s) reached their cap, this bonus needs three at once.'));
    (r.penaltyChecks || []).forEach(function (c) {
      var row = h('div', 'mcx-adb-check' + (c.fired ? ' is-fired' : ''));
      row.appendChild(h('span', 'mcx-adb-checkFlag', c.fired ? 'subtracted' : 'checked, did not subtract'));
      row.appendChild(h('span', 'mcx-adb-checkLabel', c.label));
      row.appendChild(h('span', 'mcx-adb-checkWhy', c.why));
      pen.appendChild(row);
    });
    body.appendChild(pen);

    var f = section('The arithmetic, in one line each');
    f.appendChild(h('div', 'mcx-adb-formula', 'AI Value = ' + r.formulas.value));
    f.appendChild(h('div', 'mcx-adb-formula', 'Complexity = ' + r.formulas.complexity));
    f.appendChild(h('div', 'mcx-adb-formula', 'Readiness = ' + r.formulas.readiness));
    body.appendChild(f);

    var detail = section('Every check that went into Readiness', 'loss is weight-points missing; only a closable loss of 8 or more can veto');
    r.readiness.items.forEach(function (it) {
      var row = h('div', 'mcx-adb-kv' + (it.weight === 0 ? ' is-muted' : ''));
      row.appendChild(h('span', 'mcx-adb-k', it.name + (it.weight === 0 ? ' (not counted)' : ' weight ' + it.weight)));
      row.appendChild(h('span', 'mcx-adb-v', pct(it.score) + (it.loss ? ' · losing ' + it.loss + (it.closable ? ', closable' : ', not something we can close') : '') + ' · ' + it.detail + ' · ' + it.why));
      detail.appendChild(row);
    });
    body.appendChild(detail);
  }

  function DIMENSION_FORM(box) {
    AN.DIMENSIONS.forEach(function (d) {
      var row = h('div', 'mcx-adb-weight');
      var inputs = {};
      row.appendChild(h('span', 'mcx-adb-weightName', d.label));
      [['cap', 'cap'], ['value', 'AI Value weight'], ['complexity', 'Complexity weight']].forEach(function (pair) {
        var inp = h('input', 'mcx-adb-weightInput');
        inp.type = 'number';
        inp.min = '0';
        inp.max = pair[0] === 'cap' ? '60' : '60';
        inp.value = String((S.weights && S.weights[d.id] && S.weights[d.id][pair[0]] != null) ? S.weights[d.id][pair[0]] : d[pair[0]]);
        inp.setAttribute('aria-label', d.label + ' ' + pair[1]);
        inputs[pair[0]] = inp;
        row.appendChild(h('span', 'mcx-adb-weightLabel', pair[1]));
        row.appendChild(inp);
      });
      row.appendChild(btn('Apply', 'mcx-adb-quiet', function () {
        var next = S.weights ? JSON.parse(JSON.stringify(S.weights)) : {};
        next[d.id] = { cap: Number(inputs.cap.value), value: Number(inputs.value.value), complexity: Number(inputs.complexity.value) };
        S.weights = next;
        try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(next)); } catch (e) {}
        rejudge('re-judged with changed weights on ' + d.label);
      }));
      box.appendChild(row);
    });
    var footRow = h('div', 'mcx-adb-weightFoot');
    footRow.appendChild(btn('Reset weights to the built-in ones', 'mcx-adb-quiet', function () {
      S.weights = null;
      try { localStorage.removeItem(WEIGHTS_KEY); } catch (e) {}
      rejudge('weights reset to built-in');
    }));
    if (S.weights) footRow.appendChild(h('span', 'mcx-adb-note', 'this run uses stored overrides for: ' + Object.keys(S.weights).join(', ')));
    box.appendChild(footRow);
  }

  function signalRow(sig) {
    var box = h('div', 'mcx-adb-signal' + (sig.kind === 'minus' ? ' is-minus' : '') + (sig.kind === 'info' ? ' is-info' : ''));
    var head = h('div', 'mcx-adb-signalRule');
    head.appendChild(h('span', 'mcx-adb-signalPoints', sig.kind === 'info' ? '0' : (sig.points > 0 ? '+' : '') + sig.points));
    head.appendChild(h('span', null, sig.rule));
    box.appendChild(head);
    box.appendChild(h('div', 'mcx-adb-signalPath', 'from: ' + sig.path +
      (sig.kind === 'info' ? ' · a note, worth nothing either way' : '') +
      (sig.axis === 'work' ? ' · counted as work only, it adds nothing to the AI Value' : '')));
    if (sig.evidence) box.appendChild(h('div', 'mcx-adb-evidence', 'on the page: ' + sig.evidence));
    else if (sig.kind !== 'info') box.appendChild(h('div', 'mcx-adb-evidence is-field', 'no page text behind this one, it came from a Canvas field named above'));
    return box;
  }

  /* ---- 决策 ---- */

  function renderDecision(body, r) {
    var s = section('The gates, in the order they are walked', 'the first gate that fires decides, later gates are not reached');
    r.decision.ladder.forEach(function (step, i) {
      var box = h('div', 'mcx-adb-gate' + (step.hit ? ' is-fired' : ''));
      box.appendChild(h('div', 'mcx-adb-gateNum', 'gate ' + (i + 1)));
      box.appendChild(h('div', 'mcx-adb-gateTitle', step.gate));
      box.appendChild(h('div', 'mcx-adb-gateTest', 'comparison: ' + step.test));
      box.appendChild(h('div', 'mcx-adb-gateHit', step.hit ? 'this gate fired' : 'passed through, no decision made here'));
      s.appendChild(box);
    });
    body.appendChild(s);

    var th = section('Thresholds in force');
    Object.keys(r.thresholds).forEach(function (k) {
      th.appendChild(kv(k, r.thresholds[k]));
    });
    body.appendChild(th);

    var m = section('How far the numbers are from flipping', 'every distance is a non-negative count of points, and it says which way');
    m.appendChild(kv('up to Optional', r.decision.margins.upToOptional + ' points (from ' + r.aiValue + ' to ' + r.thresholds.skipBelow + ')'));
    m.appendChild(kv('up to Recommended', r.decision.margins.upToRecommended + ' points (to ' + r.thresholds.optionalBelow + ')'));
    m.appendChild(kv('down to Optional', r.decision.margins.downToOptional + ' points below ' + r.thresholds.optionalBelow));
    m.appendChild(kv('down to Skip', r.decision.margins.downToSkip + ' points below ' + r.thresholds.skipBelow));
    m.appendChild(kv('readiness margin', r.decision.margins.readinessMargin + ' (Readiness ' + r.readiness.score + ' against ' + r.thresholds.readinessMin + ')'));
    m.appendChild(h('div', 'mcx-adb-note', r.decision.flip));
    body.appendChild(m);

    var why = section('Why this decision, in words');
    why.appendChild(h('div', 'mcx-adb-reason', r.decision.reason));
    body.appendChild(why);

    /* 个人门槛那一层：原始 AI Value 一个数没动，这里只看得见"这条线现在画在哪"。
       正式卡片用的是同一颗 recommend()，所以这一屏说的和学生看到的不可能打架 */
    if (root.MCxAssignBaseline) {
      var B = root.MCxAssignBaseline;
      var st = B.status();
      var rec = B.recommend(r, st);
      var pb = section('Personal recommendation bar', 'the raw AI Value above is unchanged; this layer only splits Optional from Recommended');
      pb.appendChild(kv('raw AI Value', r.aiValue + ' (the same number the engine used)'));
      pb.appendChild(kv('engine band', r.decision.kind + ' at the fixed ' + r.thresholds.optionalBelow));
      pb.appendChild(kv('your band', rec.kind + ' at your threshold ' + rec.threshold));
      pb.appendChild(kv('samples', st.count + ' assignments in the newest ' + st.window + (st.enough ? '' : ', under the ' + st.minSamples + ' needed to calibrate, so ' + B.CONFIG.defaultThreshold + ' is used')));
      pb.appendChild(kv('their values', st.values.length ? st.values.join(', ') : 'none yet'));
      pb.appendChild(kv('P80 → target', st.p80 == null ? 'not computed' : st.p80 + ' → ' + st.rawTarget + ' → stored ' + (st.adaptive == null ? 'n/a' : st.adaptive)));
      pb.appendChild(kv('mode / manual', st.mode + (st.manual == null ? '' : ' (manual ' + st.manual + ' wins, sensitivity ignored)')));
      pb.appendChild(h('div', 'mcx-adb-note', 'this page was added to the spread: ' + (S.baselineAdded ? 'yes' : 'no, ' + (S.baselineWhy || 'not recorded on this run'))));
      body.appendChild(pb);

      var gb = section('What the student-facing card did with this', 'the same gates, in the order the card walks them');
      rec.gates.forEach(function (g) {
        var row = h('div', 'mcx-adb-check' + (g.pass ? ' is-fired' : ''));
        row.appendChild(h('span', 'mcx-adb-checkFlag', g.pass ? 'yes' : 'no'));
        row.appendChild(h('span', 'mcx-adb-checkLabel', g.label));
        row.appendChild(h('span', 'mcx-adb-checkWhy', g.detail + (g.canLower ? ' (this is the one your threshold moves)' : ' (a threshold can never move this one)')));
        gb.appendChild(row);
      });
      gb.appendChild(h('div', 'mcx-adb-note', 'auto-write on this page: ' + (rec.auto ? 'yes' : 'no, blocked by ' + (rec.blockedBy.length ? rec.blockedBy.join(' + ') : 'nothing, it simply was not worth it'))));
      var G = root.MCxAssignGuide;
      if (!G) {
        gb.appendChild(h('div', 'mcx-adb-warn', 'The student card layer never loaded on this page, so nothing below can be reported.'));
      } else {
        var gs = G.state;
        gb.appendChild(kv('card mounted', gs.card && gs.card.isConnected ? 'yes' : 'no'));
        gb.appendChild(kv('where it sits', gs.anchor || 'no anchor was chosen'));
        gb.appendChild(kv('guide summary', gs.jobs && gs.jobs.guide.parsed ? (gs.jobs.guide.from === 'cache' ? 'reused from cache' : 'written by the model') : 'none on screen'));
        gb.appendChild(kv('verdict cache', gs.cacheHit ? 'hit, the stored fingerprint matched' : 'miss'));
        var anyRun = gs.jobs && ['guide', 'explain', 'plan'].filter(function (m) { return gs.jobs[m].running || gs.jobs[m].notice; });
        gb.appendChild(kv('AI calls from the card', anyRun && anyRun.length ? anyRun.join(', ') : 'none'));
      }
      body.appendChild(gb);
    }

    var note = section('What this window does not do', 'so a wrong judgement here can be read as a wrong judgement, not a hidden step');
    ['The debug window itself never calls a model. The student card may, only when your own bar, the Readiness gate and the auto switch all say yes.',
      'Attachments are read only when their Read button is pressed, so Readiness can legitimately be short.',
      'A 403 is reported as unreadable, never as absent.',
      'The verdict cache stores only the fingerprint and the three numbers. The raw page is always re-read.'
    ].forEach(function (line) { note.appendChild(h('div', 'mcx-adb-ok', line)); });
    body.appendChild(note);
  }

  /* ---- AI 试跑 ---- */

  function renderAI(body, r) {
    var ai = S.ai;
    var built = buildPrompt(r);
    ai.prompt = built.text;

    var head = section('What would be sent', built.notes.join(' · '));
    var pills = h('div', 'mcx-adb-slots');
    (root.MCxAi ? root.MCxAi.slots() : []).forEach(function (slot) {
      var p = h('button', 'mcx-adb-slot' + (ai.slot === slot.id ? ' is-on' : '') + (slot.filled ? '' : ' is-empty'), slot.name + (slot.filled ? '' : ' (not set up)'));
      p.type = 'button';
      p.title = slot.use || '';
      p.addEventListener('click', function () { ai.slot = slot.id; draw(); });
      pills.appendChild(p);
    });
    head.appendChild(pills);
    var cfg = root.MCxAi ? root.MCxAi.config(ai.slot) : null;
    if (cfg) {
      head.appendChild(kv('Endpoint', cfg.base));
      head.appendChild(kv('Model on that slot', cfg.model));
      head.appendChild(kv('Credential', cfg.key ? 'set, never shown here' : 'not set on this slot'));
    }
    head.appendChild(kv('Request size', built.chars + ' characters · roughly ' + (root.MCxData ? root.MCxData.estimateTokens(built.chars) : Math.round(built.chars / 3.6)) + ' tokens'));
    var showBtn = btn(ai.showPrompt ? 'Hide the prompt' : 'Show the exact prompt', 'mcx-adb-quiet', function () { ai.showPrompt = !ai.showPrompt; draw(); });
    head.appendChild(showBtn);
    if (ai.showPrompt) head.appendChild(dump('prompt', ai.prompt, 20000));
    body.appendChild(head);

    var run = section('Run it', 'this spends your own credit, so the estimate above is on the button');
    var est = root.MCxData ? root.MCxData.estimateTokens(built.chars) : Math.round(built.chars / 3.6);
    if (!ai.running) {
      run.appendChild(btn('Send this assignment to the model (about ' + est + ' tokens)', 'mcx-adb-go', function () { sendAI(r, built); }));
    } else {
      run.appendChild(btn('Stop', 'mcx-adb-quiet', stopAI));
      run.appendChild(h('span', 'mcx-adb-note', 'answering since ' + Math.round((Date.now() - ai.started) / 1000) + ' s'));
    }
    if (ai.notice) run.appendChild(h('div', 'mcx-adb-error', ai.notice));
    body.appendChild(run);

    if (ai.text || ai.running) {
      var out = section('Answer', ai.usage ? ('usage reported: ' + ai.usage) : 'no usage came back from that endpoint');
      if (ai.lines) {
        ['DELIVERABLE', 'CHECKPOINT', 'GOTCHA', 'STEP', 'OPEN QUESTION'].forEach(function (tag) {
          var list = ai.lines[tag];
          if (!list || !list.length) return;
          out.appendChild(h('div', 'mcx-adb-tagHead', tag + ' · ' + list.length));
          list.forEach(function (line) { out.appendChild(h('div', 'mcx-adb-tagLine', line)); });
        });
        if (ai.lines.other.length) {
          out.appendChild(h('div', 'mcx-adb-tagHead is-other', 'Lines that did not carry a known tag, kept and shown'));
          ai.lines.other.forEach(function (line) { out.appendChild(h('div', 'mcx-adb-tagLine', line)); });
        }
        if (ai.lines.empty) out.appendChild(h('div', 'mcx-adb-warn', 'The model sent no tagged lines at all. That is a prompt problem, not a parsing one.'));
      }
      out.appendChild(h('div', 'mcx-adb-tagHead', 'The reply as it arrived'));
      var host = h('div', 'mcx-adb-out');
      if (root.MCxFormat) root.MCxFormat.render(host, ai.text);
      else host.textContent = ai.text;
      out.appendChild(host);
      body.appendChild(out);
    } else {
      body.appendChild(h('div', 'mcx-adb-empty', 'Nothing has been sent to a model from this window yet.'));
    }
  }

  /* 结构化总结用行前缀而不是 JSON：半截 JSON 数组照样能解析成功，
     症状是"只回了前几条"，比行式更难发现（inbox-ai 那条线已经为此改过一次） */
  function buildPrompt(r) {
    var ctx = r.ctx;
    var notes = [];
    var lines = [];
    lines.push('You are helping a student understand one Canvas assignment before starting it.');
    lines.push('Reply only with short lines. Each line starts with one of these tags and a colon:');
    lines.push('DELIVERABLE: what has to be handed in');
    lines.push('CHECKPOINT: how a part of it gets marks, from the rubric if there is one');
    lines.push('GOTCHA: a requirement that is easy to miss, quote the wording you used in angle brackets');
    lines.push('STEP: a practical order to work in, with a rough time');
    lines.push('OPEN QUESTION: something the page does not actually say');
    lines.push('Rules: no JSON, no markdown bullets, no headings, at most 8 STEP lines, say nothing you cannot point at in the material below.');
    lines.push('If the material says a file or page has to be read and that text is not below, write OPEN QUESTION instead of guessing.');
    lines.push('');
    lines.push('Course id: ' + ctx.courseId + '. Assignment id: ' + ctx.assignmentId + '.');
    lines.push('Title: ' + ctx.title);
    lines.push('Page kind: ' + ctx.kind + '. Our guess at the task type: ' + r.taskType.primary + '.');
    lines.push('Points possible: ' + (ctx.submission.pointsPossible == null ? 'not stated' : ctx.submission.pointsPossible) + '.');
    lines.push('Submission types: ' + (ctx.submission.types.join(', ') || 'not stated') + '.');
    lines.push('Allowed file extensions: ' + (ctx.submission.allowedExtensions.join(', ') || 'not stated') + '.');
    lines.push('Dates: ' + ctx.body.datesNote + '.');
    if (ctx.dates.unlockAt) lines.push('It only opens at ' + ctx.dates.unlockAt + '.');
    if (ctx.dates.lockAt) lines.push('It stops accepting at ' + ctx.dates.lockAt + '.');
    if (ctx.related.quiz) lines.push('Quiz settings: ' + (ctx.related.quiz.questionCount || '?') + ' questions, time limit ' + (ctx.related.quiz.timeLimit || 'none') + ' minutes, attempts ' + (ctx.related.quiz.attempts || 'not stated') + '.');
    if (ctx.related.newQuiz && ctx.related.newQuiz.instructions) lines.push('New Quizzes instructions: ' + ctx.related.newQuiz.instructions.slice(0, 1500));
    if (ctx.related.discussion && ctx.related.discussion.text) lines.push('Discussion prompt: ' + ctx.related.discussion.text.slice(0, 2000));

    if (ctx.rubric.status === 'available') {
      lines.push('');
      lines.push('Rubric (' + ctx.rubric.criteria.length + ' criteria' + (ctx.rubric.usedForGrading ? ', used for the grade' : ', shown but not used for the grade') + '):');
      ctx.rubric.criteria.forEach(function (c) {
        lines.push('- ' + c.title + (c.points ? ' [' + c.points + ' points]' : '') + (c.details ? ': ' + c.details : ''));
        (c.ratings || []).forEach(function (rt) {
          if (rt.long_description || rt.description) lines.push('    · ' + (rt.description || '') + (rt.points != null ? ' (' + rt.points + ')' : '') + (rt.long_description ? ': ' + rt.long_description : ''));
        });
      });
    } else if (ctx.rubric.status === 'unavailable') {
      lines.push('');
      lines.push('A rubric is attached but its text could not be read (' + ctx.rubric.why + '). Put that in an OPEN QUESTION line.');
    }

    lines.push('');
    lines.push('Files named on the page:');
    if (ctx.resources.files.length) {
      ctx.resources.files.forEach(function (f) {
        lines.push('- ' + (f.name || f.id) + ' [' + statusText(f) + ']');
        if (f.text) lines.push('    text: ' + f.text.slice(0, 2500));
      });
    } else lines.push('- none');
    lines.push('Links leaving Canvas: ' + (ctx.resources.external.map(function (l) { return l.name; }).join(', ') || 'none') + '. Their contents were not read.');
    var pages = ctx.related.pageRefs || [];
    if (pages.length) {
      lines.push('Other course pages referenced:');
      pages.forEach(function (p) {
        lines.push('- ' + (p.label || p.pageUrl) + ' [' + statusText(p) + ']');
        if (p.text) lines.push('    text: ' + p.text.slice(0, 2500));
      });
    }

    var body = String(ctx.body.text || '');
    var cap = 9000;
    if (body.length > cap) {
      notes.push('description cut from ' + body.length + ' to ' + cap + ' characters');
      body = body.slice(0, cap);
    }
    lines.push('');
    lines.push('The assignment description as the student reads it:');
    lines.push('"""');
    lines.push(body || '(empty)');
    lines.push('"""');
    lines.push('');
    lines.push('The local detector scored this page ' + r.aiValue + ' out of 100 for AI Value and ' + r.readiness.score + ' for how much of it we can see, and decided ' + r.decision.kind + '. Its strongest reasons were: ' +
      r.signals.slice(0, 4).map(function (s) { return s.rule; }).join(' / '));

    var text = lines.join('\n');
    return { text: text, chars: text.length, notes: notes.length ? notes : ['nothing was cut from the description'] };
  }

  function sendAI(r, built) {
    var ai = S.ai;
    if (!root.MCxAi) { ai.notice = 'AI is not available on this page. Reload and try again.'; draw(); return; }
    var cfg = root.MCxAi.config(ai.slot);
    var cloud = !!(cfg && (cfg.isCloud || (root.MCxAi.isCloudMode && root.MCxAi.isCloudMode())));
    if (cloud && root.MCxAi.isUserLoggedIn && !root.MCxAi.isUserLoggedIn() && !cfg.key) {
      ai.notice = 'Sign in under AI & Plans, then try again.';
      draw();
      return;
    }
    if (!cfg.key && !cloud) {
      ai.notice = 'This model has no API key. Add one in AI Settings, then try again.';
      draw();
      return;
    }
    ai.running = true;
    ai.text = '';
    ai.lines = null;
    ai.usage = null;
    ai.notice = '';
    ai.started = Date.now();
    ai.controller = new AbortController();
    var gen = S.gen;
    draw();

    function alive() { return gen === S.gen; }

    root.MCxAi.send({
      profile: ai.slot,
      feature: 'Assignment breakdown',
      model: cfg.model,
      messages: [{ role: 'user', content: built.text }],
      signal: ai.controller.signal,
      onDelta: function (piece) {
        if (!alive()) return;
        ai.text += piece;
        paintStream();
      },
      onStatus: function (msg) { if (alive()) { ai.notice = msg; draw(); } },
      onUsage: function (u) { if (alive()) ai.usage = u ? (u.prompt + ' in, ' + u.completion + ' out') : null; }
    }).then(function (full) {
      if (!alive()) return;
      ai.running = false;
      if (full && !ai.text) ai.text = String(full);
      ai.lines = parseTags(ai.text);
      ai.controller = null;
      draw();
    }, function (err) {
      if (!alive()) return;
      ai.running = false;
      ai.controller = null;
      var d = root.MCxAi.describeError(err, cfg);
      ai.notice = d.code === 'abort' ? '' : d.text;
      if (ai.text) ai.lines = parseTags(ai.text);
      draw();
    });
  }

  function stopAI() {
    var ai = S.ai;
    if (ai.controller) { try { ai.controller.abort(); } catch (e) {} }
    ai.running = false;
    if (ai.text) ai.lines = parseTags(ai.text);
    draw();
  }

  /* 一套标签两边共用：正式卡片问出来的 PLAIN / OK / MISS 也走这同一颗解析器，
     不然后来改一次词表就得在两处各改一遍，症状是"调试窗口解析得出、卡片解析不出" */
  var TAG_RE = /^(DELIVERABLE|CHECKPOINT|GOTCHA|STEP|OPEN QUESTION|PLAIN|OK|MISS)\s*[:\-–]\s*(.+)$/i;
  var TAG_KEYS = ['DELIVERABLE', 'CHECKPOINT', 'GOTCHA', 'STEP', 'OPEN QUESTION', 'PLAIN', 'OK', 'MISS'];

  function parseTags(text) {
    var out = { other: [], empty: true };
    TAG_KEYS.forEach(function (k) { out[k] = []; });
    String(text || '').split('\n').forEach(function (line) {
      var t = line.replace(/^[\s>\-*•]+/, '').trim();
      if (!t) return;
      out.empty = false;
      var m = TAG_RE.exec(t);
      if (m) out[m[1].toUpperCase()].push(m[2]);
      else out.other.push(t);
    });
    return out;
  }

  function paintStream() {
    /* 字永远进 ai.text；不在 AI 那一档时不重建画面，切回来 draw() 会画全。
       每 140ms 重建整座面板就是他把"帧内脚本风暴"报过的那件事 */
    if (!S.open || S.tab !== 'ai') return;
    var host = panel.querySelector('.mcx-adb-out');
    if (!host) { draw(); return; }
    if (root.MCxFormat) root.MCxFormat.render(host, S.ai.text);
    else host.textContent = S.ai.text;
  }

  /* ==== 启动：地址变了就重来，同一页里老师改字不会变地址 ==== */

  var lastHref = '';

  /* 入口暂时收起：默认不挂药丸，代码原样留着。
     放出来还是控制台那句 ModernCanvasAssignmentDebug.enable()，不用改文件 */
  /* 这座调试仪表也算 AI 入口（里面那颗能直接向模型发一问），所以总开关排在它自己那颗前面。
     开关一翻下去，boot 下一轮走到 "if (!enabled()) { teardown(); return; }" 自己把药丸和窗口摘掉，
     不碰 ENABLE_KEY：他原来在控制台里开过没开过，翻回来时还是那个样子 */
  function enabled() {
    try { return (!window.mcAiOn || window.mcAiOn()) && localStorage.getItem(ENABLE_KEY) === 'on'; } catch (e) { return false; }
  }

  /* 关掉的是这座窗口本身：药丸和面板一起摘，页面留给 Canvas */
  function teardown() {
    if (S.ai && S.ai.controller) { try { S.ai.controller.abort(); } catch (e) {} }
    S.gen++;
    if (panel) { panel.remove(); panel = null; }
    if (pill) { pill.remove(); pill = null; }
    S.mounted = false;
    S.open = false;
    lastHref = '';
  }

  function boot() {
    DATA = root.MCxAssignData;
    AN = root.MCxAnalyze;
    if (!DATA || !AN) return;
    if (!enabled()) { teardown(); return; }
    var target = DATA.currentTarget();
    if (!target) {
      if (panel || pill) teardown();
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      /* 上一页的读数、上一页的流字都不许落到这一页的屏上 */
      S.gen++;
      if (S.ai && S.ai.controller) { try { S.ai.controller.abort(); } catch (e) {} }
      S.target = target;
      S.runs = [];
      S.runIndex = -1;
      S.collected = null;
      S.submission = null;
      S.siblings = null;
      S.error = '';
      S.ai = { text: '', lines: null, running: false, notice: '', slot: S.ai.slot || 'advanced', showPrompt: false, usage: null, controller: null, started: 0, prompt: '' };
      try { S.weights = JSON.parse(localStorage.getItem(WEIGHTS_KEY) || 'null'); } catch (e) { S.weights = null; }
      mount();
      analyze(false, 'page opened');
    }
  }

  function startWatch() {
    boot();
    /* Canvas 是同页应用：换作业不一定刷新页面。pushState 不发事件，所以站点自己的
       popstate／hashchange 挂上即时接，800ms 那一趟只是比对地址、不是重活 */
    var tick = function () { boot(); };
    window.addEventListener('popstate', tick);
    window.addEventListener('hashchange', tick);
    setInterval(tick, 800);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWatch);
  else startWatch();

  root.MCxAssignDebug = {
    state: S,
    open: function () { mount(); setOpen(true); },
    close: function () { setOpen(false); },
    analyze: analyze,
    boot: boot,
    /* 窗口里那颗"Stop showing"是关的那一头，这一头只能在控制台：
       它是调试仪表，不该在设置面板里占一行 */
    enable: function () {
      try { localStorage.setItem(ENABLE_KEY, 'on'); } catch (e) {}
      boot();
      mount();
      setOpen(true);
      return 'the pill is back on this page';
    },
    disable: function () {
      try { localStorage.setItem(ENABLE_KEY, 'off'); } catch (e) {}
      teardown();
      return 'window and pill removed';
    },
    /* 这两颗本来只在渲染那一趟内部用。导出来只为本机断言能直接喂一句回包验解析、
       验发出去的原文里到底有什么，不是给页面别处调的 */
    parseTags: parseTags,
    buildPrompt: buildPrompt
  };
  root.ModernCanvasAssignmentDebug = root.MCxAssignDebug;
})(typeof window !== 'undefined' ? window : this);
