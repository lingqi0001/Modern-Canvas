/* Inbox AI: the quick summary and the things buried inside a message.

   One request answers both, because a long email costs the same read either way and a second
   call would ask the model to work out what it just worked out. The reply is a block of tagged
   lines rather than JSON: a truncated JSON array still parses into half a list and looks like
   success, while a line format only loses the lines that never arrived.

   What leaves this browser: the subject and the message text of the one conversation he opened,
   to the provider he typed into Settings. Nothing runs in the background, and a message he never
   opens is never sent anywhere.

   The only thing that writes to Canvas is the Create button on the confirm card, which shows the
   exact title and date before anything is sent, then asks Canvas for that item by id to prove it
   landed. */
(function () {
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

  var KEY = 'mc_inbox_ai';
  var CACHE_KEY = 'mc_inbox_ai_v1';
  var AUTO_WORDS = 150;
  /* 6000 characters is about 1700 tokens of message. A summary in thirty words does not need a
     whole marketing blast, and this number is what you are paying for. */
  var MAX_CHARS = 6000;
  var CACHE_CAP = 200;
  var LOG = '[MCX inbox ai]';

  var host = null;

  /* Per conversation view. Everything the plate draws comes from here, because paintPane()
     rebuilds the whole column and state left in the DOM would be gone on the next repaint. */
  var A = {
    conv: 0,
    sig: '',
    rec: null,
    text: '',
    words: 0,
    busy: false,
    err: '',
    confirm: -1,
    /* Which of the two Canvas kinds the open card is aimed at. It is state rather than a class
       on the button, because anything that repaints the column would otherwise silently drop
       the choice he just made. */
    kind: 'todo',
    addBusy: false,
    addErr: '',
    intent: 'answer',
    tone: 'formal',
    /* null, not 50: the number that means "playful but how much" is decided once in ai-client.js,
       and this file runs before that one so it cannot read it at start-up. */
    playful: null,
    /* Typed into the picker. It has to live here rather than only in the input, because pressing
       an intent pill repaints the whole column and would otherwise eat what he just typed. */
    note: '',
    /* '' | picker | waiting | ready. Three screens, one field, because the wait and the result
       are not the same thing as the form and cannot share a boolean with it. */
    stage: '',
    shownConfirm: -1,
    /* Bumped by Cancel so a response that is already on the wire has nowhere to land. */
    replyGen: 0,
    replaced: '',
    hadText: false,
    replyErr: '',
    draft: '',
    /* Every reply attempt on this message, oldest first: pressing Regenerate adds a term to the
       sum instead of replacing the number, which is what made the second draft look free. */
    replyCalls: [],
    studyBusy: false,
    studyErr: '',
    studyNote: '',
    showDetails: false
  };

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
    });
  }

  /* AI 总开关排在最前面：它关掉时，摘要那块板、回信那一屏、点开消息自动跑的那一趟
     一起没有（画面上的入口和背后的请求都断在这里，不是只藏起来）。
     这一颗被 inbox-list.js 当成唯一的判据用（ai() 那一颗），所以只改这里一处就够。 */
  function on() {
    return (!window.mcAiOn || window.mcAiOn()) && localStorage.getItem(KEY) !== '0';
  }

  /* ---------- local cache ---------- */

  function cacheAll() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return {}; }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function cacheWrite(map) {
    var keys = Object.keys(map);
    if (keys.length > CACHE_CAP) {
      keys.sort(function (a, b) {
        return ((map[a] && map[a].at) || 0) - ((map[b] && map[b].at) || 0);
      });
      for (var i = 0; i < keys.length - CACHE_CAP; i++) delete map[keys[i]];
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(map));
      return true;
    } catch (e) {
      log('the browser would not take the summary cache, this one was not kept');
      return false;
    }
  }

  function cacheGet(convId) {
    var hit = cacheAll()[String(convId)];
    if (!hit || typeof hit !== 'object') return null;
    if (!Array.isArray(hit.dos)) return null;
    if (!hit.added || typeof hit.added !== 'object') hit.added = {};
    return hit;
  }

  function cachePut(convId, rec) {
    var map = cacheAll();
    map[String(convId)] = rec;
    cacheWrite(map);
  }

  function cacheDrop(convId) {
    var map = cacheAll();
    if (!map[String(convId)]) return;
    delete map[String(convId)];
    cacheWrite(map);
  }

  /* A summary belongs to the text it was read from. Once another reply lands in the thread the
     old answer describes less than what is on screen, so the signature covers every body. */
  function hash(str) {
    var h = 0x811c9dc5;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16);
  }

  function plainOf(body) {
    if (window.MCxData && window.MCxData.htmlToText) {
      try { return String(window.MCxData.htmlToText(body) || ''); } catch (e) {}
    }
    return String(body || '').replace(/<[^>]*>/g, ' ');
  }

  function nameOf(d, id) {
    if (host && host.nameOf) return host.nameOf(d, id);
    return '';
  }

  /* Canvas hands the array back newest first, and the newest message is the one worth reading, so
     the budget is spent from that end. It used to walk oldest first and stop when it ran out,
     which threw away exactly the part that mattered and kept the greeting from three weeks ago. */
  function threadText(d) {
    var msgs = d.messages || [];
    var keep = [];
    var cut = 0;
    var dropped = 0;
    for (var i = 0; i < msgs.length; i++) {
      var who = nameOf(d, msgs[i].author_id) || 'Someone';
      var chunk = who + ': ' + plainOf(msgs[i].body).trim();
      if (keep.length && cut + chunk.length > MAX_CHARS) {
        dropped = msgs.length - keep.length;
        break;
      }
      cut += chunk.length;
      keep.push(chunk);
    }
    keep.reverse();
    var head = dropped
      ? dropped + (dropped === 1 ? ' older message is' : ' older messages are') + ' left out because the thread is long.\n\n'
      : '';
    return head + keep.join('\n\n');
  }

  function wordCount(s) {
    var t = String(s || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function signature(d) {
    var parts = [String(d.subject || '')];
    var msgs = d.messages || [];
    for (var i = 0; i < msgs.length; i++) parts.push(msgs[i].id + '|' + plainOf(msgs[i].body));
    return hash(parts.join('\n'));
  }

  /* ---------- the reply we asked for ---------- */

  var TAGS = {
    SUMMARY: 'summary',
    DO: 'dos',
    TODO: 'dos',
    ACTION: 'dos',
    DATE: 'dates',
    CHANGE: 'changes',
    NOTE: 'notes',
    IMPORTANT: 'notes'
  };

  /* 只有标题才立首字母：找出第一个字母，把它大写，其余一个字符都不动。
     开头是数字或符号（"10/7 due"、"#3 the lab"）就原样留着 */
  function capFirst(s) {
    var text = String(s || '');
    var m = /^[^\p{L}]*/u.exec(text);
    if (!m) return text;
    var i = m[0].length;
    if (i >= text.length) return text;
    return text.slice(0, i) + text.charAt(i).toUpperCase() + text.slice(i + 1);
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/^[\s"']+|[\s"']+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }

  /* Only a real calendar date may pre-fill the Create card. Anything the model wrote in words
     stays as words, because inventing a day for "soon" would put a wrong date in his Calendar. */
  function isoOf(s) {
    var t = clean(s);
    if (!t) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var now = new Date();
    var curYear = now.getFullYear();

    // 1. YYYY-MM-DD or YYYY/MM/DD
    var mIso = /(?:^|[^\d])(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(?!\d)/.exec(t);
    if (mIso) {
      var y = Number(mIso[1]), mo = Number(mIso[2]), da = Number(mIso[3]);
      var probe = new Date(y, mo - 1, da);
      if (probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === da) {
        return y + '-' + p(mo) + '-' + p(da);
      }
    }

    // 2. MM/DD/YYYY or M/D/YY
    var mFull = /(?:^|[^\d])(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])[-/.](20\d{2}|\d{2})(?!\d)/.exec(t);
    if (mFull) {
      var yr = Number(mFull[3]);
      if (yr < 100) yr += 2000;
      var mo2 = Number(mFull[1]), da2 = Number(mFull[2]);
      var pr2 = new Date(yr, mo2 - 1, da2);
      if (pr2.getFullYear() === yr && pr2.getMonth() === mo2 - 1 && pr2.getDate() === da2) {
        return yr + '-' + p(mo2) + '-' + p(da2);
      }
    }

    // 3. M/D or MM/DD (e.g. 10/8 or 10-8)
    var mSlash = /(?:^|[^\d])(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(?!\d)/.exec(t);
    if (mSlash) {
      var mo3 = Number(mSlash[1]), da3 = Number(mSlash[2]);
      var yr3 = curYear;
      var pr3 = new Date(yr3, mo3 - 1, da3);
      if (pr3.getMonth() === mo3 - 1 && pr3.getDate() === da3) {
        return yr3 + '-' + p(mo3) + '-' + p(da3);
      }
    }

    // 4. Month name: Oct 8, October 8, Oct 8th, October 8, 2026
    var mText = /(?:^|[^\w])(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i.exec(t);
    if (mText) {
      var monthStr = mText[1];
      var dayNum = Number(mText[2]);
      var yrNum = mText[3] ? Number(mText[3]) : curYear;
      var mIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
        .indexOf(monthStr.slice(0, 3).toLowerCase()) + 1;
      if (mIdx >= 1 && dayNum >= 1 && dayNum <= 31) {
        return yrNum + '-' + p(mIdx) + '-' + p(dayNum);
      }
    }

    // 5. Day Month: 8 Oct, 8th October 2026
    var mDayText = /(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?(?:,?\s+(20\d{2}))?/i.exec(t);
    if (mDayText) {
      var dNum = Number(mDayText[1]);
      var mStr = mDayText[2];
      var yNum = mDayText[3] ? Number(mDayText[3]) : curYear;
      var mIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
        .indexOf(mStr.slice(0, 3).toLowerCase()) + 1;
      if (mIndex >= 1 && dNum >= 1 && dNum <= 31) {
        return yNum + '-' + p(mIndex) + '-' + p(dNum);
      }
    }

    return '';
  }

  function prettyDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    try {
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return m[1] + '-' + m[2] + '-' + m[3];
    }
  }

  function fields(line) {
    var parts = String(line || '').split('|');
    var out = [];
    for (var i = 0; i < parts.length; i++) out.push(clean(parts[i]));
    return out;
  }

  function parseBlock(text) {
    var out = { summary: '', dos: [], dates: [], changes: [], notes: [] };
    var lines = String(text || '').split(/\r?\n/);
    var inSummary = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^[\s>#*-]+/, '').trim();
      if (!line) { inSummary = false; continue; }
      var m = /^([A-Za-z]{2,9})\s*[:：]\s*([\s\S]*)$/.exec(line);
      var tag = m ? String(TAGS[m[1].toUpperCase()] || '') : '';
      if (m && !tag) { inSummary = false; continue; }
      var body = clean(m ? m[2] : line);
      if (!body) continue;
      if (!m) {
        /* A record that ran onto the next line. Only the summary collects it. Appending a second
           task onto the first would glue two separate jobs into one line. */
        if (inSummary) out.summary = clean(out.summary + ' ' + body);
        continue;
      }
      inSummary = tag === 'summary';
      if (tag === 'summary') {
        out.summary = clean((out.summary ? out.summary + ' ' : '') + body);
        continue;
      }
      if (tag === 'dos') {
        var f = fields(body);
        if (!f[0]) continue;
        /* 标题那一行只把首字母立起来。模型回的是句子，开头常是小写（实测他那一封
           "submit Hypothesis Assignment Part 1: Writing"），但提示词里不许写"给我大写"——
           要求模型改写法会把别的行也带歪。只动第一个字母，其余原样，
           副行（日期·课名）和 What changed / Worth knowing 那些说明句一律不碰 */
        out.dos.push({ text: capFirst(f[0]), iso: isoOf(f[1]), when: f[1] && !isoOf(f[1]) ? f[1] : '', course: f[2] || '' });
        continue;
      }
      if (tag === 'dates') {
        var g = fields(body);
        if (!g[0]) continue;
        out.dates.push({ text: capFirst(g[1] || g[0]), raw: g[0], iso: isoOf(g[0]) });
        continue;
      }
      var bucket = tag === 'changes' ? out.changes : out.notes;
      if (bucket.length < 8) bucket.push(capFirst(body));
    }
    if (out.dos.length > 8) out.dos.length = 8;
    if (out.dates.length > 8) out.dates.length = 8;
    return out;
  }

  /* ---------- the request ---------- */

  function today() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function systemPrompt() {
    return [
      'You read one Canvas Instructure conversation between a student and teachers or classmates.',
      'Work only from the text you are given. Never invent a name, a date, a link or a requirement that is not written there.',
      'Answer in English as plain text. Every line must start with one of these tags and nothing else.',
      'SUMMARY: what this message is about, in 30 words or fewer. No greeting and no sign off.',
      'DO: one thing the student has to do. Write it as: what to do | due date | course. The due date must read YYYY-MM-DD, or a single dash when the message gives none. Use a single dash for the course when the message does not name one.',
      'DATE: a date the message mentions that is not itself a task. Write it as: date as written | what happens then.',
      'CHANGE: something the teacher changed about a requirement. Write it as: what changed.',
      'NOTE: important information worth keeping, such as a room, a policy or what a link is for. Write it as: the information.',
      'Rules.',
      'Only write a line the message actually supports. If nothing matches a tag, leave that tag out entirely.',
      'If the message asks for nothing, reply with only a SUMMARY line.',
      'Keep every record on one line and under 25 words.',
      'Never write markdown, bullet characters or a heading.',
      'Today is ' + today() + '. Use that only to turn a written date such as next Friday into YYYY-MM-DD.'
    ].join('\n');
  }

  function userPrompt(d) {
    return [
      'Subject: ' + (d.subject || '(no subject)'),
      'Course: ' + (d.context_name || 'not stated'),
      '',
      'The thread, oldest message first.',
      A.text
    ].join('\n');
  }

  /* 这一屏没有选择器，所以它读的就是 Flash 那一档；那一档没配时 ai-client 自己退到 Advanced。
     两档都空着才回 null，那时下面那两句会说清楚缺的是哪一档 */
  function autoRoute() {
    if (!window.MCxAi) return Promise.resolve(null);
    var chain = null;
    try { chain = window.MCxAi.load ? window.MCxAi.load() : null; } catch (e) {}
    return Promise.resolve(chain || {}).then(function () {
      var cfg = null;
      try { cfg = window.MCxAi.config('flash'); } catch (e) { return null; }
      var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
      if (isCloud) {
        if (window.MCxAi.isUserLoggedIn && !window.MCxAi.isUserLoggedIn() && (!cfg || !cfg.key)) return null;
        return cfg;
      }
      return cfg && cfg.key ? cfg : null;
    }, function () {
      var cfg = null;
      try { cfg = window.MCxAi.config('flash'); } catch (e) { return null; }
      var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
      if (isCloud) {
        if (window.MCxAi.isUserLoggedIn && !window.MCxAi.isUserLoggedIn() && (!cfg || !cfg.key)) return null;
        return cfg;
      }
      return cfg && cfg.key ? cfg : null;
    });
  }

  function summarize(d, manual) {
    if (A.busy) return;
    var sig = A.sig;
    var isCloud = (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode());
    var loggedIn = (window.MCxAi && window.MCxAi.isUserLoggedIn && window.MCxAi.isUserLoggedIn());
    if (isCloud && !loggedIn) {
      if (manual) {
        A.err = 'Starting Google sign-in…';
        repaint();
        if (window.MCxAi && window.MCxAi.loginWithGoogle) {
          window.MCxAi.loginWithGoogle(function (err) {
            if (err) {
              A.err = 'Sign-in was cancelled. Try again to use AI summaries.';
              repaint();
            } else {
              A.err = '';
              repaint();
              summarize(d, true);
            }
          });
        }
      }
      return;
    }
    A.busy = true;
    A.err = '';
    A.confirm = -1;
    repaint();
    autoRoute().then(function (cfg) {
      if (!cfg) {
        if (sig !== A.sig) return;
        A.busy = false;
        A.err = 'No key yet. Pick a model for Flash or Advanced under AI & Plans in Settings.';
        repaint();
        return;
      }
      var text = userPrompt(d);
      var est = window.MCxData && window.MCxData.estimateTokens ? window.MCxData.estimateTokens(text.length) : 0;
      /* Runs already on this thread carry over: a re-run is the second term of the same sum,
         not a replacement for the first, which is what made pressing Generate again look free. */
      var runs = recUses(A.rec && A.rec.sig === sig ? A.rec : null).slice(0);
      /* Streamed on purpose. The non streaming branch reads exactly one field and comes back an
         empty string when it is not there, which is what "no text at all" was. This one shows the
         start of the reply when nothing arrives, and it is the same path the panel answers with. */
      /* No max_tokens on purpose. A cap is a silent truncation: the model that thinks before it
         answers spends the budget on thinking and comes back with an empty answer, and the one
         that runs long stops mid sentence with no error anywhere. */
      var poolUsed = false;
      return window.MCxAi.send({
        profile: cfg.id,
        feature: 'Inbox summary',
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: text }],
        onPoolUsed: function (val) { poolUsed = !!val; },
        onDelta: function () {},
        onUsage: function (u, key) { runs = window.MCxAi.usageTrack(runs, u, key); }
      }).then(function (raw) {
        A.busy = false;
        if (sig !== A.sig) return;
        var got = parseBlock(raw);
        if (!got.summary && !got.dos.length && !got.dates.length && !got.changes.length && !got.notes.length) {
          A.err = 'The model answered with nothing we could read. It sent: ' +
            (String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'no text at all');
          repaint();
          return;
        }
        A.rec = {
          sig: sig,
          at: Date.now(),
          model: cfg.model || '',
          sent: est,
          poolUsed: poolUsed,
          /* Every run on this thread, oldest first, with the numbers the provider sent back for
             it. The split inside each run stays: total alone cannot tell you whether we sent too
             much or the model answered too much, and those two have opposite fixes. */
          uses: runs.map(function (r) { return r && r.usage ? r.usage : r; }),
          summary: got.summary,
          dos: got.dos,
          dates: got.dates,
          changes: got.changes,
          notes: got.notes,
          added: {}
        };
        cachePut(A.conv, A.rec);
        repaint();
      }, function (err) {
        A.busy = false;
        if (sig !== A.sig) return;
        var info = null;
        try { info = window.MCxAi.describeError(err, cfg); } catch (e) {}
        A.err = String((info && info.text) || (err && err.message) || 'The request failed.');
        log(manual ? 'a pressed run failed' : 'the automatic run failed', A.err);
        repaint();
      });
    }, function () {
      A.busy = false;
      if (sig !== A.sig) return;
      A.err = 'The AI settings could not be read.';
      repaint();
    /* Anything that throws on the way through, including the provider client itself, has to end
       up on screen rather than as an error nobody is holding. */
    }).catch(function (err) {
      A.busy = false;
      if (sig !== A.sig) return;
      A.err = 'The request broke before it finished. ' + String((err && err.message) || err);
      repaint();
    });
  }

  /* ---------- writing to Canvas ---------- */

  function qs(pairs) {
    return pairs.map(function (kv) {
      return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
    }).join('&');
  }

  /* These two endpoints are read from the query string. A form body has been accepted by Canvas
     with a 200 that changed nothing, so the body stays empty and the answer is checked by id. */
  function postQuery(url, pairs) {
    return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + qs(pairs), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': host.csrf(), Accept: 'application/json' }
    }).then(function (r) {
      return r.text().then(function (t) { return { ok: r.ok, st: r.status, t: t }; });
    });
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function why(t) {
    var d = parseJson(t);
    if (d && d.errors) return d.errors.map(function (e) { return e.message || String(e); }).join(' ').slice(0, 160);
    if (d && d.error) return String(d.error).slice(0, 160);
    return String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  /* 任务行用数字键（缓存里那些老记录就是数字），日期行用 d0／r1 这种字符串键。
     两边都从属性里读出来是字符串，所以数字要先转回去，不然 `A.confirm === i` 当场不认。 */
  function rowKey(raw) {
    var s = String(raw == null ? '' : raw);
    return /^\d+$/.test(s) ? Number(s) : s;
  }

  function createItem(d, idx, form) {
    if (A.addBusy) return;
    var title = String(form.title || '').trim();
    var date = String(form.date || '').trim();
    if (!title) { A.addErr = 'Write what it is first.'; repaint(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { A.addErr = 'Pick a date first. Canvas needs one.'; repaint(); return; }
    A.addBusy = true;
    A.addErr = '';
    repaint();
    var from = 'Added by Modern Canvas from a message titled ' + (d.subject || 'untitled');
    var isEvent = form.kind === 'event';
    var url = isEvent ? '/api/v1/users/self/calendar_events' : '/api/v1/users/self/planner_notes';
    var pairs = isEvent
      ? [['event[title]', title], ['event[event_type]', 'event'], ['event[workflow_state]', 'published'],
        ['event[start_at]', date + 'T09:00:00Z'], ['event[end_at]', date + 'T09:30:00Z'], ['event[description]', from]]
      : [['note[title]', title], ['note[todo_date]', date + 'T23:59:59Z'], ['note[notes]', from]];

    /* One catch at the very end, on purpose. A rejection raised inside the first handler is not
       seen by the rejection handler sitting on the same then(), so it would escape as an error
       nobody showed: the card would just sit there with the spinner stopped. */
    postQuery(url, pairs).then(function (o) {
      var made = o.ok ? parseJson(o.t) : null;
      if (!made || !made.id) {
        throw new Error(o.ok ? 'Canvas did not hand back an id' : (why(o.t) || ('HTTP ' + o.st)));
      }
      var back = isEvent
        ? getJson('/api/v1/calendar_events/' + made.id)
        : getJson('/api/v1/planner_notes/' + made.id);
      return back.then(function (fresh) {
        if (!fresh || !fresh.id) {
          /* Canvas said it made one and then would not show it to us. Say both rather than
             picking a side, and do not let him assume a second press is safe. */
          A.addBusy = false;
          A.addErr = 'Canvas answered but would not show us the ' + (isEvent ? 'event' : 'to do') +
            ' afterwards. Look in the Calendar before making another one.';
          repaint();
          return;
        }
        A.addBusy = false;
        A.confirm = -1;
        if (A.rec) {
          A.rec.added = A.rec.added || {};
          A.rec.added[idx] = { kind: form.kind, id: fresh.id, title: fresh.title || title };
          cachePut(A.conv, A.rec);
        }
        log('created', form.kind, fresh.id);
        repaint();
      });
    }).catch(function (err) {
      A.addBusy = false;
      A.addErr = 'Canvas refused it. Nothing was created. ' + String((err && err.message) || err);
      repaint();
    });
  }

  /* ---------- the study panel ---------- */

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* 4 means one name sits inside the other, which is a real match. 2 means only two long words
     agree, which is worth offering but has to be labelled as a guess. */
  function bestTask(rows, wanted) {
    var keys = [];
    for (var i = 0; i < wanted.length; i++) {
      var n = norm(wanted[i]);
      if (n.length > 2) keys.push(n);
    }
    if (!keys.length) return null;
    var best = null;
    var tasks = rows || [];
    for (var t = 0; t < tasks.length; t++) {
      var name = norm(tasks[t].name);
      if (!name) continue;
      var score = 0;
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (name === key) score = Math.max(score, 6);
        else if (name.indexOf(key) >= 0 || key.indexOf(name) >= 0) score = Math.max(score, 4);
        else {
          var shared = 0;
          var a = name.split(' ');
          var b = key.split(' ');
          for (var x = 0; x < a.length; x++) {
            if (a[x].length >= 4 && b.indexOf(a[x]) >= 0) shared++;
          }
          if (shared >= 2) score = Math.max(score, 2);
        }
      }
      if (score >= 2 && (!best || score > best.score)) best = { task: tasks[t], score: score };
    }
    return best;
  }

  /* 那一格写的是课名。模型抄的是它在正文里看到的那一串官方全名，而用户可能在设置里
     给这门课起过短名（Canvas 存成 course nickname，但它的接口在 context_name 里仍回全名，
     实测 2026-10-13）。
     顺序不能反：模型写出来的那个名字可能不是本会话那门课（信里提到别的课的截止日期），
     拿本会话的课号去顶替它就张冠李戴了。所以写着名字时只按名字对表；
     它没写课名才退回本会话那门课，那时课号才是自己的。 */
  function courseLabelOf(d, fallback) {
    var api = window.MCxData;
    var text = String(fallback || '');
    if (!api || !api.courseLabel) return text;
    if (text) return api.courseLabel(text, '');
    return api.courseLabel(String(d.context_name || ''), courseIdOf(d));
  }

  function courseIdOf(d) {
    var m = /^course_(\d+)$/.exec(String(d.context_code || ''));
    return m ? Number(m[1]) : 0;
  }

  function openStudy(d, line, mode) {
    if (A.studyBusy) return;
    var cid = courseIdOf(d);
    if (!cid) {
      A.studyErr = 'This message is not filed under one course, so there is no material list to open.';
      repaint();
      return;
    }
    if (!window.MCxStudy || !window.MCxData) {
      A.studyErr = 'The Study With AI panel is not available on this page.';
      repaint();
      return;
    }
    A.studyBusy = true;
    A.studyErr = '';
    A.studyNote = '';
    repaint();
    var wanted = [];
    if (line) wanted.push(line.text);
    if (d.subject) wanted.push(d.subject);
    window.MCxData.tasks(cid).then(function (rows) {
      var hit = bestTask(rows || [], wanted);
      A.studyBusy = false;
      var opts = { pane: mode === 'ask' ? 'ask' : 'resources' };
      if (hit) {
        opts.pickTaskId = hit.task.id;
        if (hit.score < 4) A.studyNote = 'Ticked the closest name in this course, which is ' + hit.task.name + '. Check it before you send anything.';
      } else {
        A.studyNote = 'No task in this course matched what the message called it, so nothing is ticked yet.';
      }
      if (mode === 'ask') {
        var text = line ? line.text : clean(d.subject || '');
        opts.template = /practice|question|revise|test|exam|quiz/i.test(text) ? 'practice' : 'guide';
        opts.extra = 'This came out of a Canvas message: ' + text +
          '. Explain what it means for me and what I should do about it.';
      }
      window.MCxStudy.open(cid, opts);
      repaint();
    }, function (err) {
      A.studyBusy = false;
      A.studyErr = 'The task list of this course could not be read. ' + String((err && err.message) || err);
      repaint();
    });
  }

  /* ---------- AI reply ---------- */

  var INTENTS = [
    ['answer', 'Answer their question'],
    ['confirm', 'Confirm or agree'],
    ['ask', 'Ask a question'],
    ['extend', 'Request more time'],
    ['decline', 'Politely decline'],
    ['thanks', 'Say thank you']
  ];
  /* The four tone names and the five playfulness bands live in ai-client.js, because the other
     writer on this page (the study panel's Ask Your Teacher screen) has to send the same sentences.
     Read at call time, never at start-up: that file is listed after this one. */
  function tones() { return window.MCxAi.tones; }
  function playful() { return window.MCxAi.playfulPct(A.playful, window.MCxAi.playfulDefault); }

  function replyPrompt(d) {
    var intent = INTENTS[0][1];
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i][0] === A.intent) intent = INTENTS[i][1];
    return [
      'I am the student. Write my reply to this Canvas message.',
      'Intent: ' + intent + '.',
      window.MCxAi.tonePrompt(A.tone, playful()),
      A.note ? 'One more thing to work in: ' + A.note + '.' : '',
      'Write in English. Plain text only, no markdown, no subject line, no signature block, nothing in brackets for me to fill in.',
      'Two to five short sentences. Do not repeat back what they already said.',
      'Do not state any fact that is not in the thread.',
      A.rec && A.rec.summary ? 'What the thread is about: ' + A.rec.summary : '',
      '',
      'The thread, oldest first.',
      A.text
    ].filter(function (x) { return x !== ''; }).join('\n');
  }

  function makeReply() {
    if (A.stage === 'waiting') return;
    var d = host.detail();
    if (!d) return;

    var isCloud = (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode());
    var loggedIn = (window.MCxAi && window.MCxAi.isUserLoggedIn && window.MCxAi.isUserLoggedIn());
    if (isCloud && !loggedIn) {
      A.stage = 'picker';
      A.replyErr = 'Starting Google sign-in…';
      repaint();
      if (window.MCxAi && window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            A.replyErr = 'Sign-in was cancelled. Try again to draft a reply.';
            repaint();
          } else {
            A.replyErr = '';
            repaint();
            makeReply();
          }
        });
      }
      return;
    }
    var sig = A.sig;
    var gen = ++A.replyGen;
    /* What is in the box right now is his, not ours. The draft is about to be written over it,
       so it is kept and offered back once, rather than silently eaten. */
    A.replaced = host.draftText ? String(host.draftText() || '') : '';
    A.hadText = !!A.replaced.trim();
    A.stage = 'waiting';
    A.replyErr = '';
    A.draft = '';
    /* A.replyCalls is not cleared here: Regenerate is the second term of the same sum, and
       wiping it is exactly what made the first draft look like it cost nothing. */
    host.writeDraft('');
    repaint();
    /* A late answer has to be dropped on two counts: he moved to another message, or he pressed
       Cancel, which bumps the generation out from under the request already on the wire. */
    function dead() { return sig !== A.sig || gen !== A.replyGen; }

    autoRoute().then(function (cfg) {
      if (!cfg) {
        if (dead()) return;
        A.stage = 'picker';
        A.replyErr = 'No key yet. Pick a model for Flash or Advanced under AI & Plans in Settings.';
        repaint();
        return;
      }
      A.replyPoolUsed = false;
      return window.MCxAi.send({
        profile: cfg.id,
        feature: 'Reply draft',
        messages: [{ role: 'user', content: replyPrompt(d) }],
        onPoolUsed: function (val) {
          if (!dead()) {
            A.replyPoolUsed = !!val;
            repaint();
          }
        },
        onUsage: function (u, key) { if (!dead()) A.replyCalls = window.MCxAi.usageTrack(A.replyCalls, u, key); },
        onDelta: function (piece) {
          if (dead()) return;
          A.draft += String(piece || '');
          /* Written straight into the live box. Repainting per chunk would rebuild the whole
             column every few characters and he would watch it flicker while it writes. */
          host.writeDraft(A.draft);
        }
      }).then(function (text) {
        if (dead()) return;
        var out = String(text || '').trim();
        if (!out) {
          A.stage = 'picker';
          A.replyErr = 'The model sent back no text at all.';
          repaint();
          return;
        }
        A.draft = out;
        A.stage = 'ready';
        host.writeDraft(out);
        repaint();
      }, function (err) {
        if (dead()) return;
        var info = null;
        try { info = window.MCxAi.describeError(err, cfg); } catch (e) {}
        A.stage = 'picker';
        A.replyErr = String((info && info.text) || (err && err.message) || 'The request failed.');
        repaint();
      });
    }, function () {
      if (dead()) return;
      A.stage = 'picker';
      A.replyErr = 'The AI settings could not be read.';
      repaint();
    }).catch(function (err) {
      if (dead()) return;
      A.stage = 'picker';
      A.replyErr = 'The request broke before it finished. ' + String((err && err.message) || err);
      repaint();
    });
  }

  /* ---------- drawing ---------- */

  /* Always through the one painter, and always after stashing what is in the reply box: this
     column is rebuilt from state, so anything he had typed would otherwise vanish the moment a
     button here is pressed. */
  function repaint() {
    if (!host || !host.paintPane) return;
    if (host.saveDraft) host.saveDraft();
    host.paintPane();
  }

  function spin() {
    return '<span class="mcx-inbox-spin"></span>';
  }

  function btn(attr, label, cls) {
    return '<button type="button" class="mcx-inbox-aibtn' + (cls ? ' ' + cls : '') + '" ' + attr + '>' + esc(label) + '</button>';
  }

  var GOOGLE_SVG_STR = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;flex:0 0 auto;">'
    + '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>'
    + '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>'
    + '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>'
    + '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>'
    + '</svg>';

  function errLine(text) {
    if (!text) return '';
    var isUnlogged = /Not signed in yet|sign in with your Google account|AI & Plans|User cancelled sign-in|Sign-in was cancelled|Google sign-in|Please sign in/i.test(String(text));
    var isRed = /User cancelled|failed|error|broke|No key|Please sign in/i.test(String(text));
    var style = 'font-size:12.5px; line-height:1.45; margin-top:9px;' + (isRed ? ' color:#ef4444 !important; font-weight:500;' : '');
    var html = '<div class="mcx-inbox-aicerr" style="' + style + '">' + esc(text);
    if (isUnlogged) {
      html += '<div class="mcx-ai-error-act">'
        + '<button type="button" class="mcx-ai-error-btn" data-ai-auth="google">'
        + GOOGLE_SVG_STR + '<span>Sign in with Google</span></button>'
        + '</div>';
    }
    html += '</div>';
    return html;
  }

  function noteLine(text) {
    return text ? '<div class="mcx-inbox-aiinfo">' + esc(text) + '</div>' : '';
  }

  function headHtml(hasDetails) {
    var has = !!(A.rec && A.sig === A.rec.sig);
    var html = '<div class="mcx-inbox-aihead">' + host.icon('spark') + '<span class="mcx-inbox-ailab">Quick Summary</span>';
    if (A.busy) html += '<span class="mcx-inbox-aiwait">' + spin() + 'Reading the thread</span>';
    else if (has) {
      html += '<span class="mcx-inbox-aihead-acts">';
      if (hasDetails) {
        html += '<button type="button" class="mcx-inbox-aidetails-btn" data-ai-details>' +
          (A.showDetails ? 'Hide details' : 'View details') + '</button>';
      }
      /* Once there is a summary on the card the only thing that button does is throw it away and
         read the thread again, so an arrow is the whole label. Before there is one, a bare arrow
         would be a button whose name you had to guess. */
      html += '<button type="button" class="mcx-inbox-aiicon" data-ai-run aria-label="Summarize again" title="Summarize again">' +
        host.icon('again') + '</button>';
      html += '</span>';
    } else html += btn('data-ai-run', 'Summarize');
    return html + '</div>';
  }

  function rowActions(d, i) {
    var made = A.rec && A.rec.added && A.rec.added[i];
    var html = '<div class="mcx-inbox-aiactions">';
    if (made) {
      html += '<span class="mcx-inbox-adone">' + host.icon('check') +
        (made.kind === 'event' ? 'In your Calendar' : 'In your To Do') + '</span>';
      html += '<a class="mcx-inbox-aalink" href="/calendar">Open Calendar</a>';
    } else {
      html += btn('data-ai-add="' + i + '"', 'Add to Calendar');
    }
    html += btn('data-ai-study="' + i + '"', 'Study this');
    return html + '</div>';
  }

  function confirmHtml(i, line) {
    /* Same reason as the reply panel: pressing To Do against Calendar event repaints this, and the
       card must not fade itself in again just because something inside it was touched. */
    var anim = A.shownConfirm !== i;
    A.shownConfirm = i;
    return '<div class="mcx-inbox-aicard' + (anim ? ' is-new' : '') + '">' +
      '<div class="mcx-inbox-aicardhead">Add To Canvas Calendar</div>' +
      '<label class="mcx-inbox-aifield"><span>What</span>' +
      '<input type="text" class="mcx-inbox-aitxt" data-ai-f="title" value="' + esc(line.text) + '"></label>' +
      '<label class="mcx-inbox-aifield is-date"><span>When</span>' +
      '<input type="date" class="mcx-inbox-aitxt" data-ai-f="date" value="' + esc(line.iso || '') + '"></label>' +
      '<div class="mcx-inbox-aipicks">' +
      '<button type="button" class="mcx-inbox-mode' + (A.kind === 'todo' ? ' on' : '') + '" data-ai-k="todo">To Do, only you see it</button>' +
      '<button type="button" class="mcx-inbox-mode' + (A.kind === 'event' ? ' on' : '') + '" data-ai-k="event">Calendar event</button>' +
      '</div>' +
      (line.iso ? '' : '<div class="mcx-inbox-aihint">The message gave no date we could read, so pick one.</div>') +
      errLine(A.addErr) +
      '<div class="mcx-inbox-aifoot">' +
      btn('data-ai-cancel', 'Cancel') +
      '<button type="button" class="mcx-inbox-aigen' + (A.addBusy ? ' is-busy' : '') + '" data-ai-create="' + i + '">' +
      (A.addBusy ? 'Creating' : 'Create') + '</button>' +
      '</div>' +
      '</div>';
  }

  /* Each kind of thing the AI found gets its own card, with an icon and a count, rather than the
     whole plate being one box with small grey sub-headings inside it. */
  function cardHead(iconName, label, right) {
    return '<div class="mcx-inbox-aihead">' + host.icon(iconName) +
      '<span class="mcx-inbox-ailab">' + esc(label) + '</span>' +
      (right ? '<span class="mcx-inbox-ain">' + esc(right) + '</span>' : '') + '</div>';
  }

  function blockHtml(iconName, label, rows) {
    var html = '<div class="mcx-inbox-ai is-card">' + cardHead(iconName, label);
    for (var i = 0; i < rows.length; i++) html += rows[i];
    return html + '</div>';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  /* "10/14" in the teacher's own words and 2026-10-14 from the model are the same day. Without a
     shared key the merged plate would list it twice, and two lines for one day is exactly the
     thing he points at. Year is left out on purpose: inside one thread a bare month/day is this
     year's, and matching on it is what catches the two spellings. */
  function dayKey(str) {
    var s = String(str || '').trim();
    var mo = 0, d = 0;
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    var num = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s);
    var name = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{1,2})/i.exec(s);
    if (iso) { mo = Number(iso[2]); d = Number(iso[3]); }
    else if (num) { mo = Number(num[1]); d = Number(num[2]); }
    else if (name) {
      mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
        'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name[1].slice(0, 3).toLowerCase()) + 1;
      d = Number(name[2]);
    } else return '';
    if (!mo || mo > 12 || !d || d > 31) return '';
    return mo + '-' + d;
  }

  /* 日期行右侧那颗键和 Things to do 那三行是同一条通路：按下去长出一张确认卡，
     标题预填那件事的名字，日期预填那一天，Create 才真写进 Canvas。
     键名用 d0／d1 这种字符串，和任务行那批数字索引不撞，
     所以以前存进缓存的 added 记录（数字键）照旧认得。 */
  function dateActions(key, made, canAdd) {
    var html = '<div class="mcx-inbox-aiactions">';
    if (made) {
      html += '<span class="mcx-inbox-adone">' + host.icon('check') +
        (made.kind === 'event' ? 'In your Calendar' : 'In your To Do') + '</span>' +
        '<a class="mcx-inbox-aalink" href="/calendar">Open Calendar</a>';
    } else if (canAdd) {
      html += btn('data-ai-add="' + key + '"', 'Add to Calendar');
    } else {
      /* AI 那一档关着的时候创建那条路整个不走（paneClick 第一行就返回），
         这时候给一颗点不动的键不如给回原来那个跳转链接 */
      html += '<a class="mcx-inbox-aipill" href="/calendar">Open Calendar' +
        (host && host.icon ? host.icon('open') : '') + '</a>';
    }
    return html + '</div>';
  }

  /* One renderer for the dates plate, whoever is holding the days: the model's own list, the days
     lifted out of the raw text by the page, or both. The two lists are never drawn twice in one
     column - the page stops calling this with its own copy once the summary is on screen.
     标题＝那件事的名字，日期是副行（他 2026-10-13 拍的，和任务行同一读法）。
     原文扫出来的那些没有名字可给，标题就是那一天。 */
  /* 最后那颗 canAdd 决定这一张给的是"加进日历"还是"打开日历"：只有摘要真在屏上时，
     建成记录才落得进那条会话的缓存（换页回来还认得，不会让他按出第二个）。
     没摘要／AI 关着的时候给链接，不给一颗会重复按的键。 */
  function datesCardHtml(d, aiDates, rawDates, canAdd) {
    var rows = [];
    var seen = {};
    var addRow = function (key, label, iso) {
      var line = { text: label.title, iso: iso || '', course: '' };
      rows.push('<div class="mcx-inbox-airow"><div class="mcx-inbox-aimain">' +
        '<div class="mcx-inbox-aititle">' + esc(label.title) + '</div>' +
        '<div class="mcx-inbox-aimeta">' + esc(label.meta) + '</div>' +
        '</div>' + dateActions(key, A.rec && A.rec.added && A.rec.added[key], canAdd) + '</div>' +
        (canAdd && A.confirm === key ? confirmHtml(key, line) : ''));
    };
    for (var i = 0; i < (aiDates || []).length; i++) {
      var one = aiDates[i];
      var iso = one.iso || isoOf(one.raw);
      var k = dayKey(iso || one.raw);
      if (k) seen[k] = 1;
      addRow('d' + i, { title: capFirst(one.text), meta: iso ? prettyDate(iso) : one.raw }, iso);
    }
    for (var j = 0; j < (rawDates || []).length; j++) {
      var day = String(rawDates[j] || '');
      var iso = isoOf(day);
      var key = dayKey(iso || day);
      if (key && seen[key]) continue;
      if (key) seen[key] = 1;
      var pretty = iso ? prettyDate(iso) : day;
      addRow('r' + j, { title: pretty, meta: 'Date mentioned in the message; it may not be a deadline.' }, iso);
    }
    if (!rows.length) return '';
    return '<div class="mcx-inbox-ai is-card">' +
      cardHead('cal', 'Dates Mentioned') + rows.join('') + '</div>';
  }

  function insightsHtml(d, rawDates) {
    var rec = A.rec;
    var groups = [];
    if (rec.dos.length) {
      var dos = [];
      for (var i = 0; i < rec.dos.length; i++) {
        var line = rec.dos[i];
        var iso = line.iso || isoOf(line.when);
        var meta = [iso ? prettyDate(iso) : line.when, courseLabelOf(d, line.course)].filter(Boolean).join('  ·  ');
        var confLine = { text: line.text, iso: iso, course: line.course };
        dos.push('<div class="mcx-inbox-airow">' +
          '<div class="mcx-inbox-aimain">' +
          '<div class="mcx-inbox-aititle">' + esc(line.text) + '</div>' +
          (meta ? '<div class="mcx-inbox-aimeta">' + esc(meta) + '</div>' : '') +
          '</div>' + rowActions(d, i) + '</div>' +
          (A.confirm === i ? confirmHtml(i, confLine) : ''));
      }
      groups.push(blockHtml('check', 'Things to do', dos));
    }
    if (rec.dates.length || (rawDates || []).length) {
      groups.push(datesCardHtml(d, rec.dates, rawDates, true));
    }
    if (rec.changes.length) {
      var cs = [];
      for (var k = 0; k < rec.changes.length; k++) cs.push('<div class="mcx-inbox-ailine">' + esc(capFirst(rec.changes[k])) + '</div>');
      groups.push(blockHtml('again', 'What changed', cs));
    }
    if (rec.notes.length) {
      var ns = [];
      for (var n = 0; n < rec.notes.length; n++) ns.push('<div class="mcx-inbox-ailine">' + esc(capFirst(rec.notes[n])) + '</div>');
      groups.push(blockHtml('spark', 'Worth knowing', ns));
    }
    if (!groups.length) return '';
    return '<div class="mcx-inbox-ai-wall">' + groups.join('') + '</div>';
  }

  /* ---------- packing the insight wall ----------
     Every plate used to span the whole column while its row only ever filled part of it, so a wide
     column read as one long scroll of mostly empty plates. This hands the same plates to columns.

     The column count is not a width threshold: it is measured. A plate can be narrower than its
     row wants, in which case the action pills fall under their own row and every row grows about
     30-50px, so a third column can end up making the wall TALLER than a second one. Each count
     that physically fits is tried, the resulting wall height is measured, and the shortest wins;
     ties go to more columns, because packing tighter is the point of this. One column means the
     wall stands down and the stylesheet's own vertical flow shows through. */
  var MCW_GAP = 14;
  // Hard floor, not a comfort floor: below this a plate is too narrow to read at all.
  var MCW_MIN = 400;
  var MCW_MAX = 4;
  var mcwPlace = {};
  var mcwPlaceCols = '';

  function wallCards(wall) {
    return [].filter.call(wall.children, function (el) {
      return el.classList.contains('mcx-inbox-ai');
    });
  }

  /* The heading is the plate's identity: the four kinds never repeat inside one wall, and they are
     the one thing on the plate that survives a re-summarize. */
  function wallName(card) {
    var lab = card.querySelector('.mcx-inbox-ailab');
    return lab ? String(lab.textContent) : '?';
  }

  function wallWidthExpr(cols) {
    return cols > 1 ? 'calc((100% - ' + MCW_GAP * (cols - 1) + 'px) / ' + cols + ')' : '';
  }

  function wallApplyWidth(cards, cols) {
    var expr = wallWidthExpr(cols);
    for (var i = 0; i < cards.length; i++) if (cards[i].style.width !== expr) cards[i].style.width = expr;
    return expr;
  }

  function wallHeights(cards) {
    var hs = [];
    for (var i = 0; i < cards.length; i++) hs.push(cards[i].offsetHeight);
    return hs;
  }

  /* The packer, in two moods: with a map it honours the column each plate already lives in, and
     without one it just drops each plate onto the shortest column, which is what the candidate
     heights have to be measured against. */
  function wallPack(cols, hs, names, map) {
    var tops = [];
    for (var c = 0; c < cols; c++) tops.push(0);
    var out = [];
    for (var k = 0; k < hs.length; k++) {
      var col = map ? map[names[k]] : -1;
      if (typeof col !== 'number' || col < 0 || col >= cols) {
        col = 0;
        for (var t = 1; t < cols; t++) if (tops[t] < tops[col] - 0.5) col = t;
      }
      if (map) map[names[k]] = col;
      out.push([k, col, tops[col]]);
      tops[col] += hs[k] + MCW_GAP;
    }
    return { pos: out, h: Math.max.apply(null, tops) - MCW_GAP };
  }

  /* Standing down is a real state, not a skipped frame: a plate left at an old coordinate keeps
     floating over the column with nothing under it. */
  function wallOff(wall, cards) {
    if (wall.hasAttribute('data-mcw')) wall.removeAttribute('data-mcw');
    wall.style.removeProperty('min-height');
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.removeProperty('width');
      cards[i].style.removeProperty('left');
      cards[i].style.removeProperty('top');
    }
    wall.dataset.mcwKey = '';
  }

  function wallLayout(wall) {
    var cards = wallCards(wall);
    if (!cards.length) return;
    var total = wall.clientWidth;
    if (!total) return;
    /* Never more columns than plates: a lone plate shrunk to half the column is dead white space
       with nothing beside it. */
    var maxCols = Math.min(MCW_MAX, cards.length, Math.floor((total + MCW_GAP) / (MCW_MIN + MCW_GAP)));
    var hs0 = wallHeights(cards);
    var key = total + 'x' + maxCols + 'x' + hs0.join('.');
    /* Reading heights is the whole cost, and a resize observer hands this function a frame every
       time a plate rewraps - including the rewarp this function causes. The scan below ends with
       the winning width already applied, so the next frame lands on this check and stops. */
    if (wall.dataset.mcwKey === key && (maxCols < 2 || cards[0].style.top)) return;
    wall.dataset.mcwKey = key;
    if (maxCols < 2) { wallOff(wall, cards); return; }

    var names = cards.map(wallName);
    var chosen;
    if (mcwPlaceCols && Number(mcwPlaceCols) <= maxCols && Number(mcwPlaceCols) >= 1) {
      chosen = Number(mcwPlaceCols);
    } else {
      var best = { cols: 1, h: wallPack(1, hs0, names, null).h };
      for (var cols = 2; cols <= maxCols; cols++) {
        wallApplyWidth(cards, cols);
        var tryH = wallPack(cols, wallHeights(cards), names, null).h;
        if (tryH <= best.h) best = { cols: cols, h: tryH };
      }
      chosen = best.cols;
    }
    wallApplyWidth(cards, chosen);

    /* Which column a plate belongs to is remembered across packs, keyed by the plate's own heading.
       Without it, pressing Add to Calendar grows the first plate past the second column and the
       greedy pass hands the third plate a new column: an unrelated card slides sideways at the
       exact moment he is reading the one he pressed. This lives in the module rather than on the
       node because the column is rebuilt from a string on every repaint, which would wipe a
       dataset value. A different column count is the one case that has to be re-dealt, or the
       right-hand columns would never fill again after 3 became 2. */
    if (mcwPlaceCols !== String(chosen)) { mcwPlace = {}; mcwPlaceCols = String(chosen); }
    var packed = wallPack(chosen, wallHeights(cards), names, mcwPlace);
    var here = {};
    for (var n = 0; n < names.length; n++) here[names[n]] = true;
    for (var gone in mcwPlace) if (!here[gone]) delete mcwPlace[gone];
    wall.setAttribute('data-mcw', '');
    for (var p = 0; p < packed.pos.length; p++) {
      var el = cards[packed.pos[p][0]];
      var col = packed.pos[p][1];
      el.style.left = col ? 'calc(' + col + ' * (100% + ' + MCW_GAP + 'px) / ' + chosen + ')' : '0px';
      el.style.top = Math.round(packed.pos[p][2]) + 'px';
    }
    /* Every plate is out of the flow now, so the wall would collapse onto whatever follows it. */
    var mh = (packed.h > 0 ? Math.round(packed.h) : 0) + 'px';
    if (wall.style.minHeight !== mh) wall.style.minHeight = mh;
  }

  var mcwWall = null;
  var mcwRaf = 0;
  var mcwObs = null;

  function mcwRun() {
    mcwRaf = 0;
    if (!mcwWall) return;
    if (!mcwWall.isConnected) { mcwWall = null; return; }
    wallLayout(mcwWall);
  }

  /* A resize observer that writes styles can ask for the next frame itself; the coordinate
     signature above is what stops that from becoming a loop. */
  function mcwSchedule() {
    if (!mcwRaf && window.requestAnimationFrame) mcwRaf = window.requestAnimationFrame(mcwRun);
  }

  function wallPaint() {
    var box = host && host.paneNode ? host.paneNode() : null;
    var wall = box ? box.querySelector('.mcx-inbox-ai-wall') : null;
    if (!wall) {
      mcwWall = null;
      if (mcwObs) mcwObs.disconnect();
      return;
    }
    if (mcwWall !== wall) {
      mcwWall = wall;
      if (!mcwObs && window.ResizeObserver) mcwObs = new window.ResizeObserver(mcwSchedule);
      if (mcwObs) {
        mcwObs.disconnect();
        mcwObs.observe(wall);
        var cards = wallCards(wall);
        for (var i = 0; i < cards.length; i++) mcwObs.observe(cards[i]);
      }
    }
    wallLayout(wall);
  }

  /* The pill belongs to the target row, drawn with the same class as its two neighbours. It is
     the only way in and, while anything is running or standing, it is the way out too. */
  function replyTrigger() {
    if (!on()) return '';
    /* Lit with the same fill the two target pills use when one of them is the chosen one: while
       the reply flow is up, this is the control that is on. */
    return '<button type="button" class="mcx-inbox-mode' + (A.stage ? ' on' : '') +
      '" data-ai-reply>' + host.icon('spark') +
      (A.stage ? 'Close AI Reply' : 'AI Reply') + '</button>';
  }

  /* The right hand end of that same row carries the state, so he can see what is happening
     without the picker being on screen at all. */
  function replyStatus() {
    if (!on()) return '';
    if (A.stage === 'waiting') return '<span class="mcx-inbox-aistatus">' + spin() + 'Writing your reply…</span>';
    return '';
  }

  function ofLabel(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1];
    return '';
  }

  function replyPanel() {
    if (!on() || !A.stage) return '';
    if (A.stage === 'waiting') return waitingHtml();
    if (A.stage === 'ready') return readyHtml();
    return pickerHtml();
  }

  function panelOpen() {
    return '<div class="mcx-inbox-aireply">';
  }

  /* Playful is the one tone with a dial, so the dial belongs on the pill rather than on a line of
     its own: a slider under the row would read as a setting for all four, and three of them ignore
     it. The pill stays the pill, so picking this tone does not move anything else on the plate. */
  function playfulBar(name) {
    var n = playful();
    return '<span class="mcx-tonebar">' +
      '<button type="button" class="mcx-inbox-chip mcx-tonebar-name on" data-ai-tone="playful">' + esc(name) + '</button>' +
      '<input type="range" class="mcx-tonebar-slider" data-ai-playful min="0" max="100" step="5" ' +
      'value="' + n + '" aria-label="How playful">' +
      '<span class="mcx-tonebar-pct" data-ai-playful-pct>' + n + '%</span>' +
      '</span>';
  }

  function pickerHtml() {
    var html = panelOpen();
    html += '<div class="mcx-inbox-aigroup"><span class="mcx-inbox-aigrouphead">What should it do?</span><div class="mcx-inbox-aichips">';
    for (var i = 0; i < INTENTS.length; i++) {
      html += '<button type="button" class="mcx-inbox-chip' + (A.intent === INTENTS[i][0] ? ' on' : '') +
        '" data-ai-intent="' + INTENTS[i][0] + '">' + esc(INTENTS[i][1]) + '</button>';
    }
    html += '</div></div>';
    html += '<div class="mcx-inbox-aigroup"><span class="mcx-inbox-aigrouphead">Tone</span><div class="mcx-inbox-aichips">';
    var list = tones();
    for (var t = 0; t < list.length; t++) {
      if (list[t][0] === 'playful' && A.tone === 'playful') {
        html += playfulBar(list[t][1]);
        continue;
      }
      html += '<button type="button" class="mcx-inbox-chip' + (A.tone === list[t][0] ? ' on' : '') +
        '" data-ai-tone="' + list[t][0] + '">' + esc(list[t][1]) + '</button>';
    }
    /* 那句提醒长在刻度下面，因为它说的是这一排里只有 playful 才有的那个东西。
       换回别的三档它就整行消失（不是留一行空着）：这一屏下面还有补充框和 Generate */
    html += '</div>';
    html += window.MCxAi.toneWarnHtml(A.tone === 'playful' ? playful() : 0);
    html += '</div>';
    html += '<textarea class="mcx-inbox-ainote" rows="1" data-ai-f="note" ' +
      'placeholder="Add an optional note…">' + esc(A.note) + '</textarea>';
    html += errLine(A.replyErr);
    html += '<div class="mcx-inbox-aifoot is-pick">' +
      '<button type="button" class="mcx-inbox-aigen" data-ai-gen>' + host.icon('spark') + 'Generate</button></div>';
    return html + '</div>';
  }

  function waitingHtml() {
    var cfg = null;
    try { cfg = window.MCxAi && window.MCxAi.config ? window.MCxAi.config('flash') : null; } catch (e) {}
    var isCloud = (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()) || (cfg && cfg.isCloud);
    var model = (!isCloud && cfg) ? ((cfg.name || 'Your API key') + ' · ' + (cfg.model || 'Auto')) : '';
    var meta = ['Using this conversation', ofLabel(INTENTS, A.intent), window.MCxAi.toneLabel(A.tone, playful()), model].filter(Boolean).join('  ·  ');
    var isPool = (A.replyPoolUsed || (window.MCxAi && window.MCxAi.isPoolRouting && window.MCxAi.isPoolRouting()));
    var poolNotice = (isPool && window.MCxAi && window.MCxAi.poolNoticeHtml) ? window.MCxAi.poolNoticeHtml() : '';
    return panelOpen() + '<div class="mcx-inbox-aiplate">' +
      '<div class="mcx-inbox-aihead2">' + host.icon('spark') + 'Writing your reply…</div>' +
      poolNotice +
      '<div class="mcx-inbox-aiusing">' + esc(meta) + '</div>' +
      '<div class="mcx-inbox-aiskel"><i></i><i></i><i></i></div>' +
      '</div>' +
      '<div class="mcx-inbox-aifoot is-reply"><span class="mcx-inbox-aihint">Your reply will appear below.</span>' +
      btn('data-ai-abort', 'Cancel') + '</div></div>';
  }

  /* The draft is in the reply box itself now, so up here there is nothing left but the two ways
     to change it. No third button that re-shows a copy of text already sitting below. */
  function readyHtml() {
    var html = panelOpen() + '<div class="mcx-inbox-aibar">' +
      '<span class="mcx-inbox-aihead2">' + host.icon('spark') + 'Review Before Sending</span>' +
      '<span class="mcx-inbox-aibaracts">' +
      '<button type="button" class="mcx-inbox-aiact" data-ai-adjust>' + host.icon('adjust') + 'Adjust</button>' +
      '<button type="button" class="mcx-inbox-aiact" data-ai-gen>' + host.icon('again') + 'Regenerate</button>' +
      '</span></div>';
    if (A.hadText) {
      html += '<div class="mcx-inbox-aifoot is-reply"><span class="mcx-inbox-aihint">It wrote over what you had typed.</span>' +
        btn('data-ai-undo', 'Bring my text back') + '</div>';
    }
    html += draftFoot();
    return html + errLine(A.replyErr) + '</div>';
  }

  /* The draft carries its own count for the same reason the summary does: it is the number the
     provider sent back in its answer, not one we worked out here. Providers that leave money out
     get tokens only, and the row in Settings can hide this line altogether. */
  function draftFoot() {
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    var bits = [];
    if (!isCloud && a && a.usageBits && a.usageLineOn && a.usageLineOn()) bits = a.usageBits(A.replyCalls);
    if (!bits.length) return '';
    bits = ['used ' + bits.join(' · ')];
    return '<div class="mcx-inbox-aiby">Draft<span class="mcx-inbox-aidot"> · </span>' +
      esc(bits.join(' · ')) + '</div>';
  }

  /* One small line under the summary, no buttons on it. It adds up every run on this thread, so
     the first pass and the re-run he asked for sit side by side as "500 + 400 = 900" and pressing
     Generate again cannot look free. Money only ever comes from the provider itself; a thread
     whose provider sent no count still says the one thing we actually know, which is roughly how
     much we sent, and the word "used" stays off that figure. */
  function summaryFoot() {
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    if (isCloud) return '';
    if (a && a.usageLineOn && !a.usageLineOn()) return '';
    var uses = recUses(A.rec);
    var bits = a && a.usageBits ? a.usageBits(uses) : [];
    /* "used" only ever sits in front of numbers the provider sent back. Without them all we
       know is how much we put into the request, and that stays "About N tokens sent". */
    if (bits.length) bits = ['used ' + bits.join(' · ')];
    else if (A.rec && A.rec.sent) bits = ['About ' + (a && a.usageNum ? a.usageNum(A.rec.sent) : A.rec.sent) + ' tokens sent'];
    if (!bits.length) return '';
    return '<div class="mcx-inbox-aiby">Written with AI<span class="mcx-inbox-aidot"> · </span>' +
      esc(bits.join(' · ')) + '</div>';
  }

  /* A run list on a record, in the order the requests went out. Rows written by the earlier
     build hold one object, so that reads back as the single term of the sum. */
  function recUses(rec) {
    if (!rec) return [];
    if (Array.isArray(rec.uses)) return rec.uses;
    return rec.used && typeof rec.used === 'object' ? [rec.used] : [];
  }

  function plateHtml(d, rawDates) {
    if (!on() || !A.sig || !host) return '';
    if (A.confirm < 0) A.shownConfirm = -1;
    var fresh = !!(A.rec && A.sig === A.rec.sig);
    var cards = fresh ? insightsHtml(d, rawDates) : '';
    /* Built first so the summary card can ask it whether there is anything to jump to. */
    var foot = fresh ? summaryFoot() : '';
    var hasMaterials = fresh && !!courseIdOf(d);
    var hasDetails = fresh && (hasMaterials || !!foot);
    var html = '<div class="mcx-inbox-ai is-summary">';
    html += headHtml(hasDetails);
    if (fresh && hasDetails && A.showDetails) {
      html += '<div class="mcx-inbox-aidetails-wrap is-top">' +
        '<div class="mcx-inbox-aidetails-body">';
      if (hasMaterials) {
        html += '<div class="mcx-inbox-aifind">' +
          btn('data-ai-res', A.studyBusy ? 'Looking' : 'Find the materials in this course', A.studyBusy ? 'is-busy' : '') +
          '</div>';
      }
      if (foot) html += foot;
      html += '</div></div>';
    }
    if (A.busy && (A.poolUsed || (window.MCxAi && window.MCxAi.isPoolRouting && window.MCxAi.isPoolRouting())) && window.MCxAi && window.MCxAi.poolNoticeHtml) {
      html += window.MCxAi.poolNoticeHtml();
    }
    if (fresh && A.rec.summary) html += '<div class="mcx-inbox-aitext">' + esc(A.rec.summary) + '</div>';
    html += errLine(A.err);
    html += errLine(A.studyErr);
    html += noteLine(A.studyNote);
    if (!fresh && !A.busy && !A.err) {
      html += '<div class="mcx-inbox-aifootnote">' + esc(A.words > AUTO_WORDS
        ? 'This thread is long enough to summarize. Nothing has been sent yet.'
        : 'Short enough to read as it is. Press Summarize whenever you want one anyway.') + '</div>';
    }
    /* The summary card closes first and the finding cards follow it as siblings, so each kind of
       thing sits on its own plate with the page between them. */
    return html + '</div>' + cards;
  }

  /* ---------- events ---------- */

  /* The two text fields are read from the live nodes so the caret is never fought over, but the
     kind is state: a repaint between picking and pressing must not undo it. */
  function formFromDom() {
    var out = { title: '', date: '', kind: A.kind };
    var box = host && host.paneNode ? host.paneNode() : null;
    if (!box) return out;
    var t = box.querySelector('[data-ai-f="title"]');
    var d = box.querySelector('[data-ai-f="date"]');
    if (t) out.title = t.value;
    if (d) out.date = d.value;
    return out;
  }

  function fitNoteInput(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  /* Typed text is the one thing a repaint eats, so the note is copied into state on every
     keystroke without redrawing anything. The playfulness dial is the same case, one notch
     stricter: repainting mid-drag rebuilds the slider out from under the pointer, so only the two
     characters on its right change and the state is read straight off the input. */
  function paneInput(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-ai-f="note"]') : null;
    if (t) {
      A.note = String(t.value || '');
      fitNoteInput(t);
      return true;
    }
    var dial = e.target && e.target.closest ? e.target.closest('[data-ai-playful]') : null;
    if (!dial) return false;
    A.playful = window.MCxAi.playfulPct(dial.value, window.MCxAi.playfulDefault);
    /* The reply panel is inside the composer, and the composer is mounted on <body> so it can
       frost the page behind it, so this reaches it through the host rather than the column. */
    var cp = host && host.composerNode ? host.composerNode() : null;
    var out = cp ? cp.querySelector('[data-ai-playful-pct]') : null;
    if (out) out.textContent = A.playful + '%';
    /* 那一句也跟着当场换字换色：它是从刻度里长出来的话，拖过了才出现就等于晚一步说。
       节点一直在，只翻类和那几个字，所以不需要为它重建整块 */
    var warn = cp ? cp.querySelector('[data-tone-warn]') : null;
    if (warn) {
      var w = window.MCxAi.toneWarn(A.playful);
      warn.className = 'mcx-tone-warn' + (w.cls ? ' ' + w.cls : '');
      warn.querySelector('.mcx-tone-warn-text').textContent = w.text;
    }
    return true;
  }

  /* ---------- the reply plate's height ----------
     The plate sits inside the composer, and the composer is pinned to the bottom of the column, so
     opening the picker pushes the pill row up instead of covering anything. That push is the
     animation, and only a real height can carry it: a fade would leave the plate snapping to its
     new size around still content. Both directions run this one slide, and it finishes by dropping
     the inline styles so the plate rests on the height the stylesheet gives it. */
  function plateNode() {
    var c = host && host.composerNode ? host.composerNode() : null;
    return c ? c.querySelector('.mcx-inbox-aireply') : null;
  }

  function plateHeight() {
    var n = plateNode();
    return n ? n.offsetHeight : 0;
  }

  function slidePlate(n, from, to, done) {
    var mb = parseFloat(getComputedStyle(n).marginBottom) || 0;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !n.animate) { if (done) done(); return; }
    /* contain 只在动画这一趟挂上：这一块的子节点（两排药丸加一个补充框）在高度不变时不用重排，
       没有它每帧都要跟着板子重新铺一遍，那正是掉帧的地方。 */
    n.style.overflow = 'hidden';
    n.style.contain = 'layout paint';
    var a = n.animate([
      { height: from + 'px', marginBottom: (from ? mb : 0) + 'px' },
      { height: to + 'px', marginBottom: (to ? mb : 0) + 'px' }
    ], { duration: 420, easing: 'cubic-bezier(0.34, 0.02, 0.14, 1)' });
    /* The other branch is a repaint that replaced this node mid-slide. The caller still has to be
       told, or a collapse waiting on it would never land. */
    a.finished.then(function () {
      n.style.contain = '';
      /* A slide that ended at nothing has to stay at nothing: the animation stops driving the
         height the moment it finishes, and the plate would otherwise stand back up for the frame
         between here and the repaint that removes it. */
      if (!to) n.style.height = '0px';
      else n.style.overflow = '';
      if (done) done();
    }, function () {
      if (done) done();
    });
  }

  /* paintPane hands over the height the plate had before it rebuilt the column. Same height means
     the press only redrew what was already there, so nothing moves.
     The node is optional: inbox-list.js passes the Remind plate through this same slide so the two
     plates that change the composer's height open and close with one duration, one curve, and one
     mechanism instead of two copies of it. */
  function growPlate(from, node) {
    var n = node || plateNode();
    if (!n) return;
    var to = n.offsetHeight;
    if (!to || Math.abs(to - from) < 2) return;
    slidePlate(n, from, to);
  }

  /* Closing has to slide before the rebuild, not after: the moment innerHTML runs the plate is
     gone, and there is nothing left to shrink. */
  function collapsePlate(done, node) {
    var n = node || plateNode();
    var h = n ? n.offsetHeight : 0;
    if (!h) { done(); return; }
    slidePlate(n, h, 0, done);
  }

  /* Leaving the AI reply flow. The text already written into the reply box stays there: once it
     is in his box it is his message, and closing a panel should not quietly delete a paragraph. */
  function closeReply() {
    A.replyGen++;
    A.stage = '';
    A.draft = '';
    A.replyPoolUsed = false;
    A.replyErr = '';
    A.replyCalls = [];
    A.replaced = '';
    A.hadText = false;
  }

  function paneClick(e) {
    if (!on() || !host) return false;
    var d = host.detail();
    if (!d) return false;

    if (e.target.closest('[data-ai-auth="google"]')) {
      if (window.MCxAi && window.MCxAi.loginWithGoogle) {
        A.replyErr = 'Starting Google sign-in…';
        repaint();
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            A.replyErr = 'Sign-in was cancelled. Try again to draft a reply.';
            repaint();
          } else {
            A.replyErr = '';
            repaint();
            makeReply();
          }
        });
      } else if (window.MCxAi && window.MCxAi.promptLogin) {
        window.MCxAi.promptLogin();
      } else {
        try { document.dispatchEvent(new CustomEvent('mc-open-ai-settings')); } catch (err) {}
      }
      return true;
    }
    if (e.target.closest('[data-ai-run]')) { summarize(d, true); return true; }
    if (e.target.closest('[data-ai-details]')) {
      A.showDetails = !A.showDetails;
      repaint();
      return true;
    }
    if (e.target.closest('[data-ai-cancel]')) {
      A.confirm = -1;
      A.kind = 'todo';
      A.addErr = '';
      repaint();
      return true;
    }
    var add = e.target.closest('[data-ai-add]');
    if (add) {
      A.confirm = rowKey(add.getAttribute('data-ai-add'));
      A.kind = 'todo';
      A.addErr = '';
      repaint();
      return true;
    }
    var pick = e.target.closest('[data-ai-k]');
    if (pick) {
      A.kind = pick.getAttribute('data-ai-k') === 'event' ? 'event' : 'todo';
      repaint();
      return true;
    }
    var create = e.target.closest('[data-ai-create]');
    if (create) {
      createItem(d, rowKey(create.getAttribute('data-ai-create')), formFromDom());
      return true;
    }
    var study = e.target.closest('[data-ai-study]');
    if (study) {
      openStudy(d, A.rec && A.rec.dos[Number(study.getAttribute('data-ai-study'))], 'ask');
      return true;
    }
    if (e.target.closest('[data-ai-res]')) { openStudy(d, null, 'resources'); return true; }
    if (e.target.closest('[data-ai-reply]')) {
      /* The pill is the only way in, so it has to be the way out at every stage. Leaving the
         ready stage keeps the text that is now sitting in his reply box: it is his to keep. */
      if (A.stage) {
        collapsePlate(function () { closeReply(); repaint(); });
        return true;
      }
      A.stage = 'picker';
      A.replyErr = '';
      repaint();
      /* The account store returns asynchronously.  Paint once for responsiveness, then repaint
         the readout from the loaded store so the chip cannot briefly advertise a fallback model
         while send() is about to use the saved one. */
      try {
        if (window.MCxAi && window.MCxAi.load) {
          Promise.resolve(window.MCxAi.load()).then(function () {
            if (A.stage === 'picker') repaint();
          }, function () {});
        }
      } catch (err) {}
      return true;
    }
    var intent = e.target.closest('[data-ai-intent]');
    if (intent) {
      A.intent = intent.getAttribute('data-ai-intent');
      repaint();
      return true;
    }
    var tone = e.target.closest('[data-ai-tone]');
    if (tone) {
      A.tone = tone.getAttribute('data-ai-tone');
      repaint();
      return true;
    }
    if (e.target.closest('[data-ai-gen]')) { makeReply(); return true; }
    if (e.target.closest('[data-ai-adjust]')) {
      A.stage = 'picker';
      A.replyErr = '';
      repaint();
      return true;
    }
    if (e.target.closest('[data-ai-abort]')) {
      /* Bump the generation first: the response is already on the wire and would otherwise land
         in the box a second after he asked for it to stop. */
      A.replyGen++;
      if (A.hadText) host.writeDraft(A.replaced);
      A.stage = 'picker';
      A.draft = '';
      repaint();
      return true;
    }
    if (e.target.closest('[data-ai-undo]')) {
      host.writeDraft(A.replaced);
      A.draft = '';
      A.hadText = false;
      A.replaced = '';
      A.stage = 'picker';
      repaint();
      return true;
    }
    return false;
  }

  /* ---------- entry points the inbox page calls ---------- */

  function resetFor(d) {
    A.conv = d.id;
    A.text = threadText(d);
    A.words = wordCount(A.text);
    A.sig = signature(d);
    A.busy = false;
    A.err = '';
    A.confirm = -1;
    A.kind = 'todo';
    A.addBusy = false;
    A.addErr = '';
    A.replyGen++;
    A.stage = '';
    A.shownConfirm = -1;
    A.draft = '';
    A.replyErr = '';
    // Another message means another sum: this one's draft runs start from nothing
    A.replyCalls = [];
    A.note = '';
    A.replaced = '';
    A.hadText = false;
    A.studyBusy = false;
    A.studyErr = '';
    A.studyNote = '';
    A.showDetails = false;
    mcwPlace = {};
    mcwPlaceCols = '';
    var hit = cacheGet(d.id);
    if (hit && hit.sig !== A.sig) {
      cacheDrop(d.id);
      hit = null;
    }
    A.rec = hit;
  }

  function onDetail(d) {
    if (!on() || !d) return;
    resetFor(d);
    /* loadDetail() in inbox-list.js only comes here once per conversation it has not already
       read, so this is one request per message opened, not one per repaint. A cached answer is
       the only thing that stops it. */
    if (A.rec) return;
    if (A.words <= AUTO_WORDS) return;
    summarize(d, false);
  }

  /* Whether the insight cards are on screen for this message right now. The page uses it to decide
     who draws the dates: the same days must not be listed twice in one column. */
  function insightsShown() {
    return !!(on() && A.sig && A.rec && A.sig === A.rec.sig);
  }

  window.mcxInboxAi = {
    on: on,
    bind: function (h) { if (h) host = h; },
    plateHtml: plateHtml,
    insightsShown: insightsShown,
    datesCardHtml: datesCardHtml,
    replyTrigger: replyTrigger,
    replyPanel: replyPanel,
    replyStatus: replyStatus,
    plateHeight: plateHeight,
    growPlate: growPlate,
    collapsePlate: collapsePlate,
    wallPaint: wallPaint,
    replyStage: function () { return on() ? A.stage : ''; },
    paneClick: paneClick,
    paneInput: paneInput,
    onDetail: onDetail,
    reset: resetFor,
    refresh: repaint,
    parseBlock: parseBlock,
    isoOf: isoOf,
    signature: signature,
    threadText: threadText,
    wordCount: wordCount,
    bestTask: bestTask,
    autoWords: AUTO_WORDS
  };

  /* inbox-list.js evaluates before this file in the manifest, so the bridge is normally already
     there. mount() also calls bind, which is what covers a future change of load order. */
  if (window.mcxInboxHost) host = window.mcxInboxHost;
})();
