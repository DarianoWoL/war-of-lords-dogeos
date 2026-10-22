// Sprawdza, czy strony gracza (po angielsku) nie pokazuja polskiego tekstu: zbiera widoczny tekst i szuka polskich znakow/slow.
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const BASE = 'http://127.0.0.1:3101';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const pl = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(Serwer|serwer|wioska|Wioska|Brak|brak|gracz|Gracz|Runda|runda|Zakończona|Czekam|podlicza|Punkty|punkty|Nie można|Zamknij|Anuluj|Zapisz|Kup |Wróć|Opuść|Dołącz)\b/;
(async () => {
  const stamp = Date.now().toString().slice(-6);
  const name = 'lang_' + stamp;
  await api('POST', '/api/auth/register', null, { username: name, password: 'Haslo12345', email: name + '@t.local', termsAccepted: true });
  const token = (await api('POST', '/api/auth/login', null, { username: name, password: 'Haslo12345' })).token;
  const trial = await api('POST', '/api/trial/start', token);
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 1000 } });
  const pages = ['index.html', 'pokoje.html', 'turnieje.html', 'mini-tournaments.html', 'tournaments.html', 'ranking.html', 'profile.html', 'portfel.html', 'dogeos.html', 'zasady.html', 'zasady-turnieju.html', 'zasady-mini-turniej.html', 'regulamin.html', 'polityka-prywatnosci.html', 'game.html?roundId=' + trial.roundId];
  let bad = 0;
  for (const p of pages) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.evaluateOnNewDocument((tok) => { localStorage.setItem('authToken', tok); localStorage.setItem('token', tok); }, token);
    await page.goto(BASE + '/' + p, { waitUntil: 'networkidle0' }).catch(() => {});
    await sleep(2500);
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').filter((l) => pl.test(l)).map((l) => l.trim().slice(0, 120));
    console.log((lines.length ? ' POLISH ' : '  clean ') + p + (lines.length ? ' -> ' + lines.length + ' lines' : ''));
    lines.slice(0, 6).forEach((l) => console.log('      ' + l));
    if (lines.length) bad += 1;
    if (p.startsWith('game.html')) {
      for (const reason of ['timer', 'elimination_solo', 'elimination_team']) {
        const t = await page.evaluate((r) => { showRoundEndingOverlay(3, r); const o = document.getElementById('roundEndingOverlay') || document.querySelector('.round-ending-overlay'); return o ? o.innerText : 'NO OVERLAY'; }, reason);
        const flat = t.split(String.fromCharCode(10)).join(' | ');
        console.log((pl.test(t) ? ' POLISH ' : '  clean ') + 'round-ending overlay (' + reason + '): ' + flat.slice(0, 140));
        if (pl.test(t)) bad += 1;
      }
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
