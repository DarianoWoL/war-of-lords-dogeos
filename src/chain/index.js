// Integracja War of Lords z DogeOS testnet (EVM): bilety turniejowe, nagrody i zaklady w kontrakcie
// WarOfLordsArena (chain/contracts). Serwer jest "oracle": wystawia podpisane vouchery EIP-712
// (po sprawdzeniu regul gry), nasluchuje zdarzen kontraktu i raportuje wyniki rund.
// Tylko testnet - testowe DOGE bez wartosci. Bez klucza/kontraktu modul sie wylacza (enabled:false).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const models = require('./models');
const { ChainVoucher, ChainEvent, ChainState, ChainMarket, ChainBet, ChainPrize } = models;

const CHAIN_DIR = path.join(__dirname, '..', '..', 'chain');
try { require('dotenv').config({ path: path.join(CHAIN_DIR, '.env.chain') }); } catch (_) { /* dotenv opcjonalny */ }

const TICKET_KIND = { monthly: 1, mini: 2 };
const NETWORK = {
  chainId: 6281971,
  name: 'DogeOS Chikyu Testnet',
  rpcUrl: process.env.DOGEOS_RPC_URL || 'https://rpc.testnet.dogeos.com/',
  explorer: process.env.DOGEOS_EXPLORER_URL || 'https://blockscout.testnet.dogeos.com',
  currency: { name: 'Dogecoin', symbol: 'DOGE', decimals: 18 }
};
const VOUCHER_TTL_MS = 10 * 60 * 1000;
// Zaklady sa otwarte przez 1/6 dlugosci rundy (10 min przy godzinie, 5 min przy 30 minutach), ale nie krocej niz 60 s.
const BET_WINDOW_FRACTION = 1 / 6;
const MIN_BET_WINDOW_MS = 60 * 1000;
// 1 DOGE z gry = SCALE DOGE na testnecie (domyslnie 1:1 - bilet 10 DOGE, nagrody 30/20/10).
const PRICE_SCALE = Number(process.env.CHAIN_PRICE_SCALE || 1);
// Spectator bets are OFF unless CHAIN_BETS=on (hackathon build: tickets + prizes only).
// Markets that were already open keep being closed/settled by marketTick (refunds), so nothing gets stuck.
const BETS_ENABLED = process.env.CHAIN_BETS === 'on';

function loadDeployment() {
  if (process.env.CHAIN_CONTRACT) return { address: process.env.CHAIN_CONTRACT, deployBlock: Number(process.env.CHAIN_DEPLOY_BLOCK || 0) };
  try { return JSON.parse(fs.readFileSync(path.join(CHAIN_DIR, 'deployments', 'dogeosTestnet.json'), 'utf8')); } catch (_) { return null; }
}

const marketIdOf = (roundId) => ethers.id(`wol:round:${roundId}`);
const outcomeIdOf = (userId) => ethers.id(`wol:player:${userId}`);
const toWei = (gameAmount) => ethers.parseEther((Math.round(Number(gameAmount) * PRICE_SCALE * 1e6) / 1e6).toFixed(6));
const fromWei = (wei) => Number(ethers.formatEther(wei));
const randomNonce = () => BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();

