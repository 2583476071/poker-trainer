/* ================================================================
 * shared/gto_ranges.js — 翻前 GTO 范围表（100BB, 9-Max, 6 位置）
 * 前后端共享，依赖 constants.js
 * ================================================================ */

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./constants.js'));
}

function makeHandKey(rank1, rank2, suited) {
    const high = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank1 : rank2;
    const low  = RANK_VALUES[rank1] >= RANK_VALUES[rank2] ? rank2 : rank1;
    if (rank1 === rank2) return high + high;
    return suited ? (high + low + 's') : (high + low + 'o');
}

function handFromCards(c1, c2) {
    return makeHandKey(c1.rank, c2.rank, c1.suit === c2.suit);
}

function expandRangeDesc(desc) {
    const hands = new Set();
    if (desc.pairsMin) {
        const startIdx = RANKS.indexOf(desc.pairsMin);
        for (let i = startIdx; i < RANKS.length; i++) hands.add(RANKS[i] + RANKS[i]);
    }
    if (desc.suitedMin) {
        for (const s of desc.suitedMin) {
            const hiIdx = RANKS.indexOf(s.high), loIdx = RANKS.indexOf(s.low);
            for (let hi = hiIdx; hi > loIdx; hi--)
                for (let lo = loIdx; lo < hi; lo++)
                    hands.add(RANKS[hi] + RANKS[lo] + 's');
        }
    }
    if (desc.offsuitMin) {
        for (const o of desc.offsuitMin) {
            const hiIdx = RANKS.indexOf(o.high), loIdx = RANKS.indexOf(o.low);
            for (let hi = hiIdx; hi > loIdx; hi--)
                for (let lo = loIdx; lo < hi; lo++)
                    hands.add(RANKS[hi] + RANKS[lo] + 'o');
        }
    }
    return hands;
}

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

