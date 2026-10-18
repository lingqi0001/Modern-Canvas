/* =========================================================
   互动练习这一屏：把模型回的那一份 mcx_practice_v1 JSON 变成能作答的题。

   三条要紧的口径写在前面：
   - 判分只在本地做，而且只对选择题做。简答题永远不自动判：
     它回的是参考答案，学生自己选"我掌握了／我不确定／我还不会"，那一句才是这一题的账。
   - 出处只认面板自己那份来源映射（[R1] 对的是发出去的第几条材料）。
     模型写了一个不存在的标签，或者一题来源是空的，这一题整个不要——
     宁可少一题，也不能给出一条对不上课件的"来源"。
   - 屏幕上的每一个字都走 textContent。题干、选项、解释、参考答案全是模型写的，
     是不可信内容，一个字符都不许当 HTML 用。

   有效题不到三道就整体回退：调用方照原来的 Markdown 渲染，
   所以解析失败在屏幕上只是"这次没有互动题"，不是答案没了。

   作答状态存在传进来的 state（就是面板那一轮自己）：
   追问、换屏回来都会重画这一屏，状态不在 DOM 上而在 state 里，才不会把他答过的抹掉。
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
  var PROTOCOL = 'mcx_practice_v1';
  var MIN_QUESTIONS = 3;
  var MAX_QUESTIONS = 24;
  var LOG = '[MCX practice]';

  var TYPES = { single_choice: 1, multiple_choice: 1, short_answer: 1 };
  var DIFFICULTY = {
    basic: 'Recall',
    recall: 'Recall',
    understand: 'Understanding',
    understanding: 'Understanding',
    application: 'Application',
    apply: 'Application'
  };
  // "Chapter 3"、"Unit 2" 这种是章节名，不是一个能练的知识点：这一题按无效处理
  var TOO_BIG = /^(chapter|unit|section|week|lesson|module|part|capitulo|tema)\s+([0-9]+|[ivxlcdm]+)$/i;

  var GLYPH = {
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    cross: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    dot: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    down: 'M7 10l5 5 5-5z',
    book: 'M12 3 1 8l11 5 9-4.09V17h2V8zM5 13.18v3.32L12 20l7-3.5v-3.32L12 17z'
  };

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function text(v, cap) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    var limit = cap || 600;
    return s.length > limit ? s.slice(0, limit) : s;
  }

  function tagList(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (t) {
      var s = String(t == null ? '' : t).replace(/^\[|\]$/g, '').trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  function el(tag, cls, str) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (str != null) n.textContent = str;
    return n;
  }

  function svgIcon(path, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', cls || 'mcx-practice-icon');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'currentColor');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }

  /* ==== 读 ==== */

  /* 保守清理：
     1. 去除 Markdown 代码围栏（```json ... ```）
     2. 取协议标记或首个 { 到最后一个 } 那一段
     3. 若由于 Token 截断缺少尾部括号，做最小化的闭合尝试以抢救前序有效题目 */
  function extract(raw) {
    var s = String(raw == null ? '' : raw).trim();
    // 剥离可能存在的 markdown 代码围栏
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    var protoIdx = s.indexOf(PROTOCOL);
    var start = s.indexOf('{');
    if (protoIdx !== -1) {
      var beforeProto = s.lastIndexOf('{', protoIdx);
      if (beforeProto !== -1) start = beforeProto;
    }
    if (start === -1) return '';
    var end = s.lastIndexOf('}');
    if (end > start) return s.slice(start, end + 1);
    // 如果没有合法的闭合 }，说明在流式中或输出遇到了 token 截断，尝试截取到最后一个完整的题目对象并补齐括号
    var lastQEnd = s.lastIndexOf('}');
    if (lastQEnd !== -1 && lastQEnd > start) {
      return s.slice(start, lastQEnd + 1) + ']}';
    }
    return '';
  }

  function parse(textIn, sources, minReq) {
    var raw = String(textIn == null ? '' : textIn);
    if (raw.indexOf(PROTOCOL) === -1) return { ok: false, quiz: null, error: 'not a practice set' };
    var blob = extract(raw);
    if (!blob) return { ok: false, quiz: null, error: 'no complete JSON object in that answer' };
    var doc = null;
    try { doc = JSON.parse(blob); } catch (e) {
      // 容错：若因尾部截断或流式中输出未完成题目导致 JSON.parse 失败，尝试定位到 questions 数组中最后一个完整的 "}"
      var qIdx = blob.indexOf('"questions"');
      if (qIdx !== -1) {
        var cursor = blob.length;
        while (cursor > qIdx) {
          var lastObjEnd = blob.lastIndexOf('}', cursor);
          if (lastObjEnd === -1 || lastObjEnd <= qIdx) break;
          try {
            doc = JSON.parse(blob.slice(0, lastObjEnd + 1) + ']}');
            if (doc && doc.questions) break;
          } catch (e2) {}
          cursor = lastObjEnd - 1;
        }
      }
      if (!doc) {
        return { ok: false, quiz: null, error: 'that practice JSON could not be read' };
      }
    }
    return validate(doc, sources, minReq);
  }

  /* 一题一题验。回 null 就是这一题不要了，调用方把它剔除，不整批失败。 */
  function cleanQuestion(q, sources) {
    if (!q || typeof q !== 'object') return null;
    var type = String(q.type || '').trim();
    if (!TYPES[type]) return null;
    var prompt = text(q.prompt, 900);
    if (!prompt) return null;
    var concept = text(q.concept, 160);
    if (!concept || TOO_BIG.test(concept)) return null;

    var tags = tagList(q.sourceTags);
    if (!tags.length) return null;
    var known = sources || {};
    var kept = tags.filter(function (t) {
      var norm = t.replace(/[\[\]]/g, '').trim();
      return !!(known[t] || known[norm] || known['[' + norm + ']']);
    }).map(function (t) {
      return t.replace(/[\[\]]/g, '').trim();
    });
    // 一个来源都对上不了就没有出处可给，这一题按无效处理
    if (!kept.length) return null;

    var out = {
      type: type,
      id: String(q.id == null ? '' : q.id).slice(0, 60),
      concept: concept,
      prompt: prompt,
      explanation: text(q.explanation, 900),
      sourceTags: kept,
      difficulty: DIFFICULTY[String(q.difficulty || '').toLowerCase()] || text(q.difficulty, 40) || 'Recall'
    };

    if (type === 'short_answer') {
      var ref = text(q.referenceAnswer, 600);
      // 没有参考答案的简答题没法自评，判无效
      if (!ref) return null;
      out.referenceAnswer = ref;
      return out;
    }

    var list = Array.isArray(q.options) ? q.options : [];
    var opts = [];
    var seen = {};
    list.slice(0, 10).forEach(function (o) {
      if (!o || typeof o !== 'object') return;
      var body = text(o.text, 400);
      if (!body) return;
      var oid = String(o.id == null ? '' : o.id).trim() || String.fromCharCode(97 + opts.length);
      if (seen[oid]) return;
      seen[oid] = 1;
      opts.push({ id: oid, text: body });
    });
    if (opts.length < 2) return null;

    var rawAns = Array.isArray(q.answer) ? q.answer : [q.answer];
    var ans = [];
    rawAns.forEach(function (a) {
      var id = String(a == null ? '' : a).trim();
      if (seen[id] && ans.indexOf(id) === -1) ans.push(id);
    });
    if (!ans.length) return null;
    if (type === 'single_choice' && ans.length !== 1) return null;
    out.options = opts;
    out.answer = ans;
    return out;
  }

  function validate(doc, sources, minReq) {
    if (!doc || typeof doc !== 'object') return { ok: false, quiz: null, error: 'nothing to read' };
    if (String(doc.type || '') !== PROTOCOL) return { ok: false, quiz: null, error: 'not a practice set' };
    var raw = Array.isArray(doc.questions) ? doc.questions : [];
    if (!raw.length) return { ok: false, quiz: null, error: 'that practice set has no questions' };

    var keep = [];
    var dropped = 0;
    raw.slice(0, MAX_QUESTIONS).forEach(function (q) {
      var one = cleanQuestion(q, sources);
      if (one) keep.push(one);
      else dropped++;
    });

    if (dropped) log('dropped ' + dropped + ' unusable question(s) out of ' + raw.length);
    var threshold = typeof minReq === 'number' ? minReq : MIN_QUESTIONS;
    // 有效题不到要求数量就不开互动题：整体回退成原来的文字
    if (keep.length < threshold) {
      return { ok: false, quiz: null, error: 'only ' + keep.length + ' usable question(s) in that answer' };
    }
    return {
      ok: true,
      quiz: {
        title: text(doc.title, 160) || 'Practice set',
        instructions: text(doc.instructions, 300),
        questions: keep,
        dropped: dropped
      },
      error: ''
    };
  }

  // 解析不成就不回任何东西，由调用方走原来那套 Markdown
  function plainFallback() {
    return null;
  }

  /* ==== 画 ==== */

  function sourceHref(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  }

  function stateFor(state, index) {
    if (!state.answers[index]) state.answers[index] = { selected: [], text: '', checked: false };
    var st = state.answers[index];
    if (!Array.isArray(st.selected)) st.selected = [];
    return st;
  }

  function hasInput(q, st) {
    if (q.type === 'short_answer') return String(st.text || '').trim().length >= 2;
    return st.selected.length > 0;
  }

  /* 判这一题落在哪一档。简答题没自评之前是空串——它不该被算成任何一种掌握状态。 */
  function resultOf(q, st) {
    if (q.type === 'short_answer') {
      return st.rating === 'mastered' ? 'correct'
        : (st.rating === 'weak' ? 'wrong' : (st.rating === 'uncertain' ? 'uncertain' : ''));
    }
    var picked = st.selected.map(function (i) {
      var o = q.options[Number(i)];
      return o ? o.id : '';
    }).filter(function (s) { return s; }).sort();
    var key = q.answer.slice().sort();
    if (picked.length !== key.length) return 'wrong';
    for (var i = 0; i < key.length; i++) {
      if (key[i] !== picked[i]) return 'wrong';
    }
    return 'correct';
  }

  function rateWord(rating) {
    return rating === 'mastered' ? 'learned' : (rating === 'weak' ? 'not learned' : 'unsure');
  }

  function optionRow(q, opt, i, name, picked, locked) {
    var row = el('label', 'mcx-practice-option');
    var input = el('input');
    input.type = q.type === 'multiple_choice' ? 'checkbox' : 'radio';
    input.name = name;
    input.value = String(i);
    input.className = 'mcx-practice-choice';
    if (picked) input.checked = true;
    if (locked) input.disabled = true;
    input.setAttribute('data-opt', String(i));
    row.appendChild(input);
    row.appendChild(el('span', 'mcx-practice-optmark', String.fromCharCode(65 + i)));
    row.appendChild(el('span', 'mcx-practice-opttext', opt.text));
    return row;
  }

  function sourcesBlock(q, opts, st) {
    var wrap = el('div', 'mcx-practice-sourcewrap');
    var btn = el('button', 'mcx-study-ghost mcx-practice-srctoggle');
    btn.type = 'button';
    btn.setAttribute('data-p-src', '1');
    btn.setAttribute('aria-expanded', st.srcOpen ? 'true' : 'false');
    btn.appendChild(svgIcon(GLYPH.book, 'mcx-practice-icon mcx-practice-srcicon'));
    btn.appendChild(el('span', null, 'Source' + (q.sourceTags.length > 1 ? 's' : '')));
    btn.appendChild(svgIcon(GLYPH.down, 'mcx-practice-icon mcx-practice-srcchev'));
    wrap.appendChild(btn);

    var list = el('div', 'mcx-practice-srclist');
    list.hidden = !st.srcOpen;
    q.sourceTags.forEach(function (tag) {
      var src = opts.sourceOf ? opts.sourceOf(tag) : null;
      if (!src) return;
      var row = el('div', 'mcx-practice-source');
      row.appendChild(el('span', 'mcx-f-cite', tag));
      var href = sourceHref(src.url);
      var name = el(href ? 'a' : 'span', 'mcx-practice-sourcename',
        (src.title || tag) + (src.module ? ' (' + src.module + ')' : ''));
      if (href) {
        name.href = href;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      }
      row.appendChild(name);
      list.appendChild(row);
    });
    if (!list.children.length) {
      list.appendChild(el('div', 'mcx-practice-source', 'That piece of material is not in this chat any more.'));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function verdict(box, kind) {
    box.classList.add(kind === 'correct' ? 'mcx-practice-correct'
      : (kind === 'wrong' ? 'mcx-practice-wrong' : 'mcx-practice-uncertain'));
    var row = el('span', 'mcx-practice-verdict');
    if (kind === 'correct') {
      row.appendChild(svgIcon(GLYPH.check));
      row.appendChild(el('span', null, 'Correct'));
    } else if (kind === 'wrong') {
      row.appendChild(svgIcon(GLYPH.cross));
      row.appendChild(el('span', null, 'Not correct'));
    } else {
      row.appendChild(svgIcon(GLYPH.dot));
      row.appendChild(el('span', null, 'Self-check'));
    }
    box.appendChild(row);
  }

  function answerLine(label, body) {
    var ans = el('div', 'mcx-practice-answer');
    ans.appendChild(el('span', 'mcx-practice-label', label));
    ans.appendChild(el('span', 'mcx-practice-answerbody', body));
    return ans;
  }

  function ratingRow(q, st) {
    var row = el('div', 'mcx-practice-ratings');
    row.appendChild(el('div', 'mcx-practice-ratehead', 'How well do you have this?'));
    [{ k: 'mastered', t: 'I have this' },
      { k: 'uncertain', t: 'Not sure' },
      { k: 'weak', t: 'Not yet' }].forEach(function (p) {
      var btn = el('button', 'mcx-study-ghost mcx-practice-rate mcx-practice-rate-' + p.k);
      btn.type = 'button';
      btn.setAttribute('data-p-rate', p.k);
      btn.setAttribute('aria-pressed', st.rating === p.k ? 'true' : 'false');
      if (st.rating === p.k) btn.classList.add('is-on');
      btn.appendChild(el('span', null, p.t));
      row.appendChild(btn);
    });
    row.appendChild(el('div', 'mcx-practice-rated',
      st.rating ? 'Saved as ' + rateWord(st.rating) + '.' : 'Pick one to put this question in your review queue.'));
    return row;
  }

  function buildQuestion(q, index, opts, st, namePrefix) {
    var card = el('div', 'mcx-practice-card');
    card.setAttribute('data-qi', String(index));
    if (st.checked) card.classList.add('is-done');

    var top = el('div', 'mcx-practice-top');
    top.appendChild(el('span', 'mcx-practice-num', 'Q' + (index + 1)));
    top.appendChild(el('span', 'mcx-practice-concept', q.concept));
    top.appendChild(el('span', 'mcx-practice-diff', q.difficulty));
    card.appendChild(top);

    card.appendChild(el('div', 'mcx-practice-prompt', q.prompt));

    if (q.type === 'short_answer') {
      var box = el('textarea', 'mcx-practice-input');
      box.setAttribute('rows', '3');
      box.setAttribute('placeholder', 'Write your answer, then compare it with the reference answer.');
      box.setAttribute('aria-label', 'Your answer to question ' + (index + 1));
      box.value = st.text || '';
      if (st.checked) box.disabled = true;
      card.appendChild(box);
    } else {
      var field = el('fieldset', 'mcx-practice-options');
      var leg = el('legend', 'mcx-practice-legend');
      leg.textContent = q.type === 'multiple_choice'
        ? 'Choose every answer that applies' : 'Choose one answer';
      field.appendChild(leg);
      q.options.forEach(function (opt, i) {
        var isPick = st.selected.indexOf(String(i)) >= 0;
        var row = optionRow(q, opt, i, namePrefix + index, isPick, st.checked);
        if (st.checked) {
          var isKey = q.answer.indexOf(opt.id) >= 0;
          if (isKey) row.classList.add('is-key');
          if (isKey && isPick) row.classList.add('is-hit');
          if (!isKey && isPick) row.classList.add('is-miss');
          var tagTxt = isKey ? (isPick ? 'correct answer, and you picked it' : 'correct answer')
            : (isPick ? 'your pick' : '');
          if (tagTxt) row.appendChild(el('span', 'mcx-practice-tag', tagTxt));
        }
        field.appendChild(row);
      });
      card.appendChild(field);
    }

    var actions = el('div', 'mcx-practice-actions');
    var check = el('button', 'mcx-study-primary mcx-practice-check');
    check.type = 'button';
    check.setAttribute('data-p-check', '1');
    check.textContent = st.checked ? 'Answered' : 'Check answer';
    check.disabled = st.checked || !hasInput(q, st);
    actions.appendChild(check);

    if (st.checked && opts.totalQuestions && index < opts.totalQuestions - 1) {
      var nextBtn = el('button', 'mcx-study-ghost mcx-practice-next');
      nextBtn.type = 'button';
      nextBtn.setAttribute('data-p-next', '1');
      nextBtn.textContent = 'Next question →';
      actions.appendChild(nextBtn);
    }
    card.appendChild(actions);

    if (!st.checked) {
      card.appendChild(el('div', 'mcx-practice-hint',
        'Answer first. The correct answer, the reasoning and where it came from appear after you check.'));
      return card;
    }

    // 只有答过之后才把答案和解释放进 DOM：没答之前它们根本不存在，翻也翻不出来
    var fb = el('div', 'mcx-practice-feedback');
    fb.setAttribute('tabindex', '-1');
    fb.setAttribute('role', 'status');
    if (q.type === 'short_answer') {
      verdict(fb, 'uncertain');
      fb.appendChild(answerLine('Reference answer', q.referenceAnswer));
    } else {
      verdict(fb, st.correct ? 'correct' : 'wrong');
      var keyText = q.answer.map(function (id) {
        var hit = q.options.filter(function (o) { return o.id === id; })[0];
        return hit ? hit.text : '';
      }).filter(function (s) { return s; }).join('  ·  ');
      fb.appendChild(answerLine('Correct answer', keyText));
    }
    if (q.explanation) fb.appendChild(el('div', 'mcx-practice-why', q.explanation));
    fb.appendChild(sourcesBlock(q, opts, st));
    if (q.type === 'short_answer') fb.appendChild(ratingRow(q, st));
    card.appendChild(fb);
    return card;
  }

  function buildHead(quiz, state) {
    var head = el('div', 'mcx-practice-head');
    head.appendChild(el('div', 'mcx-practice-title', quiz.title));
    if (quiz.instructions) head.appendChild(el('div', 'mcx-practice-instructions', quiz.instructions));
    
    // 题号导航指示器：一题一题切换 / 查看答题状态
    var nav = el('div', 'mcx-practice-nav');
    var activeIdx = typeof state.activeQuestion === 'number' ? state.activeQuestion : 0;
    quiz.questions.forEach(function (q, i) {
      var dot = el('button', 'mcx-practice-nav-btn');
      dot.type = 'button';
      dot.setAttribute('data-p-nav', String(i));
      dot.textContent = 'Q' + (i + 1);
      if (i === activeIdx) dot.classList.add('is-active');
      if (state.answers && state.answers[i] && state.answers[i].checked) {
        dot.classList.add('is-done');
        if (state.answers[i].correct) dot.classList.add('is-correct');
      }
      nav.appendChild(dot);
    });
    head.appendChild(nav);

    head.appendChild(el('div', 'mcx-practice-progress', ''));
    head.appendChild(el('div', 'mcx-practice-note',
      'Practice questions generated from your course material. They are not questions copied from a real Canvas quiz.'));
    return head;
  }

  /* host 是那一轮的答题容器，options 里要带：
     courseId、state（这一轮自己，作答存这里）、sourceOf(tag)、onAttempt(rec)、onChanged() */
  function render(host, quiz, options) {
    var opts = options || {};
    var state = opts.state && typeof opts.state === 'object' ? opts.state : {};
    if (!state.answers) state.answers = {};
    if (typeof state.activeQuestion !== 'number' || state.activeQuestion >= quiz.questions.length) {
      state.activeQuestion = 0;
    }
    opts.totalQuestions = quiz.questions.length;

    while (host.firstChild) host.removeChild(host.firstChild);
    var wrap = el('div', 'mcx-practice');
    wrap.appendChild(buildHead(quiz, state));
    var body = el('div', 'mcx-practice-body');
    var prefix = 'mcx-practice-' + Math.random().toString(36).slice(2, 7) + '-';
    
    // 一题一题显示：当前选中的题目显示，其余题目在 DOM 中隐藏
    quiz.questions.forEach(function (q, i) {
      var card = buildQuestion(q, i, opts, stateFor(state, i), prefix);
      if (i !== state.activeQuestion) {
        card.style.display = 'none';
      }
      body.appendChild(card);
    });
    wrap.appendChild(body);
    host.appendChild(wrap);
    host.mcxPractice = { quiz: quiz, state: state, opts: opts, wrap: wrap };
    bind(host, { quiz: quiz, state: state, opts: opts });
    return wrap;
  }

  /* 事件全挂在 host 上代理：单题重画换了节点，绑定一次也不用重做。 */
  function bind(host, options) {
    var opts = (options && options.opts) || (options || {});
    var quiz = (options && options.quiz) || (host.mcxPractice || {}).quiz;
    var state = (options && options.state) || (host.mcxPractice || {}).state;
    if (!quiz || !state) return;

    function cardOf(node) {
      return node && node.closest ? node.closest('.mcx-practice-card') : null;
    }
    function qOf(card) {
      return quiz.questions[Number(card.getAttribute('data-qi'))];
    }
    function stOf(card) {
      return stateFor(state, Number(card.getAttribute('data-qi')));
    }

    function switchQuestion(idx) {
      if (idx < 0 || idx >= quiz.questions.length) return;
      state.activeQuestion = idx;
      var cards = host.querySelectorAll('.mcx-practice-card');
      for (var c = 0; c < cards.length; c++) {
        var cIdx = Number(cards[c].getAttribute('data-qi'));
        cards[c].style.display = (cIdx === idx) ? '' : 'none';
      }
      var dots = host.querySelectorAll('.mcx-practice-nav-btn');
      for (var d = 0; d < dots.length; d++) {
        var dIdx = Number(dots[d].getAttribute('data-p-nav'));
        dots[d].classList.toggle('is-active', dIdx === idx);
        var st = state.answers && state.answers[dIdx];
        if (st && st.checked) {
          dots[d].classList.add('is-done');
          if (st.correct) dots[d].classList.add('is-correct');
        }
      }
      progressLine();
    }

    function progressLine() {
      var line = host.querySelector('.mcx-practice-progress');
      if (!line) return;
      var done = 0;
      quiz.questions.forEach(function (q, i) {
        if (state.answers[i] && state.answers[i].checked) done++;
      });
      var cur = (typeof state.activeQuestion === 'number' ? state.activeQuestion : 0) + 1;
      line.textContent = 'Question ' + cur + ' of ' + quiz.questions.length + ' · ' + (done ? done + ' answered' : 'Answer one, then check it');
    }

    function save(q, st) {
      var result = st.result || resultOf(q, st);
      if (!result) return;
      var key = opts.progress && opts.progress.keyForQuestion
        ? opts.progress.keyForQuestion(q, opts.courseId) : '';
      if (!key) return;
      if (opts.onAttempt) {
        opts.onAttempt({
          questionKey: key,
          concept: q.concept,
          sourceTags: q.sourceTags,
          result: result,
          selfRating: st.rating || ''
        });
      }
    }

    /* 只换这一张卡：整屏重画会把他正在读的那一段一起滚走，
       还会把别的卡的 hover 打断一次 */
    function repaintCard(card) {
      var index = Number(card.getAttribute('data-qi'));
      var q = quiz.questions[index];
      opts.totalQuestions = quiz.questions.length;
      var fresh = buildQuestion(q, index, opts, stateFor(state, index), 'mcx-practice-r-');
      var parent = card.parentNode;
      parent.replaceChild(fresh, card);
      var fb = fresh.querySelector('.mcx-practice-feedback');
      if (fb) fb.focus();

      // 更新对应导航点状态
      var dot = host.querySelector('.mcx-practice-nav-btn[data-p-nav="' + index + '"]');
      if (dot) {
        dot.classList.add('is-done');
        var st = stateFor(state, index);
        if (st && st.correct) dot.classList.add('is-correct');
      }
    }

    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      var card = cardOf(t);
      if (!card) return;
      var q = qOf(card);
      var st = stOf(card);
      if (t.classList.contains('mcx-practice-choice') && q) {
        var idx = t.getAttribute('data-opt');
        if (q.type === 'multiple_choice') {
          var at = st.selected.indexOf(idx);
          if (t.checked && at === -1) st.selected.push(idx);
          else if (!t.checked && at >= 0) st.selected.splice(at, 1);
        } else {
          st.selected = [idx];
        }
      } else if (t.tagName === 'TEXTAREA') {
        st.text = String(t.value || '');
      } else {
        return;
      }
      if (!st.checked && q) {
        var btn = card.querySelector('.mcx-practice-check');
        if (btn) btn.disabled = !hasInput(q, st);
      }
    });

    // 打字只登记内容、不动那颗键：重建那排会把光标丢掉
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('mcx-practice-input')) return;
      var card = cardOf(t);
      if (!card) return;
      var q = qOf(card);
      var st = stOf(card);
      st.text = String(t.value || '');
      if (!st.checked && q) {
        var btn = card.querySelector('.mcx-practice-check');
        if (btn) btn.disabled = !hasInput(q, st);
      }
    });

    host.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var navBtn = t.closest('[data-p-nav]');
      if (navBtn) {
        var nIdx = Number(navBtn.getAttribute('data-p-nav'));
        switchQuestion(nIdx);
        return;
      }

      var nextBtn = t.closest('[data-p-next]');
      if (nextBtn) {
        var curIdx = typeof state.activeQuestion === 'number' ? state.activeQuestion : 0;
        switchQuestion(curIdx + 1);
        return;
      }

      var src = t.closest('[data-p-src]');
      if (src) {
        var cardS = cardOf(src);
        var list = cardS.querySelector('.mcx-practice-srclist');
        if (!list) return;
        var willOpen = list.hidden;
        list.hidden = !willOpen;
        src.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        stOf(cardS).srcOpen = willOpen;
        return;
      }

      var rate = t.closest('[data-p-rate]');
      if (rate) {
        var cardR = cardOf(rate);
        var qR = qOf(cardR);
        var stR = stOf(cardR);
        stR.rating = rate.getAttribute('data-p-rate');
        stR.result = resultOf(qR, stR);
        save(qR, stR);
        var rowR = rate.parentNode;
        var kids = rowR.querySelectorAll('[data-p-rate]');
        for (var a = 0; a < kids.length; a++) {
          var on = kids[a] === rate;
          kids[a].classList.toggle('is-on', on);
          kids[a].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        var said = rowR.querySelector('.mcx-practice-rated');
        if (said) said.textContent = 'Saved as ' + rateWord(stR.rating) + '.';
        if (opts.onChanged) opts.onChanged();
        return;
      }

      var check = t.closest('[data-p-check]');
      if (!check) return;
      var card = cardOf(check);
      var q = qOf(card);
      var st = stOf(card);
      if (!q || st.checked || !hasInput(q, st)) return;
      st.checked = true;
      if (q.type === 'short_answer') {
        // 简答题不自动判分：先把参考答案摊开，等他自己选掌握到哪一档才记账
        st.result = '';
        st.rating = '';
        st.correct = false;
      } else {
        st.result = resultOf(q, st);
        st.correct = st.result === 'correct';
        save(q, st);
      }
      repaintCard(card);
      progressLine();
      if (opts.onChanged) opts.onChanged();
    });

    progressLine();
  }

  window.MCxPractice = {
    protocol: PROTOCOL,
    minQuestions: MIN_QUESTIONS,
    parse: parse,
    validate: validate,
    /* 判档那一步也挂出去：离线回归（tests/ai-study-smoke-test.js）要在没有画面的情况下
       钉住"简答题不许本地自动判对"这一条，它不该被复制成第二份判据 */
    resultOf: resultOf,
    render: render,
    bind: bind,
    plainFallback: plainFallback
  };
})();
