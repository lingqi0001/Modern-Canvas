/* 本地 OCR 的那一头：藏在页面里的一个扩展页，内容脚本把页图字节递进来，
   这里把认出来的文字递回去。

   为什么非得是扩展页而不是内容脚本：内容脚本里 new Worker 拿不到
   chrome-extension 那个地址，页面自己的 CSP 也不许编 WebAssembly；
   扩展页那一份最小 CSP 里明写了 'wasm-unsafe-eval'，所以引擎只能活在这里。

   这一页在 web_accessible_resources 里，意思是任何网站都嵌得进来。可它能做的事比一个普通页面大：
   它带着用户的登录态去取图，取的是页面那一头因为 CORS 取不到的那一张。所以派活之前先认来路。
   "消息是谁发的"这一条单独用不算门：恶意页面把这颗 iframe 嵌进去，那一页天然就是它的 parent。
   真正拦得住的是来路那道判据（originAllowed）＋只让它取 Canvas 那一头的地址（jobUrlAllowed）
   ＋结果只回给派活那一个来路（不再用星号）。 */

// This is the locally bundled Tesseract WASM runtime (generated Emscripten
// glue plus extension integration), not remote code. Provenance and the
// upstream project links are recorded in vendor/THIRD_PARTY_NOTICES.md.
import { createOCREngine, supportsFastBuild } from './vendor/ocr/tesseract-lib.js';

var BASE = chrome.runtime.getURL('vendor/ocr/');
var booting = null;
var queue = Promise.resolve();

/* ==== 谁能用这一颗 ====
   判据不在这里手抄一份域名清单，读扩展自己声明的两批：manifest 里静态那三条
   （*.instructure.com／canvas.net／*.canvaslms.com），加上后台按用户授权过的学校域名现注册
   内容脚本时用的那一份名单（mc_custom_domains，Chrome 同步来的）。
   "跑着我们内容脚本的站点"＝"可以使这一颗的站点"，以后加域名只动那两个来源，这里跟着走 */
var allowHosts = [];      // 用户授权的那些：精确域名
var allowPatterns = [];   // manifest 那种 *://host/* 规则

function patternToRule(pattern) {
  var m = /^(\*|https?):\/\/([^/]*)(\/.*)?$/.exec(String(pattern || ''));
  if (!m) return null;
  var host = String(m[2] || '').toLowerCase();
  if (!host) return null;
  if (host.indexOf('*.') === 0) return { suffix: host.slice(2), exact: '' };
  return { suffix: '', exact: host };
}

function hostMatchesRule(host, rule) {
  if (rule.exact) return host === rule.exact;
  return host === rule.suffix || host.slice(-rule.suffix.length - 1) === '.' + rule.suffix;
}

try {
  var manifest = chrome.runtime.getManifest();
  (manifest.content_scripts || []).forEach(function (group) {
    (group.matches || []).forEach(function (pattern) {
      var rule = patternToRule(pattern);
      if (rule) allowPatterns.push(rule);
    });
  });
} catch (e) { /* 读不到清单就只剩用户授权那一份：宁可少放行 */ }

var hostsReady = new Promise(function (resolve) {
  try {
    chrome.storage.sync.get(['mc_custom_domains'], function (res) {
      var list = (res && Array.isArray(res.mc_custom_domains)) ? res.mc_custom_domains : [];
      allowHosts = list.map(function (h) { return String(h || '').toLowerCase(); }).filter(Boolean);
      resolve(true);
    });
  } catch (e) { resolve(false); }
});

function hostAllowed(host) {
  var h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (var i = 0; i < allowHosts.length; i++) if (allowHosts[i] === h) return true;
  for (var j = 0; j < allowPatterns.length; j++) if (hostMatchesRule(h, allowPatterns[j])) return true;
  return false;
}

// 派活那一头的来路（https://school.instructure.com 这种 origin）
function originAllowed(origin) {
  if (!origin || origin === 'null') return false;   // sandbox 出来的 iframe 就是 'null'
  try {
    var u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return hostAllowed(u.hostname);
  } catch (e) { return false; }
}

/* 它要我们替它取的那张图的地址。这一条比来路更要紧：这一头有 <all_urls> 的主机权限，
   请求又带 cookie，放开了就是替用户去敲内网和云元数据的门。
   主机除了要在上面那批名单里，还照 background.js 的 publicPolicyUrl 一样先把
   字面 IP／IPv6／本机与内网那几段掐掉——名单里万一混进这样一颗也不放行 */
var PRIVATE_HOST_RE = /^(?:0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[0-2]\d)\.)/;
var INTERNAL_NAME_RE = /(^|\.)(internal|local|localhost|localdomain|home|lan|xip\.io|sslip\.io|localtest\.me)$/i;

function jobUrlAllowed(raw) {
  var u;
  try { u = new URL(String(raw || '')); } catch (e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  var host = u.hostname.toLowerCase();
  if (!host || host.indexOf('.') < 0) return false;
  if (host.charAt(0) === '[' || host.indexOf(':') >= 0) return false;   // IPv6：浏览器会归化成"没有点"的写法
  if (INTERNAL_NAME_RE.test(host) || PRIVATE_HOST_RE.test(host)) return false;
  return hostAllowed(host);
}

/* ==== 一次能取多大 ====
   一张扫描页原图几 MB 是正常的，但这一颗是可以被连着派的，没有上限就是内存随别人点 */
var MAX_IMAGE_BYTES = 25 * 1024 * 1024;
var MAX_IMAGE_SIDE = 4096;   // 认字用不到更长的边，超过先缩到这一档

function buffer(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error(url.split('/').pop() + ' could not be read (HTTP ' + res.status + ')');
    return res.arrayBuffer();
  });
}

