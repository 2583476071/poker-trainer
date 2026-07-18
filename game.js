/* ================================================================
 * 德州扑克 AI 训练器 — 游戏引擎
 * 1 真人 vs 8 AI  |  每人 500 初始积分  |  纯单机本地运行
 * ================================================================ */

// ==================== 常量 ====================
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const SUITS = ['hearts','diamonds','clubs','spades'];
const SUIT_SYMBOLS = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' };
const SUIT_COLORS = { hearts:'#e74c3c', diamonds:'#e74c3c', clubs:'#2c3e50', spades:'#2c3e50' };

const HAND_NAMES = [
    '高牌','一对','两对','三条','顺子',
    '同花','葫芦','四条','同花顺','皇家同花顺'
];

const PHASES = ['preflop','flop','turn','river','showdown','hand_over'];
const SMALL_BLIND = 2;
const BIG_BLIND = 4;
const STARTING_CHIPS = 500;

// AI 性格类型
const AI_PERSONALITIES = [
    { name:'娱乐型', tightness:0.74, aggression:0.24, bluff:0.08, desc:'松弱-跟注站' },
    { name:'娱乐型', tightness:0.68, aggression:0.28, bluff:0.10, desc:'松弱-爱看牌' },
    { name:'常客',   tightness:0.54, aggression:0.34, bluff:0.12, desc:'偏紧-稳定' },
    { name:'常客',   tightness:0.50, aggression:0.38, bluff:0.13, desc:'平衡型' },
    { name:'常客',   tightness:0.47, aggression:0.40, bluff:0.14, desc:'平衡-稍凶' },
    { name:'常客',   tightness:0.44, aggression:0.42, bluff:0.15, desc:'紧凶-适度' },
    { name:'高手',   tightness:0.38, aggression:0.48, bluff:0.18, desc:'紧凶-会施压' },
    { name:'高手',   tightness:0.35, aggression:0.55, bluff:0.22, desc:'紧凶-最难缠' },
];

// ==================== 翻前 GTO 范围表（100bb, 9-Max） ====================
// 手牌编码：对子 "AA"-"22"，同花 "AKs"-"32s"，不同花 "AKo"-"32o"
// 范围格式：{ pairs: [minRank], suited: [minRanks], offsuit: [minRanks] }
// 每个位置定义 open / threeBet / call / fourBet 四个动作的范围

function makeHandKey(rank1, rank2, suited) {
    const high = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank1 : rank2;
    const low  = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank2 : rank1;
    if (rank1 === rank2) return high + high;                          // 对子: "AA"
    return suited ? (high + low + 's') : (high + low + 'o');         // "AKs" / "AKo"
}

function handFromCards(c1, c2) {
    return makeHandKey(c1.rank, c2.rank, c1.suit === c2.suit);
}

// 展开范围描述为手牌集合
function expandRangeDesc(desc) {
    const hands = new Set();
    // 对子: { min: '7' } → 77-AA
    if (desc.pairsMin) {
        const startIdx = RANKS.indexOf(desc.pairsMin);
        for (let i = startIdx; i < RANKS.length; i++) {
            hands.add(RANKS[i] + RANKS[i]);
        }
    }
    // 同花: [{ high: 'A', low: '9' }] → A9s,ATs,AJs,AQs,AKs
    if (desc.suitedMin) {
        for (const s of desc.suitedMin) {
            const hiIdx = RANKS.indexOf(s.high);
            const loIdx = RANKS.indexOf(s.low);
            for (let hi = hiIdx; hi > loIdx; hi--) {
                for (let lo = loIdx; lo < hi; lo++) {
                    hands.add(RANKS[hi] + RANKS[lo] + 's');
                }
            }
        }
    }
    // 不同花: [{ high: 'A', low: 'J' }] → AJo,AQo,AKo
    if (desc.offsuitMin) {
        for (const o of desc.offsuitMin) {
            const hiIdx = RANKS.indexOf(o.high);
            const loIdx = RANKS.indexOf(o.low);
            for (let hi = hiIdx; hi > loIdx; hi--) {
                for (let lo = loIdx; lo < hi; lo++) {
                    hands.add(RANKS[hi] + RANKS[lo] + 'o');
                }
            }
        }
    }
    return hands;
}

// 构建所有范围查找表
function buildRangeLookup() {
    const lookup = {};
    const descs = PREFLOP_RANGE_DESCS;
    for (const pos of Object.keys(descs)) {
        lookup[pos] = {};
        for (const action of Object.keys(descs[pos])) {
            lookup[pos][action] = expandRangeDesc(descs[pos][action]);
        }
    }
    return lookup;
}

// 范围描述（紧凑格式，启动时展开）
const PREFLOP_RANGE_DESCS = {
    // UTG / 早期位置 — 开池 ~10%
    early: {
        open: {
            pairsMin: '7',                               // 77+
            suitedMin:  [{ high:'A', low:'9' }, { high:'K', low:'T' }, { high:'Q', low:'T' }],
            offsuitMin: [{ high:'A', low:'J' }, { high:'K', low:'Q' }]
        },
        threeBet: {
            pairsMin: 'Q',                               // QQ+
            suitedMin:  [{ high:'A', low:'K' }],         // AKs
            offsuitMin: []
        },
        call: {
            pairsMin: '8',                               // 88-JJ (minus QQ+ in threeBet)
            suitedMin:  [{ high:'A', low:'Q' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'Q' }]
        }
    },
    // MP / 中位 — 开池 ~18%
    middle: {
        open: {
            pairsMin: '5',                               // 55+
            suitedMin:  [{ high:'A', low:'5' }, { high:'K', low:'9' }, { high:'Q', low:'9' }, { high:'J', low:'9' }],
            offsuitMin: [{ high:'A', low:'T' }, { high:'K', low:'J' }, { high:'Q', low:'J' }]
        },
        threeBet: {
            pairsMin: 'J',                               // JJ+
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        },
        call: {
            pairsMin: '6',
            suitedMin:  [{ high:'A', low:'T' }, { high:'K', low:'Q' }, { high:'K', low:'J' }],
            offsuitMin: [{ high:'A', low:'J' }, { high:'K', low:'Q' }]
        }
    },
    // CO / 后位 — 开池 ~30%
    late: {
        open: {
            pairsMin: '2',                               // 22+
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'5' }, { high:'Q', low:'8' },
                         { high:'J', low:'8' }, { high:'T', low:'8' }],
            offsuitMin: [{ high:'A', low:'8' }, { high:'K', low:'9' }, { high:'Q', low:'9' },
                         { high:'J', low:'9' }, { high:'T', low:'9' }]
        },
        threeBet: {
            pairsMin: 'T',                               // TT+
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }, { high:'A', low:'J' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }, { high:'A', low:'Q' }]
        },
        call: {
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'9' }, { high:'Q', low:'9' },
                         { high:'J', low:'9' }, { high:'T', low:'8' }],
            offsuitMin: [{ high:'A', low:'9' }, { high:'K', low:'T' }, { high:'Q', low:'T' }, { high:'J', low:'T' }]
        }
    }
};

// 初始化范围查找表
const PREFLOP_RANGE_LOOKUP = buildRangeLookup();

/** 检查手牌是否在指定位置/动作范围内 */
function isInPreflopRange(handKey, position, action) {
    const posRanges = PREFLOP_RANGE_LOOKUP[position];
    if (!posRanges) return false;
    const range = posRanges[action];
    if (!range) return false;
    return range.has(handKey);
}

/** 获取手牌在范围内的角色：open / threeBet / call / null（不在范围内） */
function getPreflopAction(handKey, position, facingRaise) {
    if (!facingRaise) {
        return isInPreflopRange(handKey, position, 'open') ? 'open' : null;
    }
    // 面对加注：先检查 3-bet，再检查跟注
    if (isInPreflopRange(handKey, position, 'threeBet')) return 'threeBet';
    if (isInPreflopRange(handKey, position, 'call')) return 'call';
    return null;
}


