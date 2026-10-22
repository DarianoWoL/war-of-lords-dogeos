// Test end-to-end na lokalnej sieci (hardhat node z chainId 6281971) + lokalny serwer gry + Mongo.
// Uruchamiac przez chain/scripts/run-e2e.sh (stawia wszystko i sprzata).
const { ethers } = require('ethers');
const mongoose = require('../../node_modules/mongoose');
const BASE = process.env.BASE || 'http://127.0.0.1:3101';
const RPC = 'http://127.0.0.1:8545';
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
let deployer; // konto #1 wezla hardhat (konto #0 to oracle serwera)
const abi = require('../../src/chain/arena.abi.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => { console.log(cond ? '  OK  ' : ' FAIL ', msg); if (!cond) failed++; };

async function api(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
async function newPlayer(name) {
  await api('POST', '/api/auth/register', null, { username: name, password: 'Haslo12345', email: name + '@test.local', termsAccepted: true });
  const login = await api('POST', '/api/auth/login', null, { username: name, password: 'Haslo12345' });
  const wallet = ethers.Wallet.createRandom().connect(provider);
  await (await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther('100') })).wait();
  const ch = await api('POST', '/api/chain/wallet/challenge', login.token, { address: wallet.address });
  const sig = await wallet.signMessage(ch.message);
  const link = await api('POST', '/api/chain/wallet/link', login.token, { signature: sig });
  return { name, token: login.token, wallet, link };
}

