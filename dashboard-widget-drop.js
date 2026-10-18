/* Runs in MAIN: course ordering stays owned and persisted by Canvas. */
(function () {
  'use strict';
  var source = null;
  function propsFor(node) {
    if (!node) return null;
    var key = Object.keys(node).find(function (k) { return /^__react(Fiber|InternalInstance)\$/.test(k); });
    var fiber = key && node[key];
    for (var i = 0; fiber && i < 30; i++, fiber = fiber.return) {
      var p = fiber.memoizedProps;
      if (p && typeof p.moveCard === 'function' && typeof p.assetString === 'string') return p;
    }
    return null;
  }
  document.addEventListener('dragstart', function (event) {
    var card = event.target instanceof Element && event.target.closest('.ic-DashboardCard:not(.mcx-focus-vcard)');
    source = card && propsFor(card) ? card : null;
  }, true);
  document.addEventListener('dragend', function () { source = null; }, true);
  document.addEventListener('dragover', function (event) {
    var widget = event.target instanceof Element && event.target.closest('.mcx-focus-vcard');
    if (source && widget && source.parentNode === widget.parentNode) event.preventDefault();
  }, true);
  document.addEventListener('drop', function (event) {
    var widget = event.target instanceof Element && event.target.closest('.mcx-focus-vcard');
    if (!source || !widget || source.parentNode !== widget.parentNode) return;
    var parent = widget.parentNode;
    var children = Array.from(parent.children);
    var courses = children.filter(function (c) { return c.matches('.ic-DashboardCard:not(.mcx-focus-vcard)'); });
    var p = propsFor(source);
    // Split dashboards need a separate mapping from local to global positions.
    if (!p || p.totalCards !== courses.length) return;
    var position = children.slice(0, children.indexOf(widget)).filter(function (c) {
      return c !== source && courses.indexOf(c) !== -1;
    }).length;
    var rect = widget.getBoundingClientRect();
    var widgetPosition = position + (event.clientX < rect.left + rect.width / 2 ? 1 : 0);
    event.preventDefault();
    // Let the Canvas HTML5 backend receive drop so its drag lifecycle completes.
    widget.setAttribute('data-mcx-course-drop-pending', '1');
    var timer = setTimeout(function () { widget.removeAttribute('data-mcx-course-drop-pending'); }, 2000);
    try {
      p.moveCard(p.assetString, position, function () {
        clearTimeout(timer);
        widget.dispatchEvent(new CustomEvent('mcx-wall-course-drop', {
          detail: JSON.stringify({ position: widgetPosition })
        }));
        widget.removeAttribute('data-mcx-course-drop-pending');
      });
    } catch (error) {
      clearTimeout(timer);
      widget.removeAttribute('data-mcx-course-drop-pending');
    }
  }, true);
})();
