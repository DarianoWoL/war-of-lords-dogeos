// Theme switch: "Classic" (medieval) vs "Doge" (playful). Choice is remembered per browser.
// Loaded in <head> of every page: applies the theme before first paint, then adds a small toggle.
(function () {
  var KEY = 'wolTheme', theme = 'doge';
  try { var q = /[?&]theme=(doge|classic)/.exec(location.search); if (q) localStorage.setItem(KEY, q[1]); } catch (e) {}
  try { theme = localStorage.getItem(KEY) === 'classic' ? 'classic' : 'doge'; } catch (e) {}
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (/game\.html$/.test(location.pathname)) root.setAttribute('data-page', 'game');
  if (theme === 'doge') document.write('<link rel="stylesheet" href="/doge-theme.css">');

  // Some pages (home) have a shorter menu; in Doge look give them the full set of links.
  function fillNav() {
    var nav = document.querySelector('.nav-menu'); if (!nav || theme !== 'doge') return;
    if (!nav.querySelector('.wolNavLogo')) {
      var lg = document.createElement('img'); lg.className = 'wolNavLogo'; lg.src = '/assets/logo-wol-doge.png'; lg.alt = 'War of Lords';
      lg.onclick = function () { location.href = 'index.html'; };
      nav.insertBefore(lg, nav.firstChild);
    }
    [['navMiniTournaments', 'mini-tournaments.html', 'Mini-Tournaments']].forEach(function (l) {
      if (nav.querySelector('#' + l[0])) return;
      var a = document.createElement('a'); a.id = l[0]; a.href = l[1]; a.textContent = l[2];
      if (location.pathname.indexOf(l[1]) !== -1) a.className = 'active';
      nav.appendChild(a);
    });
  }

  // The wallet button/widget are fixed, but inside the scaled <body> they scroll away; in Doge look keep them on <html> so they stay pinned to the menu bar.
  if (theme === 'doge') {
    var movePinned = function (n) { if (n && n.id && (n.id === 'wolGuestConnect' || n.id === 'wolWalletWidget') && n.parentNode !== root) root.appendChild(n); };
    new MutationObserver(function (list) { list.forEach(function (m) { m.addedNodes.forEach(movePinned); }); }).observe(root, { childList: true, subtree: true });
  }

  // Betting is switched off in this build: hide every "Live Bets" link and send the old page home.
  function hideBets() {
    Array.prototype.forEach.call(document.querySelectorAll('a[href="live.html"], a[href="/live.html"]'), function (a) { a.style.display = 'none'; });
  }
  if (/\/live(\.html)?$/.test(location.pathname)) location.replace('/index.html');

  // The menu links are absolutely positioned by the layout editor; with "Live Bets" hidden a gap is left in the middle.
  // Re-space the visible links evenly over the same span, and keep the wallet button level with the menu row.
  var PAD = 40; // equal inner padding on the left and the right edge of the bar (design px)
  function pinnedEl() { return document.getElementById('wolWalletWidget') || document.getElementById('wolGuestConnect'); }
  function layoutNav() {
    if (theme !== 'doge') return;
    var nav = document.querySelector('.nav-menu'); if (!nav || !nav.offsetWidth) return;
    var links = ['navHome', 'navTournaments', 'navMiniTournaments', 'navRanking', 'navProfile', 'navRules']
      .map(function (id) { return document.getElementById(id); })
      .filter(function (a) { return a && a.offsetWidth > 0; });
    if (links.length < 2) return;
    var nr = nav.getBoundingClientRect(), k = nr.width / nav.offsetWidth || 1;
    var pin = pinnedEl(), end = nav.offsetWidth - PAD, slots = links.length - 1;
    if (pin) { var pr = pin.getBoundingClientRect(); if (pr.width > 0) { end = (pr.left - nr.left) / k - (window.innerWidth <= 900 ? 10 : 0); slots = links.length; } }
    var start = PAD, total = 0;
    links.forEach(function (a) { total += a.offsetWidth; });
    // equal gaps between all buttons, including the gap before the wallet button
    var gap = Math.max(14, Math.min(150, (end - start - total) / slots)), x = start;
    links.forEach(function (a) { a.style.setProperty('left', Math.round(x) + 'px', 'important'); x += a.offsetWidth + gap; });
  }
  function alignPinned() {
    if (theme !== 'doge') return;
    var nav = document.querySelector('.nav-menu'), ref = document.getElementById('navHome');
    ['wolGuestConnect', 'wolWalletWidget'].forEach(function (id) {
      var el = document.getElementById(id); if (!el) return;
      if (!ref || !nav || !nav.offsetWidth) { el.style.removeProperty('top'); el.style.removeProperty('right'); return; }
      var r = ref.getBoundingClientRect(), nr = nav.getBoundingClientRect(), k = nr.width / nav.offsetWidth || 1;
      // phones: the whole page is a 1998px canvas shrunk to fit, so shrink the wallet button with it
      if (window.innerWidth <= 900) { el.style.setProperty('transform', 'scale(' + (k * 1.2).toFixed(3) + ')', 'important'); el.style.setProperty('transform-origin', 'top right', 'important'); }
      else { el.style.removeProperty('transform'); el.style.removeProperty('transform-origin'); }
      // the visual height matters (on phones the button is scaled down with a transform)
      el.style.setProperty('top', Math.round(r.top + r.height / 2 - el.getBoundingClientRect().height / 2) + 'px', 'important');
      el.style.setProperty('right', Math.round(window.innerWidth - (nr.right - PAD * k)) + 'px', 'important');
    });
  }
  function startAlign() {
    alignPinned(); layoutNav();
    window.addEventListener('scroll', alignPinned, { passive: true });
    window.addEventListener("resize", function () { alignPinned(); layoutNav(); });
    setInterval(function () { alignPinned(); layoutNav(); }, 500);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { alignPinned(); layoutNav(); });
    setTimeout(layoutNav, 600);
  }

  function addToggle() {
    fillNav();
    hideBets();
    startAlign();
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'wolThemeToggle';
    b.textContent = theme === 'doge' ? '🏰 Classic look' : '🐶 Doge look';
    b.title = 'Switch the look of the game';
    b.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147482000;padding:9px 16px;border-radius:999px;' +
      'border:2px solid ' + (theme === 'doge' ? '#7a4a00' : '#e8c766') + ';cursor:pointer;font:700 14px "Segoe UI",sans-serif;' +
      'background:' + (theme === 'doge' ? '#ffd84a' : '#0f172a') + ';color:' + (theme === 'doge' ? '#4a2c00' : '#e8c766') + ';box-shadow:0 3px 10px rgba(0,0,0,.35)';
    b.onclick = function () {
      try { localStorage.setItem(KEY, theme === 'doge' ? 'classic' : 'doge'); } catch (e) {}
      location.reload();
    };
    // On <html>, not <body>: the body is scaled by page-scale.js, which would shrink and move a fixed button.
    root.appendChild(b);
  }

  // ---------------------------------------------------------------- automatic text contrast (Doge look only)
  // Many panels keep their original dark backgrounds while the Doge look recolours text (or the other way
  // round). For every element with its own text, compare the text colour with the real background under it;
  // when the contrast is poor, switch the text to light (dark background) or dark (light background).
  // Skipped: text with an outline/shadow (Doge buttons), text straight on the wallpaper, wallet window.
  function wolParse(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function wolLum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function wolBackground(el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n === document.documentElement || n === document.body) break;
      var cs = getComputedStyle(n), bi = cs.backgroundImage;
      if (bi && bi !== 'none') {
        if (bi.indexOf('url(') !== -1) return null;
        var cols = (bi.match(/rgba?\([^)]+\)/g) || []).map(wolParse).filter(Boolean);
        if (cols.length) {
          var avg = { r: 0, g: 0, b: 0, a: 0 };
          cols.forEach(function (c) { avg.r += c.r; avg.g += c.g; avg.b += c.b; avg.a += c.a; });
          layers.push({ r: avg.r / cols.length, g: avg.g / cols.length, b: avg.b / cols.length, a: avg.a / cols.length });
          if (layers[layers.length - 1].a >= 0.85) break;
          continue;
        }
      }
      var c = wolParse(cs.backgroundColor);
      if (c && c.a > 0.02) { layers.push(c); if (c.a >= 0.85) break; }
    }
    if (!layers.length || layers[layers.length - 1].a < 0.5) return null; // text over the wallpaper - unknown
    var base = layers[layers.length - 1], col = { r: base.r, g: base.g, b: base.b };
    for (var i = layers.length - 2; i >= 0; i--) {
      var L = layers[i];
      col = { r: L.r * L.a + col.r * (1 - L.a), g: L.g * L.a + col.g * (1 - L.a), b: L.b * L.a + col.b * (1 - L.a) };
    }
    return col;
  }
  function wolHasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  }
  var WOL_SKIP = 'script,style,svg,canvas,iframe,input,textarea,select,option,#wol-wallet-root,#wolThemeToggle,.wolNavLogo';
  function wolFixElement(el) {
    if (!el || el.nodeType !== 1 || !wolHasOwnText(el)) return;
    if (el.closest && el.closest(WOL_SKIP)) return;
    var cs = getComputedStyle(el);
    if (el.dataset.wolFix !== '1' && cs.textShadow && cs.textShadow !== 'none') return;
    if (el.dataset.wolFix === '1') el.style.removeProperty('color');
    var fg = wolParse(getComputedStyle(el).color), bg = wolBackground(el);
    if (!fg || !bg) { if (el.dataset.wolFix === '1') delete el.dataset.wolFix; return; }
    var l1 = wolLum(fg), l2 = wolLum(bg);
    var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio >= 3) { delete el.dataset.wolFix; return; }
    el.style.setProperty('color', l2 < 0.35 ? '#fff4d6' : '#3a2200', 'important');
    el.dataset.wolFix = '1';
  }
  function wolFixTree(root) {
    if (!root || root.nodeType !== 1) return;
    wolFixElement(root);
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) wolFixElement(all[i]);
  }
  function startContrast() {
    if (theme !== 'doge') return;
    var pending = new Set(), timer = null;
    function flush() {
      timer = null;
      var list = Array.from(pending); pending.clear();
      list.forEach(function (n) { if (n.isConnected) wolFixTree(n); });
    }
    function queue(n) {
      if (n && n.nodeType === 3) n = n.parentElement;
      if (!n || n.nodeType !== 1) return;
      pending.add(n);
      if (!timer) timer = setTimeout(flush, 250);
    }
    wolFixTree(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === 'childList') { m.addedNodes.forEach(queue); if (m.addedNodes.length) queue(m.target); }
        else if (m.type === 'characterData') queue(m.target);
        else if (m.type === 'attributes') queue(m.target);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('load', function () { wolFixTree(document.body); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { addToggle(); startContrast(); }); else { addToggle(); startContrast(); }
})();