// ==================== 牌桌工具 ====================

/** 创建洗好的 52 张牌 */
function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ rank, suit, rankValue: RANK_VALUES[rank] });
        }
    }
    return shuffle(deck);
}

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** 从牌堆中取 n 张牌 */
function draw(deck, n) {
    return deck.splice(0, n);
}

/** 组合枚举 C(n,k) — 返回所有 k 组合的索引数组 */
function combinations(n, k) {
    const result = [];
    const combo = Array(k).fill(0).map((_,i) => i);
    while (combo[k-1] < n) {
        result.push([...combo]);
        let t = k - 1;
        while (t >= 0 && combo[t] === n - k + t) t--;
        if (t < 0) break;
        combo[t]++;
        for (let i = t + 1; i < k; i++) combo[i] = combo[i-1] + 1;
    }
    return result;
}


// ==================== 牌型判定器 ====================

/**
 * 从 7 张牌中找出最优 5 张牌型
 * 返回 { rank: 0-9, cards: 最优5张, name: 牌型名称, score: 比较用数组 }
 */
function evaluateHand(sevenCards) {
    // 输入可能是5-7张牌（翻后5张、转牌6张、河牌7张）
    const n = sevenCards.length;
    const k = Math.min(5, n);
    const combos = combinations(n, k);
    let best = null;

    for (const indices of combos) {
        const five = indices.map(i => sevenCards[i]);
        const result = scoreFiveCards(five);
        if (!best || compareScores(result.score, best.score) > 0) {
            best = result;
        }
    }

    return {
        rank: best.rank,
        name: HAND_NAMES[best.rank],
        cards: best.cards,
        score: best.score
    };
}

/** 给一手 5 张牌打分，返回 { rank, cards, score } */
function scoreFiveCards(cards) {
    const sorted = [...cards].sort((a,b) => b.rankValue - a.rankValue);
    const ranks = sorted.map(c => c.rankValue);
    const suits = sorted.map(c => c.suit);

    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(ranks);
    const groups = groupByRank(ranks); // { fours:[], threes:[], pairs:[], kickers:[] }

    // 9: 皇家同花顺
    if (isFlush && isStraight && ranks[0] === 14 && ranks[1] === 13) {
        return { rank: 9, cards: sorted, score: [9] };
    }
    // 8: 同花顺
    if (isFlush && isStraight) {
        return { rank: 8, cards: sorted, score: [8, ...getStraightHigh(ranks)] };
    }
    // 7: 四条
    if (groups.fours.length === 1) {
        return { rank: 7, cards: sorted, score: [7, groups.fours[0], groups.kickers[0]] };
    }
    // 6: 葫芦
    if (groups.threes.length === 1 && groups.pairs.length === 1) {
        return { rank: 6, cards: sorted, score: [6, groups.threes[0], groups.pairs[0]] };
    }
    // 5: 同花
    if (isFlush) {
        return { rank: 5, cards: sorted, score: [5, ...ranks] };
    }
    // 4: 顺子
    if (isStraight) {
        return { rank: 4, cards: sorted, score: [4, ...getStraightHigh(ranks)] };
    }
    // 3: 三条
    if (groups.threes.length === 1) {
        return { rank: 3, cards: sorted, score: [3, groups.threes[0], ...groups.kickers] };
    }
    // 2: 两对
    if (groups.pairs.length === 2) {
        const pairRanks = groups.pairs.sort((a,b) => b - a);
        return { rank: 2, cards: sorted, score: [2, ...pairRanks, groups.kickers[0]] };
    }
    // 1: 一对
    if (groups.pairs.length === 1) {
        return { rank: 1, cards: sorted, score: [1, groups.pairs[0], ...groups.kickers] };
    }
    // 0: 高牌
    return { rank: 0, cards: sorted, score: [0, ...ranks] };
}

/** 检测顺子（含 A-2-3-4-5 轮子） */
function checkStraight(ranks) {
    const unique = [...new Set(ranks)].sort((a,b) => b - a);
    if (unique.length < 5) return false;
    // 标准顺子
    if (unique[0] - unique[4] === 4) return true;
    // Wheel: A-2-3-4-5 (unique[0]=14, unique包含 5,4,3,2)
    if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
        return true;
    }
    return false;
}

/** 返回顺子的高点（Wheel 返回 5） */
function getStraightHigh(ranks) {
    const unique = [...new Set(ranks)].sort((a,b) => b - a);
    if (unique[0] === 14 && unique[1] === 5) return [5]; // Wheel
    return [unique[0]];
}

/** 按 rank 分组：四条/三条/对子/踢脚 */
function groupByRank(ranks) {
    const count = {};
    for (const r of ranks) count[r] = (count[r] || 0) + 1;
    const fours = [], threes = [], pairs = [], kickers = [];
    for (const [r, c] of Object.entries(count)) {
        const val = parseInt(r);
        if (c === 4) fours.push(val);
        else if (c === 3) threes.push(val);
        else if (c === 2) pairs.push(val);
        else kickers.push(val);
    }
    kickers.sort((a,b) => b - a);
    return { fours, threes, pairs, kickers };
}

/** 比较两个 score 数组 */
function compareScores(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}


// ==================== 边池计算 ====================

function calculatePots(players) {
    const activePlayers = players.filter(p => !p.isFolded);
    if (activePlayers.length === 0) return [];

    // 每个玩家的总下注额
    const bets = activePlayers.map(p => ({
        player: p,
        total: p.totalBetThisHand
    }));
    bets.sort((a,b) => a.total - b.total);

    const pots = [];
    let prevLevel = 0;

    for (let i = 0; i < bets.length; i++) {
        const level = bets[i].total;
        if (level === prevLevel) continue;

        const contribution = level - prevLevel;
        // 贡献了这一层的玩家 = 总下注额 >= level 的玩家
        const eligible = bets.filter(b => b.total >= level).map(b => b.player);
        const amount = contribution * eligible.length;

        pots.push({
            amount,
            eligiblePlayerIds: eligible.map(p => p.id)
        });

        prevLevel = level;
    }

    return pots;
}

/** 总底池（未分池前的显示用） */
function totalPot(players) {
    return players.reduce((sum, p) => sum + p.totalBetThisHand, 0);
}


// ==================== 玩家工厂 ====================

function createPlayer(id, name, isHuman, aiProfile) {
    return {
        id,
        name,
        isHuman,
        aiProfile: aiProfile || null,
        chips: STARTING_CHIPS,
        handCards: [],
        currentBet: 0,         // 当前这轮下注
        totalBetThisHand: 0,   // 整手牌的总下注
        isFolded: false,
        isAllIn: false,
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        needsToAct: false,
        hasActedThisRound: false,
    };
}


// ==================== 游戏状态机 ====================

class PokerGame {
    constructor() {
        this.players = [];
        this.communityCards = [];
        this.deck = [];
        this.phase = 'idle';        // idle | preflop | flop | turn | river | showdown | hand_over
        this.dealerIndex = -1;
        this.currentPlayerIndex = -1;
        this.bigBlindAmount = BIG_BLIND;
        this.smallBlindAmount = SMALL_BLIND;
        this.currentBetLevel = 0;   // 当前轮最高下注额
        this.minRaise = BIG_BLIND;
        this.preflopRaiserIndex = -1;
        this.raiseCountThisRound = 0;  // 本轮加注次数（防止无限再加注）
        this.handNumber = 0;
        this.message = '';
        this.winners = [];          // showdown 结果
        this.onStateChange = null;  // UI 回调
        this.pendingHumanAction = null; // Promise resolve for human input
        this.eliminatedPlayers = [];
        this.account = null;           // { nickname, stats }
        this.humanStats = null;        // 本局追踪: { folds, raises, calls, startingChips }
    }

