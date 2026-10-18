/* =========================================================
   设置面板（新）：独立居中卡片 + 左栏分类锚点 + 一分组一卡。
   Themes 和 Colours 这两档不是分组，是一屏（左栏点下去以后正文那一列整个换掉，
   卡片跟着变宽），各自的文件都在 settings.css 里。
   样式在同名 settings.css；开关和下拉要落的效果靠 content.js 末尾那份 window.mcHost。
   两边没接上时（mcHost 还没跑到）这一份整个不接管，点开还是走老的，不会两颗键都没反应。
   ========================================================= */
(function () {
  'use strict';

  // 非 Canvas 站点直接退出，严禁截获捕获阶段按键与点击事件
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

  if (window.self !== window.top) return;

  var OVERLAY_ID = 'mc-set-overlay';
  var ENTRY = '.custom-todo-gear-btn, .mc-nav-settings-link, .mc-nav-settings-item';
  var ANIM_MS = 300;
  var MENU_CLOSE_MS = 220;
  var BTX_PAGE = 50;
  var BTX_SLOTS = ['background-0', 'background-1', 'background-2', 'cards', 'borders',
    'links', 'buttons', 'text-0', 'text-1', 'text-2', 'sidebar', 'sidebar-text'];
  var BTX_TEXT_SLOTS = ['text-0', 'text-1', 'text-2', 'links', 'sidebar-text'];
  var BTX_BASE_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  /* 分组和行的摆法在这里说一次；下拉有哪些档、默认哪一档仍然只存在 content.js 那份
     MODERN_SETTINGS 里，这边不抄第二份，否则加一个档就得改两个文件。
     Themes 那一档不是分组，是一个视图（view: true），所以它没有 rows。 */
  var GROUPS = [
    { id: 'theme', title: 'Theme', rows: [
      // 这一整档在两套同时在场、或曾记录过 BC 主题时展示：
      // BC 关掉后只要有历史记录，依然允许用户自由切回该记录主题
      { type: 'select', key: 'theme_owner', label: 'Choose which theme to use', onlyBcLive: true, orRecorded: true },
      { type: 'note', key: 'theme_owner', text: btxOwnerNote, onlyBcLive: true, orRecorded: true },
      { type: 'button', cls: 'mc-set-bc-settings', text: 'Open BetterCampus Settings', onlyBcLive: true },
      // 两套都在刷这一页时才给这一颗：去我们自己的主题墙挑一份，挑完就等于定了用我们的
      { type: 'button', cls: 'mc-set-open-themes', text: 'Browse Modern Canvas themes', onlyClash: true },
      { type: 'note', key: 'mc_ext_steps', text: btxExtStepsNote, onlyClash: true },
      { type: 'button', cls: 'mc-set-copy-ext', text: 'Copy ' + btxExtAddress(), onlyClash: true },
      { type: 'check', key: 'mc_smart_contrast', label: 'Smart Text Contrast', defOn: true },
      { type: 'note', key: 'mc_smart_contrast', text: function () { return 'Makes hard-to-read text easier to see on dark themes. Turn it off to use the theme\'s original text colours.'; } },
      { type: 'check', key: 'mc_nav_blur', label: 'Frosted sidebar picture', defOn: false },
      { type: 'note', key: 'mc_nav_blur', text: navBlurNote }
    ] },
    /* 这两档不是滚动的一组，是一屏（view: true）：十二档色加一整套取色器，
       挤在设置那一列里排不下，而且它是"改完马上要在页面上看"的东西，得占满正文那一列。
       entryText／entryCls 是这张门：摆在 Theme 那一组后面，
       往下滑却从那几组直接跳到 Actions，等于这两屏只能从左边进 */
    { id: 'colours', title: 'Customize theme', view: true, entryCls: 'mc-set-open-colours', entryText: 'Edit colours' },
    { id: 'themes', title: 'Theme Picker', view: true, entryCls: 'mc-set-open-themes', entryText: 'Browse themes' },
    { id: 'ai', title: 'AI & Plans', rows: [
      /* 这颗总开关摆在整组最上面，而且要一直看得见：它是关掉以后唯一的退回入口。
         下面那一屏（路线、两档模型、用量、订阅信息）照样画照样刷新，只是页面里那些入口全收掉 */
      { type: 'check', key: 'mc_ai_enabled', label: 'Use AI features', defOn: true },
      { type: 'note', key: 'mc_ai_enabled', text: aiMasterNote },
      /* 用量那张卡不住在这一列里，它挂在 AI 那一屏的同一个容器中（aimodeRowHtml），
         这样它的宽、圆角、底色和上面两块板是同一份几何 */
      { type: 'aimode' }
    ] },
    { id: 'todo', title: 'Hub', rows: [
      { type: 'select', key: 'ring_style', label: 'Progress ring style' },
      { type: 'select', key: 'rings_for', label: 'Show progress rings for' },
      { type: 'select', key: 'grouping', label: 'Group tasks by date' },
      { type: 'check', key: 'mc_show_missing', label: 'Show missing items', defOn: true },
      { type: 'note', key: 'mc_show_missing', text: btxMissingNote },
      { type: 'select', key: 'missing_placement', label: 'Put missing items in' },
      { type: 'select', key: 'missing_range', label: 'Show missing items from' },
      { type: 'select', key: 'missing_on_paper', label: 'Include paper tasks in Missing' },
      { type: 'note', key: 'missing_on_paper', text: btxOnPaperNote },
      { type: 'select', key: 'date_format', label: 'Date format' },
      { type: 'select', key: 'week_start', label: 'Week starts on' },
      { type: 'select', key: 'card_click', label: 'Open cards in' },
      { type: 'check', key: 'bc_show_course_rail', label: 'Course colour bar', defOn: false },
      // 这一颗管三样：抽屉里的课程名、卡片左缘那条色、鼠标经过时那一圈外框。
      // 默认 accent＝三处都用主题强调色，挑 course 才回到每门课自己的颜色（落点 style.css 的 html.bc-course-colour-accent）
      { type: 'select', key: 'course_colour', label: 'Course title color' },
      { type: 'note', key: 'course_colour', text: btxCourseColourNote },
      { type: 'check', key: 'bcx_bc_todo', label: 'Show BetterCampus to-do list', defOn: true, onlyBcLive: true },
      { type: 'check', key: 'mc_todo_canvas', label: 'Sync completed tasks with Canvas', defOn: true },
      { type: 'note', key: 'mc_todo_canvas', text: btxTickNote },
      { type: 'check', key: 'bc_keep_feedback_logo', label: 'Show school logo under recent feedback' }
    ] },
    /* Focus 那一档管的是作业标题右边那颗键，和它点开的那块计时板。
       三档快捷时长写在这一页的 localStorage：读它的那一块只在 Canvas 页上画，
       不需要跨站点，所以不用另搬一份到扩展存储里 */
    { id: 'focus', title: 'Focus', rows: [
      { type: 'check', key: 'mc_focus_on', label: 'Focus timer on assignments', defOn: true },
      { type: 'note', key: 'mc_focus_on', text: 'Puts a Focus button next to the name of every assignment. It starts a timer for that assignment, and the timer shows above your Hub list.' },
      { type: 'text', key: 'mc_focus_presets', label: 'Quick times (minutes)', def: '15, 30, 60', placeholder: '15, 30, 60' },
      { type: 'note', key: 'mc_focus_presets', text: 'These show as the three buttons when you pick a time. The first one is the time that starts when you press Focus.' }
    ] },
    { id: 'widgets', title: 'Widgets', rows: [
      { type: 'check', key: 'mc_dash_focus_card', label: 'Show widgets on the Dashboard', defOn: true },
      { type: 'note', key: 'mc_dash_focus_card', text: 'Shows widgets alongside your course cards on the Dashboard. Turn it off to hide all widgets.' },
      { type: 'widget_modes' },
      { type: 'jump', cls: 'mc-set-open-grades', label: 'Grade Settings', note: 'Configure grading policy, course weights, and GPA appearance.' }
    ] },
    { id: 'dashboard', title: 'Dashboard', rows: [
      { type: 'select', key: 'card_layout', label: 'Card Layout' },
      { type: 'check', key: 'mc_dash_tasks', label: 'Show tasks on course cards', defOn: true },
      { type: 'note', key: 'mc_dash_tasks', text: btxDashTasksNote },
      { type: 'select', key: 'card_task_limit', label: 'Tasks shown per card' },
      // 这两行互相管着对方：它在跑且归我们时 Show card grades 按不动，它不在场时这一颗按不动
      { type: 'select', key: 'dash_grade_owner', label: 'Show grades from', onlyBcLive: true },
      { type: 'note', key: 'dash_grade_owner', text: btxGradeOwnerNote, onlyBcLive: true },
      { type: 'check', key: 'mc_dash_grades', label: 'Show card grades' },
      { type: 'note', key: 'mc_dash_grades', text: btxGradeShowNote },
      { type: 'check', key: 'mc_dash_outline', label: 'Grey border on course cards', defOn: true },
      { type: 'note', key: 'mc_dash_outline', text: function () { return 'Adds a light border when course cards blend into the page background.'; } },
      { type: 'check', key: 'mc_planner_plate', label: 'Use the Modern Canvas list-view toolbar and New Activity tab', defOn: true },
      { type: 'check', key: 'mc_opportunities_plate', label: 'Use the Modern Canvas alerts panel', defOn: true },
      { type: 'check', key: 'mc_update_hint', label: 'Update hint in the top-right corner', defOn: true },
      { type: 'note', key: 'mc_update_hint', text: btxUpdateHintNote },
      { type: 'check', key: 'bc_keep_footer', label: 'Instructure footer' },
      { type: 'note', key: 'bc_keep_footer_note', text: btxFooterNote }
    ] },
    // 课程卡那三行的自定义文字：一屏（哪几行上屏＋每门课三格自定义）
    { id: 'cardtext', title: 'Course info', view: true, entryCls: 'mc-set-open-cardtext', entryText: 'Edit course names' },
    // 侧栏那一列行的顺序／显隐。以前和 Colours 一样是一屏，2026-10-11 并进滚动流：
    // 这一档只剩拖拽和勾两件事，不值得为它换屏，也不需要 Apply 那一步
    { id: 'nav', title: 'Sidebar', clip: true, rows: [
      { type: 'nav_lists' }
    ] },
    { id: 'search', title: 'Search', rows: [
      { type: 'check', key: 'mc_search_box', label: 'Show search results below the search box', defOn: true },
      { type: 'note', key: 'mc_search_box', text: btxSearchNote },
      { type: 'check', key: 'mc_search_box_own', label: 'Add our own search box when the page has none', defOn: true },
      { type: 'note', key: 'mc_search_box_own', text: btxSearchOwnNote }
    ] },
    { id: 'photos', title: 'Photos', rows: [
      { type: 'check', key: 'mc_source_viewer', label: 'Photo viewer on teacher pictures', defOn: true },
      { type: 'note', key: 'mc_source_viewer', text: function () { return 'Open course images in a viewer with zoom, rotation, download, and text extraction.' } }
    ] },
    { id: 'inbox', title: 'Inbox', rows: [
      { type: 'check', key: 'mc_inbox_new_ui', label: 'Use the Modern Canvas inbox', defOn: true },
      { type: 'note', key: 'mc_inbox_new_ui', text: btxInboxNote },
      { type: 'check', key: 'mc_inbox_ai', label: 'Show AI summaries in Inbox', defOn: true },
      { type: 'note', key: 'mc_inbox_ai', text: btxInboxAiNote }
    ] },
    /* 这一档不管功能开关，只管"你的东西存在哪儿、怎么清、留多久"。
       三颗清理键各删各的那一格，谁都不许顺手把对方删掉，也都不许碰 Reset all settings & data 那一颗管的东西 */
    { id: 'privacy', title: 'Privacy & storage', rows: [
      { type: 'note', key: 'mc_ai_privacy', text: aiPrivacyNote },
      { type: 'button', cls: 'mc-set-ai-revoke-sharing', text: 'Revoke AI sharing approval' },
      { type: 'retention' },
      { type: 'note', key: 'mc_ai_retention', text: aiRetentionNote },
      { type: 'note', key: 'mc_ai_chats', text: aiHistoryNote },
      { type: 'button', cls: 'mc-set-ai-clear', text: 'Clear saved chats' },
      { type: 'note', key: 'mc_ai_progress', text: aiProgressNote },
      { type: 'button', cls: 'mc-set-ai-clear-progress', text: 'Clear learning progress' },
      { type: 'note', key: 'mc_ai_accounts', text: aiAccountsNote },
      { type: 'button', cls: 'mc-set-ai-clear-accounts', text: 'Clear AI model slots' },
      { type: 'note', key: 'mc_ai_usage', text: aiUsageNote },
      { type: 'button', cls: 'mc-set-ai-clear-usage', text: 'Clear usage log' }
    ] },
    { id: 'sites', title: 'School Sites', rows: [
      { type: 'sites_manager' }
    ] },
    { id: 'actions', title: 'Actions', card: 'actions', rows: [
      { type: 'button', cls: 'mc-set-sync', text: 'Sync now' },
      { type: 'button', cls: 'mc-set-migrate-legacy mc-set-migrate-legacy', text: 'Import data from an older version' },
      { type: 'button', cls: 'mc-set-remote-content', text: 'News & feedback' },
      { type: 'button', cls: 'mc-set-bc-settings', text: 'Open BetterCampus Settings', onlyBcLive: true },
      { type: 'button', cls: 'mc-set-reset-all', text: 'Reset all settings and data' }
    ] }
  ];

  var btx = { all: [], mc: [], byCode: {}, page: 1, query: '', note: '', detail: null, detailFull: null, timer: 0, focusPage: false };
  var btxFonts = {};
  var p = null;   // 开着的那一座面板：overlay / card / body / 两个视图

  function store() { return window.mcHost || null; }

  /* 这两颗 AI 开关（排版、读扫描文件）住在扩展自己的存储里，页面存储那一头只是它的影子：
     读数那一侧（canvas-data.js 的 OCR、study-panel.js 的排版）拿不到异步值，得先有个同步影子。
     影子不涉密（就一个 '0'/'1'），所以允许留；涉密的那几格从来往这一头写。 */
  var AI_MIRROR_KEYS = { mc_ai_enabled: 1, mc_ai_format: 1, mc_ai_ocr: 1, mc_ai_usage_line: 1 };

  function checkOn(row) {
    var saved = aiSwitchValue(row.key);
    return row.defOn ? saved !== '0' : saved === '1';
  }

  function aiSwitchValue(key) {
    var s = window.MCxStorage;
    if (s && s.getSyncFallback) return String(s.getSyncFallback(key, localStorage.getItem(key)));
    try { return String(localStorage.getItem(key)); } catch (e) { return 'null'; }
  }

  // 那句说明讲的是"翻了这一档，屏幕上看得见什么"，所以两种状态各写一句，跟着开关换。
  // 开着那句还顺带解释了为什么改背景那一行会连文字一起变：那三条兜底就归它管。
  // 卡底推亮那一档也归这一颗管（2026-10-16 并进来，不另配开关），所以两句里各补了一句它
  function flipNoteHtml() {
    return localStorage.getItem('mc_set_theme_flip') !== '0'
      ? 'On: Adjusts text and card colors when they do not have enough contrast with the background.'
      : 'Off: Uses each theme color as provided, even when text or cards have low contrast.';
  }

  /* 这颗总开关的两句。都只报"屏幕上哪几样东西没了"，因为这颗管的正是那几处入口，
     而且关掉以后这一屏是唯一的退回入口，所以 Off 那一句要把"回到这里再开"写在明处 */
  function aiMasterNote() {
    return aiSwitchValue('mc_ai_enabled') === '0'
      ? 'Off: Hides every AI entry on the pages. No Study With AI in the sidebar, no summaries in Inbox, no guide card on assignments. Nothing reads files or writes in the background. Everything below keeps the values you left, and you turn AI back on here.'
      : 'On: Shows the AI entries on the pages. Study With AI is in the sidebar, Inbox adds a summary above each message, and assignments get a guide card.';
  }

  // AI 那一档的三句说明。都只讲屏幕上看得见的那件事，两种状态各写一句
  function aiEntryNote() {
    return localStorage.getItem('mc_ai_entry') === '0'
      ? 'Off: Hides Study With AI from the sidebar. You can still open it from the button above.'
      : 'On: Adds Study With AI to the sidebar. You can move or hide it in Canvas\'s sidebar settings.';
  }

  /* 这一排讲的是屏幕上那几段宽归谁：面板占哪一段、页面让哪几列。
     第一句跟着"推不推页面"那一颗翻，因为它说的就是屏幕上看得见的那一件事 */
  function aiLayoutNote() {
    var first = localStorage.getItem('mc_ai_push') === '0'
      ? 'Docked: The panel overlays the page.'
      : 'Docked: The page shifts over to make room for the panel.';
    return first
      + ' On wider screens, saved chats appear beside the answer.'
      + ' Drag the edge to resize the panel; your choice is saved.';
  }

  function aiKeyNote() {
    return 'Your API key is stored in this extension on this computer. '
      + 'Requests go directly to your selected provider. Do not save a key on a shared computer.';
  }

  /* 这颗开关管的是"扫描版那一页有没有字进得来"，所以两句都讲屏幕上少掉的东西：
     关掉它，一份扫描的 PDF 在总结里就是一句"读不出字" */
  function aiOcrNote() {
    return aiSwitchValue('mc_ai_ocr') === '1'
      ? 'On: Reads scanned pages and images on this computer so their text can be included in summaries. This may take a few seconds per page.'
      : 'Off: Scanned pages and images without selectable text are skipped.';
  }

  /* 这颗管的是"回来那一屏怎么排"，所以两句都讲屏幕上看得见的那件事：
     开着才有标题、条目、表格和算式，出处那一小块也只在开着的时候才画 */
  function aiFormatNote() {
    return aiSwitchValue('mc_ai_format') === '1'
      ? 'On: Formats headings, lists, tables, and formulas. Source tags such as [R3] show where a statement came from.'
      : 'Off: Shows AI responses as plain text.';
  }

  /* 历史那一屏的账：这一句讲的是这台机器上现在存着几条、上限多少、清掉会少掉什么。
     数字是每次开面板现读的，不是存下来的一份副本。
     库里那一份要异步才读得回来，所以"还没读到过"和"一条都没有"必须说两句不同的话：
     把前者报成后者，他会以为自己攒了几个星期的会话没了 */
  function aiHistoryNote() {
    var h = window.MCxHistory;
    if (!h) return 'Saved chats are not available yet. Reload the page and try again.';
    if (!h.known()) return 'Loading saved chats...';
    var n = h.count();
    if (!n) {
      return 'Saved chats are stored on this computer. You do not have any yet.';
    }
    return 'Saved chats are stored only in this extension. '
      + n + ' saved; the newest ' + h.cap + ' are kept. Clearing them does not change anything in Canvas.';
  }

  var RETENTION = [
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 0, label: 'Forever' }
  ];

  function retentionLabel(days) {
    var hit = RETENTION.filter(function (r) { return r.days === Number(days); })[0];
    return hit ? hit.label : String(days) + ' days';
  }

  /* 保留期那一排照 AI Provider 那一排的样子摆（同一套药丸），因为它就是同一件事：在一小串档里挑一档。
     三档都是真档，没有"看着像关闭又不删东西"的那种兜底档 */
  function retentionRowHtml() {
    var h = window.MCxHistory;
    var cur = h && h.known ? h.retentionDays() : 90;
    var pills = RETENTION.map(function (r) {
      return '<button type="button" class="mcx-prov-pill' + (r.days === Number(cur) ? ' is-active' : '') + '"'
        + ' data-retention="' + r.days + '">' + esc(r.label) + '</button>';
    }).join('');
    return '<div class="mc-set-row mc-prov-row">' +
      '<div class="mc-prov-header">' +
        '<span class="mc-set-label">Keep saved chats</span>' +
        '<span class="mc-prov-current" data-retention-current="1">' + esc(retentionLabel(cur).toUpperCase()) + '</span>' +
      '</div>' +
      '<div class="mcx-prov-pills-wrap">' + pills + '</div>' +
    '</div>';
  }

  function aiRetentionNote() {
    var h = window.MCxHistory;
    var days = h ? h.retentionDays() : 90;
    return Number(days) === 0
      ? 'Forever: Chats stay until you delete them. The newest 50 chats are kept.'
      : 'Chats you have not opened for ' + days + ' days are removed automatically. The newest 50 chats are kept.';
  }

  /* 这一节讲的就是"什么东西存在哪一块地盘"，所以三样各自一句，收尾说清楚这三颗键各管各的 */
  function aiPrivacyNote() {
    var base = 'Your model settings, API keys, saved chats, and practice review data are stored in this extension. '
      + (aiMode() === 'byo' ? 'Selected material and your key go directly to your configured AI provider.' : 'Selected material goes through the Modern Canvas Cloudflare gateway to OpenRouter and the selected model provider. Your email and sign-in token go to our gateway to manage access and credits.') + ' The receiving services apply their own retention and data-use policies. You are asked before first sharing with each destination.';
    var warn = '';
    if (window.MCxStorage && !window.MCxStorage.available()) warn = ' ' + window.MCxStorage.unavailableNote();
    else if (window.MCxAi && window.MCxAi.storageNote) {
      var n = window.MCxAi.storageNote();
      if (n) warn = ' ' + n;
    }
    return base + warn;
  }

  function aiAccountsNote() {
    var h = window.MCxAi;
    if (!h) return 'AI settings are not ready yet. Reload the page and try again.';
    if (!h.settingsLoaded || !h.settingsLoaded()) return 'Loading AI settings...';
    /* 云端那一路手上没有钥匙（走网关＋内测码），所以这一句在云端态不能说"清掉两把钥匙" */
    if (aiMode() !== 'byo') return 'You are using Modern Canvas AI, so there are no saved provider keys to clear.';
    var n = h.profiles().filter(function (a) { return a.filled; }).length;
    if (!n) return 'No saved API keys to clear.';
    return 'Clears the provider, address, and API key from ' + n + ' model slot(s). '
      + 'Your chats, practice answers, theme, and other settings stay unchanged.';
  }

  /* 用量那一本账的账：这一句讲的是这台机器上现在存着几条、上限多少、清掉会少掉什么。
     和聊天历史同一个规矩：库里那本还没读回来时不许报"一条都没有" */
  function aiUsageNote() {
    var a = window.MCxAi;
    if (!a || !a.usage) return 'Usage data is not ready yet. Reload the page and try again.';
    if (!a.usage.known()) return 'Loading usage data...';
    var rows = a.usage.recent(a.usage.cap);
    if (!rows.length) return 'No usage data yet. It appears after your first AI response.';
    return 'This extension stores your most recent ' + rows.length + ' AI requests on this computer.';
  }

  /* 练习那本账的账：这一句讲的是这台机器上现在存着几个知识点的掌握状态、现在有几个到期该复习。
     数字每次开面板现读，不是存下来的一份副本；Practice questions 那一屏答完一题才会多一条 */
  function aiProgressNote() {
    if (!window.MCxProgress) return 'Learning progress is not ready yet. Reload the page and try again.';
    // 和聊天历史同一件事：库里那本还没读回来时不许报"一个都还没练过"
    if (window.MCxProgress.known && !window.MCxProgress.known()) {
      return 'Loading practice review...';
    }
    var all = window.MCxProgress.summary(0);
    if (!all.practiced) {
      return 'Your practice answers are stored on this computer to schedule review. Complete a practice question to start your review queue.';
    }
    var cid = window.MCxData ? window.MCxData.currentCourseId() : 0;
    var mine = cid ? window.MCxProgress.summary(cid) : null;
    var head = mine && mine.practiced
      ? 'This course: ' + mine.practiced + ' concept' + (mine.practiced === 1 ? '' : 's') + ' practised'
        + (mine.dueNow ? ', ' + mine.dueNow + ' due for review now' : ', none due yet') + '. '
      : 'This course has nothing practised yet. ';
    return head + 'All courses on this computer: ' + all.practiced + ' practised'
      + (all.dueNow ? ', ' + all.dueNow + ' due for review' : ', none due yet')
      + '. Clearing this queue takes nothing away from Canvas.';
  }

  // 侧栏那层磨砂的两句说明：讲屏幕上看得见的那件事，两种状态各一句，跟着开关换
  function navBlurNote() {
    return localStorage.getItem('mc_nav_blur') === '1'
      ? 'On: the picture behind the sidebar rows is frosted, so names stay easy to read on a busy picture. The names and their icons are not blurred.'
      : 'Off: the sidebar shows its picture exactly as the theme drew it. Turn this on when the row names are hard to read over the picture. A sidebar with no picture looks the same either way.';
  }

  /* 只有"这一格的色是那份主题给的"这一种情况才真按不动：那一格上深色的那套 token 就是两套抢同一层。
     BetterCampus 在跑**不**算拦人的理由——它只要装着就会挂那个类名，判不出"它此刻到底有没有在刷色"，
     上一版把它当成因锁掉，结果他页面上这一行永远翻不动。现在照旧让他翻，只在说明里说一句可能接不住 */
  function darkModeBlocked() {
    var h = store();
    if (!h) return '';
    if (h.mcThemeOff && !h.mcThemeOff()) return 'theme';
    return '';
  }

  function darkModeNoteHtml() {
    var h = store();
    if (darkModeBlocked() === 'theme') {
      return 'Light and Dark are unavailable while a custom theme or custom colors are active. Edit the colors below instead.';
    }
    if (h && h.bcxBcLive && h.bcxBcLive()) {
      return 'Light uses Canvas colors. Dark uses Modern Canvas colors. BetterCampus may keep some of its own colors.';
    }
    return 'Light uses Canvas colors. Dark uses Modern Canvas colors across supported pages.';
  }

  /* 按不动的样子就是这一行：压淡＋那颗下拉不接点，不描边、不掉位。
     只有"这一格是那份主题的色"这一种成因会锁它，所以 renderColours 每一趟跟着档位重算一遍 */
  function syncDarkRow() {
    if (!p || !p.colors) return;
    var row = p.colors.querySelector('.cts-select-row [data-select="colour_mode"]');
    if (!row) return;
    var holder = row.closest('.mc-set-row');
    var why = darkModeBlocked();
    if (holder) holder.classList.toggle('mc-set-off', !!why);
    var note = p.colors.querySelector('[data-note="colour_mode"]');
    if (note) note.textContent = darkModeNoteHtml();
  }

  /* 卡片分数那两行的说明按现场翻：BC 在不在这一页、Card grades shown by 挑的哪一档。
     两个都会翻（它晚挂载、他从主题墙挑完回来、他从三个点里点那一行），所以每次渲染和每次改动都要重算。
     "Card grades shown by" 那一行本身在 BC 不在场时整行不摆（onlyBcLive），这里只剩翻说明 */
  function syncGradeRows() {
    if (!p || !p.overlay) return;
    var n1 = p.overlay.querySelector('[data-note="dash_grade_owner"]');
    if (n1) n1.textContent = btxGradeOwnerNote();
    var n2 = p.overlay.querySelector('[data-note="mc_dash_grades"]');
    if (n2) n2.textContent = btxGradeShowNote();
  }

  /* BC 在跑时切到 Canvas 那一档要先问一句（afterSelect 里那条弹窗）。
     深浅色这一行**不**因为 BC 在跑就锁死：它只要装着就会挂那个类名，判不出"此刻有没有在刷主题"，
     锁掉的后果是他永远翻不动（2026-10-06 他报的） */

  // 打勾落点那两句话只在 content.js 里存一份，这边只负责摆。
  // 抄第二份的话改一句措辞就得改两个文件，迟早对不上
  // 这一档说的是"页面那一层归谁刷"，所以说明要点名看得见的四样东西：整页底色、侧栏那张图、
  // 卡片上的图、字体。自家面板和侧栏控件不在让步名单里，所以那一句专门写出来
  function hasRecordedTheme() {
    var h = store();
    if (h && h.mcHasRecordedBcTheme) return h.mcHasRecordedBcTheme();
    try {
      return !!localStorage.getItem('mc_bc_recorded_theme');
    } catch (_) {
      return false;
    }
  }

  // 打勾落点那两句话只在 content.js 里存一份，这边只负责摆。
  // 抄第二份的话改一句措辞就得改两个文件，迟早对不上
  // 这一档说的是"页面那一层归谁刷"，所以说明要点名看得见的四样东西：整页底色、侧栏那张图、
  // 卡片上的图、字体。自家面板和侧栏控件不在让步名单里，所以那一句专门写出来
  function btxOwnerNote() {
    var h = store();
    var live = h && h.bcxBcLive ? h.bcxBcLive() : false;
    var recorded = hasRecordedTheme();
    var owner = h && h.mcPageThemeOwner ? h.mcPageThemeOwner() : 'mc';
    if (!live) {
      if (recorded) {
        if (owner === 'bc') {
          return 'We found a saved BetterCampus theme. You can keep using it after BetterCampus is off, or switch to a Modern Canvas theme.';
        }
        return 'We found a saved BetterCampus theme. Choose between it and Modern Canvas themes.';
      }
      return 'BetterCampus is not active, so Modern Canvas controls this page\'s theme.';
    }
    if (owner === 'bc') {
      return 'BetterCampus controls the page theme. Modern Canvas still controls the Hub, buttons, panels, and layout improvements.';
    }
    return 'Both extensions are styling this page, which can make colors change unexpectedly. Turn off BetterCampus theming or choose a Modern Canvas theme.';
  }

  /* 他挑了一份主题、或者在 Colours 里拧了一颗色＝他要用的就是我们的主题。
     那一档当场翻回 Modern Canvas，面板上那一行和它下面那句说明跟着换。
     不这么办就会留下最难受的一种：他在墙上挑了一份、色也拧了，屏幕上还是人家那一份 */
  function btxClaimThemeOwner() {
    var h = store();
    if (!h || !h.mcPageThemeOwner || h.mcPageThemeOwner() !== 'bc') return;
    localStorage.setItem('bc_theme_owner', 'mc');
    if (!p || !p.overlay) return;
    var sel = p.overlay.querySelector('.cts-select[data-select="theme_owner"]');
    if (sel) {
      sel.querySelector('.cts-select-value').textContent = h.ctsMeta('theme_owner').text.mc;
      sel.querySelector('.cts-menu').innerHTML = h.ctsMenuHtml('theme_owner');
    }
    var onote = p.overlay.querySelector('[data-note="theme_owner"]');
    if (onote) onote.textContent = btxOwnerNote();
  }

  // 浏览器那一层的扩展页地址。Edge 和 Chrome 不通用，按 UA 认一颗
  function btxExtAddress() {
    return /Edg\//.test(navigator.userAgent) ? 'edge://extensions' : 'chrome://extensions';
  }

  /* 为什么这里只给地址不给链接：浏览器不允许网页（我们这座面板就在页面里）跳到 chrome:// 那一页，
     挂个 <a> 点下去什么都不发生＝一颗死键。所以这一步交给他自己做，我们负责把地址一键复制好 */
  function btxExtStepsNote() {
    return 'Turn off the other extension in your browser, then reload this page. '
      + 'Your browser does not let us open that page from here, and a link would just sit there doing nothing, '
      + 'so this step is yours: open a new tab, go to ' + btxExtAddress()
      + ', find the extension, and turn its switch off.';
  }

  function btxTickNote() {
    var h = store();
    return h && h.mcTickNoteHtml ? h.mcTickNoteHtml() : '';
  }

  /* MISSING 那颗开关一翻，看得见的是"过期没交的那一批在不在列表里"，
     所以说明要把两边都讲到：开着它落在哪儿，关掉它去了哪儿 */
  // 纸面作业那一档：讲清两档各自在列表里看得见什么，尤其"摆进来以后只能手动点勾"
  function btxOnPaperNote() {
    return localStorage.getItem('missing_on_paper') === 'show'
      ? 'They stay in MISSING until you tick them in the Hub Panel. An on-paper task has no upload box, so Canvas never marks it submitted on its own.'
      : 'Past due on-paper tasks go straight to Finished. They have no upload box, so nothing about them is actually late.';
  }

  function btxMissingNote() {
    return localStorage.getItem('mc_show_missing') === '0'
      ? 'Off drops past due, unsubmitted work from the list. DUE SOON stops holding it too, so those tasks show nowhere until you turn this back on.'
      : 'Past due, unsubmitted work goes into a MISSING block pinned to the top. It stays there even when the date filter above points at another week.';
  }

  // 卡片上那块 Tasks：开着讲的是那一行推出来什么、点它等于点什么，
  // 关掉讲的是那些东西去了哪儿（都还在待办列表里，只是不上卡片）
  function btxDashTasksNote() {
    return localStorage.getItem('mc_dash_tasks') === '0'
      ? 'Off takes the task line off every course card. Those tasks stay in the Hub Panel, and so does the tick.'
      : 'Each course card lists the work still open in that course, up to the number below. The circle on the left is the same tick as the one in the Hub Panel, so ticking it on a card marks the task the same way. Work that is past due follows the Show missing items setting. This also takes back the spot on the card that the External Extension uses for its own list.';
  }

  /* 课程名那一档颜色。这一颗管的是"凡是按课程上色"的地方，2026-10-14 他把范围铺开了一圈：
     以前只管圆圈和色条，卡上那行主标题、待办／反馈／公告那三屏的课程名都翻不动。
     说明要把点它到底看得见什么写在前面，最后一句报现在哪一档（这句以前是写死的） */
  function btxCourseColourNote() {
    var where = 'It paints the course name in the sidebar drawer, the title on each dashboard card, '
      + 'the course line on every task, feedback and announcement row, the bar along the left edge of a course row, '
      + 'the outline that appears when the mouse is over the row, and the tick circles in the Hub Panel and on course cards.';
    return localStorage.getItem('bc_course_colour') === 'course'
      ? 'Each course keeps its own colour. ' + where + ' This is what they do right now.'
      : 'Everything that colours by course follows the theme instead. ' + where
        + ' The task title itself always stays the theme text colour. '
        + 'This is what they do right now.';
  }

  /* 卡片左上角那一格分数归谁画。这一档的存在理由是两套扩展在同一处各画一颗：
     ours＝藏它那棵、显示我们的；bc＝回到"逐张卡看到它画了就让位"那套旧逻辑（那套一行没改） */
  function gradeOwnerValue() {
    var h = store();
    var meta = h && h.MODERN_SETTINGS ? h.MODERN_SETTINGS.dash_grade_owner : null;
    var saved = localStorage.getItem('bc_dash_grade_owner');
    if (!meta) return 'ours';
    return meta.options.indexOf(saved) !== -1 ? saved : meta.def;
  }

  function btxGradeOwnerNote() {
    var h = store();
    var live = h && h.bcxBcLive ? h.bcxBcLive() : false;
    if (!live) return 'BetterCampus is not active, so this setting controls the grade shown on course cards.';
    return gradeOwnerValue() === 'ours'
      ? 'Our number sits in that spot and the grades BetterCampus draws there are hidden. When BetterCampus turns its card grades on or off, the row below moves once to match. Anything you click afterwards stays as you left it.'
      : 'BetterCampus keeps drawing its own number. We step back on any card where it drew one, and our number only shows on the cards it left alone.';
  }

  /* 这一行不再按不动：归我们时它也真的管显不显示，跟随只在它翻开关那一刻挪一次 */
  function btxGradeShowNote() {
    var h = store();
    var live = h && h.bcxBcLive ? h.bcxBcLive() : false;
    if (live && gradeOwnerValue() === 'ours') return 'Shows or hides the Modern Canvas grade percentage on each course card.';
    return 'Shows or hides the Modern Canvas grade percentage on each course card.';
  }

  /* 卡上那三行的显隐。判据只有一份，在 content.js 那边（mcCardLinesLeft）：
     这里再算一遍就会分成两套，一套挡住最后一颗、另一套说还剩几行，两边对不上就是假提示。
     读不到宿主时（面板本来也不接管）退成"三行都亮着"，只少那句提醒，不会误报 */
  var CARD_LINE_OF = { name: 'mc_card_show_name', code: 'mc_card_show_code', term: 'mc_card_show_term' };
  var CARD_LINE_ORDER = ['name', 'code', 'term'];
  var CARD_LINE_KEYS = {};
  CARD_LINE_ORDER.forEach(function (f) { CARD_LINE_KEYS[CARD_LINE_OF[f]] = f; });
  var CARD_LINE_WORDS = { name: 'course name', code: 'course code', term: 'term' };
  var CARD_LINE_LABELS = { name: 'Course name', code: 'Course code', term: 'Term' };
  var cardLinesTimer = null;

  function cardLinesLeft() {
    var h = store();
    return h && h.mcCardLinesLeft ? h.mcCardLinesLeft() : ['name', 'code', 'term'];
  }

  function cardLinesNote() {
    var left = cardLinesLeft();
    var base = 'Turn any of these off to take that line off every course card. '
      + 'The boxes below are what those lines say.';
    if (left.length === 1) {
      return base + ' The card now shows only ' + (CARD_LINE_WORDS[left[0]] || left[0])
        + '.';
    }
    return base;
  }

  function flashCardLinesNote() {
    var n = p && p.overlay.querySelector('[data-note="card_lines"]');
    if (!n) return;
    n.textContent = 'That is the last line still showing on a card, so it stays on.';
    clearTimeout(cardLinesTimer);
    cardLinesTimer = setTimeout(function () {
      if (!n.parentNode) return;
      n.textContent = cardLinesNote();
    }, 4000);
  }

  // 这一行摆在 Dashboard 分组里，但它管的那条 footer 在 #wrapper 底下，每个页面都有一条，
  // 所以说明里得先说清"关掉以后别的页面也会少一条"，否则他会在日历页找不到它去哪了
  function btxFooterNote() {
    return localStorage.getItem('bc_keep_footer') === '1'
      ? 'The Instructure logo and the policy links at the bottom of the page.'
      : 'Off removes the Instructure logo and the policy links at the bottom. That bar is on every Canvas page, so it goes on all of them.';
  }

  // 右上角那条更新提示。说明先把那颗键干的事写出来（当场换上新版，不用重启浏览器），
  // 再报代价（其它 Canvas 标签页各自刷新一次才有皮）。不写这两句他会以为翻了这颗就能更新，
  // 或者按完那颗键发现别的页面没皮了以为坏了
  function btxUpdateHintNote() {
    return localStorage.getItem('mc_update_hint') === '0'
      ? 'Off takes the note off the top-right of the dashboard. Chrome still downloads and installs updates on its own, so nothing about updating changes.'
      : 'A note appears in the top-right of the dashboard when Chrome reports a newer build. Update now on that note swaps in the newer build and reloads this page, no browser restart. Other Canvas tabs keep running until you refresh them, because a half written assignment box is not worth losing.';
  }

  // 这颗键管 Inbox 那一屏的左右两栏。顶部那条工具条（星标、归档、删除、回复）两种状态都归 Canvas，
  // 所以两句都得点名它不动，否则他会去我们那一栏里找归档
  function btxInboxNote() {
    return localStorage.getItem('mc_inbox_new_ui') === '0'
      ? 'Off puts Canvas back in charge of the Inbox page: its own list on the left and its own message on the right, with every row carrying its own date line.'
      : 'On draws both halves ourselves. The list gets one date per group and four lines starting at the same left edge. The message side becomes a thread where every reply shows who can actually see it, and a box at the bottom to answer from. Two rows sit above the list, Follow Up and Inbox Resources, and what you put in them stays on this computer and never reaches Canvas. The bar across the top with the star, archive and delete stays Canvas in both cases.';
  }

  // 这颗键管的是 Inbox 那一屏上 AI 的三个落点（顶上的摘要、里面的洞察、回复框那排）。
  // 说明必须点名"什么会被送出去"，因为它送的是老师写的原话
  function btxInboxAiNote() {
    return localStorage.getItem('mc_inbox_ai') === '0'
      ? 'Off takes the summary block off the top of every message and the AI Reply row out of the reply box. The rest of the Inbox stays as it is, including the Follow Up row and the resource list, neither of which sends anything anywhere.'
      : 'On adds three things. A block at the top of an open message gives you a summary in thirty words or fewer, then lists the tasks, dates and requirement changes it found in that same read. The reply box gets a row that writes you an English draft you can edit, which never sends anything by itself. A thread longer than 150 words summarizes the moment you open it, and a short one waits until you press Summarize. Each message goes once to the provider you typed under AI & Plans in Settings, and the answer stays on this computer until the thread changes. A message you never open is never sent.';
  }

  // 结果框挂在搜索框下面，所以说明要说清"多出来的是哪一块"和"点它等于什么"
  function btxSearchNote() {
    return localStorage.getItem('mc_search_box') === '0'
      ? 'Off takes the extra results box away. Canvas keeps its own search box and does what it shipped with.'
      : 'When you type in Canvas\'s own search box, a box opens under it listing matches from every course, grouped by kind: courses, work, announcements, discussions, pages, files and links. Picking a row goes straight to that page. Nothing is selected at first, so you see every kind. Tapping a chip at the top keeps only the kinds you tapped.';
  }

  // 我们自造的那一颗只在没有的学校上画，所以说明要先讲清那颗框本来就不是 Canvas 自带的
  function btxSearchOwnNote() {
    return localStorage.getItem('mc_search_box_own') === '0'
      ? 'Off leaves the top of the page exactly as Canvas has it. On a school without a search box, that means there is nothing to type in.'
      : 'The search box at the top right is not part of Canvas. Schools buy it separately, so some have it and some do not. When the page has none, this adds one of our own in the same spot. On the Dashboard it sits between those two buttons, and on course pages at the right end of the top row, next to the course name. Typing in it opens the same results box. We work out which case your school is the first time you open it and remember that answer for this site, so it never blinks in and out on later visits. Schools that already have a search box keep theirs and we add nothing.';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Pinterest 原图动辄几百 KB，一页 50 张划不动。它路径里那段尺寸是可以任取的，
  // 只有 /originals/ 换过去会 403，所以那条不动（详情那一张才用原图）
  function btxThumb(url) {
    return String(url || '').replace(/^(https?:\/\/i\.pinimg\.com\/)\d+x\//, '$1236x/');
  }

  /* ==== 主题文件从哪读 ====
     规则：包里那一批（Light / Dark 那两颗和 index.json 点到的那些）永远读扩展包，
     只有远程清单点过头的那些 code 才去桶里读。BetterCanvas 那两份（index.json 的 3197 行、
     t/ 里那一大堆）也永远读包里，既不往自己服务器上搬，也省掉每次点开先读空再回退的那一趟。
     MC_THEME_BASE ＝桶的公共地址那一层，末尾带斜杠。桶里那一层要叫小写 modern-canvas：
     对象键分大小写，相对地址就是把开头的 "themes/" 换成上面这个前缀得到的 */
  var MC_THEME_BASE = 'https://bmtxbdeoxtgmgejtayge.supabase.co/storage/v1/object/public/Themes/';
  /* 清单从哪来：填成桶那边那颗扫目录函数的地址＝桶里多一个 JSON 文件，墙上就多一张卡。
     函数挂了或没部署，那一列就只剩包里那几颗，不会空 */
  var MC_THEME_LIST_URL = 'https://bmtxbdeoxtgmgejtayge.supabase.co/functions/v1/themes';
  var mcThemeSourceLogged = false;
  // 远程清单里出现过的 code。只有在这里挂了号的，它的路径才换算成桶里的地址
  var mcRemoteCodes = {};

  function mcRemoteCode(rel) {
    var m = /^themes\/modern-canvas\/([^/?#]+?)(?:\.json)?(?:\/|$)/i.exec(String(rel || ''));
    var code = m ? m[1] : '';
    return code && mcRemoteCodes[code] ? code : '';
  }

  function mcThemeUrl(rel) {
    var s = String(rel || '');
    if (!s || /^(https?:|data:|chrome-extension:|mc-img:|blob:|chrome:)/i.test(s)) return s;
    if (!MC_THEME_BASE || !mcRemoteCode(s)) return '';
    return MC_THEME_BASE + s.replace(/^themes\//, '');
  }

  function btxJson(path) {
    // 扩展重载后旧页面里这份脚本的上下文已失效,chrome.runtime 会 undefined 或调用即抛。
    // 必须异步拒绝:同步抛错绕过调用方的 .catch,面板就一直停在 Loading themes…
    var local = '';
    try {
      local = chrome.runtime.getURL('themes/' + path);
    } catch (e) {
      var stale = new Error('The extension was reloaded, this page is still running the old script.');
      stale.stale = true;
      return Promise.reject(stale);
    }
    if (!mcThemeSourceLogged) {
      mcThemeSourceLogged = true;
      console.info('[MCX] 主题源：' + (MC_THEME_BASE ? '远程 ' + MC_THEME_BASE : '扩展包'));
    }
    // 本地那份是包里的文件，改了要重载扩展才生效，所以一直 no-store；
    // 远程那份不能 no-store，否则每次打开主题墙都把清单和整包图重下一遍
    var read = function (url, noStore) {
      return fetch(url, noStore ? { cache: 'no-store' } : undefined).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    };
    var remote = mcThemeUrl('themes/' + path);
    if (!remote) return read(local, true);
    return read(remote).catch(function (err) {
      console.warn('[MCX] 远程没读到 ' + path + '（' + (err && err.message ? err.message : String(err)) +
        '），退回扩展包那一份');
      return read(local, true);
    });
  }

  /* ==== 行 ==== */

  /* 下拉那几层沿用 content.js 的 cts- 钩子：Canvas 三点菜单改了 Card Layout 或分数时，
     它那两个 syncSettingsModal* 就是照 .cts-select / .cts-row input[data-setting] 找过来的，
     钩子换了名字这层同步会静默断掉（弹窗里那行还在说旧话） */
  function selectRowHtml(row) {
    var h = store();
    var meta = h && h.ctsMeta ? h.ctsMeta(row.key) : null;
    var current = h ? h.modernSetting(row.key) : (meta ? meta.def : '');
    return '<div class="mc-set-row cts-row cts-select-row">' +
      '<span class="mc-set-label">' + esc(row.label) + '</span>' +
      '<div class="cts-select mc-set-select" data-select="' + row.key + '">' +
        '<span class="cts-select-value">' + esc(meta && meta.text ? meta.text[current] : current) + '</span>' +
        '<svg class="cts-select-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
        '<div class="cts-menu mc-set-menu">' + (h ? h.ctsMenuHtml(row.key) : '') + '</div>' +
      '</div>' +
    '</div>';
  }

  function checkRowHtml(row) {
    return '<label class="mc-set-row cts-row">' +
      '<span class="mc-set-label">' + esc(row.label) + '</span>' +
      '<input type="checkbox" data-setting="' + row.key + '"' + (checkOn(row) ? ' checked' : '') + '>' +
      '<span class="mc-set-check" aria-hidden="true"></span>' +
    '</label>';
  }

  /* 文本行：以前 type:'text' 掉进 rowHtml 最后那条 button 退路，被画成一颗按钮。
     这一行是真的输入框，标签在左、框占满剩下那一段，长地址才不会看成"存进去了但看不见" */
  /* 这三格（Base URL／Model／API key）现在住在扩展自己的存储里，不再写这一页的 localStorage。
     判据只有一处：这一串键名。别的地方再写一遍就会分成两套。 */
  var AI_STORED_KEYS = { mc_ai_key: 1, mc_ai_model: 1, mc_ai_base: 1 };

  function aiStoredKey(key) { return !!AI_STORED_KEYS[key]; }

  function aiValue(row) {
    var a = window.MCxAi;
    if (!a || !a.settingsLoaded || !a.settingsLoaded()) return '';
    return a.getSetting(row.key) || row.def || '';
  }

  function textRowHtml(row) {
    if (aiStoredKey(row.key)) {
      var waiting = !(window.MCxAi && window.MCxAi.settingsLoaded && window.MCxAi.settingsLoaded());
      var v = aiValue(row);
      return '<div class="mc-set-row cts-row mc-set-textrow">' +
        '<span class="mc-set-label">' + esc(row.label) + '</span>' +
        '<input type="text" class="mc-set-text" data-setting="' + row.key + '"' +
          ' value="' + esc(v) + '"' +
          ' placeholder="' + esc(waiting ? 'Loading AI settings...' : (row.placeholder || '')) + '"' +
          (waiting ? ' disabled data-ph="' + esc(row.placeholder || '') + '"' : '') +
          (row.autocomplete ? ' autocomplete="' + esc(row.autocomplete) + '"' : '') + '>' +
      '</div>';
    }
    var saved = localStorage.getItem(row.key);
    if (saved == null) saved = row.def || '';
    return '<div class="mc-set-row cts-row mc-set-textrow">' +
      '<span class="mc-set-label">' + esc(row.label) + '</span>' +
      '<input type="text" class="mc-set-text" data-setting="' + row.key + '"' +
        ' value="' + esc(saved) + '"' +
        ' placeholder="' + esc(row.placeholder || '') + '"' +
        (row.autocomplete ? ' autocomplete="' + esc(row.autocomplete) + '"' : '') + '>' +
    '</div>';
  }

  /* 一份 key 一格。格子里只有名字、地址、key 三样——
     模型和要不要传图都在发送前一屏挑，所以这里不摆它们，免得同一格有两个地方能动 */
  function accountsRowHtml() {
    var list = window.MCxAi ? window.MCxAi.profiles() : [];
    var max = window.MCxAi ? window.MCxAi.maxProfiles : 5;
    var blocks = list.map(function (a, i) {
      return '<div class="mc-ai-acct" data-acct="' + esc(a.id) + '">' +
        '<div class="mc-ai-accthead"><span class="mc-ai-acctname">' + esc(a.name || ('Account ' + (i + 1))) + '</span>' +
          '<button type="button" class="mc-ai-accttest" data-acc-test="' + esc(a.id) + '">Test</button>' +
          (list.length > 1 ? '<button type="button" class="mc-ai-acctdel" data-acc-remove="' + esc(a.id) + '" aria-label="Remove this account">Remove</button>' : '') +
        '</div>' +
        '<div class="mc-set-row cts-row mc-set-textrow"><span class="mc-set-label">Name</span>' +
          '<input type="text" class="mc-set-text" data-acc-field="name" data-acc-id="' + esc(a.id) + '" value="' + esc(a.name || '') + '" maxlength="24"></div>' +
        '<div class="mc-set-row cts-row mc-set-textrow"><span class="mc-set-label">Base URL</span>' +
          '<input type="text" class="mc-set-text" data-acc-field="base" data-acc-id="' + esc(a.id) + '" value="' + esc(a.base || '') + '" placeholder="https://openrouter.ai/api/v1"></div>' +
        '<div class="mc-set-row cts-row mc-set-textrow"><span class="mc-set-label">API key</span>' +
          '<input type="text" class="mc-set-text" data-acc-field="key" data-ai-secret-input="1" data-acc-id="' + esc(a.id) + '" value="' + (a.key ? AI_KEY_MASK : '') + '" autocomplete="off" placeholder="paste it here"></div>' +
        '<div class="mc-set-note mcx-ai-result" data-acc-result="' + esc(a.id) + '"></div>' +
      '</div>';
    }).join('');
    if (!list.length) {
      blocks = '<div class="mc-set-note">No account yet. Add one below, then paste the address and the key it gave you.</div>';
    }
    var adder = list.length < max
      ? '<button type="button" class="mc-set-btn mc-set-wide mc-ai-add" data-acc-add="1">Add another account (' + (max - list.length) + ' left)</button>'
      : '';
    return '<div class="mc-ai-accounts">' + blocks + adder + '</div>';
  }

  function bindAccounts() {
    if (!window.MCxAi) return;
    var ov = p.overlay;

    ov.querySelectorAll('[data-acc-field]').forEach(function (input) {
      input.addEventListener('change', function () {
        var id = input.getAttribute('data-acc-id');
        var field = input.getAttribute('data-acc-field');
        var cur = window.MCxAi.profiles().filter(function (a) { return a.id === id; })[0];
        if (!cur) return;
        var next = { id: id, name: cur.name, base: cur.base, key: cur.key, model: cur.model };
        var typed = String(input.value || '').trim();
        // 静置时那一格是占位点，谁都没动过就不许把它当"用户填的新钥匙"写回库
        if (field === 'key' && typed === AI_KEY_MASK) return;
        next[field] = typed;
        window.MCxAi.saveProfile(next);
        // 名字一改，顶上那一行标题跟着换，不然屏幕上还是旧名
        var block = input.closest('[data-acct]');
        if (block && field === 'name') {
          var head = block.querySelector('.mc-ai-acctname');
          if (head) head.textContent = next.name;
        }
      });
    });

    /* 加一格、删一格都只换这一块。
       原先是整座面板重画一遍再补绑，结果 bindSelects／bindActions／bindNav 那一串没跟着跑，
       点完 Add 之后同一屏里其它行全部按不动 */
    function repaintAccounts() {
      var block = p.overlay.querySelector('.mc-ai-accounts');
      if (!block) return;
      var fresh = document.createElement('div');
      fresh.innerHTML = accountsRowHtml();
      block.parentNode.replaceChild(fresh.firstChild, block);
      bindAccounts();
    }

    p.overlay.querySelectorAll('[data-acc-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.MCxAi.addSlot();
        repaintAccounts();
      });
    });

    p.overlay.querySelectorAll('[data-acc-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.MCxAi.removeProfile(btn.getAttribute('data-acc-remove'));
        repaintAccounts();
      });
    });

    ov.querySelectorAll('[data-acc-test]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-acc-test');
        var block = btn.closest('[data-acct]');
        var line = block ? block.querySelector('[data-acc-result]') : null;
        if (!line) return;
        line.textContent = 'Asking it once...';
        btn.disabled = true;
        window.MCxAi.test(id, function (step) {
          line.textContent = 'Asking it once. Now at: ' + step;
        }).then(function (report) {
          btn.disabled = false;
          var rows = [];
          report.steps.forEach(function (s) {
            rows.push((s.ok ? 'Passed - ' : 'Failed - ') + s.name + ': ' + s.text);
          });
          if (report.ok) rows.push('This account works. The model used when you open the panel is ' + (report.cfg.model || 'the one you pick there') + '.');
          line.textContent = rows.join('\n');
        });
      });
    });
  }

  /* =========================================================
     AI 那一屏：顶上两张选择卡，底下一张详情卡，两屏各摆各的东西。
     屏上每一格都是这里自己画的。浏览器原生的 <select> 在这套主题里会露出系统那一份
     外观（自带白底和箭头），所以下拉是自绘的 listbox；文字格留的是真 <input>，
     因为打字、粘贴、中文输入法必须落在真输入框上，换成自绘容器只会把这三件事弄坏。
     它的外观、圆点遮罩、那颗眼睛全是我们自己的：遮罩用 -webkit-text-security，
     值本身一直是明文，所以粘贴和编辑都不会被遮罩打断。
     这一屏的账：模式 mc_ai_mode、云端模型 mc_ai_cloud_model、提供商 bc_ai_provider
     存在这一页；兑换码、钥匙／地址／模型名那三格存在扩展自己的存储里。
     ========================================================= */

  var ai = {
    codeEdit: false, codeState: '', codeMsg: '', codeDraft: '',
    foldOpen: false, codeOpen: false,
    /* 手填／全部模型／搜索这三样都是"某一个下拉"的事：两档各开各的菜单，
       把它们摊平成一份，就会变成在 Advanced 里搜过的词跑到 Flash 那一列上 */
    modelManual: {}, remoteModels: {}, modelQuery: {},
    picker: false, pickId: '',
    /* 用量那一屏开到哪一格：'' 是门，'list' 是那本账，'detail' 是其中一条。
       同一屏的三格都靠这一颗，不设第二份开关 */
    usage: '', usageId: '',
    // 那一列现在是摊开的还是只留最近 10 条
    usageOpen: false,
    /* Assignment Guide 那张卡：开合只在自己这一张，和用量那张同一个机制。
       个人门槛的算珠全在 assignment-baseline.js 那一颗，这里只摆出来、不重算 */
    guideOpen: false, guideAdvanced: false, guideMsg: '',
    authOpen: true, authEmailInput: '', authCodeInput: '', authStep: 'input',
    authLoading: false, authMsg: '', authMsgType: '', authCountDown: 0
  };

  var AI_ICONS = {
    google: '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    spark: '<path d="M11 4.2 12.5 8.6 16.9 10 12.5 11.5 11 15.9 9.5 11.5 5.1 10 9.5 8.6z"/><path d="M17.6 14.4 18.3 16.4 20.3 17.1 18.3 17.8 17.6 19.8 16.9 17.8 14.9 17.1 16.9 16.4z"/>',
    key: '<circle cx="8.4" cy="12" r="3.6"/><path d="M12 12h8.4M17.6 12v3.2M14.8 12v2.2"/>',
    eye: '<path d="M2.6 12S6.1 6.3 12 6.3 21.4 12 21.4 12 17.9 17.7 12 17.7 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeoff: '<path d="M4 4.6 20 19.4"/><path d="M9.6 6.7A9.6 9.6 0 0 1 12 6.4c5.9 0 9.4 5.6 9.4 5.6a17 17 0 0 1-3.2 3.8M6.5 8.4A16.7 16.7 0 0 0 2.6 12S6.1 17.6 12 17.6a9.3 9.3 0 0 0 3.1-.5"/><path d="M10.2 10.3a2.8 2.8 0 0 0 3.7 3.9"/>',
    check: '<path d="M5.4 12.6 9.8 17 18.6 7.6"/>',
    checkcircle: '<circle cx="12" cy="12" r="8.4"/><path d="M8.3 12.3 11 15l4.8-5.4"/>',
    circle: '<circle cx="12" cy="12" r="8.4"/>',
    shield: '<path d="M12 3.6 18.8 6v5.3c0 4.1-2.8 7.3-6.8 9-4-1.7-6.8-4.9-6.8-9V6z"/><path d="M9.2 12.1 11.3 14.3l3.9-4.3"/>',
    lock: '<rect x="5.4" y="10.4" width="13.2" height="9.6" rx="2.6"/><path d="M8.7 10.4V8.1a3.3 3.3 0 0 1 6.6 0v2.3"/>',
    sliders: '<path d="M4 8.4h8.6M17.4 8.4H20M4 15.6h4.6M13.4 15.6H20"/><circle cx="15" cy="8.4" r="2.1"/><circle cx="11" cy="15.6" r="2.1"/>',
    bolt: '<path d="M13.6 3 6.4 13.4h4.6L10.4 21l7.4-10.6h-4.6z"/>',
    chev: '<path d="M7.6 10.2 12 14.6l4.4-4.4"/>',
    ext: '<path d="M14.2 5.2h4.6v4.6M18.8 5.2 12 12"/><path d="M17.4 13.6v4.6a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 18.2V9.4a1.8 1.8 0 0 1 1.8-1.8h4.6"/>',
    plus: '<path d="M12 5.8v12.4M5.8 12h12.4"/>',
    arrow: '<path d="M5.4 12h12.6M13.2 7 18.2 12l-5 5"/>',
    arrowback: '<path d="M18.6 12H6M10.8 7 5.8 12l5 5"/>',
    calendar: '<rect x="3.6" y="6.4" width="12.4" height="13" rx="2.4"/><path d="M3.6 10.4h12.4M7.4 4.2v3.4M12.2 4.2v3.4"/><path d="M18.4 12.4a3.6 3.6 0 1 0 1.4 2.8M19.8 11.8v1.8H18"/>',
    flask: '<path d="M10 3.6h4M10.8 3.6v6L5.9 17.6A1.9 1.9 0 0 0 7.5 20.4h9a1.9 1.9 0 0 0 1.6-2.8L13.2 9.6v-6"/><path d="M8.3 14.8h7.4"/>',
    link: '<path d="M10.3 13.7a3.4 3.4 0 0 0 4.9 0l2.3-2.3a3.4 3.4 0 0 0-4.8-4.9l-1 1"/><path d="M13.7 10.3a3.4 3.4 0 0 0-4.9 0l-2.3 2.3a3.4 3.4 0 0 0 4.8 4.9l1-1"/>'
  };

  function aiIcon(name, cls) {
    return '<svg class="' + (cls || 'mcx-ai-ic') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (AI_ICONS[name] || '') + '</svg>';
  }

  function aiMode() { return localStorage.getItem('mc_ai_mode') === 'byo' ? 'byo' : 'cloud'; }

  function aiReady() {
    return !!(window.MCxAi && window.MCxAi.settingsLoaded && window.MCxAi.settingsLoaded());
  }

  function aiFieldVal(key) {
    if (!window.MCxAi || !aiReady()) return '';
    return String(window.MCxAi.getSetting(key) || '');
  }

  /* 密钥静置时不能留在页面 DOM 里：这座面板是 append 到 document.body 的，页面世界一条
     querySelector 就读得走，settings.css 那层 -webkit-text-security 只遮给人眼看的显示。
     所以格子里放的是固定十六个点的占位，点那颗眼睛或光标进框才从 MCxAi 现取真值填进去，
     离开时没人改过就换回点。 */
  var AI_KEY_MASK = '••••••••••••••••';

  function aiSecretStore(input) {
    var accId = input.getAttribute('data-acc-id');
    if (accId) {
      var list = window.MCxAi && window.MCxAi.profiles ? window.MCxAi.profiles() : [];
      var cur = list.filter(function (a) { return a.id === accId; })[0];
      return cur ? String(cur.key || '') : '';
    }
    return String(aiSlot(input.getAttribute('data-slot')).key || '');
  }

  function aiSecretFill(input) {
    var real = aiSecretStore(input);
    if (input.value === AI_KEY_MASK && real) input.value = real;
    return real;
  }

  function aiSecretRestore(input) {
    if (aiSecretStore(input)) input.value = AI_KEY_MASK;
  }

  /* Access code：用户手动填写的兑换码/密码，不再自动预设 MC8888 */
  function aiCode() {
    try { return String(window.MCxAi && window.MCxAi.cloudAccessCode ? window.MCxAi.cloudAccessCode() : '').trim(); } catch (e) { return ''; }
  }

  function aiCodeShown() { return ai.codeEdit ? ai.codeDraft : aiCode(); }

  function aiMask(code) {
    var c = String(code || '');
    if (!c) return 'No code entered';
    return c.slice(0, 2) + '••••';
  }

  /* 顶上那句错话只跟着"存码那一趟真失败"走。Access code 是可选的一档，
     只用 Google 登录、没填过码的人不该被说成码不对（没登录那一档由下面的登录卡自己说） */
  function aiCodeFailed() { return ai.codeState === 'bad'; }

  function aiProviders() {
    var list = (window.MCxAi && window.MCxAi.providers) || [];
    return list.map(function (pr) {
      var nm = String(pr.name || pr.id || '');
      var open = nm.indexOf('(');
      var close = nm.indexOf(')');
      return {
        id: String(pr.id || ''),
        name: String(pr.label || (open > 0 ? nm.slice(0, open) : nm)).trim(),
        desc: String(pr.desc || (open > 0 && close > open ? nm.slice(open + 1, close) : '')).trim(),
        keyUrl: String(pr.keyUrl || ''),
        base: String(pr.base || ''),
        defaultModel: String(pr.defaultModel || ''),
        models: Array.isArray(pr.models) ? pr.models : []
      };
    });
  }

  function aiProvider(id) {
    var list = aiProviders();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0] || { id: '', name: '', desc: '', keyUrl: '', base: '', defaultModel: '', models: [] };
  }

  /* ---- 两档（Advanced / Flash）在设置里的读数 ----
     名字和"这一档什么时候被用到"那两句只写在 ai-client.js 那一份表里，这里读它，不抄第二份 */
  function aiSlot(which) {
    var empty = { id: which, name: which, provider: '', base: '', key: '', model: '', filled: false };
    if (!window.MCxAi || !window.MCxAi.slot || !aiReady()) return empty;
    try { return Object.assign(empty, window.MCxAi.slot(which)); } catch (e) { return empty; }
  }

  function aiSlotName(which) {
    return (window.MCxAi && window.MCxAi.slotNames && window.MCxAi.slotNames[which]) || which;
  }

  function aiSlotUse(which) {
    return (window.MCxAi && window.MCxAi.slotUse && window.MCxAi.slotUse[which]) || '';
  }

  /* 下拉的 id 一律以档名结尾：model-advanced、provider-flash、cloud-model-flash。
     事件那一头只有这颗 id，靠这个约定反查它属于哪一档 */
  function aiSlotOf(ddId) {
    var s = String(ddId || '');
    return s.slice(s.lastIndexOf('-') + 1);
  }

  function aiProviderId(which) {
    return aiSlot(which).provider || 'openrouter';
  }

  function aiModelName(models, id) {
    for (var i = 0; i < (models || []).length; i++) {
      var m = models[i];
      var mid = typeof m === 'string' ? m : m.id;
      if (mid === id) return (typeof m === 'string' ? m : (m.name || m.id));
    }
    return '';
  }

  /* 云端那一串可选模型：地址从 MCxAi 要，不在这份文件里再抄一遍那个网址 */
  function aiCloudBase() {
    if (!window.MCxAi || !window.MCxAi.config) return '';
    try { return String(window.MCxAi.config('cloud').base || ''); } catch (e) { return ''; }
  }

  /* ---- 订阅这一层 ----
     档位、额度上限、两个价都写在这一个表里，别处不抄第二份。
     三个月那一个数是单独的价，不是月付乘 3（乘出来是 5.97 和 14.97，摆的就是比那个低）。
     这一版没有任何真的付款：那颗"换档"的键只把 mc_ai_plan 这一格改掉，
     不打开任何付款页、不联网问任何东西。额度那条读的是 ai-client 每走一次云端加一的计数。 */
  var AI_PLANS = [
    { id: 'free', name: 'Free', credits: 25, mo: 0, three: 0 },
    { id: 'plus', name: 'Plus', credits: 800, mo: 1.99, three: 5.49 },
    { id: 'pro', name: 'Pro', credits: 2000, mo: 4.99, three: 12.49 }
  ];

  // 从本地缓存立即恢复上次从 Supabase plan_configs 同步的点数总量，避免每次打开闪烁
  try {
    var rawPlanConfigs = localStorage.getItem('mc_ai_plan_configs_cache');
    if (rawPlanConfigs) {
      var cachedConfigs = JSON.parse(rawPlanConfigs);
      if (Array.isArray(cachedConfigs)) {
        cachedConfigs.forEach(function (r) {
          if (!r || !r.plan) return;
          for (var i = 0; i < AI_PLANS.length; i++) {
            if (AI_PLANS[i].id === r.plan && typeof r.total_credits === 'number' && r.total_credits > 0) {
              AI_PLANS[i].credits = r.total_credits;
            }
          }
        });
      }
    }
  } catch (e) {}

  function aiPlanOf(id) {
    for (var i = 0; i < AI_PLANS.length; i++) if (AI_PLANS[i].id === id) return AI_PLANS[i];
    return AI_PLANS[0];
  }

  function aiPlanTotal(id) {
    var pid = id || aiPlanId();
    if (pid === aiPlanId() && typeof aiServerCustomTotal === 'number' && aiServerCustomTotal > 0) {
      return aiServerCustomTotal;
    }
    return aiPlanOf(pid).credits;
  }

  var aiServerPlan = null;
  var aiDailyPool = { limit: 500, used: 0, left: 500, loaded: false };
  try {
    var rawPool = localStorage.getItem('mc_ai_daily_pool_cache');
    if (rawPool) {
      var parsedPool = JSON.parse(rawPool);
      if (parsedPool && typeof parsedPool.limit === 'number') {
        aiDailyPool.limit = parsedPool.limit;
        aiDailyPool.used = parsedPool.used || 0;
        aiDailyPool.left = typeof parsedPool.left === 'number' ? parsedPool.left : Math.max(0, parsedPool.limit - (parsedPool.used || 0));
        aiDailyPool.loaded = true;
      }
    }
  } catch (e) {}

  /* 档位只认后端的真实验证：未登录或后端没有 active 记录一律是 free，改本地 localStorage 没有任何用 */
  function aiPlanId() {
    if (!aiUserEmail()) return 'free';
    if (aiServerPlan) return aiServerPlan;
    return 'free';
  }

  function aiBilling() { return 'monthly'; }

  /* 这一份订阅的账都记在本机这三格里：档位、期长、什么时候开始。
     没有任何真的付款，所以"到期"只能按开始那一格加一期算出来；
     没存过开始时间（更早的构建留下的）就退到额度那一个 1 号，宁可说得粗，不许编一个日期 */
  function aiPlanTerm() {
    var t = localStorage.getItem('mc_ai_plan_term');
    return t === '3m' ? '3m' : 'monthly';
  }

  function aiPlanEnd() {
    var since = Number(localStorage.getItem('mc_ai_plan_since') || 0);
    var term = aiPlanTerm();
    if (since > 0) {
      var d = new Date(since);
      d.setMonth(d.getMonth() + (term === '3m' ? 3 : 1));
      return d;
    }
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  function aiDateLabel(d) {
    var s = '';
    try { s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { s = ''; }
    return s || 'the 1st';
  }

  function aiCancelled() {
    // 到期退回 Free 那一步在 aiPlanId() 里已经结清，这里只读那一格
    return aiPlanId() !== 'free' && localStorage.getItem('mc_ai_cancelled') === '1';
  }

  var aiServerUsed = 0;
  var aiServerCustomTotal = null;
  var aiServerResetText = '';

  function aiUsed() {
    if (!aiUserEmail()) return 0;
    return aiServerUsed;
  }

  function aiNum(n) { return Number(n).toLocaleString('en-US'); }

  function aiMoney(n) { return n % 1 ? n.toFixed(2) : String(Math.round(n)); }

  /* 额度重置日期：直接读取服务端计算的到期日，未激活时显示未开始 */
  function aiResetLabel() {
    if (!aiUserEmail()) return 'upon first use';
    return aiServerResetText || 'upon first use';
  }

  function aiCloudModels() {
    var base = aiCloudBase();
    if (!base || !window.MCxAi) return [{ id: '', name: 'Auto (recommended)' }];
    var list = window.MCxAi.modelsFor(base) || [];
    var out = [{ id: '', name: 'Auto (recommended)' }];
    list.forEach(function (m) {
      var mid = typeof m === 'string' ? m : m.id;
      if (!mid || mid === 'auto') return;
      out.push({ id: mid, name: typeof m === 'string' ? m : (m.name || m.id) });
    });
    return out;
  }

  /* 云端这一路的两档：地址和内测码共用，只有模型各挑各的 */
  function aiCloudModel(which) {
    return window.MCxAi && window.MCxAi.getCloudModel ? String(window.MCxAi.getCloudModel(which) || '') : '';
  }

  function aiCloudModelOpts(which) {
    var ddId = 'cloud-model-' + which;
    var cur = aiCloudModel(which);
    return modelSearchHtml(ddId) + aiCloudModels().map(function (m) {
      return aiDdOpt({ dd: ddId, v: m.id, name: m.name, sub: modelPrice(m), sel: m.id === cur });
    }).join('');
  }

  function aiCloudModelMenu(which) {
    var menu = aiDdMenu('cloud-model-' + which);
    if (!menu) return;
    menu.innerHTML = aiCloudModelOpts(which);
    // 这一趟是面板开着时才回来的：框里要是已经打过字，重画完得按同一套判据再筛一遍
    aiFilterModelMenu(menu, 'cloud-model-' + which);
  }

  /* 那一格现在收在"Have a test access code?"这一折里：只保留 Access Code 输入，去除模型选择 */
  function aiCodeFoldHtml() {
    return '<div class="mcx-ai-fold' + (ai.codeOpen ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-foldhead" data-ai-fold="code" aria-expanded="' + (ai.codeOpen ? 'true' : 'false') + '">' +
        aiIcon('flask', 'mcx-ai-foldic') + '<span>Have a test access code?</span>' + aiIcon('chev', 'mcx-ai-foldchev') +
      '</button>' +
      '<div class="mcx-ai-foldbody">' +
        '<div class="mcx-ai-field">' +
          '<div class="mcx-ai-label">Access Code</div>' +
          (ai.codeEdit ? aiCodeEdit() : aiCodeView()) +
        '</div>' +
        '<div class="mcx-ai-foot">' + aiIcon('shield') + '<span>Your requests are processed through Modern Canvas AI.</span></div>' +
      '</div>' +
    '</div>';
  }

  function aiCloudModelFieldHtml(which) {
    var cur = aiCloudModel(which);
    return '<div class="mcx-ai-field">' +
      '<div class="mcx-ai-label">' + esc(aiSlotName(which)) + ' Model</div>' +
      aiDd({ id: 'cloud-model-' + which, name: aiModelName(aiCloudModels(), cur) || 'Auto (recommended)', opts: aiCloudModelOpts(which) }) +
    '</div>';
  }

  function aiPlanCardHtml() {
    var logged = !!aiUserEmail();
    var cur = aiPlanId();
    var p = aiPlanOf(cur);
    var total = logged ? aiPlanTotal(cur) : p.credits;
    var left = logged ? Math.max(0, total - aiUsed()) : 0;
    var pct = (!logged || !total) ? 0 : Math.max(2, Math.min(100, Math.round(left / total * 100)));
    var poolLeft = aiDailyPool.left;
    var poolLimit = aiDailyPool.limit;
    var poolUsed = aiDailyPool.used;
    var poolPct = poolLimit > 0 ? Math.max(2, Math.min(100, Math.round(poolLeft / poolLimit * 100))) : 0;
    var isLow = logged && total > 0 && (left / total < 0.1);
    var upsell = '';
    if (logged && isLow) {
      if (p.id === 'free') {
        upsell = '<button type="button" class="mcx-ai-upsell" data-ai-plans="plus">' +
          aiIcon('bolt', 'mcx-ai-upsellic') +
          '<span class="mcx-ai-upsellbody"><span class="mcx-ai-upselltitle">Running low?</span>' +
          '<span class="mcx-ai-upsellsub">Get more credits with Plus.</span></span>' +
          aiIcon('arrow', 'mcx-ai-upsellgo') + '</button>';
      } else if (p.id === 'plus') {
        upsell = '<button type="button" class="mcx-ai-upsell is-plain" data-ai-plans="pro">' +
          '<span class="mcx-ai-upsellbody"><span class="mcx-ai-upselltitle">Need more credits? Explore Pro</span></span>' +
          aiIcon('arrow', 'mcx-ai-upsellgo') + '</button>';
      }
    }

    // 路由首选项：'plan' (默认：自身套餐高速通道，秒速回答) vs 'pool' (免费公共池优先，需等待30秒-3分钟)
    var routePref = 'plan';
    try { routePref = localStorage.getItem('mc_ai_routing_pref') || 'plan'; } catch (e) {}

    var routeToggleHtml = '';
    if (logged) {
      routeToggleHtml = '<div class="mcx-ai-route-pref" style="margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--mc-tint-press, rgba(255,255,255,0.08));">' +
        '<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px;">' +
          '<div>' +
            '<div style="font-size: 13.5px; font-weight: 600; color: var(--mc-text-0);">Speed & Routing</div>' +
            '<div style="font-size: 12px; color: var(--mc-text-1); margin-top: 1px;">' +
              (routePref === 'plan' ? 'Fast Gemini model using your plan quota' : 'Slower queue saving your monthly credits') +
            '</div>' +
          '</div>' +
          '<div class="mcx-prov-pills-wrap" style="flex: 0 0 auto;">' +
            '<button type="button" class="mcx-prov-pill' + (routePref === 'plan' ? ' is-active' : '') + '" data-ai-route-pref="plan">' +
              'Instant' +
            '</button>' +
            '<button type="button" class="mcx-prov-pill' + (routePref === 'pool' ? ' is-active' : '') + '" data-ai-route-pref="pool">' +
              'Free Pool' +
            '</button>' +
          '</div>' +
        '</div>' +
        (routePref === 'pool'
          ? '<div class="mcx-ai-foot" style="margin-top: 6px; font-size: 11.5px; color: var(--mc-text-1); line-height: 1.4;">' +
              aiIcon('clock') + '<span>Free pool preserves your credits, but responses may take 30s – 3m. Falls back to your plan if empty.</span>' +
            '</div>'
          : '') +
      '</div>';
    }

    return '<div class="mcx-ai-plan' + (logged ? '' : ' is-unlogged') + '">' +
      '<div class="mcx-ai-planhead">' +
        '<div class="mcx-ai-plantext">' +
          '<div class="mcx-ai-eyebrow">Your plan</div>' +
          '<div class="mcx-ai-planname">' + (logged ? esc(p.name) : 'To use') + '</div>' +
        '</div>' +
        '<button type="button" class="' + (p.id === 'free' ? 'mcx-ai-solid' : 'mcx-ai-chip') + '" data-ai-plans="' +
          (p.id === 'free' ? 'plus' : p.id) + '">' +
          '<span>' + (p.id === 'free' ? 'Upgrade' : 'Manage plan') + '</span>' +
          (p.id === 'free' ? aiIcon('ext', 'mcx-ai-chipic') : '') +
        '</button>' +
      '</div>' +
      '<div class="mcx-ai-credrow"><span class="mcx-ai-credlabel">Personal Monthly Credits</span>' +
        '<span class="mcx-ai-crednum">' + (logged ? aiNum(left) : '0') +
        '<span class="mcx-ai-credtot"> / ' + aiNum(total) + (logged ? ' left' : ' (Sign in to use)') + '</span></span></div>' +
      '<div class="mcx-ai-bar"><span class="mcx-ai-bar-fill" style="width:' + pct + '%"></span></div>' +
      '<div class="mcx-ai-barfoot"><span>Monthly quota</span>' +
        '<span class="mcx-ai-reset">' + (logged ? 'Resets ' + esc(aiResetLabel()) : 'Sign in to activate') + '</span></div>' +
      '<div class="mcx-ai-credrow" style="margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);"><span class="mcx-ai-credlabel">Community Free Pool (All Users)</span>' +
        '<span class="mcx-ai-crednum">' + aiNum(poolLeft) +
        '<span class="mcx-ai-credtot"> / ' + aiNum(poolLimit) + ' left today</span></span></div>' +
      '<div class="mcx-ai-bar"><span class="mcx-ai-bar-fill" style="width:' + poolPct + '%; background: linear-gradient(90deg, #38bdf8, #818cf8);"></span></div>' +
      '<div class="mcx-ai-barfoot"><span>' + aiNum(poolUsed) + ' used by community today</span>' +
        '<span class="mcx-ai-reset">Resets daily (00:00 PT)</span></div>' +
      routeToggleHtml +
      upsell +
    '</div>';
  }

  /* 整张卡都是挑这一档的入口：点圆圈、点空白、点底下那颗键，都是同一件事。
     底下那颗键只是把"这一档现在是不是你挑中的"说出来，不是唯一能按的地方 */
  function aiPickCardHtml(p, bill, chosen) {
    var price = bill === '3m' ? p.three : p.mo;
    return '<div class="mcx-ai-pcard' + (chosen ? ' is-sel' : '') + '" data-ai-pick="' + esc(p.id) + '"' +
      ' role="button" tabindex="0" aria-pressed="' + (chosen ? 'true' : 'false') + '">' +
      '<div class="mcx-ai-pcardhead"><span class="mcx-ai-pname">' + esc(p.name) + '</span>' +
        (chosen ? aiIcon('checkcircle', 'mcx-ai-ptick') : aiIcon('circle', 'mcx-ai-pblank')) + '</div>' +
      '<div class="mcx-ai-price">$' + aiMoney(price) + '<span class="mcx-ai-unit">' + (bill === '3m' ? '/3 mo' : '/mo') + '</span></div>' +
      '<div class="mcx-ai-pcredits">' + aiNum(p.credits) + ' credits</div>' +
      '<div class="mcx-ai-per">' + (bill === '3m' ? 'billed every 3 months' : 'per month') + '</div>' +
      '<span class="' + (chosen ? 'mcx-ai-solid is-on' : 'mcx-ai-chip') + '"><span>' + (chosen ? 'Selected' : 'Select plan') + '</span></span>' +
    '</div>';
  }

  /* 已经取消、但这一期还没走完：那一张卡说的是"什么时候停"，那颗键说的是"接着用" */
  function aiRenewalCardHtml(p) {
    return '<div class="mcx-ai-renew">' +
      '<div class="mcx-ai-renewrow">' + aiIcon('calendar', 'mcx-ai-renewic') +
        '<div class="mcx-ai-renewbody"><div class="mcx-ai-renewtitle">Renewal cancelled</div>' +
        '<div class="mcx-ai-renewsub">Your ' + esc(p.name) + ' access ends ' + esc(aiDateLabel(aiPlanEnd())) + '.</div></div>' +
      '</div>' +
      '<button type="button" class="mcx-ai-dark" data-ai-resume><span>Resume subscription</span></button>' +
    '</div>';
  }

  /* 挑档／管档是同一屏：没付过就是"挑一份"，已经有一份就是"这一份怎么管" */
  function aiPickerHtml() {
    var logged = !!aiUserEmail();
    var bill = aiBilling();
    var cur = aiPlanId();
    var paid = cur !== 'free';
    var chosen = aiPlanOf(ai.pickId || (paid ? cur : 'plus')).id;
    var target = aiPlanOf(chosen);
    var cta = !logged ? 'Sign in with Google to purchase'
      : (!paid ? 'Upgrade to ' + target.name
      : (chosen !== cur ? 'Switch to ' + target.name : 'Manage via Dodo Portal'));
    return '<div class="mcx-ai-picktop">' +
        '<button type="button" class="mcx-ai-back" data-ai-plans="back">' + aiIcon('arrowback') + '<span>Back to my plan</span></button>' +
      '</div>' +
      (paid ? '<div class="mcx-ai-now">' +
        '<div class="mcx-ai-nowleft"><span class="mcx-ai-eyebrow">Current plan</span>' +
          '<span class="mcx-ai-nowname">' + esc(aiPlanOf(cur).name) + ' · Active</span></div>' +
        '<a href="https://customer.dodopayments.com" target="_blank" class="mcx-ai-chip" style="text-decoration:none;">' +
          aiIcon('ext', 'mcx-ai-chipic') + '<span>Manage billing</span></a>' +
      '</div>' : '') +
      '<div class="mcx-ai-picktitle">Choose your plan</div>' +
      '<div class="mcx-ai-picksub">More credits whenever you need them.</div>' +
      '<div class="mcx-ai-pcards">' +
        aiPickCardHtml(aiPlanOf('plus'), bill, chosen === 'plus') +
        aiPickCardHtml(aiPlanOf('pro'), bill, chosen === 'pro') +
      '</div>' +
      '<button type="button" class="mcx-ai-dark" data-ai-activate><span>' + esc(cta) + '</span>' +
        (!logged ? aiIcon('google', 'mcx-ai-actic') : (chosen === cur && paid ? aiIcon('ext', 'mcx-ai-actic') : aiIcon('arrow', 'mcx-ai-actic'))) + '</button>' +
      '<div class="mcx-ai-picknote">' + (!logged
        ? 'Please link your Google account so your subscription and credits can sync with your profile.'
        : (!paid || chosen !== cur
          ? 'Click to open secure checkout via Dodo Payments. Your plan activates automatically once payment completes.'
          : 'To cancel, update payment method, or download invoices, visit the official Dodo Customer Portal or use the link in your receipt email.')) + '</div>';
  }

  /* ---- 账号绑定这一层（Supabase 登录 & 邮箱验证码） ---- */
  var SB_URL = 'https://bmtxbdeoxtgmgejtayge.supabase.co';
  var SB_ANON = 'sb_publishable_fz4rl63DSNyZCWWlCU8fLQ_HsZjIB86';

  var DODO_CHECKOUT = {
    pro: 'https://checkout.dodopayments.com/buy/pdt_0NpeJuOhBADLgFxa0GM91?quantity=1',
    plus: 'https://checkout.dodopayments.com/buy/pdt_0NpeJjLz1ikk2WYjUcGTd?quantity=1'
  };

  function aiUserEmail() {
    try { return String(window.MCxAi && window.MCxAi.cloudAuth ? window.MCxAi.cloudAuth().email || '' : '').trim(); } catch (e) { return ''; }
  }

  function aiUserToken() {
    try { return String(window.MCxAi && window.MCxAi.cloudAuth ? window.MCxAi.cloudAuth().token || '' : '').trim(); } catch (e) { return ''; }
  }

  function aiSendOtp(email) {
    if (!email || email.indexOf('@') < 0) {
      ai.authMsg = 'Enter a valid email address.';
      ai.authMsgType = 'bad';
      aiRepaint();
      return;
    }
    ai.authLoading = true;
    ai.authMsg = 'Sending code...';
    ai.authMsgType = 'info';
    aiRepaint();

    fetch(SB_URL + '/auth/v1/otp', {
      method: 'POST',
      headers: {
        'apikey': SB_ANON,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: email })
    }).then(function (res) {
      return res.json().then(function (data) {
        ai.authLoading = false;
        if (!res.ok) {
          ai.authMsg = data.msg || data.error_description || 'Failed to send code. Please try again.';
          ai.authMsgType = 'bad';
        } else {
          ai.authStep = 'verify';
          ai.authMsg = 'Check your inbox for a 6-digit code.';
          ai.authMsgType = 'ok';
          ai.authCountDown = 60;
          var timer = setInterval(function () {
            ai.authCountDown--;
            if (ai.authCountDown <= 0) {
              clearInterval(timer);
              ai.authCountDown = 0;
            }
            // 局部更新倒计时按钮文字，不打扰验证码输入框输入
            var resendBtn = p && p.overlay ? p.overlay.querySelector('[data-ai-auth="resend-otp"]') : null;
            if (resendBtn) {
              resendBtn.disabled = ai.authCountDown > 0;
              resendBtn.textContent = ai.authCountDown > 0 ? ai.authCountDown + 's' : 'Resend';
            }
          }, 1000);
        }
        aiRepaint();
      });
    }).catch(function (err) {
      ai.authLoading = false;
      ai.authMsg = 'We could not connect. Check your internet connection and try again.';
      ai.authMsgType = 'bad';
      aiRepaint();
    });
  }

  function aiVerifyOtp(email, token) {
    if (!token || token.length < 6) {
      ai.authMsg = 'Enter the 6-digit code.';
      ai.authMsgType = 'bad';
      aiRepaint();
      return;
    }
    ai.authLoading = true;
    ai.authMsg = 'Checking code...';
    ai.authMsgType = 'info';
    aiRepaint();

    fetch(SB_URL + '/auth/v1/verify', {
      method: 'POST',
      headers: {
        'apikey': SB_ANON,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email,
        token: token,
        type: 'email'
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        ai.authLoading = false;
        if (!res.ok) {
          ai.authMsg = data.msg || data.error_description || 'That code is invalid or expired. Request a new one and try again.';
          ai.authMsgType = 'bad';
          aiRepaint();
        } else {
          var access_token = data.access_token || (data.session && data.session.access_token) || '';
          var user_id = (data.user && data.user.id) || '';
          if (!window.MCxAi || !window.MCxAi.setCloudAuth) {
            ai.authMsg = 'Modern Canvas could not save your sign-in. Reload the page and try again.';
            ai.authMsgType = 'bad';
            aiRepaint();
            return;
          }
          window.MCxAi.setCloudAuth({ email: email, token: access_token, userId: user_id }).then(function (saved) {
            if (!saved || !saved.ok) {
              ai.authMsg = 'Modern Canvas could not save your sign-in. Reload the page and try again.';
              ai.authMsgType = 'bad';
              aiRepaint();
              return;
            }
            ai.authStep = 'input';
            ai.authCodeInput = '';
            ai.authMsg = '';
            ai.authMsgType = '';
            aiFetchUserPlan(email);
            aiRepaint();
          });
        }
      });
    }).catch(function () {
      ai.authLoading = false;
      ai.authMsg = 'We could not verify the code. Check your internet connection and try again.';
      ai.authMsgType = 'bad';
      aiRepaint();
    });
  }

  var aiPlanPollTimer = null;

  function aiStartPlanPolling(maxSeconds) {
    aiStopPlanPolling();
    var deadline = Date.now() + (maxSeconds || 180) * 1000;
    aiPlanPollTimer = setInterval(function () {
      // 只要设置窗口依然打开且未超时，每 2 秒向后端查询一次是否已成为 Pro/Plus
      var overlay = document.querySelector('.mcx-settings-overlay') || document.querySelector('[data-ai-pane]');
      if (!overlay || Date.now() > deadline) {
        aiStopPlanPolling();
        return;
      }
      aiFetchUserPlan();
      // 一旦后端已经确认为 plus 或 pro，成功激活后停止轮询
      if (aiServerPlan === 'plus' || aiServerPlan === 'pro') {
        aiStopPlanPolling();
      }
    }, 2000);
  }

  function aiStopPlanPolling() {
    if (aiPlanPollTimer) {
      clearInterval(aiPlanPollTimer);
      aiPlanPollTimer = null;
    }
  }

  function aiFetchPlanConfigs() {
    return fetch(SB_URL + '/rest/v1/plan_configs?select=plan,total_credits', {
      headers: {
        'apikey': SB_ANON,
        'Authorization': 'Bearer ' + SB_ANON
      }
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (rows) {
      if (Array.isArray(rows) && rows.length) {
        var changed = false;
        rows.forEach(function (r) {
          if (!r || !r.plan) return;
          var item = aiPlanOf(r.plan);
          if (item && typeof r.total_credits === 'number' && r.total_credits > 0 && item.credits !== r.total_credits) {
            item.credits = r.total_credits;
            changed = true;
          }
        });
        try { localStorage.setItem('mc_ai_plan_configs_cache', JSON.stringify(rows)); } catch (e) {}
        if (changed) aiRepaint();
      }
    }).catch(function () {});
  }

  function aiFetchDailyPool() {
    return fetch(SB_URL + '/rest/v1/rpc/get_daily_pool_status', {
      method: 'POST',
      headers: {
        'apikey': SB_ANON,
        'Authorization': 'Bearer ' + SB_ANON,
        'Content-Type': 'application/json'
      },
      body: '{}'
    }).then(function (res) {
      if (!res.ok) {
        return fetch(SB_URL + '/rest/v1/daily_pool_config?id=eq.global&select=pool_limit,pool_used', {
          headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON }
        }).then(function (r) { return r.json(); }).then(function (rows) {
          if (Array.isArray(rows) && rows[0]) {
            return {
              pool_limit: rows[0].pool_limit,
              pool_used: rows[0].pool_used,
              pool_left: Math.max(0, rows[0].pool_limit - rows[0].pool_used)
            };
          }
          return null;
        });
      }
      return res.json();
    }).then(function (data) {
      if (data && typeof data.pool_limit === 'number') {
        var changed = (aiDailyPool.limit !== data.pool_limit || aiDailyPool.used !== data.pool_used);
        aiDailyPool.limit = data.pool_limit;
        aiDailyPool.used = data.pool_used || 0;
        aiDailyPool.left = typeof data.pool_left === 'number' ? data.pool_left : Math.max(0, data.pool_limit - (data.pool_used || 0));
        aiDailyPool.loaded = true;
        try { localStorage.setItem('mc_ai_daily_pool_cache', JSON.stringify(aiDailyPool)); } catch (e) {}
        if (changed) aiRepaint();
      }
    }).catch(function () {});
  }

  function aiFetchUserPlan(email) {
    var mail = String(email || aiUserEmail()).trim().toLowerCase();
    if (!mail) {
      aiServerPlan = 'free';
      aiServerUsed = 0;
      aiServerCustomTotal = null;
      aiServerResetText = 'upon first use';
      try { localStorage.removeItem('mc_ai_plan'); } catch (e) {}
      return;
    }
    var token = aiUserToken();
    var doFetch = function (authToken, withTotal) {
      var cols = withTotal ? 'plan,status,used_credits,total_credits,resets_at' : 'plan,status,used_credits,resets_at';
      return fetch(SB_URL + '/rest/v1/user_plans?user_email=eq.' + encodeURIComponent(mail) + '&select=' + cols, {
        headers: {
          'apikey': SB_ANON,
          'Authorization': 'Bearer ' + (authToken || SB_ANON)
        }
      });
    };

    var execute = function (authToken) {
      return doFetch(authToken, true).then(function (res) {
        if (!res.ok && res.status === 400) {
          // 兼容旧表结构（若用户尚未在 Supabase 添加 total_credits 列，自动回退到常规列读取）
          return doFetch(authToken, false).then(function (r) { return r.json(); });
        }
        return res.json();
      });
    };

    (token ? execute(token) : execute(SB_ANON)).then(function (rows) {
      if ((!Array.isArray(rows) || !rows.length) && token) {
        // 如果用户的 Token 已过期或未匹配，自动使用 SB_ANON 再次尝试读取公开订阅状态
        return execute(SB_ANON);
      }
      return rows;
    }).then(function (rows) {
      if (Array.isArray(rows) && rows.length && rows[0].status === 'active') {
        var p = (rows[0].plan || 'free').toLowerCase();
        aiServerPlan = (p === 'plus' || p === 'pro') ? p : 'free';
        aiServerUsed = typeof rows[0].used_credits === 'number' ? rows[0].used_credits : 0;
        aiServerCustomTotal = (typeof rows[0].total_credits === 'number' && rows[0].total_credits > 0) ? rows[0].total_credits : null;
        if (rows[0].resets_at) {
          try {
            var d = new Date(rows[0].resets_at);
            aiServerResetText = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          } catch (e) {
            aiServerResetText = 'upon first use';
          }
        } else {
          aiServerResetText = 'upon first use';
        }
        localStorage.setItem('mc_ai_plan', aiServerPlan);
      } else {
        aiServerPlan = 'free';
        aiServerUsed = 0;
        aiServerCustomTotal = null;
        aiServerResetText = 'upon first use';
        localStorage.setItem('mc_ai_plan', 'free');
      }
      aiRepaint();
    }).catch(function () {});
  }

  function aiHandleAuthToken(token, callback) {
    if (!token) {
      if (typeof callback === 'function') callback(new Error('No token provided'));
      return;
    }
    fetch(SB_URL + '/auth/v1/user', {
      headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + token }
    }).then(function (res) { return res.json(); }).then(function (u) {
      if (u && u.email) {
        if (!window.MCxAi || !window.MCxAi.setCloudAuth) throw new Error('Modern Canvas could not save your sign-in.');
        return window.MCxAi.setCloudAuth({ email: u.email, token: token, userId: u.id || '' }).then(function (saved) {
          if (!saved || !saved.ok) throw new Error('Modern Canvas could not save your sign-in.');
          ai.authStep = 'input';
          ai.authMsg = '';
          ai.authMsgType = '';
          aiFetchUserPlan(u.email);
          if (typeof callback === 'function') callback(null, u);
          try { document.dispatchEvent(new CustomEvent('mcx-ai-login-success', { detail: { user: u } })); } catch (_) {}
          ai.authLoading = false;
          aiRepaint();
        });
      } else {
        var err = new Error('Could not get user email.');
        if (typeof callback === 'function') callback(err);
        try { document.dispatchEvent(new CustomEvent('mcx-ai-login-failed', { detail: { error: err.message } })); } catch (_) {}
      }
      ai.authLoading = false;
      aiRepaint();
    }).catch(function (e) {
      ai.authLoading = false;
      ai.authMsg = (e && e.message) || 'We could not finish signing you in. Try again.';
      ai.authMsgType = 'bad';
      aiRepaint();
      if (typeof callback === 'function') callback(e);
      try { document.dispatchEvent(new CustomEvent('mcx-ai-login-failed', { detail: { error: ai.authMsg } })); } catch (_) {}
    });
  }

  function aiLoginGoogle(callback) {
    ai.authLoading = true;
    ai.authMsg = 'Opening Google sign-in...';
    ai.authMsgType = 'info';
    aiRepaint();

    var extensionRedirectUrl = 'https://' + chrome.runtime.id + '.chromiumapp.org/';
    var authUrl = SB_URL + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(extensionRedirectUrl) + '&prompt=select_account';

    // 优先使用 Chrome 扩展的原生 launchWebAuthFlow（全自动弹窗与回调捕获）
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'mc_oauth_google', authUrl: authUrl }, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok) {
          ai.authLoading = false;
          var rawErr = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'User cancelled';
          var isCancel = (rawErr === 'User cancelled' || rawErr.indexOf('cancelled') >= 0 || rawErr.indexOf('canceled') >= 0);
          // Chrome 的 identity API 会把重复发起授权报成 "Only one web auth flow..."。
          // 这是浏览器内部实现细节；用户真正需要知道的是已有登录窗口仍在等待处理。
          var hasExistingAuthWindow = /only one web auth flow is allowed at a time/i.test(rawErr);
          ai.authMsg = isCancel
            ? 'User cancelled sign-in.'
            : hasExistingAuthWindow
              ? 'A Google sign-in window is already open. Finish signing in there, or close it and try again.'
              : rawErr;
          ai.authMsgType = 'bad';
          aiRepaint();
          var err = new Error(ai.authMsg);
          err.code = isCancel ? 'cancelled' : 'auth_failed';
          if (typeof callback === 'function') callback(err);
          try { document.dispatchEvent(new CustomEvent('mcx-ai-login-failed', { detail: { error: ai.authMsg, cancelled: isCancel } })); } catch (_) {}
          return;
        }
        var redUrl = res.redirectUrl || '';
        var hash = '';
        if (redUrl.indexOf('#') >= 0) hash = redUrl.split('#')[1];
        else if (redUrl.indexOf('?') >= 0) hash = redUrl.split('?')[1];
        var params = new URLSearchParams(hash);
        var token = params.get('access_token');
        if (token) {
          aiHandleAuthToken(token, callback);
        } else {
          ai.authLoading = false;
          ai.authMsg = 'Google sign-in did not finish. Close the sign-in window and try again.';
          ai.authMsgType = 'bad';
          aiRepaint();
          var err2 = new Error(ai.authMsg);
          if (typeof callback === 'function') callback(err2);
          try { document.dispatchEvent(new CustomEvent('mcx-ai-login-failed', { detail: { error: ai.authMsg } })); } catch (_) {}
        }
      });
      return;
    }

    // 兜底 window.open
    var w = 500, h = 600;
    var left = (window.screen.width - w) / 2;
    var top = (window.screen.height - h) / 2;
    var pop = window.open(authUrl, 'ModernCanvasGoogleAuth', 'width=' + w + ',height=' + h + ',top=' + top + ',left=' + left);
    var pollTimer = setInterval(function () {
      if (!pop || pop.closed) {
        clearInterval(pollTimer);
        ai.authLoading = false;
        aiRepaint();
        return;
      }
      try {
        var href = pop.location.href;
        if (href && (href.indexOf('access_token=') >= 0 || href.indexOf('#access_token=') >= 0)) {
          var hash2 = pop.location.hash ? pop.location.hash.slice(1) : pop.location.search;
          var token2 = new URLSearchParams(hash2).get('access_token');
          if (token2) {
            clearInterval(pollTimer);
            pop.close();
            aiHandleAuthToken(token2);
          }
        }
      } catch (e) {}
    }, 500);
  }

  function aiBindAiHooks() {
    if (window.MCxAi) {
      window.MCxAi.loginWithGoogle = aiLoginGoogle;
      window.MCxAi.isUserLoggedIn = function () { return !!aiUserEmail(); };
    }
  }
  aiBindAiHooks();
  setTimeout(aiBindAiHooks, 50);
  setTimeout(aiBindAiHooks, 300);
  setTimeout(aiBindAiHooks, 1000);

  function aiLogout() {
    try { if (window.MCxAi && window.MCxAi.clearCloudAuth) window.MCxAi.clearCloudAuth(); } catch (e) {}
    ai.authStep = 'input';
    ai.authEmailInput = '';
    ai.authCodeInput = '';
    ai.authMsg = '';
    ai.authMsgType = '';
    aiRepaint();
  }

  function aiAuthCardHtml() {
    var email = aiUserEmail();
    var isLogged = !!email;

    if (isLogged) {
      return '<div class="mcx-ai-authcard is-logged">' +
        '<div class="mcx-ai-authrow">' +
          '<div class="mcx-ai-authleft">' +
            '<button type="button" class="mcx-ai-authavatar" data-ai-auth="google" title="Switch Google account">' + aiIcon('google') + '</button>' +
            '<div class="mcx-ai-authinfo">' +
              '<div class="mcx-ai-authlabel">Connected Account</div>' +
              '<div class="mcx-ai-authemail" title="' + esc(email) + '">' + esc(email) + '</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="mcx-ai-authlogout" data-ai-auth="logout" title="Sign out">' +
            aiIcon('logout') + '<span>Sign out</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    var msgHtml = '';
    if (ai.authMsg) {
      var cls = ai.authMsgType === 'ok' ? 'is-ok' : (ai.authMsgType === 'info' ? 'is-info' : 'is-bad');
      msgHtml = '<div class="mcx-ai-authmsg ' + cls + '">' + esc(ai.authMsg) + '</div>';
    }

    return '<div class="mcx-ai-authcard">' +
      '<div class="mcx-ai-authhead">' +
        '<div class="mcx-ai-authheadic">' + aiIcon('user') + '</div>' +
        '<div class="mcx-ai-authheadtext">' +
          '<div class="mcx-ai-authtitle">Sign in to use Canvas-integrated AI for FREE*</div>' +
          '<div class="mcx-ai-authsub">*Each account gets ' + aiPlanTotal('free') + ' credits monthly, and ' + aiNum(aiDailyPool.limit || 500) + ' pool credits daily for all users.</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="mcx-ai-google-btn" data-ai-auth="google"' + (ai.authLoading ? ' disabled' : '') + '>' +
        aiIcon('google') + '<span>' + (ai.authLoading ? 'Connecting...' : 'Continue with Google') + '</span>' +
      '</button>' +
      msgHtml +
    '</div>';
  }

  function aiCloudPanelHtml() {
    var failed = aiCodeFailed();
    return '<section class="mcx-ai-panel mcx-ai-panel-cloud">' +
      aiHead('Modern Canvas AI',
        failed ? 'That code did not answer. Change it and save it again.' : '', '') +
      aiAuthCardHtml() +
      (ai.picker ? aiPickerHtml() : aiPlanCardHtml() + aiCodeFoldHtml()) +
    '</section>';
  }

  /* ---- 自绘下拉：一颗触发键 + 贴着它开的那一列 ---- */
  function aiDdOpt(o) {
    return '<div class="mcx-dd-opt' + (o.sel ? ' is-sel' : '') + (o.cls ? ' ' + o.cls : '') + '" role="option"' +
      (o.sel ? ' aria-selected="true"' : '') + ' data-dd-opt="' + esc(o.dd) + '" data-value="' + esc(o.v) + '">' +
      (o.mark ? '<span class="mcx-dd-mark">' + esc(o.mark) + '</span>' : '') +
      '<span class="mcx-dd-body"><span class="mcx-dd-name">' + esc(o.name) + '</span>' +
      (o.sub ? '<span class="mcx-dd-sub">' + esc(o.sub) + '</span>' : '') + '</span>' +
      (o.sel ? aiIcon('check', 'mcx-dd-tick') : '') +
      '</div>';
  }

  function aiDd(o) {
    return '<div class="mcx-dd" data-dd="' + esc(o.id) + '">' +
      '<button type="button" class="mcx-dd-trigger" data-dd-toggle="' + esc(o.id) + '" aria-haspopup="listbox" aria-expanded="false">' +
        (o.mark ? '<span class="mcx-dd-mark">' + esc(o.mark) + '</span>' : '') +
        '<span class="mcx-dd-body"><span class="mcx-dd-name' + (o.name ? '' : ' is-empty') + '">' + esc(o.name || o.placeholder) + '</span>' +
        (o.sub ? '<span class="mcx-dd-sub">' + esc(o.sub) + '</span>' : '') + '</span>' +
        aiIcon('chev', 'mcx-dd-chev') +
      '</button>' +
      '<div class="mcx-dd-menu" role="listbox">' + (o.opts || '') + '</div>' +
    '</div>';
  }

  function aiHead(title, sub, side) {
    return '<div class="mcx-ai-head">' +
      '<div class="mcx-ai-headtext"><div class="mcx-ai-h1">' + esc(title) + '</div>' +
      (sub ? '<div class="mcx-ai-sub">' + esc(sub) + '</div>' : '') + '</div>' +
      (side ? '<div class="mcx-ai-headside">' + side + '</div>' : '') + '</div>';
  }

  function aiChoiceCard(id, icon, title, sel) {
    /* 两张板都带着勾，没选中的那颗只是看不见：换路时它淡下去、另一颗淡上来，
       而不是从这块板上消失再在那块上凭空长出来 */
    return '<button type="button" class="mcx-ai-card' + (sel ? ' is-active' : '') + '" data-ai-tab="' + id + '"' +
      ' aria-pressed="' + (sel ? 'true' : 'false') + '">' +
      '<span class="mcx-ai-cardicon">' + aiIcon(icon) + '</span>' +
      '<span class="mcx-ai-cardtitle">' + esc(title) + '</span>' +
      '<span class="mcx-ai-cardtick">' + aiIcon('checkcircle') + '</span>' +
    '</button>';
  }

  function aiChoiceHtml() {
    var mode = aiMode();
    return '<div class="mcx-ai-choice">' +
      aiChoiceCard('cloud', 'spark', 'Modern Canvas AI', mode === 'cloud') +
      aiChoiceCard('byo', 'key', 'Use Your Own Key', mode === 'byo') +
    '</div>';
  }

  function aiCodeView() {
    return '<div class="mcx-ai-inline">' +
      '<div class="mcx-ai-static">' + esc(aiMask(aiCode())) + '</div>' +
      '<button type="button" class="mcx-ai-ghost" data-ai-code="edit">Change</button>' +
    '</div>';
  }

  function aiCodeEdit() {
    return '<div class="mcx-ai-inline">' +
      '<input type="text" class="mcx-ai-input" data-ai-code-input value="' + esc(aiCodeShown()) + '"' +
        ' placeholder="Your access code" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="mcx-ai-ghost" data-ai-code="save">Save</button>' +
      '<button type="button" class="mcx-ai-quiet" data-ai-code="cancel">Cancel</button>' +
    '</div>' +
    '<div class="mcx-ai-bad" data-ai-code-msg' + (ai.codeMsg ? '' : ' hidden') + '>' + esc(ai.codeMsg) + '</div>';
  }

  /* 筛这一件事只有 aiFilterModelMenu 一个落点：重画菜单时也只挂 is-off，不把行从 DOM 里摘掉。
     一旦在重画时摘过，那份 DOM 就永久少了行，之后清空搜索框也回不到全量（二次筛选）。 */
  function aiByoModelOpts(pr, ddId, which) {
    var cur = aiSlot(which).model;
    var remote = ai.remoteModels[ddId];
    var list = remote && remote.provider === pr.id ? remote.list : pr.models;
    var query = String(ai.modelQuery[ddId] || '').trim().toLowerCase();
    var html = '';
    var hits = 0;
    (list || []).forEach(function (m) {
      var mid = typeof m === 'string' ? m : m.id;
      var name = typeof m === 'string' ? m : (m.name || m.id);
      if (!mid) return;
      var off = !!query && String(mid).toLowerCase().indexOf(query) < 0 && String(name).toLowerCase().indexOf(query) < 0;
      if (!off) hits++;
      html += aiDdOpt({ dd: ddId, v: mid, name: name, sub: modelPrice(m), sel: mid === cur, cls: off ? 'is-off' : '' });
    });
    if (!hits) html += '<div class="mcx-dd-empty">' + (query ? 'No models match this search.' : 'This address has no preset list. Type the model name.') + '</div>';
    if (remote && remote.provider === pr.id) {
      html += aiDdOpt({ dd: ddId, v: '__short__', name: 'Back to the short list', cls: 'mcx-dd-act' });
    } else if (aiReady() && aiSlot(which).key) {
      html += aiDdOpt({ dd: ddId, v: '__browse__', name: 'Show every model this key allows', cls: 'mcx-dd-act' });
    }
    html += aiDdOpt({ dd: ddId, v: '__manual__', name: 'Type a model name', cls: 'mcx-dd-act' });
    return html;
  }

  function modelPrice(model) {
    var p = model && typeof model === 'object' ? model.pricing : null;
    if (!p) return '';
    function perMillion(v) {
      var n = Number(v);
      return isFinite(n) && n >= 0 ? (n * 1000000).toFixed(n * 1000000 < 0.01 ? 4 : 2) : '';
    }
    var inPrice = perMillion(p.prompt || p.input);
    var outPrice = perMillion(p.completion || p.output);
    if (!inPrice && !outPrice) return '';
    return '$' + (inPrice || '0') + ' in / $' + (outPrice || '0') + ' out per 1M tokens';
  }

  function modelSearchHtml(ddId) {
    return '<input type="text" class="mcx-dd-search" data-model-search="' + esc(ddId) + '" value="' + esc(ai.modelQuery[ddId] || '') + '"' +
      ' placeholder="Search models" aria-label="Search models" autocomplete="off" spellcheck="false">';
  }

  /* 菜单每一趟重画都从这一份走：少带一次那颗框，那一屏就变成"没有搜索框" */
  function aiModelMenuHtml(pr, ddId, which) {
    return modelSearchHtml(ddId) + aiByoModelOpts(pr, ddId, which);
  }

  function aiByoModelHtml(pr, which) {
    var ddId = 'model-' + which;
    var cur = aiSlot(which).model;
    if (ai.modelManual[ddId] || !pr.models.length) {
      return '<div class="mcx-ai-inline">' +
        '<div class="mcx-ai-platewrap mcx-ai-grow">' +
          '<input type="text" class="mcx-ai-input" data-ai-field="model" data-slot="' + which + '" value="' + esc(cur) + '"' +
            ' placeholder="' + esc(aiReady() ? 'The name this provider uses' : 'Loading AI settings...') + '"' +
            (aiReady() ? '' : ' disabled') + ' autocomplete="off" spellcheck="false">' +
        '</div>' +
        (pr.models.length ? '<button type="button" class="mcx-ai-quiet" data-ai-model="list" data-slot="' + which + '">From list</button>' : '') +
      '</div>';
    }
    return aiDd({
      id: ddId,
      name: aiModelName(pr.models, cur) || cur,
      placeholder: 'Select a model',
      opts: aiModelMenuHtml(pr, ddId, which)
    });
  }

  /* 一档一块：名字、这一档什么时候被用到、Test 那颗，然后是它自己的一套 provider／钥匙／模型。
     两块之间只用间距分开，不描边、不加色条——同一座面板里零分隔线的口径。 */
  function aiByoSlotHtml(which) {
    var s = aiSlot(which);
    var pr = aiProvider(aiProviderId(which));
    return '<div class="mcx-ai-slot" data-slot="' + which + '">' +
      '<div class="mcx-ai-slothead">' +
        '<div class="mcx-ai-slottext">' +
          '<div class="mcx-ai-slotname">' + esc(aiSlotName(which)) + '</div>' +
          '<div class="mcx-ai-slotsub">' + esc(aiSlotUse(which)) + '</div>' +
        '</div>' +
        '<button type="button" class="mcx-ai-ghost" data-ai-test="' + which + '">' +
          aiIcon('bolt', 'mcx-ai-ctic') + '<span>Test</span></button>' +
      '</div>' +
      '<div class="mcx-ai-field">' +
        '<div class="mcx-ai-label">AI Provider</div>' +
        aiDd({
          id: 'provider-' + which,
          mark: pr.name.charAt(0),
          name: pr.name,
          sub: pr.desc,
          opts: aiProviders().map(function (one) {
            return aiDdOpt({ dd: 'provider-' + which, v: one.id, mark: one.name.charAt(0), name: one.name, sub: one.desc, sel: one.id === pr.id });
          }).join('')
        }) +
      '</div>' +
      '<div class="mcx-ai-field">' +
        '<div class="mcx-ai-labelrow"><span class="mcx-ai-label">API Key</span>' +
          (pr.keyUrl ? '<button type="button" class="mcx-ai-link" data-ai-keyurl="' + esc(pr.keyUrl) + '">' +
            '<span>Where to get key</span>' + aiIcon('ext') + '</button>' : '') +
        '</div>' +
        '<div class="mcx-ai-platewrap">' +
          '<input type="text" class="mcx-ai-input mcx-ai-secret" data-ai-field="key" data-ai-secret-input="1" data-slot="' + which + '" value="' + (s.key ? AI_KEY_MASK : '') + '"' +
            ' placeholder="' + esc(aiReady() ? 'Paste the key here' : 'Loading AI settings...') + '"' +
            (aiReady() ? '' : ' disabled') + ' autocomplete="off" spellcheck="false">' +
          '<button type="button" class="mcx-ai-eye" data-ai-reveal aria-label="Show the key">' + aiIcon('eye') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="mcx-ai-field">' +
        '<div class="mcx-ai-label">Model</div>' +
        aiByoModelHtml(pr, which) +
      '</div>' +
      '<div class="mcx-ai-result" data-ai-result="' + which + '" hidden></div>' +
    '</div>';
  }

  /* 地址这一折两档共用一格入口：挑 provider 已经把它那家的默认地址填进去了，
     只有对方给了另一个地址（代理、校内转发）才需要开这一折 */
  function aiByoEndpointsHtml() {
    return '<div class="mcx-ai-fold' + (ai.foldOpen ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-foldhead" data-ai-fold aria-expanded="' + (ai.foldOpen ? 'true' : 'false') + '">' +
        aiIcon('sliders', 'mcx-ai-foldic') + '<span>Endpoint addresses</span>' + aiIcon('chev', 'mcx-ai-foldchev') +
      '</button>' +
      '<div class="mcx-ai-foldbody">' +
      ['advanced', 'flash'].map(function (which) {
        return '<div class="mcx-ai-field">' +
          '<div class="mcx-ai-label">' + esc(aiSlotName(which)) + ' Base URL</div>' +
          '<div class="mcx-ai-platewrap">' +
            '<input type="text" class="mcx-ai-input" data-ai-field="base" data-slot="' + which + '" value="' + esc(aiSlot(which).base) + '"' +
              ' placeholder="' + esc(aiReady() ? 'https://api.openai.com/v1' : 'Loading AI settings...') + '"' +
              (aiReady() ? '' : ' disabled') + ' autocomplete="off" spellcheck="false">' +
          '</div>' +
        '</div>';
      }).join('') +
        '<div class="mcx-ai-note">Where your requests go. Picking a provider fills these in, so change one only when your provider gives you a different address.</div>' +
      '</div>' +
    '</div>';
  }

  function aiByoPanelHtml() {
    return '<section class="mcx-ai-panel mcx-ai-panel-byo">' +
      aiHead('Use Your Own Key', 'Your API key, data will never go through our server.', '<span class="mcx-ai-headmark">' + aiIcon('key') + '</span>') +
      aiByoSlotHtml('advanced') +
      aiByoSlotHtml('flash') +
      aiByoEndpointsHtml() +
      '<div class="mcx-ai-foot">' + aiIcon('lock') + '<span>Your API key stays in your extension\'s local storage.</span></div>' +
    '</section>';
  }

  /* ---- 用量这两屏：二级是这本账，三级是其中一条 ----
     入口只有 AI 那一屏下面的一颗，左栏不加一档：这些数要点进去才看得见。
     读的只有 ai-client 那一本账，这里不另存第二份，也不在这里重新算一次总量。
     钱那一栏照搬服务自己在回包里报的数。它没报的行只有 token，
     那一屏会把这句话写在明处，我们不拿价目表替谁圆场。 */
  /* 那一列静置画多少条，点开才摊全。账本本身最长 100 条（判据在 ai-client 那一颗），
     这里只管屏上铺开几行，不管记不记 */
  var RECENT_SHOWN = 10;

  function aiUsage() {
    var a = window.MCxAi;
    return a && a.usage ? a.usage : null;
  }

  /* 回复底下那一行的开关：正本在扩展自己的存储里，判据只有 ai-client 那一颗，
     这里不另存第二份，所以设置里翻了那一格，面板画的每一屏同步跟着翻 */
  function aiLineOn() {
    var a = window.MCxAi;
    return !(a && a.usageLineOn && !a.usageLineOn());
  }

  function aiSetLine(on) {
    var value = on ? '1' : '0';
    try { localStorage.setItem('mc_ai_usage_line', value); } catch (e) {}
    if (window.MCxStorage) window.MCxStorage.set('mc_ai_usage_line', value);
    // 开着的那一屏抽屉马上照新值重画：他刚按下去，不该等到下一次发消息才看见行没了
    refreshOpenAiPanel();
  }

  /* 账上记的是服务回包里那个模型 id，屏上要说人话：先在预置那几家的名单里找同名那一行，
     找不到就照原文报，不替它编一个好看的档名 */
  function aiModelLabel(name) {
    var want = String(name || '').trim();
    if (!want) return 'Not reported';
    var a = window.MCxAi;
    var list = (a && a.providers) || [];
    for (var i = 0; i < list.length; i++) {
      var ms = list[i].models || [];
      for (var j = 0; j < ms.length; j++) {
        var m = ms[j];
        var mid = typeof m === 'string' ? m : m.id;
        if (mid === want) return typeof m === 'string' ? m : (m.name || m.id);
      }
    }
    return want;
  }

  function aiCostText(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return '';
    return v >= 0.01 ? '$' + v.toFixed(2) : '$' + v.toFixed(4);
  }

  function aiWhenText(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var s = '';
    try { s = new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { s = ''; }
    return s;
  }

  function aiUseRow(name, value) {
    return '<div class="mcx-ai-resrow"><span class="mcx-ai-resname">' + name + '</span>' +
      '<span class="mcx-ai-resval">' + esc(value) + '</span></div>';
  }

  /* 一格大数：顶上小标签，底下一个数 */
  function aiUseStat(label, value, sub) {
    return '<div class="mcx-ai-usestat"><div class="mcx-ai-eyebrow">' + esc(label) + '</div>' +
      '<div class="mcx-ai-usestatnum">' + esc(value) + '</div>' +
      (sub ? '<div class="mcx-ai-usestatsub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /* 这张卡挂在 mcx-ai-root 里面，和上面那两块板是同一个列里的兄弟：
     宽度、圆角、那一档白、那一条间距都由那一列给，卡自己不写横向边距，
     否则就会出现"比旁边的卡窄一圈"的那种没对齐（他量过：米色那张两边各窄 5px） */
  function aiUsageCardHtml() {
    var open = !!ai.usage;
    return '<div class="mcx-ai-usecard' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-usehead" data-ai-usage="' + (open ? 'back' : 'list') + '"' +
        ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
        aiIcon('bolt', 'mcx-ai-useheadic') +
        '<span class="mcx-ai-useheadbody"><span class="mcx-ai-useheadtitle">AI usage</span>' +
        '<span class="mcx-ai-useheadsub">Tokens used from your own API key.</span></span>' +
        aiIcon('chev', 'mcx-ai-useheadchev') +
      '</button>' +
      (open ? '<div class="mcx-ai-usebody">' + aiLineRowHtml() + aiUsageScreenHtml() + '</div>' : '') +
      '</div>';
  }

  function aiUsageScreenHtml() {
    return ai.usage === 'detail' ? aiUsageDetailHtml() : aiUsageListHtml();
  }

  function aiUsageBackHtml(label, go) {
    return '<button type="button" class="mcx-ai-back" data-ai-usage="' + esc(go) + '">' +
      aiIcon('arrowback') + '<span>' + esc(label) + '</span></button>';
  }

  /* 一张表：只报得出 token 的那些行不补钱，钱那一格写 "Not reported"。
     一句都不写比写个 0 诚实，但只写 token 又像是漏了，所以两个都要点名。 */
  /* foot 是那一块板底下还想要一行时递进来的（最近请求那块的"摊开/收回"就在这一格）：
     它挂在板子里面，不是浮在板子下面，否则看着像另一组 */
  function aiUseTableHtml(title, rows, foot) {
    return '<div class="mcx-ai-usegrp"><div class="mcx-ai-label">' + esc(title) + '</div>' +
      (rows.length ? '<div class="mcx-ai-result">' + rows.join('') + (foot || '') + '</div>'
        : '<div class="mcx-ai-useempty">Nothing has come back with a count yet.</div>') +
      '</div>';
  }

  function aiUseCostCell(bucket) {
    var b = bucket || {};
    if (!b.requests) return 'No AI requests yet';
    if (!b.costRequests) return 'Not available';
    return aiCostText(b.cost) + (b.costRequests < b.requests ? ' (' + b.costRequests + ' of ' + b.requests + ')' : '');
  }

  function aiUseListRows() {
    var u = aiUsage();
    if (!u || !u.known()) return [];
    return u.models().slice(0, 8).map(function (m) {
      return '<div class="mcx-ai-useline is-flat">' +
        '<span class="mcx-ai-useline-name">' + esc(aiModelLabel(m.name)) + '</span>' +
        '<span class="mcx-ai-useline-tok">' + aiNum(m.total) + ' tokens</span>' +
        '<span class="mcx-ai-useline-cost">' + (m.costRequests ? aiCostText(m.cost) : 'no cost') + '</span>' +
        '</div>';
    });
  }

  function aiUseSlotRows() {
    var u = aiUsage();
    if (!u || !u.known()) return [];
    return u.slots().map(function (s) {
      return '<div class="mcx-ai-useline is-flat">' +
        '<span class="mcx-ai-useline-name">' + esc(s.name || 'Other') + '</span>' +
        '<span class="mcx-ai-useline-tok">' + aiNum(s.total) + ' tokens</span>' +
        '<span class="mcx-ai-useline-cost">' + aiUseCostCell(s) + '</span>' +
        '</div>';
    });
  }

  /* 这一列静置只给最近 10 条：那一本账最长 100 条，全铺开会把下面那句说明推到看不见的地方。
     按"Show all"才摊开到 100 条，再按收回去 */
  function aiUseRecentRows() {
    var u = aiUsage();
    if (!u || !u.known()) return [];
    return u.recent(ai.usageOpen ? u.cap : RECENT_SHOWN).map(function (r) {
      return '<button type="button" class="mcx-ai-useline is-log" data-ai-usage="' + esc(r.id) + '">' +
        '<span class="mcx-ai-useline-name">' + esc(r.feature || 'AI request') + '</span>' +
        '<span class="mcx-ai-useline-sub">' + esc(aiWhenText(r.at)) + '</span>' +
        '<span class="mcx-ai-useline-tok">' + aiNum(r.total) + ' tokens</span>' +
        '<span class="mcx-ai-useline-cost">' + (typeof r.cost === 'number' ? aiCostText(r.cost) : '') + '</span>' +
        '</button>';
    });
  }

  function aiUseRecentFootHtml() {
    var u = aiUsage();
    if (!u || !u.known()) return '';
    var held = u.recent(u.cap).length;
    if (held <= RECENT_SHOWN) return '';
    return '<button type="button" class="mcx-ai-useline is-toggle" data-ai-recent>' +
      '<span class="mcx-ai-useline-name">' +
        (ai.usageOpen ? 'Show only the newest ' + RECENT_SHOWN : 'Show all ' + held + ' requests') +
      '</span>' +
      aiIcon('chev', 'mcx-ai-recentchev' + (ai.usageOpen ? ' is-up' : '')) +
      '</button>';
  }

  /* 每条回答底下那一行 token 数的开关。正本只有 mc_ai_usage_line 那一格，
     判据在 ai-client 那一颗，这里翻一下就把开着的那一屏重画。
     它住在 "AI usage" 那张卡展开后的最上面一行（2026-10-10 他拍的：以前它自己单开一张卡，
     和用量那张是两块同级的，看着重复）。用量那张只在自家密钥那一档出现，
     所以云端那一档点不到这颗开关，那一档的回答底下照样会画这一行。 */
  function aiLineRowHtml() {
    return '<label class="mc-set-row cts-row" data-ai-line>' +
      '<span class="mc-set-label">Count under each answer</span>' +
      '<input type="checkbox"' + (aiLineOn() ? ' checked' : '') + '>' +
      '<span class="mc-set-check" aria-hidden="true"></span>' +
    '</label>';
  }

  /* 展开以后卡里不再重复标题：顶上那颗门已经写了叫什么、数的是什么。
     这里只有数本身，一层都不套第二块板。 */
  function aiUsageListHtml() {
    var u = aiUsage();
    if (!u) return '<div class="mcx-ai-useempty">Usage data has not loaded yet.</div>';
    if (!u.known()) return '<div class="mcx-ai-useempty">Loading usage data...</div>';
    var all = u.all();
    var month = u.month();
    return '<div class="mcx-ai-usetotals">' +
      aiUseStat('Tokens', aiNum(all.total), 'all requests here') +
      aiUseStat('Cost', all.costRequests ? aiCostText(all.cost) : 'Not reported',
        all.costRequests ? all.costRequests + ' of ' + all.requests + ' report a cost' : 'those providers send tokens only') +
      aiUseStat('This month', aiNum(month.total), month.costRequests ? aiCostText(month.cost) : 'no cost reported') +
      '</div>' +
      aiUseTableHtml('The two tiers', aiUseSlotRows()) +
      aiUseTableHtml('By model', aiUseListRows()) +
      aiUseTableHtml('Recent requests', aiUseRecentRows(), aiUseRecentFootHtml()) +
      '<div class="mcx-ai-note">This log holds the newest ' + u.cap + ' requests. The totals above also count the ones that fell off that list. '
        + 'A request that never got an answer back is not in here.</div>' +
      (u.note() ? '<div class="mcx-ai-bad">' + esc('This log could not be written to the extension storage: ' + u.note()) + '</div>' : '');
  }

  function aiUsageDetailHtml() {
    var u = aiUsage();
    var back = aiUsageBackHtml('Back to the list', 'list');
    var r = u && u.row ? u.row(ai.usageId) : null;
    if (!r) return back + '<div class="mcx-ai-useempty">This request is no longer in your saved usage history.</div>';
    var rows = [];
    rows.push(aiUseRow('When', aiWhenText(r.at)));
    rows.push(aiUseRow('What asked for it', r.feature || 'AI request'));
    rows.push(aiUseRow('Tier', r.slot || 'Not set'));
    rows.push(aiUseRow('Answered by', aiModelLabel(r.model)));
    rows.push(aiUseRow('Address', r.host || r.provider || ''));
    rows.push(aiUseRow('Input', aiNum(r.prompt) + ' tokens'));
    rows.push(aiUseRow('Output', aiNum(r.completion) + ' tokens'));
    /* 加法只有在两个数真能拼回那个总数的时候才写：服务报的 total 有时还带推理那一段，
       这时候硬拼成 "1,200 + 2,749 = 3,900" 就是我们自己在圆场 */
    var split = (Number(r.prompt) || 0) + (Number(r.completion) || 0);
    rows.push(aiUseRow('Total', split && split === (Number(r.total) || 0)
      ? aiNum(r.prompt) + ' + ' + aiNum(r.completion) + ' = ' + aiNum(r.total) + ' tokens'
      : aiNum(r.total) + ' tokens'));
    if (r.cached) rows.push(aiUseRow('Of the input, cached', aiNum(r.cached) + ' tokens'));
    if (r.reasoning) rows.push(aiUseRow('Spent on thinking', aiNum(r.reasoning) + ' tokens'));
    rows.push(typeof r.cost === 'number'
      ? aiUseRow('Cost', aiCostText(r.cost))
      : '<div class="mcx-ai-resrow"><span class="mcx-ai-resname">Cost</span>'
        + '<span class="mcx-ai-resmsg">That provider does not report a cost, so no figure is invented here.</span></div>');
    return back + '<div class="mcx-ai-userows">' + rows.join('') + '</div>';
  }

  /* ==== Assignment Guide 那张卡 ====
     判据全在 assignment-baseline.js，这里只读它的 statusLine/explain，绝不在这头再算一遍 P80。
     三档灵敏度动的是"门槛"，原始 AI Value 一个数都不改。用户看得见的是那一行小字，
     P80、Cap 这些术语只在 Advanced 那一折里出现，不在主界面。 */
  function guideBase() { return window.MCxAssignBaseline; }

  function aiGuideCardHtml() {
    var B = guideBase();
    if (!B) return '';
    var st = B.status();
    var open = !!ai.guideOpen;
    return '<div class="mcx-ai-usecard mcx-ai-guidecard' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-usehead" data-ai-guide="' + (open ? 'back' : 'open') + '"' +
        ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
        aiIcon('spark', 'mcx-ai-useheadic') +
        '<span class="mcx-ai-useheadbody"><span class="mcx-ai-useheadtitle">Assignment Guide</span>' +
        '<span class="mcx-ai-useheadsub">' + esc(B.statusLine(st)) + '</span></span>' +
        aiIcon('chev', 'mcx-ai-useheadchev') +
      '</button>' +
      (open ? '<div class="mcx-ai-usebody">' + aiGuideBodyHtml(st) + '</div>' : '') +
      '</div>';
  }

  function aiGuideBodyHtml(st) {
    var autoReadLocked = !!st.auto; // 开启自动生成guide的同时会自动开启assignments阅读，不得关闭
    return '<label class="mc-set-row cts-row" data-guide-auto>' +
        '<span class="mc-set-label">Auto-generate useful guides</span>' +
        '<input type="checkbox"' + (st.auto ? ' checked' : '') + '>' +
        '<span class="mc-set-check" aria-hidden="true"></span>' +
      '</label>' +
      '<label class="mc-set-row cts-row' + (autoReadLocked ? ' is-locked' : '') + '" data-guide-auto-read' + (autoReadLocked ? ' title="Always active while auto-generating guides is enabled"' : '') + '>' +
        '<span class="mc-set-label">Auto-read assignment files' + (autoReadLocked ? ' <span style="font-size:11px;opacity:0.65;">(always on with guides)</span>' : '') + '</span>' +
        '<input type="checkbox"' + (st.autoRead ? ' checked' : '') + (autoReadLocked ? ' disabled' : '') + '>' +
        '<span class="mc-set-check" aria-hidden="true"></span>' +
      '</label>' +
      '<div class="mc-set-row" data-guide-static>' +
        '<span class="mc-set-label">Recommendation sensitivity</span>' +
        '<div class="mcx-prov-pills-wrap">' +
        ['less', 'adaptive', 'more'].map(function (m) {
          return '<button type="button" class="mcx-prov-pill' + (st.mode === m ? ' is-active' : '') + '" data-guide-mode="' + m + '">' +
            (m === 'less' ? 'Less' : m === 'more' ? 'More' : 'Adaptive') + '</button>';
        }).join('') +
        '</div>' +
      '</div>' +
      '<div class="mcx-ai-note">' + esc(guideModeNote(st)) + '</div>' +
      (ai.guideMsg ? '<div class="mcx-ai-note">' + esc(ai.guideMsg) + '</div>' : '') +
      aiGuideAdvancedHtml(st);
  }

  /* 文案命名的是"屏幕上看得见的那个变化"：哪一档会更容易/更难自动铺开 */
  function guideModeNote(st) {
    if (st.manual != null) return 'A custom threshold is active. Clear it in Advanced to use these presets.';
    if (st.mode === 'less') return 'Less: Recommend guides only for more complex assignments.';
    if (st.mode === 'more') return 'More: Recommend guides for more assignments.';
    if (!st.enough) return 'Adaptive: Learning from your assignments (' + st.count + '/' + st.minSamples + '). Using the default setting for now.';
    return 'Adaptive: Recommendations are based on your last ' + st.count + ' assignments.';
  }

  /* Advanced 那一折：原始门槛、样本分布、算的全过程，外加"改用手动"那颗 */
  function aiGuideAdvancedHtml(st) {
    var B = guideBase();
    return '<div class="mcx-ai-fold' + (ai.guideAdvanced ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-foldhead" data-guide-fold aria-expanded="' + (ai.guideAdvanced ? 'true' : 'false') + '">' +
        aiIcon('sliders', 'mcx-ai-foldic') + '<span>Advanced: how this threshold is calculated</span>' + aiIcon('chev', 'mcx-ai-foldchev') +
      '</button>' +
      '<div class="mcx-ai-foldbody">' +
        '<div class="mcx-ai-result">' + B.explain(st).map(function (r) {
          return '<div class="mcx-ai-resrow"><span class="mcx-ai-resname">' + esc(r.k) + '</span><span class="mcx-ai-resval">' + esc(r.v) + '</span></div>';
        }).join('') + '</div>' +
        '<div class="mc-set-row" data-guide-static>' +
          '<span class="mc-set-label">Use my own threshold</span>' +
          '<input type="text" inputmode="numeric" class="mc-set-text mcx-ai-manual" data-guide-manual value="' + (st.manual == null ? '' : st.manual) + '" placeholder="' + (st.adaptive == null ? st.threshold : st.adaptive) + '">' +
        '</div>' +
        '<div class="mcx-ai-note">Leave empty to restore adaptive calculation. Custom threshold must stay between ' + B.CONFIG.hardFloor + ' and ' + B.CONFIG.hardCeil + '.</div>' +
        '<div class="mc-set-row" data-guide-static>' +
          '<span class="mcx-set-label">Card on the page</span>' +
          '<div class="mcx-prov-pills-wrap"><button type="button" class="mcx-prov-pill" data-guide-hide>' +
            (window.MCxAssignGuide && window.MCxAssignGuide.hidden && window.MCxAssignGuide.hidden() ? 'Show the card again' : 'Stop showing the card') +
          '</button></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ==== Cached Assignment Files 那张卡（与 Assignment Guide 同级） ==== */
  function aiReadFilesCardHtml() {
    var D = window.MCxAssignData;
    var rawIndex = D && D.readFileIndex ? D.readFileIndex() : {};
    var fileIds = Object.keys(rawIndex);
    var open = !!ai.readFilesOpen;

    var filterCourse = ai.readFilesFilterCourse || 'all';
    var filterAssign = ai.readFilesFilterAssign || 'all';

    // 读取用户在 Course info 里给课程设置的自定义名称
    var courseInfoMap = {};
    try {
      courseInfoMap = JSON.parse(localStorage.getItem('mc_card_text_v1') || '{}') || {};
    } catch (e) { courseInfoMap = {}; }

    // 如果有些课程没有自定义但曾经加载过课程列表
    var knownCourses = {};
    try {
      var h = store();
      if (h && h.mcCardCourseRows) {
        var r = h.mcCardCourseRows();
        (r.rows || []).forEach(function (c) {
          knownCourses[String(c.id)] = (c.over && c.over.name) || c.name || '';
        });
      }
    } catch (e) {}

    // 收集本地已知的作业标题映射表
    var knownAssignments = {};
    try {
      var cachedAsgns = JSON.parse(localStorage.getItem('bc_cache_assignments_v2') || '[]');
      if (Array.isArray(cachedAsgns)) {
        cachedAsgns.forEach(function (a) {
          if (a && a.id) knownAssignments[String(a.id)] = a.title || a.name || '';
        });
      }
    } catch (e) {}

    try {
      var assignCache = JSON.parse(localStorage.getItem('mc_assign_cache_v1') || '{}') || {};
      Object.keys(assignCache).forEach(function (k) {
        var row = assignCache[k];
        if (row && row.title && k.indexOf(':') !== -1) {
          var aid = k.split(':')[1];
          if (aid && !knownAssignments[aid]) knownAssignments[aid] = row.title;
        }
      });
    } catch (e) {}

    // 如果内存中有作业数据
    try {
      if (window.modernAssignments && Array.isArray(window.modernAssignments)) {
        window.modernAssignments.forEach(function (a) {
          if (a && a.id) knownAssignments[String(a.id)] = a.title || a.name || '';
        });
      }
    } catch (e) {}

    // 尝试获取当前页面的作业标题以辅助补全 assignmentId 对应的标题
    var curPageAssignTitle = '';
    var curPageAssignId = '';
    try {
      var curT = (D && D.currentTarget) ? D.currentTarget() : null;
      if (curT) {
        curPageAssignId = String(curT.id || '');
        var heading = document.querySelector('h1.title, #assignment_show h1, .ic-Layout-wrapper h1');
        if (heading) {
          curPageAssignTitle = String(heading.textContent || '').trim();
          if (curPageAssignTitle) knownAssignments[curPageAssignId] = curPageAssignTitle;
        }
      }
    } catch (e) {}

    var courses = {};
    var assignments = {};
    var totalChars = 0;
    var totalBytes = 0;
    var needFetch = [];

    fileIds.forEach(function (fid) {
      var it = rawIndex[fid];
      var cId = String(it.courseId || 'unknown');
      var aId = String(it.assignmentId || 'unknown');

      // 课程名字：优先取 Course Info 自定义名称 -> 真实课程名称 -> 缓存中的 courseName -> 'Course ' + cId
      var customName = (courseInfoMap[cId] && courseInfoMap[cId].name) || knownCourses[cId];
      courses[cId] = customName || it.courseName || ('Course ' + cId);

      // 作业名字：优先取自定义/缓存的作业名称 -> knownAssignments -> it.assignmentName
      var aName = (knownAssignments[aId]) || (it.assignmentName && !/^Assignment\s+\d+$/i.test(it.assignmentName) ? it.assignmentName : '');
      if (!aName && aId && aId === curPageAssignId && curPageAssignTitle) {
        aName = curPageAssignTitle;
      }
      if (!aName && aId && aId !== 'unknown' && aId !== '0') {
        needFetch.push({ courseId: cId, assignmentId: aId });
      }

      assignments[aId] = aName || (aId !== 'unknown' && aId !== '0' ? ('Assignment ' + aId) : 'General Files');

      totalChars += (it.sizeInStorage || it.chars || 0);
      totalBytes += (it.bytes || 0);
    });

    // 若有未识别出标题的作业，在后台异步拉取一次 Canvas API 补全并刷新
    if (needFetch.length && !ai._fetchingAssignNames) {
      ai._fetchingAssignNames = true;
      var fetches = needFetch.map(function (item) {
        if (!item.courseId || item.courseId === 'unknown' || !item.assignmentId) return Promise.resolve();
        return fetch('/api/v1/courses/' + item.courseId + '/assignments/' + item.assignmentId, { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && (data.name || data.title)) {
              var title = data.name || data.title;
              // 更新到 rawIndex
              var idx = D && D.readFileIndex ? D.readFileIndex() : {};
              var changed = false;
              Object.keys(idx).forEach(function (fid) {
                if (String(idx[fid].assignmentId) === String(item.assignmentId)) {
                  idx[fid].assignmentName = title;
                  changed = true;
                }
              });
              if (changed) {
                try { localStorage.setItem('mc_read_files_index', JSON.stringify(idx)); } catch (e) {}
              }
            }
          })
          .catch(function () {});
      });
      Promise.all(fetches).then(function () {
        ai._fetchingAssignNames = false;
        aiRepaint();
      });
    }

    var filteredFiles = fileIds.filter(function (fid) {
      var it = rawIndex[fid];
      if (filterCourse !== 'all' && String(it.courseId || 'unknown') !== filterCourse) return false;
      if (filterAssign !== 'all' && String(it.assignmentId || 'unknown') !== filterAssign) return false;
      return true;
    });

    function fmtStorage(chars) {
      if (!chars) return '0 KB';
      var kb = Math.round(chars / 1024 * 10) / 10;
      if (kb >= 1024) return (Math.round(kb / 102.4) / 10) + ' MB';
      return kb + ' KB';
    }

    var subTitle = fileIds.length + ' file' + (fileIds.length === 1 ? '' : 's') + ' · ' + fmtStorage(totalChars) + ' cached';

    var html = '<div class="mcx-ai-usecard' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="mcx-ai-usehead" data-ai-readfiles="' + (open ? 'back' : 'open') + '"' +
        ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
        aiIcon('spark', 'mcx-ai-useheadic') +
        '<span class="mcx-ai-useheadbody"><span class="mcx-ai-useheadtitle">Cached Assignment Files</span>' +
        '<span class="mcx-ai-useheadsub">' + esc(subTitle) + '</span></span>' +
        aiIcon('chev', 'mcx-ai-useheadchev') +
      '</button>';

    if (open) {
      html += '<div class="mcx-ai-usebody">';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<select class="mc-set-select" data-readfiles-filter="course" style="flex:1;min-width:140px;max-width:50%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;">' +
          '<option value="all"' + (filterCourse === 'all' ? ' selected' : '') + '>All Courses</option>' +
          Object.keys(courses).map(function (cid) {
            var cLabel = courses[cid];
            return '<option value="' + esc(cid) + '"' + (filterCourse === cid ? ' selected' : '') + ' title="' + esc(cLabel) + '">' + esc(cLabel) + '</option>';
          }).join('') +
        '</select>' +
        '<select class="mc-set-select" data-readfiles-filter="assign" style="flex:1;min-width:140px;max-width:50%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;">' +
          '<option value="all"' + (filterAssign === 'all' ? ' selected' : '') + '>All Assignments</option>' +
          Object.keys(assignments).map(function (aid) {
            var aLabel = assignments[aid];
            return '<option value="' + esc(aid) + '"' + (filterAssign === aid ? ' selected' : '') + ' title="' + esc(aLabel) + '">' + esc(aLabel) + '</option>';
          }).join('') +
        '</select>' +
      '</div>';

      if (!filteredFiles.length) {
        html += '<div class="mcx-ai-note">No cached assignment files found for this filter.</div>';
      } else {
        html += '<div class="mcx-ai-result" style="max-height:260px;overflow-y:auto;padding-right:4px;">';
        filteredFiles.forEach(function (fid) {
          var it = rawIndex[fid];
          var nameWithExt = it.name || ('file_' + fid);
          var sizeStr = fmtStorage(it.sizeInStorage || it.chars || 0);
          html += '<div class="mcx-ai-resrow" style="padding:6px 0;display:flex;justify-content:space-between;align-items:center;">' +
            '<span class="mcx-ai-resname" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;" title="' + esc(nameWithExt) + '">' + esc(nameWithExt) + '</span>' +
            '<span class="mcx-ai-resval" style="flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--mc-text-2);">' + esc(sizeStr) + '</span>' +
          '</div>';
        });
        html += '</div>';
      }

      if (fileIds.length) {
        html += '<div style="margin-top:12px;display:flex;justify-content:flex-end;">' +
          '<button type="button" class="mcx-prov-pill" data-readfiles-clear style="color:#ef4444;">Clear All Cached Files</button>' +
        '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  /* AI 那一屏永远画着：展开只让自己长高，不接管、不撤旧的。
     用量那张卡只在自家密钥那一档出现：它数的是"你自己的 key 花了多少"，
     云端那一档根本没有这把 key，挂着会让人以为在读云端账户的账。
     每条回答底下那行 token 的开关挂在这张卡展开后的最上面。 */
  function aiScreenHtml() {
    return aiChoiceHtml() + '<div class="mcx-ai-panels">' + aiPanelsHtml() + '</div>';
  }

  function aiPanelsHtml() {
    return aiCloudPanelHtml() + aiByoPanelHtml() +
      (aiMode() === 'byo' ? aiUsageCardHtml() : '') + aiGuideCardHtml() + aiReadFilesCardHtml();
  }

  function aimodeRowHtml() {
    try { aiFetchPlanConfigs(); } catch (e) {}
    try { aiFetchDailyPool(); } catch (e) {}
    try { aiFetchUserPlan(); } catch (e) {}
    /* 总开关关掉：下面那一整块都不画（两张路线选择卡、Google 登录和验证码那一屏、
       两档模型、用量、作业卡那两档、缓存清单），这一档只剩顶上那颗勾和它下面那句说明。
       上面那三趟订阅读数照发：那是"开着时该看到什么"的账，翻回来那一刻不能是旧的，
       而且池子路由那一条判据读的就是这几格 */
    if (window.mcAiOn && !window.mcAiOn()) return '';
    return '<div class="mcx-ai-root" data-mode="' + aiMode() + '">' + aiScreenHtml() + '</div>';
  }

  /* ---- 这一屏的行为：全部委托在面板那一层，重画 innerHTML 不用重新绑 ---- */
  function aiSyncChoiceState(root) {
    var mode = aiMode();
    root.querySelectorAll('.mcx-ai-card').forEach(function (card) {
      var sel = card.getAttribute('data-ai-tab') === mode;
      card.classList.toggle('is-active', sel);
      card.setAttribute('aria-pressed', sel ? 'true' : 'false');
    });
  }

  /* 换路那一瞬，下面那一坨整块换了内容，高度一帧跳过去（本机 headless 实测云端 648.6px
     → 钥匙 1014.5px，一跳 366px），而顶上那两张板还在 300ms 里慢慢让宽度——
     一个瞬间一个匀速，看着就是"闪一下"。把这一跳也铺成同一条时长同一条曲线。
     只在真的差出一档时才上时钟并临时 clip：差 0 的那几十次重画（选模型、存 key）
     不挂 overflow，免得把里面的自绘下拉裁掉半截 */
  var AI_SWAP_MS = 340;
  var AI_SWAP_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
  function aiSwapPanels(panels, before) {
    if (ai.swapTimer) { clearTimeout(ai.swapTimer); ai.swapTimer = null; }
    panels.innerHTML = aiPanelsHtml();
    var after = panels.getBoundingClientRect().height;
    if (Math.abs(after - before) < 1) return;
    panels.style.overflow = 'clip';
    panels.style.height = before + 'px';
    /* 逼一次布局把起点钉死：不这么一下，下面两行会被合成一次样式重算，
       浏览器只看见"从没高度到 after"，过渡根本不播。
       这里不用 requestAnimationFrame——那一帧要 16ms，比顶上那两张板晚起步，
       两件事就错开了 */
    void panels.offsetHeight;
    panels.style.transition = 'height ' + AI_SWAP_MS + 'ms ' + AI_SWAP_EASE;
    panels.style.height = after + 'px';
    ai.swapTimer = setTimeout(function () {
      ai.swapTimer = null;
      panels.style.transition = '';
      panels.style.height = '';
      panels.style.overflow = '';
    }, AI_SWAP_MS + 60);
  }

  function aiRepaint() {
    if (!p || !p.overlay) return;
    var root = p.overlay.querySelector('.mcx-ai-root');
    if (!root) return;
    var focus = document.activeElement;
    if (focus && focus.getAttribute && focus.getAttribute('data-ai-field')) aiCommit(focus);
    /* 顶上那两张板不跟着重画：换路要的是它俩让宽度、下面那块长缩，而 innerHTML 一换节点就是
       全新的，新节点直接以终态出现，transition 一辈子也不会播。
       真正换了 markup 的只有下面那些面板，所以只重画那一块，两张板就地翻类名。
       旧高度必须排在写 data-mode 前面量：那一行本身就翻了"哪块面板可见"，
       先写后量等于把这一跳算进旧高度，动画只剩后半截（实测 592.6→877.5 那一下没盖住） */
    var panels = root.querySelector('.mcx-ai-panels');
    if (panels) {
      var before = panels.getBoundingClientRect().height;
      root.setAttribute('data-mode', aiMode());
      aiSyncChoiceState(root);
      aiSwapPanels(panels, before);
      return;
    }
    root.setAttribute('data-mode', aiMode());
    root.innerHTML = aiScreenHtml();
  }

  /* The study drawer can remain open behind Settings. Keep its model readout in sync immediately
     after an AI route/model change; otherwise it keeps the value from the moment it was opened. */
  function refreshOpenAiPanel() {
    try {
      if (window.MCxStudy && window.MCxStudy.refresh) window.MCxStudy.refresh();
    } catch (e) {}
  }

  // 当用户在支付页面完成付款或切回 Canvas 窗口时，立即向后端拉取最新的档位配额和订阅状态
  window.addEventListener('focus', function () {
    try {
      if (p && p.overlay) {
        aiFetchPlanConfigs();
        aiFetchDailyPool();
        if (aiUserEmail()) aiFetchUserPlan();
      }
    } catch (e) {}
  });

  function aiCloseDd(dd) {
    if (!dd) return;
    if (dd._mcxCloseTimer) { clearTimeout(dd._mcxCloseTimer); dd._mcxCloseTimer = null; }
    if (!dd.classList.contains('is-open') && !dd.classList.contains('closing')) return;
    dd.classList.remove('is-open');
    dd.classList.add('closing');
    var toggle = dd.querySelector('[data-dd-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    dd._mcxCloseTimer = setTimeout(function () {
      dd._mcxCloseTimer = null;
      dd.classList.remove('closing');
    }, MENU_CLOSE_MS);
  }

  function aiOpenDd(dd) {
    if (!dd) return;
    if (dd._mcxCloseTimer) { clearTimeout(dd._mcxCloseTimer); dd._mcxCloseTimer = null; }
    dd.classList.remove('closing');
    dd.classList.add('is-open');
    var toggle = dd.querySelector('[data-dd-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
  }

  function aiCloseMenus() {
    if (!p || !p.overlay) return;
    /* 搜索只活到这一次开菜单：关上就把那一档自己那份清掉，否则下次进来还是上一次的筛完那一小截。
       另一档的菜单没关，它的词留着——两档各搜各的本来就是这个意思 */
    var typed = [];
    p.overlay.querySelectorAll('.mcx-dd.is-open').forEach(function (dd) {
      var id = dd.getAttribute('data-dd') || '';
      if (ai.modelQuery[id]) typed.push(id);
      aiCloseDd(dd);
    });
    typed.forEach(function (id) {
      ai.modelQuery[id] = '';
      if (id.indexOf('cloud-model-') === 0) aiCloudModelMenu(aiSlotOf(id));
      else if (id.indexOf('model-') === 0) aiSyncModelMenu(aiSlotOf(id));
    });
  }

  function aiToggleDd(id) {
    var dd = p.overlay.querySelector('.mcx-dd[data-dd="' + id + '"]');
    if (!dd) return;
    var wasOpen = dd.classList.contains('is-open');
    aiCloseMenus();
    if (!wasOpen) {
      aiOpenDd(dd);
    }
  }

  function aiDdMenu(id) {
    return p && p.overlay ? p.overlay.querySelector('.mcx-dd[data-dd="' + id + '"] .mcx-dd-menu') : null;
  }

  function aiDdLabel(id, name, sub) {
    var dd = p && p.overlay ? p.overlay.querySelector('.mcx-dd[data-dd="' + id + '"]') : null;
    if (!dd) return;
    var n = dd.querySelector('.mcx-dd-trigger .mcx-dd-name');
    if (n) { n.textContent = name; n.classList.toggle('is-empty', !name); }
    var s = dd.querySelector('.mcx-dd-trigger .mcx-dd-sub');
    if (s && sub != null) s.textContent = sub;
  }

  function aiCommit(input) {
    var field = input.getAttribute('data-ai-field');
    var which = input.getAttribute('data-slot');
    if (!field || !which || !window.MCxAi || !aiReady()) return;
    var v = String(input.value || '').trim();
    // 那一格静置时是占位点：没人进框动过它，就不能当成"用户把钥匙改成了十六个点"写回库
    if (field === 'key' && v === AI_KEY_MASK) return;
    input.value = v;
    var patch = {};
    patch[field] = v;
    window.MCxAi.saveSlot(which, patch);
    if (field === 'key' || field === 'base') aiSyncModelMenu(which);
    if (field === 'model') refreshOpenAiPanel();
  }

  function aiSyncModelMenu(which) {
    var ddId = 'model-' + which;
    var pr = aiProvider(aiProviderId(which));
    var menu = aiDdMenu(ddId);
    if (menu) menu.innerHTML = aiModelMenuHtml(pr, ddId, which);
  }

  /* 打字时筛的这一份和重画菜单时筛的这一份要用同一套判据：都只认模型名和那一串 id，
     价钱那一行不参与，动作那三行（换回短名单/看全部/手填）永远留着 */
  function aiFilterModelMenu(menu, ddId) {
    if (!menu) return;
    var q = String(ai.modelQuery[ddId] || '').trim().toLowerCase();
    menu.querySelectorAll('[data-dd-opt]:not(.mcx-dd-act)').forEach(function (opt) {
      var nameNode = opt.querySelector('.mcx-dd-name');
      var text = (String(opt.getAttribute('data-value') || '') + ' ' +
        (nameNode ? nameNode.textContent : '')).toLowerCase();
      // 行上是 display:flex !important，行内 display:none 压不住它，只能挂同一份 !important 的类
      opt.classList.toggle('is-off', !!q && text.indexOf(q) < 0);
    });
  }

  function aiSetProvider(which, id) {
    var pr = aiProvider(id);
    var ddId = 'model-' + which;
    ai.modelManual[ddId] = false;
    ai.remoteModels[ddId] = null;
    if (!window.MCxAi || !aiReady()) return;
    /* 一套＝这一档自己的 provider、地址、默认模型。挑完另一档不动 */
    window.MCxAi.saveSlot(which, {
      provider: id,
      base: pr.base || aiSlot(which).base,
      model: pr.defaultModel || aiSlot(which).model
    });
    aiCloseMenus();
    setTimeout(function () {
      if (!p || !p.overlay) return;
      aiRepaint();
      refreshOpenAiPanel();
    }, MENU_CLOSE_MS);
  }

  function aiPickPlan(id) {
    ai.pickId = aiPlanOf(id).id;
    aiRepaint();
  }

  /* 云端那一串模型是现问的：码对不对，只有这一趟答不答应说了算 */
  function aiAskCloudModels(code, done) {
    var base = aiCloudBase();
    if (!base) { done(null, 'The AI service address is not available on this page.'); return; }
    var url = base.replace(/\/+$/, '') + '/models';
    var settled = false;
    function once(models, err) { if (!settled) { settled = true; done(models, err); } }
    try {
      fetch(url, { headers: { Authorization: 'Bearer ' + code } }).then(function (res) {
        if (res.status === 401 || res.status === 403) { once(null, 'That code was refused. Check it and save it again.'); return; }
        if (!res.ok) { once(null, 'The AI service answered ' + res.status + '.'); return; }
        return res.json().then(function (data) {
          once(((data && data.data) || []).map(function (m) {
            return { id: m.id || m.name || '', name: m.name || m.id || '', pricing: m.pricing || null };
          }).filter(function (m) { return m.id; }), '');
        });
      }, function () { once(null, 'The AI service could not be reached from this page.'); }).catch(function (err) {
        once(null, String((err && err.message) || 'It did not answer.'));
      });
    } catch (e) { once(null, String((e && e.message) || e)); }
  }

  function aiCacheCloudModels(models) {
    try {
      localStorage.setItem('mc_ai_cloud_models_cache', JSON.stringify(
        [{ id: 'auto', name: 'Auto (recommended)' }].concat((models || []).map(function (m) {
          return { id: m.id, name: m.name || m.id, pricing: m.pricing || null };
        }))));
    } catch (e) {}
  }

  /* 开面板时按存着的那一串码悄悄读一次模型清单：读回来了才补菜单，读不回来什么都不说。
     它不判码行不行（那由保存和 Test 那两趟说了算），只把清单补齐 */
  function aiRefreshCloudModels() {
    var code = aiCode();
    if (!code || !p || !p.overlay) return;
    aiAskCloudModels(code, function (models, err) {
      if (!models || !models.length || !p || !p.overlay) return;
      aiCacheCloudModels(models);
      // 两档共用这一份清单，各自那一列各自重画
      ['advanced', 'flash'].forEach(aiCloudModelMenu);
    });
  }

  function aiSaveCode(btn) {
    var input = p.overlay.querySelector('[data-ai-code-input]');
    var code = input ? String(input.value || '').trim() : '';
    ai.codeDraft = code;
    if (!code) {
      ai.codeState = 'bad';
      ai.codeMsg = 'Type the access code first.';
      aiRepaint();
      return;
    }
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking';
    aiAskCloudModels(code, function (models, err) {
      if (err) {
        // 不重画：他刚打的那一串还在框里，重画会把它换回存着的那一份
        ai.codeState = 'bad';
        ai.codeMsg = err;
        var again = p && p.overlay ? p.overlay.querySelector('[data-ai-code="save"]') : null;
        if (again) { again.disabled = false; again.textContent = label; }
        var line = p && p.overlay ? p.overlay.querySelector('[data-ai-code-msg]') : null;
        if (line) { line.textContent = err; line.hidden = false; }
        return;
      }
      if (!window.MCxAi || !window.MCxAi.setCloudAccessCode) {
        ai.codeState = 'bad';
        ai.codeMsg = 'Secure extension storage is unavailable.';
        aiRepaint();
        return;
      }
      window.MCxAi.setCloudAccessCode(code).then(function (saved) {
        if (!saved || !saved.ok) {
          ai.codeState = 'bad';
          ai.codeMsg = 'Secure extension storage is unavailable.';
          aiRepaint();
          return;
        }
        aiCacheCloudModels(models);
        ai.codeState = 'ok';
        ai.codeMsg = '';
        ai.codeEdit = false;
        ai.codeDraft = '';
        aiRepaint();
      });
    });
  }

  function aiChoose(ddId, value, node) {
    if (ddId.indexOf('provider-') === 0) { aiSetProvider(aiSlotOf(ddId), value); return; }
    if (ddId.indexOf('cloud-model-') === 0) {
      var cWhich = aiSlotOf(ddId);
      if (window.MCxAi) window.MCxAi.setCloudModel(cWhich, value);
      aiDdLabel(ddId, aiModelName(aiCloudModels(), value) || 'Auto (recommended)');
      aiCloseMenus();
      refreshOpenAiPanel();
      return;
    }
    if (ddId.indexOf('model-') === 0) {
      var which = aiSlotOf(ddId);
      var pr = aiProvider(aiProviderId(which));
      var modelOf = function () {
        var remote = ai.remoteModels[ddId];
        return remote && remote.provider === pr.id ? remote.list : pr.models;
      };
      if (value === '__manual__') {
        ai.modelManual[ddId] = true;
        aiCloseMenus();
        setTimeout(function () {
          if (!p || !p.overlay) return;
          aiRepaint();
          var input = p.overlay.querySelector('input[data-ai-field="model"][data-slot="' + which + '"]');
          if (input) input.focus();
        }, MENU_CLOSE_MS);
        return;
      }
      if (value === '__short__') {
        ai.remoteModels[ddId] = null;
        aiSyncModelMenu(which);
        return;
      }
      if (value === '__browse__') {
        if (node) {
          var nameNode = node.querySelector('.mcx-dd-name');
          if (nameNode) nameNode.textContent = 'Reading the list...';
        }
        /* 问的是这一档自己那把钥匙允许哪些模型，不是"当前那一格"——两档可以来自两家 */
        window.MCxAi.fetchModels(which).then(function (list) {
          if (!list || !list.length) {
            aiSyncModelMenu(which);
            return;
          }
          ai.remoteModels[ddId] = { provider: pr.id, list: list.slice(0, 400) };
          aiSyncModelMenu(which);
          var dd = p && p.overlay ? p.overlay.querySelector('.mcx-dd[data-dd="' + ddId + '"]') : null;
          if (dd) aiOpenDd(dd);
        }, function (err) {
          aiSyncModelMenu(which);
          var dd = p && p.overlay ? p.overlay.querySelector('.mcx-dd[data-dd="' + ddId + '"] .mcx-dd-menu') : null;
          if (dd) {
            var line = el('div', 'mcx-dd-empty', 'That address did not give a list: ' + String((err && err.message) || 'it did not answer'));
            dd.insertBefore(line, dd.firstChild);
          }
        });
        return;
      }
      if (window.MCxAi) window.MCxAi.saveSlot(which, { model: value });
      aiDdLabel(ddId, aiModelName(modelOf(), value) || value);
      aiSyncModelMenu(which);
      aiCloseMenus();
      refreshOpenAiPanel();
    }
  }

  /* Test 的结果只往文字节点里写：提供商回的那句话是不可信内容，不能当 HTML 用 */
  function aiPaintTest(out, report) {
    out.textContent = '';
    out.hidden = false;
    var steps = (report && report.steps) || [];
    if (!steps.length) {
      out.appendChild(el('div', 'mcx-ai-resmsg', String((report && report.error && report.error.text) || 'Nothing came back.')));
      return;
    }
    steps.forEach(function (s) {
      var skipped = !s.ok && /skipped/i.test(String(s.text || ''));
      var row = el('div', 'mcx-ai-resrow');
      row.appendChild(el('span', 'mcx-ai-resname', s.name === 'Image input' ? 'Photos' : (s.name || 'Step')));
      row.appendChild(el('span', 'mcx-ai-resval' + (skipped ? '' : (s.ok ? ' is-ok' : ' is-bad')),
        skipped ? 'Skipped' : (s.ok ? 'Passed' : 'Failed')));
      out.appendChild(row);
      if (!s.ok && !skipped) {
        // 先说我们判读出来的那一句，再把对方原话带上；两个数一样时不重复一遍
        var said = String(s.text || '');
        var raw = String(s.raw || '');
        var detail = raw && said.indexOf(raw) < 0 ? (said ? said + ' (' + raw + ')' : raw) : said;
        if (detail) out.appendChild(el('div', 'mcx-ai-resmsg', detail));
      }
    });
    var cfg = (report && report.cfg) || {};
    out.appendChild(el('div', 'mcx-ai-ressum', report && report.ok
      ? 'Ready to use with ' + (cfg.model || 'the model you picked') + '.'
      : 'Not connected. The answer above is what ' + (cfg.name || 'that address') + ' gave.'));
  }

  function aiRunTest(btn) {
    if (!window.MCxAi) return;
    var which = btn.getAttribute('data-ai-test') || 'flash';
    var out = p.overlay.querySelector('[data-ai-result="' + which + '"]');
    if (!out) return;
    var focus = document.activeElement;
    if (focus && focus.getAttribute && focus.getAttribute('data-ai-field')) aiCommit(focus);
    out.hidden = false;
    out.textContent = '';
    var busy = el('div', 'mcx-ai-resrow');
    busy.appendChild(el('span', 'mcx-ai-resname', 'Asking ' + aiSlotName(which) + ' once'));
    var stepNode = el('span', 'mcx-ai-resval', 'Running');
    busy.appendChild(stepNode);
    out.appendChild(busy);
    btn.disabled = true;
    window.MCxAi.test(which, function (step) {
      stepNode.textContent = step || 'Running';
    }).then(function (report) {
      btn.disabled = false;
      aiPaintTest(out, report || { steps: [] });
    }, function (err) {
      btn.disabled = false;
      out.textContent = '';
      out.appendChild(el('div', 'mcx-ai-resmsg', 'The test did not run: ' + String((err && err.message) || 'it did not answer')));
    });
  }

  function bindAiScreen() {
    var ov = p.overlay;

    ov.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var toggle = t.closest('[data-dd-toggle]');
      if (toggle) { aiToggleDd(toggle.getAttribute('data-dd-toggle')); return; }
      var opt = t.closest('[data-dd-opt]');
      if (opt) { aiChoose(opt.getAttribute('data-dd-opt'), opt.getAttribute('data-value'), opt); return; }
      if (!t.closest('.mcx-dd')) aiCloseMenus();

      var tab = t.closest('[data-ai-tab]');
      if (tab) {
        var mode = tab.getAttribute('data-ai-tab') === 'byo' ? 'byo' : 'cloud';
        localStorage.setItem('mc_ai_mode', mode);
        ai.codeEdit = false;
        ai.codeDraft = '';
        // 换路等于离开那一屏：挑档那一屏不许半开着等回来
        ai.picker = false;
        aiRepaint();
        refreshOpenAiPanel();
        return;
      }
      var code = t.closest('[data-ai-code]');
      if (code) {
        var what = code.getAttribute('data-ai-code');
        if (what === 'edit') {
          ai.codeEdit = true;
          ai.codeDraft = aiCode();
          ai.codeState = '';
          ai.codeMsg = '';
          aiRepaint();
          var box = ov.querySelector('[data-ai-code-input]');
          if (box) box.focus();
        } else if (what === 'cancel') {
          ai.codeEdit = false;
          ai.codeDraft = '';
          aiRepaint();
        } else if (what === 'save') {
          aiSaveCode(code);
        }
        return;
      }
      var reveal = t.closest('[data-ai-reveal]');
      if (reveal) {
        var field = reveal.parentNode ? reveal.parentNode.querySelector('input') : null;
        if (!field) return;
        var on = field.getAttribute('data-reveal') === '1';
        if (on) {
          field.removeAttribute('data-reveal');
          if (field.getAttribute('data-ai-secret-input')) aiSecretRestore(field);
        } else {
          field.setAttribute('data-reveal', '1');
          if (field.getAttribute('data-ai-secret-input')) aiSecretFill(field);
        }
        reveal.innerHTML = aiIcon(on ? 'eye' : 'eyeoff');
        reveal.setAttribute('aria-label', on ? 'Show the key' : 'Hide the key');
        return;
      }
      var keylink = t.closest('[data-ai-keyurl]');
      if (keylink) {
        window.open(keylink.getAttribute('data-ai-keyurl'), '_blank', 'noopener');
        return;
      }
      /* 订阅这一层的几颗：进挑档那一屏、退回去、挑一档、换月付年付、按下去换档。
         最后那颗只改本机 mc_ai_plan 这一格，不联网、不开任何付款页 */
      /* 用量那一屏的进出：进那本账、退回去、点其中某一条请求。
         退回的那一格按当前开在哪一屏决定，所以从三级退到二级、从二级退回 AI 那一屏 */
      var usage = t.closest('[data-ai-usage]');
      if (usage) {
        var where = usage.getAttribute('data-ai-usage');
        if (where === 'back') ai.usage = '';
        else if (where === 'list') { ai.usage = 'list'; ai.usageId = ''; }
        else { ai.usage = 'detail'; ai.usageId = where; }
        aiRepaint();
        return;
      }
      /* 那一行是这座面板到处都在用的 .mc-set-row 那一套：整行点得动。
         先拦住原生那一下，值只从 ai-client 那一颗读，免得勾和库里那一格各走各的 */
      /* 摊开/收回那一列：只换这张卡，不动 AI 那一屏，也不重新去问服务要一次数 */
      var recent = t.closest('[data-ai-recent]');
      if (recent) {
        ai.usageOpen = !ai.usageOpen;
        aiRepaint();
        return;
      }
      var lineRow = t.closest('[data-ai-line]');
      if (lineRow) {
        if (e && e.preventDefault) e.preventDefault();
        aiSetLine(!aiLineOn());
        aiRepaint();
        return;
      }
      /* Assignment Guide 那张卡。判据一律交给 assignment-baseline 那一份，
         这里写完就重画这一张，不在设置头算门槛 */
      var guideGate = t.closest('[data-ai-guide]');
      if (guideGate) {
        ai.guideOpen = guideGate.getAttribute('data-ai-guide') !== 'back';
        aiRepaint();
        return;
      }
      var guideAuto = t.closest('[data-guide-auto]');
      if (guideAuto) {
        if (e && e.preventDefault) e.preventDefault();
        var Bg = guideBase();
        if (Bg) { Bg.setAuto(!Bg.autoOn()); ai.guideMsg = ''; }
        aiRepaint();
        return;
      }
      var guideAutoRead = t.closest('[data-guide-auto-read]');
      if (guideAutoRead) {
        if (e && e.preventDefault) e.preventDefault();
        var Bar = guideBase();
        if (Bar) {
          if (Bar.autoOn()) {
            ai.guideMsg = 'Auto-reading files cannot be turned off while Auto-generate is enabled.';
          } else {
            Bar.setAutoRead(!Bar.autoReadOn());
            ai.guideMsg = '';
          }
        }
        aiRepaint();
        return;
      }
      var guideMode = t.closest('[data-guide-mode]');
      if (guideMode) {
        var Bm = guideBase();
        if (Bm) Bm.setMode(guideMode.getAttribute('data-guide-mode'));
        aiRepaint();
        return;
      }
      var guideFold = t.closest('[data-guide-fold]');
      if (guideFold) {
        ai.guideAdvanced = !ai.guideAdvanced;
        aiRepaint();
        return;
      }
      var guideHide = t.closest('[data-guide-hide]');
      if (guideHide) {
        var G = window.MCxAssignGuide;
        if (!G) { ai.guideMsg = 'Reload this page once: the assignment card layer is not running here yet.'; }
        else if (G.hidden && G.hidden()) { G.show(); ai.guideMsg = 'The card will appear again on assignment pages.'; }
        else { G.hide(); ai.guideMsg = 'The card is gone from assignment pages. Come back here to bring it back.'; }
        aiRepaint();
        return;
      }
      var readFilesGate = t.closest('[data-ai-readfiles]');
      if (readFilesGate) {
        ai.readFilesOpen = readFilesGate.getAttribute('data-ai-readfiles') !== 'back';
        aiRepaint();
        return;
      }
      var readFilesClear = t.closest('[data-readfiles-clear]');
      if (readFilesClear) {
        var D = window.MCxAssignData;
        if (D && D.clearAllCachedFiles) D.clearAllCachedFiles();
        aiRepaint();
        return;
      }
      var routeBtn = t.closest('[data-ai-route-pref]');
      if (routeBtn) {
        var pref = routeBtn.getAttribute('data-ai-route-pref') === 'pool' ? 'pool' : 'plan';
        try { localStorage.setItem('mc_ai_routing_pref', pref); } catch (e) {}
        aiRepaint();
        return;
      }
      var plans = t.closest('[data-ai-plans]');
      if (plans) {
        var go = plans.getAttribute('data-ai-plans');
        ai.codeEdit = false;
        ai.codeDraft = '';
        ai.picker = go !== 'back';
        if (go !== 'back') ai.pickId = aiPlanOf(go).id;
        aiRepaint();
        return;
      }
      var pick = t.closest('[data-ai-pick]');
      if (pick) { aiPickPlan(pick.getAttribute('data-ai-pick')); return; }
      var bill = t.closest('[data-ai-billing]');
      if (bill) {
        localStorage.setItem('mc_ai_billing', bill.getAttribute('data-ai-billing') === '3m' ? '3m' : 'monthly');
        aiRepaint();
        return;
      }
      var act = t.closest('[data-ai-activate]');
      if (act) {
        var userMail = aiUserEmail();
        if (!userMail) {
          aiLoginGoogle();
          return;
        }
        var cur = aiPlanId();
        var want = aiPlanOf(ai.pickId || (cur === 'free' ? 'plus' : cur)).id;
        if (want !== cur) {
          var checkoutUrl = DODO_CHECKOUT[want];
          if (checkoutUrl) {
            checkoutUrl += (checkoutUrl.indexOf('?') >= 0 ? '&' : '?') + 'email=' + encodeURIComponent(userMail) + '&disableEmail=true';
            window.open(checkoutUrl, '_blank');
            aiStartPlanPolling(180);
          }
          ai.picker = false;
          ai.pickId = '';
          aiRepaint();
          return;
        } else if (cur !== 'free') {
          // 当前已是该付费套餐：点击跳转至 Dodo 官方客户门户进行真实退订、改卡、查收据
          window.open('https://customer.dodopayments.com', '_blank');
          return;
        }
        ai.pickId = '';
        aiRepaint();
        return;
      }
      var resume = t.closest('[data-ai-resume]');
      if (resume) {
        localStorage.removeItem('mc_ai_cancelled');
        aiRepaint();
        return;
      }
      var fold = t.closest('[data-ai-fold]');
      if (fold) {
        var box2 = fold.closest('.mcx-ai-fold');
        var open = box2.classList.toggle('is-open');
        fold.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (fold.getAttribute('data-ai-fold') === 'code') ai.codeOpen = open;
        else ai.foldOpen = open;
        return;
      }
      var modelList = t.closest('[data-ai-model="list"]');
      if (modelList) {
        ai.modelManual['model-' + (modelList.getAttribute('data-slot') || 'flash')] = false;
        aiRepaint();
        return;
      }
      var authBtn = t.closest('[data-ai-auth]');
      if (authBtn) {
        var action = authBtn.getAttribute('data-ai-auth');
        if (action === 'send-otp') {
          var emInp = ov.querySelector('[data-ai-auth-email-input]');
          var emVal = emInp ? String(emInp.value || '').trim() : '';
          ai.authEmailInput = emVal;
          aiSendOtp(emVal);
          return;
        }
        if (action === 'verify-otp') {
          var cdInp = ov.querySelector('[data-ai-auth-code-input]');
          var cdVal = cdInp ? String(cdInp.value || '').trim() : '';
          ai.authCodeInput = cdVal;
          aiVerifyOtp(ai.authEmailInput, cdVal);
          return;
        }
        if (action === 'resend-otp') {
          if (ai.authCountDown <= 0 && ai.authEmailInput) {
            aiSendOtp(ai.authEmailInput);
          }
          return;
        }
        if (action === 'cancel-verify') {
          ai.authStep = 'input';
          ai.authCodeInput = '';
          ai.authMsg = '';
          ai.authMsgType = '';
          aiRepaint();
          return;
        }
        if (action === 'google') {
          aiLoginGoogle();
          return;
        }
        if (action === 'logout') {
          aiLogout();
          return;
        }
      }
      var test = t.closest('[data-ai-test]');
      if (test) { aiRunTest(test); return; }
    });

    /* 密钥那两格（两档那一格和账户清单那一格）静置时只有占位点，进框才现取真值：
       这样页面世界任何时候扫 DOM 都扫不到钥匙，粘贴和编辑照旧能用 */
    ov.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-ai-secret-input')) aiSecretFill(t);
    });

    ov.addEventListener('focusout', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || !t.getAttribute('data-ai-secret-input')) return;
      if (String(t.value || '').trim() === aiSecretStore(t)) aiSecretRestore(t);
    });

    ov.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-ai-field')) aiCommit(t);
      if (t && t.getAttribute && t.hasAttribute('data-guide-manual')) {
        var Bh = guideBase();
        if (!Bh) return;
        var typed2 = String(t.value || '').trim();
        /* 空＝退回自适应；写进去的那一个数由 baseline 那层自己夹，这里不重复夹一遍 */
        var saved = Bh.setManualThreshold(typed2 === '' ? '' : typed2);
        ai.guideMsg = typed2 === ''
          ? 'Back on the adaptive bar.'
          : 'Manual bar set to ' + saved + '. The completeness gate still has to pass, and a page under the fixed floor is still skipped.';
        aiRepaint();
      }
      if (t && t.getAttribute && t.getAttribute('data-readfiles-filter')) {
        var kind = t.getAttribute('data-readfiles-filter');
        if (kind === 'course') ai.readFilesFilterCourse = t.value;
        if (kind === 'assign') ai.readFilesFilterAssign = t.value;
        aiRepaint();
      }
    });

    ov.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.hasAttribute('data-ai-auth-email-input')) {
        ai.authEmailInput = t.value;
      } else if (t.hasAttribute('data-ai-auth-code-input')) {
        ai.authCodeInput = t.value;
      } else if (t.hasAttribute('data-model-search')) {
        var ddId = String(t.getAttribute('data-model-search') || '');
        ai.modelQuery[ddId] = String(t.value || '');
        aiFilterModelMenu(t.closest('.mcx-dd-menu'), ddId);
      }
    });

    ov.addEventListener('keydown', function (e) {
      var t = e.target;
      if (e.key === 'Escape') { aiCloseMenus(); return; }
      if (e.key === 'Enter') {
        if (t && t.getAttribute && t.getAttribute('data-ai-auth-email-input')) {
          e.preventDefault();
          var sBtn = ov.querySelector('[data-ai-auth="send-otp"]');
          if (sBtn) sBtn.click();
          return;
        }
        if (t && t.getAttribute && t.getAttribute('data-ai-auth-code-input')) {
          e.preventDefault();
          var vBtn = ov.querySelector('[data-ai-auth="verify-otp"]');
          if (vBtn) vBtn.click();
          return;
        }
      }
      if (e.key === 'Enter' && t && t.getAttribute && t.getAttribute('data-ai-code-input')) {
        e.preventDefault();
        var btn = ov.querySelector('[data-ai-code="save"]');
        if (btn) aiSaveCode(btn);
        return;
      }
      // 整张卡就是一个入口，所以键盘走到卡上按回车或空格也算挑这一档
      if ((e.key === 'Enter' || e.key === ' ') && t && t.closest) {
        var card = t.closest('[data-ai-pick]');
        if (card && card.getAttribute('role') === 'button') {
          e.preventDefault();
          aiPickPlan(card.getAttribute('data-ai-pick'));
        }
      }
    });
  }

  /* School Sites 那一档。每一格站点一块板。
     默认那一格只是说明"这一台认哪些地址"，它删不掉也改不了，所以那一格不给任何入口，只留状态；
     自己加的那几格才有 Remove。左边那颗官方 logo 不画：那是 Canvas 的标记，
     不是我能照着重绘的东西，所以格子里只有字。 */
  function sitesManagerRowHtml() {
    var rawList = [];
    try {
      var s = localStorage.getItem('mc_custom_domains_cache') || '[]';
      rawList = JSON.parse(s);
    } catch (e) { rawList = []; }
    if (!Array.isArray(rawList)) rawList = [];

    var items = [
      '<div class="mcx-site-card mcx-site-default">' +
        '<div class="mcx-site-body">' +
          '<div class="mcx-site-name">*.instructure.com</div>' +
          '<div class="mcx-site-sub">Default Canvas Cloud (Always active)</div>' +
        '</div>' +
      '</div>'
    ];

    rawList.forEach(function (dm) {
      items.push(
        '<div class="mcx-site-card mcx-site-item" data-site="' + esc(dm) + '">' +
          '<div class="mcx-site-body">' +
            '<div class="mcx-site-name">' + esc(dm) + '</div>' +
            '<div class="mcx-site-sub">Custom School Domain</div>' +
          '</div>' +
          '<button type="button" class="mcx-site-del" data-remove-site="' + esc(dm) + '">Remove</button>' +
        '</div>'
      );
    });

    return '<div class="mcx-sites-box">' +
      '<div class="mcx-sites-lead">Modern Canvas automatically detects Canvas sites. Add a custom school domain if yours isn\'t recognized.</div>' +
      '<div class="mcx-sites-list">' + items.join('') + '</div>' +
      '<div class="mcx-sites-rule"></div>' +
      '<div class="mcx-sites-add"><span class="mcx-sites-plus">' + aiIcon('plus') + '</span><span>Add a Custom Site</span></div>' +
      '<div class="mcx-site-row">' +
        '<div class="mcx-site-field">' + aiIcon('link', 'mcx-site-linkic') +
          '<input type="text" class="mcx-site-input" placeholder="e.g. canvas.harvard.edu" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<button type="button" class="mcx-site-add" disabled>Add Site</button>' +
      '</div>' +
      '<div class="mcx-site-msg" style="display:none;"></div>' +
    '</div>';
  }

  function getWidgetLocation(widgetName) {
    try {
      var key = widgetName === 'grades' ? 'mc_dash_widget_grades_loc' : 'mc_dash_widget_focus_loc';
      var loc = localStorage.getItem(key);
      if (loc === 'combined' || loc === 'separate' || loc === 'off') return loc;
      var onKey = widgetName === 'grades' ? 'mc_dash_widget_grades' : 'mc_dash_widget_focus';
      if (localStorage.getItem(onKey) === '0') return 'off';
      var layout = localStorage.getItem('bc_dash_widget_layout') || 'combined';
      return layout === 'separate' ? 'separate' : 'combined';
    } catch (e) { return 'combined'; }
  }

  function setWidgetLocation(widgetName, loc) {
    try {
      var key = widgetName === 'grades' ? 'mc_dash_widget_grades_loc' : 'mc_dash_widget_focus_loc';
      var onKey = widgetName === 'grades' ? 'mc_dash_widget_grades' : 'mc_dash_widget_focus';
      localStorage.setItem(key, loc);
      localStorage.setItem(onKey, loc === 'off' ? '0' : '1');
      var fLoc = getWidgetLocation('focus');
      var gLoc = getWidgetLocation('grades');
      var layout = (fLoc === 'separate' || gLoc === 'separate') ? 'separate' : 'combined';
      localStorage.setItem('bc_dash_widget_layout', layout);
    } catch (e) {}
  }

  function widgetModesRowHtml() {
    var focusLoc = getWidgetLocation('focus');
    var gradesLoc = getWidgetLocation('grades');
    var focusInCombined = focusLoc === 'combined';
    var gradesInCombined = gradesLoc === 'combined';
    var focusInSeparate = focusLoc === 'separate';
    var gradesInSeparate = gradesLoc === 'separate';
    var coverOn = localStorage.getItem('mc_dash_widget_cover') === '1' || localStorage.getItem('bc_dash_widget_cover') === '1';

    var clockSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.4" r="6.4"/><path d="M12 10.2v3.2l2.4 1.6"/><path d="M7.5 8.9L5.1 6.5M16.5 8.9l2.4-2.4"/></svg>';
    var capSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 8 9.5-4 9.5 4-9.5 4zM6 10v5c0 2.4 2.7 4.3 6 4.3s6-1.9 6-4.3v-5M21.5 8v6"/></svg>';
    var slidersSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.4h8.6M17.4 8.4H20M4 15.6h4.6M13.4 15.6H20"/><circle cx="15" cy="8.4" r="2.1"/><circle cx="11" cy="15.6" r="2.1"/></svg>';

    /* Combined Card Preview */
    var combinedPreviewContent = '';
    if (!focusInCombined && !gradesInCombined) {
      combinedPreviewContent = '<div class="mcx-wm-empty-preview">No widgets included in Widget Card</div>';
    } else {
      var rowsHtml = '';
      if (focusInCombined) {
        rowsHtml += '<div class="mcx-wm-mock-row">' + clockSvg + '<span>Focus</span><span class="mcx-wm-mock-chevron">›</span></div>';
      }
      if (gradesInCombined) {
        rowsHtml += '<div class="mcx-wm-mock-row">' + capSvg + '<span>Grades</span><span class="mcx-wm-mock-chevron">›</span></div>';
      }
      combinedPreviewContent =
        '<div class="mcx-wm-mock-card mcx-wm-mock-combined has-cover">' +
          '<div class="mcx-wm-mock-cover"><div class="mcx-wm-mock-mascot"></div><div class="mcx-wm-mock-cover-tag">Cover Art</div></div>' +
          '<div class="mcx-wm-mock-slot">' +
            rowsHtml +
          '</div>' +
        '</div>';
    }

    /* Separate Cards Preview */
    var separatePreviewContent = '';
    if (!focusInSeparate && !gradesInSeparate) {
      separatePreviewContent = '<div class="mcx-wm-empty-preview">No separate cards selected</div>';
    } else {
      var cardsHtml = '';
      if (focusInSeparate) {
        cardsHtml +=
          '<div class="mcx-wm-mock-card mcx-wm-mock-card-focus' + (coverOn ? ' has-cover' : '') + '">' +
            (coverOn ? '<div class="mcx-wm-mock-cover"><div class="mcx-wm-mock-mascot"></div><div class="mcx-wm-mock-cover-tag">Cover</div></div>' : '') +
            '<div class="mcx-wm-mock-slot">' +
              '<div class="mcx-wm-mock-head"><strong>Focus</strong></div>' +
              '<div class="mcx-wm-mock-pills"><span>15</span><span>30</span><span>60</span></div>' +
              '<div class="mcx-wm-mock-step"><span>-</span><span>15m</span><span>+</span><span class="mcx-wm-mock-start">Start</span></div>' +
            '</div>' +
          '</div>';
      }
      if (gradesInSeparate) {
        cardsHtml +=
          '<div class="mcx-wm-mock-card mcx-wm-mock-card-grades' + (coverOn ? ' has-cover' : '') + '">' +
            (coverOn ? '<div class="mcx-wm-mock-cover"><div class="mcx-wm-mock-mascot"></div><div class="mcx-wm-mock-cover-tag">Cover</div></div>' : '') +
            '<div class="mcx-wm-mock-slot">' +
              '<div class="mcx-wm-mock-nav"><span>Current</span><span>Cumul</span></div>' +
              '<div class="mcx-wm-mock-score-row"><span>3.71</span>' + slidersSvg + '</div>' +
              '<div class="mcx-wm-mock-nav"><span>Unwght</span><span>Wght</span></div>' +
            '</div>' +
          '</div>';
      }
      var isSingle = (!focusInSeparate || !gradesInSeparate);
      separatePreviewContent = '<div class="mcx-wm-mock-grid' + (isSingle ? ' is-single' : '') + '">' + cardsHtml + '</div>';
    }

    return '<div class="mcx-wm-container">' +
      '<div class="mcx-wm-heading">' +
        '<div class="mcx-wm-heading-title">Widget Settings</div>' +
        '<div class="mcx-wm-heading-sub">Choose which widgets appear in the combined Widget Card or as separate cards on your Dashboard.</div>' +
      '</div>' +
      '<div class="mcx-wm-grid">' +
        /* 左侧：Widget Cards */
        '<div class="mcx-wm-card">' +
          '<div class="mcx-wm-card-top">' +
            '<div class="mcx-wm-card-info">' +
              '<div class="mcx-wm-card-name">Widget Cards</div>' +
            '</div>' +
          '</div>' +
          '<div class="mcx-wm-preview-box">' +
            combinedPreviewContent +
          '</div>' +
          '<p class="mcx-wm-desc">Bundles selected widgets into one card with mascot cover art and collapsible entries.</p>' +
          '<div class="mcx-wm-config-section">' +
            '<div class="mcx-wm-config-title">Included in Widget Cards:</div>' +
            '<label class="mc-set-row cts-row mcx-wm-opt-row">' +
              '<span class="mc-set-label">Focus</span>' +
              '<input type="checkbox" data-wm-widget="focus" data-wm-target="combined"' + (focusInCombined ? ' checked' : '') + '>' +
              '<span class="mc-set-check" aria-hidden="true"></span>' +
            '</label>' +
            '<label class="mc-set-row cts-row mcx-wm-opt-row">' +
              '<span class="mc-set-label">Grades</span>' +
              '<input type="checkbox" data-wm-widget="grades" data-wm-target="combined"' + (gradesInCombined ? ' checked' : '') + '>' +
              '<span class="mc-set-check" aria-hidden="true"></span>' +
            '</label>' +
          '</div>' +
        '</div>' +

        /* 右侧：Separate Cards */
        '<div class="mcx-wm-card">' +
          '<div class="mcx-wm-card-top">' +
            '<div class="mcx-wm-card-info">' +
              '<div class="mcx-wm-card-name">Separate Cards</div>' +
            '</div>' +
          '</div>' +
          '<div class="mcx-wm-preview-box">' +
            separatePreviewContent +
          '</div>' +
          '<p class="mcx-wm-desc">Displays widgets as individual standalone cards on your Dashboard, always visible.</p>' +
          '<div class="mcx-wm-config-section">' +
            '<div class="mcx-wm-config-title">Separate cards settings:</div>' +
            '<label class="mc-set-row cts-row mcx-wm-opt-row">' +
              '<span class="mc-set-label">Focus card</span>' +
              '<input type="checkbox" data-wm-widget="focus" data-wm-target="separate"' + (focusInSeparate ? ' checked' : '') + '>' +
              '<span class="mc-set-check" aria-hidden="true"></span>' +
            '</label>' +
            '<label class="mc-set-row cts-row mcx-wm-opt-row">' +
              '<span class="mc-set-label">Grades card</span>' +
              '<input type="checkbox" data-wm-widget="grades" data-wm-target="separate"' + (gradesInSeparate ? ' checked' : '') + '>' +
              '<span class="mc-set-check" aria-hidden="true"></span>' +
            '</label>' +
            '<label class="mc-set-row cts-row mcx-wm-opt-row">' +
              '<span class="mc-set-label">Card cover art</span>' +
              '<input type="checkbox" data-setting="mc_dash_widget_cover"' + (coverOn ? ' checked' : '') + '>' +
              '<span class="mc-set-check" aria-hidden="true"></span>' +
            '</label>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function rowHtml(row) {
    if (row.type === 'sites_manager') return sitesManagerRowHtml();
    if (row.type === 'aimode') return aimodeRowHtml();
    if (row.type === 'widget_modes') return widgetModesRowHtml();
    if (row.type === 'nav_lists') return navListsHtml();
    if (row.type === 'select') return selectRowHtml(row);
    if (row.type === 'check') return checkRowHtml(row);
    if (row.type === 'text') return textRowHtml(row);
    if (row.type === 'accounts') return accountsRowHtml();
    if (row.type === 'retention') return retentionRowHtml();
    if (row.type === 'jump') {
      return '<div class="mc-set-row mc-set-jump ' + (row.cls || '') + '" role="button" tabindex="0">' +
        '<div class="mc-set-jump-main" style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;">' +
          '<span class="mc-set-label">' + esc(row.label) + '</span>' +
          (row.note ? '<span style="font-size:12px;color:var(--mc-text-1,#777);line-height:1.4;">' + esc(row.note) + '</span>' : '') +
        '</div>' +
        '<span class="mc-set-jump-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>' +
        '</span>' +
      '</div>';
    }
    // 说明句的 text 两种写法都有：要按当前档位翻字的那几行写成函数，字从头到尾不变的写成字符串。
    // 这里两种都收：只认函数的那一版让整座面板搭不起来（抛在 map 里，捕获层把错误吞成"点了没反应"）
    if (row.type === 'note') return '<div class="mc-set-note"' + (row.key ? ' data-note="' + row.key + '"' : '') + '>'
      + esc(typeof row.text === 'function' ? row.text() : row.text) + '</div>';
    return '<button type="button" class="mc-set-btn mc-set-wide ' + row.cls + '">' + esc(row.text) + '</button>';
  }

  /* 哪些行这一趟摆得出来。onlyBcLive＝External Extension 没在这页上跑就不摆（点它只会回一句没找到），
     orRecorded＝只要曾记录过 BC 主题也摆（即使 BC 已经关闭，用户也能在两者间切换），
     onlyClash＝只有两套同时在刷这一页时才摆（没抢起来就不用挑一份来定） */
  function visibleRows(g) {
    var h = store();
    var live = h && h.bcxBcLive ? h.bcxBcLive() : false;
    var recorded = hasRecordedTheme();
    var clash = h && h.mcThemeClash ? h.mcThemeClash() : false;
    return (g.rows || []).filter(function (r) {
      var liveOk = !r.onlyBcLive || live || (r.orRecorded && recorded);
      return liveOk && (!r.onlyClash || clash);
    });
  }

  // 一行都不剩的那一组整档撤掉：留着就是一块空的粉框子，左栏那颗点了也没地方滚
  function listedGroups() {
    return GROUPS.filter(function (g) { return g.view || visibleRows(g).length; });
  }

  // BC 不在时 Theme 那一档整档没了，"当前是哪一组"的退路不能写死 'theme'（那样一颗都不亮）
  function firstSectionId() {
    var g = listedGroups().filter(function (x) { return !x.view; })[0];
    return g ? g.id : '';
  }

  function groupHtml(g) {
    // clip＝卡里有一颗整行按钮：它按下时铺的那一层底色是方的，不裁就顶出卡的圆角
    return '<div class="mc-set-group' + (g.card === 'actions' || g.clip ? ' mc-set-actions' : '') + '">' +
      visibleRows(g).map(rowHtml).join('') + '</div>';
  }

  /* 那一屏在滚动流里只留一颗门。它不挂 .mc-set-sec：左栏的滚动判据和 tailRoom 量的都是
     "能滚过去的那一组"，而这一颗点了是换屏，不是滚过去 */
  function entryHtml(g) {
    return '<section class="mc-set-entry">' +
      '<div class="mc-set-eyebrow">' + esc(g.title) + '</div>' +
      '<div class="mc-set-group">' +
        '<button type="button" class="mc-set-btn mc-set-wide ' + g.entryCls + '">' + esc(g.entryText) + '</button>' +
      '</div>' +
    '</section>';
  }

  function sectionsHtml() {
    var h = store();
    var ink = h && h.getInkFix ? h.getInkFix() : '';
    return listedGroups().map(function (g) {
      if (g.view) return entryHtml(g);
      return '<section class="mc-set-sec" data-sec="' + g.id + '">' +
        '<div class="mc-set-eyebrow">' + esc(g.title) + '</div>' +
        groupHtml(g) +
      '</section>';
    }).join('<div class="mc-set-gap"></div>') +
      (ink ? '<div class="mc-set-note">Text is ' + esc(ink) + ' instead of the theme colour. The theme colour was too faint to read on the cards.</div>' : '');
  }

  function themesViewHtml() {
    var h = store();
    var value = h ? h.ctsMeta('theme_sort').text[h.modernSetting('theme_sort')] : '';
    var items = h ? h.ctsMenuHtml('theme_sort') : '';
    return '<div class="btx-bar">' +
        '<button type="button" class="btx-back btx-ctl" aria-label="Back">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.8 6.2 9 12l5.8 5.8"/></svg>' +
        '</button>' +
        '<div class="btx-title">Theme Picker</div>' +
        '<div class="btx-tools">' +
          '<input type="text" class="btx-search btx-ctl" placeholder="Search name or author" autocomplete="off" spellcheck="false" aria-label="Search themes">' +
          '<div class="cts-select-row btx-sort">' +
            '<div class="cts-select btx-ctl" data-select="theme_sort">' +
              '<span class="cts-select-value">' + esc(value) + '</span>' +
              '<svg class="cts-select-arrow" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
              '<div class="cts-menu">' + items + '</div>' +
            '</div>' +
          '</div>' +
          // 和 Colours 那一屏那颗同一通路（共用同一个文件框），导入完跳到 Colours 那屏看结果
          // New theme 是自建主题的入口（库和翻译在 theme-lib.js），建完落进同一批存档
          '<button type="button" class="mc-set-btn btx-ctl mc-mk-new">New theme</button>' +
          '<button type="button" class="mc-set-btn btx-ctl mc-set-import">Import JSON</button>' +
        '</div>' +
      '</div>' +
      btxNoticeHtml(h) +
      '<div class="btx-body"></div>' +
      '<div class="btx-foot"></div>';
  }

  /* 只在"BC 在跑 且 页面这一层归我们"时摆这一条。这时候两边都还在刷同一层，
     他刚挑完我们的主题，得当场知道还差一步：去它自己的设置里把它那层关掉。
     那颗键点下去开的是它的设置（[BCP69] 那颗齿轮我们点得动），不是浏览器的扩展页，
     也不自动跳：他得自己按 */
  function btxNoticeHtml(h) {
    if (!h || !h.bcxBcLive || !h.bcxBcLive()) return '';
    if (!h.mcPageThemeOwner || h.mcPageThemeOwner() !== 'mc') return '';
    return '<div class="btx-notice">' +
      '<div class="btx-notice-text"><span class="btx-count"></span>' +
      'External extension is still painting this page while it runs. Open its settings and turn its theme off there, so only one theme shows.</div>' +
      '<button type="button" class="mc-set-btn mc-set-bc-settings">Open BetterCampus Settings</button>' +
      '</div>';
  }

  function shellHtml() {
    var nav = listedGroups().map(function (g) {
      return '<button type="button" class="mc-set-nav-btn" data-nav="' + g.id + '"' +
        (g.view ? ' data-view="' + g.id + '"' : '') + '>' + esc(g.title) + '</button>';
    }).join('');
    return '<div class="mc-set-card" role="dialog" aria-modal="true" aria-label="Settings">' +
      '<div class="mc-set-head">' +
        '<div class="mc-set-title">Settings</div>' +
        '<button type="button" class="mc-set-close" aria-label="Close settings">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6.8 6.8 17.2 17.2M17.2 6.8 6.8 17.2"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="mc-set-body">' +
        '<nav class="mc-set-nav">' + nav + '</nav>' +
        '<div class="mc-set-main">' +
          '<div class="mc-set-view mc-set-view-settings">' + sectionsHtml() + '</div>' +
          '<div class="mc-set-view mc-set-view-colours" hidden>' + coloursViewHtml() + '</div>' +
          '<div class="mc-set-view mc-set-view-themes" hidden>' + themesViewHtml() + '</div>' +
          // 自建主题那一屏：壳子常驻，里面每一步每次点开重搭（和 Colours 同一做法）
          '<div class="mc-set-view mc-set-view-maker" hidden></div>' +
          // 课程卡那三行的自定义那一屏：里面那张表每次点开重读（课是 Canvas 给的，会多会少），
          // 但那一屏的壳要在 bindChecks 之前先摆好，不然那颗送名字的勾没人绑
          '<div class="mc-set-view mc-set-view-cardtext" hidden></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ==== 生效：和老弹窗逐条对齐，少跑一条就是"这里改了、页面上没动" ==== */

  function afterCheck(key) {
    var h = store();
    if (!h) return;
    // 翻一档就可能有一句说明从一行变两行，下面每一组的位置跟着挪
    invalidateSectionTops();
    // 他自己拧过这一格＝以后每次加载第一轮都别替他改（modernGradePills 里那条跟随要读这颗）
    if (key === 'mc_dash_grades') localStorage.setItem('mc_dash_grade_touched', '1');
    h.step('applyLogoSettings', h.applyLogoSettings);
    h.step('applyModernPalette', h.applyModernPalette);
    h.step('modernGradePills', h.modernGradePills);
    h.step('mountSidebarCourses', h.mountSidebarCourses);
    // 卡片分数那两行谁按得动跟着现场重算（上一行才把 modernGradePills 跑过）
    syncGradeRows();
    if (key === 'bcx_bc_todo') {
      localStorage.setItem('bcx_bc_todo_asked', '1');
      h.step('hideBcTodo', h.hideBcTodo);
    }
    // 这颗开关一翻，说明那句要跟着翻（它讲的是屏幕上看得见的那件事）
    if (key === 'mc_nav_blur') {
      var bnote = p.overlay.querySelector('[data-note="mc_nav_blur"]');
      if (bnote) bnote.textContent = navBlurNote();
    }
    // AI 那一档的两行说明也跟着翻。侧栏那颗入口是造壳那一层管的，
    // 这里立刻重跑一次造壳，省得"勾已经没了、那一行还挂在侧栏上"
    if (key === 'mc_ai_entry') {
      var ain = p.overlay.querySelector('[data-note="mc_ai_entry"]');
      if (ain) ain.textContent = aiEntryNote();
      if (key === 'mc_ai_entry' && window.mcNav && window.mcNav.ensureRows) window.mcNav.ensureRows();
    }
    // 排版那一档翻完，说明那句要跟着翻，已经摆在结果屏上的那份也要当场重排一次：
    // 不然他关了设置回到抽屉，看到的还是旧的那一档
    if (key === 'mc_ai_format') {
      var fmtNote = p.overlay.querySelector('[data-note="mc_ai_format"]');
      if (fmtNote) fmtNote.textContent = aiFormatNote();
      if (window.MCxStudy && window.MCxStudy.refresh) window.MCxStudy.refresh();
    }
    // 读扫描件那一句也讲的是屏幕上少不少一段字，翻完得跟着翻（上面那句注释早就说了两行都要翻）
    if (key === 'mc_ai_ocr') {
      var onote = p.overlay.querySelector('[data-note="mc_ai_ocr"]');
      if (onote) onote.textContent = aiOcrNote();
    }
    /* 这一排四颗都是"当场就要在页面上看到"的：面板占哪一段、页面让哪几列、
       右侧那一列折不折。算式全在 study-panel.js 那一份里，这里只叫它重算一趟，
       面板没开过也要叫（那一列的档子和面板开不开没关系） */
    if (key === 'mc_ai_push' || key === 'mc_ai_fold_menu' || key === 'mc_ai_tuck_nav' || key === 'mc_ai_todo_tab') {
      if (window.MCxStudy && window.MCxStudy.layout) window.MCxStudy.layout();
      // 那一句说明讲的第一件事就是"页面让不让位"，这颗翻了它得跟着翻
      if (key === 'mc_ai_push') {
        var lnote = p.overlay.querySelector('[data-note="mc_ai_push"]');
        if (lnote) lnote.textContent = aiLayoutNote();
      }
    }
    // 打勾落点：说明行讲的是这一档看得见的那个变化，所以它得跟着翻；
    // 列表也要当场重算，不然切到只本地那一档时旧的服务端状态还挂在屏上
    if (key === 'mc_todo_canvas') {
      var note = p.overlay.querySelector('[data-note="mc_todo_canvas"]');
      if (note) note.textContent = btxTickNote();
      if (h.mcTickLog) h.mcTickLog('设置翻了这一档', 'mc_todo_canvas =', localStorage.getItem('mc_todo_canvas'), localStorage.getItem('mc_todo_canvas') === '0' ? '只本地' : '同步到 Canvas');
      h.step('updatePanelDom', h.updatePanelDom);
    }
    if (key === 'mc_dash_widget_cover') {
      localStorage.setItem('bc_dash_widget_cover', localStorage.getItem('mc_dash_widget_cover'));
    }
    if (key === 'mc_dash_focus_card' || key === 'mc_dash_widget_focus' || key === 'mc_dash_widget_grades' || key === 'mc_dash_widget_cover') {
      if (window.MCxFocus && window.MCxFocus.canvasPass) window.MCxFocus.canvasPass();
      if (window.MCxGrading && window.MCxGrading.syncWidgets) window.MCxGrading.syncWidgets();
      refreshWidgetModesUi();
    }
    if (key === 'bc_keep_footer') {
      var fnote = p.overlay.querySelector('[data-note="bc_keep_footer_note"]');
      if (fnote) fnote.textContent = btxFooterNote();
    }
    // 右上角那条更新提示：面板开着的时候页面那趟 300 毫秒的轮询是停的，
    // 所以翻完当场叫一次，不然就是"勾已经没了、那条还挂在右上角"
    if (key === 'mc_update_hint') {
      var uhn = p.overlay.querySelector('[data-note="mc_update_hint"]');
      if (uhn) uhn.textContent = btxUpdateHintNote();
      h.step('mcUpdateHint', h.mcUpdateHint);
    }
    // Inbox 那一列整棵是我们自己加的节点，翻一下当场接上或摘掉，不用他刷新
    if (key === 'mc_inbox_new_ui') {
      var inote = p.overlay.querySelector('[data-note="mc_inbox_new_ui"]');
      if (inote) inote.textContent = btxInboxNote();
      if (window.mcxInboxSet) window.mcxInboxSet();
    }
    // 摘要那一块只重画阅读栏就行：列表那一棵没有它的东西，翻它不该闪一下整列
    if (key === 'mc_inbox_ai') {
      var anote = p.overlay.querySelector('[data-note="mc_inbox_ai"]');
      if (anote) anote.textContent = btxInboxAiNote();
      if (window.mcxInboxHost && window.mcxInboxHost.detail && window.mcxInboxHost.detail()) window.mcxInboxHost.paintPane();
    }
    // 卡片上那块 Tasks：翻一下就是每张卡那一整块上不上屏（BC 补在同一处的那段跟着让位），
    // 所以当场重搭一次，不等那条 1500 毫秒的轮询
    if (key === 'mc_dash_tasks') {
      var dnote = p.overlay.querySelector('[data-note="mc_dash_tasks"]');
      if (dnote) dnote.textContent = btxDashTasksNote();
      h.step('mcCardTasks', h.mcCardTasks);
    }
    /* 卡上那三行的显隐：藏行是挂在 <html> 上的类名，卡片本身不用重搭，叫一次生效那一趟就行。
       面板开着的时候页面那条 300 毫秒的轮询是停的（mcScheduleUiPass 挡的），
       所以这里必须自己叫，不然就是"勾已经翻了、卡上那行还在" */
    if (CARD_LINE_KEYS[key]) {
      var lnote = p.overlay.querySelector('[data-note="card_lines"]');
      if (lnote) lnote.textContent = cardLinesNote();
      h.step('mcCardTextApply', h.mcCardTextApply);
    }
    /* 送名字那一颗一翻就要当场把话说清：翻到开＝把已经写下的名字整批送一次并回读，
       翻到关＝只是以后不再送，Canvas 已经改掉的那些留着（撤它们得他自己在 Course info 里点清除） */
    if (key === 'mc_card_name_sync') {
      var snote = p.overlay.querySelector('[data-note="mc_card_name_sync"]');
      if (snote) snote.textContent = cardTextSyncNote();
      if (h.mcCardNameSyncOn && h.mcCardNameSyncOn()) {
        ctState('Sending the names you have typed to Canvas.');
        h.mcNicknameSyncAll().then(function (list) {
          if (!p || !p.cardtext) return;
          var bad = list.filter(function (x) { return !x.ok; }).length;
          if (!list.length) ctState('Nothing is typed in a name box yet, so there is nothing to send.');
          else if (!bad) ctState('Sent ' + list.length + ' name' + (list.length === 1 ? '' : 's')
            + ' to Canvas. Every Canvas screen now uses them.');
          else ctState('Sent ' + (list.length - bad) + ' of ' + list.length + '. ' + bad
            + ' did not go through, so those cards show your words only on this browser.');
        });
      } else {
        ctState('Stopped sending names. What Canvas already holds stays as it is.');
      }
    }
    // 过期那一批要不要露脸：列表当场重算，说明跟着翻
    if (key === 'mc_show_missing') {
      var mnote = p.overlay.querySelector('[data-note="mc_show_missing"]');
      if (mnote) mnote.textContent = btxMissingNote();
      h.step('updatePanelDom', h.updatePanelDom);
    }
    // 兜底开关一翻，页面上的翻色当场重算（上面那条 applyModernPalette 已经跑了），
    // 面板这边要跟着换的是那句说明和每一行后面的小提示
    if (key === 'mc_set_theme_flip') {
      var fnote = p.overlay.querySelector('[data-note="mc_set_theme_flip"]');
      if (fnote) fnote.textContent = flipNoteHtml();
      renderColours();
    }
    // 这颗开关一翻，Accent 那一行"这一档管到哪儿"的说话就变了，跟着重排一次
    if (key === 'mc_link_accent') renderColours();
    /* AI 总开关：先重画这一张卡（底下那一屏跟着收或回，说明句照新档位重出），
       再动页面上那几处入口。顺序是有意的：卡这一趟只碰设置里那一段，
       页面那一趟哪一处抛了都不该把已经该看见的东西留在旧画面上 */
    if (key === 'mc_ai_enabled') {
      repaintAiGroup();
      applyAiMaster();
    }
  }

  /* 弹窗问"要不要切到 Canvas 那一档"时，键在调进这里之前已经被写过一次了，
     所以不切就得把这一档整个摆回上一档：键、那颗显示的字、还有菜单里打勾的那一条。
     只改前两份的话下次打开菜单勾是错的 */
  function revertTierSelect(prev) {
    var h = store();
    var back = prev === 'canvas' || prev === '1' || prev === '2' || prev === '3' ? prev : '1';
    localStorage.setItem('bc_colour_tier', back);
    var sel = p.colors ? p.colors.querySelector('[data-select="colour_tier"]') : null;
    if (!sel || !h || !h.ctsMeta) return;
    var meta = h.ctsMeta('colour_tier');
    sel.querySelector('.cts-select-value').textContent = (meta && meta.text ? meta.text[back] : '') || back;
    if (h.ctsMenuHtml) sel.querySelector('.cts-menu').innerHTML = h.ctsMenuHtml('colour_tier');
  }

  function afterSelect(key, value, prev) {
    var h = store();
    if (!h) return;
    if (key === 'theme_sort') {
      btx.page = 1;
      // Let the selected menu finish its close animation before the list replaces its DOM.
      setTimeout(renderThemeList, MENU_CLOSE_MS);
      return;
    }
    /* 换档位＝整屏的色换一份。我们写进行内的色、贴出去的那份表和逐层的底色钩子是一层层叠上来的，
       当场逐条摘总会留几处（原生样式被我们盖过的那几层回不去），所以直接帮他重读一次页面。
       空的那一格由 mcSetTier 在落盘之前照抄另一格主题的原始色 */
    if (key === 'colour_tier') {
      if (h.mcSetTier) h.mcSetTier(value, prev);
      setTimeout(function () { location.reload(); }, MENU_CLOSE_MS);
      return;
    }
    // 换"页面那一层归谁刷"：整屏所有图层、样式表与底色接管必须干净重载生效。
    if (key === 'theme_owner') {
      if (value === 'mc') {
        var currentTier = localStorage.getItem('bc_colour_tier');
        if (!currentTier || currentTier === 'canvas') {
          sessionStorage.setItem('mc_auto_open_themes', '1');
        }
      }
      setTimeout(function () { location.reload(); }, MENU_CLOSE_MS);
      return;
    }
    h.step('applyLogoSettings', h.applyLogoSettings);
    h.step('updatePanelDom', h.updatePanelDom);
    // 换这一档就是换"卡片那一格归谁"，两行的按不动态和说明都得跟着翻，
    // 而且 applyLogoSettings 刚把 html 上的类名挂好，藏它那棵的规则当场就生效
    syncGradeRows();
    // 这一档的说明最后一句报的就是"现在哪一档在生效"，翻完当场得跟着换，不能等他重开面板
    if (key === 'course_colour') {
      var colnote = p.overlay.querySelector('[data-note="course_colour"]');
      if (colnote) colnote.textContent = btxCourseColourNote();
    }
    // 这一档的说明讲的正是"摆进来以后只能自己点勾"，所以它得跟着翻；列表上面已经重算过了
    if (key === 'missing_on_paper') {
      var pnote = p.overlay.querySelector('[data-note="missing_on_paper"]');
      if (pnote) pnote.textContent = btxOnPaperNote();
    }
    // 卡片排列方式当场重排，不等那 1.5 秒的轮询
    if (key === 'card_layout') h.step('mcMasonryLayout', h.mcMasonryLayout);
    if (key === 'dash_widget_layout' || key === 'gpa_score_display') {
      if (window.MCxFocus && window.MCxFocus.canvasPass) window.MCxFocus.canvasPass();
      if (window.MCxGrading && window.MCxGrading.syncWidgets) window.MCxGrading.syncWidgets();
    }
    // 面板形态和停靠那一边换了就是它占掉的那一段宽换了：页面当场挪回去，不等他重新载入。
    // 换成悬浮窗那一头也要跑这一趟，不然它还是按停靠那一档钉在屏幕边上
    if (key === 'ai_panel_mode' || key === 'ai_panel_side') {
      if (window.MCxStudy && window.MCxStudy.layout) window.MCxStudy.layout();
    }
    /* 深浅色也整屏重读一次。这一档翻下去要动的不只是一层类名：深色那一档活着时取色轮会把
       第 36 节的色抄成 html 上的行内 --mc-*，行内权重最高，当场只摘类名压不回去，
       所以旧的当场重算那条撤掉了（见下面注释掉的那一行）。键在 bindSelects 里已经写过，
       theme-boot.js 首帧就按新值挂类名 */
    if (key === 'colour_mode') {
      setTimeout(function () { location.reload(); }, MENU_CLOSE_MS);
      return;
    }
    // if (key === 'colour_mode') h.step('applyModernPalette', h.applyModernPalette);
    // 回看窗口跟着 MISSING 那档变长了，缓存里最早那批读不到那么早的过期项，重拉一次
    if (key === 'missing_range' && localStorage.getItem('mc_show_missing') !== '0') {
      h.step('fetchPlannerData', h.fetchPlannerData);
    }
  }

  /* 只重画 AI & Plans 那一张卡，不重画整屏：整屏一换他就看不见自己滚到哪儿了。
     那颗勾在换掉的这一张里，按下去的是它自己，所以换完要把焦点还回去，
     不然键盘上用的人一按完就掉出这一屏 */
  function repaintAiGroup() {
    if (!p || !p.overlay) return;
    var g = GROUPS.filter(function (x) { return x.id === 'ai'; })[0];
    var card = p.overlay.querySelector('.mc-set-sec[data-sec="ai"] .mc-set-group');
    if (!g || !card) return;
    var hadFocus = document.activeElement && document.activeElement.getAttribute
      ? document.activeElement.getAttribute('data-setting') === 'mc_ai_enabled' : false;
    card.innerHTML = visibleRows(g).map(rowHtml).join('');
    /* 这一张卡里那颗勾是刚造出来的节点，监听器不会跟着 innerHTML 过来。
       只补这一张卡，不重跑 bindChecks：整屏重绑会让别处每一颗勾都绑上两次，
       那意味着按一次跑两趟（送名字那一颗会真发两批请求） */
    card.querySelectorAll('.mc-set-row input[type="checkbox"][data-setting]').forEach(bindOneCheck);
    if (hadFocus) {
      var again = card.querySelector('input[data-setting="mc_ai_enabled"]');
      if (again) again.focus();
    }
  }

  /* 翻完这一颗，页面上已经挂在的那些入口要立刻跟着变。
     每一处都叫它自己那份拆除／重建的活，这里不另写第二套：
     侧栏那一行归 nav-boot 那颗引擎（ensureRows 会按 mcAiOn 决定画不画），
     那张作业卡自己会 abort 在飞的请求，收件箱那块板由它自己重画整栏。
     每一处单独罩住：这几棵分属四份文件，任何一份在这一页上没起来（或它自己抛）
     都不该把后面那几处一起带走，更不该把上面 repaintAiGroup 已经画好的那一屏顶回去 */
  function applyAiMaster() {
    function step(fn) { try { if (fn) fn(); } catch (e) {} }
    var off = window.mcAiOn && !window.mcAiOn();
    if (off) {
      step(function () {
        var row = document.querySelector('.mc-nav-study-item');
        if (row) row.remove();
      });
      step(function () { window.MCxStudy.close(); });
      step(function () { window.MCxAssignGuide.teardown(); });
      step(function () { window.mcxInboxAi.refresh(); });
    } else {
      step(function () { window.mcNav.ensureRows(); });
      step(function () { window.MCxAssignGuide.boot(); });
      step(function () { window.mcxInboxAi.refresh(); });
    }
    // 那一行摘掉或摆回来之后，剩下的行要按他排好的顺序重新占位
    step(function () { window.mcNav.apply(); });
  }

  /* 一颗勾从按下去到落盘这一整趟。单独成一个函数是因为重画过的那张卡里是一颗新节点：
     监听器挂在旧节点上，第二下就点不动了（症状是"翻回去要重开设置才认"）。
     所以凡是换过 innerHTML 的那张卡，都要照这个函数把里面那几颗重新绑一次 */
  function onCheckChange(input) {
    var key = input.getAttribute('data-setting');
    var value = input.checked ? '1' : '0';
    // 卡上那三行不许全关掉。这一颗按下去会让卡片没有字的，直接弹回勾着的样子，
    // 再把下面那句说明换成点名这一颗的话，四秒后自己回去
    if (CARD_LINE_KEYS[key] && value === '0' && cardLinesLeft().length <= 1) {
      input.checked = true;
      flashCardLinesNote();
      return;
    }
    localStorage.setItem(key, value);
    // 那两颗 AI 开关的正本在扩展自己的存储里，页面这一头只是给同步读数用的影子
    if (AI_MIRROR_KEYS[key] && window.MCxStorage) window.MCxStorage.set(key, value);
    afterCheck(key);
  }

  function bindOneCheck(input) {
    input.addEventListener('change', function () { onCheckChange(input); });
  }

  function bindWidgetModeChecks(root) {
    var target = root || (p && p.overlay);
    if (!target) return;
    target.querySelectorAll('input[type="checkbox"][data-wm-widget]').forEach(function (input) {
      input.addEventListener('change', function () {
        var widget = input.getAttribute('data-wm-widget');
        var loc = input.getAttribute('data-wm-target');
        var isChecked = input.checked;
        var newLoc = isChecked ? loc : 'off';
        setWidgetLocation(widget, newLoc);
        if (window.MCxFocus && window.MCxFocus.canvasPass) window.MCxFocus.canvasPass();
        if (window.MCxGrading && window.MCxGrading.syncWidgets) window.MCxGrading.syncWidgets();
        refreshWidgetModesUi();
        // 两张虚拟卡都完成插入/移除后再量高度并重排，避免只把后续卡片推下去。
        if (window.mcHost && window.mcHost.mcQueueMasonryLayout) window.mcHost.mcQueueMasonryLayout(true);
        else if (window.mcHost && window.mcHost.mcReflowMasonryLayout) window.requestAnimationFrame(function () { window.mcHost.mcReflowMasonryLayout(); });
        else if (window.mcHost && window.mcHost.mcMasonryLayout) window.requestAnimationFrame(function () { window.mcHost.mcMasonryLayout(); });
      });
    });
  }

  function bindChecks() {
    // 点名 checkbox：那条选择器原来只圈得到勾，现在同一层里有了文本行，
    // 不点名的话文本框也会被绑上这条，写进去的是 input.checked（文本框没有这个）＝'0'
    p.overlay.querySelectorAll('.mc-set-row input[type="checkbox"][data-setting]').forEach(bindOneCheck);
    bindWidgetModeChecks(p.overlay);
  }

  function bindTexts() {
    p.overlay.querySelectorAll('.mc-set-row input[type="text"][data-setting]').forEach(function (input) {
      var key = input.getAttribute('data-setting');
      if (aiStoredKey(key)) {
        /* 这三格只往扩展自己的存储里写。以前它们写页面存储，而且 key 那一格连 input 都写：
           他每敲一下，Canvas 那一页就多一份明文钥匙 */
        input.addEventListener('change', function () {
          var value = input.value.trim();
          if (window.MCxAi) window.MCxAi.setSetting(key, value);
        });
        return;
      }
      input.addEventListener('change', function () {
        var value = input.value.trim();
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
        /* 宽度那一格写的必须是屏幕上真长出来的那一段：太窄太宽都会被按屏幕收一档，
           收完把真的那一个数填回这一格，别让它说着 2000 而面板其实只有 1200 */
        if (key === 'mc_ai_panel_w') {
          if (window.MCxStudy && window.MCxStudy.layout) window.MCxStudy.layout();
          var used = window.MCxStudy && window.MCxStudy.width ? window.MCxStudy.width() : 0;
          if (used) {
            localStorage.setItem(key, String(used));
            input.value = String(used);
          }
        }
      });
    });

    bindAiStorageRows();
  }

  /* 读数是异步的：面板可能比库里那几格先画好。所以那三格先摆成"正在读"（按不动、话写在框里），
     真读回来了再整屏重画一次，把值填进去、把依赖读数的那几句说明重算一遍。
     不按住的话他打进去的字会被晚到的读数盖掉，那正是"改了 key 还是 401"的成因 */
  function bindAiStorageRows() {
    var ov = p && p.overlay;
    if (!ov) return;

    function ready() {
      if (!p || !p.overlay || p.overlay !== ov) return;
      aiRepaint();
      setNote('[data-note="mc_ai_privacy"]', aiPrivacyNote());
      setNote('[data-note="mc_ai_accounts"]', aiAccountsNote());
      setNote('[data-note="mc_ai_chats"]', aiHistoryNote());
      setNote('[data-note="mc_ai_progress"]', aiProgressNote());
      repaintRetention();
    }

    var waits = [];
    if (window.MCxAi && window.MCxAi.load) waits.push(window.MCxAi.load());
    if (window.MCxHistory && window.MCxHistory.hydrate) waits.push(window.MCxHistory.hydrate());
    if (window.MCxProgress && window.MCxProgress.hydrate) waits.push(window.MCxProgress.hydrate());
    if (!waits.length) return;
    Promise.all(waits).then(ready, ready);
  }

  function setNote(selector, text) {
    if (!p || !p.overlay) return;
    var node = p.overlay.querySelector(selector);
    if (node) node.textContent = text;
  }

  /* 保留期那一排只换药丸的亮档和顶上那一句读数，不重建整块：
     重建会把他刚点的那颗节点变成游离节点，下一颗就按不动了 */
  function repaintRetention() {
    if (!p || !p.overlay || !window.MCxHistory) return;
    var cur = Number(window.MCxHistory.retentionDays());
    p.overlay.querySelectorAll('[data-retention]').forEach(function (btn) {
      btn.classList.toggle('is-active', Number(btn.getAttribute('data-retention')) === cur);
    });
    var now = p.overlay.querySelector('[data-retention-current]');
    if (now) now.textContent = retentionLabel(cur).toUpperCase();
    setNote('[data-note="mc_ai_retention"]', aiRetentionNote());
    setNote('[data-note="mc_ai_chats"]', aiHistoryNote());
  }

  function closeSelectRow(row) {
    if (!row) return;
    if (row._mcSetCloseTimer) { clearTimeout(row._mcSetCloseTimer); row._mcSetCloseTimer = null; }
    if (!row.classList.contains('open') && !row.classList.contains('closing')) return;
    row.classList.remove('open');
    row.classList.add('closing');
    row._mcSetCloseTimer = setTimeout(function () {
      row._mcSetCloseTimer = null;
      row.classList.remove('closing');
    }, MENU_CLOSE_MS);
  }

  function openSelectRow(row) {
    if (!row) return;
    if (row._mcSetCloseTimer) { clearTimeout(row._mcSetCloseTimer); row._mcSetCloseTimer = null; }
    row.classList.remove('closing');
    row.classList.add('open');
  }

  function refreshWidgetModesUi() {
    if (!p || !p.overlay) return;
    var container = p.overlay.querySelector('.mcx-wm-container');
    if (!container) return;
    var temp = document.createElement('div');
    temp.innerHTML = widgetModesRowHtml();
    var next = temp.firstChild;
    container.parentNode.replaceChild(next, container);
    next.querySelectorAll('.mc-set-row input[type="checkbox"][data-setting]').forEach(bindOneCheck);
    bindWidgetModeChecks(next);
  }

  function bindSelects() {
    // 委托绑：选中一项以后菜单整块换掉，逐条绑的那份就没了
    p.overlay.addEventListener('click', function (e) {
      var h = store();
      var item = e.target.closest ? e.target.closest('.cts-menu-item') : null;
      if (item && h) {
        var srow = item.closest('.cts-select-row');
        if (srow) {
          e.stopPropagation();
          var sel = srow.querySelector('.cts-select');
          var key = sel.getAttribute('data-select');
          var value = item.getAttribute('data-value');
          // 上一档先抄一份：afterSelect 里要知道"从哪一格切过来"（换档位要照抄那份的原始色），
          // 而这一行写完就读不到旧值了
          var prev = localStorage.getItem('bc_' + key);
          localStorage.setItem('bc_' + key, value);
          sel.querySelector('.cts-select-value').textContent = h.ctsMeta(key).text[value];
          sel.querySelector('.cts-menu').innerHTML = h.ctsMenuHtml(key);
          closeSelectRow(srow);
          afterSelect(key, value, prev);
          return;
        }
      }
      var row = e.target.closest ? e.target.closest('.cts-select-row') : null;
      if (!p || !p.overlay) return;
      if (!row) {
        // 点击其它区域时，关闭所有展开的常规下拉菜单（AI 那一屏自己管它那些菜单）
        p.overlay.querySelectorAll('.cts-select-row.open').forEach(closeSelectRow);
        return;
      }
      // 按不动的那一行不弹菜单。现在只剩一种成因（这一格的色是那份主题给的），
      // 点它什么都不弹：那边没有任何可做的动作，原因已经写在同一行下面
      if (row.classList.contains('mc-set-off')) return;
      var wasOpen = row.classList.contains('open');
      p.overlay.querySelectorAll('.cts-select-row.open').forEach(closeSelectRow);
      if (!wasOpen) openSelectRow(row);
      e.stopPropagation();
    });
  }

  /* 顶上那颗 "Use theme colours"：把正在用的这一格回到那份主题本来的颜色。
     这一按会清掉他亲手拧的那几档，所以先弹一次确认，而且要点名是哪一份主题——
     "默认"在这套里有两种东西（Canvas 自己的色／这份主题自带的色），只有名字能确定是哪个。
     弹窗用这座面板一直在用的那一家（bc-modal-*），不用浏览器原生 confirm */
  /* onAlt 可以省：省了就是那颗副键只关弹窗（以前所有调用处都是这个行为）。
     有的告示只是"提醒一句"，副键要能"知道，照样做"，那种就把动作传进来 */
  function btxAsk(id, title, note, okText, altText, onOk, onAlt) {
    if (document.getElementById(id)) return;
    var overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'bc-modal-overlay';
    // 只给一句话的告示（存不下了这种）没有第二个选择，就不摆那颗多余的键
    overlay.innerHTML =
      '<div class="bc-modal-card" role="dialog" aria-label="' + esc(title) + '">' +
        '<div class="bc-modal-title">' + esc(title) + '</div>' +
        '<div class="bc-modal-note">' + esc(note) + '</div>' +
        '<button type="button" class="cts-sync-btn" data-ask="ok">' + esc(okText) + '</button>' +
        (altText ? '<button type="button" class="cts-sync-btn mc-modal-alt" data-ask="no">' + esc(altText) + '</button>' : '') +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    var close = function () {
      overlay.classList.remove('open');
      setTimeout(function () { overlay.remove(); }, 240);
    };
    overlay.querySelector('[data-ask="ok"]').addEventListener('click', function () {
      close();
      onOk();
    });
    var alt = overlay.querySelector('[data-ask="no"]');
    if (alt) alt.addEventListener('click', function () {
      close();
      if (onAlt) onAlt();
    });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  }

  function promptSwitchCanvasLighting(onChosen) {
    var id = 'mcx-canvas-lighting-modal';
    if (document.getElementById(id)) return;
    var overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'bc-modal-overlay';
    overlay.innerHTML =
      '<div class="bc-modal-card" role="dialog" aria-label="Switch to Canvas colours">' +
        '<div class="bc-modal-title">Switch to Canvas colours</div>' +
        '<div class="bc-modal-note">Choose your preferred lighting for Canvas. You can change between them at any time.</div>' +
        '<div class="mc-mode-opts">' +
          '<div class="mc-mode-opt" data-mode="light">' +
            '<span>Light Mode</span>' +
            '<span class="mc-mode-opt-sub">Canvas original colours</span>' +
          '</div>' +
          '<div class="mc-mode-opt" data-mode="dark">' +
            '<span>Dark Mode</span>' +
            '<span class="mc-mode-opt-sub">Modern Canvas dark tone</span>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="cts-sync-btn mc-modal-alt" data-ask="cancel">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    var close = function () {
      overlay.classList.remove('open');
      setTimeout(function () { overlay.remove(); }, 240);
    };
    overlay.querySelectorAll('.mc-mode-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        var mode = opt.getAttribute('data-mode') || 'light';
        close();
        onChosen(mode);
      });
    });
    var cancel = overlay.querySelector('[data-ask="cancel"]');
    if (cancel) cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  }

  function bindTheme() {
    var h = store();
    var file = p.overlay.querySelector('.mc-set-file');
    var status = p.overlay.querySelector('.mc-col-status');
    // 自建主题那颗门：只在主题墙顶上那一排摆（Colours 顶上那排已经撤了），仍按 forEach 绑
    p.overlay.querySelectorAll('.mc-mk-new').forEach(function (btn) {
      btn.addEventListener('click', function () { openMaker(null, 0); });
    });
    // 置顶切换按钮：在 Canvas 原生颜色和自定义主题之间切换
    var switchBtn = p.overlay.querySelector('.mc-col-switch-btn');
    if (switchBtn && h) {
      switchBtn.addEventListener('click', function () {
        var off = h.mcThemeOff ? h.mcThemeOff() : false;
        if (!off) {
          // 当前在使用自选主题，切换到 Canvas 原生颜色 -> 弹窗询问 Dark Mode 还是 Light Mode
          promptSwitchCanvasLighting(applyCanvasColours);
        } else {
          // 当前在使用 Canvas 原生，切换回自定义主题（优先切回最近的 Save 1）
          var info1 = h.mcSaveInfo ? h.mcSaveInfo(1) : null;
          var hasAnyTheme = (info1 && info1.tiered) || !!localStorage.getItem('mc_save_1') || !!localStorage.getItem('mc_save_2') || !!localStorage.getItem('mc_save_3');
          if (!hasAnyTheme) {
            // 没有选择过主题 -> 弹窗提示没有选择过 themes，询问是否前往 Theme Picker
            btxAsk('mcx-no-theme-prompt', 'No theme selected yet',
              "You haven't chosen a theme yet, so there are no custom theme colours to switch to. Would you like to check out the Theme Picker?",
              'Browse themes', 'Cancel', function () {
                showView('themes');
              });
            return;
          }
          var targetSlot = '1';
          if (h.mcSetTier) h.mcSetTier(targetSlot, 'canvas');
          else localStorage.setItem('bc_colour_tier', targetSlot);
          location.reload();
        }
      });
    }
    if (!file || !h) return;
    // 现在只剩主题墙顶上那一颗 Import JSON（Colours 顶上那排按他的要求撤了），
    // 但它点的还是这一屏里那个隐藏文件框，所以照旧 forEach：以后再加一颗不用再改这里
    p.overlay.querySelectorAll('.mc-set-import').forEach(function (importBtn) {
      importBtn.addEventListener('click', function () { file.value = ''; file.click(); });
    });
    // 那一屏底下那颗"改这份主题的贴图"：进去的是自建主题那两步，不是第二套编辑器
    var picsBtn = p.overlay.querySelector('.mc-col-pics');
    if (picsBtn) picsBtn.addEventListener('click', function () { openPicturesForThisSave(); });
    // 那一格有你拧过的色时这颗才在（renderColours 管它出不出），点它先弹确认
    var revert = p.overlay.querySelector('.mc-col-revert');
    if (revert && h) {
      revert.addEventListener('click', function () {
        var info = h.mcSaveInfo ? h.mcSaveInfo() : null;
        if (!info || !info.edits) return;
        btxAsk('mcx-revert-overlay', 'Reset theme colours',
          'Save ' + info.slot + ' goes back to the colours of ' + (info.title || 'this theme') +
          '. The ' + info.edits + (info.edits === 1 ? ' colour' : ' colours') + ' you changed here are reverted.',
          'Reset colours', 'Keep my colours', function () {
            h.step('mcResetSlotColors', function () { return h.mcResetSlotColors(); });
            h.step('applyModernPalette', h.applyModernPalette);
            renderColours();
          });
      });
    }
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        // 那份 JSON 有我们自建主题的标记就先交给库（里面带着贴图），不然它会被主题墙那条
        // 通路读成一份"只有色、没有图"的主题
        var custom = lib() ? lib().importJson(text) : null;
        if (custom) {
          var saved = lib().upsert(custom);
          if (!saved.ok) {
            if (status) { status.hidden = false; status.textContent = saved.error; }
            return;
          }
          showView('themes');
          openCustomDetail(saved.rec);
          return;
        }
        try {
          var imported = JSON.parse(text);
          // 先采侧栏那张图再落盘：Apply 完这一趟不刷新，取色轮当场要读到 samples 才不会先画白再翻黑
          bakeSidebarSamples(imported).then(function (full) {
            var snap = h.mcApplyThemeJson(full);
            // 导入完不当场要求刷新：这条通路和改色用的是同一份快照，跑一趟取色循环就画上
            h.step('applyModernPalette', h.applyModernPalette);
            h.step('updatePanelDom', h.updatePanelDom);
            if (status) {
              status.hidden = false;
              status.textContent = 'Applied. ' + Object.keys(snap.vars).length + ' colours, '
                + snap.dash.images.length + ' card images. Any of them you can now change below.';
            }
            // 从主题墙那一屏导入的，跳到 Colours 那一屏才看得到上面那句结果
            showView('colours');
            renderColours();
          });
        } catch (err) {
          if (status) {
            status.hidden = false;
            status.textContent = 'Could not read that file: ' + (err && err.message ? err.message : String(err));
          }
        }
      };
      reader.readAsText(f);
    });
  }

  /* 打开 BetterCampus 自己的设置。先试它面板里那颗齿轮（[BCP69]：那颗没有 aria-label 也没有文字，
     所以只能按 svg.lucide-settings 认），点不动才把它面板从隔离容器放回右侧栏让他自己点。
     "到底开没开成"只能等下一帧读它 portal 的高度，同步读它 React 还没画＝误报。
     btn 是那颗能改文案的键（面板里摆了两颗）；深浅色弹窗的主按钮没有位置写字，那边不传，
     失败就不出声，因为为什么开不了已经写在同一行下面了 */
  function openBcSettingsFrom(btn) {
    var h = store();
    if (!h) return;
    var label = btn ? btn.textContent : '';
    var fallback = function () {
      if (!h.revealBcPanel()) {
        if (btn) {
          btn.textContent = 'BetterCampus panel not found';
          setTimeout(function () { btn.textContent = label; }, 2500);
        }
        return;
      }
      close();
    };
    if (!h.clickBcGear()) { fallback(); return; }
    // 弹窗开启后，自动寻找并点击 Themes 选项卡直达主题页面
    var tries = 0;
    var navThemesTimer = setInterval(function () {
      tries++;
      if (h.clickBcThemesTab && h.clickBcThemesTab()) {
        clearInterval(navThemesTimer);
      }
      if (tries >= 15) {
        clearInterval(navThemesTimer);
      }
    }, 100);
    setTimeout(function () {
      if (!h.bcPopupOpen()) { fallback(); return; }
      close();
    }, 600);
  }

  function bindActions() {
    var h = store();
    var sync = p.overlay.querySelector('.mc-set-sync');
    if (sync && h) {
      sync.addEventListener('click', function () {
        if (h.isFetching()) return;
        var label = 'Sync now';
        var reset = function () {
          sync.textContent = label;
          sync.classList.remove('busy');
        };
        sync.textContent = 'Syncing…';
        sync.classList.add('busy');
        h.step('fetchPlannerData', h.fetchPlannerData);
        var restore = setInterval(function () {
          if (!h.isFetching()) { clearInterval(restore); reset(); }
        }, 200);
        setTimeout(function () { clearInterval(restore); reset(); }, 8000);
      });
    }

    // 手动全量迁移历史 bcx 数据（覆盖已有的 mc 变量）
    p.overlay.querySelectorAll('.mc-set-migrate-legacy, .mc-set-migrate-legacy').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = btn.textContent;
        var n = executeMigrateLegacy();
        btn.textContent = 'Migrated ' + n + ' item' + (n === 1 ? '' : 's') + '! Reloading...';
        btn.classList.add('busy');
        setTimeout(function () {
          location.reload();
        }, 800);
      });
    });

    // 它那颗齿轮能直接点（[BCP69]），点不动才退回"把它的面板放出来"那条老路子。
    // 这一颗现在在 Theme 组和 Actions 组各摆了一份，所以每一颗都要绑：
    // 只挑第一颗的话，另一颗点了没反应。通路抽成 openBcSettingsFrom，深浅色那颗弹窗也走它
    p.overlay.querySelectorAll('.mc-set-bc-settings').forEach(function (bc) {
      if (!h) return;
      bc.addEventListener('click', function () { openBcSettingsFrom(bc); });
    });

    // "打开我们的主题墙"有两处入口：Theme 组那一颗（两套在抢这一页时才摆，挑一份就是定下来用
    // 我们的），和滚动流里那颗门。两处点下去都走同一个 showView，不另写一套换屏
    p.overlay.querySelectorAll('.mc-set-open-themes').forEach(function (btn) {
      btn.addEventListener('click', function () { showView('themes'); });
    });
    p.overlay.querySelectorAll('.mc-set-open-colours').forEach(function (btn) {
      btn.addEventListener('click', function () { showView('colours'); });
    });
    p.overlay.querySelectorAll('.mc-set-open-cardtext').forEach(function (btn) {
      btn.addEventListener('click', function () { showView('cardtext'); });
    });
    p.overlay.querySelectorAll('.mc-set-open-grades').forEach(function (btn) {
      var activate = function () {
        close();
        if (window.MCxGrading && window.MCxGrading.openSettings) {
          window.MCxGrading.openSettings('appearance');
        } else {
          document.dispatchEvent(new CustomEvent('mcx-open-grading-settings', { detail: { tab: 'appearance' } }));
        }
      };
      btn.addEventListener('click', activate);
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });
    p.overlay.querySelectorAll('.mc-set-remote-content').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.dispatchEvent(new CustomEvent('mcx-open-remote-content', { detail: { source: 'settings' } }));
      });
    });

    /* 清历史要过一道确认弹窗（这一档里删东西一律不许用浏览器原生 confirm），
       删完那句读数要当场重算，不然屏幕上还写着"12 saved" */
    p.overlay.querySelectorAll('.mc-set-ai-clear').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.MCxHistory) return;
        var n = window.MCxHistory.count();
        var note = p.overlay.querySelector('[data-note="mc_ai_chats"]');
        if (!n) {
          if (note) note.textContent = 'Nothing is saved yet, so there is nothing to clear.';
          return;
        }
        showTwoChoiceModal('mcx-clear-chats', 'Clear saved chats?',
          'This deletes the ' + n + ' chat' + (n === 1 ? '' : 's') + ' this extension has saved on this computer. Nothing on Canvas changes.',
          'Cancel', 'Clear all', 'right',
          function () {
            var out = window.MCxHistory.clear();
            var fresh = p.overlay.querySelector('[data-note="mc_ai_chats"]');
            if (!fresh) return;
            // 库里那一格没摘干净时不许报"没了"：那一句会让人以为钥匙和历史都清了
            if (out.ok) fresh.textContent = aiHistoryNote();
            else fresh.textContent = 'Those chats are off this screen, but the extension storage would not take the clearing: '
              + String(out.error || 'it did not answer') + '.';
            if (out.done) out.done.then(function () {
              var again = p && p.overlay ? p.overlay.querySelector('[data-note="mc_ai_chats"]') : null;
              if (again) again.textContent = window.MCxHistory.lastWriteError()
                ? 'The saved chats are still in this extension\'s storage. The clearing did not go through.'
                : aiHistoryNote();
            });
          });
      });
    });

    p.overlay.querySelectorAll('.mc-set-ai-revoke-sharing').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.MCxStorage) return;
        window.MCxStorage.remove('mc_ai_consent_v1').then(function (result) {
          btn.textContent = result && result.ok ? 'Sharing approval revoked' : 'Could not revoke approval. Try again.';
        });
      });
    });

    /* 保留期那一排点药丸就换档：当场按新档清一次这本账，再把顶上那句读数和两句说明重算 */
    p.overlay.querySelectorAll('[data-retention]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.MCxHistory) return;
        var days = Number(btn.getAttribute('data-retention'));
        if (Number(window.MCxHistory.retentionDays()) === days) return;
        window.MCxHistory.setRetention(days).then(function (res) {
          repaintRetention();
          if (res && res.ok) return;
          var note = p && p.overlay ? p.overlay.querySelector('[data-note="mc_ai_retention"]') : null;
          if (note) {
            note.textContent = 'This change is held on this screen only. The extension storage would not take the write: '
              + String((res && res.error) || 'it did not answer') + '.';
          }
        });
      });
    });

    /* 清账户这一颗只管钥匙那三格，历史与练习一律不碰，也绝不挂到 Reset all settings & data 那一颗上：
       那颗会连主题一起抹，而他按这一颗的时候只想少一把钥匙 */
    p.overlay.querySelectorAll('.mc-set-ai-clear-accounts').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.MCxAi) return;
        if (!window.MCxAi.settingsLoaded || !window.MCxAi.settingsLoaded()) {
          var waiting = p.overlay.querySelector('[data-note="mc_ai_accounts"]');
          if (waiting) waiting.textContent = 'Still reading the AI model slots on this computer. Try again in a moment.';
          return;
        }
        var list = window.MCxAi.profiles().filter(function (a) { return a.base || a.key; });
        if (!list.length) {
          setNote('[data-note="mc_ai_accounts"]', 'Neither model slot has a key stored here, so there is nothing to clear.');
          return;
        }
        showTwoChoiceModal('mcx-clear-accounts', 'Clear AI model slots?',
          'This removes what this extension holds on this computer for ' + list.map(function (a) { return a.name; }).join(' and ') + ': '
            + 'the provider, the address, and the key. Saved chats, practice answers, your theme and every other setting stay as they are. '
            + 'Nothing is sent to the provider for this.',
          'Cancel', 'Clear all', 'right',
          function () {
            window.MCxAi.clearAccounts().then(function (out) {
              var purge = window.MCxStorage && window.MCxStorage.purgeLegacy
                ? window.MCxStorage.purgeLegacy(['mc_ai_slots_v1', 'mc_ai_profiles_v1', 'mc_ai_active', 'mc_ai_key', 'mc_ai_base', 'mc_ai_model', 'mc_ai_provider', 'mc_ai_last_model'])
                : { ok: true };
              setNote('[data-note="mc_ai_accounts"]', out && out.ok
                ? 'Cleared. ' + (purge && purge.ok
                  ? 'The older copy kept in the Canvas page storage has been removed from this computer too.'
                  : 'The older copy that was left in the Canvas page storage could not be checked, so it is still there.')
                : 'Those slots are off this screen, but the extension storage would not take the clearing: '
                  + String((out && out.error) || 'it did not answer') + '.');
              if (p && p.overlay) aiRepaint();
            });
          });
      });
    });

    /* 清用量这一本账也走同一道确认弹窗，和清历史、清练习并排放着但各删各的：
       三本账存在不同的键上，谁也不许顺手把对方删掉 */
    p.overlay.querySelectorAll('.mc-set-ai-clear-usage').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var u = window.MCxAi && window.MCxAi.usage;
        if (!u) { btn.textContent = 'Usage has not loaded yet'; return; }
        if (!u.known()) {
          setNote('[data-note="mc_ai_usage"]', 'Still reading the usage log on this computer. Try again in a moment.');
          return;
        }
        var n = u.recent(u.cap).length;
        if (!n) {
          setNote('[data-note="mc_ai_usage"]', aiUsageNote());
          return;
        }
        showTwoChoiceModal('mcx-clear-usage', 'Clear the usage log?',
          'This deletes the ' + n + ' counted request' + (n === 1 ? '' : 's') + ' this extension holds on this computer, '
            + 'and the totals built from them. Saved chats, practice answers, your model slots and every other setting stay as they are. '
            + 'Nothing is sent to any provider for this.',
          'Cancel', 'Clear all', 'right',
          function () {
            var out = u.clear();
            /* 先按当场那一判说话，等回读：库里那一格没真空就不许报"清了" */
            setNote('[data-note="mc_ai_usage"]', out.ok ? aiUsageNote()
              : 'That log is off this screen, but the extension storage would not take the clearing: '
                + String(out.error || 'it did not answer') + '.');
            if (p && p.overlay) aiRepaint();
            if (out.done) out.done.then(function (res) {
              var again = p && p.overlay ? p.overlay.querySelector('[data-note="mc_ai_usage"]') : null;
              if (!again) return;
              again.textContent = res && res.ok ? aiUsageNote()
                : 'The usage log is still in this extension\'s storage: '
                  + String((res && res.error) || 'it did not answer') + '.';
              if (p && p.overlay) aiRepaint();
            });
          });
      });
    });

    /* 清练习那本账走同一道确认弹窗，和清聊天历史那一条并排放着但各删各的：
       那两份存在不同的键上，谁也不许顺手把对方删掉 */
    p.overlay.querySelectorAll('.mc-set-ai-clear-progress').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.MCxProgress) { btn.textContent = 'Practice progress has not loaded yet'; return; }
        var all = window.MCxProgress.summary(0);
        var note = p.overlay.querySelector('[data-note="mc_ai_progress"]');
        if (!all.practiced) {
          if (note) note.textContent = aiProgressNote();
          return;
        }
        showTwoChoiceModal('mcx-clear-progress', 'Clear learning progress?',
          'This deletes the review queue this extension built from your practice answers on this computer: '
            + all.practiced + ' concept' + (all.practiced === 1 ? '' : 's') + ' recorded. '
            + 'Saved chats and everything on Canvas stay as they are.',
          'Cancel', 'Clear all', 'right',
          function () {
            var out = window.MCxProgress.clearAll();
            var fresh = p.overlay.querySelector('[data-note="mc_ai_progress"]');
            if (fresh) {
              fresh.textContent = out.ok ? aiProgressNote()
                : 'The queue is still on this screen, but this browser would not take the write.';
            }
          });
      });
    });

    // 扩展页跳不过去，那就把地址一键复制好，他粘进地址栏回车就行。
    // 复制没成也要给一句读得懂的：那句里直接带上地址，他照着打也走得通
    p.overlay.querySelectorAll('.mc-set-copy-ext').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var label = btn.textContent;
        var show = function (ok) {
          btn.textContent = ok ? 'Copied. Paste it into the address bar.' : 'Copy did not work. The address is ' + btxExtAddress();
          setTimeout(function () { btn.textContent = label; }, 2800);
        };
        try {
          navigator.clipboard.writeText(btxExtAddress()).then(function () { show(true); }, function () { show(false); });
        } catch (e) { show(false); }
      });
    });

    // 一键初始化：双重确认，重置所有设置、主题、颜色、侧栏布局、已读缓存等，全部恢复为全新出厂默认
    p.overlay.querySelectorAll('.mc-set-reset-all').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openResetModalStep1();
      });
    });

    // 绑定 School Sites 管理器
    bindSitesBox();

    aiRefreshCloudModels();
  }

  /* School Sites 那一屏的每一颗。单独成一个函数，是因为加完一条域名要把那一块整块换掉：
     以前它重跑一遍 bindActions()，面板里每一颗键因此被多绑一次，
     加过一条域名以后 Test Connection 那种按一下就跑两趟 */
  function bindSitesBox() {
    var sitesBox = p.overlay.querySelector('.mcx-sites-box');
    if (sitesBox) {
      var siteInput = sitesBox.querySelector('.mcx-site-input');
      var addBtn = sitesBox.querySelector('.mcx-site-add');
      var msg = sitesBox.querySelector('.mcx-site-msg');

      var getSavedSites = function () {
        try {
          var arr = JSON.parse(localStorage.getItem('mc_custom_domains_cache') || '[]');
          return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
      };

      var saveSites = function (arr) {
        try {
          localStorage.setItem('mc_custom_domains_cache', JSON.stringify(arr));
        } catch (e) {}
        if (chrome && chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.set({ mc_custom_domains: arr });
        }
      };

      /* 输入框里那一串和真正存下来的那一串不是同一个东西：协议、路径、端口、大写都擦掉。
         判"能不能按"用的是擦完那一段，所以那颗键说的话和框里的字不会各说各的 */
      var normSite = function (raw) {
        return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split(':')[0];
      };
      var okSite = function (val) { return !!val && val.indexOf('.') !== -1; };
      var syncAddBtn = function () {
        if (addBtn && siteInput) addBtn.disabled = !okSite(normSite(siteInput.value));
      };

      if (addBtn && siteInput) {
        addBtn.addEventListener('click', function () {
          var val = normSite(siteInput.value);
          if (msg) msg.style.display = 'none';

          if (!okSite(val)) {
            if (msg) {
              msg.textContent = 'Please enter a valid school domain (e.g. canvas.harvard.edu).';
              msg.style.display = 'block';
            }
            return;
          }
          if (val.indexOf('instructure.com') !== -1) {
            if (msg) {
              msg.textContent = 'Default *.instructure.com is already built-in.';
              msg.style.display = 'block';
            }
            return;
          }

          var curList = getSavedSites();
          if (curList.indexOf(val) !== -1) {
            if (msg) {
              msg.textContent = 'This site is already in your list.';
              msg.style.display = 'block';
            }
            return;
          }

          curList.push(val);
          saveSites(curList);
          siteInput.value = '';

          // 加完一条域名只重搭那一块，并且只重绑那一块
          sitesBox.replaceWith((function () {
            var temp = document.createElement('div');
            temp.innerHTML = sitesManagerRowHtml();
            return temp.firstElementChild;
          })());
          bindSitesBox();
        });

        // 一边打一边判：空框和没有点的那一串按不动，擦完还剩一个域名才亮
        siteInput.addEventListener('input', syncAddBtn);
        siteInput.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!addBtn.disabled) addBtn.click();
        });
        syncAddBtn();
      }

      sitesBox.addEventListener('click', function (e) {
        var delBtn = e.target.closest('[data-remove-site]');
        if (!delBtn) return;
        var toRemove = delBtn.getAttribute('data-remove-site');
        if (!toRemove) return;
        var list = getSavedSites().filter(function (x) { return x !== toRemove; });
        saveSites(list);
        var itemEl = delBtn.closest('.mcx-site-item');
        if (itemEl) itemEl.remove();
      });
    }
  }

  /* 一键初始化：彻底清理本插件在 localStorage 中的所有自定义数据并恢复全新默认 */
  function executeResetAll() {
    try {
      // 收集并移除本扩展相关的所有 localStorage 项
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (
          k.indexOf('mc_') === 0 ||
          k.indexOf('mcx_') === 0 ||
          k.indexOf('bc_') === 0 ||
          k.indexOf('bcx_') === 0 ||
          k.indexOf('canvas_notif_collapsed_') === 0 ||
          k === 'missing_on_paper' ||
          k === '_bettercampus_theme_cache'
        ) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(function (key) {
        try { localStorage.removeItem(key); } catch (e) {}
      });
    } catch (err) {}

    // 关闭面板并强制重载页面，让所有组件以全新默认状态重新启动
    close();
    location.reload();
  }

  // 强制全量覆盖迁移旧版 bcx 数据到 mc 数据
  function executeMigrateLegacy() {
    var count = 0;
    try {
      // 1. 扫描所有 bcx_* 键名并覆盖同步至 mc_*
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (k.indexOf('bcx_') === 0) {
          // 排除纯 compatibility 抓取项
          if (k === 'bcx_bc_todo' || k === 'bcx_bc_todo_asked') continue;
          var newKey = 'mc_' + k.slice(4);
          var val = localStorage.getItem(k);
          if (val !== null) {
            try {
              localStorage.setItem(newKey, val);
              count++;
            } catch (e) {}
          }
        }
      }
      // 2. 检查旧版快照与主题库
      var leg1 = localStorage.getItem('mc_applied_theme_v1');
      var leg2 = localStorage.getItem('mc_theme_snapshot_v3');
      if (leg1 && !localStorage.getItem('mc_save_1')) {
        try { localStorage.setItem('mc_save_1', leg1); count++; } catch (e) {}
      } else if (leg2 && !localStorage.getItem('mc_save_1')) {
        try { localStorage.setItem('mc_save_1', leg2); count++; } catch (e) {}
      }
      var legLib = localStorage.getItem('mc_theme_lib_v1');
      if (legLib) {
        try { localStorage.setItem('mc_theme_lib_v1', legLib); count++; } catch (e) {}
      }
    } catch (err) {}
    return count;
  }

  /* 弹出重置确认对话框：
     第1次确认：Cancel 在左，Confirm 在右
     第2次确认：Confirm 在左（防手滑误触），Cancel 在右 */
  function openResetModalStep1() {
    showTwoChoiceModal(
      'mc-reset-confirm-1',
      'Reset All Settings and Data?',
      'This will delete all custom themes, custom colors, sidebar layouts, and task caches, restoring everything to default factory state.',
      'Cancel',
      'Continue Reset',
      'right', // 确认按钮在右侧
      function () {
        // 进入第2次确认
        openResetModalStep2();
      }
    );
  }

  function openResetModalStep2() {
    showTwoChoiceModal(
      'mc-reset-confirm-2',
      'Final Confirmation: Are You Sure?',
      'This action is irreversible! All your custom data and settings will be permanently erased. Notice that button positions have been swapped to prevent accidental clicks.',
      'Confirm & Reset',
      'Cancel',
      'left', // 确认按钮在左侧
      function () {
        executeResetAll();
      }
    );
  }

  function showTwoChoiceModal(id, title, note, leftText, rightText, confirmSide, onConfirm) {
    if (document.getElementById(id)) return;
    var overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'bc-modal-overlay mc-reset-overlay';

    var leftIsConfirm = confirmSide === 'left';
    var leftBtnClass = leftIsConfirm ? 'mc-modal-btn-danger' : 'mc-modal-btn-cancel';
    var rightBtnClass = leftIsConfirm ? 'mc-modal-btn-cancel' : 'mc-modal-btn-danger';

    overlay.innerHTML =
      '<div class="bc-modal-card mc-reset-card" role="dialog" aria-label="' + esc(title) + '">' +
        '<div class="bc-modal-title">' + esc(title) + '</div>' +
        '<div class="bc-modal-note">' + esc(note) + '</div>' +
        '<div class="mc-modal-actions">' +
          '<button type="button" class="mc-modal-btn ' + leftBtnClass + '" data-side="left">' + esc(leftText) + '</button>' +
          '<button type="button" class="mc-modal-btn ' + rightBtnClass + '" data-side="right">' + esc(rightText) + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('open'); });

    var closeSelf = function () {
      overlay.classList.remove('open');
      setTimeout(function () { overlay.remove(); }, 240);
    };

    var leftBtn = overlay.querySelector('[data-side="left"]');
    var rightBtn = overlay.querySelector('[data-side="right"]');

    leftBtn.addEventListener('click', function () {
      closeSelf();
      if (leftIsConfirm) onConfirm();
    });

    rightBtn.addEventListener('click', function () {
      closeSelf();
      if (!leftIsConfirm) onConfirm();
    });

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closeSelf();
    });
  }

  /* ==== 左栏：点一下滚到那一组；滚过去了反过来点亮 ==== */

  // 上一次点亮的那一颗。只改它和新命中这一颗，不再遍历整列改 class
  var navLit = null;

  function markNav(id) {
    var next = id ? p.overlay.querySelector('.mc-set-nav-btn[data-nav="' + id + '"]') : null;
    if (next === navLit) return;
    if (navLit) navLit.classList.remove('active');
    if (next) next.classList.add('active');
    navLit = next;
  }

  /* 每一组顶到滚动层顶的距离，一次算好存着，滚动路径上只读一个 scrollTop 和它比大小。
     以前每来一个滚动事件就把每一组的 getBoundingClientRect 全读一遍，而点亮左栏那颗刚写过
     class（当前档是粗体，字宽变了＝排版脏）：下一次读就得把整页 Canvas 重排一次。
     滚得快、跨的组多＝每帧一次全页重排，报上来的"滑快了卡、像一直在加载"就是这个；
     慢慢滑或组少时跨档次数少，所以看不出来。
     表什么时候作废：换屏（藏起来的那一屏每组 offsetTop 都是 0）、翻了任一档（说明文字
     会从一行变两行，下面各组跟着挪）、窗口变窄（卡片跟着变窄，文字重排）。 */
  var secTops = null;

  function invalidateSectionTops() { secTops = null; }

  // 挂在模块这一层一次：面板关着时它只是让一张表作废，没有别的副作用
  window.addEventListener('resize', invalidateSectionTops);

  function sectionTops(secs) {
    if (!secTops) {
      secTops = [];
      for (var i = 0; i < secs.length; i++) secTops.push(secs[i].offsetTop);
    }
    return secTops;
  }

  function bindNav() {
    var secs = p.overlay.querySelectorAll('.mc-set-sec');
    var last = '';

    p.overlay.querySelectorAll('.mc-set-nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-nav');
        if (btn.hasAttribute('data-view')) { showView(btn.getAttribute('data-view')); return; }
        if (p.settings && !p.settings.hidden) {
          jumpToSection(id);
        } else {
          // 从主题墙或 Colours 那一屏回来：先换回设置那一列，再滚到要点的那一组
          showView('settings');
          jumpToSection(id);
        }
        markNav(id);
      });
    });

    function spy() {
      if (!p.settings || p.settings.hidden) return;
      var t = sectionTops(secs);
      var y = p.body.scrollTop + 48;
      var idx = 0;
      for (var i = 0; i < t.length; i++) if (t[i] <= y) idx = i;
      var id = secs[idx] && secs[idx].getAttribute('data-sec');
      if (!id || id === last) return;
      p.lastSection = id;
      last = id;
      markNav(id);
    }

    // 一个滚动事件一次布局都不做：滚得再快，一帧也只判一次
    var queued = false;
    p.body.addEventListener('scroll', function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; spy(); });
    }, { passive: true });
    p.spy = spy;
    tailRoom();
    spy();
  }

  /* 最后一组也得能滚到正文顶上。CSS 里那 55vh 补白是按平均窗口高度拍的，
     窗口高、或最后几组矮的时候就不够：滚不到顶 → 点左栏那颗画面不动，
     判当前组靠"这一组的顶到正文顶"，也就永远判不到它。差多少当场补多少。
     量的是 offsetTop（排版坐标），不是 getBoundingClientRect：卡片开场那 300ms 带着
     scale(0.95)，rect 会被缩放，量出来差一截。 */
  function tailRoom() {
    // secs 不能借用 bindNav 里那份：tailRoom 的作用链是这一层的 IIFE，
    // 从那里只能拿到全局，闭包拿不到别人的局部变量，一借就是 ReferenceError
    var secs = p.overlay.querySelectorAll('.mc-set-sec');
    var tail = secs[secs.length - 1];
    if (!tail) return;
    var below = p.body.scrollHeight - tail.offsetTop;
    if (below >= p.body.clientHeight) return;
    var pad = parseFloat(getComputedStyle(p.settings).paddingBottom) || 0;
    p.settings.style.setProperty('padding-bottom',
      Math.ceil(pad + p.body.clientHeight - below) + 'px', 'important');
  }

  /* ==== 换屏：设置那一列 / 主题墙 / Colours ====
     三屏共用一个 showView。变宽那条过渡挂在 .mc-set-card 上，只有这一处说一次，
     两屏进来出去走同一条、同一个时长 */

  function showView(which) {
    syncInspectState(false);
    // 离开自建那一屏：那份还没落盘的临时盖色要摘干净，不然页面停在一个没存过的色上
    if (which !== 'maker') mkClearDraft();
    // 藏起来的那一屏每组量出来都是 0，换屏之后这张表必须重算
    invalidateSectionTops();
    p.settings.hidden = which !== 'settings';
    p.themes.hidden = which !== 'themes';
    p.colors.hidden = which !== 'colours';
    p.maker.hidden = which !== 'maker';
    p.cardtext.hidden = which !== 'cardtext';
    // Course info 那一屏不加宽：它现在是一门课一块、每块三行标签加框，正文那一列的宽度正好
    p.card.classList.toggle('mc-set-wide', which === 'themes' || which === 'colours' || which === 'maker');
    p.body.scrollTo({ top: 0 });
    if (which !== 'themes') p.card.classList.remove('btx-detail-open');
    if (which === 'themes') openThemes();
    else if (which === 'colours') openColours();
    else if (which === 'maker') openMakerView();
    else if (which === 'cardtext') openCardTextView();
    else if (p.spy) p.spy();
    // 自建主题是从 Theme Picker 那一屏进去的，左栏那颗要保持亮着（它自己不是左栏的一档）
    markNav(which === 'settings' ? (p.lastSection || firstSectionId())
      : (which === 'maker' ? 'themes' : which));
  }
  function btxRows() {
    var q = btx.query.trim().toLowerCase();
    var rows = !q ? btx.all.slice() : btx.all.filter(function (x) {
      return String(x.t).toLowerCase().indexOf(q) !== -1 || String(x.a).toLowerCase().indexOf(q) !== -1;
    });
    // 有几份标题开头带空格，排序时先剥掉，否则 A→Z 第一屏是几行空白
    var byName = function (a, b) { return String(a.t).trim().localeCompare(String(b.t).trim()); };
    var h = store();
    var sort = h ? h.modernSetting('theme_sort') : 'popular';
    if (sort === 'az') return rows.sort(byName);
    if (sort === 'za') return rows.sort(function (a, b) { return -byName(a, b); });
    // 榜单＝用的人从多到少；同人数再按名字，翻页时顺序才不会飘
    return rows.sort(function (a, b) { return (b.n - a.n) || byName(a, b); });
  }

  function btxCardEl(row) {
    var card = el('div', 'btx-card');
    card.dataset.code = row.c;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    var src = btxThumb(row.p);
    var cover = el('div', 'btx-cover');
    if (src) {
      var img = document.createElement('img');
      img.className = 'btx-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      // Theme preview images are hosted by the URLs in the curated catalog.
      // Loading one contacts that image host (which can receive IP/referrer
      // metadata); keep previews optional/lazy and include this in privacy copy.
      // 图挂了就留一块纯色底板：标题和作者照样看得见，主题也照样能应用
      img.addEventListener('error', function () { card.classList.add('btx-no-img'); });
      img.src = src;
      cover.appendChild(img);
    } else {
      card.classList.add('btx-no-img');
    }
    card.appendChild(cover);
    card.appendChild(el('div', 'btx-name', row.t || row.c));
    card.appendChild(el('div', 'btx-by', row.a || ''));
    var open = function () {
      if (row.canvasMode) applyCanvasColours(row.canvasMode);
      else openThemeDetail(row);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    return card;
  }

  // 翻页条：页码那一格可以直接打字，回车或点走就跳；超界自动收到首页/末页，不弹提示
  function btxPager(shown, total, pages) {
    var wrap = el('div', 'btx-pager');
    var prev = el('button', 'btx-page-btn btx-ctl', 'Prev');
    var next = el('button', 'btx-page-btn btx-ctl', 'Next');
    prev.type = 'button';
    next.type = 'button';
    prev.disabled = btx.page <= 1;
    next.disabled = btx.page >= pages;
    prev.addEventListener('click', function () { btx.page--; renderThemeList(); });
    next.addEventListener('click', function () { btx.page++; renderThemeList(); });

    var num = el('input', 'btx-page-num btx-ctl');
    num.type = 'text';
    num.value = btx.page;
    num.setAttribute('aria-label', 'Page number');
    var jump = function () {
      // 整条翻页条会随重画换掉，节点一离开面板就当它没发生过，免得 change 再补一次跳转
      if (!num.isConnected) return;
      var typed = parseInt(num.value, 10);
      if (!isNaN(typed)) btx.page = Math.min(pages, Math.max(1, typed));
      btx.focusPage = true;
      renderThemeList();
    };
    num.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      jump();
    });
    num.addEventListener('change', jump);

    wrap.appendChild(prev);
    wrap.appendChild(num);
    wrap.appendChild(el('span', 'btx-page-of', '/ ' + pages));
    wrap.appendChild(el('div', 'btx-page-count', shown + ' of ' + total + ' themes'));
    wrap.appendChild(next);
    if (btx.focusPage) {
      // 跳完把光标留在这一格并选中数字，接着敲下一个页码就行
      btx.focusPage = false;
      num.focus();
      num.select();
    }
    return wrap;
  }

  function renderThemeList() {
    if (!p || p.themes.hidden) return;
    btx.detail = null;
    btx.detailFull = null;
    p.card.classList.remove('btx-detail-open');
    p.view.querySelector('.btx-title').textContent = 'Theme Picker';
    var body = p.view.querySelector('.btx-body');
    var foot = p.view.querySelector('.btx-foot');
    body.textContent = '';
    foot.textContent = '';
    // 那句"这儿有多少份"要等读盘回来才报得准，所以整句在渲染时填，不在搭壳子时写死
    var cnt = p.view.querySelector('.btx-count');
    if (cnt) cnt.textContent = btx.all.length ? btx.all.length + ' themes from Better Campus. ' : '';

    if (btx.note) {
      body.appendChild(el('div', 'btx-note', btx.note));
      return;
    }
    var rows = btxRows();
    var pages = Math.max(1, Math.ceil(rows.length / BTX_PAGE));
    if (btx.page > pages) btx.page = pages;
    if (btx.page < 1) btx.page = 1;
    var start = (btx.page - 1) * BTX_PAGE;
    var slice = rows.slice(start, start + BTX_PAGE);

    // 三列从上往下：我们自己建的、我们打包的、BetterCanvas 那一大堆。
    // 前两列各占一行横向滚，不参与搜索排序以外的任何分页；最后一列才走翻页
    var mine = mkList();
    if (mine.length) body.appendChild(mkStripEl(mine));
    var q = btx.query.trim().toLowerCase();
    var ours = !q ? btx.mc.slice() : btx.mc.filter(function (x) {
      return String(x.t).toLowerCase().indexOf(q) !== -1 || String(x.a).toLowerCase().indexOf(q) !== -1;
    });
    // 那两颗 Canvas 深浅色常驻，所以这一列无条件摆：搜索没命中任何一份打包主题时它也不该整列消失
    body.appendChild(mcStripEl(ours));
    if (!slice.length) {
      body.appendChild(el('div', 'btx-note', btx.query
        ? 'No theme matches that search.'
        : 'The theme list has nothing in it yet.'));
      return;
    }
    body.appendChild(el('div', 'btx-mine-head', 'Themes from Better Campus'));
    var grid = el('div', 'btx-grid');
    slice.forEach(function (row) { grid.appendChild(btxCardEl(row)); });
    body.appendChild(grid);
    foot.appendChild(btxPager(slice.length, rows.length, pages));
    // 换页只把面板那一列拉回顶部，别动背后的页面
    scrollWallToTop();
  }

  function btxSampleBase(bySlot, slot) {
    return slot === 'sidebar-text'
      ? (bySlot.sidebar || bySlot['background-1'] || bySlot['background-0'] || '')
      : (bySlot.cards || bySlot['background-0'] || bySlot['background-1'] || '');
  }

  function btxUseFont(font) {
    var h = store();
    var fam = h ? h.mcFontFamily(font) : '';
    if (h && fam) h.mcFontLinks(font).forEach(function (href) {
      if (btxFonts[href]) return;   // 同一份字体在一个页面里只挂一次
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-bcx-theme-preview', '');
      link.href = href;
      btxFonts[href] = link;
      document.head.appendChild(link);
    });
    return fam || BTX_BASE_FONT;
  }

  // 槽值本身就是一条完整的 background 简写（渐变、图、位置关键字都可能带），
  // 整串交给 style.background 才对；写进 DOM 一律走 textContent / style 属性，不拼 HTML
  function fillThemeDetail(full, swatches, strip) {
    var h = store();
    swatches.textContent = '';
    var bySlot = {};
    (full.colors || []).forEach(function (c) { if (c && c.slot) bySlot[c.slot] = String(c.value || '').trim(); });
    var previewFont = btxUseFont(full.font);
    var chips = 0;
    BTX_SLOTS.forEach(function (slot) {
      var value = bySlot[slot];
      if (!value || /[;{}<>]/.test(value)) return;
      chips++;
      var tile = el('div', 'btx-swatch');
      var chip = el('div', 'btx-chip');
      if (BTX_TEXT_SLOTS.indexOf(slot) !== -1) {
        var base = btxSampleBase(bySlot, slot);
        if (base && !/[;{}<>]/.test(base)) chip.style.background = base;
        chip.classList.add('btx-sample');
        chip.style.color = value;
        // 必须写成行内 important：主题那条字族规则是 body 的全后代选择器加 !important，
        // 普通行内样式压不住它，示例还是会显成当前主题的字体
        chip.style.setProperty('font-family', previewFont, 'important');
        chip.textContent = 'Aa';
      } else {
        chip.style.background = value;
      }
      // 上面那句是简写，会把 size/position 一起清成默认值，带图或带渐变的槽位就得在这之后补
      chip.style.backgroundSize = 'cover';
      chip.style.backgroundPosition = 'center';
      tile.appendChild(chip);
      tile.appendChild(el('span', 'btx-slot', slot));
      swatches.appendChild(tile);
    });
    if (!chips) swatches.appendChild(el('div', 'btx-note', 'This theme records no colour slots.'));
    var imgs = (full.exports && full.exports.custom_cards) || [];
    imgs.slice(0, 8).forEach(function (url) {
      // 作者常把链接前面粘出空格或反斜杠，先擦干净再判这一格有没有图
      var src = String(url == null ? '' : url).replace(/^[\\\s]+/, '');
      var tile = el('div', 'btx-card-img btx-no-img');
      if (/^(https?:|data:image|chrome-extension:)/i.test(src)) {
        var pic = el('img', 'btx-card-pic');
        pic.alt = '';
        pic.addEventListener('error', function () { tile.classList.add('btx-no-img'); });
        pic.addEventListener('load', function () { tile.classList.remove('btx-no-img'); });
        tile.appendChild(pic);
        pic.src = src;
      }
      tile.appendChild(el('span', 'btx-card-none', 'No image'));
      strip.appendChild(tile);
    });
    if (!strip.children.length) strip.appendChild(el('div', 'btx-note', 'This theme keeps the default card images.'));
    // 一格色都没画出来就别让 Apply 亮着：那份数据本来就不完整
    return chips > 0;
  }

  function openThemeDetail(row) {
    if (!p || p.themes.hidden) return;
    var h = store();
    btx.detail = row;
    btx.detailFull = null;
    p.card.classList.add('btx-detail-open');
    p.view.querySelector('.btx-title').textContent = row.t || row.c;
    var body = p.view.querySelector('.btx-body');
    body.textContent = '';
    p.view.querySelector('.btx-foot').textContent = '';

    var wrap = el('div', 'btx-detail');
    var hero = el('div', 'btx-hero');
    var src = String(row.p || '').replace(/^[\\\s]+/, '');
    if (/^(https?:|data:image|chrome-extension:)/i.test(src)) {
      var img = document.createElement('img');
      img.className = 'btx-hero-img';
      img.alt = '';
      img.addEventListener('error', function () { hero.classList.add('btx-no-img'); });
      // 详情这一张用原图，就一张，值得看清
      img.src = src;
      hero.appendChild(img);
    } else {
      hero.classList.add('btx-no-img');
    }
    hero.appendChild(el('span', 'btx-hero-none', 'No image'));
    wrap.appendChild(hero);

    var info = el('div', 'btx-info');
    info.appendChild(el('div', 'btx-detail-name', row.t || row.c));
    var byLine = el('div', 'btx-line', 'by ' + (row.a || 'unknown') + (row.g ? ' · ' + row.g : ''));
    info.appendChild(byLine);
    // 我们自己的那批不摆这句（图现在也可能热链在外部，那句话已经不成立）；
    // BetterCanvas 那批照旧摆它的使用数、点赞和评论
    if (row.src !== 'mc') {
      info.appendChild(el('div', 'btx-line', (row.n || 0).toLocaleString() + ' using · ' +
        (row.s || 0).toLocaleString() + ' likes · ' + (row.m || 0).toLocaleString() + ' comments'));
    }

    // 停在 Canvas 那一档时页面上刷的不是任何一格存档，这句就不摆
    var off = h && h.mcThemeOff ? h.mcThemeOff() : false;
    var cur = off ? null : (h && h.mcSnapshot ? h.mcSnapshot() : null);
    if (cur && cur.imported && cur.imported.code === row.c) {
      info.appendChild(el('div', 'btx-line', 'This theme is on the page right now.'));
    }
    info.appendChild(el('div', 'btx-group', 'Colours'));
    var swatches = el('div', 'btx-swatches');
    swatches.appendChild(el('div', 'btx-note', 'Loading colours…'));
    info.appendChild(swatches);
    info.appendChild(el('div', 'btx-group', 'Card images'));
    var strip = el('div', 'btx-cards');
    info.appendChild(strip);

    var actions = el('div', 'btx-actions');
    var apply = el('button', 'btx-apply btx-ctl', 'Apply');
    // 这份主题的参数没读进来之前不给点
    apply.type = 'button';
    apply.disabled = true;
    var status = el('div', 'cts-theme-status');
    apply.addEventListener('click', function () {
      // 先采图再落盘：这句要立刻给，不然那半秒看起来像按钮没反应
      apply.disabled = true;
      status.hidden = false;
      status.textContent = 'Reading the sidebar picture…';
      bakeSidebarSamples(btx.detailFull).then(function (full) {
        try {
          h.mcApplyThemeJson(full);
          // 快照只在 document_start 被读一次，所以当场刷新页面，不让他再点一颗键
          location.reload();
        } catch (err) {
          apply.disabled = true;
          status.textContent = "Can't apply this theme: " + (err && err.message ? err.message : String(err));
        }
      });
    });
    actions.appendChild(apply);
    actions.appendChild(status);
    info.appendChild(actions);
    wrap.appendChild(info);
    body.appendChild(wrap);

    scrollWallToTop();

    // 色板和卡图都在分块文件里（一块 100 份），读到了才填，读之前那两格先写着在读
    // 我们打包那批是一份一个文件（图就在同目录），BetterCanvas 那批是 100 份一块
    var read = row.src === 'mc'
      ? btxJson('modern-canvas/' + row.c + '.json').then(function (one) { return mcFull(one, row.c); })
      : btxJson('t/' + row.k + '.json').then(function (group) { return group && group[row.c]; });
    read.then(function (full) {
      if (btx.detail !== row || !body.contains(swatches)) return;
      if (!full) {
        swatches.textContent = '';
        swatches.appendChild(el('div', 'btx-note', row.src === 'mc'
          ? 'The list names this one but ' + row.c + '.json is not in the folder.'
          : 'The list puts this one in chunk ' + row.k + " but it isn't in there. Run the export script again."));
        return;
      }
      btx.detailFull = full;
      if (full.mc_custom_theme === 1) {
        // 桶里躺着的是 Theme Customizer 导出的那一种（图内嵌在文件里）。墙上这一列应用的是
        // 打包那一种形状，两种字段对不上，所以这边不猜：说清楚走哪条路，Apply 保持按不住
        swatches.textContent = '';
        swatches.appendChild(el('div', 'btx-note',
          'This one is a Theme Customizer export. Load it with Import JSON and it lands in Your themes.'));
        return;
      }
      apply.disabled = !fillThemeDetail(full, swatches, strip);
      var fam = h && h.mcFontName ? h.mcFontName(full.font) : '';
      byLine.textContent = 'by ' + (row.a || 'unknown') + (row.g ? ' · ' + row.g : '') +
        (fam ? ' · font ' + fam : ' · default font');
    }).catch(function (err) {
      if (!body.contains(swatches)) return;
      swatches.textContent = '';
      swatches.appendChild(el('div', 'btx-note', err && err.stale
        ? 'The extension was updated. Refresh this page to load the theme parameters.'
        : "Can't read this theme's parameters (" + (err && err.message ? err.message : String(err)) + ').'));
    });
  }

  // 每次点开都重新读盘：这份扩展是解包加载的，重跑一次导出脚本不用重新加载扩展就能看到新库
  function loadThemeIndex() {
    btx.all = [];
    btx.byCode = {};
    btx.page = 1;
    btx.note = 'Loading themes…';
    loadMcIndex();
    renderThemeList();
    btxJson('index.json').then(function (list) {
      if (!p || p.themes.hidden || !Array.isArray(list)) return;
      btx.all = list;
      btx.byCode = {};
      list.forEach(function (x) { if (x && x.c) btx.byCode[x.c] = x; });
      btx.note = '';
      renderThemeList();
    }).catch(function (err) {
      btx.note = err && err.stale ? 'The extension was updated. Refresh this page to load the theme list.'
        : "Can't read themes/index.json (" + (err && err.message ? err.message : String(err)) +
          "). Run 抓取工具/build_extension_themes.py, then reload this page.";
      renderThemeList();
    });
  }

  /* ==== 我们自己的那一批（清单里存的是 themes/modern-canvas/... 这种相对地址，图在不在包里都行）====
     读出来先换成绝对地址：面板里的预览和页面上的样式都直接用它。JSON 里的图名也是相对的
     （"sidebar.jpg"），装进快照前一并换成绝对地址，不然 Canvas 那一页会拿站点的地址去拼，图就 404。
     接上远程桶时 MC_THEME_BASE 非空，这里换出来的就是桶那边的 https 地址（见文件头 btxJson 那段） */
  function mcUrl(rel) {
    var remote = mcThemeUrl(rel);
    if (remote) return remote;
    try { return chrome.runtime.getURL(String(rel || '')); } catch (e) { return ''; }
  }

  function mcRow(row) {
    if (row && !/^(https?:|data:|chrome-extension:)/i.test(String(row.p || ''))) {
      row.p = mcUrl(row.p);
    }
    return row;
  }

  function mcFull(full, code) {
    // 桶里也可能躺着 Theme Customizer 导出的那一种（colors 是一份字典不是数组），
    // 那种这边一套字段都碰不到，原样交回去，由详情那一屏说清楚它走哪条路
    if (!full || typeof full !== 'object' || !Array.isArray(full.colors)) return full;
    var dir = 'themes/modern-canvas/' + code + '/';
    var abs = function (u) {
      var s = String(u || '').trim().replace(/^[\\'"]+|[\\'"]+$/g, '');
      if (!s || /^(https?:|data:|chrome-extension:|mc-img:)/i.test(s)) return s;
      return mcUrl(dir + s.replace(/^\//, ''));
    };
    (full.colors || []).forEach(function (c) {
      if (c && c.value) c.value = String(c.value).replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi,
        function (m, u) { return 'url("' + abs(u) + '")'; });
    });
    var ex = full.exports || {};
    if (Array.isArray(ex.custom_cards)) {
      ex.custom_cards = ex.custom_cards.map(abs).filter(Boolean);
    }
    return full;
  }

  /* 墙上这一列是两个来源拼出来的：包里那份清单先摆，桶那边扫到的接在后面。
     两边谁先到都不影响：每一趟都从两份原始行重算，不互相覆盖 */
  var mcLocalRows = [];
  var mcRemoteRows = [];

  function paintMcRows() {
    var seen = {};
    btx.mc = mcLocalRows.concat(mcRemoteRows).filter(function (row) {
      if (!row || !row.c) return false;
      if (seen[row.c]) {
        // 桶里那颗和包里撞了名：留包里那颗，顺手撤掉它的远程挂号，
        // 不然它的图会被换算成桶里的地址，读到的却是包里的清单
        delete mcRemoteCodes[row.c];
        return false;
      }
      seen[row.c] = 1;
      return true;
    }).map(mcRow);
    if (p && !p.themes.hidden) renderThemeList();
  }

  function loadMcIndex() {
    btx.mc = [];
    btxJson('modern-canvas/index.json').then(function (list) {
      mcLocalRows = Array.isArray(list) ? list : [];
      paintMcRows();
    }).catch(function () {
      // 这一列读不到不影响 BetterCanvas 那一大堆，空着就行
      mcLocalRows = [];
    });
    if (!MC_THEME_LIST_URL) return;
    fetch(MC_THEME_LIST_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (list) {
      mcRemoteRows = Array.isArray(list) ? list : [];
      // 先挂号再画：画的时候每行的相对地址要按这张表决定读桶里还是读包里
      mcRemoteRows.forEach(function (row) { if (row && row.c) mcRemoteCodes[row.c] = 1; });
      paintMcRows();
    }).catch(function (err) {
      console.warn('[MCX] 桶那份清单没读到（' + (err && err.message ? err.message : String(err)) +
        '），这一列只摆包里那几颗');
    });
  }

  /* 这两颗摆在墙上，但它们不是主题：点了不进详情，直接把页面那一层换成 Canvas 自己的色。
     动作和 Theme Customizer 顶上那颗 "Switch to Canvas colours" 是同一套（applyCanvasColours），
     只是省掉了弹窗问他深浅——卡片本身已经替他分好了 Light / Dark。
     不进 themes/modern-canvas/index.json：那份清单是主题库，这两颗没有主题参数可读 */
  var MC_CANVAS_MODE_ROWS = [
    { c: 'canvas_mode_light', t: 'Light Mode', a: 'Modern Canvas', g: 'Canvas colours',
      p: 'themes/modern-canvas/canvas_mode_light/preview.jpg', canvasMode: 'light' },
    { c: 'canvas_mode_dark', t: 'Dark Mode', a: 'Modern Canvas', g: 'Canvas colours',
      p: 'themes/modern-canvas/canvas_mode_dark/preview.jpg', canvasMode: 'dark' }
  ];

  /* 页面那一层换回 Canvas 自己的色，深浅由调用方定。
     Page colours 那颗下拉读的是同一个 bc_colour_mode，所以刷完以后 Customizer 里跟着翻 */
  function applyCanvasColours(mode) {
    localStorage.setItem('bc_colour_mode', mode);
    localStorage.setItem('bc_colour_tier', 'canvas');
    location.reload();
  }

  function mcStripEl(list) {
    var wrap = el('section', 'btx-mine btx-mc');
    wrap.appendChild(el('div', 'btx-mine-head', 'Themes from Modern Canvas'));
    var rail = el('div', 'btx-grid');
    MC_CANVAS_MODE_ROWS.forEach(function (row) { rail.appendChild(btxCardEl(mcRow(row))); });
    list.forEach(function (row) { rail.appendChild(btxCardEl(row)); });
    wrap.appendChild(rail);
    return wrap;
  }

  /* Apply 之前先把侧栏那张图采一遍，三颗底（平均／最暗／最亮）写进这份 JSON 的 samples。
     为什么不等到页面上再算：那是 document_idle 的活，首帧那颗字色已经照"读不到底"画过一次了，
     算完再翻＝他看见白字跳成黑字。采在 Apply 这一刻，存档里就带着这三颗，
     首帧那份编译好的表直接是最终结果，取色轮每轮重算也是同一个数。
     图读不到像素（外链被 CORS 挡、图坏了、超时）就一个字段都不写，兜底照旧不翻色 */
  function bakeSidebarSamples(full) {
    var l = lib();
    if (!l || !l.samplePicture || !full) return Promise.resolve(full);
    var side = '';
    (full.colors || []).forEach(function (c) {
      if (c && c.slot === 'sidebar') side = String(c.value || '');
    });
    var url = l.pictureUrlOf(side);
    if (!url) return Promise.resolve(full);
    return l.samplePicture(url).then(function (rgb) {
      if (rgb && rgb.length) {
        full.samples = Object.assign({}, full.samples || {}, { sidebar: rgb });
      }
      return full;
    }, function () { return full; });
  }

  // 自建那一屏走的是另一条口（库里那份记录先由 theme-lib 翻成 JSON），所以采好的三颗挂在记录上
  function bakeRecSamples(rec) {
    var l = lib();
    if (!l || !l.samplePicture || !rec || !rec.sidebar || !rec.sidebar.src) return Promise.resolve(rec);
    return l.samplePicture(rec.sidebar.src).then(function (rgb) {
      if (rgb && rgb.length) rec.sidebar.samples = rgb;
      return rec;
    }, function () { return rec; });
  }

  function openThemes() {
    if (p.themesBound) {
      p.view.querySelector('.btx-search').value = '';
      btx.query = '';
      loadThemeIndex();
      return;
    }
    p.themesBound = true;

    p.view.querySelector('.btx-search').addEventListener('input', function (e) {
      var value = e.target.value;
      clearTimeout(btx.timer);
      btx.timer = setTimeout(function () {
        btx.query = value;
        btx.page = 1;
        renderThemeList();
      }, 150);
    });

    // 详情里的返回＝回列表；列表状态的返回＝回设置那一列
    p.view.querySelector('.btx-back').addEventListener('click', function () {
      if (p.card.classList.contains('btx-detail-open')) renderThemeList();
      else showView('settings');
    });

    loadThemeIndex();
  }

  // 只滚面板这一层。默认量主题墙那一屏，自建那一屏进来时点名它自己
  function scrollWallToTop(node) {
    var view = node || p.themes;
    var delta = view.getBoundingClientRect().top - p.body.getBoundingClientRect().top;
    p.body.scrollTo({ top: p.body.scrollTop + delta });
  }

  /* ==== Colours 面板：这一份主题的十二档色，每一档都能自己调 ====
     取色器是自己画的（一块饱和度/明度方块 + 一条色相 + 一个十六进制格），
     不用浏览器那颗 native color input：它弹的是系统面板，样式跟不上主题，
     也没地方放"这一档用在哪儿"那句解释。
     拖动的时候只盖一份临时样式（content.js 的 mcPreviewSlotColors），松手才写快照，
     不然每挪一像素存一次 localStorage、重编译一份表。 */

  var COLOUR_GROUPS = [
    { title: 'Backgrounds', slots: ['background-0', 'background-1', 'sidebar'] },
    { title: 'Text', slots: ['text-0', 'text-1', 'text-2', 'sidebar-text'], hasFont: true },
    { title: 'Lines and controls', slots: ['borders', 'buttons', 'background-2', 'links'] }
  ];

  /* 每句讲的是"改了它以后页面上哪一块跟着变"，不是槽名。
     对得上 style.css 的配色 token 那一节，而且名字已经一对一：background-0→--mc-background-0、
     borders→--mc-borders、buttons→--mc-buttons、links→--mc-links、text-0/1/2→--mc-text-0/1/2。
     只有两处不是一样：--mc-background-0 在主题自带 cards 时读 cards，--mc-buttons 缺档时退到
     background-2。sidebar/sidebar-text 由编译出来的那份表点名画。
     这一行说明允许换到第二行（.mc-col-use）：空档时后面还要跟一句"借了谁"，压成一行会截成半句 */
  var COLOUR_INFO = {
    // 【合二为一】这一档就是卡底：主题自带 cards 时读它自己的，没有时卡底、面板、日历、
    // 弹窗、菜单、抽屉全用这一颗。以前它叫 Page background，又单列一行 cards 掺白造档
    'background-0': { name: 'Card and panel fill', use: 'Course cards, panels, calendar, dialogs, menus' },
    'background-1': { name: 'Whole background', use: 'The page area behind every card' },
    'sidebar': { name: 'Sidebar', use: 'The nav strip on the left' },
    'text-0': { name: 'Main text', use: 'Titles, task names, and every hover wash' },
    'text-1': { name: 'Second text', use: 'Smaller labels and captions' },
    'text-2': { name: 'Faint text', use: 'Dates, counts, finished tasks' },
    'sidebar-text': { name: 'Sidebar text', use: 'Nav labels and their icons' },
    'borders': { name: 'Lines', use: 'Hairlines and panel edges' },
    'buttons': { name: 'Control fill', use: 'Buttons, search box, menu rows' },
    'background-2': { name: 'Track', use: 'Control plate, hover and pressed' },
    // 公告那根色条没有自己的一行，它读的就是这一档（--mc-notif-rail 由 links 行内写死）。
    // 这句要把"这一行还管着公告"说出来，不然下一轮又是"我调这个怎么动了公告"。
    // 文字链接那一半由顶上那颗 mc_link_accent 管，关着的时候这一句要缩回去（见 renderColourRow）
    'links': { name: 'Accent', use: 'Notification bar, switches, ticks, text links' }
  };

  var COLOUR_INK_SLOTS = { 'text-0': 1, 'text-1': 1, 'text-2': 1, 'sidebar-text': 1 };

  /* 字体那一行的名单。它不是第 13 档色，换的是整页的字，所以不并进 COLOUR_GROUPS，
     摆在 Text 那张卡最后。
     名单不是拍的：抓取那批主题按使用人数取前 100，其中 87 份自带字体、去掉重名剩 31 个字族，
     这里挑 12 种互相样式分得开的（几何无衬线／圆角无衬线／正文衬线／高对比衬线／罗马大写／
     窄体／圆体／手写／马克笔／像素／等宽）。地址一律交给 content.js 的 mcFontLinks 现拼，
     这里只存字族名，不在面板里抄一份 URL 再维护第二套拼法 */
  var MC_FONTS = ['Jost', 'Poppins', 'Quicksand', 'Playfair Display', 'Lora',
    'Cinzel', 'Oswald', 'Comfortaa', 'Mali', 'Permanent Marker', 'Silkscreen', 'Roboto Mono'];

  // 那一排只有 12 颗，剩下的去 Google 自己那面墙挑：那颗键开的是字族目录
  var MC_FONTS_URL = 'https://fonts.google.com/';

  var col = { items: {}, view: null, values: {}, drag: null, raf: 0, pending: null,
    font: null, fontOpen: false };

  /* ==== 一点点颜色数学：十六进制 ↔ 色相/饱和度/明度 ==== */

  function colRgb(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    if (/^#[0-9a-f]{6}$/i.test(s)) {
      return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    }
    if (/^#[0-9a-f]{3}$/i.test(s)) {
      return [1, 2, 3].map(function (i) { return parseInt(s[i] + s[i], 16); });
    }
    var m = s.match(/^[a-z]+\(([^)]+)\)$/i);
    if (!m) return null;
    // hsl() 之类的要先让浏览器算成 rgb，量法和 content.js 那边一样：挂个隐形节点读 computed
    var probe = document.createElement('span');
    probe.style.cssText = 'display:none;color:' + s;
    document.body.appendChild(probe);
    var parts = getComputedStyle(probe).color.match(/[\d.]+/g);
    probe.remove();
    if (!parts || parts.length < 3) return null;
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  }

  function colHex(rgb) {
    return '#' + rgb.slice(0, 3).map(function (c) {
      return Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
    }).join('');
  }

  function colHsv(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, max ? d / max : 0, max];
  }

  function colRgbFromHsv(hsv) {
    var h = hsv[0], s = hsv[1], v = hsv[2];
    var i = Math.floor(h * 6), f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    var pick = [
      [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]
    ][i % 6];
    return [pick[0] * 255, pick[1] * 255, pick[2] * 255];
  }

  // 往白或黑挪一档（0.08）。取色器方块也能挪，但挪一档这种"就要亮一点点"用不着拖
  function colStep(hex, up) {
    var rgb = colRgb(hex);
    if (!rgb) return hex;
    var to = up ? 255 : 0;
    return colHex(rgb.map(function (c) { return c + (to - c) * 0.08; }));
  }

  /* ==== 一屏的壳 ==== */

  function coloursViewHtml() {
    var h = store();
    var tier = h && h.mcTier ? h.mcTier() : '1';
    var off = h && h.mcThemeOff ? h.mcThemeOff() : false;
    var currentSlot = tier === 'canvas' ? '1' : tier;
    var tierText = h && h.ctsMeta ? h.ctsMeta('colour_tier').text[currentSlot] : ('Save ' + currentSlot);
    var switchBtnText = off ? 'Switch to Custom theme' : 'Switch to Canvas colours';
    var switchBtnClass = 'mc-set-btn btx-ctl mc-col-switch-btn' + (off ? ' is-canvas' : '');
    return '<div class="btx-bar mc-col-bar">' +
        '<div class="btx-title">Theme Customizer</div>' +
        // 主题存档下拉框（Save 1 / Save 2 / Save 3）
        '<div class="cts-select-row btx-tier" ' + (off ? 'style="opacity:0.5;"' : '') + '>' +
          '<div class="cts-select btx-ctl" data-select="colour_tier">' +
            '<span class="cts-select-value">' + esc(tierText) + '</span>' +
            '<svg class="cts-select-arrow" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
            '<div class="cts-menu">' + (h ? h.ctsMenuHtml('colour_tier') : '') + '</div>' +
          '</div>' +
        '</div>' +
        // 置顶独立切换按钮：在 Canvas 原生模式与自定义主题之间切换
        '<button type="button" class="' + switchBtnClass + '">' + esc(switchBtnText) + '</button>' +
        // 这一格有你拧过的色时才出现：重置为主题默认色彩
        '<button type="button" class="mc-set-btn btx-ctl mc-col-revert" hidden>Reset theme colours</button>' +
        // 顶上那一排（主题名 / Browse themes / Import JSON）按他的要求撤了：
        // 主题墙从设置左栏那一档进，导入那颗在主题墙顶上还有一颗（共用下面那个文件框）
      '</div>' +
      '<input type="file" accept="application/json,.json" class="mc-set-file" hidden>' +
      '<div class="mc-col-body">' +
        // 深浅色单独一张卡，摆在开关卡上面：停在 Canvas 那一档时下面那张开关卡会整张收掉、
        // 正文换成那句 "Using Canvas colours"，那颗开关跟着被挤没了（你报的那个顺序问题）。
        // 这一档在 Canvas 那一格是管用的，所以它不能跟着那张卡一起收
        '<div class="mc-set-group mc-col-mode">' +
          // Canvas colours 那一档的深浅色（落点 style.css 第 36 节，判据 content.js 的 mcDarkOn）。
          // 这一行永远摆着，但只有停在 Canvas 那一格才拧得动：另外两种情况下页面那一层的色已经
          // 由某份主题或 BetterCampus 定了，深色的那套 token 上去就是两套抢同一层。
          // 行和说明都写死在这份模板里，因为 bindSelects 在打开那一刻扫完手边的控件，事后塞进来的那颗点了没反应
          selectRowHtml({ type: 'select', key: 'colour_mode', label: 'Page colours' }) +
          '<div class="mc-set-note" data-note="colour_mode">' + darkModeNoteHtml() + '</div>' +
        '</div>' +
        // 开关那一行是静态摆在这儿的：bindChecks 在 open() 那一刻就把手边的 input 全绑了，
        // 再往回塞进来的那颗就没有反应（以前"点着没动静"就是这么来的）
        '<div class="mc-set-group mc-col-switch">' +
          // 那三条"分不开就翻成纯黑/纯白"的可读性兜底以前是写死的，一档颜色会顺手改掉另一档文字。
          // 现在摊开给他选，默认照旧开着。落点在 content.js 的 mcFlipOn，四通路共用同一颗
          checkRowHtml({ type: 'check', key: 'mc_set_theme_flip', label: 'Keep text readable', defOn: true }) +
          // 这句挂在它那一颗的正下方。以前排在整组最后，读起来像在讲最后一行
          // Accent colour on text links（他报的"这行字位置不对"）。落点见 settings.css
          // 那条 .mc-set-group [data-note]：说明跟着自己那一行排
          '<div class="mc-set-note" data-note="mc_set_theme_flip">' + flipNoteHtml() + '</div>' +
          // 控件 hover 时补一圈强调色描边（缺 buttons 档的主题上 hover 会和身后那档撞平）。
          // 开关＝<html> 上的 mc-hover-ring，落点在 style.css 的 --mc-hover-ring
          checkRowHtml({ type: 'check', key: 'mc_hover_ring', label: 'Accent ring on hover', defOn: true }) +
          // 正文里的文字链接吃 Accent 那一档（落点在 style.css 的 mc-link-accent）。
          // 只落在纯文字链接上：带底色边框内边距的那种按钮链接不跟，实测 View Grades 那颗不受牵连
          checkRowHtml({ type: 'check', key: 'mc_link_accent', label: 'Accent colour on text links', defOn: true }) +
        '</div>' +
        '<div class="mc-col-intro">These are the colours this theme set. Pick one and change it, the page follows right away. Undo puts the theme colour back.</div>' +
        // 贴图不在这里改：那一套编辑器（选哪张、拖框、cover/contain/tile、换一张、删掉）
        // 自建主题那两步已经有了，这里只摆一颗进去的门，不重写第二份。
        // 这颗得自己带板：上一版它是文字链、颜色又为了不与卡底撞色翻成正文色，
        // 结果看着就像一句说明，他找了半天（"按钮在哪我咋没看到"）
        '<button type="button" class="mc-set-btn mc-col-pics" hidden>' +
          '<span>Edit this theme\'s pictures</span>' + aiIcon('arrow') + '</button>' +
        '<div class="mc-col-status" hidden></div>' +
        '<div class="mc-col-mockwrap" hidden>' + mockHtml() + '</div>' +
        '<div class="mc-col-rows"></div>' +
        '<div class="mc-col-empty" hidden></div>' +
        '<div class="mc-col-tail"></div>' +
      '</div>';
  }

  /* 一小块仿真：真的页面就是最大的预览，但页面上不一定正好有课程卡、完成的任务、
     进度轨道这几样，这里按这一档要用的样子各摆一小块，改哪档都能马上看到它落点 */
  function mockHtml() {
    return '<div class="mc-col-mock">' +
      '<div class="mc-col-mock-side">' +
        '<span class="mc-col-mock-icon"></span>' +
        '<span class="mc-col-mock-icon"></span>' +
        '<span class="mc-col-mock-icon"></span>' +
      '</div>' +
      '<div class="mc-col-mock-main">' +
        '<div class="mc-col-mock-card">' +
          '<span class="mc-col-mock-rail"></span>' +
          '<span class="mc-col-mock-h">Biology 201</span>' +
          '<span class="mc-col-mock-d">Due Friday</span>' +
        '</div>' +
        '<div class="mc-col-mock-list">' +
          '<div class="mc-col-mock-item">' +
            '<span class="mc-col-mock-box"></span>' +
            '<span class="mc-col-mock-t">Read chapter four</span>' +
          '</div>' +
          '<div class="mc-col-mock-item mc-col-mock-done">' +
            '<span class="mc-col-mock-box mc-col-mock-boxon"></span>' +
            '<span class="mc-col-mock-t">Lab report</span>' +
          '</div>' +
          '<div class="mc-col-mock-track"><span class="mc-col-mock-fill"></span></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function colourItemHtml(slot) {
    var info = COLOUR_INFO[slot];
    return '<div class="mc-col-item" data-slot="' + slot + '">' +
      '<button type="button" class="mc-col-row">' +
        '<span class="mc-col-chip"><span class="mc-col-chip-in">Aa</span></span>' +
        '<span class="mc-col-names">' +
          '<span class="mc-col-label">' + esc(info.name) + '</span>' +
          '<span class="mc-col-use">' + esc(info.use) + '</span>' +
        '</span>' +
        '<span class="mc-col-hex"></span>' +
        '<span class="mc-col-dot" aria-hidden="true"></span>' +
        '<svg class="mc-col-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
      '</button>' +
      editorHtml(slot) +
    '</div>';
  }

  function editorHtml(slot) {
    // 那两颗只挂在"铺一层底"的两行上：卡底和控件底板。其余档（文字、线、强调色）
    // 按下去＝看不见字，摆一颗能自毁的键没有意义
    var fills = slot === 'background-0' || slot === 'buttons';
    // 卡底那一档按下去页面是真糊的（拿页面底提一档当 tint 压到 60%），控件底板那一档按下去
    // 只是不铺板子、一点糊都没有，所以这一颗在两行上叫两个名字
    var clearLabel = slot === 'background-0' ? 'Frosted' : 'No colour';
    var clearBtn = fills
      ? '<button type="button" class="mc-set-btn mc-col-clear" data-part="clear" aria-pressed="false">' + clearLabel + '</button>'
      : '';
    var alphaCtl = fills
      ? '<span class="mc-col-alpha mc-mk-slide">'
        + '<span class="mc-mk-tool-label">Opacity</span>'
        + '<input type="range" min="0" max="100" step="5" data-part="alpha" aria-label="Opacity">'
        + '<span class="mc-mk-slide-out" data-part="alphav">100%</span>'
        + '</span>'
      : '';
    return '<div class="mc-col-editor"><div class="mc-col-editor-in">' +
      '<div class="mc-col-picks">' +
        '<div class="mc-col-field" data-part="field"><span class="mc-col-knob" data-part="knob"></span></div>' +
        '<div class="mc-col-hue" data-part="hue"><span class="mc-col-knob mc-col-hue-knob" data-part="hueknob"></span></div>' +
      '</div>' +
      '<div class="mc-col-tools">' +
        '<input type="text" class="mc-col-input" spellcheck="false" maxlength="7" aria-label="Hex value">' +
        '<button type="button" class="mc-set-btn" data-part="up">Lighter</button>' +
        '<button type="button" class="mc-set-btn" data-part="down">Darker</button>' +
        clearBtn +
        alphaCtl +
        '<button type="button" class="mc-set-btn mc-col-undo" data-part="undo">Undo</button>' +
      '</div>' +
      '<div class="mc-col-tips"></div>' +
    '</div></div>';
  }

  /* 字体那一行：和上面几行色共用 .mc-col-row 的几何和 .mc-col-item.open 那条展开过渡，
     点开在同一张卡里长高，不另起浮层。里面那排药丸用各自的字体写自己的名字 */
  function fontItemHtml() {
    return '<div class="mc-col-item mc-col-font">' +
      '<button type="button" class="mc-col-row">' +
        '<span class="mc-col-chip"><span class="mc-col-chip-in">Aa</span></span>' +
        '<span class="mc-col-names">' +
          '<span class="mc-col-label">Text font</span>' +
          '<span class="mc-col-use"></span>' +
        '</span>' +
        '<span class="mc-col-hex mc-col-font-tag"></span>' +
        '<span class="mc-col-dot" aria-hidden="true"></span>' +
        '<svg class="mc-col-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
      '</button>' +
      '<div class="mc-col-editor"><div class="mc-col-editor-in">' +
        fontPickerHtml() +
      '</div></div>' +
    '</div>';
  }

  // 一屏只留一个主角：现在还不能改色时（BC 在跑 / 还没主题），
  // 把那句"为什么不能改"做成一张带粗标题的卡片，并藏掉平时那行引导语，
  // 免得一屏三行一样大的字糊在一起（他说的"逻辑混乱、没重点、字体好多"）。
  function showNotice(title, body, btnText, onBtnClick) {
    var intro = p.colors.querySelector('.mc-col-intro');
    if (intro) intro.hidden = true;
    var pics = p.colors.querySelector('.mc-col-pics');
    if (pics) pics.hidden = true;
    var sw = p.colors.querySelector('.mc-col-switch');
    if (sw) sw.hidden = false;
    var empty = p.colors.querySelector('.mc-col-empty');
    empty.hidden = false;
    empty.classList.add('mc-col-notice');
    empty.textContent = '';
    empty.appendChild(el('div', 'mc-col-notice-t', title));
    empty.appendChild(el('div', 'mc-col-notice-b', body));
    if (btnText && onBtnClick) {
      var actWrap = el('div', 'mc-col-notice-act');
      var actBtn = el('button', 'mc-set-btn btx-ctl', btnText);
      actBtn.type = 'button';
      actBtn.addEventListener('click', onBtnClick);
      actWrap.appendChild(actBtn);
      empty.appendChild(actWrap);
    }
  }

  /* 顶上那颗 "Use theme colours" 出不出，只看正在用的这一格里有没有他亲手拧过的色。
     拧色那条通路只重画那一行、不重建整屏，所以那颗要单独跟着翻（renderColours 和 commit 两边都调它） */
  function syncRevert() {
    if (!p || !p.colors) return;
    var btn = p.colors.querySelector('.mc-col-revert');
    var h = store();
    if (!btn || !h) return;
    var off = h.mcThemeOff ? h.mcThemeOff() : false;
    var mine = h.mcSaveInfo ? h.mcSaveInfo().edits : 0;
    btn.hidden = off || !mine;
  }

  function renderColours() {
    if (!p || !p.colors || p.colors.hidden) return;
    var h = store();
    var rows = h && h.mcThemeSlotRows ? h.mcThemeSlotRows() : null;
    var snap = h ? h.mcSnapshot() : null;
    var box = p.colors.querySelector('.mc-col-rows');
    var wrap = p.colors.querySelector('.mc-col-mockwrap');
    var empty = p.colors.querySelector('.mc-col-empty');
    var intro = p.colors.querySelector('.mc-col-intro');
    var sw = p.colors.querySelector('.mc-col-switch');
    var off = h && h.mcThemeOff ? h.mcThemeOff() : false;
    col.items = {};
    col.values = {};
    // 这一屏每一行都是重搭的：旧节点已经不在页面上了，字体那一行的引用和展开态要一起清
    col.font = null;
    col.fontOpen = false;
    syncRevert();
    // 深浅色那行的按不动态跟着这一趟重算：BC 是晚挂载的，面板开着的时候它会从"不在"翻成"在跑"
    syncDarkRow();
    /* 停在 Canvas 那一档：那十二行没有可改的东西（这一格没有一份主题的色可以拧），
       所以正文换成一句说明。但深浅色那一行是管用的，而且这一格是它唯一管用的地方，
       所以这句要把它说出来，不能再写成"这一屏什么都没得改" */
    if (off) {
      box.textContent = '';
      wrap.hidden = true;
      showNotice('Using Canvas colours',
        'The page is painted with Canvas original colours, so there are no theme colours to edit here. Light and Dark mode above does apply. To customize colours, pick a theme from the Theme Picker.',
        'Browse themes', function () { showView('themes'); });
      renderColoursTail();
      return;
    }
    // BC 在跑也照样让他编辑这一屏：拧色那一步会把 Theme 那一档翻回 Modern Canvas
    // （见 btxClaimThemeOwner），所以不存在"改了不生效"的假开关
    if (!rows || !snap || !Object.keys(rows).some(function (s) { return rows[s].color || rows[s].hasImage; })) {
      box.textContent = '';
      wrap.hidden = true;
      showNotice('No theme selected',
        "You haven't chosen a theme yet, so there are no theme colours to edit or reset here. Would you like to check out the Theme Picker?",
        'Browse themes', function () { showView('themes'); });
      renderColoursTail();
      return;
    }
    empty.hidden = true;
    empty.classList.remove('mc-col-notice');
    if (intro) intro.hidden = false;
    var pics = p.colors.querySelector('.mc-col-pics');
    if (pics) pics.hidden = false;
    if (sw) sw.hidden = false;
    wrap.hidden = false;
    col.view = rows;
    box.textContent = '';
    COLOUR_GROUPS.forEach(function (group) {
      var sec = el('section', 'mc-col-sec');
      sec.appendChild(el('div', 'mc-set-eyebrow', group.title));
      var card = el('div', 'mc-set-group mc-col-group');
      group.slots.forEach(function (slot) {
        var item = el('div');
        item.innerHTML = colourItemHtml(slot);
        var node = item.firstElementChild;
        card.appendChild(node);
        col.items[slot] = {
          item: node,
          chipBox: node.querySelector('.mc-col-chip'),
          chip: node.querySelector('.mc-col-chip-in'),
          hex: node.querySelector('.mc-col-hex'),
          use: node.querySelector('.mc-col-use'),
          dot: node.querySelector('.mc-col-dot'),
          editor: node.querySelector('.mc-col-editor'),
          tips: node.querySelector('.mc-col-tips'),
          input: node.querySelector('.mc-col-input'),
          clear: node.querySelector('[data-part="clear"]'),
          alpha: node.querySelector('[data-part="alpha"]'),
          alphaOut: node.querySelector('[data-part="alphav"]'),
          undo: node.querySelector('[data-part="undo"]'),
          field: node.querySelector('[data-part="field"]'),
          knob: node.querySelector('[data-part="knob"]'),
          hue: node.querySelector('[data-part="hue"]'),
          hueknob: node.querySelector('[data-part="hueknob"]')
        };
        bindColourItem(slot);
        paintRow(slot, rows[slot].color);
      });
      // 字体那一行跟在 Text 那四档后面：它换的是整页的字，不是第 13 档色，所以不进 COLOUR_GROUPS。
      // 罩进那颗容错包装：这一行搭不起来只该少一行，不该把整屏带走
      if (group.hasFont) step('mountFontItem', function () { mountFontItem(card); });
      sec.appendChild(card);
      box.appendChild(sec);
    });
    paintMock();
    renderColoursTail();
  }

  // 尾部那颗"把我改过的全部撤掉"：只有真改过才出现，没改过那儿不留一颗空键
  function renderColoursTail() {
    var h = store();
    if (!p || !p.colors) return;
    var tail = p.colors.querySelector('.mc-col-tail');
    tail.textContent = '';
    if (!h || !h.mcThemeEdited || !h.mcThemeEdited()) return;
    var btn = el('button', 'mc-set-btn mc-col-reset', 'Undo all my changes');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      h.step('mcResetSlotColors', function () { h.mcResetSlotColors(); });
      // 这句说的是"我改过的全部"，那字体也算一份改动：顶上那颗只点名的 "Reset theme colours" 不管它
      if (h.mcResetFont) h.step('mcResetFont', function () { h.mcResetFont(); });
      closeEditor();
      renderColours();
    });
    tail.appendChild(btn);
  }

  // 每次点开都重新读快照：主题可能在别处被换掉（主题墙 Apply、另一个标签页导入）
  function openColours() {
    col.drag = null;
    col.open = '';
    clearDraft();
    renderColours();
  }

  /* ==== 一行 ==== */

  function slotColor(slot) { return col.view && col.view[slot] ? col.view[slot].color : ''; }

  function paintRow(slot, hex) {
    var item = col.items[slot];
    if (!item) return;
    col.values[slot] = hex;
    // 色块底色一律涂在外层那颗 30×30 方框上（.mc-col-chip）。
    // 上一版涂在了内层 .mc-col-chip-in 那颗粒 inline span 上——它没有尺寸，涂了也看不见，
    // 就是你截图里那一排空方框。内层那颗只留给文字档的 "Aa" 字样。
    if (COLOUR_INK_SLOTS[slot]) {
      // 文字那一档不涂一块死色：方框铺它要压的底色，"Aa" 用这一档色写出来，
      // 一眼能看出它在卡底上读不读得清（光看一块色看不出来）
      // 卡底那一档已经并进 background-0：方框铺的底色就是它（主题自带 cards 时才是 cards）
      var base = slot === 'sidebar-text' ? (col.values.sidebar || slotColor('sidebar') || '#ffffff')
        : (col.values['background-0'] || slotColor('background-0') || '#ffffff');
      item.chipBox.style.background = base;
      item.chip.textContent = 'Aa';
      item.chip.style.color = hex || 'transparent';
    } else if (hex) {
      item.chipBox.style.background = hex;
      item.chip.textContent = '';
    } else {
      // 这一档压根没纯色（整串是图）：清空行内底色，让 .btx-empty 那颗斜纹透出来，别画一块白假装有色
      item.chipBox.style.background = '';
      item.chip.textContent = '';
    }
    item.chipBox.classList.toggle('btx-empty', !hex);
    var view = col.view && col.view[slot] ? col.view[slot] : {};
    // 这一档现在画的是主题那幅图（sidebar 1067/3197 份、background-0 63 份）。它不再是"改不动"的一行：
    // 挑一颗色＝把图撤掉，只画这颗色；Undo 把图放回来。值那一列只有 76px，那儿放一个词，整句放下面那行
    var picture = !!view.hasImage;
    var flattened = !picture && !!view.baseImage && !!view.edited;
    // 那颗 "No colour" 的按下态：这一档现在是不是透明。值由 content.js 那一侧报过来，
    // 这儿不另算一份判据（两边各算就会出现"行上写一个色、页面画另一个色"）
    if (item.clear) item.clear.setAttribute('aria-pressed', view.clear ? 'true' : 'false');
    item.hex.textContent = picture ? 'picture'
      : (view.clear && slot === 'background-0' ? 'frosted'
        : (hex ? hex.toUpperCase() : 'no colour'));
    if (item.use) {
      var note = COLOUR_INFO[slot].use;
      // 那颗开关关着的时候，这一档不再刷文字链接，这句就得缩回来说真话
      if (slot === 'links' && localStorage.getItem('mc_link_accent') === '0') {
        note = 'Notification bar, switches, tick marks';
      }
      if (picture) {
        note = 'The theme puts a picture here. Picking a colour takes that picture off. Undo puts it back.';
      } else if (flattened) {
        note = COLOUR_INFO[slot].use + '. The picture this theme put here is off until you press Undo.';
      } else if (!hex) {
        // 空的这一档到底借了谁：判据在 content.js（那边才有退路链），这边只负责摆这一句
        var fh = store();
        var back = fh && fh.mcSlotFallbackNote ? fh.mcSlotFallbackNote(slot) : '';
        if (back) note += '. ' + back;
      }
      item.use.textContent = note;
    }
    var edited = !!view.edited;
    item.item.classList.toggle('mc-col-edited', edited);
    // 没改过的档不给它一颗"撤回去"：一颗按下去什么都不发生的键比没有更糟
    item.undo.hidden = !edited;
  }

  /* ==== 那一块仿真 ==== */

  /* 那一块仿真：一套摆法，两处用。Colours 那一屏读正在用的那份快照，自建主题那一屏读
     还没落盘的默认色，所以取色那一步由调用方递进来（v(档名, 退路色)） */
  function paintMock() {
    var wrap = p.colors.querySelector('.mc-col-mockwrap');
    if (!wrap || wrap.hidden) return;
    var h = store();
    var row = col.view && col.view['background-0'];
    var btnRow = col.view && col.view.buttons;
    // 卡底那一档看不穿的时候（作者给的透明，或者他按了 No colour）：仿真里那两块也得是
    // 页面上真正在用的那一串。磨砂那层由取色轮算，这边直接抄，不重算一遍提亮和 alpha
    var card = row && row.seeThrough
      ? ((h && h.mcFrostCss ? h.mcFrostCss() : '') || 'transparent')
      : '';
    paintMockIn(wrap, function (slot, fallback) {
      var draft = col.values[slot] || (slot === 'cards' ? col.values['background-0'] : '');
      if (slot === 'background-0' || slot === 'cards') {
        // 拖动中的那一档优先：那时候 col.values 是他正拧的色，抄来的那串还是上一轮的
        return draft || card || slotColor(slot) || fallback || '';
      }
      if (btnRow && btnRow.seeThrough && slot === 'buttons' && !draft) return 'transparent';
      return draft || slotColor(slot) || fallback || '';
    });
  }

  function paintMockIn(wrap, v) {
    // 卡底那一档已经并进 background-0（主题自带 cards 时才是 cards），仿真里两块都读这一颗
    var cardFill = function () { return v('cards') || v('background-0', '#ffffff'); };
    // 一块底色铺给这一类的每一块：仿真里同一档有两块（两行任务、两个方框），
    // 只挑第一块的话第二块就停在上一轮的色上
    var set = function (cls, styles) {
      wrap.querySelectorAll(cls).forEach(function (node) {
        for (var key in styles) if (Object.prototype.hasOwnProperty.call(styles, key)) node.style[key] = styles[key];
      });
    };
    set('.mc-col-mock', { background: v('background-0', '#f4f4f5') });
    set('.mc-col-mock-side', { background: v('sidebar', '#1f2937') });
    set('.mc-col-mock-icon', { background: v('sidebar-text', '#ffffff') });
    set('.mc-col-mock-main', { background: v('background-1', '#fafafa') });
    set('.mc-col-mock-card', { background: cardFill(), boxShadow: 'inset 0 0 0 1px ' + (v('borders', 'rgba(0,0,0,.08)')) });
    set('.mc-col-mock-rail', { background: v('links', '#2563eb') });
    set('.mc-col-mock-h', { color: v('text-0', '#111827') });
    set('.mc-col-mock-d', { color: v('text-2', '#9ca3af') });
    set('.mc-col-mock-list', { background: cardFill() });
    set('.mc-col-mock-item', { background: v('buttons', '#f3f4f6') });
    set('.mc-col-mock-done', { background: v('background-1', '#fafafa') });
    set('.mc-col-mock-box', { background: v('background-2', '#e5e7eb') });
    set('.mc-col-mock-boxon', { background: v('links', '#2563eb') });
    set('.mc-col-mock-t', { color: v('text-0', '#111827') });
    set('.mc-col-mock-done .mc-col-mock-t', { color: v('text-2', '#9ca3af') });
    set('.mc-col-mock-track', { background: v('background-2', '#e5e7eb') });
    set('.mc-col-mock-fill', { background: v('links', '#2563eb') });
  }

  /* ==== 字体那一行 ====
     面板这边只管摆和读：挑一颗药丸、或者交一条链接／一个字体名，都落到 content.js 的 mcSetFont，
     那一层把"你挑的"和"这份主题自带的"两层一起写进这一格存档，再重编译那份表、换那两条 <link>。
     改色那两颗全局撤销键（顶上 "Reset theme colours"、底下 "Undo all my changes"）的文案各自点名
     它们撤的是什么，所以字体不跟着它们一起被抹掉：这一行自己的那颗 Default 就是它的撤销。 */

  var FONT_TIP = 'Pick one of these, or paste a link from Google Fonts. The page follows right away. '
    + 'The quiz screen keeps the system font, so typing stays smooth there.';

  function fontChip(fam) {
    var btn = el('button', 'mc-set-btn mc-col-font-chip', fam || 'Default');
    btn.type = 'button';
    // 每一颗都钉一行内字族：页面那条整页字族的规则是 body 全后代加 !important，
    // 只有行内 !important 压得住它。名单里那 12 颗钉自己的字体，
    // Default 那颗钉面板自己那套中性字栈——它没有"自己的字体"，那几个字就该一直是 Default 的样子，
    // 不然每换一次字体它跟着变一次，看着像它也是一档字体
    btn.style.setProperty('font-family', fam ? "'" + fam + "'" : BTX_BASE_FONT, 'important');
    if (fam) btn.setAttribute('data-font', fam);
    return btn;
  }

  // 显示用的名字：只给了一条链接、名字藏在那条链接里的时候，从 family= 那一段读出来。
  // 这一段到 : （字重）或 & （下一个参数）为止：作者常把整段 <link> 粘进地址里，切一刀才读得干净
  function fontShown(font) {
    var h = store();
    var fam = h && h.mcFontName ? h.mcFontName(font) : '';
    if (fam) return fam;
    var m = String((font && font.link) || '').match(/family=([^&]+)/i);
    return m ? m[1].split(':')[0].replace(/\+/g, ' ').replace(/%20/gi, ' ').replace(/["'<>&]/g, '').trim() : '';
  }

  // 输入框收两种写法：一条完整地址，或者光一个字体名（只有名字时那边自己拼 Google 的地址）
  function fontFromText(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    if (/^https?:/i.test(s)) return { family: fontShown({ link: s }), link: s };
    var fam = s.replace(/[^\w .-]/g, '').trim();
    return fam ? { family: fam, link: '' } : '';
  }

  /* 这条链接到底有没有把字体拉下来：Google 对一个不存在的字族回一句错误文本，<link> 那边
     不一定报错，页面只是静静退回系统字＝按下去什么都不发生最难查的那种。所以判据用 document.fonts：
     链接加载完再查这个字族有没有真的登记进来。全程不额外发请求，也不等超时 */
  function mcFontReady(font, done) {
    var h = store();
    var fam = h && h.mcFontFamily ? h.mcFontFamily(font) : '';
    var links = h && h.mcFontLinks ? h.mcFontLinks(font) : [];
    if (!fam || !links.length) { done(false); return; }
    if (!document.fonts || !document.fonts.load) { done(true); return; }
    var pending = 0, failed = false, settled = false;
    var finish = function (okFlag) {
      if (settled) return;
      settled = true;
      clearTimeout(hold);
      done(okFlag);
    };
    var check = function () {
      if (failed) { finish(false); return; }
      if (pending > 0) return;
      try {
        document.fonts.load('16px ' + fam, 'Aa').then(function (faces) {
          finish(!!(faces && faces.length));
        }, function () { finish(false); });
      } catch (e) { finish(false); }
    };
    // 那条 <link> 一直不回话（地址能连但字体包不下）也得有个结果：到点就按"查无此字体"收，
    // 不能让那句 Checking 一直挂着
    var hold = setTimeout(function () { finish(false); }, 2500);
    links.forEach(function (href) {
      if (btxFonts[href]) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.setAttribute('data-bcx-theme-preview', '');
      pending++;
      link.addEventListener('load', function () { pending--; check(); });
      link.addEventListener('error', function () { failed = true; pending--; check(); });
      btxFonts[href] = link;
      document.head.appendChild(link);
    });
    check();
  }

  /* 那一排药丸 + 输入框 + 提示行，两处共用一份：
     Customizer 那一屏交的是"正在用的这一格"（你挑的那份盖在主题自带的那份上面），
     自建主题那一屏交的是"这份主题自带哪一份"（还没有覆盖这一层）。
     两边只差 api 那三颗，所以名单、校验、那颗跳转、选中态不再各写一遍 */
  function fontPickerHtml() {
    return '<div class="mc-col-fonts"></div>' +
      '<div class="mc-col-tools">' +
        '<input type="text" class="mc-col-input mc-col-font-in" spellcheck="false" ' +
          'aria-label="Google Fonts link or font name" ' +
          'placeholder="Paste a Google Fonts link, or type a font name">' +
        // 那颗跳转借 AI 那一屏 "Where to get key" 同一颗样式（.mcx-ai-link）：同一件事不另起一套排版
        '<button type="button" class="mcx-ai-link mc-col-font-more">' +
          '<span>Find more fonts</span>' + aiIcon('ext') + '</button>' +
      '</div>' +
      '<div class="mc-col-tips"></div>';
  }

  function mountFontPicker(root, api) {
    var k = {
      chips: root.querySelector('.mc-col-fonts'),
      input: root.querySelector('.mc-col-font-in'),
      more: root.querySelector('.mc-col-font-more'),
      tips: root.querySelector('.mc-col-tips'),
      typed: ''
    };
    k.repaint = function () {
      var st = api.get() || {};
      k.chips.querySelectorAll('.mc-col-font-chip').forEach(function (btn) {
        var want = btn.getAttribute('data-font') || '';
        // Default 那颗＝"没挑过"这一档，不能因为某条链接里读不出名字就跟着亮
        var on = st.edit ? (!!want && (st.edit.family || '') === want) : !want;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    // 那 12 条链接：Customizer 那一屏等他点开这一行才挂（一进设置页就拉十二份字体不值当），
    // 自建那一屏这一节是摊开的、没有"点开"这一步，所以它挂载完就得自己叫一次——
    // 不叫就是首次进 creator 时每一颗药丸都显成回退字体，非先去 Customizer 开一次那一行才正常
    k.preload = function () {
      MC_FONTS.forEach(function (fam) {
        step('btxUseFont', function () { btxUseFont({ family: fam, link: '' }); });
      });
    };
    k.open = function () {
      k.typed = '';
      k.tips.textContent = api.tip;
      k.preload();
    };
    k.chips.appendChild(fontChip(''));
    MC_FONTS.forEach(function (fam) { k.chips.appendChild(fontChip(fam)); });
    k.chips.querySelectorAll('.mc-col-font-chip').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var fam = btn.getAttribute('data-font') || '';
        api.set(fam ? { family: fam, link: '' } : null);
        k.repaint();
      });
    });
    k.more.addEventListener('click', function (e) {
      e.stopPropagation();
      window.open(MC_FONTS_URL, '_blank', 'noopener');
    });
    var submit = function () {
      var raw = k.input.value.trim();
      if (!raw || raw === k.typed) return;   // 回车和失焦会各来一次，别查两遍
      k.typed = raw;
      var font = fontFromText(raw);
      if (!font) {
        k.tips.textContent = 'That is neither a link nor a font name. A Google Fonts link looks like '
          + 'https://fonts.googleapis.com/css2?family=Jost';
        return;
      }
      var name = fontShown(font);
      k.tips.textContent = 'Checking' + (name ? ' ' + name : '') + '…';
      mcFontReady(font, function (ok) {
        if (!ok) {
          k.tips.textContent = 'Google Fonts has no font named ' + (name || 'on that link') + '.';
          return;
        }
        api.set(font);
        k.typed = '';
        k.input.value = '';
        k.tips.textContent = api.tip;
        k.repaint();
      });
    };
    k.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    k.input.addEventListener('change', submit);
    k.repaint();
    return k;
  }

  function paintFontRow() {
    var h = store();
    var f = col.font;
    if (!h || !f || !h.mcFontState) return;
    var st = h.mcFontState();
    var eff = st.edit || st.base || null;
    var fam = h.mcFontFamily ? h.mcFontFamily(eff) : '';
    // 方框照文字那一档的画法：底铺卡底，"Aa" 用正文色，字用现在生效的这一份字体
    f.chipBox.style.background = col.values['background-0'] || slotColor('background-0') || '#ffffff';
    f.chip.style.color = col.values['text-0'] || slotColor('text-0') || 'transparent';
    if (fam) f.chip.style.setProperty('font-family', fam, 'important');
    else f.chip.style.removeProperty('font-family');
    f.tag.textContent = st.edit ? 'Custom' : 'Default';
    f.item.classList.toggle('mc-col-edited', !!st.edit);
    var lands = 'Titles, cards, buttons, every word on the page.';
    var name = fontShown(eff);
    f.use.textContent = st.edit
      ? lands + ' Now using ' + (name || 'that font') + '.'
      : (st.base && name
        ? lands + ' This theme brings ' + name + '. Press a pill below to replace it.'
        : lands + ' Canvas keeps its own font until you pick one.');
    f.picker.repaint();
  }

  function applyFont(font) {
    var h = store();
    if (!h) return;
    h.step('mcSetFont', function () { return h.mcSetFont(font); });
    // 和他拧一颗色完全同一条收尾：先认"这一层归我们"，再跑一趟取色。
    // 那一趟才把 <link> 换成新字族（applyModernSheets 里那一步），只存快照的话页面上还是老字体
    step('claimThemeOwner', btxClaimThemeOwner);
    h.step('applyModernPalette', h.applyModernPalette);
    paintFontRow();
    renderColoursTail();
  }

  function openFont() {
    var f = col.font;
    if (!f) return;
    closeEditor();
    col.fontOpen = true;
    f.item.classList.add('open');
    f.picker.open();
  }

  function closeFont() {
    if (!col.fontOpen) return;
    var f = col.font;
    if (f) f.item.classList.remove('open');
    col.fontOpen = false;
  }

  function mountFontItem(card) {
    var box = el('div');
    box.innerHTML = fontItemHtml();
    var node = box.firstElementChild;
    card.appendChild(node);
    var f = col.font = {
      item: node,
      row: node.querySelector('.mc-col-row'),
      chipBox: node.querySelector('.mc-col-chip'),
      chip: node.querySelector('.mc-col-chip-in'),
      use: node.querySelector('.mc-col-use'),
      tag: node.querySelector('.mc-col-font-tag')
    };
    f.picker = mountFontPicker(node, {
      tip: FONT_TIP,
      get: function () {
        var h = store();
        return h && h.mcFontState ? h.mcFontState() : { edit: null, base: null };
      },
      set: function (font) { applyFont(font); }
    });
    f.row.addEventListener('click', function () {
      if (col.fontOpen) closeFont();
      else openFont();
    });
    paintFontRow();
  }

  /* ==== 取色器 ==== */

  function bindColourItem(slot) {
    var h = store();
    var item = col.items[slot];
    if (!h || !item) return;
    item.row = item.item.querySelector('.mc-col-row');
    item.row.addEventListener('click', function () {
      if (col.open === slot) { closeEditor(); return; }
      openEditor(slot);
    });
    item.undo.addEventListener('click', function (e) {
      e.stopPropagation();
      commit(slot, '', true);
    });
    if (item.clear) item.clear.addEventListener('click', function (e) {
      e.stopPropagation();
      commitClear(slot);
    });
    if (item.alpha) {
      // 每次重建这一行都回读一次：滑杆可能在别的标签页里被拧过，也可能刚被 Undo 撤掉
      item.alpha.value = String(h.mcSlotAlpha ? h.mcSlotAlpha(slot) : 100);
      item.alphaOut.textContent = item.alpha.value + '%';
      // 拖动过程中就把这一档画上：只重跑那两档的透明度，不跑整轮取色（那一趟要抄卡图）
      item.alpha.addEventListener('input', function () {
        item.alphaOut.textContent = item.alpha.value + '%';
        h.step('mcSetSlotAlpha', function () { h.mcSetSlotAlpha(slot, item.alpha.value); });
      });
      item.alpha.addEventListener('change', function (e) {
        e.stopPropagation();
        h.step('applyModernPalette', h.applyModernPalette);
      });
    }
    item.input.addEventListener('change', function () {
      var typed = item.input.value.trim();
      if (/^[0-9a-fA-F]{3}$/.test(typed)) typed = '#' + typed[1] + typed[1] + typed[2] + typed[2] + typed[3] + typed[3];
      if (!/^#[0-9a-fA-F]{6}$/.test(typed)) { item.input.value = col.values[slot] || ''; return; }
      apply(slot, typed);
      commit(slot, typed);
    });
    dragify(item, slot);
    item.item.querySelector('[data-part="up"]').addEventListener('click', function (e) {
      e.stopPropagation();
      nudge(slot, true);
    });
    item.item.querySelector('[data-part="down"]').addEventListener('click', function (e) {
      e.stopPropagation();
      nudge(slot, false);
    });
  }

  function syncInspectState(inspecting) {
    if (p && p.overlay) {
      p.overlay.classList.toggle('mc-set-inspecting', !!inspecting);
    }
  }

  function openEditor(slot) {
    closeFont();
    closeEditor();
    var item = col.items[slot];
    if (!item) return;
    col.open = slot;
    item.item.classList.add('open');
    syncInspectState(true);
    syncEditor(slot);
  }

  function closeEditor() {
    if (!col.open) return;
    var item = col.items[col.open];
    if (item) item.item.classList.remove('open');
    col.open = '';
    syncInspectState(false);
  }

  // 方块和色相条上那两个圆钮的位置：一次算完，拖动过程中只挪它们
  function syncEditor(slot) {
    var item = col.items[slot];
    if (!item) return;
    var hex = col.values[slot] || slotColor(slot) || '#ffffff';
    var hsv = colHsv(colRgb(hex) || [255, 255, 255]);
    item.hsv = hsv;
    item.field.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),'
      + 'linear-gradient(to right,#fff,hsl(' + Math.round(hsv[0] * 360) + ',100%,50%))';
    item.knob.style.left = (hsv[1] * 100) + '%';
    item.knob.style.top = ((1 - hsv[2]) * 100) + '%';
    item.hueknob.style.top = ((1 - hsv[0]) * 100) + '%';
    if (document.activeElement !== item.input) item.input.value = hex.toUpperCase();
    var h = store();
    var tips = ['Drag the square to set how deep and how light, the bar on the right to set the colour itself.'];
    if (h && h.mcSlotHint) {
      var hint = h.mcSlotHint(slot, hex);
      if (hint) tips.push(hint);
    }
    tips.push('Lighter and darker move only this colour.');
    item.tips.textContent = tips.join(' ');
  }

  // 往白或黑挪一档再落盘。名字不能叫 step：文件底部有个 step(name, fn) 容错包装，
  // 同名函数声明会互相覆盖，点 Lighter 就变成给那个包装器传了个 true 当函数 → "fn is not a function"
  function nudge(slot, up) {
    var next = colStep(col.values[slot] || slotColor(slot) || '#ffffff', up);
    apply(slot, next);
    syncEditor(slot);
    commit(slot, next);
  }

  /* 拖动：按下就算，指针跑出方块也继续跟着（setPointerCapture）。
     局部反馈（钮、行上的色块、仿真）当场动，整页那一份盖色每帧最多一次 */
  function dragify(item, slot) {
    var start = function (node, onPoint) {
      node.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (col.drag) col.drag();
        try { node.setPointerCapture(e.pointerId); } catch (err) {}
        var from = col.values[slot];
        var move = function (ev) {
          var rect = node.getBoundingClientRect();
          onPoint(
            Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))),
            Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)))
          );
        };
        move(e);
        var stop = function () {
          col.drag = null;
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', stop);
          node.removeEventListener('pointercancel', stop);
          // 挪过才写快照；按下去没拖动（或者拖回原位）不值得存一次、重编译一份表
          if (col.values[slot] !== from) commit(slot, col.values[slot]);
          else clearDraft();
        };
        col.drag = stop;
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', stop);
        node.addEventListener('pointercancel', stop);
      });
    };
    start(item.field, function (x, y) {
      var hsv = item.hsv || [0, 0, 1];
      // colRgbFromHsv 返回的是 [r,g,b] 数组，必须 colHex 收成 #rrggbb 再往下走：
      // 直接喂给 apply 会被 String() 成 "52.013663222240645,147.22495118045234,…" 这种浮点串，
      // 写进快照后读回来解析不成色 → 色块空、钮弹回左上、值那一列又变超长（就是"松手弹回"）
      apply(slot, colHex(colRgbFromHsv([hsv[0], x, 1 - y])));
      item.knob.style.left = (x * 100) + '%';
      item.knob.style.top = (y * 100) + '%';
    });
    start(item.hue, function (x, y) {
      var hsv = item.hsv || [0, 0, 1];
      var hue = 1 - y;
      apply(slot, colHex(colRgbFromHsv([hue, hsv[1], hsv[2]])));
      item.hueknob.style.top = (y * 100) + '%';
      syncField(slot);
    });
  }

  function syncField(slot) {
    var item = col.items[slot];
    if (!item) return;
    var hex = col.values[slot] || '#ffffff';
    var hsv = colHsv(colRgb(hex) || [255, 255, 255]);
    item.hsv = hsv;
    item.field.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),'
      + 'linear-gradient(to right,#fff,hsl(' + Math.round(hsv[0] * 360) + ',100%,50%))';
    item.knob.style.left = (hsv[1] * 100) + '%';
    item.knob.style.top = ((1 - hsv[2]) * 100) + '%';
  }

  // 拖到一半的值：行上、仿真、整页都跟着走，但还不写快照
  function apply(slot, hex) {
    hex = String(hex).toLowerCase();
    paintRow(slot, hex);
    paintMock();
    var item = col.items[slot];
    if (item && document.activeElement !== item.input) item.input.value = hex.toUpperCase();
    var map = {};
    map[slot] = hex;
    preview(map);
  }

  function preview(map) {
    col.pending = map;
    if (col.raf) return;
    col.raf = requestAnimationFrame(function () {
      col.raf = 0;
      var h = store();
      if (h && h.mcPreviewSlotColors) h.mcPreviewSlotColors(col.pending || {});
    });
  }

  // 把那份临时盖色摘干净（快照才是长久的）
  function clearDraft() {
    if (col.raf) { cancelAnimationFrame(col.raf); col.raf = 0; }
    col.pending = null;
    var h = store();
    if (h && h.mcPreviewSlotColors) h.mcPreviewSlotColors({});
  }

  // 松手（或敲完十六进制、按了 Lighter）才落进快照。undo 为真＝撤掉这一档
  function commit(slot, hex, undo) {
    var h = store();
    if (!h || !p) return;
    clearDraft();
    if (undo) h.step('mcResetSlotColors', function () { h.mcResetSlotColors([slot]); });
    else h.step('mcSetSlotColor', function () { h.mcSetSlotColor(slot, hex); });
    var rows = h.mcThemeSlotRows();
    col.view = rows;
    paintRow(slot, rows[slot].color);
    paintMock();
    // 字体那一行的方框铺的是卡底、字是正文色：这两档刚被他拧过，那一行要跟着重画
    if (col.font) paintFontRow();
    if (col.open === slot) syncEditor(slot);
    renderColoursTail();
    // 这一格从"没拧过"变成"拧过"＝顶上那颗 "Use theme colours" 要当场出现（这条不重建整屏）
    syncRevert();
    // 只要动了颜色，自动关闭深浅色调节并切换回浅色（避免深色引擎和自定义色冲突），深浅色选择器随之锁定
    if (localStorage.getItem('bc_colour_mode') === 'dark') {
      localStorage.setItem('bc_colour_mode', 'light');
      var selMode = p.colors ? p.colors.querySelector('[data-select="colour_mode"]') : null;
      if (selMode) {
        var valEl = selMode.querySelector('.cts-select-value');
        if (valEl) valEl.textContent = 'Light';
      }
    }
    syncDarkRow();
    // 他拧了一颗色＝他要用的就是我们这份主题，那一档当场翻回 Modern Canvas。
    // 排在下面那趟取色之前翻，同一趟就把页面换成我们的色，不留"改了但没生效"那一帧
    step('claimThemeOwner', btxClaimThemeOwner);
    // 兜底规则和那一族 --mc-* token 是这条通路算出来的（改一档会牵到别的档：
    // 比如卡底翻深了，正文那几档太淡就要当场换成读得清的色），所以改完跑它一趟
    h.step('applyModernPalette', h.applyModernPalette);
  }

  /* 那颗 "No colour"：卡底这一档在"透明"和"一颗实色"之间翻面，再按一下取消。
     它存成一个独立标记（content.js 的 mcSetSlotClear），不写进 background-0 的槽值——
     那颗槽值还同时管着页面底，往里塞 transparent 会把整页捅穿、露出浏览器的白底 */
  function commitClear(slot) {
    var h = store();
    if (!h || !p) return;
    var on = !(col.view && col.view[slot] && col.view[slot].clear);
    clearDraft();
    h.step('mcSetSlotClear', function () { h.mcSetSlotClear(slot, on); });
    var rows = h.mcThemeSlotRows();
    col.view = rows;
    paintRow(slot, rows[slot].color);
    paintMock();
    // 字体那一行的方框铺的是卡底、字是正文色：这两档刚被他拧过，那一行要跟着重画
    if (col.font) paintFontRow();
    if (col.open === slot) syncEditor(slot);
    renderColoursTail();
    syncRevert();
    if (localStorage.getItem('bc_colour_mode') === 'dark') {
      localStorage.setItem('bc_colour_mode', 'light');
      var selMode = p.colors ? p.colors.querySelector('[data-select="colour_mode"]') : null;
      if (selMode) {
        var valEl = selMode.querySelector('.cts-select-value');
        if (valEl) valEl.textContent = 'Light';
      }
    }
    syncDarkRow();
    step('claimThemeOwner', btxClaimThemeOwner);
    h.step('applyModernPalette', h.applyModernPalette);
  }

  /* ==== 自建主题 ====
     入口是主题墙顶上那颗 New theme，四步走完：贴图 → 用的是图里哪一块 → 默认色 → 看一眼再存。
     库里那些记录（含贴图）和"翻译成主题 JSON"的算法都在 theme-lib.js，这一节只管摆和收。

     默认色和 Colours 那一屏是两套东西：那一屏改的是正在用的这一格（写进快照的 edits），
     这一屏改的是这份主题自带的色（写进库）。所以在 Colours 里拧色不会动到这份主题的默认配置，
     而"Use theme colours"撤回去的也正是这里存的那一份。

     取色器那一套（方块＋色相条＋十六进制）沿用的是 Colours 那屏的 CSS 和算法函数，
     但控制器是这一节自己的一份：那座面板写的是快照，这里写的是还没落盘的一份记录，
     共用一套状态就会互相串色（改到没保存的主题上、或者把页面那一格顶掉）。 */

  var mk = { rec: null, step: 0, isNew: true, sel: null, picking: null, status: '', note: '', fromSave: false };
  var mkp = { slot: '', drag: null };
  var MK_STEPS = ['Pictures', 'Area', 'Colours', 'Review'];
  var MK_MAX_CARDS = 12;
  // 自建那一屏改的就是 Colours 那三组那 11 档（cards 一档已经并进 background-0，不单列）
  var MK_EDIT_SLOTS = COLOUR_GROUPS.reduce(function (out, g) { return out.concat(g.slots); }, []);

  function lib() { return window.mcLib || null; }

  function mkMissingLib() {
    btxNotice('Not ready', 'The theme builder did not come in with the copy of the extension running on this page. '
      + 'Reload this page once and open New theme again.');
    return true;
  }

  /* ---- 库的摆法 ---- */

  function mkList() {
    var l = lib();
    if (!l) return [];
    var q = (btx.query || '').trim().toLowerCase();
    var list = l.read().slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    return !q ? list : list.filter(function (r) { return String(r.name || '').toLowerCase().indexOf(q) !== -1; });
  }

  function mkApplied(rec) {
    var h = store();
    var snap = h && h.mcSnapshot ? h.mcSnapshot() : null;
    return !!(snap && snap.imported && snap.imported.code === 'mc:' + rec.id);
  }

  function mkStripEl(list) {
    var wrap = el('section', 'btx-mine');
    wrap.appendChild(el('div', 'btx-mine-head', 'Your themes'));
    var grid = el('div', 'btx-grid');
    list.forEach(function (rec) { grid.appendChild(mkCardEl(rec)); });
    wrap.appendChild(grid);
    return wrap;
  }

  /* 把"这张图用的是哪一块"画到一颗盒子上。那一层 .btx-cover/.btx-hero 的底色在 CSS 里写着
     !important，普通行内样式压不住它（上一版那十格色块全变灰就是这条咬人），
     所以外面那两层要用 important 那一份 */
  function mkPaintRegion(node, src, one, important, box) {
    var l = lib();
    var set = function (key, value) {
      if (important) node.style.setProperty(key, value, 'important');
      else node.style[key] = value;
    };
    if (!src) return;
    var region = l.regionCss(one, box);
    // setProperty 只认连字写的属性名，camelCase 那一份它静默收下但不画（上一版封面全是一块死色）
    set('background-image', 'url("' + src + '")');
    set('background-size', region.size);
    set('background-position', region.pos);
    set('background-repeat', region.repeat);
  }

  // 那一块封面就是这份主题的样子：侧栏那张图（或第一张卡图）铺在上面，
  // 没有图就按它自己那两档底色摆一条，一眼能看出是谁
  function mkCoverEl(rec, cls) {
    var l = lib();
    var cover = el('div', cls || 'btx-cover');
    var one = rec.sidebar || (rec.cards || [])[0] || null;
    var fill = mkSolid((rec.colors || {})['background-0'], '#f4f4f5');
    var side = mkSolid((rec.colors || {}).sidebar, '#1f2937');
    if (one && one.src) {
      // 底色先铺上：Contain／Tile 那两档图铺不满，剩下的那一块就该露这份主题的色
      cover.style.setProperty('background', side, 'important');
      mkPaintRegion(cover, one.src, one, true);
    } else {
      cover.style.setProperty('background',
        'linear-gradient(104deg,' + side + ' 0 30%,' + fill + ' 30%)', 'important');
    }
    return cover;
  }

  function mkCardEl(rec) {
    var card = el('div', 'btx-card');
    card.dataset.code = 'mc:' + rec.id;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.appendChild(mkCoverEl(rec));
    card.appendChild(el('div', 'btx-name', rec.name || 'Untitled theme'));
    card.appendChild(el('div', 'btx-by', 'Your theme' + (mkApplied(rec) ? ' · on the page now' : '')));
    card.addEventListener('click', function () { openCustomDetail(rec); });
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      openCustomDetail(rec);
    });
    return card;
  }

  function openCustomDetail(rec) {
    if (!p || p.themes.hidden) return;
    var l = lib();
    var h = store();
    if (!l) { mkMissingLib(); return; }
    btx.detail = rec;
    p.card.classList.add('btx-detail-open');
    p.view.querySelector('.btx-title').textContent = rec.name || 'Untitled theme';
    var body = p.view.querySelector('.btx-body');
    body.textContent = '';
    p.view.querySelector('.btx-foot').textContent = '';

    var wrap = el('div', 'btx-detail');
    wrap.appendChild(mkCoverEl(rec, 'btx-hero'));
    var info = el('div', 'btx-info');
    info.appendChild(el('div', 'btx-detail-name', rec.name || 'Untitled theme'));
    info.appendChild(el('div', 'btx-line', 'Your theme · ' + l.describe(rec)));
    info.appendChild(el('div', 'btx-line', 'Made ' + mkDate(rec.created) + ' · last changed ' + mkDate(rec.updated)));
    if (mkApplied(rec)) info.appendChild(el('div', 'btx-line', 'This theme is on the page right now.'));

    info.appendChild(el('div', 'btx-group', 'Colours'));
    var swatches = el('div', 'btx-swatches');
    var strip = el('div', 'btx-cards');
    // 色板和卡图这两块直接沿用主题墙详情那套摆法：把这份记录翻成 JSON，
    // 再把里面的引用换成真图，那边就照常画。resolve 收的是字符串，所以先 stringify 再 parse 回来
    var full = null;
    try { full = JSON.parse(l.resolve(JSON.stringify(l.buildThemeJson(rec)))); } catch (e) { full = null; }
    info.appendChild(swatches);
    info.appendChild(el('div', 'btx-group', 'Card images'));
    info.appendChild(strip);

    var actions = el('div', 'btx-actions');
    var apply = el('button', 'btx-apply btx-ctl', mkApplied(rec) ? 'Apply again' : 'Apply');
    apply.type = 'button';
    apply.disabled = !full;
    var status = el('div', 'cts-theme-status');
    apply.addEventListener('click', function () {
      apply.disabled = true;
      status.hidden = false;
      status.textContent = 'Reading the sidebar picture…';
      bakeRecSamples(rec).then(function (one) {
        try {
          h.mcApplyCustomTheme(one);
          location.reload();
        } catch (err) {
          apply.disabled = true;
          status.textContent = "Can't apply this theme: " + (err && err.message ? err.message : String(err));
        }
      });
    });
    actions.appendChild(apply);
    actions.appendChild(status);
    info.appendChild(actions);

    var mine = el('div', 'btx-actions mc-mk-manage');
    [['Edit', function () { openMaker(rec, 0); }],
      ['Download pictures', function () {
        var n = l.downloadZip(rec);
        status.textContent = 'Saved a folder with theme.json and ' + (n - 1) + (n - 1 === 1 ? ' picture' : ' pictures') + '.';
      }],
      ['Download theme.json', function () {
        l.downloadJson(rec);
        status.textContent = 'Saved theme.json. It carries the pictures inside it, so it can be brought back in on another browser.';
      }],
      ['Delete', function () { mkDelete(rec); }]
    ].forEach(function (pair) {
      var btn = el('button', 'mc-set-btn btx-ctl', pair[0]);
      btn.type = 'button';
      btn.addEventListener('click', pair[1]);
      mine.appendChild(btn);
    });
    info.appendChild(mine);
    wrap.appendChild(info);
    body.appendChild(wrap);
    if (full) fillThemeDetail(full, swatches, strip);
    else swatches.appendChild(el('div', 'btx-note', 'This record has no colours in it. Open Edit and set them.'));
    scrollWallToTop();
  }

  function mkDate(ms) {
    var d = new Date(Number(ms) || Date.now());
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function mkDelete(rec) {
    var l = lib();
    if (!l) return;
    var on = mkApplied(rec);
    btxAsk('mcx-del-theme', 'Delete ' + (rec.name || 'this theme') + '?',
      on ? 'It is the theme on the page right now. Deleting it takes its pictures off; the colours stay until you pick another theme.'
        : 'Its colours and pictures go. Other themes and your three saves are not touched.',
      'Delete', 'Keep it', function () {
        var res = l.remove(rec.id);
        if (!res.ok) { btxNotice('Not deleted', res.error); return; }
        renderThemeList();
      });
  }

  // 库里那些报错（存不下了）用面板这一家的弹窗说，不用浏览器原生那一颗
  function btxNotice(title, text) {
    btxAsk('mcx-notice-overlay', title, text, 'Close', '', function () {});
  }

  /* ---- 四步的壳 ---- */

  function makerViewHtml() {
    return '<div class="btx-bar mc-mk-bar">' +
        '<button type="button" class="btx-back mc-mk-back" data-act="mk-back" aria-label="Back">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.8 6.2 9 12l5.8 5.8"/></svg>' +
        '</button>' +
        '<div class="btx-title">New theme</div>' +
        '<div class="mc-mk-steps">' + MK_STEPS.map(function (name, i) {
          return '<button type="button" class="mc-set-btn btx-ctl mc-mk-step" data-act="mk-step" data-step="' + i + '">' + esc(name) + '</button>';
        }).join('') + '</div>' +
      '</div>' +
      '<input type="file" accept="image/*" class="mc-mk-file" hidden>' +
      '<div class="mc-mk-body"></div>' +
      '<div class="mc-mk-foot"></div>';
  }

  function openMakerView() {
    if (!p.maker.innerHTML) p.maker.innerHTML = makerViewHtml();
    if (p.makerBound) { renderMaker(); return; }
    p.makerBound = true;
    p.maker.addEventListener('click', mkClick);
    p.maker.addEventListener('input', mkInput);
    p.maker.addEventListener('change', mkChange);
    var file = p.maker.querySelector('.mc-mk-file');
    file.addEventListener('change', function () {
      var picked = file.files && file.files[0];
      file.value = '';
      if (!picked || !mk.picking) return;
      mkUpload(picked, mk.picking);
      mk.picking = null;
    });
    renderMaker();
  }

  function openMaker(rec, step) {
    var l = lib();
    if (!l) { showView('themes'); mkMissingLib(); return; }
    // 编辑动的是这一份的拷贝：没按 Save 就走掉，库里那一份一个字都不改
    mk.rec = rec ? l.normalize(JSON.parse(JSON.stringify(rec))) : l.blank(mkStartColors());
    mk.isNew = !rec;
    mk.fromSave = false;
    mk.step = Number(step) || 0;
    mk.sel = null;
    mk.status = '';
    showView('maker');
  }

  /* 从 Customizer 进去改这一格那份主题的贴图（侧栏 + 课程卡）。
     编辑器不自建第二份：那两步（Pictures／Area）本来就是为这件事写的，
     选哪一张、拖框定构图、cover／contain／tile、换一张、删掉、再加一张全都在里面。
     这一格用的若不是我们库里的主题（主题墙挑来的 BetterCampus 那份、或导入的 JSON），
     它的图不在库里、没有可改的地方——先照快照收成一份你自己的，再进去改。
     收的时候只换这一格指向哪份记录，颜色和你在这格拧过的那几档一个字都不动 */
  function openPicturesForThisSave() {
    var l = lib();
    var h = store();
    if (!l) { showView('themes'); mkMissingLib(); return; }
    if (!h || !h.mcSnapshot) return;
    var snap = h.mcSnapshot();
    if (!snap) {
      btxAsk('mcx-pics-no-theme', 'Nothing to edit',
        'This save is using Canvas original colours, so there is no theme behind it yet. Pick one from the Theme Picker first.',
        'OK');
      return;
    }
    var code = String((snap.imported && snap.imported.code) || '');
    if (code.indexOf('mc:') === 0) {
      var mine = l.get(code.slice(3));
      if (mine) { openMaker(mine, 0); mk.fromSave = true; return; }
      // 记录被删过：这一格还指着它，那就照页面上这份重新收一份
    }
    btxAsk('mcx-adopt-pictures', 'Edit the pictures',
      'This theme came from outside, so its pictures are not editable yet. We copy this theme into your own'
      + ' themes first, keeping its colours and pictures exactly as they are now, then open the picture editor.'
      + ' The colours you changed in this save stay changed.',
      'Copy it and edit', 'Cancel', function () {
        var made = l.recordFromSnapshot(snap);
        if (!made) return;
        var res = l.upsert(made);
        if (!res.ok) {
          btxAsk('mcx-adopt-fail', 'Could not copy it', res.error || 'The theme library is full.', 'OK');
          return;
        }
        if (h.mcAdoptThemeRecord) h.step('mcAdoptThemeRecord', function () { h.mcAdoptThemeRecord(res.rec.id, res.rec.name); });
        openMaker(res.rec, 0);
        mk.fromSave = true;
      });
  }

  // 新建时那份起手色：抄现在页面上这一格的样子（图不算，图有它自己那一步）
  function mkStartColors() {
    var l = lib();
    var h = store();
    var snap = h && h.mcSnapshot ? h.mcSnapshot() : null;
    var out = {};
    l.SLOTS.forEach(function (slot) {
      out[slot] = mkSolid(snap && snap.vars ? snap.vars['bc' + slot] : '', l.FALLBACK_COLORS[slot]);
    });
    return out;
  }

  function mkSolid(raw, fallback) {
    var s = String(raw || '').trim();
    if (!s || /url|gradient/i.test(s)) return fallback || '';
    var rgb = colRgb(s);
    return rgb ? colHex(rgb) : (fallback || '');
  }

  function mkPictureOne(rec, sel) {
    if (!sel) return null;
    return sel.kind === 'sidebar' ? rec.sidebar : (rec.cards || [])[sel.index] || null;
  }

  function mkCurrentSel() {
    var rec = mk.rec;
    if (!rec) return null;
    if (mk.sel && mkPictureOne(rec, mk.sel)) return mk.sel;
    if (rec.sidebar && rec.sidebar.src) return { kind: 'sidebar' };
    if ((rec.cards || []).length) return { kind: 'card', index: 0 };
    return null;
  }

  function renderMaker() {
    if (!p || !p.maker || p.maker.hidden || !mk.rec) return;
    var body = p.maker.querySelector('.mc-mk-body');
    var foot = p.maker.querySelector('.mc-mk-foot');
    p.maker.querySelector('.btx-title').textContent = mk.isNew ? 'New theme' : (mk.rec.name || 'Your theme');
    p.maker.querySelectorAll('.mc-mk-step').forEach(function (btn) {
      btn.classList.toggle('on', Number(btn.dataset.step) === mk.step);
    });
    body.textContent = '';
    mkp.slot = '';
    [mkPicturesStep, mkAreaStep, mkColoursStep, mkReviewStep][mk.step](body);
    foot.textContent = '';
    if (mk.status) foot.appendChild(el('div', 'mc-mk-status', mk.status));
    var row = el('div', 'mc-mk-btns');
    if (mk.step > 0) row.appendChild(mkBtn('Back', 'mk-prev'));
    if (mk.step < MK_STEPS.length - 1) row.appendChild(mkBtn('Next', 'mk-next', 'btx-apply'));
    else {
      row.appendChild(mkBtn(mk.isNew ? 'Save theme' : 'Save changes', 'mk-save', 'btx-apply'));
      row.appendChild(mkBtn('Save and apply', 'mk-save-apply'));
    }
    if (mk.isNew && mk.step === 0) row.appendChild(mkBtn('Cancel', 'mk-cancel'));
    foot.appendChild(row);
    scrollWallToTop(p.maker);
  }

  function mkBtn(text, act, cls) {
    var btn = el('button', 'mc-set-btn btx-ctl' + (cls ? ' ' + cls : ''), text);
    btn.type = 'button';
    btn.setAttribute('data-act', act);
    return btn;
  }

  function mkSec(title, note, inner) {
    var sec = el('section', 'mc-set-sec mc-mk-sec');
    sec.appendChild(el('div', 'mc-set-eyebrow', title));
    var card = el('div', 'mc-set-group mc-mk-card');
    if (note) card.appendChild(el('div', 'mc-set-note', note));
    if (inner) card.innerHTML = inner;
    sec.appendChild(card);
    return sec;
  }

  /* ---- 第 1 步：名字和贴图 ---- */

  function mkPicturesStep(body) {
    var l = lib();
    var rec = mk.rec;
    var sSide = l.SPEC.sidebar, sCard = l.SPEC.card;

    var name = el('div', 'mc-mk-name-row');
    name.innerHTML = '<input type="text" class="mc-mk-name btx-ctl" data-in="name" maxlength="60" spellcheck="false"' +
      ' placeholder="My theme" value="' + esc(rec.name) + '" aria-label="Theme name">';
    var nameSec = mkSec('Name', 'This is what shows on the wall and on the Colours page.', '');
    nameSec.querySelector('.mc-mk-card').appendChild(name);

    var sideSec = mkSec('Sidebar picture',
      'The sidebar is a tall strip, about ' + sSide.ratio + ' on a normal window. A picture '
      + sSide.sample + ' px fills that one. Other windows are taller or shorter, so they crop a little. '
      + 'The part nobody loses is marked with a dashed line in the next step.', '');
    sideSec.querySelector('.mc-mk-card').appendChild(mkPictureRow(rec.sidebar, { kind: 'sidebar' }, 'Sidebar'));

    var cardSec = mkSec('Card pictures',
      'Course cards are landscape, about ' + sCard.ratio + '. A picture ' + sCard.sample
      + ' px fills one. Your courses take them in order: the first picture goes to the first course, '
      + 'and when there are more courses than pictures it starts again at the first.', '');
    var cardBox = cardSec.querySelector('.mc-mk-card');
    if (!(rec.cards || []).length) cardBox.appendChild(el('div', 'mc-set-note', 'No card pictures yet. Add one, or leave it out and your cards keep Canvas colours.'));
    rec.cards.forEach(function (one, i) {
      cardBox.appendChild(mkPictureRow(one, { kind: 'card', index: i }, 'Picture ' + (i + 1)));
    });
    if ((rec.cards || []).length < MK_MAX_CARDS) cardBox.appendChild(mkAddRow('Add card picture'));
    else cardBox.appendChild(el('div', 'mc-set-note', MK_MAX_CARDS + ' pictures is the most one theme carries.'));

    var size = el('div', 'mc-mk-size');
    size.textContent = 'Pictures saved here take up room on this site: '
      + l.kb(l.libBytes()) + ' of ' + l.kb(l.LIB_LIMIT) + ' used, this theme ' + l.kb(l.bytesOf(rec)) + '.';
    body.appendChild(nameSec);
    body.appendChild(sideSec);
    body.appendChild(cardSec);
    body.appendChild(size);
  }

  // 一行就是一张图：左小图、中间它是什么、右边这一行自己的那几颗键
  function mkPictureRow(one, at, label) {
    var l = lib();
    var kind = at.kind;
    var row = el('div', 'mc-mk-pict' + (one && one.src ? '' : ' mc-mk-pict-none'));
    var box = el('div', 'mc-mk-thumb');
    // 没图就留一块斜纹：这一行右边那句"Nothing set"已经把话说完了，
    // 小图里再塞两个字反而挤成一团
    if (one && one.src) mkPaintRegion(box, one.src, one, false);
    else box.classList.add('empty');
    box.setAttribute('data-kind', kind);
    row.appendChild(box);

    var info = el('div', 'mc-mk-pic-info');
    info.appendChild(el('div', 'mc-mk-pic-name', label));
    var meta = el('div', 'mc-mk-pic-meta');
    meta.textContent = !one || !one.src ? 'Nothing set'
      : (/^data:/i.test(one.src) ? 'A picture you uploaded' : 'A link')
        + (one.width && one.height ? ' · ' + one.width + ' × ' + one.height : '')
        + (/^data:/i.test(one.src) ? ' · ' + l.kb(Math.round(one.src.length * 0.75)) : '')
        + ' · ' + mkModeName(one ? one.mode : 'cover');
    info.appendChild(meta);
    row.appendChild(info);

    var acts = el('div', 'mc-mk-pic-acts');
    if (one && one.src) {
      acts.appendChild(mkBtn('Set area', 'mk-area', ''));
      acts.appendChild(mkBtn('Replace', 'mk-upload'));
      if (kind === 'card') {
        acts.appendChild(mkBtn('Earlier', 'mk-move-left'));
        acts.appendChild(mkBtn('Later', 'mk-move-right'));
      }
      acts.appendChild(mkBtn('Remove', 'mk-remove'));
    } else {
      acts.appendChild(mkBtn('Upload picture', 'mk-upload'));
      acts.appendChild(mkBtn('Add link', 'mk-url-open'));
    }
    row.appendChild(acts);

    var url = el('div', 'mc-mk-url');
    url.hidden = true;
    url.innerHTML = '<input type="text" class="mc-mk-url-in btx-ctl" data-in="url" spellcheck="false"' +
      ' placeholder="https://example.com/picture.jpg" aria-label="Picture link">'
      + '<button type="button" class="mc-set-btn btx-ctl" data-act="mk-url-save">Use link</button>'
      + '<button type="button" class="mc-set-btn btx-ctl" data-act="mk-url-cancel">Cancel</button>';
    row.appendChild(url);

    if (one && one.src) {
      var warn = el('div', 'mc-mk-ratio');
      warn.textContent = l.ratioNote(one, kind);
      if (warn.textContent) row.appendChild(warn);
    }
    row.dataset.at = JSON.stringify(at);
    return row;
  }

  function mkAddRow(text) {
    var row = el('div', 'mc-mk-pict mc-mk-pict-add');
    var acts = el('div', 'mc-mk-pic-acts');
    acts.appendChild(mkBtn(text, 'mk-add-card'));
    acts.appendChild(mkBtn('Add card picture by link', 'mk-url-open'));
    row.appendChild(acts);
    var url = el('div', 'mc-mk-url');
    url.hidden = true;
    url.innerHTML = '<input type="text" class="mc-mk-url-in btx-ctl" data-in="url" spellcheck="false"' +
      ' placeholder="https://example.com/picture.jpg" aria-label="Picture link">'
      + '<button type="button" class="mc-set-btn btx-ctl" data-act="mk-url-save">Use link</button>'
      + '<button type="button" class="mc-set-btn btx-ctl" data-act="mk-url-cancel">Cancel</button>';
    row.appendChild(url);
    row.dataset.at = JSON.stringify({ kind: 'card', index: -1, add: true });
    return row;
  }

  function mkModeName(mode) {
    return mode === 'contain' ? 'whole picture' : mode === 'tile' ? 'tiled' : 'filled';
  }

  /* ---- 第 2 步：这张图用的是哪一块 ---- */

  function mkAreaStep(body) {
    var l = lib();
    var rec = mk.rec;
    var sel = mkCurrentSel();
    var one = mkPictureOne(rec, sel);

    var choose = el('section', 'mc-set-sec mc-mk-sec');
    choose.appendChild(el('div', 'mc-set-eyebrow', 'Which picture'));
    var chips = el('div', 'mc-set-group mc-mk-card mc-mk-choose');
    choose.appendChild(chips);
    var all = [];
    if (rec.sidebar && rec.sidebar.src) all.push({ at: { kind: 'sidebar' }, one: rec.sidebar, label: 'Sidebar' });
    (rec.cards || []).forEach(function (c, i) { if (c && c.src) all.push({ at: { kind: 'card', index: i }, one: c, label: 'Picture ' + (i + 1) }); });
    if (!all.length) {
      chips.appendChild(el('div', 'mc-set-note', 'There is no picture to set yet. Add one first, then come back and choose the part that shows.'));
      var toPictures = mkBtn('Add pictures', 'mk-step');
      toPictures.dataset.step = '0';
      chips.appendChild(toPictures);
      body.appendChild(choose);
      return;
    }
    all.forEach(function (item) {
      var chip = el('button', 'mc-mk-pick');
      chip.type = 'button';
      chip.dataset.act = 'mk-pick';
      chip.dataset.at = JSON.stringify(item.at);
      var thumb = el('div', 'mc-mk-thumb mc-mk-thumb-chip');
      thumb.style.backgroundImage = 'url("' + item.one.src + '")';
      thumb.style.backgroundSize = 'cover';
      chip.appendChild(thumb);
      chip.appendChild(el('span', 'mc-mk-pick-name', item.label));
      var on = sel && sel.kind === item.at.kind && (sel.index === undefined || sel.index === item.at.index);
      chip.classList.toggle('on', !!on);
      chips.appendChild(chip);
    });
    body.appendChild(choose);
    if (!one) { mk.sel = all[0].at; one = mkPictureOne(rec, mk.sel); }

    var kind = (mkCurrentSel() || {}).kind || 'card';
    var spec = l.SPEC[kind] || l.SPEC.card;
    var sec = el('section', 'mc-set-sec mc-mk-sec');
    sec.appendChild(el('div', 'mc-set-eyebrow', 'The part that shows'));
    var card = el('div', 'mc-set-group mc-mk-card');
    card.appendChild(el('div', 'mc-set-note',
      'This box is the size of the ' + (kind === 'sidebar' ? 'sidebar' : 'course card')
      + ' on the page. Drag the picture inside it: whatever stays inside is what you will see.'));

    var stage = el('div', 'mc-mk-stage');
    var frame = el('div', 'mc-mk-frame');
    frame.innerHTML = '<span class="mc-mk-box-none">No picture yet</span>';
    frame.tabIndex = 0;
    frame.setAttribute('aria-label', 'Which part of the picture shows. Arrow keys move it, Shift makes the step bigger.');
    stage.appendChild(frame);
    card.appendChild(stage);

    var tools = el('div', 'mc-mk-tools');
    var seg = el('div', 'mc-mk-seg');
    ['cover', 'contain', 'tile'].forEach(function (mode) {
      var btn = el('button', 'mc-set-btn btx-ctl' + (one && one.mode === mode ? ' on' : ''), mkModeName(mode));
      btn.type = 'button';
      btn.dataset.act = 'mk-mode';
      btn.dataset.mode = mode;
      seg.appendChild(btn);
    });
    tools.appendChild(el('span', 'mc-mk-tool-label', 'How it sits'));
    tools.appendChild(seg);

    var readout = el('div', 'mc-mk-readout');
    readout.textContent = mkRegionText(one);
    tools.appendChild(readout);

    if (one && one.mode === 'tile') {
      var tile = el('div', 'mc-mk-slide');
      tile.innerHTML = '<span class="mc-mk-tool-label">Each copy is</span>'
        + '<input type="range" min="10" max="120" step="5" data-in="scale" value="' + (Number(one.scale) || spec.tile) + '">'
        + '<span class="mc-mk-slide-out">' + Math.round(Number(one.scale) || spec.tile) + '% wide</span>';
      tools.appendChild(tile);
    }
    var zoom = null;
    /* 侧栏这一档另外一颗"图在栏上多大"：100＝刚好盖满这条栏（一条缝都不留，就是以前的铺满），
       往小是放大裁图，往大是缩小（看得见更多图，代价是边上留缝，读数会当场写出"留缝"这件事）。
       没拧过时它显示的是当前这个模式相当于铺满的百分之多少，所以一进来就停在画面上那一格。
       量不到原图多大（外链那台浏览器不给读）时这一行不摆：滑杆按下去算不出东西，
       留着它就是"拧了没反应"，拖动那颗也一样挪不动 */
    if (kind === 'sidebar' && one && one.mode !== 'tile' && (Number(one.width) || 0) && (Number(one.height) || 0)) {
      zoom = el('div', 'mc-mk-slide');
      zoom.innerHTML = '<span class="mc-mk-tool-label">Picture size</span>'
        + '<input type="range" min="20" max="120" step="5" data-in="size" value="100">'
        + '<span class="mc-mk-slide-out"></span>';
      tools.appendChild(zoom);
    }
    card.appendChild(tools);

    var note = el('div', 'mc-mk-ratio');
    // 这句里的"这个框"要用量出来的那个比例，不能再抄 SPEC 里写死的 1 : 2.8，
    // 不然框已经按真侧栏画瘦了，底下这句话还说它是 1 : 2.8＝两个数对不上
    note.textContent = l.ratioNote(one, kind, kind === 'sidebar' ? mkNavFrame() : null);
    if (note.textContent) card.appendChild(note);
    // 这一行跟着框里那圈虚线一起亮／收（谁裁不掉的时候不占地方）。
    // 收它用 display，不用 hidden：.mc-mk-ratio 自己写了 display，[hidden] 顶不掉它
    var safeNote = el('div', 'mc-mk-ratio mc-mk-safe-note');
    card.appendChild(safeNote);
    sec.appendChild(card);
    body.appendChild(sec);

    /* 这两笔必须等这一节挂进文档之后再落：那个预览框的像素尺寸要 getBoundingClientRect 才量得到，
       而它在 body 里之前量出来是 0×0——于是框按关键字画（铺满），滑杆却退回显示 100%，
       他一碰滑杆，尺寸这才按 100% 算＝整张图缩成一小块，画面当场跳一下。
       先画框、再按画出来的那一档回填滑杆，两边读的是同一个数 */
    mkPaintBox(frame, one, kind);
    if (zoom) mkPaintZoom(zoom, one, frame);
    mkBindDrag(frame, one, kind, readout);
  }

  // 那颗滑杆上的数字＝图现在相当于"刚好盖满这条栏"的百分之多少；量不到框就不摆这一行
  function mkPaintZoom(zoom, one, frame) {
    var box = mkFrameBox(frame);
    var shown = Number(one.size) || (box ? lib().visiblePercent(one, box) : 0);
    if (!shown) { if (zoom.parentNode) zoom.parentNode.removeChild(zoom); return; }
    var input = zoom.querySelector('input');
    if (input) input.value = mkSizeText(shown)[0];
    var out = zoom.querySelector('.mc-mk-slide-out');
    if (out) out.textContent = mkSizeText(shown)[1];
  }

  // 读数只算一次：[滑杆该停在哪一格, 那一行字]。过了 100 就是盖不满，当场说出来
  function mkSizeText(v) {
    var snap5 = Math.max(20, Math.min(120, Math.round(Number(v) || 0) / 5) * 5);
    return [snap5, snap5 + '% of filling the bar' + (snap5 > 100 ? ', so the edges stay empty' : '')];
  }

  function mkRegionText(one) {
    if (!one) return '';
    return 'Shows the point at ' + Math.round(one.x) + '% across, ' + Math.round(one.y) + '% down';
  }

  /* 预览框必须和页面上那条侧栏一样瘦。以前它照一个写死的 1 : 2.8 画，真侧栏是 200 宽乘一整屏高
     （他这台量出来 1 : 4.5）：同样是铺满，框越瘦看到的图越窄，所以他在那个框里看着"人物右边还有一大片"，
     Apply 上去右侧被裁掉一截。现在先量真的那一块，量不到（没有侧栏的页面）才退回 SPEC 里那一档 */
  function mkNavFrame() {
    try {
      var node = document.querySelector('.ic-app-header') || document.querySelector('#header');
      var r = node && node.getBoundingClientRect();
      if (r && r.width > 20 && r.height > 20) return [1, r.height / r.width];
    } catch (e) {}
    return (lib().SPEC.sidebar || {}).frame || [1, 4.5];
  }

  // 那颗"这一屏看得到图的多少"要按框的真实像素算，画一次量一次
  function mkFrameBox(node) {
    var r = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    return r && r.width > 4 && r.height > 4 ? { w: r.width, h: r.height } : null;
  }

  function mkPaintBox(box, one, kind) {
    var l = lib();
    if (!box) return;
    var spec = l.SPEC[kind] || l.SPEC.card;
    var ratio = kind === 'sidebar' ? mkNavFrame() : spec.frame;
    box.style.aspectRatio = ratio[0] + ' / ' + ratio[1];
    var none = box.querySelector('.mc-mk-box-none');
    box.style.backgroundColor = mkSolid(mk.rec.colors.sidebar, '#1f2937');
    if (!one || !one.src) {
      box.style.backgroundImage = '';
      box.classList.add('empty');
      if (none) none.hidden = false;
    } else {
      box.classList.remove('empty');
      if (none) none.hidden = true;
      mkPaintRegion(box, one.src, one, false, mkFrameBox(box));
    }
    mkPaintSafeBand(box, one, kind);
  }

  /* 框里那一圈虚线＝别人的窗口再高再矮也裁不掉的那一块。
     算它用的是"栏宽 200、窗口 600 / 900 / 1400"这三档取交集，和他这台窗口多大无关 */
  function mkPaintSafeBand(box, one, kind) {
    var band = kind === 'sidebar' ? lib().safeBand(one, mkFrameBox(box)) : null;
    var node = box.querySelector('.mc-mk-safe');
    if (!band) {
      if (node) node.remove();
    } else {
      if (!node) {
        node = el('span', 'mc-mk-safe');
        node.setAttribute('aria-hidden', 'true');
        box.appendChild(node);
      }
      node.style.left = band.left.toFixed(2) + '%';
      node.style.top = band.top.toFixed(2) + '%';
      node.style.width = band.width.toFixed(2) + '%';
      node.style.height = band.height.toFixed(2) + '%';
    }
    // 底下那行解释跟着这一圈一起亮收：线没了话还留着，就是凭空多一句。
    // 收它用 display，不用 hidden——.mc-mk-ratio 自己写了 display，[hidden] 顶不掉它
    var card = box.closest ? box.closest('.mc-mk-card') : null;
    var note = card ? card.querySelector('.mc-mk-safe-note') : null;
    if (!note) return;
    note.style.display = band ? '' : 'none';
    if (band) {
      note.textContent = 'The dashed line is the part every screen shows, here ' + band.percent
        + '% of the picture. Outside it, what people see depends on how tall their window is.';
      // 上一句里的百分数是"占整张图的面积"，和那颗滑杆的读数不是一把尺子，两个词分开用不会混
    }
  }

  /* 拖动是"抓住图挪"：图比框大的那一部分（over）从 0% 到 100% 正好走完焦点。
     图比框小（那颗滑杆拧到缩小那一头）时同一个符号自己就翻对方向，所以判的是差值的绝对大小。
     框和图差不多大时没有可挪的空间，这时候不动它，免得读数和画面对不上 */
  function mkBindDrag(frame, one, kind, readout) {
    if (!one || !one.src) return;
    var point = function (dx, dy) {
      var box = frame.getBoundingClientRect();
      var nat = { w: Number(one.width) || 0, h: Number(one.height) || 0 };
      if (!nat.w || !nat.h || !box.width) return;
      var scale = one.mode === 'contain' ? Math.min(box.width / nat.w, box.height / nat.h)
        : one.mode === 'tile' ? (box.width * (Math.max(10, Math.min(200, Number(one.scale) || 40)) / 100)) / nat.w
        : Math.max(box.width / nat.w, box.height / nat.h);
      // 那颗"看得到图的多少"拧过之后图不再是铺满／放全那两个关键字，是按那条算式画的：
      // 整张图刚好放得下的那一档乘上 100/多少。拖动算的"图比框多出多少"得跟着它，不然手和图脱节
      var shown = Number(one.size);
      if (one.mode !== 'tile' && shown >= 20 && shown <= 120) {
        // 那颗滑杆的 100% ＝刚好盖满这块框（cover），和 fitSizeCss／visiblePercent 同一条基准
        scale = Math.max(box.width / nat.w, box.height / nat.h) * (100 / shown);
      }
      var overX = nat.w * scale - box.width;
      var overY = nat.h * scale - box.height;
      if (one.mode === 'tile') { overX = overX > 0 ? overX : box.width; overY = overY > 0 ? overY : box.height; }
      if (Math.abs(overX) > 1) one.x = Math.max(0, Math.min(100, one.x - (dx / overX) * 100));
      if (Math.abs(overY) > 1) one.y = Math.max(0, Math.min(100, one.y - (dy / overY) * 100));
      mkPaintBox(frame, one, kind);
      if (readout) readout.textContent = mkRegionText(one);
    };
    var last = null;
    frame.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { frame.setPointerCapture(e.pointerId); } catch (err) {}
      last = { x: e.clientX, y: e.clientY };
      var move = function (ev) {
        point(ev.clientX - last.x, ev.clientY - last.y);
        last = { x: ev.clientX, y: ev.clientY };
      };
      var stop = function () {
        frame.removeEventListener('pointermove', move);
        frame.removeEventListener('pointerup', stop);
        frame.removeEventListener('pointercancel', stop);
      };
      frame.addEventListener('pointermove', move);
      frame.addEventListener('pointerup', stop);
      frame.addEventListener('pointercancel', stop);
    });
    // 键盘也能挪：方向键一档 2%，按住 Shift 一档 10%（拖不动鼠标的时候、还有读屏器都用这条）
    frame.addEventListener('keydown', function (e) {
      var n = e.shiftKey ? 10 : 2;
      var map = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] };
      var d = map[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      point(d[0], d[1]);
    });
  }

  /* ---- 第 3 步：这份主题自带的色 ---- */

  function mkColoursStep(body) {
    var rec = mk.rec;
    var l = lib();
    var intro = mkSec('These are the colours this theme starts with',
      'Changing a colour on the Colours page later does not come back and change these. '
      + 'Undo on that page goes back to what you set here.', '');
    body.appendChild(intro);

    COLOUR_GROUPS.forEach(function (group) {
      var sec = mkSec(group.title, '', '');
      var card = sec.querySelector('.mc-mk-card');
      group.slots.forEach(function (slot) {
        var item = el('div');
        item.innerHTML = mkColourItemHtml(slot, COLOUR_INFO[slot].name, COLOUR_INFO[slot].use);
        var node = item.firstElementChild;
        card.appendChild(node);
        mkPaintColourRow(node, slot, mkSolid(rec.colors[slot], ''));
      });
      body.appendChild(sec);
    });

    body.appendChild(mkWashSection('card', 'The wash on card pictures',
      'Sits over the picture so the course name stays readable'));
    var sideWash = mkWashSection('sidebar', 'The wash on the sidebar picture',
      'Sits over the sidebar picture so the labels there stay readable');
    if (!rec.sidebar || !rec.sidebar.src) {
      var noPic = el('div', 'mc-set-note');
      noPic.textContent = 'This theme has no sidebar picture, so there is nothing for it to sit on yet.';
      sideWash.querySelector('.mc-mk-card').appendChild(noPic);
    }
    body.appendChild(sideWash);

    /* 字体这一行和 Customizer 那一屏共用一颗组件（mountFontPicker）：
       那边交的是"正在用的这一格挑的那份"，这边交的是"这份主题自带的那份"，
       所以名单、校验、那颗 Find more fonts、选中态都不写第二遍 */
    var fontSec = mkSec('Text font', '', fontPickerHtml());
    var fontCard = fontSec.querySelector('.mc-mk-card');
    var fontPick = mountFontPicker(fontCard, {
      tip: 'This is the font the theme brings when you Apply it. Nothing is saved until you press Save.',
      get: function () { return { edit: (mk.rec && mk.rec.font) || null, base: null }; },
      set: function (font) { if (mk.rec) mk.rec.font = font || null; }
    });
    // 这一节没有"点开"那一步（Customizer 那一行才有），所以挂上就把提示语和那 12 条链接补上：
    // 不然首次进这一屏每颗药丸都显成回退字体，看不出它自己是哪一档
    fontPick.open();
    body.appendChild(fontSec);
  }

  /* 那两份膜记录：卡图上的一份（overlay）和侧栏图上的一份（sidebarOverlay）。
     老存档可能没有后面这一份（它是后加的），读的时候当没有、写之前先补上 */
  function mkWashRec(which, create) {
    var rec = mk.rec || {};
    var key = which === 'sidebar' ? 'sidebarOverlay' : 'overlay';
    if (!rec[key] && create) {
      rec[key] = which === 'sidebar' ? { color: '#241f1a', strength: 0 } : { color: '#241f1a', strength: 45 };
    }
    return rec[key] || null;
  }

  /* 卡图那一节和侧栏那一节是三行一模一样的东西（那颗色、多少、那一小块仿真），
     只有落点不同：各读各的那一份膜，各画各的那幅图 */
  function mkWashSection(which, title, use) {
    var rec = mk.rec;
    var ov = mkWashRec(which) || { color: '#241f1a', strength: 0 };
    var strength = Math.max(0, Math.min(100, Number(ov.strength) || 0));
    var sec = mkSec(title, '', '');
    sec.classList.add('mc-mk-wash-' + which);
    var card = sec.querySelector('.mc-mk-card');
    var item = el('div');
    item.innerHTML = mkColourItemHtml(which === 'sidebar' ? '__sideWash' : '__wash', 'Wash colour', use);
    card.appendChild(item.firstElementChild);
    var slide = el('div', 'mc-mk-slide mc-mk-wash-strength');
    slide.innerHTML = '<span class="mc-mk-tool-label">How much of it</span>'
      + '<input type="range" min="0" max="100" step="5" data-in="strength" data-wash="' + which + '" value="' + strength + '">'
      + '<span class="mc-mk-slide-out">' + strength + '%</span>'
      + '<div class="mc-mk-wash-demo"></div>';
    card.appendChild(slide);
    mkPaintWashDemo(card.querySelector('.mc-mk-wash-demo'), rec, which);
    return sec;
  }

  function mkColourItemHtml(key, name, use) {
    return '<div class="mc-col-item mc-mk-colour" data-slot="' + key + '">' +
      '<button type="button" class="mc-col-row">' +
        '<span class="mc-col-chip"><span class="mc-col-chip-in">Aa</span></span>' +
        '<span class="mc-col-names">' +
          '<span class="mc-col-label">' + esc(name) + '</span>' +
          '<span class="mc-col-use">' + esc(use) + '</span>' +
        '</span>' +
        '<span class="mc-col-hex"></span>' +
        // 那颗小圆点在 Colours 那屏只在"这一档被你拧过"时亮。这里没有拧过的概念，
        // 但那一列要留着，不然箭头会挪位（那一行是五列的 grid）
        '<span class="mc-col-dot" aria-hidden="true"></span>' +
        '<svg class="mc-col-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>' +
      '</button>' +
      editorHtml() +
    '</div>';
  }

  function mkColourValue(key) {
    var rec = mk.rec;
    if (key === '__wash') return mkSolid(rec.overlay.color, '#241f1a');
    if (key === '__sideWash') return mkSolid((mkWashRec('sidebar') || {}).color, '#241f1a');
    return mkSolid(rec.colors[key], '');
  }

  function mkSetColourValue(key, hex) {
    if (key === '__wash') mk.rec.overlay.color = hex;
    else if (key === '__sideWash') mkWashRec('sidebar', true).color = hex;
    else mk.rec.colors[key] = hex;
  }

  function mkPaintColourRow(item, key, hex) {
    var ink = ['text-0', 'text-1', 'text-2', 'sidebar-text'].indexOf(key) !== -1;
    var chipBox = item.querySelector('.mc-col-chip');
    var chip = item.querySelector('.mc-col-chip-in');
    if (ink) {
      var base = key === 'sidebar-text' ? mkSolid(mk.rec.colors.sidebar, '#ffffff')
        : (mkSolid(mk.rec.colors['background-0'], '') || '#ffffff');
      chipBox.style.background = base;
      chip.textContent = 'Aa';
      chip.style.color = hex || 'transparent';
    } else if (hex) {
      chipBox.style.background = hex;
      chip.textContent = '';
    } else {
      chipBox.style.background = '';
      chip.textContent = '';
    }
    chipBox.classList.toggle('btx-empty', !hex);
    item.querySelector('.mc-col-hex').textContent = hex ? hex.toUpperCase() : 'no colour';
  }

  /* 自建那一屏的取色器：方块、色相条、十六进制那三样和 Colours 那屏一模一样
     （共用 .mc-col-* 这套 CSS 和 colRgb/colHsv/colRgbFromHsv/colStep 这几个算法），
     只有落点不同——这儿写的是那份记录，页面那一份只拿临时表跟一下 */
  function mkOpenEditor(item, key) {
    var open = item.classList.contains('open');
    p.maker.querySelectorAll('.mc-col-item.open').forEach(function (n) { n.classList.remove('open'); });
    mkp.slot = '';
    mkClearDraft();
    if (open) {
      syncInspectState(false);
      return;
    }
    mkp.slot = key;
    item.classList.add('open');
    syncInspectState(true);
    mkBindEditorParts(item, key);
    mkSyncEditor(item, key);
  }

  function mkEditorParts(item) {
    return {
      field: item.querySelector('[data-part="field"]'),
      knob: item.querySelector('[data-part="knob"]'),
      hue: item.querySelector('[data-part="hue"]'),
      hueknob: item.querySelector('[data-part="hueknob"]'),
      input: item.querySelector('.mc-col-input'),
      tips: item.querySelector('.mc-col-tips')
    };
  }

  /* 方块和色相条上的拖动。每一行的这几个节点在这一屏重搭时才在，绑一次挂个记号，
     重开编辑器不会叠第二层监听 */
  function mkBindEditorParts(item, key) {
    if (item.dataset.bound === '1') return;
    item.dataset.bound = '1';
    var part = mkEditorParts(item);
    var grab = function (node, onPoint) {
      node.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        try { node.setPointerCapture(e.pointerId); } catch (err) {}
        var move = function (ev) {
          var rect = node.getBoundingClientRect();
          onPoint(
            Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))),
            Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)))
          );
        };
        var stop = function () {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', stop);
          node.removeEventListener('pointercancel', stop);
          mkp.drag = null;
        };
        mkp.drag = stop;
        move(e);
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', stop);
        node.addEventListener('pointercancel', stop);
      });
    };
    grab(part.field, function (x, y) {
      var hsv = item._hsv || [0, 0, 1];
      part.knob.style.left = (x * 100) + '%';
      part.knob.style.top = (y * 100) + '%';
      mkApply(item, key, colHex(colRgbFromHsv([hsv[0], x, 1 - y])));
    });
    grab(part.hue, function (x, y) {
      var hsv = item._hsv || [0, 0, 1];
      part.hueknob.style.top = (y * 100) + '%';
      mkApply(item, key, colHex(colRgbFromHsv([1 - y, hsv[1], hsv[2]])));
      var hex = mkColourValue(key);
      var next = colHsv(colRgb(hex) || [255, 255, 255]);
      item._hsv = next;
      part.field.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),'
        + 'linear-gradient(to right,#fff,hsl(' + Math.round(next[0] * 360) + ',100%,50%))';
      part.knob.style.left = (next[1] * 100) + '%';
      part.knob.style.top = ((1 - next[2]) * 100) + '%';
    });
    part.input.addEventListener('change', function () {
      var typed = part.input.value.trim();
      if (/^[0-9a-fA-F]{3}$/.test(typed)) typed = '#' + typed[0] + typed[0] + typed[1] + typed[1] + typed[2] + typed[2];
      if (!/^#[0-9a-fA-F]{6}$/.test(typed)) { part.input.value = (mkColourValue(key) || '').toUpperCase(); return; }
      mkApply(item, key, typed);
      mkSyncEditor(item, key);
    });
  }

  function mkSyncEditor(item, key) {
    var part = mkEditorParts(item);
    var hex = mkColourValue(key) || '#ffffff';
    var hsv = colHsv(colRgb(hex) || [255, 255, 255]);
    item._hsv = hsv;
    part.field.style.background = 'linear-gradient(to top,#000,rgba(0,0,0,0)),'
      + 'linear-gradient(to right,#fff,hsl(' + Math.round(hsv[0] * 360) + ',100%,50%))';
    part.knob.style.left = (hsv[1] * 100) + '%';
    part.knob.style.top = ((1 - hsv[2]) * 100) + '%';
    part.hueknob.style.top = ((1 - hsv[0]) * 100) + '%';
    if (document.activeElement !== part.input) part.input.value = hex.toUpperCase();
    part.tips.textContent = 'Drag the square to set how deep and how light, the bar on the right to set the colour itself. '
      + 'The page follows while you drag so you can see it, but nothing is saved until you press Save.';
  }

  function mkApply(item, key, hex) {
    hex = String(hex).toLowerCase();
    mkSetColourValue(key, hex);
    mkPaintColourRow(item, key, hex);
    mkPreviewColour(key, hex);
    var part = mkEditorParts(item);
    if (document.activeElement !== part.input) part.input.value = hex.toUpperCase();
    if (key === '__wash' || key === '__sideWash') {
      var which = key === '__sideWash' ? 'sidebar' : 'card';
      var sec = p.maker.querySelector('.mc-mk-wash-' + which);
      if (sec) mkPaintWashDemo(sec.querySelector('.mc-mk-wash-demo'), mk.rec, which);
    }
  }

  // 页面上那一份临时盖色：借 Colours 那屏同一颗（它只盖这一档，不动快照）
  function mkPreviewColour(key, hex) {
    var h = store();
    if (!h || !h.mcPreviewSlotColors || key === '__wash' || key === '__sideWash') return;
    var map = {};
    map[key] = hex;
    h.mcPreviewSlotColors(map);
  }

  function mkClearDraft() {
    var h = store();
    if (h && h.mcPreviewSlotColors) h.mcPreviewSlotColors({});
  }

  /* 那层色膜压在这张图上像什么样：膜色和透明度在这儿算成一层渐变盖在图上。
     which 是 'sidebar' 时画的是侧栏那一节：图用侧栏那幅，膜读侧栏那一份，
     字用侧栏文字那一档坐在侧栏底色上；不传就是卡图那一节，跟以前一样 */
  function mkPaintWashDemo(demo, rec, which) {
    if (!demo) return;
    var l = lib();
    var sidebar = which === 'sidebar';
    var pic = sidebar ? (rec.sidebar || null) : (rec.sidebar || (rec.cards || [])[0] || null);
    var ov = (sidebar ? mkWashRec('sidebar') : rec.overlay) || { color: '#241f1a', strength: 0 };
    var strength = Math.max(0, Math.min(100, Number(ov.strength) || 0));
    var rgb = l.hexRgb(mkSolid(ov.color, '#241f1a')) || [36, 31, 26];
    var film = 'linear-gradient(rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ','
      + (strength / 100).toFixed(2) + ')';
    demo.style.backgroundImage = pic && pic.src ? film + '),' + 'url("' + pic.src + '")' : film + ')';
    demo.style.backgroundSize = pic ? l.regionCss(pic).size + ',cover' : 'auto';
    demo.style.backgroundPosition = pic ? l.regionCss(pic).pos + ',center' : 'center';
    demo.style.backgroundRepeat = 'no-repeat';
    demo.style.backgroundColor = sidebar ? mkSolid((rec.colors || {}).sidebar, '#1f2937')
      : mkSolid((rec.colors || {})['background-0'], '#f4f4f5');
    demo.style.color = sidebar ? mkSolid((rec.colors || {})['sidebar-text'], '#ffffff')
      : mkSolid((rec.colors || {})['text-0'], '#111417');
    if (!demo.textContent) demo.textContent = 'Biology 201';
  }

  /* ---- 第 4 步：存之前看一眼 ---- */

  function mkReviewStep(body) {
    var l = lib();
    var rec = mk.rec;
    var sec = mkSec('Before you save', '', '');
    var card = sec.querySelector('.mc-mk-card');
    var linked = (rec.cards || []).filter(function (c) { return c && /^https?:/i.test(c.src); }).length;
    var set = MK_EDIT_SLOTS.filter(function (s) { return !!mkSolid(rec.colors[s], ''); }).length;
    // 两节膜写成一样的样子，0% 就是没画
    var washText = function (ov) {
      var s = Math.max(0, Math.min(100, Number(ov && ov.strength) || 0));
      return s + '% of ' + mkSolid((ov || {}).color, '#241f1a').toUpperCase();
    };
    var rows = [
      ['Name', (rec.name || '').trim() || 'My theme'],
      ['Sidebar picture', mkOneText(rec.sidebar)],
      ['Card pictures', (rec.cards || []).length
        ? rec.cards.length + (rec.cards.length === 1 ? ' picture, given to your courses in the order above'
          : ' pictures, given to your courses in the order above')
          + (linked ? ' · ' + linked + ' of them ' + (linked === 1 ? 'is' : 'are') + ' links, not saved here' : '')
        : 'none, so cards keep the colours below'],
      ['Colours', set + ' of ' + MK_EDIT_SLOTS.length + ' set'],
      ['Font', rec.font && rec.font.family ? rec.font.family
        : (rec.font && rec.font.link ? 'From your link' : 'Canvas default')],
      ['Wash on card pictures', washText(rec.overlay)],
      ['Wash on the sidebar picture', washText(rec.sidebarOverlay)],
      ['Room it takes', l.kb(l.bytesOf(rec)) + ' (everything you have saved is ' + l.kb(l.libBytes()) + ')']
    ];
    rows.forEach(function (pair) {
      var line = el('div', 'mc-mk-line');
      line.appendChild(el('span', 'mc-mk-line-k', pair[0]));
      line.appendChild(el('span', 'mc-mk-line-v', String(pair[1])));
      card.appendChild(line);
    });
    body.appendChild(sec);

    var preview = mkSec('What it will look like', 'The same little mock the Colours page uses, painted with these colours.', '');
    var wrap = el('div', 'mc-mk-mockwrap');
    wrap.innerHTML = mockHtml();
    preview.querySelector('.mc-mk-card').appendChild(wrap);
    var v = function (slot, fallback) { return mkSolid(rec.colors[slot], '') || fallback || ''; };
    paintMockIn(wrap, function (slot, fallback) {
      if (slot === 'cards') return v('background-0', fallback);
      // 侧栏那一档带着贴图：槽值里写的是引用，仿真这块要自己展开才看得见图
      if (slot === 'sidebar') return l.resolve(l.sidebarSlotValue(rec));
      return v(slot, fallback);
    });
    body.appendChild(preview);
  }

  function mkOneText(one) {
    if (!one || !one.src) return 'none';
    var where = Math.round(one.x) + '% across, ' + Math.round(one.y) + '% down';
    var how;
    if (one.mode === 'tile') {
      how = 'tiled, each copy ' + Math.round(one.scale) + '% wide, starting at ' + where;
    } else if (Number(one.size) >= 20 && one.kind === 'sidebar') {
      // 这一档拧过之后大小就不是"filled／whole picture"那两个词了，报的是它自己那一格
      how = 'the picture is ' + Math.round(one.size) + '% of what fills the bar, at ' + where;
    } else {
      how = mkModeName(one.mode) + ' at ' + where;
    }
    return (/^data:/i.test(one.src) ? 'a picture you uploaded' : 'a link') + ', ' + how;
  }

  /* ---- 收：写库 ---- */

  function mkSave(andApply) {
    var l = lib();
    var h = store();
    if (!l || !mk.rec) return;
    if (!(mk.rec.name || '').trim()) mk.rec.name = 'My theme';
    var res = l.upsert(mk.rec);
    if (!res.ok) {
      mk.status = res.error;
      renderMaker();
      return;
    }
    mk.rec = res.rec;
    mk.isNew = false;
    mk.status = '';
    mkClearDraft();
    if (andApply) {
      if (!h || !h.mcApplyCustomTheme) {
        mk.status = 'Saved. Reload this page once and Apply will work.';
        renderMaker();
        return;
      }
      // 存完顺手 Apply：这一条也先采图，理由和主题墙那颗键一样（首帧就要读到三颗底）
      mk.status = 'Reading the sidebar picture…';
      renderMaker();
      bakeRecSamples(mk.rec).then(function (one) {
        try {
          h.mcApplyCustomTheme(one);
          location.reload();
          return;
        } catch (err) {
          mk.status = "Saved, but it could not be applied: " + (err && err.message ? err.message : String(err));
          renderMaker();
          return;
        }
      });
      return;
    }
    if (mk.fromSave) {
      // 从 Customizer 进来只按了"存"：回那一屏，页面上还是旧图，那屏底下那颗 Apply 的键不归这里，
      // 所以这句要说清楚——存好了，但要 Apply 才画上
      mk.fromSave = false;
      mk.status = '';
      showView('colours');
      renderColours();
      var note = p.colors.querySelector('.mc-col-status');
      if (note) { note.hidden = false; note.textContent = 'Pictures saved. Press Save and apply to put them on the page.'; }
      return;
    }
    showView('themes');
    openCustomDetail(mk.rec);
  }

  function mkUpload(file, at) {
    var l = lib();
    var kind = at.kind === 'sidebar' ? 'sidebar' : 'card';
    mk.status = 'Reading that picture…';
    renderMaker();
    l.fileToPicture(file, kind).then(function (out) {
      mk.status = '';
      var one = l.picture(out.src, kind, { width: out.width, height: out.height });
      // 换图就重新框：老的那一组百分数是照着上一张图的尺寸算的
      if (kind === 'sidebar') mk.rec.sidebar = one;
      else if (at.add || at.index === -1) mk.rec.cards.push(one);
      else mk.rec.cards[at.index] = one;
      mk.sel = kind === 'sidebar' ? { kind: 'sidebar' } : { kind: 'card', index: at.add ? mk.rec.cards.length - 1 : at.index };
      renderMaker();
    }).catch(function (err) {
      mk.status = (err && err.message ? err.message : String(err))
        + ' You can put a link to the picture in instead.';
      renderMaker();
    });
  }

  function mkUseUrl(at, raw) {
    var l = lib();
    var url = String(raw || '').trim();
    if (/^www\./i.test(url)) url = 'https://' + url;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      mk.status = 'That does not look like a picture link. It needs to start with http:// or https://.';
      renderMaker();
      return;
    }
    var one = l.picture(url, at.kind === 'sidebar' ? 'sidebar' : 'card');
    if (at.kind === 'sidebar') mk.rec.sidebar = one;
    else if (at.add || at.index === -1) mk.rec.cards.push(one);
    else mk.rec.cards[at.index] = one;
    mk.status = 'It is set as a link, so the picture itself is not saved on this site. '
      + 'A downloaded theme.json will point at it rather than carry it.';
    // 网上那张图顺手量一下尺寸：区域那一步要按它算"能挪多少"，不量就只能看中间那一块
    l.measure(url).then(function (size) {
      one.width = size.width;
      one.height = size.height;
      if (mk.rec && mk.step === 1 && p && !p.maker.hidden) renderMaker();
    }, function () {});
    renderMaker();
  }

  /* ---- 事件：整屏每次重搭，所以键一律委托到这一屏的根上 ---- */

  function mkAt(node) {
    var row = node.closest('[data-at]');
    if (!row) return null;
    try { return JSON.parse(row.getAttribute('data-at')); } catch (e) { return null; }
  }

  function mkClick(e) {
    if (!mk.rec) return;
    /* 取色器那一套是照 Colours 那屏的摆法搭的，它上面那几层（行、方块、色相条、十六进制）
       没有 data-act，先按类名认。方块和色相条上的拖动、还有输入框是自己绑在节点上的，
       这里只要不往下管就行 */
    var colour = e.target.closest ? e.target.closest('.mc-mk-colour') : null;
    if (colour) {
      if (e.target.closest('.mc-col-row')) { mkOpenEditor(colour, colour.dataset.slot); return; }
      var lift = e.target.closest('[data-part="up"]') || e.target.closest('[data-part="down"]');
      if (lift) {
        mkApply(colour, colour.dataset.slot,
          colStep(mkColourValue(colour.dataset.slot) || '#ffffff', lift.dataset.part === 'up'));
        mkSyncEditor(colour, colour.dataset.slot);
      }
      return;
    }
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.dataset.act;
    var at = mkAt(btn);

    if (act === 'mk-back') { mkBack(); return; }
    if (act === 'mk-cancel') { mkBack(); return; }
    if (act === 'mk-step') { mk.step = Number(btn.dataset.step); mk.status = ''; renderMaker(); return; }
    if (act === 'mk-prev') { mk.step = Math.max(0, mk.step - 1); mk.status = ''; renderMaker(); return; }
    if (act === 'mk-next') { mk.step = Math.min(MK_STEPS.length - 1, mk.step + 1); mk.status = ''; renderMaker(); return; }
    if (act === 'mk-save') { mkSave(false); return; }
    if (act === 'mk-save-apply') { mkSave(true); return; }

    if (act === 'mk-upload' || act === 'mk-add-card') {
      mk.picking = act === 'mk-add-card' ? { kind: 'card', index: -1, add: true } : at;
      p.maker.querySelector('.mc-mk-file').click();
      return;
    }
    if (act === 'mk-url-open' || act === 'mk-url-cancel') {
      var row = btn.closest('[data-at]');
      var url = row ? row.querySelector('.mc-mk-url') : null;
      if (url) {
        url.hidden = act !== 'mk-url-open';
        if (act === 'mk-url-open') url.querySelector('.mc-mk-url-in').focus();
      }
      return;
    }
    if (act === 'mk-url-save') {
      var line = btn.closest('[data-at]');
      if (line && at) mkUseUrl(at, line.querySelector('.mc-mk-url-in').value);
      return;
    }
    if (act === 'mk-remove') {
      if (at && at.kind === 'sidebar') mk.rec.sidebar = null;
      else if (at) mk.rec.cards.splice(at.index, 1);
      mk.sel = null;
      mk.status = '';
      renderMaker();
      return;
    }
    if (act === 'mk-move-left' || act === 'mk-move-right') {
      if (!at || at.kind !== 'card') return;
      var to = at.index + (act === 'mk-move-left' ? -1 : 1);
      if (to < 0 || to >= mk.rec.cards.length) return;
      var list = mk.rec.cards;
      var held = list[at.index];
      list[at.index] = list[to];
      list[to] = held;
      mk.sel = { kind: 'card', index: to };
      renderMaker();
      return;
    }
    if (act === 'mk-area') {
      mk.sel = at;
      mk.step = 1;
      mk.status = '';
      renderMaker();
      return;
    }
    if (act === 'mk-pick') {
      mk.sel = at;
      renderMaker();
      return;
    }
    if (act === 'mk-mode') {
      var one = mkPictureOne(mk.rec, mkCurrentSel());
      if (!one) return;
      one.mode = btn.dataset.mode;
      // 换模式就是换回那一档自己的大小：那颗滑杆跟着回到这一档实际看得到多少那一格
      one.size = 0;
      renderMaker();
      return;
    }
  }

  function mkInput(e) {
    var where = e.target.dataset ? e.target.dataset.in : '';
    if (where === 'name') {
      mk.rec.name = e.target.value;
      p.maker.querySelector('.btx-title').textContent = mk.isNew ? 'New theme' : (mk.rec.name || 'Your theme');
      return;
    }
    if (where === 'scale') {
      var one = mkPictureOne(mk.rec, mkCurrentSel());
      if (!one) return;
      one.scale = Number(e.target.value) || 40;
      mkPaintBox(p.maker.querySelector('.mc-mk-frame'), one, (mkCurrentSel() || {}).kind);
      var out = p.maker.querySelector('.mc-mk-tools .mc-mk-slide-out');
      if (out) out.textContent = one.scale + '% wide';
      return;
    }
    if (where === 'size') {
      var pic = mkPictureOne(mk.rec, mkCurrentSel());
      if (!pic) return;
      pic.size = Number(e.target.value) || 0;
      mkPaintBox(p.maker.querySelector('.mc-mk-frame'), pic, (mkCurrentSel() || {}).kind);
      var zoomRow = e.target.closest('.mc-mk-slide');
      var out3 = zoomRow ? zoomRow.querySelector('.mc-mk-slide-out') : null;
      if (out3) out3.textContent = mkSizeText(pic.size)[1];
      return;
    }
    if (where === 'strength') {
      var which = e.target.dataset.wash === 'sidebar' ? 'sidebar' : 'card';
      var ov = mkWashRec(which, true);
      ov.strength = Number(e.target.value) || 0;
      // 读数和小仿真都只动这一节自己那一份：两节挂的是同一个类名
      var slide = e.target.closest('.mc-mk-slide');
      var out2 = slide && slide.querySelector('.mc-mk-slide-out');
      if (out2) out2.textContent = ov.strength + '%';
      if (slide) mkPaintWashDemo(slide.querySelector('.mc-mk-wash-demo'), mk.rec, which);
      return;
    }
  }

  function mkChange(e) {
    var where = e.target.dataset ? e.target.dataset.in : '';
    if (where !== 'url') return;
    var row = e.target.closest('[data-at]');
    if (row) mkUseUrl(mkAt(row), e.target.value);
  }

  function mkBack() {
    mkClearDraft();
    var rec = mk.rec;
    var backToSave = mk.fromSave;
    mk.fromSave = false;
    mk.status = '';
    // 从 Theme Customizer 进来的，退回去也回那一屏，不把人扔到主题墙上
    if (backToSave) { showView('colours'); renderColours(); return; }
    showView('themes');
    if (!mk.isNew && rec && lib() && lib().get(rec.id)) openCustomDetail(rec);
    else renderThemeList();
  }

  /* ==== 开合 ==== */

  function open() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      if (!existing.classList.contains('open')) {
        try { existing.remove(); } catch (_) {}
      } else {
        return;
      }
    }
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'mc-set-overlay';
    try {
      // 遮罩那一层糊排在卡片之前：它什么都不装，所以正文滚动重不到它（settings.css 的 .mc-set-scrim）
      overlay.innerHTML = '<div class="mc-set-scrim" aria-hidden="true"></div>' + shellHtml();
    } catch (e) {
      console.error('[BCX] 设置面板没搭起来：', e);
      return;
    }
    document.body.appendChild(overlay);
    // 这一座是重新搭的，而且各组摆哪些行要看现场：那颗"上一次亮着的"和那张位置表都不能带过来
    navLit = null;
    secTops = null;

    var card = overlay.querySelector('.mc-set-card');
    p = {
      overlay: overlay,
      card: card,
      body: card.querySelector('.mc-set-body'),
      settings: card.querySelector('.mc-set-view-settings'),
      colors: card.querySelector('.mc-set-view-colours'),
      themes: card.querySelector('.mc-set-view-themes'),
      maker: card.querySelector('.mc-set-view-maker'),
      cardtext: card.querySelector('.mc-set-view-cardtext'),
      view: card.querySelector('.mc-set-view-themes'),
      themesBound: false,
      makerBound: false,
      // 由 bindNav 里那条滚动判据填；开面板那一刻还不知道在哪一组
      lastSection: ''
    };
    // Colours 那一屏的每一行是每次点开重读一遍快照搭起来的：上一次面板里改过什么都不带过来
    col.items = {};
    col.values = {};
    col.open = '';
    col.drag = null;
    // AI 那一屏的临时状态（正在改码、改成手填模型名）不带进下一次开面板
    ai.codeEdit = false;
    ai.codeDraft = '';
    ai.codeState = '';
    ai.codeMsg = '';
    ai.modelManual = {};
    ai.foldOpen = false;
    ai.codeOpen = false;
    ai.remoteModels = {};
    ai.modelQuery = {};
    ai.picker = false;
    ai.pickId = '';
    // 用量那两屏也不带进下一次开面板：门是关着的，数点进去才看
    ai.usage = '';
    ai.usageId = '';
    ai.usageOpen = false;

    requestAnimationFrame(function () { overlay.classList.add('open'); });

    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) close();
    });
    var closeBtn = overlay.querySelector('.mc-set-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // 严密保护面板自身滚动：防止滚轮事件穿透给可能卡在重排/长任务中的背景页面
    card.addEventListener('wheel', function (e) {
      var body = p && p.body;
      if (!body) return;
      var canScroll = body.scrollHeight > body.clientHeight;
      if (!canScroll) return;
      // 只要光标在设置卡片内，就把滚轮位移直接精准打在滚动层上
      body.scrollTop += e.deltaY;
      e.stopPropagation();
      e.preventDefault();
    }, { passive: false });

    try {
      // 侧栏那一档的两张拖拽清单：现场那几行是 Canvas 画的，会多会少，每次开面板重读一遍
      navScreenInit();
      p.cardtext.innerHTML = cardTextViewHtml();
      bindChecks();
      bindTexts();
      bindAccounts();
      bindSelects();
      bindAiScreen();
      bindTheme();
      bindActions();
      bindNav();
      bindCardText();
      markNav(firstSectionId());
      // 卡片分数那两行一开面板就要按现场摆好（它是晚挂载的，开面板这一刻才判得准）
      syncGradeRows();
    } catch (e) {
      console.error('[BCX] 设置面板挂载内容失败：', e);
      try { overlay.remove(); } catch (_) {}
      p = null;
    }
  }

  // 开和关走同一条过渡、同一个时长，只是方向相反
  /* ==== Sidebar 这一档：拖拽排行＋每行一颗 Show 勾 ====
     2026-10-11 从"单独一屏"并回滚动流的那一组：这一档只剩两件事能调（行的先后、上不上屏），
     为一列短行换一次屏不划算。同时撤掉了 Apply：拖完落一次盘、勾一下落一次盘，侧栏当场跟着摆好。
     原来滚动那一组 "Sidebar" 整份并到这一档（Courses list 并进每行的 Show 勾，
     Left sidebar logo 留在这一档），设置里不再有两颗都叫 Sidebar 的东西。

     收起那颗不进这一档：它是下区那两行的锚（它们的下边距是量它的高度算的）。
     课程那一列的名字也不在这里改：那一格归 Course info。 */
  var nv = { rows: [], courses: [], drag: null, root: null };

  function navRowHtml(r) {
    return '<li class="mc-nav-row" data-nav-k="' + esc(r.k) + '">' +
      '<span class="mc-nav-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor">' +
      '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/>' +
      '<circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>' +
      '<span class="mc-nav-row-label">' + esc(r.label) + '</span>' +
      (r.hideable
        // 勾用这座面板那一颗（现成的 .mc-set-check 方框加白勾），不是浏览器原生的那种。
        // 结构和 checkRowHtml 一样：input 紧跟一颗 .mc-set-check，:checked 那两条规则才命中
        ? '<label class="mc-nav-show"><span>Show</span>' +
          '<input type="checkbox" data-nav-on="' + esc(r.k) + '"' + (r.on ? ' checked' : '') + '>' +
          '<span class="mc-set-check" aria-hidden="true"></span></label>'
        : '<span class="mc-nav-always">Always shown</span>') +
      '</li>';
  }

  function navCourseRowHtml(c) {
    return '<li class="mc-nav-row mc-nav-course-row" data-nav-id="' + esc(c.id) + '">' +
      '<span class="mc-nav-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor">' +
      '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/>' +
      '<circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>' +
      '<span class="mc-nav-course-name">' + esc(c.name) + '</span>' +
      '<label class="mc-nav-show"><span>Show</span>' +
      '<input type="checkbox" data-nav-course-on="' + esc(c.id) + '"' + (c.on ? ' checked' : '') + '>' +
      '<span class="mc-set-check" aria-hidden="true"></span></label>' +
      '</li>';
  }

  /* 一张卡三段：上区的行、下区的行（那颗 logo 开关紧跟在下区后面，不再另起一个小标题）、
     侧栏里那列课程。段与段靠小标题和留白分开，卡里不再画框（这座面板零分隔线的口径）。
     最后那颗 Restore default 会把按下那一层的底色铺到方的角上，所以这一档的卡要裁边，
     走的是 Actions 那一档现成的 .mc-set-actions。 */
  function navListsHtml() {
    return '<div class="btx-group">Top of the sidebar</div>' +
      '<ul class="mc-nav-list" data-nav-zone="top"></ul>' +
      '<div class="btx-group">Bottom of the sidebar</div>' +
      '<ul class="mc-nav-list" data-nav-zone="bottom"></ul>' +
      checkRowHtml({ type: 'check', key: 'bc_keep_nav_logo', label: 'Left sidebar logo' }) +
      '<div class="btx-group">Courses in sidebar</div>' +
      '<div class="mc-set-note mc-nav-note">Drag to set the order the sidebar lists them in. Untick Show to take that course out of the sidebar. The name on each row is the one from Course info, and it is the same name the card on the dashboard uses.</div>' +
      '<ul class="mc-nav-list" data-nav-course></ul>' +
      '<div class="mc-set-note mc-nav-note mc-nav-course-empty" hidden>Course names arrive with the dashboard. Reopen Settings in a moment and they will be here.</div>' +
      '<button type="button" class="mc-set-btn mc-set-wide mc-nav-reset">Restore default</button>';
  }

  /* 拖完、勾完当场落盘：这一档没有 Apply 那一步了。落盘那一趟 content.js 会顺手把侧栏摆成
     新样子——面板开着时页面那条 300 毫秒的轮询是停的（mcSettingsPanelOpen 挡的），
     所以那一趟必须由存盘自己叫，不然他关掉面板还得等一下才看见变化 */
  function navSaveNow() {
    var h = store();
    if (!h) return;
    h.mcNavSave(nv.rows);
    if (h.mcNavCourseSave) {
      h.mcNavCourseSave(nv.courses.map(function (c) { return c.id; }),
        nv.courses.filter(function (c) { return !c.on; }).map(function (c) { return c.id; }));
    }
  }

  /* 拖完之后从这两张清单的 DOM 反读一份草稿：顺序和落在哪一区就是屏幕上看到的样子。
     不去猜"这次动了哪几行"——跨区拖动、拖回原位这些情况一猜就漏 */
  function navReadDom() {
    var byKey = {};
    nv.rows.forEach(function (r) { byKey[r.k] = r; });
    var out = [];
    nv.root.querySelectorAll('.mc-nav-list[data-nav-zone]').forEach(function (list) {
      var zone = list.getAttribute('data-nav-zone');
      list.querySelectorAll('.mc-nav-row').forEach(function (li) {
        var k = li.getAttribute('data-nav-k');
        var was = byKey[k] || {};
        var box = li.querySelector('[data-nav-on]');
        out.push({ k: k, label: was.label || '', zone: zone,
          on: box ? (box.checked ? 1 : 0) : (was.on === undefined ? 1 : was.on),
          hideable: was.hideable !== false });
      });
    });
    nv.rows = out;
  }

  /* 课程那一列的先后和显隐，从 DOM 反读回来。名字不读：那是 Course info 的东西，
     这一档没有改它的入口，草稿里那一份只是画出来给他认行 */
  function navReadCourses() {
    var byId = {};
    nv.courses.forEach(function (c) { byId[c.id] = c; });
    var list = nv.root.querySelector('.mc-nav-list[data-nav-course]');
    if (!list) return;
    var out = [];
    list.querySelectorAll('[data-nav-id]').forEach(function (li) {
      var id = li.getAttribute('data-nav-id');
      var was = byId[id] || { id: id, name: '' };
      var box = li.querySelector('[data-nav-course-on]');
      out.push({ id: id, name: was.name, on: box ? (box.checked ? 1 : 0) : (was.on ? 1 : 0) });
    });
    nv.courses = out;
  }

  function navRenderCourses() {
    var list = nv.root.querySelector('.mc-nav-list[data-nav-course]');
    var empty = nv.root.querySelector('.mc-nav-course-empty');
    if (!list) return;
    list.innerHTML = nv.courses.map(navCourseRowHtml).join('');
    if (empty) empty.hidden = nv.courses.length > 0;
  }

  function navRender() {
    var lists = {};
    nv.root.querySelectorAll('.mc-nav-list[data-nav-zone]').forEach(function (l) { lists[l.getAttribute('data-nav-zone')] = l; });
    Object.keys(lists).forEach(function (z) { lists[z].innerHTML = ''; });
    nv.rows.forEach(function (r) {
      var list = lists[r.zone === 'bottom' ? 'bottom' : 'top'];
      if (!list) return;
      var wrap = document.createElement('ul');
      wrap.innerHTML = navRowHtml(r);
      list.appendChild(wrap.firstChild);
    });
    navRenderCourses();
  }

  /* 不用 HTML5 那套 draggable：幽灵图是浏览器画的，跟不上手，换清单时还会自己抖。
     这里自己接指针：被拖那一行抬出文档流、钉在指针上（fixed），原地留一个同高的空档；
     空档跟着指针走，松手就落在那儿。 */
  function navGhost(h) {
    var g = document.createElement('li');
    g.className = 'mc-nav-ghost';
    g.style.height = h + 'px';
    return g;
  }

  /* 指针落在哪张清单的哪两行之间：清单用矩形判，行用中线判。
     group＝只在同一族里落：站点那几行能在上区／下区之间走，课程那一行只能在自己那张清单里换先后。
     三张清单现在是上下叠着的，不认这一族的话课程行往上一抬就塞进侧栏那几行里去了 */
  function navDropAt(x, y, skip, group) {
    var lists = nv.root.querySelectorAll('.mc-nav-list');
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      if (group !== (list.hasAttribute('data-nav-course') ? 'course' : 'zone')) continue;
      var box = list.getBoundingClientRect();
      if (x < box.left - 10 || x > box.right + 10 || y < box.top - 20 || y > box.bottom + 20) continue;
      var rows = list.querySelectorAll('.mc-nav-row');
      for (var j = 0; j < rows.length; j++) {
        if (rows[j] === skip) continue;
        var rb = rows[j].getBoundingClientRect();
        if (y < rb.top + rb.height / 2) return { list: list, ref: rows[j] };
      }
      return { list: list, ref: null };
    }
    return null;
  }

  function navDragStart(e, row) {
    var box = row.getBoundingClientRect();
    var d = { row: row, dx: e.clientX - box.left, dy: e.clientY - box.top,
      group: row.closest('[data-nav-course]') ? 'course' : 'zone',
      ghost: navGhost(box.height) };
    nv.drag = d;
    row.parentNode.insertBefore(d.ghost, row);
    row.classList.add('mc-nav-lift');
    row.style.width = box.width + 'px';
    row.style.left = box.left + 'px';
    row.style.top = box.top + 'px';
    // 抬到 body 上才不受卡的 overflow 和圆角裁切，钉在指针上就是真的跟手
    document.body.appendChild(row);
    // 移动和松手挂到 window 上，不挂在这一档里：这一行已经不在面板的子里头了，
    // 事件从它身上冒上去根本路不过这一档（挂在面板上＝抬起来那一刻就断，拖不动第二下）
    d.move = ev => navDragMove(ev);
    d.up = () => navDragEnd();
    window.addEventListener('pointermove', d.move);
    window.addEventListener('pointerup', d.up);
    window.addEventListener('pointercancel', d.up);
    try { row.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  }

  function navDragMove(e) {
    var d = nv.drag;
    if (!d) return;
    d.row.style.left = (e.clientX - d.dx) + 'px';
    d.row.style.top = (e.clientY - d.dy) + 'px';
    var at = navDropAt(e.clientX, e.clientY, d.row, d.group);
    if (!at) return;
    if (!at.ref) {
      if (at.list.lastElementChild !== d.ghost) at.list.appendChild(d.ghost);
      return;
    }
    if (d.ghost !== at.ref.previousElementSibling) at.list.insertBefore(d.ghost, at.ref);
  }

  function navDragEnd() {
    var d = nv.drag;
    if (!d) return;
    nv.drag = null;
    window.removeEventListener('pointermove', d.move);
    window.removeEventListener('pointerup', d.up);
    window.removeEventListener('pointercancel', d.up);
    var row = d.row;
    ['width', 'left', 'top'].forEach(function (k) { row.style.removeProperty(k); });
    row.classList.remove('mc-nav-lift');
    if (d.ghost.parentNode) d.ghost.parentNode.insertBefore(row, d.ghost);
    d.ghost.remove();
    navReadDom();
    navReadCourses();
    navSaveNow();
  }

  function bindNavView() {
    var root = nv.root;

    root.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var row = e.target.closest ? e.target.closest('.mc-nav-row') : null;
      if (!row || !row.parentNode || !row.parentNode.classList.contains('mc-nav-list')) return;
      // 点在 Show 勾上那一笔留给复选框自己，不抢
      if (e.target.closest && e.target.closest('.mc-nav-show')) return;
      navDragStart(e, row);
    });
    // 勾是直接落在 DOM 上的，不反读一次的话"拖完又改勾"会被上一次的顺序盖掉
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (!t.matches) return;
      if (t.matches('[data-nav-on]')) {
        navReadDom();
        navSaveNow();
      } else if (t.matches('[data-nav-course-on]')) {
        navReadCourses();
        navSaveNow();
      }
    });

    root.querySelector('.mc-nav-reset').addEventListener('click', function () {
      var h = store();
      if (!h) return;
      btxAsk('mc-nav-reset-ask', 'Restore the default sidebar',
        'Every row goes back to where it starts and anything you hid comes back. This reloads the page once.',
        'Restore default', 'Cancel', function () {
          h.mcNavReset();
          location.reload();
        });
    });
  }

  /* 每次开面板重搭一遍这一档：行是 Canvas 画的，会多会少，课程那份也是现场读的。
     整座面板的 DOM 是这一刻重新搭起来的，所以监听挂一次就够，不需要"绑过没有"那颗标记 */
  function navScreenInit() {
    var h = store();
    nv.root = p.settings.querySelector('.mc-set-sec[data-sec="nav"]');
    if (!nv.root) return;
    nv.rows = h && h.mcNavDraft ? h.mcNavDraft() : [];
    nv.courses = h && h.mcNavCourseRows ? h.mcNavCourseRows() : [];
    nv.drag = null;
    navRender();
    bindNavView();
  }

  /* ==== Course info 那一屏：每门课三格自定义文字 ====
     三格都留空＝这一门课一个字都不动。写了的那一格就是卡上真换掉的那一行，
     框里那串灰字是 Canvas 现在的话，所以"不填会看见什么"是摆在眼前的。
     没有 Apply：每格改完当场落盘并重画那三行。面板开着时页面那条 300 毫秒的轮询是停的
     （mcScheduleUiPass 挡的），所以只能自己叫那一次生效，等它就是"改了卡上没动"。
     名字那一格多一条通路：开了 Send custom names to Canvas，同一句字会写进 Canvas 自己的
     课程昵称，那时这门课在 Canvas 每一屏都叫这个名、换设备也跟着。
     代码和学期官方没有对应字段，那两格永远只在这台浏览器生效。 */
  var ct = { rows: [], focus: '', poll: null, tries: 0, gaveUp: false };

  function cardTextSyncNote() {
    return 'Sends each custom name to Canvas as your nickname for that course, so every Canvas screen uses it. '
      + 'Codes and terms stay on this browser. Turning this off leaves names Canvas already holds.';
  }

  /* 一门课一块：抬头是这门课现在的名字（Canvas 那句），下面三行就是这座面板到处都在用的
     那种行（标签在左、那颗框占满剩下那一段）。不自己造四列网格：上一版那么排，
     三个框加间距比正文那一列还宽，整行顶出了卡片，底下多出一条横向滚动。
     走现成的 .mc-set-row 就同时拿到三件事：和别的行同高、永远不会顶出去、
     板子和圆角跟着主题走（它不是浏览器自带的那副样子，是这座面板自己那颗控件）。
     框里摆的是 Canvas 现在那一份文字本身，不是占位提示：占位提示一点进去就没了，
     他得从第一个字重打一遍，而他要的只是把其中几个字改掉 */
  function ctFieldHtml(c, field, label, value, max) {
    return '<div class="mc-set-row cts-row mc-set-textrow">' +
      '<span class="mc-set-label">' + esc(label) + '</span>' +
      '<input type="text" class="mc-set-text mc-ct-input" data-ct="' + field + '"' +
        ' data-ct-id="' + esc(c.id) + '" maxlength="' + max + '"' +
        ' value="' + esc(value || '') + '"' +
        ' aria-label="' + esc(label + ' for ' + c.name) + '">' +
    '</div>';
  }

  /* 框里预填的那一份＝Canvas 现在的文字，按那一格的字数上限截。
     不截的话一门 67 个字的课（Intern/Mentor Program 那种）会把整格塞满，
     他一个字母都打不进去，比原来那个"点进去就没了"还难用 */
  function ctBase(c, field) {
    return String(c[field] || '').trim().slice(0, c.max && c.max[field] ? c.max[field] : 60);
  }

  function ctRowHtml(c) {
    var o = c.over || {};
    return '<div class="mc-ct-course" data-ct-row="' + esc(c.id) + '">' +
      '<div class="mc-ct-course-name">' + esc(c.name) + '</div>' +
      ctFieldHtml(c, 'name', 'Course name', o.name || ctBase(c, 'name'), c.max.name) +
      ctFieldHtml(c, 'code', 'Course code', o.code || ctBase(c, 'code'), c.max.code) +
      ctFieldHtml(c, 'term', 'Term', o.term || ctBase(c, 'term'), c.max.term) +
    '</div>';
  }

  function cardTextViewHtml() {
    var lines = CARD_LINE_ORDER.map(function (f) {
      return checkRowHtml({ type: 'check', key: CARD_LINE_OF[f], label: CARD_LINE_LABELS[f] });
    }).join('');
    return '<div class="btx-bar mc-ct-bar">' +
        '<div class="btx-title">Course info</div>' +
        '<div class="btx-tools">' +
          '<button type="button" class="mc-set-btn btx-ctl mc-ct-clear">Restore to original</button>' +
        '</div>' +
      '</div>' +
      '<div class="mc-ct-body">' +
        '<div class="mc-set-group">' +
          '<div class="btx-group">Lines on course cards</div>' +
          lines +
          '<div class="mc-set-note" data-note="card_lines">' + esc(cardLinesNote()) + '</div>' +
        '</div>' +
        '<div class="mc-set-gap"></div>' +
        '<div class="mc-set-group">' +
          '<div class="btx-group">Your own words for a card</div>' +
          '<div class="mc-ct-tip">Each box already holds the words Canvas shows now. Type over them to change the card. Put the Canvas words back and that line goes back to Canvas. The name is also what the sidebar row for that course shows.</div>' +
          '<div class="mc-ct-list"></div>' +
          '<div class="mc-ct-empty" hidden></div>' +
        '</div>' +
        '<div class="mc-set-gap"></div>' +
        '<div class="mc-set-group">' +
          '<div class="btx-group">Names</div>' +
          checkRowHtml({ type: 'check', key: 'mc_card_name_sync', label: 'Send custom names to Canvas' }) +
          '<div class="mc-set-note" data-note="mc_card_name_sync">' + esc(cardTextSyncNote()) + '</div>' +
          '<div class="mc-ct-state" hidden></div>' +
        '</div>' +
      '</div>';
  }

  function ctState(text) {
    var n = p && p.cardtext.querySelector('.mc-ct-state');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
  }

  function ctCourse(id) {
    var s = String(id);
    for (var i = 0; i < ct.rows.length; i++) if (ct.rows[i].id === s) return ct.rows[i];
    return null;
  }

  function ctCourseName(id) {
    var hit = ctCourse(id);
    return hit ? hit.name : 'That course';
  }

  function ctRender() {
    var h = store();
    var list = p && p.cardtext.querySelector('.mc-ct-list');
    var empty = p && p.cardtext.querySelector('.mc-ct-empty');
    if (!list || !empty || !h || !h.mcCardCourseRows) return;
    var r = h.mcCardCourseRows();
    ct.rows = r.rows;
    if (!r.rows.length) {
      list.innerHTML = '';
      empty.hidden = false;
      empty.textContent = r.loading && !ct.gaveUp
        ? 'Reading your courses from Canvas.'
        : (ct.gaveUp
          ? 'Canvas has not answered yet. Close this screen and open it again to try once more.'
          : 'Canvas gave back no courses you are still in.');
      /* 轮这一趟不是因为要盯网络，是因为这一屏可能比那批课先画好。
         读失败时 content.js 那头会把请求再发一次，所以这里必须有上限，
         不然面板一直开着就是每 8 秒重发一次，永远不停 */
      if (r.loading && !ct.gaveUp && !ct.poll) {
        ct.tries = 0;
        ct.poll = setInterval(function () {
          if (!p || !p.cardtext) { clearInterval(ct.poll); ct.poll = null; return; }
          if (++ct.tries >= 20) {
            clearInterval(ct.poll); ct.poll = null; ct.gaveUp = true; ctRender();
            return;
          }
          var again = h.mcCardCourseRows();
          if (again.rows.length || !again.loading) { clearInterval(ct.poll); ct.poll = null; ctRender(); }
        }, 400);
      }
      return;
    }
    empty.hidden = true;
    list.innerHTML = r.rows.map(ctRowHtml).join('');
    // 落位要等开场那一下缩放停：卡片带 transform 的时候量 rect，滚过去的位置会偏一档
    if (ct.focus) setTimeout(ctFocus, ANIM_MS + 40);
  }

  /* 从卡片那颗 ⋮ 进来的要落在自己那门课上：滚到那一行、光标停在名字那一格。
     只滚面板这一层，背后的页面一下都不许动（和 jumpToSection 同一算法）。
     谁用它谁抹：落一次就清，第二次从别处进来不会又滚到上一门课 */
  function ctFocus() {
    if (!ct.focus || !p || !p.cardtext) return;
    var id = ct.focus;
    ct.focus = '';
    var row = p.cardtext.querySelector('[data-ct-row="' + id + '"]');
    if (!row) return;
    var delta = row.getBoundingClientRect().top - p.body.getBoundingClientRect().top;
    p.body.scrollTo({ top: Math.max(0, p.body.scrollTop + delta - 90) });
    var box = row.querySelector('[data-ct="name"]');
    if (box) box.focus({ preventScroll: true });
  }

  function ctSave(input) {
    var h = store();
    if (!h) return;
    var id = input.getAttribute('data-ct-id');
    var field = input.getAttribute('data-ct');
    var value = input.value.trim();
    var c = ctCourse(id);
    /* 框里现在预填的就是 Canvas 那一份文字，所以"一个字都没改"必须算没盖过。
       存成盖过的话，老师以后改这门课的名字，我们这一行会一直冻着他刚抄来的旧文字 */
    if (c && value === ctBase(c, field)) value = '';
    h.mcCardTextSet(id, field, value);
    h.step('mcCardTextApply', h.mcCardTextApply);
    if (field !== 'name' || !h.mcCardNameSyncOn()) return;
    ctState('Sending that name to Canvas.');
    h.mcNicknameWrite(id, value).then(function (r) {
      // 弹窗可能已经关掉了，节点早没了
      if (!p || !p.cardtext) return;
      var name = ctCourseName(id);
      if (r.ok) ctState(value ? name + ': Canvas now calls this course ' + value + '.'
        : name + ': Canvas has its own name back.');
      else ctState(name + ': Canvas did not take that name. The card here still shows what you typed.');
    });
  }

  function ctClear() {
    var h = store();
    if (!h) return;
    var named = ct.rows.filter(function (c) { return c.over && (c.over.name || c.over.code || c.over.term); });
    if (!named.length) {
      ctState('Nothing is typed here yet, so there is nothing to clear.');
      return;
    }
    var sync = h.mcCardNameSyncOn();
    btxAsk('mc-ct-clear-ask', 'Use Canvas text again?',
      'This clears the lines you typed for ' + named.length + ' course' + (named.length === 1 ? '' : 's')
      + '. The cards go back to what Canvas says.'
      + (sync ? ' The names Canvas holds for them are cleared too.' : ''),
      'Clear', 'Cancel', function () {
        var map = {};
        named.forEach(function (c) { if (c.over.name) map[c.id] = c.over.name; });
        h.mcCardTextClearAll();
        h.step('mcCardTextApply', h.mcCardTextApply);
        ctRender();
        if (!sync) {
          ctState('Cleared here. Names you had sent to Canvas are still there.');
          return;
        }
        ctState('Clearing the names Canvas holds.');
        var ids = Object.keys(map);
        ids.reduce(function (chain, id) {
          return chain.then(function () { return h.mcNicknameWrite(id, ''); });
        }, Promise.resolve()).then(function () {
          if (!p || !p.cardtext) return;
          ctState('Cleared here, and the ' + ids.length + ' name' + (ids.length === 1 ? '' : 's')
            + ' Canvas was holding are back to their course names.');
        });
      });
  }

  function openCardTextView() {
    // 不清 ct.focus：从卡片那颗 ⋮ 进来的时候它刚被填上，这里清掉就回到表头了。
    // 谁用它谁负责抹（ctFocus 落完位就抹），所以第二次进来不会又滚到上一门课
    ct.gaveUp = false;
    ctRender();
  }

  /* 那一屏的绑定只挂两次：表是每次点开重搭的，所以监听要落在一直留着的那一层上（委托），
     不往每一格里塞 */
  function bindCardText() {
    var list = p.cardtext.querySelector('.mc-ct-list');
    if (list) list.addEventListener('change', function (e) {
      var input = e.target;
      if (input.matches && input.matches('[data-ct]')) ctSave(input);
    });
    var clear = p.cardtext.querySelector('.mc-ct-clear');
    if (clear) clear.addEventListener('click', ctClear);
  }

  function close() {
    // 面板是被 Esc／点外面／别处代码关掉的，拖拽不会自己收尾：那一行还钉在 body 上，
    // 不收回列表就会留一颗飘在页面上的行
    if (nv.drag) navDragEnd();
    // 那一屏在读课程时留了一个轮询。面板关了就没人看那张表了，让它继续跑会一直握着旧节点
    if (ct.poll) { clearInterval(ct.poll); ct.poll = null; }
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.style.pointerEvents = 'none';
    // 拖到一半就关掉面板：那份临时盖色得摘掉，不然页面停在一个没落进快照的颜色上
    step('clearDraft', clearDraft);
    step('clearMakerDraft', mkClearDraft);
    col.open = '';
    col.drag = null;
    col.items = {};
    overlay.classList.remove('open');
    p = null;
    setTimeout(function () {
      try { overlay.remove(); } catch (_) {}
    }, ANIM_MS + 20);
  }

  function toggle() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.classList.contains('open')) close();
    else open();
  }

  /* content.js 那颗"首次检测到 External Extension"的弹窗会发这一句，要直接把设置开在 Themes 那一屏。
     走事件而不是让它来调我们这里的函数：两座脚本各自是 IIFE，内部函数不往外露 */
  document.addEventListener('mc-open-theme-picker', function () {
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showThemes', function () { showView('themes'); });
  });

  /* 侧栏 Settings 那一行右上角那颗点发这一句：面板要落在设置那一列，并滚到 Theme 那一组。
     它和上面那颗不一样——上面是去看墙，这一颗是去看"两套在抢，去哪儿定" */
  document.addEventListener('mc-open-theme-owner', function () {
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showThemeOwner', function () {
      showView('settings');
      jumpToSection('theme');
      markNav('theme');
    });
  });

  /* 课程卡那两处的 "Edit course info"（整屏那颗菜单、和每张卡右上角那颗）发这一句。
     卡片那颗带 detail.course：面板要落在那一门课的那一行，光标停在名字那一格。
     从整屏那颗进来没有课程，就停在表头 */
  document.addEventListener('mc-open-course-info', function (e) {
    var id = e && e.detail && e.detail.course ? String(e.detail.course) : '';
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showCourseInfo', function () {
      ct.focus = id;
      showView('cardtext');
    });
  });

  /* 复习面板抬头那颗齿轮：设置要落在设置那一列，并停在 AI & Plans 那一组。
     和 theme-owner 那一颗同一个走法：先开面板，再换列，再滚过去 */
  document.addEventListener('mc-open-ai-settings', function () {
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showAiSettings', function () {
      showView('settings');
      jumpToSection('ai');
      markNav('ai');
      try {
        aiFetchDailyPool();
        if (aiUserEmail()) aiFetchUserPlan();
      } catch (e) {}
    });
  });

  /* 扩展弹出层/快捷入口发这一句：直接打开设置面板 */
  document.addEventListener('mc-open-settings', function () {
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showSettings', function () {
      showView('settings');
    });
  });

  /* 仪表盘三点菜单那行 Widget Settings 发这一句：打开设置面板并滚到 Dashboard 那一组 */
  document.addEventListener('mc-open-widget-settings', function () {
    if (!document.getElementById(OVERLAY_ID)) step('open', open);
    step('showWidgetSettings', function () {
      showView('settings');
      jumpToSection('widgets');
      markNav('widgets');
    });
  });

  // 只滚面板这一层，背后的页面一下都不许动。
  // 用两边到屏幕顶的距离差算，不用 offsetTop：卡片带了 transform，offsetTop 那套参照系不干净
  function jumpToSection(id) {
    if (!p) return;
    var sec = p.overlay.querySelector('[data-sec="' + id + '"]');
    if (!sec) return;
    var delta = sec.getBoundingClientRect().top - p.body.getBoundingClientRect().top;
    p.body.scrollTo({ top: p.body.scrollTop + delta - 4, behavior: 'smooth' });
  }

  function step(name, fn) {
    try { fn(); }
    catch (e) { console.error('[BCX] 设置面板这一步没跑成：' + name, e); }
  }

  // 抢在 content.js 那颗键自己弹老窗口之前接管：它在按钮的冒泡阶段，这里停在捕获阶段
  function takeover(e) {
    if (!e.target || !e.target.closest) return false;
    var hit = e.target.closest(ENTRY);
    if (!hit) return false;
    e.preventDefault();
    e.stopPropagation();
    try {
      if (typeof hit.blur === 'function') hit.blur();
      var activeEl = document.activeElement;
      if (activeEl && typeof activeEl.blur === 'function') activeEl.blur();
    } catch (_) {}
    step('toggle', toggle);
    return true;
  }

  document.addEventListener('click', function (e) { takeover(e); }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (document.getElementById(OVERLAY_ID)) { e.preventDefault(); step('close', close); }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    takeover(e);
  }, true);

  window.mcSettingsPanel = { open: open, close: close, toggle: toggle };

  /* 换上"侧栏是一张图"的主题以后问一句要不要起那层磨砂。Apply 那一步当场就刷新页面，
     所以这句只能落在下一次加载：读现在这一格的侧栏档，是图就问，是纯色就不问。
     开着的时候不再问；同一份主题也只问过一遍（记的是问过的代号，换另一份带图的会再问）*/
  function navBlurAsk() {
    var h = store();
    if (!h || !h.mcSnapshot || localStorage.getItem('mc_nav_blur') === '1') return;
    var snap = h.mcSnapshot();
    if (!snap) return;
    var side = (snap.vars && snap.vars.bcsidebar) || '';
    var nav = (snap.surfaces && snap.surfaces.nav) || {};
    var look = [side, nav.raw || '', nav.bg || '', nav.layer || ''].join(' ');
    if (!/url\(/i.test(look)) return;
    var code = (snap.imported && snap.imported.code) || '';
    try {
      if (localStorage.getItem('mcx_nav_blur_ask') === code) return;
      localStorage.setItem('mcx_nav_blur_ask', code);
    } catch (_) {}
    btxAsk('mcx-nav-blur-ask', 'Frost the sidebar picture?',
      'This theme paints the sidebar with a picture. Frosting it puts a soft layer under the row names, so they stay easy to read. You can change this in Settings, under Theme.',
      'Frost it', 'Leave it sharp',
      function () {
        localStorage.setItem('mc_nav_blur', '1');
        // 主键当场就把这层挂上，不让他再进设置找第二下
        step('applyLogoSettings', h.applyLogoSettings);
      },
      function () { localStorage.setItem('mc_nav_blur', '0'); });
  }

  // 这句问话已撤下：侧栏磨砂只在设置里 Theme 那一档自己开
  // setTimeout(function () { step('navBlurAsk', navBlurAsk); }, 900);

  // 刷新后若有联动打开主题墙的标记，平滑自动打开
  try {
    if (sessionStorage.getItem('mc_auto_open_themes') === '1') {
      sessionStorage.removeItem('mc_auto_open_themes');
      setTimeout(function () {
        step('open', open);
        step('showThemes', function () { showView('themes'); });
      }, 350);
    }
  } catch (_) {}
})();
