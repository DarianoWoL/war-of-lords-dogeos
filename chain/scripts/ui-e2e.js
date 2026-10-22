// Test interfejsu dogeos.html w prawdziwej przegladarce (Edge headless) z atrapa portfela EIP-1193,
// ktora podpisuje kluczem testowym i wysyla transakcje do lokalnego wezla. Robi zrzuty ekranu.
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const puppeteer = require('E:/Gry/Naval Lords video/skrypty/node_modules/puppeteer-core');
const mongoose = require('../../node_modules/mongoose');

const BASE = 'http://127.0.0.1:3101';
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };

async function api(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
async function user(name) {
  await api('POST', '/api/auth/register', null, { username: name, password: 'Haslo12345', email: name + '@test.local', termsAccepted: true });
  return (await api('POST', '/api/auth/login', null, { username: name, password: 'Haslo12345' })).token;
}

(async () => {
  const funder = await provider.getSigner(1);
  const stamp = Date.now().toString().slice(-6);
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const wallet = ethers.Wallet.createRandom().connect(provider);
  await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('100') })).wait();
  const aliceToken = await user('ui_alice' + stamp);
  const adminName = 'ui_admin' + stamp;
  const adminToken = await user(adminName);
  await db.collection('users').updateOne({ username: adminName }, { $set: { isAdmin: true } });
  await db.collection('rooms').insertOne({ roomName: 'ui-mini-' + stamp, isMiniTournament: true, requiresMiniTournamentTicket: true, miniTournamentPrizes: { place1VPLN: 30, place2VPLN: 20, place3VPLN: 10 }, enabled: true, maxPlayers: 2, waitingPlayers: [], settings: {}, createdAt: new Date() });
  await api('POST', '/api/chain/admin/demo-market', adminToken, { title: 'Final duel: who wins?', names: ['Sir Aldric', 'Lady Morwen', 'Baron Grimm'], minutes: 30 });

  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 1000 } });
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failed++; });
  page.on('dialog', (d) => d.accept());

  // atrapa portfela: zapytania "do lancucha" obsluguje Node
  await page.exposeFunction('__rpc', async (method, params) => {
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [wallet.address];
      case 'wallet_switchEthereumChain': return null;
      case 'personal_sign': return wallet.signMessage(ethers.toUtf8String(params[0]));
      case 'eth_sendTransaction': {
        const t = params[0];
        const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n });
        return tx.hash;
      }
      default: return provider.send(method, params || []);
    }
  });
  await page.evaluateOnNewDocument((tok) => {
    localStorage.setItem('authToken', tok);
    const listeners = {};
    window.ethereum = { isMetaMask: false, request: ({ method, params }) => window.__rpc(method, params), on: (e, f) => { listeners[e] = f; }, removeListener() {} };
  }, aliceToken);

  await page.goto(BASE + '/dogeos.html', { waitUntil: 'networkidle0' });
  await sleep(1500);
  await page.screenshot({ path: path.join(SHOTS, '1-start.png') });

  const clickText = async (txt) => {
    const handle = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t) && !b.disabled && b.offsetParent !== null), txt);
    const el = handle.asElement();
    if (!el) throw new Error('button not found: ' + txt);
    await el.click();
  };
  const waitText = (sel, txt, ms = 30000) => page.waitForFunction((s, t) => (document.querySelector(s) || {}).textContent?.includes(t), { timeout: ms }, sel, txt);

  await clickText('Connect');
  await waitText('#wLinked', 'Not linked');
  ok(true, 'wallet connected through the injected EIP-1193 provider, on the right network');
  await clickText('Link wallet to my account');
  await waitText('#wLinked', 'Linked as');
  ok(true, 'wallet linked by signing a message');

  await clickText('Buy Mini-Tournament ticket');
  await waitText('#ticketStatus', 'Ticket granted', 40000);
  ok(await page.$eval('#tkMini', (e) => e.textContent.includes('1')), 'Mini ticket bought from the wallet and granted by the server');
  await page.screenshot({ path: path.join(SHOTS, '2-ticket.png') });

  // --- strona Live Bets: jedno klikniecie "Bet 20 DOGE" -> portfel -> zaklad
  await page.goto(BASE + '/live.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('button[data-bet]', { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, '3-live-before.png'), fullPage: true });
  await page.evaluate(() => document.querySelector('button[data-bet]').click());
  await page.waitForFunction(() => /Your bet is placed/.test(document.documentElement.innerText), { timeout: 60000 });
  ok(true, 'live page: one click placed the 20 DOGE bet from the wallet');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done').click());
  await page.waitForFunction(() => /your pick/.test(document.getElementById('markets').innerText) && /pool 20 DOGE/.test(document.getElementById('markets').innerText), { timeout: 20000 })
    .then(() => ok(true, 'the list shows "your pick" and a pool of 20 DOGE'), () => ok(false, 'list did not update after the bet'));
  await page.screenshot({ path: path.join(SHOTS, '3-bet.png'), fullPage: true });

  // --- koniec gry: okno wynikow (kto wygral / przegral) i wyjscie do menu
  const live = await api('GET', '/api/chain/markets', aliceToken);
  const myMarket = live.markets.find((m) => m.myOutcome);
  await api('POST', '/api/chain/admin/resolve', adminToken, { marketId: myMarket.id, outcome: myMarket.outcomes[0].outcome });
  await page.waitForFunction(() => document.getElementById('resultsOverlay').classList.contains('show'), { timeout: 25000 });
  const resText = await page.evaluate(() => document.getElementById('resultsBox').innerText);
  ok(/game results/i.test(resText) && /refund/i.test(resText) && /Back to menu/.test(resText), 'results window after the game: shows the outcome of the bets, refund (only 1 bet) and a Back to menu button');
  await page.screenshot({ path: path.join(SHOTS, '16-bet-results.png') });
  await page.evaluate(() => document.getElementById('resMenu').click());
  await page.waitForFunction(() => location.pathname.endsWith('index.html'), { timeout: 10000 }).then(() => ok(true, 'Back to menu leaves to the main page'), () => ok(false, 'no redirect to the main page'));

  // --- strona logowania: przycisk Connect wallet -> wejscie do gry bez hasla
  const ctx2 = await browser.createBrowserContext(); // czysty profil: bez tokenu z poprzedniej strony
  const page2 = await ctx2.newPage();
  const wallet2 = ethers.Wallet.createRandom();
  await page2.exposeFunction('__sign', (m) => wallet2.signMessage(ethers.toUtf8String(m)));
  await page2.evaluateOnNewDocument((addr) => {
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return [addr];
      if (method === 'personal_sign') return window.__sign(params[0]);
      return null;
    }, on() {} };
  }, wallet2.address);
  await page2.goto(BASE + '/login.html', { waitUntil: 'networkidle0' });
  await page2.waitForFunction(() => { const b = document.getElementById('connectWalletBtn'); return b && !b.disabled; });
  await page2.screenshot({ path: path.join(SHOTS, '4-login.png') });
  await page2.click('#connectWalletBtn');
  await page2.waitForSelector('#wolNameInput', { timeout: 20000 });
  await page2.screenshot({ path: path.join(SHOTS, '5-username.png') });
  await page2.type('#wolNameInput', 'Lord ' + stamp);
  await page2.click('#wolNameBtn');
  await page2.waitForFunction(() => localStorage.getItem('username') && !/^Lord_/.test(localStorage.getItem('username')), { timeout: 20000 });
  ok(await page2.evaluate(() => !!localStorage.getItem('authToken') && localStorage.getItem('username')) === 'Lord ' + stamp, 'login page: Connect wallet signs in, asks for a player name and stores it');
  await page2.close();

  // --- Mini-turniej: jeden przycisk "Join · X DOGE" -> portfel -> platnosc -> bilet -> wejscie do kolejki
  let txDelay = 0;
  const buyerToken = await user('ui_buyer' + stamp);
  const wallet3 = ethers.Wallet.createRandom().connect(provider);
  await (await funder.sendTransaction({ to: wallet3.address, value: ethers.parseEther('50') })).wait();
  const ctx3 = await browser.createBrowserContext();
  const page3 = await ctx3.newPage();
  page3.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failed++; });
  await page3.exposeFunction('__rpc3', async (method, params) => {
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [wallet3.address];
      case 'personal_sign': return wallet3.signMessage(ethers.toUtf8String(params[0]));
      case 'eth_sendTransaction': { const t = params[0]; if (txDelay) await sleep(txDelay); return (await wallet3.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) })).hash; }
      default: return provider.send(method, params || []);
    }
  });
  await page3.evaluateOnNewDocument((tok) => {
    localStorage.setItem('authToken', tok);
    window.ethereum = { request: ({ method, params }) => window.__rpc3(method, params), on() {} };
  }, buyerToken);
  await page3.goto(BASE + '/mini-tournaments.html', { waitUntil: 'networkidle0' });
  try { await page3.waitForFunction(() => [...document.querySelectorAll('button.btn-join')].some((b) => /Join/.test(b.textContent)), { timeout: 15000 }); }
  catch (e) { console.log('MINI PAGE TEXT:', (await page3.evaluate(() => document.documentElement.innerText)).slice(0, 700)); await page3.screenshot({ path: path.join(SHOTS, '8-mini-debug.png') }); throw e; }
  await page3.screenshot({ path: path.join(SHOTS, '8-mini-join.png') });
  await page3.evaluate(() => [...document.querySelectorAll('button.btn-join')].find((b) => /Join/.test(b.textContent)).click());
  await page3.waitForFunction(() => /Ticket ready/.test(document.documentElement.innerText), { timeout: 60000 });
  await page3.screenshot({ path: path.join(SHOTS, '9-ticket-ready.png') });
  ok(true, 'mini page: one click paid from the wallet (auto-linked) and the ticket arrived');
  await page3.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Continue').click());
  await page3.waitForFunction(() => location.pathname.includes('poczekalnia'), { timeout: 20000 });
  ok(true, 'after the ticket the player is sent straight to the game queue');
  await page3.waitForSelector('#mmCancelBtn', { timeout: 15000 });
  await page3.evaluate(() => document.getElementById('mmCancelBtn').click());
  await page3.waitForFunction(() => location.pathname.endsWith('index.html'), { timeout: 15000 })
    .then(() => ok(true, 'cancelling the search sends the player to the main page'), () => ok(false, 'cancel did not go to the main page'));

  // --- nagroda: zloty pasek "Claim prize" na stronie glownej -> odbior jednym kliknieciem
  const cfgChain = await api('GET', '/api/chain/config');
  const abi = require('../../src/chain/arena.abi.json');
  const oracleSigner = await provider.getSigner(0); // konto #0 wezla = oracle serwera testowego
  const arenaO = new ethers.Contract(cfgChain.contract, abi, oracleSigner);
  await (await new ethers.Contract(cfgChain.contract, abi, funder).fund({ value: ethers.parseEther('5') })).wait();
  await (await arenaO.creditPrizes(ethers.id('ui-claim-' + stamp), [wallet3.address], [ethers.parseEther('2')])).wait();
  await page3.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
  await page3.waitForFunction(() => /Claim 2 DOGE/.test(document.documentElement.innerText), { timeout: 20000 });
  await page3.screenshot({ path: path.join(SHOTS, '11-claim-banner.png') });
  txDelay = 4000; // portfel "czeka na zatwierdzenie" - nasze okno nie moze go zaslaniac
  await page3.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Claim 2 DOGE/.test(b.textContent)).click());
  await sleep(1500);
  const passive = await page3.evaluate(() => [...document.querySelectorAll('div')].some((d) => d.style.position === 'fixed' && d.style.pointerEvents === 'none' && /Confirm the transaction/.test(d.innerText)));
  ok(passive, 'while the wallet asks for confirmation our window steps aside (does not block clicks)');
  await page3.screenshot({ path: path.join(SHOTS, '12-claim-waiting.png') });
  await page3.waitForFunction(() => /Prize received/.test(document.documentElement.innerText), { timeout: 60000 });
  txDelay = 0;
  ok(true, 'top-right wallet widget shows the claim button and one click pays the prize to the wallet');
  await page3.waitForFunction(() => /0 DOGE/.test(document.getElementById('dash-punkty').innerText) && /Total won: 2 DOGE/.test(document.getElementById('dash-won').innerText), { timeout: 15000 })
    .then(() => ok(true, 'home info bar updates after claiming: To claim 0, Total won 2 DOGE'), () => ok(false, 'home info bar did not update (' + '' + ')'));
  await page3.evaluate(() => document.querySelector('#wolWalletWidget .wolPill').click());
  const widgetText = await page3.evaluate(() => document.getElementById('wolWalletWidget').innerText);
  ok(widgetText.includes('Wallet connected') && widgetText.toLowerCase().includes(wallet3.address.toLowerCase()) && /Log out/.test(widgetText), 'widget menu shows the connected wallet address, balance and Log out');
  await page3.screenshot({ path: path.join(SHOTS, '13-wallet-widget.png') });
  const after = await api('GET', '/api/chain/me', buyerToken);
  ok(Number(after.claimable) === 0, 'claimable is 0 after claiming');

  // --- ramka portfela DogeOS: zawsze nad naszymi okienkami i zamykana po sukcesie
  const frameOk = await page3.evaluate(async () => {
    WolConnect.hardenWalletIframe();
    const f = document.createElement('iframe');
    f.setAttribute('allow', 'publickey-credentials-get; publickey-credentials-create');
    f.style.cssText = 'width:0;height:0';
    document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 100));
    f.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:999'; // tak robi popup() w SDK
    await new Promise((r) => setTimeout(r, 100));
    const raised = f.style.zIndex === '2147483000';
    WolConnect.closeWalletPopup();
    const closed = f.style.width === '0px' || f.style.width === '0';
    f.remove();
    return raised && closed;
  });
  ok(frameOk, 'wallet iframe is forced above our windows and can be closed by the game');

  // --- panel admina: wpisz ilosc DOGE -> pobranie z portfela do puli nagrod (bez kopiowania adresow)
  const poolBefore = Number((await api('GET', '/api/chain/stats')).prizePool);
  await page3.goto(BASE + '/admin/dogeos', { waitUntil: 'networkidle0' });
  await page3.evaluate(() => { document.getElementById('poolAmount').value = '7'; });
  await page3.evaluate(() => document.getElementById('poolBtn').click());
  await page3.waitForFunction(() => /The prize pool has been topped up/.test(document.documentElement.innerText), { timeout: 60000 });
  await page3.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done').click());
  const poolAfter = Number((await api('GET', '/api/chain/stats')).prizePool);
  ok(Math.abs(poolAfter - poolBefore - 7) < 0.001, `admin panel: typing 7 DOGE and clicking topped up the pool (${poolBefore} -> ${poolAfter})`);
  await page3.screenshot({ path: path.join(SHOTS, '15-admin-dogeos.png') });

  // --- okno portfela przy stronie skalowanej (page-scale.js): ramka musi byc przypieta do <html> i zajmowac cale okno
  const scaleCheck = await page3.evaluate(async () => {
    await new Promise((r) => { const s = document.createElement('script'); s.src = '/page-scale.js'; s.onload = r; document.head.appendChild(s); });
    WolConnect.keepWalletIframeOutOfBody('test-client-id');
    window.scrollTo(0, 200);
    const f = document.createElement('iframe');
    f.id = 'test-client-id';
    document.body.appendChild(f); // tak robi SDK
    f.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:999;border:none';
    await new Promise((r) => setTimeout(r, 200));
    const rect = f.getBoundingClientRect();
    const out = { parent: f.parentElement.tagName, w: Math.round(rect.width), h: Math.round(rect.height), vw: innerWidth, vh: innerHeight, bodyTransform: getComputedStyle(document.body).transform !== 'none' };
    f.remove();
    return out;
  });
  ok(scaleCheck.parent === 'HTML' && Math.abs(scaleCheck.w - scaleCheck.vw) <= 20 && Math.abs(scaleCheck.h - scaleCheck.vh) <= 2, `wallet iframe sits on <html> and fills the window (${scaleCheck.w}x${scaleCheck.h} of ${scaleCheck.vw}x${scaleCheck.vh}, body scaled: ${scaleCheck.bodyTransform})`);

  // --- gracz z otwarta rozgrywka: okno "Leave the game and continue"
  const activeName = 'ui_active' + stamp;
  const activeToken = await user(activeName);
  await db.collection('users').updateOne({ username: activeName }, { $set: { hasUnusedMiniTournamentTicket: true } });
  const trial = await api('POST', '/api/trial/start', activeToken);
  ok(!!trial.roundId, 'test setup: the player has an active game');
  const ctx4 = await browser.createBrowserContext();
  const page4 = await ctx4.newPage();
  page4.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failed++; });
  page4.on('dialog', (d) => d.dismiss());
  await page4.evaluateOnNewDocument((tok) => { localStorage.setItem('authToken', tok); }, activeToken);
  await page4.goto(BASE + '/mini-tournaments.html', { waitUntil: 'networkidle0' });
  await page4.waitForFunction(() => [...document.querySelectorAll('button.btn-join')].some((b) => /Find a Game/.test(b.textContent)), { timeout: 15000 });
  await page4.evaluate(() => [...document.querySelectorAll('button.btn-join')].find((b) => /Find a Game/.test(b.textContent)).click());
  await page4.waitForFunction(() => /You have a game in progress/.test(document.documentElement.innerText), { timeout: 15000 });
  await page4.screenshot({ path: path.join(SHOTS, '10-active-game.png') });
  ok(true, 'blocked by an open game: the player gets Return / Leave options');
  await page4.evaluate(() => document.querySelector('.wolLeave').click());
  await page4.waitForFunction(() => location.pathname.includes('poczekalnia') || /Could not|already/.test(document.documentElement.innerText), { timeout: 20000 });
  ok(page4.url().includes('poczekalnia'), 'after leaving the old game the join goes through');

  await browser.close();
  await mongoose.disconnect();
  console.log(failed ? `\n${failed} FAILED` : '\nUI E2E PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
