const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 950 } });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:3101/index.html', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: 'E:/Gry/War of Lords/chain/screenshots/14-home.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})();