/* ========== 6 位置 GTO 翻前范围 ========== */
const PREFLOP_RANGE_DESCS = {
    // UTG (~8%)
    UTG: {
        open: {
            pairsMin: '8',
            suitedMin:  [{ high:'A', low:'T' }, { high:'K', low:'Q' }, { high:'Q', low:'J' }],
            offsuitMin: [{ high:'A', low:'Q' }, { high:'K', low:'Q' }]
        },
        threeBet: {
            pairsMin: 'Q',
            suitedMin:  [{ high:'A', low:'K' }],
            offsuitMin: []
        },
        call: {
            pairsMin: '9',
            suitedMin:  [{ high:'A', low:'J' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        },
        fourBet: {
            pairsMin: 'K',
            suitedMin:  [{ high:'A', low:'K' }],
            offsuitMin: []
        }
    },
    // MP (~13%)
    MP: {
        open: {
            pairsMin: '6',
            suitedMin:  [{ high:'A', low:'8' }, { high:'K', low:'T' }, { high:'Q', low:'T' }, { high:'J', low:'T' }],
            offsuitMin: [{ high:'A', low:'J' }, { high:'K', low:'Q' }]
        },
        threeBet: {
            pairsMin: 'J',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        },
        call: {
            pairsMin: '7',
            suitedMin:  [{ high:'A', low:'T' }, { high:'K', low:'J' }, { high:'Q', low:'J' }],
            offsuitMin: [{ high:'A', low:'Q' }, { high:'K', low:'Q' }]
        },
        fourBet: {
            pairsMin: 'Q',
            suitedMin:  [{ high:'A', low:'K' }],
            offsuitMin: [{ high:'A', low:'K' }]
        }
    },
    // HJ (~19%)
    HJ: {
        open: {
            pairsMin: '5',
            suitedMin:  [{ high:'A', low:'5' }, { high:'K', low:'9' }, { high:'Q', low:'9' }, { high:'J', low:'9' }, { high:'T', low:'9' }],
            offsuitMin: [{ high:'A', low:'T' }, { high:'K', low:'J' }, { high:'Q', low:'J' }]
        },
        threeBet: {
            pairsMin: 'T',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }, { high:'A', low:'Q' }]
        },
        call: {
            pairsMin: '5',
            suitedMin:  [{ high:'A', low:'8' }, { high:'K', low:'T' }, { high:'Q', low:'T' }, { high:'J', low:'T' }],
            offsuitMin: [{ high:'A', low:'J' }, { high:'K', low:'Q' }]
        },
        fourBet: {
            pairsMin: 'J',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        }
    },
    // CO (~26%)
    CO: {
        open: {
            pairsMin: '3',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'5' }, { high:'Q', low:'7' },
                         { high:'J', low:'8' }, { high:'T', low:'8' }, { high:'9', low:'8' }],
            offsuitMin: [{ high:'A', low:'8' }, { high:'K', low:'T' }, { high:'Q', low:'T' }, { high:'J', low:'T' }]
        },
        threeBet: {
            pairsMin: 'T',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }, { high:'A', low:'J' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }, { high:'A', low:'Q' }]
        },
        call: {
            pairsMin: '3',
            suitedMin:  [{ high:'A', low:'4' }, { high:'K', low:'7' }, { high:'Q', low:'9' }, { high:'J', low:'9' }],
            offsuitMin: [{ high:'A', low:'9' }, { high:'K', low:'Q' }, { high:'Q', low:'J' }]
        },
        fourBet: {
            pairsMin: 'J',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        }
    },
    // BTN (~40%)
    BTN: {
        open: {
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'2' }, { high:'Q', low:'5' },
                         { high:'J', low:'7' }, { high:'T', low:'7' }, { high:'9', low:'7' }, { high:'8', low:'7' }],
            offsuitMin: [{ high:'A', low:'5' }, { high:'K', low:'8' }, { high:'Q', low:'9' },
                         { high:'J', low:'9' }, { high:'T', low:'9' }]
        },
        threeBet: {
            pairsMin: '9',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }, { high:'A', low:'J' },
                         { high:'K', low:'Q' }, { high:'K', low:'J' }],
            offsuitMin: [{ high:'A', low:'K' }, { high:'A', low:'Q' }]
        },
        call: {
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'5' }, { high:'Q', low:'7' },
                         { high:'J', low:'8' }, { high:'T', low:'8' }],
            offsuitMin: [{ high:'A', low:'8' }, { high:'K', low:'T' }, { high:'Q', low:'J' }, { high:'J', low:'T' }]
        },
        fourBet: {
            pairsMin: 'T',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        }
    },
    // SB (~30%)
    SB: {
        open: {
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'4' }, { high:'Q', low:'7' },
                         { high:'J', low:'8' }, { high:'T', low:'8' }],
            offsuitMin: [{ high:'A', low:'7' }, { high:'K', low:'9' }, { high:'Q', low:'9' },
                         { high:'J', low:'9' }, { high:'T', low:'9' }]
        },
        threeBet: {
            pairsMin: 'T',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }, { high:'A', low:'J' }, { high:'K', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }, { high:'A', low:'Q' }]
        },
        call: {
            pairsMin: '2',
            suitedMin:  [{ high:'A', low:'2' }, { high:'K', low:'7' }, { high:'Q', low:'8' }, { high:'J', low:'9' }],
            offsuitMin: [{ high:'A', low:'8' }, { high:'K', low:'T' }, { high:'Q', low:'T' }, { high:'J', low:'T' }]
        },
        fourBet: {
            pairsMin: 'J',
            suitedMin:  [{ high:'A', low:'K' }, { high:'A', low:'Q' }],
            offsuitMin: [{ high:'A', low:'K' }]
        }
    }
};

// 向后兼容
PREFLOP_RANGE_DESCS.early = PREFLOP_RANGE_DESCS.UTG;
PREFLOP_RANGE_DESCS.middle = PREFLOP_RANGE_DESCS.MP;
PREFLOP_RANGE_DESCS.late = PREFLOP_RANGE_DESCS.CO;

const PREFLOP_RANGE_LOOKUP = buildRangeLookup();

function isInPreflopRange(handKey, position, action) {
    const posRanges = PREFLOP_RANGE_LOOKUP[position];
    if (!posRanges) return false;
    const range = posRanges[action];
    if (!range) return false;
    return range.has(handKey);
}

function getPreflopAction(handKey, position, facingRaise, raiseCount) {
    if (!facingRaise) {
        return isInPreflopRange(handKey, position, 'open') ? 'open' : null;
    }
    // 4bet+ spot
    if (raiseCount >= 3 && isInPreflopRange(handKey, position, 'fourBet')) return 'fourBet';
    if (isInPreflopRange(handKey, position, 'threeBet')) return 'threeBet';
    if (isInPreflopRange(handKey, position, 'call')) return 'call';
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeHandKey, handFromCards, expandRangeDesc, buildRangeLookup,
                       PREFLOP_RANGE_DESCS, PREFLOP_RANGE_LOOKUP,
                       isInPreflopRange, getPreflopAction };
}
