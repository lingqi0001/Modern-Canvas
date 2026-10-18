/* =========================================================
   复习总结的排版层：模型回来的 Markdown 变成能看的字。

   为什么自己写而不装 marked／KaTeX：
   - MV3 不许从网上加载要执行的代码，装就得把整颗 KaTeX（JS 加几十个字型文件）搬进包里，
     而字型地址在页面里还要改写成 chrome-extension:// 那一条，等于再摊一层 web_accessible_resources。
   - 这一层只做"看得下去"这一件事，不需要完整 CommonMark。

   安全口径和 canvas-data.js 里那条一样：整条通路一个 innerHTML 都没有。
   parse() 只产纯数据，mount() 才建节点，文字一律走 createTextNode／textContent。
   模型回来的东西里若有 <script> 或 onerror，它到屏幕上就只是字符。
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
  /* 引用标签两种形状都要认：整份那一个号 [R3]，和切片那一个号 [R3-C2]。
     只认前者的话，模型照材料上印的片号写出来的角标会原样带着方括号上屏，看着像没排完 */
  var CITETAG = /^R\d{1,3}(-C\d{1,3})?$/;

  /* ==== 行内：一次扫描切成 run ====
     不认 _italic_：课件里的化学式（H_2O）和下标写法太多，认它只会把正文切坏 */
  var TOKEN = /(\*\*(?!\s)[^*\n]+\*\*|__(?!\s)[^_\n]+__|\*(?!\s)[^*\n]+\*|~~(?!\s)[^~\n]+~~|`[^`\n]+`|\$\$[^$\n]+\$\$|\$[^$\n]+\$|<br\s*\/?>|\[[^\]\n]+\]\([^)\s]+\)|\[[RGW]?\d{1,3}(?:-C\d{1,3})?[A-Za-z]?\]|https?:\/\/[^\s<>()\[\]"'`]+)/gi;

  function inline(text) {
    var src = String(text == null ? '' : text);
    var runs = [];
    var last = 0;
    var m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src))) {
      if (m.index > last) runs.push({ t: 'text', v: src.slice(last, m.index) });
      var hit = m[0];
      var next = m.index + hit.length;
      var kind = 'text';
      var val = hit;
      if (/^<br\s*\/?>$/i.test(hit)) {
        runs.push({ t: 'br' });
        last = next;
        continue;
      } else if (/^\*\*[^*]+\*\*$/.test(hit)) { kind = 'b'; val = hit.slice(2, -2); }
      else if (/^__[^_]+__$/.test(hit)) { kind = 'b'; val = hit.slice(2, -2); }
      else if (/^\*[^*]+\*$/.test(hit)) { kind = 'i'; val = hit.slice(1, -1); }
      else if (/^~~[^~]+~~$/.test(hit)) { kind = 'del'; val = hit.slice(2, -2); }
      else if (/^`[^`]+`$/.test(hit)) { kind = 'code'; val = hit.slice(1, -1); }
      else if (/^\$\$[^$]+\$\$$/.test(hit)) { kind = 'math'; val = hit.slice(2, -2); }
      else if (/^\$[^$]+\$$/.test(hit)) { kind = 'math'; val = hit.slice(1, -1); }
      else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(hit)) {
        var br = hit.indexOf('](');
        kind = 'a';
        val = hit.slice(1, br);
        runs.push({ t: kind, v: val, href: safeHref(hit.slice(br + 2, -1)) });
        last = next;
        continue;
      } else if (/^\[.*\]$/.test(hit)) {
        var tag = hit.slice(1, -1);
        if (CITETAG.test(tag)) {
          runs.push({ t: 'cite', v: tag });
          last = next;
          continue;
        }
        // 不是引用标签的方括号（[1]、[R2a] 之类）原样留着，别猜它想链去哪儿
        runs.push({ t: 'text', v: hit });
        last = next;
        continue;
      } else if (/^https?:\/\//.test(hit)) {
        var trailing = /[.,;:!?)]+$/.exec(hit);
        var clean = hit;
        var tail = '';
        if (trailing) {
          // 句尾那个点／括号多半是正文，不是地址的一部分
          clean = hit.slice(0, hit.length - trailing[0].length);
          tail = trailing[0];
        }
        runs.push({ t: 'a', v: clean, href: safeHref(clean) });
        if (tail) runs.push({ t: 'text', v: tail });
        last = next;
        continue;
      }
      runs.push({ t: kind, v: String(val) });
      last = next;
    }
    if (last < src.length) runs.push({ t: 'text', v: src.slice(last) });
    return runs;
  }

  // 只放绝对的网络地址进 <a>：javascript:、data: 这种一个都不许
  function safeHref(url) {
    var u = String(url || '').trim();
    if (!/^(https?:)?\/\//i.test(u)) return '';
    return u;
  }

  /* ==== 块级 ==== */

  function parse(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    function isBlockStart(line) {
      return !line.trim()
        || /^\s*(#{1,6})\s+/.test(line)
        || /^\s*(```|~~~)/.test(line)
        || /^\s*>/.test(line)
        || /^\s*(\$\$)/.test(line)
        || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
        || /^\s*([-*+]|\d+[.)])\s+/.test(line);
    }

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        var marker = fence[1];
        var buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker).test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push({ t: 'pre', v: buf.join('\n') });
        continue;
      }

      if (/^\s*\$\$/.test(line)) {
        var math = [line.replace(/^\s*\$\$/, '').replace(/\$\$\s*$/, '')];
        if (!/\$\$\s*$/.test(line) || line.replace(/^\s*\$\$/, '').indexOf('$$') < 0) {
          i++;
          while (i < lines.length) {
            var stop = /\$\$\s*$/.test(lines[i]);
            math.push(stop ? lines[i].replace(/\$\$\s*$/, '') : lines[i]);
            i++;
            if (stop) break;
          }
        } else {
          i++;
        }
        out.push({ t: 'dmath', v: math.join(' ').trim() });
        continue;
      }

      var head = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        out.push({ t: 'h', lvl: Math.min(head[1].length, 3), v: inline(head[2].replace(/\s*#+\s*$/, '')) });
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push({ t: 'gap' });
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push({ t: 'quote', blocks: parse(q.join('\n')) });
        continue;
      }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var built = parseTable(lines, i);
        out.push(built.table);
        i = built.next;
        continue;
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var got = takeList(lines, i);
        out.push.apply(out, got.blocks);
        i = got.next;
        continue;
      }

      var para = [];
      while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
      // 段里那一个换行保留：模型常用单换行分行，并成一行反而读不断
      out.push({ t: 'p', lines: para.map(function (l) { return inline(l.replace(/^\s+/, '')); }) });
    }
    return out;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(String(line || ''));
  }

  /* 表格那一行按竖线切格。$…$、反引号、花括号以及绝对值 |…| 里面的竖线不是列边界，
     当切出的列数超过表头列数时，智能重合过度拆分的列，避免整表错位。 */
  function splitCells(line) {
    var s = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    var out = [];
    var buf = '';
    var math = false;
    var code = false;
    var depth = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '\\' && s[i + 1] === '|') { buf += '|'; i++; continue; }
      if (c === '$' && !code) { math = !math; buf += c; continue; }
      if (c === '`' && !math) { code = !code; buf += c; continue; }
      if ((c === '{' || c === '(') && !code) { depth++; buf += c; continue; }
      if ((c === '}' || c === ')') && !code && depth > 0) { depth--; buf += c; continue; }
      if (c === '|' && !math && !code && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += c;
    }
    out.push(buf);
    return out;
  }

  function repairRowCells(rawCells, expectedCols) {
    if (!expectedCols || rawCells.length <= expectedCols) return rawCells;
    // 当列数超出表头时，往往是某单元格内部的未转义竖线（如 $|A - B|...$ 或绝对值）被误切
    // 检查是否有未闭合的 $ 或者包含公式算符（\le, \ge, \text）的碎片，将其与相邻项重聚
    var merged = [];
    for (var i = 0; i < rawCells.length; i++) {
      var cell = rawCells[i];
      var dollarCount = (cell.match(/\$/g) || []).length;
      if (dollarCount % 2 !== 0 && i + 1 < rawCells.length) {
        // 未配对的 $：与下一项用竖线合并回绝对值 |
        rawCells[i + 1] = cell + '|' + rawCells[i + 1];
        continue;
      }
      merged.push(cell);
    }
    // 如果依然超长，从后往前查找是否是倒数第2、3项拆碎了
    while (merged.length > expectedCols) {
      // 找到含有 LaTeX 反斜杠或数学算符但被孤立的项向前合并
      var found = false;
      for (var j = 1; j < merged.length; j++) {
        if (/^\s*(?:\\le|\\ge|\\approx|\\pm|\+|-|=|[A-Za-z0-9_-]+\s*\|)/.test(merged[j]) ||
            /\|\s*$/.test(merged[j - 1]) || /^\s*\$/.test(merged[j - 1])) {
          merged[j - 1] = merged[j - 1] + '|' + merged[j];
          merged.splice(j, 1);
          found = true;
          break;
        }
      }
      if (!found) {
        // 兜底：将最后多出来的合并到倒数第二列
        var tail = merged.pop();
        merged[merged.length - 1] += ' ' + tail;
      }
    }
    return merged;
  }

  function cells(line, expectedCols) {
    var raw = splitCells(line);
    var repaired = repairRowCells(raw, expectedCols);
    return repaired.map(function (cell) { return inline(cell.trim()); });
  }

  function parseTable(lines, start) {
    var head = cells(lines[start]);
    var expectedCols = head.length;
    var i = start + 2;
    var rows = [];
    while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
      rows.push(cells(lines[i], expectedCols));
      i++;
    }
    return { table: { t: 'table', head: head, rows: rows }, next: i };
  }

  var ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function takeList(lines, start) {
    var items = [];
    var i = start;
    var baseIndent = null;
    while (i < lines.length) {
      var line = lines[i];
      var m = ITEM.exec(line);
      if (m) {
        var indent = m[1].replace(/\t/g, '  ').length;
        if (baseIndent === null) baseIndent = indent;
        var ordered = /\d/.test(m[2]);
        // 同一排缩进上换了号码就换了一列：条目之间空一行很常见，但那不该把
        // "- a / - b" 和 "1. c / 2. d" 并成一条列表
        if (indent === baseIndent && items.length && items[0].ordered !== ordered) break;
        items.push({ indent: indent, ordered: ordered, text: m[3] });
        i++;
        continue;
      }
      // 缩进的续行接在上一条后面；空行后面还跟着更深的缩进也算（模型爱在条目间留一行）
      if (!line.trim()) {
        var ahead = lines[i + 1];
        if (ahead && (ITEM.test(ahead) || /^\s{2,}\S/.test(ahead))) { i++; continue; }
        break;
      }
      if (/^\s{2,}\S/.test(line) && items.length) {
        items[items.length - 1].text += ' ' + line.trim();
        i++;
        continue;
      }
      break;
    }
    var made = buildList(items, 0);
    return { blocks: [made.node], next: i };
  }

  function buildList(items, start) {
    var indent = items[start].indent;
    var list = { t: items[start].ordered ? 'ol' : 'ul', items: [] };
    var i = start;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        var made = buildList(items, i);
        var last = list.items[list.items.length - 1];
        if (last) {
          if (!last.sub) last.sub = [];
          last.sub.push(made.node);
        } else {
          list.items.push({ runs: [], sub: [made.node] });
        }
        i = made.next;
        continue;
      }
      list.items.push({ runs: inline(items[i].text), sub: null });
      i++;
    }
    return { node: list, next: i };
  }

  /* ==== LaTeX 转成能直接读的字 ====
     不追求排得和印刷体一样：那要整颗 KaTeX。这里只保证一句话公式不再以反斜杠出现，
     认不出的写法就剥掉反斜杠留下词本身，宁可朴素也不要留一堆 \left\frac */
  var GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
    eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
    chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };

  var SYM = {
    times: '×', div: '÷', cdot: '·', ast: '*', star: '⋆', bullet: '•',
    pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
    approx: '≈', cong: '≅', simeq: '≃', sim: '∼', propto: '∝', equiv: '≡',
    ll: '≪', gg: '≫', inf: '∞', infty: '∞', partial: '∂', nabla: '∇',
    sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', lim: 'lim',
    to: '→', rightarrow: '→', Rrightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐',
    leftrightharpoons: '⇌', rightleftharpoons: '⇌', Leftrightarrow: '⇔', leftrightarrow: '↔',
    implies: '⟹', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
    supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', neg: '¬', langle: '⟨', rangle: '⟩',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', prime: '′',
    circ: '∘', degree: '°', deg: '°', angle: '∠', triangle: '△', square: '□',
    perp: '⊥', parallel: '∥', mid: '∣', therefore: '∴', because: '∵',
    ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', hbar: 'ℏ', ell: 'ℓ',
    aleph: 'ℵ', Re: 'ℜ', Im: 'ℑ', checkmark: '✓', cross: '✗'
  };

  var SUP = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
    'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ',
    'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ'
  };

  var SUB = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
    'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
    'v': 'ᵥ', 'x': 'ₓ'
  };

  var FRAC = { '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/5': '⅕', '2/5': '⅖',
    '3/5': '⅗', '4/5': '⅘', '1/6': '⅙', '5/6': '⅚', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞' };

  function mapChars(src, table) {
    var s = String(src || '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (!table[s[i]]) return '';
      out += table[s[i]];
    }
    return out;
  }

  /* 上下标遇到 Unicode 里根本没有的那一个字母时（下标 y 就没有），不许把 `_y` 留在屏上：
     用两个私用字符把内容夹住，挂载那一步换成真的 <sub>／<sup>。
     这两个码位正常文本里不会出现，万一模型真吐了，mathNodes 找不到配对就把它丢掉 */
  var SUB_OPEN = '\u0002';
  var SUB_CLOSE = '\u0003';
  var SUP_OPEN = '\u0004';
  var SUP_CLOSE = '\u0005';
  var ESC = '\u0001';

  // 组合记号只盖在它前面那一个字符上，多字母的 body 只有最后一位带得动。
  // 这一档本来就是退路：prompt 已经让它直接写 unicode，认不出的写法宁可记号薄也不丢字母
  var ACCENT = {
    vec: '\u20D7', hat: '\u0302', tilde: '\u0303', bar: '\u0304', overline: '\u0304',
    dot: '\u0307', ddot: '\u0308', check: '\u030C'
  };

  var TEXTISH = {
    text: 1, textrm: 1, textit: 1, textbf: 1, textsf: 1, texttt: 1, mbox: 1,
    mathrm: 1, mathbf: 1, mathit: 1, mathsf: 1, mathtt: 1, mathcal: 1, mathbb: 1,
    operatorname: 1, mathop: 1
  };

  // 读一个参数：{…} 要按花括号配对走进去（里面还能再套 \frac{…}），不然就只吃一个字符
  function readArg(s, i) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '{') return { body: s[i] === undefined ? '' : s[i], next: i + 1 };
    var depth = 0;
    var start = i + 1;
    for (; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && !--depth) return { body: s.slice(start, i), next: i + 1 };
    }
    return { body: s.slice(start), next: s.length };
  }

  function script(body, table, open, close) {
    var mapped = mapChars(body, table);
    return mapped ? mapped : open + body + close;
  }

  function fracOf(num, den) {
    var key = num + '/' + den;
    if (FRAC[key]) return FRAC[key];
    // 两头各判各的要不要加括号：分子有加减号就得包，分母是 2 就别多写一对
    var wideNum = num.length > 3 || /[+\-=]/.test(num);
    var wideDen = den.length > 3 || /[+\-=]/.test(den);
    // 分子被包了一层时，两位以上的分母也一起包：`(...) / 2a` 那种读起来要猜哪一半在底下
    if (wideNum && den.length > 1) wideDen = true;
    return (wideNum ? '(' + num + ')' : num) + '/' + (wideDen ? '(' + den + ')' : den);
  }

  /* 结构件一层层剥开。之前用的是"参数里不许有花括号"那种正则，
     于是 \frac{(v_0 \sin\theta)^2}{2g} 这种分子里带 ^{…} 的整条折不动，
     最后露出来的就是屏幕上半个括号加一串反斜杠（他截图里那两行正是） */
  function expand(s) {
    var out = '';
    var i = 0;
    while (i < s.length) {
      if (s[i] === '\\') {
        var word = /^\\([A-Za-z]+)/.exec(s.slice(i));
        var w = word ? word[1] : '';
        var after = i + (word ? word[0].length : 1);
        if (w === 'frac' || w === 'dfrac' || w === 'tfrac' || w === 'cfrac') {
          var a = readArg(s, after);
          var b = readArg(s, a.next);
          out += fracOf(expand(a.body).trim(), expand(b.body).trim());
          i = b.next;
          continue;
        }
        if (w === 'sqrt') {
          var root = '';
          var j = after;
          if (s[j] === '[') {
            var close = s.indexOf(']', j);
            if (close > 0) {
              root = mapChars(s.slice(j + 1, close).replace(/[{}]/g, ''), SUP) || '';
              j = close + 1;
            }
          }
          var arg = readArg(s, j);
          out += root + '√(' + expand(arg.body) + ')';
          i = arg.next;
          continue;
        }
        if (TEXTISH[w]) {
          var t = readArg(s, after);
          out += expand(t.body);
          i = t.next;
          continue;
        }
        if (ACCENT[w]) {
          var u = readArg(s, after);
          out += expand(u.body) + ACCENT[w];
          i = u.next;
          continue;
        }
      }
      out += s[i];
      i++;
    }
    return out;
  }

  function toUnicodeMath(src) {
    var s = ' ' + String(src == null ? '' : src) + ' ';
    s = s.replace(/\\(?:left|right|bigg?[lr]?|Bigg?[lr]?)/g, '');
    s = s.replace(/\\(?:begin|end)\s*\{[^}]*\}/g, ' ');
    s = s.replace(/\\hline|\\newline|\\displaystyle|\\textstyle|\\limits/g, ' ');
    // \( … \) 是另一套"这里开始是公式"的写法，折完之后那两对字符没意义
    s = s.replace(/\\\(/g, ' ').replace(/\\\)/g, ' ');
    // \% \_ \{ 这些先占住，免得下面几趟把转义的那个字符当结构处理
    s = s.replace(/\\([%&#_{}$\\])/g, ESC + '$1');
    s = s.replace(/\\(?:[,:;!]|\s)/g, ' ');
    s = s.replace(/\\(?:quad|qquad)(?![A-Za-z])/g, ' ');
    s = expand(s);
    // 45^\circ 那个是"度"，不是复合算符 ∘；只有紧跟在数字后面时才折成度
    s = s.replace(/(\d)\s*\^?\s*\\circ/g, '$1\u00B0');

    s = s.replace(/_\s*\{([^{}]*)\}/g, function (_, x) { return script(x, SUB, SUB_OPEN, SUB_CLOSE); });
    s = s.replace(/\^\s*\{([^{}]*)\}/g, function (_, x) { return script(x, SUP, SUP_OPEN, SUP_CLOSE); });
    s = s.replace(/_(\d)(?!\d)/g, function (_, c) { return SUB[c]; });
    s = s.replace(/\^(\d)(?!\d)/g, function (_, c) { return SUP[c]; });
    s = s.replace(/_([A-Za-z])(?![A-Za-z0-9])/g, function (_, c) { return script(c, SUB, SUB_OPEN, SUB_CLOSE); });
    s = s.replace(/\^([A-Za-z])(?![A-Za-z0-9])/g, function (_, c) { return script(c, SUP, SUP_OPEN, SUP_CLOSE); });
    // 45^° 那个尖号只是写法，屏幕上不该有
    s = s.replace(/\^([^\w\u0001-\u0005])/g, '$1');

    s = s.replace(/\\([A-Za-z]+)/g, function (_, word) {
      if (GREEK[word]) return GREEK[word];
      if (SYM[word]) return SYM[word];
      var low = word.toLowerCase();
      if (GREEK[low]) return GREEK[low];
      if (SYM[low]) return SYM[low];
      // 认不出的控制词留下词面：\vec 比一片空白有用
      return word;
    });

    s = s.replace(JOIN_GREEK, '$1');
    s = s.replace(new RegExp(ESC, 'g'), '');
    s = s.replace(/\s*\/\s*/g, '/');
    // \left( \right) 那两趟会留下括号两边的空格，式子里读起来是断的
    s = s.replace(/\s+([)\]])/g, '$1').replace(/([(\[])\s+/g, '$1');
    s = s.replace(/[{}]/g, '');
    s = s.replace(/\\(?![A-Za-z])/g, '');
    s = s.replace(/ {2,}/g, ' ');
    return s.trim();
  }

  /* 正文里那些没被 $…$ 包住的写法（模型经常直接写 v_x、x^2、H_2O，甚至整段 \frac 都不包）：
     只折公式这一小件事。snake_case 那种后面还跟着字母的不折，免得把英文单词啃了；
     要不要整段按公式折，得先认出这是一个我们认识的 TeX 词——
     不然 "C:\Users\m" 那种路径也会被啃掉 */
  var TEX_WORDS = Object.keys(GREEK).concat(Object.keys(SYM), Object.keys(ACCENT), Object.keys(TEXTISH), [
    'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'left', 'right', 'begin', 'end',
    'quad', 'qquad', 'limits', 'displaystyle', 'newline', 'hline'
  ]);
  var TEX_WORD = new RegExp('\\\\(?:' + TEX_WORDS.join('|') + ')(?![A-Za-z])');

  function foldPlain(text) {
    var s = String(text == null ? '' : text);
    var hasTex = TEX_WORD.test(s);
    if (s.indexOf('_') < 0 && s.indexOf('^') < 0 && !hasTex) return s;
    if (hasTex) {
      // 前后那点空格要留着：两段 run 之间少了它，屏幕上就是两个词粘在一起
      var lead = /^\s*/.exec(s)[0];
      var tail = /\s*$/.exec(s)[0];
      return lead + toUnicodeMath(s) + tail;
    }
    s = s.replace(/_\s*\{([^{}]*)\}/g, function (_, x) { return script(x, SUB, SUB_OPEN, SUB_CLOSE); });
    s = s.replace(/\^\s*\{([^{}]*)\}/g, function (_, x) { return script(x, SUP, SUP_OPEN, SUP_CLOSE); });
    s = s.replace(/_(\d)(?!\d)/g, function (_, c) { return SUB[c]; });
    s = s.replace(/\^(\d)(?!\d)/g, function (_, c) { return SUP[c]; });
    s = s.replace(/_([A-Za-z])(?![A-Za-z0-9])/g, function (_, c) { return script(c, SUB, SUB_OPEN, SUB_CLOSE); });
    s = s.replace(/\^([A-Za-z])(?![A-Za-z0-9])/g, function (_, c) { return script(c, SUP, SUP_OPEN, SUP_CLOSE); });
    s = s.replace(/\^([^\w\u0002-\u0005])/g, '$1');
    return s;
  }

  /* 私用字符在这里换成真的 <sub>／<sup>；没配对的直接丢，不许留成空白方块 */
  function mathNodes(doc, str) {
    var frag = doc.createDocumentFragment();
    var s = String(str == null ? '' : str);
    var buf = '';
    var mode = '';
    function flush() {
      if (!buf) return;
      if (mode) {
        var el = doc.createElement(mode);
        el.textContent = buf;
        frag.appendChild(el);
      } else {
        frag.appendChild(doc.createTextNode(buf));
      }
      buf = '';
    }
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === SUB_OPEN || c === SUP_OPEN) { flush(); mode = c === SUB_OPEN ? 'sub' : 'sup'; continue; }
      if (c === SUB_CLOSE || c === SUP_CLOSE) { flush(); mode = ''; continue; }
      if (c === ESC) continue;
      buf += c;
    }
    flush();
    return frag;
  }

  // TeX 里控制词后面那一个空格是"词尾"，不是要印出来的空格：\omega t 读作 ωt。
    // 只对希腊字母这么折，算符（× ÷ ±）两边的空格留着才数得清。
  function classOf(table) {
    var seen = {};
    var out = '';
    Object.keys(table).forEach(function (k) {
      var v = table[k];
      if (seen[v]) return;
      seen[v] = 1;
      out += /[[\\\]\^-]/.test(v) ? '\\' + v : v;
    });
    return out;
  }

  var JOIN_GREEK = new RegExp('([' + classOf(GREEK) + '])[ \t]+(?=[A-Za-z0-9(])', 'g');

  /* ==== 挂成节点 ==== */

  function runsToNodes(doc, runs, ctx) {
    var frag = doc.createDocumentFragment();
    (runs || []).forEach(function (r) {
      if (r.t === 'br') { frag.appendChild(doc.createElement('br')); return; }
      if (r.t === 'text') { frag.appendChild(mathNodes(doc, foldPlain(r.v))); return; }
      if (r.t === 'a') {
        if (!r.href) { frag.appendChild(doc.createTextNode(r.v)); return; }
        var a = doc.createElement('a');
        a.className = 'mcx-f-link';
        a.href = r.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = r.v;
        frag.appendChild(a);
        return;
      }
      if (r.t === 'cite') {
        var known = ctx && ctx.cite ? ctx.cite(r.v) : null;
        if (!known) { frag.appendChild(doc.createTextNode('[' + r.v + ']')); return; }
        frag.appendChild(citeNode(doc, r.v, known));
        return;
      }
      var tag = r.t === 'math' ? 'span' : (r.t === 'i' ? 'em' : (r.t === 'del' ? 's' : 'span'));
      var el = doc.createElement(tag);
      var cls = { b: 'mcx-f-b', i: 'mcx-f-i', code: 'mcx-f-code', del: 'mcx-f-del', math: 'mcx-f-math' }[r.t] || '';
      if (cls) el.className = cls;
      if (r.t === 'math') el.appendChild(mathNodes(doc, toUnicodeMath(r.v)));
      else el.textContent = r.v;
      frag.appendChild(el);
    });
    return frag;
  }

  function citeNode(doc, tag, info) {
    var url = info.url && /^(https?:)?\/\//i.test(info.url) ? info.url : '';
    var node = doc.createElement(url ? 'a' : 'span');
    node.className = 'mcx-f-cite';
    if (url) {
      node.href = url;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    node.title = info.title || tag;
    node.textContent = tag;
    return node;
  }

  function blockNode(doc, b, ctx) {
    var el;
    switch (b.t) {
      case 'h':
        el = doc.createElement(b.lvl >= 3 ? 'h4' : (b.lvl === 2 ? 'h3' : 'h2'));
        el.className = 'mcx-f-h mcx-f-h' + b.lvl;
        el.appendChild(runsToNodes(doc, b.v, ctx));
        return el;
      case 'p':
        el = doc.createElement('p');
        el.className = 'mcx-f-p';
        b.lines.forEach(function (runs, n) {
          if (n) el.appendChild(doc.createElement('br'));
          el.appendChild(runsToNodes(doc, runs, ctx));
        });
        return el;
      case 'ul':
      case 'ol':
        el = doc.createElement(b.t);
        el.className = 'mcx-f-list ' + (b.t === 'ol' ? 'mcx-f-olist' : 'mcx-f-ulist');
        b.items.forEach(function (it) {
          var li = doc.createElement('li');
          li.appendChild(runsToNodes(doc, it.runs, ctx));
          (it.sub || []).forEach(function (sub) {
            var sn = blockNode(doc, sub, ctx);
            if (sn) li.appendChild(sn);
          });
          el.appendChild(li);
        });
        return el;
      case 'quote':
        el = doc.createElement('blockquote');
        el.className = 'mcx-f-quote';
        (b.blocks || []).forEach(function (inner) {
          var child = blockNode(doc, inner, ctx);
          if (child) el.appendChild(child);
        });
        return el;
      case 'pre':
        el = doc.createElement('pre');
        el.className = 'mcx-f-pre';
        el.textContent = b.v;
        return el;
      case 'dmath':
        el = doc.createElement('div');
        el.className = 'mcx-f-dmath';
        el.appendChild(mathNodes(doc, toUnicodeMath(b.v)));
        return el;
      case 'gap':
        el = doc.createElement('div');
        el.className = 'mcx-f-gap';
        return el;
      case 'table':
        var wrap = doc.createElement('div');
        wrap.className = 'mcx-f-tablewrap';
        var table = doc.createElement('table');
        table.className = 'mcx-f-table';
        var thead = doc.createElement('thead');
        var hr = doc.createElement('tr');
        (b.head || []).forEach(function (runs) {
          var th = doc.createElement('th');
          th.appendChild(runsToNodes(doc, runs, ctx));
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = doc.createElement('tbody');
        (b.rows || []).forEach(function (row) {
          var tr = doc.createElement('tr');
          row.forEach(function (runs) {
            var td = doc.createElement('td');
            td.appendChild(runsToNodes(doc, runs, ctx));
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
      default:
        return null;
    }
  }

  function mount(doc, blocks, ctx) {
    var frag = doc.createDocumentFragment();
    (blocks || []).forEach(function (b) {
      var node = blockNode(doc, b, ctx);
      if (node) frag.appendChild(node);
    });
    return frag;
  }

  function render(el, text, ctx) {
    var doc = el.ownerDocument || document;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(mount(doc, parse(text), ctx));
  }

  window.MCxFormat = {
    parse: parse,
    inline: inline,
    toUnicodeMath: toUnicodeMath,
    mount: mount,
    render: render
  };
})();
