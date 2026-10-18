/* =========================================================
   AI 复习总结的面板：侧栏那一行点开，右侧抽屉，四屏一条道走完。
   数据来自 canvas-data.js，模型调用走 ai-client.js，这里只管画面和节奏。

   三条他拍过的口径落在这份文件里：
   - 开跑之前必须先报这一趟要发多少字、估算多少 token，他点头才发。
   - 传图那颗开关默认关，开着也只从已选的正文里取图，不额外翻资料。
   - 结果只留在这个面板里，不写回 Canvas。

   2026-10-09 这一轮在这份文件里加的四件事：
   - 资料屏的"让 AI 挑"先走一遍本地判据（rankCandidates），只把最有关系的几十条报给模型，
     它回的是"编号: 为什么"，那句为什么就摆在被勾上的那一行下面。
   - 发给模型的每一份材料带一个 [R1] 那样的引用号，材料末尾还有一张对照表；
     它写 [R1] 的时候对的就是这一份清单，所以结果屏底下那张出处表用我们自己的数据画，一个字都不信它复述。
   - 回来的那一屏由 study-format.js 排版（标题、条目、表格、算式），开关是设置里的 mc_ai_format：
     那一颗同时管"要它回 Markdown"和"把它排出来"，只翻一头就会出现星号上屏。
   - 结果屏底下那一排多了追问框。追问复用发出去的那一份上下文（材料再走一次），
     所以那一句价钱要当场报出来，不是"大概"两个字糊过去。
   ========================================================= */
