// Zmienia stala stawke zakladu w kontrakcie (tylko wlasciciel): node scripts/set-stake.js 5   (potem restart serwera gry odswieza zasady)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.chain') });
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
const addr = require('../deployments/dogeosTestnet.json').address;
(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/', undefined, { cacheTimeout: -1 });
  const c = new ethers.Contract(addr, abi, new ethers.Wallet(process.env.CHAIN_ORACLE_KEY, p));
  const stake = ethers.parseEther(process.argv[2] || '20');
  const [minBets, house, bonus] = await Promise.all([c.minBets(), c.houseBps(), c.bonusBps()]);
  await (await c.setBetRules(stake, minBets, house, bonus)).wait();
  console.log('stawka zakladu:', ethers.formatEther(await c.betStake()), 'DOGE | min. zakladow', Number(minBets));
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
