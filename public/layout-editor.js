// Site-wide "drag anywhere, resize by stretching" layout customization. By default applies to
// every top-level (direct body child) section on the page it's loaded into — nav bar, info bars,
// banners, the main content grid, panel cards, etc. — letting the player freely reposition and
// resize each one, persisted per page (by pathname) in this browser's localStorage.
//
// A page can ALSO opt in to a second, narrower editor scoped to the direct children of one
// specific container (e.g. the game's #topBar), instead of — or in addition to — the whole-page
// one. Declare this before the script tag loads:
//   <script>window.__layoutEditorExtraScopes = [{ selector: '#topBar', keySuffix: 'topBar' }];</script>
//   <script src="/layout-editor.js"></script>
// Pages that don't define that global keep the exact original whole-page behavior.
//
// A scope can also set `global: true` to share one saved layout across every page that declares
// the same keySuffix, instead of keying it per-pathname — used for a component (like the site nav
// bar) that's duplicated identically on many pages and should look the same everywhere once the
// player adjusts it on any one of them. This requires the scoped elements to carry stable `id`s
// (rather than relying on class/tag position) so a link's saved position still matches it on a
// page where the surrounding set of links, or which one is "active", differs.
//
// Deliberately scoped to a container's direct children, not every nested element: most pages
// rebuild their inner content (room cards, tables, lists) from live server data every few
// seconds, so making those individually draggable would just have them snap back on the next
// refresh. Direct children of a stable container (the body's top-level sections, or the game's
// #topBar sub-panels, whose own text gets updated in place rather than the elements being
// replaced) stay put across refreshes, so dragging/resizing them actually sticks.
//
// Elements are left in NORMAL DOCUMENT FLOW until the moment the player actually grabs a drag or
// resize handle — only then do we freeze their current (by then fully rendered, real-data-sized)
// position into `position: absolute`. Freezing eagerly at page load was tried first and caused a
// real bug: most sections populate themselves from an async fetch (room lists, rankings, etc.),
// so measuring before that data arrives freezes everyone at their placeholder-content size —
// later, when a panel grows taller after real data loads, nothing pushes the sections after it
// down anymore (position:absolute is out of flow), so panels end up overlapping. An element with
// a previously SAVED layout is the one exception: that's an explicit, already-final position, not
// a page-load-time guess, so it's safe to apply immediately.
(function () {
    'use strict';

    let stylesInjected = false;

    function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const style = document.createElement('style');
        style.className = 'layout-editor-ignore';
        style.textContent = [
            '.layout-editor-drag-handle {',
            '  position: absolute; top: 2px; left: 2px; width: 24px; height: 24px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(212, 175, 55, 0.9); color: #1c1408; border-radius: 6px;',
            '  cursor: grab; font-size: 15px; z-index: 999; user-select: none; touch-action: none;',
            '  box-shadow: 0 2px 6px rgba(0,0,0,0.4);',
            '}',
            '.layout-editor-drag-handle:active { cursor: grabbing; }',
            '.layout-editor-resize-handle {',
            '  position: absolute; bottom: 0; right: 0; width: 18px; height: 18px;',
            '  cursor: nwse-resize; z-index: 999; touch-action: none;',
            '  background: linear-gradient(135deg, transparent 50%, rgba(212, 175, 55, 0.9) 50%);',
            '  border-bottom-right-radius: 8px;',
            '}',
            '.layout-editor-reset-btn {',
            '  position: fixed; z-index: 99999;',
            '  background: #1e293b; color: #e8c766; border: 1px solid rgba(212, 175, 55, 0.5);',
            '  border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: bold;',
            '  cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.4);',
            '}',
            '.layout-editor-reset-btn:hover { background: #334155; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // Removes every saved layout for this pathname in one go — both the whole-page layout (if
    // any) and any scoped ones (e.g. the top bar) — so a single reset button always leaves the
    // player with a fully clean slate instead of a partial one.
    function resetAllLayoutsForThisPage() {
        const prefix = 'layoutEditor:' + window.location.pathname;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k === prefix || (k && k.indexOf(prefix + ':') === 0)) toRemove.push(k);
        }
        toRemove.forEach((k) => localStorage.removeItem(k));
    }

    function addResetButton(label, position) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.className = 'layout-editor-reset-btn layout-editor-ignore';
        btn.style.bottom = position.bottom;
        btn.style.right = position.right;
        btn.addEventListener('click', () => {
            if (!window.confirm('Przywrócić domyślny układ tej strony? Twoje przesunięcia i rozmiary na tej stronie zostaną utracone.')) return;
            resetAllLayoutsForThisPage();
            window.location.reload();
        });
        document.body.appendChild(btn);
    }

    // Builds one editor instance scoped to `container`'s direct children. `isRoot` selects
    // viewport/document-relative absolute positioning (the original whole-page behavior, anchored
    // via window scroll offsets) vs container-relative positioning (for a nested scope like
    // #topBar, anchored to that element's own box instead of the page).
    function createEditor(container, storageKey, opts) {
        const isRoot = !!opts.isRoot;
        const minWidth = opts.minWidth || 160;
        const minHeight = opts.minHeight || 60;
        const locked = !!opts.locked;
        // `fixed`: position the element with `position: fixed` (pure viewport coordinates, no
        // scroll compensation, ignores any positioned ancestor) instead of `position: absolute`.
        // Needed for a single element that's nested deep inside other, already-positioned
        // elements (e.g. a button inside a container that itself got frozen to position:absolute)
        // — plain `absolute` would then resolve against that ancestor instead of the viewport.
        const useFixed = !!opts.fixed;
        // Elements to skip even though they're structurally eligible — used so the whole-page
        // editor doesn't ALSO pick up an element that's independently managed by an
        // `elementSelector` scope (e.g. a whole nav bar dragged as one unit). Without this, both
        // editors would inject their own drag/resize handles into the same element and fight over
        // it under two different storage keys — and if the whole-page editor's `.init()` runs
        // first (it's always pushed before extraScopes), its handles get appended as DIRECT
        // CHILDREN of that element, which a `selector`-scoped editor for the same element (managing
        // ITS children individually) would then wrongly scoop up as if they were real content.
        const excludeSet = opts.exclude ? new Set(opts.exclude) : null;

        function loadLayout() {
            try {
                return JSON.parse(localStorage.getItem(storageKey) || '{}');
            } catch (e) {
                return {};
            }
        }

        function saveLayout(layout) {
            try {
                localStorage.setItem(storageKey, JSON.stringify(layout));
            } catch (e) {
                console.error('layout-editor: could not save layout', e);
            }
        }

        // `seenCounts` tracks how many elements sharing this same class (or tag, if classless)
        // have already been keyed THIS init() run — so the index suffix only disambiguates genuine
        // siblings of the same kind, instead of counting every eligible element regardless of
        // type. That's what makes a saved position survive edits like "insert a new toggle bar
        // before the info-bar": the info-bar's key no longer shifts just because something
        // unrelated was added earlier. (An id is always preferred when present, and never depends
        // on position at all.)
        function keyFor(el, seenCounts) {
            if (el.id) return 'id:' + el.id;
            const label = (el.className && typeof el.className === 'string' && el.className.trim())
                ? 'class:' + el.className.trim().split(/\s+/).join('.')
                : 'tag:' + el.tagName;
            const n = seenCounts[label] || 0;
            seenCounts[label] = n + 1;
            return label + ':' + n;
        }

        function isEligible(el) {
            if (!(el instanceof HTMLElement)) return false;
            const tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
            if (el.classList.contains('layout-editor-ignore')) return false;
            if (el.classList.contains('layout-editor-reset-btn')) return false;
            if (excludeSet && excludeSet.has(el)) return false;
            return true;
        }

        // The container's own natural (flow-based) size, captured once before anything gets
        // converted to position:absolute — the floor for how big the container should ever be,
        // regardless of what floats around inside it afterward.
        let baselineHeight = 0;

        function recomputeContainerSize(managed) {
            if (useFixed) return; // fixed elements float independent of document/container flow
            let maxBottom = 0;
            const containerRect = isRoot ? null : container.getBoundingClientRect();
            managed.forEach(({ el }) => {
                if (el.style.position !== 'absolute' || el.style.display === 'none') return;
                const rect = el.getBoundingClientRect();
                const bottom = isRoot
                    ? window.scrollY + rect.bottom
                    : rect.bottom - containerRect.top;
                if (bottom > maxBottom) maxBottom = bottom;
            });
            if (isRoot) {
                document.body.style.minHeight = Math.max(baselineHeight, maxBottom + 80, window.innerHeight) + 'px';
            } else {
                container.style.minHeight = Math.max(baselineHeight, maxBottom + 16) + 'px';
            }
        }

        function makeManageable(el, key, layout, managed) {
            const saved = layout[key];
            let frozen = false;

            // Turns the element from "sitting normally in the page flow" into "a free-floating
            // panel pinned at its CURRENT on-screen position" — called either immediately (if a
            // saved layout already exists) or lazily on the first drag/resize interaction.
            //
            // Either way, leaving the flow for position:absolute/fixed would otherwise let
            // whatever came after the element snap up into the space it used to occupy — on a
            // live drag that's an obvious jump the instant the player grabs the handle; on a page
            // load with an already-saved layout it's just as real (every later sibling renders as
            // if the element was never there), just less visually dramatic since there's no
            // "before" frame to compare against. Both paths reach this point with `el` still in
            // its normal, unmutated flow position (the `position: relative` set by the caller
            // doesn't change its flow footprint), so measuring it here and inserting a same-sized
            // invisible spacer right after it holds that spot open permanently, however the
            // element itself ends up positioned.
            function freeze(explicit) {
                if (frozen) return;
                frozen = true;
                const flowRect = el.getBoundingClientRect();
                const flowComputed = window.getComputedStyle(el);
                const placeholder = document.createElement('div');
                placeholder.className = 'layout-editor-ignore';
                placeholder.style.display = flowComputed.display === 'inline' ? 'inline-block' : flowComputed.display;
                placeholder.style.flex = '0 0 auto';
                placeholder.style.width = flowRect.width + 'px';
                placeholder.style.height = flowRect.height + 'px';
                placeholder.style.marginTop = flowComputed.marginTop;
                placeholder.style.marginRight = flowComputed.marginRight;
                placeholder.style.marginBottom = flowComputed.marginBottom;
                placeholder.style.marginLeft = flowComputed.marginLeft;
                placeholder.style.visibility = 'hidden';
                el.parentNode.insertBefore(placeholder, el.nextSibling);
                let left, top;
                if (useFixed) {
                    // position:fixed's coordinate system IS the viewport — no scroll or ancestor
                    // compensation needed, getBoundingClientRect() can be used as-is.
                    left = explicit ? explicit.left : Math.round(el.getBoundingClientRect().left);
                    top = explicit ? explicit.top : Math.round(el.getBoundingClientRect().top);
                } else {
                    const containerRect = isRoot ? null : container.getBoundingClientRect();
                    const refLeft = isRoot ? -window.scrollX : containerRect.left;
                    const refTop = isRoot ? -window.scrollY : containerRect.top;
                    left = explicit ? explicit.left : Math.round(el.getBoundingClientRect().left - refLeft);
                    top = explicit ? explicit.top : Math.round(el.getBoundingClientRect().top - refTop);
                }
                const width = explicit ? explicit.width : Math.round(el.getBoundingClientRect().width);
                el.style.position = useFixed ? 'fixed' : 'absolute';
                el.style.left = left + 'px';
                el.style.top = top + 'px';
                el.style.width = width + 'px';
                if (explicit && explicit.height) el.style.height = explicit.height + 'px';
                el.style.boxSizing = 'border-box';
                el.style.margin = '0';
                if (!el.style.zIndex) el.style.zIndex = '1';
            }

            // Anchors the drag/resize handle overlays even pre-freeze — but only forces `relative`
            // when the element is still plain `static`. An element can already ship with a baked
            // default position (e.g. a nav link permanently positioned via CSS after a player-
            // arranged layout was adopted site-wide) — `absolute` is just as valid a positioning
            // context for the handles, and overwriting it here would silently discard that default
            // for every visitor who has no saved layout of their own for this key.
            if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
            if (saved) freeze(saved);

            if (locked) {
                // Applies whatever position the player already saved (if any) and stops there —
                // no handles, no further dragging. Used for a scope that should render exactly as
                // it was left, permanently.
                managed.push({ el, key });
                return;
            }

            const dragHandle = document.createElement('div');
            dragHandle.className = 'layout-editor-drag-handle';
            dragHandle.title = 'Przeciągnij, aby przesunąć';
            dragHandle.textContent = '⠿';
            el.appendChild(dragHandle);

            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'layout-editor-resize-handle';
            resizeHandle.title = 'Przeciągnij, aby zmienić rozmiar';
            el.appendChild(resizeHandle);

            managed.push({ el, key });

            function persist() {
                layout[key] = {
                    left: parseFloat(el.style.left),
                    top: parseFloat(el.style.top),
                    width: parseFloat(el.style.width),
                    height: el.style.height ? parseFloat(el.style.height) : undefined
                };
                saveLayout(layout);
                recomputeContainerSize(managed);
            }

            let dragging = false, dragStartX = 0, dragStartY = 0, elStartLeft = 0, elStartTop = 0;
            dragHandle.addEventListener('pointerdown', (e) => {
                freeze();
                dragging = true;
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                elStartLeft = parseFloat(el.style.left);
                elStartTop = parseFloat(el.style.top);
                el.style.zIndex = '1000';
                dragHandle.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            dragHandle.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;
                el.style.left = Math.max(0, elStartLeft + dx) + 'px';
                el.style.top = Math.max(0, elStartTop + dy) + 'px';
                recomputeContainerSize(managed);
            });
            function endDrag() {
                if (!dragging) return;
                dragging = false;
                el.style.zIndex = '1';
                persist();
            }
            dragHandle.addEventListener('pointerup', endDrag);
            dragHandle.addEventListener('pointercancel', endDrag);

            let resizing = false, resizeStartX = 0, resizeStartY = 0, elStartWidth = 0, elStartHeight = 0;
            resizeHandle.addEventListener('pointerdown', (e) => {
                freeze();
                resizing = true;
                resizeStartX = e.clientX;
                resizeStartY = e.clientY;
                const r = el.getBoundingClientRect();
                elStartWidth = r.width;
                elStartHeight = r.height;
                el.style.zIndex = '1000';
                resizeHandle.setPointerCapture(e.pointerId);
                e.preventDefault();
                e.stopPropagation();
            });
            resizeHandle.addEventListener('pointermove', (e) => {
                if (!resizing) return;
                const dx = e.clientX - resizeStartX;
                const dy = e.clientY - resizeStartY;
                el.style.width = Math.max(minWidth, elStartWidth + dx) + 'px';
                el.style.height = Math.max(minHeight, elStartHeight + dy) + 'px';
                recomputeContainerSize(managed);
            });
            function endResize() {
                if (!resizing) return;
                resizing = false;
                el.style.zIndex = '1';
                persist();
            }
            resizeHandle.addEventListener('pointerup', endResize);
            resizeHandle.addEventListener('pointercancel', endResize);
        }

        return {
            init() {
                baselineHeight = isRoot ? document.documentElement.scrollHeight : container.getBoundingClientRect().height;
                if (!isRoot && getComputedStyle(container).position === 'static') {
                    container.style.position = 'relative'; // positioning context for frozen children
                }
                const layout = loadLayout();
                const managed = [];
                const candidates = Array.prototype.slice.call(container.children);
                const seenCounts = {};
                candidates.forEach((el) => {
                    if (!isEligible(el)) return;
                    const computed = window.getComputedStyle(el);
                    // A broad scan (whole-page, or a `selector` scope's children) skips anything
                    // currently display:none — usually a banner/panel an async check hasn't
                    // decided to show yet, so there's nothing meaningful to measure or manage. An
                    // `elementSelector` scope is different: it names ONE specific element on
                    // purpose, so it should still get its handle wired up even if that element
                    // happens to be hidden at page-load (e.g. a banner shown later once an async
                    // fetch resolves) — `opts.alwaysManage` opts out of the skip for that case.
                    if (computed.display === 'none' && !opts.alwaysManage) return;
                    const key = keyFor(el, seenCounts);
                    makeManageable(el, key, layout, managed);
                });
                recomputeContainerSize(managed);
                window.addEventListener('resize', () => recomputeContainerSize(managed));
            }
        };
    }

    function init() {
        injectStyles();
        const editors = [];
        const extraScopes = Array.isArray(window.__layoutEditorExtraScopes) ? window.__layoutEditorExtraScopes : [];
        const runWholePage = extraScopes.length === 0 || extraScopes.some((s) => s.keepWholePage);
        const elementScopeTargets = extraScopes
            .filter((s) => s.elementSelector)
            .map((s) => document.querySelector(s.elementSelector))
            .filter(Boolean);

        if (runWholePage) {
            editors.push(createEditor(document.body, 'layoutEditor:' + window.location.pathname, { isRoot: true, exclude: elementScopeTargets }));
        }
        extraScopes.forEach((scope) => {
            // `elementSelector` manages ONE specific element directly (e.g. a single button
            // nested deep inside a fixed, non-draggable bar, or a whole bar that should be
            // draggable/resizable as one unit alongside a `selector` scope managing its individual
            // children), as opposed to `selector` which manages every direct child of a container.
            // Defaults to `position: fixed` (pure viewport coordinates) rather than the whole-page
            // editor's `absolute`, since this element may sit inside other already-positioned
            // ancestors that `absolute` would wrongly resolve against — pass `fixed: false` to opt
            // back into scroll-compensated `absolute` positioning (e.g. for a normal-flow top-level
            // element like a nav bar, so it scrolls away with the page instead of staying pinned).
            const storageKey = scope.global
                ? 'layoutEditor:global:' + scope.keySuffix
                : 'layoutEditor:' + window.location.pathname + ':' + scope.keySuffix;
            if (scope.elementSelector) {
                const el = document.querySelector(scope.elementSelector);
                if (!el) return;
                editors.push(createEditor({ children: [el] }, storageKey, {
                    isRoot: true,
                    fixed: scope.fixed !== false,
                    minWidth: scope.minWidth,
                    minHeight: scope.minHeight,
                    alwaysManage: true
                }));
                return;
            }
            const el = document.querySelector(scope.selector);
            if (!el) return;
            editors.push(createEditor(el, storageKey, {
                isRoot: false,
                minWidth: scope.minWidth,
                minHeight: scope.minHeight
            }));
        });

        editors.forEach((e) => e.init());
        addResetButton('↺ Resetuj układ strony', { bottom: '16px', right: '16px' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