    /** 初始化游戏：1 真人 + 8 AI */
    init() {
        this.players = [];
        this.handNumber = 0;
        this.eliminatedPlayers = [];

        // 真人
        this.players.push(createPlayer(0, '你', true, null));

        // 8 个 AI，随机分配性格
        const shuffledPersonalities = shuffle(AI_PERSONALITIES);
        for (let i = 0; i < 8; i++) {
            this.players.push(createPlayer(i + 1, `AI-${i + 1}`, false, shuffledPersonalities[i]));
        }

        // 随机庄位
        this.dealerIndex = Math.floor(Math.random() * 9);
        this.startNewHand();
    }

    /** 开始一手新牌 */
    startNewHand() {
        this.handNumber++;

        // 检查是否有玩家被淘汰（筹码为0）
        const broke = this.players.filter(p => p.chips <= 0 && !this.eliminatedPlayers.includes(p.id));
        for (const p of broke) {
            this.eliminatedPlayers.push(p.id);
            p.chips = 0;
        }

        // 更新盲注级别（掉人后翻倍）
        this.updateBlinds();

        // 重置状态
        this.communityCards = [];
        this.phase = 'preflop';
        this.currentBetLevel = this.bigBlindAmount;
        this.minRaise = this.bigBlindAmount;
        this.preflopRaiserIndex = -1;
        this.raiseCountThisRound = 0;
        this.winners = [];
        this.message = '';
        this.pendingHumanAction = null;

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

        // 如果有人在上一局输光了，跳过（让他们继续坐但无法参与）
        // 实际做法：标记为已淘汰，从牌桌移除
        // 简化处理：已经 eliminated 的玩家不参与，但仍然占据座位（保持9人桌位置）

        // 庄位轮转
        this.dealerIndex = this.nextActivePlayerIndex(this.dealerIndex);

        // 设定盲注位
        const sbIndex = this.nextActivePlayerIndex(this.dealerIndex);
        const bbIndex = this.nextActivePlayerIndex(sbIndex);

        if (this.countActivePlayers() < 2) {
            // 游戏结束——真人要么赢了要么输了
            this.phase = 'game_over';
            this.message = this.players[0].chips > 0 ? '你赢了！所有AI已被淘汰' : '你被淘汰了';
            this.notifyState();
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

        // 扣盲注
        this.postBlind(sbIndex, this.smallBlindAmount);
        this.postBlind(bbIndex, this.bigBlindAmount);

        // 第一个行动的是大盲注之后的人（preflop）
        const firstToAct = this.nextActivePlayerIndex(bbIndex);
        this.currentPlayerIndex = firstToAct;
        this.currentBetLevel = this.bigBlindAmount;

        // 设置所有活跃玩家"待行动"
        for (const p of this.players) {
            if (this.isActive(p)) {
                p.needsToAct = true;
                p.hasActedThisRound = false;
            }
        }

        // 如果当前玩家不是真人，自动推进到真人或本轮结束
        this.initHumanStats();
        // 盲注升级提示
        if (this.blindIncreased) {
            this.message = `⚠️ 盲注升级！${this.smallBlindAmount}/${this.bigBlindAmount} — 剩余 ${9 - this.eliminatedPlayers.length} 人`;
            this.blindIncreased = false;
        } else {
            this.message = '新一局开始！你是' + (this.players[0].isDealer ? '庄家(D)' : (this.players[0].isSmallBlind ? '小盲(SB)' : (this.players[0].isBigBlind ? '大盲(BB)' : '普通位置')));
        }
        this.notifyState();

        // 自动推进直到真人需要行动
        this.autoAdvance();
    }

    /** 扣盲注 */
    postBlind(playerIndex, amount) {
        const p = this.players[playerIndex];
        const actual = Math.min(amount, p.chips);
        p.chips -= actual;
        p.currentBet = actual;
        p.totalBetThisHand = actual;
        if (p.chips === 0) p.isAllIn = true;
    }

    /** 获取下一个活跃玩家的索引（跳过已淘汰和已弃牌的） */
    nextActivePlayerIndex(fromIndex) {
        for (let i = 1; i <= 9; i++) {
            const idx = (fromIndex + i) % 9;
            if (!this.eliminatedPlayers.includes(this.players[idx].id)) {
                return idx;
            }
        }
        return fromIndex;
    }

    /** 获取本轮下一个需要行动的玩家索引 */
    nextPlayerToAct(fromIndex) {
        for (let i = 1; i <= 9; i++) {
            const idx = (fromIndex + i) % 9;
            const p = this.players[idx];
            if (!this.isActive(p)) continue;
            if (p.needsToAct) return idx;
        }
        return -1; // 所有人都行动完了
    }

    /** 玩家是否活跃（未弃牌、未淘汰） */
    isActive(p) {
        return !p.isFolded && !this.eliminatedPlayers.includes(p.id);
    }

    /** 玩家是否还能行动（活跃 + 未All-in） */
    canAct(p) {
        return this.isActive(p) && !p.isAllIn;
    }

    /** 活跃玩家数量 */
    countActivePlayers() {
        return this.players.filter(p => this.isActive(p)).length;
    }

    /** 还能行动的玩家数量 */
    countCanActPlayers() {
        return this.players.filter(p => this.canAct(p)).length;
    }

    // ========== 玩家行动 ==========

    /** 玩家行动入口（供 UI 调用） */
    doAction(playerIndex, action, raiseMultiplier) {
        if (playerIndex !== this.currentPlayerIndex) return false;
        const p = this.players[playerIndex];

        // 追踪真人行动
        if (playerIndex === 0 && this.humanStats) {
            if (action === 'fold') this.humanStats.folds++;
            if (action === 'raise') this.humanStats.raises++;
            if (action === 'call') this.humanStats.calls++;
        }

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

        // 检查本轮是否结束
        if (this.isBettingRoundOver()) {
            this.advancePhase();
        } else {
            // 推进到下一个玩家
            this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
            this.notifyState();
            this.autoAdvance();
        }

        return true;
    }

    doFold(p) {
        p.isFolded = true;
        this.message = `${p.name} 弃牌`;
    }

    doCheck(p) {
        this.message = `${p.name} 过牌`;
    }

    doCall(p) {
        const raw = Math.min(this.currentBetLevel - p.currentBet, p.chips);
        const callAmount = Math.round(raw * 2) / 2;
        p.chips -= callAmount;
        p.currentBet += callAmount;
        p.totalBetThisHand += callAmount;
        if (p.chips <= 0) p.isAllIn = true;
        this.message = `${p.name} 跟注 ${callAmount}`;
    }

    doRaise(p, multiplier) {
        // multiplier 是百分比：1.3=+30%, 1.5=+50%, 自定义值
        const rawTarget = this.currentBetLevel * multiplier;
        // 四舍五入到 0.5
        const raiseTo = Math.max(
            Math.round(rawTarget * 2) / 2,
            this.currentBetLevel + this.minRaise
        );
        const needed = raiseTo - p.currentBet;
        const additional = Math.round(Math.min(needed, p.chips) * 2) / 2;
        p.chips -= additional;
        p.currentBet += additional;
        p.totalBetThisHand += additional;
        this.currentBetLevel = p.currentBet;
        if (this.phase === 'preflop') this.preflopRaiserIndex = p.id;
        if (p.chips <= 0) p.isAllIn = true;

        // 递增本轮加注计数
        this.raiseCountThisRound++;

        // 有人加注 → 所有其他活跃玩家需要重新行动
        for (const other of this.players) {
            if (other.id !== p.id && this.isActive(other) && !other.isAllIn) {
                other.needsToAct = true;
                other.hasActedThisRound = false;
            }
        }

        const pct = Math.round((multiplier - 1) * 100);
        this.message = `${p.name} 加注到 ${p.currentBet}（+${pct}%）`;
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
            // All-in 作为加注 → 其他人需要响应
            for (const other of this.players) {
                if (other.id !== p.id && this.isActive(other) && !other.isAllIn) {
                    other.needsToAct = true;
                    other.hasActedThisRound = false;
                }
            }
        }
        this.message = `${p.name} All-in! (${amount})`;
    }