/* 训练数据直接读取未压缩的 eng.traineddata（避免 Edge 商店拦截包内压缩文件，且加载更快速） */
function modelBuffer() {
  return buffer(BASE + 'eng.traineddata');
}

function boot() {
  if (!supportsFastBuild()) {
    return Promise.reject(new Error('this browser has no WebAssembly SIMD, and the OCR build shipped here needs it'));
  }
  if (!booting) {
    booting = Promise.all([buffer(BASE + 'tesseract-core.wasm'), modelBuffer()]).then(function (parts) {
      return createOCREngine({ wasmBinary: parts[0] }).then(function (engine) {
        engine.loadModel(parts[1]);
        return engine;
      });
    });
    booting.catch(function () { booting = null; });
  }
  return booting;
}

function run(job) {
  return boot().then(function (engine) {
    var image = job.url
      ? imageDataFromUrl(job.url, job.maxSide)
      : Promise.resolve(new ImageData(new Uint8ClampedArray(job.bytes), job.w, job.h));
    return image.then(function (data) {
      engine.loadImage(data);
      var text = engine.getText();
      engine.clearImage();
      return text;
    });
  });
}

/* 收到的字节一边读一边累加，过线就断掉这一条流。只信 content-length 不行：
   服务器不给、给小了、分块传输，三种都躲得过 */
function tooBig() {
  return new Error('the photo is larger than ' + Math.round(MAX_IMAGE_BYTES / 1048576) + ' MB');
}

function readCapped(res) {
  var declared = Number(res.headers.get('content-length') || '0');
  if (declared > MAX_IMAGE_BYTES) return Promise.reject(tooBig());
  if (!res.body || !res.body.getReader) {
    return res.arrayBuffer().then(function (buf) {
      if (buf.byteLength > MAX_IMAGE_BYTES) throw tooBig();
      return buf;
    });
  }
  var reader = res.body.getReader();
  var parts = [];
  var total = 0;
  function pump() {
    return reader.read().then(function (step) {
      if (step.done) return new Blob(parts).arrayBuffer();
      parts.push(step.value);
      total += step.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        try { reader.cancel(); } catch (e) {}
        throw tooBig();
      }
      return pump();
    });
  }
  return pump();
}

/* 正文里那张照片走这一条：字节必须在扩展页这一头取。
   页面那一头的 fetch 会被 CORS 挡（/files/…/preview 会重定向到文件集群），
   降级成 <img> 画进画布又会被判污染，toDataURL 直接抛。
   这一头有主机权限，重定向跟得过去，也不用过 CORS 那道门。
   地址在进门那一刻已经过 jobUrlAllowed；跟完重定向只剩最后一跳，那一跳的落点判不了
   （manual 只能拿到 opaqueredirect，Location 读不出来，而这一条正是靠跟得过去才活的）。
   剩下的形状因此是"盲打"：请求发得出去，回东西只有派活那一个来路收得到 */
function imageDataFromUrl(url, maxSide) {
  return fetch(url, { credentials: 'include' }).then(function (res) {
    if (!res.ok) throw new Error('the photo could not be read (HTTP ' + res.status + ')');
    return readCapped(res);
  }).then(function (bytes) {
    return createImageBitmap(new Blob([bytes]));
  }).then(function (bmp) {
    var side = Math.max(bmp.width, bmp.height);
    var want = Math.max(Number(maxSide) || 0, 0);
    var cap = want > 0 ? Math.min(want, MAX_IMAGE_SIDE) : MAX_IMAGE_SIDE;
    var k = side > cap ? cap / side : 1;
    var w = Math.max(1, Math.round(bmp.width * k));
    var h = Math.max(1, Math.round(bmp.height * k));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    // 先铺白底：透明 PNG 画进引擎里整张是黑的，一个字也认不出来
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return ctx.getImageData(0, 0, w, h);
  });
}

/* 结果只回给这一趟派活的那个来路：它进门时过了 originAllowed，
   所以这里没有星号可给的——星号等于把认出来的字送给任意一个嵌进来的页面 */
function reply(target, msg) {
  msg.type = 'mcx-ocr-result';
  parent.postMessage(msg, target);
}

/* 一次一张：引擎是同步的，并发递进来也只是在队列里排着，
   而一次摆好几张整页位图会把内存顶上去 */
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (!d || typeof d !== 'object') return;
  // 只接直接挂着这一页的那一头：别的窗口攥着这一页的引用也发得到，但它不是 parent
  if (ev.source !== window.parent) return;
  if (!originAllowed(ev.origin)) return;
  if (d.type === 'mcx-ocr-ping') {
    parent.postMessage({ type: 'mcx-ocr-alive', id: d.id || '' }, ev.origin);
    return;
  }
  if (d.type !== 'mcx-ocr') return;
  var target = ev.origin;
  var job = d;
  queue = queue.then(function () {
    if (job.url && !jobUrlAllowed(job.url)) {
      return reply(target, { id: job.id, ok: false, error: 'that image address is not one of your Canvas sites' });
    }
    return hostsReady.then(function () { return run(job); }).then(function (text) {
      reply(target, { id: job.id, ok: true, text: text });
    }, function (err) {
      reply(target, { id: job.id, ok: false, error: String((err && err.message) || err) });
    });
  });
});

/* 加载那一刻不再自己喊一声"我在这儿"了：那一嗓子任何嵌进来的页面都听得见，
   等于替人把这颗扩展装没装点名出来。现在改成等页面那一头报上来路来点，见 canvas-data.js 的 ocrFrame() */
