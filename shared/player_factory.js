/* ================================================================
 * shared/player_factory.js — 玩家对象工厂
 * 前后端共享，依赖 constants.js
 * ================================================================ */

// Node.js: 将依赖挂到 globalThis；浏览器: <script> 顺序保证全局可用
// 使用 globalThis 而非 var，避免 hoisting 覆盖浏览器的 const 全局声明
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./constants.js'));
}

function createPlayer(id, name, isHuman, aiProfile) {
    return {
        id,
        name,
        isHuman,
        aiProfile: aiProfile || null,
        chips: STARTING_CHIPS,
        handCards: [],
        currentBet: 0,
        totalBetThisHand: 0,
        isFolded: false,
        isAllIn: false,
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        needsToAct: false,
        hasActedThisRound: false,
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createPlayer };
}
