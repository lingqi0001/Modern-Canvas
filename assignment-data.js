/* =========================================================
   Assignment 详情页的取数层：把"这份作业到底能读到什么"整合成一个 ctx，
   交给 assignment-analyze.js 判值，交给 assignment-debug.js 摆出来。

   和 canvas-data.js 的分工：那一份是给 AI 复习总结用的（读课件正文、翻页、按大小记账），
   这一份只多做一件它没有的事——每一条网络请求都留一条带状态码和耗时的记录，
   因为调试窗口必须能回答"这条为什么缺"。读 HTML、读单文件正文、估 token 这些一律复用那一份，
   不在这里重写一遍。

   四条口径：
   - 发现 ≠ 读取。附件只拿元数据（名字、类型、大小），正文要点窗口里那颗 Read 才拉。
   - 403／404 不许洗成"没有"。rubric 三态 available / absent / unavailable 就是这么来的。
   - Canvas 两代作业详情页的 DOM 完全不同（旧版 #assignment_show、新版整页 InstUI），
     所以认页面只认地址，不认锚点。
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

  var LOG = '[MCX assign-analysis]';
  var CACHE_KEY = 'mc_assign_cache_v1';

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  /* ==== 路由：地址是唯一判据 ==== */

  var ROUTES = [
    { kind: 'assignment', re: /^\/courses\/(\d+)\/assignments\/(\d+)/i },
    { kind: 'quiz', re: /^\/courses\/(\d+)\/quizzes\/(\d+)/i },
    { kind: 'discussion', re: /^\/courses\/(\d+)\/discussion_topics\/(\d+)/i }
  ];

  /* 这几页看着像作业页但不是：答题中、起飞页、编辑页、提交详情、大纲页。
     调试窗口挂上去只会挡路，而且那些页的地址里作业 id 含义不同 */
  var EXCLUDE = /(\/take(\b|\/)|\/launch(\b|\/)|\/taking\/|\/edit(\b|\/)|\/submissions\/\d+\/|\/syllabus(\b|\/)|\/moderated_grading(\b|\/))/i;

  function currentTarget() {
    var path = location.pathname || '';
    if (EXCLUDE.test(path)) return null;
    for (var i = 0; i < ROUTES.length; i++) {
      var m = ROUTES[i].re.exec(path);
      if (m) {
        var mm = /[?&]module_item_id=(\d+)/.exec(location.search || '');
        return {
          kind: ROUTES[i].kind,
          courseId: Number(m[1]),
          id: Number(m[2]),
          moduleItemId: mm ? Number(mm[1]) : 0,
          href: location.href
        };
      }
    }
    return null;
  }

  function onAssignmentPage() { return !!currentTarget(); }

  /* ==== 带记录的请求 ==== */

  function ask(label, url) {
    var t0 = Date.now();
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        var ms = Date.now() - t0;
        if (!res.ok) {
          return res.text().then(function (body) {
            var rec = {
              label: label, url: url, status: res.status, ms: ms, ok: false,
              bodyHead: String(body || '').replace(/\s+/g, ' ').slice(0, 160),
              error: httpMeaning(res.status, String(body || ''))
            };
            var err = new Error(label + ' failed: HTTP ' + res.status);
            err.record = rec;
            err.status = res.status;
            throw err;
          });
        }
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); }
          catch (e) {
            var bad = { label: label, url: url, status: res.status, ms: ms, ok: false, error: 'answered ' + res.status + ' but the body is not JSON', bodyHead: String(text || '').replace(/\s+/g, ' ').slice(0, 160) };
            var err2 = new Error(label + ' returned something that is not JSON');
            err2.record = bad;
            throw err2;
          }
          return { label: label, url: url, status: res.status, ms: ms, ok: true, data: data, size: String(text || '').length };
        });
      }, function (err) {
        var rec = { label: label, url: url, status: 0, ms: Date.now() - t0, ok: false, error: 'the request never completed: ' + String((err && err.message) || err) };
        var out = new Error(label + ' never reached Canvas');
        out.record = rec;
        throw out;
      });
  }

  /* 状态码翻译成一句人话：调试窗口里光写"403"不算解释 */
  function httpMeaning(status, body) {
    var head = String(body || '');
    if (status === 401) return 'not logged in to Canvas on this tab';
    if (status === 403) return /must be released to students/i.test(head) ? 'Canvas hides this from students until the teacher releases it' : 'Canvas will not give this to your account (permission)';
    if (status === 404) return /has been disabled for this course/i.test(head) ? 'this course has that tool switched off, so the endpoint does not exist here' : 'not found, or not visible to you';
    if (status === 429) return 'rate limited, Canvas asked us to back off';
    if (status >= 500) return 'Canvas itself failed (' + status + ')';
    return 'HTTP ' + status;
  }

  function recordOf(err) {
    if (err && err.record) return err.record;
    return { label: 'unknown', url: '', status: 0, ms: 0, ok: false, error: String((err && err.message) || err) };
  }

  /* ==== 指纹：老师改一个字就该重算，没改就不重算 ==== */

  function fingerprint(parts) {
    var s = String(parts || '');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return 'fp' + h.toString(36) + '-' + s.length;
  }

  function cacheAll() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function cacheRead(key) {
    var all = cacheAll();
    return all && all[key] ? all[key] : null;
  }

  function cacheWrite(key, row) {
    try {
      var all = cacheAll();
      all[key] = row;
      /* 只留最近 40 份作业的判值结论；整份 HTML 不进缓存，只进指纹和结论 */
      var ids = Object.keys(all);
      if (ids.length > 40) {
        ids.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
        ids.slice(0, ids.length - 40).forEach(function (id) { delete all[id]; });
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch (e) { log('could not write the analysis cache:', String(e)); }
  }

  /* 已阅读文件正文在本地持久化缓存（供重复进入和设置面板查阅） */
  var FILE_CACHE_PREFIX = 'mc_file_text_';
  var FILE_INDEX_KEY = 'mc_read_files_index';

  function readFileIndex() {
    try { return JSON.parse(localStorage.getItem(FILE_INDEX_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveFileIndex(idx) {
    try { localStorage.setItem(FILE_INDEX_KEY, JSON.stringify(idx)); } catch (e) {}
  }

  function cacheReadFile(fileId) {
    try {
      var raw = localStorage.getItem(FILE_CACHE_PREFIX + fileId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheWriteFile(fileId, record) {
    try {
      localStorage.setItem(FILE_CACHE_PREFIX + fileId, JSON.stringify(record));
      var idx = readFileIndex();
      idx[fileId] = {
        id: fileId,
        courseId: record.courseId,
        assignmentId: record.assignmentId,
        courseName: record.courseName || '',
        assignmentName: record.assignmentName || '',
        name: record.name,
        ext: record.ext || '',
        chars: record.chars || 0,
        bytes: record.bytes || 0,
        sizeInStorage: (record.text ? record.text.length : 0),
        at: record.at || Date.now()
      };
      saveFileIndex(idx);
    } catch (e) { log('could not cache file content:', String(e)); }
  }

  function removeCachedFile(fileId) {
    try {
      localStorage.removeItem(FILE_CACHE_PREFIX + fileId);
      var idx = readFileIndex();
      delete idx[fileId];
      saveFileIndex(idx);
    } catch (e) {}
  }

  function clearAllCachedFiles() {
    try {
      var idx = readFileIndex();
      Object.keys(idx).forEach(function (fid) {
        localStorage.removeItem(FILE_CACHE_PREFIX + fid);
      });
      localStorage.removeItem(FILE_INDEX_KEY);
    } catch (e) {}
  }

  /* ==== 正文结构化：DOMParser，不用 innerHTML ==== */

  var FILE_RE = /(?:\/api\/v1)?(?:\/courses\/\d+)?\/files?\/(\d+)(?:\/|$)/;
  var BLOCK_RE = /^(ul|ol|table|div|p|h1|h2|h3|h4|h5|blockquote|pre)$/i;

  function externalHost(href) {
    try {
      var u = new URL(href, location.origin);
      if (u.origin === location.origin) return '';
      return u.hostname;
    } catch (e) { return ''; }
  }

  var EXTERNAL_NAME = {
    'drive.google.com': 'Google Drive',
    'docs.google.com': 'Google Docs / Slides',
    '1drv.ms': 'OneDrive',
    'onedrive.live.com': 'OneDrive',
    'sharepoint.com': 'SharePoint',
    'youtu.be': 'YouTube',
    'www.youtube.com': 'YouTube',
    'panopto.com': 'Panopto lecture recording',
    'zoom.us': 'Zoom',
    'www.canva.com': 'Canva',
    'quizlet.com': 'Quizlet',
    'www.kahoot.com': 'Kahoot',
    'www.notability.com': 'Notability',
    'github.com': 'GitHub',
    'gitlab.com': 'GitLab'
  };

  /* units 是给判值引擎读的最小单位：一段话、一条列表项、一格表格各算一条，
     带 path 是为了让证据能说出"它来自第几条列表的第几项" */
  function structureOf(html) {
    var out = {
      units: [], headings: [], lists: [], tables: 0, tableOffset: -1,
      images: 0, links: [], files: [], external: [], pageRefs: [],
      weeks: 0, weekOffset: -1, headingOffset: -1, listOffset: -1,
      rawHTML: String(html || ''), removed: 0
    };
    var doc;
    try { doc = new DOMParser().parseFromString('<body>' + out.rawHTML + '</body>', 'text/html'); }
    catch (e) {
      /* 解析器本身塌了（不是内容塌了）：这条必须留名字，不然画面只是空白，
         看起来像"这份作业没有正文" */
      out.parseFailed = String((e && e.message) || e);
      log('could not parse the description HTML:', out.parseFailed);
      return out;
    }
    var box = doc.body;
    if (!box) { out.parseFailed = 'the parser returned no body element'; return out; }

    var junk = box.querySelectorAll('script,style,noscript,template');
    out.removed = junk.length;
    for (var j = 0; j < junk.length; j++) if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);

    var pCount = 0;
    var liCount = 0;

    function push(kind, text, path) {
      var t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      out.units.push({ kind: kind, text: t, path: path });
    }

    function walk(node, depth) {
      var kids = node.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        var tag = (el.tagName || '').toLowerCase();
        if (/^h[1-5]$/.test(tag)) {
          var ht = el.textContent.replace(/\s+/g, ' ').trim();
          out.headings.push({ tag: tag, text: ht, path: 'heading ' + (out.headings.length + 1) });
          push('heading', ht, 'heading ' + out.headings.length);
        } else if (tag === 'ul' || tag === 'ol') {
          var items = [];
          for (var k = 0; k < el.children.length; k++) {
            var c = el.children[k];
            if ((c.tagName || '').toLowerCase() !== 'li') continue;
            liCount++;
            /* 一条要求里还套着小列表＝这条本身就有细分，判值得看这个数，
               而不是看大列表一共有几条（2026-10-12 他给的那条判据）。
               但"套着小项"和"这条本身很长"是两件事：父项自己的话要摘掉小列表再数，
               小列表自己另数一共几个词。那页"描述四个阶段"就是靠混在一起漏判成重项的。 */
            var own = '';
            for (var cn = 0; cn < c.childNodes.length; cn++) {
              if (c.childNodes[cn].nodeType === 3) own += c.childNodes[cn].nodeValue;
            }
            var nested = c.querySelectorAll('ul > li, ol > li');
            var subWords = 0;
            for (var nk = 0; nk < nested.length; nk++) {
              subWords += String(nested[nk].textContent || '').trim().split(/\s+/).length;
            }
            var it = {
              index: liCount, text: c.textContent.replace(/\s+/g, ' ').trim(),
              own: own.replace(/\s+/g, ' ').trim(),
              path: 'list item ' + liCount, bold: firstBold(c), subs: nested.length, subWords: subWords
            };
            items.push(it);
            push('li', it.text, it.path);
          }
          out.lists.push({ type: tag, items: items, path: 'list #' + (out.lists.length + 1) });
        } else if (tag === 'table') {
          out.tables++;
          var cells = el.querySelectorAll('td,th');
          for (var t2 = 0; t2 < cells.length; t2++) push('cell', cells[t2].textContent, 'table ' + out.tables + ' cell ' + (t2 + 1));
        } else {
          var hasBlock = false;
          for (var q = 0; q < el.children.length; q++) {
            if (BLOCK_RE.test(el.children[q].tagName || '')) { hasBlock = true; break; }
          }
          if (hasBlock && depth < 8) { walk(el, depth + 1); continue; }
          pCount++;
          push(tag || 'node', el.textContent, 'paragraph ' + pCount);
          if (tag === 'img') out.images++;
        }
      }
    }
    walk(box, 0);

    if (!out.images) out.images = box.querySelectorAll('img').length;

    /* 链接、附件、外站、指向别的 Canvas 页 */
    var seenFile = {};
    var seenPage = {};
    var nodes = box.querySelectorAll('[href],[src],[data-api-endpoint]');
    for (var n = 0; n < nodes.length; n++) {
      var e2 = nodes[n];
      var label = (e2.textContent || e2.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      var cands = [e2.getAttribute('href'), e2.getAttribute('src'), e2.getAttribute('data-api-endpoint')];
      for (var c = 0; c < cands.length; c++) {
        var raw = cands[c];
        if (!raw) continue;
        var fm = FILE_RE.exec(raw);
        if (fm) {
          if (!seenFile[fm[1]]) {
            seenFile[fm[1]] = 1;
            out.files.push({ id: fm[1], label: label, sourceUrl: abs(raw), status: 'discovered' });
          }
          continue;
        }
        var pm = /\/courses\/(\d+)\/pages\/([^?#]+)/.exec(raw);
        if (pm) {
          if (!seenPage[pm[1] + ':' + pm[2]]) {
            seenPage[pm[1] + ':' + pm[2]] = 1;
            out.pageRefs.push({ courseId: Number(pm[1]), pageUrl: pm[2], label: label, status: 'discovered' });
          }
          continue;
        }
        if (/^(mailto:|javascript:|#)/i.test(raw)) continue;
        var host = externalHost(raw);
        if (host) out.external.push({ host: host, name: EXTERNAL_NAME[host] || host, label: label, url: abs(raw) });
        else out.links.push({ label: label, url: abs(raw) });
      }
    }

    /* 偏移量：证据那一句要能指回拼起来的正文，所以这里换成字符下标 */
    var joined = out.units.map(function (u) { return u.text; }).join('\n');
    out.joined = joined;
    out.headingOffset = offsetOf(joined, out.headings[0] && out.headings[0].text);
    out.listOffset = offsetOf(joined, firstListText(out));
    out.tableOffset = offsetOf(joined, firstCellText(out));
    var wk = /\bweek\s*\d+/i.exec(joined);
    out.weeks = wk ? (joined.match(/\bweek\s*\d+/gi) || []).length : 0;
    out.weekOffset = wk ? wk.index : -1;
    return out;
  }

  function firstListText(out) {
    return out.lists.length && out.lists[0].items.length ? out.lists[0].items[0].text : '';
  }

  function firstCellText(out) {
    for (var i = 0; i < out.units.length; i++) if (out.units[i].kind === 'cell') return out.units[i].text;
    return '';
  }

  function offsetOf(joined, needle) {
    if (!needle) return -1;
    return String(joined).indexOf(String(needle).slice(0, 24));
  }

  function firstBold(el) {
    var b = el.querySelector('strong,b');
    return b ? b.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function abs(href) {
    try { return new URL(href, location.origin).href; } catch (e) { return String(href); }
  }

  function htmlToText(html) {
    if (root.MCxData && root.MCxData.htmlToText) return root.MCxData.htmlToText(html);
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ==== rubric 三态：available / absent / unavailable ==== */

  function rubricShape(list) {
    return (list || []).map(function (c) {
      return {
        id: c.id || '', title: c.description || '', details: c.long_description || '',
        points: c.points == null ? null : c.points,
        maxPoints: c.outcome_points == null ? null : c.outcome_points,
        ratings: Array.isArray(c.ratings) ? c.ratings : []
      };
    });
  }

  function rubricOf(assignment) {
    var list = Array.isArray(assignment.rubric) ? assignment.rubric : null;
    var settings = assignment.rubric_settings || null;
    var used = assignment.use_rubric_for_grading;
    var out = { status: 'absent', criteria: [], usedForGrading: used == null ? null : !!used, why: '', httpStatus: 0, source: 'this assignment response' };
    if (list && list.length) {
      out.status = 'available';
      out.criteria = rubricShape(list);
      return out;
    }
    if (settings) {
      out.status = 'unavailable';
      out.why = 'the assignment carries rubric_settings (points ' + (settings.points_possible == null ? 'not stated' : settings.points_possible) + ') but no criterion text came back in this response';
      return out;
    }
    out.why = 'no rubric_settings and no rubric array on this assignment';
    return out;
  }

  /* ==== 主流程：一趟把所有可读来源收齐，缺的照常登记 ==== */

  var FILE_META_CAP = 8;
  var FILE_META_CONCURRENCY = 3;
  /* 8 MB 以下自动量并自动读取，大于 8 MB 的需由用户选择是否继续阅读 */
  var MEASURE_BYTES_CAP = 8 * 1024 * 1024;
  var MEASURE_CONCURRENCY = 2;

  /* 一次跑最多 n 条：任务是一堆"返回 Promise 的函数"，不是 Promise 数组 */
  function runLimited(jobs, n) {
    var next = 0;
    function worker() {
      if (next >= jobs.length) return Promise.resolve();
      var job = jobs[next++];
      return Promise.resolve(job()).then(worker);
    }
    var runners = [];
    for (var i = 0; i < Math.min(n, jobs.length); i++) runners.push(worker());
    return Promise.all(runners);
  }

  /* 同一份作业在这一页上只收一次：正式卡片和调试窗口是同一页上的两个读者，
     各收各的等于把 Canvas 的请求打两遍。force 是那颗 Re-analyze，它要真重新问。 */
  var inflight = {};

  function collect(target, onStep, opts) {
    opts = opts || {};
    var k = target.kind + ':' + target.courseId + ':' + target.id;
    var row = inflight[k];
    if (!opts.force && row && row.href === target.href) return row.p;
    var p = runCollect(target, onStep).then(function (out) {
      inflight[k] = { href: target.href, p: Promise.resolve(out) };
      return out;
    }, function (err) {
      delete inflight[k];
      throw err;
    });
    inflight[k] = { href: target.href, p: p };
    return p;
  }

  function runCollect(target, onStep) {
    var access = [];
    var ctxMetaSkipped = 0;
    var raw = {};
    var courseId = target.courseId;
    var assignmentId = target.id;
    var step = onStep || function () {};
    var detectedKind = target.kind;

    function askLogged(label, url) {
      step(label);
      return ask(label, url).then(function (res) {
        access.push(res);
        return res.data;
      }, function (err) {
        access.push(recordOf(err));
        return null;
      });
    }

    var first;
    if (detectedKind === 'assignment') {
      first = askLogged('assignment', '/api/v1/courses/' + courseId + '/assignments/' + assignmentId);
    } else if (detectedKind === 'quiz') {
      first = askLogged('quiz', '/api/v1/courses/' + courseId + '/quizzes/' + target.id).then(function (quiz) {
        raw.quiz = quiz;
        if (quiz && quiz.assignment_id) {
          assignmentId = quiz.assignment_id;
          return askLogged('the assignment behind that quiz', '/api/v1/courses/' + courseId + '/assignments/' + assignmentId);
        }
        step('this quiz is not attached to an assignment');
        return null;
      });
    } else {
      first = askLogged('discussion topic', '/api/v1/courses/' + courseId + '/discussion_topics/' + target.id).then(function (topic) {
        raw.discussion = topic;
        if (topic && topic.assignment_id) {
          assignmentId = topic.assignment_id;
          return askLogged('the assignment behind that discussion', '/api/v1/courses/' + courseId + '/assignments/' + assignmentId);
        }
        return null;
      });
    }

    return first.then(function (assignment) {
      raw.assignment = assignment;
      var html = (assignment && assignment.description) || (raw.quiz && raw.quiz.description) || (raw.discussion && raw.discussion.message) || '';
      var htmlFrom = html ? 'Canvas API field ' + (raw.quiz && !assignment ? 'quiz.description' : raw.discussion && !assignment ? 'discussion_topic.message' : 'assignment.description') : '';

      /* API 那份是空串时才退回页面上已经画出来的说明：有些课把正文放在模块页里，
         assignment.description 回空。用了退路必须在窗口里点名，不然看着像 API 给的 */
      if (!html) {
        html = pageFallbackHtml();
        if (html) htmlFrom = 'not from the API: read out of the page DOM (' + htmlFromSource + ')';
      }

      var structure = structureOf(html);
      var rubric = assignment ? rubricOf(assignment)
        : { status: 'absent', criteria: [], usedForGrading: null, why: 'no assignment object came back, so there was no rubric field to read', httpStatus: 0, source: 'none' };

      var extra = [];

      /* rubric_settings 有、criteria 没有：再单问一次 rubric 端点，把"没有"和"拿不到"分开。
         这条在没有 rubric 时回 404 一页 HTML（canvas-data.js 里 2026-10-10 量过），那页 HTML 就是要摆的证据 */
      if (rubric.status === 'unavailable') {
        extra.push(askLogged('rubric endpoint', '/api/v1/courses/' + courseId + '/assignments/' + assignmentId + '/rubric').then(function (r) {
          var list = r && (Array.isArray(r.rubric) ? r.rubric : Array.isArray(r.data) ? r.data : null);
          if (list && list.length) {
            rubric.status = 'available';
            rubric.criteria = rubricShape(list);
            rubric.why = '';
            rubric.source = '/assignments/:id/rubric';
          }
          return true;
        }));
      }

      /* 附件只拿元数据，正文等那颗 Read。
         2026-10-12 外部审查复现的那条 N+1：老师挂了 15 个文件时，旧写法在一进页面那一刻
         同时发出 15 条请求。Canvas 官方是动态限流并回 429 的，被限的是学生本人不是我们，
         所以这里封顶：最多认 8 个、同时最多走 3 条，剩下的名字照列、标着没读，Read 那颗照样点得动。 */
      structure.files.slice(FILE_META_CAP).forEach(function (f) {
        f.why = 'metadata not read: this page links more files than the ' + FILE_META_CAP + ' this window looks at';
      });
      ctxMetaSkipped = Math.max(0, structure.files.length - FILE_META_CAP);
      var metaJobs = [];
      structure.files.slice(0, FILE_META_CAP).forEach(function (f) {
        metaJobs.push(function () {
          return askLogged('file ' + f.id, '/api/v1/files/' + f.id).then(function (meta) {
            if (!meta) { f.status = 'unavailable'; f.why = 'Canvas refused this file'; return true; }
            f.status = 'metadata_loaded';
            f.name = meta.display_name || meta.filename || f.label || ('file ' + f.id);
            f.ext = extOf(f.display_name || meta.filename || '');
            f.mime = meta.content_type || meta['content-type'] || '';
            f.mimeClass = meta.mime_class || '';
            f.bytes = meta.size || 0;
            f.updatedAt = meta.updated_at || '';
            f.downloadUrl = meta.url || '';
            f.locked = !!meta.locked_for_user;
            f.label = f.name;

            /* 如果本地已阅读过且文件更新时间未变，直接命中缓存，无需重新下载解析 */
            var cached = cacheReadFile(f.id);
            if (cached && cached.text && (!f.updatedAt || cached.updatedAt === f.updatedAt)) {
              f.status = 'extracted';
              f.chars = cached.chars || cached.text.length;
              f.text = cached.text;
              f.fromCache = true;
            }
            return true;
          });
        });
      });
      extra.push(runLimited(metaJobs, FILE_META_CONCURRENCY));
      /* 量材料不在这一趟里：那一步要下字节，几 MB 的课件会把首屏拖住。
         先出分，再由 countFiles() 量完补一条 run，屏幕上看得见它是后加上去的。 */

      /* 指向别的 Canvas 页：这一趟只登记，不自动读（读了就是替用户爬课） */

      /* 新版测验和老版测验不是同一套 API。老的下线时 404，那条 404 本身是要展示的证据 */
      if (assignment && assignment.quiz_id && !raw.quiz) {
        extra.push(askLogged('classic quiz', '/api/v1/courses/' + courseId + '/quizzes/' + assignment.quiz_id).then(function (q) {
          if (q) { raw.quiz = q; return true; }
          return askLogged('new quiz (a different API)', '/api/quiz/v1/courses/' + courseId + '/quizzes/' + assignment.quiz_id).then(function (nq) {
            if (nq) { raw.newQuiz = nq; detectedKind = 'new_quiz'; }
            return true;
          });
        }));
      }
      if (assignment && assignment.discussion_topic) raw.discussion = assignment.discussion_topic;

      return Promise.all(extra).then(function () {
        var subTypes = (assignment && assignment.submission_types) || [];
        var exts = (assignment && assignment.allowed_extensions) || [];
        var bodyText = htmlToText(html) || structure.joined;

        /* 讨论题的说明可能挂在 topic 那一份而 assignment.description 是另一份：两份都并进来读，
           否则一份"先发帖再回两位同学"的要求会因为只读 API 的 assignment 而丢掉 */
        if (raw.discussion && raw.discussion.message) {
          var dtext = htmlToText(raw.discussion.message);
          if (dtext && bodyText.indexOf(dtext.slice(0, 40)) < 0) bodyText = bodyText ? bodyText + '\n' + dtext : dtext;
        }

        /* 这一趟还没量过任何东西，所以总量是空的：countFiles() 量完会把它填上，
           判值那边跟着多出一条 run 来。 */
        var material = materialTotals(structure.files);

        var ctx = {
          key: courseId + ':' + assignmentId,
          courseId: courseId,
          assignmentId: assignmentId,
          kind: assignment && assignment.quiz_id ? (raw.newQuiz ? 'new_quiz' : 'quiz')
            : (assignment && assignment.discussion_topic ? 'discussion' : detectedKind),
          title: (assignment && assignment.name) || (raw.quiz && raw.quiz.title) || (raw.discussion && raw.discussion.title) || documentTitle(),
          url: location.href,
          htmlSource: htmlFrom || 'no description text found',
          lockedForUser: !!(assignment && assignment.locked_for_user),
          body: { rawHTML: structure.rawHTML, text: bodyText, chars: (bodyText || '').length, datesNote: dateNote(assignment), parseFailed: structure.parseFailed || '' },
          units: structure.units,
          structure: {
            headings: structure.headings,
            lists: structure.lists,
            tables: structure.tables,
            images: structure.images,
            links: structure.links,
            headingOffset: structure.headingOffset,
            listOffset: structure.listOffset,
            tableOffset: structure.tableOffset,
            weeks: structure.weeks,
            weekOffset: structure.weekOffset
          },
          rubric: rubric,
          submission: {
            types: subTypes,
            allowedExtensions: exts,
            pointsPossible: assignment && assignment.points_possible != null ? assignment.points_possible : null,
            needsGrading: !!(assignment && assignment.needs_grading_count)
          },
          dates: {
            dueAt: (assignment && assignment.due_at) || '',
            unlockAt: (assignment && assignment.unlock_at) || '',
            lockAt: (assignment && assignment.lock_at) || ''
          },
          resources: { files: structure.files, external: structure.external, metaSkipped: ctxMetaSkipped },
          material: material,
          related: {
            pageRefs: structure.pageRefs,
            quiz: raw.quiz ? { title: raw.quiz.title, timeLimit: raw.quiz.time_limit, attempts: raw.quiz.allowed_attempts, questionCount: raw.quiz.question_count, points: raw.quiz.points_possible } : null,
            newQuiz: raw.newQuiz ? { instructions: htmlToText(raw.newQuiz.instructions || ''), points: raw.newQuiz.points_possible } : null,
            discussion: raw.discussion ? { text: htmlToText(raw.discussion.message || ''), attachment: raw.discussion.attachment || null, requireInitial: !!raw.discussion.require_initial_post } : null,
            moduleItemId: target.moduleItemId || 0,
            siblings: null
          },
          canvasFields: {
            published: assignment ? assignment.published : null,
            gradingType: assignment ? assignment.grading_type : null,
            anonymousGrading: assignment ? assignment.anonymous_grading : null,
            scoreExtensions: assignment ? assignment.score_extensions_needed : null,
            position: assignment ? assignment.position : null,
            updatedAt: assignment ? assignment.updated_at : '',
            htmlUrl: assignment ? assignment.html_url : '',
            quizId: assignment ? assignment.quiz_id : null,
            hasMutedMaterials: !!(assignment && assignment.has_muted_materials)
          }
        };

        ctx.fingerprint = fingerprint([
          structure.rawHTML,
          JSON.stringify(rubric.criteria),
          subTypes.join(','), exts.join(','),
          ctx.dates.dueAt, ctx.dates.unlockAt, ctx.dates.lockAt,
          structure.files.map(function (f) { return f.id + '@' + (f.updatedAt || ''); }).join(';')
        ].join('|'));

        return { ctx: ctx, raw: raw, access: access, structure: structure, assignmentId: assignmentId, courseId: courseId };
      });
    });
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || '').split('?')[0]);
    return m ? m[1].toLowerCase() : '';
  }

  function dateNote(assignment) {
    if (!assignment) return 'no assignment object, so no dates to read';
    var bits = [];
    if (assignment.due_at) bits.push('due ' + assignment.due_at);
    if (assignment.unlock_at) bits.push('opens ' + assignment.unlock_at);
    if (assignment.lock_at) bits.push('stops accepting at ' + assignment.lock_at);
    return bits.length ? bits.join(', ') : 'no due, unlock or lock date is set';
  }

  function documentTitle() {
    var h = document.querySelector('h1.title, #assignment_show h1, .ic-Layout-wrapper h1');
    return h ? String(h.textContent || '').trim() : '';
  }

  /* 站点 DOM 里的说明：只在 API 那份是空的时候当退路，找到哪颗要在窗口里说清楚 */
  var FALLBACK_SELECTORS = ['#assignment_description', '#assignment_details', '.assignment-description', '#quiz_description', '#quiz_show .quiz-description', '#module_item_details'];
  var htmlFromSource = '';

  function pageFallbackHtml() {
    htmlFromSource = '';
    var html = '';
    for (var i = 0; i < FALLBACK_SELECTORS.length; i++) {
      var node = null;
      try { node = document.querySelector(FALLBACK_SELECTORS[i]); } catch (e) { node = null; }
      if (node && String(node.textContent || '').trim().length > 20) {
        html = node.innerHTML;
        htmlFromSource = FALLBACK_SELECTORS[i];
        break;
      }
    }
    return html;
  }

  /* ==== 按需读数：附件正文、关联页面。点了才拉，不替用户批量下载 ==== */

  function lastCourseId() {
    var t = currentTarget();
    return t ? t.courseId : 0;
  }

  function readFile(file, courseId, onStep, opts) {
    opts = opts || {};
    var cached = cacheReadFile(file.id);
    if (cached && cached.text && (!file.updatedAt || cached.updatedAt === file.updatedAt)) {
      file.status = 'extracted';
      file.chars = cached.chars || cached.text.length;
      file.text = cached.text;
      file.fromCache = true;
      return Promise.resolve(file);
    }

    var D = root.MCxData;
    if (!D || !D.read) {
      file.status = 'unavailable';
      file.why = 'the Canvas data layer never loaded on this page, so no file can be read';
      return Promise.resolve(file);
    }
    var resource = {
      id: 'file_' + file.id, kind: 'file', title: file.name || file.label || ('file ' + file.id),
      contentId: file.id, courseId: courseId || lastCourseId(), url: file.sourceUrl || '',
      downloadUrl: file.downloadUrl || '', bytes: file.bytes || 0
    };
    file.status = 'reading';
    return D.read(resource, onStep).then(function (v) {
      if (v && v.ok && v.text) {
        file.status = 'extracted';
        file.chars = v.text.length;
        file.text = v.text;
        file.why = v.why || '';
        try {
          var curT = currentTarget();
          var defCourseName = (root.MCxAssignGuide && root.MCxAssignGuide.lastCtx && root.MCxAssignGuide.lastCtx.courseName) || '';
          var defAssignName = (root.MCxAssignGuide && root.MCxAssignGuide.lastCtx && root.MCxAssignGuide.lastCtx.title) || documentTitle();
          cacheWriteFile(file.id, {
            courseId: courseId || lastCourseId(),
            assignmentId: opts.assignmentId || (curT ? curT.id : 0),
            courseName: opts.courseName || defCourseName || '',
            assignmentName: opts.assignmentName || defAssignName || '',
            name: file.name || ('file ' + file.id),
            ext: file.ext || extOf(file.name),
            chars: file.chars,
            bytes: file.bytes || 0,
            text: file.text,
            updatedAt: file.updatedAt || '',
            at: Date.now()
          });
        } catch (e) {}
      } else {
        file.status = (v && v.bytes) ? 'unreadable' : 'unavailable';
        file.why = (v && v.why) || 'no text came out of it';
        file.chars = 0;
      }
      return file;
    }, function (err) {
      file.status = 'unavailable';
      file.why = String((err && err.message) || err);
      return file;
    });
  }

  function readPage(page, courseId) {
    var D = root.MCxData;
    if (!D || !D.read) {
      page.status = 'unavailable';
      page.why = 'the Canvas data layer never loaded on this page';
      return Promise.resolve(page);
    }
    var resource = {
      id: 'page_' + page.pageUrl, kind: 'page', title: page.label || page.pageUrl,
      pageUrl: page.pageUrl, courseId: page.courseId || courseId || lastCourseId(), url: ''
    };
    page.status = 'reading';
    return D.read(resource).then(function (v) {
      if (v && v.ok && v.text) {
        page.status = 'extracted';
        page.chars = v.text.length;
        page.text = v.text;
      } else {
        page.status = 'unreadable';
        page.why = (v && v.why) || 'the page came back with no text';
      }
      return page;
    }, function (err) {
      page.status = 'unavailable';
      page.why = String((err && err.message) || err);
      return page;
    });
  }

  /* 同一模块里前后还有什么：那是一次整门课的读数，所以只挂在按钮上 */
  function moduleSiblings(courseId, assignmentId) {
    var url = '/api/v1/courses/' + courseId + '/module_item_sequence?asset_type=Assignment&asset_id=' + assignmentId;
    return ask('module sequence', url).then(function (res) {
      return { record: strip(res), list: res.data };
    }, function (err) {
      return { record: strip(recordOf(err)), list: null };
    });
  }

  function strip(rec) {
    var out = {};
    Object.keys(rec).forEach(function (k) { if (k !== 'data') out[k] = rec[k]; });
    return out;
  }

  /* ==== 量材料：只数不读 ====
     页数、字数、里面有几页其实是图片。这些数不需要把正文交给任何人，也不需要 OCR。
     2026-10-12 他拿两份真作业对出来的那条：一份 116 词的短文和一份挂着六份课件的作业，
     在"有多少东西要看"这一维上几乎分不开，因为谁都没量过文件。
     这一趟要下字节（5 MB 以下才量，是他拍的档），所以它跑在第一次出分之后，
     量完补一条 run，不让他对着空白等课件。 */
  function materialTotals(files) {
    var out = { files: (files || []).length, pages: 0, textChars: 0, picturePages: 0, media: 0, counted: 0, skipped: 0 };
    (files || []).forEach(function (f) {
      if (!f.measure) return;
      if (f.measure.skipped) { out.skipped++; return; }
      out.counted++;
      out.pages += f.measure.pages || 0;
      out.textChars += f.measure.chars || 0;
      out.picturePages += f.measure.picturePages || 0;
      out.media += f.measure.media || 0;
    });
    return out;
  }

  function countFiles(ctx, onStep) {
    var D = root.MCxData;
    var jobs = [];
    (ctx.resources.files || []).forEach(function (f) {
      if (f.measure) return;
      if (f.status !== 'metadata_loaded') { f.measure = { skipped: 'no file record came back, so there was nothing to count' }; return; }
      if (!f.bytes) { f.measure = { skipped: 'Canvas gave no size for this file' }; return; }
      if (f.bytes > MEASURE_BYTES_CAP) {
        f.measure = { skipped: Math.round(f.bytes / 1048576) + ' MB, over the ' + Math.round(MEASURE_BYTES_CAP / 1048576) + ' MB this window counts' };
        return;
      }
      if (!D || !D.measure) { f.measure = { skipped: 'the Canvas data layer never loaded on this page' }; return; }
      jobs.push(function () {
        if (onStep) onStep(f);
        return D.measure({
          id: 'file_' + f.id, kind: 'file', title: f.name || f.label || ('file ' + f.id), contentId: f.id,
          courseId: ctx.courseId, url: f.sourceUrl || '', downloadUrl: f.downloadUrl || '', bytes: f.bytes
        }).then(function (m) {
          if (m && m.ok) {
            f.measure = m;
            f.pages = m.pages; f.textChars = m.chars; f.picturePages = m.picturePages; f.media = m.media || 0;
          } else {
            f.measure = { skipped: (m && m.why) || 'nothing countable came out of it' };
          }
          return true;
        }, function (err) {
          f.measure = { skipped: String((err && err.message) || err) };
          return true;
        });
      });
    });
    return runLimited(jobs, MEASURE_CONCURRENCY).then(function () {
      ctx.material = materialTotals(ctx.resources.files);
      return ctx.material;
    });
  }

  /* 你自己交没交：不进判值（判的是要求本身），只在概览里说一句 */
  function submissionState(courseId, assignmentId) {
    if (!root.MCxData || !root.MCxData.submission) return Promise.resolve(null);
    return root.MCxData.submission(courseId, assignmentId).then(function (s) { return s; }, function () { return null; });
  }

  root.MCxAssignData = {
    LOG: LOG,
    log: log,
    currentTarget: currentTarget,
    onAssignmentPage: onAssignmentPage,
    collect: collect,
    structureOf: structureOf,
    fingerprint: fingerprint,
    cacheRead: cacheRead,
    cacheWrite: cacheWrite,
    cacheKey: CACHE_KEY,
    readFile: readFile,
    readPage: readPage,
    moduleSiblings: moduleSiblings,
    countFiles: countFiles,
    materialTotals: materialTotals,
    MEASURE_BYTES_CAP: MEASURE_BYTES_CAP,
    submissionState: submissionState,
    ask: ask,
    recordOf: recordOf,
    readFileIndex: readFileIndex,
    cacheReadFile: cacheReadFile,
    cacheWriteFile: cacheWriteFile,
    removeCachedFile: removeCachedFile,
    clearAllCachedFiles: clearAllCachedFiles
  };
})(typeof window !== 'undefined' ? window : global);
