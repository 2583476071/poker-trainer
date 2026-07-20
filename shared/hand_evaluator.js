/* ================================================================
 * shared/hand_evaluator.js — 牌型判定器（5-7张牌中找最优5张组合）
 * 前后端共享，依赖 constants.js, deck.js
 * ================================================================ */

// Node.js: 将依赖挂到 globalThis；浏览器: <script> 顺序保证全局可用
// 使用 globalThis 而非 var，避免 hoisting 覆盖浏览器的 const 全局声明
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./constants.js'));
    Object.assign(globalThis, require('./deck.js'));
}

/**
 * 从 5-7 张牌中找出最优 5 张牌型
 * 返回 { rank: 0-9, cards: 最优5张, name: 牌型名称, score: 比较用数组 }
 */
function evaluateHand(sevenCards) {
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
    const sorted = [...cards].sort((a, b) => b.rankValue - a.rankValue);
    const ranks = sorted.map(c => c.rankValue);
    const suits = sorted.map(c => c.suit);

    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(ranks);
    const groups = groupByRank(ranks);

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
        const pairRanks = groups.pairs.sort((a, b) => b - a);
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
    const unique = [...new Set(ranks)].sort((a, b) => b - a);
    if (unique.length < 5) return false;
    if (unique[0] - unique[4] === 4) return true;
    // Wheel: A-2-3-4-5
    if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
        return true;
    }
    return false;
}

/** 返回顺子的高点（Wheel 返回 5） */
function getStraightHigh(ranks) {
    const unique = [...new Set(ranks)].sort((a, b) => b - a);
    if (unique[0] === 14 && unique[1] === 5) return [5];
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
    kickers.sort((a, b) => b - a);
    return { fours, threes, pairs, kickers };
}

/** 比较两个 score 数组 */
function compareScores(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evaluateHand, scoreFiveCards, checkStraight, getStraightHigh,
                       groupByRank, compareScores };
}
