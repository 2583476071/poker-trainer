/* ================================================================
 * shared/gto_ranges.js — 翻前 GTO 范围表（100bb, 9-Max）
 * 前后端共享，依赖 constants.js
 * ================================================================ */

// Node.js: 将依赖挂到 globalThis；浏览器: <script> 顺序保证全局可用
// 使用 globalThis 而非 var，避免 hoisting 覆盖浏览器的 const 全局声明
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./constants.js'));
}

/** 手牌编码：对子 "AA"-"22"，同花 "AKs"-"32s"，不同花 "AKo"-"32o" */
function makeHandKey(rank1, rank2, suited) {
    const high = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank1 : rank2;
    const low  = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank2 : rank1;
    if (rank1 === rank2) return high + high;
    return suited ? (high + low + 's') : (high + low + 'o');
}

function handFromCards(c1, c2) {
    return makeHandKey(c1.rank, c2.rank, c1.suit === c2.suit);
}

/** 展开范围描述为手牌集合 */
function expandRangeDesc(desc) {
    const hands = new Set();
    if (desc.pairsMin) {
        const startIdx = RANKS.indexOf(desc.pairsMin);
        for (let i = startIdx; i < RANKS.length; i++) {
            hands.add(RANKS[i] + RANKS[i]);
        }
    }
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

/** 构建所有范围查找表 */
function buildRangeLookup() {
    const lookup = {};
    for (const pos of Object.keys(PREFLOP_RANGE_DESCS)) {
        lookup[pos] = {};
        for (const action of Object.keys(PREFLOP_RANGE_DESCS[pos])) {
            lookup[pos][action] = expandRangeDesc(PREFLOP_RANGE_DESCS[pos][action]);
        }
    }
    return lookup;
}

/** 范围描述（紧凑格式，启动时展开） */
const PREFLOP_RANGE_DESCS = {
    // UTG / 早期位置 — 开池 ~10%
    early: {
        open: {
            pairsMin: '7',
            suitedMin:  [{ high:'A', low:'9' }, { high:'K', low:'T' }, { high:'Q', low:'T' }],
            offsuitMin: [{ high:'A', low:'J' }, { high:'K', low:'Q' }]
        },
        threeBet: {
            pairsMin: 'Q',
            suitedMin:  [{ high:'A', low:'K' }],
            offsuitMin: []
        },
        call: {
            pairsMin: '8',
            suitedMin:  [{ high:'A', low:'Q' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'Q' }]
        }
    },
    // MP / 中位 — 开池 ~18%
    middle: {
        open: {
            pairsMin: '5',
            suitedMin:  [{ high:'A', low:'5' }, { high:'K', low:'9' }, { high:'Q', low:'9' }, { high:'J', low:'9' }],
            offsuitMin: [{ high:'A', low:'T' }, { high:'K', low:'J' }, { high:'Q', low:'J' }]
        },
        threeBet: {
            pairsMin: 'J',
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
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'5' }, { high:'Q', low:'8' },
                         { high:'J', low:'8' }, { high:'T', low:'8' }],
            offsuitMin: [{ high:'A', low:'8' }, { high:'K', low:'9' }, { high:'Q', low:'9' },
                         { high:'J', low:'9' }, { high:'T', low:'9' }]
        },
        threeBet: {
            pairsMin: 'T',
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

/** 初始化范围查找表 */
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
    if (isInPreflopRange(handKey, position, 'threeBet')) return 'threeBet';
    if (isInPreflopRange(handKey, position, 'call')) return 'call';
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeHandKey, handFromCards, expandRangeDesc, buildRangeLookup,
                       PREFLOP_RANGE_DESCS, PREFLOP_RANGE_LOOKUP,
                       isInPreflopRange, getPreflopAction };
}
