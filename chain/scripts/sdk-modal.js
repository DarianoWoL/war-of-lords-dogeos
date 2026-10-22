// Sprawdza, czy pakiet DogeOS Connect Kit laduje sie na stronie logowania i otwiera okno (bez prawdziwego clientId nie zaloguje).
const path = require('path');
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1100, height: 900 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 140)); });
  page.on('requestfailed', (r) => errors.push('reqfailed: ' + r.url().slice(0, 120)));
  await page.goto('http://127.0.0.1:3101/login.html', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => { const b = document.getElementById('connectWalletBtn'); return b && !b.disabled; });
  await page.click('#connectWalletBtn');
  await new Promise((r) => setTimeout(r, 9000));
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '5-sdk-modal.png') });
  const info = await page.evaluate(() => ({ wol: typeof window.WolWallet, state: window.WolWallet && window.WolWallet.state(), dialogs: document.querySelectorAll('[role=dialog]').length, text: (document.querySelector('[role=dialog]') || {}).innerText }));
  console.log(JSON.stringify(info, null, 1).slice(0, 1200));
  console.log('ERRORS:', errors.slice(0, 12));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(2); });
