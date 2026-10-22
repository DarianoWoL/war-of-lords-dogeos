require('@nomicfoundation/hardhat-toolbox');
const path = require('path');
// Klucz serwera/wdrozenia testnetu: chain/.env.chain (poza gitem) albo zmienna CHAIN_ORACLE_KEY.
require('dotenv').config({ path: path.join(__dirname, '.env.chain') });

const key = process.env.CHAIN_ORACLE_KEY;

module.exports = {
  solidity: { version: '0.8.24', settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: { chainId: Number(process.env.HH_CHAIN_ID || 31337) },
    dogeosTestnet: {
      url: process.env.DOGEOS_RPC_URL || 'https://rpc.testnet.dogeos.com/',
      chainId: 6281971,
      accounts: key ? [key] : []
    }
  }
};
