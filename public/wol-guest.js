// Gosc (bez zalogowanego portfela) moze przegladac strony gry; w prawym gornym rogu dostaje zolty przycisk
// "Connect wallet", ktory prowadzi na strone logowania (tylko portfel DogeOS, bez nazwy uzytkownika i hasla).
(function () {
  var token = null;
  try { token = localStorage.getItem('authToken') || localStorage.getItem('token'); } catch (e) { /* ignore */ }
  if (token) return;
  function add() {
    if (document.getElementById('wolGuestConnect')) return;
    var a = document.createElement('a');
    a.id = 'wolGuestConnect';
    a.href = '/login.html';
    a.textContent = 'Connect wallet';
    a.style.cssText = 'position:fixed;top:41.22px;right:111px;z-index:9998;padding:10px 18px;border-radius:8px;font:800 15px "Segoe UI",system-ui,sans-serif;text-decoration:none;color:#1a1405;background:linear-gradient(#e8c766,#b8932f);box-shadow:0 4px 14px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25)';
    document.body.appendChild(a);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
