/* =========================================================
   AI 复习总结的数据层：只负责"从 Canvas 把课的内容读成文字"，不碰画面。
   和它同一条 content script 世界的 study-panel.js 通过 window.MCxData 用它。

   下面这几条口径是 2026-10-09 在他账号（课程 300107 Physics C）实测出来的，不是照文档抄的：
   - /api/v1/courses/:id/files 对学生回 403；/quizzes 和 /pages 那两个列表端点在老师关掉
     对应工具时回 404 "That page has been disabled for this course"。所以资料名单只认
     modules?include[]=items 这一份总索引，逐条详情再按 id 单问。
   - 单文件详情给 size 和下载直链；直链 302 跳到 cdn.*.inscloudgate.net（跨源），
     页面里 fetch 照样读得到完整字节（实测 1,554,664 字节 / 1305 ms）。
   - /quizzes/:id/questions 回 403：题目本身拿不到，考纲只能来自 quiz 的 description。
   - "交没交"只认 submitted_at。workflow_state 会把 missing 判成已交，
     ToDo 列表那一版在这上面翻过车（见 content.js 里那条同内容的注释）。
   ========================================================= */
(function () {
  // 非 Canvas 站点直接退出，严禁挂载全局 message 监听
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
  var LOG = '[MCX study]';

  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  function fail(res, url) {
    var err = new Error('HTTP ' + res.status + ' ' + url);
    err.status = res.status;
    return err;
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw fail(res, url);
        return res.json();
      });
  }

  /* Canvas 每个列表端点都有 per_page 上限，超了就只回最早那一批，不报错也不说截断了。
     planner/items 那条我们已经栽过一次（见文件头），所以这里一律跟 Link: rel="next" 翻完，
     并且给一个页数保险：翻不完也只说"这一路只读到这么多家"，不许悄悄少读 */
  var PAGE_CAP = 8;
  var PAGE_LIMIT = 100;

  function nextPage(link) {
    var head = String(link || '');
    var parts = head.split(',');
    var urls = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg.indexOf('rel="next"') >= 0 || seg.indexOf("rel=next") >= 0) {
        var m = seg.match(/<([^>]+)>/);
        if (m) urls.push(m[1]);
      }
    }
    return urls[0] || '';
  }

  function getJSONPages(url, cap, onStep) {
    var limit = cap || PAGE_CAP;
    var out = [];
    var pages = 0;
    var hitCap = false;
    var total = 0;
    function step(target) {
      pages++;
      return fetch(target, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw fail(res, target);
          var link = res.headers.get('Link') || res.headers.get('link') || '';
          // 这一路是翻页读的，总数只能从响应头拿；拿不到就报"已读多少条"，不许编一个总数
          if (!total) total = Number(res.headers.get('X-TOTAL-COUNT') || res.headers.get('x-total-count') || '') || 0;
          return res.json().then(function (list) {
            if (!Array.isArray(list)) return { stop: true };
            out = out.concat(list);
            if (onStep) onStep(out.length, total);
            var more = nextPage(link);
            if (!more || list.length === 0) return { stop: true };
            if (pages >= limit) {
              // 只有"确实还有下一页却被保险值截住"才叫截断，恰好整除那种不算
              hitCap = true;
              log('this list stopped at page ' + pages + ' (safety cap), more pages were not read:', target);
              return { stop: true };
            }
            return step(more);
          });
        });
    }
    return step(url).then(function () {
      return { list: out, truncated: hitCap };
    });
  }

  function getBytes(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw fail(res, url);
      return res.arrayBuffer();
    });
  }

  /* 解析老师写的 HTML。必须用 DOMParser，不能用 div.innerHTML：
     innerHTML 在解析时就会发起图片请求，失败时元素上那句 onerror 会在我们这个脚本世界里执行，
     而 API key 就存在同一个世界的 localStorage 里。DOMParser 出来的文档是不透明源，
     既不加载资源也不跑内联事件 handler。
     只取 textContent，标签里的字一起当文字读 */
  function parseFragment(html) {
    try {
      var doc = new DOMParser().parseFromString('<body>' + String(html) + '</body>', 'text/html');
      return doc.body || null;
    } catch (e) { return null; }
  }

  function htmlToText(html) {
    if (!html) return '';
    var box = parseFragment(html);
    if (!box) {
      return String(html).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    }
    var kill = box.querySelectorAll('script,style,noscript');
    for (var i = 0; i < kill.length; i++) kill[i].parentNode.removeChild(kill[i]);
    var blocks = box.querySelectorAll('p,li,div,tr,h1,h2,h3,h4,h5,table,pre');
    for (var j = 0; j < blocks.length; j++) {
      if (blocks[j].parentNode) blocks[j].parentNode.insertBefore(document.createTextNode('\n'), blocks[j]);
    }
    return (box.textContent || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n\n+/g, '\n')
      .trim();
  }

  function absoluteUrl(src) {
    if (!src || src.indexOf('data:') === 0) return '';
    try { return new URL(src, location.origin).href; } catch (e) { return ''; }
  }

  // 正文里的图片：只有"传图"那一档开着才用得上（那颗默认关）。
  // 同样走 parseFragment，原因见上面那段：这些地址一旦塞进 innerHTML 就会真被请求一次
  function imagesFromHtml(html, limit) {
    var out = [];
    if (!html) return out;
    var box = parseFragment(html);
    if (!box) return out;
    var imgs = box.querySelectorAll('img[src]');
    for (var i = 0; i < imgs.length && out.length < (limit || 6); i++) {
      var u = absoluteUrl(imgs[i].getAttribute('src'));
      if (u) out.push({ src: u, alt: imgs[i].getAttribute('alt') || '' });
    }
    return out;
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || '').split('?')[0]);
    return m ? m[1].toLowerCase() : '';
  }

  function courseIdOf(resource) {
    var m = /\/courses\/(\d+)/.exec(resource.url || '');
    if (m) return m[1];
    var self = /\/courses\/(\d+)/.exec(location.pathname);
    return self ? self[1] : '';
  }

  /* 并发上限：一门课全选能有几十条，一次性放出去会把这条连接堵死 */
  function mapLimit(list, limit, worker) {
    var out = new Array(list.length);
    var next = 0;
    var running = 0;
    return new Promise(function (resolve) {
      function finish() {
        running--;
        pump();
      }
      function pump() {
        while (running < limit && next < list.length) {
          (function (i) {
            next++;
            running++;
            // 套一层 try：worker 同步抛错的话，异常会从这趟循环里跑出去，
            // 那一趟就会少 resolve 一个，整批读数永远不结束（画面卡在"正在读…"）
            var job;
            try {
              job = Promise.resolve(worker(list[i], i));
            } catch (e) {
              job = Promise.reject(e);
            }
            job.then(function (v) {
              out[i] = v;
              finish();
            }, function (e) {
              out[i] = { error: String((e && e.message) || e) };
              finish();
            });
          })(next);
        }
        if (!running && next >= list.length) resolve(out);
      }
      pump();
    });
  }

  /* ==== 课程 ==== */

  function courses() {
    return getJSONPages('/api/v1/courses?enrollment_state=active&per_page=' + PAGE_LIMIT).then(function (res) {
      if (res.truncated) log('course list hit the page cap, some courses may be missing');
      return res.list.map(function (c) {
        return { id: c.id, name: c.name || '', code: c.course_code || c.name || '', url: c.html_url || ('/courses/' + c.id) };
      });
    });
  }

  function currentCourseId() {
    var m = /\/courses\/(\d+)/.exec(location.pathname);
    return m ? Number(m[1]) : 0;
  }

  /* ===== 用户自己给课程起的名字 =====
     设置里那颗键把它写成 Canvas 的 course nickname，但 Canvas 在自己接口的 context_name 里
     仍然回官方全名（[实测 2026-10-13] /api/v1/conversations 那颗的 context_name 就是
     "Intern/Mentor Program - GT (AAP)-GT-430-440-450-460-Ireland-FY-CHS" 这一长串），
     所以想要他起的那个名字只能自己读这张表。
     先吃 localStorage 里那一份，画面第一帧就是他的叫法；后台再问一次更新，问完才重画。 */
  var NICK_KEY = 'mc_cou…s_v1';
  var nickCache = null;

  function nickReadStored() {
    try {
      var raw = JSON.parse(localStorage.getItem(NICK_KEY) || 'null');
      if (raw && typeof raw === 'object') nickCache = raw;
    } catch (e) { /* 读不到就当没有，下面去问接口 */ }
    return nickCache;
  }

  function nicknames() {
    if (!nickCache) nickReadStored();
    return getJSON('/api/v1/users/self/course_nicknames').then(function (list) {
      var map = {};
      (Array.isArray(list) ? list : []).forEach(function (n) {
        if (n && n.course_id) map[String(n.course_id)] = { name: String(n.name || ''), nick: String(n.nickname || '') };
      });
      nickCache = map;
      try { localStorage.setItem(NICK_KEY, JSON.stringify(map)); } catch (e) {}
      return map;
    }, function () { return nickCache || {}; });
  }

  /* 渲染那一趟是同步的，所以这里只读缓存；没读到就原样回传，等后台那一趟回来再重画 */
  function courseLabel(name, courseId) {
    var text = String(name || '');
    var map = nickCache || nickReadStored();
    if (!map) return text;
    var byId = map[String(courseId || '')];
    if (byId && byId.nick) return byId.nick;
    if (!text) return text;
    for (var k in map) {
      var e = map[k];
      if (!e || !e.nick || !e.name) continue;
      if (text === e.name || text.indexOf(e.name) === 0 || e.name.indexOf(text) === 0) return e.nick;
    }
    return text;
  }

  /* 这门课的老师。"给老师写信"那一屏要列出收信人，所以按 enrollment_type 筛，
     不自己从全站用户里猜。一门课两位老师是常事，名单原样带回去，默认第一位由画面那一头定 */
  function teachers(courseId) {
    var url = '/api/v1/courses/' + courseId + '/users?enrollment_type=teacher&per_page=' + PAGE_LIMIT;
    return getJSON(url).then(function (list) {
      return (Array.isArray(list) ? list : []).map(function (u) {
        return { id: u.id, name: u.name || u.short_name || ('Teacher ' + u.id), pronouns: u.pronouns || '' };
      });
    });
  }

  /* ==== 一条提交自己的情况 ====
     "写信"那一屏从提交详情页叫出来时，作业已经定了，要的是这一条的真相：交没交、批到几分、
     老师回过什么、有没有 rubric。一次请求全带上。
     [实测 2026-10-10 /courses/296970/assignments/14752971/submissions/473100，学生这一侧]
       submissions/self 回 200；workflow_state "graded"、grade "25"、score 25、submitted_at 有；
       这条没有评语，submission_comments 回的是空表（键在，长度 0），所以"没有"和"读不到"要分开：
       回包成功才是没有，失败不能报成没有。
     rubric 走同一条请求的 include[]=rubric_assessment：/assignments/:id/rubric 那个端点在没有 rubric
     时回 404 一页 HTML（同一分钟量到的），而 submissions 这个 include 没数据就是不回这个键，
     不用先处理一次假 404。 */
  function submission(courseId, assignmentId) {
    var url = '/api/v1/courses/' + courseId + '/assignments/' + assignmentId +
      '/submissions/self?include%5B%5D=submission_comments&include%5B%5D=rubric_assessment';
    return getJSON(url).then(function (s) {
      s = s || {};
      var list = Array.isArray(s.submission_comments) ? s.submission_comments : [];
      var ra = s.rubric_assessment && typeof s.rubric_assessment === 'object' ? s.rubric_assessment : null;
      var rubric = [];
      if (ra) {
        Object.keys(ra).forEach(function (k) {
          var c = ra[k] || {};
          var name = c.description || c.title || c.skill_id || '';
          var rating = c.long_description || c.rating_description || '';
          var pts = (c.points == null ? null : c.points);
          var max = (c.outcome_points == null ? null : c.outcome_points);
          if (!name && rating == null && pts == null) return;
          rubric.push({ name: String(name), rating: String(rating), points: pts, maxPoints: max });
        });
      }
      return {
        state: String(s.workflow_state || ''),
        grade: s.grade == null ? '' : String(s.grade),
        score: (s.score == null ? null : s.score),
        submittedAt: s.submitted_at || '',
        late: !!s.late,
        missing: s.missing === true || s.workflow_state === 'missing',
        comments: list.filter(function (c) { return c && c.comment; }).map(function (c) {
          return { text: htmlToText(c.comment), at: c.created_at || '' };
        }),
        rubric: rubric
      };
    });
  }

  /* ==== 任务 ====
     数据源是这一门课的 assignments，不是 planner/items：planner 那条会被 per_page 截断
     （320 天的窗口只回最早 100 条），而"翻出以前做完的"正好是最长窗口那一头。
     include[]=submission 让一次请求就带上 submitted_at。 */

  function tasks(courseId, onStep) {
    var url = '/api/v1/courses/' + courseId + '/assignments?per_page=' + PAGE_LIMIT + '&include[]=submission&order_by=due_at';
    return getJSONPages(url, null, onStep).then(function (res) {
      // due_at 是升序，所以被保险值截住时丢掉的是"最晚的那批"，也就是默认那一档看得见的未来任务
      if (res.truncated) log('task list hit the page cap; the latest items were not listed', courseId);
      var rows = res.list.map(function (a) {
        var sub = a.submission || {};
        return {
          id: a.id,
          name: a.name || '',
          dueAt: a.due_at || '',
          dueMs: a.due_at ? Date.parse(a.due_at) : 0,
          points: (a.points_possible == null ? null : a.points_possible),
          url: a.html_url || '',
          description: a.description || '',
          quizId: a.quiz_id || 0,
          submittedAt: sub.submitted_at || '',
          done: !!sub.submitted_at,
          graded: sub.workflow_state === 'graded',
          // 没判分的那一条 Canvas 回的是 null，不是 0：写信那一屏要拿它和"总分"分开摆
          score: sub.score == null ? null : sub.score,
          kind: a.quiz_id ? 'quiz' : 'assignment'
        };
      });
      rows.sort(function (x, y) { return (y.dueMs || 0) - (x.dueMs || 0); });
      return rows;
    });
  }

  /* ==== 资料名单：一次模块请求当总索引 ====
     File 条目给 content_id、Page 给 page_url、Quiz/Assignment 给 content_id，
     这些就是逐条详情的入口。SubHeader 是老师分小节用的，不是一种资料。 */

  var KIND_OF = {
    File: 'file',
    Page: 'page',
    Quiz: 'quiz',
    Assignment: 'assignment',
    Discussion: 'discussion',
    ExternalTool: 'link',
    ExternalUrl: 'link',
    Url: 'link',
    BasicLtiLaunch: 'link',
    LTIToolPlacement: 'link'
  };

  var READABLE = { file: 1, page: 1, quiz: 1, assignment: 1, discussion: 1 };

  function resources(courseId, onStep) {
    return getJSONPages('/api/v1/courses/' + courseId + '/modules?include[]=items&per_page=' + PAGE_LIMIT, null, onStep)
      .then(function (res) {
        if (res.truncated) log('module list hit the page cap', courseId);
        // 带着 include[]=items 时，单个模块里回的条目也有上限；正好顶到那个数的要单独再翻一次
        var wide = res.list.filter(function (m) { return (m.items || []).length >= PAGE_LIMIT; });
        return mapLimit(wide, 3, function (m) {
          return getJSONPages('/api/v1/courses/' + courseId + '/modules/' + m.id + '/items?per_page=' + PAGE_LIMIT)
            .then(function (full) {
              if (full.list.length) m.items = full.list;
              return true;
            }, function (err) {
              // 这一条要是悄悄失败，那一节就停在正好 100 条上，看不出来。点名一句
              log('section ' + (m.name || m.id) + ': re-read of its items failed, this section may stop at ' + PAGE_LIMIT + ' items:', String((err && err.message) || err));
              return false;
            });
        }).then(function () {
          var out = [];
          res.list.forEach(function (m) {
            (m.items || []).forEach(function (it) {
              var kind = KIND_OF[it.type] || '';
              if (!kind) return;
              out.push({
                id: it.id,
                kind: kind,
                rawType: it.type,
                title: it.title || '',
                module: m.name || '',
                moduleId: m.id,
                contentId: it.content_id || 0,
                pageUrl: it.page_url || '',
                url: it.html_url || it.external_url || '',
                dueAt: it.due_at || '',
                readable: !!READABLE[kind],
                courseId: courseId
              });
            });
          });
          return out;
        });
      });
  }

  /* ==== 逐条详情：先补齐"它有多大"，选好资料那一屏要报实数不是估的 ==== */

  function detail(resource) {
    var cid = resource.courseId || courseIdOf(resource);
    if (resource.kind === 'file') {
      return getJSON('/api/v1/files/' + resource.contentId).then(function (f) {
        return {
          ok: true,
          name: f.display_name || resource.title,
          bytes: f.size || 0,
          ext: extOf(f.display_name || ''),
          mime: f.content_type || '',
          downloadUrl: f.url || '',
          how: 'file'
        };
      });
    }
    if (resource.kind === 'page' && cid) {
      return getJSON('/api/v1/courses/' + cid + '/pages/' + encodeURIComponent(resource.pageUrl))
        .then(function (p) {
          var text = htmlToText(p.body || '');
          return { ok: true, name: p.title || resource.title, chars: text.length, html: p.body || '', how: 'html' };
        });
    }
    if (resource.kind === 'quiz' && cid) {
      return getJSON('/api/v1/courses/' + cid + '/quizzes/' + resource.contentId)
        .then(function (q) {
          var text = htmlToText(q.description || '');
          return {
            ok: true, name: q.title || resource.title, chars: text.length, html: q.description || '',
            questionCount: q.question_count || 0, points: (q.points_possible == null ? null : q.points_possible),
            how: 'html'
          };
        });
    }
    if (resource.kind === 'assignment' && cid) {
      return getJSON('/api/v1/courses/' + cid + '/assignments/' + resource.contentId)
        .then(function (a) {
          var text = htmlToText(a.description || '');
          return { ok: true, name: a.name || resource.title, chars: text.length, html: a.description || '', how: 'html' };
        });
    }
    if (resource.kind === 'discussion' && cid) {
      return getJSON('/api/v1/courses/' + cid + '/discussion_topics/' + resource.contentId)
        .then(function (d) {
          var text = htmlToText(d.message || '');
          return { ok: true, name: d.title || resource.title, chars: text.length, html: d.message || '', how: 'html' };
        });
    }
    return Promise.resolve({ ok: false, name: resource.title, chars: 0, why: 'nothing readable in this item' });
  }

  /* 逐条大小。onEach 每读完一条回调一次，让画面能报"第几条 of 共几条"，
     而不是只有一句"正在读" */
  function details(list, onEach) {
    return mapLimit(list, 5, function (r) {
      return detail(r).then(function (v) {
        if (onEach) onEach(r, v);
        return v;
      });
    });
  }

  /* 测验的考纲文字住在 quiz 那一层，不在 assignment 那层：点进单条测验才读得到。
     题目本身读不到（403），这一段说明是能拿到的最多 */
  function quizScope(courseId, quizId) {
    return getJSON('/api/v1/courses/' + courseId + '/quizzes/' + quizId).then(function (q) {
      var text = htmlToText(q.description || '');
      return { chars: text.length, text: text, name: q.title || '', questionCount: q.question_count || 0 };
    }, function (err) {
      return { chars: 0, text: '', name: '', error: String((err && err.message) || err) };
    });
  }

  /* ==== 课件里的文字 ====
     PDF 使用本地 PDF.js 模块和 worker；PPTX 和 DOCX 本质是 zip，用
     vendor/jszip.min.js 解出 xml 取文字。所有可执行代码都随扩展打包。 */

  function extensionUrl(file) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL(file);
      }
    } catch (e) {}
    return '';
  }

  var pdfJsPromise = null;

  function pdfDocument(bytes) {
    if (!pdfJsPromise) {
      // Load the packaged PDF.js module. Its worker is also an extension URL
      // below; PDF.js's internal _createCDNWrapper exists for cross-origin
      // callers but is not used to fetch a CDN worker in this extension path.
      var moduleUrl = extensionUrl('vendor/pdf.mjs');
      if (!moduleUrl) return Promise.reject(new Error('the PDF library URL is unavailable'));
      pdfJsPromise = import(moduleUrl).catch(function (err) {
        pdfJsPromise = null;
        throw err;
      });
    }
    return pdfJsPromise.then(function (lib) {
      var workerUrl = extensionUrl('vendor/pdf.worker.mjs');
      if (!workerUrl || !lib.GlobalWorkerOptions) {
        throw new Error('the PDF worker URL is unavailable');
      }
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0
      }).promise;
    });
  }

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
  }

  function pptxText(bytes) {
    if (typeof JSZip === 'undefined') return Promise.reject(new Error('the unpack library did not load'));
    return JSZip.loadAsync(bytes).then(function (zip) {
      var names = Object.keys(zip.files).filter(function (n) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(n);
      }).sort(function (a, b) {
        return (parseInt(a.split('/').pop(), 10) || 0) - (parseInt(b.split('/').pop(), 10) || 0);
      });
      if (!names.length) return '';
      return mapLimit(names, 4, function (n) {
        return zip.file(n).async('string').then(function (xml) {
          // 一个 </a:p> 是一段结束的文字，先按段切开，否则整页糊成一串
          var bits = [];
          String(xml).split('</a:p>').forEach(function (p) {
            var t = decodeEntities(p.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
            if (t) bits.push(t);
          });
          return bits.join('\n');
        });
      }).then(function (pages) {
        var keep = [];
        pages.forEach(function (t, i) {
          if (t && !t.error) keep.push('Page ' + (i + 1) + '\n' + t);
        });
        return keep.join('\n\n');
      });
    });
  }

  function docxText(bytes) {
    if (typeof JSZip === 'undefined') return Promise.reject(new Error('the unpack library did not load'));
    return JSZip.loadAsync(bytes).then(function (zip) {
      var f = zip.file('word/document.xml');
      if (!f) return '';
      return f.async('string').then(function (xml) {
        var bits = [];
        String(xml).split(/<\/w:p>/).forEach(function (p) {
          var t = decodeEntities(p.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).trim();
          if (t) bits.push(t);
        });
        return bits.join('\n');
      });
    });
  }

  /* ==== 本地 OCR：扫描版 PDF 和不带文字的课件图片 ====
     pdf.js 抽不出字的那些页，画到 canvas 上交给 vendor/ocr 里那颗 tesseract-wasm。
     引擎本体不在这里跑，在 ocr-frame.html 那一页跑，理由写在那份文件顶上。 */

  var OCR_MIN_CHARS = 25;   // 一页抽到不到这点字，就当中它是扫描页
  var OCR_PAGE_CAP = 24;    // 一份文件最多 OCR 这么多页，再多的宁可少读也不要一直转
  var OCR_SCALE = 2;        // pdf.js 的 scale，约 150 DPI：字够清楚，一页一秒到几秒
  var OCR_READY_MS = 8000;  // 那一页没在这么久内答话，就当这台浏览器跑不起来
  var OCR_IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, bmp: 1, webp: 1 };

  var ocr = { frame: null, ready: null, seq: 0, pending: {}, origin: '' };

  /* 和设置面板那颗 check 同一个口径：没存过算开，存了 '0' 才算关。
     正本在扩展自己的存储里（那一档归 study-storage.js 管），它不在时才退回页面存储那一格 */
  function ocrOn() {
    // AI 总开关关掉：扫描页和图片一律不认，那一帧 tesseract 也不会被拉起来
    if (window.mcAiOn && !window.mcAiOn()) return false;
    var s = window.MCxStorage;
    if (s && s.switchOn) return s.switchOn('mc_ai_ocr');
    try {
      return localStorage.getItem('mc_ai_ocr') !== '0';
    } catch (e) {
      return true;
    }
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !ocr.frame || ev.source !== ocr.frame.contentWindow) return;
    // 回话的必须是那一页自己：这一颗 iframe 挂在页面 DOM 里，谁都能拿到它的引用去发消息
    if (d.type === 'mcx-ocr-alive') {
      if (ocr.origin && ev.origin !== ocr.origin) return;
      if (ocr.wait) ocr.wait();
      return;
    }
    if (d.type !== 'mcx-ocr-result') return;
    if (ocr.origin && ev.origin !== ocr.origin) return;
    var job = ocr.pending[d.id];
    if (!job) return;
    delete ocr.pending[d.id];
    if (d.ok) job.resolve(d.text);
    else job.reject(new Error(d.error || 'OCR did not answer'));
  });

  function ocrFrame() {
    if (ocr.ready) return ocr.ready;
    ocr.ready = new Promise(function (resolve, reject) {
      var el = document.createElement('iframe');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:0';
      var timer = 0;
      ocr.wait = function () {
        clearTimeout(timer);
        ocr.wait = null;
        resolve(el);
      };
      var fail = function () {
        clearTimeout(timer);
        ocr.wait = null;
        ocr.frame = null;
        ocr.ready = null;
        if (el.parentNode) el.parentNode.removeChild(el);
        reject(new Error('the OCR frame did not answer within ' + (OCR_READY_MS / 1000) + ' s'));
      };
      timer = setTimeout(fail, OCR_READY_MS);
      ocr.frame = el;
      el.src = extensionUrl('ocr-frame.html');
      ocr.origin = frameOrigin(el.src);
      /* 由我们点名，它才答话（原来是它一加载就朝星号喊一声，任何嵌得进来的页面都听得见）。
         load 事件排在它那份模块脚本执行之后，所以这一发一定接得住；
         接不住就是引擎没起来，8 秒那一条照旧把这帧撤掉 */
      el.addEventListener('load', function () {
        try { el.contentWindow.postMessage({ type: 'mcx-ocr-ping' }, ocr.origin); } catch (e) {}
      });
      document.documentElement.appendChild(el);
    });
    return ocr.ready;
  }

  function frameOrigin(src) {
    try { return new URL(src).origin; } catch (e) { return ''; }
  }

  /* 一张整页位图进去，认出来的文字出来 */
  function ocrPage(image) {
    return ocrFrame().then(function (el) {
      return new Promise(function (resolve, reject) {
        var id = ++ocr.seq;
        ocr.pending[id] = { resolve: resolve, reject: reject };
        postJob(el, {
          type: 'mcx-ocr', id: id, w: image.width, h: image.height, bytes: image.data.buffer
        }, reject);
      });
    });
  }

  /* 只给一个 URL 的那种：取字节、解码、压长边全在扩展页那一头做。
     页面这一头 fetch 会被 CORS 挡（/files/…/preview 重定向到文件集群），
     降级成 <img> 又会被判画布污染，所以这条路不在这里碰 canvas */
  function ocrUrl(url, maxSide) {
    return ocrFrame().then(function (el) {
      return new Promise(function (resolve, reject) {
        var id = ++ocr.seq;
        ocr.pending[id] = { resolve: resolve, reject: reject };
        postJob(el, {
          type: 'mcx-ocr', id: id, url: url, maxSide: maxSide || 0
        }, reject);
      });
    });
  }

  /* 活只递给那一页自己的 origin（原来是星号：谁嵌得进这颗 iframe，谁就能收结果）。
     origin 读不出来就是扩展上下文已经失效（重载过），这一发递出去也没人接，直接回个错 */
  function postJob(el, payload, reject) {
    if (!ocr.origin) {
      if (ocr.pending[payload.id]) delete ocr.pending[payload.id];
      reject(new Error('the extension context is no longer available on this page'));
      return;
    }
    try {
      el.contentWindow.postMessage(payload, ocr.origin);
    } catch (e) {
      if (ocr.pending[payload.id]) delete ocr.pending[payload.id];
      reject(e);
    }
  }

  function blankCanvas(w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    var ctx = canvas.getContext('2d');
    // 先铺白底：画布是透明的话整页在 OCR 眼里就是黑的，一个字也认不出来
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas: canvas, ctx: ctx };
  }

  function pageImageData(doc, n) {
    return doc.getPage(n).then(function (page) {
      var vp = page.getViewport({ scale: OCR_SCALE });
      var made = blankCanvas(vp.width, vp.height);
      return page.render({ canvasContext: made.ctx, viewport: vp }).promise.then(function () {
        var data = made.ctx.getImageData(0, 0, made.canvas.width, made.canvas.height);
        made.canvas.width = 0;
        made.canvas.height = 0;
        return data;
      });
    });
  }

  function imageDataFromBytes(bytes) {
    /* 解码走 createImageBitmap：这一条整页量到过 1.4 秒（含识别）。
       同一台机器上换 new Image 加 onload 那条量到过 12 秒，我没把"是解码被推迟"
       这一条钉死，所以不走它 */
    return createImageBitmap(new Blob([bytes])).then(function (bmp) {
      var made = blankCanvas(bmp.width, bmp.height);
      made.ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      var data = made.ctx.getImageData(0, 0, made.canvas.width, made.canvas.height);
      made.canvas.width = 0;
      made.canvas.height = 0;
      return data;
    });
  }

  function pageText(doc, n) {
    return doc.getPage(n).then(function (page) {
      return page.getTextContent().then(function (tc) {
        var chunks = [];
        var lastChar = '';
        var previous = null;
        (tc.items || []).forEach(function (it) {
          var text = typeof it.str === 'string' ? it.str : '';
          if (!text) {
            if (it.hasEOL && lastChar !== '\n') {
              chunks.push('\n');
              lastChar = '\n';
            }
            return;
          }

          var matrix = it.transform || [];
          var fontSize = Math.hypot(Number(matrix[0]) || 0, Number(matrix[1]) || 0) || it.height || 12;
          var horizontal = matrix.length >= 4 && Math.abs(Number(matrix[1]) || 0) < 0.01 &&
            Math.abs(Number(matrix[2]) || 0) < 0.01;
          var x = Number(matrix[4]);
          var y = Number(matrix[5]);

          if (previous && lastChar !== '\n' && previous.horizontal && horizontal &&
              Number.isFinite(x) && Number.isFinite(y)) {
            var baselineGap = Math.abs(y - previous.y);
            var lineThreshold = Math.max(fontSize, previous.fontSize) * 0.55;
            if (baselineGap > lineThreshold) {
              chunks.push('\n');
              lastChar = '\n';
            } else if (it.dir !== 'rtl' && previous.dir !== 'rtl') {
              var gap = x - (previous.x + previous.width);
              var spaceThreshold = Math.max(1, Math.min(fontSize, previous.fontSize) * 0.16);
              if (gap > spaceThreshold && !/\s$/.test(lastChar) && !/^\s/.test(text)) {
                chunks.push(' ');
                lastChar = ' ';
              }
            }
          }

          chunks.push(text);
          lastChar = text.charAt(text.length - 1);
          if (it.hasEOL && lastChar !== '\n') {
            chunks.push('\n');
            lastChar = '\n';
          }

          previous = {
            x: x,
            y: y,
            width: Number(it.width) || 0,
            fontSize: fontSize,
            dir: it.dir,
            horizontal: horizontal
          };
        });
        return chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      });
    });
  }

  /* 哪几页抽不到字就 OCR 哪几页：一份"前几页是打字、后面是扫描"的混合件，
     不该因为前几页有字就整份跳过，也不该把有字的那几页重认一遍 */
  function ocrThinPages(doc, pages, onStep) {
    if (!ocrOn()) return Promise.resolve(0);
    var thin = [];
    pages.forEach(function (t, i) {
      if (!t || String(t).trim().length < OCR_MIN_CHARS) thin.push(i + 1);
    });
    if (!thin.length) return Promise.resolve(0);
    var take = thin.slice(0, OCR_PAGE_CAP);
    var done = 0;
    /* 报一步，返回 false 就是"这一趟人已经不要了"：按了 Stop 还继续把 24 页认完，
       屏幕上什么都看不见，只有风扇在转 */
    function step(msg) { return onStep ? onStep(msg) !== false : true; }
    if (!step('reading ' + take.length + ' scanned page' + (take.length > 1 ? 's' : '') + ' with OCR...')) return Promise.resolve(0);
    // 一次一页：并发递进去也只是在那一头排队，而这里会同时摆着好几张整页位图
    return mapLimit(take, 1, function (n) {
      if (!step('OCR page ' + (done + 1) + ' of ' + take.length)) return Promise.resolve(false);
      return pageImageData(doc, n).then(function (image) {
        return ocrPage(image);
      }).then(function (text) {
        pages[n - 1] = text;
        done++;
        return true;
      }, function (err) {
        done++;
        log('page ' + n + ': OCR failed:', String((err && err.message) || err));
        return false;
      });
    }).then(function (all) {
      if (thin.length > take.length) return -1;
      return all.filter(Boolean).length;
    });
  }

  function pdfText(bytes, onStep) {
    return pdfDocument(bytes).then(function (doc) {
        var jobs = [];
        for (var i = 1; i <= doc.numPages; i++) jobs.push(i);
        return mapLimit(jobs, 3, function (n) {
          return pageText(doc, n);
        }).then(function (pages) {
          // 某一页抽字失败时 mapLimit 放回来的是 { error } 那颗对象，
          // 直接 String() 会得到 "[object Object]"，既进不了 OCR 判据也糊进正文
          var texts = pages.map(function (t) { return typeof t === 'string' ? t : ''; });
          return ocrThinPages(doc, texts, onStep).then(function (capped) {
            var keep = [];
            texts.forEach(function (t, i) {
              if (t && String(t).trim()) keep.push('Page ' + (i + 1) + '\n' + String(t).trim());
            });
            if (capped < 0) {
              keep.push('Note: this file has more scanned pages than the ' + OCR_PAGE_CAP +
                ' read here, so the later ones are missing from this material.');
            }
            doc.destroy();
            return keep.join('\n\n');
          });
        });
      });
  }

  var PLAIN = { txt: 1, md: 1, csv: 1, json: 1 };
  // .ppt/.doc 是老的二进制办公格式，jszip 打不开（它们不是 zip），
  // 与其返回空字符串让上面判成"扫描版"，不如当场说清是哪一档
  var LEGACY_OFFICE = { ppt: 1, doc: 1, xls: 1 };

  function fileText(detail, bytes, onStep) {
    var ext = detail.ext || '';
    if (ext === 'pdf') return pdfText(bytes, onStep);
    if (OCR_IMAGE_EXT[ext]) {
      if (!ocrOn()) return Promise.resolve('');
      return imageDataFromBytes(bytes).then(ocrPage);
    }
    if (ext === 'pptx' || ext === 'docx') return ext === 'pptx' ? pptxText(bytes) : docxText(bytes);
    if (LEGACY_OFFICE[ext]) return Promise.reject(new Error('the old .' + ext + ' format carries no text this can unpack; only the .' + ext + 'x package format can be read here'));
    if (PLAIN[ext]) return Promise.resolve(new TextDecoder('utf-8').decode(new Uint8Array(bytes)));
    return Promise.resolve('');
  }

  /* 一条资料的正文。图片那一档（传图开关）只在这一步之后决定要不要额外发图，
     文字永远先拿，因为它不要 vision 模型 */
  function read(resource, onStep) {
    return detail(resource).then(function (d) {
      if (!d.ok) return { ok: false, name: d.name || resource.title, why: d.why || 'this item could not be read', text: '', images: [] };
      if (d.how === 'html') {
        return {
          ok: true, name: d.name, text: htmlToText(d.html), images: imagesFromHtml(d.html),
          chars: d.chars, bytes: 0, kind: resource.kind, questionCount: d.questionCount || 0
        };
      }
      var maxBytes = 24 * 1024 * 1024;
      if (d.bytes > maxBytes) {
        return { ok: false, name: d.name, why: 'the file is ' + Math.round(d.bytes / 1048576) + ' MB, over the 24 MB per-file limit', text: '', images: [], bytes: d.bytes };
      }
      return getBytes(d.downloadUrl).then(function (bytes) {
        return fileText(d, bytes, onStep).then(function (text) {
          text = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n\n+/g, '\n').trim();
          return {
            ok: true, name: d.name, text: text, images: [], chars: text.length,
            bytes: d.bytes, kind: 'file', ext: d.ext,
            why: text ? '' : emptyWhy(d.ext)
          };
        });
      }).catch(function (e) {
        return { ok: false, name: d.name, why: String((e && e.message) || e), text: '', images: [], bytes: d.bytes };
      });
    });
  }

  /* 抽不到字那一句要跟着开关走：关了 OCR 的时候说"可能是扫描版"，
     等于把用户往一个他自己刚拧掉的地方推 */
  function emptyWhy(ext) {
    if (ext === 'ppt' || ext === 'doc' || ext === 'xls') return 'the old Office format (.' + ext + ') carries no text here';
    if (!ocrOn()) {
      if (OCR_IMAGE_EXT[ext]) return 'it is a picture, and reading text out of pictures is switched off in Settings';
      if (ext === 'pdf') return 'no text could be pulled from it, so it looks like a scan; reading scans is switched off in Settings';
    }
    return 'no text could be pulled from it, it may be a scan';
  }

  function readMany(list, onEach, onStep) {
    return mapLimit(list, 3, function (r) {
      return read(r, function (step) {
        return onStep ? onStep(r, step) : undefined;
      }).then(function (v) {
        if (onEach) onEach(r, v);
        return v;
      });
    });
  }

  /* 图片转 base64 给 vision 那一档。
     优先走 getBytes() 取字节（最稳妥）；如果因为 Canvas 重定向到 user-content 集群导致
     fetch 被 CORS 拦截，退回到直接用 new Image() 加载并尝试从 canvas 导出 */
  function imageAsDataUrl(url, maxSide) {
    function scaleAndExport(img, done) {
      try {
        var side = maxSide || 1024;
        var scale = Math.min(1, side / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        done({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), w: canvas.width, h: canvas.height });
      } catch (err) {
        done({ error: 'canvas export tainted: ' + String((err && err.message) || err) });
      }
    }

    function fallbackViaImg(src) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () { scaleAndExport(img, resolve); };
        img.onerror = function () {
          // 如果 anonymous 失败，再试一次不带 crossOrigin（部分带 token 的直链不支持 anonymous）
          var img2 = new Image();
          img2.onload = function () { scaleAndExport(img2, resolve); };
          img2.onerror = function () { resolve({ error: 'image could not be loaded directly' }); };
          img2.src = src;
        };
        img.src = src;
      });
    }

    return getBytes(url).then(function (bytes) {
      return new Promise(function (resolve) {
        var blob = new Blob([bytes]);
        var objectUrl = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          scaleAndExport(img, function (res) {
            URL.revokeObjectURL(objectUrl);
            resolve(res);
          });
        };
        img.onerror = function () {
          URL.revokeObjectURL(objectUrl);
          resolve({ error: 'this image could not be decoded from blob' });
        };
        img.src = objectUrl;
      });
    }).catch(function (e) {
      // 遇到 CORS 拦截（比如重定向到 canvas-user-content 集群），走直接 Image 降级
      return fallbackViaImg(url);
    });
  }

  /* ==== 只量不读：数一份文件里有多少页、多少字、多少页其实是图 ====
     判"这份作业有多少材料"不需要先把正文吞下来：页数和字数就够把
     "页上挂着六份课件"和"就一行字"分开。所以这一路只回计数，不回正文。
     复用上面那三套解包（pdf.js / jszip），不另起一份解析。 */
  var MEASURE_PAGE_CAP = 60;    // 一份最多数这么多页，再多的只报"不止"
  var MEASURE_THIN_CHARS = 25;  // 和 OCR 那颗同一档：一页抽不到这点字就当中它是张图

  function measurePdf(bytes) {
    return pdfDocument(bytes).then(function (doc) {
        var total = doc.numPages || 0;
        var take = Math.min(total, MEASURE_PAGE_CAP);
        var jobs = [];
        for (var i = 1; i <= take; i++) jobs.push(i);
        var chars = 0;
        var thin = 0;
        return mapLimit(jobs, 4, function (n) {
          return pageText(doc, n).then(function (t) {
            var s = typeof t === 'string' ? t : '';
            chars += s.trim().length;
            if (s.trim().length < MEASURE_THIN_CHARS) thin++;
            return true;
          }, function () { return false; });
        }).then(function () {
          doc.destroy();
          return {
            pages: total, pagesCounted: take, chars: chars, picturePages: thin,
            note: total > take ? 'counted the first ' + take + ' of ' + total + ' pages' : ''
          };
        });
      });
  }

  /* PPTX 和 DOCX 是 zip：数文字之外还数里面嵌了多少张图（media 目录里的东西）。
     一页全是截图的幻灯片，字数抽得到、图片也数得到，两边都要报。 */
  function measurePackage(bytes, textFiles, mediaFolder) {
    if (typeof JSZip === 'undefined') return Promise.reject(new Error('the unpack library did not load'));
    return JSZip.loadAsync(bytes).then(function (zip) {
      var names = Object.keys(zip.files);
      var media = 0;
      names.forEach(function (n) {
        if (mediaFolder && n.indexOf(mediaFolder) === 0 && !zip.files[n].dir) media++;
      });
      var wanted = names.filter(function (n) {
        for (var i = 0; i < textFiles.length; i++) if (textFiles[i].test(n)) return true;
        return false;
      });
      return mapLimit(wanted, 6, function (n) {
        return zip.files[n].async('string').then(function (xml) {
          return decodeEntities(String(xml).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().length;
        }, function () { return 0; });
      }).then(function (lens) {
        var chars = 0;
        (lens || []).forEach(function (v) { if (typeof v === 'number') chars += v; });
        return { pages: wanted.length, pagesCounted: wanted.length, chars: chars, picturePages: 0, media: media };
      });
    });
  }

  function measure(resource) {
    return detail(resource).then(function (d) {
      if (!d.ok) return { ok: false, name: d.name || resource.title, why: d.why || 'the file record could not be read' };
      var ext = d.ext || extOf(d.name || '');
      if (!d.bytes) return { ok: false, name: d.name, why: 'Canvas gave no size for this file' };
      if (ext === 'pdf') {
        return getBytes(d.downloadUrl).then(function (bytes) {
          return measurePdf(bytes).then(function (m) {
            m.ok = true; m.name = d.name; m.ext = ext; m.bytes = d.bytes; return m;
          });
        });
      }
      if (ext === 'pptx') {
        return getBytes(d.downloadUrl).then(function (bytes) {
          return measurePackage(bytes, [/^ppt\/slides\/slide\d+\.xml$/], 'ppt/media/').then(function (m) {
            m.ok = true; m.name = d.name; m.ext = ext; m.bytes = d.bytes; return m;
          });
        });
      }
      if (ext === 'docx') {
        return getBytes(d.downloadUrl).then(function (bytes) {
          return measurePackage(bytes, [/^word\/document\.xml$/, /^word\/footnotes\.xml$/, /^word\/endnotes\.xml$/], 'word/media/').then(function (m) {
            m.ok = true; m.name = d.name; m.ext = ext; m.bytes = d.bytes; return m;
          });
        });
      }
      if (OCR_IMAGE_EXT[ext]) {
        return Promise.resolve({ ok: true, name: d.name, ext: ext, bytes: d.bytes, pages: 0, pagesCounted: 0, chars: 0, picturePages: 1, media: 1, why: 'a single picture, nothing to count but its size' });
      }
      if (PLAIN[ext]) {
        return getBytes(d.downloadUrl).then(function (bytes) {
          var text = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
          return { ok: true, name: d.name, ext: ext, bytes: d.bytes, pages: 1, pagesCounted: 1, chars: String(text || '').trim().length, picturePages: 0, media: 0 };
        });
      }
      return { ok: false, name: d.name, ext: ext, bytes: d.bytes, why: 'this file type carries nothing countable here (.' + ext + ')' };
    });
  }

  // 报数那一屏：字符数换算成 token 只是给个量级，不是模型自己的计数
  function estimateTokens(chars) {
    return Math.round((chars || 0) / 3.6);
  }

  window.MCxData = {
    log: log,
    courses: courses,
    currentCourseId: currentCourseId,
    nicknames: nicknames,
    courseLabel: courseLabel,
    teachers: teachers,
    tasks: tasks,
    submission: submission,
    resources: resources,
    detail: detail,
    details: details,
    quizScope: quizScope,
    read: read,
    readMany: readMany,
    measure: measure,
    htmlToText: htmlToText,
    imagesFromHtml: imagesFromHtml,
    imageAsDataUrl: imageAsDataUrl,
    /* 正文那张照片的"转文字"：只递 URL，取字节与解码都在扩展页那一头做，
       不在这里再养一帧 tesseract（引擎正本就是上面 ocrPage 用的那一颗）。
       fetchBytes 留给下载用：那条走的是同源那一份 /download，不会被 CORS 挡 */
    fetchBytes: getBytes,
    ocrUrl: ocrUrl,
    estimateTokens: estimateTokens
  };
})();
