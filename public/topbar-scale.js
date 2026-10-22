// #topBar's children (treasury panel, round timer, village-name switcher, player panel) are
// positioned with fixed pixel offsets, hand-tuned via the old drag/resize layout editor against
// #topBar's own natural width of 1404px (the .page-shell content width at its 1440px max-width).
// Below that width — any narrower desktop window, and every mobile screen — those absolute
// pixel offsets used to spill outside the now-narrower #topBar (which itself shrinks to fit,
// since it's a plain block filling its container) while the children stayed put at their
// full-width coordinates, scattering them off to the side instead of on the ribbon graphic.
//
// Fix: keep #topBar itself pinned at its natural 1404px design width, and uniformly shrink the
// whole element (background image + every child, together) with transform:scale() to fit
// whatever width is actually available — exactly mirroring page-scale.js's own proven technique,
// just scoped to this one element instead of the whole page (game.html deliberately doesn't use
// page-scale.js itself, since a forced-width transform on the whole body would conflict with its
// own separate @media breakpoints for the sidebars/panel grid below).
(function () {
    var DESIGN_WIDTH = 1404;
    var wrapper = document.getElementById('topBarScaleWrapper');
    var bar = document.getElementById('topBar');
    if (!wrapper || !bar) return;
    var scale = 1;

    // Recomputes the scale from the wrapper's available width, and pins #topBar to its design
    // width so the scale is meaningful — only ever triggered by an actual window resize (or
    // first load), never by the ResizeObserver below, so setting bar.style.width here can't turn
    // into a resize-observer feedback loop.
    function applyScale() {
        var availableWidth = wrapper.clientWidth;
        if (!availableWidth) return;
        // Never upscale beyond the hand-tuned native size — 1 is the correct look, not a cap to
        // shrink toward like page-scale.js's 0.9 (that page-wide script leaves headroom on
        // purpose; this element was tuned to look right at exactly its own full design width).
        scale = Math.min(1, availableWidth / DESIGN_WIDTH);
        bar.style.width = DESIGN_WIDTH + 'px';
        bar.style.transform = 'scale(' + scale + ')';
        updateWrapperHeight();
    }

    // transform only affects painting, not layout — bar.offsetHeight always reflects the
    // natural (unscaled) height, which is what the wrapper needs sized down by `scale` to,
    // otherwise it would keep reserving the full unscaled height of empty space below it. Kept
    // separate from applyScale() so #topBar's own natural height changing independently of window
    // width (e.g. the max-height:950px media query trimming its padding) can resync the wrapper
    // via ResizeObserver using the current scale, without recomputing/reassigning bar's own width.
    function updateWrapperHeight() {
        wrapper.style.height = (bar.offsetHeight * scale) + 'px';
    }

    window.addEventListener('resize', applyScale);
    if (window.ResizeObserver) {
        new ResizeObserver(updateWrapperHeight).observe(bar);
    }
    applyScale();
    wrapper.style.visibility = 'visible';
})();
