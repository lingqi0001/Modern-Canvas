/**
 * Modern Canvas - Popup script
 * Manages custom Canvas LMS school domain permissions and script registration.
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'mc_custom_domains';
  /* 页面那一趟取色算完以后抄进来的九档最终色，见 content.js 的 mcPublishPopupTheme。
     popup 是另一个文档，既读不到页面上的 --mc-*，也读不到 Canvas 源那份 localStorage，
     只能靠这一格存档传。没抄过（从没开过 Canvas）就停在 popup.css 里那套 Canvas 原生色 */
  var THEME_KEY = 'mc_popup_theme_v1';
  var TOKENS = ['--mc-background-0', '--mc-background-1', '--mc-background-2', '--mc-borders',
    '--mc-links', '--mc-text-0', '--mc-text-1', '--mc-text-2'];
  // 和 theme-lib 的 solidOf 同一条门槛：整串必须就是一颗纯色，渐变和 url 一律不收
  var SOLID_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i;

  // Elements
  var statusDot = document.getElementById('statusDot');
  var statusLabel = document.getElementById('statusLabel');
  var statusDomain = document.getElementById('statusDomain');
  var btnEnableDomain = document.getElementById('btnEnableDomain');
  var btnEnableText = document.getElementById('btnEnableText');
  var domainList = document.getElementById('domainList');
  var siteCount = document.getElementById('siteCount');
  var manualDomainInput = document.getElementById('manualDomainInput');
  var btnAddManual = document.getElementById('btnAddManual');
  var inputError = document.getElementById('inputError');
  var readingFooter = document.getElementById('readingFooter');
  var readingText = document.getElementById('readingText');
  var btnOpenSettings = document.getElementById('btnOpenSettings');
  var statusActions = document.getElementById('statusActions');
  var btnPauseToggle = document.getElementById('btnPauseToggle');
  var btnResume = document.getElementById('btnResume');
  var pauseMenu = document.getElementById('pauseMenu');

  var currentTab = null;
  var currentHostname = '';

  function checkPaused(callback) {
    if (!currentTab || !currentTab.id) {
      return fallbackCheckStorage(callback);
    }
    chrome.storage.local.get(['mc_paused_until'], function (res) {
      var globalUntil = res && res.mc_paused_until;
      var isGlobalPaused = false;
      var validUntil = null;
      if (globalUntil === -1 || globalUntil === '-1') {
        isGlobalPaused = true;
        validUntil = -1;
      } else if (globalUntil === 'reload') {
        isGlobalPaused = true;
        validUntil = 'reload';
      } else if (globalUntil) {
        var num = Number(globalUntil);
        if (num && Date.now() < num) {
          isGlobalPaused = true;
          validUntil = num;
        } else {
          chrome.storage.local.remove('mc_paused_until');
        }
      }

      chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: function () {
          return {
            isPaused: document.documentElement.classList.contains('mc-paused'),
            isActive: document.documentElement.classList.contains('mcx-canvas-active'),
            lsVal: localStorage.getItem('mc_paused_until')
          };
        }
      }, function (results) {
        if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
          return callback(isGlobalPaused, validUntil);
        }
        var pageRes = results[0].result;
        // 1. 如果当前页面挂着 mc-paused 确处于暂停状态
        if (pageRes.isPaused) {
          var val = pageRes.lsVal || validUntil;
          if (val === '-1' || val === -1) return callback(true, -1);
          if (val === 'reload') return callback(true, 'reload');
          var n = Number(val);
          if (n && Date.now() < n) return callback(true, n);
          return callback(true, validUntil || 'reload');
        }
        // 2. 如果页面 localStorage 有待暂停标记
        if (pageRes.lsVal) {
          if (pageRes.lsVal === '-1') return callback(true, -1);
          if (pageRes.lsVal === 'reload') return callback(true, 'reload');
          var nVal = Number(pageRes.lsVal);
          if (nVal && Date.now() < nVal) return callback(true, nVal);
        }
        // 3. 全局存储处于暂停态
        if (isGlobalPaused) {
          return callback(true, validUntil);
        }
        callback(false, null);
      });
    });
  }

  function fallbackCheckStorage(callback) {
    chrome.storage.local.get(['mc_paused_until'], function (res) {
      var until = res && res.mc_paused_until;
      if (!until) return callback(false, null);
      if (until === -1 || until === '-1') return callback(true, -1);
      if (until === 'reload') return callback(true, 'reload');
      var num = Number(until);
      if (num && Date.now() < num) return callback(true, num);
      chrome.storage.local.remove('mc_paused_until');
      callback(false, null);
    });
  }

  function formatRemaining(until) {
    if (until === -1 || until === '-1') return 'Until you turn it back on';
    if (until === 'reload') return 'Until you reload the page';
    var diff = Number(until) - Date.now();
    if (diff <= 0) return 'Expires soon';
    var mins = Math.ceil(diff / 60000);
    if (mins < 60) return mins + ' min left';
    var hrs = Math.floor(mins / 60);
    var remMins = mins % 60;
    return hrs + ' hr' + (remMins > 0 ? ' ' + remMins + ' min' : '') + ' left';
  }

  /* ==== 主题色 ==== */

  var cssDefaults = {};

  function rememberCssDefaults() {
    var cs = getComputedStyle(document.documentElement);
    TOKENS.forEach(function (token) { cssDefaults[token] = String(cs.getPropertyValue(token)).trim(); });
  }

  // #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() → [r,g,b,a]，读不到 null
  function toRgb(raw) {
    var v = String(raw || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
    if (m) {
      var hex = m[1];
      if (hex.length === 3) hex = hex.replace(/./g, function (c) { return c + c; });
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16),
        hex.length > 6 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(v);
    if (!m) return null;
    var part = m[1].split(/[,\s/]+/).filter(Boolean);
    if (part.length < 3) return null;
    var num = function (s, scale) {
      var n = parseFloat(s);
      if (isNaN(n)) return 0;
      return String(s).indexOf('%') !== -1 ? n / 100 * scale : Math.min(scale, n);
    };
    return [num(part[0], 255), num(part[1], 255), num(part[2], 255),
      part.length > 3 ? num(part[3], 1) : 1];
  }

  function relLum(rgb) {
    var c = rgb.slice(0, 3).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var x = relLum(a), y = relLum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function mixWith(ink, base, k) {
    return ink.map(function (v, i) { return Math.round(v * (1 - k) + base[i] * k); });
  }

  function applyTheme(tokens) {
    var st = document.documentElement.style;
    var out = {};
    TOKENS.forEach(function (token) {
      var raw = String((tokens || {})[token] || '').trim();
      var rgb = SOLID_RE.test(raw) ? toRgb(raw) : null;
      // 面板上那颗 "No colour" 抄过来是透明的，铺在 popup 上会把这一档刷穿，当没读到
      out[token] = rgb && rgb[3] > 0.35 ? raw : '';
    });

    // 半透明卡底先合成到页面底上，后面判对比度用的是眼睛真看到的那颗
    var page = toRgb(out['--mc-background-1'] || cssDefaults['--mc-background-1']) || [255, 255, 255, 1];
    var cardRaw = out['--mc-background-0'];
    var card = cardRaw ? toRgb(cardRaw) : toRgb(cssDefaults['--mc-background-0']);
    if (card && card[3] < 1) card = mixWith(card, page, 1 - card[3]);
    if (!card) card = page;

    var surfaces = [card, page];
    ['--mc-text-0', '--mc-text-1', '--mc-text-2'].forEach(function (token) {
      var raw = out[token] || cssDefaults[token];
      var rgb = toRgb(raw);
      if (!rgb) return;
      // 两层底里最差的那一层。判据和页面上那套可读性兜底同一档线（3:1）
      var worst = surfaces[0], worstRatio = contrast(rgb, surfaces[0]);
      for (var i = 1; i < surfaces.length; i++) {
        var r = contrast(rgb, surfaces[i]);
        if (r < worstRatio) { worstRatio = r; worst = surfaces[i]; }
      }
      if (worstRatio >= 3) return;
      // 主题那三档一起按最差底翻黑白，并照原来的层级往底色靠回去：
      // 只换第一档会让正文和小字变成同一颗色
      var ink = relLum(worst) > 0.45 ? [0, 0, 0] : [255, 255, 255];
      var k = token === '--mc-text-0' ? 0 : token === '--mc-text-1' ? 0.3 : 0.55;
      var fixed = mixWith(ink, worst.slice(0, 3), k);
      out[token] = 'rgb(' + fixed[0] + ', ' + fixed[1] + ', ' + fixed[2] + ')';
    });

    var accent = toRgb(out['--mc-links'] || cssDefaults['--mc-links']);
    if (accent) {
      // 强调色板上那颗勾/那行字按它自己的明暗翻黑白，阈值和页面那套同一颗 0.45
      st.setProperty('--mc-links-ink', relLum(accent) > 0.45 ? '#000000' : '#ffffff');
    }

    TOKENS.forEach(function (token) { if (out[token]) st.setProperty(token, out[token]); });
  }

  function readTheme(cb) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { cb({}); return; }
    chrome.storage.local.get([THEME_KEY], function (res) {
      var tokens = res && res[THEME_KEY];
      cb(tokens && typeof tokens === 'object' ? tokens : {});
    });
  }

  rememberCssDefaults();
  readTheme(applyTheme);

  /* ==== 界面 ==== */

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }


  // 1. 获取已保存的域名列表
  function getCustomDomains(cb) {
    if (!chrome.storage || !chrome.storage.sync) {
      cb([]);
      return;
    }
    chrome.storage.sync.get([STORAGE_KEY], function (res) {
      var list = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
      cb(list);
    });
  }

  function saveCustomDomains(list, cb) {
    var data = {};
    data[STORAGE_KEY] = list;
    chrome.storage.sync.set(data, function () {
      if (cb) cb();
    });
  }

  // 检查某个域名是否是系统默认自动支持的 Canvas 域名
  function isDefaultCanvasDomain(hostname) {
    if (!hostname) return false;
    var h = hostname.toLowerCase();
    return (h === 'instructure.com' || h.endsWith('.instructure.com') ||
            h === 'canvas.net' || h.endsWith('.canvaslms.com') ||
            h.startsWith('canvas.') || h.indexOf('.canvas.') !== -1 || h.indexOf('-canvas.') !== -1);
  }

  // 检查是否可能为学校/高校/教育相关网站（排除通用网站）
  function isCandidateSchoolDomain(hostname) {
    if (!hostname) return false;
    var h = hostname.toLowerCase();
    // 1. 教育类顶级或二级域名，例如 .edu, .edu.cn, .edu.hk, .edu.au, .ac.uk, .ac.jp 等
    if (/\.edu(\.[a-z]{2,4})?$/i.test(h)) return true;
    if (/\.ac\.[a-z]{2,4}$/i.test(h)) return true;
    // 2. 教育通用顶级域名
    if (/\.(school|academy|university)$/i.test(h)) return true;
    // 3. 包含教育机构或教学平台特征关键词
    if (/(^|\.)[^.]*(school|college|university|univ|academy|campus|k12|lms)[^.]*(\.|$)/i.test(h)) return true;
    return false;
  }

  // 清洗输入的域名
  function sanitizeHostname(input) {
    if (!input) return '';
    var str = input.trim().toLowerCase();
    // 移除协议头 http:// 或 https://
    str = str.replace(/^https?:\/\//i, '');
    // 移除 path 和 query
    str = str.split('/')[0].split('?')[0].split('#')[0];
    // 移除端口号
    str = str.split(':')[0];
    return str;
  }

  // 给指定域名注册动态 Content Scripts
  function registerScriptsForDomain(hostname, callback) {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) {
      if (callback) callback();
      return;
    }

    var matchPattern = '*://' + hostname + '/*';
    var calendarPattern1 = '*://' + hostname + '/calendar*';
    var calendarPattern2 = '*://' + hostname + '/courses/*/calendar*';
    var idPrefix = 'mc_dyn_' + hostname.replace(/[^a-zA-Z0-9_-]/g, '_');

    var scripts = [
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
          'sourceviewer.js'
        ],
        runAt: 'document_idle',
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
        // 与 background.js 那份 getScriptsConfig 同一条：漏这里＝从 popup 授权的域名没有 Grading 那一行
        id: idPrefix + '_grading',
        matches: [matchPattern],
        css: ['grading.css'],
        js: ['grading-core.js', 'grading.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true
      },
      {
        id: idPrefix + '_theaterjs',
        matches: [matchPattern],
        js: ['theater-frame.js'],
        runAt: 'document_idle',
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
      }
    ];

    // 先注销可能存在的同名旧脚本，然后注册
    var ids = scripts.map(function (s) { return s.id; });
    chrome.scripting.unregisterContentScripts({ ids: ids }, function () {
      if (chrome.runtime.lastError) {
        // ignore error if not registered
      }
      chrome.scripting.registerContentScripts(scripts, function () {
        if (chrome.runtime.lastError) {
          console.warn('registerContentScripts warning:', chrome.runtime.lastError);
        }
        if (callback) callback();
      });
    });
  }

  // 注销指定域名的脚本
  function unregisterScriptsForDomain(hostname, callback) {
    if (!chrome.scripting || !chrome.scripting.unregisterContentScripts) {
      if (callback) callback();
      return;
    }
    var idPrefix = 'mc_dyn_' + hostname.replace(/[^a-zA-Z0-9_-]/g, '_');
    var ids = [
      idPrefix + '_start',
      idPrefix + '_cal',
      idPrefix + '_main',
      idPrefix + '_notif',
      idPrefix + '_idle',
      idPrefix + '_theater',
      idPrefix + '_theaterjs',
      idPrefix + '_grading',
      idPrefix + '_preview'
    ];
    chrome.scripting.unregisterContentScripts({ ids: ids }, function () {
      if (chrome.runtime.lastError) {}
      if (callback) callback();
    });
  }

  // 渲染域名列表
  function renderDomainList(domains) {
    siteCount.textContent = (domains.length + 1).toString();

    // 清空现有自定义项，保留第一项 instructure
    var items = domainList.querySelectorAll('.custom-domain-item');
    items.forEach(function (el) { el.remove(); });

    domains.forEach(function (dm) {
      var li = document.createElement('li');
      li.className = 'domain-item custom-domain-item';
      li.innerHTML =
        '<div class="domain-info">' +
          '<span class="domain-name">' + esc(dm) + '</span>' +
          '<span class="domain-tag">School Custom Canvas</span>' +
        '</div>' +
        '<button type="button" class="btn-remove" title="Remove permission" data-domain="' + esc(dm) + '">' +
          '<svg viewBox="0 0 20 20" fill="currentColor">' +
            '<path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>' +
          '</svg>' +
        '</button>';
      domainList.appendChild(li);
    });
  }

  function syncCacheToTab(tabId, domainList, cb) {
    if (!tabId || !chrome.scripting || !chrome.scripting.executeScript) {
      if (cb) cb();
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (arr) {
        try { localStorage.setItem('mc_custom_domains_cache', JSON.stringify(arr)); } catch (e) {}
      },
      args: [domainList]
    }, function () {
      if (chrome.runtime.lastError) {}
      if (cb) cb();
    });
  }

  // 授权并添加域名
  function requestAndAddDomain(targetDomain, isCurrentTab, callback) {
    var originPattern = '*://' + targetDomain + '/*';

    chrome.permissions.request({ origins: [originPattern] }, function (granted) {
      if (!granted) {
        if (callback) callback(false, 'Permission request was dismissed or denied.');
        return;
      }

      getCustomDomains(function (list) {
        if (list.indexOf(targetDomain) === -1) {
          list.push(targetDomain);
          saveCustomDomains(list, function () {
            registerScriptsForDomain(targetDomain, function () {
              // 如果刚好是当前活动标签页，先写入本地缓存再刷新以立即应用
              if (isCurrentTab && currentTab && currentTab.id) {
                syncCacheToTab(currentTab.id, list, function () {
                  chrome.tabs.reload(currentTab.id);
                });
              }
              if (callback) callback(true);
            });
          });
        } else {
          // 已经存在，更新注册
          registerScriptsForDomain(targetDomain, function () {
            if (isCurrentTab && currentTab && currentTab.id) {
              syncCacheToTab(currentTab.id, list, function () {
                chrome.tabs.reload(currentTab.id);
              });
            }
            if (callback) callback(true);
          });
        }
      });
    });
  }

  // 移除域名
  function removeDomain(targetDomain) {
    var originPattern = '*://' + targetDomain + '/*';
    chrome.permissions.remove({ origins: [originPattern] }, function () {
      getCustomDomains(function (list) {
        var idx = list.indexOf(targetDomain);
        if (idx !== -1) {
          list.splice(idx, 1);
          saveCustomDomains(list, function () {
            unregisterScriptsForDomain(targetDomain, function () {
              if (currentTab && currentTab.id && currentHostname === targetDomain) {
                syncCacheToTab(currentTab.id, list, function () {
                  chrome.tabs.reload(currentTab.id);
                  updateUI();
                });
              } else {
                updateUI();
              }
            });
          });
        }
      });
    });
  }

  // 更新整个界面状态
  function updateUI() {
    getCustomDomains(function (domains) {
      renderDomainList(domains);

      if (!currentHostname) {
        statusDot.className = 'status-dot inactive';
        statusLabel.textContent = 'Ready';
        statusDomain.textContent = 'Open your school\'s Canvas page';
        btnEnableDomain.style.display = 'none';
        if (statusActions) statusActions.style.display = 'none';
        if (pauseMenu) pauseMenu.style.display = 'none';
        return;
      }

      statusDomain.textContent = currentHostname;

      var isCanvasSite = isDefaultCanvasDomain(currentHostname) || (domains.indexOf(currentHostname) !== -1);

      if (isCanvasSite) {
        btnEnableDomain.style.display = 'none';
        checkPaused(function (isPaused, until) {
          if (statusActions) statusActions.style.display = 'flex';
          if (isPaused) {
            statusDot.className = 'status-dot paused';
            statusLabel.textContent = 'Paused · ' + formatRemaining(until);
            if (btnPauseToggle) btnPauseToggle.style.display = 'none';
            if (btnResume) {
              btnResume.style.display = 'inline-flex';
              btnResume.disabled = false;
              btnResume.textContent = 'Resume';
            }
            if (pauseMenu) pauseMenu.style.display = 'none';
          } else {
            statusDot.className = 'status-dot active';
            statusLabel.textContent = 'Modern Canvas is on';
            if (btnPauseToggle) btnPauseToggle.style.display = 'inline-flex';
            if (btnResume) btnResume.style.display = 'none';
          }
        });
        return;
      }

      if (statusActions) statusActions.style.display = 'none';
      if (pauseMenu) pauseMenu.style.display = 'none';

      // 3. 如果是未激活的学校自定义域名（如 .edu, .ac.uk, 包含 school/college 等）
      if (isCandidateSchoolDomain(currentHostname)) {
        statusDot.className = 'status-dot prompt';
        statusLabel.textContent = 'Canvas site found';
        btnEnableDomain.style.display = 'inline-flex';
        btnEnableText.textContent = 'Enable on this site';
        return;
      }

      // 4. 普通非 Canvas 网站（如 gemini.google.com, supabase.com 等），静默关闭
      statusDot.className = 'status-dot inactive';
      statusLabel.textContent = 'Off on this site';
      btnEnableDomain.style.display = 'none';
    });
  }

  // 绑定事件
  function initEvents() {
    // 监听暂停下拉菜单开关
    if (btnPauseToggle) {
      btnPauseToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = pauseMenu.style.display !== 'none';
        pauseMenu.style.display = isOpen ? 'none' : 'flex';
        btnPauseToggle.classList.toggle('is-open', !isOpen);
      });
    }

    // 点击暂停时长选项
    if (pauseMenu) {
      pauseMenu.addEventListener('click', function (e) {
        e.stopPropagation();
        var item = e.target.closest('.pause-menu-item');
        if (!item) return;
        var duration = item.getAttribute('data-duration');
        var until;
        if (duration === '30') {
          until = Date.now() + 30 * 60 * 1000;
        } else if (duration === '120') {
          until = Date.now() + 120 * 60 * 1000;
        } else if (duration === 'reload') {
          until = 'reload';
        } else if (duration === '-1') {
          until = -1;
        }

        chrome.storage.local.set({ mc_paused_until: until }, function () {
          if (currentTab && currentTab.id) {
            chrome.scripting.executeScript({
              target: { tabId: currentTab.id },
              func: function (val) {
                try { localStorage.setItem('mc_paused_until', String(val)); } catch (e) {}
              },
              args: [until]
            }, function () {
              chrome.tabs.reload(currentTab.id, function () {
                window.close();
              });
            });
          } else {
            updateUI();
          }
        });
      });
    }

    // 点击恢复按钮
    if (btnResume) {
      btnResume.addEventListener('click', function (e) {
        e.stopPropagation();
        btnResume.disabled = true;
        btnResume.textContent = 'Turning back on…';
        chrome.storage.local.remove('mc_paused_until', function () {
          statusDot.className = 'status-dot active';
          statusLabel.textContent = 'Modern Canvas is on';
          btnResume.style.display = 'none';
          if (btnPauseToggle) btnPauseToggle.style.display = 'inline-flex';

          if (currentTab && currentTab.id) {
            chrome.scripting.executeScript({
              target: { tabId: currentTab.id },
              func: function () {
                try { localStorage.removeItem('mc_paused_until'); } catch (e) {}
              }
            }, function () {
              chrome.tabs.reload(currentTab.id, function () {
                setTimeout(function () {
                  window.close();
                }, 100);
              });
            });
          } else {
            updateUI();
          }
        });
      });
    }

    // 点击空白处收起菜单
    document.addEventListener('click', function (e) {
      if (pauseMenu && !e.target.closest('#pauseMenu') && !e.target.closest('#btnPauseToggle')) {
        pauseMenu.style.display = 'none';
        if (btnPauseToggle) btnPauseToggle.classList.remove('is-open');
      }
    });

    // 监听一键启用按钮
    btnEnableDomain.addEventListener('click', function () {
      if (!currentHostname) return;
      btnEnableDomain.disabled = true;
      btnEnableText.textContent = 'Turning on…';
      requestAndAddDomain(currentHostname, true, function (success, err) {
        btnEnableDomain.disabled = false;
        if (!success && err) {
          alert(err);
        }
        updateUI();
      });
    });

    // 监听手动添加
    btnAddManual.addEventListener('click', function () {
      var val = sanitizeHostname(manualDomainInput.value);
      inputError.style.display = 'none';

      if (!val) {
        inputError.textContent = 'Enter a valid Canvas address, such as canvas.school.edu.';
        inputError.style.display = 'block';
        return;
      }
      if (val.indexOf('.') === -1) {
        inputError.textContent = 'That address does not look right. Check it and try again.';
        inputError.style.display = 'block';
        return;
      }
      if (isDefaultCanvasDomain(val)) {
        inputError.textContent = 'This Canvas site is already supported.';
        inputError.style.display = 'block';
        return;
      }

      btnAddManual.disabled = true;
      var isCurrent = (val === currentHostname);
      requestAndAddDomain(val, isCurrent, function (success, err) {
        btnAddManual.disabled = false;
        if (success) {
          manualDomainInput.value = '';
          updateUI();
        } else if (err) {
          inputError.textContent = err;
          inputError.style.display = 'block';
        }
      });
    });

    // 监听列表上的删除按钮
    domainList.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-remove');
      if (!btn) return;
      var domain = btn.getAttribute('data-domain');
      if (domain && confirm('Stop allowing Modern Canvas on ' + domain + '?')) {
        removeDomain(domain);
      }
    });

    // 监听设置齿轮按钮点击
    if (btnOpenSettings) {
      btnOpenSettings.addEventListener('click', function () {
        if (!currentTab || !currentTab.id) {
          window.close();
          return;
        }
        chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          func: function () {
            // 优先直接调用全局设置打开事件
            document.dispatchEvent(new CustomEvent('mc-open-settings'));
            // 兜底方案：触发页面上的设置按钮点击
            var gear = document.querySelector('.custom-todo-gear-btn, .mc-nav-settings-link, .mc-nav-settings-item');
            if (gear) gear.click();
          }
        }, function () {
          window.close();
        });
      });
    }
  }

  function updateReadingStatus(statusText) {
    if (!readingFooter || !readingText) return;
    if (statusText) {
      readingText.textContent = statusText;
      readingFooter.style.display = 'flex';
    } else {
      readingFooter.style.display = 'none';
      readingText.textContent = '';
    }
  }

  // 监听后台/页面阅读状态变动
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.mc_reading_assignment_status) {
        updateReadingStatus(changes.mc_reading_assignment_status.newValue);
      }
    });
  }

  // 启动
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0] && tabs[0].url) {
      currentTab = tabs[0];
      try {
        var parsed = new URL(tabs[0].url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          currentHostname = parsed.hostname;
        }
      } catch (e) {}
    }
    initEvents();
    updateUI();
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['mc_reading_assignment_status'], function (res) {
        if (res && res.mc_reading_assignment_status) {
          updateReadingStatus(res.mc_reading_assignment_status);
        }
      });
    }
  });
})();
