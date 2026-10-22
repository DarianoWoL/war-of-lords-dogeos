const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const DOGE = (n) => ethers.parseEther(String(n));
const CAP = ethers.parseEther('1000'); // limit bonusu zwyciezcy (tu: nie ogranicza)
const id = (s) => ethers.id(s); // bytes32 ids (marketId / outcome)

describe('WarOfLordsArena', () => {
  let arena, owner, oracle, alice, bob, carol, domain;
  const TICKET_TYPES = { Ticket: [
    { name: 'buyer', type: 'address' }, { name: 'kind', type: 'uint8' }, { name: 'price', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] };
  const BET_TYPES = { Bet: [
    { name: 'bettor', type: 'address' }, { name: 'marketId', type: 'bytes32' }, { name: 'outcome', type: 'bytes32' },
    { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
  ] };

  async function ticketVoucher(buyer, { kind = 1, price = DOGE(1), nonce = 1, ttl = 600, signer = oracle } = {}) {
    const deadline = (await time.latest()) + ttl;
    const value = { buyer: buyer.address, kind, price, nonce, deadline };
    const sig = await signer.signTypedData(domain, TICKET_TYPES, value);
    return { ...value, sig };
  }
  async function betVoucher(bettor, marketId, outcome, amount, { nonce = 100, ttl = 600, signer = oracle } = {}) {
    const deadline = (await time.latest()) + ttl;
    const value = { bettor: bettor.address, marketId, outcome, amount, nonce, deadline };
    const sig = await signer.signTypedData(domain, BET_TYPES, value);
    return { ...value, sig };
  }
  const buy = (who, v) => arena.connect(who).buyTicket(v.kind, v.price, v.nonce, v.deadline, v.sig, { value: v.price });
  const bet = (who, v) => arena.connect(who).placeBet(v.marketId, v.outcome, v.amount, v.nonce, v.deadline, v.sig, { value: v.amount });

  beforeEach(async () => {
    [owner, oracle, alice, bob, carol] = await ethers.getSigners();
    arena = await (await ethers.getContractFactory('WarOfLordsArena')).deploy(oracle.address);
    domain = { name: 'WarOfLordsArena', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await arena.getAddress() };
  });

  describe('tickets', () => {
    it('sells a ticket for a valid voucher and splits price into prize pool and treasury', async () => {
      const v = await ticketVoucher(alice);
      await expect(buy(alice, v)).to.emit(arena, 'TicketPurchased').withArgs(alice.address, 1, DOGE(1), 1);
      expect(await arena.treasury()).to.equal(DOGE(0.1));
      expect(await arena.prizePool()).to.equal(DOGE(0.9));
      expect(await arena.ticketsBought(alice.address)).to.equal(1);
    });
    it('rejects a replayed voucher, a wrong amount, an expired voucher and a stranger voucher', async () => {
      const v = await ticketVoucher(alice);
      await buy(alice, v);
      await expect(buy(alice, v)).to.be.revertedWith('voucher used');
      const v2 = await ticketVoucher(alice, { nonce: 2 });
      await expect(arena.connect(alice).buyTicket(v2.kind, v2.price, v2.nonce, v2.deadline, v2.sig, { value: DOGE(0.5) })).to.be.revertedWith('wrong amount');
      const v3 = await ticketVoucher(alice, { nonce: 3, ttl: 10 });
      await time.increase(60);
      await expect(buy(alice, v3)).to.be.revertedWith('voucher expired');
      const v4 = await ticketVoucher(alice, { nonce: 4, signer: bob });
      await expect(buy(alice, v4)).to.be.revertedWith('bad voucher');
    });
    it('a voucher issued for alice cannot be used by bob', async () => {
      const v = await ticketVoucher(alice);
      await expect(buy(bob, v)).to.be.revertedWith('bad voucher');
    });
  });

  describe('prizes', () => {
    beforeEach(async () => {
      await buy(alice, await ticketVoucher(alice, { nonce: 1, price: DOGE(10) })); // pool = 9
    });
    it('credits prizes once, winners claim, pool shrinks', async () => {
      const ref = id('round-1');
      await expect(arena.connect(oracle).creditPrizes(ref, [alice.address, bob.address], [DOGE(5), DOGE(2)])).to.emit(arena, 'PrizeCredited');
      expect(await arena.prizePool()).to.equal(DOGE(2));
      expect(await arena.winCount(alice.address)).to.equal(1);
      await expect(arena.connect(oracle).creditPrizes(ref, [alice.address], [DOGE(1)])).to.be.revertedWith('already paid');
      await expect(arena.connect(alice).claim()).to.changeEtherBalance(alice, DOGE(5));
      await expect(arena.connect(alice).claim()).to.be.revertedWith('nothing to claim');
      expect(await arena.totalWon(alice.address)).to.equal(DOGE(5));
    });
    it('does not credit more than the pool and only the oracle can credit', async () => {
      await expect(arena.connect(oracle).creditPrizes(id('r'), [alice.address], [DOGE(50)])).to.be.revertedWith('pool too small');
      await expect(arena.connect(alice).creditPrizes(id('r2'), [alice.address], [DOGE(1)])).to.be.revertedWith('not oracle');
    });
    it('fund() tops up the pool and rollSeason moves the treasury into it', async () => {
      await arena.connect(bob).fund({ value: DOGE(3) });
      expect(await arena.prizePool()).to.equal(DOGE(12));
      expect(await arena.treasury()).to.equal(DOGE(1));
      await expect(arena.connect(oracle).rollSeason()).to.emit(arena, 'SeasonRolled').withArgs(1, DOGE(1));
      expect(await arena.prizePool()).to.equal(DOGE(13));
      expect(await arena.treasury()).to.equal(0);
      expect(await arena.season()).to.equal(2);
    });
  });

  describe('betting', () => {
    const M = id('market-1');
    const A = id('player-A');
    const B = id('player-B');
    const C = id('player-C');
    let dave, eve, frank;
    let nonce = 1000;
    beforeEach(async () => {
      [, , , , , dave, eve, frank] = await ethers.getSigners();
      await arena.connect(oracle).openMarket(M);
    });
    const stake20 = DOGE(20);
    const place = async (who, outcome, m = M) => bet(who, await betVoucher(who, m, outcome, stake20, { nonce: nonce++ }));

    it('splits the pool: backers share 60%, the winning player and the game get 20% each', async () => {
      await place(alice, A); await place(bob, A); await place(carol, B); await place(dave, B); await place(eve, B);
      await arena.connect(oracle).closeMarket(M);
      await arena.connect(oracle).resolveMarket(M, A, frank.address, CAP);
      // pool 100: backers of A share 60 (30 each), winning player gets 20, game gets 20
      await expect(arena.connect(alice).collectBet(M, A)).to.changeEtherBalance(alice, DOGE(30));
      await expect(arena.connect(bob).collectBet(M, A)).to.changeEtherBalance(bob, DOGE(30));
      expect(await arena.claimable(frank.address)).to.equal(DOGE(20));
      expect(await arena.treasury()).to.equal(DOGE(20));
      await expect(arena.connect(carol).collectBet(M, B)).to.be.revertedWith('nothing to collect');
    });
    it('backers never lose money when they win: floor = their stake back', async () => {
      await place(alice, A); await place(bob, A); await place(carol, A); await place(dave, A); await place(eve, B);
      await arena.connect(oracle).resolveMarket(M, A, frank.address, CAP);
      // pool 100, backers' stakes 80 > 60% => they get 80 back (20 each), the rest 20 is split 10/10
      await expect(arena.connect(alice).collectBet(M, A)).to.changeEtherBalance(alice, DOGE(20));
      expect(await arena.claimable(frank.address)).to.equal(DOGE(10));
      expect(await arena.treasury()).to.equal(DOGE(10));
    });
    it('refunds everybody when all bets are on the winner, when nobody backed him, or when there are too few bets', async () => {
      await place(alice, A); await place(bob, A); await place(carol, A);
      await arena.connect(oracle).resolveMarket(M, A, frank.address, CAP); // everybody on the winner
      expect((await arena.markets(M)).status).to.equal(4);
      await expect(arena.connect(alice).collectBet(M, A)).to.changeEtherBalance(alice, stake20);

      const M2 = id('market-2');
      await arena.connect(oracle).openMarket(M2);
      await place(alice, A, M2); await place(bob, B, M2); await place(carol, B, M2);
      await arena.connect(oracle).resolveMarket(M2, C, frank.address, CAP); // nobody backed C
      expect((await arena.markets(M2)).status).to.equal(4);
      await expect(arena.connect(bob).collectBet(M2, B)).to.changeEtherBalance(bob, stake20);

      const M3 = id('market-3');
      await arena.connect(oracle).openMarket(M3);
      await place(alice, A, M3); await place(bob, B, M3); // only 2 bets (< minBets 3)
      await arena.connect(oracle).resolveMarket(M3, A, frank.address, CAP);
      expect((await arena.markets(M3)).status).to.equal(4);
      await expect(arena.connect(alice).collectBet(M3, A)).to.changeEtherBalance(alice, stake20);
    });
    it('caps the winning player bonus; the rest of the pool goes to the backers', async () => {
      await place(alice, A); await place(bob, A); await place(carol, B); await place(dave, B); await place(eve, B);
      await arena.connect(oracle).resolveMarket(M, A, frank.address, DOGE(10)); // pool 100: game 20, bonus capped at 10, backers get 70
      expect(await arena.claimable(frank.address)).to.equal(DOGE(10));
      expect(await arena.treasury()).to.equal(DOGE(20));
      await expect(arena.connect(alice).collectBet(M, A)).to.changeEtherBalance(alice, DOGE(35));
      await expect(arena.connect(bob).collectBet(M, A)).to.changeEtherBalance(bob, DOGE(35));
    });
    it('gives the winning player share to the game when he has no wallet', async () => {
      await place(alice, A); await place(bob, B); await place(carol, B); await place(dave, B);
      await arena.connect(oracle).resolveMarket(M, A, ethers.ZeroAddress, CAP);
      expect(await arena.treasury()).to.equal(DOGE(32)); // 80 pool: 60% = 48 to the single backer, rest 32 -> game
      await expect(arena.connect(alice).collectBet(M, A)).to.changeEtherBalance(alice, DOGE(48));
    });
    it('claimAll pays prizes, bonus and bet winnings in one transaction', async () => {
      await place(alice, A); await place(bob, A); await place(carol, B); await place(dave, B); await place(eve, B);
      await arena.connect(oracle).resolveMarket(M, A, frank.address, CAP);
      expect(await arena.pendingBetPayout(M, alice.address, A)).to.equal(DOGE(30));
      expect(await arena.pendingBetPayout(M, carol.address, B)).to.equal(0);
      await expect(arena.connect(alice).claimAll([M], [A])).to.changeEtherBalance(alice, DOGE(30));
      await expect(arena.connect(alice).claimAll([M], [A])).to.be.revertedWith('nothing to claim'); // already collected
      await expect(arena.connect(frank).claimAll([], [])).to.changeEtherBalance(frank, DOGE(20));
    });
    it('one bet per wallet, fixed stake, valid voucher, open market only', async () => {
      await place(alice, A);
      await expect(place(alice, B)).to.be.revertedWith('already bet');
      const odd = await betVoucher(bob, M, A, DOGE(10), { nonce: nonce++ });
      await expect(arena.connect(bob).placeBet(odd.marketId, odd.outcome, odd.amount, odd.nonce, odd.deadline, odd.sig, { value: DOGE(10) })).to.be.revertedWith('wrong amount');
      const forged = await betVoucher(bob, M, A, stake20, { nonce: nonce++, signer: carol });
      await expect(bet(bob, forged)).to.be.revertedWith('bad voucher');
      const replay = await betVoucher(carol, M, A, stake20, { nonce: nonce++ });
      await bet(carol, replay);
      await expect(bet(dave, replay)).to.be.revertedWith('voucher used'); // a voucher works once
      await arena.connect(oracle).closeMarket(M);
      await expect(place(dave, A)).to.be.revertedWith('market not open');
      await expect(arena.connect(alice).collectBet(M, A)).to.be.revertedWith('nothing to collect'); // not settled
    });
    it('cancelMarket refunds open bets; only the oracle manages markets; only the owner changes the rules', async () => {
      await place(bob, B);
      await arena.connect(oracle).cancelMarket(M);
      await expect(arena.connect(bob).collectBet(M, B)).to.changeEtherBalance(bob, stake20);
      await expect(arena.connect(alice).openMarket(id('x'))).to.be.revertedWith('not oracle');
      await expect(arena.connect(oracle).openMarket(M)).to.be.revertedWith('market exists');
      await expect(arena.connect(alice).setBetRules(DOGE(50), 3, 2000, 2000)).to.be.revertedWith('not owner');
      await arena.connect(owner).setBetRules(DOGE(50), 3, 2000, 2000);
      expect(await arena.betStake()).to.equal(DOGE(50));
    });
  });

  it('owner can rotate the oracle; old oracle vouchers stop working', async () => {
    await arena.connect(owner).setOracle(bob.address);
    const v = await ticketVoucher(alice); // signed by old oracle
    await expect(buy(alice, v)).to.be.revertedWith('bad voucher');
    await expect(arena.connect(alice).setOracle(alice.address)).to.be.revertedWith('not owner');
  });
});
