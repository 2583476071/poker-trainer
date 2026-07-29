/* ================================================================
 * server/poker_game.js — 服务端权威 PokerGame（多人类玩家支持）
 *
 * 基于原 game.js 的 PokerGame，关键改动：
 *   ① 构造函数接受 seats 配置（不再硬编码 seat 0 = 人类）
 *   ② getState(playerId) 按人过滤手牌（摊牌前隐藏其他人类手牌）
 *   ③ notifyState() 向所有人类广播个性化状态
 *   ④ autoAdvance() 人类回合发出 your_turn 事件后停止，等待网络回调
 *   ⑤ 移除所有 localStorage 存档逻辑
 *   ⑥ AI 决策逻辑完整保留
 * ================================================================ */

// 加载 shared 纯函数模块
Object.assign(globalThis, require('../shared/constants.js'));
Object.assign(globalThis, require('../shared/deck.js'));
Object.assign(globalThis, require('../shared/hand_evaluator.js'));
Object.assign(globalThis, require('../shared/pot_calculator.js'));
Object.assign(globalThis, require('../shared/gto_ranges.js'));
Object.assign(globalThis, require('../shared/player_factory.js'));
Object.assign(globalThis, require('../shared/board_analyzer.js'));


// ==================== 游戏状态机 ====================

class PokerGame {
    /**
     * @param {Object} config
     * @param {Array}  config.seats — [{ seatIndex, playerId, name, isHuman, aiProfile }]
     * @param {Number} config.smallBlind
     * @param {Number} config.bigBlind
     * @param {Number} config.startingChips
     * @param {String} config.gameMode — 'training' | 'competitive'
     * @param {Number} config.turnTimeout — 人类回合超时秒数
     * @param {Function} onBroadcast — 广播回调 (playerId, personalizedState) => void
     */
    constructor(config) {
        // 座位配置
        this.seatConfig = config.seats || [];
        this.players = [];
        this.playerIdMap = new Map();   // playerId → playerIndex

        // 游戏状态
        this.communityCards = [];
        this.deck = [];
        this.phase = 'idle';
        this.dealerIndex = -1;
        this.currentPlayerIndex = -1;
        this.blindLevel = 0;
        this.bigBlindAmount = config.bigBlind || BLIND_LEVELS[0].big;
        this.smallBlindAmount = config.smallBlind || BLIND_LEVELS[0].small;
        this.currentBetLevel = 0;
        this.minRaise = config.bigBlind || BLIND_LEVELS[0].big;
        this.preflopRaiserIndex = -1;
        this.raiseCountThisRound = 0;
        this.currentRoundRaiserId = -1;
        this.handNumber = 0;
        this.handsAtCurrentBlind = 0;
        this.blindLevelStartTime = Date.now();
        this.blindIncreased = false;
        this.message = '';
        this.lastAction = null;
        this.winners = [];
        this.eliminatedPlayers = [];
        this._rebuysLeft = 5;              // 全局补码次数，所有人共享
        this.startingChips = config.startingChips || 20000;
        this.gameMode = config.gameMode || 'training';
        this.turnTimeout = (config.turnTimeout || 60) * 1000;
        this.opponentStats = new Map();

        // 广播回调：由 game_manager 设置
        this.onBroadcast = null;        // (playerId, state) => void
        this.onGameOver = null;         // (results) => void

        // 人类回合等待机制
        this._pendingHumanResolve = null;
        this._turnTimer = null;
        this._handOverTimer = null;

        // 初始化玩家和游戏
        this._initFromConfig();
    }

    // ==================== 初始化 ====================

    _initFromConfig() {
        this.players = [];
        this.playerIdMap.clear();
        this.handNumber = 0;
        this.eliminatedPlayers = [];

        // 按 seatIndex 排序创建玩家（仅创建有人的座位，空位不创建）
        const sorted = [...this.seatConfig].sort((a, b) => a.seatIndex - b.seatIndex);
        for (const s of sorted) {
            const player = createPlayer(s.playerId, s.name, s.isHuman, s.aiProfile || null);
            player.seatIndex = s.seatIndex;               // 视觉座位号 0-8
            const arrayIndex = this.players.length;       // 实际数组索引
            this.players.push(player);
            this.playerIdMap.set(s.playerId, arrayIndex); // 存数组索引，非座位号
        }

        // 随机庄位
        this.dealerIndex = Math.floor(Math.random() * this.players.length);
        this.startNewHand();
    }

    /** 通过 playerId 查找玩家索引 */
    _playerIndex(playerId) {
        return this.playerIdMap.get(playerId);
    }

    // ==================== 手牌管理 ====================

    startNewHand() {
        this.handNumber++;
        this.handsAtCurrentBlind++;

        // 检查淘汰
        const broke = this.players.filter(p => p.chips <= 0 && !this.eliminatedPlayers.includes(p.id));
        const hadEliminated = this.eliminatedPlayers.length;
        for (const p of broke) {
            this.eliminatedPlayers.push(p.id);
            p.chips = 0;
        }

        const willForceAdvance = hadEliminated >= 2 && broke.length > 0;
        this.updateBlinds(willForceAdvance);

        // 重置状态
        this.communityCards = [];
        this.phase = 'preflop';
        this.currentBetLevel = this.bigBlindAmount;
        this.minRaise = this.bigBlindAmount;
        this.preflopRaiserIndex = -1;
        this.raiseCountThisRound = 0;
        this.currentRoundRaiserId = -1;
        this.winners = [];
        this.message = '';
        this.lastAction = null;
        this._wasShowdown = false;
        this._pendingHumanResolve = null;
        if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
        if (this._handOverTimer) { clearTimeout(this._handOverTimer); this._handOverTimer = null; }

        for (const p of this.players) {
            p.handCards = [];
            p.currentBet = 0;
            p.totalBetThisHand = 0;
            p.isFolded = false;
            p.isAllIn = false;
            p.isDealer = false;
            p.isSmallBlind = false;
            p.isBigBlind = false;
            p.needsToAct = false;
            p.hasActedThisRound = false;
        }

        // 庄位轮转
        this.dealerIndex = this.nextActivePlayerIndex(this.dealerIndex);
        const sbIndex = this.nextActivePlayerIndex(this.dealerIndex);
        const bbIndex = this.nextActivePlayerIndex(sbIndex);

        if (this.countActivePlayers() < 2) {
            // 检查被淘汰的人类玩家是否还有补码机会
            const canRebuy = this._rebuysLeft > 0 && this.players.some(p =>
                p.isHuman && this.eliminatedPlayers.includes(p.id)
            );
            if (!canRebuy) {
                this.phase = 'game_over';
                this.message = '游戏结束！';
                this.notifyState();
                if (this.onGameOver) this.onGameOver(this._getResults());
                return;
            }
        }

        this.players[this.dealerIndex].isDealer = true;
        this.players[sbIndex].isSmallBlind = true;
        this.players[bbIndex].isBigBlind = true;

        // 洗牌发牌
        this.deck = createDeck();
        for (const p of this.players) {
            if (!this.isActive(p)) continue;
            p.handCards = draw(this.deck, 2);
        }
        this.validateNoDuplicates();

        // 扣盲注
        this.postBlind(sbIndex, this.smallBlindAmount);
        this.postBlind(bbIndex, this.bigBlindAmount);

        const firstToAct = this.nextActivePlayerIndex(bbIndex);
        this.currentPlayerIndex = firstToAct;
        this.currentBetLevel = this.bigBlindAmount;

        for (const p of this.players) {
            if (this.isActive(p)) {
                p.needsToAct = true;
                p.hasActedThisRound = false;
            }
        }

        if (this.blindIncreased) {
            this.message = `⚠️ 盲注升级！${this.smallBlindAmount}/${this.bigBlindAmount}`;
            this.blindIncreased = false;
        } else {
            this.message = '新一局开始！';
        }
        this.notifyState();
        this.autoAdvance();
    }

