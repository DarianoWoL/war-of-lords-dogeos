// Sprawdza wirtualnych widzow: sa doladowani z puli kontraktu i obstawiaja otwarty rynek.
const { spawnSync } = require('child_process');
const path = require('path');
const { ethers } = require('ethers');
const mongoose = require('../../node_modules/mongoose');
const BASE = 'http://127.0.0.1:3101';
let failed = 0;
const ok = (c, m) => { console.log(c ? '  OK  ' : ' FAIL ', m); if (!c) failed++; };
async function api(method, p, token, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
(async () => {
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
  const funder = await provider.getSigner(1);
  const cfg = await api('GET', '/api/chain/config');
  await (await funder.sendTransaction({ to: cfg.contract, value: ethers.parseEther('300') })).wait(); // pula nagrod
  await mongoose.connect(process.env.MONGO_URI);
  const name = 'fanadmin' + Date.now().toString().slice(-5);
  await api('POST', '/api/auth/register', null, { username: name, password: 'Haslo12345', email: name + '@t.local', termsAccepted: true });
  await mongoose.connection.db.collection('users').updateOne({ username: name }, { $set: { isAdmin: true } });
  const token = (await api('POST', '/api/auth/login', null, { username: name, password: 'Haslo12345' })).token;
  const dm = await api('POST', '/api/chain/admin/demo-market', token, { title: 'Fan test', names: ['Red', 'Blue', 'Green'], minutes: 10 });
  ok(dm.marketId, 'demo market opened');
  for (let i = 0; i < 3; i += 1) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'demo-fans.js'), '3', '--once'], { env: { ...process.env, BASE }, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) console.log(r.stdout, r.stderr);
  }
  await new Promise((r) => setTimeout(r, 10000)); // watcher serwera indeksuje zaklady
  const m = (await api('GET', '/api/chain/markets', token)).markets.find((x) => x.id === dm.marketId);
  ok(m.bets >= 2, `virtual fans placed bets on the market (${m.bets} bets, pool ${m.totalDoge} DOGE)`);
  const fanWallets = Object.values(require('../demo-fans.json')).map((k) => new ethers.Wallet(k));
  ok((await provider.getBalance(fanWallets[0].address)) > 0n, 'fans were topped up from the contract pool');
  await mongoose.disconnect();
  console.log(failed ? `\n${failed} FAILED` : '\nFANS CHECK PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
