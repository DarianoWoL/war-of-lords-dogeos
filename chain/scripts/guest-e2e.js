// Gosc bez portfela: strony da sie przegladac, w rogu jest zolty "Connect wallet", akcje odsylaja do logowania,
// a strona logowania ma tylko Connect wallet (bez nazwy uzytkownika i hasla).
const path = require('path');
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const BASE = 'http://127.0.0.1:3101';
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } });
  const ctx = await browser.createBrowserContext();
  for (const p of ['index.html', 'pokoje.html', 'turnieje.html', 'mini-tournaments.html', 'tournaments.html', 'sklep.html', 'ranking.html', 'zasady.html']) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/${p}`, { waitUntil: 'networkidle0' });
    await sleep(800);
    const url = page.url();
    const btn = await page.$('#wolGuestConnect');
    ok(url.includes(p === 'sklep.html' ? 'dogeos.html' : p) && !!btn && errs.length === 0, `${p}: guest stays on the page, Connect wallet button present${errs.length ? ' | errors: ' + errs[0] : ''}`);
    if (p === 'pokoje.html') {
      await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '6-guest-rooms.png') });
      await page.evaluate(() => joinRoom('x', 'y'));
      await page.waitForFunction(() => location.pathname.includes('login.html'), { timeout: 8000 }).then(() => ok(true, 'pokoje.html: join as guest sends to the wallet login page'), () => ok(false, 'pokoje.html: join as guest did not redirect'));
    }
    await page.close();
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle0' });
  const info = await page.evaluate(() => ({ user: !!document.getElementById('username'), pass: !!document.getElementById('password'), reg: !!document.getElementById('registerForm'), btn: !!document.getElementById('connectWalletBtn') }));
  ok(!info.user && !info.pass && !info.reg && info.btn, 'login page: only Connect wallet (no username/password/register)');
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '7-login-wallet-only.png') });
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nGUEST E2E PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
