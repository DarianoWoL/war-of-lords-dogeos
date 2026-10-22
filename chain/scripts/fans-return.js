// Zwraca czesc srodkow wirtualnych widzow do puli nagrod kontraktu: node scripts/fans-return.js [ile DOGE z kazdego, domyslnie 40]
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/', undefined, { cacheTimeout: -1 });
  const addr = process.env.CHAIN_CONTRACT || require('../deployments/dogeosTestnet.json').address;
  const amount = ethers.parseEther(process.argv[2] || '40');
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo-fans.json'), 'utf8'));
  for (const [name, key] of Object.entries(keys)) {
    const w = new ethers.Wallet(key, p);
    const bal = await p.getBalance(w.address);
    if (bal < amount + ethers.parseEther('0.02')) { console.log(name, 'ma za malo:', ethers.formatEther(bal)); continue; }
    await (await new ethers.Contract(addr, abi, w).fund({ value: amount })).wait();
    console.log(name, 'zwrocil', ethers.formatEther(amount), 'DOGE do puli');
  }
  console.log('pula nagrod:', ethers.formatEther(await new ethers.Contract(addr, abi, p).prizePool()), 'DOGE');
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
