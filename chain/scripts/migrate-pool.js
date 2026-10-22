// Przenosi pule nagrod i skarbiec ze starego kontraktu do obecnego (tylko testnet): rollSeason -> creditPrizes na konto serwera
// -> claim -> fund nowego kontraktu. Nagrody graczy (claimable) zostaja na starym kontrakcie - gracze odbieraja je sami.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
// uzycie: node scripts/migrate-pool.js dogeosTestnet.v2-backup.json  (plik z chain/deployments)
const OLD = require('../deployments/' + (process.argv[2] || 'dogeosTestnet.v1-backup.json')).address;
const NEW = require('../deployments/dogeosTestnet.json').address;
(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/', undefined, { cacheTimeout: -1 });
  const w = new ethers.NonceManager(new ethers.Wallet(process.env.CHAIN_ORACLE_KEY, p));
  const me = await w.getAddress();
  const oldC = new ethers.Contract(OLD, abi, w), newC = new ethers.Contract(NEW, abi, w);
  if ((await oldC.treasury()) > 0n) { await (await oldC.rollSeason()).wait(); console.log('skarbiec starego kontraktu przeniesiony do puli'); }
  const pool = await oldC.prizePool();
  console.log('pula starego kontraktu:', ethers.formatEther(pool), 'DOGE');
  if (pool > 0n) {
    await (await oldC.creditPrizes(ethers.id('migrate-v1-pool:' + Date.now()), [me], [pool])).wait();
    await (await oldC.claim()).wait();
    console.log('odebrano na konto serwera:', ethers.formatEther(pool), 'DOGE');
  }
  const keepGas = ethers.parseEther('4');
  const bal = await p.getBalance(me);
  if (bal > keepGas) {
    const amount = bal - keepGas;
    await (await newC.fund({ value: amount })).wait();
    console.log('wplacono do puli nowego kontraktu:', ethers.formatEther(amount), 'DOGE');
  }
  console.log('nowy kontrakt: pula', ethers.formatEther(await newC.prizePool()), '| saldo serwera', ethers.formatEther(await p.getBalance(me)));
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
