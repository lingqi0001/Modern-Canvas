/* =========================================================
   Assignment 详情页的本地判值引擎。

   这一份只管算，不管取也不不管画：给它一个结构化的 ctx（assignment-data.js 造的那份），
   它回一套"每个数都能追溯到原文证据"的分数。之所以拆成纯函数，是为了能在 Node 里
   直接喂假数据跑断言（Temp/assign-analyze-test.js），调算法时不用开浏览器。

   三条口径是从 2026-10-12 那份方案里定下来的，别在改代码时悄悄改掉：
   - 正向加分和负向扣分分开列，扣分不是"少加分"，它必须单独看得见。
   - 判读性（Readiness）排在价值判断前面：核心要求在没读到的附件里时，
     不许拿一份残缺摘要冒充完整结果。
   - 每一个结论都要带回退理由：403 是"读不到"，不是"没有"。
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

  var VERSION = 'mc-analyze-1';

  /* ==== 阈值与权重：调试窗口里那屏可以直接改这些数重跑，所以集中放这一处 ==== */

  var THRESHOLDS = {
    skipBelow: 25,        // AI Value 低于这颗 = 不值得整理
    optionalBelow: 50,    // 介于两档 = 摆着但不催
    readinessMin: 55,     // 低于这颗且缺口是"必读的东西没读到"= need_content
    bodyReadyChars: 250,  // 正文读到这么多字算读满
    trivialChars: 120     // 整份要求不到这么多字，又没有别的可读来源 = 判值直接扣分
  };

  /* 一颗维度给 AI Value 和给 Complexity 的权重是两条独立的路：
     "作业本身很难"和"AI 能帮上多少忙"不是一回事（例：一份写得清清楚楚的五步实验，
     Complexity 高，AI Value 低）。两边各自加起来都是 100，所以那个数就是百分比。 */
  var DIMENSIONS = [
    { id: 'parts', label: 'Several distinct parts', cap: 14, value: 11, complexity: 20,
      note: 'Separate tasks the student has to keep track of.' },
    { id: 'deliverable', label: 'Deliverables and formats', cap: 12, value: 12, complexity: 14,
      note: 'What has to be handed in, in how many pieces, in which format.' },
    { id: 'constraint', label: 'Rules and limits', cap: 14, value: 12, complexity: 13,
      note: 'Must / must not, word and page limits, citation style, late policy.' },
    { id: 'rubric', label: 'Grading sheet depth', cap: 16, value: 24, complexity: 8,
      note: 'Rubric criteria and the wording hidden inside each rating.' },
    { id: 'dependency', label: 'Order and prerequisites', cap: 10, value: 12, complexity: 18,
      note: 'Steps that have to happen before other steps.' },
    { id: 'volume', label: 'How much there is to get through', cap: 16, value: 18, complexity: 20,
      note: 'How much text, how many tables, links and files sit on this page.' },
    { id: 'ambiguity', label: 'Unclear or missing', cap: 10, value: 11, complexity: 7,
      note: 'Vague wording, requirements pointed at something we cannot read.' }
  ];

  var PENALTY_CAP = 40;   // 负向最多抵掉这么多分

  /* ==== 词表：命中哪一条就在证据里点名哪一条 ==== */

  var RE = {
    numbering: /^\s*[\(]?([0-9]{1,2}|[a-z]|[ivx]{1,5})[\.\)、:]\s+/i,
    labelled: /^\s*(?:[0-9]{1,2}[\.\)、]\s*)?\*\*?[^:]{2,48}\*\*?\s*[:\-–—]/,
    partLabel: /\b(?:parts?|sections?|tasks?|questions?|phases?|stages?|steps?)\s+[0-9a-iv]{1,5}\b/i,
    imperative: /^(write|include|submit|upload|create|build|analys[ei]z?[e]|record|calculate|compute|draw|answer|read|watch|complete|research|compare|describe|explain|list|show|solve|prove|design|attach|post|reply|comment|take|review|prepare|present|document|identify|evaluate|summariz|summaris|cite|label|graph|measure|collect|interview|visit|install|run|test|debug|reflect|choose|draft|revise|edit|convert|derive|estimate|match|mark|annotate|photograph|sketch|outline|translate)\b/i,
    modal: /\b(must|mandatory|required|requires|require[sd]|shall|do not|don't|cannot|can't|no\s+more\s+than|at\s+least|only|need\s+to|have\s+to|ensur\w+|make\s+sure|should|is\s+expected)\b/i,
    numericLimit: /\b\d+\s*(?:-\s*\d+\s*)?(?:words?|word\s+count|pages?|paragraphs?|slides?|screenshots?|sources?|references?|examples?|questions?|attempts?|minutes?|hours?|days?|items?|figures?|tables?|photos?|videos?|links?)\b/i,
    citation: /\b(apa|mla|chicago|ieee|harvard|vancouver|csab|citation|citations|bibliography|works\s+cited|reference\s+list|footnotes?|in‑text|in-text)\b/i,
    formatSpec: /\b(font|times\s+new\s+roman|arial|calibri|double[\s-]*spaced|single[\s-]*spaced|1\.5[\s-]*spaced|margins?|cover\s+page|title\s+page|header|footer|page\s+numbers?|12\s*pt|11\s*pt|\.pdf|\.docx?|\.zip|\.pptx?|\.xlsx?|\.csv|\.ipynb|\.jpg|\.png|\.mp4|pdf|docx?|xlsx?|pptx?|zip\s+file|word\s+document|excel|powerpoint|handwritten|typed|scanned|bound|stapled?|narrative\s+format|lab\s+report\s+format)\b/i,
    fileAction: /\b(submit|upload|turn[\s-]*in|attach\w*|hand\s+in|drop\s+(?:it\s+)?here|file\s+submission|browse\s+and\s+choose)\b/i,
    artifact: /\b(reports?|essays?|papers?|reflections?|journals?|diaries|presentations?|slides?|videos?|audio|recordings?|podcasts?|posters?|diagrams?|charts?|graphs?|maps?|models?|prototypes?|code|programs?|scripts?|notebooks?|worksheets?|summaries?|annotations?|portfolios?|blogs?|threads?|posts?|repl(?:y|ies)|responses?|comments?|datasets?|spreadsheets?|tables?|proposals?|drafts?|outlines?|handwriting|documents?)\b/i,
    /* 'phase' 和 'stage' 光秃秃出现时多半是内容词（expansion phase、peak phase），
       只有带编号或名字时才是顺序词。2026-10-12 那页被五个 phase 白加了 4 分。 */
    sequence: /\b(before|after|first|second|then|next|finally|once\s+you|prior\s+to|following|subsequent|in\s+order|proceed|week\s*\d+|part\s+[ab1-4]|(?:stage|phase)\s+(?:\d+[a-z]?|[A-Z][a-z]+))\b/i,
    prereq: /\b(complete\s+\w{2,30}\s+before|must\s+(?:have\s+)?(?:finish(?:ed)?|complet\w+|read|watch|submit\w*)|before\s+you\b|before\s+(?:answering|starting|posting)|unlock\w*|prerequisites?|require[sd]?\s+before|wait\s+for|approval|feedback\s+(?:from|before))\b/i,
    vague: /\b(etc\.?|and\s+so\s+on|as\s+discussed|we\s+(?:covered|talked|did)|as\s+we\s+said\s+in\s+class|on\s+the\s+board|from\s+(?:the\s+)?(?:lecture|slides|handout)|your\s+choice|any\s+topic|anything|up\s+to\s+you|as\s+you\s+(?:like|prefer|wish)|if\s+you\s+want|optionally|creativity|your\s+own|be\s+creative|interpretation|relevant|appropriate|as\s+needed|similar)\b/i,
    latePolicy: /\b(late|no\s+late|late\s+work|extension|grace\s+period|penalt\w+|deduct\w+|zero(?:es)?\s+(?:out|the)|missed\s+deadline)\b/i,
    grouping: /\b(individual|pairs?|group(?:s|work)?|teams?|partners?|classmates?|peers?|peer\s+(?:review|grading))\b/i,
    integrity: /\b(plagiarism|academic\s+integrity|cheating|original\s+work|contract\s+cheating|ai[-\s]+generated|artificial\s+intelligence\s+tools|turnitin|similarity\s+report|generative\s+ai)\b/i,
    externalPoint: /\b(see|read|watch|open|refer\s+to|go\s+to|use)\b[^.]{0,60}\b(page|file|document|pdf|video|link|drive|slides|handout|attachment|chapter|website|worksheet)\b/i,
    questionImperative: /\b(answer\s+(?:all|every|the following)|respond\s+to)\b/i,
    /* 散文式说明里没有列表，"要做几件事"只能从动词认。这颗是 detectParts 那条
       "几件不同的事"的唯一非列表来源，所以它必须独立列证据，不能并进列表那颗 */
    askVerb: /\b(write|includ\w+|submit|upload|creat\w+|build|analys\w+|record|calculat\w+|comput\w+|draw|answer\w*|read|watch|complet\w+|research|compar\w+|describe|explai?n|solv\w+|prov\w+|design|attach\w*|post|repl(?:y|ies)|comment|review|prepare|present|document|identify|evaluat\w+|summariz\w+|summaris\w+|cite|label|measur\w+|collect|interview|install|run|reflect|choos\w+|draft|revis\w+|edit|annotat\w+|sketch|outlin\w+|translat\w+)\b/gi
  };

  /* 学校通稿：这些句子每份作业都长一样，读它没有信息量。
     更重要的一条在下面 analyze 里：被判成通稿的那一段，里面的 must / rule 不许再去喂约束检测器，
     否则一份全是免责声明的作业会被判成"要求很多" */
  var BOILERPLATE = [
    { re: /\bacademic\s+integrity\s+(?:policy|statement|pledge)\b/i, why: 'the school-wide academic integrity statement' },
    { re: /\bdisability\s+services?\b|\bspecial\s+(?:educational\s+)?needs?\b|\baccommodat\w+\s+(?:services|office|needs)/i, why: 'the accommodation notice every assignment repeats' },
    { re: /\bplagiarism\s+will\s+(?:result|lead|mean)\b/i, why: 'a canned plagiarism warning' },
    { re: /\bin\s+accordance\s+with\b.{0,80}\b(district|school|board|university|policy)\b/i, why: 'a policy reference clause' },
    { re: /\bwriting\s+(?:center|commons)\b|\btutoring\s+(?:center|lab)\b/i, why: 'a campus service plug' },
    { re: /\bcourse\s+(?:syllabus|policies)\b.{0,40}\bsee\b|\bsee\s+the\s+(?:course\s+)?syllabus\s+for\b/i, why: 'a pointer back to the syllabus' },
    { re: /canvas\.instructure\.com\/courses\/\d+\/pages\/[a-z0-9_-]*(?:syllabus|polic|integrity|guide)/i, why: 'a link to a standing course page' },
    { re: /\b(?:need|have)\s+(?:help|questions)\??\s*(?:visit|contact|reach|email|message)\b/i, why: 'a standing "where to get help" line' },
    { re: /\bthis\s+(?:assignment|activity|task)\s+was\s+(?:generated|created|posted)\s+by\b/i, why: 'an attribution line' }
  ];

  /* 作业类型先验：只是给模型的一句提示，也用来解释"为什么这份值/不值" */
  var TYPE_PRIORS = [
    { type: 'lab report', re: /\b(lab\s+report|experiment|hypothesis|data\s+table|raw\s+data|procedure|observations?|scientific\s+method|error\s+(?:bars|analysis))\b/i },
    { type: 'essay or paper', re: /\b(essay|paper|thesis|argument|thesis\s+statement|word\s+count|source[s]?\s+(?:and|with)|cite)/i },
    { type: 'problem set', re: /\b(problem\s+set|calculate|solve|show\s+your\s+work|equation|derive|answers?\s+(?:only|must)|quiz\s+questions?)/i },
    { type: 'coding task', re: /\b(code|program|script|function|compile|github|repository|\.py|\.java|\.ipynb|unit\s+test|debug|repo\s+link)\b/i },
    { type: 'discussion post', re: /\b(discussion|reply|respond\s+to|peer|thread|initial\s+post)\b/i },
    { type: 'project or portfolio', re: /\b(project|portfolio|proposal|milestone|deliverable[s]?|phase\s+\d|team)\b/i },
    { type: 'reading or viewing', re: /\b(read\s+chapter|readings?|watch|video|lecture|annotat|summary\s+of)\b/i },
    { type: 'exam or quiz', re: /\b(exam|final|midterm|timed|attempts?|question\s+count|multiple\s+choice|closed[-\s]book)\b/i },
    { type: 'presentation', re: /\b(presentation|slides?|record\w*\s+your|present\s+to|speaking)\b/i }
  ];

  /* ==== 小工具 ==== */

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function countWords(text) {
    var t = String(text || '').trim();
    if (!t) return 0;
    var m = t.match(/[A-Za-zÀ-ÿ0-9_'’\-]+/g);
    return m ? m.length : 0;
  }

  /* 把命中位置前后各取一点，凑成能对着页面读的一句证据；同时给偏移，
     方便回原文里找（数据层拼 units 时带了 path，这里再带上第几颗字符） */
  function around(text, index, radius) {
    var s = String(text || '');
    var rad = radius || 44;
    var from = Math.max(0, index - rad);
    var to = Math.min(s.length, index + rad);
    var out = s.slice(from, to).replace(/\s+/g, ' ').trim();
    return (from > 0 ? '…' : '') + out + (to < s.length ? '…' : '');
  }

  function escHit(re, text) {
    var m = re.exec(text);
    return m ? { text: m[0], index: m.index } : null;
  }

  function allMatches(re, text) {
    var out = [];
    if (!text) return out;
    var flags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';
    var rx = new RegExp(re.source, flags);
    var m;
    var guard = 0;
    while ((m = rx.exec(text)) !== null && guard++ < 400) {
      out.push({ text: m[0], index: m.index });
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
    return out;
  }

  /* axis：这条证据算进哪本账。
     'both' 两边都算；'work' 只算 Complexity（活儿确实多），不算 AI Value。
     2026-10-12 他拿三份真作业对出来的方向性错误：老师自己把要求编成 1 到 10 的清单，
     旧写法把它当成"要求很多"给 AI Value 加分，可清单本身就是拆好的结果，
     AI 再拆一遍是零增益。这类信号从此只算工作量。 */
  function signal(dims, dim, rule, points, ctxText, index, path, kind, axis) {
    dims.push({
      dim: dim,
      rule: rule,
      points: points,
      kind: kind || 'plus',
      axis: axis || 'both',
      path: path || 'whole description',
      /* index 小于 0 是"这条来自 Canvas 的字段，页面上没有对应的字"。
         这时候宁可留空也不许从正文头部截一句充数，那是一条假证据 */
      evidence: (index == null || index < 0) ? '' : around(ctxText, index),
      matched: (index == null || index < 0) ? '' : (String(ctxText || '').slice(index, index + 40) || '')
    });
  }

  function unitTexts(units) {
    return (units || []).map(function (u) { return u.text; }).join('\n');
  }

  function firstListText(ctx) {
    var lists = (ctx.structure && ctx.structure.lists) || [];
    return lists.length && lists[0].items.length ? lists[0].items[0].text : '';
  }

  /* 表格那条证据要指回第一格文字在正文里的位置。数据层算的偏移是"洗掉通稿之前"那份文本的，
     少几段之后数字会挪位，所以这里一律在引擎自己的文本上现找 */
  function firstCellIndex(ctx, text) {
    var units = ctx.units || [];
    for (var i = 0; i < units.length; i++) {
      if (units[i].kind === 'cell' && !units[i].boilerplate) return findIn(text, units[i].text);
    }
    return -1;
  }

  /* 证据的下标必须在"洗掉通稿之后"的那份文本里现找：数据层给的是整页拼出来的偏移，
     少了几段之后那个数会指到别的话上去，摆出来的证据就成了假证据 */
  function findIn(text, needle) {
    if (!needle) return -1;
    return String(text || '').indexOf(String(needle).slice(0, 24));
  }

  /* ==== 通稿清洗：句子级，不是段落级 ====
     2026-10-12 外部审查复现出的一条真 bug：老师把"周五 18:00 前交"和整段学术诚信声明写在同一个
     <p> 里，按整段丢弃会把真要求一起抹掉。所以现在按句子切，只摘匹配上通稿的那几句，
     其余留在正文里继续参与判值；被摘掉的每句都在 Structure 那一档看得见。 */
  /* 数句子。先把开头的编号摘掉："1. What Country did you pick?" 是一句，
     不是两句 —— 旧写法把 "1." 那个点当句号，十条清单全被判成"多句"，
     于是"每条都很重"的判据在老师列好的清单上假响。 */
  var ENUM_HEAD = /^\(?(?:\d{1,2}|[a-z]{1,3}|[ivxlcdm]{1,5})[.)、]\s+/i;
  var WORDY = /[a-zÀ-ÿ]{3,}/i;

  function splitSentences(text) {
    var body = String(text || '').replace(ENUM_HEAD, '');
    var parts = body.match(/[^.!?。！？]+[.!?。！？]?/g) || [];
    return parts.map(function (s) { return s.trim(); }).filter(function (s) { return s && WORDY.test(s); });
  }

  function boilerReason(sentence) {
    for (var i = 0; i < BOILERPLATE.length; i++) {
      if (BOILERPLATE[i].re.test(sentence)) return BOILERPLATE[i].why;
    }
    return '';
  }

  /* 不动传进来的 ctx：analyze 会被同一份 ctx 反复调（改权重重判），就地改会第二次洗不干净 */
  function markBoilerplate(units) {
    return (units || []).map(function (src) {
      var u = Object.assign({}, src);
      var sentences = splitSentences(u.text);
      var kept = [];
      var cut = [];
      sentences.forEach(function (s) {
        var why = boilerReason(s);
        if (why) cut.push({ text: s, why: why });
        else kept.push(s);
      });
      u.boilerCut = cut;
      if (cut.length && !kept.length) {
        u.boilerplate = cut[0].why;
        u.text = '';
      } else if (cut.length) {
        /* 段落里混着写的：保留下来的那句继续算正文，摘掉的那句单独报 */
        u.text = kept.join(' ').replace(/\s+/g, ' ').trim();
      }
      return u;
    });
  }

  /* 逐字重复。程序判不了"意思重复"，所以这里只认"同一句长话原样出现两次"：
     门槛 90 个字符（短句子像 "Part I" 这种一条一项的标签最容易撞车），
     比对时保留数字，封顶 −4。2026-10-12 他指的那条就是这个：以前 45 字符起算、
     抹掉标点，一条 8 分说扣就扣。 */
  function findRepeats(units) {
    var seen = {};
    var out = [];
    (units || []).forEach(function (u) {
      var key = String(u.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (key.length < 90) return;
      if (seen[key]) { seen[key].count++; seen[key].paths.push(u.path); }
      else seen[key] = { text: u.text, count: 1, paths: [u.path] };
    });
    Object.keys(seen).forEach(function (k) {
      if (seen[k].count > 1) out.push(seen[k]);
    });
    return out;
  }

  /* ==== 一颗维度的账：把该维度的 signal 点数加起来，按 cap 归一 ==== */

  function tally(signals, dimId) {
    var raw = 0;
    var valueRaw = 0;
    var hits = [];
    signals.forEach(function (s) {
      if (s.dim !== dimId) return;
      raw += s.points;
      /* axis 'work' 的信号只进 Complexity 那本账：活儿确实多了，但 AI 帮不上新的忙 */
      if (s.axis !== 'work') valueRaw += s.points;
      hits.push(s);
    });
    return { raw: raw, valueRaw: valueRaw, hits: hits };
  }

  /* ==== 七颗正向维度各自的检测器 ==== */

  /* 一条列表项是不是"自己已经带小标题"：DOMParser 把 <strong> 拆成了 bold 字段，
     所以三种写法都要认——粗体前缀、"Word: 正文"、还有 "Step 3: 正文" 这种词加号码 */
  function itemLabelled(item) {
    var t = String((item && item.text) || '').trim();
    if (/^\(?\d{1,2}[.\)、]?\s*[A-Z][A-Za-z0-9 '&\-]{2,32}\s*[:\-–]\s+\S/.test(t)) return true;
    if (/^[A-Za-z]{3,10}\s*\d{1,2}\s*[:\-–]\s+\S/.test(t)) return true;
    if (item && item.bold && item.bold.length >= 3) {
      var b = String(item.bold).trim();
      if (t.indexOf(b) === 0) return true;
    }
    return false;
  }

  /* 散文里"要做几件事"必须数到跨句的动词。
     "Read and answer questions 1–10" 是一件事的两个动词，写在同一句里就不该算两段活 */
  function proseAskSentences(text) {
    var sentences = splitSentences(text);
    var hits = [];
    sentences.forEach(function (s, i) {
      var verbs = {};
      allMatches(RE.askVerb, s).forEach(function (v) { verbs[v.text.toLowerCase()] = 1; });
      var names = Object.keys(verbs);
      /* 一句里两个连动动词是同一件事；只有各自动了不同句子的才算多件事 */
      if (names.length) hits.push({ index: i, verbs: names, at: text.indexOf(s) });
    });
    var distinct = {};
    hits.forEach(function (h) { h.verbs.forEach(function (v) { if (!distinct[v]) distinct[v] = h; }); });
    var ownSentences = {};
    Object.keys(distinct).forEach(function (v) { ownSentences[distinct[v].index] = 1; });
    var spread = Object.keys(ownSentences).length;
    return {
      sentences: hits.length, distinctVerbs: Object.keys(distinct).length,
      names: Object.keys(distinct), spread: spread, first: hits.length ? hits[0] : null
    };
  }

  /* 一条列表项里塞了多少东西：字数、句子数、套着的小项。
     2026-10-12 他给的判据：老师列 10 条、每条 15 到 30 字，那不用 AI 拆；
     两条之间就要写 50 字以上、或者一条里还套着小要求，那才真需要有人把它摊开。
     所以这里量的是"每条多重"，不是"有几条"。 */
  function listDensity(list) {
    var items = (list && list.items) || [];
    var out = { items: items.length, words: 0, avgWords: 0, maxWords: 0, sentences: 0, multiSentence: 0,
      withSubs: 0, heavySubs: 0, lightSubs: 0, subItems: 0, subAvgWords: 0, densest: null, densestAt: 0, heavy: false };
    if (!items.length) return out;
    var base = 0;
    var subWordsAll = 0;
    items.forEach(function (it) {
      /* 父项自己那句话才是"这条要求有多重"，套着的小列表另数一档。
         数据层把两者分开放在 own 和 subs / subWords 里；混在一起数，
         一条带着五个六词小问句的要求会被当成 68 词的重项。 */
      var own = (it.own == null || it.own === '') ? String(it.text || '') : String(it.own);
      var w = countWords(own);
      var s = splitSentences(own).length;
      out.words += w;
      out.sentences += s;
      if (w > out.maxWords) { out.maxWords = w; out.densest = own; out.densestAt = base; }
      if (s >= 2) out.multiSentence++;
      if (s >= 3) out.tripleSentence = (out.tripleSentence || 0) + 1;
      var subs = it.subs || 0;
      if (subs) {
        out.withSubs++;
        out.subItems += subs;
        subWordsAll += it.subWords || 0;
        /* 平均 20 词以上的子项才叫"里面还套着要求"；五个六词的小问句还是列好了 */
        if ((it.subWords || 0) / subs >= 20) out.heavySubs++; else out.lightSubs++;
      }
      base += own.length + 1;
    });
    out.avgWords = Math.round(out.words / items.length);
    out.subAvgWords = out.subItems ? Math.round(subWordsAll / out.subItems) : 0;
    out.heavy = out.avgWords > 50 || out.heavySubs > 0 || (out.tripleSentence || 0) >= 2;
    out.share = 0;
    return out;
  }

  /* 这条清单占全页多少话：只有"要求基本都以列表形式写出来了"，
     才能说老师列好了。列表只占三成、剩下都是长段落时，段落里那些步骤还没被拆。 */
  function denseListShare(ctx, text) {
    var total = countWords(text) || 1;
    var best = 0;
    ((ctx.structure && ctx.structure.lists) || []).forEach(function (l) {
      var w = 0;
      (l.items || []).forEach(function (it) { w += countWords(it.text); });
      if (w > best) best = w;
    });
    return best / total;
  }

  function detectParts(ctx, units, signals) {
    var lists = ctx.structure.lists || [];
    var headings = ctx.structure.headings || [];
    var text = unitTexts(units);

    var numbered = 0;
    var imperativeItems = 0;
    lists.forEach(function (list) {
      list.items.forEach(function (item) {
        if (RE.numbering.test(item.text) || RE.partLabel.test(item.text)) numbered++;
        if (RE.imperative.test(item.text.replace(RE.numbering, ''))) imperativeItems++;
      });
    });

    if (numbered >= 2) {
      var m = escHit(RE.partLabel, text);
      signal(signals, 'parts', numbered + ' separate numbered or lettered items in the instructions',
        clamp(numbered, 2, 6), text, m ? m.index : findIn(text, firstListText(ctx)),
        'lists in the body', 'plus', 'work');
    }
    if (headings.length >= 2) {
      signal(signals, 'parts', headings.length + ' section headings break the page into parts',
        clamp(headings.length, 2, 5), text, findIn(text, headings[0] && headings[0].text), headings.map(function (h) { return h.text; }).slice(0, 4).join(' / '), 'plus', 'work');
    }
    if (imperativeItems >= 2) {
      var verbUnit = null;
      for (var i = 0; i < lists.length && !verbUnit; i++) {
        for (var j = 0; j < lists[i].items.length; j++) {
          if (RE.imperative.test(lists[i].items[j].text.replace(RE.numbering, ''))) { verbUnit = lists[i].items[j]; break; }
        }
      }
      signal(signals, 'parts', imperativeItems + ' instruction lines open with an action verb (write / include / analyse …)',
        clamp(imperativeItems, 2, 4), verbUnit ? verbUnit.text : text,
        verbUnit ? 0 : -1, verbUnit ? verbUnit.path : 'lists in the body', 'plus', 'work');
    }
    var answerAll = escHit(RE.questionImperative, text);
    if (answerAll) signal(signals, 'parts', 'a block of questions to get through: "' + answerAll.text + '"', 3, text, answerAll.index, 'body text', 'plus', 'work');

    /* 每条多重：这才是该不该叫 AI 的那颗判据 */
    var dense = null, denseList = null;
    lists.forEach(function (l) {
      var d = listDensity(l);
      if (d.items >= 2 && (!dense || d.avgWords > dense.avgWords)) { dense = d; denseList = l; }
    });
    ctx.density = dense || null;
    if (ctx.density) ctx.density.share = Math.round(denseListShare(ctx, text) * 100) / 100;
    if (dense) {
      var heavy = dense.heavy;
      if (heavy) {
        signal(signals, 'parts', 'its ' + dense.items + ' items are heavy, not one-liners: ' + dense.avgWords + ' words on average, the longest is ' + dense.maxWords +
          ' words, ' + dense.multiSentence + ' of them are more than one sentence' + (dense.subItems ? ', ' + dense.subItems + ' sub-item(s) averaging ' + dense.subAvgWords + ' words (' + dense.heavySubs + ' of them 20 words or more)' : '') + (dense.lightSubs ? ', ' + dense.lightSubs + ' list(s) whose sub-items are one-liners' : ''),
          clamp(4 + Math.floor(dense.avgWords / 25) + dense.heavySubs * 2, 4, 8), text, (denseList && denseList.offset != null) ? -1 : -1,
          (denseList && denseList.path) || 'longest list', 'plus', 'both');
        if (dense.densest) signals.push({
          dim: 'parts', rule: 'the heaviest single item, in full', points: 0, kind: 'info', axis: 'both',
          path: (denseList && denseList.path) || 'longest list',
          evidence: dense.densest.slice(0, 220), matched: dense.densest.slice(0, 40)
        });
      }
    }

    /* 没有列表也没有小标题的散文说明：做几件事只能从动词数出来，
       但"Read and answer" 是一件事，必须动词落在不同句子上才算多件事 */
    if (numbered < 2 && headings.length < 2) {
      var asks = proseAskSentences(text);
      if (asks.spread >= 2) {
        var names = asks.names || [];
        signal(signals, 'parts', asks.spread + ' different sentences each ask for their own action (' + names.slice(0, 6).join(', ') + ')',
          clamp(asks.spread, 2, 4), text, asks.first ? asks.first.at : -1, 'body text');
      }
    }
  }

  function detectDeliverable(ctx, units, signals) {
    var text = unitTexts(units);
    var types = ctx.submission.types || [];
    var exts = ctx.submission.allowedExtensions || [];

    if (exts.length) {
      var fs = escHit(RE.formatSpec, text);
      signal(signals, 'deliverable', 'Canvas restricts the upload to ' + exts.length + ' format(s): ' + exts.join(', '),
        clamp(2 + exts.length, 2, 5), text, fs ? fs.index : -1, 'Canvas field allowed_extensions');
    }
    if (types.length > 1) {
      /* Canvas 勾多个提交方式是"任选一种"，不是"要交这么多份"。
         2026-10-12 外部审查复现：旧写法按 types.length 怒加 6 分，把一道最普通的作业判成了多交付物 */
      signal(signals, 'deliverable', 'Canvas accepts any one of ' + types.length + ' submission types (' + types.join(', ') + '), an or choice, not extra work',
        1, text, -1, 'Canvas field submission_types');
    } else if (types.length) {
      signal(signals, 'deliverable', 'the only submission type switched on is ' + types.join(', '), 2, text, -1, 'Canvas field submission_types');
    }

    var format = escHit(RE.formatSpec, text);
    if (format) signal(signals, 'deliverable', 'a format is spelled out in prose: "' + format.text + '"', 3, text, format.index, 'body text');

    var action = escHit(RE.fileAction, text);
    if (action) signal(signals, 'deliverable', 'handing something in is required: "' + action.text + '"', 2, text, action.index, 'body text');

    var artifacts = allMatches(RE.artifact, text);
    var kinds = {};
    artifacts.forEach(function (a) { kinds[a.text.toLowerCase().replace(/s$/, '')] = 1; });
    /* 一句里用逗号和 or 列出来的那几样是"任选一种"，不是一起要交五样。
       2026-10-12 那页 "infographic, presentation, video or Audio recording, or paragraph
       written response" 被数成五种交付物，白加 6 分。跟 submission_types 那颗同一个道理。 */
    var choiceSets = [];
    splitSentences(text).forEach(function (sent) {
      if (!/\bor\b/i.test(sent)) return;
      var seen = {};
      allMatches(RE.artifact, sent).forEach(function (a) { seen[a.text.toLowerCase().replace(/s$/, '')] = 1; });
      var u = Object.keys(seen);
      if (u.length >= 2) choiceSets.push({ words: u, at: text.indexOf(sent) });
    });
    var choiceExtra = 0;
    choiceSets.forEach(function (c) { choiceExtra += c.words.length - 1; });
    var distinct = Object.keys(kinds).length - choiceExtra;
    if (choiceSets.length) {
      signal(signals, 'deliverable', choiceSets[0].words.length + ' formats are offered as an either/or choice (' + choiceSets[0].words.join(', ') + '), not ' + choiceSets[0].words.length + ' things to hand in',
        1, text, choiceSets[0].at, 'body text', 'plus', 'work');
    }
    if (distinct >= 2) {
      signal(signals, 'deliverable', distinct + ' different kinds of output are named (' + Object.keys(kinds).slice(0, 5).join(', ') + ')',
        clamp(2 + distinct, 2, 6), text, artifacts[0].index, 'body text');
    } else if (distinct === 1) {
      signal(signals, 'deliverable', 'one output is named (' + Object.keys(kinds)[0] + ')', 2, text, artifacts[0].index, 'body text');
    }
    var countPhrase = /\b((?:two|three|four|five|both|[2-9])\s+(?:files?|documents?|pieces?|separate|screenshots?|submissions?))\b/i.exec(text);
    if (countPhrase) signal(signals, 'deliverable', 'more than one file may be expected: "' + countPhrase[0] + '"', 3, text, countPhrase.index, 'body text');
  }

  function detectConstraint(ctx, units, signals) {
    var text = unitTexts(units);
    var modals = allMatches(RE.modal, text);
    if (modals.length) {
      signal(signals, 'constraint', modals.length + ' binding words (must / required / at least / do not …)',
        clamp(modals.length, 1, 6), text, modals[0].index, 'body text');
    }
    var limits = allMatches(RE.numericLimit, text);
    if (limits.length) {
      signal(signals, 'constraint', limits.length + ' numeric limit(s), first one: "' + limits[0].text + '"',
        clamp(2 + limits.length, 2, 6), text, limits[0].index, 'body text');
    }
    var cite = escHit(RE.citation, text);
    if (cite) signal(signals, 'constraint', 'a citation style is named: "' + cite.text + '"', 3, text, cite.index, 'body text');
    var group = escHit(RE.grouping, text);
    if (group) signal(signals, 'constraint', 'who works together is specified: "' + group.text + '"', 2, text, group.index, 'body text');
    var late = escHit(RE.latePolicy, text);
    if (late) signal(signals, 'constraint', 'there is a late or penalty rule: "' + late.text + '"', 2, text, late.index, 'body text');
    var integrity = escHit(RE.integrity, text);
    if (integrity) signal(signals, 'constraint', 'originality or AI use is addressed: "' + integrity.text + '"', 2, text, integrity.index, 'body text');
    if (ctx.dates.dueAt) signal(signals, 'constraint', 'a due date is set', 1, '', null, 'Canvas field due_at');
    if (ctx.dates.lockAt) signal(signals, 'constraint', 'it stops accepting work at a set time', 2, '', null, 'Canvas field lock_at');
  }

  /* 评分表有多重：数条目、数每条里几个评分档、数每档写了多少字。
     2026-10-12 他给的那三步，跟清单那把尺子是同一把：正文只有五个小圆点，
     可六行四档、每档三句话的评分表就是要求本体，这时候"老师已经写清楚了"是反话。 */
  function rubricDensity(crit) {
    var out = { criteria: crit.length, boxes: 0, words: 0, avgWords: 0, maxWords: 0, heaviest: '', heavyBoxes: 0, perCriterion: [] };
    crit.forEach(function (c) {
      var own = countWords(c.details || '');
      var boxes = 0, words = own, max = own;
      (c.ratings || []).forEach(function (rt) {
        var t = [rt.description, rt.long_description].filter(Boolean).join('. ');
        var w = countWords(t);
        boxes++;
        words += w;
        if (w > max) max = w;
        if (w > out.maxWords) { out.maxWords = w; out.heaviest = (c.title || 'criterion') + ' / ' + (rt.description || 'rating'); }
        if (w >= 25) out.heavyBoxes++;
      });
      out.boxes += boxes;
      out.words += words;
      out.perCriterion.push({ title: c.title || '', boxes: boxes, words: words, max: max });
    });
    out.avgWords = out.boxes ? Math.round(out.words / out.boxes) : 0;
    out.heavy = out.avgWords > 25 || out.words > 300 || out.heavyBoxes >= 3;
    return out;
  }

  /* 评分标准画在页面表格里、没挂 Canvas rubric 的课很常见（2026-10-12 那页墨西哥时间轴就是）。
     这一颗不看条数，只看表格格子里是不是在写"多少分、多少词、必须有什么"：
     那就是要求本体，只是我们没法像 rubric 那样逐条读它。 */
  var SHEET_CELL = /\b(max|minimum|points?|score|criteria|length\s*\/\s*format|at least|must|no more than|words?\b)\b/i;

  function detectSheetOnPage(ctx, units, signals) {
    if (ctx.rubric.status === 'available') return;
    var cells = (units || []).filter(function (u) { return u.kind === 'cell'; });
    if (cells.length < 6 || !(ctx.structure.tables >= 1)) return;
    var hits = cells.filter(function (u) { return SHEET_CELL.test(u.text); });
    if (hits.length < 4) return;
    signal(signals, 'rubric', 'the grading rules are drawn on the page as a table rather than attached as a Canvas rubric: ' + hits.length + ' of ' + cells.length +
      ' table cells state marks, limits or must-haves',
      clamp(3 + Math.floor(hits.length / 3), 3, 8), unitTexts(units), unitTexts(units).indexOf(hits[0].text), hits[0].path, 'plus', 'both');
  }

  function detectRubric(ctx, units, signals) {
    var r = ctx.rubric;
    if (r.status !== 'available') return;
    var crit = r.criteria || [];
    if (!crit.length) return;
    var text = unitTexts(units);
    signal(signals, 'rubric', crit.length + ' grading criteria attached', clamp(2 + crit.length, 2, 6), text, -1, 'Canvas field rubric', 'plus', 'work');
    if (r.usedForGrading === true) signal(signals, 'rubric', 'Canvas marks the grade with this rubric (use_rubric_for_grading)', 3, text, -1, 'Canvas field use_rubric_for_grading', 'plus', 'work');
    else if (r.usedForGrading === false) signal(signals, 'rubric', 'the rubric is shown but not used for the grade', 1, text, -1, 'Canvas field use_rubric_for_grading');

    var dens = rubricDensity(crit);
    ctx.rubricDensity = dens;
    if (dens.boxes) {
      signal(signals, 'rubric', 'the grading sheet is where the requirement actually is: ' + dens.criteria + ' criteria, ' + dens.boxes +
        ' rating boxes, ' + dens.words + ' words in them (' + dens.avgWords + ' per box, the longest one ' + dens.maxWords + ' words)' +
        (dens.heavyBoxes ? ', ' + dens.heavyBoxes + ' box(es) of them over 25 words' : ''),
        clamp(3 + Math.floor(dens.words / 120) + (dens.heavyBoxes ? 2 : 0), 3, 12), text, -1, 'Canvas field rubric[].ratings', 'plus', 'both');
      if (dens.perCriterion.length) {
        var top = dens.perCriterion.slice().sort(function (a, b) { return b.words - a.words; })[0];
        signals.push({
          dim: 'rubric', rule: 'the heaviest criterion, ' + top.boxes + ' rating box(es) and ' + top.words + ' words',
          points: 0, kind: 'info', axis: 'both', path: 'Canvas field rubric',
          evidence: String(top.title || '').slice(0, 200), matched: String(top.title || '').slice(0, 40)
        });
      }
      /* 评分表比正文还长：这正是"学生读完说明仍然不知道该干什么"的形状，
         2026-10-12 他指的那张 DELA 就是这种，正文 121 词、评分表 711 词。 */
      var bodyWords = countWords(text);
      if (dens.words > bodyWords && dens.words >= 150) {
        signal(signals, 'rubric', 'the grading sheet says more than the instructions do (' + dens.words + ' words against ' + bodyWords + ')',
          clamp(4 + Math.floor((dens.words - bodyWords) / 400), 4, 8), text, -1, 'Canvas field rubric[].ratings', 'plus', 'both');
      }
    }

    /* 真正的金矿在 rating 的长说明里：那里常写着正文没写的条件。
       "常写着"不等于"一定是"：2026-10-12 外部审查复现出假阳性，正文已经写了 APA 7、
       评分表也写了 APA 7，旧写法照样报"这条只出现在评分表里"。
       所以判据换成"评分表里有没有正文一次都没出现过的词"：
       比得上正文的算重复（0 分挂在屏上说明它没被算进来），比不上的才算正文之外的要求。 */
    var bodyWords = wordSet(text);
    var detailChars = 0;
    var hidden = null;
    var repeated = 0;
    crit.forEach(function (c) {
      (c.ratings || []).forEach(function (rating) {
        var long = String(rating.long_description || '');
        detailChars += long.length;
        var novel = wordListOf(long).filter(function (w) { return !bodyWords[w]; });
        if (!novel.length) {
          var hit = RE.modal.exec(long) || RE.numericLimit.exec(long) || RE.citation.exec(long) || RE.formatSpec.exec(long);
          if (hit) repeated++;
          return;
        }
        if (!hidden || novel.length > hidden.novel.length) {
          hidden = { criterion: c.title || '', rating: rating.description || '', text: long, novel: novel.slice(0, 5) };
        }
      });
    });
    if (detailChars > 60) signal(signals, 'rubric', detailChars + ' characters of rating descriptions spell out what full marks need', clamp(2 + Math.floor(detailChars / 180), 2, 5), text, -1, 'Canvas field rubric[].ratings[].long_description', 'plus', 'work');
    if (hidden) {
      signals.push({
        dim: 'rubric',
        rule: 'the rubric asks for wording the instructions never say (' + hidden.novel.map(function (w) { return '"' + w + '"'; }).join(', ') + ')',
        points: 4, kind: 'plus',
        path: 'rubric criterion ' + hidden.criterion + ' / rating ' + hidden.rating,
        evidence: around(hidden.text, hidden.text.toLowerCase().indexOf(String(hidden.novel[0] || '').split(' ')[0])),
        matched: String(hidden.novel[0] || '')
      });
    }
    var thin = crit.filter(function (c) { return !c.details || String(c.details).length < 20; }).length;
    if (thin && thin === crit.length) signal(signals, 'rubric', 'all ' + thin + ' criteria carry no description, the rubric adds nothing readable', 1, text, -1, 'Canvas field rubric');
    /* 比对上正文的那几条不算隐藏要求，但也不能当没看见：0 分挂在这儿，
       他在窗口里能看出"评分表里这条正文已经写过了" */
    if (repeated) signals.push({
      dim: 'rubric', rule: repeated + ' condition(s) in the rubric repeat wording already in the instructions, so they add no value',
      points: 0, kind: 'info', path: 'Canvas field rubric[].ratings[].long_description', evidence: '', matched: ''
    });
  }

  /* 一组"值得比的词"：丢掉停用词和短词，剩下的拿去两边比。
     这是给上面那颗隐藏要求判据用的，不是全文检索。 */
  var STOP = {};
  ('the a an and or of to in for on with your you our we are is be this that it its as at by from has have had will would can could should must do does not no so if then than them they their there here these those what which who whom when where how all any each other more most less least per day days week weeks item items part parts task steps step one two three four five six seven eight nine ten please make sure sure into onto over under about after before student students assignment work').split(' ').forEach(function (w) { STOP[w] = 1; });

  function wordListOf(text) {
    var seen = {};
    var out = [];
    (String(text || '').toLowerCase().match(/[a-z][a-z\-']{4,}/g) || []).forEach(function (w) {
      if (STOP[w] || seen[w]) return;
      seen[w] = 1;
      out.push(w);
    });
    return out;
  }

  function wordSet(text) {
    var out = {};
    wordListOf(text).forEach(function (w) { out[w] = 1; });
    return out;
  }

  function detectDependency(ctx, units, signals) {
    var text = unitTexts(units);
    var pre = escHit(RE.prereq, text);
    if (pre) signal(signals, 'dependency', 'a step has to finish before another: "' + pre.text + '"', 4, text, pre.index, 'body text');
    var seq = allMatches(RE.sequence, text);
    if (seq.length >= 2) signal(signals, 'dependency', seq.length + ' ordering words (before / then / next / week / phase)',
      clamp(2 + Math.floor(seq.length / 2), 2, 5), text, seq[0].index, 'body text');
    if (ctx.dates.unlockAt) signal(signals, 'dependency', 'it stays locked until a set time (unlock_at)', 3, text, -1, 'Canvas field unlock_at');
    var weekHit = /\bweek\s*\d+/i.exec(text);
    if (ctx.structure.weeks >= 2 && weekHit) signal(signals, 'dependency', 'work spans ' + ctx.structure.weeks + ' labelled weeks or phases', 3, text, weekHit.index, 'body text');
    if ((ctx.related.pageRefs || []).length) {
      signal(signals, 'dependency', ctx.related.pageRefs.length + ' other Canvas page(s) have to be read first', 3, text, -1, 'links in the body');
    }
  }

  function detectVolume(ctx, units, signals) {
    var text = unitTexts(units);
    var words = countWords(text);
    if (words >= 90) signal(signals, 'volume', words + ' words of instructions (after boilerplate is dropped)',
      clamp(Math.floor(words / 90), 1, 6), text, -1, 'body text');
    if (ctx.structure.tables) signal(signals, 'volume', ctx.structure.tables + ' table(s) on the page, likely a rubric or data grid', 3, text, firstCellIndex(ctx, text), 'tables in the body');
    if (ctx.resources.files.length) signal(signals, 'volume', ctx.resources.files.length + ' file(s) attached in the description', 2, text, -1, 'file links in the body');
    if (ctx.resources.external.length) signal(signals, 'volume', ctx.resources.external.length + ' link(s) leave Canvas', 2, text, -1, 'external links');
    if (ctx.structure.images) signal(signals, 'volume', ctx.structure.images + ' image(s) that may carry instructions', 2, text, -1, 'images in the body');

    /* 量出来的材料：这是 2026-10-12 那两条真作业对出来的缺口。
       只数不读，所以"六份课件"和"一行字"在这一维上终于能分开。 */
    var m = ctx.material || {};
    if (m.counted) {
      var materialWords = Math.round((m.textChars || 0) / 6);
      signal(signals, 'volume', m.counted + ' file(s) counted without being read: ' + (m.pages || 0) + ' page(s), about ' +
        (m.textChars || 0).toLocaleString() + ' characters of text (' + materialWords.toLocaleString() + ' words)' +
        (m.media ? ' and ' + m.media + ' embedded image(s)' : ''),
        clamp(3 + Math.floor(materialWords / 400) + Math.floor((m.pages || 0) / 6), 3, 10), text, -1, 'counted by pdf.js and jszip, contents not opened');
      if (m.picturePages) {
        signal(signals, 'volume', m.picturePages + ' of those pages carry no text layer, they are pictures', 3, text, -1, 'counted page by page');
      }
      if (m.skipped) signal(signals, 'volume', m.skipped + ' file(s) were not counted at all (over the size this window counts)', 1, text, -1, 'file records without a count');
    }
    var unreadWords = (ctx.resources.files || []).filter(function (f) { return f.status !== 'extracted'; })
      .reduce(function (a, f) { return a + Math.round(((f.measure && f.measure.chars) || 0) / 6); }, 0);
    if (unreadWords >= 300) {
      signal(signals, 'ambiguity', 'about ' + unreadWords.toLocaleString() + ' words of the requirement sit in files that have not been opened',
        clamp(4 + Math.floor(unreadWords / 1200), 4, 8), text, -1, 'counted, not read');
    }
  }

  function detectAmbiguity(ctx, units, signals) {
    var text = unitTexts(units);
    var vague = allMatches(RE.vague, text);
    if (vague.length) {
      signal(signals, 'ambiguity', vague.length + ' vague phrase(s), first: "' + vague[0].text + '"',
        clamp(3 + vague.length, 3, 7), text, vague[0].index, 'body text');
    }
    /* 有产出物却没说格式 = 学生得自己猜；有格式却没说产出物 = 同样模糊，但少见 */
    var artifact = escHit(RE.artifact, text);
    var format = escHit(RE.formatSpec, text);
    var action = escHit(RE.fileAction, text);
    if ((artifact || action) && !format && !escHit(RE.numericLimit, text) && !ctx.resources.files.length) {
      signal(signals, 'ambiguity', 'something is handed in but no format, length or template is stated', 4, text, (artifact || action).index, 'body text');
    }
    var point = escHit(RE.externalPoint, text);
    if (point) {
      var unread = ctx.resources.unread.length;
      signal(signals, 'ambiguity', 'instructions point at something else: "' + point.text + '"' + (unread ? ' (' + unread + ' of those we have not read)' : ''),
        unread ? 6 : 4, text, point.index, 'body text');
    }
    /* 评分表只有名字没有说明，等于让学生猜"好"长什么样 */
    if (ctx.rubric.status === 'available' && ctx.rubric.thinCriteria) {
      signal(signals, 'ambiguity', ctx.rubric.thinCriteria + ' rubric criterion(s) are named but never explained', 3, text, -1, 'Canvas field rubric');
    }
    if (ctx.rubric.status === 'unavailable') {
      signal(signals, 'ambiguity', 'a rubric is attached but Canvas would not give us its text', 3, text, -1, ctx.rubric.why || 'not readable');
    }
    if (ctx.kind === 'discussion' && !ctx.structure.lists.length) {
      signal(signals, 'ambiguity', 'a discussion asks for posts and replies; how many and how long are often left out', 2, text, -1, 'page kind');
    }
  }

  /* ==== 负向：四条，全部单独列账 ==== */

  function penaltiesFor(ctx, units, allUnits, dims, signals) {
    var out = [];
    /* 每一条负向规则都要回报"判过了，没成，为什么"：误判和漏判在他眼里同样要紧，
       只列开火的扣分等于让他猜哪一条没响 */
    out.checks = [];
    var text = unitTexts(units);
    var words = countWords(text);

    /* 1) 通稿占比：按摘掉的句子数，不是整段 */
    var boch = 0;
    var boSamples = [];
    allUnits.forEach(function (u) {
      (u.boilerCut || []).forEach(function (c) {
        boch += String(c.text || '').length;
        boSamples.push({ path: u.path, why: c.why, evidence: around(c.text, 0, 60) });
      });
    });
    var total = (ctx.body.chars || 1) || 1;
    var ratio = clamp(boch / total, 0, 1);
    if (boch >= 60) {
      out.push({
        id: 'boilerplate', label: 'School-wide boilerplate', points: -clamp(Math.round(ratio * 100 * 0.45), 1, 18),
        formula: Math.round(ratio * 100) + '% of the page is repeated notices → ' + Math.round(ratio * 100) + ' × 0.45 = ' + Math.round(ratio * 100 * 0.45) + ', clamped at 18',
        evidence: boSamples.slice(0, 3)
      });
    }

    /* 2) 已经写得很清楚了，AI 再总结一遍是浪费。
       这条只在该页真的没有"读不到的东西"时才成立：一条排好的清单后面挂着没读的附件时，
       浪费的不是屏幕，是那次没读。 */
    var lists = ctx.structure.lists || [];
    var big = null;
    lists.forEach(function (l) { if (!big || l.items.length > big.items.length) big = l; });
    var labelled = 0;
    if (big) big.items.forEach(function (it) { if (itemLabelled(it)) labelled++; });
    var headings = (ctx.structure.headings || []).length;
    var unreadSource = ctx.resources.files.some(function (f) { return f.status !== 'extracted'; })
      || (ctx.related.pageRefs || []).some(function (p) { return p.status !== 'extracted'; })
      || ctx.resources.external.length > 0
      || ctx.rubric.status === 'unavailable';
    var pointersAtUnread = (signals || []).some(function (s) {
      return s.dim === 'ambiguity' && /point at|would not give|named but never explained|left out/.test(s.rule);
    });
    var heavyElsewhere = !!ctx.rubricDensity && ctx.rubricDensity.heavy;
    var structured = !!big && big.items.length >= 3 && (labelled / big.items.length) >= 0.7 && headings >= 1 && !unreadSource && !pointersAtUnread && ratio < 0.15 && !heavyElsewhere &&
      /* 同一条轻重判据：小标题再整齐，每条五六十词、还套着小项，那也还是要有人摊开 */
      !!ctx.density && ctx.density.avgWords <= 35 && !ctx.density.heavySubs;
    if (structured) {
      out.push({
        id: 'well-structured', label: 'Already a clean checklist', points: -16,
        formula: labelled + ' of ' + big.items.length + ' list items open with their own label, plus ' + headings + ' heading(s), nothing on the page points at text we cannot read → flat −16',
        evidence: [{ path: big.path || 'longest list', evidence: around(big.items[0].text, 0, 70) }]
      });
    }

    /* 3) 同一句长话原样出现两次（只认逐字，见 findRepeats 那段） */
    var repeats = findRepeats(allUnits);
    if (repeats.length) {
      var dupChars = repeats.reduce(function (a, r) { return a + (r.count - 1) * r.text.length; }, 0);
      out.push({
        id: 'repetition', label: 'The same long line, word for word, twice', points: -clamp(Math.round(dupChars / 200), 1, 4),
        formula: Math.round(dupChars) + ' repeated characters ÷ 200 = ' + Math.round(dupChars / 200) + ', clamped at 4',
        evidence: repeats.slice(0, 2).map(function (r) { return { path: r.paths.join(' and '), evidence: around(r.text, 0, 70) }; })
      });
    }

    /* 4) 整份要求本来就一句话 */
    var nothingElse = !ctx.resources.files.length && !ctx.resources.external.length && !ctx.related.pageRefs.length;
    if ((ctx.body.chars || 0) < THRESHOLDS.trivialChars && ctx.rubric.status !== 'available' && nothingElse && ctx.kind !== 'quiz') {
      out.push({
        id: 'trivial', label: 'Nothing to destructure', points: -20,
        formula: 'the whole requirement is ' + (ctx.body.chars || 0) + ' characters (under ' + THRESHOLDS.trivialChars + ') and there is no rubric or file to read → flat −20',
        evidence: [{ path: 'body text', evidence: around(ctx.body.text || '', 0, 70) }]
      });
    }

    /* 5) 测验类：要求就是"点进去做完"，拆不出更多 */
    if (ctx.kind === 'quiz' && words < 60) {
      out.push({
        id: 'one-click', label: 'A quiz with almost no prose', points: -12,
        formula: 'page kind is a quiz and its description is ' + words + ' words → flat −12',
        evidence: [{ path: 'body text', evidence: around(ctx.body.text || '', 0, 70) }]
      });
    }

    /* 6) 老师已经把话讲完了：格式、字数、怎么交都写在页上，也没有读不到的材料。
       2026-10-12 他拿一份 116 词的短文对出来的那条 —— 旧写法把"写得具体"当成"要求多"，
       double-spaced、MLA、12-point 一路加分，判成 43 分值得总结，方向正好是反的。 */
    var statedFormat = escHit(RE.formatSpec, text);
    var statedLimit = escHit(RE.numericLimit, text);
    var modalCount = allMatches(RE.modal, text).length;
    var nothingElse = !ctx.resources.files.length && !ctx.resources.external.length && !(ctx.related.pageRefs || []).length;
    var ambiguityRaw = (dims.ambiguity || {}).raw || 0;
    var lightItems = !ctx.density || (ctx.density.avgWords <= 35 && !ctx.density.heavySubs);
    var spelledOut = !!statedFormat && (!!statedLimit || modalCount >= 2) && nothingElse && !pointersAtUnread
      && ctx.rubric.status !== 'unavailable' && ambiguityRaw <= 4 && (ctx.body.chars || 0) < 1400 && lightItems && !heavyElsewhere;
    if (spelledOut) {
      out.push({
        id: 'already-spelled-out', label: 'The teacher already wrote the checklist', points: -16,
        formula: 'the page states the format ("' + statedFormat.text.trim() + '")' + (statedLimit ? ' and a limit ("' + statedLimit.text.trim() + '")' : ' and ' + modalCount + ' binding words') +
          ', nothing on it points at unread material, and it is ' + (ctx.body.chars || 0) + ' characters → flat −16',
        evidence: [{ path: 'body text', evidence: around(text, statedFormat.index, 70) }]
      });
    }

    /* 7) 老师已经把它列成清单了：整份要求就是 1 到 10 那几条，没有藏在别处。
       2026-10-12 他指的那条："老师都列举好了，还有 40 分"。
       这条跟"预先结构化"那条的区别在判据：那条要每项自带小标题，
       这一条只要求编号成串、动词成串，且没有任何读不到的东西。 */
    var enumerated = 0;
    if (big) big.items.forEach(function (it) { if (RE.numbering.test(it.text) || itemLabelled(it)) enumerated++; });
    var allClosable = !(ctx.resources.files || []).some(function (f) { return f.status !== 'extracted'; })
      && !(ctx.related.pageRefs || []).some(function (p) { return p.status !== 'extracted'; })
      && ctx.rubric.status !== 'unavailable';
    var enumeratedAlready = !!ctx.density && ctx.density.items >= 4 && (ctx.density.share || 0) >= 0.5 && allClosable && ratio < 0.15 && !heavyElsewhere &&
      ctx.density.avgWords <= 35 && !ctx.density.heavySubs && ctx.density.multiSentence <= Math.ceil(ctx.density.items * 0.5);
    if (enumeratedAlready) {
      out.push({
        id: 'already-enumerated', label: 'The teacher already numbered the steps', points: -14,
        formula: ctx.density.items + ' list items carry ' + Math.round((ctx.density.share || 0) * 100) + '% of the words on the page, all of them light: ' +
          ctx.density.avgWords + ' words on average (over 35 would mean each one needs unpacking), longest ' + ctx.density.maxWords +
          ' words, ' + ctx.density.multiSentence + ' of them more than one sentence, ' + ctx.density.heavySubs + ' with a heavy sub-list (' + ctx.density.lightSubs + ' more carry only one-liners), and nothing on the page points at text we cannot read → flat −14',
        evidence: [{ path: big.path || 'longest list', evidence: around(big.items[0].text, 0, 70) }]
      });
    }

    /* 每条负向规则都回报一次，扣了分和没扣分都要说清差在哪：
       他调算法时找的是误判，"这条没响"和"这条响了"同样是结论 */
    out.checks = [
      { id: 'boilerplate', label: 'School-wide boilerplate', fired: out.some(function (p) { return p.id === 'boilerplate'; }),
        why: boch >= 60 ? boch + ' characters matched the notice list' : boch + ' characters matched the notice list, under the 60 it needs' },
      { id: 'well-structured', label: 'Already a clean checklist', fired: structured,
        why: structured ? labelled + ' of ' + big.items.length + ' items labelled, ' + headings + ' heading(s)'
          : 'needs a list of at least 3 items with 70% labelled plus a heading and nothing unreadable on the page. Here: ' +
            (big ? labelled + ' of ' + big.items.length + ' labelled, longest list ' + big.items.length + ' item(s)' : 'no list at all') +
            ', ' + headings + ' heading(s)' + (unreadSource ? ', and something is still unread' : '') + (pointersAtUnread ? ', and a line points at text we cannot read' : '') },
      { id: 'repetition', label: 'The same line more than once', fired: repeats.length > 0,
        why: repeats.length ? repeats.length + ' duplicated line(s)' : 'no two lines over 45 characters are the same' },
      { id: 'trivial', label: 'Nothing to destructure', fired: out.some(function (p) { return p.id === 'trivial'; }),
        why: (ctx.body.chars || 0) < THRESHOLDS.trivialChars
          ? (ctx.rubric.status === 'available' ? 'short, but a rubric is readable, so it is not trivial' : (!nothingElse ? 'short, but there is a file or link to read' : 'short and nothing else to read'))
          : (ctx.body.chars || 0) + ' characters, over the ' + THRESHOLDS.trivialChars + ' it looks at' },
      { id: 'one-click', label: 'A quiz with almost no prose', fired: out.some(function (p) { return p.id === 'one-click'; }),
        why: ctx.kind !== 'quiz' ? 'this page is not a quiz' : words + ' words, under the 60 it needs to count as one click' },
      { id: 'already-spelled-out', label: 'The teacher already wrote the checklist', fired: spelledOut,
        why: spelledOut ? 'format, a limit or binding words, and nothing unreadable behind it'
          : 'needs a stated format plus a limit or two binding words, with nothing pointing at unread material. Here: ' +
            (statedFormat ? 'format "' + statedFormat.text.trim() + '" stated' : 'no format stated') +
            (statedLimit ? ', limit "' + statedLimit.text.trim() + '"' : ', no numeric limit') +
            (nothingElse ? '' : ', and something is pointed at that we have not read') +
            (ambiguityRaw > 4 ? ', plus ' + ambiguityRaw + ' raw points of unclear or missing' : '') },
      { id: 'already-enumerated', label: 'The teacher already numbered the steps', fired: enumeratedAlready,
        why: enumeratedAlready ? ctx.density.items + ' items, all of them light'
          : 'needs the requirements written out as a list of 4+ light items (35 words or fewer each, no sub-lists) covering half the page or more, with no heavy grading sheet and nothing unreadable behind it. Here: ' +
            (ctx.density ? ctx.density.items + ' items in the longest list, ' + Math.round((ctx.density.share || 0) * 100) + '% of the words' : 'no list') +
            (ctx.density ? ', ' + ctx.density.avgWords + ' words per item, longest ' + ctx.density.maxWords + ', ' + ctx.density.heavySubs + ' with a heavy sub-list' : '') +
            (allClosable ? '' : ', and something on the page is still unread') }
    ];
    return out;
  }

  /* ==== Readiness：手上到底攥着多少真信息 ==== */

  /* 一条没读的来源要不要挡路，看正文有没有指向它：
     要么点名了那份东西（文件名、页面名），要么句子本身写着"要求见附件/见那一页"。
     没被指向的附件只是挂在页上的资料，它读没读都不该拦下整份摘要。 */
  var POINTER_RE = /\b(?:in|see|read|open|from|use|on|check|consult|finish)\b[^.]{0,40}\b(?:attached|attachment|file|document|pdf|handout|worksheet|template|guideline|page|slides|video|recording)\b/i;

  function pointsAtSource(ctx) {
    var t = String(ctx.body.text || '');
    var hit = POINTER_RE.exec(t);
    return hit ? { phrase: hit[0], index: hit.index } : null;
  }

  function namesInText(ctx, list) {
    var t = String(ctx.body.text || '').toLowerCase();
    var named = [];
    (list || []).forEach(function (item) {
      var label = String(item.name || item.label || item.pageUrl || '').toLowerCase().trim();
      if (!label) return;
      var key = label.replace(/\.[a-z0-9]+$/, '');
      if (key.length >= 4 && t.indexOf(key) >= 0) named.push(item.name || item.label || item.pageUrl);
    });
    return named;
  }

  function readiness(ctx) {
    var items = [];
    var bodyChars = ctx.body.chars || 0;
    var pointer = pointsAtSource(ctx);

    items.push({
      name: 'Assignment description',
      weight: 40,
      score: clamp(bodyChars / THRESHOLDS.bodyReadyChars, 0, 1),
      closable: false,
      detail: bodyChars + ' characters of usable text',
      why: bodyChars >= THRESHOLDS.bodyReadyChars
        ? 'enough to work from'
        : 'under ' + THRESHOLDS.bodyReadyChars + ' characters, so a summary would be guessing at the rest'
    });

    var r = ctx.rubric;
    if (r.status === 'absent') {
      items.push({ name: 'Rubric', weight: 0, score: 1, closable: false, detail: 'this assignment has no rubric attached', why: 'not counted: nothing to read' });
    } else if (r.status === 'available') {
      items.push({ name: 'Rubric', weight: 20, score: 1, closable: false, detail: (r.criteria || []).length + ' criteria read', why: 'read' });
    } else {
      /* 评分表挂着但正文里读不到：按"要求的一部分还没读到"处理，不是"这门课没有评分表"。
         它可以被读，只是不是由我们读到（学生在页面上打得开），所以算 closable。 */
      items.push({
        name: 'Rubric', weight: 20, score: 0.35, closable: true, needed: true,
        how: 'open the grading sheet on the page itself, Canvas will not hand its text to this window',
        neededWhy: 'a rubric is attached, so the grading sheet is part of what the student has to satisfy',
        detail: (r.httpStatus ? 'HTTP ' + r.httpStatus + ' · ' : '') + (r.why || 'attached but not given to us'),
        why: 'Canvas returned ' + (r.httpStatus || 'no text') + ', so the criteria are counted as missing, not as absent'
      });
    }

    var files = ctx.resources.files || [];
    if (files.length) {
      var read = files.filter(function (f) { return f.status === 'extracted'; }).length;
      var partial = files.filter(function (f) { return f.status === 'partial' || f.status === 'unreadable'; }).length;
      var meta = files.filter(function (f) { return f.status === 'metadata_loaded' || f.status === 'discovered'; }).length;
      var dead = files.filter(function (f) { return f.status === 'unavailable'; }).length;
      var got = read + partial * 0.2 + meta * 0.4 + dead * 0;
      items.push({
        name: 'Attached files',
        weight: 20,
        score: clamp(got / files.length, 0, 1),
        closable: meta > 0,
        how: 'press Read on the file',
        needed: (meta > 0) && (!!namesInText(ctx, files).length || !!pointer),
        neededWhy: namesInText(ctx, files).length ? 'the instructions name ' + namesInText(ctx, files).join(', ')
          : (pointer ? 'a line points at something attached: "' + around(ctx.body.text, pointer.index, 40) + '"' : 'the link is on the page but nothing tells the student to open it'),
        detail: read + ' read, ' + meta + ' metadata only, ' + partial + ' unreadable, ' + dead + ' refused (' + files.length + ' found)',
        why: meta ? 'we know the file names but not their text; press Read on a file to close this gap' : (dead ? 'Canvas refused to hand the file over' : 'all found files were read')
      });
    } else {
      items.push({ name: 'Attached files', weight: 0, score: 1, closable: false, detail: 'no Canvas file linked in the description', why: 'not counted: none referenced' });
    }

    var pages = ctx.related.pageRefs || [];
    if (pages.length) {
      var fetched = pages.filter(function (p) { return p.status === 'extracted' || p.status === 'metadata_loaded'; }).length;
      items.push({
        name: 'Other Canvas pages', weight: 8,
        score: clamp(fetched / pages.length, 0, 1),
        closable: fetched < pages.length,
        how: 'press Read on the page',
        needed: (fetched < pages.length) && (!!namesInText(ctx, pages).length || !!pointer),
        neededWhy: namesInText(ctx, pages).length ? 'the instructions name ' + namesInText(ctx, pages).join(', ')
          : (pointer ? 'a line points at another page' : 'the page is linked but nothing asks for it'),
        detail: fetched + ' of ' + pages.length + ' page(s) read',
        why: fetched < pages.length ? 'the instructions point at pages we have not opened' : 'read'
      });
    }

    var ext = ctx.resources.external || [];
    if (ext.length) {
      items.push({
        name: 'Links leaving Canvas', weight: 12,
        score: 0.15,
        closable: false,
        detail: ext.length + ' link(s) to ' + ext.map(function (e) { return e.host; }).filter(function (h, i, a) { return a.indexOf(h) === i; }).slice(0, 3).join(', '),
        why: 'we cannot read these from here; a document or video behind a link stays unknown until the student opens it'
      });
    } else {
      items.push({ name: 'Links leaving Canvas', weight: 0, score: 1, closable: false, detail: 'nothing points off Canvas', why: 'not counted' });
    }

    if (ctx.body.datesNote) {
      items.push({ name: 'Dates and access window', weight: 4, score: ctx.dates.dueAt ? 1 : 0.6, closable: false, detail: ctx.body.datesNote, why: 'read from Canvas fields' });
    }

    var wsum = 0, acc = 0;
    items.forEach(function (it) { wsum += it.weight; acc += it.weight * it.score; });
    var score = wsum ? Math.round(acc / wsum * 100) : 0;
    var gaps = items.filter(function (it) { return it.weight > 0 && it.score < 0.999; });
    /* 挡路的只有"我们本来读得到、但还没读"的那两类：附件和别的课程页。
       外站链接和没权限的评分表是读不到的，它们只能压分，不能一票否决，
       否则任何带 YouTube 链接的作业都永远出不了摘要。
       2026-10-12 外部审查复现的那条 P0 是：平均数把阻断冲掉了，所以这里阻断不看总分。 */
    gaps.forEach(function (it) { it.loss = Math.round((1 - it.score) * it.weight * 10) / 10; });
    var blocking = gaps.filter(function (it) {
      return it.closable && it.needed && it.loss >= 8;
    });
    return {
      items: items,
      score: score,
      weightSum: wsum,
      formula: 'Σ(score × weight) ' + acc.toFixed(2) + ' ÷ Σ(weight) ' + wsum + ' × 100 = ' + score,
      gaps: gaps,
      blocking: blocking,
      blockingLoss: blocking.reduce(function (a, b) { return a + b.loss; }, 0)
    };
  }

  /* ==== 作业类型先验 ==== */

  function detectTaskType(ctx, units) {
    var text = unitTexts(units) + '\n' + (ctx.title || '');
    var scored = TYPE_PRIORS.map(function (p) {
      var hits = allMatches(p.re, text);
      return { type: p.type, hits: hits.length, words: hits.slice(0, 3).map(function (h) { return h.text; }).join(', ') };
    }).filter(function (s) { return s.hits > 0; }).sort(function (a, b) { return b.hits - a.hits; });
    if (ctx.kind === 'quiz' && !scored.length) scored.push({ type: 'exam or quiz', hits: 1, words: 'page kind is a quiz' });
    if (ctx.kind === 'discussion') scored.unshift({ type: 'discussion post', hits: 99, words: 'page kind is a discussion' });
    return {
      primary: scored.length ? scored[0].type : 'plain homework',
      candidates: scored.slice(0, 3),
      evidence: scored.length ? [{ path: 'body text', evidence: around(text, text.indexOf(scored[0].words.split(', ')[0] || ''), 60) }] : []
    };
  }

  /* ==== 决策：一道一道门走过去，每道门都留下比较过程 ==== */

  function decide(aiValue, readinessInfo, ctx) {
    var ladder = [];
    var decision;
    var reason;
    var emptyPage = false;

    ladder.push({
      gate: 'Is anything readable at all?',
      test: 'description characters ' + (ctx.body.chars || 0) + ' , rubric ' + ctx.rubric.status + ' , files ' + ctx.resources.files.length + ' , external ' + ctx.resources.external.length,
      hit: false
    });

    /* 这一道门必须排在 locked 那道之前（2026-10-13 他拍的：没有正文的那一页这张卡不要出现）。
       作业还没开放那一屏 Canvas 整块说明都不画，看着就是"锁着且读不到字"，
       先撞上 locked 会被判成 need_content，卡片摊开来只会说"还有东西没读到"，
       而那东西其实根本不存在。[实测 /courses/296970/assignments/14485431 与 /14485465：
       description 回空串、/rubric 回 404、attachments 是 []] */
    if ((ctx.body.chars || 0) < 40 && ctx.rubric.status === 'absent' && !ctx.resources.files.length && !ctx.resources.external.length && !(ctx.body.text || '').trim()) {
      ladder[ladder.length - 1].hit = true;
      decision = 'skip';
      emptyPage = true;
      reason = 'There is no description text, no rubric, no file and no external link on this page. A summary would be invented.' +
        (ctx.lockedForUser ? ' This one is also locked for you, which is why Canvas draws no description at all here.' : '');
      return finish();
    }

    if (ctx.lockedForUser && !(ctx.body.chars > 40)) {
      ladder[ladder.length - 1].hit = true;
      decision = 'need_content';
      reason = 'Canvas marks this locked for you (locked_for_user) and the page carries no text, so there is nothing to analyse yet.';
      return finish();
    }

    var readyStep = {
      gate: 'Is anything we could still read sitting unread? (a blocking gap vetoes, whatever the average says)',
      test: 'blocking gap(s) ' + readinessInfo.blocking.length + ' , total loss ' + readinessInfo.blockingLoss + ' weight-points (one gap at 8 or more blocks)' +
        ' ; the average Readiness is ' + readinessInfo.score + ' and is not part of this gate',
      hit: false
    };
    if (readinessInfo.blocking.length) {
      readyStep.hit = true;
      readyStep.test += ' , blocking: ' + readinessInfo.blocking.map(function (g) { return g.name + ' loses ' + g.loss; }).join(' and ');
      ladder.push(readyStep);
      decision = 'need_content';
      reason = 'Readiness averages ' + readinessInfo.score + ', but ' + readinessInfo.blocking.map(function (g) { return g.name.toLowerCase() + ' (' + g.detail + ')'; }).join(' and ') + ' is still readable and unread. A summary built without it would be missing the part it is about, so the gate is a veto, not a deduction.';
      return finish();
    }
    ladder.push(readyStep);

    var thinStep = {
      gate: 'Or is the page thin while something it asks for is still unopened? (Readiness < ' + THRESHOLDS.readinessMin + ' , with a needed gap that could be read)',
      test: readinessInfo.score + ' < ' + THRESHOLDS.readinessMin + ' ? ' + (readinessInfo.score < THRESHOLDS.readinessMin) +
        ' , needed and closable gaps ' + readinessInfo.items.filter(function (g) { return g.closable && g.needed && g.score < 0.999; }).length,
      hit: false
    };
    /* 短本身不是缺东西：一页写得清清楚楚的三行作业，读不到更多也照样能总结。
       只有"正文短 + 它点名要读的那份还没读"才够第二道门。 */
    if (readinessInfo.score < THRESHOLDS.readinessMin && readinessInfo.items.some(function (g) { return g.closable && g.needed && g.score < 0.999; })) {
      thinStep.hit = true;
      ladder.push(thinStep);
      decision = 'need_content';
      reason = 'Readiness is ' + readinessInfo.score + ', under ' + THRESHOLDS.readinessMin + ', and ' +
        readinessInfo.items.filter(function (g) { return g.closable && g.needed && g.score < 0.999; }).map(function (g) { return g.name + ' (' + g.detail + '; ' + g.neededWhy + ')'; }).join(', ') +
        ' is asked for by the text and still unopened. A short page on its own is not a problem; a short page that sends you to something unread is.';
      return finish();
    }
    ladder.push(thinStep);

    var valueStep = {
      gate: 'Is it worth the tokens? (AI Value ≥ ' + THRESHOLDS.skipBelow + ' to say anything at all)',
      test: aiValue + ' < ' + THRESHOLDS.skipBelow + ' ? ' + (aiValue < THRESHOLDS.skipBelow),
      hit: aiValue < THRESHOLDS.skipBelow
    };
    ladder.push(valueStep);
    if (valueStep.hit) {
      decision = 'skip';
      reason = 'AI Value ' + aiValue + ' is under ' + THRESHOLDS.skipBelow + '. ' + weakReason(aiValue, readinessInfo) + '.';
      return finish();
    }

    var optStep = {
      gate: 'Or is it a clear win? (AI Value ≥ ' + THRESHOLDS.optionalBelow + ')',
      test: aiValue + ' ≥ ' + THRESHOLDS.optionalBelow + ' ? ' + (aiValue >= THRESHOLDS.optionalBelow),
      hit: aiValue >= THRESHOLDS.optionalBelow
    };
    ladder.push(optStep);
    decision = optStep.hit ? 'recommended' : 'optional';
    reason = decision === 'recommended'
      ? 'AI Value ' + aiValue + ' is at or over ' + THRESHOLDS.optionalBelow + ', with ' + (readinessInfo.gaps.length) + ' gap(s) still open out of ' + readinessInfo.items.length + ' checks. The page has enough unsaid that laying it out is worth a call.'
      : 'AI Value ' + aiValue + ' sits between ' + THRESHOLDS.skipBelow + ' and ' + THRESHOLDS.optionalBelow + '. Worth offering, not worth interrupting for.';

    function finish() {
      /* 距离一律算法值，且用"要涨多少 / 要跌多少"两个方向分开。
         2026-10-12 外部审查复现的那条：旧写法把 aiValue - skipBelow 这个负数直接塞进
         Math.max(1, x + 1)，差 25 分屏上显示"差 1 分"。 */
      var margins = {
        upToOptional: Math.max(0, THRESHOLDS.skipBelow - aiValue),
        upToRecommended: Math.max(0, THRESHOLDS.optionalBelow - aiValue),
        downToOptional: Math.max(0, aiValue - THRESHOLDS.optionalBelow + 1),
        downToSkip: Math.max(0, aiValue - THRESHOLDS.skipBelow + 1),
        readinessMargin: readinessInfo.score - THRESHOLDS.readinessMin
      };
      return {
        kind: decision,
        reason: reason,
        /* 这一页压根没有可读的东西（不是"还没读到"，是本来就没有）。
           卡片拿这颗决定出不出，见 assignment-guide.js 的 judge() */
        emptyPage: emptyPage,
        ladder: ladder,
        margins: margins,
        flip: flipNote(decision, margins, aiValue, readinessInfo)
      };
    }
    return finish();
  }

  function weakReason(aiValue, readinessInfo) {
    var top = (readinessInfo.gaps || [])[0];
    return 'The strongest signal on this page is weak' + (top ? ', and ' + top.name + ' is still short: ' + top.detail : '');
  }

  /* "差多少会翻档" —— 他要用真作业验判准不准时，这一句最省事。
     四个方向分开算，每个都是非负数：负数出现在屏幕上就是那条"差 1 分"的假话 */
  function flipNote(decision, margins, aiValue, readinessInfo) {
    if (decision === 'need_content') {
      if (readinessInfo.blocking.length) {
        return 'How to close this: ' + readinessInfo.blocking.map(function (g) {
          return (g.how || 'read it here') + ' (' + g.detail + ')';
        }).join('; ') + '. Closing them lifts Readiness by ' + Math.round(readinessInfo.blockingLoss / (readinessInfo.weightSum / 100)) +
          ' points and this gate lets go.';
      }
      return 'Nothing here is one click away: ' + readinessInfo.gaps.map(function (g) { return g.name + ' (' + g.detail + ')'; }).join(', ') +
        '. Readiness would have to rise by ' + Math.max(1, THRESHOLDS.readinessMin - readinessInfo.score) + ' to reach the ' + THRESHOLDS.readinessMin + ' floor.';
    }
    if (decision === 'skip') {
      return 'AI Value would have to rise by ' + Math.max(1, margins.upToOptional) + ' to reach Optional, or by ' +
        Math.max(1, margins.upToRecommended) + ' to reach Recommended.';
    }
    if (decision === 'optional') {
      return 'AI Value would have to rise by ' + Math.max(1, margins.upToRecommended) + ' to become Recommended, or fall by ' +
        Math.max(1, margins.downToSkip) + ' to be skipped.';
    }
    return 'AI Value would have to fall by ' + Math.max(1, margins.downToOptional) + ' to become Optional, or by ' +
      Math.max(1, margins.downToSkip) + ' to be skipped.';
  }


  /* ==== 主入口 ==== */

  function analyze(rawCtx, overrides) {
    var ctx = prepare(rawCtx);
    var weights = weightsWith(overrides);

    var allUnits = markBoilerplate(ctx.units);
    /* 摘过句子的副本挂回 ctx.units，画面那一头读的就是这一份：
       每条 unit 自带 boilerplate / boilerCut，证据才说得出"这段里摘掉了哪一句" */
    ctx.units = allUnits;
    var units = allUnits.filter(function (u) { return !u.boilerplate; });

    var signals = [];
    detectParts(ctx, units, signals);
    detectDeliverable(ctx, units, signals);
    detectConstraint(ctx, units, signals);
    detectRubric(ctx, units, signals);
    detectDependency(ctx, units, signals);
    detectVolume(ctx, units, signals);
    detectAmbiguity(ctx, units, signals);
    detectSheetOnPage(ctx, units, signals);

    var dims = {};
    DIMENSIONS.forEach(function (d) { dims[d.id] = tally(signals, d.id); });

    var valueRows = [];
    var complexityRows = [];
    var valueAcc = 0, compAcc = 0;
    DIMENSIONS.forEach(function (d) {
      var t = dims[d.id];
      var w = weights[d.id] || {};
      /* 同一颗维度走两本账：AI Value 只看 axis 不是 'work' 的那些点，
         Complexity 看全部。老师列好的清单只进后面那本。 */
      var norm = clamp(t.valueRaw / (w.cap || d.cap), 0, 1);
      var cnorm = clamp(t.raw / (w.cap || d.cap), 0, 1);
      var vContrib = norm * (w.value == null ? d.value : w.value);
      var cContrib = cnorm * (w.complexity == null ? d.complexity : w.complexity);
      valueAcc += vContrib;
      compAcc += cContrib;
      valueRows.push({ id: d.id, label: d.label, raw: t.valueRaw, allRaw: t.raw, cap: (w.cap || d.cap), norm: Math.round(norm * 100) / 100, weight: (w.value == null ? d.value : w.value), contribution: Math.round(vContrib * 10) / 10, hits: t.hits.length, workOnly: t.raw - t.valueRaw, note: d.note });
      complexityRows.push({ id: d.id, label: d.label, raw: t.raw, cap: (w.cap || d.cap), norm: Math.round(cnorm * 100) / 100, weight: (w.complexity == null ? d.complexity : w.complexity), contribution: Math.round(cContrib * 10) / 10 });
    });

    var penalties = penaltiesFor(ctx, units, allUnits, dims, signals);
    var penTotal = clamp(penalties.reduce(function (a, p) { return a + p.points; }, 0), -PENALTY_CAP, 0);

    /* 多颗一起打满的组合分。每颗维度到自己的上限就停止加分，于是"三样都很重"的页面
       和"两样重"的页面分数一样：2026-10-12 那页墨西哥时间轴就是这个情况，
       规则、材料、含糊三颗全溢出 27 个原始点，一分没拿到。
       从第三颗饱和起每多一颗 +4，封顶 +12。单颗刷满拿不到这条。 */
    var saturated = valueRows.filter(function (r) { return r.norm >= 1; });
    var bonusPoints = saturated.length >= 3 ? Math.min((saturated.length - 2) * 4, 12) : 0;
    var bonus = { points: bonusPoints, count: saturated.length, ids: saturated.map(function (r) { return r.id; }) };

    var aiValue = clamp(Math.round(valueAcc + penTotal + bonusPoints), 0, 100);
    var complexity = clamp(Math.round(compAcc), 0, 100);
    var readinessInfo = readiness(ctx);
    var taskType = detectTaskType(ctx, units);
    var decision = decide(aiValue, readinessInfo, ctx);

    return {
      version: VERSION,
      at: Date.now(),
      key: ctx.key,
      title: ctx.title,
      kind: ctx.kind,
      taskType: taskType,
      aiValue: aiValue,
      complexity: complexity,
      readiness: readinessInfo,
      decision: decision,
      dimensions: valueRows,
      complexityRows: complexityRows,
      signals: signals,
      penalties: penalties,
      penaltyChecks: penalties.checks || [],
      penaltyTotal: penTotal,
      bonus: bonus,
      boilerplateUnits: allUnits.filter(function (u) { return u.boilerplate; }).length,
      /* 通稿是按句子摘的，摘过哪几句要原样交给画面，不然"这段被洗掉了"说不清洗掉了什么。
         这份是副本，ctx.units 一个字都没被改过（同一份 ctx 会被反复重判） */
      unitsMarked: allUnits,
      contentUnits: units.length,
      totalUnits: allUnits.length,
      formulas: {
        value: valueRows.map(function (r) { return r.id + ' ' + r.raw + '/' + r.cap + '=' + r.norm + '×' + r.weight + '=' + r.contribution; }).join(' + ') +
          ' = ' + Math.round(valueAcc * 10) / 10 + ' then penalties ' + penTotal +
          (bonusPoints ? ' then ' + bonus.count + ' dimensions at once maxed out ' + bonus.ids.join(', ') + ' +' + bonusPoints : ' then no multi-max bonus (needs 3 dimensions at their cap)') +
          ' → ' + aiValue,
        complexity: complexityRows.map(function (r) { return r.id + ' ' + r.norm + '×' + r.weight + '=' + r.contribution; }).join(' + ') + ' = ' + Math.round(compAcc * 10) / 10 + ' → ' + complexity,
        readiness: readinessInfo.formula,
        decision: decision.ladder.map(function (s) { return s.gate + ' → ' + s.test + (s.hit ? '  [fired]' : ''); }).join('  |  ')
      },
      thresholds: THRESHOLDS,
      ctx: ctx
    };
  }

  /* 权重覆盖：只接受那四个键，其它一律忽略，防止手抖把 cap 写成字符串 */
  function weightsWith(overrides) {
    var out = {};
    DIMENSIONS.forEach(function (d) { out[d.id] = { cap: d.cap, value: d.value, complexity: d.complexity }; });
    if (overrides && typeof overrides === 'object') {
      Object.keys(out).forEach(function (id) {
        var o = overrides[id];
        if (!o) return;
        ['cap', 'value', 'complexity'].forEach(function (k) {
          var n = Number(o[k]);
          if (isFinite(n) && n >= 0) out[id][k] = k === 'cap' ? clamp(Math.round(n), 1, 60) : clamp(Math.round(n), 0, 60);
        });
      });
    }
    return out;
  }

  /* 数据层给的 ctx 允许缺字段：这里补齐成引擎能无脑读的形状，
     缺的部分同时登记进 access，让"缺失信息"那一屏知道是缺了什么 */
  function prepare(raw) {
    var ctx = raw || {};
    ctx.title = ctx.title || '';
    ctx.kind = ctx.kind || 'assignment';
    ctx.key = ctx.key || (ctx.courseId + ':' + ctx.assignmentId);
    ctx.body = ctx.body || {};
    ctx.body.text = ctx.body.text || '';
    ctx.body.chars = ctx.body.chars == null ? ctx.body.text.length : ctx.body.chars;
    ctx.units = ctx.units || [];
    ctx.structure = ctx.structure || { headings: [], lists: [], tables: 0, images: 0, weeks: 0 };
    ctx.structure.headings = ctx.structure.headings || [];
    ctx.structure.lists = ctx.structure.lists || [];
    ctx.rubric = ctx.rubric || { status: 'absent', criteria: [] };
    ctx.rubric.criteria = ctx.rubric.criteria || [];
    ctx.rubric.thinCriteria = ctx.rubric.criteria.filter(function (c) { return !c.details || String(c.details).length < 20; }).length;
    ctx.rubricDensity = ctx.rubricDensity || null;
    ctx.submission = ctx.submission || {};
    ctx.submission.types = ctx.submission.types || [];
    ctx.submission.allowedExtensions = ctx.submission.allowedExtensions || [];
    ctx.dates = ctx.dates || {};
    ctx.resources = ctx.resources || { files: [], external: [] };
    ctx.resources.files = ctx.resources.files || [];
    ctx.resources.external = ctx.resources.external || [];
    ctx.resources.unread = ctx.resources.files.filter(function (f) { return f.status !== 'extracted'; });
    ctx.material = ctx.material || { files: 0, pages: 0, textChars: 0, picturePages: 0, media: 0, counted: 0, skipped: 0 };
    ctx.related = ctx.related || {};
    ctx.related.pageRefs = ctx.related.pageRefs || [];
    ctx.lockedForUser = !!ctx.lockedForUser;
    if (!ctx.body.chars && ctx.units.length) {
      ctx.body.text = unitTexts(ctx.units);
      ctx.body.chars = ctx.body.text.length;
    }
    return ctx;
  }

  var api = {
    VERSION: VERSION,
    THRESHOLDS: THRESHOLDS,
    PENALTY_CAP: PENALTY_CAP,
    DIMENSIONS: DIMENSIONS,
    analyze: analyze,
    countWords: countWords,
    BOILERPLATE: BOILERPLATE,
    RE: RE
  };

  if (typeof define === 'function' && define.amd) define([], function () { return api; });
  else if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MCxAnalyze = api;
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
