// Stan starego kontraktu v1 (0x901C...7571): node scripts/inspect-old.js 0xPortfelGracza
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
const OLD = '0x901Ce4f25F31CB6e8Ac3fbF162F441cFB1007571';
(async () => {
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/');
  const c = new ethers.Contract(OLD, abi, p);
  const bal = await p.getBalance(OLD);
  const [pool, tre] = await Promise.all([c.prizePool(), c.treasury()]);
  console.log('stary kontrakt: saldo', ethers.formatEther(bal), '| pula', ethers.formatEther(pool), '| skarbiec', ethers.formatEther(tre), '| reszta (nagrody/zaklady graczy)', ethers.formatEther(bal - pool - tre));
  const w = process.argv[2];
  if (w) console.log('gracz', w, '- do odebrania:', ethers.formatEther(await c.claimable(w)), 'DOGE | lacznie wygrane:', ethers.formatEther(await c.totalWon(w)));
})();
