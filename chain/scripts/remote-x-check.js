// Klika "X" w oknie DogeOS na wersji VPS i pokazuje odpowiedzi przekaznika (do diagnozy bledu "authentication delivery is not allowed").
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const BASE = process.env.BASE || 'https://dogeos.waroflords.pl';
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const log = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (/relay\.|mydoge|dogeos|tomo/.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(u)) {
      let body = ''; try { body = (await r.text()).slice(0, 220); } catch (_) {}
      log.push(`${r.request().method()} ${r.status()} ${u.slice(0, 150)} ${body}`);
    }
  });
  const url = process.env.INVITE ? `${BASE}/login.html?invite=${process.env.INVITE}` : `${BASE}/login.html`;
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => { const b = document.getElementById('connectWalletBtn'); return b && !b.disabled; });
  await page.click('#connectWalletBtn');
  await new Promise((r) => setTimeout(r, 6000));
  const pos = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('[role=dialog] *')].filter((e) => (e.textContent || '').trim() === 'X');
    const el = cands[cands.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName };
  });
  let clicked = false;
  if (pos) { await page.mouse.click(pos.x, pos.y); clicked = true; }
  await new Promise((r) => setTimeout(r, 7000));
  const text = await page.evaluate(() => (document.querySelector('[role=dialog]') || {}).innerText || '');
  console.log('clicked X:', clicked, '\nDIALOG:', text.slice(0, 300).replace(/\n/g, ' | '));
  console.log(log.slice(-12).join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(2); });
