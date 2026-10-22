// Sprawdza, co robi okno DogeOS (SDK) z ukladem strony skalowanej: porownuje body/html przed i po otwarciu okna logowania.
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1500, height: 900 } });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3101/index.html', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));
  const snap = () => page.evaluate(() => ({
    bodyStyle: document.body.getAttribute('style'), htmlStyle: document.documentElement.getAttribute('style'),
    bodyTransform: getComputedStyle(document.body).transform, bodyOverflow: getComputedStyle(document.body).overflow, htmlOverflow: getComputedStyle(document.documentElement).overflow,
    clientWidth: document.documentElement.clientWidth, bodyRectWidth: Math.round(document.body.getBoundingClientRect().width), bodyLeft: Math.round(document.body.getBoundingClientRect().left),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ id: f.id.slice(0, 8), parent: f.parentElement.tagName, style: f.getAttribute('style') }))
  }));
  console.log('BEFORE', JSON.stringify(await snap()));
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'layout-before.png') });
  await page.evaluate(() => { WolConnect.connect().catch(() => {}); });
  await new Promise((r) => setTimeout(r, 9000));
  console.log('AFTER ', JSON.stringify(await snap()));
  await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'layout-after.png') });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(2); });
