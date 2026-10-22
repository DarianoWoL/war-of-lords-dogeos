// Sprawdza z zewnatrz, czy przekaznik DogeOS akceptuje logowanie dla wersji na VPS.
// Uzycie: PROVIDER=email|X URL="https://dogeos.waroflords.pl/login.html?invite=..." node scripts/remote-email-flow-check.js
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const out = [];
  page.on('response', async (r) => { if (/relay\.mydoge.*(flows|bootstrap)/.test(r.url()) && r.request().method() === 'POST') { let b = ''; try { b = await r.text(); } catch (e) { /* ignore */ } out.push(`${r.status()} ${r.url().slice(0, 130)}\n   ${b.slice(0, 400)}`); } });
  page.on('request', (r) => { if (/relay\.mydoge.*flows/.test(r.url()) && r.method() === 'POST') out.push('REQ body: ' + (r.postData() || '').replace(/"verifierChallenge":"[^"]*"/, '"verifierChallenge":"…"').slice(0, 330)); });
  page.on('popup', async (p) => {
    out.push('POPUP opened: ' + p.url().slice(0, 150));
    for (const wait of [2500, 3500]) {
      await new Promise((r) => setTimeout(r, wait));
      try { const t = (await p.evaluate(() => document.body.innerText)).slice(0, 260).split(String.fromCharCode(10)).join(' / '); out.push('POPUP now: ' + p.url().slice(0, 170) + ' | text: ' + t); } catch (e) { out.push('POPUP closed or unreadable: ' + e.message.slice(0, 80)); }
    }
  });
  await page.goto(process.env.URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => { const b = document.getElementById('connectWalletBtn'); return b && !b.disabled; });
  await page.click('#connectWalletBtn');
  await page.waitForSelector('[role=dialog]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));
  const which = process.env.PROVIDER || 'email';
  if (which === 'email') {
    const input = await page.$('[role=dialog] input');
    await input.type('wol.test.user@example.com');
    const btn = await page.evaluateHandle(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => /continue/i.test(b.innerText)));
    await btn.asElement().click();
  } else {
    const names = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()));
    console.log('buttons:', JSON.stringify(names));
    const btn = await page.evaluateHandle((n) => [...document.querySelectorAll('[role=dialog] button')].find((b) => (b.innerText || '').trim() === n || (b.getAttribute('aria-label') || '').toLowerCase() === n.toLowerCase()), which);
    const el = btn.asElement();
    if (!el) { console.log('no button for', which); await browser.close(); return; }
    await el.click();
  }
  await new Promise((r) => setTimeout(r, 9000));
  console.log('DIALOG:', (await page.evaluate(() => (document.querySelector('[role=dialog]') || {}).innerText || '')).slice(0, 260).replace(/\n/g, ' | '));
  console.log(out.join('\n'));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(2); });
