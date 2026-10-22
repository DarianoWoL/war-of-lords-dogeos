// Pokazuje stan portfela gracza i kontraktu na testnecie DogeOS: node scripts/inspect-wallet.js 0xAdres
const { ethers } = require('ethers');
const abi = require('../../src/chain/arena.abi.json');
const dep = require('../deployments/dogeosTestnet.json');
(async () => {
  const addr = process.argv[2];
  const provider = new ethers.JsonRpcProvider('https://rpc.testnet.dogeos.com/');
  const arena = new ethers.Contract(dep.address, abi, provider);
  console.log('Portfel', addr);
  console.log(' saldo:', ethers.formatEther(await provider.getBalance(addr)), 'DOGE');
  console.log(' do odebrania w kontrakcie:', ethers.formatEther(await arena.claimable(addr)), 'DOGE | lacznie wygrane:', ethers.formatEther(await arena.totalWon(addr)));
  console.log('Kontrakt: pula', ethers.formatEther(await arena.prizePool()), '| skarbiec', ethers.formatEther(await arena.treasury()), '| saldo', ethers.formatEther(await provider.getBalance(dep.address)));
  const head = await provider.getBlockNumber();
  const logs = await arena.queryFilter('*', Math.max(dep.deployBlock, head - 50000), head);
  for (const l of logs) {
    const a = l.args ? [...l.args].map((x) => (typeof x === 'bigint' ? ethers.formatEther(x) : String(x))) : [];
    if (JSON.stringify(a).toLowerCase().includes(addr.toLowerCase().slice(2))) console.log(' zdarzenie', l.fragment.name, 'blok', l.blockNumber, 'tx', l.transactionHash, a.join(' | ').slice(0, 160));
  }
})().catch((e) => console.error(e.shortMessage || e.message));
