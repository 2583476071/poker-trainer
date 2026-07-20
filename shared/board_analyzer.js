/* ================================================================
 * shared/board_analyzer.js — 牌面分析 & 阻断牌 & 听牌评估（纯函数版）
 * 前后端共享
 *
 * 依赖：pot_calculator.js（totalPot）
 * 所有函数均为纯函数：接受数据参数，不依赖 this 或外部状态
 * ================================================================ */

// Node.js: 将依赖挂到 globalThis；浏览器: <script> 顺序保证全局可用
// 使用 globalThis 而非 var，避免 hoisting 覆盖浏览器的 const 全局声明
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./pot_calculator.js'));
}

// 浏览器端 _totalPot 指向全局 totalPot；Node.js 端 globalThis 已包含
const _totalPot = (typeof totalPot !== 'undefined') ? totalPot : globalThis.totalPot;

// ==================== 牌面分析 ====================

/**
 * 分析公共牌面结构
 * @param {Array} communityCards — 公共牌数组
 * @returns {Object} 牌面分析结果
 */
function analyzeBoard(communityCards) {
    if (!communityCards || communityCards.length === 0) {
        return { scary: false, paired: false, flushPossible: false, straightPossible: false,
                 highCards: 0, category: 'dry', boardType: 'rainbow_safe', avgRank: 0, connectivity: 0 };
    }
    const board = communityCards;
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

    const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;

    let connectivity = 0;
    if (uniqueRanks.length >= 2) {
        let closeGaps = 0;
        for (let i = 1; i < uniqueRanks.length; i++) {
            if (uniqueRanks[i] - uniqueRanks[i - 1] <= 2) closeGaps++;
        }
        connectivity = closeGaps / (uniqueRanks.length - 1);
    }

    // 五类牌面分类
    let boardType;
    if (paired) {
        boardType = 'paired';
    } else if (flushPossible) {
        boardType = 'wet_flush';
    } else if (straightPossible) {
        boardType = 'straight';
    } else if (highCards >= 2) {
        boardType = 'dry_high';
    } else {
        boardType = 'rainbow_safe';
    }

    const drawCount = (flushPossible ? 1 : 0) + (straightPossible ? 1 : 0);
    let oldCategory = 'medium';
    if (boardType === 'paired' && drawCount >= 1) oldCategory = 'wet';
    else if (boardType === 'wet_flush' || boardType === 'straight') oldCategory = 'wet';
    else if (boardType === 'dry_high') oldCategory = 'medium';
    else if (boardType === 'rainbow_safe') oldCategory = 'dry';

    return { scary, paired, flushPossible, straightPossible, highCards,
             category: oldCategory, boardType, avgRank, connectivity };
}

// ==================== 牌面策略模板 ====================

function getBoardStrategy(boardType) {
    const strategies = {
        dry_high:      { cbetFreq: 0.65, betSize: 0.50, valueWeight: 0.7, bluffWeight: 0.3, desc: '干燥高牌面' },
        wet_flush:     { cbetFreq: 0.45, betSize: 0.67, valueWeight: 0.5, bluffWeight: 0.5, desc: '湿润同花面' },
        paired:        { cbetFreq: 0.55, betSize: 0.33, valueWeight: 0.6, bluffWeight: 0.4, desc: '成对牌面' },
        straight:      { cbetFreq: 0.35, betSize: 0.50, valueWeight: 0.5, bluffWeight: 0.3, desc: '顺子面' },
        rainbow_safe:  { cbetFreq: 0.75, betSize: 0.50, valueWeight: 0.8, bluffWeight: 0.4, desc: '彩虹安全面' },
    };
    return strategies[boardType] || strategies.rainbow_safe;
}

// ==================== GTO 下注尺度选择 ====================

