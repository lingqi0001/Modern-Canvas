/* =========================================================
   本地这一层筛子：把已选、已读出的课件切成片段，按考点挑，再拼成发给模型的那一份。

   为什么要有这一份文件：
   - 原先 materialsBlock() 是照资料顺序一路拼到 TOTAL_CAP 就砍，
     勾选一多，排在后面的整份讲义一个字都进不去，而屏幕上报的却是"材料超了上限被截短"。
   - 标题模糊的那一份（"Chapter 4.pdf"、"讲义 3.docx"）在按标题筛的那一头永远排不上号，
     可它的正文里正好写着考纲要的那一条。这里改成按正文片段判，标题只当次要线索。
   - 学生看得见的是模型写的那段总结，看不见"哪些考点根本没有材料撑着"。
     所以这一份还要产出 coverage，让面板能老实说"这一条在所给材料里没找到依据"。

   三条边界（和案头上别的批评一起立在这里）：
   - 全程在这台电脑里跑：不联网、不建库、不装东西，只碰学生自己勾了并且已经读正文的那些资料。
   - 只挑片段，不改权限：读不出来的、学生没勾的，一律不进这里。
   - 这一份出错绝不能拖垮原流程：调用方包着 try/catch，出错就退回按顺序拼那一条老路。
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
  /* ==== 可调的几个数 ==== */
  var MIN_CHARS = 800;        // 一块至少这么大，否则只剩孤立句子
  var MAX_CHARS = 1800;       // 一块至多这么大
  var OVERLAP = 140;          // 相邻两块重叠一点，跨块的定义不会被腰斩
  var STRONG_HITS = 3;        // 考点命中到这个分以上才算"有材料撑着"
  var WEAK_HITS = 1;
  var CONCEPT_CAP = 12;
  var EVIDENCE_CHARS = 280;   // 展开那一条时给看的原文摘录上限

  /* 停用词表。study-panel.js 里那张是正本（按标题筛那一条先写的），
     它一加载就把它塞进来（useStopWords），这里这份只是它不在时的退路 */
  var STOP = {
    the: 1, and: 1, with: 1, from: 1, that: 1, this: 1, your: 1, have: 1, will: 1, they: 1, them: 1,
    what: 1, when: 1, where: 1, which: 1, who: 1, how: 1, many: 1, more: 1, most: 1, using: 1, use: 1,
    chapter: 1, section: 1, unit: 1, week: 1, quiz: 1, test: 1, exam: 1, assignment: 1, homework: 1,
    class: 1, course: 1, date: 1, page: 1, file: 1, part: 1, all: 1, any: 1, for: 1, not: 1, can: 1,
    was: 1, were: 1, has: 1, had: 1, are: 1, its: 1, you: 1, our: 1, into: 1, over: 1, after: 1,
    before: 1, then: 1, than: 1, been: 1, would: 1, should: 1, could: 1, there: 1,
    here: 1, those: 1, these: 1, very: 1, much: 1, make: 1, made: 1, take: 1, show: 1, each: 1,
    other: 1, some: 1, such: 1, only: 1, also: 1, both: 1, between: 1, about: 1, across: 1
  };

  /* 中文单字虚词：含它的二字组几乎都不是考点（"的时""为在"） */
  var CJK_STOP = {};
  '的了和与及或在是我为吗呢吧啊很就都还不把被给让从对以之等这那些其一二又也要能有会去可以如但更最'
    .split('').forEach(function (c) { CJK_STOP[c] = 1; });

  /* 结构信号：这一块像不像"要背的东西"。定义、公式、例题、小标题旁边留着才有用，
     孤零零一句"we will see this later"没有价值 */
  var SIGNALS = [
    { re: /(^|\n)[ \t]*(#{1,6}[ \t]|chapter\b|unit\b|section\b|lesson\b|topic\b|outline\b|summary\b|key terms?\b|objectives?\b|review\b)/gi, v: 3 },
    { re: /(^|\n)[ \t]*(definition|theorem|lemma|formula|equation|example|worked example|exercise|problem|note|proof)\b/gi, v: 3 },
    { re: /例题|例\d|定义|定理|公式|概念|要点|考点|习题|证明|小结|本章/g, v: 3 },
    { re: /[=≈≤≥≠±×÷∑∏√∞→θλμΩ]|\\frac|\\sum|_\{|\^\{/g, v: 2 },
    { re: /\bdenote[sd]?\b|\bis defined as\b|\bmeans that\b|\bwe have\b|\bgiven that\b|\brearrang/gi, v: 2 },
    { re: /即\b|等于|称为|定义为|记作|可得|代入|单位|表示/g, v: 2 },
    { re: /\b\d+(?:\.\d+)?\s*(?:%|m\/s|kg|ms|s\b|j\b|n\b|w\b|mol|k\b|c\b|v\b|a\b|m\b)/gi, v: 1 }
  ];

  // 标签正本：整份资料 R3，块级 R3-C2
  var TAG_RE = /^\[?R(\d{1,3})(?:-C(\d{1,3}))?\]?$/;

  function useStopWords(obj) {
    if (obj && typeof obj === 'object') STOP = obj;
  }

  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  /* ==== 关键词 ==== */
  /* 和 study-panel.js 那份逐字同规则：拉丁词长度 ≥4 且不在停用词表，中文两个两个地给。
     面板那份现在是调这里，所以这张表只有一套口径 */
  function keywords(text) {
    var out = [];
    String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).forEach(function (run) {
      if (!run) return;
      if (/^[\u4e00-\u9fff]+$/.test(run)) {
        for (var i = 0; i + 2 <= run.length && i < 24; i++) out.push(run.slice(i, i + 2));
        return;
      }
      if (run.length >= 4 && !STOP[run]) out.push(run);
    });
    return out;
  }

  // 词频，findEvidence 与概念打分都用它
  function termCounts(text) {
    var map = {};
    keywords(text).forEach(function (k) { map[k] = (map[k] || 0) + 1; });
    return map;
  }

  /* 一个词在一段文字里出现几次（indexOf 走一遍，够用且不用建索引） */
  function countOf(hay, term) {
    if (!term) return 0;
    var n = 0, at = 0;
    while ((at = hay.indexOf(term, at)) >= 0) {
      n++;
      at += term.length;
      if (n >= 4) break;   // 出现四次和十次对"这一块有没有讲它"没区别
    }
    return n;
  }

  /* ==== 考点候选 ==== */
  function latinPhrases(text, push) {
    var clean = String(text).toLowerCase().replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ');
    var words = trim(clean).split(' ');
    for (var i = 0; i < words.length; i++) {
      var run = [];
      for (var j = i; j < words.length && run.length < 3; j++) {
        var w = words[j].replace(/['\-]+$/, '');
        // 停用词那里断掉：不把 "of"、"through" 这种填充词缝进考点名里
        if (w.length < 4 || STOP[w] || /^\d+$/.test(w)) break;
        run.push(w);
        push(run.slice(), run.length);
      }
    }
  }

  function cjkPhrases(text, push) {
    var runs = String(text).match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      for (var i = 0; i < run.length - 1 && i < 40; i++) {
        var two = run.slice(i, i + 2);
        if (!CJK_STOP[two.charAt(0)] && !CJK_STOP[two.charAt(1)]) push(two, 2);
        if (i + 3 <= run.length) {
          var three = run.slice(i, i + 3);
          if (!CJK_STOP[three.charAt(0)] && !CJK_STOP[three.charAt(2)]) push(three, 3);
        }
      }
    }
  }

  /* 考纲那一段里我们自己写进去的那句样板要摘掉。
     不摘的话 "What it says on Canvas (the quiz questions themselves are not visible to students)"
     这一句会被抽成 says、canvas、questions 那种假考点，屏幕上就成排地挂噪声行 */
  var BOILERPLATE = [
    /what it says on canvas[^\n]*/gi,
    /the quiz questions themselves[^\n]*/gi,
    /no text came out of these[^\n]*/gi
  ];

  /* 从考纲那一段里提出最多 12 个考点。
     任务名那一行最值钱（权重 3），老师写的说明其次，形状括注（a quiz, 20 points）先摘掉，
     因为它报的是这一项长什么样，不是要考什么 */
  function concepts(scopeText, options) {
    var cap = (options && options.max) || CONCEPT_CAP;
    var lines = String(scopeText || '').split('\n');
    var bag = {};

    function add(words, weight) {
      var name = words.join(' ');
      if (!name) return;
      var hit = bag[name];
      if (!hit) hit = bag[name] = { name: name, words: words, score: 0 };
      hit.score += weight * (words.length >= 2 ? 2 : 1);
    }

    function feed(text, weight) {
      latinPhrases(text, function (words) {
        add(words, weight);
      });
      cjkPhrases(text, function (name, len) {
        add([name], weight * (len >= 3 ? 2 : 1));
      });
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = trim(raw);
      if (!line) continue;
      var isTitle = /^-\s+/.test(line);
      var body = line.replace(/^-\s+/, '').replace(/^[*>]\s*/, '');
      // "(a quiz, 20 points, 5 questions)" 与 ", due Oct 12" 是形状和日期，不是考点
      body = body.replace(/\([^)]*\)/g, ' ').replace(/,\s*due\s+[^,;]*/i, ' ')
        .replace(/\[already submitted\]/i, ' ');
      for (var b = 0; b < BOILERPLATE.length; b++) body = body.replace(BOILERPLATE[b], ' ');
      var indented = /^\s{2,}/.test(raw);
      var weight = isTitle ? 3 : (indented ? 2 : 1);
      feed(trim(body), weight);
    }

    /* 同一句头的那几条只留最像考点的那一条：
       "impulse" / "impulse collisions" 这类叠着的行会把整格占满，而它们说的是同一件事。
       分数接近时偏向长的那一条，因为长的更具体。 */
    var byHead = {};
    Object.keys(bag).forEach(function (k) {
      var c = bag[k];
      c.rank = c.score * (1 + 0.2 * (c.words.length - 1));
      var head = c.words[0];
      if (!byHead[head] || byHead[head].rank < c.rank) byHead[head] = c;
    });

    var list = Object.keys(byHead).map(function (k) { return byHead[k]; });
    list.sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (b.name.length !== a.name.length) return b.name.length - a.name.length;
      return a.name < b.name ? -1 : 1;
    });

    var out = [];
    list.forEach(function (c) {
      if (out.length >= cap) return;
      // 整串词已经被收进去的那一条盖住的，就不再单列一行
      for (var i = 0; i < out.length; i++) {
        var mine = c.words, theirs = out[i].words;
        var inside = mine.length <= theirs.length;
        var outer = mine.length > theirs.length;
        var a = inside ? mine : theirs, b = inside ? theirs : mine;
        var all = a.every(function (w) { return b.indexOf(w) >= 0; });
        if (!all) continue;
        // 短的已经在里面了：长的更具体就换掉短的，否则这条不收
        if (outer && c.score >= out[i].score * 0.6) {
          out[i] = {
            name: c.name,
            words: c.words,
            terms: [{ k: c.name, v: c.name.indexOf(' ') > 0 ? 3 : 2 }]
              .concat(c.name.indexOf(' ') > 0 ? c.words.map(function (w) { return { k: w, v: 1 }; }) : []),
            score: c.score
          };
          return;
        }
        if (inside) return;
      }
      out.push({
        name: c.name,
        // 上面那一圈去重要读 words，这一份里必须带上，否则第二条候选一来就抛
        words: c.words,
        // 整条短语命中最值钱；单词命中只算"沾边"，够不上"有材料撑着"
        terms: [{ k: c.name, v: c.name.indexOf(' ') > 0 ? 3 : 2 }]
          .concat(c.name.indexOf(' ') > 0 ? c.words.map(function (w) { return { k: w, v: 1 }; }) : []),
        score: c.score
      });
    });
    return out;
  }

  /* ==== 切块 ==== */
  /* 边界优先级：分页符 → 空行 → 换行 → 句末标点 → 词边界。绝不在字或数字中间硬切，
     真要硬切的是那种一整段没有标点的外链正文，那也切在空格或逗号上。 */
  var SENT_END_CJK = '。！？；';
  var SENT_END_LATIN = '.!?;';
  var TRAIL_CH = '”’)]）》';
  var SOFT_STOP = '，,、)》"';

  function sentenceUnits(src, from, to, max) {
    var units = [];
    var start = from;
    var i = from;
    while (i < to) {
      var ch = src.charAt(i);
      var cut = -1;
      if (SENT_END_CJK.indexOf(ch) >= 0) {
        cut = i + 1;
      } else if (SENT_END_LATIN.indexOf(ch) >= 0) {
        var prev = i > from ? src.charAt(i - 1) : '';
        var nextc = i + 1 < to ? src.charAt(i + 1) : '';
        // "3.14"、"e.g."、"U.S." 里那个点不是句子尾巴：前面是数字或后面紧着单词就放过
        if (ch === '.' && (/\d/.test(prev) || (nextc && nextc !== ' ' && nextc !== '\n'))) {
          i++;
          continue;
        }
        if (ch === ';' && /\d/.test(prev)) { i++; continue; }
        cut = i + 1;
      }
      if (cut < 0) { i++; continue; }
      // 尾巴上的引号括号一起归这一句；紧跟的一个空格也算进去
      while (cut < to && TRAIL_CH.indexOf(src.charAt(cut)) >= 0) cut++;
      if (cut < to && src.charAt(cut) === ' ') cut++;
      units = units.concat(fit(src, start, cut, max));
      start = cut;
      i = cut;
    }
    units = units.concat(fit(src, start, to, max));
    return units;

    // 一段超过上限就再退一档：换行 → 软标点 → 空格 → 才按字符
    function fit(s, a, b, lim) {
      if (b - a <= lim) return b > a ? [{ s: a, e: b }] : [];
      var out = [];
      var seg = a;
      for (var k = a; k < b; k++) {
        if (s.charAt(k) === '\n') {
          out = out.concat(soft(s, seg, k + 1, lim));
          seg = k + 1;
        }
      }
      out = out.concat(soft(s, seg, b, lim));
      return out;
    }

    function soft(s, a, b, lim) {
      if (b - a <= lim) return b > a ? [{ s: a, e: b }] : [];
      var out = [];
      var seg = a;
      for (var k = a; k < b; k++) {
        if (SOFT_STOP.indexOf(s.charAt(k)) >= 0 && k + 1 - seg > lim * 0.5) {
          out.push({ s: seg, e: k + 1 });
          seg = k + 1;
        }
      }
      return out.concat(hard(s, seg, b, lim));
    }

    function hard(s, a, b, lim) {
      if (b - a <= lim) return b > a ? [{ s: a, e: b }] : [];
      var out = [];
      var seg = a;
      while (seg < b) {
        var next = Math.min(seg + lim, b);
        if (next < b) {
          // 往回找空格，宁可少切一点也不把单词劈开
          var back = s.lastIndexOf(' ', next);
          if (back > seg && next - back < lim * 0.35) next = back;
        }
        out.push({ s: seg, e: next });
        seg = next;
      }
      return out;
    }
  }

  /* 把正文切成单位：先按分页/空行成段，太长的段再切句。
     小标题（短、不以标点收尾的一行）并进后面那一段，标题和它下面的说明不能分家 */
  function buildUnits(src, max) {
    var blocks = src.split('\f');
    var offset = 0;
    var units = [];
    blocks.forEach(function (block) {
      var base = offset;
      offset += block.length + 1;   // +1 是分页符那一个字符
      var paras = [];
      var at = 0;
      block.replace(/\n{2,}/g, function (m, idx) {
        paras.push([at, idx]);
        at = idx + m.length;
        return m;
      });
      paras.push([at, block.length]);
      // 单行里也可能长到没边（一整面墙），先按换行粗切
      paras = paras.filter(function (p) { return p[1] > p[0]; });
      var pending = null;   // 待并的小标题
      paras.forEach(function (p) {
        var s = base + p[0], e = base + p[1];
        var body = src.slice(s, e);
        if (!trim(body)) return;
        if (body.length <= max) {
          var isHeading = body.length < 90 && !/[。！？!?;.\uFF1F\uFF01]$/.test(trim(body))
            && (body.indexOf('\n') < 0 || body.split('\n').length <= 2);
          if (isHeading) {
            if (pending) { units.push({ s: pending.s, e: e }); pending = null; }
            else pending = { s: s, e: e };
            return;
          }
          if (pending) { units.push({ s: pending.s, e: e }); pending = null; }
          else units.push({ s: s, e: e });
          return;
        }
        if (pending) { units.push({ s: pending.s, e: s }); pending = null; }
        sentenceUnits(src, s, e, max).forEach(function (u) { units.push(u); });
      });
      if (pending) units.push(pending);
    });
    return units.filter(function (u) { return u.e > u.s; });
  }

  function chunkText(text, options) {
    var o = options || {};
    var min = o.minChars || MIN_CHARS;
    var max = o.maxChars || MAX_CHARS;
    var lap = o.overlap == null ? OVERLAP : o.overlap;
    var src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (!trim(src)) return [];
    var units = buildUnits(src, max);
    if (!units.length) return [];

    var out = [];
    var i = 0;
    while (i < units.length) {
      var j = i;
      while (j + 1 < units.length && units[j + 1].e - units[i].s <= max) j++;
      // 凑不够 min 就把下一单元吞进来，宁可略超一点也不要留一条小尾巴
      if (units[j].e - units[i].s < min && j + 1 < units.length) j++;
      var body = trim(src.slice(units[i].s, units[j].e));
      if (body) {
        out.push({
          index: out.length + 1, tag: 'C' + (out.length + 1),
          start: units[i].s, end: units[j].e, text: body, len: body.length
        });
      }
      var advance = j + 1;
      var next = advance;
      if (lap > 0 && j > i && advance < units.length) {
        var b = j;
        while (b > i && units[b].s > units[advance - 1].e - lap) b--;
        if (b > i) next = b;
      }
      i = next;   // next 一定大于 i，不会空转
    }
    /* 太薄的那一条并进前一格：短块既不值一个标签，也会让预算被头部行吃光。
       整份只有这一小段的时候留着，读得出二十几个字的课件也是材料 */
    var packed = [];
    out.forEach(function (c) {
      var prev = packed[packed.length - 1];
      if (prev && (c.len < 200 || prev.len < 200) && prev.len + c.len <= max * 1.6) {
        prev.text = prev.text + '\n' + c.text;
        prev.len = prev.text.length;
        prev.end = c.end;
        return;
      }
      packed.push(c);
    });
    packed.forEach(function (c, n) {
      c.index = n + 1;
      c.tag = 'C' + (n + 1);
    });
    return packed;
  }

  /* ==== 索引 ==== */
  function indexResource(resource, readResult, options) {
    var o = options || {};
    var r = resource || {};
    var v = readResult || {};
    var text = String(v.text || '');
    var chunks = chunkText(text, o);
    var words = {};
    keywords((r.title || '') + ' ' + (r.module || '')).forEach(function (k) { words[k] = 1; });
    return {
      resourceId: r.id,
      title: v.name || r.title || '(untitled)',
      module: r.module || '',
      kind: r.kind || v.kind || '',
      url: r.url || '',
      totalChars: text.length,
      text: text,
      chunks: chunks,
      keywords: Object.keys(words)
    };
  }

  /* 一批资料的索引。量大就一趟趟让出主线程，否则读十几份 PDF 时整个抽屉会僵住。
     items 是 [{resource, read}]；onProgress(done, total) 用来报"索引到第几条"。 */
  function buildIndexes(items, options) {
    var o = options || {};
    var list = items || [];
    var total = 0;
    list.forEach(function (it) { total += String((it && it.read && it.read.text) || '').length; });
    var batched = list.length > (o.yieldAfterItems || 25) || total > (o.yieldAfterChars || 80000);
    var idle = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback : null;

    function nextTick(fn) {
      if (idle) idle(fn, { timeout: 600 });
      else setTimeout(fn, 0);
    }

    return new Promise(function (resolve, reject) {
      var out = [];
      var i = 0;
      var since = Date.now();

      function step() {
        try {
          if (o.dead && o.dead()) { resolve(out); return; }
          var guard = 0;
          while (i < list.length && (!batched || guard++ < 8 || Date.now() - since < 6)) {
            var it = list[i];
            out.push(indexResource(it.resource, it.read, o));
            i++;
            if (batched && Date.now() - since > 24) { since = Date.now(); nextTick(step); return; }
          }
          if (o.onProgress) o.onProgress(i, list.length);
          if (i < list.length) { since = Date.now(); nextTick(step); return; }
          resolve(out);
        } catch (e) {
          reject(e);
        }
      }
      step();
    });
  }

  /* ==== 打分 ==== */
  /* anchor 收的是 { resourceIndex, anchorIndex }（考纲那条在课件清单里的位置），
     也接受光秃秃一个数字表示 anchorIndex，调用方少写一层不容易错 */
  function scoreChunk(chunk, conceptList, taskWords, anchor) {
    var hay = String(chunk.text || '').toLowerCase();
    var hits = {};
    var conceptScore = 0;
    (conceptList || []).forEach(function (c) {
      var p = 0;
      (c.terms || [{ k: c.name, v: 2 }]).forEach(function (t) {
        p += countOf(hay, String(t.k).toLowerCase()) * (t.v || 1);
      });
      if (p > 0) { hits[c.name] = p; conceptScore += p; }
    });
    var tw = 0;
    (taskWords || []).forEach(function (entry) {
      if (!entry || !entry.k) return;
      if (hay.indexOf(String(entry.k).toLowerCase()) >= 0) tw += entry.v || 1;
    });
    var sig = 0;
    SIGNALS.forEach(function (s) {
      var m = hay.match(s.re);
      if (m) sig += Math.min(m.length, 4) * s.v;
    });
    var a = typeof anchor === 'number' ? { anchorIndex: anchor } : (anchor || {});
    var prox = 0;
    if (a.anchorIndex >= 0 && a.resourceIndex != null) {
      // 考纲那一条之前的课件才是这一趟的复习范围；隔太远多半是上一单元的旧东西
      prox = a.resourceIndex <= a.anchorIndex ? 2 : -2;
      if (a.anchorIndex - a.resourceIndex > 80) prox -= 2;
    }
    var len = chunk.len || chunk.text.length || 1;
    // 长块要打折，否则一份又长又空的讲义会靠词频把所有名额吃光
    var norm = len > 1500 ? 0.82 : (len < MIN_CHARS * 0.7 ? 0.9 : 1);
    var score = (conceptScore * 2.4 + tw * 0.5 + sig * 0.7 + prox) * norm;
    var best = '', bestV = 0;
    Object.keys(hits).forEach(function (k) { if (hits[k] > bestV) { bestV = hits[k]; best = k; } });
    return {
      score: score, hits: hits, bestConcept: best, bestHits: bestV,
      conceptScore: conceptScore, taskScore: tw, signal: sig
    };
  }

  /* ==== 挑块 ==== */
  /* 三趟：
     1) 每个考点挑它手上得分最高、还没选中的那一块（覆盖优先，先保证考点都有人撑着）
     2) 一块都没被选中的资料，给它得分最高的那一块一次机会（一份长讲义不许垄断名额）
     3) 剩下的预算按总相关性补
     同一份资料的上限（默认 3 块、且不超过预算的 30%）在第 2、3 趟生效；
     要是某个考点只有这一份资料命中，那就必须放行，否则屏幕上得写"没找到依据"——假话。 */
  function selectChunks(indexes, conceptList, options) {
    var o = options || {};
    var budget = Math.max(0, o.budget || 0);
    var headChars = o.headerChars || 90;   // 每块头部那两行标签也算进预算
    var nRes = Math.max(1, (indexes || []).length);
    var concepts = conceptList || [];
    /* 单份资料的名额按预算推算，不写死 3。
       写死 3 的话勾四五份时预算一大半空着（那等于把能送的材料白白扔了），
       勾上百份时又每份都想挤 3 块，最后拼不下的那一批全落空。 */
    var perResParts = o.maxPartsPerResource || Math.max(3,
      Math.min(o.maxPartsCeil || 40, Math.floor(budget / nRes / (MAX_CHARS + headChars))));
    var perResChars = o.perResourceChars || Math.max(6000, Math.floor(budget * (o.perResourceShare || 0.3)));

    var pool = [];
    indexes.forEach(function (ix, ri) {
      (ix.chunks || []).forEach(function (ch, ci) {
        var sc = scoreChunk(ch, concepts, o.taskWords, { resourceIndex: ri, anchorIndex: o.anchorIndex });
        pool.push({
          ri: ri, ci: ci, ix: ix, chunk: ch, score: sc.score, hits: sc.hits,
          cost: ch.len + headChars, used: false
        });
      });
    });

    // 每个考点在哪些资料里有强命中，用来认"唯一命中"
    var soleSource = {};
    var anySource = {};
    concepts.forEach(function (c) {
      var strong = {}, any = {};
      pool.forEach(function (p) {
        var h = p.hits[c.name] || 0;
        if (h >= WEAK_HITS) any[p.ri] = 1;
        if (h >= STRONG_HITS) strong[p.ri] = 1;
      });
      var sk = Object.keys(strong), ak = Object.keys(any);
      soleSource[c.name] = (sk.length === 1 ? Number(sk[0]) : (sk.length ? -1 : (ak.length === 1 ? Number(ak[0]) : -1)));
      anySource[c.name] = ak.length;
    });

    var coverage = concepts.map(function (c) {
      return { name: c.name, status: 'none', parts: [] };
    });

    var used = 0;
    var picked = [];
    var resParts = {};
    var resChars = {};

    function fits(p) {
      return used + p.cost <= budget;
    }
    function capAllows(p, exempt) {
      if (exempt) return true;
      if ((resParts[p.ri] || 0) >= perResParts) return false;
      if ((resChars[p.ri] || 0) + p.cost > perResChars) return false;
      return true;
    }
    function take(p, reason) {
      p.used = true;
      p.reason = reason;
      picked.push(p);
      used += p.cost;
      resParts[p.ri] = (resParts[p.ri] || 0) + 1;
      resChars[p.ri] = (resChars[p.ri] || 0) + p.cost;
    }

    var byScore = pool.slice().sort(function (a, b) { return b.score - a.score; });

    // 第一趟：覆盖
    concepts.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).forEach(function (c) {
      var strong = byScore.filter(function (p) { return !p.used && (p.hits[c.name] || 0) >= STRONG_HITS; });
      var pool2 = strong.length ? strong : byScore.filter(function (p) { return !p.used && (p.hits[c.name] || 0) >= WEAK_HITS; });
      if (!pool2.length) return;
      var p = pool2[0];
      if (fits(p) && capAllows(p, soleSource[c.name] === p.ri)) take(p, 'concept');
    });

    // 第二趟：每份资料至少一次机会（预算不够时按那一块自己的分排，不靠资料先后）
    var bestOfRes = {};
    byScore.forEach(function (p) { if (!bestOfRes[p.ri]) bestOfRes[p.ri] = p; });
    Object.keys(bestOfRes).map(Number).sort(function (a, b) {
      return bestOfRes[b].score - bestOfRes[a].score;
    }).forEach(function (ri) {
      var p = bestOfRes[ri];
      if (p.used || (resParts[ri] || 0) > 0) return;
      if (p.score <= 0) return;   // 一个词都没踩上的那份不必占名额
      if (fits(p) && capAllows(p, false)) take(p, 'one per item');
    });

    // 第三趟：按总相关性补满
    byScore.forEach(function (p) {
      if (p.used || p.score <= 0) return;
      if (fits(p) && capAllows(p, false)) take(p, 'relevance');
    });

    picked.sort(function (a, b) { return a.ri - b.ri || a.ci - b.ci; });

    /* 覆盖状态在选完之后照选中那一批统一重算：一块常常同时撑好几个考点，
       只在"为哪个考点挑它"那一格里记账会把别的考点误判成没材料。
       Covered ＝ 送出去的那一批里至少有一块强命中；
       Needs checking ＝ 只有弱命中，或者命中过的那一块被预算挤掉了；
       No evidence found ＝ 全部已读正文里都找不到这个词。 */
    coverage.forEach(function (c) {
      var strong = [], weak = [];
      picked.forEach(function (p) {
        var h = p.hits[c.name] || 0;
        var row = { resourceId: p.ix.resourceId, title: p.ix.title, module: p.ix.module, kind: p.ix.kind, url: p.ix.url, tag: p.chunk.tag, hits: h };
        if (h >= STRONG_HITS) strong.push(row);
        else if (h >= WEAK_HITS) weak.push(row);
      });
      if (strong.length) { c.status = 'covered'; c.parts = strong; }
      else if (weak.length) { c.status = 'weak'; c.parts = weak.slice(0, 3); }
      else { c.status = anySource[c.name] > 0 ? 'weak' : 'none'; c.parts = []; }
    });

    var omitted = { parts: 0, chars: 0, byResource: [] };
    var omMap = {};
    pool.forEach(function (p) {
      if (p.used) return;
      omitted.parts++;
      omitted.chars += p.cost;
      var row = omMap[p.ri] || (omMap[p.ri] = {
        resourceId: p.ix.resourceId, title: p.ix.title, module: p.ix.module, parts: 0, chars: 0,
        best: Math.round(p.score)
      });
      row.parts++;
      row.chars += p.cost;
    });
    Object.keys(omMap).forEach(function (k) { omitted.byResource.push(omMap[k]); });

    return {
      chunks: picked.map(function (p) {
        return {
          resourceIndex: p.ri, resourceId: p.ix.resourceId, title: p.ix.title, module: p.ix.module,
          kind: p.ix.kind, url: p.ix.url, chunk: p.chunk, chunkTag: p.chunk.tag,
          score: Math.round(p.score * 10) / 10, hits: p.hits, reason: p.reason, cost: p.cost
        };
      }),
      coverage: coverage,
      omitted: omitted,
      omittedConcepts: coverage.filter(function (c) { return c.status !== 'covered'; }),
      usedChars: used,
      budget: budget
    };
  }

  /* ==== 给 UI 看的短摘录 ==== */
  /* 挑一段"含这个词、又正好是完整几句"的原文，展开那一格用。
     先在句子边界上取窗口，窗口够不到 min 再退回硬窗口，最后再贴一次词边界。 */
  function boundaryList(src) {
    var out = [0];
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (SENT_END_CJK.indexOf(ch) >= 0 || (SENT_END_LATIN.indexOf(ch) >= 0 && ch !== '.')) {
        if (i + 1 < src.length && src.charAt(i + 1) === ' ') i++;
        out.push(i + 1);
      } else if (ch === '\n') out.push(i + 1);
    }
    out.push(src.length);
    return out;
  }

  function windowAround(bounds, cap, hit, srcLen) {
    var start = 0, end = Math.min(srcLen, cap), i;
    for (i = 0; i < bounds.length; i++) {
      if (bounds[i] <= hit) start = bounds[i];
      else break;
    }
    for (i = 0; i < bounds.length; i++) {
      if (bounds[i] > start && bounds[i] - start <= cap) end = bounds[i];
      else if (bounds[i] > start) break;
    }
    if (end - start < cap * 0.4) {
      end = Math.min(srcLen, start + cap);
      if (end - start < cap * 0.4) start = Math.max(0, end - cap);
    }
    return [start, Math.max(end, start + 1)];
  }

  function snapWord(src, a, b) {
    // 硬窗口那一种可能落在词中间：两头各退/进到最近一个空格，退不动就原样
    if (a > 0 && a < src.length && !/\s/.test(src.charAt(a)) && !/\s/.test(src.charAt(a - 1))) {
      var back = src.slice(Math.max(0, a - 24), a).lastIndexOf(' ');
      if (back >= 0) a = a + back + 1;
    }
    if (b < src.length && /\S/.test(src.charAt(b)) && /\S/.test(src.charAt(b - 1))) {
      var fwd = src.slice(b, Math.min(src.length, b + 24)).indexOf(' ');
      if (fwd >= 0) b = b + fwd;
    }
    return [a, Math.max(b, a + 1)];
  }

  function findEvidence(text, queryTerms, maxChars) {
    var raw = String(text == null ? '' : text);
    var src = raw.replace(/\s+/g, ' ');
    var cap = maxChars || EVIDENCE_CHARS;
    var terms = (queryTerms || []).filter(Boolean).map(function (t) { return String(t).toLowerCase(); });
    if (!trim(src)) return { excerpt: '', start: 0, end: 0 };
    if (src.length <= cap) return { excerpt: trim(src), start: 0, end: src.length };

    var hay = src.toLowerCase();
    var bounds = boundaryList(src);
    var best = null;
    terms.forEach(function (t) {
      if (!t) return;
      var at = 0, guard = 0;
      while (guard++ < 40) {
        var found = hay.indexOf(t, at);
        if (found < 0) break;
        var w = windowAround(bounds, cap, found, src.length);
        w = snapWord(src, w[0], w[1]);
        var win = trim(src.slice(w[0], w[1]));
        var lower = win.toLowerCase();
        var score = 0;
        terms.forEach(function (q) { score += countOf(lower, q); });
        // 命中一样多的时候挑短的那一条：展开那一格越长越没人读
        if (!best || score > best.score || (score === best.score && win.length < best.excerpt.length)) {
          best = { score: score, excerpt: win.slice(0, cap), start: w[0], end: w[1] };
        }
        at = found + Math.max(1, t.length);
      }
    });
    if (best && best.score > 0) return best;
    return { excerpt: trim(src.slice(0, cap)), start: 0, end: Math.min(cap, src.length) };
  }

  /* ==== 引用标签核对 ==== */
  /* 只回答一件事：这一条标签能不能映射回我们发出去的那份清单。
     它写的任何"这份材料讲了什么"一概不信，出处表画的是我们自己的数据。 */
  function baseTag(tag) {
    var m = TAG_RE.exec(String(tag == null ? '' : tag).trim());
    return m ? 'R' + m[1] : '';
  }

  function chunkOfTag(tag) {
    var m = TAG_RE.exec(String(tag == null ? '' : tag).trim());
    return m && m[2] ? 'C' + m[2] : '';
  }

  function validateCitations(answer, sources) {
    var src = sources || {};
    var text = String(answer == null ? '' : answer);
    var seen = {};
    var valid = [];
    var invalid = [];
    var occurrences = 0;
    var repeats = 0;
    var re = /\[(R\d{1,3}(?:-C\d{1,3})?)\]/g;
    var m;
    while ((m = re.exec(text))) {
      occurrences++;
      var tag = m[1];
      var base = baseTag(tag);
      var known = !!src[tag] || !!src[base];
      if (!known) {
        if (invalid.indexOf(tag) < 0) invalid.push(tag);
        continue;
      }
      if (seen[tag]) repeats++;
      else { seen[tag] = 1; valid.push(tag); }
    }
    return {
      occurrences: occurrences,
      valid: valid,
      invalid: invalid,
      repeats: repeats,
      anyValid: valid.length > 0,
      chunkUsed: valid.some(function (t) { return !!chunkOfTag(t); })
    };
  }

  window.MCxRetrieval = {
    MIN_CHARS: MIN_CHARS,
    MAX_CHARS: MAX_CHARS,
    STRONG_HITS: STRONG_HITS,
    useStopWords: useStopWords,
    keywords: keywords,
    termCounts: termCounts,
    concepts: concepts,
    chunkText: chunkText,
    indexResource: indexResource,
    buildIndexes: buildIndexes,
    scoreChunk: scoreChunk,
    selectChunks: selectChunks,
    findEvidence: findEvidence,
    validateCitations: validateCitations,
    baseTag: baseTag,
    chunkOfTag: chunkOfTag
  };
})();
