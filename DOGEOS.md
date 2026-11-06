# War of Lords on DogeOS (testnet)

> **Testnet only. Test DOGE has no value.** This branch (`dogeos-testnet`) is a hackathon build for *Vibe Code on DOGE*
> (Noah AI × DogeOS). The production game is untouched.

War of Lords is a browser strategy game (real-time villages, armies, tournaments with a Monthly Tournament and
Mini-Tournaments). This build lets players **connect their DogeOS wallet, pay tournament entry on-chain, receive prizes
from a smart contract and bet on who wins a round**.

## What is on-chain

One contract, [`WarOfLordsArena`](chain/contracts/WarOfLordsArena.sol), on **DogeOS Chikyu Testnet** (chain ID 6281971):

| Flow | How it works |
|---|---|
| **Tournament tickets** | The game server checks the rules (tournament open, one Monthly ticket per month, pool not exhausted) and signs a one-time **EIP-712 voucher**. The player pays the entry fee from the wallet with `buyTicket`; the contract only accepts a valid voucher. The server watches the `TicketPurchased` event and grants the ticket in the game. |
| **Prizes** | When a Mini-Tournament round ends the server reports the podium (`creditPrizes`); the prize pool is funded by ticket sales (90%) and top-ups. Winners withdraw with `claim()`. A player without a linked wallet gets the prize on the in-game balance, so nothing is lost. |
| **Season treasury** | 10% of each ticket and 5% of each betting pool go to a season treasury; `rollSeason()` moves it into the prize pool for the next tournaments. |
| **Spectator betting (Live Bets)** | Every Mini-Tournament round opens a market "who wins?" (outcomes = the round's players). A bet is a fixed **20 DOGE** from the wallet, one per wallet per game, open for the first sixth of the round (min. 60 s). Settlement: **20%** of the pool stays with the game, the player who won the game gets a **bonus of 20% capped at half of that tournament's first prize**, and the **rest goes to the people who picked the winner** (they never get less than their stake back). Refund for everybody if fewer than 3 bets, nobody picked the winner, or everybody picked the same player. Players of a round cannot bet on it. Winnings, refunds and prizes are collected in **one transaction** (`claimAll`) with the gold Claim button. |
| **Wallet link** | The wallet is linked to the game account by signing a message (no gas). One wallet = one account. |

Trust model (testnet demo): the game server is the contract's *oracle* — it signs vouchers and reports results. It can
never take player funds: the contract moves money only by the rules above. A production version would move result
reporting to a decentralised scheme.

## Architecture

```
Browser (dogeos.html, ethers.js, EIP-6963 / window.ethereum wallet)
   │  voucher request / wallet link                ▲ events (TicketPurchased, BetPlaced)
   ▼                                               │
Game server (Node/Express, src/chain)  ───────────►│  JSON-RPC https://rpc.testnet.dogeos.com
   │  signs vouchers, opens/closes/resolves markets, credits prizes
   ▼
WarOfLordsArena (Solidity 0.8.24)
```

* `chain/` – Hardhat project: contract, 12 unit tests, deploy script, end-to-end scripts.
* `src/chain/` – server module (routes `/api/chain/*`, event watcher, market lifecycle, prize payout).
* `public/dogeos.html` – player page (wallet, tickets, prizes, bets, stats, admin demo tools).

## Run it

```bash
# 1. contract tests
cd chain && npm install && npx hardhat test

# 2. full local stack test (Mongo + local chain with chainId 6281971 + game server + 2 test suites)
bash chain/scripts/run-e2e.sh            # API level
bash chain/scripts/run-e2e.sh ui-e2e.js  # browser UI with an injected wallet, screenshots in chain/screenshots

# 3. deploy to DogeOS testnet (needs testnet DOGE for gas on the server key)
echo CHAIN_ORACLE_KEY=0x... > chain/.env.chain
cd chain && npx hardhat run scripts/deploy.js --network dogeosTestnet
# then start the game server (node src/server.js) and open /dogeos.html
```

Config (env): `CHAIN_ORACLE_KEY`, `CHAIN_CONTRACT`, `DOGEOS_RPC_URL`, `CHAIN_PRICE_SCALE` (default `1`: a 10-DOGE game
ticket costs 10 testnet DOGE; prizes are paid 1:1), `CHAIN_BET_WINDOW_MINUTES` (default 10), `CHAIN_MAX_BET` (default 50).

## Demo script (≈2 minutes)

1. Log in, open **Shop → DogeOS Testnet**, connect the wallet, switch to DogeOS Testnet, link the wallet (signature).
2. Buy a **Mini-Tournament ticket** from the wallet; the ticket appears in the game after the transaction confirms.
3. In the betting section place a bet on a round (as a spectator); show the live pool and multipliers.
4. Settle the round: winners press **Collect** (bets) or **Claim prize**; open the transactions in the block explorer.

## Hackathon submission text (draft)

**Name:** War of Lords — Onchain Tournaments

**Description:** War of Lords is a real-time browser strategy game with monthly and mini tournaments. On DogeOS testnet,
tournament entry fees are paid by wallet straight into a smart contract, prizes are credited on-chain and claimed by the
winners, and spectators can bet on who wins each round in a parimutuel market. The game server is only an oracle that
signs vouchers and reports results — it never holds player funds. Built for competitive players and the DOGE community who
want skill-based tournaments with transparent prize pools.

**DogeOS integration:** the whole money layer runs on DogeOS testnet (EVM, chain ID 6281971): entry tickets (EIP-712
vouchers verified by the contract), prize pool and claim, season treasury, and betting markets with refunds. Everything is
verifiable in the block explorer; the wallet is linked to the game account by a signed message.

**Demo:** short video + screenshots (see `chain/screenshots` after running the UI test).

## Known limits / next steps

* Monthly Tournament semifinal/final prizes still use the in-game balance path (Mini-Tournaments are on-chain).
* The oracle is a single server key (fine for a testnet demo).
* Betting is testnet-only by design; it is not intended for real-money use.