    postBlind(playerIndex, amount) {
        const p = this.players[playerIndex];
        const actual = Math.min(amount, p.chips);
        p.chips -= actual;
        p.currentBet = actual;
        p.totalBetThisHand = actual;
        if (p.chips === 0) p.isAllIn = true;
    }

    nextActivePlayerIndex(fromIndex) {
        const len = this.players.length;
        for (let i = 1; i <= len; i++) {
            const idx = (fromIndex + i) % len;
            if (!this.eliminatedPlayers.includes(this.players[idx].id)) {
                return idx;
            }
        }
        return fromIndex;
    }

    nextPlayerToAct(fromIndex) {
        const len = this.players.length;
        for (let i = 1; i <= len; i++) {
            const idx = (fromIndex + i) % len;
            const p = this.players[idx];
            if (!this.isActive(p)) continue;
            if (p.needsToAct) return idx;
        }
        return -1;
    }

    validateNoDuplicates() {
        const allCards = [...this.communityCards];
        for (const p of this.players) {
            if (p.handCards && p.handCards.length) allCards.push(...p.handCards);
        }
        const seen = new Set();
        for (const c of allCards) {
            const key = c.rank + c.suit;
            if (seen.has(key)) {
                console.error('⚠️ 重复牌检测:', key);
                return false;
            }
            seen.add(key);
        }
        return true;
    }

    isActive(p) {
        return !p.isFolded && !this.eliminatedPlayers.includes(p.id);
    }

    canAct(p) {
        return this.isActive(p) && !p.isAllIn;
    }

    countActivePlayers() {
        return this.players.filter(p => this.isActive(p)).length;
    }

    countCanActPlayers() {
        return this.players.filter(p => this.canAct(p)).length;
    }

    // ==================== 玩家行动 ====================

    doAction(playerIndex, action, raiseMultiplier) {
        if (playerIndex !== this.currentPlayerIndex) return false;
        const p = this.players[playerIndex];

        this._trackOpponentAction(p, action);

        switch (action) {
            case 'fold': this.doFold(p); break;
            case 'check': this.doCheck(p); break;
            case 'call': this.doCall(p); break;
            case 'raise': this.doRaise(p, raiseMultiplier); break;
            case 'allin': this.doAllIn(p); break;
            default: return false;
        }

        p.needsToAct = false;
        p.hasActedThisRound = true;

        if (this.isBettingRoundOver()) {
            this.advancePhase();
        } else {
            this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
            this.notifyState();
            this.autoAdvance();
        }

        return true;
    }