function pickGTOMultiplier(profile, board, situation) {
    let base;
    switch (board ? board.boardType : 'rainbow_safe') {
        case 'paired':       base = 1.20; break;
        case 'rainbow_safe': base = 1.35; break;
        case 'dry_high':     base = 1.45; break;
        case 'straight':     base = 1.60; break;
        case 'wet_flush':    base = 1.80; break;
        default:             base = 1.45;
    }

    if (situation === 'steal') base = Math.min(base, 1.35);
    if (situation === 'cbet')  base = Math.max(base, 1.30);

    const rand = Math.random();
    if (profile.aggression > 0.40) {
        base *= rand < 0.38 ? 1.0 : (rand < 0.68 ? 1.15 : 1.35);
    } else if (profile.aggression > 0.30) {
        base *= rand < 0.55 ? 1.0 : 1.18;
    } else {
        base *= rand < 0.60 ? 1.0 : 1.12;
    }

    return Math.round(base * 20) / 20;
}

// ==================== MDF 最低防守频率 ====================

function calculateMDF(players, currentBetLevel) {
    const pot = _totalPot(players);
    const toCall = currentBetLevel;
    if (toCall <= 0) return 1.0;
    const mdf = pot / (pot + toCall);
    return Math.min(0.9, Math.max(0.05, mdf));
}

// ==================== 下注与底池比例 ====================

function getBetPotRatio(players, currentBetLevel) {
    const pot = _totalPot(players);
    if (pot <= 0) return 1;
    return currentBetLevel / pot;
}

// ==================== 范围优势 ====================

function getRangeAdvantage(playerId, communityCards, preflopRaiserIndex) {
    if (!communityCards || communityCards.length === 0) return 0;
    const board = analyzeBoard(communityCards);
    const isAggressor = preflopRaiserIndex === playerId;
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

// ==================== 听牌潜力 ====================

function evaluateDrawPotential(handCards, communityCards) {
    if (!communityCards || communityCards.length < 3) return 0;
    if (!handCards || handCards.length < 2) return 0;
    const allCards = [...handCards, ...communityCards];

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

// ==================== 阻断牌评估 ====================

function evaluateBlockers(handCards, communityCards) {
    if (!handCards || handCards.length < 2 || !communityCards || communityCards.length < 3) return 0;
    let score = 0;

    const [c1, c2] = handCards;
    const handRanks = [c1.rankValue, c2.rankValue];
    const handSuits = [c1.suit, c2.suit];

    const boardRanks = communityCards.map(c => c.rankValue);
    const allRanks = [...boardRanks, ...handRanks].sort((a, b) => a - b);

    // 1. 顺子坚果阻断
    for (const r of handRanks) {
        const sorted = [...boardRanks].sort((a, b) => a - b);
        for (let i = 0; i + 2 < sorted.length; i++) {
            if (sorted[i + 2] - sorted[i] <= 4) {
                const gap = sorted[i + 2] - sorted[i];
                if (gap === 2 && (r === sorted[i] - 1 || r === sorted[i + 2] + 1)) {
                    score += 4;
                } else if (gap <= 3 && (r >= sorted[i] - 1 && r <= sorted[i + 2] + 1)) {
                    score += 2;
                }
            }
        }
    }

    // 2. 同花坚果阻断
    const suitCounts = {};
    communityCards.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
    for (const [suit, count] of Object.entries(suitCounts)) {
        if (count >= 3 && handSuits.includes(suit)) {
            const highSuitCards = handRanks.filter((_, i) => handSuits[i] === suit);
            if (highSuitCards.some(r => r >= 10)) score += 5;
            else score += 3;
        }
    }

    // 3. 范围阻断
    for (const r of handRanks) {
        if (r === 14) score += 2;
        else if (r === 13) score += 1;
    }

    // 4. 听牌阻断
    for (const s of handSuits) {
        if (suitCounts[s] && suitCounts[s] >= 2) {
            score += 1;
        }
    }

    return Math.min(10, score);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyzeBoard, getBoardStrategy, pickGTOMultiplier,
                       calculateMDF, getBetPotRatio, getRangeAdvantage,
                       evaluateDrawPotential, evaluateBlockers };
}
