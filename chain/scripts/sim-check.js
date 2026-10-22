// Sprawdza strone symulacji turnieju: brak bledow, kolejne fazy i zrzuty ekranu.
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const path = require('path');
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1360, height: 900 } });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:3101/symulacja.html', { waitUntil: 'networkidle0' });
  const total = await page.evaluate(() => window.__sim.total());
  ok(total > 280 && total < 330, `full timeline is ${Math.round(total)} s (about 5 minutes)`);
  const shots = [[9, 'intro'], [30, 'qual1'], [112, 'qual4'], [119, 'cut'], [150, 'semi'], [180, 'final-bets'], [220, 'final-result'], [250, 'money'], [300, 'money-end']];
  for (const [t, name] of shots) {
    await page.evaluate((s) => window.__sim.seek(s), t);
    await sleep(700);
    await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', `sim-${name}.png`) });
  }
  const d = await page.evaluate(() => { const s = window.__sim.data(); return { champ: s.P[s.winnerId].name, semi: s.semi.length, finalists: s.finalists.length, wild: s.wild.length, bet: s.bet, money: s.money }; });
  ok(d.semi === 40 && d.finalists === 10 && d.wild === 2, `bracket sizes: ${d.semi} semifinalists, ${d.finalists} finalists (${d.wild} wildcards)`);
  const text = await page.evaluate(() => document.body.innerText);
  ok(text.includes(d.champ) && /what the game earned/i.test(text) && /who earned what/i.test(text), `final screen shows the champion (${d.champ}) and the money tables`);
  ok(Math.abs(d.money.revenue - 350 * 20) < 1 && d.money.carry > 0 && d.money.prizeTotal === 4600 && d.bet.bonus <= 750.01, `money: tickets ${d.money.revenue}, prizes ${d.money.prizeTotal}, carried over ${d.money.carry}`);
  ok(errs.length === 0, 'no page errors' + (errs[0] ? ': ' + errs[0] : ''));
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nSIMULATION CHECK PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