    doFold(p) {
        p.isFolded = true;
        this.message = `${p.name} 弃牌`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'fold', amount: 0 };
    }

    doCheck(p) {
        this.message = `${p.name} 过牌`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'check', amount: 0 };
    }

    doCall(p) {
        const raw = Math.min(this.currentBetLevel - p.currentBet, p.chips);
        const callAmount = Math.floor(raw);
        p.chips -= callAmount;
        p.currentBet += callAmount;
        p.totalBetThisHand += callAmount;
        if (p.chips <= 0) p.isAllIn = true;
        this.message = `${p.name} 跟注 ${callAmount}`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'call', amount: callAmount };
    }

    doRaise(p, amount) {
        // amount: 人类传绝对加注到金额, AI 传 BB 倍数
        const pot = totalPot(this.players);
        let raiseTo;
        if (amount > 100) {
            // 人类：绝对金额
            raiseTo = Math.round(amount / 100) * 100;
            raiseTo = Math.max(raiseTo, this.currentBetLevel + this.minRaise);
        } else {
            // AI：BB 倍数
            const n = Math.max(1, Math.min(5, Math.round(amount || 1)));
            raiseTo = this.currentBetLevel + n * this.bigBlindAmount;
        }
        raiseTo = Math.min(raiseTo, this.currentBetLevel + p.chips + p.currentBet);
        raiseTo = Math.round(raiseTo / 100) * 100;
        const needed = raiseTo - p.currentBet;
        const additional = Math.floor(Math.min(needed, p.chips));
        p.chips -= additional;
        p.currentBet += additional;
        p.totalBetThisHand += additional;
        this.currentBetLevel = p.currentBet;
        this.minRaise = Math.max(this.minRaise, additional);
        if (this.phase === 'preflop') this.preflopRaiserIndex = p.id;
        if (p.chips <= 0) p.isAllIn = true;
        this.raiseCountThisRound++;

        for (const other of this.players) {
            if (other.id !== p.id && this.isActive(other) && !other.isAllIn) {
                other.needsToAct = true;
                other.hasActedThisRound = false;
            }
        }

        this.message = `${p.name} 加注到 ${p.currentBet}`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'raise', amount: p.currentBet };
        if (this.currentRoundRaiserId === -1) this.currentRoundRaiserId = p.id;
    }

    doAllIn(p) {
        const amount = p.chips;
        p.currentBet += amount;
        p.totalBetThisHand += amount;
        p.chips = 0;
        p.isAllIn = true;
        if (p.currentBet > this.currentBetLevel) {
            this.currentBetLevel = p.currentBet;
            if (this.phase === 'preflop') this.preflopRaiserIndex = p.id;
            for (const other of this.players) {
                if (other.id !== p.id && this.isActive(other) && !other.isAllIn) {
                    other.needsToAct = true;
                    other.hasActedThisRound = false;
                }
            }
        }
        this.message = `${p.name} All-in! (${amount})`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'allin', amount };
        if (this.currentRoundRaiserId === -1) this.currentRoundRaiserId = p.id;
    }

    isBettingRoundOver() {
        if (this.countActivePlayers() === 1) return true;
        const canActPlayers = this.players.filter(p => this.canAct(p) && this.isActive(p));
        if (canActPlayers.length === 0) return true;
        const needAction = this.players.filter(p => this.isActive(p) && p.needsToAct);
        if (needAction.length === 0) return true;
        return false;
    }

    // ==================== 阶段推进 ====================

    advancePhase() {
        for (const p of this.players) {
            p.currentBet = 0;
            p.needsToAct = true;
            p.hasActedThisRound = false;
        }
        this.currentBetLevel = 0;
        this.minRaise = this.bigBlindAmount;
        this.raiseCountThisRound = 0;
        this.currentRoundRaiserId = -1;

        if (this.countActivePlayers() === 1) {
            const winner = this.players.find(p => this.isActive(p));
            const cardsNeeded = 5 - this.communityCards.length;
            if (cardsNeeded > 0 && this.deck.length >= cardsNeeded) {
                this.communityCards.push(...draw(this.deck, cardsNeeded));
            }
            this.phase = 'hand_over';
            const pot = totalPot(this.players);
            winner.chips += pot;
            this.winners = [{ player: winner, hand: null, pot }];
            this.message = `${winner.name} 获胜！所有人弃牌，赢得 ${pot} 积分`;
            this.notifyState();
            return;
        }

        switch (this.phase) {
            case 'preflop':
                this.phase = 'flop';
                this.communityCards.push(...draw(this.deck, 3));
                break;
            case 'flop':
                this.phase = 'turn';
                this.communityCards.push(...draw(this.deck, 1));
                break;
            case 'turn':
                this.phase = 'river';
                this.communityCards.push(...draw(this.deck, 1));
                break;
            case 'river':
                this.phase = 'showdown';
                this.doShowdown();
                return;
        }

        const firstToAct = this.nextActivePlayerIndex(this.dealerIndex);

        if (this.countCanActPlayers() === 0) {
            while (this.phase !== 'showdown' && this.phase !== 'hand_over') {
                const cardsNeeded = this.phase === 'preflop' ? 3 : (this.phase === 'flop' || this.phase === 'turn' ? 1 : 0);
                if (cardsNeeded > 0) {
                    this.communityCards.push(...draw(this.deck, cardsNeeded));
                }
                const nextPhase = { preflop:'flop', flop:'turn', turn:'river', river:'showdown' };
                this.phase = nextPhase[this.phase];
                if (this.phase === 'showdown') { this.doShowdown(); return; }
            }
        }

        this.currentPlayerIndex = firstToAct;
        this.notifyState();
        this.autoAdvance();
    }

    doShowdown() {
        this.phase = 'showdown';
        this._wasShowdown = true;
        const activePlayers = this.players.filter(p => this.isActive(p));
        const pots = calculatePots(this.players);

        if (activePlayers.length === 1) {
            const total = totalPot(this.players);
            activePlayers[0].chips += total;
            this.winners = [{ player: activePlayers[0], hand: null, pot: total }];
            this.phase = 'hand_over';
            this.message = `${activePlayers[0].name} 获胜！赢得 ${total} 积分`;
            this.notifyState();
            return;
        }

        const evaluations = {};
        for (const p of activePlayers) {
            if (p.handCards.length === 2) {
                const all7 = [...p.handCards, ...this.communityCards];
                if (all7.length >= 5) evaluations[p.id] = evaluateHand(all7);
            }
        }

        const totalWon = {};
        for (const pot of pots) {
            const eligible = pot.eligiblePlayerIds
                .map(id => this.players.find(p => p.id === id))
                .filter(p => p && this.isActive(p) && evaluations[p.id]);

            if (eligible.length === 0) continue;
            if (eligible.length === 1) {
                eligible[0].chips += pot.amount;
                totalWon[eligible[0].id] = (totalWon[eligible[0].id] || 0) + pot.amount;
                continue;
            }

            let bestPlayers = [eligible[0]];
            let bestScore = evaluations[eligible[0].id].score;
            for (let i = 1; i < eligible.length; i++) {
                const score = evaluations[eligible[i].id].score;
                const cmp = compareScores(score, bestScore);
                if (cmp > 0) { bestPlayers = [eligible[i]]; bestScore = score; }
                else if (cmp === 0) { bestPlayers.push(eligible[i]); }
            }

            const share = Math.floor(pot.amount / bestPlayers.length);
            const remainder = pot.amount - share * bestPlayers.length;
            for (let i = 0; i < bestPlayers.length; i++) {
                const win = share + (i === 0 ? remainder : 0);
                bestPlayers[i].chips += win;
                totalWon[bestPlayers[i].id] = (totalWon[bestPlayers[i].id] || 0) + win;
            }
        }

        this.winners = [];
        for (const [id, amount] of Object.entries(totalWon)) {
            const player = this.players.find(p => p.id === parseInt(id));
            this.winners.push({ player, hand: evaluations[player.id] || null, pot: amount });
        }
        for (const p of activePlayers) {
            if (!totalWon[p.id]) {
                this.winners.push({ player: p, hand: evaluations[p.id] || null, pot: 0 });
            }
        }

        this.phase = 'hand_over';
        const winSummary = this.winners
            .filter(w => w.pot > 0)
            .map(w => `${w.player.name} (+${w.pot}) ${w.hand ? w.hand.name : ''}`)
            .join(' / ');
        this.message = winSummary || '摊牌完成';
        this.notifyState();
    }

    // ==================== AI 辅助 ====================

    getPositionContext(player) {
        let positionInOrder = -1, totalActive = 0;
        const len = this.players.length;
        for (let i = 1; i <= len; i++) {
            const idx = (this.dealerIndex + i) % len;
            const p = this.players[idx];
            if (!this.isActive(p)) continue;
            totalActive++;
            if (p.id === player.id) positionInOrder = totalActive;
        }
        if (totalActive <= 2) return 'BTN';
        const ratio = positionInOrder / totalActive;
        if (ratio >= 0.85) return 'BTN';
        if (ratio >= 0.70) return 'CO';
        if (ratio >= 0.50) return 'HJ';
        if (ratio >= 0.30) return 'MP';
        return 'UTG';
    }

    analyzeBoard() { return analyzeBoard(this.communityCards); }
    getBoardStrategy(bt) { return getBoardStrategy(bt); }
    calculateMDF() { return calculateMDF(this.players, this.currentBetLevel); }
    getBetPotRatio() { return getBetPotRatio(this.players, this.currentBetLevel); }
    getRangeAdvantage(p) { return getRangeAdvantage(p.id, this.communityCards, this.preflopRaiserIndex); }
    pickGTOMultiplier(prof, board, sit) { return pickGTOMultiplier(prof, board, sit); }
    evaluateDrawPotential(p) { return evaluateDrawPotential(p.handCards, this.communityCards); }
    evaluateBlockers(hand, _) { return evaluateBlockers(hand, this.communityCards); }

    analyzeStacks(player) {
        const activePlayers = this.players.filter(p => this.isActive(p));
        const stacks = activePlayers.map(p => p.chips);
        const avgStack = stacks.reduce((a, b) => a + b, 0) / (stacks.length || 1);
        const stackRatio = player.chips / (avgStack || 1);
        return {
            isBigStack: stackRatio > 1.5,
            avgStack,
            stackRatio,
            targetsShortStack: activePlayers.some(p => p.id !== player.id && p.chips < avgStack * 0.5)
        };
    }

    // ==================== 翻前 GTO 范围决策 ====================

    preflopRangeDecision(player, position, isCheckedToMe, profile, stacks, board) {
        const handKey = handFromCards(player.handCards[0], player.handCards[1]);
        const toCall = this.currentBetLevel - player.currentBet;
        const raiseCount = this.raiseCountThisRound;
        const facingRaise = !isCheckedToMe;
        const activeCount = this.countActivePlayers();

        let rangePos = position;
        if (activeCount <= 3) rangePos = 'BTN';
        else if (activeCount <= 5 && (position === 'MP' || position === 'HJ')) rangePos = position === 'MP' ? 'HJ' : 'CO';
        else if (activeCount <= 6 && position === 'UTG') rangePos = 'MP';

        if (!facingRaise) {
            if (raiseCount >= 1) return { action: 'check' };
            if (isInPreflopRange(handKey, rangePos, 'open')) {
                const agg = profile.aggression;
                let mult;
                if (agg > 0.45)      mult = 1.8 + Math.random() * 0.6;
                else if (agg > 0.30) mult = 1.6 + Math.random() * 0.5;
                else                 mult = 1.5 + Math.random() * 0.3;
                const raiseTo = Math.floor(this.currentBetLevel * mult);
                if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) return { action: 'raise', multiplier: mult };
                return { action: 'call' };
            }
            return isCheckedToMe ? { action: 'check' } : { action: 'fold' };
        }

        if (raiseCount >= 3) {
            if (isInPreflopRange(handKey, rangePos, 'fourBet')) {
                if (Math.random() < 0.6) return { action: 'allin' };
                return { action: 'raise', multiplier: 1.6 + Math.random() * 0.4 };
            }
            if (isInPreflopRange(handKey, rangePos, 'threeBet') && Math.random() < 0.3) return { action: 'call' };
            return { action: 'fold' };
        }

        if (isInPreflopRange(handKey, rangePos, 'threeBet')) {
            const mult = 1.8 + Math.random() * 0.5;
            const raiseTo = Math.floor(this.currentBetLevel * mult);
            if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) return { action: 'raise', multiplier: mult };
            return { action: 'call' };
        }

        if (isInPreflopRange(handKey, rangePos, 'call')) {
            if (profile.aggression > 0.40 && Math.random() < 0.12 && raiseCount < 2) {
                const mult = 1.7 + Math.random() * 0.4;
                const raiseTo = Math.floor(this.currentBetLevel * mult);
                if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) return { action: 'raise', multiplier: mult };
            }
            if (toCall <= player.chips) return { action: 'call' };
            if (Math.random() < 0.4) return { action: 'allin' };
            return { action: 'fold' };
        }

        if (profile.tightness > 0.55 && Math.random() < 0.08 && raiseCount < 2) {
            if (toCall <= player.chips * 0.2) return { action: 'call' };
        }
        return { action: 'fold' };
    }

    // ===== 对手建模 =====

    _trackOpponentAction(p, action) {
        if (!p.aiProfile) return;
        let s = this.opponentStats.get(p.id);
        if (!s) { s = { vpip:0, pfr:0, foldFreq:0, hands:0, folds:0, calls:0, raises:0 }; this.opponentStats.set(p.id, s); }
        s.hands++;
        if (action === 'fold') s.folds++;
        if (action === 'call') s.calls++;
        if (action === 'raise' || action === 'allin') s.raises++;
        s.vpip = (s.calls + s.raises) / s.hands;
        s.pfr = s.raises / s.hands;
        s.foldFreq = s.folds / Math.max(1, s.hands);
    }

    _getOpponentStats(player) {
        return this.opponentStats.get(player.id) || { vpip:0.2, pfr:0.1, foldFreq:0.4, hands:0 };
    }

    _estimateFoldEquity(player) {
        let total = 0, count = 0;
        for (const p of this.players) {
            if (p.id === player.id || !this.isActive(p) || p.isAllIn) continue;
            const s = this._getOpponentStats(p);
            total += s.foldFreq; count++;
        }
        return count > 0 ? total / count : 0.3;
    }

    _estimateImpliedOddsBonus(player, drawBonus) {
        if (drawBonus < 0.05) return 0;
        const pot = totalPot(this.players);
        const stacks = this.players.filter(p => this.isActive(p) && p.id !== player.id).map(p => p.chips);
        const avgStack = stacks.reduce((a,b)=>a+b,0) / Math.max(1, stacks.length);
        const implied = Math.min(avgStack, pot * 2) / Math.max(1, pot);
        return drawBonus * implied * 0.3;
    }

    _getRiverTier(player) {
        if (this.phase !== 'river' || this.communityCards.length < 5) return null;
        const all7 = [...player.handCards, ...this.communityCards];
        const handRank = all7.length >= 5 ? evaluateHand(all7).rank : 0;
        const blockerScore = this.evaluateBlockers(player.handCards, null) / 10;
        if (handRank >= 6) return 5;
        if (handRank >= 3) return 4;
        if (handRank === 2 || (handRank === 1 && blockerScore > 0.3)) return 3;
        if (handRank === 1) return 2;
        return 1;
    }

    // ==================== AI 决策 ====================

    applyMixedStrategy(decision, profile, effectiveStrength, isCheckedToMe) {
        if (!decision) return decision;
        const deviateChance = profile.aggression * 0.25 + (1 - profile.tightness) * 0.1;
        if (Math.random() < deviateChance) {
            const roll = Math.random();
            if (decision.action === 'raise' && roll < 0.3 && isCheckedToMe) return { action: 'check' };
            else if (decision.action === 'raise' && roll < 0.15) return { action: 'raise', multiplier: (decision.multiplier || 1.5) + 0.3 };
            else if (decision.action === 'call' && roll < 0.2 && effectiveStrength > 0.6) return { action: 'raise', multiplier: 1.3 + Math.random() * 0.3 };
            else if (decision.action === 'check' && roll < 0.2 && effectiveStrength > 0.4) return { action: 'raise', multiplier: 1.0 + Math.random() * 0.2 };
        }
        return decision;
    }

    /** 把 AI 的百分比倍数换算成大盲倍数 */
    _aiPercentToBB(pct) {
        const raiseBy = this.currentBetLevel * (pct - 1);
        return Math.max(1, Math.min(5, Math.round(raiseBy / this.bigBlindAmount)));
    }

    /** 把百分比换算成 BB 数（用于翻后高级策略直接生成 BB 倍数） */
    _getBBFromPercent(pct) {
        return this._aiPercentToBB(pct);
    }

    aiDecide(player) {
        const decision = this._aiDecideCore(player);
        const result = this.applyMixedStrategy(decision, player.aiProfile,
            player._lastEffectiveStrength || 0.5,
            (this.currentBetLevel - player.currentBet) === 0);
        // 把百分比 multiplier 换算成 BB 倍数
        if (result && result.action === 'raise' && result.multiplier) {
            result.multiplier = this._aiPercentToBB(result.multiplier);
        }
        return result;
    }

    _aiDecideCore(player) {
        const profile = player.aiProfile;
        const hand = player.handCards;

        const position = this.getPositionContext(player);
        const board = this.analyzeBoard();
        const stacks = this.analyzeStacks(player);
        const drawBonus = this.evaluateDrawPotential(player);
        const boardStrat = this.getBoardStrategy(board.boardType);

        const toCall = this.currentBetLevel - player.currentBet;
        const potAfterCall = totalPot(this.players) + toCall;
        const potOdds = toCall > 0 ? toCall / (potAfterCall || 1) : 0;
        const isCheckedToMe = toCall === 0;
        const isPreflop = this.communityCards.length === 0;

        if (isPreflop) {
            return this.preflopRangeDecision(player, position, isCheckedToMe, profile, stacks, board);
        }

        const all7 = [...hand, ...this.communityCards];
        const handStrength = all7.length >= 5 ? evaluateHand(all7).rank / 9 : 0.3;
        const positionBonus = position === 'BTN' ? 0.05 : (position === 'CO' ? 0.04 : (position === 'HJ' ? 0.02 : (position === 'SB' ? -0.03 : 0)));
        const blockerScore = this.evaluateBlockers(hand, board) / 10;
        const impliedBonus = this._estimateImpliedOddsBonus(player, drawBonus);
        const activeCount = this.countActivePlayers();
        const multiwayPenalty = activeCount > 2 ? (activeCount - 2) * 0.04 : 0;
        let effectiveStrength = Math.min(1.0, handStrength + positionBonus + drawBonus + impliedBonus + blockerScore * 0.08 - multiwayPenalty);
        player._lastEffectiveStrength = effectiveStrength;

        const mdf = this.calculateMDF();
        const rangeAdv = this.getRangeAdvantage(player);
        const mdfFoldThreshold = (1 - mdf) * 0.7;
        const personalityFoldShift = (profile.tightness - 0.5) * 0.3;
        const gtoFoldThreshold = Math.max(0.10, Math.min(0.65, mdfFoldThreshold + personalityFoldShift));
        const rangeBoost = rangeAdv * 0.06;

        const betPotRatio = this.getBetPotRatio();
        const isMassiveOverbet = betPotRatio > 3;
        const overbetPenalty = isMassiveOverbet ? Math.min(0.4, (betPotRatio - 3) * 0.06) : 0;

        const riverTier = this._getRiverTier(player);
        const isRiver = this.phase === 'river';
        const riverPolarized = isRiver && riverTier !== null && riverTier <= 2;
        const raiseCapped = this.raiseCountThisRound >= 5 || riverPolarized;

        const foldEquity = this._estimateFoldEquity(player);
        const oppStats = this._getOpponentStats(player);

        // 筹码霸凌
        if (!raiseCapped && stacks.isBigStack && stacks.targetsShortStack && !isCheckedToMe && effectiveStrength > 0.3) {
            if (Math.random() < profile.aggression * 0.5) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bully') };
            }
        }

        // 偷盲/偷底
        if (!raiseCapped && position === 'late' && isCheckedToMe && effectiveStrength > 0.25) {
            const dryBonus = (board.boardType === 'dry_high' || board.boardType === 'rainbow_safe') ? 0.15 : 0;
            if (Math.random() < profile.aggression * 0.6 + (stacks.isBigStack ? 0.2 : 0) + dryBonus) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'steal') };
            }
        }

        // C-bet
        if (this.preflopRaiserIndex === player.id && this.phase === 'flop' && isCheckedToMe && this.communityCards.length === 3) {
            const cbetChance = boardStrat.cbetFreq + rangeAdv * 0.20 + (profile.aggression - 0.35) * 0.3;
            if (Math.random() < Math.max(0.15, Math.min(0.95, cbetChance))) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'cbet') };
            }
        }

        // 陷阱/慢打
        const trapChance = board.scary ? 0.08 : 0.22;
        const isTrapping = effectiveStrength > 0.8 && Math.random() < trapChance && isCheckedToMe;

        // 半诈唬
        if (!raiseCapped && drawBonus > 0.05 && position !== 'early' && isCheckedToMe && effectiveStrength > 0.3) {
            if (Math.random() < profile.aggression * 0.5 + (board.boardType === 'wet_flush' ? 0.1 : 0)) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'semibluff') };
            }
        }

        // 情景化诈唬：基于弃牌率 EV
        if (!raiseCapped && isCheckedToMe && effectiveStrength < 0.5) {
            const betSize = this.currentBetLevel > 0 ? this.currentBetLevel : this.bigBlindAmount * 3;
            const bluffEV = foldEquity * totalPot(this.players) - (1 - foldEquity) * betSize;
            const boardBluffBonus = (board.boardType === 'dry_high' || board.boardType === 'rainbow_safe') ? 1.25 : (board.scary && foldEquity > 0.45 ? 1.3 : 1.0);
            const blockerBluffBonus = 1.0 + blockerScore * 0.4;
            const bluffChance = profile.bluff * boardBluffBonus * blockerBluffBonus * (bluffEV > 0 ? 1.2 : 0.6);
            const multiwayBluffPenalty = activeCount > 2 ? Math.pow(0.7, activeCount - 2) : 1;
            if (Math.random() < bluffChance * multiwayBluffPenalty && player.chips > this.currentBetLevel * 2 + this.bigBlindAmount) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bluff') };
            }
        }

        // 面对下注时的诈唬加注
        if (!raiseCapped && !isCheckedToMe && effectiveStrength < 0.35 && toCall > 0 && !isMassiveOverbet) {
            const raiseSize = toCall * 3;
            const bluffRaiseEV = foldEquity * (totalPot(this.players) + toCall) - (1 - foldEquity) * raiseSize;
            const bluffVsBet = profile.bluff * (board.scary && foldEquity > 0.4 ? 1.3 : 1.0) * (1.0 + blockerScore * 0.3);
            const multiwayPen = activeCount > 2 ? 0.5 : 1;
            if (Math.random() < bluffVsBet * multiwayPen && player.chips > toCall * 3 && bluffRaiseEV > -player.chips * 0.1) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bluffraise') };
            }
        }

        // ===== 5. 翻后高级策略 =====

        // 5a. 驴式下注（Donk Bet）：翻前非加注者翻牌主动下注
        const canDonk = isPreflop ? false : (this.communityCards.length === 3 &&
            this.preflopRaiserIndex !== player.id && isCheckedToMe && !raiseCapped &&
            this.raiseCountThisRound === 0);
        if (canDonk) {
            // 中低牌面 + 有击中 → donk
            const donkBoard = board.boardType === 'rainbow_safe' || board.boardType === 'dry_high';
            const donkChance = donkBoard ? 0.15 : (board.boardType === 'paired' ? 0.12 : 0.05);
            if (effectiveStrength > 0.4 && Math.random() < donkChance * (1 + profile.aggression)) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.15) };
            }
        }

        // 5b. 挤压（Squeeze）：有人加注+有人跟注时，3-bet偷
        const squeezeEligible = isPreflop && this.raiseCountThisRound === 1 && activeCount >= 3
                              && position !== 'early' && player.chips > this.bigBlindAmount * 10;
        if (squeezeEligible && Math.random() < profile.aggression * 0.3) {
            const handKey = handFromCards(player.handCards[0], player.handCards[1]);
            // 用中强牌或纯诈唬牌挤压
            if (preflopRangeDecision(player, position, isCheckedToMe, profile, stacks, board).action !== 'fold'
                || Math.random() < 0.15) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.35) };
            }
        }

        // 5c. 薄价值下注（Thin Value）：中等牌也下注拿价值
        if (!raiseCapped && isCheckedToMe && effectiveStrength > 0.38 && effectiveStrength < 0.58 &&
            this.phase !== 'river' && activeCount <= 3 && !isTrapping) {
            const thinChance = profile.aggression * 0.35 + (board.scary ? -0.1 : 0.05);
            if (Math.random() < thinChance && oppStats.foldFreq < 0.5) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.1) };
            }
        }

        // 5d. 英雄跟注（Hero Call）：用弱牌抓诈唬
        if (!isCheckedToMe && toCall > 0 && effectiveStrength < foldThreshold && effectiveStrength > 0.2
            && this.phase === 'river' && toCall <= player.chips * 0.25) {
            const heroIndicators = (blockerScore > 0.3 ? 0.3 : 0)
                + (oppStats.vpip > 0.25 && oppStats.pfr > 0.15 && oppStats.foldFreq < 0.5 ? 0.2 : 0)
                + (board.scary ? 0.15 : 0);
            if (Math.random() < heroIndicators * (1 - profile.tightness)) {
                return { action: 'call' };
            }
        }

        // 5e. 河牌超池下注（Overbet）：极化手牌用大尺度
        if (isRiver && isCheckedToMe && !raiseCapped && (effectiveStrength > 0.75 || effectiveStrength < 0.2)) {
            const overbetChance = effectiveStrength > 0.75 ? 0.2 : (profile.bluff * 0.3);
            if (Math.random() < overbetChance && player.chips > this.bigBlindAmount * 5) {
                const obSize = effectiveStrength > 0.75
                    ? this._getBBFromPercent(1.4 + Math.random() * 0.3)
                    : this._getBBFromPercent(1.5 + Math.random() * 0.5);
                return { action: 'raise', multiplier: obSize };
            }
        }

        // 5f. 延迟 C-bet：翻牌过牌，转牌下注
        if (isTurn && isCheckedToMe && this.communityCards.length === 4 &&
            this.preflopRaiserIndex === player.id && !raiseCapped && effectiveStrength > 0.35) {
            const delayedChance = 0.15 + profile.aggression * 0.2 + (board.scary ? 0.12 : 0);
            if (Math.random() < delayedChance) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.2) };
            }
        }

        // 5g. 飘浮跟注（Float）：翻牌有位置时跟注，转牌被过牌就下注偷
        const isFlop = this.phase === 'flop';
        const isTurn = this.phase === 'turn';
        const floatEligible = isFlop && !isCheckedToMe && position !== 'early' && toCall > 0
                            && toCall <= player.chips * 0.3 && activeCount <= 3;
        if (floatEligible && effectiveStrength < 0.45 && effectiveStrength > 0.2) {
            const floatChance = profile.aggression * 0.45 + (board.scary ? -0.1 : 0.1);
            if (Math.random() < floatChance && player.chips > toCall * 4) {
                player._floatPlanned = true;  // 标记，转牌无抵抗就偷
                return { action: 'call' };
            }
        }
        // 执行飘浮：转牌被过牌 → 下注
        if (isTurn && player._floatPlanned && isCheckedToMe && !raiseCapped && effectiveStrength < 0.5) {
            player._floatPlanned = false;
            if (Math.random() < 0.7) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.3) };
            }
        }

        // 5b. 探针下注（Probe Bet）：翻前加注者翻牌过牌 → 转牌主动下注
        if (isTurn && isCheckedToMe && this.communityCards.length === 4 &&
            this.preflopRaiserIndex !== player.id && !raiseCapped) {
            const probeChance = (board.scary ? 0.2 : 0.35) * profile.aggression;
            if (Math.random() < probeChance && player.chips > this.bigBlindAmount * 3) {
                if (effectiveStrength > 0.25) {
                    return { action: 'raise', multiplier: this._getBBFromPercent(1.2) };
                }
            }
        }

        // 5c. 过牌-加注（Check-Raise）：面对下注时用强牌或听牌反加
        if (!isCheckedToMe && !raiseCapped && toCall > 0 && toCall < player.chips * 0.5) {
            const crStrong = effectiveStrength > 0.65 && Math.random() < 0.4 && this.raiseCountThisRound < 2;
            const crDraw = drawBonus > 0.06 && effectiveStrength > 0.35 && Math.random() < profile.aggression * 0.5;
            if ((crStrong || crDraw) && this.raiseCountThisRound < 3) {
                const crMult = crStrong
                    ? this._getBBFromPercent(1.5)
                    : this._getBBFromPercent(1.8);
                return { action: 'raise', multiplier: crMult };
            }
        }

        // 5d. 转牌连续开火（Double Barrel）：翻牌 C-bet 后转牌继续下注
        if (isTurn && isCheckedToMe && this.preflopRaiserIndex === player.id &&
            this.communityCards.length === 4 && !raiseCapped && effectiveStrength > 0.3) {
            const barrelChance = 0.3 + profile.aggression * 0.35 + (board.scary ? 0.1 : -0.05)
                               + (effectiveStrength > 0.5 ? 0.2 : 0);
            if (Math.random() < barrelChance) {
                return { action: 'raise', multiplier: this._getBBFromPercent(1.2) };
            }
        }

        // 5e. 适应性剥削：根据对手弃牌率调整
        if (!raiseCapped && isCheckedToMe && effectiveStrength < 0.45) {
            if (foldEquity > 0.45 && Math.random() < profile.aggression * 0.4) {
                // 对手弃牌多 → 多诈唬
                if (player.chips > this.bigBlindAmount * 4) {
                    return { action: 'raise', multiplier: this._getBBFromPercent(1.25) };
                }
            }
        }
        if (!raiseCapped && effectiveStrength > 0.55 && !isCheckedToMe && toCall > 0) {
            if (oppStats.foldFreq < 0.35 && oppStats.vpip > 0.35) {
                // 对手不爱弃牌 → 加注价值
                if (Math.random() < 0.3 && this.raiseCountThisRound < 2) {
                    return { action: 'raise', multiplier: this._getBBFromPercent(1.3) };
                }
            }
        }

        if (isTrapping) return { action: 'check' };

        // 动态阈值
        const valueFusion = rangeAdv * 0.4 + blockerScore * 0.3 + boardStrat.valueWeight * 0.3;
        const foldThreshold = (Math.min(gtoFoldThreshold, profile.tightness * 0.55) + overbetPenalty)
                              * (1.0 + boardStrat.bluffWeight * 0.3);
        const betThreshold = Math.max(0.22, (0.38 - profile.aggression * 0.12) - rangeBoost - valueFusion * 0.15);
        const raiseThreshold = Math.max(isRiver ? 0.55 : 0.40,
            (0.72 - profile.aggression * 0.28) - rangeBoost + this.raiseCountThisRound * 0.08 + (isRiver ? 0.10 : 0)
            - valueFusion * 0.20);

        const margin = 0.06;

        if (effectiveStrength < foldThreshold && toCall > 0) {
            if (!isMassiveOverbet && effectiveStrength > gtoFoldThreshold && Math.random() < 0.35) return { action: 'call' };
            if (potOdds < 0.18 && effectiveStrength > foldThreshold * 0.55) return { action: 'call' };
            if (toCall === 0) return { action: 'check' };
            return { action: 'fold' };
        }

        if (effectiveStrength > raiseThreshold && !isTrapping && !raiseCapped) {
            if (effectiveStrength < raiseThreshold + margin && Math.random() > (effectiveStrength - raiseThreshold) / margin) {
                if (isCheckedToMe) return { action: 'check' };
                if (toCall <= player.chips) return { action: 'call' };
            }
            const multiplier = this.pickGTOMultiplier(profile, board, 'value');
            const raiseTo = Math.floor(this.currentBetLevel * multiplier);
            if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) return { action: 'raise', multiplier };
            if (effectiveStrength > 0.7 && player.chips > 0) return { action: 'allin' };
        }

        if (!raiseCapped && isCheckedToMe && effectiveStrength > betThreshold && !isTrapping) {
            if (effectiveStrength < betThreshold + margin && Math.random() < 0.5) return { action: 'check' };
            return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bet') };
        }

        if (isCheckedToMe) return { action: 'check' };

        if (toCall <= player.chips) {
            if (effectiveStrength < foldThreshold + margin * 2 && effectiveStrength >= foldThreshold && Math.random() < 0.15)
                return { action: 'fold' };
            if (toCall > player.chips * 0.5 && effectiveStrength > 0.5) return { action: 'allin' };
            return { action: 'call' };
        }

        if (effectiveStrength > 0.55) return { action: 'allin' };
        return { action: 'fold' };
    }

    evaluatePreflop(hand) {
        const [c1, c2] = hand;
        const high = Math.max(c1.rankValue, c2.rankValue);
        const low = Math.min(c1.rankValue, c2.rankValue);
        const gap = high - low;
        const suited = c1.suit === c2.suit;
        const isPair = c1.rank === c2.rank;
        if (isPair) return (high - 1) / 14 + 0.15;
        const highScore = (high - 1) / 14;
        const gapPenalty = gap * 0.04;
        const suitedBonus = suited ? 0.08 : 0;
        return Math.max(0.05, Math.min(0.9, highScore * 0.65 + (low / 14) * 0.25 - gapPenalty + suitedBonus));
    }

    // ==================== 自动推进（Promise 等待人类） ====================

    autoAdvance() {
        const step = () => {
            if (this.phase === 'hand_over' || this.phase === 'idle' || this.phase === 'game_over') return;

            const current = this.players[this.currentPlayerIndex];
            if (!current || !this.isActive(current)) {
                this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                if (this.currentPlayerIndex < 0) {
                    this.advancePhase();
                    if (this.phase !== 'hand_over') setTimeout(() => this.autoAdvance(), 0);
                    return;
                }
                this.notifyState();
                setTimeout(() => this.autoAdvance(), 0);
                return;
            }

            if (!current.isHuman && this.isActive(current)) {
                // AI 行动
                if (!current.isAllIn && current.needsToAct) {
                    const decision = this.aiDecide(current);
                    setTimeout(() => {
                        if (this.currentPlayerIndex >= 0) {
                            this.doAction(this.currentPlayerIndex, decision.action, decision.multiplier);
                        }
                    }, 0);
                } else {
                    current.needsToAct = false;
                    current.hasActedThisRound = true;
                    if (this.isBettingRoundOver()) {
                        this.advancePhase();
                    } else {
                        this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                        this.notifyState();
                        setTimeout(() => this.autoAdvance(), 0);
                    }
                }
            } else if (current.isHuman && this.isActive(current)) {
                // 人类行动
                if (current.isAllIn || !current.needsToAct) {
                    current.needsToAct = false;
                    current.hasActedThisRound = true;
                    if (this.isBettingRoundOver()) {
                        this.advancePhase();
                    } else {
                        this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                        this.notifyState();
                        setTimeout(() => this.autoAdvance(), 0);
                    }
                } else {
                    // 等待人类操作
                    this.message = `等待 ${current.name} 行动...`;
                    this.notifyState();
                    // 设置超时
                    this._startTurnTimeout(current.id);
                }
            }
        };

        setTimeout(step, 0);
    }

    _startTurnTimeout(playerId) {
        if (this._turnTimer) clearTimeout(this._turnTimer);
        this._turnTimer = setTimeout(() => {
            // 超时 → 自动弃牌
            const idx = this._playerIndex(playerId);
            if (idx >= 0 && idx === this.currentPlayerIndex) {
                console.log(`⏰ ${this.players[idx].name} 回合超时，自动弃牌`);
                this.doAction(idx, 'fold');
            }
            this._turnTimer = null;
        }, this.turnTimeout);
    }

    /** 补码：被淘汰后重新获得 20000 积分上桌（全局共5次） */
    rebuy(playerId) {
        const idx = this._playerIndex(playerId);
        if (idx < 0) return { error: '玩家不存在' };
        const player = this.players[idx];
        if (!this.eliminatedPlayers.includes(playerId)) return { error: '你还在游戏中，不需要补码' };
        if (this._rebuysLeft <= 0) return { error: '本局补码次数已用完（全局共5次）' };

        this._rebuysLeft--;

        // 恢复玩家
        this.eliminatedPlayers = this.eliminatedPlayers.filter(id => id !== playerId);
        player.chips = this.startingChips;
        player.isFolded = false;
        player.isAllIn = false;
        player.currentBet = 0;
        player.totalBetThisHand = 0;
        player.needsToAct = true;
        player.hasActedThisRound = false;

        console.log(`💰 ${player.name} 补码，剩余全局次数: ${this._rebuysLeft}`);

        if (this.phase === 'game_over') {
            this.phase = 'hand_over';
            this.message = `${player.name} 补码重新上桌！`;
        }

        this.notifyState();
        return { ok: true, rebuysLeft: this._rebuysLeft };
    }

    /** 观战者接管 AI 座位 */
    takeSeat(spectatorId, targetPlayerId, spectatorName) {
        const idx = this._playerIndex(targetPlayerId);
        if (idx < 0) return { error: '目标玩家不存在' };
        const target = this.players[idx];
        if (target.isHuman) return { error: '该座位已被真人占用' };
        if (this.eliminatedPlayers.includes(targetPlayerId)) return { error: '该玩家已被淘汰' };

        // 接管 AI
        target.isHuman = true;
        target.name = spectatorName;
        target.aiProfile = null;
        target._lastEffectiveStrength = 0;
        this.playerIdMap.set(spectatorId, idx);  // 更新 playerId → 座位映射
        // 删除旧的 AI playerId 映射
        this.playerIdMap.delete(targetPlayerId);
        target.id = spectatorId;

        console.log(`🎯 ${spectatorName} 接管了 ${target.name}（座位${idx}，筹码${target.chips}）`);
        this.message = `${spectatorName} 入座，接管了 AI！`;

        // 如果当前是 AI 的回合，重置等待
        if (this.currentPlayerIndex === idx && target.needsToAct && !target.isAllIn) {
            // 变为人类回合，重新通知
            this._pendingHumanResolve = null;
            if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
        }

        this.notifyState();
        return { ok: true, seatIndex: idx };
    }

    /** 观战者加入空位（场上无AI的空位） */
    joinEmptySeat(playerId, playerName, seatIndex) {
        // 验证：座位必须在 0-8 范围内
        if (seatIndex < 0 || seatIndex > 8) return { error: '无效的座位号' };
        // 验证：该座位必须为空（没有已存在的玩家）
        const existing = this.players.find(p => p.seatIndex === seatIndex);
        if (existing) return { error: '该座位已被占用' };

        const player = createPlayer(playerId, playerName, true, null);
        player.seatIndex = seatIndex;
        player.chips = this.startingChips;
        // 当前局标记为已弃牌，下局自动参与
        player.isFolded = true;
        player.handCards = [];
        player.currentBet = 0;
        player.totalBetThisHand = 0;
        player.needsToAct = false;
        player.hasActedThisRound = true;

        // 按 seatIndex 插入到正确位置（保持 players 数组按座位排序）
        let insertIdx = 0;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].seatIndex < seatIndex) {
                insertIdx = i + 1;
            } else {
                break;
            }
        }
        this.players.splice(insertIdx, 0, player);

        // 重建 playerIdMap（插入位置之后的索引全部后移）
        this.playerIdMap.clear();
        for (let i = 0; i < this.players.length; i++) {
            this.playerIdMap.set(this.players[i].id, i);
        }

        // 调整可能受影响的索引
        if (this.dealerIndex >= insertIdx) this.dealerIndex++;
        if (this.currentPlayerIndex >= insertIdx) this.currentPlayerIndex++;

        console.log(`🪑 ${playerName} 加入空位 ${seatIndex}，获得 ${this.startingChips} 积分`);
        this.message = `${playerName} 入座空位！下局开始参与`;

        this.notifyState();
        return { ok: true, seatIndex, playerId };
    }

    /** 获取所有空位编号 */
    getEmptySeats() {
        const occupied = new Set(this.players.map(p => p.seatIndex));
        const empties = [];
        for (let i = 0; i < 9; i++) {
            if (!occupied.has(i)) empties.push(i);
        }
        return empties;
    }

    /** 真人退出 → AI 接管 */
    convertToAI(playerId) {
        const idx = this._playerIndex(playerId);
        if (idx < 0) return;
        const player = this.players[idx];
        if (!player.isHuman) return;

        // 随机分配一个 AI 性格
        const aiProfiles = require('../shared/constants.js').AI_PERSONALITIES;
        const profile = aiProfiles[Math.floor(Math.random() * aiProfiles.length)];

        player.isHuman = false;
        player.aiProfile = profile;
        player.name = 'AI-' + (player.name.length > 6 ? player.name.slice(0, 4) : player.name);
        player._lastEffectiveStrength = 0;

        console.log(`🤖 ${player.name} 接管了退出的玩家（座位${idx}，${player.chips}积分）`);

        // 如果当前是这位玩家的回合，立即触发 AI 决策
        if (this.currentPlayerIndex === idx && player.needsToAct && this.isActive(player) && !player.isAllIn) {
            if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
            this.message = `${player.name}（AI）接管行动...`;
            this.notifyState();
            const decision = this.aiDecide(player);
            setTimeout(() => {
                if (this.currentPlayerIndex === idx) {
                    this.doAction(idx, decision.action, decision.multiplier);
                }
            }, 0);
        } else {
            this.notifyState();
        }
    }

    /** 接收人类玩家的行动（由 network_handler 调用） */
    receiveHumanAction(playerId, action, multiplier) {
        const idx = this._playerIndex(playerId);
        if (idx < 0 || idx !== this.currentPlayerIndex) return false;

        const p = this.players[idx];
        if (!p.isHuman || !p.needsToAct) return false;

        // 清除超时
        if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }

        return this.doAction(idx, action, multiplier);
    }

    /** 开始下一局 */
    nextHand() {
        if (this.phase !== 'hand_over') return;
        if (this._handOverTimer) { clearTimeout(this._handOverTimer); this._handOverTimer = null; }
        this.startNewHand();
    }

    /** 更新盲注级别（20手/10分钟/掉人触发） */
    updateBlinds(forceAdvance) {
        let shouldAdvance = forceAdvance || false;

        if (this.handsAtCurrentBlind >= BLINDS_UP_HANDS) {
            shouldAdvance = true;
        }

        const elapsed = Date.now() - this.blindLevelStartTime;
        if (elapsed >= BLINDS_UP_MINUTES * 60 * 1000) {
            shouldAdvance = true;
        }

        if (shouldAdvance && this.blindLevel < BLIND_LEVELS.length - 1) {
            this.blindLevel++;
            this.handsAtCurrentBlind = 0;
            this.blindLevelStartTime = Date.now();
            this.blindIncreased = (this.handNumber > 1);
        }

        this.smallBlindAmount = BLIND_LEVELS[this.blindLevel].small;
        this.bigBlindAmount  = BLIND_LEVELS[this.blindLevel].big;
        this.minRaise = this.bigBlindAmount;
    }

    // ==================== 状态广播 ====================

    /**
     * 获取针对特定玩家的个性化状态快照
     * @param {Number} playerId — 接收方的 playerId
     */
    getState(playerId) {
        const viewerIdx = this._playerIndex(playerId);
        const viewer = viewerIdx >= 0 ? this.players[viewerIdx] : null;

        // 是否是当前查看者的回合
        const isMyTurn = this.phase !== 'hand_over' &&
                         this.phase !== 'idle' &&
                         this.phase !== 'game_over' &&
                         viewer &&
                         this.currentPlayerIndex === viewerIdx &&
                         viewer.needsToAct &&
                         this.isActive(viewer) &&
                         !viewer.isAllIn;

        // 可用动作
        let availableActions = [];
        if (isMyTurn) {
            const toCall = this.currentBetLevel - viewer.currentBet;
            if (toCall === 0) {
                availableActions = ['fold', 'check', 'raise', 'allin'];
            } else if (toCall >= viewer.chips) {
                availableActions = ['fold', 'allin'];
            } else {
                availableActions = ['fold', 'call', 'raise', 'allin'];
            }
        }

        // 是否亮牌
        const isShowdownResult = this.phase === 'hand_over' && this._wasShowdown;
        const revealAll = this.gameMode === 'training'
            ? (this.phase === 'hand_over' || this.phase === 'showdown')
            : (this.phase === 'showdown' || isShowdownResult);

        // 构建9元素座位数组，空位为 null
        const playersState = new Array(9).fill(null);
        for (const p of this.players) {
            let visible = [];
            if (p.id === playerId) {
                visible = p.handCards;
            } else if (revealAll) {
                visible = (this.gameMode === 'competitive' && p.isFolded) ? [] : p.handCards;
            }
            playersState[p.seatIndex] = {
                id: p.id, name: p.name, chips: p.chips,
                handCards: visible,
                currentBet: p.currentBet,
                totalBetThisHand: p.totalBetThisHand,
                isFolded: p.isFolded, isAllIn: p.isAllIn,
                isHuman: p.isHuman,
                isDealer: p.isDealer, isSmallBlind: p.isSmallBlind, isBigBlind: p.isBigBlind,
                isActive: this.isActive(p),
                isEliminated: this.eliminatedPlayers.includes(p.id),
                aiType: p.aiProfile ? p.aiProfile.desc : null,
            };
        }

        const currentPlayer = this.currentPlayerIndex >= 0 ? this.players[this.currentPlayerIndex] : null;

        return {
            myPlayerId: playerId,
            myCards: viewer ? viewer.handCards : [],
            myChips: viewer ? viewer.chips : 0,
            players: playersState,
            communityCards: this.communityCards,
            pot: totalPot(this.players),
            phase: this.phase,
            message: this.message,
            currentPlayerId: (this.currentPlayerIndex >= 0 && this.currentPlayerIndex < this.players.length) ? this.players[this.currentPlayerIndex].id : null,
            isMyTurn,
            availableActions,
            minRaise: isMyTurn ? (this.currentBetLevel + this.minRaise) : 0,
            toCall: isMyTurn ? Math.max(0, this.currentBetLevel - viewer.currentBet) : 0,
            handNumber: this.handNumber,
            winners: this.winners.map(w => ({
                name: w.player.name,
                playerId: w.player.id,
                handName: w.hand ? w.hand.name : null,
                handCards: w.player.handCards,
                pot: w.pot,
            })),
            lastAction: this.lastAction,
            currentRoundRaiserId: this.currentRoundRaiserId,
            isGameOver: this.phase === 'game_over',
            canRebuy: viewer ? (this.eliminatedPlayers.includes(playerId) && this._rebuysLeft > 0) : false,
            rebuysLeft: this._rebuysLeft,
            smallBlind: this.smallBlindAmount,
            bigBlind: this.bigBlindAmount,
            gameMode: this.gameMode,
            revealAllCards: revealAll,
            showAiTypes: this.gameMode === 'training',
            emptySeats: this.getEmptySeats(),
        };
    }

    /** 向所有人类玩家广播个性化状态 */
    notifyState() {
        if (!this.onBroadcast) return;

        // 向所有人类玩家（包括被淘汰但可补码的）发送状态
        for (const p of this.players) {
            if (p.isHuman) {
                const state = this.getState(p.id);
                this.onBroadcast(p.id, state);
            }
        }

        // hand_over 时 5 秒后自动推进
        if (this.phase === 'hand_over' && !this._handOverTimer) {
            this._handOverTimer = setTimeout(() => {
                this._handOverTimer = null;
                if (this.phase === 'hand_over') {
                    this.nextHand();
                }
            }, 5000);
        }

        // 通知观战者（通过 game_manager 的 _spectatorCallback）
        if (this._onSpectatorBroadcast) {
            const specState = this.getSpectatorState(0); // 观战者通用状态
            this._onSpectatorBroadcast(specState);
        }
    }

    /** 获取观战者状态（看到所有牌，但不能行动） */
    getSpectatorState(spectatorId) {
        const revealAll = this.gameMode === 'training'
            ? (this.phase === 'hand_over' || this.phase === 'showdown')
            : (this.phase === 'showdown' || (this.phase === 'hand_over' && this._wasShowdown));

        // 构建9元素座位数组，空位为 null
        const specPlayersState = new Array(9).fill(null);
        for (const p of this.players) {
            specPlayersState[p.seatIndex] = {
                id: p.id, name: p.name, chips: p.chips,
                handCards: revealAll ? p.handCards : [],
                currentBet: p.currentBet,
                totalBetThisHand: p.totalBetThisHand,
                isFolded: p.isFolded, isAllIn: p.isAllIn,
                isHuman: p.isHuman,
                isDealer: p.isDealer, isSmallBlind: p.isSmallBlind, isBigBlind: p.isBigBlind,
                isActive: this.isActive(p),
                isEliminated: this.eliminatedPlayers.includes(p.id),
                aiType: p.aiProfile && this.gameMode === 'training' ? p.aiProfile.desc : null,
            };
        }

        return {
            myPlayerId: spectatorId,
            myCards: [],
            myChips: 0,
            isSpectator: true,
            players: specPlayersState,
            communityCards: this.communityCards,
            pot: totalPot(this.players),
            phase: this.phase,
            message: this.message,
            currentPlayerId: (this.currentPlayerIndex >= 0 && this.currentPlayerIndex < this.players.length) ? this.players[this.currentPlayerIndex].id : null,
            isMyTurn: false,
            availableActions: [],
            handNumber: this.handNumber,
            winners: this.winners.map(w => ({
                name: w.player.name,
                playerId: w.player.id,
                handName: w.hand ? w.hand.name : null,
                handCards: w.player.handCards,
                pot: w.pot,
            })),
            lastAction: this.lastAction,
            currentRoundRaiserId: this.currentRoundRaiserId,
            isGameOver: this.phase === 'game_over',
            canRebuy: false,
            rebuysLeft: this._rebuysLeft,
            smallBlind: this.smallBlindAmount,
            bigBlind: this.bigBlindAmount,
            gameMode: this.gameMode,
            revealAllCards: revealAll,
            showAiTypes: this.gameMode === 'training',
            emptySeats: this.getEmptySeats(),
        };
    }

    /** 获取游戏结束结果 */
    _getResults() {
        return {
            players: this.players.map(p => ({
                id: p.id, name: p.name, chips: p.chips,
                isHuman: p.isHuman, isEliminated: this.eliminatedPlayers.includes(p.id),
            })),
            handNumber: this.handNumber,
        };
    }
}

module.exports = { PokerGame };
