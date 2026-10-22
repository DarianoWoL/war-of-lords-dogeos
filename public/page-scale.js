// Pages built with the layout editor share one fixed design canvas (1998px wide, matching
// .nav-menu's width on every one of them) rather than a responsive layout — on any window
// narrower than that, content used to overflow/clip unless the player manually zoomed the browser
// out (e.g. to ~90%). This scales the whole page to fit the real window width automatically, for
// every visitor, regardless of their screen size — replacing the "type ctrl/cmd - a few times"
// workaround with something that just works.
(function () {
  var DESIGN_WIDTH = 1998;
  var body = document.body;
  var scale = 1;

  function applyScale() {
    // documentElement.clientWidth (not window.innerWidth) — clientWidth already excludes the
    // vertical scrollbar's own width, whereas innerWidth includes it in Chrome. Using innerWidth
    // here made the scaled page a few pixels too wide whenever a vertical scrollbar was showing,
    // which then triggered a second, horizontal scrollbar of its own.
    var availableWidth = document.documentElement.clientWidth || window.innerWidth;
    // Capped at 90% (not 100%) — the design canvas already looks correct with a bit of headroom
    // at 90%, so this is the max scale on any screen; narrower windows still shrink further below
    // that, same as before.
    scale = Math.min(0.9, availableWidth / DESIGN_WIDTH);
    // Center horizontally: whenever the 90% cap means the scaled page is narrower than the actual
    // viewport (any screen wider than ~2220px), the leftover space used to sit entirely on the
    // right (body pinned to the left edge via transform-origin) — this splits it evenly on both
    // sides instead. Applied as margin BEFORE the transform, so transform-origin:top-left still
    // scales from that (now centered) position rather than from the viewport's actual left edge.
    var scaledWidth = DESIGN_WIDTH * scale;
    var leftOffset = Math.max(0, (availableWidth - scaledWidth) / 2);
    body.style.transformOrigin = 'top left';
    body.style.transform = 'scale(' + scale + ')';
    body.style.width = DESIGN_WIDTH + 'px';
    body.style.marginLeft = leftOffset + 'px';
    document.documentElement.style.overflowX = 'hidden';
    updateHeight();
  }

  // transform only affects painting, not layout — body.scrollHeight always reflects the natural,
  // unscaled height, which is exactly what's needed to size the document to the scaled-down result
  // (otherwise the page would keep the full unscaled height's worth of scroll space below it).
  function updateHeight() {
    document.documentElement.style.height = (body.scrollHeight * scale) + 'px';
  }

  window.addEventListener('resize', applyScale);
  // Content that loads/changes after first paint (profile stats, room lists, rankings, etc. are
  // all fetched async on these pages) can change body's natural height without changing window
  // width — ResizeObserver catches that and re-syncs the compensated height without recalculating
  // the scale itself.
  if (window.ResizeObserver) {
    new ResizeObserver(updateHeight).observe(body);
  }

  // Pin the page background on <html> explicitly. Normally body's background propagates to the
  // canvas, but once anything (e.g. the wallet SDK) sets a background on <html>, the scaled body's
  // own background no longer reaches the side margins and they turn white.
  (function pinBackground() {
    if (document.documentElement.getAttribute('data-theme') === 'doge') { body.style.background = 'none'; return; } // Doge look paints its own <html> background
    var cs = getComputedStyle(body), root = document.documentElement.style;
    root.backgroundImage = cs.backgroundImage;
    root.backgroundSize = cs.backgroundSize;
    root.backgroundPosition = cs.backgroundPosition;
    root.backgroundRepeat = cs.backgroundRepeat;
    root.backgroundAttachment = cs.backgroundAttachment;
    root.backgroundColor = cs.backgroundColor;
    // Only <html> paints the background now; otherwise the scaled body draws a second, narrower copy.
    body.style.background = 'none';
  })();

  applyScale();
  body.style.visibility = 'visible';
})();
