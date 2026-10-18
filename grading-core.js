/* Deterministic GPA calculations. Canvas grades are observations, not a transcript. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MCxGradingCore = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  function finite(value) {
    /* 空串、纯空格、数组、对象在 Number() 眼里都是 0，而 0 是一个合法的百分比或学分数。
       这一颗是整个算法唯一的入口，放行一个就等于把一门没成绩的课算成 F */
    if (value === '' || value == null || typeof value === 'boolean') return null;
    if (Array.isArray(value) || typeof value === 'object') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function objectRow(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function policy() {
    return {
      version: 3, tab: 'current', weighted: false,
      scale: [], scalePreset: 'custom', conversion: 'percent', pointCutoffs: [], defaultCredits: 1, defaultMethod: 'direct', defaultCalendar: 'auto', defaultGradeSource: 'current', rounding: 'none', weights: [], courses: {},
      school: '', academicYear: '', policySources: [], policyReviewedAt: '',
      history: { unweighted: '', weighted: '', credits: '', records: [] },
      policyUrls: [], policyDraft: null, policyReview: null,
      flowStep: 'welcome'
    };
  }
  function normalize(input) {
    var out = policy();
    if (!input || typeof input !== 'object') { out.defaultCredits = ''; return out; }
    Object.keys(out).forEach(function (key) { if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key]; });
    if (typeof input.flowStep === 'string') out.flowStep = input.flowStep;
    /* These school-wide controls no longer exist. Old saved values must not keep
       changing GPA invisibly; individual course overrides remain intact. */
    out.defaultCredits = out.defaultCredits === '' ? '' : 1;
    out.defaultMethod = 'direct';
    out.defaultCalendar = 'auto';
    out.defaultGradeSource = 'current';
    out.rounding = 'none';
    if (!Array.isArray(out.scale)) out.scale = [];
    if (!Array.isArray(out.pointCutoffs)) out.pointCutoffs = [];
    if (!Array.isArray(out.weights)) out.weights = [];
    if (!Array.isArray(out.policyUrls)) out.policyUrls = [];
    if (!Array.isArray(out.policySources)) out.policySources = [];
    /* 行级也要筛：storage 里只要躺着一行 null 或非对象，后面每一趟读它都会抛，
       而这一抛是从 panel() 里冲出去的＝整块面板画不出来，还会顺带打断 Focus 那一秒一趟的计时 */
    out.scale = out.scale.filter(objectRow);
    out.pointCutoffs = out.pointCutoffs.filter(objectRow);
    out.weights = out.weights.filter(objectRow);
    out.policyUrls = out.policyUrls.filter(function (v) { return typeof v === 'string' && v; });
    out.policySources = out.policySources.filter(function (v) { return typeof v === 'string' && v; });
    if (!out.courses || typeof out.courses !== 'object' || Array.isArray(out.courses)) out.courses = {};
    Object.keys(out.courses).forEach(function (id) {
      if (!objectRow(out.courses[id])) out.courses[id] = {};
      /* 这一档下面还嵌着一层时段行：外面筛掉了、里面没筛＝同一类崩溃只堵了一半
         （实测 courses:{1:{method:'percentPeriods',periods:[null]}} 仍然抛 reading 'weight'） */
      if (Array.isArray(out.courses[id].periods)) out.courses[id].periods = out.courses[id].periods.filter(objectRow);
      if (Array.isArray(out.courses[id].scale)) out.courses[id].scale = out.courses[id].scale.filter(objectRow);
    });
    if (!out.history || typeof out.history !== 'object' || Array.isArray(out.history)) out.history = policy().history;
    if (!Array.isArray(out.history.records)) out.history.records = [];
    out.history.records = out.history.records.filter(objectRow);
    return out;
  }
  function validScale(rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    var seen = Object.create(null), thresholds = Object.create(null);
    return rows.every(function (row) {
      var grade = String(row && row.grade || '').trim().toUpperCase();
      var min = finite(row && row.minimum), points = finite(row && row.points);
      if (!grade || seen[grade] || min == null || min < 0 || min > 100 || points == null || points < 0 || points > 10 || thresholds[min]) return false;
      seen[grade] = true; thresholds[min] = true; return true;
    });
  }
  function validLetterScale(rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    var seen = Object.create(null);
    return rows.every(function (row) {
      var grade = String(row && row.grade || '').trim().toUpperCase();
      var points = finite(row && row.points);
      if (!grade || seen[grade] || points == null || points < 0 || points > 10) return false;
      seen[grade] = true;
      return true;
    });
  }
  function courseConfig(p, courseId) {
    var config = Object.assign({}, p.courses[String(courseId)] || {});
    if (!config.method || config.method === 'inherit') config.method = p.defaultMethod || 'direct';
    if (!config.gradeSource || config.gradeSource === 'inherit') config.gradeSource = p.defaultGradeSource || 'current';
    if (!config.calendar || config.calendar === 'inherit') config.calendar = p.defaultCalendar || 'auto';
    return config;
  }
  function pointLetter(cutoffs, points) {
    if (!Array.isArray(cutoffs) || !cutoffs.length) return '';
    var seen = Object.create(null), thresholds = Object.create(null);
    /* 两档卡同一个下限（比如 A 和 B 都写 4.0）时，排序后的第一行说了算＝4.0 能被判成 B。
       和 validScale 同一条规矩：下限不许重复 */
    if (!cutoffs.every(function (r) { var grade = String(r.grade || '').trim().toUpperCase(), min = finite(r.minimum); if (!grade || seen[grade] || min == null || min < 0 || min > 10 || thresholds[min]) return false; seen[grade] = true; thresholds[min] = true; return true; })) return '';
    var sorted = cutoffs.slice().sort(function (a, b) { return Number(b.minimum) - Number(a.minimum); });
    var hit = sorted.filter(function (r) { return snap(points) + EPS >= Number(r.minimum); })[0];
    return hit ? String(hit.grade).trim() : '';
  }
  function gradeOf(course, config) {
    var rows = Array.isArray(course.enrollments) ? course.enrollments.filter(function (e) { return objectRow(e); }) : [];
    var enrollment = rows.filter(function (e) { return e.type === 'StudentEnrollment' || e.role === 'StudentEnrollment'; })[0] || rows[0] || {};
    var grades = enrollment.grades || {};
    var final = config.gradeSource === 'final';
    /* 时段制学校在课程列表里同时给两份数：全学期那一串（computed_current_*）和当前时段那一串
       （current_period_computed_*，源码 lib/api/v1/course_json.rb:229-233）。
       以前只读前者，屏幕上写着 Current 的那格其实是整个学期的分。
       totals_for_all_grading_periods_option 为真时学校自己就是要全学期汇总，那份才是对的。 */
    var onPeriod = enrollment.has_grading_periods === true && enrollment.totals_for_all_grading_periods_option !== true;
    var periodKey = onPeriod ? 'current_period_computed_' + (final ? 'final' : 'current') : '';
    var percent = periodKey ? finite(enrollment[periodKey + '_score']) : null;
    if (percent == null) percent = final ? finite(grades.final_score) : finite(grades.current_score);
    if (percent == null) percent = final ? finite(enrollment.computed_final_score) : finite(enrollment.computed_current_score);
    var letter = periodKey ? String(enrollment[periodKey + '_grade'] || '').trim() : '';
    if (!letter) letter = String((final ? grades.final_grade : grades.current_grade) || enrollment[(final ? 'computed_final' : 'computed_current') + '_grade'] || '').trim();
    return { percent: percent, letter: letter, period: !!periodKey };
  }
  /* Canvas 报的分数是浮点：89.49999999999999 和 89.5 是同一个数，但 Math.round 会把前者降到 89，
     "精确值"那一档又按 89.5 判成 A＝同一个学生的同一门课，换一档舍入就跳档。
     先把噪声归掉（精度 1e-10，够抹掉 1e-14 那种噪声，又不会把 87.2499999995 这种真在线下的抬上去），
     四档舍入和下面那句比较都读这同一个数 */
  var EPS = 1e-11;
  function snap(value) { return Math.round((value + Number.EPSILON) * 1e10) / 1e10; }
  function rounded(percent, mode) {
    if (mode === 'whole') return Math.round(snap(percent));
    if (mode === 'tenth') return Math.round((percent + Number.EPSILON) * 10) / 10;
    if (mode === 'hundredth') return Math.round((percent + Number.EPSILON) * 100) / 100;
    return percent;
  }
  function nonGpaLetter(letter) { return /^(P|PASS|NP|S|U|I|INC|INCOMPLETE|W|WP|WF|AU|AUDIT)$/i.test(String(letter || '').trim()); }
  function convert(scale, grade, rounding, mode) {
    if (mode === 'canvasLetter' ? !validLetterScale(scale) : !validScale(scale)) return null;
    var sorted = scale.slice().sort(function (a, b) { return Number(b.minimum) - Number(a.minimum); });
    if (mode !== 'canvasLetter' && grade.percent != null) {
      var value = snap(rounded(grade.percent, rounding));
      for (var i = 0; i < sorted.length; i++) {
        if (value + EPS >= Number(sorted[i].minimum)) return { grade: sorted[i].grade, points: Number(sorted[i].points), percent: value };
      }
      return null;
    }
    var hit = sorted.filter(function (row) { return String(row.grade).trim().toUpperCase() === grade.letter.toUpperCase(); })[0];
    return hit ? { grade: hit.grade, points: Number(hit.points), percent: null } : null;
  }
  function periodGrade(config, fallback) {
    if (config.method === 'manual') return { percent: finite(config.manualPercent), letter: String(config.manualLetter || '').trim() };
    if (config.method === 'manualPoints') return { points: finite(config.manualPoints), percent: null, letter: '' };
    if (config.method !== 'percentPeriods' && config.method !== 'pointPeriods' && config.method !== 'pointLetter') return fallback;
    var list = Array.isArray(config.periods) ? config.periods : [];
    if (!list.length) return { percent: null, letter: '' };
    var numerator = 0, denominator = 0;
    for (var i = 0; i < list.length; i++) {
      var item = objectRow(list[i]) ? list[i] : {};
      var weight = finite(item.weight), value = finite(config.method === 'percentPeriods' ? item.percent : item.points);
      if (weight == null || weight <= 0 || value == null) return { percent: null, letter: '' };
      numerator += value * weight; denominator += weight;
    }
    if (!denominator) return { percent: null, letter: '' };
    return config.method === 'pointPeriods' || config.method === 'pointLetter'
      ? { points: numerator / denominator, percent: null, letter: '' }
      : { percent: numerator / denominator, letter: '' };
  }
  function weightFor(p, config, grade) {
    if (!p.weighted) return 0;
    var type = String(config.type || '').trim();
    if (!type || ['choose a course type', 'customize', 'regular', 'regular (no extra weight)', 'regular / no extra weight', '__custom__'].indexOf(type.toLowerCase()) >= 0) return 0;
    var rule = p.weights.filter(function (r) { return String(r.type || '').trim().toLowerCase() === type.toLowerCase(); })[0];
    if (!rule) return null;
    if ((config.weightBonus != null && config.weightBonus !== '') || (config.weightMinimum != null && config.weightMinimum !== '' && rule.mode !== 'table')) {
      var courseBonus = config.weightBonus != null && config.weightBonus !== '' ? finite(config.weightBonus) : finite(rule.bonus);
      if (courseBonus == null) return null;
      var courseMinimum = config.weightMinimum != null && config.weightMinimum !== '' ? finite(config.weightMinimum) : finite(rule.minimumPoints);
      return courseMinimum != null && grade.points < courseMinimum ? 0 : courseBonus;
    }
    if (rule.mode === 'table') {
      var points = rule.table && finite(rule.table[String(grade.grade).trim().toUpperCase()]);
      return points == null ? null : points - grade.points;
    }
    var bonus = finite(rule.bonus);
    if (bonus == null) return null;
    var minimum = config.weightMinimum != null && config.weightMinimum !== '' ? finite(config.weightMinimum) : finite(rule.minimumPoints);
    return minimum != null && grade.points < minimum ? 0 : bonus;
  }
  function current(p, courses) {
    var sum = 0, credits = 0, used = [], skipped = [], problems = [];
    if (p.weighted && (!Array.isArray(p.weights) || !p.weights.length)) problems.push('School weighting rules');
    (courses || []).forEach(function (course) {
      if (!course || course.id == null) return;
      var config = courseConfig(p, course.id), name = course.name || course.course_code || String(course.id);
      var observed = periodGrade(config, gradeOf(course, config));
      var hasNoUsableGrade = nonGpaLetter(observed.letter) || (p.conversion === 'canvasLetter' ? !observed.letter : observed.percent == null && !observed.letter && observed.points == null);
      if (config.include === false) { skipped.push({ id: course.id, reason: 'excluded' }); return; }
      if (config.excludeMode === 'until_grade' && hasNoUsableGrade) { skipped.push({ id: course.id, reason: 'excluded_until_grade' }); return; }
      var scale = Array.isArray(config.scale) ? config.scale : p.scale;
      if (p.conversion === 'canvasLetter' ? !validLetterScale(scale) : !validScale(scale)) { problems.push(name + ': grading scale'); return; }
      var credit = finite(config.credits === '' || config.credits == null ? p.defaultCredits : config.credits);
      if (credit == null || credit <= 0 || credit > 1000) { problems.push(name + ': credits'); return; }
      if (nonGpaLetter(observed.letter)) { problems.push(name + ': non-GPA grade; exclude or override'); return; }
      /* 手里拿的是"点数"的那些档（时段点数、手填 GPA 点数）本身就是学校报的点数，
         再叠一次课程类型加分＝同一门课加两遍。这一格必须在下面那行把 points 抹掉之前记下来，
         抹掉之后再问 observed.points 就永远是 null，加分会被偷偷加回去 */
      var pointsBased = observed.points != null;
      if (config.method === 'pointLetter' && observed.points != null) observed = { percent: null, letter: pointLetter(p.pointCutoffs, observed.points) };
      var grade = observed.points == null ? convert(scale, observed, p.rounding, config.method === 'pointLetter' ? 'canvasLetter' : p.conversion) :
        { grade: '', points: observed.points, percent: null };
      if (grade && observed.points != null && (grade.points < 0 || grade.points > 10)) grade = null;
      if (!grade) { problems.push(name + ': grade unavailable'); return; }
      var bonus = pointsBased ? 0 : weightFor(p, config, grade);
      if (bonus == null) { problems.push(name + ': course weighting'); return; }
      /* 加分规则是用户（或 AI 导进来的草稿）填的，填成 -5 或 99 都能算出一个数来：
         GPA 会当场显示成 -1.00 或 99.00 而不报错。越界的这一门直接不算，并点名它 */
      var quality = grade.points + bonus;
      if (quality < 0 || quality > 10) { problems.push(name + ': weighted points outside 0–10'); return; }
      sum += quality * credit; credits += credit;
      used.push({ id: course.id, name: name, credits: credit, grade: grade.grade, percent: observed.percent, basePoints: grade.points, bonus: bonus, points: quality });
    });
    /* 最后一道闸：任何一个数不是有限值、或落在 0..10 之外，就不算"成套"，屏上不许出现那种数 */
    var gpa = credits ? sum / credits : null;
    if (gpa != null && (!Number.isFinite(gpa) || gpa < 0 || gpa > 10)) { problems.push('Combined GPA is out of range'); gpa = null; }
    return { value: gpa, qualityPoints: sum, credits: credits, used: used, skipped: skipped, problems: problems, complete: credits > 0 && gpa != null && !problems.length };
  }
  function history(p) {
    var h = p.history || {}, records = Array.isArray(h.records) ? h.records : [];
    if (records.length) {
      var sum = 0, credits = 0, problems = [];
      records.forEach(function (row, i) {
        if (row.include === false) return;
        var cr = finite(row.credits), points = finite(p.weighted ? row.weightedPoints : row.points);
        if (cr == null || cr <= 0 || points == null || points < 0 || points > 10) { problems.push('Historical course ' + (i + 1)); return; }
        sum += cr * points; credits += cr;
      });
      return { qualityPoints: sum, credits: credits, complete: credits > 0 && !problems.length, problems: problems };
    }
    var cr = finite(h.credits), gpa = finite(p.weighted ? h.weighted : h.unweighted);
    return { qualityPoints: cr != null && gpa != null ? cr * gpa : 0, credits: cr || 0, complete: cr != null && cr > 0 && gpa != null && gpa >= 0 && gpa <= 10, problems: [] };
  }
  function result(p, courses) {
    p = normalize(p);
    var now = current(p, courses), previous = history(p);
    var projected = now.complete && previous.complete ? (now.qualityPoints + previous.qualityPoints) / (now.credits + previous.credits) : null;
    return { current: now.complete ? now.value : null, projected: projected, currentDetails: now, historyDetails: previous };
  }
  return { policy: policy, normalize: normalize, finite: finite, objectRow: objectRow, validScale: validScale, validLetterScale: validLetterScale, nonGpaLetter: nonGpaLetter, gradeOf: gradeOf, convert: convert, result: result };
});