function init(deps) {
  const { app, authMiddleware, authOptional, requireAdmin, User, Room, Round, TicketOrder, MiniTournamentTicketOrder, eligibility, grant, auth } = deps;
  const deployment = loadDeployment();
  const key = process.env.CHAIN_ORACLE_KEY;
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, 'arena.abi.json'), 'utf8'));
  const enabled = Boolean(key && deployment && deployment.address);

  // Zasady zakladow czytane z kontraktu (stala stawka, minimalna liczba zakladow, udzial trafiajacych).
  const rules = { stake: '20', minBets: 3, houseBps: 2000, bonusBps: 2000 };
  const publicConfig = () => ({
    enabled,
    network: NETWORK,
    contract: enabled ? deployment.address : null,
    priceScale: PRICE_SCALE,
    clientId: process.env.DOGEOS_CLIENT_ID || null, // publiczny identyfikator projektu z console.dogeos.com (logowanie przez X)
    betStake: rules.stake,
    minBets: rules.minBets,
    houseShare: rules.houseBps / 10000,
    bonusShare: rules.bonusBps / 10000
  });
  app.get('/api/chain/config', (req, res) => res.json(publicConfig()));

  if (!enabled) {
    console.log('[chain] wylaczone (brak CHAIN_ORACLE_KEY albo wdrozonego kontraktu chain/deployments/dogeosTestnet.json)');
    app.use('/api/chain', (req, res) => res.status(503).json({ error: 'DogeOS integration is not configured on this server.' }));
    return { enabled: false, onRoundStarted: async () => {}, onRoundFinished: async () => {}, creditRoundPrizes: async () => new Set() };
  }

  const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrl, NETWORK.chainId, { staticNetwork: ethers.Network.from(NETWORK.chainId) });
  const signer = new ethers.Wallet(key, provider);
  // NonceManager: kolejne transakcje oracle'a w jednej chwili nie dostaja tego samego nonce (cache RPC).
  const nonceManager = new ethers.NonceManager(signer);
  const arena = new ethers.Contract(deployment.address, abi, nonceManager);
  const iface = new ethers.Interface(abi);
  // Stare kontrakty (pliki *-backup.json): gracze moga na nich miec jeszcze nieodebrane nagrody - pokazujemy je i pozwalamy odebrac.
  const legacy = [];
  try {
    const dir = path.join(CHAIN_DIR, 'deployments');
    for (const f of fs.readdirSync(dir).filter((x) => /-backup\.json$/.test(x))) {
      const old = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (old.address && old.address.toLowerCase() !== deployment.address.toLowerCase() && !legacy.some((l) => l.address.toLowerCase() === old.address.toLowerCase())) legacy.push({ address: old.address, contract: new ethers.Contract(old.address, abi, provider) });
    }
  } catch (_) { /* brak starych kontraktow */ }
  async function loadRules() {
    try {
      const [stake, minBets, house, bonus] = await Promise.all([arena.betStake(), arena.minBets(), arena.houseBps(), arena.bonusBps()]);
      rules.stake = ethers.formatEther(stake); rules.minBets = Number(minBets); rules.houseBps = Number(house); rules.bonusBps = Number(bonus);
    } catch (err) { console.error('[chain] nie udalo sie odczytac zasad zakladow:', err.shortMessage || err.message); }
  }
  loadRules();
  setInterval(loadRules, 5 * 60 * 1000).unref();
  const domain = { name: 'WarOfLordsArena', version: '1', chainId: NETWORK.chainId, verifyingContract: deployment.address };
  const TICKET_TYPES = { Ticket: [
    { name: 'buyer', type: 'address' }, { name: 'kind', type: 'uint8' }, { name: 'price', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] };
  const BET_TYPES = { Bet: [
    { name: 'bettor', type: 'address' }, { name: 'marketId', type: 'bytes32' }, { name: 'outcome', type: 'bytes32' },
    { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] };

  // Transakcje oracle'a ida jedna po drugiej (kolejnosc nonce'ow konta).
  let txQueue = Promise.resolve();
  function sendTx(label, fn) {
    const run = txQueue.then(async () => {
      let tx;
      try { tx = await fn(arena); } catch (err) { nonceManager.reset(); throw err; }
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(`${label}: transakcja odrzucona`);
      return receipt;
    });
    txQueue = run.catch(() => {});
    return run;
  }

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[chain] blad endpointu', req.method, req.path, err);
    res.status(500).json({ error: 'Chain error: ' + (err.shortMessage || err.message || 'unknown') });
  });
  const getUser = (req) => User.findById(req.userId).select('username walletAddress isBot');

  // ---------------------------------------------------------------- logowanie portfelem (bez hasla)
  // Gracz klika "Connect wallet" (X / e-mail / portfel DogeOS), podpisuje wyzwanie i wchodzi na konto
  // powiazane z tym adresem - albo dostaje nowe konto. Haslo nie jest potrzebne.
  const authChallenges = new Map(); // adres(lowercase) -> { message, expires }
  app.post('/api/chain/auth/challenge', wrap(async (req, res) => {
    const address = String(req.body.address || '');
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const message = `War of Lords - sign in with wallet
Wallet: ${ethers.getAddress(address)}
Nonce: ${randomNonce()}
Issued: ${new Date().toISOString()}`;
    authChallenges.set(address.toLowerCase(), { message, expires: Date.now() + 10 * 60 * 1000 });
    res.json({ message });
  }));
  app.post('/api/chain/auth/login', wrap(async (req, res) => {
    const addr = String(req.body.address || '').toLowerCase();
    const ch = authChallenges.get(addr);
    if (!ch || ch.expires < Date.now()) return res.status(400).json({ error: 'Challenge expired, try again.' });
    let recovered;
    try { recovered = ethers.verifyMessage(ch.message, String(req.body.signature || '')).toLowerCase(); } catch (_) { return res.status(400).json({ error: 'Invalid signature.' }); }
    if (recovered !== addr) return res.status(400).json({ error: 'Signature does not match the wallet.' });
    authChallenges.delete(addr); // jednorazowe
    let user = await User.findOne({ walletAddress: addr });
    let isNew = false;
    if (!user) { user = await auth.createWalletUser(addr); isNew = true; }
    await auth.onLogin(req, user);
    res.json({ token: auth.issueToken(user), username: user.username, isNew, needsUsername: !!user.needsUsername });
  }));

  // Gracz z konta zalozonego portfelem wybiera wlasna nazwe (jednorazowo).
  app.post('/api/chain/profile/username', authMiddleware, wrap(async (req, res) => {
    const user = await User.findById(req.userId).select('needsUsername username');
    if (!user.needsUsername) return res.status(400).json({ error: 'The player name is already set.' });
    const name = String(req.body.username || '').trim().replace(/\s+/g, ' ');
    const problem = auth.validateUsername(name);
    if (problem) return res.status(400).json({ error: problem });
    // Porownanie bez rozrozniania wielkosci liter (Dariano = dariano), zeby nikt nie podszyl sie pod innego gracza.
    if (await User.findOne({ username: name, _id: { $ne: user._id } }).collation({ locale: 'en', strength: 2 }).select('_id')) {
      return res.status(409).json({ error: 'This player name is already taken.' });
    }
    try {
      await User.updateOne({ _id: user._id }, { $set: { username: name, needsUsername: false } });
    } catch (err) {
      if (err && err.code === 11000) return res.status(409).json({ error: 'This player name is already taken.' });
      throw err;
    }
    res.json({ success: true, username: name });
  }));

  // ---------------------------------------------------------------- portfel: laczenie podpisem
  const linkChallenges = new Map(); // userId -> { message, address, expires }
  app.post('/api/chain/wallet/challenge', authMiddleware, wrap(async (req, res) => {
    const user = await getUser(req);
    const address = String(req.body.address || '');
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid wallet address.' });
    const message = `War of Lords - link wallet to account "${user.username}"\nWallet: ${ethers.getAddress(address)}\nNonce: ${randomNonce()}\nIssued: ${new Date().toISOString()}`;
    linkChallenges.set(String(req.userId), { message, address: address.toLowerCase(), expires: Date.now() + 10 * 60 * 1000 });
    res.json({ message });
  }));

  app.post('/api/chain/wallet/link', authMiddleware, wrap(async (req, res) => {
    const ch = linkChallenges.get(String(req.userId));
    if (!ch || ch.expires < Date.now()) return res.status(400).json({ error: 'Challenge expired, try again.' });
    let recovered;
    try { recovered = ethers.verifyMessage(ch.message, String(req.body.signature || '')).toLowerCase(); } catch (_) { return res.status(400).json({ error: 'Invalid signature.' }); }
    if (recovered !== ch.address) return res.status(400).json({ error: 'Signature does not match the wallet.' });
    const taken = await User.findOne({ walletAddress: recovered, _id: { $ne: req.userId } }).select('_id');
    if (taken) return res.status(409).json({ error: 'This wallet is already linked to another account.' });
    await User.updateOne({ _id: req.userId }, { $set: { walletAddress: recovered } });
    linkChallenges.delete(String(req.userId));
    res.json({ success: true, walletAddress: recovered });
  }));

  app.post('/api/chain/wallet/unlink', authMiddleware, wrap(async (req, res) => {
    await User.updateOne({ _id: req.userId }, { $unset: { walletAddress: 1 } });
    res.json({ success: true });
  }));

  // ---------------------------------------------------------------- stan gracza i kontraktu
  app.get('/api/chain/stats', wrap(async (req, res) => {
    const [prizePool, treasury, season, balance, oracleBalance] = await Promise.all([
      arena.prizePool(), arena.treasury(), arena.season(), provider.getBalance(deployment.address), provider.getBalance(signer.address)
    ]);
    const prizes = await ChainPrize.aggregate([
      { $match: { where: 'chain' } },
      { $group: { _id: '$userId', username: { $last: '$username' }, wins: { $sum: { $cond: [{ $eq: ['$placement', 1] }, 1, 0] } }, won: { $sum: { $toDouble: '$amountWei' } } } },
      { $sort: { won: -1 } }, { $limit: 10 }
    ]);
    res.json({
      contract: deployment.address, oracle: signer.address, season: Number(season),
      prizePool: ethers.formatEther(prizePool), treasury: ethers.formatEther(treasury), contractBalance: ethers.formatEther(balance), oracleBalance: ethers.formatEther(oracleBalance),
      leaderboard: prizes.map((p) => ({ username: p.username, wins: p.wins, won: p.won / 1e18 }))
    });
  }));

  // Zaklady gracza, za ktore nalezy sie wyplata (wygrana albo zwrot) - do jednej transakcji claimAll.
  async function betClaimItems(wallet) {
    const mine = await ChainBet.find({ bettor: wallet }).sort({ createdAt: -1 }).limit(100).lean();
    const items = [];
    let total = 0n;
    const seen = new Set();
    for (const b of mine) {
      const k = b.marketId + b.outcome;
      if (seen.has(k)) continue;
      seen.add(k);
      const pending = await arena.pendingBetPayout(b.marketId, wallet, b.outcome);
      if (pending > 0n) { items.push({ marketId: b.marketId, outcome: b.outcome }); total += pending; }
    }
    return { items, total };
  }

  app.get('/api/chain/me', authMiddleware, wrap(async (req, res) => {
    const user = await User.findById(req.userId).select('username walletAddress tournamentTickets hasUnusedMiniTournamentTicket dogeBalance isAdmin needsUsername');
    const out = {
      username: user.username, isAdmin: !!user.isAdmin, needsUsername: !!user.needsUsername, walletAddress: user.walletAddress || null,
      tournamentTickets: user.tournamentTickets || 0, hasMiniTicket: !!user.hasUnusedMiniTournamentTicket, dogeBalance: user.dogeBalance || 0
    };
    if (user.walletAddress) {
      const [prizes, totalWon, winCount, ticketsBought, walletBalance, bets] = await Promise.all([
        arena.claimable(user.walletAddress), arena.totalWon(user.walletAddress), arena.winCount(user.walletAddress),
        arena.ticketsBought(user.walletAddress), provider.getBalance(user.walletAddress), betClaimItems(user.walletAddress)
      ]);
      const legacyItems = [];
      for (const l of legacy) {
        const amt = await l.contract.claimable(user.walletAddress).catch(() => 0n);
        if (amt > 0n) legacyItems.push({ address: l.address, amount: amt });
      }
      const legacyAmount = legacyItems.reduce((sum, i) => sum + i.amount, 0n);
      Object.assign(out, {
        // claimable = wszystko, co mozna odebrac przyciskiem (nagrody + bonus + wygrane/zwroty z zakladow + ewentualnie ze starego kontraktu)
        claimable: ethers.formatEther(prizes + bets.total + legacyAmount), claimablePrizes: ethers.formatEther(prizes), betWinnings: ethers.formatEther(bets.total), claimItems: bets.items,
        legacyClaimable: ethers.formatEther(legacyAmount), legacyContract: legacyItems.length ? legacyItems[0].address : null, legacyItems: legacyItems.map((i) => ({ address: i.address, amount: ethers.formatEther(i.amount) })),
        totalWon: ethers.formatEther(totalWon), wins: Number(winCount), ticketsBought: Number(ticketsBought), walletBalance: ethers.formatEther(walletBalance)
      });
    }
    res.json(out);
  }));

  // Los transakcji o danym hashu (dla okien postepu: pokazuje blad, gdy transakcja sie nie powiodla).
  app.get('/api/chain/tx/:hash', authMiddleware, wrap(async (req, res) => {
    const hash = String(req.params.hash || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ error: 'Invalid transaction hash.' });
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) return res.json({ found: false });
    res.json({ found: true, status: receipt.status === 1 ? 'success' : 'failed', blockNumber: receipt.blockNumber });
  }));

  // ---------------------------------------------------------------- bilety: voucher -> platnosc w portfelu
  app.post('/api/chain/tickets/voucher', authMiddleware, wrap(async (req, res) => {
    const kind = req.body.kind;
    if (!TICKET_KIND[kind]) return res.status(400).json({ error: 'Unknown ticket kind.' });
    const user = await User.findById(req.userId);
    if (!user.walletAddress) return res.status(400).json({ error: 'Link your wallet first.' });
    const check = await eligibility[kind](user);
    if (check.error) return res.status(check.status || 400).json({ error: check.error });
    const priceWei = toWei(check.priceGame);
    if (priceWei <= 0n) return res.status(400).json({ error: 'Ticket price is not configured.' });
    // Jeden aktywny voucher danego rodzaju na gracza - kolejne zapytanie wystawia nowy (stary wygasa).
    await ChainVoucher.deleteMany({ userId: user._id, kind, usedAt: null });
    const nonce = randomNonce();
    const deadline = Math.floor((Date.now() + VOUCHER_TTL_MS) / 1000);
    const value = { buyer: user.walletAddress, kind: TICKET_KIND[kind], price: priceWei, nonce, deadline };
    const sig = await signer.signTypedData(domain, TICKET_TYPES, value);
    await ChainVoucher.create({ nonce, userId: user._id, kind, amountWei: priceWei.toString(), expiresAt: new Date(deadline * 1000) });
    res.json({ kind: value.kind, price: priceWei.toString(), priceDoge: ethers.formatEther(priceWei), priceGame: check.priceGame, nonce, deadline, sig });
  }));

  // ---------------------------------------------------------------- rynki zakladow
  // Podzial puli (ta sama regula co w kontrakcie): gra 20%, bonus zwyciezcy 20% (max `cap`), reszta dla trafiajacych (min. ich stawki).
  function splitPool(total, winnersStakes, cap) {
    let house = (total * BigInt(rules.houseBps)) / 10000n;
    let bonus = (total * BigInt(rules.bonusBps)) / 10000n;
    if (bonus > cap) bonus = cap;
    let share = total - house - bonus;
    if (share < winnersStakes) {
      share = winnersStakes;
      const leftover = total - winnersStakes, weights = BigInt(rules.houseBps + rules.bonusBps);
      bonus = weights === 0n ? 0n : (leftover * BigInt(rules.bonusBps)) / weights;
      if (bonus > cap) bonus = cap;
      house = leftover - bonus;
    }
    return { share, bonus, house };
  }
  // Ile dostalby jeden trafiajacy, gdyby wygral ten wynik, przy danej puli i liczbie zakladow.
  function payoutPerBacker(totalStakes, winnersStakes, backers, cap) {
    if (backers <= 0 || winnersStakes <= 0 || winnersStakes >= totalStakes) return null; // zwrot stawek
    return splitPool(totalStakes, winnersStakes, cap).share / BigInt(backers);
  }

  async function marketView(m, userId) {
    const bets = await ChainBet.find({ marketId: m.marketId }).lean();
    const stake = ethers.parseEther(rules.stake);
    const counts = {};
    let total = 0n;
    let mineOutcome = null;
    for (const b of bets) {
      counts[b.outcome] = (counts[b.outcome] || 0) + 1;
      total += BigInt(b.amountWei);
      if (userId && b.userId === String(userId)) mineOutcome = b.outcome;
    }
    // Po rozstrzygnieciu: kto obstawil kogo i co z tego wyszlo (do okna wynikow).
    let bettors = null;
    if (m.status === 'resolved' || m.status === 'cancelled') {
      const ids = [...new Set(bets.map((b) => b.userId).filter(Boolean))];
      const names = Object.fromEntries((await User.find({ _id: { $in: ids } }).select('username')).map((u) => [String(u._id), u.username]));
      const pool = m.result && m.result.payoutPool ? ethers.parseEther(m.result.payoutPool) : 0n;
      const winnersStake = m.winnerOutcome ? bets.filter((b) => b.outcome === m.winnerOutcome).reduce((sum, b) => sum + BigInt(b.amountWei), 0n) : 0n;
      bettors = bets.map((b) => {
        const o = m.outcomes.find((x) => x.outcome === b.outcome);
        let result = 'lost', payout = 0n;
        if (m.status === 'cancelled') { result = 'refund'; payout = BigInt(b.amountWei); }
        else if (b.outcome === m.winnerOutcome && winnersStake > 0n) { result = 'won'; payout = (BigInt(b.amountWei) * pool) / winnersStake; }
        return { name: (b.userId && names[b.userId]) || 'Spectator', pick: o ? o.username : '?', result, payoutDoge: ethers.formatEther(payout), mine: !!(userId && b.userId === String(userId)) };
      });
    }
    return {
      bettors,
      id: m.marketId, roundId: m.roundId, title: m.title, status: m.status, closesAt: m.closesAt, roundEndsAt: m.roundEndsAt || null,
      winnerOutcome: m.winnerOutcome, winnerName: m.winnerName, result: m.result || null,
      stakeDoge: rules.stake, totalDoge: ethers.formatEther(total), bets: bets.length, minBets: rules.minBets, myOutcome: mineOutcome, bonusCapDoge: m.bonusCap || 0,
      outcomes: m.outcomes.map((o) => {
        const n = counts[o.outcome] || 0;
        // Ile dostalby kolejny obstawiajacy ten wynik, gdyby wygral (z jego stawka w puli).
        const ifWin = payoutPerBacker(total + stake, stake * BigInt(n + 1), n + 1, ethers.parseEther(String(m.bonusCap || 0)));
        return {
          outcome: o.outcome, username: o.username, bets: n,
          payoutIfWinDoge: ifWin === null ? rules.stake : ethers.formatEther(ifWin),
          mine: mineOutcome === o.outcome
        };
      }),
      txs: m.txs || {}
    };
  }

  app.get('/api/chain/markets', authOptional, wrap(async (req, res) => {
    if (!BETS_ENABLED) return res.json({ markets: [], rules, betsEnabled: false });
    const list = await ChainMarket.find({ status: { $ne: 'opening' } }).sort({ createdAt: -1 }).limit(30);
    res.json({ markets: await Promise.all(list.map((m) => marketView(m, req.userId))), rules });
  }));

  app.post('/api/chain/bets/voucher', authMiddleware, wrap(async (req, res) => {
    if (!BETS_ENABLED) return res.status(403).json({ error: 'Betting is not available.' });
    const user = await User.findById(req.userId);
    if (!user.walletAddress) return res.status(400).json({ error: 'Link your wallet first.' });
    const market = await ChainMarket.findOne({ marketId: String(req.body.marketId || '') });
    if (!market || market.status !== 'open') return res.status(400).json({ error: 'Betting is closed for this game.' });
    if (market.closesAt.getTime() <= Date.now()) return res.status(400).json({ error: 'The betting window has ended.' });
    const outcome = market.outcomes.find((o) => o.outcome === req.body.outcome);
    if (!outcome) return res.status(400).json({ error: 'Unknown player.' });
    // Uczestnik rundy nie moze obstawiac wlasnego turnieju (zaden ustawiony wynik).
    if (market.outcomes.some((o) => o.userId && o.userId === String(user._id))) {
      return res.status(403).json({ error: 'Players of this game cannot bet on it.' });
    }
    // Jedna stawka na portfel na gre.
    if (await ChainBet.exists({ marketId: market.marketId, bettor: user.walletAddress }) || await arena.hasBet(market.marketId, user.walletAddress)) {
      return res.status(400).json({ error: 'You have already placed a bet on this game.' });
    }
    const amountWei = ethers.parseEther(rules.stake); // stala stawka z kontraktu
    const nonce = randomNonce();
    const deadline = Math.floor(Math.min(Date.now() + VOUCHER_TTL_MS, market.closesAt.getTime()) / 1000);
    const value = { bettor: user.walletAddress, marketId: market.marketId, outcome: outcome.outcome, amount: amountWei, nonce, deadline };
    const sig = await signer.signTypedData(domain, BET_TYPES, value);
    await ChainVoucher.create({ nonce, userId: user._id, kind: 'bet', marketId: market.marketId, outcome: outcome.outcome, amountWei: amountWei.toString(), expiresAt: new Date(deadline * 1000) });
    res.json({ marketId: market.marketId, outcome: outcome.outcome, amount: amountWei.toString(), amountDoge: rules.stake, nonce, deadline, sig });
  }));

  // Zaklady gracza z ich stanem (do listy "My bets").
  app.get('/api/chain/me/bets', authMiddleware, wrap(async (req, res) => {
    const user = await getUser(req);
    if (!user.walletAddress) return res.json({ bets: [] });
    const mine = await ChainBet.find({ bettor: user.walletAddress }).sort({ createdAt: -1 }).limit(50).lean();
    const markets = Object.fromEntries((await ChainMarket.find({ marketId: { $in: [...new Set(mine.map((b) => b.marketId))] } })).map((m) => [m.marketId, m]));
    const bets = [];
    for (const b of mine) {
      const m = markets[b.marketId];
      if (!m) continue;
      const o = m.outcomes.find((x) => x.outcome === b.outcome);
      const pending = await arena.pendingBetPayout(b.marketId, user.walletAddress, b.outcome);
      bets.push({
        marketId: b.marketId, title: m.title, status: m.status, outcome: b.outcome, outcomeName: o ? o.username : '?',
        stakeDoge: ethers.formatEther(b.amountWei),
        payoutDoge: ethers.formatEther(pending),
        collectable: pending > 0n,
        lost: m.status === 'resolved' && m.winnerOutcome !== b.outcome,
        refunded: m.status === 'cancelled'
      });
    }
    res.json({ bets });
  }));

  // ---------------------------------------------------------------- admin (demo i obsluga)
  app.post('/api/chain/admin/demo-market', authMiddleware, requireAdmin, wrap(async (req, res) => {
    if (!BETS_ENABLED) return res.status(403).json({ error: 'Betting is switched off.' });
    const names = (Array.isArray(req.body.names) ? req.body.names : []).map((n) => String(n).trim()).filter(Boolean).slice(0, 10);
    if (names.length < 2) return res.status(400).json({ error: 'Give at least 2 names.' });
    const minutes = Math.min(Math.max(Number(req.body.minutes) || 10, 1), 240);
    const roundId = 'demo-' + crypto.randomBytes(6).toString('hex');
    const m = await createMarket({
      roundId, title: String(req.body.title || 'Demo market').slice(0, 80),
      outcomes: names.map((n, i) => ({ outcome: outcomeIdOf(`${roundId}:${i}`), userId: null, username: n })), closesInMs: minutes * 60000, roundEndsAt: null, bonusCap: Math.max(0, Number(req.body.bonusCap) || 750)
    });
    res.json({ marketId: m.marketId });
  }));
  app.post('/api/chain/admin/resolve', authMiddleware, requireAdmin, wrap(async (req, res) => {
    const m = await ChainMarket.findOne({ marketId: String(req.body.marketId || '') });
    if (!m) return res.status(404).json({ error: 'Market not found.' });
    if (req.body.cancel) await settleMarket(m, null); else {
      const o = m.outcomes.find((x) => x.outcome === req.body.outcome);
      if (!o) return res.status(400).json({ error: 'Unknown outcome.' });
      await settleMarket(m, o);
    }
    res.json({ success: true });
  }));
  app.post('/api/chain/admin/roll-season', authMiddleware, requireAdmin, wrap(async (req, res) => {
    const rc = await sendTx('rollSeason', (c) => c.rollSeason());
    res.json({ success: true, tx: rc.hash });
  }));

  // ---------------------------------------------------------------- cykl zycia rynku
  async function createMarket({ roundId, title, outcomes, closesInMs, roundEndsAt, bonusCap }) {
    const marketId = marketIdOf(roundId);
    const m = await ChainMarket.create({ marketId, roundId, title, outcomes, closesAt: new Date(Date.now() + closesInMs), roundEndsAt: roundEndsAt || null, bonusCap: bonusCap || 0, status: 'opening' });
    await openOnChain(m);
    return m;
  }
  async function openOnChain(m) {
    let rc = null;
    try { rc = await sendTx('openMarket', (c) => c.openMarket(m.marketId)); } catch (e) {
      // Already opened on-chain (an earlier attempt landed after we gave up): only the database still says 'opening'.
      if (!/market exists/i.test(e.shortMessage || e.message || '')) throw e;
    }
    m.status = 'open';
    if (rc) m.txs = { ...(m.txs || {}), open: rc.hash };
    m.markModified('txs');
    await m.save();
  }
  async function closeOnChain(m) {
    const rc = await sendTx('closeMarket', (c) => c.closeMarket(m.marketId));
    m.status = 'closed';
    m.txs = { ...(m.txs || {}), close: rc.hash };
    m.markModified('txs');
    await m.save();
  }
  // outcome === null -> anulowanie (zwrot stawek)
  async function settleMarket(m, outcome) {
    if (m.status === 'resolved' || m.status === 'cancelled') return;
    if (m.status === 'opening') await openOnChain(m);
    if (!outcome) {
      const rc = await sendTx('cancelMarket', (c) => c.cancelMarket(m.marketId));
      m.status = 'cancelled';
      m.txs = { ...(m.txs || {}), settle: rc.hash };
    } else {
      if (m.status === 'open') await closeOnChain(m);
      // Portfel gracza, ktory wygral runde - dostaje bonus z puli zakladow (brak portfela => bonus trafia do gry).
      const winnerUser = outcome.userId ? await User.findById(outcome.userId).select('walletAddress') : null;
      const winnerWallet = winnerUser && winnerUser.walletAddress ? ethers.getAddress(winnerUser.walletAddress) : ethers.ZeroAddress;
      const rc = await sendTx('resolveMarket', (c) => c.resolveMarket(m.marketId, outcome.outcome, winnerWallet, ethers.parseEther(String(m.bonusCap || 0))));
      // Za malo zakladow / nikt nie trafil / wszyscy trafili - kontrakt sam anuluje rynek (zwrot stawek).
      const info = await arena.markets(m.marketId);
      m.status = Number(info.status) === 4 ? 'cancelled' : 'resolved';
      m.winnerOutcome = outcome.outcome;
      m.winnerName = outcome.username;
      if (m.status === 'resolved') {
        // Dokladny podzial odczytujemy ze zdarzenia MarketResolved (total, pula trafiajacych, bonus zwyciezcy, gra).
        const ev = rc.logs.map((l) => { try { return iface.parseLog(l); } catch (_) { return null; } }).find((x) => x && x.name === 'MarketResolved');
        if (ev) {
          m.result = { total: ethers.formatEther(ev.args.total), payoutPool: ethers.formatEther(ev.args.payoutPool), winnerBonus: ethers.formatEther(ev.args.winnerBonus), house: ethers.formatEther(ev.args.houseCut) };
          m.markModified('result');
        }
      }
      m.txs = { ...(m.txs || {}), settle: rc.hash };
    }
    m.markModified('txs');
    await m.save();
  }

  // Wywolywane z server.js po utworzeniu rundy / po jej zakonczeniu.
  async function onRoundStarted({ round, roomName, players }) {
    if (!BETS_ENABLED) return;
    const real = (players || []).filter((p) => p && !p.isBot && p.userId);
    if (real.length < 2) return;
    const roundId = String(round._id);
    if (await ChainMarket.exists({ roundId })) return;
    const startedAt = round.roundStartedAt ? new Date(round.roundStartedAt).getTime() : Date.now();
    const endsAt = round.roundEndsAt ? new Date(round.roundEndsAt).getTime() : null;
    const lengthMs = endsAt ? Math.max(0, endsAt - startedAt) : 60 * 60 * 1000;
    // Bonus dla zwyciezcy gry z zakladow nie moze przekroczyc polowy pierwszej nagrody tego turnieju.
    let firstPrize = 0;
    try { const room = Room ? await Room.findById(round.roomId).select('miniTournamentPrizes') : null; firstPrize = Number(room && room.miniTournamentPrizes && room.miniTournamentPrizes.place1VPLN) || 0; } catch (_) { /* brak pokoju */ }
    await createMarket({
      roundId, title: `${roomName || 'Mini-Tournament'}`, closesInMs: Math.max(MIN_BET_WINDOW_MS, Math.round(lengthMs * BET_WINDOW_FRACTION)), roundEndsAt: endsAt ? new Date(endsAt) : null, bonusCap: firstPrize * PRICE_SCALE * 0.5,
      outcomes: real.map((p) => ({ outcome: outcomeIdOf(String(p.userId)), userId: String(p.userId), username: p.username || p.name || 'Player' }))
    });
  }
  async function onRoundFinished({ round, winnerUserId }) {
    const m = await ChainMarket.findOne({ roundId: String(round._id) });
    if (!m) return;
    const winner = winnerUserId ? m.outcomes.find((o) => o.userId === String(winnerUserId)) : null;
    await settleMarket(m, winner || null);
  }

  // Zamykanie rynkow po uplywie okna zakladow + dokanczanie otwarcia po awarii.
  async function marketTick() {
    const now = new Date();
    for (const m of await ChainMarket.find({ status: 'opening' })) await openOnChain(m).catch((e) => console.error('[chain] open retry', e.shortMessage || e.message));
    for (const m of await ChainMarket.find({ status: 'open', closesAt: { $lte: now } })) await closeOnChain(m).catch((e) => console.error('[chain] close', e.shortMessage || e.message));
  }

  // ---------------------------------------------------------------- nagrody
  // entries: [{ userId, username, placement, amountGame }] - zwraca zbior userId, ktorym wyplacono w kontrakcie.
  // Pozostali (bez portfela / za mala pula / blad sieci) dostaja saldo w grze, wiec nic nie przepada.
  async function creditRoundPrizes(roundId, entries) {
    const paid = new Set();
    const users = await User.find({ _id: { $in: entries.map((e) => e.userId) } }).select('walletAddress');
    const addr = Object.fromEntries(users.map((u) => [String(u._id), u.walletAddress]));
    const onchain = entries.filter((e) => addr[String(e.userId)] && toWei(e.amountGame) > 0n);
    if (onchain.length) {
      try {
        const sum = onchain.reduce((s, e) => s + toWei(e.amountGame), 0n);
        if (sum > await arena.prizePool()) throw new Error('prize pool too small');
        const ref = ethers.id(`wol:prize:${roundId}`);
        const rc = await sendTx('creditPrizes', (c) => c.creditPrizes(ref, onchain.map((e) => addr[String(e.userId)]), onchain.map((e) => toWei(e.amountGame))));
        for (const e of onchain) {
          paid.add(String(e.userId));
          await ChainPrize.create({ ref: String(roundId), userId: String(e.userId), username: e.username, address: addr[String(e.userId)], placement: e.placement, amountGame: e.amountGame, amountWei: toWei(e.amountGame).toString(), where: 'chain', txHash: rc.hash });
        }
      } catch (err) {
        console.error('[chain] creditPrizes nieudane - nagrody trafia na saldo gry:', err.shortMessage || err.message);
      }
    }
    for (const e of entries) {
      if (!paid.has(String(e.userId))) await ChainPrize.create({ ref: String(roundId), userId: String(e.userId), username: e.username, placement: e.placement, amountGame: e.amountGame, where: 'balance' });
    }
    return paid;
  }

  // ---------------------------------------------------------------- watcher zdarzen
  let polling = false;
  async function pollEvents() {
    if (polling) return;
    polling = true;
    try {
      let state = await ChainState.findOne({ key: 'arena' });
      if (!state) state = await ChainState.create({ key: 'arena', lastBlock: Math.max(0, (deployment.deployBlock || 0) - 1) });
      const head = await provider.getBlockNumber();
      for (let from = state.lastBlock + 1; from <= head; from += 2000) {
        const to = Math.min(from + 1999, head);
        const logs = await provider.getLogs({ address: deployment.address, fromBlock: from, toBlock: to });
        for (const log of logs) await handleLog(log);
        state.lastBlock = to;
        await state.save();
      }
    } catch (err) {
      console.error('[chain] poll error:', err.shortMessage || err.message);
    } finally { polling = false; }
  }

  async function handleLog(log) {
    let parsed;
    try { parsed = iface.parseLog(log); } catch (_) { return; }
    if (!parsed) return;
    try {
      await ChainEvent.create({ txHash: log.transactionHash, logIndex: log.index, name: parsed.name, blockNumber: log.blockNumber, args: parsed.args.toArray().map(String) });
    } catch (err) {
      if (err.code === 11000) return; // juz przetworzone
      throw err;
    }
    if (parsed.name === 'TicketPurchased') await onTicketPurchased(parsed.args, log);
    else if (parsed.name === 'BetPlaced') await onBetPlaced(parsed.args, log);
  }

  async function onTicketPurchased(args, log) {
    const voucher = await ChainVoucher.findOne({ nonce: args.nonce.toString() });
    if (!voucher || voucher.usedAt) return console.error('[chain] bilet bez vouchera / voucher juz uzyty:', log.transactionHash);
    voucher.usedAt = new Date();
    await voucher.save();
    const priceGame = fromWei(args.price) / PRICE_SCALE;
    if (voucher.kind === 'monthly') {
      const order = await TicketOrder.create({ userId: voucher.userId, quantity: 1, grossAmountZl: priceGame, currency: 'DOGE', status: 'paid', paidAt: new Date() });
      await grant.monthly(order);
    } else {
      const order = await MiniTournamentTicketOrder.create({ userId: voucher.userId, grossAmountZl: priceGame, currency: 'DOGE', status: 'paid', paidAt: new Date() });
      await grant.mini(order);
    }
    console.log(`[chain] bilet ${voucher.kind} przyznany (tx ${log.transactionHash})`);
  }

  async function onBetPlaced(args, log) {
    const voucher = await ChainVoucher.findOne({ nonce: args.nonce.toString() });
    if (voucher) { voucher.usedAt = new Date(); await voucher.save(); }
    try {
      await ChainBet.create({
        marketId: args.marketId, bettor: args.bettor.toLowerCase(), userId: voucher ? String(voucher.userId) : null, outcome: args.outcome,
        amountWei: args.amount.toString(), txHash: log.transactionHash, logIndex: log.index
      });
    } catch (err) { if (err.code !== 11000) throw err; }
  }

  const timers = [setInterval(pollEvents, 8000), setInterval(() => marketTick().catch((e) => console.error('[chain] tick', e.message)), 15000)];
  timers.forEach((t) => t.unref && t.unref());
  setTimeout(() => { pollEvents(); marketTick().catch(() => {}); }, 2000);
  console.log(`[chain] wlaczone: kontrakt ${deployment.address}, oracle ${signer.address}, siec ${NETWORK.name}`);

  return { enabled: true, onRoundStarted, onRoundFinished, creditRoundPrizes };
}

module.exports = { init, outcomeIdOf, marketIdOf, NETWORK };
