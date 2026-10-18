(function () {
  'use strict';

  // content.js intentionally leaves every iframe early: that avoids making the
  // rich-text editor sluggish, but Canvas renders its PDF controls in an iframe
  // too.  Keep this file deliberately small so only the two reader controls run
  // there.
  if (window.self === window.top) return;

  var EXPAND_ID = 'canvas-inline-theater-btn';
  var THEME_ID = 'canvas-document-theme-btn';
  var currentMode = 'NORMAL';
  var themeEnabled = false;

  function fullscreenButton(bar) {
    var items = Array.prototype.slice.call(bar.querySelectorAll('button, a, div[role="button"]'));
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item.id === EXPAND_ID) continue;
      var label = ((item.getAttribute('aria-label') || '') + ' ' + (item.getAttribute('title') || '')).toLowerCase();
      if (label.indexOf('full screen') !== -1 || label.indexOf('fullscreen') !== -1 || label.indexOf('全屏') !== -1) return item;
    }
    var icon = bar.querySelector('.icon-fullscreen, [class*="fullscreen"]');
    return icon && icon.closest('button, [role="button"]');
  }

  function surface() {
    var selectors = ['.ViewerControls', '.canvashdr', '.docviewer-wrapper'];
    for (var i = 0; i < selectors.length; i += 1) {
      var bars = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < bars.length; j += 1) {
        var button = fullscreenButton(bars[j]);
        if (button) return { bar: bars[j], button: button };
      }
    }
    return null;
  }

  function directControl(host, id) {
    var kids = host.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].id === id) return kids[i];
    }
    return null;
  }

  function paint() {
    var target = surface();
    var expand = document.getElementById(EXPAND_ID);
    if (!target || !expand) return;
    var text = target.button.querySelector('.canvas-custom-fs-text');
    if (!text) return;
    expand.classList.toggle('active', currentMode === 'EXPAND');
    expand.textContent = currentMode === 'EXPAND' ? 'EXIT' : 'EXPAND';
    expand.title = currentMode === 'EXPAND' ? 'Exit expand mode (Esc)' : 'Expand to page (Esc to exit)';
    target.button.classList.toggle('active', currentMode === 'FULLSCREEN');
    text.textContent = currentMode === 'FULLSCREEN' ? 'EXIT' : 'FULLSCREEN';
    target.button.title = currentMode === 'FULLSCREEN' ? 'Exit full screen (Esc)' : 'Enter Full Screen';
    var theme = document.getElementById(THEME_ID);
    if (theme) {
      theme.classList.toggle('active', themeEnabled);
      theme.setAttribute('aria-pressed', themeEnabled ? 'true' : 'false');
      theme.title = themeEnabled ? 'Document theme is on' : 'Document theme is off';
    }
  }

  function mount() {
    var target = surface();
    if (!target || !target.button.parentElement) return;
    var nativeButton = target.button;
    var host = nativeButton.parentElement;
    var text = nativeButton.querySelector('.canvas-custom-fs-text');
    var remounted = false;
    if (!text) {
      nativeButton.innerHTML = '';
      text = document.createElement('span');
      text.className = 'canvas-custom-fs-text';
      nativeButton.appendChild(text);
      remounted = true;
    }
    nativeButton.classList.add('canvas-unified-btn');
    if (!nativeButton.dataset.canvasTheaterBound) {
      nativeButton.dataset.canvasTheaterBound = 'true';
      nativeButton.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'FULLSCREEN', surface: 'viewer' }, '*');
      }, true);
    }

    // React may leave a just-detached old toolbar node in flight while it mounts
    // a replacement.  Never reuse a control from another (or detached) toolbar.
    var expand = directControl(host, EXPAND_ID);
    if (!expand) {
      expand = document.createElement('button');
      expand.id = EXPAND_ID;
      expand.type = 'button';
      expand.className = 'canvas-unified-btn';
      expand.setAttribute('aria-label', 'Expand to Page');
      expand.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.top.postMessage({ type: 'CANVAS_REQUEST_MODE', mode: 'EXPAND', surface: 'viewer' }, '*');
      });
      remounted = true;
    }
    var theme = directControl(host, THEME_ID);
    if (!theme) {
      theme = document.createElement('button');
      theme.id = THEME_ID;
      theme.type = 'button';
      theme.className = 'canvas-unified-btn canvas-document-theme-btn';
      theme.textContent = 'THEME DOCUMENT';
      theme.setAttribute('aria-label', 'Theme Document');
      theme.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.top.postMessage({ type: 'CANVAS_SET_DOCUMENT_THEME', enabled: !themeEnabled }, '*');
      });
      remounted = true;
    }
    if (!host.isConnected || !nativeButton.isConnected || nativeButton.parentElement !== host) return;
    // Insert from right to left. The reference nodes are direct children (or
    // newly-created detached nodes), so React wrappers cannot cause NotFoundError.
    if (nativeButton.previousElementSibling !== expand) host.insertBefore(expand, nativeButton);
    if (expand.previousElementSibling !== theme) host.insertBefore(theme, expand);
    paint();
    if (remounted) window.top.postMessage({ type: 'CANVAS_REQUEST_MODE_SYNC' }, '*');
    if (remounted) window.top.postMessage({ type: 'CANVAS_DOCUMENT_THEME_SYNC' }, '*');
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'CANVAS_VIEW_MODE_CHANGED') {
      currentMode = event.data.mode || 'NORMAL';
      mount();
    } else if (event.data && event.data.type === 'CANVAS_DOCUMENT_THEME_CHANGED') {
      themeEnabled = !!event.data.enabled;
      paint();
    }
  });

  var queued = false;
  function scheduleMount() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; mount(); });
  }
  new MutationObserver(scheduleMount).observe(document.documentElement, { childList: true, subtree: true });
  scheduleMount();
}());
