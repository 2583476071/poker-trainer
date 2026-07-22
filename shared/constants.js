/* ================================================================
 * shared/constants.js — 德州扑克常量定义
 * 前后端共享，零依赖
 * ================================================================ */

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
const SMALL_BLIND = 100;
const BIG_BLIND = 200;
const STARTING_CHIPS = 20000;

// 盲注级别表: { small, big }
const BLIND_LEVELS = [
    { small: 100,  big: 200 },
    { small: 200,  big: 400 },
    { small: 300,  big: 600 },
    { small: 400,  big: 800 },
    { small: 500,  big: 1000 },
    { small: 1000, big: 2000 },
    { small: 2000, big: 4000 },
    { small: 5000, big: 10000 },
];
const BLINDS_UP_HANDS = 20;      // 每20手牌升盲
const BLINDS_UP_MINUTES = 10;    // 每10分钟升盲

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

// UMD 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RANKS, RANK_VALUES, SUITS, SUIT_SYMBOLS, SUIT_COLORS,
                       HAND_NAMES, PHASES, SMALL_BLIND, BIG_BLIND, STARTING_CHIPS,
                       AI_PERSONALITIES, BLIND_LEVELS, BLINDS_UP_HANDS, BLINDS_UP_MINUTES };
}
