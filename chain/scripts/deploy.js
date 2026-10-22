// Wdraza WarOfLordsArena na testnet DogeOS (klucz z chain/.env.chain: CHAIN_ORACLE_KEY) i zapisuje adres + ABI dla serwera.
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error('Brak klucza: ustaw CHAIN_ORACLE_KEY w chain/.env.chain');
  const net = await hre.ethers.provider.getNetwork();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Siec ${hre.network.name} (chainId ${net.chainId}), konto ${deployer.address}, saldo ${hre.ethers.formatEther(balance)} DOGE`);
  if (balance === 0n) throw new Error('Saldo 0 - pobierz testowe DOGE z kranu DogeOS na adres konta.');

  // Wlasciciel i oracle to ten sam klucz (testnet). Na produkcji rozdzielic.
  const arena = await (await hre.ethers.getContractFactory('WarOfLordsArena')).deploy(deployer.address);
  await arena.waitForDeployment();
  const address = await arena.getAddress();
  const tx = arena.deploymentTransaction();
  console.log('WarOfLordsArena:', address, 'tx', tx.hash);

  const artifact = await hre.artifacts.readArtifact('WarOfLordsArena');
  const out = { network: hre.network.name, chainId: Number(net.chainId), address, deployTx: tx.hash, deployedAt: new Date().toISOString(), deployBlock: (await tx.wait()).blockNumber };
  fs.writeFileSync(path.join(__dirname, '..', 'deployments', `${hre.network.name}.json`), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'src', 'chain', 'arena.abi.json'), JSON.stringify(artifact.abi, null, 2) + '\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
