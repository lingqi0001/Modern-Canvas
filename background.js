/**
 * Modern Canvas - Background Service Worker
 * Ensures registered custom domains and auto-detected Canvas domains
 * have their content scripts cleanly registered and persistent across sessions.
 * Never injects into non-Canvas websites.
 */

var STORAGE_KEY = 'mc_custom_domains';

// 判定是否是自动支持的 Canvas 域名（排除已在 manifest 中静态声明的 instructure）
function swallow() {
  // 补投番茄钟那一份用：受限页面、已失效的标签页都会回一个 lastError，
  // 不读一下 Chrome 会在控制台抛 "Unchecked runtime.lastError"
  try { void chrome.runtime.lastError; } catch (e) {}
}

function isAutoCanvasDomain(hostname) {
  if (!hostname) return false;
  var h = hostname.toLowerCase();
  // 已在 manifest.json 静态加载，无需动态注册
  if (h === 'instructure.com' || h.endsWith('.instructure.com') || h === 'canvas.net' || h.endsWith('.canvaslms.com')) {
    return false;
  }
  // 形式 2 & 3: canvas.* 或 *.canvas.* 或 *-canvas.*
  return (h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
}

  /* 这一颗筛"扩展可以去开哪个网址"。地址是页面里用户粘的，页面那一头已经筛过一次，
     这里再筛是因为真发请求的是本机：放进 127.0.0.1、169.254.169.254 或内网那几段，
     就等于替用户敲他自己家网络与云元数据的门。IPv6 字面量一律挡（浏览器会把它归化成
     [::ffff:7f00:1] 那种"没有点"的写法，靠点数判不住） */
  function publicPolicyUrl(text) {
    try {
      var u = new URL(String(text || ''));
      if (u.protocol !== 'https:' || u.username || u.password) return false;
      var host = u.hostname.replace(/\.$/, '').toLowerCase();
      if (!host || host.indexOf('.') < 0 || host.charAt(0) === '[' || host.indexOf(':') >= 0) return false;
      if (/(^|\.)(internal|local|localhost|localdomain|home|lan|xip\.io|sslip\.io|localtest\.me)$/i.test(host)) return false;
      if (/^0\./.test(host)) return false;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.)/.test(host)) return false;
      return true;
    } catch (e) { return false; }
  }

