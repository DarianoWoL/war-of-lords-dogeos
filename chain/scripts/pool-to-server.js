// Przenosi DOGE z puli nagrod na konto serwera (bank demo dla widzow): node scripts/pool-to-server.js 40
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
const addr = require('../deployments/dogeosTestnet.json').address;
(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/', undefined, { cacheTimeout: -1 });
  const w = new ethers.NonceManager(new ethers.Wallet(process.env.CHAIN_ORACLE_KEY, p));
  const c = new ethers.Contract(addr, abi, w);
  const amount = ethers.parseEther(process.argv[2] || '40');
  await (await c.creditPrizes(ethers.id('pool-to-server:' + Date.now()), [await w.getAddress()], [amount])).wait();
  await (await c.claim()).wait();
  console.log('przeniesiono', ethers.formatEther(amount), 'DOGE z puli na konto serwera | pula:', ethers.formatEther(await c.prizePool()), '| serwer:', ethers.formatEther(await p.getBalance(await w.getAddress())));
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
