// Theme switch: "Classic" (medieval) vs "Doge" (playful). Choice is remembered per browser.
// Loaded in <head> of every page: applies the theme before first paint, then adds a small toggle.
(function () {
  var KEY = 'wolTheme', theme = 'doge';
  try { var q = /[?&]theme=(doge|classic)/.exec(location.search); if (q) localStorage.setItem(KEY, q[1]); } catch (e) {}
  try { theme = localStorage.getItem(KEY) === 'classic' ? 'classic' : 'doge'; } catch (e) {}
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'doge') document.write('<link rel="stylesheet" href="/doge-theme.css">');

  // Some pages (home) have a shorter menu; in Doge look give them the full set of links.
  function fillNav() {
    var nav = document.querySelector('.nav-menu'); if (!nav || theme !== 'doge') return;
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

  function addToggle() {
    fillNav();
    hideBets();
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addToggle); else addToggle();
})();
