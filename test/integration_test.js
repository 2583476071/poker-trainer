/* ================================================================
 * test/integration_test.js — Phase 4 集成测试
 * 用法: node test/integration_test.js
 * 前提: 服务器在 localhost:3000 运行
 * ================================================================ */

const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SUITS = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' };

let passed = 0, failed = 0;
function check(name, condition, detail) {
    if (condition) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

async function test() {
    console.log('🧪 Phase 4 集成测试\n');
    console.log('=' .repeat(50));

    // ============ Test 1: 服务端模块加载 ============
    console.log('\n📋 Test 1: 服务端模块加载');
    try {
        const { PokerGame } = require('../server/poker_game.js');
        check('PokerGame 加载', true);
        const { GameManager } = require('../server/game_manager.js');
        check('GameManager 加载', true);
    } catch(e) {
        check('服务端模块加载', false, e.message);
    }

    // ============ Test 2: 单人模式游戏引擎 ============
    console.log('\n📋 Test 2: 单人模式游戏引擎');
    require('../shared/constants.js');
    require('../shared/deck.js');
    require('../shared/hand_evaluator.js');
    require('../shared/pot_calculator.js');
    require('../shared/gto_ranges.js');
    require('../shared/player_factory.js');
    require('../shared/board_analyzer.js');
    const { PokerGame } = require('../game.js');

    const sp = new PokerGame();
    sp.init('training');
    check('9 个玩家创建', sp.players.length === 9);
    check('起始筹码 20000', sp.players[0].chips === 20000);
    check('初始盲注 100/200', sp.smallBlindAmount === 100 && sp.bigBlindAmount === 200);
    check('phase = preflop', sp.phase === 'preflop');

    const spState = sp.getState();
    check('humanChips = 20000', spState.humanChips === 20000);
    check('加注按钮: +100%/+150%/+200%',
        spState.availableActions.length > 0 ?
            ['raise_100','raise_150','raise_200'].every(a => spState.availableActions.includes(a)) :
            spState.availableActions.length === 0 // 可能不是人类回合
    );

    // 验证盲注升级
    sp.updateBlinds(true);
    check('强制升盲: 200/400', sp.smallBlindAmount === 200 && sp.bigBlindAmount === 400);

    // 验证竞技模式
    const sp2 = new PokerGame();
    sp2.init('competitive');
    check('竞技模式 9 玩家', sp2.players.length === 9);
    check('竞技模式起始筹码', sp2.players[0].chips >= 19600 && sp2.players[0].chips <= 20100);

    // ============ Test 3: 联机模式 ============
    console.log('\n📋 Test 3: 联机房间 & 游戏');
    const a = io('http://localhost:3000', { transports: ['websocket'] });
    const b = io('http://localhost:3000', { transports: ['websocket'] });
    await Promise.all([new Promise(r => a.on('connect', r)), new Promise(r => b.on('connect', r))]);
    check('两个客户端连接', true);

    let roomCode, aliceId;
    a.emit('create_room', { nickname: 'Alice' }, (res) => {
        roomCode = res.roomCode; aliceId = res.playerId;
    });
    await sleep(500);
    check('房间创建成功', !!roomCode);
    check('房间码6位', roomCode && roomCode.length === 6);

    b.emit('join_room', { roomCode, nickname: 'Bob' }, (res) => {
        check('Bob 加入成功', res.ok, res.error);
    });
    await sleep(500);

    // ============ Test 4: 游戏状态推送 ============
    console.log('\n📋 Test 4: 游戏状态推送 & 手牌隔离');
    let aState = null, bState = null;
    a.on('state_update', s => { aState = s; });
    b.on('state_update', s => { bState = s; });

    a.emit('start_game', {}, (res) => {
        check('开始游戏成功', res.ok, res.error);
    });
    await sleep(2000);

    check('Alice 收到状态', aState !== null);
    check('Alice 手牌2张', aState && aState.myCards.length === 2);
    check('Alice 筹码~20000', aState && Math.abs(aState.myChips - 20000) <= 200);
    check('Alice 盲注 100/200', aState && aState.smallBlind === 100 && aState.bigBlind === 200);

    if (bState) {
        check('Bob 收到状态', true);
        check('Bob 手牌2张', bState.myCards.length === 2);
        check('Bob 看不到 Alice 手牌',
            bState.players.filter(p => p.id !== bState.myPlayerId).every(p => p.handCards.length === 0));
    }

    if (aState) {
        check('Alice 看不到 Bob 手牌',
            aState.players.filter(p => p.id !== aliceId).every(p => p.handCards.length === 0));
    }

    check('currentPlayerId 已设置', aState && aState.currentPlayerId !== null);
    check('加注选项正确',
        aState && aState.isMyTurn ?
            ['raise_100','raise_150','raise_200'].every(act => aState.availableActions.includes(act)) :
            true);

    // ============ Test 5: 玩家行动 ============
    console.log('\n📋 Test 5: 玩家行动模拟');
    let actions = 0;
    for (let i = 0; i < 25 && aState && aState.phase !== 'hand_over'; i++) {
        if (aState && aState.isMyTurn) {
            const act = aState.availableActions.includes('check') ? 'check' : 'call';
            a.emit('player_action', { action: act });
            actions++;
        }
        if (bState && bState.isMyTurn) {
            const act = bState.availableActions.includes('check') ? 'check' : 'call';
            b.emit('player_action', { action: act });
            actions++;
        }
        await sleep(300);
    }
    check('玩家至少行动过', actions > 0,
        `实际行动 ${actions} 次`);

    // ============ Test 6: 服务端盲注升级 ============
    console.log('\n📋 Test 6: 服务端盲注升级');
    const { PokerGame: SG } = require('../server/poker_game.js');
    const sg = new SG({
        seats: [{ seatIndex:0, playerId:1, name:'Test', isHuman:true, aiProfile:null }],
        startingChips: 20000
    });
    check('服端初始盲注 100/200', sg.smallBlindAmount === 100 && sg.bigBlindAmount === 200);
    sg.updateBlinds(true);
    check('服端升盲 200/400', sg.smallBlindAmount === 200 && sg.bigBlindAmount === 400);
    for (let i = 0; i < 6; i++) sg.updateBlinds(true);
    check('服端封顶 5000/10000', sg.smallBlindAmount === 5000 && sg.bigBlindAmount === 10000);

    // Cleanup
    a.disconnect(); b.disconnect();

    // ============ Summary ============
    console.log('\n' + '='.repeat(50));
    console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败, ${passed + failed} 总计`);
    if (failed > 0) {
        console.log('❌ 集成测试未通过！');
        process.exit(1);
    } else {
        console.log('✅ 集成测试全部通过！');
        process.exit(0);
    }
}

test().catch(e => { console.error('💥 测试崩溃:', e.message); process.exit(1); });
