/* ================================================================
 * shared/pot_calculator.js — 边池计算
 * 前后端共享，零依赖
 * ================================================================ */

/**
 * 计算边池分配
 * @param {Array} players — 所有玩家（需含 isFolded, totalBetThisHand, id 字段）
 * @returns {Array<{amount, eligiblePlayerIds}>}
 */
function calculatePots(players) {
    const activePlayers = players.filter(p => !p.isFolded);
    if (activePlayers.length === 0) return [];

    const bets = activePlayers.map(p => ({
        player: p,
        total: p.totalBetThisHand
    }));
    bets.sort((a, b) => a.total - b.total);

    const pots = [];
    let prevLevel = 0;

    for (let i = 0; i < bets.length; i++) {
        const level = bets[i].total;
        if (level === prevLevel) continue;

        const contribution = level - prevLevel;
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calculatePots, totalPot };
}
