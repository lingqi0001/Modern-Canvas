/* =========================================================
   自定义主题的数据层：库里有哪些主题、贴图存在哪儿、一张图用的是哪个区域、
   打包下载，以及把一份自定义主题翻译成 mcApplyThemeJson 认得的那份 JSON。

   三处脚本都要用它：theme-boot.js 在首帧、content.js 在取色轮、settings.js 在设置面板。
   manifest 把它排在同组别的脚本前面，谁先跑到谁挂上 window.mcLib，后跑的那份直接退出
   （同一扩展的内容脚本共用一个 isolated world，挂一次就够）。

   贴图一律不抄进快照。快照里只写一个 mc-img://<主题 id>/<位置> 的引用，
   样式表写进 DOM 那一刻才由 resolve() 换成真的图：
   一张 300KB 的图要是抄四份（库、surfaces、cards、themeCss），localStorage 很快就装不下，
   而一条引用只有三十来个字符。
   ========================================================= */
(function () {
  'use strict';

  // 仅在指定域名规则下自动开启，其他网址必须手动添加:
  // 1. *.instructure.com 官方域名
  // 2. 以 canvas. 开头的学校域名 (如 canvas.harvard.edu)
  // 3. 包含 .canvas. 或 -canvas. 的专用域名 (如 online.canvas.school.edu 或 lms-canvas.school.edu)
  // 4. 用户在 Popup 或设置里手动添加的学校名单 (mc_custom_domains_cache)
  function detectIsCanvas() {
    try {
      var h = window.location.hostname.toLowerCase();
      // 规则 1: *.instructure.com, canvas.net, *.canvaslms.com
      if (h === 'instructure.com' || h.endsWith('.instructure.com') || h === 'canvas.net' || h.endsWith('.canvaslms.com')) return true;
      // 规则 2 & 3: canvas.* 或 *.canvas.* 或 *-canvas.*
      if (h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1) return true;
      // 规则 4: 用户手动添加的自定义域名
      var customStr = localStorage.getItem('mc_custom_domains_cache') || '';
      if (customStr && customStr.indexOf(h) !== -1) return true;
    } catch (e) {}
    return false;
  }

  // 挂载识别结果供所有脚本首行快速判定
  if (typeof window.mcIsCanvas === 'undefined') {
    window.mcIsCanvas = detectIsCanvas();
  }

  /* ==== AI 总开关的同步读法 ====
     正本在扩展自己的存储里（study-storage.js 白名单那一格），页面这一头是它的同步影子：
     nav-boot.js 在 document_start 就要按它决定侧栏画不画那一行，等不了 Promise。
     口径和排版、OCR 那两颗一字不差：没存过算开，只有存了 '0' 才算关，老用户升级后一切照旧。
     这颗必须挂在"非 Canvas 就退出"那两句前面，而且要定义得早：manifest 里注入它的名单有两处
     （document_start 那一组和 document_idle 那一组），后台按域名现注册时只有后一组。
     两边共用的就是这个函数，别再抄第二份 'mc_ai_enabled' 的字面量判据。 */
  if (typeof window.mcAiOn !== 'function') {
    window.mcAiOn = function () {
      try { return localStorage.getItem('mc_ai_enabled') !== '0'; } catch (e) { return true; }
    };
  }

  /* ==== 往 <style> 里拼文本时那两道闸 ====
     主题 JSON 的槽值、卡图、区域参数最后要拼成一份样式表的纯文本（content.js 的 mcThemeCss、
     mcSlotPreviewCss，theme-boot.js 首帧那份存档串）。那是整条通路里唯一能"凭空多出一条规则"
     的落点：一颗值里带一个 } 就把这条声明提前关掉，后半截变成新选择器，
     例如 red;}body{display:none}/* 会把整页界面藏掉。行内 setProperty 那条没这个毛病
     （值永远只是一条声明的值，劈不出新规则），所以两道闸只管样式表这一头。

     value(text)：这条值能不能原样拼进去。判据只看结构（能不能把表劈开），不管它是不是合法 CSS
       —— 合不合法浏览器自己会丢，我们要的是它别替别人开新规则。
     sheetOk(text)：一份编译好的表原文，结构上还是不是"选择器{声明;声明}"这一层，只有一层。
       首帧注的是存档里已经编译好的串，它不在这颗编译器手里过过，注进去以前先验一遍结构。

     和 mcAiOn 同一理由挂在"非 Canvas 就退出"前面：这两道闸守的是"别人塞进来的文本"，
     正好是页面自己那份脚本用不上的东西，退出得越早越是白留一条口子。 */
  if (typeof window.mcCssGuard !== 'object') {
    var CSS_VALUE_LIMIT = 1000000;

    // 一条声明的值。顶层（引号和外层括号之外）出现 { } < ; 或一段注释就整条不要：
    // ; 能再开一条声明，{} 能开新规则，< 只可能是想把自己那棵 <style> 关掉，
    // 注释能把后面的 !important 连同别的声明一起吞掉。
    // 括号里的 // 不算注释（url(https://…) 没加引号时就是这个形状），分号也不算
    // （url(data:image/png;base64,AA) 那种合法值就带一个）
    function cssValueOk(text) {
      var quote = '', depth = 0;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i], n = text[i + 1];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '/' && n === '*' && !depth) return false;
        if (ch === '{' || ch === '}' || ch === '<') return false;
        if (ch === '(') depth++;
        else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
        else if (ch === ';' && depth === 0) return false;
      }
      return !quote && depth === 0;
    }

    // 一份编译好的表：只允许"前奏{声明}"这一层花括号，不许套、不许有 at-rule／注释。
    // 这里放行 > ：我们自己的编译器就在选择器里用它（hook + ' > *:not(...)'），
    // 而它劈不开表；要防的是 < （它只可能是想把自己那棵 <style> 关掉）
    function cssSheetOk(text) {
      var quote = '', depth = 0, paren = 0;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i], n = text[i + 1];
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '/' && n === '*' && !paren) return false;
        if (ch === '<') return false;
        if (ch === '(') { paren++; continue; }
        if (ch === ')') { paren = paren > 0 ? paren - 1 : 0; continue; }
        if (paren) continue;
        if (ch === '{') { if (depth++) return false; continue; }
        if (ch === '}') { if (--depth < 0) return false; continue; }
        if (ch === '@' && depth === 0) return false;
        if (ch === ';' && depth === 0) return false;
      }
      return depth === 0 && !quote && paren === 0;
    }

    window.mcCssGuard = {
      // 干净就原样还，脏了就空串：调用方那一档于是"没有值"，走它本来就有的退路
      value: function (raw) {
        var text = String(raw == null ? '' : raw).trim();
        if (!text) return '';
        if (text.length > CSS_VALUE_LIMIT || !cssValueOk(text)) return '';
        return text;
      },
      // 摊平标记那一档要的布尔：这一条是不是"能拼"
      ok: function (raw) {
        var text = String(raw == null ? '' : raw).trim();
        return !!text && text.length <= CSS_VALUE_LIMIT && cssValueOk(text);
      },
      sheetOk: cssSheetOk,
      // 变量名（--bcX 那一颗）也是外部输入：拼进 :root{...} 之前先限成 [-\w]，
      // 名字里带 {} 就能替自己开一条声明
      name: function (raw) {
        var text = String(raw == null ? '' : raw).trim();
        return /^-{1,2}[A-Za-z][-\w]*$/.test(text) ? text : '';
      }
    };
  }

  // 非 Canvas 站点直接退出，不初始化任何主题库逻辑
  if (!window.mcIsCanvas) return;

  if (window.mcLib) return;

  var LIB_KEY = 'mc_theme_lib_v1';
  var REF_RE = /mc-img:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g;
  // 引用查不到图时顶上这一颗：1×1 全透明，身后那档纯色照样露出来
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  // 十二档色，和 settings.js、content.js 里那两份 BTX_SLOTS 同一批
  var SLOTS = ['background-0', 'background-1', 'background-2', 'cards', 'borders', 'links',
    'buttons', 'text-0', 'text-1', 'text-2', 'sidebar', 'sidebar-text'];
  // 整座库的上限按字符数算（存进去的图是 base64，一个字符一个字节）。
  // Chrome 给一个源的 localStorage 大约 5MB，三格存档还要留地方，所以收到 2.6M
  var LIB_LIMIT = 2600000;

  /* 推荐的贴图比例。frame 是那块东西在屏幕上的样子（侧栏是一条高栏，课程卡是横幅），
     面板里那个预览框就按它摆——用户在那儿框住的区域和页面上看到的是同一件事。
     maxW/maxH/quality/cap 是上传时重编码的目标：压进 cap 字节，压不动就再缩一档。
     侧栏这一档：宽是我们 CSS 里钉死的那个数（style.css 的 --bc-nav-w：展开 200、收起 74），
     高＝别人窗口多高就是多高，navH 按常见窗口取三档，只用来算预览框里那条安全线，不参与落盘。
     frame／ratio／sample 就是这三档中间那一档（200 × 900 ＝ 1 : 4.5）：图按这一档做，
     三档窗口都保得住图上大约 64%，比按任何一头做都多 */
  var SPEC = {
    sidebar: { maxW: 900, maxH: 2400, quality: 0.82, cap: 420 * 1024, frame: [1, 4.5],
      ratio: '1 : 4.5', sample: '400 × 1800', tile: 30, navW: 200, navH: [600, 900, 1400] },
    card: { maxW: 1000, maxH: 640, quality: 0.82, cap: 300 * 1024, frame: [16, 10],
      ratio: '16 : 10', sample: '800 × 500', tile: 40 }
  };

  // 页面上还没有任何主题可抄时，新建第一档的起手色
  var FALLBACK_COLORS = {
    'background-0': '#f5f2ec', 'background-1': '#e9e4da', 'background-2': '#d8d2c6',
    cards: '', borders: '#d5cfc4', links: '#4c6ef5', buttons: '#efeae0',
    'text-0': '#1f2328', 'text-1': '#4b5158', 'text-2': '#8b9099',
    sidebar: '#2f3440', 'sidebar-text': '#f4f6f8'
  };

  var cache = null;

  function read() {
    if (cache) return cache;
    var list = [];
    try {
      var parsed = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
      if (Array.isArray(parsed)) list = parsed.filter(function (x) { return x && x.id; });
    } catch (e) { list = []; }
    cache = list;
    return list;
  }

  function write(list) {
    var text = '';
    try { text = JSON.stringify(list); }
    catch (e) { return { ok: false, error: 'That theme could not be packed.' }; }
    if (text.length > LIB_LIMIT) {
      return { ok: false, error: 'Your saved pictures add up to ' + kb(text.length)
        + ' and the limit is ' + kb(LIB_LIMIT)
        + '. Put a picture link in place of an upload, or delete a theme you no longer use.' };
    }
    try { localStorage.setItem(LIB_KEY, text); }
    catch (e) {
      return { ok: false, error: 'This site is out of storage (' + (e && e.name ? e.name : 'unknown')
        + '). Try a picture link instead of an upload.' };
    }
    cache = list;
    return { ok: true };
  }

  // 别的标签页里改了库（同源的 localStorage 会发 storage 事件），这一趟把内存里那份丢掉
  window.addEventListener('storage', function (e) {
    if (e && e.key === LIB_KEY) cache = null;
  });

  function kb(chars) { return Math.max(1, Math.round(chars / 1024)) + ' KB'; }

  function freshId() {
    return 'mc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* ==== 引用 ==== */

  // 侧栏 → mc-img://<id>/sidebar ；第 3 张卡图 → mc-img://<id>/card-2
  function refOf(id, kind, index) {
    return 'mc-img://' + id + '/' + (kind === 'sidebar' ? 'sidebar' : 'card-' + index);
  }

  function parseRef(ref) {
    var m = /^mc-img:\/\/([A-Za-z0-9._-]+)\/(sidebar|card-(\d+))$/.exec(String(ref || ''));
    if (!m) return null;
    return { id: m[1], kind: m[2] === 'sidebar' ? 'sidebar' : 'card', index: m[3] ? Number(m[3]) : -1 };
  }

  /* 一整串 CSS 里的引用换成真图。真图不直接抄进表里：一张课程卡一条规则，十门课就把同一张
     几百 KB 的图抄十遍（实测他那份主题编译出来 1.78MB）。这里每张图只登记一次，
     单独写成一张 :root{--mcx-img-0:url(…)} 小表，规则里换成 var(--mcx-img-0)。
     绝大多数表不含引用，走上面那句快路就原样返回了 */
  var VARS_ID = 'mcx-img-vars';
  var ONE_REF_RE = /mc-img:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/;
  var URL_REF_RE = /url\(\s*["']?mc-img:\/\/[^"')]+["']?\s*\)/g;
  // 变量按【真图】登记，不是按引用：同一张图既当侧栏又当卡图时只用一份
  var imgVarSrcs = [];
  var imgVarForRef = {};

  function imgVarName(ref) {
    if (imgVarForRef[ref]) return imgVarForRef[ref];
    var src = srcOf(ref) || BLANK;
    var at = imgVarSrcs.indexOf(src);
    if (at === -1) {
      imgVarSrcs.push(src);
      writeVars();
      at = imgVarSrcs.length - 1;
    }
    imgVarForRef[ref] = '--mcx-img-' + at;
    return imgVarForRef[ref];
  }

  function writeVars() {
    var css = '';
    imgVarSrcs.forEach(function (src, i) {
      css += '--mcx-img-' + i + ':url("' + src + '");';
    });
    var node = document.getElementById(VARS_ID);
    if (!node) {
      node = document.createElement('style');
      node.id = VARS_ID;
      (document.head || document.documentElement).appendChild(node);
    }
    node.textContent = ':root{' + css + '}';
  }

  function resolve(css) {
    var text = String(css == null ? '' : css);
    if (text.indexOf('mc-img://') === -1) return text;
    var out = text.replace(URL_REF_RE, function (chunk) {
      var m = ONE_REF_RE.exec(chunk);
      return m ? 'var(' + imgVarName(m[0]) + ')' : 'none';
    });
    // 漏网的裸引用（没写在 url() 里的）：换成一颗全透明像素，别留一串认不出的地址在那儿
    return out.replace(REF_RE, function (ref) { return srcOf(ref) || BLANK; });
  }

  function srcOf(ref) {
    var at = parseRef(ref);
    if (!at) return '';
    var rec = get(at.id);
    if (!rec) return '';
    if (at.kind === 'sidebar') return pictureSrcOkOf((rec.sidebar && rec.sidebar.src) || '');
    var one = (rec.cards || [])[at.index];
    return pictureSrcOkOf((one && one.src) || '');
  }

  /* 库里那一颗地址会被拼成 url("<这一颗>")，还要拼进 :root{--mcx-img-N:…} 那张表：
     它要带的不是一个协议名，就是一段替自己开新规则的东西。导入的那份主题带的图来路不一定，
     所以在这里认一次；不认就当这颗图没有——resolve 那一条会换成那颗全透明像素，
     颜色其余各档照旧 */
  function pictureSrcOkOf(src) {
    var s = String(src || '');
    if (!s || s.length > 4000000) return '';
    if (!/^(https?:|data:|blob:|chrome-extension:|chrome:|file:)/i.test(s)) return '';
    // 这些字符在引号里就能把自己那对引号关掉，接着替自己开一条规则
    return /["'{}<>\\]/.test(s) ? '' : s;
  }

  /* ==== 库 ==== */

  function get(id) {
    var list = read();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // 一张图的区域设定：模式 + 焦点 + 平铺时的块头 + 侧栏那一档"看得到图的多少"。
  // 缺省＝铺满、看中间、size 0＝没拧过那颗滑杆（按模式的字面走，画面和这一档加进来之前一样）
  function picture(src, kind, extra) {
    var spec = SPEC[kind] || SPEC.card;
    var out = { src: String(src || ''), kind: kind, mode: 'cover', x: 50, y: 50,
      scale: spec.tile, width: 0, height: 0, size: 0 };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] !== undefined) out[key] = extra[key];
      }
    }
    out.src = String(out.src || '');
    return out;
  }

  function blank(fromColors) {
    return {
      id: freshId(),
      name: '',
      created: Date.now(),
      updated: Date.now(),
      colors: Object.assign({}, fromColors || FALLBACK_COLORS),
      sidebar: null,
      cards: [],
      overlay: { color: '#241f1a', strength: 45 },
      sidebarOverlay: { color: '#241f1a', strength: 0 },
      font: null
    };
  }

  /* 一份字体记录＝{family, link}，两样都空就是"这份主题不自带字体"。
     字族名最后会被拼进我们编译的那条 body 规则，链接会挂成 <link>，所以两边都按外部输入洗一遍：
     能把自己那份表劈开的字符一律剥掉，中文／日文字族名留得住 */
  function fontOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var family = String(raw.family || '').replace(/[{}<>;"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    var link = String(raw.link || '').trim().slice(0, 300);
    if (link && !/^https?:/i.test(link) && !/^[A-Za-z0-9 .:+&%-]+$/.test(link)) link = '';
    return (family || link) ? { family: family, link: link } : null;
  }

  // 从别的机器带回来的 JSON 可能缺字段，这里补齐
  function normalize(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var out = {
      id: typeof rec.id === 'string' && rec.id ? rec.id : freshId(),
      name: String(rec.name || '').slice(0, 60),
      created: Number(rec.created) || Date.now(),
      updated: Date.now(),
      colors: {},
      sidebar: null,
      cards: [],
      overlay: { color: '#241f1a', strength: 45 },
      // 侧栏图上那层膜自己一份，和卡图那层分开调。默认 0＝不画，
      // 他在这份之前存下的主题（还有从别的机器带回来的）画面一个字不变
      sidebarOverlay: { color: '#241f1a', strength: 0 },
      font: null
    };
    SLOTS.forEach(function (slot) {
      var value = String((rec.colors || {})[slot] || '').trim();
      if (value && !/[{}<>]/.test(value)) out.colors[slot] = value;
    });
    if (rec.sidebar && rec.sidebar.src) out.sidebar = picture(rec.sidebar.src, 'sidebar', rec.sidebar);
    (Array.isArray(rec.cards) ? rec.cards : []).forEach(function (one) {
      if (one && one.src) out.cards.push(picture(one.src, 'card', one));
    });
    if (rec.overlay) {
      if (/^#[0-9a-f]{6}$/i.test(String(rec.overlay.color || ''))) out.overlay.color = rec.overlay.color;
      var strength = Number(rec.overlay.strength);
      if (!isNaN(strength)) out.overlay.strength = Math.max(0, Math.min(100, Math.round(strength)));
    }
    // 这一档以前是颗开关（overlay.sidebar: true），现在换成整份独立设置：
    // 带那一版的存档读回来就是默认的关着，不会拿 true 当颜色用
    if (rec.sidebarOverlay && typeof rec.sidebarOverlay === 'object') {
      if (/^#[0-9a-f]{6}$/i.test(String(rec.sidebarOverlay.color || ''))) out.sidebarOverlay.color = rec.sidebarOverlay.color;
      var sideStrength = Number(rec.sidebarOverlay.strength);
      if (!isNaN(sideStrength)) out.sidebarOverlay.strength = Math.max(0, Math.min(100, Math.round(sideStrength)));
    }
    out.font = fontOf(rec.font);
    return out;
  }

  // 有这一格就覆盖（编辑器存回去），没有就加进去
  function upsert(rec) {
    var list = read().slice();
    var at = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === rec.id) at = i;
    rec.updated = Date.now();
    if (at === -1) list.push(rec); else list[at] = rec;
    var res = write(list);
    return res.ok ? { ok: true, rec: rec } : res;
  }

  function remove(id) {
    return write(read().filter(function (x) { return x.id !== id; }));
  }

  /* ==== 区域 → CSS ====
     焦点用百分数：50% 50% 是图的中心对框的中心，20% 80% 就是看靠左下那一块。
     页面上那块东西比图小，所以这三个值就是"用图的哪一块"的全部答案。
     box 只有设置面板那个预览框会传（它知道自己多少像素）；不传就是关键字那三档 */
  function regionCss(one, box) {
    var mode = (one && one.mode) || 'cover';
    var x = clampPercent(one ? one.x : 50);
    var y = clampPercent(one ? one.y : 50);
    var pos = x + '% ' + y + '%';
    if (mode === 'tile') {
      var scale = Math.max(10, Math.min(200, Number(one && one.scale) || SPEC.card.tile));
      return { size: scale + '% auto', repeat: 'repeat', pos: pos };
    }
    var base = mode === 'contain' ? 'contain' : 'cover';
    return { size: fitSizeCss(one, box) || base, repeat: 'no-repeat', pos: pos };
  }

  /* 侧栏那张图的大小：one.size 是他拧的那颗滑杆，100＝图刚好盖满这条栏（＝以前的铺满，
     一条缝都不留），20＝放大到五倍（只看得到图中间那一条），120＝缩到铺满的 0.83 倍
     （看得见更多图，代价是边上留缝）。没拧过（0、旧存档、卡图）返回空串，
     上面那个关键字照旧，画面和加这一档之前一个字不差。
     落盘是一条算式而不是一个死像素数，因为侧栏这块框自己会动：
     宽那一头吃 --bc-nav-w（收起 74、展开 200 都跟着），高那一头按 Apply 那一刻量到的
     "侧栏高占视口多少"换算成 vh（窗口拉高图跟着长）。两头取大＝刚好盖满，
     再乘上他要那一档（100/size）。预览框走的是同一条算式的像素版，两边看到的是同一块 */
  function fitSizeCss(one, box) {
    var v = Number(one && one.size);
    if (!(v >= 20 && v <= 120)) return '';
    if (one.kind !== 'sidebar') return '';
    var natW = Number(one.width) || 0, natH = Number(one.height) || 0;
    if (!natW || !natH) return '';
    var a = natW / natH;
    var k = 100 / v;
    if (box && box.live) {
      var c = (box.navH && box.winH) ? 100 * box.navH / box.winH : 100;
      return 'calc(max(var(--bc-nav-w, 200px), ' + (a * c).toFixed(3) + 'vh) * ' + k.toFixed(4) + ')';
    }
    if (box && box.w && box.h) return Math.round(Math.max(box.w, a * box.h) * k) + 'px';
    return '';
  }

  /* Apply 那一刻量一次侧栏这块框：它多高、这一屏多高。量不到（页面还没画侧栏）就退回整屏 */
  function navBox() {
    var out = { live: true, navH: 0, winH: Number(window.innerHeight) || 0 };
    try {
      var node = document.querySelector('.ic-app-header') || document.querySelector('#header');
      var r = node && node.getBoundingClientRect();
      if (r && r.height) out.navH = r.height;
    } catch (e) {}
    return out;
  }

  /* fitSizeCss 的反面：这一档模式在这块框里相当于"铺满"的那一档的百分之多少
     （100＝刚好铺满，小＝放大裁图，大＝缩小留缝）。滑杆没拧过时显示的就是这个数，
     所以它一进来就停在画面当前那一档上：铺满那一档正好读到 100。
     量不到就返回 0（＝不知道），让调用方把那一行收掉：
     上一版这里退回 100，框还没挂进文档量到 0×0 时滑杆就谎报一个数，
     他一碰滑杆画面当场跳一下 */
  function visiblePercent(one, box) {
    var natW = Number(one && one.width) || 0, natH = Number(one && one.height) || 0;
    if (!natW || !natH || !box || !box.w || !box.h) return 0;
    var a = natW / natH;
    var mode = (one && one.mode) || 'cover';
    var shown = mode === 'contain' ? Math.min(box.w, a * box.h)
      : mode === 'tile' ? box.w * (Math.max(10, Math.min(200, Number(one.scale) || SPEC.card.tile)) / 100)
      : Math.max(box.w, a * box.h);
    if (!shown) return 0;
    return Math.max(20, Math.min(120, Math.round(100 * Math.max(box.w, a * box.h) / shown)));
  }

  function clampPercent(v) {
    var n = Number(v);
    if (isNaN(n)) return 50;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // 一串 background 简写里那张图的地址
  function urlIn(raw) {
    var m = /url\(\s*['"]?([^'")]+)/i.exec(String(raw || ''));
    return m ? m[1].trim() : '';
  }

  /* 一串 background 简写按顶层逗号劈成几层。不能直接 split(',')：linear-gradient(#a,#b) 里也有逗号，
     要按括号深度劈（content.js 里 mcSlotLayers 同一套算法） */
  function layersOf(raw) {
    var text = String(raw || ''), out = [], depth = 0, cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // 那几层里画着图的那一层（连它自己写的位置／平铺关键字一起）
  function imageLayerOf(raw) {
    var layers = layersOf(raw);
    for (var i = 0; i < layers.length; i++) if (/url\(/i.test(layers[i])) return layers[i];
    return '';
  }

  /* 把主题作者自己写的那一层读回成记录里那三样。
     为什么不用页面上量到的那一份（regionFromCss 那条）：BC 把侧栏这张图画在 ::before 上，
     每三秒抄回来的镜像只抄了 ::before 的图，size／repeat／pos 抄的却是元素自己那一份，
     对不上这张图。实测本地那 1067 份带侧栏图的主题，作者这一层只有两种写法：
     'center' 或者什么都不写，一颗尺寸、一个 no-repeat 都没写过
     ＝CSS 的意思是按原图大小、重复铺。这一档三颗按钮装不下，先挂上 auto，
     等量到原图多大再交给 settlePicture 定档 */
  function regionFromSlot(raw, kind) {
    var out = { mode: 'cover', x: 50, y: 50, scale: (SPEC[kind] || SPEC.card).tile };
    var layer = imageLayerOf(raw);
    if (!layer) return out;
    var rest = layer.replace(/url\((?:[^()]|\([^()]*\))*\)/i, ' ');
    var rep = /\b(no-repeat|repeat-x|repeat-y|repeat)\b/i.exec(rest);
    var size = /\b(cover|contain)\b/i.exec(rest);
    var pct = /(-?[\d.]+)%\s+(-?[\d.]+)%/.exec(rest);
    if (pct) {
      out.x = Number(pct[1]);
      out.y = Number(pct[2]);
    } else {
      var h = '', v = '';
      (rest.match(/\b(center|left|right|top|bottom)\b/gi) || []).forEach(function (word) {
        var w = word.toLowerCase();
        if (w === 'left') h = '0';
        else if (w === 'right') h = '100';
        else if (w === 'top') v = '0';
        else if (w === 'bottom') v = '100';
        else if (!h) h = '50'; else if (!v) v = '50';
      });
      if (h) out.x = Number(h);
      if (v) out.y = Number(v);
    }
    if (size) out.mode = size[1].toLowerCase();
    else if (!rep || !/no-repeat/i.test(rep[1])) out.auto = true;
    return out;
  }

  /* 量到原图尺寸之后收尾，规则就一句：图比那一栏窄就平铺、够宽就铺满。
     平铺的块头＝原图那串像素占栏宽的百分比，所以页面上看到的一块和 BC 画的一样大。
     量不到（地址不通、图挂了）就铺满，和改之前一样 */
  function settlePicture(one, box) {
    if (!one || !one.auto) return one;
    delete one.auto;
    var nat = Number(one.width) || 0, w = Number(box && box.w) || 0;
    if (!nat || !w || nat >= w) { one.mode = 'cover'; return one; }
    one.mode = 'tile';
    one.scale = Math.max(10, Math.min(120, Math.round(nat / w * 100)));
    return one;
  }

  /* 收进库的那一份没量过原图尺寸。拖动要按"图比框多出多少像素"算，尺寸是 0 就一步都挪不动，
     侧栏那一档是平铺还是铺满也要等量到了才定得下来 */
  function measureCopies(rec, box) {
    var list = [];
    if (rec.sidebar && rec.sidebar.src) list.push(rec.sidebar);
    (rec.cards || []).forEach(function (one) { if (one && one.src) list.push(one); });
    return Promise.all(list.map(function (one) {
      return measure(one.src).then(function (size) {
        one.width = size.width;
        one.height = size.height;
      }, function () {});
    })).then(function () {
      settlePicture(rec.sidebar, box);
      return rec;
    });
  }

  // regionCss 的反向：页面上那一串（size／repeat／pos）读回成记录里那三样
  function regionFromCss(one, kind) {
    var src = one || {};
    var pos = String(src.pos || '').match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
    var out = { mode: 'cover', x: pos ? Number(pos[1]) : 50, y: pos ? Number(pos[2]) : 50,
      scale: (SPEC[kind] || SPEC.card).tile };
    if (src.repeat === 'repeat') {
      out.mode = 'tile';
      var w = /([\d.]+)%/.exec(String(src.size || ''));
      if (w) out.scale = Number(w[1]);
    } else if (/contain/i.test(String(src.size || ''))) {
      out.mode = 'contain';
    }
    return out;
  }

  /* 把"这一格正在用的那份主题"收成一份库记录。
     从 Customizer 进去改贴图时，如果那一格用的是主题墙挑来的（BetterCampus 那份）或者导入的 JSON，
     它的图不在库里，就没有可以改的地方。先照快照造一份记录（每档取那颗纯色、图取地址、
     构图取现在页面上生效的那一份），之后改的就是这份你自己的主题。
     地址原样带过来不搬像素：外链本来就能用；真是 data: 那种大到装不下时，由 upsert 的库上限报回来 */
  function recordFromSnapshot(snap) {
    if (!snap) return null;
    var base = snap.base || snap.vars || {};
    var colors = {};
    SLOTS.forEach(function (slot) { colors[slot] = solidOf(String(base['bc' + slot] || '')); });
    var out = blank(Object.assign({}, FALLBACK_COLORS, colors));
    out.name = String((snap.imported && (snap.imported.title || snap.imported.code)) || 'My theme').slice(0, 60);
    var nav = (snap.surfaces && snap.surfaces.nav) || {};
    var side = urlIn(nav.raw) || urlIn(nav.bg) || urlIn(nav.layer) || urlIn(base.bcsidebar);
    // 构图照作者写的那一层读，不照页面上量到的那三样读（原因见 regionFromSlot 那段）
    if (side) out.sidebar = picture(side, 'sidebar', regionFromSlot(base.bcsidebar || nav.raw, 'sidebar'));
    var imgs = (snap.dash && snap.dash.images) || [];
    var regions = (snap.dash && snap.dash.regions) || [];
    imgs.forEach(function (url, i) {
      if (!url) return;
      out.cards.push(picture(String(url), 'card', regionFromCss(regions[i], 'card')));
    });
    var film = String((snap.dash && snap.dash.film) || '');
    var filmCol = /#([0-9a-f]{6})/i.exec(film);
    var filmAlpha = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/i.exec(film);
    if (filmCol) out.overlay.color = '#' + filmCol[1];
    if (filmAlpha) out.overlay.strength = Math.round(Math.max(0, Math.min(1, Number(filmAlpha[1]))) * 100);
    out.font = snap.baseFont ? { family: String(snap.baseFont.family || ''), link: String(snap.baseFont.link || '') } : null;
    return out;
  }

  /* 预览框里那条"每台机器都看得见"的线：
     栏的宽和高分别取 SPEC.sidebar 里那两颗（宽是我们 CSS 钉死的，高按常见窗口取三档）。
     同一张图同样这一档，别人窗口越高、左右被裁得越多，越矮、上下被裁得越多，
     所以把那三档各算一次看得见的那一块取交集＝不管谁的窗口都跑不掉的那一圈。
     返回的是这一圈在预览框里的位置和大小（百分数）；
     交集空了、或者本来就整框保得住，返回 null（那时多画一圈线只是白挡图） */
  function safeBand(one, box) {
    var spec = SPEC.sidebar;
    if (!one || one.kind !== 'sidebar' || one.mode === 'tile') return null;
    if (!box || !box.w || !box.h) return null;
    var here = visibleRect(one, box.w, box.h);
    if (!here || here.x1 <= here.x0 || here.y1 <= here.y0) return null;
    var acc = null;
    for (var i = 0; i < spec.navH.length; i++) {
      var r = visibleRect(one, spec.navW, spec.navH[i]);
      if (!r || r.x1 <= r.x0 || r.y1 <= r.y0) return null;
      acc = acc ? { x0: Math.max(acc.x0, r.x0), x1: Math.min(acc.x1, r.x1),
        y0: Math.max(acc.y0, r.y0), y1: Math.min(acc.y1, r.y1) } : r;
    }
    if (!acc || acc.x1 <= acc.x0 || acc.y1 <= acc.y0) return null;
    var natW = Number(one.width) || 0, natH = Number(one.height) || 0;
    var pct = function (v, a, b) { return Math.max(0, Math.min(100, (v - a) / (b - a) * 100)); };
    var left = pct(acc.x0, here.x0, here.x1), right = pct(acc.x1, here.x0, here.x1);
    var top = pct(acc.y0, here.y0, here.y1), bottom = pct(acc.y1, here.y0, here.y1);
    if (left < 1 && right > 99 && top < 1 && bottom > 99) return null;
    return {
      left: left, top: top, width: right - left, height: bottom - top,
      // 这一圈占整张图多少（面积）：那句说明要报一个带单位的数，不能只说"一部分"
      percent: Math.round((acc.x1 - acc.x0) * (acc.y1 - acc.y0) / (natW * natH) * 100)
    };
  }

  // 这张图按当前这一档画进一块 w × h 的框里：一张图的像素占多少屏幕像素。
  // 那颗滑杆的 100% 就是这里的 cover（铺满），和 fitSizeCss 同一条基准，别改一头
  function picScale(one, w, h) {
    var natW = Number(one && one.width) || 0, natH = Number(one && one.height) || 0;
    if (!natW || !natH || !w || !h) return 0;
    var mode = (one && one.mode) || 'cover';
    if (mode === 'contain') return Math.min(w / natW, h / natH);
    if (mode === 'tile') {
      return (w * (Math.max(10, Math.min(200, Number(one.scale) || SPEC.card.tile)) / 100)) / natW;
    }
    var cover = Math.max(w / natW, h / natH);
    var v = Number(one.size);
    if (one.kind === 'sidebar' && v >= 20 && v <= 120) return cover * (100 / v);
    return cover;
  }

  // 这块框看到的是图上哪一块（图的像素坐标，超出图外那一截是底色，所以夹回图里）
  function visibleRect(one, w, h) {
    var natW = Number(one && one.width) || 0, natH = Number(one && one.height) || 0;
    var s = picScale(one, w, h);
    if (!s || !natW || !natH) return null;
    var offX = clampPercent(one.x) * (w - natW * s) / 100;
    var offY = clampPercent(one.y) * (h - natH * s) / 100;
    return {
      x0: Math.max(0, -offX / s), x1: Math.min(natW, (w - offX) / s),
      y0: Math.max(0, -offY / s), y1: Math.min(natH, (h - offY) / s)
    };
  }

  /* 侧栏那一格：区域算式 + 那层膜占的层数。
     膜和图是同一条 background 的两层，尺寸那一栏只写一个值会被两层共用——
     只写他拧的那一档，膜就跟着缩成一小块，栏的其余部分露出底色。
     所以只要尺寸不是 cover／contain 那两个关键字（也就是他拧过那颗滑杆、或者选了平铺），
     就先给膜补一个 cover */
  function sidebarRegion(rec) {
    if (!rec.sidebar || !rec.sidebar.src) return null;
    var r = regionCss(rec.sidebar, navBox());
    var keyword = r.size === 'cover' || r.size === 'contain';
    if (!keyword && filmOf(rec.sidebarOverlay)) r = { size: 'cover,' + r.size, repeat: r.repeat, pos: r.pos };
    return r;
  }

  /* 那一档大小的基准＝图刚好盖满这块框（CSS 的 cover），不是"整张图刚好放得下"。
     以前用后者：图比框还瘦的时候，那个基准本身就比框窄，于是滑杆停在 100% 也照样在框边上
     留一条缝（他报的"侧栏右边空一条"）。换成铺满当 100% 之后，100% 永远盖满，
     往小是放大裁图，往大才是缩小留缝 */
  function coverWidth(one, box) {
    var natW = Number(one && one.width) || 0, natH = Number(one && one.height) || 0;
    if (!natW || !natH || !box || !box.w || !box.h) return 0;
    return Math.max(box.w, (natW / natH) * box.h);
  }

  /* 一层色膜摊成渐变：膜色 + 那一份深浅，两头同色＝平铺一层，不挑方向。
     强度为 0 就是没有膜，和 exports.disable_color_overlay 同一个口径 */
  function filmOf(ov) {
    var strength = Math.max(0, Math.min(100, Number(ov && ov.strength) || 0));
    if (!strength) return '';
    var rgb = hexRgb(/^#[0-9a-f]{6}$/i.test(String((ov && ov.color) || '')) ? ov.color : '#241f1a') || [36, 31, 26];
    var one = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (strength / 100).toFixed(2) + ')';
    return 'linear-gradient(' + one + ',' + one + ')';
  }

  // 侧栏那一档的槽值：有图就是"图层 + 纯色"两层简写，没图就是那颗纯色
  function sidebarSlotValue(rec) {
    var base = solidOf((rec.colors || {}).sidebar) || FALLBACK_COLORS.sidebar;
    if (!rec.sidebar || !rec.sidebar.src) return base;
    // 侧栏图上那层膜排在图上面。没图就什么都不画：
    // 一层膜坐在纯色上只是把那颗色挪了个值，那一档他直接挑得到
    var film = filmOf(rec.sidebarOverlay);
    return (film ? film + ',' : '') + 'url("' + refOf(rec.id, 'sidebar') + '"),' + base;
  }

  function solidOf(raw) {    var v = String(raw || '').trim();
    return /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/i.test(v) ? v : '';
  }

  /* ==== 翻译成 mcApplyThemeJson 认得的那份 JSON ====
     应用自定义主题只走主题墙那一条通路，不另起一套：字段照抓取工具那份 JSON 的形状给，
     它装不下的"区域"由 j.regions 带过去（content.js 的 mcThemeFromJson 认这一份） */
  function buildThemeJson(rec) {
    var colors = [];
    SLOTS.forEach(function (slot) {
      var value = slot === 'sidebar' ? sidebarSlotValue(rec) : String((rec.colors || {})[slot] || '').trim();
      if (value && !/[{}<>]/.test(value)) colors.push({ slot: slot, value: value });
    });
    var refs = (rec.cards || []).map(function (one, i) { return refOf(rec.id, 'card', i); });
    var strength = Math.max(0, Math.min(100, Number(rec.overlay && rec.overlay.strength) || 0));
    var film = rec.overlay && /^#[0-9a-f]{6}$/i.test(rec.overlay.color) ? rec.overlay.color : '#241f1a';
    return {
      title: rec.name || 'My theme',
      code: 'mc:' + rec.id,
      colors: colors,
      images: refs.map(function (r) { return { role: 'cards', url: r }; }),
      // 这份主题自带的字体。Customizer 那一屏读到的 "This theme brings X" 就是它；
      // 没挑过就是 null＝Apply 以后页面保持 Canvas 自己的字
      font: rec.font || null,
      exports: {
        custom_cards: refs,
        card_colors: strength ? [film] : [],
        // 卡上那行课程名的颜色。以前按"色膜压完像什么样子"算一颗黑或白（假设标题压在图上），
        // 实测他这版旧卡 DOM 里 __header_image 压根不存在、标题是正常流里排在图下面的一行，
        // 坐的是卡身那一档底色＝配白就是白压粉看不见。所以这一档直接跟正文那一档走
        card_title_colors: solidOf((rec.colors || {})['text-0']) ? [solidOf(rec.colors['text-0'])] : [],
        card_overlay_opacity: strength,
        disable_color_overlay: !strength,
        gradient_cards: false
      },
      regions: {
        sidebar: sidebarRegion(rec),
        cards: (rec.cards || []).map(function (one) { return regionCss(one); })
      },
      // Apply 前刚采的那三颗侧栏图亮度（平均／最暗／最亮），交给可读性兜底当底用。
      // 没采过就是空数组，那边照旧不翻色
      samples: {
        sidebar: (rec.sidebar && Array.isArray(rec.sidebar.samples)) ? rec.sidebar.samples : []
      }
    };
  }

  function hexRgb(hex) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  /* ==== 上传：读文件 → 压到规定大小 → data URL ==== */

  function fileToPicture(file, kind) {
    var spec = SPEC[kind] || SPEC.card;
    return new Promise(function (done, fail) {
      if (!file) { fail(new Error('No file was picked.')); return; }
      if (!/^image\//i.test(file.type || '')) { fail(new Error('That file is not a picture.')); return; }
      // 动图重编一场就只剩第一帧；本来就不大的图也没必要再压一次。这两种原样留着
      if (/gif/i.test(file.type) || file.size <= spec.cap) {
        readAsData(file).then(function (src) {
          measure(src).then(function (size) {
            done({ src: src, width: size.width, height: size.height, kept: true, bytes: file.size });
          }, fail);
        }, fail);
        return;
      }
      readAsData(file).then(function (raw) {
        measure(raw).then(function (size) {
          shrink(raw, size.width, size.height, spec, 0).then(function (out) {
            done({ src: out.src, width: out.width, height: out.height, kept: false, bytes: out.bytes });
          }, fail);
        }, fail);
      }, fail);
    });
  }

  function readAsData(file) {
    return new Promise(function (done, fail) {
      var reader = new FileReader();
      reader.onload = function () { done(String(reader.result || '')); };
      reader.onerror = function () { fail(new Error('That file could not be read.')); };
      reader.readAsDataURL(file);
    });
  }

  function measure(src) {
    return new Promise(function (done, fail) {
      var img = new Image();
      img.onload = function () { done({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { fail(new Error('That picture could not be opened.')); };
      img.src = src;
    });
  }

  /* ==== 采一张图的亮度：侧栏那一档整串是图时，可读性兜底要能看见字身后是什么颜色 ====
     三颗样本：整张的平均、最暗那一格、最亮那一格（缩到 8×24 再读，侧栏本来就是一条窄栏，
     192 个采样点足够代表它）。返回的是 rgb 三元组，判色交给调用方那套 3:1，
     这里那点亮度算术只用来给像素排序，不参与任何结论。
     读不到就交空数组＝这一档不翻色，照主题作者给的那颗，绝不猜：
     外链的图直接画进画布会被判污染，所以先 fetch 成字节、转 data:、再画（data: 算同源，读得出来）；
     fetch 被 CORS 挡下、图坏了、超时，全走空数组这一条。同一颗地址只读一次。 */
  var pictureSamples = {};
  function samplePicture(url) {
    var src = String(url || '').trim();
    // 自建主题那份写的是 mc-img://<主题 id>/sidebar，真图在库里：先换成它自己那颗地址再采
    if (src.indexOf('mc-img://') === 0) src = String(srcOf(src) || '');
    if (!src || src.indexOf('mc-img:') === 0) return Promise.resolve([]);
    if (pictureSamples[src]) return pictureSamples[src];
    pictureSamples[src] = new Promise(function (done) {
      var settled = false;
      var timer = setTimeout(function () { finish([]); }, 4000);
      function finish(v) { if (settled) return; settled = true; clearTimeout(timer); done(v); }
      function fail() { finish([]); }
      function stats(size) {
        var img = size.image;
        try {
          var w = 8, h = 24;
          var cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          var g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, w, h);
          var d = g.getImageData(0, 0, w, h).data;
          var px = [];
          for (var i = 0; i < d.length; i += 4) {
            var one = [d[i], d[i + 1], d[i + 2]];
            // 这颗亮度只用来给像素排序（挑最暗／最亮那一批），不参与任何判色结论
            px.push({ l: 0.299 * one[0] + 0.587 * one[1] + 0.114 * one[2], px: one });
          }
          if (px.length < 4) return fail();
          px.sort(function (a, b) { return a.l - b.l; });
          var tail = Math.max(1, Math.round(px.length * 0.1));
          var mean = function (list) {
            var s = [0, 0, 0];
            list.forEach(function (p) { s[0] += p.px[0]; s[1] += p.px[1]; s[2] += p.px[2]; });
            return s.map(function (v) { return Math.round(v / list.length); });
          };
          // 三颗：整张平均、最暗那 10% 的平均、最亮那 10% 的平均。
          // 用"那一批的平均"而不是单颗最值：一张花图里总有一两颗星、一块云，
          // 拿单颗最值当底会把任何字色都判成不合格，兜底就会把每份图主题的字强翻成纯黑纯白
          var all = mean(px);
          var dark = mean(px.slice(0, tail));
          var bright = mean(px.slice(px.length - tail));
          finish([all, dark, bright]);
        } catch (e) { fail(); }
      }
      function loadInto(u) {
        var img = new Image();
        img.onload = function () { stats({ image: img }); };
        img.onerror = fail;
        img.src = u;
      }
      if (src.indexOf('data:') === 0) { loadInto(src); return; }
      try {
        fetch(src).then(function (r) { return r && r.ok ? r.blob() : null; }).then(function (b) {
          if (!b || !/^image\//i.test(String(b.type || ''))) return fail();
          return readAsData(b).then(loadInto, fail);
        }, fail);
      } catch (e) { fail(); }
    });
    return pictureSamples[src];
  }

  // 从一份主题的侧栏档里挑出那颗要采的图地址（整串可能是 "url(图),渐变" 那种多层简写）
  function pictureUrlOf(raw) {
    var m = /url\(\s*['"]?([^'")]+)/i.exec(String(raw || ''));
    return m ? m[1].trim() : '';
  }

  // 先按最长边缩；还压不进 cap 就把边再打八折、质量再降一档，最多四轮
  function shrink(src, w, h, spec, round) {
    return new Promise(function (done, fail) {
      var img = new Image();
      img.onload = function () {
        var maxW = Math.round(spec.maxW * Math.pow(0.8, round));
        var maxH = Math.round(spec.maxH * Math.pow(0.8, round));
        var k = Math.min(1, maxW / Math.max(1, w), maxH / Math.max(1, h));
        var width = Math.max(1, Math.round(w * k));
        var height = Math.max(1, Math.round(h * k));
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        var quality = Math.max(0.45, spec.quality - round * 0.08);
        var data = canvas.toDataURL('image/jpeg', quality);
        var bytes = Math.round(data.length * 0.75);
        if (bytes <= spec.cap || round >= 3) { done({ src: data, width: width, height: height, bytes: bytes }); return; }
        shrink(src, w, h, spec, round + 1).then(done, fail);
      };
      img.onerror = function () { fail(new Error('That picture could not be resized.')); };
      img.src = src;
    });
  }

  /* ==== 大小 / 比例的回话 ==== */

  function bytesOf(rec) {
    var total = 0;
    var add = function (src) {
      var s = String(src || '');
      if (/^data:/i.test(s)) total += Math.round(s.length * 0.75);
    };
    if (rec && rec.sidebar) add(rec.sidebar.src);
    ((rec && rec.cards) || []).forEach(function (one) { add(one.src); });
    return total;
  }

  function libBytes() { return (localStorage.getItem(LIB_KEY) || '').length; }

  // 上传的图和那块东西的框比例差太远就先说出来，省得他到页面上才发现被裁了
  /* frameSize 是调用方量到的那个框（侧栏现在按页面上真栏的比例画，不再是 SPEC 里写死那档），
     没量到才退回 spec.frame。不传就等于以前 */
  function ratioNote(one, kind, frameSize) {
    var spec = SPEC[kind] || SPEC.card;
    var w = Number(one && one.width), h = Number(one && one.height);
    if (!w || !h) return '';
    var use = (frameSize && Number(frameSize[0]) && Number(frameSize[1])) ? frameSize : spec.frame;
    var image = w / h, frame = use[0] / use[1];
    if (Math.abs(Math.log(image / frame)) < 0.18) return '';
    var cut = image > frame ? 'the sides' : 'the top and bottom';
    var say = 'Its ratio is ' + asRatio(image) + ' and this box is ' + asRatio(frame) + '.';
    if (one.mode === 'contain') {
      return say + ' Contain keeps all of the picture and leaves the rest of the box in this theme\u2019s colour.';
    }
    if (one.mode === 'tile') {
      return say + ' Tiling repeats it, so ' + cut + ' are not cut off.';
    }
    return say + ' With Cover, ' + cut + ' are cut off. Drag the picture to pick the part that stays.';
  }

  // 说成"宽 : 高"，竖的那一头永远写在高那位，免得报出 0.3 : 1 这种看不懂的数
  function asRatio(n) {
    return n >= 1 ? round1(n) + ' : 1' : '1 : ' + round1(1 / n);
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function describe(rec) {
    var colors = 0;
    SLOTS.forEach(function (slot) { if ((rec.colors || {})[slot]) colors++; });
    var pictures = (rec.sidebar && rec.sidebar.src ? 1 : 0) + (rec.cards || []).length;
    return colors + (colors === 1 ? ' colour' : ' colours') + ', '
      + pictures + (pictures === 1 ? ' picture' : ' pictures') + ', ' + kb(bytesOf(rec)) + ' saved';
  }

  /* ==== 导出：theme.json（自包含，可以再导回来）＋ images/ 里的原图 ==== */

  function fileName(rec) {
    var base = String(rec.name || 'theme').trim().replace(/[^\w .-]+/g, '').replace(/^\.+/, '');
    return (base || 'theme').slice(0, 40);
  }

  function extOf(src, fallback) {
    var m = /^data:image\/([a-z.+-]+)/i.exec(String(src || ''));
    var kind = m ? m[1].toLowerCase() : '';
    if (/jpe?g/.test(kind)) return 'jpg';
    if (kind === 'png') return 'png';
    if (kind === 'gif') return 'gif';
    if (kind === 'webp') return 'webp';
    var u = /\.(jpe?g|png|gif|webp)(\?|#|$)/i.exec(String(src || ''));
    if (u) return u[1].toLowerCase().replace('jpeg', 'jpg');
    return fallback || 'jpg';
  }

  // theme.json 里不带 width/height（那是这一台机器上量出来的，带回去也没用），
  // 但带 src：data: 的那份是自包含的，导回来就能直接用
  function exportJson(rec) {
    var drop = function (one) {
      if (!one) return one;
      var out = Object.assign({}, one);
      delete out.width;
      delete out.height;
      return out;
    };
    return JSON.stringify({
      mc_custom_theme: 1,
      extension: 'Modern Canvas',
      theme: Object.assign({}, rec, { sidebar: drop(rec.sidebar), cards: (rec.cards || []).map(drop) })
    }, null, 2);
  }

  // 压缩包里的清单：一份 theme.json ＋ images/ 下每张上传的图。
  // 网上来的图只把地址写进 JSON，不往压缩包里塞一份空文件
  function exportFiles(rec) {
    var folder = fileName(rec);
    var files = [{ name: folder + '/theme.json', text: exportJson(rec) }];
    var list = [];
    if (rec.sidebar && /^data:/i.test(rec.sidebar.src)) list.push({ key: 'sidebar', src: rec.sidebar.src });
    (rec.cards || []).forEach(function (one, i) {
      if (one && /^data:/i.test(one.src)) list.push({ key: 'card-' + (i + 1), src: one.src });
    });
    list.forEach(function (item) {
      files.push({ name: folder + '/images/' + item.key + '.' + extOf(item.src), data: base64Bytes(item.src) });
    });
    if (list.length) {
      files.push({ name: folder + '/images/links.txt',
        text: 'These are the pictures this theme uses, in the order they are given to your courses.\n'
          + 'theme.json in the folder above points at them by address or by the copy stored inside it.\n' });
    }
    return files;
  }

  function base64Bytes(dataUrl) {
    var comma = String(dataUrl).indexOf(',');
    var b64 = comma === -1 ? String(dataUrl) : String(dataUrl).slice(comma + 1);
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 最小的一份 ZIP 写入器：只存不压（图本身已经是 JPEG，再压压不出多少），
     所以 CRC32 + 每条文件的本地头 + 一份中央目录就够，不用带第三方库 */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosStamp(date) {
    var d = date || new Date();
    var y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function zip(entries) {
    var enc = new TextEncoder();
    var stamp = dosStamp();
    var parts = [];
    var central = [];
    var offset = 0;
    var centralSize = 0;
    entries.forEach(function (entry) {
      var data = typeof entry.text === 'string' ? enc.encode(entry.text) : entry.data;
      var name = enc.encode(entry.name);
      var crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // 文件名按 UTF-8
      local.setUint16(8, 0, true);               // 0 ＝ 只存不压
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      var head = new DataView(new ArrayBuffer(46));
      head.setUint32(0, 0x02014b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 20, true);
      head.setUint16(8, 0x0800, true);
      head.setUint16(10, 0, true);
      head.setUint16(12, stamp.time, true);
      head.setUint16(14, stamp.date, true);
      head.setUint32(16, crc, true);
      head.setUint32(20, data.length, true);
      head.setUint32(24, data.length, true);
      head.setUint16(28, name.length, true);
      head.setUint16(30, 0, true);
      head.setUint16(32, 0, true);
      head.setUint16(34, 0, true);
      head.setUint16(36, 0, true);
      head.setUint32(38, 0, true);
      head.setUint32(42, offset, true);
      central.push(new Uint8Array(head.buffer), name);
      centralSize += 46 + name.length;
      offset += 30 + name.length + data.length;
    });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadZip(rec) {
    var files = exportFiles(rec);
    saveBlob(zip(files), fileName(rec) + '.zip');
    return files.length;
  }

  function downloadJson(rec) {
    saveBlob(new Blob([exportJson(rec)], { type: 'application/json' }), fileName(rec) + '.json');
  }

  // 导回来的一份 JSON：认我们的标记就返回补齐后的记录，不是就返回 null（交给主题墙那条通路）
  function importJson(text) {
    var obj = null;
    try { obj = JSON.parse(String(text || '')); } catch (e) { return null; }
    if (!obj || obj.mc_custom_theme !== 1 || !obj.theme) return null;
    var rec = normalize(obj.theme);
    if (!rec) return null;
    rec.id = freshId();          // 别人那份不占用你库里同名的那一格
    return rec;
  }

  window.mcLib = {
    LIB_KEY: LIB_KEY,
    LIB_LIMIT: LIB_LIMIT,
    SLOTS: SLOTS,
    SPEC: SPEC,
    samplePicture: samplePicture,
    pictureUrlOf: pictureUrlOf,
    FALLBACK_COLORS: FALLBACK_COLORS,
    read: read,
    get: get,
    blank: blank,
    normalize: normalize,
    upsert: upsert,
    remove: remove,
    picture: picture,
    refOf: refOf,
    parseRef: parseRef,
    resolve: resolve,
    srcOf: srcOf,
    regionCss: regionCss,
    visiblePercent: visiblePercent,
    safeBand: safeBand,
    recordFromSnapshot: recordFromSnapshot,
    regionFromSlot: regionFromSlot,
    settlePicture: settlePicture,
    measureCopies: measureCopies,
    urlIn: urlIn,
    sidebarSlotValue: sidebarSlotValue,
    buildThemeJson: buildThemeJson,
    fileToPicture: fileToPicture,
    bytesOf: bytesOf,
    libBytes: libBytes,
    ratioNote: ratioNote,
    describe: describe,
    exportJson: exportJson,
    exportFiles: exportFiles,
    importJson: importJson,
    downloadZip: downloadZip,
    downloadJson: downloadJson,
    saveBlob: saveBlob,
    zip: zip,
    measure: measure,
    hexRgb: hexRgb,
    kb: kb
  };
})();