    /** 本轮下注是否结束 */
    isBettingRoundOver() {
        // 如果只剩一个活跃玩家（其他全弃牌）→ 立即结束
        if (this.countActivePlayers() === 1) return true;

        // 如果所有非All-in的活跃玩家都已行动且下注持平
        const canActPlayers = this.players.filter(p => this.canAct(p) && this.isActive(p));
        if (canActPlayers.length === 0) return true; // 全部All-in了

        // 所有能行动的玩家都不需要再行动了
        const needAction = this.players.filter(p => this.isActive(p) && p.needsToAct);
        if (needAction.length === 0) return true;

        return false;
    }

    /** 推进到下一阶段 */
    advancePhase() {
        // 所有人在当前轮的行动都已完成 → 重置每轮下注
        for (const p of this.players) {
            p.currentBet = 0;
            p.needsToAct = true;
            p.hasActedThisRound = false;
        }
        this.currentBetLevel = 0;
        this.minRaise = this.bigBlindAmount;
        this.raiseCountThisRound = 0;

        // 如果只剩一个活跃玩家 → 发完公共牌再结束
        if (this.countActivePlayers() === 1) {
            const winner = this.players.find(p => this.isActive(p));
            // 补发剩余公共牌（让玩家看到完整牌面）
            const cardsNeeded = 5 - this.communityCards.length;
            if (cardsNeeded > 0 && this.deck.length >= cardsNeeded) {
                this.communityCards.push(...draw(this.deck, cardsNeeded));
            }
            this.phase = 'hand_over';
            const pot = totalPot(this.players);
            winner.chips += pot;
            this.winners = [{ player: winner, hand: null, pot }];
            this.message = `${winner.name} 获胜！所有人弃牌，赢得 ${pot} 积分`;
            this.recordHandResult(winner.isHuman, pot);
            this.notifyState();
            return;
        }

        switch (this.phase) {
            case 'preflop':
                this.phase = 'flop';
                this.communityCards.push(...draw(this.deck, 3));
                // 如果只剩All-in玩家或无人在意 → 直接跳到摊牌
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

        // 确定发牌后第一个行动的人（庄家之后第一个活跃非弃牌玩家）
        const firstToAct = this.nextActivePlayerIndex(this.dealerIndex);

        // 如果所有非All-in玩家都是All-in → 直接翻完所有牌
        if (this.countCanActPlayers() === 0) {
            // 快速翻完所有公共牌
            while (this.phase !== 'showdown' && this.phase !== 'hand_over') {
                const cardsNeeded = this.phase === 'preflop' ? 3 : (this.phase === 'flop' || this.phase === 'turn' ? 1 : 0);
                if (cardsNeeded > 0) {
                    this.communityCards.push(...draw(this.deck, cardsNeeded));
                }
                const nextPhase = { preflop:'flop', flop:'turn', turn:'river', river:'showdown' };
                this.phase = nextPhase[this.phase];
                if (this.phase === 'showdown') {
                    this.doShowdown();
                    return;
                }
            }
        }

        this.currentPlayerIndex = firstToAct;
        this.notifyState();
        this.autoAdvance();
    }

    /** 摊牌比大小 */
    doShowdown() {
        this.phase = 'showdown';
        const activePlayers = this.players.filter(p => this.isActive(p));
        const pots = calculatePots(this.players);
        const results = []; // [{player, hand, potShare}]

        // 如果只有一个活跃玩家 → 直接拿所有底池
        if (activePlayers.length === 1) {
            const total = totalPot(this.players);
            activePlayers[0].chips += total;
            this.winners = [{ player: activePlayers[0], hand: null, pot: total }];
            this.phase = 'hand_over';
            this.message = `${activePlayers[0].name} 获胜！赢得 ${total} 积分`;
            this.recordHandResult(activePlayers[0].isHuman, total);
            this.notifyState();
            return;
        }

        // 评估每个活跃玩家的手牌
        const evaluations = {};
        for (const p of activePlayers) {
            if (p.handCards.length === 2) {
                const all7 = [...p.handCards, ...this.communityCards];
                if (all7.length >= 5) {
                    evaluations[p.id] = evaluateHand(all7);
                }
            }
        }

        // 分配每个边池
        const totalWon = {};
        for (const pot of pots) {
            // 找出这个池的赢家
            const eligible = pot.eligiblePlayerIds
                .map(id => this.players.find(p => p.id === id))
                .filter(p => p && this.isActive(p) && evaluations[p.id]);

            if (eligible.length === 0) continue;
            if (eligible.length === 1) {
                // 只有一个人有资格 → 直接拿
                eligible[0].chips += pot.amount;
                totalWon[eligible[0].id] = (totalWon[eligible[0].id] || 0) + pot.amount;
                continue;
            }

            // 多人比较 → 找牌型最好的
            let bestPlayers = [eligible[0]];
            let bestScore = evaluations[eligible[0].id].score;

            for (let i = 1; i < eligible.length; i++) {
                const score = evaluations[eligible[i].id].score;
                const cmp = compareScores(score, bestScore);
                if (cmp > 0) {
                    bestPlayers = [eligible[i]];
                    bestScore = score;
                } else if (cmp === 0) {
                    bestPlayers.push(eligible[i]);
                }
            }

            // 平分
            const share = Math.floor(pot.amount / bestPlayers.length);
            const remainder = pot.amount - share * bestPlayers.length;

            for (let i = 0; i < bestPlayers.length; i++) {
                const win = share + (i === 0 ? remainder : 0);
                bestPlayers[i].chips += win;
                totalWon[bestPlayers[i].id] = (totalWon[bestPlayers[i].id] || 0) + win;
            }
        }

        // 组装结果
        this.winners = [];
        for (const [id, amount] of Object.entries(totalWon)) {
            const player = this.players.find(p => p.id === parseInt(id));
            this.winners.push({
                player,
                hand: evaluations[player.id] || null,
                pot: amount
            });
        }

        // 输家也显示手牌（用于学习）
        for (const p of activePlayers) {
            if (!totalWon[p.id]) {
                this.winners.push({
                    player: p,
                    hand: evaluations[p.id] || null,
                    pot: 0
                });
            }
        }

        this.phase = 'hand_over';
        const winSummary = this.winners
            .filter(w => w.pot > 0)
            .map(w => `${w.player.name} (+${w.pot}) ${w.hand ? w.hand.name : ''}`)
            .join(' / ');
        this.message = winSummary || '摊牌完成';
        const humanWon = totalWon[0] > 0;
        this.recordHandResult(humanWon, totalWon[0] || 0);
        this.notifyState();
    }

    // ========== AI 辅助方法 ==========

    /** 判断玩家在当前活跃玩家中的位置（从庄家顺时针计算） */
    getPositionContext(player) {
        let positionInOrder = -1;
        let totalActive = 0;
        for (let i = 1; i <= 9; i++) {
            const idx = (this.dealerIndex + i) % 9;
            const p = this.players[idx];
            if (!this.isActive(p)) continue;
            totalActive++;
            if (p.id === player.id) positionInOrder = totalActive;
        }
        if (totalActive <= 2) return 'late';
        const ratio = positionInOrder / totalActive;
        if (ratio >= 0.75) return 'late';
        if (ratio >= 0.35) return 'middle';
        return 'early';
    }

    /** 分析牌面结构（含 GTO 牌面分类） */
    analyzeBoard() {
        if (this.communityCards.length === 0) {
            return { scary: false, paired: false, flushPossible: false, straightPossible: false,
                     highCards: 0, category: 'dry', avgRank: 0, connectivity: 0 };
        }
        const board = this.communityCards;
        const ranks = board.map(c => c.rankValue);
        const suits = board.map(c => c.suit);

        const rankCounts = {};
        ranks.forEach(r => { rankCounts[r] = (rankCounts[r] || 0) + 1; });
        const paired = Object.values(rankCounts).some(c => c >= 2);

        const suitCounts = {};
        suits.forEach(s => { suitCounts[s] = (suitCounts[s] || 0) + 1; });
        const flushPossible = Object.values(suitCounts).some(c => c >= 3);

        const uniqueRanks = [...new Set(ranks)].sort((a, b) => a - b);
        let straightPossible = false;
        for (let i = 0; i + 2 < uniqueRanks.length; i++) {
            if (uniqueRanks[i + 2] - uniqueRanks[i] <= 4) { straightPossible = true; break; }
        }
        if (!straightPossible && uniqueRanks.includes(14) && uniqueRanks.some(r => r >= 2 && r <= 5)) {
            straightPossible = true;
        }
        const highCards = ranks.filter(r => r >= 10).length;
        const scary = highCards >= 2 && (flushPossible || straightPossible || paired);

        // === GTO 扩展 ===
        const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;

        let connectivity = 0;
        if (uniqueRanks.length >= 2) {
            let closeGaps = 0;
            for (let i = 1; i < uniqueRanks.length; i++) {
                if (uniqueRanks[i] - uniqueRanks[i - 1] <= 2) closeGaps++;
            }
            connectivity = closeGaps / (uniqueRanks.length - 1);
        }

        // 牌面分类: dry / medium / wet / made
        const drawCount = (flushPossible ? 1 : 0) + (straightPossible ? 1 : 0);
        const flushMade = Object.values(suitCounts).some(c => c >= 4);
        const straightMade = uniqueRanks.length >= 5 &&
            uniqueRanks.some((_, i) => i + 4 < uniqueRanks.length && uniqueRanks[i + 4] - uniqueRanks[i] === 4);

        let category = 'medium';
        if (flushMade || straightMade) {
            category = 'made';
        } else if (drawCount >= 2 || (paired && drawCount >= 1)) {
            category = 'wet';
        } else if (drawCount === 0 && !paired && highCards <= 1) {
            category = 'dry';
        }

        return { scary, paired, flushPossible, straightPossible, highCards,
                 category, avgRank, connectivity };
    }

    /** 分析筹码相对位置 */
    analyzeStacks(player) {
        const activePlayers = this.players.filter(p => this.isActive(p));
        const stacks = activePlayers.map(p => p.chips);
        const avgStack = stacks.reduce((a, b) => a + b, 0) / (stacks.length || 1);
        const stackRatio = player.chips / (avgStack || 1);
        const isBigStack = stackRatio > 1.5;
        const targetsShortStack = activePlayers.some(p => p.id !== player.id && p.chips < avgStack * 0.5);
        return { isBigStack, avgStack, stackRatio, targetsShortStack };
    }

    // ========== GTO 策略方法 ==========

    /** 计算 MDF（最低防守频率）：面对下注时需防守的范围比例 */
    calculateMDF() {
        const pot = totalPot(this.players);
        const toCall = this.currentBetLevel;
        if (toCall <= 0) return 1.0;
        const mdf = pot / (pot + toCall);
        // 下限极低：巨大超池下注时 MDF 可降至 5%（不再强制 25%）
        return Math.min(0.9, Math.max(0.05, mdf));
    }

    /** 计算下注与底池的比例（用于判断是否超池下注） */
    getBetPotRatio() {
        const pot = totalPot(this.players);
        if (pot <= 0) return 1;
        return this.currentBetLevel / pot;
    }

    /** 计算范围优势：+1=AI有优势，0=中性，-1=对手有优势 */
    getRangeAdvantage(player) {
        if (this.communityCards.length === 0) return 0;
        const board = this.analyzeBoard();
        const isAggressor = this.preflopRaiserIndex === player.id;
        let advantage = 0;

        if (isAggressor) {
            if (board.highCards >= 2) advantage += 0.25;
            if (board.highCards >= 1 && !board.straightPossible) advantage += 0.15;
            if (board.paired && board.highCards >= 1) advantage += 0.15;
            if (board.straightPossible && board.highCards === 0) advantage -= 0.20;
            if (board.connectivity > 0.6 && board.avgRank < 7) advantage -= 0.15;
        } else {
            if (board.straightPossible && board.highCards <= 1) advantage += 0.20;
            if (board.connectivity > 0.6 && board.avgRank < 8) advantage += 0.15;
            if (board.highCards >= 2 && !board.flushPossible && !board.straightPossible) advantage -= 0.25;
        }

        return Math.max(-1, Math.min(1, advantage));
    }

    /** GTO 下注尺度选择：牌面类型 + 人格 + 行动场景 */
    pickGTOMultiplier(profile, board, situation) {
        // 基于牌面类型的基础乘数
        let base;
        switch (board ? board.category : 'medium') {
            case 'dry':    base = 1.25; break;
            case 'medium': base = 1.45; break;
            case 'wet':    base = 1.70; break;
            case 'made':   base = 2.00; break;
            default:       base = 1.45;
        }

        // 行动场景微调
        if (situation === 'steal') base = Math.min(base, 1.35);
        if (situation === 'cbet')  base = Math.max(base, 1.30);

        // 人格偏移
        const rand = Math.random();
        if (profile.aggression > 0.40) {
            base *= rand < 0.38 ? 1.0 : (rand < 0.68 ? 1.15 : 1.35);
        } else if (profile.aggression > 0.30) {
            base *= rand < 0.55 ? 1.0 : 1.18;
        } else {
            base *= rand < 0.60 ? 1.0 : 1.12;
        }

        return Math.round(base * 20) / 20; // 四舍五入到 0.05
    }

    /** 评估听牌潜力：花听/两头顺/卡顺，返回 0~0.12 bonus */
    evaluateDrawPotential(player) {
        if (this.communityCards.length < 3) return 0;
        if (player.handCards.length < 2) return 0;
        const allCards = [...player.handCards, ...this.communityCards];

        const suitCounts = {};
        allCards.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
        let flushDrawBonus = 0;
        for (const count of Object.values(suitCounts)) {
            if (count >= 4) { flushDrawBonus = 0.12; break; }
        }

        const ranks = [...new Set(allCards.map(c => c.rankValue))].sort((a, b) => a - b);
        let straightDrawBonus = 0;
        for (let i = 0; i + 3 < ranks.length; i++) {
            if (ranks[i + 3] - ranks[i] === 3) { straightDrawBonus = 0.10; break; }
        }
        if (straightDrawBonus === 0) {
            for (let i = 0; i + 3 < ranks.length; i++) {
                if (ranks[i + 3] - ranks[i] === 4) {
                    const sub = ranks.slice(i, i + 4);
                    let gaps = 0;
                    for (let j = 1; j < sub.length; j++) {
                        if (sub[j] - sub[j - 1] > 1) gaps++;
                    }
                    if (gaps === 1) { straightDrawBonus = 0.06; break; }
                }
            }
        }
        if (straightDrawBonus === 0 && ranks.includes(14)) {
            const wheelCards = ranks.filter(r => r >= 2 && r <= 5);
            if (wheelCards.length >= 3) straightDrawBonus = 0.08;
        }

        return Math.max(flushDrawBonus, straightDrawBonus);
    }

    // ========== 翻前 GTO 范围决策 ==========

    /** 基于 GTO 范围表的翻前决策（仅翻前调用） */
    preflopRangeDecision(player, position, isCheckedToMe, profile, stacks, board) {
        const handKey = handFromCards(player.handCards[0], player.handCards[1]);
        const toCall = this.currentBetLevel - player.currentBet;

        // 确定位置对应的范围键
        let rangePos = position; // early / middle / late

        // 人数少时位置放宽
        const activeCount = this.countActivePlayers();
        if (activeCount <= 3) rangePos = 'late';
        else if (activeCount <= 5 && position === 'middle') rangePos = 'late';

        const raiseCount = this.raiseCountThisRound;
        const facingRaise = !isCheckedToMe;

        // ===== 场景1: 无人加注（checked to me）→ 开池或过牌 =====
        if (!facingRaise) {
            // 已有 ≥1 次加注后又回到我 → 过牌（不应再加注）
            if (raiseCount >= 1) {
                return { action: 'check' };
            }

            // 在开池范围内 → 加注开池
            if (isInPreflopRange(handKey, rangePos, 'open')) {
                // 高手偶尔用标准尺度开池，娱乐型偏好小额
                const agg = profile.aggression;
                let multiplier;
                if (agg > 0.45)      multiplier = 1.0 + Math.random() * 0.3;  // 1.0-1.3x pot
                else if (agg > 0.30) multiplier = 1.0 + Math.random() * 0.2;  // 1.0-1.2x pot
                else                 multiplier = 1.0;                          // min raise

                const raiseTo = Math.floor(this.currentBetLevel * multiplier);
                if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) {
                    return { action: 'raise', multiplier };
                }
                return { action: 'call' };
            }

            // 不在开池范围 → 过牌（如果免费）或弃牌
            return isCheckedToMe ? { action: 'check' } : { action: 'fold' };
        }

        // ===== 场景2: 面对加注 → 3-bet / 跟注 / 弃牌 =====

        // ≥3 次加注后：只需要考虑全下或弃牌（4-bet+ 范围极紧）
        if (raiseCount >= 3) {
            if (isInPreflopRange(handKey, rangePos, 'threeBet') && player.chips > 0) {
                if (Math.random() < 0.7) return { action: 'allin' };
                return { action: 'call' };
            }
            return { action: 'fold' };
        }

        // 面对首次或第二次加注
        if (isInPreflopRange(handKey, rangePos, 'threeBet')) {
            // 在 3-bet 范围内 → 再加注
            const multiplier = 1.3 + Math.random() * 0.3; // 1.3-1.6x
            const raiseTo = Math.floor(this.currentBetLevel * multiplier);
            if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) {
                return { action: 'raise', multiplier };
            }
            return { action: 'call' };
        }

