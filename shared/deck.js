/* ================================================================
 * shared/deck.js — 牌堆操作（创建、洗牌、发牌、组合枚举）
 * 前后端共享，依赖 constants.js
 * ================================================================ */

// Node.js: 将依赖挂到 globalThis；浏览器: <script> 顺序保证全局可用
// 使用 globalThis 而非 var，避免 hoisting 覆盖浏览器的 const 全局声明
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(globalThis, require('./constants.js'));
}

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
    const combo = Array(k).fill(0).map((_, i) => i);
    while (combo[k - 1] < n) {
        result.push([...combo]);
        let t = k - 1;
        while (t >= 0 && combo[t] === n - k + t) t--;
        if (t < 0) break;
        combo[t]++;
        for (let i = t + 1; i < k; i++) combo[i] = combo[i - 1] + 1;
    }
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createDeck, shuffle, draw, combinations };
}
