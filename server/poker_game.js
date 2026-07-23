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
        this.gameMode = config.gameMode || 'training';
        this.turnTimeout = (config.turnTimeout || 60) * 1000;
        this.opponentStats = new Map();

        // 广播回调：由 game_manager 设置
        this.onBroadcast = null;        // (playerId, state) => void
        this.onGameOver = null;         // (results) => void

        // 人类回合等待机制
        this._pendingHumanResolve = null;
        this._turnTimer = null;

        // 初始化玩家和游戏
        this._initFromConfig();
    }

    // ==================== 初始化 ====================

    _initFromConfig() {
        this.players = [];
        this.playerIdMap.clear();
        this.handNumber = 0;
        this.eliminatedPlayers = [];

        // 按 seatIndex 排序创建玩家
        const sorted = [...this.seatConfig].sort((a, b) => a.seatIndex - b.seatIndex);
        for (const s of sorted) {
            const player = createPlayer(s.playerId, s.name, s.isHuman, s.aiProfile || null);
            this.players.push(player);
            this.playerIdMap.set(s.playerId, s.seatIndex);
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
            this.phase = 'game_over';
            this.message = '游戏结束！';
            this.notifyState();
            if (this.onGameOver) this.onGameOver(this._getResults());
            return;
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
        const callAmount = Math.round(raw * 2) / 2;
        p.chips -= callAmount;
        p.currentBet += callAmount;
        p.totalBetThisHand += callAmount;
        if (p.chips <= 0) p.isAllIn = true;
        this.message = `${p.name} 跟注 ${callAmount}`;
        this.lastAction = { playerName: p.name, playerId: p.id, action: 'call', amount: callAmount };
    }

    doRaise(p, multiplier) {
        const rawTarget = this.currentBetLevel * (multiplier || 1.3);
        const raiseTo = Math.max(Math.round(rawTarget * 2) / 2, this.currentBetLevel + this.minRaise);
        const needed = raiseTo - p.currentBet;
        const additional = Math.round(Math.min(needed, p.chips) * 2) / 2;
        p.chips -= additional;
        p.currentBet += additional;
        p.totalBetThisHand += additional;
        this.currentBetLevel = p.currentBet;
        if (this.phase === 'preflop') this.preflopRaiserIndex = p.id;
        if (p.chips <= 0) p.isAllIn = true;
        this.raiseCountThisRound++;

        for (const other of this.players) {
            if (other.id !== p.id && this.isActive(other) && !other.isAllIn) {
                other.needsToAct = true;
                other.hasActedThisRound = false;
            }
        }

        const pct = Math.round(((multiplier || 1.3) - 1) * 100);
        this.message = `${p.name} 加注到 ${p.currentBet}（+${pct}%）`;
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

    aiDecide(player) {
        const decision = this._aiDecideCore(player);
        return this.applyMixedStrategy(decision, player.aiProfile,
            player._lastEffectiveStrength || 0.5,
            (this.currentBetLevel - player.currentBet) === 0);
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
                    if (this.phase !== 'hand_over') setTimeout(() => this.autoAdvance(), 300);
                    return;
                }
                this.notifyState();
                setTimeout(() => this.autoAdvance(), 200);
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
                    }, 400 + Math.random() * 800);
                } else {
                    current.needsToAct = false;
                    current.hasActedThisRound = true;
                    if (this.isBettingRoundOver()) {
                        this.advancePhase();
                    } else {
                        this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                        this.notifyState();
                        setTimeout(() => this.autoAdvance(), 200);
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
                        setTimeout(() => this.autoAdvance(), 200);
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

        setTimeout(step, 300);
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
                availableActions = ['fold', 'check', 'raise_100', 'raise_150', 'raise_200', 'allin'];
            } else if (toCall >= viewer.chips) {
                availableActions = ['fold', 'allin'];
            } else {
                availableActions = ['fold', 'call', 'raise_100', 'raise_150', 'raise_200', 'allin'];
            }
        }

        // 是否亮牌
        const isShowdownResult = this.phase === 'hand_over' && this._wasShowdown;
        const revealAll = this.gameMode === 'training'
            ? (this.phase === 'hand_over' || this.phase === 'showdown')
            : (this.phase === 'showdown' || isShowdownResult);

        return {
            myPlayerId: playerId,
            myCards: viewer ? viewer.handCards : [],
            myChips: viewer ? viewer.chips : 0,
            players: this.players.map(p => {
                // 手牌可见性：
                // - 自己：始终可见
                // - 摊牌/hand_over：所有人可见（竞技模式中弃牌者不亮）
                // - 其他情况：隐藏
                let visible = [];
                if (p.id === playerId) {
                    visible = p.handCards;
                } else if (revealAll) {
                    visible = (this.gameMode === 'competitive' && p.isFolded) ? [] : p.handCards;
                }
                return {
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
            }),
            communityCards: this.communityCards,
            pot: totalPot(this.players),
            phase: this.phase,
            message: this.message,
            currentPlayerId: this.currentPlayerIndex >= 0 ? this.players[this.currentPlayerIndex].id : null,
            isMyTurn,
            availableActions,
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
            smallBlind: this.smallBlindAmount,
            bigBlind: this.bigBlindAmount,
            gameMode: this.gameMode,
            revealAllCards: revealAll,
            showAiTypes: this.gameMode === 'training',
        };
    }

    /** 向所有人类玩家广播个性化状态 */
    notifyState() {
        if (!this.onBroadcast) return;
        for (const p of this.players) {
            if (p.isHuman && !this.eliminatedPlayers.includes(p.id)) {
                const state = this.getState(p.id);
                this.onBroadcast(p.id, state);
            }
        }
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