        if (isInPreflopRange(handKey, rangePos, 'call')) {
            // 在跟注范围内 → 跟注（高手偶尔半诈唬加注）
            if (profile.aggression > 0.40 && Math.random() < 0.15 && raiseCount < 2) {
                const multiplier = 1.3 + Math.random() * 0.2;
                const raiseTo = Math.floor(this.currentBetLevel * multiplier);
                if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) {
                    return { action: 'raise', multiplier };
                }
            }
            if (toCall <= player.chips) return { action: 'call' };
            if (Math.random() < 0.5) return { action: 'allin' };
            return { action: 'fold' };
        }

        // 不在任何范围内 → 弃牌（娱乐型偶尔跟注看牌）
        if (profile.tightness > 0.60 && Math.random() < 0.12 && this.raiseCountThisRound === 0) {
            if (toCall <= player.chips * 0.3) return { action: 'call' };
        }

        return { action: 'fold' };
    }

    // ========== AI 决策 ==========

    aiDecide(player) {
        const profile = player.aiProfile;
        const hand = player.handCards;

        // ===== 1. 上下文采集 =====
        const position = this.getPositionContext(player);
        const board = this.analyzeBoard();
        const stacks = this.analyzeStacks(player);
        const drawBonus = this.evaluateDrawPotential(player);

        // ===== 2. 下注上下文 =====
        const toCall = this.currentBetLevel - player.currentBet;
        const potAfterCall = totalPot(this.players) + toCall;
        const potOdds = toCall > 0 ? toCall / (potAfterCall || 1) : 0;
        const isCheckedToMe = toCall === 0;
        const isPreflop = this.communityCards.length === 0;

        // ===== 3. 翻前：GTO 范围表决策（直接返回，不进入翻后引擎） =====
        if (isPreflop) {
            return this.preflopRangeDecision(player, position, isCheckedToMe, profile, stacks, board);
        }

        // ===== 4. 翻后：手牌强度评估 =====
        const all7 = [...hand, ...this.communityCards];
        const handStrength = all7.length >= 5 ? evaluateHand(all7).rank / 9 : 0.3;
        const positionBonus = position === 'late' ? 0.04 : (position === 'middle' ? 0.02 : 0);
        let effectiveStrength = Math.min(1.0, handStrength + positionBonus + drawBonus);

        // GTO: MDF 最低防守频率 + 范围优势
        const mdf = this.calculateMDF();
        const rangeAdv = this.getRangeAdvantage(player);
        const mdfFoldThreshold = (1 - mdf) * 0.7;           // GTO 基线
        const personalityFoldShift = (profile.tightness - 0.5) * 0.3; // 人格偏移
        const gtoFoldThreshold = Math.max(0.10, Math.min(0.65, mdfFoldThreshold + personalityFoldShift));

        // 范围优势调整加注阈值
        const rangeBoost = rangeAdv * 0.06; // 有优势时降低 thresholds，无优势时升高

        // 超池下注保护：面对巨大超池下注时大幅提高弃牌门槛
        const betPotRatio = this.getBetPotRatio();
        const isMassiveOverbet = betPotRatio > 3;    // 下注超过底池3倍
        const overbetPenalty = isMassiveOverbet ? Math.min(0.4, (betPotRatio - 3) * 0.06) : 0;

        // 加注次数上限：本轮已加注 ≥5 次 → 禁止 AI 再加注
        const raiseCapped = this.raiseCountThisRound >= 5;

        // ===== 4. 特殊策略（按优先级排列） =====

        // 4a. 筹码霸凌
        if (!raiseCapped && stacks.isBigStack && stacks.targetsShortStack && !isCheckedToMe && effectiveStrength > 0.3) {
            if (Math.random() < profile.aggression * 0.5) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bully') };
            }
        }

        // 4b. 偷盲/偷底：干燥牌面更好偷
        if (!raiseCapped && position === 'late' && isCheckedToMe && effectiveStrength > 0.25) {
            const dryBonus = board.category === 'dry' ? 0.15 : 0;
            const stealChance = profile.aggression * 0.6 + (stacks.isBigStack ? 0.2 : 0) + dryBonus;
            if (Math.random() < stealChance) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'steal') };
            }
        }

        // 4c. 持续下注(C-bet)：范围优势调整频率
        if (this.preflopRaiserIndex === player.id &&
            this.phase === 'flop' &&
            isCheckedToMe &&
            this.communityCards.length === 3) {
            const cbetBase = profile.aggression * 0.8;
            const cbetChance = cbetBase + rangeAdv * 0.25; // 有优势多c-bet，无优势少c-bet
            if (Math.random() < Math.max(0.15, Math.min(0.95, cbetChance))) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'cbet') };
            }
        }

        // 4d. 陷阱/慢打
        const trapChance = board.scary ? 0.08 : 0.22;
        const isTrapping = effectiveStrength > 0.8 &&
                           Math.random() < trapChance &&
                           isCheckedToMe;

        // 4e. 半诈唬
        if (!raiseCapped && drawBonus > 0.05 && position !== 'early' && isCheckedToMe && effectiveStrength > 0.3) {
            const semiBluffChance = profile.aggression * 0.5 + (board.category === 'wet' ? 0.1 : 0);
            if (Math.random() < semiBluffChance) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'semibluff') };
            }
        }

        // 4f. 情景化诈唬：干燥面也适合诈唬（牌面没帮到对手）
        if (!raiseCapped && isCheckedToMe && effectiveStrength < 0.5) {
            const boardBluffBonus = board.category === 'dry' ? 1.2 : (board.scary ? 1.5 : 1.0);
            const bluffMultiplier = boardBluffBonus * (position === 'late' ? 1.3 : 1.0);
            if (Math.random() < profile.bluff * bluffMultiplier) {
                if (player.chips > this.currentBetLevel * 2 + BIG_BLIND) {
                    return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bluff') };
                }
            }
        }

        // 需要跟注时的诈唬加注（超池下注时禁用——诈唬成本太高）
        if (!raiseCapped && !isCheckedToMe && effectiveStrength < 0.35 && toCall > 0 && !isMassiveOverbet) {
            const bluffVsBet = profile.bluff * (board.scary ? 1.3 : 1.0);
            if (Math.random() < bluffVsBet && player.chips > toCall * 3) {
                return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bluffraise') };
            }
        }

        // 慢打
        if (isTrapping) {
            return { action: 'check' };
        }

        // ===== 5. 动态阈值（翻后 GTO 增强 + 超池保护） =====
        const foldThreshold  = Math.min(gtoFoldThreshold, profile.tightness * 0.55) + overbetPenalty;
        const betThreshold   = Math.max(0.22, (0.38 - profile.aggression * 0.12) - rangeBoost);
        const raiseThreshold = Math.max(0.40,
            (0.72 - profile.aggression * 0.28) - rangeBoost + this.raiseCountThisRound * 0.08);

        // ===== 6. 核心决策（混合策略边界） =====
        const margin = 0.06; // 混合区间宽度

        // 手牌弱 → 考虑弃牌（MDF 提供"再次考虑跟注"的机会）
        if (effectiveStrength < foldThreshold && toCall > 0) {
            // MDF 防守：超池下注时禁用
            if (!isMassiveOverbet && effectiveStrength > gtoFoldThreshold && Math.random() < 0.35) {
                return { action: 'call' };
            }
            if (potOdds < 0.18 && effectiveStrength > foldThreshold * 0.55) {
                return { action: 'call' };
            }
            if (toCall === 0) return { action: 'check' };
            return { action: 'fold' };
        }

        // 手牌强 → 加注（混合策略：在阈值附近按概率加注）
        if (effectiveStrength > raiseThreshold && !isTrapping && !raiseCapped) {
            // 混合区：raiseThreshold ~ raiseThreshold+margin 之间，概率性加注
            if (effectiveStrength < raiseThreshold + margin) {
                const raiseProb = (effectiveStrength - raiseThreshold) / margin;
                if (Math.random() > raiseProb) {
                    // 改为跟注而非加注
                    if (isCheckedToMe) return { action: 'check' };
                    if (toCall <= player.chips) return { action: 'call' };
                }
            }
            const multiplier = this.pickGTOMultiplier(profile, board, 'value');
            const raiseTo = Math.floor(this.currentBetLevel * multiplier);
            if (raiseTo <= player.chips && raiseTo > this.currentBetLevel) {
                return { action: 'raise', multiplier };
            }
            if (effectiveStrength > 0.7 && player.chips > 0) {
                return { action: 'allin' };
            }
        }

        // 被过牌 + 中等牌力 → 主动下注
        if (!raiseCapped && isCheckedToMe && effectiveStrength > betThreshold && !isTrapping) {
            // 混合策略边界
            if (effectiveStrength < betThreshold + margin && Math.random() < 0.5) {
                return { action: 'check' };
            }
            return { action: 'raise', multiplier: this.pickGTOMultiplier(profile, board, 'bet') };
        }

        // 免费看牌
        if (isCheckedToMe) {
            return { action: 'check' };
        }

        // 需要跟注 → 混合策略：fold/call 边界
        if (toCall <= player.chips) {
            // 在 foldThreshold 附近的混合区，偶尔弃牌
            if (effectiveStrength < foldThreshold + margin * 2 && effectiveStrength >= foldThreshold) {
                if (Math.random() < 0.15) return { action: 'fold' };
            }
            if (toCall > player.chips * 0.5 && effectiveStrength > 0.5) {
                return { action: 'allin' };
            }
            return { action: 'call' };
        }

        // 跟不起
        if (effectiveStrength > 0.55) {
            return { action: 'allin' };
        }
        return { action: 'fold' };
    }

    /** 翻牌前手牌强度评估（简化 Chen 公式） */
    evaluatePreflop(hand) {
        const [c1, c2] = hand;
        const high = Math.max(c1.rankValue, c2.rankValue);
        const low = Math.min(c1.rankValue, c2.rankValue);
        const gap = high - low;
        const suited = c1.suit === c2.suit;
        const isPair = c1.rank === c2.rank;

        // 基于 Sklansky 分组的简化评分
        let score;

        if (isPair) {
            score = (high - 1) / 14 + 0.15; // AA ≈ 0.98, 22 ≈ 0.15
        } else {
            // 高分牌
            const highScore = (high - 1) / 14;
            const gapPenalty = gap * 0.04;
            const suitedBonus = suited ? 0.08 : 0;
            score = highScore * 0.65 + (low / 14) * 0.25 - gapPenalty + suitedBonus;
            score = Math.max(0.05, Math.min(0.9, score));
        }

        return score;
    }

    // 向后兼容：委托给 GTO 版本
    pickRaiseMultiplier(profile) {
        return this.pickGTOMultiplier(profile, null, 'default');
    }

    // ========== 自动推进 ==========

    autoAdvance() {
        // 使用 setTimeout 递归，让UI有时间更新
        const step = () => {
            if (this.phase === 'hand_over' || this.phase === 'idle' || this.phase === 'game_over') return;

            // 如果当前玩家不是真人 → AI自动行动
            const current = this.players[this.currentPlayerIndex];
            if (!current || !this.isActive(current)) {
                // 跳过，找下一个
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
                        // doAction 内部已处理 notifyState + autoAdvance
                        this.doAction(this.currentPlayerIndex, decision.action, decision.multiplier);
                    }, 400 + Math.random() * 800);
                } else {
                    // AI 已All-in或不需要行动 → 标记完成，跳过
                    current.needsToAct = false;
                    current.hasActedThisRound = true;
                    if (this.isBettingRoundOver()) {
                        this.advancePhase();
                        // advancePhase 内部已处理 notifyState + autoAdvance
                    } else {
                        this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                        this.notifyState();
                        setTimeout(() => this.autoAdvance(), 200);
                    }
                }
            } else if (current.isHuman && this.isActive(current)) {
                // 真人 → 等待UI输入
                if (current.isAllIn || !current.needsToAct) {
                    current.needsToAct = false;
                    current.hasActedThisRound = true;
                    if (this.isBettingRoundOver()) {
                        this.advancePhase();
                        // advancePhase 内部已处理 notifyState + autoAdvance
                    } else {
                        this.currentPlayerIndex = this.nextPlayerToAct(this.currentPlayerIndex);
                        this.notifyState();
                        setTimeout(() => this.autoAdvance(), 200);
                    }
                } else {
                    // 真人的回合，等待
                    this.message = '等待你的行动...';
                    this.notifyState();
                }
            }
        };

        setTimeout(step, 300);
    }

    // ========== UI 通信 ==========

    /** 获取当前游戏状态快照 */
    getState() {
        const human = this.players[0];
        const isHumanTurn = this.phase !== 'hand_over' &&
                            this.phase !== 'idle' &&
                            this.phase !== 'game_over' &&
                            this.currentPlayerIndex === 0 &&
                            human.needsToAct &&
                            this.isActive(human) &&
                            !human.isAllIn;

        // 计算可用的行动选项
        let availableActions = [];
        if (isHumanTurn) {
            const toCall = this.currentBetLevel - human.currentBet;
            if (toCall === 0) {
                availableActions = ['fold', 'check', 'raise_30', 'raise_50', 'raise_custom', 'allin'];
            } else if (toCall >= human.chips) {
                availableActions = ['fold', 'allin'];
            } else {
                availableActions = ['fold', 'call'];
                availableActions.push('raise_30');
                availableActions.push('raise_50');
                availableActions.push('raise_custom');
                availableActions.push('allin');
            }
        }

        return {
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                chips: p.chips,
                handCards: p.isHuman ? p.handCards : (this.phase === 'hand_over' || this.phase === 'showdown' ? p.handCards : []),
                currentBet: p.currentBet,
                totalBetThisHand: p.totalBetThisHand,
                isFolded: p.isFolded,
                isAllIn: p.isAllIn,
                isHuman: p.isHuman,
                isDealer: p.isDealer,
                isSmallBlind: p.isSmallBlind,
                isBigBlind: p.isBigBlind,
                isActive: this.isActive(p),
                isEliminated: this.eliminatedPlayers.includes(p.id),
                aiType: p.aiProfile ? p.aiProfile.desc : null,
            })),
            communityCards: this.communityCards,
            pot: totalPot(this.players),
            phase: this.phase,
            message: this.message,
            isHumanTurn,
            availableActions,
            handNumber: this.handNumber,
            winners: this.winners.map(w => ({
                name: w.player.name,
                isHuman: w.player.isHuman,
                handName: w.hand ? w.hand.name : null,
                handCards: w.player.handCards,
                pot: w.pot,
            })),
            isGameOver: this.phase === 'game_over',
            humanChips: this.players[0].chips,
            humanHand: this.players[0].handCards,
            smallBlind: this.smallBlindAmount,
            bigBlind: this.bigBlindAmount,
        };
    }

    notifyState() {
        if (this.phase !== 'idle' && this.phase !== 'game_over' && this.phase !== 'hand_over') {
            PokerGame.saveGame(this);
        }
        if (this.onStateChange) {
            this.onStateChange(this.getState());
        }
    }

    /** 真人行动（供 UI 按钮调用） */
    humanAction(action, multiplier) {
        if (this.currentPlayerIndex !== 0) return;
        if (!this.players[0].needsToAct) return;
        this.doAction(0, action, multiplier);
        // doAction 内部已调用 notifyState + autoAdvance，这里不重复调用
    }

    /** 开始下一局 */
    nextHand() {
        if (this.phase !== 'hand_over') return;
        this.startNewHand();
    }

    /** 根据淘汰人数更新盲注级别 */
    updateBlinds() {
        const eliminated = this.eliminatedPlayers.length;
        // 前2人出局不翻倍，第3人开始每次翻倍
        const levels = Math.max(0, eliminated - 2);
        const multiplier = Math.pow(2, levels);
        const oldBig = this.bigBlindAmount;
        this.smallBlindAmount = SMALL_BLIND * multiplier;
        this.bigBlindAmount  = BIG_BLIND * multiplier;
        if (this.bigBlindAmount !== oldBig && this.handNumber > 1) {
            this.blindIncreased = true;
        }
    }

    // ========== 战绩追踪 & 本地存档 ==========

    /** 记录一手牌的结果 */
    recordHandResult(humanWon, potAmount) {
        if (!this.account) return;
        const s = this.account.stats;
        s.totalHands++;
        if (humanWon) {
            s.handsWon++;
            s.profit += (potAmount || 0);
            s.biggestPot = Math.max(s.biggestPot, potAmount || 0);
        } else {
            s.handsLost++;
            const lost = this.humanStats ? (this.humanStats.startingChips - this.players[0].chips) : 0;
            s.profit -= Math.max(0, lost);
        }
        // 记录行动统计
        if (this.humanStats) {
            s.totalFolds  += this.humanStats.folds;
            s.totalRaises += this.humanStats.raises;
            s.totalCalls  += this.humanStats.calls;
        }
        // 更新胜率百分比
        s.winRate = s.totalHands > 0 ? Math.round((s.handsWon / s.totalHands) * 100) : 0;
        // 保存战绩
        PokerGame.saveAccount(this.account);
    }

    /** 初始化本局人类追踪 */
    initHumanStats() {
        this.humanStats = {
            folds: 0, raises: 0, calls: 0,
            startingChips: this.players[0].chips
        };
    }

    /** 设置账号昵称 */
    setNickname(name) {
        this.account = PokerGame.loadAccount() || {
            nickname: name,
            stats: {
                totalHands: 0, handsWon: 0, handsLost: 0,
                profit: 0, biggestPot: 0, winRate: 0,
                totalFolds: 0, totalRaises: 0, totalCalls: 0
            }
        };
        this.account.nickname = name;
        PokerGame.saveAccount(this.account);
    }

    // ===== 静态存储方法 =====

    static saveAccount(account) {
        try { localStorage.setItem('pt_account', JSON.stringify(account)); } catch(e) {}
    }

    static loadAccount() {
        try {
            const raw = localStorage.getItem('pt_account');
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    }

    static saveGame(game) {
        try {
            const save = {
                timestamp: Date.now(),
                handNumber: game.handNumber,
                phase: game.phase,
                players: game.players.map(p => ({
                    id: p.id, name: p.name, isHuman: p.isHuman,
                    chips: p.chips, isEliminated: game.eliminatedPlayers.includes(p.id),
                    aiProfile: p.aiProfile
                })),
                dealerIndex: game.dealerIndex,
                handCards: game.players.map(p => p.handCards),
                communityCards: game.communityCards,
                currentBetLevel: game.currentBetLevel,
                currentPlayerIndex: game.currentPlayerIndex,
                pot: totalPot(game.players),
                message: game.message,
                preflopRaiserIndex: game.preflopRaiserIndex
            };
            localStorage.setItem('pt_save', JSON.stringify(save));
        } catch(e) {}
    }

    static loadGame() {
        try {
            const raw = localStorage.getItem('pt_save');
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    }

    static clearSave() {
        localStorage.removeItem('pt_save');
    }

    /** 从存档恢复游戏 */
    restoreFromSave(save) {
        this.handNumber = save.handNumber || 1;
        this.phase = save.phase || 'preflop';
        this.dealerIndex = save.dealerIndex;
        this.currentBetLevel = save.currentBetLevel || BIG_BLIND;
        this.currentPlayerIndex = save.currentPlayerIndex;
        this.preflopRaiserIndex = save.preflopRaiserIndex || -1;
        this.communityCards = save.communityCards || [];
        this.message = save.message || '游戏已恢复';
        this.eliminatedPlayers = [];

        // 恢复玩家状态
        for (let i = 0; i < this.players.length; i++) {
            const sp = save.players[i];
            if (!sp) continue;
            this.players[i].chips = sp.chips;
            this.players[i].handCards = save.handCards[i] || [];
            this.players[i].isFolded = false;
            this.players[i].isAllIn = false;
            this.players[i].currentBet = 0;
            this.players[i].totalBetThisHand = 0;
            this.players[i].needsToAct = (i === save.currentPlayerIndex && this.phase !== 'hand_over');
            this.players[i].hasActedThisRound = false;
            this.players[i].isDealer = (i === save.dealerIndex);
            if (sp.isEliminated) this.eliminatedPlayers.push(sp.id);
        }

        // 设置盲注标记
        const sbIdx = this.nextActivePlayerIndex(this.dealerIndex);
        const bbIdx = this.nextActivePlayerIndex(sbIdx);
        this.players[this.dealerIndex].isDealer = true;
        if (!this.players[sbIdx].isEliminated) this.players[sbIdx].isSmallBlind = true;
        if (!this.players[bbIdx].isEliminated) this.players[bbIdx].isBigBlind = true;

        // 存档不包含完整牌堆，从安全状态重启
        this.deck = createDeck();
        this.initHumanStats();
        this.notifyState();
        this.autoAdvance();
    }
}


// ==================== 全局导出 ====================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PokerGame, evaluateHand, createDeck, RANKS, SUIT_SYMBOLS, SUIT_COLORS };
}
