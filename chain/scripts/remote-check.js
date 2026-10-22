// Sprawdza wersje na VPS z zewnatrz: wejscie z kluczem, strona logowania, okno DogeOS (X / Google / e-mail), brak bledow.
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const path = require('path');
const URL_ = 'https://dogeos.waroflords.pl';
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 110)); });
  await page.goto(`${URL_}/login.html?invite=${process.env.INVITE}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => { const b = document.getElementById('connectWalletBtn'); return b && !b.disabled; }, { timeout: 15000 });
  await page.click('#connectWalletBtn');
  await new Promise((r) => setTimeout(r, 9000));
  const info = await page.evaluate(() => ({ url: location.href, modal: (document.querySelector('[role=dialog]') || {}).innerText || null }));
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'remote-login.png') });
  console.log(JSON.stringify(info));
  console.log('ERRORS:', errors.slice(0, 8));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(2); });
