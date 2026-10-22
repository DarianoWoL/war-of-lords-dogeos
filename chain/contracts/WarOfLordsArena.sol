// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * War of Lords Arena - DogeOS testnet edition.
 *
 * One contract for the three money flows of the game (testnet DOGE only, no real value):
 *   1. Tournament tickets  - players pay the entry fee straight from their wallet.
 *   2. Prizes              - the game server credits winners, winners pull ("claim") their prize.
 *   3. Spectator betting   - fixed-stake pool betting on "who wins this tournament round" (60/20/20 split, winners never lose).
 *
 * Trust model (testnet demo): a single `oracle` (the game server key) signs vouchers (EIP-712) so the
 * server can enforce game rules before money moves (one ticket per month, tournament open, a player
 * can not bet on a round he plays in) and it reports results. It can never take player funds:
 * prizes/bets only move according to the rules below.
 */
contract WarOfLordsArena {
    // ------------------------------------------------------------------ config / access
    address public owner;
    address public oracle;
    uint16 public ticketFeeBps = 1000; // 10% of every ticket goes to the season treasury
    uint16 public betFeeBps = 500; // 5% of every betting pool goes to the season treasury
    uint16 public constant MAX_FEE_BPS = 2000;

    uint256 public prizePool; // DOGE reserved for tournament prizes
    uint256 public treasury; // fees collected this season, rolled into the prize pool by rollSeason()
    uint256 public season = 1;

    uint256 private _lock = 1;

    event OracleChanged(address indexed oracle);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyOracle() {
        require(msg.sender == oracle, "not oracle");
        _;
    }
    modifier nonReentrant() {
        require(_lock == 1, "reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address _oracle) {
        require(_oracle != address(0), "oracle=0");
        owner = msg.sender;
        oracle = _oracle;
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "oracle=0");
        oracle = _oracle;
        emit OracleChanged(_oracle);
    }

    function setFees(uint16 _ticketFeeBps, uint16 _betFeeBps) external onlyOwner {
        require(_ticketFeeBps <= MAX_FEE_BPS && _betFeeBps <= MAX_FEE_BPS, "fee too high");
        ticketFeeBps = _ticketFeeBps;
        betFeeBps = _betFeeBps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        owner = newOwner;
    }

    // ------------------------------------------------------------------ EIP-712
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TICKET_TYPEHASH =
        keccak256("Ticket(address buyer,uint8 kind,uint256 price,uint256 nonce,uint256 deadline)");
    bytes32 private constant BET_TYPEHASH =
        keccak256("Bet(address bettor,bytes32 marketId,bytes32 outcome,uint256 amount,uint256 nonce,uint256 deadline)");

    mapping(uint256 => bool) public usedNonce; // each voucher works exactly once

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("WarOfLordsArena"), keccak256("1"), block.chainid, address(this))
        );
    }

    function _recover(bytes32 structHash, bytes calldata sig) private view returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad sig s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad sig");
        return signer;
    }

    // ------------------------------------------------------------------ 1. tickets
    /// kind: 1 = Monthly Tournament ticket, 2 = Mini-Tournament ticket
    event TicketPurchased(address indexed buyer, uint8 indexed kind, uint256 price, uint256 indexed nonce);

    mapping(address => uint256) public ticketsBought;

    function buyTicket(uint8 kind, uint256 price, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
        payable
        nonReentrant
    {
        require(msg.value == price && price > 0, "wrong amount");
        require(block.timestamp <= deadline, "voucher expired");
        require(!usedNonce[nonce], "voucher used");
        bytes32 structHash = keccak256(abi.encode(TICKET_TYPEHASH, msg.sender, kind, price, nonce, deadline));
        require(_recover(structHash, sig) == oracle, "bad voucher");
        usedNonce[nonce] = true;

        uint256 fee = (price * ticketFeeBps) / 10000;
        treasury += fee;
        prizePool += price - fee;
        ticketsBought[msg.sender] += 1;
        emit TicketPurchased(msg.sender, kind, price, nonce);
    }

    // ------------------------------------------------------------------ 2. prizes
    event PrizeCredited(bytes32 indexed ref, address indexed winner, uint256 amount);
    event PrizeClaimed(address indexed winner, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount);
    event SeasonRolled(uint256 indexed season, uint256 movedToPool);

    mapping(address => uint256) public claimable;
    mapping(address => uint256) public totalWon;
    mapping(address => uint256) public winCount;
    mapping(bytes32 => bool) public prizeRefPaid; // one payout batch per tournament/round reference

    /// Anyone can top up the prize pool (the owner uses this to seed a testnet pool).
    function fund() external payable {
        require(msg.value > 0, "no value");
        prizePool += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    receive() external payable {
        prizePool += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    /// Credits prizes of one finished tournament/round. First winner in the list is counted as the
    /// round winner for the on-chain stats. `ref` makes the call idempotent (a retry reverts).
    function creditPrizes(bytes32 ref, address[] calldata winners, uint256[] calldata amounts) external onlyOracle {
        require(!prizeRefPaid[ref], "already paid");
        require(winners.length == amounts.length && winners.length > 0, "bad input");
        prizeRefPaid[ref] = true;
        uint256 sum;
        for (uint256 i = 0; i < winners.length; i++) {
            require(winners[i] != address(0), "winner=0");
            sum += amounts[i];
            claimable[winners[i]] += amounts[i];
            totalWon[winners[i]] += amounts[i];
            emit PrizeCredited(ref, winners[i], amounts[i]);
        }
        winCount[winners[0]] += 1;
        require(sum <= prizePool, "pool too small");
        prizePool -= sum;
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "nothing to claim");
        claimable[msg.sender] = 0;
        _send(msg.sender, amount);
        emit PrizeClaimed(msg.sender, amount);
    }

    /// Moves the season's fee treasury into the prize pool and starts the next season.
    function rollSeason() external onlyOracle {
        uint256 moved = treasury;
        treasury = 0;
        prizePool += moved;
        emit SeasonRolled(season, moved);
        season += 1;
    }

    // ------------------------------------------------------------------ 3. betting
    // Spectators bet a fixed stake on "who wins this round". Rules of the settlement (see resolveMarket):
    //   - the game keeps houseBps (20%) of the pool and the player who won the round gets a bonus of bonusBps (20%) capped by `bonusCap`
    //     (the server sets it to half of the first prize), the REST goes to the backers of the winner, who NEVER get less than their stake back,
    //   - too few bets, a winner nobody backed, or everybody backing the winner => full refund for all.
    enum MarketStatus {
        None,
        Open,
        Closed,
        Resolved,
        Cancelled
    }

    struct Market {
        MarketStatus status;
        bytes32 winner;
        uint256 total; // all stakes
        uint256 payoutPool; // what the backers of the winner share, fixed at resolution
    }

    event MarketOpened(bytes32 indexed marketId);
    event MarketClosed(bytes32 indexed marketId);
    event MarketResolved(bytes32 indexed marketId, bytes32 winner, uint256 total, uint256 payoutPool, uint256 winnerBonus, uint256 houseCut);
    event MarketCancelled(bytes32 indexed marketId);
    event BetPlaced(bytes32 indexed marketId, address indexed bettor, bytes32 outcome, uint256 amount, uint256 nonce);
    event BetPaid(bytes32 indexed marketId, address indexed bettor, uint256 amount);
    event BetRulesChanged(uint256 stake, uint256 minBets, uint16 houseBps, uint16 bonusBps);

    uint256 public betStake = 20 ether; // fixed stake per bet
    uint256 public minBets = 3; // fewer bets in a market => refund
    uint16 public houseBps = 2000; // share of the pool kept by the game
    uint16 public bonusBps = 2000; // share of the pool for the player who won the round (before the cap)

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => uint256) public betCount; // market => number of bets
    mapping(bytes32 => mapping(address => bool)) public hasBet; // one bet per wallet per market
    mapping(bytes32 => mapping(bytes32 => uint256)) public outcomeTotal; // market => outcome => stakes
    mapping(bytes32 => mapping(address => mapping(bytes32 => uint256))) public stake; // market => bettor => outcome => stake

    function setBetRules(uint256 _stake, uint256 _minBets, uint16 _houseBps, uint16 _bonusBps) external onlyOwner {
        require(_stake > 0 && _minBets >= 2 && uint256(_houseBps) + _bonusBps <= 5000, "bad rules");
        betStake = _stake;
        minBets = _minBets;
        houseBps = _houseBps;
        bonusBps = _bonusBps;
        emit BetRulesChanged(_stake, _minBets, _houseBps, _bonusBps);
    }

    function openMarket(bytes32 marketId) external onlyOracle {
        require(markets[marketId].status == MarketStatus.None, "market exists");
        markets[marketId].status = MarketStatus.Open;
        emit MarketOpened(marketId);
    }

    function closeMarket(bytes32 marketId) external onlyOracle {
        require(markets[marketId].status == MarketStatus.Open, "not open");
        markets[marketId].status = MarketStatus.Closed;
        emit MarketClosed(marketId);
    }

    function placeBet(bytes32 marketId, bytes32 outcome, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
        payable
        nonReentrant
    {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.Open, "market not open");
        require(amount == betStake && msg.value == betStake, "wrong amount");
        require(!hasBet[marketId][msg.sender], "already bet");
        require(block.timestamp <= deadline, "voucher expired");
        require(!usedNonce[nonce], "voucher used");
        bytes32 structHash = keccak256(abi.encode(BET_TYPEHASH, msg.sender, marketId, outcome, amount, nonce, deadline));
        require(_recover(structHash, sig) == oracle, "bad voucher");
        usedNonce[nonce] = true;
        hasBet[marketId][msg.sender] = true;

        m.total += amount;
        betCount[marketId] += 1;
        outcomeTotal[marketId][outcome] += amount;
        stake[marketId][msg.sender][outcome] += amount;
        emit BetPlaced(marketId, msg.sender, outcome, amount, nonce);
    }

    /// Settles a market. `winnerPlayer` is the wallet of the player who won the round (address(0) if he has none),
    /// `bonusCap` the maximum bonus he can get (the server uses half of the first prize of that tournament).
    function resolveMarket(bytes32 marketId, bytes32 winnerOutcome, address winnerPlayer, uint256 bonusCap) external onlyOracle {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.Closed || m.status == MarketStatus.Open, "bad status");
        uint256 total = m.total;
        uint256 winnersStake = outcomeTotal[marketId][winnerOutcome];
        if (betCount[marketId] < minBets || winnersStake == 0 || winnersStake == total) {
            m.status = MarketStatus.Cancelled; // everybody gets the stake back
            emit MarketCancelled(marketId);
            return;
        }
        uint256 house = (total * houseBps) / 10000;
        uint256 bonus = (total * bonusBps) / 10000;
        if (bonus > bonusCap) bonus = bonusCap;
        uint256 sharePool = total - house - bonus; // the rest goes to the backers of the winner
        if (sharePool < winnersStake) {
            // backers never lose money when they win: they get their stakes back first, the leftover is split house : bonus
            sharePool = winnersStake;
            uint256 leftover = total - winnersStake;
            uint256 weights = uint256(houseBps) + bonusBps;
            bonus = weights == 0 ? 0 : (leftover * bonusBps) / weights;
            if (bonus > bonusCap) bonus = bonusCap;
            house = leftover - bonus;
        }
        if (winnerPlayer == address(0)) {
            house += bonus;
            bonus = 0;
        }
        if (bonus > 0) {
            claimable[winnerPlayer] += bonus;
            totalWon[winnerPlayer] += bonus;
            emit PrizeCredited(marketId, winnerPlayer, bonus);
        }
        treasury += house;
        m.payoutPool = sharePool;
        m.winner = winnerOutcome;
        m.status = MarketStatus.Resolved;
        emit MarketResolved(marketId, winnerOutcome, total, sharePool, bonus, house);
    }

    function cancelMarket(bytes32 marketId) external onlyOracle {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.Open || m.status == MarketStatus.Closed, "bad status");
        m.status = MarketStatus.Cancelled;
        emit MarketCancelled(marketId);
    }

    /// What `bettor` would receive for his bet on `outcome` (0 when the market is not settled or the bet lost).
    function pendingBetPayout(bytes32 marketId, address bettor, bytes32 outcome) public view returns (uint256) {
        uint256 s = stake[marketId][bettor][outcome];
        if (s == 0) return 0;
        Market storage m = markets[marketId];
        if (m.status == MarketStatus.Resolved) {
            return outcome == m.winner ? (s * m.payoutPool) / outcomeTotal[marketId][outcome] : 0;
        }
        if (m.status == MarketStatus.Cancelled) return s;
        return 0;
    }

    function _settleBet(bytes32 marketId, address bettor, bytes32 outcome) private returns (uint256 payout) {
        payout = pendingBetPayout(marketId, bettor, outcome);
        if (payout > 0) {
            stake[marketId][bettor][outcome] = 0;
            emit BetPaid(marketId, bettor, payout);
        }
    }

    /// Winners collect their share; on a cancelled market everyone gets his stake back.
    function collectBet(bytes32 marketId, bytes32 outcome) external nonReentrant {
        require(stake[marketId][msg.sender][outcome] > 0, "no stake");
        uint256 payout = _settleBet(marketId, msg.sender, outcome);
        require(payout > 0, "nothing to collect");
        _send(msg.sender, payout);
    }

    /// One transaction for everything the player is owed: prizes + bonus + winnings/refunds of the listed bets.
    function claimAll(bytes32[] calldata marketIds, bytes32[] calldata outcomes) external nonReentrant {
        require(marketIds.length == outcomes.length, "bad input");
        uint256 total = claimable[msg.sender];
        claimable[msg.sender] = 0;
        for (uint256 i = 0; i < marketIds.length; i++) {
            total += _settleBet(marketIds[i], msg.sender, outcomes[i]);
        }
        require(total > 0, "nothing to claim");
        _send(msg.sender, total);
        emit PrizeClaimed(msg.sender, total);
    }

    // ------------------------------------------------------------------ helpers
    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