(function () {
  // 非 Canvas 站点直接退出，严禁挂载全局抽屉面板与点击监听
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

  var OPEN_CLS = 'mcx-study-open';
  var ANIM = 400;
  var SPIN_DELAY = 250;
  var TOTAL_CAP = 180000;
  var ITEM_CAP = 60000;
  var IMAGE_CAP = 6;
  // 流式回字时整段重排最多每 140ms 一次。第一笔不排队：晚了就是"它没在动"
  var PAINT_EVERY = 140;
  // "让 AI 挑资料"送出去的条数。
  // 但本地这一遍筛子只在清单大到非筛不可时才动手：筛掉的正是"标题里没写考点、其实是要看的那份讲义"，
  // 那一条批评早就写在案。一般一门课的资料数量不到这个数，还是一整份交出去，一条都不少它看。
  var PICK_CANDIDATE_CAP = 60;
  var PICK_FILTER_ABOVE = 90;

  /* 四档模板。"要有出处、要能自测"写在每一档自己的要求里，
     因为系统那一句是通用的，这一档该长什么样只有在这里说才定得准 */
  var TEMPLATES = [
    { id: 'cheatsheet', label: 'Cheat sheet',
      ask: 'A one-page cheat sheet for this assessment: the definitions, formulas, constants and rules a student has to hold in memory, grouped the way the course groups them. One line per entry, the term in bold first, then what to remember about it. Nothing that is not in the material.',
      tail: 'Close with a Self-check block: three questions the student can answer from memory, then the one-line answers under them.' },
    { id: 'guide', label: 'Study guide',
      ask: 'A study guide that walks the material in the order the course puts it. For each idea: the term in bold, two or three sentences on what it means and why the course wants it, then one line on what the student must be able to do. Where the material works an example, keep its numbers.',
      tail: 'Close with a Self-check block: three questions the student can answer from memory, then the one-line answers under them. If the material leaves something the assessment needs unclear, end with one line saying what to ask the teacher.' },
    { id: 'practice', label: 'Practice questions',
      ask: 'Practice questions in the style this course asks: short answer and multiple choice, mixing plain recall with the kind of calculation the material shows. Every one has to be answerable from the material. Then a separate Answers section that shows the working, not just the letter.',
      tail: 'Put the answers under their own heading, after all the questions, so the student can cover them.',
      /* 这一档另有去向：答对了协议就换成能作答的一屏题，上面那两句才是答不成时回退的画面。
         所以这两句留着不动，只把协议追加在它后面，并当场说清"内容照那两句，形状照这份 JSON" */
      json: 'Answer as exactly one JSON object in the format below. Nothing else: no markdown, no code fences, no sentence before the first brace or after the last one.\n'
        + '{"type":"mcx_practice_v1","title":"...","instructions":"...","questions":[{"id":"short-stable-id","concept":"...","type":"single_choice|multiple_choice|short_answer","prompt":"...","options":[{"id":"a","text":"..."}],"answer":["b"],"referenceAnswer":"...","explanation":"...","sourceTags":["R2"],"difficulty":"basic|understand|apply"}]}\n'
        + 'Rules for that object:\n'
        + '- 5 to 8 questions. Mix the three difficulty levels: plain recall, understanding, and a calculation or application like the material works.\n'
        + '- Every question must be answerable from the material supplied below, and every question needs sourceTags naming blocks that actually say it. Never invent a tag.\n'
        + '- concept is the one thing the question practises, small enough to redo on its own (what impulse conserves, reading a position-time graph). A chapter or unit name is not a concept.\n'
        + '- options and answer only for the two choice types; answer holds the option ids. referenceAnswer only for short_answer, two or three lines a student can score themselves against.\n'
        + '- explanation is one or two lines on why that answer is right, in the reasoning the course uses.\n'
        + '- These are practice questions generated from the course material. Never claim they are copied from a real Canvas quiz.\n'
        + '- If the material is too thin for at least three honest questions, write the practice questions as ordinary text instead, and say in one line what is missing. Do not pad the set or invent sources.' },
    { id: 'pitfalls', label: 'Common mistakes',
      ask: 'The points students most often get wrong in this material. For each one: the wrong way, the right way, and one line on why the wrong one is tempting. Use a table when there are three or more pairs.',
      tail: 'End with the two or three items worth re-reading before the assessment.' }
  ];

  /* 抬头下面那一条进度：过了的变亮，当前这一步最亮。
     结果那一屏算三步都过了；历史那一屏不是这一步里的东西，所以三颗都不亮 */
  var STEPS = [
    { k: 'tasks', label: 'Select tasks' },
    { k: 'resources', label: 'Choose resources' },
    { k: 'ask', label: 'Prompt' }
  ];

  /* 给老师写信那一屏只有一步：材料那一档和"发出去之前先报数"那一屏在这条道上没有位置，
     它读的就是选中的那几条作业本身，不再去翻课件 */
  var TEACHER_STEPS = [{ k: 'teacher', label: 'Select tasks' }];

  /* 提交详情页叫出来那一趟：作业是这一页定好的，没有"挑"这一步可做，抬头那一颗就说它是哪一条 */
  var TEACHER_STEPS_LOCKED = [{ k: 'teacher', label: 'This assignment' }];

  /* 图二那一排快捷选择在作业这条道上的六颗。口径和收件箱那六颗一样：单选，
     回的是"要它做什么"，不是它写好的字 */
  var MT_INTENTS = [
    ['grade', 'Ask about my grade'],
    ['feedback', 'Ask for feedback'],
    ['issue', 'Report a grading issue'],
    ['resubmit', 'Ask to resubmit'],
    ['missing', 'Explain a missing assignment'],
    ['help', 'Ask for extra help']
  ];
  /* 语气那四颗和调皮程度的五段话在 ai-client.js 里，和收件箱回信共用一份：
     两边发给模型的那一句必须逐字相同，抄两份就会有一天只改得动一处 */
  function mtTones() { return window.MCxAi.tones; }
  function mtPlayful() { return window.MCxAi.playfulPct(S.playful, window.MCxAi.playfulDefault); }

  /* 提交详情页那颗叫出来的是同一屏，只是作业已经定了，所以那一排快捷换成这六颗：
     全是"关于这一次提交"的话。成绩页那六颗（要解释一条没交的、要额外帮助）在这屏没有位置，
     因为这一屏没有"没交的那一条"和"整门课"这两个概念。
     同一个键在这一屏换个说法是正当的：resubmit 在整门课那一屏是"我可不可以重交"，
     在这一屏是"我要请求重交这一条"；issue 在那一屏指成绩，在这一屏指提交本身。
     键名两边共用，所以存过的稿子换一屏不会认不出自己那一档 */
  var MT_SUB_INTENTS = [
    ['feedback', 'Ask about feedback'],
    ['grade', 'Ask about my grade'],
    ['resubmit', 'Request a resubmission'],
    ['issue', 'Report a submission issue'],
    ['clarify', 'Ask for clarification'],
    ['followup', 'Send a follow-up']
  ];

  var S = {
    open: false,
    pane: 'tasks',
    /* 别的功能借这一座窗用它自己那一屏时挂进来的那一个节点（MCxStudy.embed）。
       这座窗的拖、改大小、糊、存档全是现成的，别人不该再造一座 */
    embed: null,
    courses: [],
    courseId: 0,
    courseName: '',
    tasks: [],
    taskQuery: '',
    includePast: false,
    pickedTasks: {},
    /* 从邮件那一屏带过来的任务号。任务名单是异步读回来的，所以这一格必须活到那一次回包，
       在回包里盖一次就作废，不能留着：留着的话下一次换课会被它悄悄勾上一条 */
    pendingPick: 0,
    resources: [],
    stats: {},
    pickedRes: {},
    filters: {},
    template: 'guide',
    extra: '',
    account: '',
    model: '',
    imagesOn: false,
    loading: '',
    notice: '',
    sizeNote: '',
    // 一轮一轮存着。S.result 永远等于最后那一轮正在流的文字，只有一个写者（addDelta）
    turns: [],
    baseMessages: null,
    sources: {},
    pickReason: {},
    askText: '',
    /* 历史那一屏要用的三样：这一条会话的壳子（第一次落库时定下 id 和时间）、
       它是不是从库里翻出来的（决定追问带不带课件）、返回键该回哪一屏 */
    session: null,
    fromHistory: false,
    backPane: 'ask',
    /* 宽的那一档左边那一列会话名单开不开着。它是这一屏的视图状态，不是存档，
       所以不写 localStorage：面板宽度才是判据，那一列要不要盖住由抬头那颗时钟翻 */
    railOn: true,
    // 结果屏的返回键走 backPane，历史那一屏的返回键走 historyBack：
    // 两个挤在一个字段上，从历史回到答案屏之后，那一屏的返回键就会指向它自己，按了不动
    historyBack: 'tasks',
    result: '',
    running: false,
    controller: null,
    loadGen: 0,
    runGen: 0,
    readNote: '',
    loadNote: '',
    readDone: false,
    courseKnown: true,
    /* 检索这一层的三样：这一趟到底送了什么（片段数、覆盖、token）、
       每个考点的覆盖行、还有那一行"检索没跑成"的非阻断提示 */
    ctx: null,
    coverage: null,
    openCov: {},
    retrievalNote: '',
    /* 服务自己在回包里带的那一份 token 计数。没有就是 null，屏上那一行也就不画：
       我们手里没有价目表，宁可少一行，不许多编一个数。
       这一格只留"最近那一趟"，给下面那条 in/out 拆开的读数用 */
    usage: null,
    /* 这一场对话里每一趟真发出去的请求，各占一项：第一次总结、Again 重问的那一趟、
       每一次追问。以前每一屏只挂最近那一趟的数，第二趟一来就把第一趟顶掉了，
       屏上看着像追问和重问不花钱。现在屏上那句是加法（500 + 400 = 900） */
    calls: [],
    /* 历史那一屏的课筛子：null 是"没在筛"，也就是每门课都列出来。
       进去那一屏默认就是这一档，所以这里不给它存任何"上一门课"的惯性 */
    chatCourse: null,
    /* ==== 给老师写信那一屏 ====
       mode 管抬头那一条步骤条画几步、底部那一排画什么；pane 到了那一屏就是 'teacher'。
       草稿按课存 localStorage（mc_ai_teacher_draft），所以这里每一格都有落库的那一份 */
    mode: 'summary',
    teachers: [],
    teacherId: 0,
    teacherNote: '',
    intent: MT_INTENTS[0][0],
    // 这一格只能写死：这份文件跑到这里时 ai-client.js 还没加载，取不到那四颗的名字。
    // restoreTeacherDraft 每次开这一屏都会重填它，所以它只是首帧的占位
    tone: 'formal',
    // null ＝这一屏还没挑过 playful 的刻度，真正的默认值在 ai-client.js 那一头
    playful: null,
    mtNote: '',
    mtDraft: '',
    // '' 还没写过 | waiting 正在写 | ready 稿子在这
    mtStage: '',
    /* 写给老师那一稿自己的用量：每一趟真发出去的请求各占一项，
       Regenerate 按下去是加法里的新一项，不换掉上一项 */
    mtCalls: [],
    mtErr: '',
    // 换课、按 Stop、关面板都靠它把已经在路上的回包作废，和总结那一条道的 runGen 同一个用法
    mtGen: 0,
    // 同一趟请求的 AbortController：关面板不只是"结果不要了"，连流量也要停
    mtController: null,
    // 老师名单单独一代读数，见 loadTeachers 里那句注释
    mtLoadGen: 0,
    // 那一屏默认只摆最新 10 条加没交的，这颗翻了才摆全。是视图状态，不按课存
    mtShowAll: false,
    /* 从提交详情页叫出来时这一格有值：那一屏的作业不用再挑，锁在这一条上。
       0＝成绩页那一颗叫出来的，走原来的整门课挑法 */
    mtLockTaskId: 0,
    // 页面上那行作业名。名单里认不到这一条时（测验、或者名单被页数保险截掉了）拿它兜底
    mtLockTaskName: '',
    // 这一条提交的真相（状态／分数／老师评语／rubric），MCxData.submission 回的那一份
    mtSub: null,
    // 读数单独一代：换作业、换课、重开面板都不能让旧回包盖到新屏上
    mtSubGen: 0,
    mtSubNote: '',
    // 他在这屏动过手（挑档、挑语气、打字）以后，状态预选就不许再改他选的那一颗
    mtTouched: false,
  };

  var root = null;
  var bound = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
    });
  }

  /* 排版那一档开不开。口径和 canvas-data.js 里 OCR 那颗一样：没存过算开，存了 '0' 才算关。
     它同时管两头：开着才让模型回 Markdown，也才把回的东西排出来——
     只翻其中一头就会出现"排好了没人渲染"或者"渲染了却拿到纯文本" */
  function formatOn() {
    var s = window.MCxStorage;
    if (s && s.switchOn) return s.switchOn('mc_ai_format');
    try {
      return localStorage.getItem('mc_ai_format') !== '0';
    } catch (e) {
      return true;
    }
  }

  /* 正在流的那一轮。追问和第一次总结都走这里，所以"最后一条"永远是屏幕上在动的那块 */
  function liveTurn() {
    var t = S.turns[S.turns.length - 1];
    if (!t) {
      t = { q: '', a: '', model: S.model || '', calls: [], poolUsed: false };
      S.turns.push(t);
    }
    return t;
  }

  function addDelta(piece) {
    var t = liveTurn();
    t.a += piece;
    S.result = t.a;
  }

  function threadText() {
    return S.turns.map(function (t) {
      return (t.q ? 'Q: ' + t.q + '\n\n' : '') + t.a;
    }).join('\n\n\n');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    var day = String(d.getDate()).padStart(2, '0');
    var h = d.getHours();
    var m = String(d.getMinutes()).padStart(2, '0');
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return month + ' ' + day + ', ' + h + ':' + m + ' ' + ap;
  }

  function fmtKb(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ==== 回复底下那一行的数 ====
     只有服务自己在回包里报了数才画，它没报就一个字都不多：屏上那个数必须是它数的，不能是我们替它数的。
     钱也一样：只有它自己带了 usage.cost 才提钱（现在只有 OpenRouter 会带），
     别家根本不报钱这个字段，我们不拿 token 去乘价目表，免得屏上出现一个我们编的数。
     0 块钱是报过的数（免费那一档就是这个价），所以判的是"这个字段在不在"。
     这几句全在 ai-client.js 的 usageBits 那一颗里，这里只负责把名单递过去。 */

  /* 一句用量的写法只在这一处拼，而且拼法交给 ai-client 那一颗：每一轮答复、整场对话、
     写给老师那一稿，将来还有别的屏，判据（关掉了就一个字都不出、没报数也不出字）
     都挂在这里，多一个画它的地方也不会漏掉开关。
     屏上是加法：这一串请求各用了多少 ＝ 一共多少 */
  function useText(list, label) {
    var a = window.MCxAi;
    if (a && a.isCloudMode && a.isCloudMode()) return '';
    if (a && a.usageSentence) return a.usageSentence(list, label);
    return '';
  }

  function turnUseText(turn) {
    return useText(turn && turn.calls, 'This answer');
  }

  /* 一场对话的累计：这屏幕上跑过的每一趟都算进去，包括被 Again 换掉的那一趟。
     没报数的那趟不进加法，也不说成 0 */
  function chatUseText() {
    return useText(S.calls, 'This chat');
  }

  var ICONS = {
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
    spark: 'M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    settings: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    trash: 'M6 19c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    todo: 'M3 5h18v2H3V5zm0 6h12v2H3v-2zm0 6h12v2H3v-2z',
    /* 这两颗的几何自己推的，不是抄来的：外尖 (8,12)、两条臂到 (14,6) 和 (14,18)，
       内侧凹点落在 8 ＋ t√2、两头端帽落在 14 ± t／√2，t 就是臂厚（24 那一格里的单位）。
       旧的那两串凹点写歪了（8.83／11.17），内侧不平行于外侧＝一头粗一头细的楔形，
       而且 chevL 的臂只剩 0.59 单位，折到 18px 是 0.44 CSS px，不到一个物理像素。
       他拍了要再粗一点：t 从 Material 原件那颗的 2.0 提到 2.6（18px 上 1.5px → 1.95px） */
    chevL: 'M15.84 7.84L14 6l-6 6 6 6 1.84-1.84L11.68 12z',
    chevR: 'M8.16 16.16L10 18l6-6-6-6-1.84 1.84L12.32 12z',
    /* 那几颗键的图形：实心块是面板落过去的那一条，两条短线是页面正文；
       浮窗那一档画成"一块压在另一块前面"。哪一边站着，那一边那颗就改画浮窗图形
       （图形和那句话都只说一件事：按下去会变成什么） */
    floatWin: 'M4 4h11v3H7v9H4V4zm5 6h11v10H9V10z',
    sideL: 'M4 5h7v14H4V5zm9 2h7v2h-7V7zm0 4h7v2h-7v-2z',
    sideR: 'M13 5h7v14h-7V5zM4 7h7v2H4V7zm0 4h7v2H4v-2z'
  };

  function svg(path, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  /* 这一屏那一屏都只换最外面那一个节点，抽屉本体不参与重排，
     不然每次换屏都会把它的宽度过渡一起牵动 */
  function shell() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'mcx-study-root';
    root.innerHTML =
      '<div class="mcx-study-scrim" data-close="1"></div>' +
      '<aside class="mcx-study-panel" role="dialog" aria-modal="false" aria-label="Study With AI">' +
        '<header class="mcx-study-head">' +
          '<div class="mcx-study-headrow">' +
            '<span class="mcx-study-headmark">' + svg(ICON_SPARK_PATH(), 'mcx-study-headicon') + '</span>' +
            '<span class="mcx-study-headtitle">Study With AI</span>' +
            '<button type="button" class="mcx-study-historybtn" data-history="1" aria-label="Saved chats" title="Saved chats">' + svg(ICONS.clock) + '</button>' +
          /* 齿轮排在时钟后面、关闭前面：draw() 认的是这一排里第一颗 .mcx-study-historybtn
             （那一颗要跟着"现在是不是历史屏"亮着），所以那颗必须排在最前 */
          '<button type="button" class="mcx-study-historybtn mcx-study-setbtn" data-settings="1" aria-label="Study With AI settings" title="Study With AI settings">' + svg(ICONS.settings) + '</button>' +
          /* 这两颗排在齿轮后面、关闭前面：draw() 认的是这一排里第一颗 .mcx-study-historybtn（那颗时钟），
             顺序倒了时钟那颗就不会亮 */
          '<button type="button" class="mcx-study-historybtn mcx-study-dockbtn" data-dock="left"></button>' +
          '<button type="button" class="mcx-study-historybtn mcx-study-dockbtn" data-dock="right"></button>' +
          '<button type="button" class="mcx-study-close" data-close="1" aria-label="Close">' + svg(ICONS.close) + '</button>' +
          '</div>' +
          stepsHtml() +
        '</header>' +
        /* 宽的那一档左边多出一列会话名单，正文和它并排；窄的那一档这一列不画，
           body 还是只有一个节点在换，抽屉本体不参与重排 */
        '<div class="mcx-study-cols">' +
          '<div class="mcx-study-rail" aria-label="Saved chats"></div>' +
          '<div class="mcx-study-body"></div>' +
        '</div>' +
        '<footer class="mcx-study-foot"></footer>' +
        '<div class="mcx-study-resize is-w" data-edge="w" aria-hidden="true"></div>' +
        '<div class="mcx-study-resize is-e" data-edge="e" aria-hidden="true"></div>' +
        '<div class="mcx-study-resize is-s" data-edge="s" aria-hidden="true"></div>' +
        /* 两个下角：按住这里宽和高一起走。只有三条单边时角上那 9×9 叠在一起，
           命中的只是其中一条，就得拖两趟才能把大小都调完 */
        '<div class="mcx-study-resize is-sw" data-edge="sw" aria-hidden="true"></div>' +
        '<div class="mcx-study-resize is-se" data-edge="se" aria-hidden="true"></div>' +
      '</aside>';
    document.body.appendChild(root);
    bind();
    bindGeom();
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', function (e) {
      // 右侧那一列滑出来时它就在最上面，Escape 先收它，收完那一轮才轮到面板
      if (e.key === 'Escape' && railOpen && document.documentElement.classList.contains('mcx-rail-tab-mode')) {
        railOpen = false;
        applyRailTab();
        return;
      }
      if (e.key === 'Escape' && S.open) close();
      // 覆盖那几行是 role=button 的一行字，键盘也当按钮处理才不算只做一半
      if (S.open && (e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest) {
        var cov = e.target.closest('[data-cov]');
        if (cov) {
          e.preventDefault();
          toggleCoverageAt(Number(cov.getAttribute('data-cov')));
        }
      }
    });
    // 当在面板内滚到顶/底时，阻断向宿主页面传导，防止 Canvas 页面跟着滚动
    var panelEl = root.querySelector('.mcx-study-panel');
    if (panelEl) {
      panelEl.addEventListener('wheel', function (e) {
        var scroller = e.target && e.target.closest && e.target.closest('.mcx-study-body, .mcx-study-railbody, .mcx-study-courselist');
        if (!scroller) {
          e.preventDefault();
          return;
        }
        var delta = e.deltaY;
        var up = delta < 0;
        var top = scroller.scrollTop <= 0;
        var bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        if ((up && top) || (!up && bottom)) {
          e.preventDefault();
        }
      }, { passive: false });
    }
    return root;
  }

  function ICON_SPARK_PATH() { return ICONS.spark; }

  function bodyEl() { return root.querySelector('.mcx-study-body'); }
  function footEl() { return root.querySelector('.mcx-study-foot'); }

  function open(startCourseId, opts) {
    /* AI 总开关关掉时这一扇整块画不出来：侧栏那一行、收件箱里的跳转、
       作业页借住的那一屏、设置里那颗，全都要经过这一颗，所以只关这里一处就全断。
       开关翻回开着时不必补一趟：那些入口各自每一轮都会重新问过这里 */
    if (window.mcAiOn && !window.mcAiOn()) return;
    var created = !root;
    opts = opts || {};
    // 他回到面板里看了，那句"要停还是在背后写完"就作废：这一屏底下本来就有 Stop 那颗
    dismissRunAsk();
    // 上一趟关闭留下的冻结到这里作废：这一趟要按现在这一档重算一次左边缘
    frozenNavW = -1;
    // 这一页的那一层推不推得动，每一趟重开都重新判一次（换页是另一棵 DOM）
    layer.dead = false;
    clearTimeout(freezeTimer);
    shell();
    S.open = true;
    /* 从别的屏幕带着任务、带着屏、或者走写信那一道来，"上次会话"都不许再把面板领回旧的一屏。
       写信那一屏尤其：它是从成绩页那颗键叫出来的，落回上次看的那条总结就等于没响应 */
    if (opts.pane || opts.mode === 'teacher') lastChatTried = true;
    S.pendingPick = opts.pickTaskId ? Number(opts.pickTaskId) : 0;
    // 那三样都住在扩展自己的存储里，读数一律异步：点开这一刻就发起，别让第一屏对着空账说话
    try {
      if (window.MCxAi && window.MCxAi.load) window.MCxAi.load();
      var hh = window.MCxHistory && window.MCxHistory.hydrate ? window.MCxHistory.hydrate() : null;
      // 库里那一份读回来以后左边那一列才有真名单：没读回来那一头左边那一列只能说"正在读"，说"没存过"是假空状态
      if (hh && hh.then) hh.then(function () {
        if (!S.open) return;
        restoreLastChat();
        drawRail();
      }, function () {});
      if (window.MCxProgress && window.MCxProgress.hydrate) window.MCxProgress.hydrate();
    } catch (e) {}
    document.documentElement.classList.add(OPEN_CLS);
    /* 形态、让位、推挤都要在"加展开态"之前定好：那一下才开始 400ms 的滑动，
       页面主列的 margin 和抽屉必须是同一条路上一起走，晚一趟就成了两段 */
    applyLayout();
    // 第一次点：节点刚建好就在同一帧加上展开态，浏览器根本没画过收起那一帧，
    // 于是没有可插值的起点——症状正是他报的"首次打开没动画，第二次才正常"。
    // 读一次 offsetWidth 把收起那一帧强制刷出来，动画就有了起点。
    // 只有新建那一帧需要，第二次打开节点早就画过了，不去白读这一次布局
    if (created) void root.offsetWidth;
    root.classList.add('is-open');
    /* 临时取证（磨砂那一轮，读完就删）：抽屉开着的那一帧到底是糊的还是没糊，
       只有这一刻在页面上，隔截图量不到。等滑动跑完再读，读的是计算值不是推论 */
    setTimeout(function () {
      var el = panelEl();
      var cs = el ? getComputedStyle(el) : null;
      console.log('[MCX] frost-check', JSON.stringify({
        frost: document.documentElement.classList.contains('mc-frost') || document.documentElement.classList.contains('bcx-frost'),
        bg0: getComputedStyle(document.documentElement).getPropertyValue('--mc-background-0'),
        panelBf: cs ? cs.backdropFilter : 'no-panel',
        panelBg: cs ? cs.backgroundColor : '',
        panelTf: cs ? cs.transform : '',
        plate: 'removed',
        mode: root ? String(root.className) : ''
      }));
    }, ANIM + 250);
    var before = S.courseId;
    if (startCourseId) S.courseId = startCourseId;
    /* 两道共用这同一个抽屉：那颗键叫的是哪一道，这一趟就走哪一道。
       侧栏那一行不带 mode，所以它永远回总结那三道步 */
    var nextMode = opts.mode === 'teacher' ? 'teacher' : 'summary';
    var sameCourse = !before || !S.courseId || before === S.courseId;
    /* 换了一门课就必须把上一门课那一整套清掉、回到第一屏。
       以前这里什么都不做：从另一门课的门进来时，屏幕上还是上一门课停着的那一屏，
       材料那一列要么是旧课的，要么是空的，看着就是"内容列表完全不显示" */
    if (before && S.courseId && before !== S.courseId) {
      resetForCourseSwitch();
      S.pane = 'tasks';
    }
    /* 从邮件里带进来的那一屏：落在哪一屏、问的是什么、用哪一档，都在这一步盖上去。
       必须排在换课清理之后，否则换课那一段会把刚设的落点又抹回第一屏 */
    if (opts.template && TEMPLATES.some(function (t) { return t.id === opts.template; })) S.template = opts.template;
    if (typeof opts.extra === 'string') S.extra = opts.extra;
    /* 'history' 不在这里盖：那一屏宽窄两档的落点不一样（宽的是左边那一列，窄的才是一整屏），
       直接盖成 'history' 会在宽的那一档同时画出两份名单。它由这一趟末尾的 showHistory() 定 */
    if (opts.pane && opts.pane !== 'history') S.pane = opts.pane;
    var modeChanged = nextMode !== S.mode;
    S.mode = nextMode;
    if (S.mode === 'teacher') {
      /* 锁不锁、锁的是哪一条，是这一屏的身份的一部分：同一门课从作业 A 换到作业 B，
         正在路上的回包不许把 B 的格子留给 A 的稿子，所以这一判要多带一条 sameLock */
      var lockId = Number(opts.assignmentId) || 0;
      var sameLock = lockId === S.mtLockTaskId;
      S.mtLockTaskId = lockId;
      S.mtLockTaskName = String(opts.assignmentName || '');
      if (!sameLock) { S.mtGen++; stopTeacherStream(); S.mtSub = null; S.mtSubNote = ''; }
      /* 正在写的那一稿不撤：同一门课、同一条作业重开面板，回包还在路上的时候
         拿存储那一份盖回去，他就会看见刚写出来的字被清空一次 */
      if (!(sameCourse && sameLock && S.mtStage === 'waiting' && !modeChanged)) restoreTeacherDraft();
      S.pane = 'teacher';
      loadTeachers();
      if (S.mtLockTaskId) loadSubmission();
    } else if (modeChanged) {
      S.pane = 'tasks';
    }
    loadCourses();
    // 已经停在材料那一屏时，这一屏的数据每次点开都要重读一遍（老师可能刚改过模块）
    if (S.pane === 'resources') loadResources();
    // 这一页第一次点开：回到上次在看的那一条。openSession 自己会画，所以这一趟不再补一次 draw
    if (!restoreLastChat()) draw();
    // 侧栏那一行点开的应该是存过的那批会话，不是新的一屏
    if (opts.pane === 'history') showHistory();
  }

  /* 历史摆在屏幕上：宽的那一档是左边那一列名单，窄的那一档是"历史"那一屏。
     和抬头那颗时钟共用这一段，所以两种档法只有一份定义 */
  function showHistory() {
    if (isWide()) {
      if (!S.railOn) setRailOn(true);
      return;
    }
    if (S.pane === 'history') return;
    S.historyBack = S.pane;
    S.pane = 'history';
    // 进去那一刻一律先看全部，上一回筛在哪门课不算数
    S.chatCourse = null;
    S.notice = '';
    var h = window.MCxHistory;
    if (h && h.hydrate) {
      h.hydrate().then(function () { if (S.open && S.pane === 'history') draw(); },
                       function () { if (S.open && S.pane === 'history') draw(); });
    }
    draw();
  }

  /* ==== 正在出字时关面板：先收面板，再问这一趟怎么办 ====
     停＝把已经落下的那半截存进历史，这一趟不再花钱。继续＝它在背后写完，写完原地更新同一条。
     还没落一个字的那一趟不问：屏上什么都没有，停不停都没东西可留，所以让它安静地跑下去，
     他下次点开面板正好回到那一屏接着看流字。 */
  var RUN_ASK_ID = 'mcx-study-runask';

  function dismissRunAsk() {
    var el = document.getElementById(RUN_ASK_ID);
    if (!el) return;
    el.classList.remove('open');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
  }

  function askRunChoice() {
    if (document.getElementById(RUN_ASK_ID)) return;
    var overlay = document.createElement('div');
    overlay.id = RUN_ASK_ID;
    overlay.className = 'bc-modal-overlay';
    overlay.innerHTML =
      '<div class="bc-modal-card" role="dialog" aria-label="Still generating">' +
        '<div class="bc-modal-title">Still generating</div>' +
        '<div class="bc-modal-note">Stop to keep the text already shown and avoid further usage, or let the response finish.</div>' +
        '<div class="cts-sync-btn" data-run-ask="stop">Stop it</div>' +
        '<div class="cts-sync-btn" data-run-ask="keep">Keep answering</div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    /* 遮罩上点外面不作答：这一问没有"算了"这一档，两颗键各自当场把事办了 */
    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-run-ask]') : null;
      if (!btn) return;
      if (btn.getAttribute('data-run-ask') === 'stop') cancel();
      dismissRunAsk();
    });
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    /* 写信那一屏：关面板就是"这一稿先留着"，所以先把已经在路上的那一趟作废（否则它回完字
       会往已经不在这儿的格子里写），再把这一屏的输入按这门课存下来 */
    if (S.mode === 'teacher') {
      S.mtGen++;
      stopTeacherStream();
      if (S.mtStage === 'waiting') S.mtStage = '';
      saveTeacherDraft();
    }
    document.documentElement.classList.remove(OPEN_CLS);
    root.classList.remove('is-open');
    /* 借窗那一屏跟着这一关交还出去：那位是在页面里挂着的卡，窗关了它要回到原来的位置，
       不然再开这扇窗看到的还是上一页的答案 */
    if (S.embed) {
      var back = S.embed.onClose;
      S.embed = null;
      if (S.pane === 'embed') S.pane = 'tasks';
      if (back) { try { back(); } catch (e) {} }
    }
    /* 左边缘钉在原地，等这 400ms 的位移跑完再松手：这一趟里侧栏会反向展开，
       让左边缘跟着改就成"退出去一半、又回来、再退一次"（他报的那个重复关闭） */
    frozenNavW = navUsed();
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(function () { frozenNavW = -1; }, ANIM + 120);
    // 让出去的那几列（课程菜单、侧栏、页面主列的宽）在这一趟一起还回去，
    // 还回去走的是同一条动画，和他点开时的方向反过来才对得上
    applyLayout();
    /* 总结／追问那一趟正在往下写字时，关面板不再等于 Stop：那半截先存进历史（换课或刷新会把
       这条链掐死，先落盘的才保得住），再问一句要停还是让它背后写完。背后写完落库时用的是
       同一个会话 id，所以原地更新那一条，历史名单里不会存出两条 */
    if (S.mode !== 'teacher' && S.running) {
      var tail = S.turns[S.turns.length - 1];
      if (tail && tail.a) {
        persistSession();
        askRunChoice();
      }
    } else {
      cancelRun();
    }
  }

  /* ==== 面板摆在页面的哪一处 ====
     三档形态（靠左停靠／靠右停靠／悬浮窗）在 CSS 第 49 节，这里只管类名和数。
     一份正本：档位、左右、宽度、推不推页面都从 localStorage 现读，
     所以设置里翻一颗键就是 MCxStudy.layout() 一趟，不存在第二份状态要对齐。
     页面级那三样（课程那一列、应用侧栏、右侧 To Do）也读同一份。 */

  var MIN_W = 420;
  var MIN_H = 440;
  // 到这一档就分出左边那一列历史（264）＋右边正文（至少还有一屏的一半）
  var WIDE_AT = 760;
  // 推挤以后正文至少还要剩下的宽：面板再想宽也得给中间留这一截
  var PAGE_MIN = 360;
  var OBS_EVERY = 300;

  var L = {
    mode: 'docked', side: 'right', w: 620,
    push: true, autoNav: true, autoSide: true, todoTab: true,
    x: 0, y: 0, h: 0
  };
  // 我们替页面收掉的那几样，只在确实是我们挂上的时候才认领、才还回去。
  // 这份凭据同时抄一份到 sessionStorage：Canvas 会把"课程菜单是收着的"存到自己那一格里，
  // 而我们正在面板开着的时候被重载（他按 F5、换课触发整页重读）时内存里那份就丢了，
  // 结果是我们收的、别人不认，菜单从此不回原位
  var tuck = { nav: false, side: false, navPref: null };
  var TUCK_KEY = 'mcx_ai_tuck_v1';

  function saveTuck() {
    try {
      if (tuck.nav || tuck.side) sessionStorage.setItem(TUCK_KEY, JSON.stringify(tuck));
      else sessionStorage.removeItem(TUCK_KEY);
    } catch (e) {}
  }

  function readTuck() {
    var r = null;
    try { r = JSON.parse(sessionStorage.getItem(TUCK_KEY) || 'null'); } catch (e) { r = null; }
    return r && (r.nav || r.side) ? r : null;
  }

  /* 重载以后第一件事：把上一趟我们收掉的东西还回去（面板这会儿必然还没开）。
     宿主那颗键还没挂出来时不清凭据，留着让观察器那一趟再试一次——
     Canvas 的 React 比 document_idle 慢，第一趟常常还没有它 */
  function restoreLeftoverTuck() {
    var r = readTuck();
    if (!r) return;
    var btn = document.querySelector(NAV_TOGGLE_SEL);
    if (r.nav && !btn) return;
    if (r.nav && !courseNavOpen()) btn.click();
    if (r.side) {
      tuckNav(r.navPref === '1');
      if (r.navPref === '1') {
        localStorage.setItem('mc_nav_min', '1');
        localStorage.setItem('bcx_nav_min', '1');
      } else {
        localStorage.removeItem('mc_nav_min');
        localStorage.removeItem('bcx_nav_min');
      }
    }
    try { sessionStorage.removeItem(TUCK_KEY); } catch (e) {}
    tuck.nav = false;
    tuck.side = false;
    tuck.navPref = null;
  }
  var pushed = { host: null, side: '', value: 0, natural: 0, nav: -1, prevLeft: '', prevRight: '' };
  /* 这一页的"整页那一层"推得动推不动：dead＝它吃了 margin 屏幕不动（钉死的 margin、
     或者压根不在看得见的那条链上），这一档就一路走只推正文的老路。
     每次重开面板重判一次：换页／换屏都是另一棵 DOM，上一趟的判决不算数 */
  var layer = { dead: false };
  var dragging = false;
  var railOpen = false;   // 右侧那一列现在是滑出来的。不存档：重新载入就回到折起来那一档
  var railTab = null;
  var settleTimer = 0, relayoutTimer = 0, chromeTimer = 0, freezeTimer = 0;

  function panelEl() { return root ? root.querySelector('.mcx-study-panel') : null; }

  function pos(v, def) {
    var n = Math.round(Number(v));
    return isFinite(n) && n > 0 ? n : def;
  }

  function signed(v, def) {
    var n = Math.round(Number(v));
    return isFinite(n) ? n : def;
  }

  function clamp(v, lo, hi) {
    return hi > lo ? Math.max(lo, Math.min(v, hi)) : lo;
  }

  // 这几颗都是 defOn：没存过就是开着，只有存成 '0' 才算关
  function on(v) { return v !== '0'; }

  function maxW() {
    var vw = window.innerWidth || 1280;
    return Math.max(MIN_W, vw - PAGE_MIN);
  }

  function readLayout() {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    L.mode = localStorage.getItem('bc_ai_panel_mode') === 'floating' ? 'floating' : 'docked';
    L.side = localStorage.getItem('bc_ai_panel_side') === 'left' ? 'left' : 'right';
    L.w = clamp(pos(localStorage.getItem('mc_ai_panel_w'), 620), MIN_W, maxW());
    L.push = on(localStorage.getItem('mc_ai_push'));
    L.autoNav = on(localStorage.getItem('mc_ai_fold_menu'));
    L.autoSide = on(localStorage.getItem('mc_ai_tuck_nav'));
    L.todoTab = on(localStorage.getItem('mc_ai_todo_tab'));
    var g = null;
    try { g = JSON.parse(localStorage.getItem('mc_ai_float_geo') || 'null'); } catch (e) { g = null; }
    g = g || {};
    L.h = clamp(pos(g.h, Math.round(vh * 0.8)), MIN_H, Math.max(MIN_H, vh - 60));
    /* 一次都没拖过就没有落点，那就贴在设置里挑的那一边；拖过一次之后存下来的那个落点才算数，
       所以换了那一边也不会把他摆好的窗口抢走 */
    var homeX = L.side === 'left' ? navUsed() + 16 : Math.max(8, vw - L.w - 16);
    // 上一次可能是在一台更宽的显示器上摆的位置：按现在这块屏幕整个拉回来，别开到看不见的外面
    L.x = clamp(signed(g.x, homeX), 8 - (L.w - 140), Math.max(8, vw - 140));
    L.y = clamp(signed(g.y, Math.max(8, Math.round((vh - L.h) / 2))), 0, Math.max(0, vh - 60));
  }

  function isTop() {
    try { return window.top === window; } catch (e) { return false; }
  }

  /* 应用侧栏占掉的那一段宽。这里只要"这一档落定之后是多少"，一次算准、中途不改口：
     面板的开和关都是 400ms 的位移，左边缘要是在这中间变过一次，
     看着就是"退出去一半又回来再退"（他报的两段路都是这一个成因）。
     读 CSS 变量就够了：翻那一档时变量是瞬间换值的，动画走的只是宽。
     以前这里还读一份 BC 的 `--bcsidebarwidth` 取更大那颗，理由是"那一块的宽是它那张表钉的"。
     [实测 2026-10-10] 那条已经不成立：style.css 那条 `html #header.ic-app-header{width:var(--bc-nav-w)!important}`
     从首帧就把栏宽钉在我们这一档（BC 那条只写 #header，同带 id、我们多一层类名，又是扩展的用户表），
     它那份数只是留在变量上没人用。他报的"贴到左侧时中间一大条空带"就是它：栏实际 74，
     它那份是 180，取大就把面板推到 180 上，空出 106 像素。所以这里只看 --bc-nav-w 一颗。
     以前那条"落定之后量一次真宽、往大里对账"同样是错的，别再补回来。 */
  var frozenNavW = -1;   // 关面板那一段：左边缘钉在原地等位移跑完

  function navUsed() {
    if (frozenNavW >= 0) return frozenNavW;
    var b = document.body;
    if (b && (b.classList.contains('no-headers') || b.classList.contains('content-only') || b.classList.contains('hide-global-nav'))) return 0;
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bc-nav-w'));
    if (!isFinite(v) || v <= 0) v = 0;
    return v;
  }

  /* 面板在视口里占掉的那一段。靠左时它从侧栏右边缘起（和那一列融在一起，不压着它），
     靠右时贴屏幕边。悬浮窗不算段：它飘着，不推页面 */
  function band() {
    if (L.mode === 'floating') return null;
    var vw = window.innerWidth || 1280;
    if (L.side === 'left') {
      var n = navUsed();
      return { from: n, to: n + L.w };
    }
    return { from: vw - L.w, to: vw };
  }

  /* 推挤只推一个节点：推两条就会推两遍，中间那条空带就是这么来的。
     按顺序认第一条真在页面上撑开的主列 */
  var PUSH_HOSTS = ['#content', '.ic-Layout-contentMain', '#dashboard_view_wrapper', '#main'];

  function pickPushHost() {
    for (var i = 0; i < PUSH_HOSTS.length; i++) {
      var el = document.querySelector(PUSH_HOSTS[i]);
      if (el && el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  }

  /* 靠左那一档推的不是正文，是"整页那一层"：标题行、课程那一列、正文一起走。
     只推 #content 的话标题行和左边那一列整条留在原地＝面板盖上去，他报的"看不见、也不动"。
     哪一颗是那一层，不写死类名（Canvas 两代页面把它放在不同层上，我们在这上面吃过很多次亏）：
     侧栏是固定的一栏，正文住在它的兄弟节点里，所以"和 #header 同一个爹、并且真装着 #content"
     的那一颗就是它。读不到就退回上面那条只推正文的老路，不至于什么都不动 */
  function pageLayer() {
    var header = document.getElementById('header') || document.querySelector('.ic-app-header');
    var parent = header && header.parentElement;
    var probe = document.getElementById('content') || document.querySelector('.ic-Layout-contentMain');
    if (!parent || !probe) return null;
    for (var i = 0; i < parent.children.length; i++) {
      var el = parent.children[i];
      if (el === header || !el.contains(probe)) continue;
      if (el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  }

  function clearPush() {
    var host = pushed.host;
    document.documentElement.classList.remove('mcx-push-on');
    if (!host) return;
    host.classList.remove('mcx-push-host');
    host.style.marginLeft = pushed.prevLeft;
    host.style.marginRight = pushed.prevRight;
    pushed.host = null;
    pushed.side = '';
    pushed.value = 0;
    pushed.natural = 0;
  }

  /* 要补的那一段按"面板朝里那条边"到"主列现在的边"算，不是照面板宽度硬推：
     主列本来就躲在面板后面时算出来是 0，就一个字都不动它。
     selfPushed 是上一趟我们自己推出去的那一段，要加回去才量得到它没被推时的位置 */
  function pushFor(host, bd, navFreed, selfPushed) {
    var r = host.getBoundingClientRect();
    if (L.side === 'left') return Math.max(0, Math.ceil(bd.to - (r.left - selfPushed - navFreed)));
    return Math.max(0, Math.ceil(r.right + selfPushed - bd.from));
  }

  /* 加回去的那一段必须读**当下渲染中的**那个 margin，不能用 pushed.value（我们写的目标值）：
     这一段正走 400ms 的过渡，getBoundingClientRect 量到的是中途的边。拿目标值去补，
     量出来的"页面本来就在那儿"就永远偏浅一档，于是每一趟都比上一趟多推一点，
     推到过头再弹回来＝他报的"卡片反复改宽、超出界、又挪回来"。
     开面板那三趟（起步／落定补的那一趟／body 变动每 300 毫秒补一趟）和拖着改宽那一路都是这一个成因 */
  function renderedPush(host) {
    var cs = getComputedStyle(host);
    var v = parseFloat(L.side === 'left' ? cs.marginLeft : cs.marginRight);
    return isFinite(v) ? v : 0;
  }

  /* 那一层里面现在站在最左的是哪一样：标题行、课程那一列、正文，谁靠左就用谁。
     不能只量 #content——课程那一列是它的兄弟、排在它左边，照正文对齐会把那一列整条留在面板底下。
     这一页没有标题行／没有那一列的档很多，所以逐条量、宽大于 0 才算数，全落空才退到那一层自己的边 */
  var LAYER_PROBES = ['#breadcrumbs', '.ic-app-nav-toggle-and-crumbs', '#left-side',
                      '#content', '.ic-Layout-contentMain', '#dashboard_view_wrapper'];

  function layerLeftmost(host) {
    var best = null;
    for (var i = 0; i < LAYER_PROBES.length; i++) {
      var list = document.querySelectorAll(LAYER_PROBES[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!host.contains(el)) continue;
        /* 钉在屏幕上的那一档（课程抽屉在窄屏是 fixed）跟着我们推不动，
           拿它当参照会把那一段边距算两遍，所以只认在页面流里的那几样 */
        if (getComputedStyle(el).position === 'fixed') continue;
        var r = el.getBoundingClientRect();
        if (r.width <= 0) continue;
        if (best === null || r.left < best) best = r.left;
      }
    }
    return best === null ? host.getBoundingClientRect().left : best;
  }

  /* 那一层"没被我们推的时候，最左那一样站在哪儿"。量的是当下的边，再把自己这一趟写上去的那一段
     （过渡中途读到的正是插值出来的那一个数）减掉：两个数是同一帧的，所以动画中途量也准。
     这一段不能照"侧栏宽＋面板宽"硬算——侧栏那一段边距有的挂在这一层自己身上、有的挂在它里面那一层，
     两份都算进去就是中间那条空带（他 2026-10-10 那张截图） */
  function layerNatural(host) {
    var m = parseFloat(getComputedStyle(host).marginLeft);
    return layerLeftmost(host) - (isFinite(m) ? m : 0);
  }

  /* 靠左那一档推的是"整页那一层"：标题行、课程那一列、正文一起走。
     只推 #content 的话标题行和左边那一列整条留在原地＝面板盖上去。
     要补的那一段＝面板朝里那条边 − 那一层里最左那一样没被推时站的位子，一次算准，动画中途不改口。
     返回 false ＝ 这一页不走这一条（认不出那一层，或验过它吃了 margin 也不动），
     交回下面那条只推正文的老路，不许出现"两边都不动" */
  function pushLayer(host) {
    if (!host || layer.dead) return false;
    var fresh = pushed.host !== host || pushed.side !== L.side;
    if (fresh) {
      clearPush();
      pushed.host = host;
      pushed.side = L.side;
      pushed.prevLeft = host.style.marginLeft;
      pushed.prevRight = host.style.marginRight;
    }
    /* 正文站位子只在两种时候重量：刚认下这一层，和侧栏那一档翻了（下面那条是带 !important 写上去的，
       站点自己改的那一段边距会被我们压住，所以这一趟必须自己跟上来）。
       每 300 毫秒那一趟不许重量：那正是"每一趟都比上一趟多推一点、推到过头再弹回来"的老成因 */
    if (fresh || pushed.nav !== navUsed()) {
      pushed.natural = layerNatural(host);
      pushed.nav = navUsed();
    }
    var bd = band();
    var target = Math.max(0, Math.ceil(bd.to - pushed.natural));
    /* 那颗类名只管这一层的过渡。站点重渲染会把它连行内那一条一起抹掉，
       所以每一趟都补一次（已经在就是空操作，不挂 attribute 观察器，不会自己绕圈） */
    host.classList.add('mcx-push-host');
    var want = snapPx(target) + 'px';
    /* 行内那一条要带 !important 才压得住钉死 margin 的那张表（站点自己的、还有我们那条
       .ic-Layout-wrapper{margin-left:var(--bc-nav-w)!important}）——不带就等于写不下去，
       屏幕上一个字都不动＝上一轮报的"更差了"。
       被站点重渲染抹掉时这一趟也当场补回来，所以比的是"它还写着没有"，不是"上一趟的数变没变" */
    var written = host.style.marginLeft !== want;
    if (written) host.style.setProperty('margin-left', want, 'important');
    if (host.style.marginRight !== pushed.prevRight) host.style.marginRight = pushed.prevRight;
    pushed.value = target;
    document.documentElement.classList.add('mcx-push-on');
    if (fresh || written) relayoutCards();
    if (fresh) {
      /* 写下去不等于挪得动：那一层可能压根不在看得见的那条链上，屏幕上一个字都不动＝
         上一轮报的"全部被遮住"。动画跑完验一次，判据不是"我们那条 margin 写进去没有"，
         是屏幕上那件事：那一层里最左的一样有没有正好接到面板朝里那条边上
         （停在原地＝推空了；还压在面板底下＝层认错了一颗，它不含最左那一栏） */
      setTimeout(function () {
        if (pushed.host !== host) return;
        var bd = band();
        var at = layerLeftmost(host);
        var clear = !bd || at >= bd.to - 8;
        console.log('[MCX] push-layer', host.tagName.toLowerCase() + (host.id ? '#' + host.id : ''),
          String(host.className || '').slice(0, 40),
          'natural', pushed.natural, 'margin', target, 'nav', Math.round(navUsed()),
          'want', bd ? Math.round(bd.to) : -1, 'at', Math.round(at), clear ? 'ok' : 'dead');
        if (clear) return;
        layer.dead = true;
        clearPush();
        syncPush(true);
      }, ANIM + 260);
    }
    return true;
  }

  function syncPush(settle) {
    if (!isTop()) return;
    var bd = band();
    if (!bd || !L.push || !S.open) {
      clearPush();
      return;
    }
    if (L.side === 'left' && pushLayer(pageLayer())) return;
    var host = pushed.host && document.contains(pushed.host) ? pushed.host : pickPushHost();
    if (!host) {
      clearPush();
      return;
    }
    /* 课程那一列刚点下去的时候量到的是收之前的位置：先按收完算，页面和抽屉才是一条路走完。
       等它落定那趟（settle）再量一次真的，差得多就补一跳，量得准就是什么都不动 */
    var freed = 0;
    if (!settle && tuck.nav) {
      var ls = document.getElementById('left-side');
      if (ls) freed = Math.max(0, Math.ceil(ls.getBoundingClientRect().width));
    }
    /* 换边那一趟要先把自己上一趟推出去的那一段收回来再量：留着它就会被当成"页面本来就在那儿"，
       接下来那一段 margin 就按两个面板的宽去补了 */
    var same = pushed.host === host && pushed.side === L.side;
    var px = pushFor(host, bd, freed, same ? renderedPush(host) : 0);
    if (!same) {
      clearPush();
      pushed.host = host;
      pushed.side = L.side;
      pushed.prevLeft = host.style.marginLeft;
      pushed.prevRight = host.style.marginRight;
    } else if (Math.abs(px - pushed.value) < 2) {
      /* 量到的数和已经写下去的那一段对得上（差不到 2 像素）就一个字都不再写：
         写一次就是一次全页重排加一趟卡片重算。
         这里必须留一档容差：过渡中途 r.right 和渲染中的 margin 各带零点几像素，相加本该恒定，
         可 pushFor 末尾那道 Math.ceil 会把 0.3 的噪声放大成 1 的差，于是每一趟都"变了 1 像素"，
         400 毫秒的过渡被一遍遍重新起步＝他报的卡片一路在改宽 */
      return;
    }
    pushed.value = px;
    var v = px > 0 ? snapPx(px) + 'px' : '';
    if (L.side === 'left') {
      host.style.marginRight = pushed.prevRight;
      host.style.marginLeft = v;
    } else {
      host.style.marginLeft = pushed.prevLeft;
      host.style.marginRight = v;
    }
    document.documentElement.classList.toggle('mcx-push-on', px > 0);
    relayoutCards();
  }

  /* 卡片墙是按容器实际宽度摆坐标的，让出来的这一段不重排就会叠在面板下面。
     content.js 那一头收窄导航之后也是等动画跑完再重排一次，这里同一套做法 */
  function relayoutCards() {
    var h = window.mcHost || window.bcxHost;
    if (!h) return;
    var fn = h.mcMasonryLayout || h.bcxMasonryLayout;
    if (typeof fn !== 'function') return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      try { fn(); } catch (e) {}
    }, 420);
  }

  /* 课程那一列（#left-side）收起走站点自己那颗 Hide／Show。
     以前这里是我们自己挂 width:0 !important 那一档（style.css 5.1 节备好的三个类名），
     实测把 Canvas 自己的 Show 顶掉了：位置留着、东西没了，他点 Show 也点不回来＝图2 那一大片空白。
     它那颗键自己会重排布局，我们只按一下，关面板时只在"现在是收起的"才按回去 */
  var NAV_TOGGLE_SEL = '[data-toggle="#left-side"], #section-tabs-toggle, .ic-app-nav-toggle, [aria-label*="Courses Navigation Menu"]';

  /* 那一列现在是展开还是收起：先读那颗键自己写的字（Hide＝现在是开着的，Show＝现在是收着的），
     它才是宿主那一档的正本。量宽只是退路——那颗键收的可能是里面的列表而容器还留着宽，
     那时按宽判就会说"它是开着的"，关面板时那一按回去就被跳过，菜单从此不回来了。 */
  function courseNavOpen() {
    var btn = document.querySelector(NAV_TOGGLE_SEL);
    var lab = btn ? String(btn.getAttribute('aria-label') || btn.getAttribute('title') || '') : '';
    var m = /^\s*(Show|Hide)\b/i.exec(lab);
    if (m) return m[1].toLowerCase() === 'hide';
    var ls = document.getElementById('left-side');
    // 读不到文字才看量到的宽：Canvas 自己收这一列是行内 display:none，那时宽是 0
    return !!(ls && ls.getBoundingClientRect().width > 0);
  }

  function foldCourseNav(want) {
    if (!isTop()) return;
    var btn = document.querySelector(NAV_TOGGLE_SEL);
    if (want && L.autoNav) {
      if (!tuck.nav && btn && courseNavOpen()) {
        btn.click();
        tuck.nav = true;
        saveTuck();
      }
      return;
    }
    if (tuck.nav && (!want || !L.autoNav)) {
      tuck.nav = false;
      saveTuck();
      if (btn && !courseNavOpen()) btn.click();
    }
  }

  /* 侧栏那一档借的是站点自己收窄用的 bcx-nav-min：同一颗机制，
     文字被容器一点点擦掉那套设计、那颗键的文案、两节列表的折叠才都跟着走。
     但 bcx_nav_min 那一格是他的偏好正本，setNavMinimized 会顺手写它，
     所以我们接手前先把他的值记下来，还回去的时候连那一格一起还 */
  function tuckSideNav(want) {
    if (!isTop()) return;
    var html = document.documentElement;
    var live = html.classList.contains('mc-nav-min') || html.classList.contains('bcx-nav-min');
    if (want && L.autoSide && !live) {
      tuck.navPref = localStorage.getItem('mc_nav_min') || localStorage.getItem('bcx_nav_min');
      tuckNav(true);
      tuck.side = true;
      saveTuck();
      return;
    }
    if (tuck.side && (!want || !L.autoSide)) {
      tuck.side = false;
      var back = tuck.navPref === '1';
      tuckNav(back);
      /* 那一颗键自己会写 mc_nav_min，而他手上那一格才是正本：
         所以先让它跑，再把他原来那一格摆回去（原来没有这一格就是删掉，不是写 '0'） */
      if (back) {
        localStorage.setItem('mc_nav_min', '1');
        localStorage.setItem('bcx_nav_min', '1');
      } else {
        localStorage.removeItem('mc_nav_min');
        localStorage.removeItem('bcx_nav_min');
      }
      tuck.navPref = null;
      saveTuck();
    }
  }

  function tuckNav(want) {
    var h = window.mcHost || window.bcxHost;
    if (h && typeof h.setNavMinimized === 'function') {
      try { h.setNavMinimized(want); return; } catch (e) {}
    }
    // 读不到那一头就走同一档类名，只补那颗键的文字（content.js 没 load 上时不至于整趟失灵）
    document.documentElement.classList.toggle('mc-nav-min', want);
    document.documentElement.classList.toggle('bcx-nav-min', want);
    localStorage.setItem('mc_nav_min', want ? '1' : '0');
    localStorage.setItem('bcx_nav_min', want ? '1' : '0');
    var nav = window.mcNav || window.bcxNav;
    if (nav && nav.syncToggleLabel) {
      try { nav.syncToggleLabel(); } catch (e) {}
    }
  }

  /* ---- 右侧 To Do 那一列：屏幕边上一颗键，按一下滑出来 ---- */

  /* 那一列归不归我们折：只在面板贴着边开着的那一档。面板一关这一列就回到原位、那颗键也撤掉，
     他退出面板看到的还是原来那个页面，不是"左边多了一列、右边还藏着一列"。
     答题那一屏和日历页本来就不挂我们自己的面板（content.js 那一头按同一条地址判据跳过），
     那两处的原生右侧列有它自己要紧的东西（提交详情、分数），不去碰它 */
  function railTabAllowed() {
    if (!L.todoTab || !isTop()) return false;
    if (!S.open || L.mode !== 'docked') return false;
    // 答题那一屏（/quizzes/<号>，含 take 那两种写法）右边那一列放着提交详情和分数，不折它
    if (/\/quizzes\/[^\/]+(\/|$)/i.test(window.location.pathname) || !!document.getElementById('submit_quiz_form')) return false;
    var rs = document.getElementById('right-side');
    if (!rs) return false;
    // 右侧栏若没有任何有效子内容（空栏或无实际内容），不摆缩放按钮
    if (!rs.children || rs.children.length === 0) return false;
    /* 站点自己没把这一列摆出来的那些页（modules 那一类整页铺满，右侧本来就没有东西）不折：
       平时那一格里什么都不显示，摆一颗键过去就是开一个凭空多出来的抽屉。
       判据只看量到的 display／visibility，我们自己不再强行把它顶出来 */
    var wr = document.getElementById('right-side-wrapper') || rs;
    var cs = getComputedStyle(wr);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }

  function applyRailTab() {
    var html = document.documentElement;
    var want = railTabAllowed();
    html.classList.toggle('mcx-rail-tab-mode', want);
    if (!want) {
      html.classList.remove('mcx-rail-open');
      html.classList.remove('mcx-rail-pad-clear');
      // 档一关就把量到的那两条撤掉：换到另一页重新开这一档时要重新量一次那个起点
      html.style.removeProperty('--mcx-rail-top');
      html.style.removeProperty('--mcx-rail-max');
      railOpen = false;
      return;
    }
    var wr = document.getElementById('right-side-wrapper');
    if (wr) anchorRail(wr, html);
    ensureRailTab();
    html.classList.toggle('mcx-rail-open', railOpen);
    if (railTab) railTab.setAttribute('aria-expanded', railOpen ? 'true' : 'false');
    syncRailPad();
  }

  /* 抽屉右边那 40px 走道护的是那颗键：它和键都钉在同一个 right 上，所以只要两者在同一竖条里
     撞面，卡片右缘那颗勾就会被键压住。但键的高度中间对齐的是 AI 面板那条抬头线（paintGeom 量的），
     抽屉的顶是那一列当年在页面流里的位置（anchorRail 量的），两个数没有约束关系。
     [实测 2026-10-10 他这一屏] 键底 95px、抽屉顶 150px，键整个停在抽屉上方，
     那 40px 从头到尾是空的，卡片却照让——所以撞不上就让 16px，撞上了才让 56px */
  function syncRailPad() {
    var html = document.documentElement;
    var clear = true;
    var wr = document.getElementById('right-side-wrapper');
    var a = railTab && railTab.getBoundingClientRect();
    var b = wr && wr.getBoundingClientRect();
    if (a && b) clear = !(a.bottom > b.top && a.top < b.bottom);
    html.classList.toggle('mcx-rail-pad-clear', !!clear);
  }

  /* 折起来以后那一列是钉在屏幕边的浮层，它该从哪一行开始必须由它自己原来站的位置说了算：
     照 CSS 猜一个 top 就会盖住 Dashboard 顶上那一行（那颗搜索和 ⋮），或者从半空开始。
     所以趁它还在页面流里的时候量一次，之后一直用那一个数。
     量不到（Canvas 把这一列行内藏掉的那些档）就退到屏幕顶上那两条带子下面，宁可不贴边也不压着控件 */
  function anchorRail(wr, html) {
    if (html.style.getPropertyValue('--mcx-rail-top')) return;
    var r = wr.getBoundingClientRect();
    var top = r.top > 40 && r.height > 40 ? Math.round(r.top) : 150;
    html.style.setProperty('--mcx-rail-top', top + 'px');
    /* 一屏到底，底下不留那 20px：这一栏的圆角已经改成只留上面那颗，底边要贴住屏幕边 */
    html.style.setProperty('--mcx-rail-max', Math.max(240, (window.innerHeight || 800) - top) + 'px');
  }

  function ensureRailTab() {
    if (railTab && document.body.contains(railTab)) return railTab;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mcx-rail-tab';
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', 'To Do list');
    /* 一颗键只说一件事：它管展开／收起，所以只留那颗跟着翻方向的箭头。
       抽屉抬头自己写着 Hub，不必再由第二颗图标报"这里面是作业"。
       读屏器那颗名字留着（aria-label: To Do list），撤掉的只是画面上那三横 */
    b.innerHTML = '<span class="mcx-rail-chev is-closed">' + svg(ICONS.chevL) + '</span>'
      + '<span class="mcx-rail-chev is-open">' + svg(ICONS.chevR) + '</span>';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      railOpen = !railOpen;
      applyRailTab();
    });
    document.body.appendChild(b);
    railTab = b;
    return b;
  }

  function isWide() {
    return L.w >= WIDE_AT;
  }

  /* 左边那一列现在归谁画：宽＋开着，两个都在才算。
     判据只有 L.w 那一份，这里不再存第二个"宽不宽" */
  function railShown() {
    return !!root && root.classList.contains('is-wide') && root.classList.contains('rail-on');
  }

  function setRailOn(want) {
    S.railOn = !!want;
    if (root) root.classList.toggle('rail-on', S.railOn);
    drawRail();
    var hbtn = root ? root.querySelector('.mcx-study-historybtn') : null;
    if (hbtn) hbtn.classList.toggle('is-on', isWide() ? S.railOn : S.pane === 'history');
  }

  /* ---- 一趟把上面这些全算完 ---- */

  function applyLayout() {
    readLayout();
    if (!root) {
      document.documentElement.style.setProperty('--mcx-rail-shift', '0px');
      applyRailTab();
      return;
    }
    // 宽的那一档左边那一列本来就一直在，"历史"那一屏就没有存在的必要了：
    // 从窄拖到宽时把它落回原来那一屏，不然屏幕上会同时有两份会话名单
    if (isWide() && S.pane === 'history') S.pane = historyBackPane();
    root.classList.toggle('is-float', L.mode === 'floating');
    root.classList.toggle('is-left', L.mode !== 'floating' && L.side === 'left');
    root.classList.toggle('is-push', L.mode !== 'floating' && L.push);
    root.classList.toggle('is-wide', isWide());
    root.classList.toggle('rail-on', S.railOn);
    paintDockBtns();
    applyRailTab();
    /* 先让位，再算这一屏摆哪儿：--bc-nav-w 那一档是翻瞬间就换值的（动画走的宽），
       排在让位前面的话这里量到的是让位之前的侧栏宽，靠左那一档会先摆歪 126px 再跳回来 */
    /* 让位只在"贴着边开着"那一档，悬浮窗一律不动页面的那几列（他 2026-10-10 拍的）：
       悬浮窗盖在页面上，不占边，没有"要让出来"这回事。判据里带上 docked 还有两份账对得上：
       ① 设置里那两行本来就写着 "while docked"，档位翻到悬浮时那两行不该还在生效；
       ② 让位是借，借据（tuck／sessionStorage）只在我们真收过的时候才有东西可还，
          悬浮窗这一档不借＝刷新以后侧栏照他自己那一档摆，不会停在"被面板收着"的那一格。
       代价要说清楚：docked→悬浮 这一趟会把那几列当场还回去，正文宽度动 320 毫秒，
       卡片墙那十张带 blur(24px) 的会跟着重新取样一次＝那一瞬会顿。上一版为了躲这一顿
       把让位拖到关面板才还，代价是悬浮窗一直压着他平时展开的侧栏，他不要那个。 */
    /* 收课程那一列只在贴右那一档：那一头收它是为了把正文挤宽。
       贴左这一档整页连着标题行一起右移，课程那一列落在面板右边，本来就不挡事，
       再收它就成了"面板一贴左，那一列从此看不见"（他 2026-10-10 报的那条） */
    foldCourseNav(S.open && L.mode === 'docked' && L.side === 'right');
    tuckSideNav(S.open && L.mode === 'docked');
    paintGeom();
    syncPush(false);
    clearTimeout(settleTimer);
    // 课程那一列落定以后真实位置会挪，所以补一趟推挤；左边缘不参与这一趟（它一次算准就不改口）
    // 这一趟必须排在 400ms 那一段位移之后：360 毫秒量到的是动画中途的边（navUsed 那条老毛病，
    // 见上面 611 行的注释），补的这一趟本来是对账，量早了就成了第二次推
    settleTimer = setTimeout(function () {
      /* 拖到一半不许补这一趟：搬位置那一趟落点写在位移上，left/top 还是上一站的数，
         这一趟去写就会把"left ＋ 位移"叠成两倍，窗口当场跳出鼠标。松手那一趟会把它补上 */
      if (dragging) return;
      paintGeom();
      syncPush(true);
    }, ANIM + 120);
  }

  /* 只有这三个数会随拖动手柄变：宽度、悬浮窗的位置和高度。
     推挤那一段是宽度的函数，所以这一趟不重算档位，只把眼前三样写下去 */
  /* 落位对齐到整数设备像素。Windows 上 125% / 150% 缩放时一个 CSS px 不等于一个物理像素，
     半像素原点会让 Chrome 按自己的网格重排文字，鼠标一划字就上下跳半行高的一小截 */
  function snapPx(v) {
    var d = window.devicePixelRatio || 1;
    return Math.round(v * d) / d;
  }

  /* 值没变就一个字都别写。往 html 那一层写自定义属性是让整棵树重算一遍样式，
     拖到一半每帧写一次没用的＝他报的卡顿 */
  function setVar(el, name, value) {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  }

  function setCss(el, name, value) {
    if (el.style[name] !== value) el.style[name] = value;
  }

  /* 面板左边缘在哪一处。停靠那一档这个数是构造出来的，不用量：
     刚写完样式马上去量一次，浏览器就得当场把整棵子树重排一遍（写→读＝强制同步布局），
     每一帧来一次就是卡顿的正身。留 2 像素是因为这台按 150% 缩放，整数化以后本来就有零点几的差 */
  function panelLeft() {
    if (L.mode === 'floating') return L.x;
    if (L.side === 'left') return navUsed();
    return (window.innerWidth || 1280) - L.w;
  }

  /* light＝拖到一半那一趟：只把该写的数写下去，凡是"量出来的"一律留到松手那一趟。
     那颗收纳键横向要让的宽度是面板宽的函数，所以它跟着这一趟走；纵向那一个数不随拖动变，跳过 */
  function paintGeom(light) {
    if (root) {
      setVar(root, '--mcx-study-w', snapPx(L.w) + 'px');
      /* 靠左那一档的左边缘只认这一个数：这一页没有应用侧栏时（no-headers 那几档）
         它算 0，CSS 里那条 :root 的 200px 就不能再拿来定位置，否则抽屉停在空气上，
         而推挤那一段又是按另一份读数算的，两边会错开 */
      setVar(root, '--mcx-nav-w', snapPx(navUsed()) + 'px');
      var p = panelEl();
      if (p) {
        if (L.mode === 'floating') {
          setCss(p, 'left', snapPx(L.x) + 'px');
          setCss(p, 'top', snapPx(L.y) + 'px');
          setCss(p, 'height', snapPx(L.h) + 'px');
          setCss(p, 'right', 'auto');
          setCss(p, 'bottom', 'auto');
        } else {
          /* 从悬浮窗切回贴边时必须把行内那四个数收掉：留着的话抽屉赖在他摆过的
             那个落点上不走，CSS 那一条 top/right/bottom 被行内压着，看着就是"贴边了却没贴边" */
          setCss(p, 'left', ''); setCss(p, 'top', ''); setCss(p, 'height', '');
          setCss(p, 'right', ''); setCss(p, 'bottom', '');
        }
      }
    }
    /* 那颗键要让的只有"面板真占着右边那一段"的时候。面板一关那一段就没了，
       键得回到屏幕边上，不然它会停在半屏宽的地方指着空气 */
    var shift = S.open && L.mode === 'docked' && L.side === 'right' ? L.w : 0;
    setVar(document.documentElement, '--mcx-rail-shift', snapPx(shift) + 'px');
    if (light) return;
    /* 那颗收纳键的高度中间要对齐面板"抬头和内容区之间那条线"。那条线多高只有面板自己知道
       （抬头两行、换屏还会变），所以量它：键 40px 高，线在中间＝键顶＝线 - 20。
       面板还没开过时不写，留着 CSS 那颗 44px 的退路，别拿 0 去顶它 */
    var head = root && root.querySelector('.mcx-study-head');
    if (head) {
      var hr = head.getBoundingClientRect();
      if (hr.height > 8) setVar(document.documentElement, '--mcx-rail-tab-top', snapPx(Math.max(8, hr.bottom - 20)) + 'px');
    }
    // 键的落点刚被上面这两个数挪过，走道让不让得跟着重量一次
    if (document.documentElement.classList.contains('mcx-rail-tab-mode')) syncRailPad();
    /* 面板的左边缘有没有顶到应用侧栏那条右边缘：顶上了，栏右边那两颗角要摊平，
       不然接缝两头各留一个缺口露出底下的页面。靠左那一档一定是（panelLeft 就是栏宽，差 0），
       贴右那一档只有宽到铺满栏右边那一段时才是 */
    document.documentElement.classList.toggle('mcx-study-flush-nav',
      !!(root && S.open) && Math.abs(panelLeft() - navUsed()) <= 2);
  }

  function saveGeom() {
    localStorage.setItem('mc_ai_panel_w', String(L.w));
    if (L.mode === 'floating') {
      localStorage.setItem('mc_ai_float_geo', JSON.stringify({ x: L.x, y: L.y, h: L.h }));
    }
  }

  /* 抬头那两颗快捷键：一颗管左边、一颗管右边，按下去就是它说的那一档。
     图形和那句话都只写"按下去会变成什么"：现在贴在右边，右边那颗就画浮窗、说浮窗，
     左边那颗照旧画贴左、说贴左；悬浮窗那一档两颗都画自己那一条边。
     两颗都不带亮底：面板贴在哪个边上屏幕上看得见，键只说下一站，不报现在这一站。
     和设置里那两行读的是同一格存档，不另起一份状态 */
  function paintDockBtns() {
    if (!root) return;
    var btns = root.querySelectorAll('.mcx-study-dockbtn');
    for (var i = 0; i < btns.length; i++) {
      var side = btns[i].getAttribute('data-dock');
      var here = L.mode === 'docked' && L.side === side;
      btns[i].innerHTML = svg(here ? ICONS.floatWin : (side === 'left' ? ICONS.sideL : ICONS.sideR));
      var txt = here ? 'Turn it into a floating window'
        : 'Stick it to the ' + (side === 'left' ? 'left' : 'right') + ' edge';
      btns[i].setAttribute('aria-label', txt);
      btns[i].title = txt;
    }
  }

  function dockTo(side) {
    var here = L.mode === 'docked' && L.side === side;
    localStorage.setItem('bc_ai_panel_side', side);
    localStorage.setItem('bc_ai_panel_mode', here ? 'floating' : 'docked');
    applyLayout();
    draw();
  }

  /* 拖动全在这一趟里：抬到 body 之后事件要挂在 window 上才跟得住（那边设置里排序行同一套），
     手柄自己 capture 才不会被页面里的 iframe 把移动吃掉 */
  function startDrag(e, kind) {
    if (dragging || !root) return;
    dragging = true;
    var handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    root.classList.add('is-dragging');
    if (kind === 'move') root.querySelector('.mcx-study-head').classList.add('is-live');
    else handle.classList.add('is-live');
    var wasWide = isWide();
    var sx = e.clientX, sy = e.clientY;
    var w0 = L.w, x0 = L.x, y0 = L.y, h0 = L.h;
    var panel = panelEl();
    /* 拖的这一趟侧栏宽不会自己动（收放那颗键的观察器这一趟是让路的），先把它钉住：
       不然每一趟 paintGeom 都要 getComputedStyle(html) 读一次，而读之前刚写过样式＝当场重算整棵树 */
    frozenNavW = navUsed();
    var pending = null, frame = 0;

    function pump() {
      frame = 0;
      var ev = pending;
      pending = null;
      if (!ev) return;
      var vw = window.innerWidth || 1280;
      var vh = window.innerHeight || 800;
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (kind === 'move') {
        L.x = clamp(x0 + dx, 8 - (w0 - 140), Math.max(8, vw - 140));
        L.y = clamp(y0 + dy, 0, Math.max(0, vh - 60));
        /* 搬整个窗口只写位移：left/top 每帧改一次就是每帧把整棵面板子树重排一遍
           （靠左那一档早就换成位移了，悬浮窗这一档漏在这一条上）。松手那一趟才落回 left/top。
           位移也按整数物理像素走，不然缩放那一档下半像素的原点会让字发虚 */
        if (panel) panel.style.transform = 'translate3d('
          + snapPx(L.x - x0) + 'px,' + snapPx(L.y - y0) + 'px,0)';
        return;
      }
      if (kind === 'e') {
        L.w = clamp(w0 + dx, MIN_W, maxW());
      } else if (kind === 'w') {
        /* 朝里那一条边：往屏幕外那一头拖才是变宽。
           悬浮窗还要连着把左边缘一起带过去，右边缘那一条不动（那才是"拖着左边在改大小"） */
        var nw = clamp(w0 - dx, MIN_W, maxW());
        if (L.mode === 'floating') L.x = x0 + (w0 - nw);
        L.w = nw;
      } else if (kind === 's') {
        L.h = clamp(h0 + dy, MIN_H, Math.max(MIN_H, vh - 24));
      } else if (kind === 'se' || kind === 'sw') {
        /* 下角：宽和高一起走。左半边那一颗还要把左边缘带着走，
           右边缘那一条钉在原地不动（那才是"捏住右下角放大"的手感） */
        if (kind === 'sw') {
          var nw2 = clamp(w0 - dx, MIN_W, maxW());
          L.x = x0 + (w0 - nw2);
          L.w = nw2;
        } else {
          L.w = clamp(w0 + dx, MIN_W, maxW());
        }
        L.h = clamp(h0 + dy, MIN_H, Math.max(MIN_H, vh - 24));
      }
      root.classList.toggle('is-wide', isWide());
      paintGeom(true);
      syncPush(true);
    }

    function move(ev) {
      pending = ev;
      if (!frame) frame = requestAnimationFrame(pump);
    }

    function done() {
      dragging = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      /* 松手这一趟把拖时跳过的那几样量回来（栏角摊不摊平、那颗键的走道），
         再把位移换回 left/top。这两件事必须在 is-dragging 还挂着（transition:none）的时候提交：
         不然 transform 从位移回到 none 会被那条 400ms 过渡接住＝松手以后窗口自己滑回原地 */
      paintGeom();
      if (kind === 'move' && panel) {
        panel.style.transform = '';
        void panel.offsetWidth;
      }
      if (S.open) frozenNavW = -1;
      root.classList.remove('is-dragging');
      var head = root.querySelector('.mcx-study-head');
      if (head) head.classList.remove('is-live');
      handle.classList.remove('is-live');
      saveGeom();
      // 搬位置没动过宽，左边那一列没什么要重画的；拖过宽的那一档才算跨过 760
      if (kind === 'move' || !S.open) return;
      if ((L.w >= WIDE_AT) !== wasWide) draw();
      else drawRail();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
    e.preventDefault();
  }

  function bindGeom() {
    var head = root.querySelector('.mcx-study-head');
    if (head) {
      head.addEventListener('pointerdown', function (e) {
        if (L.mode !== 'floating' || e.button !== 0) return;
        if (e.target.closest && e.target.closest('button, input, textarea, select, [data-close]')) return;
        startDrag(e, 'move');
      });
    }
    var grips = root.querySelectorAll('.mcx-study-resize');
    for (var i = 0; i < grips.length; i++) {
      grips[i].addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var edge = this.getAttribute('data-edge');
        if (L.mode !== 'floating') {
          /* 停靠那一档只有朝里那一条边能拖宽：朝屏幕外那条拖的是抽屉的墙，
             下边和两个角都不参与（它没有高可调，是整屏高） */
          if (edge === 's' || edge === 'se' || edge === 'sw') return;
          if ((L.side === 'right' && edge === 'e') || (L.side === 'left' && edge === 'w')) return;
        }
        startDrag(e, edge);
      });
    }
  }

  /* 页面是单页应用：右侧那一列是后来才出现的，地址也会在不重新载入的情况下换。
     变动合成一趟 300ms，只重算那颗键该不该在；档位本身不在这儿读，免得两份状态 */
  function bootChrome() {
    if (!isTop()) return;
    readLayout();
    restoreLeftoverTuck();
    /* 会话库提前读回来。以前它是第一次点开面板时才发起，于是第一次点开那 400ms 里
       左边那一列只有"正在读"，名单要等动画跑完才填上——他报的就是这个。
       页面一load 就读，等他点到侧栏那一行时数据已经在内存里 */
    try {
      var h0 = window.MCxHistory && window.MCxHistory.hydrate ? window.MCxHistory.hydrate() : null;
      if (h0 && h0.then) h0.then(function () { if (S.open) drawRail(); }, function () {});
    } catch (e) {}
    applyRailTab();
    // 面板一次都没开过时，Escape 也要收得了滑出来的那一列（开过以后那条走 shell 里的顺序）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && railOpen && !S.open) {
        railOpen = false;
        applyRailTab();
      }
    });
    window.addEventListener('resize', function () {
      if (dragging) return;
      readLayout();
      paintGeom();
      syncPush(true);
    });
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function () {
      clearTimeout(chromeTimer);
      chromeTimer = setTimeout(function () {
        /* 这一趟只认"页面上多了还是少了那一列"，不回读档位和宽度：
           回读会把正在拖的那一段宽按存储里的旧数盖回去（拖到一半存储还没落），
           设置里翻的每一颗键另有 MCxStudy.layout() 那一头叫账，不用在这儿赌 */
        if (dragging) return;
        // 面板没开着的时候才要还账（开着的时候那份收起是我们现在正持有的，不是上一趟留下的）
        if (!S.open) restoreLeftoverTuck();
        applyRailTab();
        /* 面板开着的时候他随时可能自己展开或收起应用侧栏：那一段宽一变，
           靠左那一档的左边缘和推挤那一段都要跟着重算，不然抽屉就压在展开出来的那一列上 */
        if (S.open) {
          paintGeom();
          syncPush(true);
        }
      }, OBS_EVERY);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    /* 侧栏收放只改 html 的类名（节点一个都不增减），上面那个只看 childList 的观察器看不见它，
       于是面板停在旧的位移上＝左边多出一段对不上的空带，要等下一次别的 DOM 变动才跟上来。
       这里只看类名，而且是边沿检测：值没变就直接返回，不会被自己写的 mcx-push-on 再绕回来 */
    var lastNavMin = (document.documentElement.classList.contains('mc-nav-min') || document.documentElement.classList.contains('bcx-nav-min')) ? 1 : 0;
    var navMo = new MutationObserver(function () {
      var now = (document.documentElement.classList.contains('mc-nav-min') || document.documentElement.classList.contains('bcx-nav-min')) ? 1 : 0;
      if (now === lastNavMin) return;
      lastNavMin = now;
      if (dragging) return;
      paintGeom();
      if (S.open) syncPush(true);
    });
    navMo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  bootChrome();

  /* ==== 取数 ==== */

  function loadCourses() {
    if (!window.MCxData) return;
    S.loading = S.loading || 'courses';
    var gen = ++S.loadGen;
    window.MCxData.courses().then(function (list) {
      if (gen !== S.loadGen) return;
      S.courses = list;
      if (!S.courseId) {
        var here = window.MCxData.currentCourseId();
        S.courseId = here || (list[0] && list[0].id) || 0;
      }
      S.readDone = true;
      var named = list.filter(function (c) { return c.id === S.courseId; })[0];
      S.courseName = named ? named.name : '';
      // 地址里那门课不在"在读课程"那一份名单里（已结束的课最常见）：
      // 这一门课什么都读不到，得说清楚，不能让它看起来像面板坏了
      S.courseKnown = !!named || !S.courseId;
      if (S.courseId) {
        // 加载态归 loadTasks 那一头管。这里再写一次 S.loading='' 并 draw，
        // 就会在任务回包到达前把那一屏画成"这个范围里没有东西"
        loadTasks();
        return;
      }
      S.loading = '';
      draw();
    }, function (err) {
      if (gen !== S.loadGen) return;
      S.loading = '';
      S.notice = 'Could not load courses. ' + String((err && err.message) || err);
      draw();
    });
  }

  function loadTasks() {
    if (!S.courseId) return;
    var cid = S.courseId;
    var gen = ++S.loadGen;
    S.loading = 'tasks';
    S.loadNote = 'Reading the tasks of this course...';
    draw();
    window.MCxData.tasks(cid, function (n, total) {
      if (stale(gen, cid)) return;
      S.loadNote = total ? 'Reading tasks, ' + n + ' of ' + total
        : 'Reading tasks, ' + n + ' so far';
      paintLoadNote();
    }).then(function (rows) {
      if (stale(gen, cid)) return;
      S.tasks = rows;
      S.loading = '';
      S.loadNote = '';
      /* 邮件那一屏认出的那条任务在这里盖上去：名单是刚读回来的，此刻才有真 id 可对。
         对不上就不勾，宁可让他自己点，也不能凭一个匹配不上的号勾上别的东西 */
      if (S.pendingPick) {
        var pid = S.pendingPick;
        S.pendingPick = 0;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].id === pid) { S.pickedTasks[pid] = true; break; }
        }
      }
      draw();
    }, function (err) {
      if (stale(gen, cid)) return;
      S.pendingPick = 0;
      S.loading = '';
      S.loadNote = '';
      S.notice = 'Could not load assignments for this course. ' + String((err && err.message) || err);
      draw();
    });
  }

  function loadResources() {
    var cid = S.courseId;
    var gen = ++S.loadGen;
    S.loading = 'resources';
    S.loadNote = 'Reading the modules of this course...';
    draw();
    window.MCxData.resources(cid, function (n, total) {
      if (stale(gen, cid)) return;
      S.loadNote = total ? 'Reading modules, ' + n + ' of ' + total
        : 'Reading modules, ' + n + ' so far';
      paintLoadNote();
    }).then(function (list) {
      if (stale(gen, cid)) return;
      S.resources = list;
      S.loading = '';
      S.loadNote = '';
      // 每条多大要逐条问一次（文件问 size，正文问长度），因为选好之后那一屏要报的是实数。
      // 这一趟在画面上看得见进度，人才不会以为它停了
      S.sizeNote = list.length ? 'Reading sizes, 0 of ' + list.length + ' so far' : '';
      draw();
      var done = 0;
      return window.MCxData.details(list, function () {
        if (stale(gen, cid)) return;
        done++;
        S.sizeNote = 'Reading sizes, ' + done + ' of ' + list.length + ' so far';
        var count = footEl().querySelector('.mcx-study-count');
        if (count) count.textContent = S.sizeNote;
      }).then(function (stats) {
        if (stale(gen, cid)) return;
        // 就地盖，不许整份换掉：那一份里还存着 quiz_<id> 那几颗考纲说明，
        // 换掉之后报数和发给模型的考纲都少一段，而屏幕上一点看不出来
        list.forEach(function (r, i) { S.stats[r.id] = stats[i] || {}; });
        S.sizeNote = '';
        draw();
      });
    }, function (err) {
      if (stale(gen, cid)) return;
      S.loading = '';
      S.loadNote = '';
      S.sizeNote = '';
      S.notice = 'Could not load course materials. ' + String((err && err.message) || err);
      draw();
    });
  }

  /* 换课或重开之后，先前那一趟晚到的回包一律不许再写画面：
     不然旧课那份慢一点落地，就把已经显示的列表换回去（标题还写着新课） */
  function stale(gen, cid) {
    return gen !== S.loadGen || cid !== S.courseId;
  }

  function resetForCourseSwitch() {
    S.loadGen++;
    cancelRun();
    // 写信那一屏在换课的时候同理：旧课那一稿不许写进新课的格子
    S.mtGen++;
    S.mtShowAll = false;
    stopTeacherStream();
    S.pickedTasks = {};
    S.pickedRes = {};
    S.stats = {};
    S.resources = [];
    S.tasks = [];
    S.readTexts = {};
    S.filters = {};
    S.notice = '';
    S.result = '';
    S.courseKnown = true;
    S.turns = [];
    // 每一场对话自己那一串加法，和写信那一稿的：换课就是换一场，旧课的数不许跟在新一屏底下
    S.calls = [];
    S.mtCalls = [];
    S.baseMessages = null;
    S.sources = {};
    S.ctx = null;
    S.coverage = null;
    S.openCov = {};
    S.retrievalNote = '';
    S.pickReason = {};
    S.askText = '';
    S.session = null;
    S.fromHistory = false;
    S.backPane = 'ask';
    S.historyBack = 'tasks';
    // 那一趟的回包被代次挡掉时没人再把这颗翻回来，换课必须自己清
    S.picking = false;
    /* 锁住的那一条作业是从地址上来的，换一门课它就不属于这门课了：
       不换回整门课那一屏挑法，屏幕上就会挂着另一门课的一条作业 */
    S.mtLockTaskId = 0;
    S.mtLockTaskName = '';
    S.mtSubGen++;
    S.mtSub = null;
    S.mtSubNote = '';
  }

  /* ==== 选中的东西 ==== */

  function pickedTaskList() {
    return S.tasks.filter(function (t) { return S.pickedTasks[t.id]; });
  }

  function visibleResources() {
    var on = FILTERS.filter(function (f) { return S.filters[f.k]; });
    if (!on.length) return S.resources;
    return S.resources.filter(function (r) {
      return on.some(function (f) { return f.hit(r); });
    });
  }

  function kindLabel(r) {
    if (r.kind === 'file') return SLIDE_EXT[extOfStat(r)] ? 'Slides' : 'Files';
    return KIND_LABEL[r.kind] || r.kind;
  }

  function pickedResources() {
    return S.resources.filter(function (r) { return S.pickedRes[r.id] && r.readable; });
  }

  /* ==== 用哪份 key、哪个模型、要不要传图 ====
     三样都放在发送前这一屏。传图原先在设置里，那是摆错地方：它问的是"这一趟要不要带上图"，
     不是"这个扩展要不要开这个功能" */

  /* 那几格住在扩展自己的存储里，要到 document_idle 发起读数才回得来。
     没读回来之前这一屏一律不许说"没有 key"：那一句会让人把已经填好的钥匙再填一遍。
     读回来了就自己重画一次，他不该看见"正在读"停在那儿不动 */
  var aiWaitHook = false;

  function aiSettingsLoading() {
    var a = window.MCxAi;
    if (!a) return false;
    if (a.settingsLoaded && a.settingsLoaded()) return false;
    if (!a.load) return false;
    if (!aiWaitHook) {
      aiWaitHook = true;
      a.load().then(function () {
        if (S.open) draw();
      }, function () {
        if (S.open) draw();
      });
    }
    return true;
  }

  /* 没配钥匙、或那一格还没读回来时，发送前一屏不许摆出一个像"$0"那样的数。
     这里不是有价目表，是根本没有可报的东西：报 0 就是编出来的 */
  function aiKeyState() {
    var a = window.MCxAi;
    if (!a) return 'none';
    if (aiSettingsLoading()) return 'loading';
    var cfg = a.config(S.account);
    return a.canUseSlot(cfg) ? 'ready' : 'none';
  }

  /* 两档：Advanced 和 Flash，每一档自己一套地址＋钥匙＋模型。
     所以这一屏只挑档，不再单独挑模型——档名本身就代表那一个模型，
     两处都能选会撞出"选了 Flash 又手改模型"这种两不认的状态 */
  function accounts() {
    return window.MCxAi.profiles().filter(function (p) { return p.filled; });
  }

  function accountOf(id) {
    return accounts().filter(function (a) { return a.id === id; })[0] || null;
  }

  /* 这一屏默认落在 Flash：这一屏以外的那些自动调用（收件箱摘要、回信草稿）走的也是它。
     两处同一颗默认，才不会出现设置里说省的那一档、面板一开却选了贵的那一档 */
  function ensureAccount() {
    var list = accounts();
    if (!list.length) { S.account = ''; S.model = ''; return; }
    var hit = list.filter(function (a) { return a.id === S.account; })[0];
    if (!hit) hit = list.filter(function (a) { return a.id === 'flash'; })[0] || list[0];
    S.account = hit.id;
    S.model = hit.model || '';
  }

  /* 报数：已选条目的字数加文件大小。文件的字节按 3 字符折一档，
     那是给量级用的，不是模型自己的计数 */
  function estimate() {
    var chars = 0;
    var bytes = 0;
    pickedResources().forEach(function (r) {
      var st = S.stats[r.id] || {};
      if (st.bytes) bytes += st.bytes;
      else if (st.chars) chars += st.chars;
    });
    pickedTaskList().forEach(function (t) {
      chars += window.MCxData.htmlToText(t.description || '').length;
    });
    var scopeChars = 0;
    pickedTaskList().forEach(function (t) {
      var st = t.quizId ? (S.stats['quiz_' + t.quizId] || {}) : {};
      scopeChars += st.chars || 0;
    });
    var fromBytes = Math.round(bytes / 3);
    var total = chars + fromBytes + scopeChars;
    return { chars: total, tokens: window.MCxData.estimateTokens(total), files: bytes };
  }

  /* 追问的价钱在发送前就说清楚：这一次发出去的那份材料，往后每一问都跟着再走一次，
     所以一句追问照普通请求的输入那一头收。数是从上面那个实测数推出来的，不是另量一套。
     图不带第二次（followUp 那一趟没有 images 那一项），这句也照实说 */
  function followCostPreview() {
    var est = estimate();
    return 'Each one goes out with this same material again, so a question costs close to the '
      + fmtNum(est.tokens) + ' tokens above, plus what it writes back. Pictures are not sent again.';
  }

  /* ==== 发出去的那份文字 ==== */

  function materialsBlock() {
    var parts = [];
    // 考纲那一份也算进总上限。它之前不过这套记账，多选任务时"单次上限"那句话只管材料，
    // 实发能比屏幕上报的多出好几万字符
    var used = scopeBlock().length;
    var stopped = false;
    var list = pickedResources();
    /* 引用号在这里发，不发在模型那一头：它写 [R7] 对的就是这一份清单，
       而这一份清单我们手里有真标题和真地址，结果屏底下那张出处表照着它画 */
    var sources = {};

    function push(tag, label, text) {
      if (!text) return;
      if (used >= TOTAL_CAP) { stopped = true; return; }
      // 只能给 slice 两个参数：第三个是多余的，写了也不生效，
      // 那样单条上限会盖过总量上限，整份材料能一路超出到 TOTAL_CAP 之外
      var room = Math.min(ITEM_CAP, TOTAL_CAP - used);
      var body = String(text).slice(0, room);
      used += body.length;
      parts.push('=== [' + tag + '] ' + label + ' ===\n' + body);
    }

    for (var i = 0; i < list.length; i++) {
      if (stopped) break;
      var r = list[i];
      // 正文要现场取，所以这一趟在 run() 里先读齐才进来
      var got = S.readTexts && S.readTexts[r.id];
      if (!got) continue;
      var tag = 'R' + (i + 1);
      sources[tag] = {
        title: got.name || r.title, module: r.module || '', kind: r.kind,
        url: r.url || '', chars: String(got.text || '').length
      };
      push(tag, (r.module || 'Course page') + ' / ' + (got.name || r.title) + ' [' + r.kind + ']', got.text);
    }
    S.sources = sources;
    return { text: parts.join('\n\n'), truncated: stopped, used: used };
  }

  // 给模型看的那张对照表。没有它就只能靠模型自己数第几条，一错整批出处就废了
  function sourcesLegend() {
    var keys = Object.keys(S.sources);
    if (!keys.length) return '';
    return keys.map(function (k) {
      var s = S.sources[k];
      var line = k + ' = ' + s.title + ' (' + (s.module || 'no section') + ', ' + s.kind + ')';
      // 切成片送的那一份要把片号一并报出去，否则它压根不知道自己手上的 [R3-C2] 是从哪儿来的
      if (s.parts && s.parts.length) {
        line += ' — parts: ' + s.parts.map(function (p) {
          return p.tag + ' (' + p.chars + ' chars)';
        }).join(', ');
      }
      return line;
    }).join('\n');
  }

  /* ==== 按考点压上下文这一条通路 ====
     旧那一条是按资料顺序拼到 TOTAL_CAP 就砍，勾得多时排在后面的整份进不去。
     这里改成：正文切块 → 每块对着考点打分 → 在预算里先保证考点有人撑、再保证每份资料有一次机会、
     最后按相关性补满。挑出来的每一块都带着自己的号（[R3-C2]），出处表还是照我们自己的数据画。

     三件事必须成立：
     - 只碰学生勾了并且这一趟真读出正文的那些资料，一个未选的字都不进这里。
     - 出错就退回旧通路，并把"退回了"这句话报在屏上，绝不因为检索把总结拖死。
     - 考点没材料撑着就写 uncovered，不许由模型补成确定事实。 */
  var LEGEND_RESERVE = 2400;   // 对照表本身也占地方，给它留一格

  function retrievalOn() {
    return !!window.MCxRetrieval;
  }

  /* 把选中的片段拼成发给模型的那一份，同时把 S.sources / S.coverage / S.ctx 三样填好。
     list 是学生勾选的那一份顺序，ri 就是它在这份里的下标，号数与旧通路一致（R1 起）。 */
  function materialsFromChunks(list, sel) {
    var R = window.MCxRetrieval;
    var used = scopeBlock().length;
    var byRes = {};
    sel.chunks.forEach(function (c) {
      (byRes[c.resourceIndex] || (byRes[c.resourceIndex] = [])).push(c);
    });
    var sources = {};
    var blocks = [];
    var stopped = false;

    Object.keys(byRes).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ri) {
      var r = list[ri];
      var got = r && S.readTexts && S.readTexts[r.id];
      if (!got) return;
      var tag = 'R' + (ri + 1);
      var rows = byRes[ri].slice().sort(function (a, b) { return a.chunk.start - b.chunk.start; });
      var head = '=== [' + tag + '] ' + (r.module || 'Course page') + ' / ' + (got.name || r.title) + ' [' + r.kind + '] ===';
      if (used + head.length >= TOTAL_CAP) { stopped = true; return; }
      used += head.length;
      var body = [head];
      var parts = [];
      rows.forEach(function (c) {
        if (stopped) return;
        var ct = String(c.chunk.text || '');
        var mark = '[' + tag + '-' + c.chunk.tag + ']';
        if (used + ct.length + mark.length + 2 >= TOTAL_CAP) { stopped = true; return; }
        used += ct.length + mark.length + 2;
        body.push(mark + '\n' + ct);
        parts.push({ tag: tag + '-' + c.chunk.tag, chars: ct.length, from: c.chunk.start, to: c.chunk.end });
      });
      if (!parts.length) { used -= head.length; return; }
      sources[tag] = {
        title: got.name || r.title, module: r.module || '', kind: r.kind,
        url: r.url || '', chars: String(got.text || '').length, parts: parts
      };
      blocks.push(body.join('\n\n'));
    });

    /* 覆盖行照着选中的那些块统一列一遍：一格考点可能落在好几份资料上，
       摘录取那一块里最贴着这个考点的 280 字，展开时才显示。 */
    var coverage = (sel.coverage || []).map(function (c) {
      var rows = [];
      (sel.chunks || []).forEach(function (p) {
        var h = (p.hits || {})[c.name] || 0;
        if (!h) return;
        var r = list[p.resourceIndex];
        if (!r || !S.readTexts || !S.readTexts[r.id]) return;
        var picked = rows.filter(function (x) { return x.resourceId === p.resourceId; })[0];
        if (picked && picked.hits >= h) return;
        if (picked) rows.splice(rows.indexOf(picked), 1);
        rows.push({
          resourceId: p.resourceId, title: p.title, module: p.module, kind: p.kind, url: p.url,
          tag: 'R' + (p.resourceIndex + 1) + '-' + p.chunk.tag, hits: h,
          excerpt: R.findEvidence(p.chunk.text, (c.terms || [{ k: c.name }]).map(function (t) { return t.k; }), 280).excerpt
        });
      });
      rows.sort(function (a, b) { return b.hits - a.hits; });
      return { name: c.name, status: c.status, parts: rows.slice(0, 3) };
    });

    var sentItems = Object.keys(sources).length;
    var conceptCount = coverage.length;
    var covered = coverage.filter(function (c) { return c.status === 'covered'; }).length;
    var weak = coverage.filter(function (c) { return c.status === 'weak'; }).length;
    var missing = coverage.filter(function (c) { return c.status === 'none'; });
    S.sources = sources;
    S.coverage = coverage;
    S.ctx = {
      items: list.length, sentItems: sentItems, parts: sel.chunks.length,
      concepts: conceptCount, covered: covered, weak: weak,
      missing: missing.map(function (c) { return c.name; }),
      dropped: sel.omitted && sel.omitted.parts ? sel.omitted.parts : 0,
      droppedItems: Math.max(0, list.length - sentItems),
      chars: used, tokens: window.MCxData.estimateTokens(used),
      budget: sel.budget, chunked: true
    };
    return { text: blocks.join('\n\n'), truncated: stopped, used: used, chunked: true };
  }

  /* 检索那一趟整体是个可失败的外挂：任何一环不对就退回按顺序拼的那条老路，
     并在屏上说清"这一趟是按顺序送的"，不能让他以为压过上下文。 */
  function prepareMaterials(list, dead) {
    S.ctx = null;
    S.coverage = null;
    S.retrievalNote = '';
    var R = window.MCxRetrieval;
    if (!R || !list.length) return Promise.resolve(materialsBlock());
    // 槽位先按勾选那一份排好，读不出正文的那些留空壳：这样 resourceIndex 就是他在名单上看到的那一格
    var slots = list.map(function (r) {
      return {
        resourceId: r.id, title: r.title, module: r.module || '', kind: r.kind, url: r.url || '', chunks: []
      };
    });
    var items = [];
    list.forEach(function (r) {
      var got = S.readTexts && S.readTexts[r.id];
      if (got && got.text) items.push({ resource: r, read: got });
    });
    if (!items.length) return Promise.resolve(materialsBlock());
    var scopeChars = scopeBlock().length;
    var budget = Math.max(0, TOTAL_CAP - scopeChars - LEGEND_RESERVE);
    return R.buildIndexes(items, {
      dead: dead,
      onProgress: function (d, total) {
        if (dead && dead()) return;
        S.readNote = 'Checking these ' + total + ' item' + (total === 1 ? '' : 's') + ' against the exam points... ' + d + ' of ' + total;
        paintProgress();
      }
    }).then(function (built) {
      if (dead && dead()) return materialsBlock();
      built.forEach(function (ix) {
        for (var i = 0; i < slots.length; i++) {
          if (slots[i].resourceId === ix.resourceId) { slots[i] = ix; break; }
        }
      });
      var concepts = R.concepts(scopeBlock());
      var sel = R.selectChunks(slots, concepts, {
        budget: budget,
        taskWords: taskWords(),
        anchorIndex: anchorIndex(list, pickedTaskList()),
        perResourceChars: ITEM_CAP
      });
      if (dead && dead()) return materialsBlock();
      // 一份都没挑中（多半是词全对不上）就别演"按考点压过"，走老路更诚实
      if (!sel.chunks.length) return materialsBlock();
      return materialsFromChunks(list, sel);
    }).catch(function (e) {
      if (window.MCxData && window.MCxData.log) window.MCxData.log('retrieval did not run, sending in list order:', e);
      S.ctx = null;
      S.coverage = null;
      S.retrievalNote = 'Topic-based selection could not run this time, so the material goes in the order it is listed.';
      return materialsBlock();
    });
  }


  var SCOPE_ITEM_CAP = 8000;

  /* 考纲那一段。除了任务名和截止日期，这里还要报"这一项在 Canvas 上是什么形状"：
     是测验、多少分、几道题。模型知道是 20 道选择题的 quiz 和知道是大题计算，写出来的东西不一样 */
  function scopeBlock() {
    var out = [];
    pickedTaskList().forEach(function (t) {
      var shape = [];
      if (t.kind === 'quiz') shape.push('a quiz');
      if (t.points != null && t.points !== '') shape.push(t.points + ' points');
      var q = t.quizId && S.stats['quiz_' + t.quizId] ? S.stats['quiz_' + t.quizId] : null;
      if (q && q.questionCount) shape.push(q.questionCount + ' questions');
      var line = '- ' + t.name
        + (shape.length ? ' (' + shape.join(', ') + ')' : '')
        + (t.dueAt ? ', due ' + fmtDate(t.dueAt) : '')
        + (t.done ? ' [already submitted]' : '');
      var quizText = q && q.text ? q.text : '';
      var desc = quizText || window.MCxData.htmlToText(t.description || '');
      desc = String(desc).slice(0, SCOPE_ITEM_CAP);
      if (desc) line += '\n  What it says on Canvas (the quiz questions themselves are not visible to students):\n  ' + desc.replace(/\n/g, '\n  ');
      out.push(line);
    });
    return out.join('\n');
  }

  /* 选了哪几颗任务，就把那几颗的考纲说明读回来：报数那一屏要算上它，
     发给模型的那一份也要带上它 */
  function loadScopeStats() {
    var need = pickedTaskList().filter(function (t) {
      return t.quizId && !S.stats['quiz_' + t.quizId];
    });
    if (!need.length || !window.MCxData) return;
    var cid = S.courseId;
    need.forEach(function (t) {
      window.MCxData.quizScope(cid, t.quizId).then(function (v) {
        if (cid !== S.courseId) return;
        // 读失败不许留档：那份是 chars:0 的空壳，留下来这一颗测验的考纲这一趟就永远补不回来，
        // 而屏幕上只是少了一段字，谁都不会发现
        if (v.error) {
          window.MCxData.log('scope text could not be read for', t.name, v.error);
          return;
        }
        S.stats['quiz_' + t.quizId] = v;
        if (S.pane === 'resources' || S.pane === 'ask') draw();
      });
    });
  }

  var GROUND_RULE = 'You are a study assistant inside a student\'s own Canvas LMS. '
    + 'Work only from the course material supplied at the end. Each block of that material starts with a tag like [R3]: '
    + 'after anything you take from a block, put that block\'s tag in square brackets at the end of the line, so the student can find the page it came from. '
    + 'Never invent a tag, and never attach one to something the block does not actually say. '
    + 'When the material does not cover something the assessment needs, say that in one line instead of filling the gap. '
    + 'Write in the language of the material (if the material is mixed, follow the student\'s own request line). '
    + 'Start at the first heading: no preamble about what you are about to write, and do not restate the request.';

  // 排版开着才让模型回 Markdown；关上就得把那句禁令放回去，否则屏幕上就是一堆星号和井号
  var FORMAT_RULE = 'The panel renders Markdown, so use it: ## and ### for section titles, - for bullets, 1. for steps, '
    + '**bold** on a term the student has to remember, > for a note worth pinning, and a pipe table when three or more things belong side by side. '
    + 'Inside a table cell never type a vertical bar: that character is what separates the columns, so a magnitude like |A - B| there breaks the whole row. '
    + 'Write abs(A - B) instead, or keep that row out of the table. '
    + 'No code fences unless the course itself wrote it as code, and no HTML. Keep each section short enough to scan on a phone. '
    + 'For maths write what a student would read out loud, in ordinary characters and unicode: v = 12 m/s, θ = ωt, √2, 3 × 10^8, '
    + 'a² + b² = c², ½mv², and the signs ≤ ≥ ≠ ≈ ± × ÷ →. Subscripts as v_x and superscripts as x^2 are fine as they are. '
    + 'If one formula cannot be written that way, wrap that whole one in $...$ and keep it simple LaTeX '
    + '(\\frac{a}{b}, \\sqrt{x}, x^2, \\theta); the panel turns those into the same readable form.';

  var PLAIN_RULE = 'The screen that shows this cannot render markup, so write plain text only: short headings as bare lines, '
    + 'list items starting with a dash. Never use markdown or LaTeX syntax. No ** or __ around words, no # before headings, '
    + 'no --- divider lines, no backticks, no tables, no code fences, and no maths written in LaTeX, which means nothing wrapped in dollar signs. '
    + 'Write formulas the way you would say them, in ordinary characters and unicode '
    + '(|A| for a vector magnitude, v = 12 m/s, theta, sqrt(2), 3 x 10^8).';

  /* 按考点压上下文那一条通路专用的几句。
     不放进 GROUND_RULE 是因为顺序拼那一条老路没有片号，说了它会去找不存在的东西。
     最后一句是限长：逐句引用审计会把学习总结压垮，引用只服务"能不能查回去"。 */
  var CHUNK_RULE = 'The material below arrives as parts, each one headed by a tag like [R3-C2]; the whole file is [R3]. '
    + 'Put the tag of the part a line came from on that line, or on the sentence right after it. '
    + 'A definition, a formula, a number and a worked example each need their own tag on their own line. '
    + 'One tag stands for one claim: never let a single tag cover several unrelated statements, '
    + 'and never attach a tag to something that part of the file does not say. '
    + 'Only the tags printed in the list exist. Do not invent, renumber, reformat or guess one. '
    + 'Where a line would need a tag you do not have, write that the selected material does not give enough to say it, '
    + 'and leave it at that. '
    + 'Do not promote a general remark in the material into something the assessment will certainly test. '
    + 'If you go through the exam points, mark each one with a single word for its state '
    + '(covered / thin / ask the teacher) and do not audit the answer sentence by sentence.';

  /* 覆盖表里"没找到依据"那几条要报名字，也要报名字地告诉它不许补 */
  function uncoveredRule() {
    if (!S.ctx || !S.ctx.missing || !S.ctx.missing.length) return '';
    return '\nExam points the selected material does not cover: ' + S.ctx.missing.join(', ') + '. '
      + 'For each of those write one line saying the material picked here does not cover it, '
      + 'and that the student should check the slides or ask the teacher. Do not answer them from general knowledge.';
  }

  function buildMessages(materials) {
    var tpl = TEMPLATES.filter(function (x) { return x.id === S.template; })[0] || TEMPLATES[0];
    var system = GROUND_RULE + ' ' + (formatOn() ? FORMAT_RULE : PLAIN_RULE);
    if (materials && materials.chunked) system += ' ' + CHUNK_RULE;
    // 排版那几句讲的是散文怎么排，练习那一档要的是一个 JSON 对象：不点明的话它会两头都照，
    // 结果就是一段带代码围栏的 JSON，parse 不动
    if (tpl.json) {
      system += ' The shape asked for below is one JSON object, so those markup rules do not apply to this answer, '
        + 'except inside the string values of that object.';
    }
    var legend = sourcesLegend();
    var user = 'Course: ' + (S.courseName || 'a course in Canvas') + '\n\n'
      + 'What the student is preparing for:\n' + (scopeBlock() || '(the student picked no task line)') + '\n\n'
      + 'What to produce: ' + tpl.ask + ' ' + (tpl.tail || '') + '\n'
      + (tpl.json ? '\n' + tpl.json + '\n' : '')
      + (S.extra ? '\nThe student added this requirement: ' + S.extra + '\n' : '')
      + (legend ? '\nThe tags, so [R1] means something you can look up:\n' + legend + '\n' : '')
      + uncoveredRule()
      + '\nCourse material:\n' + (materials.text || '(none supplied)');
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }

  /* 开跑这一刻才把正文读齐：面板一直开着的话，早点读完的和老师后来改过的会岔开 */
  function run() {
    ensureAccount();
    if (aiKeyState() === 'loading') {
      // 读数还在路上，这时候报"没有 key"是假警报
      S.notice = 'Loading AI settings. Try again in a moment.';
      draw();
      return;
    }
    var cfg = window.MCxAi.config(S.account);
    var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
    if (isCloud && window.MCxAi.hasCloudAccess && !window.MCxAi.hasCloudAccess()) {
      S.notice = 'Starting Google sign-in…';
      draw();
      if (window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            S.notice = 'Sign-in was cancelled. Try again when you are ready.';
            draw();
          } else {
            S.notice = '';
            draw();
            runChat();
          }
        });
      }
      return;
    }
    if (!window.MCxAi.canUseSlot(cfg)) {
      S.notice = isCloud
        ? 'Sign in under Settings → AI & Plans to use Modern Canvas AI.'
        : 'Nothing can be summarised until one request goes out. Paste a key into the AI row in Settings, then press Test to check it answers.';
      draw();
      return;
    }
    /* Settings can change while this drawer stays open. S.model is only the drawer display state;
       cfg.model is the current resolved route, so never send a stale model after a settings edit. */
    S.model = cfg.model || '';
    var list = pickedResources();
    if (!list.length && !pickedTaskList().length) {
      S.notice = 'Select at least one course item or assignment to continue.';
      draw();
      return;
    }
    S.running = true;
    S.turns = [{ q: '', a: '', model: S.model || '', calls: [] }];
    S.result = '';
    // 上一趟那份计数（in/out 拆开那一格）不算在这一趟头上
    S.usage = null;
    // S.calls 故意不清：Again 就是这一场对话里的第二趟，屏上那句加法要把它排成第二项。
    // 真正开新一场是那一颗 New chat（见 data-new-chat），换课是 resetForCourseSwitch
    S.sources = {};
    // 上一趟的覆盖表和"送了多少片段"必须跟着清：不然新那一趟还没挑完，屏上挂着的是旧的考点
    S.ctx = null;
    S.coverage = null;
    S.openCov = {};
    S.retrievalNote = '';
    // 这是一条新会话：库里的壳子在落第一笔字之后才造，从历史翻出来的那一条不带过来
    S.session = null;
    S.fromHistory = false;
    S.backPane = 'ask';
    S.pane = 'result';
    S.notice = '';
    progressNote = '';
    S.readNote = 'Reading 0 of ' + list.length + ' selected items…';
    // 这一趟的代次和本地 controller：Stop、关面板、换课都要能让这条链安静下来。
    // 之前是每一步都去读 S.controller，取消那里已经把它置成 null，
    // 于是阅读阶段按 Stop 会把 "Cannot read properties of null" 甩在结果屏上
    var gen = ++S.runGen;
    var controller = new AbortController();
    S.controller = controller;
    draw();

    function dead() { return gen !== S.runGen; }

    var texts = {};
    var doneOne = function () {
      if (dead()) return;
      S.readNote = 'Reading ' + Object.keys(texts).length + ' of ' + list.length + ' selected items...';
      paintProgress();
    };

    window.MCxData.readMany(list, function (r, v) {
      texts[r.id] = v;
      doneOne();
    }, function (r, step) {
      // 一份扫描版 PDF 里每一页都要一秒多，只报"第几条 of 共几条"看着就像卡住。
      // 回 false 是告诉读数那一头这一趟已经没人要了，别再把剩下的页认下去
      if (dead()) return false;
      S.readNote = (r.title || 'A file') + ': ' + step;
      paintProgress();
      return true;
    }).then(function () {
      if (dead()) return '';
      S.readTexts = {};
      var missing = [];
      list.forEach(function (r) {
        var v = texts[r.id];
        if (v && v.ok && v.text) S.readTexts[r.id] = v;
        else missing.push((v && v.name) || r.title);
      });
      S.readNote = '';
      return collectImages(gen).then(function (images) {
        if (dead()) return '';
        /* 读数这一段完了不等于有东西上屏：从这里到模型吐出第一个字常常要好几秒，
           那一头清掉转圈行之后这一屏就是全白，看着像死了。所以这一段一路报着"在挑哪几块" */
        /* 先按考点把上下文压一遍；压不动或出岔就退回按顺序拼那一条老路。
           这里必须等它，因为"实际送了多少片段、盖住几个考点"这两句要在发出去之前上屏 */
        return prepareMaterials(list, dead).then(function (materials) {
          if (dead()) return '';
          S.readNote = 'Waiting for the model to answer...';
          var messages = buildMessages(materials);
          // 追问那一趟要报"这一问出去又是多少字"，所以把这一趟的固定开销存下来：
          // 材料加考纲加系统那句，它每问一次就跟着重发一次，那是他掏的钱
          S.baseMessages = messages;
          var notes = [];
          if (missing.length) notes.push('No text came out of these, so they are not in this request: ' + missing.join(', '));
          if (materials.truncated) {
            notes.push(materials.chunked
              ? 'Only the parts of the selected material that fit one request went in; the rest stays in Canvas.'
              : 'The material passed the limit for one request, so the last items were cut short.');
          }
          if (S.retrievalNote) notes.push(S.retrievalNote);
          S.notice = notes.join('\n');
          draw();
          return window.MCxAi.send({
            profile: S.account,
            feature: 'Study summary',
            model: cfg.model,
            messages: messages,
            images: images,
            withImages: S.imagesOn,
            signal: controller.signal,
            onPoolUsed: function (val) {
              if (dead()) return;
              liveTurn().poolUsed = !!val;
              paintResultSoon();
            },
            onStatus: function (msg) {
              if (dead()) return;
              S.readNote = msg;
              paintProgress();
            },
            onDelta: function (piece) {
              if (dead()) return;
              // 第一个字到手就把"在等回话"那一行撤掉：paintResult 只换下面那块文字，碰不到它
              if (S.readNote) { S.readNote = ''; paintProgress(); }
              addDelta(piece);
              paintResultSoon();
            },
            onUsage: function (u, key) {
              if (dead()) return;
              S.usage = u;
              // 每一趟各占一项：这一轮的数挂在它自己那一轮上，整场的加法挂在 S.calls
              S.calls = window.MCxAi.usageTrack(S.calls, u, key);
              liveTurn().calls = window.MCxAi.usageTrack(liveTurn().calls, u, key);
            }
          });
        });
      });
    }).then(function (full) {
      if (dead()) return;
      S.running = false;
      // 一个字都没回的那一趟（代理页、非流式退路）不能把"在等回话"留在屏上
      S.readNote = '';
      dismissRunAsk();
      if (full && !liveTurn().a) addDelta(full);
      if (S.controller === controller) S.controller = null;
      persistSession();
      draw();
    }, function (err) {
      if (dead()) return;
      S.running = false;
      S.readNote = '';
      dismissRunAsk();
      if (S.controller === controller) S.controller = null;
      // 一个字都没落的那一轮不许留在屏上（和追问那一头同一个口径）
      if (!liveTurn().a) S.turns.pop();
      var d = window.MCxAi.describeError(err, cfg);
      S.notice = d.code === 'abort' ? '' : d.text;
      draw();
    });
  }

  /* 取消这一趟。bump 代次是唯一要紧的一步：
     链条上每一步都先问 dead()，所以晚到的回包只会自己散去，不会写画面也不会清掉别人的 controller */
  function cancelRun() {
    S.runGen++;
    if (paintLate) { clearTimeout(paintLate); paintLate = 0; }
    // 还没落一个字的那一轮不许留在屏上：按 Stop 之后屏幕上该剩的是上一条真东西
    var last = S.turns[S.turns.length - 1];
    if (last && !last.a) {
      S.turns.pop();
      S.result = (S.turns[S.turns.length - 1] || {}).a || '';
    }
    if (S.controller) {
      try { S.controller.abort(); } catch (e) {}
    }
    S.controller = null;
    S.running = false;
    S.readNote = '';
    // 这一趟没了就是没了：那句"要停还是在背后写完"不许继续挂在页面上问一件已经结束的事
    dismissRunAsk();
  }

  function collectImages(gen) {
    if (!S.imagesOn) return Promise.resolve([]);
    var urls = [];
    var list = pickedResources();
    for (var i = 0; i < list.length && urls.length < IMAGE_CAP; i++) {
      var got = S.readTexts && S.readTexts[list[i].id];
      if (got && got.images) urls = urls.concat(got.images.map(function (x) { return x.src; }));
    }
    urls = urls.slice(0, IMAGE_CAP);
    if (!urls.length) return Promise.resolve([]);
    if (gen === S.runGen) {
      S.readNote = 'Resizing ' + urls.length + ' images for sending...';
      draw();
    }
    // 每张图自己收错：坏掉那张算没这张图，其余照发。
    // 用 Promise.all 而不做 catch 的话，一张取不回来的图会把整趟总结作废
    return Promise.all(urls.map(function (u) {
      return window.MCxData.imageAsDataUrl(u, 1024).then(function (v) { return v && v.error ? null : v; },
        function () { return null; });
    })).then(function (imgs) {
      return imgs.filter(Boolean);
    });
  }

  function cancel() {
    cancelRun();
    // 按 Stop 之前已经落了一半答案，那一半还挂在屏幕上；库里也得有，
    // 否则他关掉抽屉再回来找，就变成"什么都没存过"
    persistSession();
    draw();
  }

  /* ==== 画面 ==== */

  function stepsHtml(list) {
    return '<div class="mcx-study-steps">' + stepsInner(list) + '</div>';
  }

  function stepsInner(list) {
    return (list || STEPS).map(function (s) {
      return '<span class="mcx-study-step" data-step="' + s.k + '">' +
        '<i class="mcx-study-dot" aria-hidden="true"></i><span>' + esc(s.label) + '</span></span>';
    }).join('');
  }

  function stepIndex() {
    var list = S.mode === 'teacher' ? TEACHER_STEPS : STEPS;
    for (var i = 0; i < list.length; i++) if (list[i].k === S.pane) return i;
    if (S.mode !== 'teacher' && S.pane === 'result') return STEPS.length;
    return -1;
  }

  /* 只翻类名，不重建这一行：重建会把颜色过渡的起点抹掉（换屏时那三颗会闪一下），
     而且抬头那一整块跟着重排。唯一要重建的时候是换了道（总结／写信），那一步的颗数不一样 */
  function paintSteps() {
    var row = root.querySelector('.mcx-study-steps');
    if (!row) return;
    /* 锁住那一屏的那一步不叫"挑作业"（这一屏挑不了），所以换锁也要重建这一行一次。
       重建的代价只在这一道换那一道的那一下，同档之内还是只翻类名 */
    var stepKey = S.mode + (S.mode === 'teacher' && S.mtLockTaskId ? '-locked' : '');
    if (row.dataset.mode !== stepKey) {
      row.dataset.mode = stepKey;
      row.innerHTML = stepsInner(S.mode === 'teacher'
        ? (S.mtLockTaskId ? TEACHER_STEPS_LOCKED : TEACHER_STEPS) : STEPS);
    }
    /* 历史那一屏不是这几步里的一站（它是从抬头那颗时钟进的另一条道），
       那一行挂在这里只会让人以为按得动它：整行藏掉，回到步骤那一头再露出来 */
    row.classList.toggle('is-off', S.pane === 'history');
    var now = stepIndex();
    var nodes = row.querySelectorAll('.mcx-study-step');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-done', now >= 0 && i < now);
      nodes[i].classList.toggle('is-now', i === now);
      if (i === now) nodes[i].setAttribute('aria-current', 'step');
      else nodes[i].removeAttribute('aria-current');
    }
  }

  function draw() {
    if (!S.open) return;
    paintChrome();
    paintSteps();
    // 结果那一屏的底部是"输入框加一排按钮"两行，其余各屏还是单独一排
    footEl().className = 'mcx-study-foot' + (S.pane === 'result' && !S.running ? ' is-doc' : '');
    /* 抬头那颗时钟亮着＝那一份会话名单在屏幕上。窄的那一档它是"历史"那一屏，
       宽的那一档它是左边那一列，两档各按各自的样子亮，按下去都有东西动 */
    var hbtn = root.querySelector('.mcx-study-historybtn');
    if (hbtn) hbtn.classList.toggle('is-on', S.pane === 'history' || (isWide() && S.railOn));
    if (S.pane === 'tasks') drawTasks();
    else if (S.pane === 'resources') drawResources();
    else if (S.pane === 'ask') drawAsk();
    else if (S.pane === 'teacher') drawTeacher();
    else if (S.pane === 'history') drawHistory();
    else if (S.pane === 'embed') drawEmbed();
    else drawResult();
    drawRail();
  }

  /* 借窗那一屏的抬头：那一行本来就是"这一扇是什么"，所以名字换成借进来那位报的；
     底下那三颗步骤点（挑任务—挑资料—提问）是 AI 总结自己的流程，
     这一屏上没有它们，留着就是拿别人的流程给用户看，整行藏掉。
     不在这屏时逐字写回原样，别留半条改过的抬头 */
  function paintChrome() {
    if (!root) return;
    var emb = S.pane === 'embed' && S.embed;
    var t = root.querySelector('.mcx-study-headtitle');
    if (t) { var want = emb ? (S.embed.label || 'Assignment Guide') : 'Study With AI'; if (t.textContent !== want) t.textContent = want; }
    var s = root.querySelector('.mcx-study-steps');
    if (s) s.style.display = emb ? 'none' : '';
  }

  /* 借这一座窗的那一屏：节点原样搬进来，不复制、不重画它的内容（那是来借的那位自己的事），
     脚那一排是聊天输入框，这一屏上没有要问的东西，所以清空 */
  function drawEmbed() {
    var b = bodyEl();
    if (!b) return;
    b.textContent = '';
    if (S.embed && S.embed.node) b.appendChild(S.embed.node);
    var f = footEl();
    if (f) { f.textContent = ''; f.className = 'mcx-study-foot'; }
  }

  /* 底部那一排：勾了一条作业之后要重画的就是它，两道的内容不一样，
     所以那一颗的刷新口只认这一个函数，不在两处各写一遍 */
  function paintFoot() {
    footEl().innerHTML = S.mode === 'teacher' ? teacherFootHtml() : tasksFootHtml();
  }

  var GOOGLE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>'
    + '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>'
    + '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>'
    + '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>'
    + '</svg>';

  function isUnloggedMsg(text) {
    return /Not signed in yet|sign in with your Google account|AI & Plans|User cancelled sign-in|Sign-in was cancelled|Please sign in/i.test(String(text || ''));
  }

  function formatNoticeHtml(text) {
    if (!text) return '';
    var isRed = /User cancelled|failed|error|Not signed in|Please sign in/i.test(String(text));
    var html = '<span style="' + (isRed ? 'color:#ef4444 !important; font-weight:500;' : '') + '">' + esc(text).replace(/\n/g, '<br>') + '</span>';
    if (isUnloggedMsg(text)) {
      html += '<div class="mcx-ai-error-act">'
        + '<button type="button" class="mcx-ai-error-btn" data-ai-auth="google">'
        + GOOGLE_SVG + '<span>Sign in with Google</span></button>'
        + '</div>';
    }
    return html;
  }

  function noticeHtml() {
    if (!S.notice) return '';
    return '<div class="mcx-study-note">' + formatNoticeHtml(S.notice) + '</div>';
  }

  function loadingHtml(label) {
    return '<div class="mcx-study-loading"><span class="mcx-study-spin" data-late="1"></span><span class="mcx-study-loading-text">' + esc(label) + '</span></div>';
  }

  function courseRowHtml() {
    var name = S.courseName || (S.courseId ? 'Course ' + S.courseId : 'No course selected');
    var opts = S.courses.map(function (c) {
      return '<button type="button" class="mcx-study-course' + (c.id === S.courseId ? ' is-on' : '') + '" data-course="' + c.id + '">' +
        esc(c.name) + '</button>';
    }).join('');
    return '<div class="mcx-study-coursebox">' +
      '<button type="button" class="mcx-study-curseclose" data-courses="1"><span>' + esc(name) + '</span>' + svg('M7 10l5 5 5-5z') + '</button>' +
      (S.showCourses ? '<div class="mcx-study-courselist">' + (opts || '<span class="mcx-study-dim">The course list is still arriving</span>') + '</div>' : '') +
      '</div>';
  }

  /* 写信那一屏默认只摆两堆：最新的那 10 条，加过了期还没交的。
     整门课一屏列不完，而他要点的东西几乎都在这两堆里。
     按了 Show all 或者在搜索框里打了字，这一屏就放开 */
  var MT_NEWEST = 10;

  function visibleTasks() {
    var now = Date.now();
    var q = S.taskQuery.trim().toLowerCase();
    var all = S.tasks.filter(function (t) {
      // 写信那一屏默认就把教过的作业一起摆出来：要问的成绩多半正是已经交过的那几条
      if (!S.includePast && S.mode !== 'teacher' && t.dueMs && t.dueMs < now) return false;
      if (q && String(t.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (S.mode !== 'teacher') return { rows: all, hidden: 0 };
    var keep = {};
    all.slice(0, MT_NEWEST).forEach(function (t) { keep[t.id] = true; });
    all.forEach(function (t) { if (!t.done && t.dueMs && t.dueMs < now) keep[t.id] = true; });
    var kept = all.filter(function (t) { return keep[t.id]; });
    return { rows: S.mtShowAll || q ? all : kept, hidden: all.length - kept.length };
  }

  /* 分数那一档：判过就是 "5 / 50"，没判就是 "- / 50"。
     小数只留一位（Canvas 会给到 16.666667），整数不带小数点 */
  function fmtPoints(n) {
    var r = Math.round(Number(n) * 10) / 10;
    return String(r % 1 === 0 ? Math.round(r) : r);
  }

  function taskSideHtml(t) {
    var top = t.points == null ? '' : fmtPoints(t.points);
    var line;
    if (!top) line = esc(t.kind === 'quiz' ? 'Quiz' : 'Task');
    else if (t.score == null) line = '- / ' + esc(top);
    else line = esc(fmtPoints(t.score)) + ' / ' + esc(top);
    return line + (t.dueAt ? '<br>' + esc(fmtDate(t.dueAt)) : '');
  }

  /* 那一屏下面这颗：收着的时候说清还有多少条没摆出来，
     摆全了那一档就只剩一颗收回键，不再重复报数（数已经不对了） */
  function mtShowAllHtml(cap) {
    if (!cap.hidden || S.taskQuery.trim()) return '';
    if (S.mtShowAll) {
      return '<div class="mcx-study-mtmore"><button type="button" class="mcx-study-ghost" data-mt-all="1">Show less</button></div>';
    }
    return '<div class="mcx-study-mtmore"><button type="button" class="mcx-study-ghost" data-mt-all="1">Show all assignments</button>' +
      '<span class="mcx-study-dim">' + cap.hidden + ' earlier assignments</span></div>';
  }

  function taskRowsHtml() {
    var rows = visibleTasks().rows;
    if (!rows.length) {
      // 这四种在屏幕上是一回事、在手上是四回事，混成一句就会让人去点不该点的东西
      if (!S.readDone) return '<div class="mcx-study-empty">Loading assignments…</div>';
      if (!S.courseKnown) return '<div class="mcx-study-empty">This course is not active. Choose another course.</div>';
      if (!S.tasks.length) return '<div class="mcx-study-empty">No assignments in this course.</div>';
      if (S.mode === 'teacher') return '<div class="mcx-study-empty">No assignments match your search.</div>';
      return '<div class="mcx-study-empty">No upcoming assignments. Turn on “Include past work” to see earlier ones.</div>';
    }
    return rows.map(function (t) {
      var on = !!S.pickedTasks[t.id];
      return '<div class="mcx-study-row' + (on ? ' is-on' : '') + '" data-task="' + t.id + '">' +
        '<span class="mcx-study-tick">' + (on ? svg('M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z') : '') + '</span>' +
        '<span class="mcx-study-rowmain">' + esc(t.name) +
          (t.done ? '<span class="mcx-study-state">submitted</span>' : '') + '</span>' +
        '<span class="mcx-study-rowside">' + taskSideHtml(t) + '</span>' +
        '</div>';
    }).join('');
  }

  /* 勾一行不该重建整屏：整屏重建会把每一行的 hover 和过渡都打断一次，
     还会让刚点的那颗节点变成游离节点。这里只改那一行，加底部那一行计数 */
  function paintRow(row, on) {
    row.classList.toggle('is-on', !!on);
    var tick = row.querySelector('.mcx-study-tick');
    if (tick) tick.innerHTML = on ? svg(ICONS.check) : '';
  }

  function paintNote() {
    var host = bodyEl().querySelector('.mcx-study-note');
    if (!S.notice && host) { host.parentNode.removeChild(host); return; }
    if (!S.notice) return;
    if (!host) {
      host = document.createElement('div');
      host.className = 'mcx-study-note';
      var sec = bodyEl().querySelector('.mcx-study-h');
      if (sec && sec.nextSibling) sec.parentNode.insertBefore(host, sec.nextSibling);
      else bodyEl().querySelector('.mcx-study-sec').appendChild(host);
    }
    host.innerHTML = formatNoticeHtml(S.notice);
  }

  function tasksFootHtml() {
    return '<span class="mcx-study-count">' + (pickedTaskList().length ? pickedTaskList().length + ' assignments selected' : '') + '</span>' +
      '<button type="button" class="mcx-study-primary" data-next="resources"' + (pickedTaskList().length ? '' : ' disabled') + '>Choose materials</button>';
  }

  function resourcesFootHtml() {
    var est = estimate();
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    return '<span class="mcx-study-count">' + (pickedResources().length
      ? pickedResources().length + ' selected · about ' + fmtNum(est.chars) + ' characters' + (isCloud ? '' : ' · roughly ' + fmtNum(est.tokens) + ' tokens')
      : (S.sizeNote || (Object.keys(S.stats).length ? 'sizes read' : 'reading sizes'))) + '</span>' +
      '<button type="button" class="mcx-study-back" data-next="tasks" aria-label="Back">' + svg(ICONS.back) + '</button>' +
      '<button type="button" class="mcx-study-primary" data-next="ask"' + (pickedResources().length || pickedTaskList().length ? '' : ' disabled') + '>Add instructions</button>';
  }

  function drawTasks() {
    bodyEl().innerHTML =
      '<section class="mcx-study-sec">' +
        '<h2 class="mcx-study-h">Which course, which assessment</h2>' +
        courseRowHtml() +
        noticeHtml() +
        '<div class="mcx-study-tools">' +
          '<span class="mcx-study-searchbox">' +
            '<input type="text" class="mcx-study-search" placeholder="Search assignments" value="' + esc(S.taskQuery) + '">' +
            '<svg class="mcx-study-searchicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
              '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20" stroke-linecap="round"/></svg>' +
          '</span>' +
          '<label class="mcx-study-check"><input type="checkbox" data-past="1"' + (S.includePast ? ' checked' : '') + '>' +
            '<span class="mcx-study-box" aria-hidden="true"></span><span>Include past work</span></label>' +
        '</div>' +
        '<div class="mcx-study-list">' + (S.loading === 'tasks' ? loadingHtml(S.loadNote || 'Loading assignments…') : taskRowsHtml()) + '</div>' +
        '<p class="mcx-study-hint">Pick one or more. A quiz\'s own description on Canvas is read as part of the scope; the questions inside it are not visible to students, so they are never in here.</p>' +
      '</section>';
    footEl().innerHTML = tasksFootHtml();
  }

  var KIND_LABEL = { file: 'Files', slides: 'Slides', page: 'Pages', quiz: 'Quizzes', assignment: 'Assignments', discussion: 'Discussions', link: 'Links' };

  var SLIDE_EXT = { pptx: 1, ppt: 1 };

  function extOfStat(r) {
    var st = S.stats[r.id];
    if (st && st.ext) return st.ext;
    var m = /\.([a-z0-9]+)$/i.exec(String(r.title || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /* 分档判据：Files 和 Slides 互斥，勾两条不会把同一份课件数两遍 */
  var FILTERS = [
    { k: 'file', hit: function (r) { return r.kind === 'file' && !SLIDE_EXT[extOfStat(r)]; } },
    { k: 'slides', hit: function (r) { return r.kind === 'file' && SLIDE_EXT[extOfStat(r)]; } },
    { k: 'page', hit: function (r) { return r.kind === 'page'; } },
    { k: 'quiz', hit: function (r) { return r.kind === 'quiz'; } },
    { k: 'assignment', hit: function (r) { return r.kind === 'assignment'; } },
    { k: 'discussion', hit: function (r) { return r.kind === 'discussion'; } },
    { k: 'link', hit: function (r) { return r.kind === 'link'; } }
  ];

  function filterPillsHtml() {
    return FILTERS.filter(function (f) {
      return S.resources.some(function (r) { return f.hit(r); });
    }).map(function (f) {
      return '<button type="button" class="mcx-study-pill' + (S.filters[f.k] ? ' is-on' : '') + '" data-filter="' + f.k + '">' +
        esc(KIND_LABEL[f.k]) + '</button>';
    }).join('');
  }

  function statLine(r) {
    var st = S.stats[r.id];
    if (!st) return '';
    if (st.bytes) return fmtKb(st.bytes);
    if (st.chars) return fmtNum(st.chars) + ' characters';
    if (!r.readable) return 'No readable text';
    // 这一条的详情问失败了（403、404、超时）。右列空着＝看起来像"它没大小"，
    // 而那一位其实根本没读到，得说清楚
    if (st.error) return 'File size unavailable';
    return '';
  }

  function resourceRowsHtml() {
    var rows = visibleResources();
    if (!rows.length) {
      return '<div class="mcx-study-empty">' + (S.readDone ? 'No course materials found in Modules.' : 'Loading course materials…') + '</div>';
    }
    // 先把这一屏切成一段一段：分组标题自己就是一颗全选键，所以它得知道这一段有几条、勾了几条
    var groups = [];
    rows.forEach(function (r) {
      var key = r.module || '';
      var g = groups.length ? groups[groups.length - 1] : null;
      if (!g || g.key !== key) groups.push(g = { key: key, rows: [] });
      g.rows.push(r);
    });
    return groups.map(function (g) {
      var live = g.rows.filter(function (r) { return r.readable; });
      var onCount = live.filter(function (r) { return S.pickedRes[r.id]; }).length;
      var state = !live.length ? 'plain' : (onCount === live.length ? 'all' : (onCount ? 'part' : 'none'));
      var html = '<div class="mcx-study-mod is-' + state + '"' + (live.length ? ' data-mod="' + esc(g.key) + '"' : '') + '>' +
        (live.length ? '<span class="mcx-study-tick">' +
          (state === 'all' ? svg(ICONS.check) : state === 'part' ? svg('M4 9.5h16v5H4z') : '') + '</span>' : '') +
        '<span class="mcx-study-modname">' + esc(g.key || 'No section') + '</span>' +
        '</div>';
      g.rows.forEach(function (r) {
        var on = !!S.pickedRes[r.id];
        html += '<div class="mcx-study-row' + (on ? ' is-on' : '') + (r.readable ? '' : ' is-dead') + '" data-res="' + r.id + '">' +
          '<span class="mcx-study-tick">' + (on ? svg('M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z') : '') + '</span>' +
          '<span class="mcx-study-rowmain">' + esc(r.title) +
            '<span class="mcx-study-kind">' + esc(kindLabel(r)) + '</span>' +
            (on && S.pickReason[r.id] ? '<span class="mcx-study-why">' + esc(S.pickReason[r.id]) + '</span>' : '') +
            '</span>' +
          '<span class="mcx-study-rowside">' + esc(statLine(r)) + '</span>' +
          '</div>';
      });
      return html;
    }).join('');
  }

  function drawResources() {
    bodyEl().innerHTML =
      '<section class="mcx-study-sec">' +
        '<h2 class="mcx-study-h">What it should read</h2>' +
        '<div class="mcx-study-pills">' + filterPillsHtml() +
          '<button type="button" class="mcx-study-aid" data-ai-pick="1"' + (S.picking ? ' disabled' : '') + '>' +
            (S.picking ? 'AI is picking...' : 'Let AI pick it for you') + '</button>' +
        '</div>' +
        noticeHtml() +
        (S.loading === 'resources' ? loadingHtml(S.loadNote || 'Reading the modules of this course...') : '<div class="mcx-study-list">' + resourceRowsHtml() + '</div>') +
        '<p class="mcx-study-hint">Files are read from Canvas as they are stored there. Anything the teacher put behind an outside tool (Google Slides, a link) has no text here to read.</p>' +
      '</section>';
    footEl().innerHTML = resourcesFootHtml();
  }

  function sendBlockHtml() {
    var list = accounts();
    var pills = list.length
      ? '<div class="mcx-study-pills">' + list.map(function (a) {
          return '<button type="button" class="mcx-study-pill' + (a.id === S.account ? ' is-on' : '') + '" data-account="' + esc(a.id) + '">' + esc(a.name) + '</button>';
        }).join('') + '</div>'
      : '<div class="mcx-study-dim">' + (aiSettingsLoading()
        ? 'Getting AI ready…'
        : 'Neither model slot is filled in yet. Pick a model for Advanced or Flash under Settings, AI & Plans.') + '</div>';
    var chosen = accountOf(S.account);
    var noVision = chosen && chosen.vision === false;
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    /* 药丸右边那一小灰字是这一档配的那个模型，只读：换模型是设置里那一档的事 */
    var shown = (chosen && !isCloud) ? '<span class="mcx-study-sendmodel">' + esc(chosen.model || '') + '</span>' : '';
    return '<div class="mcx-study-send">' +
      '<div class="mcx-study-sendrow"><span class="mcx-study-sendlabel">' + (isCloud ? 'Speed' : 'Model') + '</span>' + pills + shown + '</div>' +
      '<label class="mcx-study-check mcx-study-imgrow' + (noVision ? ' is-dead' : '') + '">' +
        '<input type="checkbox" data-img="1"' + (S.imagesOn ? ' checked' : '') + (noVision ? ' disabled' : '') + '>' +
        '<span class="mcx-study-box" aria-hidden="true"></span>' +
        '<span>Send pictures found in the reading</span></label>' +
      (noVision ? '<div class="mcx-study-dim">The Test on ' + esc(chosen.name) + ' showed that its model does not take pictures, so this one is off.</div>' : '') +
      '</div>';
  }

  /* Practice questions 那一档回来的不是一屏文字，是一屏能作答的题。
     所以挑中它的时候摆一张缩小的样张：题目和选项全部拿横条替掉，答案那一层根本不在图里。
     不先看见形状，就没人知道自己按下 Send it 会拿到什么。
     样张是死的：pointer-events 关掉，读屏器也跳过它，别让人以为能点 */
  function practiceSampleHtml() {
    if (S.template !== 'practice') return '';
    return '<div class="mcx-study-sample" aria-hidden="true">' +
      '<div class="mcx-study-sample-cap">What you get</div>' +
      '<div class="mcx-study-sample-card">' +
        '<div class="mcx-study-sample-top">' +
          '<span class="mcx-study-sample-num">Q1</span>' +
          '<span class="mcx-study-sample-bar"></span>' +
          '<span class="mcx-study-sample-diff">Recall</span>' +
        '</div>' +
        '<div class="mcx-study-sample-prompt">' +
          '<span class="mcx-study-sample-bar"></span>' +
          '<span class="mcx-study-sample-bar"></span>' +
        '</div>' +
        '<div class="mcx-study-sample-legend">Choose one answer</div>' +
        '<div class="mcx-study-sample-opts">' +
          '<div class="mcx-study-sample-opt"><span class="mcx-study-sample-dot"></span><span class="mcx-study-sample-mark">A</span><span class="mcx-study-sample-bar"></span></div>' +
          '<div class="mcx-study-sample-opt"><span class="mcx-study-sample-dot"></span><span class="mcx-study-sample-mark">B</span><span class="mcx-study-sample-bar"></span></div>' +
          '<div class="mcx-study-sample-opt"><span class="mcx-study-sample-dot"></span><span class="mcx-study-sample-mark">C</span><span class="mcx-study-sample-bar"></span></div>' +
          '<div class="mcx-study-sample-opt"><span class="mcx-study-sample-dot"></span><span class="mcx-study-sample-mark">D</span><span class="mcx-study-sample-bar"></span></div>' +
        '</div>' +
        '<div class="mcx-study-sample-check">Check answer</div>' +
      '</div>' +
      '<p class="mcx-study-sample-note">5 to 8 questions like this one. The answer, the reasoning and where it came '
        + 'from appear only after you check.</p>' +
    '</div>';
  }

  function drawAsk() {
    var est = estimate();
    ensureAccount();
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    bodyEl().innerHTML =
      '<section class="mcx-study-sec">' +
        '<h2 class="mcx-study-h">What to make of it</h2>' +
        '<div class="mcx-study-pills">' + TEMPLATES.map(function (t) {
          return '<button type="button" class="mcx-study-pill' + (S.template === t.id ? ' is-on' : '') + '" data-tpl="' + t.id + '">' + esc(t.label) + '</button>';
        }).join('') + '</div>' +
        practiceSampleHtml() +
        '<textarea class="mcx-study-ask" rows="4" placeholder="Add details, such as chapters to focus on, language, or length…"></textarea>' +
        sendBlockHtml() +
        '<div class="mcx-study-plate">' +
          '<div class="mcx-study-platerow"><span>Course</span><span>' + esc(S.courseName || 'None selected') + '</span></div>' +
          '<div class="mcx-study-platerow"><span>Assessments</span><span>' + esc(pickedTaskList().map(function (t) { return t.name; }).join(', ') || 'None selected') + '</span></div>' +
          '<div class="mcx-study-platerow"><span>Material</span><span>' + pickedResources().length + ' items · about ' + fmtNum(est.chars) + ' characters</span></div>' +
          (retrievalOn() && pickedResources().length ? '<div class="mcx-study-platerow"><span>Selection</span><span>' +
            (est.chars > TOTAL_CAP
              ? 'These items are over the limit for one request, so the parts that cover the exam points are picked and the rest stays out'
              : 'Parts that cover the exam points are picked when the pile gets big, so a late item is not dropped for being late') +
            '</span></div>' : '') +
          (!isCloud ? '<div class="mcx-study-platerow"><span>Text</span><span>about ' + fmtNum(est.tokens) + ' input tokens' +
            (est.files ? ' (files counted at 3 characters per byte)' : '') + '. What it writes back is billed on top of this.</span></div>' : '') +
          '<div class="mcx-study-platerow"><span>Images</span><span>' + (S.imagesOn
            ? (isCloud ? 'On: up to ' + IMAGE_CAP + ' pictures found inside the selected reading go along.' : 'On: up to ' + IMAGE_CAP + ' pictures found inside the selected reading go along. Some providers bill a picture as visual input, on top of the text above.')
            : (isCloud ? 'Off: no picture leaves this page.' : 'Off: no picture leaves this page, so nothing is billed as visual input.')) + '</span></div>' +
          (!isCloud ? '<div class="mcx-study-platerow"><span>Follow-up questions</span><span>' + followCostPreview() + '</span></div>' : '') +
        '</div>' +
        (!isCloud ? '<p class="mcx-study-hint">The information you selected goes to the AI service provider that you selected in settings. Nothing passes through Modern Canvas, and we hold no price list, '
          + 'so these are counts taken from your own text rather than a price. Actual billing depends on the provider and model you chose, and their own token count is what you are billed for. '
          + 'Read the numbers above before sending.</p>' : '') +
        noticeHtml() +
      '</section>';
    footEl().innerHTML =
      '<button type="button" class="mcx-study-back" data-next="resources" aria-label="Back">' + svg(ICONS.back) + '</button>' +
      '<button type="button" class="mcx-study-primary" data-run="1">Send it</button>';
    var box = bodyEl().querySelector('.mcx-study-ask');
    if (box) {
      box.value = S.extra;
      box.addEventListener('input', function () { S.extra = box.value; });
    }
  }

  /* ==== 给老师写信那一屏 ====
     一门课的成绩页顶部那颗 Message Your Teacher 叫出来的就是这里。三段一路往下：
     选哪几条作业、写给哪位老师、要它说什么。它不发消息，只把稿子写好留在这。 */

  function teacherOf(id) {
    return S.teachers.filter(function (t) { return t.id === id; })[0] || null;
  }

  function teacherName() {
    var t = teacherOf(S.teacherId);
    return t ? t.name : '';
  }

  /* 两屏共用一颗 S.intent，可选的那一排按屏不同：先按这一屏那张表找，
     找不到再回总表（他从提交屏挑了一档、回手换成成绩页那颗时，存的还是同一个键名） */
  function mtIntentRows() {
    return S.mtLockTaskId ? MT_SUB_INTENTS : MT_INTENTS;
  }

  function mtIntentLabel() {
    var rows = mtIntentRows();
    for (var i = 0; i < rows.length; i++) if (rows[i][0] === S.intent) return rows[i][1];
    rows = MT_INTENTS;
    for (var k = 0; k < rows.length; k++) if (rows[k][0] === S.intent) return rows[k][1];
    return MT_INTENTS[0][1];
  }

  /* 只有 playful 这一档带刻度，所以刻度长在它自己那颗药丸右边，不另起一行：
     摆在下面那一行就成了"这一排四颗共用的设置"，而另外三颗根本不认它。
     药丸本身还是药丸，挑它不会把这一屏别的东西挤走 */
  function mtPlayfulBar(name) {
    var n = mtPlayful();
    return '<span class="mcx-tonebar">' +
      '<button type="button" class="mcx-study-pill mcx-tonebar-name is-on" data-mt-tone="playful">' + esc(name) + '</button>' +
      '<input type="range" class="mcx-tonebar-slider" data-mt-playful min="0" max="100" step="5" ' +
      'value="' + n + '" aria-label="How playful">' +
      '<span class="mcx-tonebar-pct" data-mt-playful-pct>' + n + '%</span>' +
      '</span>';
  }

  /* 锁住的那一条：名单里有就用名单那一行（它有 dueAt／points／description），
     名单里没有就用地址上带来的那颗名字，不许因为"名单没读到"就把整张卡空掉 */
  function lockedTask() {
    if (!S.mtLockTaskId) return null;
    for (var i = 0; i < S.tasks.length; i++) {
      if (S.tasks[i].id === S.mtLockTaskId) return S.tasks[i];
    }
    return {
      id: S.mtLockTaskId, name: S.mtLockTaskName || ('Assignment ' + S.mtLockTaskId),
      dueAt: '', dueMs: 0, points: null, url: '', description: '', quizId: 0,
      submittedAt: (S.mtSub && S.mtSub.submittedAt) || '', done: !!(S.mtSub && S.mtSub.submittedAt),
      graded: !!(S.mtSub && S.mtSub.state === 'graded'),
      score: S.mtSub ? S.mtSub.score : null, kind: 'assignment'
    };
  }

  /* 这一屏到底在说哪几条作业：锁住就是那一条，没锁就是他勾的那几条。
     锁住时不碰 S.pickedTasks：他从这一屏回到成绩页那颗，自己挑的那几条还得在 */
  function mtRows() {
    if (S.mtLockTaskId) { var t = lockedTask(); return t ? [t] : []; }
    return pickedTaskList();
  }

  function mtSubStatus() {
    var s = S.mtSub;
    if (!s) return '';
    if (s.missing || s.state === 'missing') return 'missing';
    if (s.state === 'graded' || s.state === 'complete') return s.state;
    return s.state || (s.submittedAt ? 'submitted' : '');
  }

  /* 一屏一读：老师可能刚批完、刚回过话，所以每次点开都重新问一遍，不吃上一趟的缓存。
     失败只在这一屏下面留一句，不拦他写信（名单那一行本来就带着分数） */
  function loadSubmission() {
    if (!S.mtLockTaskId || !S.courseId) return;
    var cid = S.courseId, aid = S.mtLockTaskId, gen = ++S.mtSubGen;
    S.mtSubNote = '';
    window.MCxData.submission(cid, aid).then(function (s) {
      if (gen !== S.mtSubGen || cid !== S.courseId || aid !== S.mtLockTaskId) return;
      S.mtSub = s;
      S.mtSubNote = '';
      mtPreselectIntent();
      if (S.pane === 'teacher') { draw(); saveTeacherDraft(); }
    }, function (err) {
      if (gen !== S.mtSubGen || cid !== S.courseId || aid !== S.mtLockTaskId) return;
      S.mtSub = null;
      S.mtSubNote = 'This submission did not come back (' + String((err && err.message) || err) +
        '), so the draft is written from what the assignment list says about it.';
      if (S.pane === 'teacher') draw();
    });
  }

  /* 预选那一档：只是把某一颗先按亮，不是替他决定要问什么。
     他动过手（挑过档、写过字、有存过的稿子）就再也不动 */
  function mtPreselectIntent() {
    if (!S.mtLockTaskId || S.mtTouched || S.mtDraft || S.mtNote) return;
    var t = lockedTask();
    if (!t) return;
    var s = S.mtSub;
    var state = mtSubStatus() || (t.graded ? 'graded' : (t.done ? 'submitted' : 'missing'));
    var graded = state === 'graded';
    var want;
    if (state === 'missing' || state === 'unsubmitted' || (!t.done && !s)) want = 'issue';
    else if (graded) {
      var full = t.points != null && s && s.score != null && Number(s.score) >= Number(t.points);
      want = (s && s.comments && s.comments.length) || full ? 'feedback' : 'grade';
    } else want = 'followup';
    for (var i = 0; i < MT_SUB_INTENTS.length; i++) {
      if (MT_SUB_INTENTS[i][0] === want) { S.intent = want; return; }
    }
  }

  function loadTeachers() {
    if (!S.courseId) return;
    var cid = S.courseId;
    /* 这一趟单独一代：S.loadGen 是课程名单和作业名单共用的那条链，
       写信这一屏的读数挂在它上面就会把课程回包判成"过期了"，课名就永远填不上 */
    var gen = ++S.mtLoadGen;
    var keep = S.teacherId;
    S.teachers = [];
      S.teacherNote = 'Loading teachers…';
    draw();
    window.MCxData.teachers(cid).then(function (list) {
      if (gen !== S.mtLoadGen || cid !== S.courseId) return;
      S.teachers = list || [];
      S.teacherNote = '';
      // 草稿里那位还在名单上就回到他上次挑的那位；不在（或本来就没挑过）就第一位
      var kept = null;
      for (var i = 0; i < S.teachers.length; i++) if (S.teachers[i].id === keep) kept = S.teachers[i];
      S.teacherId = kept ? kept.id : ((S.teachers[0] || {}).id || 0);
      draw();
      saveTeacherDraft();
    }, function (err) {
      if (gen !== S.mtLoadGen || cid !== S.courseId) return;
      S.teacherNote = 'Could not load teachers. ' + String((err && err.message) || err);
      draw();
    });
  }

  function teacherPillsHtml() {
    if (S.teacherNote) {
      return '<div class="mcx-study-dim">' + esc(S.teacherNote) + '</div>';
    }
    if (!S.teachers.length) {
      return '<div class="mcx-study-dim">No teacher is listed for this course.</div>';
    }
    return '<div class="mcx-study-pills">' + S.teachers.map(function (t) {
      return '<button type="button" class="mcx-study-pill' + (t.id === S.teacherId ? ' is-on' : '') + '" data-teacher="' + t.id + '">' +
        esc(t.name) + (t.pronouns ? ' (' + esc(t.pronouns) + ')' : '') + '</button>';
    }).join('') + '</div>';
  }

  /* Message Your Teacher uses the same resolved route as Inbox Reply. Keep this as a readout
     that opens the single AI settings screen, rather than creating a second model picker here. */
  function teacherModelChipHtml() {
    var a = window.MCxAi;
    if (a && a.isCloudMode && a.isCloudMode()) return '';
    var cfg = null;
    /* 这一颗报的必须是这一屏按下 Send 真的会用的那一档：读 config() 会报成默认那一档，
       而他刚在药丸上挑的是另一档 */
    try { cfg = a && a.config ? a.config(S.account) : null; } catch (e) {}
    if (!cfg || cfg.isCloud) return '';
    var source = cfg.name || 'Your API key';
    var model = cfg.model || 'Not set';
    var label = source + ' · ' + model;
    var icon = '<svg class="mcx-study-modelico" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<rect x="4" y="5" width="16" height="14" rx="4"/><path d="M8.5 10.5h.01M15.5 10.5h.01M9 15h6"/>'
      + '</svg>';
    return '<button type="button" class="mcx-study-modelchip" data-settings '
      + 'aria-label="AI settings. Configured model: ' + esc(label) + '" '
      + 'title="Configured model: ' + esc(label) + '. Open AI settings">'
      + icon + '<span>' + esc(label) + '</span></button>';
  }

  function teacherComposerHtml() {
    var busy = S.mtStage === 'waiting';
    var gen = '<button type="button" class="mcx-study-primary" data-mt-gen' + (busy ? ' disabled' : '') + '>' +
      svg(ICONS.spark) + (busy ? 'Writing' : (S.mtStage === 'ready' ? 'Regenerate' : 'Generate')) + '</button>';
    var chip = teacherModelChipHtml();
    return '<div class="mcx-study-mtcompose">' +
      (chip ? '<div class="mcx-study-modelrow"><span>Reply model</span>' + chip + '</div>' : '') +
      '<div class="mcx-study-mtgroup"><span class="mcx-study-mtlabel">What would you like to say?</span>' +
        '<div class="mcx-study-pills">' + mtIntentRows().map(function (r) {
          return '<button type="button" class="mcx-study-pill' + (S.intent === r[0] ? ' is-on' : '') + '" data-mt-intent="' + r[0] + '">' + esc(r[1]) + '</button>';
        }).join('') + '</div></div>' +
      '<div class="mcx-study-mtgroup"><span class="mcx-study-mtlabel">Tone</span>' +
        '<div class="mcx-study-pills">' + mtTones().map(function (r) {
          if (r[0] === 'playful' && S.tone === 'playful') return mtPlayfulBar(r[1]);
          return '<button type="button" class="mcx-study-pill' + (S.tone === r[0] ? ' is-on' : '') + '" data-mt-tone="' + r[0] + '">' + esc(r[1]) + '</button>';
        }).join('') + '</div>' +
        /* 和收件箱那一屏同一句、同一个三角、同一道边界：这一屏发出去的是真给老师的那封信 */
        window.MCxAi.toneWarnHtml(S.tone === 'playful' ? mtPlayful() : 0) +
        '</div>' +
      '<textarea class="mcx-study-ask mcx-study-mtnote" rows="3" placeholder="Add an optional note…"></textarea>' +
      '<div class="mcx-study-mtgen">' + gen +
        (busy ? '<button type="button" class="mcx-study-ghost" data-mt-stop>Stop</button>' : '') +
        (busy ? '<span class="mcx-study-dim">The draft will appear in the box below.</span>' : '') +
      '</div>' +
      (S.mtErr ? '<div class="mcx-study-note">' + formatNoticeHtml(S.mtErr) + '</div>' : '') +
      ((busy && (S.mtPoolUsed || (window.MCxAi && window.MCxAi.isPoolRouting && window.MCxAi.isPoolRouting()))) && window.MCxAi && window.MCxAi.poolNoticeHtml ? window.MCxAi.poolNoticeHtml() : '') +
      '<textarea class="mcx-study-ask mcx-study-mtdraft" rows="6" placeholder="Write your reply…"></textarea>' +
      (S.mtCalls.length ? '<div class="mcx-study-mtuse">' + esc(useText(S.mtCalls, 'This draft')) + '</div>' : '') +
      '</div>';
  }

  /* Keep the generated draft from becoming a second scroll container inside the drawer.  As the
     stream grows, let the textarea grow with it so wheel/trackpad input always reaches the one
     intended scroller: .mcx-study-body. */
  function fitTeacherDraft(box) {
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = Math.max(132, box.scrollHeight) + 'px';
  }

  /* 锁住那一屏的第一段：一张只读的卡，四行。这里不让人再挑作业，也不给换课的入口，
     因为作业和课都是这一页地址定下来的；要挑别的作业，回成绩页那颗 */
  function mtLockedCardHtml() {
    var t = lockedTask();
    var s = S.mtSub;
    var grade;
    var shownGrade = mtGradeText(s && s.grade);
    if (s && s.state === 'graded' && shownGrade) {
      grade = shownGrade + (t && t.points != null ? ' / ' + fmtPoints(t.points) : '');
    } else if (t && t.score != null && t.points != null) {
      grade = fmtPoints(t.score) + ' / ' + fmtPoints(t.points);
    } else if (shownGrade) grade = shownGrade;
    /* 那一条请求没回来时不许说"还没批"：那是"没读到"，两句话在屏幕上是一回事、在他手上是两回事 */
    else if (S.mtSubNote) grade = 'Not read';
    else grade = 'Not graded yet';
    var when = (s && s.submittedAt) || (t && t.submittedAt) || '';
    var submitted;
    if (when) submitted = fmtDate(when);
    else if (s) submitted = 'Not handed in';
    else if (S.mtSubNote) submitted = 'Not read';
    else submitted = 'Reading this submission...';
    var rows = [
      ['Assignment', t ? (t.name || '(no name on Canvas)') : '(not read yet)'],
      ['Grade', grade],
      ['Submitted', submitted],
      ['Course', S.courseName || 'Reading this course...']
    ];
    return '<div class="mcx-study-plate">' + rows.map(function (r) {
      return '<div class="mcx-study-platerow"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>';
    }).join('') + '</div>' + (S.mtSubNote ? '<div class="mcx-study-dim">' + esc(S.mtSubNote) + '</div>' : '');
  }

  function drawTeacher() {
    ensureAccount();
    var locked = !!S.mtLockTaskId;
    var cap = visibleTasks();
    var sec1 = locked
      ? '<section class="mcx-study-sec">' +
          '<h2 class="mcx-study-h">Current assignment</h2>' +
          noticeHtml() +
          mtLockedCardHtml() +
        '</section>'
      : '<section class="mcx-study-sec">' +
          '<h2 class="mcx-study-h">Which assignments</h2>' +
          courseRowHtml() +
          noticeHtml() +
          '<div class="mcx-study-tools">' +
            '<span class="mcx-study-searchbox">' +
              '<input type="text" class="mcx-study-search" placeholder="Search assignments" value="' + esc(S.taskQuery) + '">' +
              '<svg class="mcx-study-searchicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
                '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20" stroke-linecap="round"/></svg>' +
            '</span>' +
          '</div>' +
          '<div class="mcx-study-list">' + (S.loading === 'tasks' ? loadingHtml(S.loadNote || 'Reading the tasks of this course...') : taskRowsHtml()) + '</div>' +
          mtShowAllHtml(cap) +
          '<p class="mcx-study-hint">Start with the 10 newest and the ones you did not hand in. Search, or show all, for anything older.</p>' +
        '</section>';
    var sec2 = locked
      ? '<section class="mcx-study-sec">' +
          '<h2 class="mcx-study-h">Who to message</h2>' +
          teacherPillsHtml() +
        '</section>'
      : '<section class="mcx-study-sec">' +
          '<h2 class="mcx-study-h">Who to message</h2>' +
          teacherPillsHtml() +
          '<div class="mcx-study-plate">' +
            '<div class="mcx-study-platerow"><span>Course</span><span>' + esc(S.courseName || 'None selected') + '</span></div>' +
            '<div class="mcx-study-platerow"><span>Assessments</span><span class="mcx-study-mtassess">' + esc(pickedTaskList().map(function (t) { return t.name; }).join(', ') || 'None selected') + '</span></div>' +
          '</div>' +
        '</section>';
    bodyEl().innerHTML = sec1 + sec2 +
      '<section class="mcx-study-sec">' +
        '<h2 class="mcx-study-h">Write it</h2>' +
        teacherComposerHtml() +
        '<p class="mcx-study-hint">This writes a draft and keeps it for ' + (locked ? 'this assignment' : 'this course') +
        '. Nothing is sent to your teacher from here, so the last step stays yours.</p>' +
      '</section>';
    footEl().innerHTML = teacherFootHtml();
    var note = bodyEl().querySelector('.mcx-study-mtnote');
    if (note) note.value = S.mtNote;
    var draft = bodyEl().querySelector('.mcx-study-mtdraft');
    if (draft) { draft.value = S.mtDraft; fitTeacherDraft(draft); }
  }

  function teacherFootHtml() {
    var n = mtRows().length;
    var count = S.mtLockTaskId ? 'This assignment' : (n ? n + ' selected' : '');
    return '<span class="mcx-study-count">' + esc(count) + '</span>' +
      '<button type="button" class="mcx-study-primary" data-mt-copy' + (String(S.mtDraft).trim() ? '' : ' disabled') + '>Copy draft</button>';
  }

  /* 每一档要给模型的那一句限定。名字（"Ask to resubmit"）本身太宽，
     模型会拿它当"帮我写一封请求信"的许可，把没在数据里的东西编进去 */
  var MT_INTENT_NOTE = {
    resubmit: 'Ask whether a resubmission would be accepted, and say what you would change. Do not assume a resubmission is allowed.',
    issue: 'Say what is wrong with the submission itself (the file, the timestamp, the status Canvas shows) and ask them to check it.',
    clarify: 'Ask one concrete question about what the assignment asks for, taken from its own words above.',
    followup: 'Keep it short: this follows up on something already said, so do not retell the whole thing.',
    feedback: 'Work from what the teacher actually wrote above. If there is nothing written yet, ask for the feedback instead of reacting to it.',
    grade: 'Ask how the work was scored and what to aim at next. Do not claim marks were lost.'
  };

  function mtTaskLine(r) {
    var bits = [];
    if (r.dueAt) bits.push('was due ' + fmtDate(r.dueAt));
    bits.push(r.done ? 'I submitted it' : 'I did not submit it');
    /* 分数照 Canvas 那一份原样报。以前这里只写"有个成绩"，于是满分 25/25 的作业
       点"问成绩"，模型看不见那个数，就敢写成一封申诉信 */
    if (r.graded && r.score != null && r.points != null) {
      bits.push('Canvas shows ' + fmtPoints(r.score) + ' out of ' + fmtPoints(r.points) + ' points on it');
    } else if (r.graded) bits.push('Canvas shows a grade on it');
    else if (r.done) bits.push('it has no grade on Canvas yet');
    if (r.points != null) bits.push('it is worth ' + r.points + ' points');
    return '- ' + r.name + ' (' + bits.join(', ') + ')';
  }

  /* Canvas 那一份 grade 是字符串，可能是 "16.666667" 也可能是一封信 "A-"：
     数字就收到一位小数（和名单那一列同一个算法），不是数字就原样摆 */
  function mtGradeText(grade) {
    var g = String(grade == null ? '' : grade);
    if (!g) return '';
    var n = Number(g);
    return (g !== '' && !isNaN(n)) ? fmtPoints(n) : g;
  }

  function mtLockedBits() {
    var t = lockedTask(), s = S.mtSub, bits = [];
    var when = (s && s.submittedAt) || (t && t.submittedAt) || '';
    if (when) bits.push('I handed it in on ' + fmtDate(when));
    else bits.push(mtSubStatus() === 'missing' ? 'Canvas marks it missing' : 'Canvas does not show it handed in');
    if (s && s.late) bits.push('it went in late');
    var shown = mtGradeText(s && s.grade);
    if (s && s.state === 'graded' && shown) {
      bits.push('Canvas shows the grade ' + shown + (t.points != null ? ' out of ' + fmtPoints(t.points) : ''));
    } else if (t.graded && t.score != null && t.points != null) {
      bits.push('Canvas shows the grade ' + fmtPoints(t.score) + ' out of ' + fmtPoints(t.points));
    } else bits.push('it has no grade on Canvas yet');
    return bits;
  }

  /* 这一屏只要三到六句话，读进来的资料却可能没边：老师一件批注能贴上几千字，
     一条 rubric 十几行，成绩页那颗还能一次勾上几十条作业。每一块单独封顶，
     削掉多少要在屏上说出来，不许悄悄少带 */
  var MT_LINES_MAX = 20;
  var MT_COMMENTS_MAX = 3;
  var MT_COMMENT_CAP = 400;
  var MT_RUBRIC_MAX = 12;
  var MT_RATING_CAP = 160;
  var MT_NOTE_CAP = 600;

  function teacherPrompt() {
    var rows = mtRows();
    var t = teacherOf(S.teacherId);
    var locked = S.mtLockTaskId ? lockedTask() : null;
    var s = S.mtSub;
    var lines = locked ? [] : rows.slice(0, MT_LINES_MAX).map(mtTaskLine);
    if (!locked && rows.length > MT_LINES_MAX) {
      lines.push('(and ' + (rows.length - MT_LINES_MAX) + ' more not listed here)');
    }
    var head = locked
      ? ['The assignment it is about: ' + (locked.name || 'the one this page shows') + '.',
         'What Canvas says about this submission: ' + mtLockedBits().join(', ') + '.']
      : (rows.length ? ['The assignments it is about, with exactly what Canvas says about each one:'] : []);
    var body = locked ? [] : [lines.join('\n')];

    /* 老师回过的话：有就带原话，没有就一句都不写（"老师没有评论"这种话会让模型去评论"没有评论"这件事） */
    var said = (locked && s && s.comments && s.comments.length)
      ? ['What your teacher wrote back on it, their own words:']
        .concat(s.comments.slice(-MT_COMMENTS_MAX).map(function (c) {
          var text = String(c.text || '').replace(/\s+/g, ' ').trim();
          if (text.length > MT_COMMENT_CAP) text = text.slice(0, MT_COMMENT_CAP) + '... (part cut)';
          return '- ' + text;
        }))
      : [];

    /* rubric：这一屏没有 rubric 时 Canvas 压根不回这个键，那也就一行都不占 */
    var rub = (locked && s && s.rubric && s.rubric.length)
      ? ['The rubric on it, with the points Canvas gave each line:']
        .concat(s.rubric.slice(0, MT_RUBRIC_MAX).map(function (r) {
          var bit = String(r.name || 'a criterion').slice(0, 120);
          if (r.rating) bit += ': ' + String(r.rating).replace(/\s+/g, ' ').trim().slice(0, MT_RATING_CAP);
          if (r.points != null) bit += ' (' + fmtPoints(r.points) + (r.maxPoints != null ? ' out of ' + fmtPoints(r.maxPoints) : '') + ' points)';
          return '- ' + bit;
        }))
        .concat(s.rubric.length > MT_RUBRIC_MAX
          ? ['(and ' + (s.rubric.length - MT_RUBRIC_MAX) + ' more lines not listed here)'] : [])
      : [];

    /* 作业说明：只有"问要求"那一档真的需要它，其余档带上它只会把模型拽去讲题 */
    var ask = '';
    if (locked && S.intent === 'clarify' && locked.description) {
      ask = window.MCxData.htmlToText(locked.description).replace(/\s+/g, ' ').trim();
      if (ask.length > 900) ask = ask.slice(0, 900) + '...';
      ask = ['What the assignment asks for, in its own words (trimmed):', ask];
    } else ask = [];

    var guard = ['Ask, do not accuse. Do not state any fact that is not in the lines above, and do not invent a score.'];
    if (locked) {
      var full = s && s.state === 'graded' && s.score != null && locked.points != null && Number(s.score) >= Number(locked.points);
      if (!full && locked.score != null && locked.points != null && Number(locked.score) >= Number(locked.points)) full = true;
      if (full) {
        guard.push('The grade above is the full total, so this is not a complaint about lost marks: '
          + 'ask what made the work score well and what to aim higher on next time, unless the note below says otherwise.');
      } else if (S.intent === 'grade' && !(s && s.state === 'graded')) {
        guard.push('There is no grade on Canvas for it yet, so ask when to expect feedback rather than asking about marks.');
      }
    }
    var note = MT_INTENT_NOTE[S.intent];
    return [
      'I am a student. Write my Canvas inbox message to my teacher.',
      'Who it goes to: ' + (t ? t.name : 'my teacher') + '.',
      'Course: ' + (S.courseName || 'my course') + '.'
    ].concat(head, body, said, rub, ask, [
      'What it should do: ' + mtIntentLabel() + '.',
      note ? 'For that: ' + note : '',
      window.MCxAi.tonePrompt(S.tone, mtPlayful()),
      S.mtNote ? 'One more thing to work in: ' + String(S.mtNote).slice(0, MT_NOTE_CAP) + '.' : '',
      '',
      'Write in English. Plain text only, no markdown, no subject line, no signature block, nothing in brackets for me to fill in.',
      'Three to six short sentences, in the order: why I am writing, what the lines above say, what I am asking for.'
    ], guard, [
      rows.length || locked ? '' : 'No assignment is listed, so ask which work the message should be about instead of guessing.'
    ]).filter(function (x) { return x !== ''; }).join('\n');
  }

  function makeTeacherDraft() {
    if (S.mtStage === 'waiting') return;
    ensureAccount();
    if (aiKeyState() === 'loading') {
      S.mtErr = 'The AI settings are still being read. Try again in a moment.';
      draw();
      return;
    }
    var cfg = window.MCxAi.config(S.account);
    var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
    if (isCloud && window.MCxAi.hasCloudAccess && !window.MCxAi.hasCloudAccess()) {
      S.mtErr = 'Starting Google sign-in…';
      draw();
      if (window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            S.mtErr = 'Sign-in was cancelled. Try again when you are ready.';
            draw();
          } else {
            S.mtErr = '';
            draw();
            sendTeacherMail();
          }
        });
      }
      return;
    }
    if (!window.MCxAi.canUseSlot(cfg)) {
      S.mtErr = isCloud
        ? 'Sign in under Settings → AI & Plans to use Modern Canvas AI.'
        : 'No key is filled in yet, so nothing can be written. Add one under Settings > AI & Plans.';
      draw();
      return;
    }
    S.model = cfg.model || '';
    if (!S.teacherId && !S.teacherNote) {
      S.mtErr = 'Pick the teacher this goes to first.';
      draw();
      return;
    }
    var gen = ++S.mtGen;
    var cid = S.courseId;
    stopTeacherStream();
    var controller = new AbortController();
    S.mtController = controller;
    S.mtErr = '';
    S.mtDraft = '';
    S.mtStage = 'waiting';
    // S.mtCalls 故意不清：Regenerate 那一趟是加法里的新一项，换掉上一项就成了"重问不花钱"
    draw();
    function dead() { return gen !== S.mtGen || cid !== S.courseId; }
    S.mtPoolUsed = false;
    window.MCxAi.send({
      profile: S.account,
      feature: 'Message to teacher',
      model: cfg.model,
      signal: controller.signal,
      messages: [{ role: 'user', content: teacherPrompt() }],
      onPoolUsed: function (val) {
        if (dead()) return;
        S.mtPoolUsed = !!val;
        draw();
      },
      onUsage: function (u, key) {
        if (dead()) return;
        S.mtCalls = window.MCxAi.usageTrack(S.mtCalls, u, key);
      },
      onDelta: function (piece) {
        if (dead()) return;
        S.mtDraft += String(piece || '');
        /* 一个字一个字只往那一格里写，不重画整屏：重画会把他正在看的那一段滚动位置和
           输入焦点一起弄丢，而且每几个字重建一次整屏就是他自己看着它在闪 */
        var box = bodyEl().querySelector('.mcx-study-mtdraft');
        if (box) { box.value = S.mtDraft; fitTeacherDraft(box); }
      }
    }).then(function (text) {
      if (dead()) return;
      S.mtController = null;
      var out = String(text || '').trim();
      S.mtStage = out ? 'ready' : '';
      S.mtDraft = out;
      if (!out) S.mtErr = 'The model sent back no text at all.';
      draw();
      saveTeacherDraft();
    }, function (err) {
      if (dead()) return;
      S.mtController = null;
      var d = window.MCxAi.describeError(err, window.MCxAi.config(S.account));
      S.mtStage = '';
      S.mtErr = d.code === 'abort' ? '' : 'That one did not go through: ' + d.text;
      draw();
    });
  }

  /* 把在路上那一趟掐掉。换课、Stop、关面板三处都调它：
     光靠 dead() 只是不写画面，请求本身还在跑 */
  function stopTeacherStream() {
    if (S.mtController) {
      try { S.mtController.abort(); } catch (e) {}
      S.mtController = null;
    }
  }

  function stopTeacherDraft() {
    S.mtGen++;
    stopTeacherStream();
    S.mtStage = '';
    saveTeacherDraft();
    draw();
  }

  function copyTeacherDraft() {
    var text = String(S.mtDraft || '');
    var done = function (ok) {
    S.notice = ok ? 'Draft copied. Paste it into your message.'
      : 'Could not copy automatically. Select the draft and copy it.';
      draw();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* ==== 草稿按这一屏留在这里 ====
     一门课一份，键是课号；从提交详情页锁到某一条作业时，键是"课号:作业号"。
     不加分隔的话，同一门课里两条作业的稿子会互相盖掉——那一屏的输入完全是另一条作业。
     存的是这一屏的输入，不是聊天记录，所以不进 mc_ai_chats_v1 那一份库 */
  var MT_KEY = 'mc_ai_teacher_draft';

  function mtKey() {
    return S.mtLockTaskId ? (String(S.courseId || 0) + ':' + String(S.mtLockTaskId)) : String(S.courseId || 0);
  }

  function teacherStore() {
    var all = null;
    try { all = JSON.parse(localStorage.getItem(MT_KEY) || '{}'); } catch (e) { all = null; }
    return all && typeof all === 'object' ? all : {};
  }

  function saveTeacherDraft() {
    if (S.mode !== 'teacher') return;
    var all = teacherStore();
    var k = mtKey();
    var picked = S.mtLockTaskId ? [S.mtLockTaskId]
      : Object.keys(S.pickedTasks).filter(function (id) { return S.pickedTasks[id]; });
    if (!picked.length && !S.mtNote && !S.mtDraft && !S.teacherId) {
      delete all[k];
    } else {
      all[k] = {
        tasks: picked.map(Number), teacher: S.teacherId, intent: S.intent, tone: S.tone,
        playful: mtPlayful(),
        note: S.mtNote, draft: S.mtDraft, at: Date.now()
      };
    }
    try { localStorage.setItem(MT_KEY, JSON.stringify(all)); } catch (e) {}
  }

  function restoreTeacherDraft() {
    var rec = teacherStore()[mtKey()];
    S.teacherId = 0;
    S.mtNote = '';
    S.mtDraft = '';
    S.mtStage = '';
    S.mtErr = '';
    S.mtTouched = false;
    S.intent = mtIntentRows()[0][0];
    S.tone = mtTones()[0][0];
    S.playful = null;
    if (!rec) { mtPreselectIntent(); return; }
    if (rec.intent) S.intent = String(rec.intent);
    if (rec.tone) S.tone = String(rec.tone);
    /* 这一格要过一遍 playfulPct：存进来的可能是空、可能是别的版本留下的字符串，
       直接 String 出来再画进 value="" 就是一颗停在最左边的滑块 */
    S.playful = window.MCxAi.playfulPct(rec.playful, window.MCxAi.playfulDefault);
    S.mtNote = String(rec.note || '');
    S.mtDraft = String(rec.draft || '');
    S.teacherId = Number(rec.teacher) || 0;
    S.pickedTasks = {};
    (Array.isArray(rec.tasks) ? rec.tasks : []).forEach(function (id) {
      var n = Number(id);
      if (n) S.pickedTasks[n] = true;
    });
    if (S.mtDraft) S.mtStage = 'ready';
  }

  /* 翻页读数那一行：只换字，不重建整屏（和 paintProgress 同一个理由） */
  function paintLoadNote() {
    var host = bodyEl().querySelector('.mcx-study-loading-text');
    if (host && S.loadNote) host.textContent = S.loadNote;
  }

  /* 读到第几条那一行：只换它那一句字。整屏重建会让那一行闪一下，
     而且选中的文件多时就是"每读完一条重建一次画面" */
  function paintProgress() {
    // 面板收起在背后写的那一趟不许重排：字照样往 S.turns 里落，点开面板那一趟 draw 一次画全
    if (!S.open) return;
    var host = bodyEl().querySelector('.mcx-study-loading-text');
    if (S.readNote) {
      if (host) { host.textContent = S.readNote; return; }
      draw();
      return;
    }
    // 摘的是那一整块转圈：它是 .mcx-study-loading-text 爸爸的爸爸，
    // 从它自己身上摘它自己只会在 onDelta 那一刻抛一句 NotFoundError，甩在结果屏上
    var plate = host.parentNode;
    if (plate && plate.parentNode) plate.parentNode.removeChild(plate);
  }

  /* 流式回字时的重排节律：第一笔立刻画，之后最多每 140ms 一趟。
     一有字就重排会在长回答上把主线程占满，全部延后又会让人觉得它没在动 */
  var paintLate = 0;
  var paintAt = 0;

  function paintResultSoon() {
    var now = Date.now();
    if (now - paintAt >= PAINT_EVERY) {
      if (paintLate) { clearTimeout(paintLate); paintLate = 0; }
      paintAt = now;
      paintResult();
      return;
    }
    if (!paintLate) {
      paintLate = setTimeout(function () {
        paintLate = 0;
        paintAt = Date.now();
        paintResult();
      }, PAINT_EVERY);
    }
  }

  function citeOf(tag) {
    var s = sourceFor(tag);
    if (!s) return null;
    return { title: s.title + (s.module ? ', ' + s.module : ''), url: s.url };
  }

  /* 这一条会话是不是练习那一档。从库里翻出来的那一条认它自己存下的档，
     现跑的那一条认手上这一排药丸——两个都可能不是 S.template（他在设置完模板后又去翻了旧聊天） */
  function practiceSession() {
    return ((S.session && S.session.template) || S.template) === 'practice';
  }

  function looksLikeJson(text) {
    var s = String(text == null ? '' : text).trim();
    return s.charAt(0) === '{';
  }

  /* 只有第一轮才是题集。追问那些轮哪怕复述了半句 JSON 也不许变成第二套题。
     判过一次就把结果挂在轮次自己身上：流式每 140ms 重画一趟，不能每趟都整段 parse */
  function quizOf(turn, i) {
    if (i !== 0 || !practiceSession() || !window.MCxPractice) return null;
    if (!S.running && turn.quiz !== undefined && turn.quiz !== null) return turn.quiz;
    if (!S.running && turn.quiz === null) return null;
    // 正在回字的那几趟：只要开始回 JSON，就尝试按流式容错（至少 1 题）解析出已经生成完的题目
    if (S.running) {
      if (!looksLikeJson(turn.a)) return turn.quiz || null;
      var partial = window.MCxPractice.parse(turn.a, citationSources(), 1);
      if (partial.ok) {
        // 只有当新解析出的题目数大于等于先前解析出的题目数时才更新，防止局部失效回退
        if (!turn.quiz || (partial.quiz && partial.quiz.questions && partial.quiz.questions.length >= (turn.quiz.questions ? turn.quiz.questions.length : 0))) {
          turn.quiz = partial.quiz;
        }
        return turn.quiz;
      }
      // 如果这一小段 delta 刚好处于未闭合中间态，保留之前已经解析出来的题目，绝不退回 null 导致题目消失
      return turn.quiz || null;
    }
    var out = window.MCxPractice.parse(turn.a, citationSources());
    if (out.ok) {
      turn.quiz = out.quiz;
      return turn.quiz;
    }
    // 只有在流式彻底结束之后，才把失败结果定死为 null；跑动中保持未决，等流完最后再试
    if (!S.running) {
      turn.quiz = null;
    }
    return null;
  }

  function practiceOptions(turn) {
    return {
      courseId: S.courseId,
      state: turn,
      progress: window.MCxProgress || null,
      sourceOf: function (tag) {
        var s = sourceFor(tag);
        if (!s) return null;
        return { title: s.title, module: s.module, url: s.url };
      },
      onAttempt: function (rec) {
        if (!window.MCxProgress) return;
        var out = window.MCxProgress.recordAttempt(S.courseId, rec);
        // 记成没成看两头：ok 是这一笔接不接受，saved 是那一本有没有落到库里
        if (out.ok && out.saved !== false) { progressNote = ''; return; }
        /* 库里那本账还没读到过时这一笔会被挡下来（那等于拿"只有这一条"的账去盖整本），
           它自己会补发一次读数。所以这里等那一趟回来再记一次：
           他答完的那一题不该因为读数晚到就白答 */
        if (!out.ok && window.MCxProgress.hydrate && /not been read/.test(String(out.error || ''))) {
          window.MCxProgress.hydrate().then(function (h) {
            if (!h || !h.ok) return;
            var again = window.MCxProgress.recordAttempt(S.courseId, rec);
            progressNote = (again.ok && again.saved !== false) ? ''
              : 'This answer was not added to your review queue: ' + (again.error || again.reason || 'the write did not go through') + '.';
            paintReviewStat();
          }, function () {});
          return;
        }
        progressNote = 'This answer was not added to your review queue: '
          + (out.error || 'the write did not go through') + '.';
        paintReviewStat();
      },
      // 答完一题只重画底下那一句状态，绝不 draw()：整屏重建会把他刚答的那些卡换掉
      onChanged: paintReviewStat
    };
  }

  function renderAnswer(host, turn, i) {
    var quiz = quizOf(turn, i);
    if (quiz) {
      // 题目数量有变化或尚未渲染时，刷新渲染；若已渲染且题目数未增多，不要每次 140ms 流式重画清空用户正在输入的作答
      var qCount = quiz.questions ? quiz.questions.length : 0;
      if (host.mcxQuiz === quiz && host.mcxQCount === qCount) return;
      host.mcxQuiz = quiz;
      host.mcxQCount = qCount;
      window.MCxPractice.render(host, quiz, practiceOptions(turn));
      return;
    }
    host.mcxQuiz = null;
    host.mcxQCount = 0;
    // 如果是练习题生成中，但第一道题还没写完闭合，不展示满屏乱跑的 JSON 代码，展示优雅出题动画
    if (i === 0 && practiceSession() && S.running) {
      host.innerHTML = '<div class="mcx-study-loading" style="padding: 24px 0;"><span class="mcx-study-spin" data-late="1"></span><span class="mcx-study-loading-text">Generating questions based on your course material…</span></div>';
      return;
    }
    if (formatOn() && window.MCxFormat) {
      window.MCxFormat.render(host, turn.a, { cite: citeOf });
      return;
    }
    host.textContent = '';
    var box = document.createElement('div');
    box.className = 'mcx-f-plain';
    box.textContent = turn.a;
    host.appendChild(box);
  }

  /* 一轮一个块。已经说完的那几轮不重画，只重画最后正在流的那一块：
     整段重建会把上面每一轮的重排和 hover 都打断一次，而流式每 140ms 就来一趟 */
  function paintResult() {
    // 面板收起时不重排（背后那一趟靠这里省下每 140ms 一次 markdown 重排）：
    // 每一笔字都照样落在 S.turns 上，他点开面板那一趟 draw 一次画全
    if (!S.open) return;
    var host = bodyEl().querySelector('.mcx-study-out');
    if (!host) return;
    var need = S.turns.length;
    while (host.children.length > need) host.removeChild(host.lastChild);
    for (var i = 0; i < need; i++) {
      var turn = S.turns[i];
      var node = host.children[i];
      var fresh = !node;
      if (fresh) {
        node = document.createElement('div');
        node.className = 'mcx-f-turn';
        node.innerHTML = '<div class="mcx-f-q"></div><div class="mcx-f-pool"></div><div class="mcx-f-a"></div><div class="mcx-f-use"></div>';
        host.appendChild(node);
      }
      var q = node.querySelector('.mcx-f-q');
      q.textContent = turn.q || '';
      q.style.display = turn.q ? '' : 'none';
      var poolEl = node.querySelector('.mcx-f-pool');
      if (poolEl) {
        var isTurnBusy = !!turn.busy;
        poolEl.innerHTML = (isTurnBusy && (turn.poolUsed || (window.MCxAi && window.MCxAi.isPoolRouting && window.MCxAi.isPoolRouting())) && window.MCxAi && window.MCxAi.poolNoticeHtml) ? window.MCxAi.poolNoticeHtml() : '';
        poolEl.style.display = (isTurnBusy && poolEl.innerHTML) ? '' : 'none';
      }
      if (fresh || i === need - 1) renderAnswer(node.querySelector('.mcx-f-a'), turn, i);
      var useNode = node.querySelector('.mcx-f-use');
      if (useNode) {
        if (fresh || i === need - 1) useNode.textContent = turnUseText(turn);
        useNode.style.display = useNode.textContent ? '' : 'none';
      }
    }
    paintSources();
    paintReviewStat();
    /* 整场对话的累计挂在最后一轮底下：那是他刚看完的地方，也是他决定要不要接着问的地方 */
    var chatUse = bodyEl().querySelector('.mcx-study-use');
    if (chatUse) {
      var chatTxt = chatUseText();
      chatUse.textContent = chatTxt;
      chatUse.hidden = !chatTxt;
    }
    // 会滚的是外面那一层，不是这一段文字。而且只有他本来就停在底下时才跟着走：
    // 他翻上去看前面那一轮的时候不许每次回字都把他拽回来；练习题出题时也不拽滚轮，允许他在顶部安心看题作答
    var scroller = bodyEl();
    if (!practiceSession() && S.running && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  /* 出处表用我们自己那份清单画，不靠模型复述：它写 [R3] 或 [R3-C2] 的时候对的就是这一份，
     标题和地址从这份里取，模型那边一个字都不用信。
     片的号归回整份那一行，屏幕上是一列资料，不是一列片号 */
  function citedTags() {
    var rows = {};
    var out = [];
    S.turns.forEach(function (t) {
      (String(t.a || '').match(/\[R\d{1,3}(?:-C\d{1,3})?\]/g) || []).forEach(function (raw) {
        var tag = raw.slice(1, -1);
        var m = /^R(\d{1,3})(?:-C(\d{1,3}))?$/.exec(tag);
        if (!m) return;
        var base = 'R' + m[1];
        if (!S.sources[base]) return;
        var row = rows[base];
        if (!row) { row = rows[base] = { tag: base, parts: [] }; out.push(row); }
        if (m[2] && row.parts.indexOf('C' + m[2]) < 0) row.parts.push('C' + m[2]);
      });
    });
    out.sort(function (a, b) { return Number(a.tag.slice(1)) - Number(b.tag.slice(1)); });
    return out;
  }

  /* 一个标签指向哪一份资料：先按整份那个号认，退一步才认片号（[R3-C2] 认回 R3）。
     角标、出处表、练习那一档、引用核对四处都从这里取，别各写一份切法 */
  function sourceFor(tag) {
    if (!tag) return null;
    var s = S.sources[tag];
    if (s) return s;
    var base = '';
    var m = /^R(\d{1,3})(?:-C(\d{1,3}))?$/.exec(String(tag).trim());
    if (m) base = 'R' + m[1];
    return base ? (S.sources[base] || null) : null;
  }

  /* 交给"验标签对不对"那两头的一份表：整份的号加上每一片的号。
     片的号是当场算出来的别名，不落库，也不改变 S.sources 自己的形状 */
  function citationSources() {
    var map = {};
    Object.keys(S.sources).forEach(function (tag) {
      var s = S.sources[tag];
      map[tag] = s;
      (s.parts || []).forEach(function (p) {
        if (p && p.tag) map[p.tag] = s;
      });
    });
    return map;
  }

  /* 结果屏顶上那一格：这一趟到底送了什么出去。
     报的是发出去之前已经量到的数，不是模型自己说它看了多少 */
  function sentPlateHtml() {
    var c = S.ctx;
    if (!c) return '';
    function row(k, v) {
      return '<div class="mcx-study-platerow"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>';
    }
    var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
    var sent = plural(c.sentItems, 'item') + ' · ' + plural(c.parts, 'part') + ' sent';
    var cov = c.concepts
      ? c.covered + ' of ' + c.concepts + ' exam points have material behind them'
        + (c.weak ? ', ' + c.weak + ' thin' : '')
      : 'No exam points could be read from the selected tasks';
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    return '<div class="mcx-study-plate mcx-study-sent">' +
      row('Selected', plural(c.items, 'item')) +
      row('Sent to the model', sent) +
      row('Exam points', cov) +
      (isCloud ? '' : row('Text sent', 'about ' + fmtNum(c.tokens) + ' input tokens')) +
      (isCloud ? '' : usageRow(row)) +
      '</div>';
  }

  /* 只有服务自己在回包里带了计数才画这一行。
     它没带就一行都不多：屏上那个数必须是它数的，不能是我们替它数的。
     行本身交给调用方那颗 row，这里不另搭一份摆法 */
  function usageRow(row) {
    var a = window.MCxAi;
    if (a && a.isCloudMode && a.isCloudMode()) return '';
    var u = S.usage;
    if (!u || (!u.prompt && !u.completion && !u.total)) return '';
    var bits = [];
    if (u.prompt) bits.push(fmtNum(u.prompt) + ' in');
    if (u.completion) bits.push(fmtNum(u.completion) + ' out');
    if (u.total && (!u.prompt || !u.completion)) bits.push(fmtNum(u.total) + ' total');
    if (!bits.length) return '';
    return row('Provider-reported usage', bits.join(' · ') + ' tokens');
  }

  var COV_LABEL = { covered: 'Covered', weak: 'Needs checking', none: 'No evidence found' };

  /* 覆盖那一格：每个考点一行，点开来是对得上的那一份资料里的原文摘录。
     没有检索数据（旧的历史、按顺序拼那一条退路）时整格不画，屏上不该多出一排空标题 */
  function paintCoverage() {
    var host = bodyEl().querySelector('.mcx-study-coverage');
    if (!host) return;
    host.textContent = '';
    var rows = S.coverage;
    if (!rows || !rows.length) return;
    var head = document.createElement('div');
    head.className = 'mcx-f-srchead';
    head.textContent = 'What the selected materials cover';
    host.appendChild(head);
    rows.forEach(function (c, i) {
      var open = !!S.openCov[i];
      var canOpen = c.status !== 'none' && (c.parts || []).length > 0;
      var row = document.createElement('div');
      row.className = 'mcx-cov-row is-' + c.status + (canOpen ? ' is-openable' : '') + (open ? ' is-open' : '');
      var name = document.createElement('span');
      name.className = 'mcx-cov-name';
      name.textContent = c.name;
      row.appendChild(name);
      var tag = document.createElement('span');
      tag.className = 'mcx-cov-state';
      tag.textContent = COV_LABEL[c.status] || c.status;
      row.appendChild(tag);
      if (canOpen) {
        row.setAttribute('data-cov', String(i));
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      host.appendChild(row);
      if (!open) return;
      var detail = document.createElement('div');
      detail.className = 'mcx-cov-detail';
      c.parts.forEach(function (p) {
        var src = document.createElement('div');
        src.className = 'mcx-cov-src';
        var label = document.createElement((p.url && /^https?:\/\//i.test(String(p.url))) ? 'a' : 'span');
        label.className = 'mcx-cov-link';
        label.textContent = (p.module ? p.module + ' / ' : '') + p.title + '  [' + p.tag + ']';
        if (label.tagName === 'A') {
          label.href = p.url;
          label.target = '_blank';
          label.rel = 'noopener noreferrer';
        }
        src.appendChild(label);
        detail.appendChild(src);
        if (p.excerpt) {
          var q = document.createElement('div');
          q.className = 'mcx-cov-quote';
          q.textContent = p.excerpt;
          detail.appendChild(q);
        }
      });
      host.appendChild(detail);
    });
    var hint = document.createElement('p');
    hint.className = 'mcx-study-hint mcx-cov-hint';
    hint.textContent = 'The selected materials do not cover this point. It may appear in other course materials or class discussion.';
    host.appendChild(hint);
  }

  function toggleCoverageAt(i) {
    var c = (S.coverage || [])[i];
    if (!c || c.status === 'none' || !(c.parts || []).length) return;
    // 展开状态按那一格的位子记，不按考点名记：名字是从考纲里抽出来的，重复一个就把另一格顶开了
    if (S.openCov[i]) delete S.openCov[i];
    else S.openCov[i] = 1;
    paintCoverage();
  }

  /* ==== 引用可信度 ====
     只回答"这个号能不能映射回我们发出去的那份清单"这一件事。
     它写的任何事实都不判，判不了也不该判。 */
  function citationTrust() {
    var R = window.MCxRetrieval;
    if (!R || !S.turns.length) return null;
    // 流式途中不报：那时引用还没写完，每 140ms 重画会让那两句闪
    if (S.running) return null;
    var text = S.turns.map(function (t) { return t.a || ''; }).join('\n');
    if (!String(text).trim()) return null;
    var out = R.validateCitations(text, citationSources());
    var sentAny = Object.keys(S.sources).length > 0;
    return {
      invalid: out.invalid,
      // 一个字都没引对，且这一趟确实发过材料：那才值得提醒他去对课件
      unmatched: sentAny && !out.anyValid,
      repeats: out.repeats
    };
  }

  function paintSources() {
    var host = bodyEl().querySelector('.mcx-study-sources');
    if (!host) return;
    // 纯文字那一档也照样列：那一句里 [R3] 还是原样写着字，底下这张表才让人对得上是哪一份
    var cited = citedTags();
    host.textContent = '';
    var trust = citationTrust();
    if (!cited.length && !trust) return;
    var head = document.createElement('div');
    head.className = 'mcx-f-srchead';
    head.textContent = 'Sources';
    host.appendChild(head);
    if (trust && trust.unmatched) {
      var warn0 = document.createElement('div');
      warn0.className = 'mcx-f-srcwarn';
      warn0.textContent = 'This answer has no citations from the selected materials. Check it against your course materials.';
      host.appendChild(warn0);
    }
    cited.forEach(function (row) {
      var s = S.sources[row.tag];
      // 地址是模块条目里带回来的，认协议再挂链接：这一屏是我们自己的节点，不能什么串都进 href
      var link = /^https?:\/\//i.test(String(s.url || '')) ? s.url : '';
      var line = document.createElement('div');
      line.className = 'mcx-f-src';
      var chip = document.createElement('span');
      chip.className = 'mcx-f-cite';
      chip.textContent = row.tag;
      line.appendChild(chip);
      var name = document.createElement(link ? 'a' : 'span');
      name.className = 'mcx-f-srcname';
      name.textContent = (s.module ? s.module + ' / ' : '') + s.title;
      if (link) {
        name.href = link;
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
      }
      line.appendChild(name);
      if (row.parts.length) {
        var parts = document.createElement('span');
        parts.className = 'mcx-f-srcparts';
        parts.textContent = 'Sections ' + row.parts.slice(0, 6).join(', ');
        line.appendChild(parts);
      }
      host.appendChild(line);
    });
    /* 它编出来的号只在它那一头存在，我们这份清单里没有。
       这句不判对错，只报"对不回材料"，因为除了对不回别的什么都判不了 */
    if (trust && trust.invalid.length) {
      var warn = document.createElement('div');
      warn.className = 'mcx-f-srcwarn';
      warn.textContent = 'Some citations do not match the materials you selected.';
      host.appendChild(warn);
      var which = document.createElement('div');
      which.className = 'mcx-f-srcwarn mcx-f-srcwarn-tags';
      which.textContent = trust.invalid.slice(0, 8).join('  ');
      host.appendChild(which);
    }
  }

  /* 结果屏底下那一句学习状态。报的是"用户看得见的那件事"：现在有几题该复习、几题掌握了。
     一题都没答过就不画这一行，屏幕底下不该挂一句"0 to review"。
     存的账读不出（配额满了、别的标签页把这本账写坏了）时这一行也只是不画，
     不许在这一处抛错把整屏带走。 */
  var progressNote = '';

  function reviewStatText() {
    var head = progressNote ? progressNote + ' ' : '';
    if (!window.MCxProgress || !S.courseId) return head;
    var n;
    try { n = window.MCxProgress.summary(S.courseId); } catch (e) { return head; }
    if (!n || !n.practiced) return head;
    var bits = [];
    if (n.dueNow) bits.push(n.dueNow + ' to review now');
    if (n.mastered) bits.push(n.mastered + ' learned');
    if (n.uncertain) bits.push(n.uncertain + ' unsure');
    if (n.weak) bits.push(n.weak + ' to go over again');
    if (!bits.length) bits.push(n.practiced + ' question' + (n.practiced === 1 ? '' : 's') + ' practised');
    return head + 'This course: ' + bits.join(', ') + '.';
  }

  function paintReviewStat() {
    var line = bodyEl().querySelector('.mcx-practice-coursestat');
    if (!line) return;
    var txt = reviewStatText();
    line.textContent = txt;
    line.hidden = !txt;
  }

  /* ==== 追问要发出去的那一份 ====
     两条路，措辞和价钱都不同，所以只留一个出口函数：
     - 刚跑完的这一条：用当时那份完整 prompt（课件正文在里面），后面接上已经说过的那几轮
     - 从历史里翻出来的一条（A 路线）：不重新读课件，只把这份总结和后面的问答带上去 */
  function threadTail() {
    var out = [];
    S.turns.forEach(function (t) {
      // 只带答完的那些轮：手上这一轮的问句下面会以"新问的那一句"再发一次，
      // 两边都发就成了同一句话问两遍
      if (!t.a) return;
      if (t.q) out.push({ role: 'user', content: t.q });
      out.push({ role: 'assistant', content: t.a });
    });
    return out;
  }

  function summaryHead() {
    var tpl = TEMPLATES.filter(function (x) { return x.id === ((S.session || {}).template); })[0];
    return 'Course: ' + (S.courseName || 'a course in Canvas') + '\n'
      + 'Saved chat: ' + ((S.session || {}).title || 'an earlier summary') + '\n\n'
      + 'Below is a study summary the student made earlier from course material, and what they asked after it. '
      + 'The material itself is not attached to this one. Answer from the summary and the conversation, '
      + 'and say in one line when a question needs the original material to answer properly.'
      + (tpl ? '\nWhat that summary was asked for: ' + tpl.ask : '');
  }

  function followMessages(q) {
    var head = (S.baseMessages && S.baseMessages.length)
      ? S.baseMessages
      : [{ role: 'system', content: GROUND_RULE + ' ' + (formatOn() ? FORMAT_RULE : PLAIN_RULE) },
        { role: 'user', content: summaryHead() }];
    var ask = String(q == null ? '' : q);
    /* 练习那一档发出去的那一份里写着"只回一个 JSON 对象"，追问要是照那个形状回，
       这一屏就多出第二套题，而他问的只是其中一句。所以这里当场说明：接着问照普通文字回 */
    if (practiceSession()) ask += '\n\nAnswer this in ordinary prose, not as the practice JSON.';
    return head.concat(threadTail()).concat([{ role: 'user', content: ask }]);
  }

  /* 价钱直接量"这一问真发出去的那一份"，不再另算一套：
     两处口径不一样的话，屏幕上那个数就成了摆设 */
  function followEstimate() {
    var msgs = followMessages(S.askText || 'x');
    var chars = msgs.reduce(function (n, m) { return n + String(m.content || '').length; }, 0);
    return { chars: chars, tokens: window.MCxData ? window.MCxData.estimateTokens(chars) : 0 };
  }

  function costLine() {
    var a = window.MCxAi;
    if (a && a.isCloudMode && a.isCloudMode()) return '';
    var n = fmtNum(followEstimate().tokens);
    return (S.baseMessages && S.baseMessages.length)
      ? 'Your question goes out with the same course material again, roughly ' + n + ' tokens.'
      : 'Continuing from this summary without reloading original materials, roughly ' + n + ' tokens.';
  }

  /* ==== 会话壳子与落库 ====
     只在"这一轮真落了字"的时候写一次。流式途中不写：那等于每 140ms 往扩展存储里灌一整份历史 */
  function sessionTitle() {
    var tpl = TEMPLATES.filter(function (x) { return x.id === S.template; })[0] || TEMPLATES[0];
    var bits = [tpl.label, S.courseName || 'Course'];
    var names = pickedTaskList().map(function (t) { return t.name; });
    if (names.length) bits.push(names[0] + (names.length > 1 ? ' and ' + (names.length - 1) + ' more' : ''));
    return bits.join(' · ');
  }

  /* 落库存的是覆盖表，不是课件。每格最多留两条、每条摘录削到 240 字：
     完整正文永远不进那一格，展开时看的那一句够他对上原文就行。 */
  function compactCoverage() {
    if (!S.coverage || !S.coverage.length) return null;
    return S.coverage.slice(0, 12).map(function (c) {
      return {
        name: String(c.name || '').slice(0, 160),
        status: c.status,
        parts: (c.parts || []).slice(0, 2).map(function (p) {
          return {
            title: String(p.title || '').slice(0, 200),
            module: String(p.module || '').slice(0, 200),
            tag: String(p.tag || '').slice(0, 16),
            url: String(p.url || '').slice(0, 500),
            excerpt: String(p.excerpt || '').slice(0, 240)
          };
        })
      };
    });
  }

  /* 进库存的只有每一趟报回来的那几个数本身：牌号（key）只在这屏内存里用来把同一趟的
     流式帧归成一项，存进库没有意义。库里那一格也可能是旧的单个 usage 对象，
     ai-client 那颗加法两种形状都认，所以读回来不用换算 */
  function callsForStore(calls) {
    return (Array.isArray(calls) ? calls : []).slice(0, 40).map(function (c) {
      return c && c.usage ? c.usage : c;
    }).filter(function (u) { return u && typeof u === 'object'; });
  }

  function callsFromRows(rows) {
    return (Array.isArray(rows) ? rows : []).slice(0, 40).filter(function (u) { return u && typeof u === 'object'; });
  }

  function persistSession() {
    if (!window.MCxHistory) return;
    var last = S.turns[S.turns.length - 1];
    if (!last || !last.a) return;
    var now = Date.now();
    if (!S.session) {
      S.session = {
        id: 'c' + now.toString(36) + Math.random().toString(36).slice(2, 7),
        courseId: S.courseId,
        courseName: S.courseName || '',
        title: sessionTitle(),
        template: S.template,
        createdAt: now,
        updatedAt: now,
        assessments: pickedTaskList().map(function (t) { return t.name; })
      };
    }
    S.session.turns = S.turns.map(function (t) {
      return { q: t.q || '', a: t.a, model: t.model || '', calls: callsForStore(t.calls), poolUsed: !!t.poolUsed };
    });
    // 整场的加法单独存一份：被 Again 换掉的那一轮已经不在 turns 里了，它的钱得留在这一格
    S.session.calls = callsForStore(S.calls);
    S.session.sources = S.sources;
    // 覆盖表存一份压缩的（考点名、状态、两条摘录），正文一个字都不进库
    S.session.coverage = compactCoverage();
    S.session.sent = S.ctx ? {
      items: S.ctx.items, sentItems: S.ctx.sentItems, parts: S.ctx.parts,
      concepts: S.ctx.concepts, covered: S.ctx.covered, weak: S.ctx.weak,
      missing: (S.ctx.missing || []).slice(0, 12), tokens: S.ctx.tokens
    } : null;
    S.session.updatedAt = now;
    var out = window.MCxHistory.save(S.session, S.session.id);
    // 刚生成这一条也算"上次在看的那一条"：重新进页面时面板回到的是它，不是空白的新屏
    rememberChat(S.session.id);
    // 存不下也要说：屏幕上答案还在，库里没有这一条，他下次来找就找不到了
    if (!out.ok) {
      S.notice = 'Your answer is still here, but the chat could not be saved. ' + out.error;
      return;
    }
    // 落库是异步的：这一屏先照旧写着，真没写进去再补那一句，不许把刚拿到的答案撤掉
    if (out.done) out.done.then(function (res) {
      if (res && res.ok) return;
      var live = bodyEl().querySelector('.mcx-study-out');
      if (!live || !S.turns.length) return;
      S.notice = 'Your answer is still here, but this chat was not added to saved chats. '
        + String((res && res.error) || 'The extension could not save it.');
      // 那一句挂在 notice 那一块上，只有整屏重画才画得出来；还在流字的时候不重画，那会打断回字
      if (S.pane === 'result' && !S.running) draw();
    });
  }

  /* 上次在看的那一条。重新进页面时面板第一次点开就回到它，不再每次都从"新的一屏"开始；
     只在这一页第一次点开时回来一次，之后他自己按了 New chat 就不再抢 */
  var lastChatTried = false;

  function rememberChat(id) {
    if (!id) return;
    try { localStorage.setItem('mc_ai_last_chat', String(id)); } catch (e) {}
  }

  function restoreLastChat() {
    if (lastChatTried) return false;
    // 背后还在写的那一趟优先：openSession 会 cancelRun()，从库里翻旧会话等于把这一趟掐了
    if (S.running) return false;
    var id = localStorage.getItem('mc_ai_last_chat');
    if (!id || !window.MCxHistory || !window.MCxHistory.get) return false;
    if (!window.MCxHistory.get(id)) return false;
    lastChatTried = true;
    openSession(id);
    return true;
  }

  function openSession(id) {
    var s = window.MCxHistory ? window.MCxHistory.get(id) : null;
    if (!s) {
      S.notice = 'This chat is no longer in your saved chats.';
      draw();
      return;
    }
    cancelRun();
    rememberChat(id);
    S.session = s;
    S.turns = s.turns.map(function (t) {
      return { q: t.q || '', a: t.a || '', model: t.model || '', calls: callsFromRows(t.calls), poolUsed: !!t.poolUsed };
    });
    /* 整场那一份优先读库里新存的这一格；旧会话没有这一格，就从各轮自己的数拼回来，
       那样至少这一屏那句加法说的还是它存过的那几趟 */
    S.calls = callsFromRows(s.calls);
    if (!S.calls.length) {
      S.calls = [];
      S.turns.forEach(function (t) { t.calls.forEach(function (u) { S.calls.push(u); }); });
    }
    S.sources = s.sources || {};
    /* 旧的那一条库里没有覆盖表（那是后来才存的），这一格就整个不画。
       不许给历史里的会话编一排"考点状态"，也不许让它看起来像没做过检索 */
    S.coverage = Array.isArray(s.coverage) && s.coverage.length ? s.coverage : null;
    S.ctx = s.sent || null;
    S.openCov = {};
    S.retrievalNote = '';
    // A 路线：这份总结没有当时那份课件，追问只带总结本身，所以这里必须清干净
    S.baseMessages = null;
    S.result = (S.turns[S.turns.length - 1] || {}).a || '';
    S.fromHistory = true;
    /* 窄的那一档这一条是从名单那一屏进来的，返回箭头要带回得去的地方；
       宽的那一档名单一直摆在左边那一列，那只箭头只会把他送回一个已经看得见的东西 */
    S.backPane = railShown() ? 'tasks' : 'history';
    S.askText = '';
    S.notice = '';
    S.readNote = '';
    S.pane = 'result';
    draw();
  }

  function deleteSession(id) {
    var s = window.MCxHistory ? window.MCxHistory.get(id) : null;
    if (!s) return;
    window.MCxHistory.remove(id);
    if (S.session && S.session.id === id) S.session = null;
    S.notice = 'Deleted “' + s.title + '”.';
    draw();
  }

  /* 回去要去的那一屏：历史那一屏自己不算一步，
     而且要是那一屏已经空了（换过课、轮次被清掉），回去就是对着空白，不如回第一屏 */
  function historyBackPane() {
    var back = S.historyBack && S.historyBack !== 'history' ? S.historyBack : 'tasks';
    if (back === 'result' && !S.turns.length) back = 'tasks';
    if (back === 'resources' && !S.resources.length && !S.courseId) back = 'tasks';
    return back;
  }

  /* 那颗时钟是开关：已经在这屏再点一次就该回去。
     不然它亮着却按不动，只能去摸底部那个返回箭头 */
  function openHistory() {
    /* 宽的那一档那一份名单一直摆在左边那一列，这一颗翻的就是那一列开不开。
       两档共用同一颗键，但走的是两条道：那一屏在这一档没有存在的必要 */
    if (isWide()) {
      if (S.pane === 'history') S.pane = historyBackPane();
      setRailOn(!S.railOn);
      return;
    }
    if (S.pane === 'history') {
      S.pane = historyBackPane();
      S.notice = '';
      draw();
      return;
    }
    // 进去那一段和侧栏那一行点开是同一份定义，不另写一遍
    showHistory();
  }

  function chatGroup(ms) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    if (ms >= today.getTime()) return 'Today';
    if (ms >= today.getTime() - 7 * 86400000) return 'Previous 7 days';
    return 'Earlier';
  }

  /* 存过会话的那些课，条数多的排前面。一门课一颗药丸：点一下只看它，再点一下回到全部。
     默认（一颗都不按）就是全部，所以这里不造"全部"那一档——它不是一个筛子，是不筛的那个状态。
     课号一律按字符串存：没有课号的那批存的是 "0"，它必须和"没在筛"那一个状态分得开 */
  function historyCourses() {
    var rows = window.MCxHistory ? window.MCxHistory.list() : [];
    var by = {};
    var order = [];
    rows.forEach(function (s) {
      var cid = String(Number(s.courseId) || 0);
      var hit = by[cid];
      if (!hit) {
        hit = by[cid] = { id: cid, name: String(s.courseName || '') || (cid !== '0' ? 'Course ' + cid : 'No course'), count: 0 };
        order.push(hit);
      }
      hit.count++;
    });
    return order.sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
  }

  function historyList() {
    var h = window.MCxHistory;
    if (!h) return [];
    return S.chatCourse === null ? h.list() : h.forCourse(Number(S.chatCourse));
  }

  function historyRows(viewRows) {
    var rows = viewRows || historyList();
    var html = '';
    var last = null;
    rows.forEach(function (s) {
      var g = chatGroup(s.updatedAt);
      if (g !== last) {
        last = g;
        html += '<div class="mcx-study-mod">' + esc(g) + '</div>';
      }
      var turns = s.turns.length;
      var model = (s.turns[turns - 1] || {}).model || '';
      var a = window.MCxAi;
      var isCloud = a && a.isCloudMode && a.isCloudMode();
      var modelTag = (!isCloud && model) ? (' · ' + esc(model)) : '';
      // 没筛的时候这一列里混着几门课，那一句课名就是他分得开的唯一线索
      var courseTag = (!S.chatCourse && s.courseName) ? (' · ' + esc(s.courseName)) : '';
      html += '<div class="mcx-study-row' + (S.session && S.session.id === s.id ? ' is-on' : '') + '" data-chat="' + esc(s.id) + '">' +
        '<span class="mcx-study-rowmain">' + esc(s.title) +
          '<span class="mcx-study-kind">' + turns + (turns === 1 ? ' turn' : ' turns') +
            modelTag + courseTag + '</span></span>' +
        '<span class="mcx-study-rowside">' + esc(fmtDate(s.updatedAt)) + '</span>' +
        '<button type="button" class="mcx-study-del" data-del-chat="' + esc(s.id) + '" aria-label="Delete this chat">' + svg(ICONS.trash) + '</button>' +
        '</div>';
    });
    return html;
  }

  function historyProgressCard(courseId, courseName) {
    if (!window.MCxProgress) return '';
    var cid = Number(courseId) || 0;
    var summ;
    try { summ = window.MCxProgress.summary(cid); } catch (e) { return ''; }
    if (!summ) return '';
    var label = cid ? (courseName || ('Course ' + cid)) : 'All courses';
    var isFiltered = !!cid;

    if (!summ.practiced) {
      return '<div class="mcx-history-progress">' +
        '<div class="mcx-history-progress-head">' +
          '<span class="mcx-history-progress-title">' + svg(ICONS.spark, 'mcx-history-progress-icon') + 'Learning progress · ' + esc(label) + '</span>' +
        '</div>' +
        '<div class="mcx-history-progress-desc">No practice questions answered yet for ' + (isFiltered ? 'this course' : 'any course') + '. Choose "Practice questions" when generating to practice.</div>' +
      '</div>';
    }

    var statsHtml =
      '<div class="mcx-history-progress-stats">' +
        '<div class="mcx-history-progress-stat"><span class="mcx-hps-num">' + summ.practiced + '</span><span class="mcx-hps-lbl">Practiced</span></div>' +
        '<div class="mcx-history-progress-stat is-mastered"><span class="mcx-hps-num">' + summ.mastered + '</span><span class="mcx-hps-lbl">Learned</span></div>' +
        '<div class="mcx-history-progress-stat is-uncertain"><span class="mcx-hps-num">' + summ.uncertain + '</span><span class="mcx-hps-lbl">Unsure</span></div>' +
        '<div class="mcx-history-progress-stat is-weak"><span class="mcx-hps-num">' + summ.weak + '</span><span class="mcx-hps-lbl">To review</span></div>' +
        '<div class="mcx-history-progress-stat is-due"><span class="mcx-hps-num">' + summ.dueNow + '</span><span class="mcx-hps-lbl">Due now</span></div>' +
      '</div>';

    var clearBtn = '<button type="button" class="mcx-history-progress-clear" data-clear-progress="' + (cid || 0) + '">' +
      (cid ? 'Clear for this course' : 'Clear all progress') +
    '</button>';

    return '<div class="mcx-history-progress">' +
      '<div class="mcx-history-progress-head">' +
        '<span class="mcx-history-progress-title">' + svg(ICONS.spark, 'mcx-history-progress-icon') + 'Learning progress · ' + esc(label) + '</span>' +
        clearBtn +
      '</div>' +
      statsHtml +
    '</div>';
  }

  /* 一门存过的课一颗药丸，加那一列行。"历史"那一屏和宽的那一档左边那一列共用这一份：
     两处各写一套行的话，改一处忘一处，两列长成两个样子 */
  function historyPillsAndRows(emptyCls) {
    var h = window.MCxHistory;
    var courses = historyCourses();
    // 筛进去的那门课要是已经一条都不剩（他刚在那门课里删干净），筛子自己收回去，别对着空屏按不动
    var picked = S.chatCourse === null ? null : courses.filter(function (c) { return c.id === S.chatCourse; })[0];
    if (S.chatCourse !== null && !picked) S.chatCourse = null;
    var rows = historyList();
    // 库里那一份要异步才读得回来，那时报"还没有存过任何会话"是假空状态：他会以为自己攒的会话没了
    var reading = !!(h && h.known && !h.known());

    var progressCard = historyProgressCard(S.chatCourse ? Number(S.chatCourse) : 0, picked ? picked.name : '');

    /* 只有一门课时这一排不画：那时"全部"和"这门课"是同一份东西，
       摆出来就是一颗按了什么都没发生的键 */
    var pills = courses.length > 1
      ? '<div class="mcx-study-pills">' + courses.map(function (c) {
          return '<button type="button" class="mcx-study-pill' + (S.chatCourse === c.id ? ' is-on' : '') + '"' +
            ' data-chat-course="' + c.id + '">' + esc(c.name) + ' (' + c.count + ')</button>';
        }).join('') + '</div>'
      : '';

    return {
      count: rows.length,
      pickedName: picked ? picked.name : '',
      html: progressCard + pills + (rows.length
        ? '<div class="mcx-study-list">' + historyRows(rows) + '</div>'
        : '<div class="' + emptyCls + '">' + (reading
          ? 'Reading the chats this extension holds on this computer...'
          : (picked
            ? 'No saved chats in ' + esc(picked.name) + '. Press that one again to see every course.'
            : 'Nothing saved yet. Every answer you send is kept here, on this computer.')) + '</div>')
    };
  }

  /* 宽的那一档左边那一列。窄的时候这里一个字都不留：CSS 本来也不画它，
     但留着上一趟的行会让它下次变宽时先闪一下旧内容 */
  function drawRail() {
    if (!root) return;
    var rail = root.querySelector('.mcx-study-rail');
    if (!rail) return;
    if (!railShown()) {
      rail.innerHTML = '';
      return;
    }
    var list = historyPillsAndRows('mcx-study-rail-empty');
    rail.innerHTML =
      '<div class="mcx-study-railhead">Saved chats</div>' +
      '<div class="mcx-study-railbody">' + list.html + '</div>' +
      '<div class="mcx-study-railfoot">' +
        '<button type="button" class="mcx-study-ghost" data-next="tasks" data-new-chat>New chat</button>' +
      '</div>';
  }

  function drawHistory() {
    var h = window.MCxHistory;
    var cap = h ? h.cap : 50;
    var days = h && Number(h.retentionDays()) ? Number(h.retentionDays()) : 0;
    var list = historyPillsAndRows('mcx-study-empty');

    bodyEl().innerHTML =
      '<section class="mcx-study-sec">' +
        '<h2 class="mcx-study-h">Saved chats</h2>' +
        noticeHtml() +
        list.html +
        '<p class="mcx-study-hint">Keeps your last ' + cap + ' chats'
          + (days ? ', and lets go of the ones older than ' + days + ' days' : '')
          + '. They stay on this computer in this extension\'s own storage, where the Canvas pages cannot read them: nothing is uploaded for this, and nothing is written back to Canvas.</p>' +
      '</section>';
    footEl().innerHTML =
      '<span class="mcx-study-count">' + (list.count
        ? list.count + ' saved' + (list.pickedName ? ' in ' + esc(list.pickedName) : ' on this computer') : '') + '</span>' +
      '<button type="button" class="mcx-study-back" data-next="' + esc(historyBackPane()) + '" aria-label="Back">' + svg(ICONS.back) + '</button>' +
      '<button type="button" class="mcx-study-primary" data-next="tasks" data-new-chat>New chat</button>';
  }

  function resultFootHtml() {
    if (S.running) {
      return '<button type="button" class="mcx-study-ghost" data-cancel="1">Stop</button>';
    }
    var last = S.turns[S.turns.length - 1];
    var hasAnswer = !!(last && last.a);
    if (!hasAnswer) {
      // 还没出字就被停下来：那一排里摆一颗复制空字符串的按钮没道理
      return '<div class="mcx-study-btnrow">' +
          '<span class="mcx-study-count"></span>' +
          '<button type="button" class="mcx-study-back" data-next="' + esc(S.backPane || 'ask') + '" aria-label="Back">' + svg(ICONS.back) + '</button>' +
          '<button type="button" class="mcx-study-primary" data-run="1">Send it</button>' +
        '</div>';
    }
    var a = window.MCxAi;
    var isCloud = a && a.isCloudMode && a.isCloudMode();
    var cLine = costLine();
    return '<div class="mcx-study-askrow">' +
        '<input type="text" class="mcx-study-follow" placeholder="Ask about this summary or course material…" value="' + esc(S.askText) + '">' +
        '<button type="button" class="mcx-study-primary" data-follow="1"' + (S.askText.trim() ? '' : ' disabled') + '>Ask</button>' +
      '</div>' +
      (cLine ? '<div class="mcx-study-cost">' + esc(cLine) + '</div>' : '') +
      '<div class="mcx-study-btnrow">' +
        (!isCloud ? '<span class="mcx-study-count">' + esc(last.model || S.model || '') + '</span>' : '') +
        (railShown() && S.fromHistory
          ? ''
          : '<button type="button" class="mcx-study-back" data-next="' + esc(S.backPane || 'ask') + '" aria-label="Back">' + svg(ICONS.back) + '</button>') +
        '<button type="button" class="mcx-study-ghost" data-copy="1">' + svg(ICONS.copy) + '<span>Copy</span></button>' +
        /* 从库里翻出来的那一条手上没有当时那份课件，"再来一次"会拿现在的勾选发一趟完全不同的东西，
           所以那一颗在这里换成开一条新的 */
        (S.fromHistory
          ? '<button type="button" class="mcx-study-primary" data-next="tasks" data-new-chat>New chat</button>'
          : '<button type="button" class="mcx-study-primary" data-run="1">Regenerate</button>') +
      '</div>';
  }

  function drawResult() {
    bodyEl().innerHTML =
      '<section class="mcx-study-sec mcx-study-result">' +
        (S.readNote ? loadingHtml(S.readNote) : '') +
        sentPlateHtml() +
        noticeHtml() +
        '<div class="mcx-study-out"></div>' +
        '<div class="mcx-study-use" hidden></div>' +
        '<div class="mcx-study-coverage"></div>' +
        '<div class="mcx-study-sources"></div>' +
        '<div class="mcx-practice-coursestat" hidden></div>' +
      '</section>';
    footEl().innerHTML = resultFootHtml();
    paintResult();
    paintCoverage();
  }

  /* 追问：材料那一份不再重新读，也不重新挑任务，就在这一屏接着上一轮问。
     上下文用的还是这一趟已经发出去的那一份，所以它答的还是这些课件里的东西 */
  function followUp() {
    var q = String(S.askText || '').trim();
    if (!q || S.running) return;
    ensureAccount();
    var cfg = window.MCxAi.config(S.account);
    var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
    if (isCloud && window.MCxAi.hasCloudAccess && !window.MCxAi.hasCloudAccess()) {
      S.notice = 'Starting Google sign-in…';
      draw();
      if (window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            S.notice = 'Sign-in was cancelled. Try again when you are ready.';
            draw();
          } else {
            S.notice = '';
            draw();
            followUp();
          }
        });
      }
      return;
    }
    if (!window.MCxAi.canUseSlot(cfg)) {
      S.notice = isCloud
        ? 'Sign in under Settings → AI & Plans to use Modern Canvas AI.'
        : 'Nothing can be answered until one request goes out. Paste a key into the AI row in Settings, then press Test to check it answers.';
      draw();
      return;
    }
    S.model = cfg.model || '';
    var prev = S.turns[S.turns.length - 1];
    if (!prev || !prev.a) {
      S.notice = 'This answer is no longer available. Go back and send it again.';
      draw();
      return;
    }
    S.turns.push({ q: q, a: '', model: S.model || '', calls: [] });
    S.askText = '';
    S.result = '';
    S.running = true;
    S.readNote = '';
    S.notice = '';
    // 上一趟那份计数不算在这一问头上：每一问自己带自己的数
    S.usage = null;
    var gen = ++S.runGen;
    var controller = new AbortController();
    S.controller = controller;
    draw();

    function dead() { return gen !== S.runGen; }

    window.MCxAi.send({
      profile: S.account,
      feature: 'Follow-up question',
      model: cfg.model,
      messages: followMessages(q),
      signal: controller.signal,
      onPoolUsed: function (val) {
        if (dead()) return;
        liveTurn().poolUsed = !!val;
        paintResultSoon();
      },
      onDelta: function (piece) {
        if (dead()) return;
        addDelta(piece);
        paintResultSoon();
      },
      onUsage: function (u, key) {
        if (dead()) return;
        S.usage = u;
        S.calls = window.MCxAi.usageTrack(S.calls, u, key);
        liveTurn().calls = window.MCxAi.usageTrack(liveTurn().calls, u, key);
      }
    }).then(function (full) {
      if (dead()) return;
      if (full && !liveTurn().a) addDelta(full);
      S.running = false;
      dismissRunAsk();
      if (S.controller === controller) S.controller = null;
      persistSession();
      draw();
    }, function (err) {
      if (dead()) return;
      S.running = false;
      dismissRunAsk();
      if (S.controller === controller) S.controller = null;
      // 没答上来的那一轮不许留在屏上：一个空的追问块比一句报错更难懂
      if (!liveTurn().a) {
        S.turns.pop();
        S.result = (S.turns[S.turns.length - 1] || {}).a || '';
      }
      var d = window.MCxAi.describeError(err, cfg);
      S.notice = d.code === 'abort' ? '' : d.text;
      draw();
    });
  }

  /* ==== 事件 ====
     都挂在根节点上代理，换屏不用重绑；抽屉里的 input 是 text/textarea，
     它们每次换屏会重建，所以打字的内容存进 S 再从 S 填回去 */

  function bind() {
    if (!root || bound) return;
    bound = true;
    root.addEventListener('click', function (e) {
      // 删除那颗在行的里面，先认它，再认整行
      var del = e.target.closest('[data-del-chat]');
      if (del) { deleteSession(del.getAttribute('data-del-chat')); return; }
      var cov = e.target.closest('[data-cov]');
      if (cov) { toggleCoverageAt(Number(cov.getAttribute('data-cov'))); return; }
      var chat = e.target.closest('[data-chat]');
      if (chat) { openSession(chat.getAttribute('data-chat')); return; }
      var coursePill = e.target.closest('[data-chat-course]');
      if (coursePill) {
        // 同一颗再点一次就是把这道筛子收回去，回到"每门课都列"的那一屏
        var want = coursePill.getAttribute('data-chat-course');
        S.chatCourse = S.chatCourse === want ? null : want;
        draw();
        return;
      }
      var clearProgressBtn = e.target.closest('[data-clear-progress]');
      if (clearProgressBtn && window.MCxProgress) {
        var cidToClear = Number(clearProgressBtn.getAttribute('data-clear-progress')) || 0;
        var confirmMsg = cidToClear
          ? 'Clear learning progress for this course? This removes practice scores and scheduled reviews for this course.'
          : 'Clear all learning progress across every course?';
        if (confirm(confirmMsg)) {
          var res = cidToClear ? window.MCxProgress.clearCourse(cidToClear) : window.MCxProgress.clearAll();
          S.notice = 'Removed ' + (res.removed || 0) + ' learning record' + (res.removed === 1 ? '' : 's') + '.';
          draw();
        }
        return;
      }
      if (e.target.closest('[data-history]')) { openHistory(); return; }
      if (e.target.closest('[data-settings]')) { openAiSettings(); return; }
      var dock = e.target.closest('[data-dock]');
      if (dock) { dockTo(dock.getAttribute('data-dock')); return; }
      var course = e.target.closest('[data-course]');
      if (course) {
        S.courseId = Number(course.getAttribute('data-course'));
        var named = S.courses.filter(function (c) { return c.id === S.courseId; })[0];
        S.courseName = named ? named.name : '';
        S.courseKnown = true;
        S.showCourses = false;
        // 上一门课残留的筛选必须一起清：新那一门课没有那一类资料时，
        // 药丸那一排画不出这颗，名单就被一个看不见也撤不掉的筛子筛成空的
        resetForCourseSwitch();
        loadTasks();
        // 写信那一屏换了课就得跟着换：老师是这门课的老师，草稿也是这门课的那一份
        if (S.mode === 'teacher') { restoreTeacherDraft(); loadTeachers(); }
        draw();
        return;
      }
      if (e.target.closest('[data-courses]')) {
        S.showCourses = !S.showCourses;
        draw();
        return;
      }
      var task = e.target.closest('[data-task]');
      if (task) {
        var tid = Number(task.getAttribute('data-task'));
        S.pickedTasks[tid] = !S.pickedTasks[tid];
        paintRow(task, S.pickedTasks[tid]);
        paintFoot();
        // 底部那一排的"Assessments"那一行在写信那一屏是正文里的表，跟着一起改
        if (S.mode === 'teacher') {
          saveTeacherDraft();
          var plate = bodyEl().querySelector('.mcx-study-mtassess');
          if (plate) plate.textContent = pickedTaskList().map(function (t) { return t.name; }).join(', ') || 'None selected';
        }
        loadScopeStats();
        return;
      }
      var mod = e.target.closest('[data-mod]');
      if (mod) {
        var mkey = mod.getAttribute('data-mod');
        // 只管这一屏看得见的、而且读得出正文的那几条：筛子筛掉的那一段和点了只会报错的那几条都不该被带走
        var mg = visibleResources().filter(function (r) {
          return (r.module || '') === mkey && r.readable;
        });
        var allOn = mg.every(function (r) { return S.pickedRes[r.id]; });
        mg.forEach(function (r) {
          S.pickedRes[r.id] = !allOn;
          if (allOn) delete S.pickReason[r.id];
        });
        S.notice = '';
        var mlist = bodyEl().querySelector('.mcx-study-list');
        if (mlist) mlist.innerHTML = resourceRowsHtml();
        footEl().innerHTML = resourcesFootHtml();
        paintNote();
        return;
      }
      var res = e.target.closest('[data-res]');
      if (res) {
        var rid = Number(res.getAttribute('data-res'));
        var item = S.resources.filter(function (r) { return r.id === rid; })[0];
        if (item && !item.readable) {
          S.notice = 'This item links outside Canvas / has no readable text, so it cannot be included.';
          paintNote();
          return;
        }
        S.pickedRes[rid] = !S.pickedRes[rid];
        // 撤掉一条就把它的"为什么挑它"一起撤掉：那句话是在解释这一勾，勾没了它还留着就是假话
        if (!S.pickedRes[rid]) {
          delete S.pickReason[rid];
          var why = res.querySelector('.mcx-study-why');
          if (why && why.parentNode) why.parentNode.removeChild(why);
        }
        S.notice = '';
        paintRow(res, S.pickedRes[rid]);
        footEl().innerHTML = resourcesFootHtml();
        paintNote();
        return;
      }
      var pill = e.target.closest('[data-filter]');
      if (pill) {
        var k = pill.getAttribute('data-filter');
        S.filters[k] = !S.filters[k];
        pill.classList.toggle('is-on', !!S.filters[k]);
        var list = bodyEl().querySelector('.mcx-study-list');
        if (list) list.innerHTML = resourceRowsHtml();
        footEl().innerHTML = resourcesFootHtml();
        return;
      }
      var acct = e.target.closest('[data-account]');
      if (acct) {
        /* 挑档就是挑那一档自己配的模型，所以这里不再另记一份模型选择，
           也不再写"当前哪一格"——那一颗键整个作废了 */
        S.account = acct.getAttribute('data-account');
        S.model = (accountOf(S.account) || {}).model || '';
        draw();
        return;
      }
      var tpl = e.target.closest('[data-tpl]');
      if (tpl) {
        S.template = tpl.getAttribute('data-tpl');
        draw();
        return;
      }
      /* 写信那一屏的六颗快捷、四颗语气（playful 那颗自带刻度）、收信人、Generate／Stop／Copy。
         每一颗改完都要落库：这一屏的东西他一页都不刷新，关面板再开要原样回来 */
      var mtIntent = e.target.closest('[data-mt-intent]');
      if (mtIntent) {
        S.intent = mtIntent.getAttribute('data-mt-intent');
        // 他自己挑过一颗，状态预选这一趟就再也不许动这一格
        S.mtTouched = true;
        saveTeacherDraft();
        draw();
        return;
      }
      var mtTone = e.target.closest('[data-mt-tone]');
      if (mtTone) {
        S.tone = mtTone.getAttribute('data-mt-tone');
        S.mtTouched = true;
        saveTeacherDraft();
        draw();
        return;
      }
      var teacher = e.target.closest('[data-teacher]');
      if (teacher) {
        S.teacherId = Number(teacher.getAttribute('data-teacher'));
        saveTeacherDraft();
        draw();
        return;
      }
      if (e.target.closest('[data-mt-gen]')) { makeTeacherDraft(); return; }
      if (e.target.closest('[data-mt-all]')) { S.mtShowAll = !S.mtShowAll; draw(); return; }
      if (e.target.closest('[data-mt-stop]')) { stopTeacherDraft(); return; }
      if (e.target.closest('[data-mt-copy]')) { copyTeacherDraft(); return; }
      if (e.target.closest('[data-ai-pick]')) { aiPick(); return; }
      var next = e.target.closest('[data-next]');
      if (next) {
        var where = next.getAttribute('data-next');
        /* 那一颗 New chat 开的是另一场对话：上一场那一串数要清空，
           不然新一场头一句 "This chat" 里挂着旧一场花掉的钱 */
        if (next.hasAttribute('data-new-chat')) S.calls = [];
        S.pane = where;
        S.notice = '';
        if (where === 'resources') {
          // 每次进这一屏都重新读一遍（老师在面板开着的时候也能改模块），
          // 勾过的按 id 留着，读回来的还是同一批条目
          loadResources();
          loadScopeStats();
        }
        draw();
        return;
      }
      if (e.target.closest('[data-ai-auth="google"]')) {
        if (window.MCxAi && window.MCxAi.loginWithGoogle) {
          S.notice = 'Starting Google sign-in…';
          draw();
          window.MCxAi.loginWithGoogle(function (err) {
            if (err) {
              S.notice = 'Sign-in was cancelled. Try again when you are ready.';
              draw();
            } else {
              S.notice = '';
              draw();
            }
          });
        } else {
          openAiSettings();
        }
        return;
      }
      if (e.target.closest('[data-run]')) { run(); return; }
      if (e.target.closest('[data-cancel]')) { cancel(); return; }
      if (e.target.closest('[data-follow]')) { followUp(); return; }
      if (e.target.closest('[data-copy]')) { copyResult(); return; }
    });

    /* 追问框里回车就发。这里不能顺手重建那一排：重建会把光标丢掉，
       而他正在打字，只需要那一句价钱和那颗按钮的状态跟着变 */
    root.addEventListener('keydown', function (e) {
      if (!e.target.classList.contains('mcx-study-follow')) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        followUp();
      }
    });

    root.addEventListener('input', function (e) {
      if (e.target.classList.contains('mcx-study-search')) {
        S.taskQuery = e.target.value;
        // 打字时只换那一列行，不动上面那排工具，光标才不会跳
        var host = bodyEl().querySelector('.mcx-study-list');
        if (host) host.innerHTML = taskRowsHtml();
        // 写信那一屏：搜起来是全量匹配，那排"还有多少条"当场要跟着走，清空搜索框也要跟
        if (S.mode === 'teacher') {
          var more = bodyEl().querySelector('.mcx-study-mtmore');
          var moreHtml = mtShowAllHtml(visibleTasks());
          var list = bodyEl().querySelector('.mcx-study-list');
          if (more) more.outerHTML = moreHtml;
          else if (moreHtml && list) list.insertAdjacentHTML('afterend', moreHtml);
        }
        return;
      }
      if (e.target.classList.contains('mcx-study-follow')) {
        S.askText = e.target.value;
        var cost = footEl().querySelector('.mcx-study-cost');
        if (cost) cost.textContent = costLine();
        var go = footEl().querySelector('[data-follow]');
        if (go) go.disabled = !String(S.askText).trim();
      }
      /* 写信那一屏的两格都当场记账：那一屏任何一处重画都是整块 innerHTML 换掉，
         没记下来的那几个字就没了（收件箱那一份是同一个理由） */
      if (e.target.classList.contains('mcx-study-mtnote')) {
        S.mtNote = e.target.value;
        S.mtTouched = true;
        saveTeacherDraft();
      }
      if (e.target.classList.contains('mcx-study-mtdraft')) {
        S.mtDraft = e.target.value;
        fitTeacherDraft(e.target);
        saveTeacherDraft();
        var cp = footEl().querySelector('[data-mt-copy]');
        if (cp) cp.disabled = !String(S.mtDraft).trim();
      }
      /* 调皮刻度：拖动途中只换右边那几个字符，一次都不重建。重建会把滑块从指针底下搬走，
         他松手停在哪一格就不由他了。落库排在 change 那一头，等松手，不每 5% 写一次 */
      if (e.target.hasAttribute('data-mt-playful')) {
        S.playful = window.MCxAi.playfulPct(e.target.value, window.MCxAi.playfulDefault);
        var pct = bodyEl().querySelector('[data-mt-playful-pct]');
        if (pct) pct.textContent = S.playful + '%';
        // 那一句跟着刻度当场换字换色，节点一直在，只翻类和那几个字
        var warn = bodyEl().querySelector('[data-tone-warn]');
        if (warn) {
          var w = window.MCxAi.toneWarn(S.playful);
          warn.className = 'mcx-tone-warn' + (w.cls ? ' ' + w.cls : '');
          var wt = warn.querySelector('.mcx-tone-warn-text');
          if (wt) wt.textContent = w.text;
        }
      }
    });

    root.addEventListener('change', function (e) {
      if (e.target.hasAttribute('data-img')) {
        S.imagesOn = e.target.checked;
        draw();
      }
      if (e.target.hasAttribute('data-past')) {
        S.includePast = e.target.checked;
        draw();
      }
      // 松手才算一格：刻度上的每一个中间值都不值得写一次库
      if (e.target.hasAttribute('data-mt-playful')) saveTeacherDraft();
    });
  }

  function copyResult() {
    // 整条线一起给：追问过好几轮之后只复制最后那一轮，等于把他刚读的东西丢了
    var text = threadText();
    var done = function (ok) {
          S.notice = ok ? 'Copied to clipboard.' : 'Could not copy automatically. Select the text and copy it.';
      draw();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  /* ==== 两级挑选 ====
     第一级在本地，不要钱也不要等：判据是"选中的那几条任务"里的词（任务名最值钱，
     老师写的说明其次，测验封面上那段其次），加上这门课里它排在第几条。
     第二级才是模型：它只看这几十条的标题，正文一条都不读。
     整门课一屏一屏报上去，一来一回就是上万字，而它只会顾得上排在最前面那批。 */
  var STOP_WORDS = {
    the: 1, and: 1, with: 1, from: 1, that: 1, this: 1, your: 1, have: 1, will: 1, they: 1, them: 1,
    what: 1, when: 1, where: 1, which: 1, who: 1, how: 1, many: 1, more: 1, most: 1, using: 1, use: 1,
    chapter: 1, section: 1, unit: 1, week: 1, quiz: 1, test: 1, exam: 1, assignment: 1, homework: 1,
    class: 1, course: 1, date: 1, page: 1, file: 1, part: 1, all: 1, any: 1, for: 1, not: 1, can: 1,
    was: 1, were: 1, has: 1, had: 1, are: 1, its: 1, you: 1, our: 1, into: 1, over: 1, after: 1,
    before: 1, then: 1, than: 1, them: 1, they: 1, been: 1, would: 1, should: 1, could: 1, there: 1,
    here: 1, those: 1, these: 1, very: 1, much: 1, make: 1, made: 1, take: 1, show: 1, each: 1,
    other: 1, some: 1, such: 1, only: 1, also: 1, both: 1, between: 1, about: 1, across: 1
  };

  function keywords(text) {
    var out = [];
    String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).forEach(function (run) {
      if (!run) return;
      // 中文没有空格可切：整句当一个词永远对不上，就两字两字地给，判据靠叠加
      if (/^[\u4e00-\u9fff]+$/.test(run)) {
        for (var i = 0; i + 2 <= run.length && i < 24; i++) out.push(run.slice(i, i + 2));
        return;
      }
      if (run.length >= 4 && !STOP_WORDS[run]) out.push(run);
    });
    return out;
  }

  function taskWords() {
    var w = {};
    pickedTaskList().forEach(function (t) {
      keywords(t.name).forEach(function (k) { w[k] = Math.max(w[k] || 0, 3); });
      keywords(window.MCxData.htmlToText(t.description || '')).forEach(function (k) { w[k] = Math.max(w[k] || 0, 1); });
      var q = t.quizId && S.stats['quiz_' + t.quizId] ? S.stats['quiz_' + t.quizId] : null;
      if (q && q.text) keywords(q.text).forEach(function (k) { w[k] = Math.max(w[k] || 0, 2); });
    });
    return Object.keys(w).map(function (k) { return { k: k, v: w[k] }; });
  }

  /* 选中的任务在模块里排到第几条。老师按单元排课件，这个位置就是"考纲落在哪一段"；
     任务没挂进模块（很多作业正是这样）就回 -1，这一趟只按词判，不硬造一个位置 */
  function anchorIndex(list, tasks) {
    var ids = {};
    tasks.forEach(function (t) { if (t.id) ids[t.id] = 1; });
    var best = -1;
    list.forEach(function (r, i) {
      if ((r.kind === 'quiz' || r.kind === 'assignment') && ids[r.contentId]) best = i;
    });
    return best;
  }

  function rankCandidates() {
    var list = S.resources.filter(function (r) { return r.readable; });
    var tasks = pickedTaskList();
    // 没有任务可参照，或者这门课本来就长不到哪儿去：一份都不筛，全部交给它
    if (!tasks.length) return list.slice(-PICK_CANDIDATE_CAP);
    if (list.length <= PICK_FILTER_ABOVE) return list;
    var words = taskWords();
    var anchor = anchorIndex(list, tasks);
    var scored = list.map(function (r, i) {
      var hay = ((r.module || '') + ' ' + (r.title || '')).toLowerCase();
      var score = 0;
      words.forEach(function (entry) { if (hay.indexOf(entry.k) >= 0) score += entry.v; });
      if (anchor >= 0) {
        // 考纲那一条之前的课件才是复习范围；排在它后面多半是下一单元，隔太远的是更早的旧内容
        if (i <= anchor) score += 2;
        else score -= 2;
        if (anchor - i > 80) score -= 2;
      }
      return { r: r, i: i, score: score };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      // 谁都没踩上词的时候按位置排：离考纲近的那批，或者排在最后那批
      return anchor >= 0 ? Math.abs(a.i - anchor) - Math.abs(b.i - anchor) : b.i - a.i;
    });
    return scored.slice(0, PICK_CANDIDATE_CAP)
      .sort(function (a, b) { return a.i - b.i; })
      .map(function (x) { return x.r; });
  }

  function aiPick() {
    ensureAccount();
    if (aiKeyState() === 'loading') {
      S.notice = 'Loading AI settings. Try again in a moment.';
      draw();
      return;
    }
    var cfg = window.MCxAi.config(S.account);
    var isCloud = cfg && (cfg.isCloud || (window.MCxAi && window.MCxAi.isCloudMode && window.MCxAi.isCloudMode()));
    if (isCloud && window.MCxAi.hasCloudAccess && !window.MCxAi.hasCloudAccess()) {
      S.notice = 'Starting Google sign-in…';
      draw();
      if (window.MCxAi.loginWithGoogle) {
        window.MCxAi.loginWithGoogle(function (err) {
          if (err) {
            S.notice = 'Sign-in was cancelled. Try again when you are ready.';
            draw();
          } else {
            S.notice = '';
            draw();
            aiPick();
          }
        });
      }
      return;
    }
    if (!window.MCxAi.canUseSlot(cfg)) {
      S.notice = isCloud
        ? 'Sign in under Settings → AI & Plans to use Modern Canvas AI.'
        : 'Letting the model choose material still needs a key. Paste one into the AI row in Settings.';
      draw();
      return;
    }
    var all = S.resources.filter(function (r) { return r.readable; });
    if (!all.length) {
      S.notice = 'No course materials are available to choose from.';
      draw();
      return;
    }
    var shortlist = rankCandidates();
    // 口径要用整份选中任务，不能只取第一颗：多选时只报第一颗等于偷偷把范围收窄，
    // 而他屏幕上勾了好几条
    var scopeText = scopeBlock();
    var names = pickedTaskList().map(function (t) { return t.name; });
    var cid = S.courseId;
    S.picking = true;
    S.notice = '';
    draw();
    var controller = new AbortController();
    // 挂进 S.controller：关面板和 Stop 才摘得掉这一趟。
    // 之前它是一颗本地 controller，晚到的回包照样把整份勾选换掉
    S.controller = controller;
    var pickGen = S.runGen;
    window.MCxAi.pickResources({
      profile: S.account,
      courseName: S.courseName,
      taskName: names.length ? names.join(', ') : '(no task picked)',
      scopeText: scopeText,
      resources: shortlist,
      signal: controller.signal
    }).then(function (out) {
      if (cid !== S.courseId || pickGen !== S.runGen) return;
      S.picking = false;
      if (S.controller === controller) S.controller = null;
      var map = {};
      out.ids.forEach(function (id) { map[id] = 1; });
      S.pickedRes = map;
      S.pickReason = out.reasons || {};
      S.notice = out.ids.length
        ? 'Selected ' + out.ids.length + ' item' + (out.ids.length === 1 ? '' : 's') + '. '
          + (shortlist.length < all.length
            ? 'It was shown the ' + shortlist.length + ' most likely of the ' + all.length + ' entries in this course. '
            : '')
          + 'Add or remove any of them.'
        : 'No materials were selected. '
          + (out.how === 'empty'
            ? 'That answer came back with no text at all. '
            : 'What came back starts with "' + String(out.preview || '').slice(0, 120) + '". ')
          + 'Tick a few by hand.';
      draw();
    }, function (err) {
      if (cid !== S.courseId || pickGen !== S.runGen) return;
      S.picking = false;
      if (S.controller === controller) S.controller = null;
      var d = window.MCxAi.describeError(err, window.MCxAi.config(S.account));
      S.notice = d.code === 'abort' ? '' : 'Could not choose materials. ' + d.text;
      draw();
    });
  }

  /* 抬头那颗齿轮：把设置打开并停在 AI & Plans 那一组。
     那座面板归 settings.js，这里只发一个事件，不伸手去摸它的节点；
     抽屉也不关——他看完设置回来还是这一屏，追问的话都在。 */
  function openAiSettings() {
    try {
      document.dispatchEvent(new CustomEvent('mc-open-ai-settings'));
      document.dispatchEvent(new CustomEvent('bcx-open-ai-settings'));
    } catch (e) {
      window.MCxData && window.MCxData.log('settings did not open from the study panel', String((e && e.message) || e));
    }
  }

  window.MCxStudy = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    /* 设置里那一排形态翻完要当场重算：那几句改的都是这一屏在页面上占哪一段、
       页面让哪几列，不重算的话他关掉设置回来看到的还是旧的那一档。
       面板没开过也要跑这一趟：右侧 To Do 那一列的档子和面板开不开没关系 */
    layout: function () {
      applyLayout();
      if (S.open) draw();
    },
    /* 这一格宽度要回读这一个数：按屏幕收过一档的真实宽度只有这里知道 */
    width: function () { return L.w; },
    /* ---- 借窗：别的功能把自己的那一屏放进这座悬浮窗里用 ----
       它要的是"能拖、能改大小、吃主题、带糊"那一套外壳，那一套这里全写好了，
       所以对外只开这一进一出：进来时按调用方的意思决定要不要翻成悬浮档，出去时把那一屏交还给原来的位置 */
    embed: function (node, opts) {
      opts = opts || {};
      if (!node) return false;
      S.embed = { node: node, label: opts.label || '', onClose: opts.onClose || null };
      S.pane = 'embed';
      if (opts.floating) {
        try { localStorage.setItem('bc_ai_panel_mode', 'floating'); } catch (e) {}
      }
      if (!S.open) open(opts.courseId || 0, { pane: 'embed' });
      applyLayout();
      draw();
      return true;
    },
    unembed: function () {
      S.embed = null;
      if (S.pane === 'embed') S.pane = 'tasks';
      if (S.open) draw();
      return true;
    },
    embedded: function () { return !!(S.embed && S.embed.node); },
    /* 设置里翻完"排版"那一档要当场重排：那一句改的是这一屏怎么画，
       不重排的话他关掉设置回到抽屉，看到的还是旧的那一档 */
    refresh: function () { if (S.open) draw(); }
  };

  /* 侧栏那一行由 nav-boot.js 在 document_start 挂好，这里代理点击：
     两边各绑一次的话，重载扩展前那一帧按下去是没反应的。
     它点开的是存过的那批会话（他拍的口径），不是新的一屏：从侧栏进来看的是"我上次问了什么" */
  document.addEventListener('click', function (e) {
    var row = e.target.closest ? (e.target.closest('.mc-nav-study-link') || e.target.closest('.bcx-nav-study-link')) : null;
    if (row) {
      e.preventDefault();
      e.stopPropagation();
      window.MCxStudy.open(window.MCxData ? window.MCxData.currentCourseId() : 0, { pane: 'history' });
    }
  }, true);
})();
