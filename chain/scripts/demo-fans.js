// Wirtualni widzowie (Fan_*) do pokazania zakladow na testnecie: kazdy ma wlasny portfel (chain/demo-fans.json, poza gitem),
// obstawia po 20 DOGE trwajace gry na stronie Live Bets, a wygrane odbiera sam. Portfele dostaja srodki z puli nagrod
// kontraktu (creditPrizes + claim), wiec pieniadze krazÄ… tylko w obrebie kontraktu.
// Uzycie: node scripts/demo-fans.js [liczba widzow, domyslnie 3]
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { ethers } = require('ethers');
const mongoose = require('../../node_modules/mongoose');
const jwt = require('../../node_modules/jsonwebtoken');
const bcrypt = require('../../node_modules/bcrypt');
const abi = require('../../src/chain/arena.abi.json');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const INVITE = process.env.INVITE_TOKEN ? { cookie: 'wol_invite=' + encodeURIComponent(process.env.INVITE_TOKEN) } : {};
const RPC = process.env.DOGEOS_RPC_URL || 'https://rpc.testnet.dogeos.com/';
const COUNT = Math.min(Number(process.argv[2]) || 3, 6);
const NAMES = ['Fan_Rex', 'Fan_Luna', 'Fan_Milo', 'Fan_Nova', 'Fan_Zed', 'Fan_Ivy'];
const WALLET_FILE = path.join(__dirname, '..', 'demo-fans.json');
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function contractAddress() {
  if (process.env.CHAIN_CONTRACT) return process.env.CHAIN_CONTRACT;
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', 'dogeosTestnet.json'), 'utf8')).address;
}

async function api(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...INVITE, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  const oracle = new ethers.NonceManager(new ethers.Wallet(process.env.CHAIN_ORACLE_KEY, provider));
  const address = contractAddress();
  const arenaO = new ethers.Contract(address, abi, oracle);
  await mongoose.connect(process.env.MONGO_URI);
  const users = mongoose.connection.db.collection('users');

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')); } catch (_) { /* pierwszy start */ }
  const fans = [];
  for (let i = 0; i < COUNT; i += 1) {
    const username = NAMES[i];
    if (!saved[username]) saved[username] = ethers.Wallet.createRandom().privateKey;
    const wallet = new ethers.Wallet(saved[username], provider);
    let u = await users.findOne({ username });
    const now = new Date();
    if (!u) {
      const r = await users.insertOne({ username, passwordHash: await bcrypt.hash('fan-' + Math.random(), 10), walletAddress: wallet.address.toLowerCase(), needsUsername: false, tournamentMMR: 1000, skillPoints: 1200, dogeBalance: 0, tournamentTickets: 0, isAdmin: false, isBlocked: false, isBot: false, termsAcceptedAt: now, privacyAcceptedAt: now, createdAt: now, updatedAt: now });
      u = { _id: r.insertedId };
    } else {
      await users.updateOne({ _id: u._id }, { $set: { walletAddress: wallet.address.toLowerCase(), needsUsername: false } });
    }
    const token = jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET || 'change_this_secret');
    fans.push({ username, wallet, arena: new ethers.Contract(address, abi, wallet), token, busy: false });
  }
  fs.writeFileSync(WALLET_FILE, JSON.stringify(saved, null, 2));
  log(`Widzowie: ${fans.map((f) => `${f.username} ${f.wallet.address}`).join(' | ')}`);

  // Srodki: widz potrzebuje stawki + odrobiny gazu. Gdy ma mniej, dostaje na 2 zaklady z konta serwera (to ono jest "bankiem" demo:
  // wplacasz na nie z panelu admina -> DogeOS -> "Doladuj konto serwera"). Pula nagrod nie jest ruszana. Serwer zostawia 8 DOGE na gaz.
  let stakeWei = ethers.parseEther('20');
  async function topUp(f) {
    stakeWei = await arenaO.betStake();
    const bal = await provider.getBalance(f.wallet.address);
    if (bal >= stakeWei + ethers.parseEther('0.2')) return;
    const amount = stakeWei * 2n + ethers.parseEther('0.3');
    const bank = await provider.getBalance(await oracle.getAddress());
    if (bank < amount + ethers.parseEther('8')) { log(`${f.username}: konto serwera ma ${ethers.formatEther(bank)} DOGE, potrzeba ${ethers.formatEther(amount + ethers.parseEther('8'))} - nie doladowuje (wplac przez panel admina: DogeOS -> Doladuj konto serwera)`); return; }
    await (await oracle.sendTransaction({ to: f.wallet.address, value: amount })).wait();
    log(`${f.username}: dostal ${ethers.formatEther(amount)} DOGE z konta serwera`);
  }

  async function play(f) {
    if (f.busy) return;
    f.busy = true;
    try {
      await topUp(f);
      // wygrane i zwroty z zakladow odbieramy same
      const me = await api('GET', '/api/chain/me', f.token);
      if (me.claimItems && me.claimItems.length) {
        await (await f.arena.claimAll(me.claimItems.map((i) => i.marketId), me.claimItems.map((i) => i.outcome))).wait();
        log(`${f.username}: odebral ${me.claimable} DOGE`);
      }
      const { markets } = await api('GET', '/api/chain/markets', f.token);
      for (const m of (markets || []).filter((x) => x.status === 'open' && !x.myOutcome && new Date(x.closesAt).getTime() - Date.now() > 20000)) {
        if (Math.random() > 0.75) continue; // nie kazdy widz obstawia kazda gre
        const bal = await provider.getBalance(f.wallet.address);
        if (bal < stakeWei + ethers.parseEther('0.02')) break;
        const pick = m.outcomes[Math.floor(Math.random() * m.outcomes.length)];
        const v = await api('POST', '/api/chain/bets/voucher', f.token, { marketId: m.id, outcome: pick.outcome });
        if (!v.sig) { log(`${f.username}: voucher odrzucony: ${v.error}`); continue; }
        await (await f.arena.placeBet(v.marketId, v.outcome, v.amount, v.nonce, v.deadline, v.sig, { value: v.amount })).wait();
        log(`${f.username}: obstawil ${pick.username} w "${m.title}"`);
      }
    } catch (err) {
      log(`${f.username}: blad (${err.shortMessage || err.message})`);
    } finally { f.busy = false; }
  }

  const once = process.argv.includes('--once');
  do {
    for (const f of fans) await play(f);
    if (!once) await sleep(20000);
  } while (!once);
  if (once) { await mongoose.disconnect(); process.exit(0); }
})().catch((e) => { console.error(e); process.exit(1); });
