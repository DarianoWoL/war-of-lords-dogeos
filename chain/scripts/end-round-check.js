// Koniec rundy: odliczanie zamyka wszystkie okna gry, a zamkniecie wynikow wraca do menu glownego.
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const BASE = 'http://127.0.0.1:3101';
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
(async () => {
  const name = 'end_' + Date.now().toString().slice(-6);
  await api('POST', '/api/auth/register', null, { username: name, password: 'Haslo12345', email: name + '@t.local', termsAccepted: true });
  const token = (await api('POST', '/api/auth/login', null, { username: name, password: 'Haslo12345' })).token;
  const trial = await api('POST', '/api/trial/start', token);
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 1000 } });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.evaluateOnNewDocument((tok) => { localStorage.setItem('authToken', tok); localStorage.setItem('token', tok); }, token);
  await page.goto(`${BASE}/game.html?roundId=${trial.roundId}`, { waitUntil: 'networkidle0' });
  await sleep(2500);
  // otwieramy kilka okien, jak w grze
  await page.evaluate(() => ['upgradeModal', 'villageListModal', 'reportsModal'].forEach((id) => document.getElementById(id).classList.add('active')));
  const before = await page.evaluate(() => document.querySelectorAll('.modal-backdrop.active').length);
  await page.evaluate(() => showRoundEndingOverlay(5, 'timer'));
  const after = await page.evaluate(() => document.querySelectorAll('.modal-backdrop.active').length);
  ok(before === 3 && after === 0, `countdown closes all open windows (${before} -> ${after})`);
  await page.evaluate(() => showRoundResults());
  await sleep(500);
  const btn = await page.evaluate(() => { const b = document.getElementById('closeRoundResultModal'); return b ? b.textContent.trim() : null; });
  ok(btn === 'Back to menu', `results button says "${btn}"`);
  await page.evaluate(() => document.getElementById('closeRoundResultModal').click());
  await page.waitForFunction(() => location.pathname.endsWith('index.html'), { timeout: 8000 }).then(() => ok(true, 'closing the results returns to the main menu'), () => ok(false, 'no redirect to the main menu'));
  ok(errs.length === 0, 'no page errors' + (errs[0] ? ': ' + errs[0] : ''));
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nEND-ROUND CHECK PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
