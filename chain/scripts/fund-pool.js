// Zasila pule nagrod kontraktu testowymi DOGE z konta serwera: node scripts/fund-pool.js <ilosc>
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
const dep = require('../deployments/dogeosTestnet.json');

(async () => {
  const amount = process.argv[2] || '10';
  const provider = new ethers.JsonRpcProvider(process.env.DOGEOS_RPC_URL || 'https://rpc.testnet.dogeos.com/');
  const wallet = new ethers.Wallet(process.env.CHAIN_ORACLE_KEY, provider);
  const arena = new ethers.Contract(dep.address, abi, wallet);
  const tx = await arena.fund({ value: ethers.parseEther(amount) });
  await tx.wait();
  console.log('fund tx', tx.hash, '| pula:', ethers.formatEther(await arena.prizePool()), 'DOGE');
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