function getScriptsConfig(hostname) {
  var matchPattern = '*://' + hostname + '/*';
  var calendarPattern1 = '*://' + hostname + '/calendar*';
  var calendarPattern2 = '*://' + hostname + '/courses/*/calendar*';
  var idPrefix = 'mc_dyn_' + hostname.replace(/[^a-zA-Z0-9_-]/g, '_');

  return [
    {
      id: idPrefix + '_start',
      matches: [matchPattern],
      css: ['style.css', 'settings.css', 'remote-content.css', 'study.css', 'assignment-debug.css', 'assignment-guide.css'],
      js: ['mcx-css-debug.js', 'theme-lib.js', 'theme-boot.js', 'nav-boot.js', 'assignment-width-boot.js'],
      runAt: 'document_start',
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_cal',
      matches: [calendarPattern1, calendarPattern2],
      css: ['theme-calendar.css'],
      runAt: 'document_start',
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_main',
      matches: [matchPattern],
      js: ['modules-fx-guard.js', 'planner-guard.js', 'recipient-picker.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_notif',
      matches: [matchPattern],
      js: ['notif-boot.js'],
      runAt: 'document_start',
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_idle',
      matches: [matchPattern],
      js: [
        'theme-lib.js', 'content.js', 'search.js', 'settings.js', 'inbox-list.js', 'inbox-ai.js',
        'vendor/jszip.min.js', 'canvas-data.js', 'study-storage.js', 'ai-client.js',
        'study-format.js', 'study-history.js', 'study-progress.js', 'study-retrieval.js',
        'study-practice.js', 'study-panel.js',
        'assignment-analyze.js', 'assignment-data.js', 'assignment-baseline.js',
        'assignment-debug.js', 'assignment-guide.js', 'remote-content-config.js', 'remote-content.js',
        /* sourceviewer.js 在 manifest 那条里有、这份手抄清单里没有＝
           自定义域名的那批机器上"看源码"那一颗永远不出现，症状和控制台报错都没有 */
        'sourceviewer.js'
      ],
      runAt: 'document_idle',
      persistAcrossSessions: true
    },
    {
      /* Grading 这一块在静态三条里已经注册过；这份手抄清单漏了它，
         自动识别或手填的自定义 Canvas 域就永远没有 Grading 入口（控制台零报错，
         而 focus.js 靠 <all_urls> 在那儿是跑得起来的，sync 也就永远等不到宿主） */
      id: idPrefix + '_grading',
      matches: [matchPattern],
      css: ['grading.css'],
      js: ['grading-core.js', 'grading.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    },
    {
      /* 阅读器那一屏的接管脚本：manifest 里是一条 all_frames + document_idle 的独立条目，
         这份清单原来只有样式没有脚本＝PDF 阅读页在自定义域名上换皮不吃、EXPAND 那颗也不动 */
      id: idPrefix + '_theaterjs',
      matches: [matchPattern],
      js: ['theater-frame.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_theater',
      matches: [matchPattern],
      css: ['theater.css'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_preview',
      matches: [matchPattern],
      css: ['preview-frame.css'],
      js: ['theme-frame-boot.js', 'select-frame.js'],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true
    },
    {
      id: idPrefix + '_focus',
      matches: [matchPattern],
      css: ['focus.css'],
      js: ['focus.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }
  ];
}

var activeRegistrations = new Set();

var FOCUS_ALL_SITES_ID = 'mc_focus_all_sites';

// Serialize reconciliation so a late registration cannot survive turning Focus off.
var focusRegistrationQueue = Promise.resolve();
function syncFocusRegistration(callback) {
  focusRegistrationQueue = focusRegistrationQueue.catch(function () {}).then(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get('mc_focus_state', function (data) {
        var state = data && data.mc_focus_state;
        var wanted = !!(state && state.pin === 'all');
        function done(ok, error) {
          if (callback) callback(ok && wanted, error || (wanted ? '' : 'focus_not_enabled'));
          resolve();
        }
        if (chrome.runtime.lastError) { done(false, 'storage_unavailable'); return; }
        chrome.scripting.getRegisteredContentScripts({ ids: [FOCUS_ALL_SITES_ID] }, function (rows) {
          if (chrome.runtime.lastError) { done(false, chrome.runtime.lastError.message); return; }
          var exists = rows && rows.length > 0;
          if (wanted === !!exists) { done(true); return; }
          if (!wanted) {
            chrome.scripting.unregisterContentScripts({ ids: [FOCUS_ALL_SITES_ID] }, function () {
              var error = chrome.runtime.lastError;
              done(!error, error && error.message);
            });
            return;
          }
          chrome.scripting.registerContentScripts([{
            id: FOCUS_ALL_SITES_ID, matches: ['<all_urls>'], css: ['focus.css'], js: ['focus.js'],
            runAt: 'document_idle', persistAcrossSessions: true
          }], function () {
            var error = chrome.runtime.lastError;
            done(!error, error && error.message);
          });
        });
      });
    });
  });
  return focusRegistrationQueue;
}
function registerFocusForAllSites(callback) { syncFocusRegistration(callback); }
function unregisterFocusForAllSites(callback) { syncFocusRegistration(function () { if (callback) callback(); }); }

function registerScriptsForDomain(hostname, callback) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
    if (callback) callback();
    return;
  }
  if (!hostname) {
    if (callback) callback();
    return;
  }
  var repair = activeRegistrations.has(hostname);
  activeRegistrations.add(hostname);

  var scripts = getScriptsConfig(hostname);
  var ids = scripts.map(function (s) { return s.id; });

  chrome.scripting.unregisterContentScripts({ ids: ids }, function () {
    if (chrome.runtime.lastError) {}
    chrome.scripting.registerContentScripts(scripts, function () {
      if (chrome.runtime.lastError) {
        console.warn('[MC] registerContentScripts error for ' + hostname, chrome.runtime.lastError);
      }
      if (callback) callback();
    });
  });
}

function syncRegisteredScripts() {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;

  // 1. 同步已注册列表以填充内存缓存
  chrome.scripting.getRegisteredContentScripts(function (list) {
    if (chrome.runtime.lastError) {}
    var registered = {};
    var registeredPrefixes = new Set();
    if (Array.isArray(list)) {
      list.forEach(function (s) {
        if (s && s.id && s.id.startsWith('mc_dyn_')) {
          registered[s.id] = true;
          var m = s.id.match(/^mc_dyn_(.+?)_(?:start|cal|main|notif|idle|theater|theaterjs|grading|preview)$/);
          if (m) registeredPrefixes.add(m[1]);
        }
      });
    }

    // Sync only the user's custom Canvas-domain allowlist. Chrome Sync may
    // replicate these hostnames across the user's signed-in Chrome devices;
    // this does not sync Canvas page content, grades, or assignment data.
    chrome.storage.sync.get([STORAGE_KEY], function (res) {
      var domains = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
      var validPrefixes = new Set();
      domains.forEach(function (hostname) {
        var prefix = String(hostname || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        validPrefixes.add(prefix);
        /* 原来"看见 _start 就跳过"：那一趟跳掉的是整套刷新，
           于是清单里后加的东西（Grading 三件、theater-frame.js）永远落不到早就授权过的那些域名上，
           症状是那批机器上这块功能一直没有。注册那一步本身是先注销同名再注册，重跑不叠加 */
        activeRegistrations.add(hostname);
        registerScriptsForDomain(hostname);
      });

      // 保护自动识别已注册的高校域名不被意外注销
      var autoDetectedPrefixes = new Set();
      activeRegistrations.forEach(function (h) {
        if (isAutoCanvasDomain(h)) {
          autoDetectedPrefixes.add(String(h).replace(/[^a-zA-Z0-9_-]/g, '_'));
        }
      });

      // 注销已经从自定义列表中移除且非自动识别域名的脚本
      registeredPrefixes.forEach(function (prefix) {
        if (!validPrefixes.has(prefix) && !autoDetectedPrefixes.has(prefix)) {
          /* 这份 id 名单原来是手抄第二遍，上面注册那串加了 _grading/_theaterjs、
             这里没跟着加＝域名撤掉以后那两件东西变成孤儿注册，persistAcrossSessions 长期挂着，
             症状是撤了授权以后页面上还有一块我们的东西。现在直接从同一份清单取 */
          var staleIds = getScriptsConfig(prefix).map(function (row) { return row.id; });
          chrome.scripting.unregisterContentScripts({ ids: staleIds }, function () {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
  });
}

// 监听自定义域名在设置或 Popup 中的改动，实时同步注册
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.mc_focus_state) syncFocusRegistration();
    if (area === 'sync' && changes[STORAGE_KEY]) {
      syncRegisteredScripts();
    }
  });
}

// 自动检测用户访问的标签页：如符合 Canvas 3 种格式或已在自定义名单中，自动动态注册
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (!tab || !tab.url) return;
  try {
    var url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    var host = url.hostname.toLowerCase();
    if (isAutoCanvasDomain(host)) {
      registerScriptsForDomain(host);
    } else {
      chrome.storage.sync.get([STORAGE_KEY], function (res) {
        var domains = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
        if (domains.indexOf(host) !== -1) {
          if (changeInfo.status === 'loading' && chrome.scripting && chrome.scripting.executeScript) {
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              func: function (arr) {
                try {
                  var cur = JSON.parse(localStorage.getItem('mc_custom_domains_cache') || '[]');
                  var merged = Array.from(new Set(cur.concat(arr)));
                  localStorage.setItem('mc_custom_domains_cache', JSON.stringify(merged));
                } catch (e) {}
              },
              args: [domains]
            }, function () {
              if (chrome.runtime.lastError) {}
            });
          }
          if (!activeRegistrations.has(host)) {
            registerScriptsForDomain(host);
          }
        }
      });
    }
  } catch (e) {}
});

/* ============ 问商店：我们自己的扩展有没有新版 ============
   requestUpdateCheck 只回"有没有"，商店最新是几点几它不报。
   以开发者方式"加载已解压的"那一份永远回 error＝那种装法根本没有商店可问，标记不写、页面不提示。
   结论写在 chrome.storage.local 这一格给页面读：这仓库后台从来没有 sendMessage 到 tab 的通路，
   popup 那一格是同一个办法（见 content.js 的 mcPublishPopupTheme）。
   生效还是要重启浏览器，我们能做的只有"告诉他" */
var MC_UPDATE_FLAG_KEY = 'mc_update_available';

function mcSetUpdateFlag(status) {
  try {
    if (status === 'update_available' || status === 'restart_required') {
      chrome.storage.local.set({ mc_update_available: { status: status, at: Date.now() } });
    } else {
      chrome.storage.local.remove(MC_UPDATE_FLAG_KEY);
    }
  } catch (e) {}
}

function mcCheckForUpdate() {
  if (!chrome.runtime || !chrome.runtime.requestUpdateCheck) return;
  try {
    chrome.runtime.requestUpdateCheck(function (status) {
      // lastError 有值＝这条路走不通（开发者装的、非商店来源），什么都不写
      if (chrome.runtime.lastError) { mcSetUpdateFlag(''); return; }
      mcSetUpdateFlag(status);
    });
  } catch (e) {}
}

// 商店把新包发下来了（还没生效）：这条比轮询准，一有就写标记
if (chrome.runtime.onUpdateAvailable) {
  chrome.runtime.onUpdateAvailable.addListener(function () {
    mcSetUpdateFlag('update_available');
  });
}

mcCheckForUpdate();

chrome.runtime.onInstalled.addListener(function (details) {
  // 只在真正首次安装时记时间；更新扩展不能把老用户重新算成新用户。
  if (details && details.reason === 'install') {
    chrome.storage.local.set({ mc_install_at: Date.now() });
  }
  // 刚更新完商店那一侧的状态要重新问一次，不然旧标记一直挂着＝页面还在喊"有新版"
  mcCheckForUpdate();
  syncRegisteredScripts();
});

chrome.runtime.onStartup.addListener(function () {
  mcCheckForUpdate();
  syncRegisteredScripts();
});

// Service Worker 启动/唤醒时主动核实一次脚本注册
syncRegisteredScripts();
syncFocusRegistration();

/* 处理 Supabase Google OAuth 跨域重定向流 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'mc_reload_extension') {
    // 只有页面里跑着我们那份内容脚本的投递才认（sender.tab 为空＝扩展自己的页面，那条不走这里）
    if (!sender || !sender.tab) return;
    sendResponse({ ok: true });
    // 换版靠这一颗：Chrome 已经把新包下好了，reload 之后跑的就是它，不用重启整个浏览器。
    // 发信的那一页自己会跟着刷一次（见 content.js 那颗 Update now），
    // 其它标签页故意不代刷：那些页里可能正写着作业，替人家刷新会丢没存的东西
    try { chrome.runtime.reload(); } catch (e) {}
    return;
  }
  if (msg && msg.type === 'mc_check_update') {
    // 页面把睡着的后台叫醒来问一次；这里回的是当前标记，页面自己听着 storage.onChanged 收结果
    mcCheckForUpdate();
    chrome.storage.local.get([MC_UPDATE_FLAG_KEY], function (res) {
      sendResponse({ ok: true, update: (res && res.mc_update_available) || null });
    });
    return true;
  }
  if (msg && msg.type === 'mc_focus_broadcast') {
    // 番茄钟选了"所有网站"那一档：扩展重载之前就开着的那些页面上没有 focus.js，
    // 光改存储它们不会动。这里把脚本和表补投一次，替他省掉逐个刷新。
    // 页面里那份认了门牌，投两遍也只有一份卡。受限地址（商店、chrome://）会抛，逐颗吞掉
    if (!sender || !sender.tab) { sendResponse({ ok: false, error: 'no_sender' }); return; }
    try {
      registerFocusForAllSites(function (registered, error) {
        if (!registered) {
          sendResponse({ ok: false, error: error || 'permission_required' });
          return;
        }
      chrome.tabs.query({}, function (tabs) {
        var hit = 0;
        (tabs || []).forEach(function (tab) {
          if (!tab.id || !/^https?:/i.test(String(tab.url || ''))) return;
          hit++;
          try {
            chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['focus.css'] }, swallow);
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['focus.js'] }, swallow);
            /* Grading 那颗入口是挂在 Focus 那张卡里的。只补投 focus 两件的话，
               这一屏会有一张卡、卡里少一行，要等他手动刷新才出得来 */
            if (/instructure\.com|canvaslms\.com|canvas\.net/i.test(String(tab.url || ''))) {
              chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['grading.css'] }, swallow);
              chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['grading-core.js', 'grading.js'] }, swallow);
            }
          } catch (e) {}
        });
        sendResponse({ ok: true, tabs: hit });
      });
      });
    } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    return true; // 异步响应
  }
  if (msg && msg.type === 'mc_focus_unpin_all') {
    if (!sender || !sender.tab) { sendResponse({ ok: false, error: 'no_sender' }); return; }
    unregisterFocusForAllSites(function () { sendResponse({ ok: true }); });
    return true;
  }
  if (msg && msg.type === 'mc_fetch_policy') {
    // Grading 那一屏要读学校自己官网上的政策页。页面里的内容脚本发不出跨源请求，这里代取一份。
    // 只认 https，不带 cookie（那是人家的站点，不是用户的 Canvas），正文取完就交给页面去清洗。
    var policyUrl = String(msg.url || '');
    if (!publicPolicyUrl(policyUrl)) { sendResponse({ ok: false, error: 'that link is not a public https page' }); return true; }
    var policyAbort = new AbortController();
    var policyTimer = setTimeout(function () { policyAbort.abort(); }, 15000);
    /* redirect 必须自己一跳一跳验：合法的学校官网 302 进 169.254.169.254 或内网那一圈，
       跟着跳就等于替用户把门打开。页面里那颗 publicUrl 只筛了他粘贴的第一条 */
    function hop(url, depth) {
      return fetch(url, { credentials: 'omit', redirect: 'manual', signal: policyAbort.signal }).then(function (res) {
        if (res.type === 'opaqueredirect' || res.status >= 300 && res.status < 400) {
          if (depth >= 3) { return { ok: false, error: 'that link redirects too many times' }; }
          var to = res.headers.get('location');
          var nextUrl = to ? new URL(to, url).href : '';
          if (!publicPolicyUrl(nextUrl)) return { ok: false, error: 'that link redirects somewhere private' };
          return hop(nextUrl, depth + 1);
        }
        return res.text().then(function (body) {
          var landed = res.url || url;
          // 逐跳已经判过，这里再判一次落地那一跳：res.url 才是真打开的那个地址
          if (!publicPolicyUrl(landed)) return { ok: false, error: 'that link ended somewhere private' };
          return { ok: true, status: res.status, finalUrl: landed, contentType: res.headers.get('content-type') || '', body: String(body || '').slice(0, 400000) };
        });
      });
    }
    hop(policyUrl, 0)
      .then(function (row) { clearTimeout(policyTimer); sendResponse(row); })
      .catch(function (err) {
        clearTimeout(policyTimer);
        sendResponse({ ok: false, error: err && err.name === 'AbortError' ? 'that page took more than 15 seconds' : String((err && err.message) || err) });
      });
    return true; // 异步响应
  }
  if (msg && msg.type === 'mc_oauth_google') {
    var authUrl = msg.authUrl;
    if (!chrome.identity || !chrome.identity.launchWebAuthFlow) {
      sendResponse({ ok: false, error: 'identity_not_supported' });
      return true;
    }
    chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    }, function (redirectUrl) {
      if (chrome.runtime.lastError || !redirectUrl) {
        sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'User cancelled' });
      } else {
        sendResponse({ ok: true, redirectUrl: redirectUrl });
      }
    });
    return true; // 异步响应
  }
});
