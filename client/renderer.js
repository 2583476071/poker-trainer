/* ================================================================
 * client/renderer.js — 牌桌渲染（联机版）
 *
 * 基于原 index.html 的 render() 函数，适配服务端个性化 state：
 *   - state.myPlayerId / myCards / myChips / isMyTurn
 *   - state.players[].handCards 已由服务端按权限过滤
 * ================================================================ */

const Renderer = {
    _seatCount: 9,

    /** 初始化座位 DOM */
    initSeats() {
        const container = document.getElementById('seatsContainer');
        container.innerHTML = '';
        for (let i = 0; i < this._seatCount; i++) {
            const seat = document.createElement('div');
            seat.className = 'player-seat';
            seat.id = 'seat-' + i;
            seat.innerHTML = `
                <div class="player-info" id="playerInfo${i}">
                    <div class="player-name" id="playerName${i}"></div>
                    <div class="player-chip" id="playerChip${i}"></div>
                    <div class="player-bet" id="playerBet${i}"></div>
                    <div class="player-cards" id="playerCards${i}"></div>
                    <div class="seat-pos-label" id="seatLabel${i}"></div>
                </div>`;
            container.appendChild(seat);
        }
    },

    /** 渲染卡牌 HTML（小） */
    _renderMiniCard(card, faceDown) {
        if (faceDown) return '<div class="mini-card face-down">?</div>';
        const suitSymbol = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' }[card.suit];
        const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
        return `<div class="mini-card ${isRed ? 'red' : ''}">
            <span>${card.rank}</span><span>${suitSymbol}</span></div>`;
    },

    /** 渲染卡牌 HTML（大） */
    _renderBigCard(card, faceDown) {
        if (faceDown) return '<div class="card face-down"></div>';
        const suitSymbol = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' }[card.suit];
        const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
        return `<div class="card ${isRed ? 'red' : 'black'}">
            <span class="rank">${card.rank}</span>
            <span class="suit">${suitSymbol}</span></div>`;
    },

    /** 主渲染 */
    render(state) {
        // 顶栏
        document.getElementById('handNum').textContent = `第 ${state.handNumber} 手`;
        document.getElementById('gameMsg').textContent = state.message;

        const tableArea = document.getElementById('tableArea');
        const isShowdown = state.phase === 'showdown' || state.phase === 'hand_over';
        tableArea.classList.toggle('showdown-phase', isShowdown);

        // 为联机模式，座位映射保持不变（seat-0 到 seat-8）
        // state.players 按座位索引排序
        for (let i = 0; i < this._seatCount; i++) {
            const p = state.players[i];
            if (!p) continue;

            const info = document.getElementById('playerInfo' + i);
            const nameEl = document.getElementById('playerName' + i);
            const chipEl = document.getElementById('playerChip' + i);
            const betEl = document.getElementById('playerBet' + i);
            const cardsEl = document.getElementById('playerCards' + i);

            // 名字 + 标记
            let nameHTML = p.name;
            if (p.isDealer) nameHTML += ' <span class="badge-dealer">D</span>';
            if (p.isSmallBlind) nameHTML += ' <span class="badge-sb">SB</span>';
            if (p.isBigBlind) nameHTML += ' <span class="badge-bb">BB</span>';
            if (state.currentRoundRaiserId === p.id) nameHTML += ' <span class="badge-raiser">R</span>';
            if (p.aiType && state.showAiTypes) nameHTML += ` <span class="badge-ai">${p.aiType}</span>`;
            nameEl.innerHTML = nameHTML;

            if (p.id === state.myPlayerId) nameEl.classList.add('human');
            else nameEl.classList.remove('human');

            // 筹码 + BB数
            const bbCount = Math.round(p.chips / state.bigBlind);
            chipEl.textContent = `${p.chips}（${bbCount}BB）`;

            // 下注（彩色）
            if (p.totalBetThisHand > 0) {
                betEl.textContent = `💵 ${p.totalBetThisHand}`;
                betEl.style.color = '#2ecc71';
                betEl.style.fontWeight = 'bold';
            } else {
                betEl.textContent = '';
                betEl.style.color = '';
                betEl.style.fontWeight = '';
            }

            // 手牌
            if (p.isEliminated) {
                cardsEl.innerHTML = '';
            } else if (p.handCards.length === 2) {
                cardsEl.innerHTML = this._renderMiniCard(p.handCards[0], false) +
                                    this._renderMiniCard(p.handCards[1], false);
            } else if (p.isFolded) {
                cardsEl.innerHTML = this._renderMiniCard(null, true) + this._renderMiniCard(null, true);
            } else if (p.isActive && !p.isEliminated) {
                cardsEl.innerHTML = this._renderMiniCard(null, true) + this._renderMiniCard(null, true);
            } else {
                cardsEl.innerHTML = '';
            }

            // 状态样式
            info.classList.remove('current-turn', 'folded', 'eliminated');
            if (p.isEliminated) info.classList.add('eliminated');
            else if (p.isFolded) info.classList.add('folded');
        }

        // 高亮当前行动玩家
        for (let i = 0; i < this._seatCount; i++) {
            document.getElementById('playerInfo' + i).classList.remove('current-turn');
        }
        if (state.currentPlayerId != null && state.phase !== 'hand_over' &&
            state.phase !== 'idle' && state.phase !== 'game_over') {
            const idx = state.players.findIndex(p => p.id === state.currentPlayerId);
            if (idx >= 0) {
                const info = document.getElementById('playerInfo' + idx);
                if (info) info.classList.add('current-turn');
            }
        }

        // 公共牌
        const commDiv = document.getElementById('communityCards');
        let commHTML = '';
        for (let i = 0; i < 5; i++) {
            if (i < state.communityCards.length) {
                commHTML += this._renderBigCard(state.communityCards[i], false);
            } else {
                commHTML += '<div class="card-placeholder"></div>';
            }
        }
        commDiv.innerHTML = commHTML;

        // 底池 + 盲注
        document.getElementById('potDisplay').textContent = `底池: ${state.pot}`;
        document.getElementById('blindDisplay').textContent = `${state.smallBlind}/${state.bigBlind}`;

        // 自己的手牌（大图）
        const yourHandDiv = document.getElementById('yourHand');
        if (state.myCards && state.myCards.length === 2) {
            yourHandDiv.innerHTML = this._renderBigCard(state.myCards[0], false) +
                                    this._renderBigCard(state.myCards[1], false);
        } else {
            yourHandDiv.innerHTML = '';
        }

        // 自己的筹码
        document.getElementById('yourChips').textContent = `积分: ${state.myChips}`;

        // 自己当前下注
        const me = state.players.find(p => p.id === state.myPlayerId);
        document.getElementById('yourBet').textContent =
            (me && me.totalBetThisHand > 0) ? `已下: ${me.totalBetThisHand}` : '';

        // 牌型提示
        const hintDiv = document.getElementById('handHint');
        if (state.phase !== 'preflop' && state.phase !== 'idle' &&
            state.phase !== 'hand_over' && state.phase !== 'game_over' &&
            state.myCards && state.myCards.length === 2 &&
            state.communityCards.length >= 3) {
            const all7 = [...state.myCards, ...state.communityCards];
            const evalResult = evaluateHand(all7);
            hintDiv.textContent = `当前牌型: ${evalResult.name}`;
        } else if (state.phase === 'hand_over' && state.myCards &&
                   state.myCards.length === 2 && state.communityCards.length >= 3) {
            const all7 = [...state.myCards, ...state.communityCards];
            const evalResult = evaluateHand(all7);
            const won = state.winners.find(w => w.playerId === state.myPlayerId && w.pot > 0);
            hintDiv.textContent = `最终牌型: ${evalResult.name}` + (won ? ' ✅ 赢了!' : ' — 输了');
        } else {
            hintDiv.textContent = '';
        }

        // 行动按钮
        this._updateButtons(state);

        // 行动日志
        this._updateActionLog(state);

        // 摊牌面板
        this._updateShowdownPanel(state);

        // 结果弹窗
        this._updateResultOverlay(state);
    },

    _updateButtons(state) {
        const ids = ['btnFold', 'btnCheck', 'btnCall', 'btnRaise100', 'btnRaise150',
                     'btnRaise200', 'btnAllIn', 'btnNext'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });

        if (state.isGameOver) return;
        if (state.phase === 'hand_over') {
            document.getElementById('btnNext').classList.remove('hidden');
            return;
        }
        if (!state.isMyTurn) return;

        const actions = state.availableActions;
        if (actions.includes('fold')) document.getElementById('btnFold').classList.remove('hidden');
        if (actions.includes('check')) document.getElementById('btnCheck').classList.remove('hidden');
        if (actions.includes('call')) {
            const btn = document.getElementById('btnCall');
            btn.classList.remove('hidden');
            btn.textContent = '跟注';
        }
        if (actions.includes('raise_100')) document.getElementById('btnRaise100').classList.remove('hidden');
        if (actions.includes('raise_150')) document.getElementById('btnRaise150').classList.remove('hidden');
        if (actions.includes('raise_200')) document.getElementById('btnRaise200').classList.remove('hidden');
        if (actions.includes('allin')) document.getElementById('btnAllIn').classList.remove('hidden');
    },

    _updateResultOverlay(state) {
        const overlay = document.getElementById('resultOverlay');
        if (!state.isGameOver) { overlay.classList.add('hidden'); return; }

        overlay.classList.remove('hidden');
        const box = document.getElementById('resultBox');
        const title = document.getElementById('resultTitle');
        const list = document.getElementById('winnerList');

        const humanWon = state.myChips > 0;
        if (humanWon) {
            box.className = 'champion';
            title.innerHTML = '🏆 冠军！';
            list.innerHTML = '<span class="trophy">🏆</span><div>你赢了！</div>';
        } else {
            box.className = 'defeat';
            title.innerHTML = '😞 你被淘汰了';
            list.innerHTML = '<span class="trophy">💀</span><div>下次加油！</div>';
        }

        document.getElementById('btnNextHand').onclick = () => {
            overlay.classList.add('hidden');
            Network.nextHand();
        };
    },

    _logEntries: [],

    _updateActionLog(state) {
        if (!state.lastAction) return;
        const a = state.lastAction;
        const key = `${a.playerId}-${a.action}-${state.handNumber}-${state.phase}`;
        if (this._logEntries.includes(key)) return;
        this._logEntries.push(key);
        if (this._logEntries.length > 50) this._logEntries.shift();

        const log = document.getElementById('actionLog');
        if (!log) return;
        let cls = 'action-' + a.action;
        let icon = { fold:'✗', check:'✓', call:'→', raise:'↑', allin:'⚡' }[a.action] || '';
        let detail = a.amount > 0 ? ` ${a.amount}` : '';
        let actName = { fold:'弃牌', check:'过牌', call:'跟注', raise:'加注', allin:'All-in' }[a.action] || a.action;
        log.innerHTML += `<div class="entry"><span class="player">${a.playerName}</span> <span class="${cls}">${icon}${actName}${detail}</span></div>`;
        log.scrollTop = log.scrollHeight;
    },

    _updateShowdownPanel(state) {
        const panel = document.getElementById('showdownPanel');
        if (!panel) return;
        if (state.phase !== 'hand_over' || state.winners.length === 0) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');

        document.getElementById('sdTitle').textContent = '🃏 摊牌结果';

        let pubHTML = '';
        for (const c of state.communityCards) {
            const s = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' }[c.suit];
            const isRed = c.suit === 'hearts' || c.suit === 'diamonds';
            pubHTML += `<div class="card ${isRed ? 'red' : 'black'}"><span class="rank">${c.rank}</span><span class="suit">${s}</span></div>`;
        }
        document.getElementById('sdPubcards').innerHTML = pubHTML;

        const activePlayers = state.players.filter(p => !p.isEliminated && !p.isFolded);
        const ranked = activePlayers.map(p => {
            const w = state.winners.find(w => w.playerId === p.id || w.name === p.name);
            return { ...p, handName: w && w.handName ? w.handName : '—', pot: w ? w.pot : 0, isWinner: w && w.pot > 0 };
        }).sort((a, b) => b.pot - a.pot);

        document.getElementById('sdPlayers').innerHTML = ranked.map(p => `
            <div class="sd-player-card ${p.isWinner ? 'winner' : ''}">
                <div class="sd-name">${p.isWinner ? '🏆 ' : ''}${p.name}${p.id === state.myPlayerId ? ' 👤' : ''}</div>
                <div class="sd-cards">${p.handCards.map(c => {
                    const s = { hearts:'♥', diamonds:'♦', clubs:'♣', spades:'♠' }[c.suit];
                    return `<span style="color:${c.suit === 'hearts' || c.suit === 'diamonds' ? '#e74c3c' : '#2c3e50'}">${c.rank}${s}</span>`;
                }).join(' ')}</div>
                <div class="sd-handname">【${p.handName}】</div>
                <div class="sd-result">${p.isWinner ? `<span class="sd-win">+${p.pot}</span>` : '<span class="sd-lose">—</span>'}</div>
            </div>
        `).join('');

        document.getElementById('sdPot').textContent = `底池: ${state.pot}`;

        document.getElementById('sdNextBtn').onclick = () => {
            panel.classList.add('hidden');
            this._logEntries = [];
            const log = document.getElementById('actionLog');
            if (log) log.innerHTML = '';
            Network.nextHand();
        };
    },
};