(async () => {
  deployer = await provider.getSigner(1);
  const cfg = await api('GET', '/api/chain/config');
  ok(cfg.enabled && cfg.network.chainId === 6281971, 'config: chain enabled, chainId 6281971');
  const arena = new ethers.Contract(cfg.contract, abi, deployer);

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const stamp = Date.now().toString().slice(-6);
  const P = {};
  for (const n of ['alice', 'bob', 'carol', 'dave']) P[n] = await newPlayer(`${n}${stamp}`);
  ok(P.alice.link.success, 'wallet linked by signature');
  const dup = await api('POST', '/api/chain/wallet/challenge', P.bob.token, { address: P.alice.wallet.address });
  const dupSig = await P.alice.wallet.signMessage(dup.message);
  const dupLink = await api('POST', '/api/chain/wallet/link', P.bob.token, { signature: dupSig });
  ok(dupLink.status === 409, 'same wallet cannot be linked to a second account');
  await db.collection('users').updateOne({ username: P.dave.name }, { $set: { isAdmin: true } });

  // --- bilet mini-turnieju
  await db.collection('rooms').insertOne({ roomName: 'e2e-mini-' + stamp, isMiniTournament: true, requiresMiniTournamentTicket: true, miniTournamentPrizes: { place1VPLN: 30, place2VPLN: 20, place3VPLN: 10 }, enabled: true, maxPlayers: 2, waitingPlayers: [], settings: {}, createdAt: new Date() });
  const v = await api('POST', '/api/chain/tickets/voucher', P.alice.token, { kind: 'mini' });
  ok(v.sig && v.priceDoge, `mini ticket voucher issued (price ${v.priceDoge} DOGE)`);
  const arenaAlice = arena.connect(P.alice.wallet);
  await (await arenaAlice.buyTicket(v.kind, v.price, v.nonce, v.deadline, v.sig, { value: v.price })).wait();
  let me;
  for (let i = 0; i < 12; i++) { await sleep(1500); me = await api('GET', '/api/chain/me', P.alice.token); if (me.hasMiniTicket) break; }
  ok(me.hasMiniTicket === true, 'server saw TicketPurchased and granted the Mini-Tournament ticket');
  const v2 = await api('POST', '/api/chain/tickets/voucher', P.alice.token, { kind: 'mini' });
  ok(v2.status === 400, 'second mini ticket refused while one is unused');

  // --- zaklady (rynek demo): stala stawka 20, podzial 60/20/20, trafiajacy nie traca
  const dm = await api('POST', '/api/chain/admin/demo-market', P.dave.token, { title: 'E2E market', names: ['Red', 'Blue'], minutes: 5 });
  ok(dm.marketId, 'admin created a demo market (opened on chain)');
  const list = await api('GET', '/api/chain/markets', P.bob.token);
  const market = list.markets.find((m) => m.id === dm.marketId);
  ok(market && market.status === 'open' && market.stakeDoge === '20.0', `market listed as open, stake ${market && market.stakeDoge} DOGE`);
  const [red, blue] = market.outcomes;
  async function placeBet(p, outcome) {
    const bv = await api('POST', '/api/chain/bets/voucher', p.token, { marketId: dm.marketId, outcome: outcome.outcome });
    if (!bv.sig) return bv;
    await (await arena.connect(p.wallet).placeBet(bv.marketId, bv.outcome, bv.amount, bv.nonce, bv.deadline, bv.sig, { value: bv.amount })).wait();
    return bv;
  }
  ok((await placeBet(P.alice, red)).sig, 'alice bets 20 on Red');
  ok((await placeBet(P.bob, red)).sig, 'bob bets 20 on Red');
  ok((await placeBet(P.carol, blue)).sig, 'carol bets 20 on Blue');
  ok((await placeBet(P.dave, blue)).sig, 'dave bets 20 on Blue');
  ok((await api('POST', '/api/chain/bets/voucher', P.bob.token, { marketId: dm.marketId, outcome: blue.outcome })).status === 400, 'a second bet from the same wallet is refused');
  await sleep(9000);
  const m2 = (await api('GET', '/api/chain/markets', P.bob.token)).markets.find((m) => m.id === dm.marketId);
  ok(m2.bets === 4 && Number(m2.totalDoge) === 80 && m2.myOutcome === red.outcome, `server indexed all bets (pool ${m2.totalDoge}, bob picked Red)`);
  const res1 = await api('POST', '/api/chain/admin/resolve', P.dave.token, { marketId: dm.marketId, outcome: red.outcome });
  ok(res1.success, 'admin resolved market: Red wins');
  const m3 = (await api('GET', '/api/chain/markets', P.bob.token)).markets.find((m) => m.id === dm.marketId);
  ok(m3.status === 'resolved' && Number(m3.result.payoutPool) === 48 && Number(m3.result.house) === 32, `result: backers share ${m3.result && m3.result.payoutPool}, game keeps ${m3.result && m3.result.house}`);
  ok(Array.isArray(m3.bettors) && m3.bettors.length === 4 && m3.bettors.filter((b) => b.result === 'won').length === 2 && m3.bettors.filter((b) => b.result === 'lost').length === 2 && m3.bettors.some((b) => b.mine), 'results list: 4 bettors, 2 won, 2 lost');
  const meBob = await api('GET', '/api/chain/me', P.bob.token);
  ok(Number(meBob.betWinnings) === 24 && meBob.claimItems.length === 1, `bob sees 24 DOGE of bet winnings to claim in /me (${meBob.betWinnings})`);
  const before = await provider.getBalance(P.bob.wallet.address);
  await (await arena.connect(P.bob.wallet).claimAll(meBob.claimItems.map((i) => i.marketId), meBob.claimItems.map((i) => i.outcome))).wait();
  const gained = ethers.formatEther((await provider.getBalance(P.bob.wallet.address)) - before);
  ok(Number(gained) > 23.9 && Number(gained) < 24.01, `bob claimed ~24 DOGE with one claimAll transaction, got ${gained}`);
  const meAlice = await api('GET', '/api/chain/me', P.alice.token);
  await (await arena.connect(P.alice.wallet).claimAll(meAlice.claimItems.map((i) => i.marketId), meAlice.claimItems.map((i) => i.outcome))).wait();
  const carolBets = await api('GET', '/api/chain/me/bets', P.carol.token);
  ok(carolBets.bets[0] && carolBets.bets[0].lost, 'carol sees her bet as lost');
  const meBob2 = await api('GET', '/api/chain/me', P.bob.token);
  ok(Number(meBob2.betWinnings) === 0, 'nothing left to claim after claimAll');

  // --- nagrody (modul wywolany bezposrednio, jak z hooka rundy)
  await (await arena.fund({ value: ethers.parseEther('50') })).wait();
  const express = require('../../node_modules/express');
  const User = require('../../src/models/User');
  const chainMod = require('../../src/chain').init({
    app: express(), authMiddleware: (q, s, n) => n(), authOptional: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), User, Round: null, TicketOrder: null, MiniTournamentTicketOrder: null,
    eligibility: {}, grant: {}
  });
  const uAlice = await User.findOne({ username: P.alice.name });
  const uDave = await User.findOne({ username: P.dave.name });
  await User.updateOne({ _id: uDave._id }, { $unset: { walletAddress: 1 } });
  const paid = await chainMod.creditRoundPrizes('e2e-round-' + stamp, [
    { userId: uAlice._id, username: P.alice.name, placement: 1, amountGame: 100 },
    { userId: uDave._id, username: P.dave.name, placement: 2, amountGame: 50 }
  ]);
  ok(paid.has(String(uAlice._id)) && !paid.has(String(uDave._id)), 'prize: wallet owner paid on chain, player without wallet falls back to game balance');
  const me2 = await api('GET', '/api/chain/me', P.alice.token);
  ok(Number(me2.claimable) === 10 && me2.wins === 1, `alice has 10 DOGE claimable on chain (100 * scale 0.1), wins=${me2.wins}`);
  const b4 = await provider.getBalance(P.alice.wallet.address);
  await (await arena.connect(P.alice.wallet).claim()).wait();
  ok((await provider.getBalance(P.alice.wallet.address)) > b4 + ethers.parseEther('9.9'), 'alice claimed her prize');
  const stats = await api('GET', '/api/chain/stats');
  ok(stats.leaderboard.length >= 1, 'public stats / leaderboard work');

  // --- logowanie portfelem (konto bez hasla)
  const lw = ethers.Wallet.createRandom();
  async function walletLogin() {
    const ch = await api('POST', '/api/chain/auth/challenge', null, { address: lw.address });
    return api('POST', '/api/chain/auth/login', null, { address: lw.address, signature: await lw.signMessage(ch.message) });
  }
  const l1 = await walletLogin();
  ok(l1.token && l1.isNew && /^Lord_/.test(l1.username), `wallet login created a new account (${l1.username})`);
  const l2 = await walletLogin();
  ok(l2.token && !l2.isNew && l2.username === l1.username, 'second wallet login returns the same account');
  const meW = await api('GET', '/api/chain/me', l1.token);
  ok(meW.walletAddress === lw.address.toLowerCase(), 'wallet is linked to the new account');
  ok(l1.needsUsername === true, 'new wallet account is asked for a player name');
  const nm1 = await api('POST', '/api/chain/profile/username', l1.token, { username: 'x!' });
  ok(nm1.status === 400, 'too short / invalid player name refused');
  const nm2 = await api('POST', '/api/chain/profile/username', l1.token, { username: 'Sir  Aldric' + stamp.slice(0, 2) });
  ok(nm2.success && nm2.username === 'Sir Aldric' + stamp.slice(0, 2), `player name saved (${nm2.username})`);
  const nm3 = await api('POST', '/api/chain/profile/username', l1.token, { username: 'Another' });
  ok(nm3.status === 400, 'player name can be chosen only once');
  const lw2 = ethers.Wallet.createRandom();
  const ch2 = await api('POST', '/api/chain/auth/challenge', null, { address: lw2.address });
  const l3 = await api('POST', '/api/chain/auth/login', null, { address: lw2.address, signature: await lw2.signMessage(ch2.message) });
  const nm4 = await api('POST', '/api/chain/profile/username', l3.token, { username: ('sir aldric' + stamp.slice(0, 2)).toUpperCase() });
  ok(nm4.status === 409, 'taken player name refused (case-insensitive)');
  const l2b = await walletLogin();
  ok(l2b.needsUsername === false && l2b.username === nm2.username, 'after choosing, login returns the chosen name');
  const bad = await api('POST', '/api/chain/auth/login', null, { address: lw.address, signature: '0x' + '11'.repeat(65) });
  ok(bad.status === 400, 'login without a fresh challenge / with a bad signature is refused');

  await mongoose.disconnect();
  console.log(failed ? `\n${failed} FAILED` : '\nALL E2E CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
