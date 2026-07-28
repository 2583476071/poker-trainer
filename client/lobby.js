/* ================================================================
 * client/lobby.js — 大厅 UI 逻辑
 * ================================================================ */

const Lobby = {
    roomCode: null,
    isHost: false,

    /** 初始化：绑定 DOM 事件 */
    init() {
        document.getElementById('btnCreateRoom').addEventListener('click', () => this.createRoom());
        document.getElementById('btnJoinRoom').addEventListener('click', () => this.joinRoom());
        document.getElementById('btnRejoinRoom').addEventListener('click', () => this.rejoinRoom());
        document.getElementById('btnStartGame').addEventListener('click', () => this.startGame());
        document.getElementById('btnLeaveRoom').addEventListener('click', () => this.leaveRoom());
        document.getElementById('btnCancelRejoin').addEventListener('click', () => this.cancelRejoin());
    },

    /** 显示大厅 */
    show() {
        document.getElementById('lobbyPanel').classList.remove('hidden');
        document.getElementById('tableArea').classList.add('hidden');
        document.getElementById('actionBar').classList.add('hidden');
    },

    /** 隐藏大厅，显示牌桌 */
    hide() {
        document.getElementById('lobbyPanel').classList.add('hidden');
        document.getElementById('tableArea').classList.remove('hidden');
        document.getElementById('actionBar').classList.remove('hidden');
    },

    /** 显示重连面板 */
    showRejoinPanel(roomCode, nickname) {
        document.getElementById('lobbyPanel').classList.remove('hidden');
        document.getElementById('createJoinRow').classList.add('hidden');
        document.getElementById('rejoinRow').classList.remove('hidden');
        document.getElementById('lobbyRoomCode').textContent = roomCode;
        document.getElementById('lobbyStatus').textContent = `检测到你之前的房间 ${roomCode}，昵称: ${nickname}`;
        document.getElementById('inputNickname').value = nickname;
    },

    /** 取消重连 */
    cancelRejoin() {
        Session.clear();
        document.getElementById('rejoinRow').classList.add('hidden');
        document.getElementById('createJoinRow').classList.remove('hidden');
        document.getElementById('lobbyRoomCode').textContent = '';
        document.getElementById('lobbyStatus').textContent = '';
    },

    async createRoom() {
        const name = this._getNickname();
        const res = await Network.createRoom(name);
        if (res.error) { alert(res.error); return; }
        this._enterRoom(res.roomCode, true, '等待玩家加入...');
    },

    async joinRoom() {
        const name = this._getNickname();
        const code = document.getElementById('inputRoomCode').value.trim().toUpperCase();
        if (!code) { alert('请输入房间码'); return; }
        const res = await Network.joinRoom(code, name);
        if (res.error) { alert(res.error); return; }
        if (res.spectator) {
            // 观战模式
            this.roomCode = code;
            this.isHost = false;
            document.getElementById('topRoomCode').textContent = '🏠 ' + code;
            this.hide();
            if (res.state) Renderer.render(res.state);
            document.getElementById('topMsg').textContent = '👀 观战中...';
            return;
        }
        this._enterRoom(code, false, '等待房主开始游戏...');
    },

    async rejoinRoom() {
        const code = document.getElementById('lobbyRoomCode').textContent.trim();
        const name = this._getNickname();
        const res = await Network.rejoinRoom(code, name);
        if (res.error) { alert(res.error); return; }
        document.getElementById('rejoinRow').classList.add('hidden');
        document.getElementById('btnLeaveRoom').classList.remove('hidden');
        if (res.reconnected && res.state) {
            // 重连回游戏 — 直接显示牌桌
            this.isHost = false;
            this.roomCode = code;
            this.hide();
        } else {
            this._enterRoom(code, false, '等待房主开始游戏...');
        }
    },

    _enterRoom(code, isHost, statusMsg) {
        this.roomCode = code;
        this.isHost = isHost;
        document.getElementById('lobbyRoomCode').textContent = code;
        document.getElementById('topRoomCode').textContent = '🏠 ' + code;
        document.getElementById('lobbyStatus').textContent = statusMsg;
        document.getElementById('btnStartGame').classList.toggle('hidden', !isHost);
        document.getElementById('btnLeaveRoom').classList.remove('hidden');
        document.getElementById('createJoinRow').classList.add('hidden');
        document.getElementById('rejoinRow').classList.add('hidden');
    },

    async startGame() {
        const res = await Network.startGame();
        if (res.error) { alert(res.error); return; }
        document.getElementById('lobbyStatus').textContent = '游戏开始！';
    },

    leaveRoom() {
        Network.socket.emit('leave_room');
        Session.clear();
        this._resetLobby();
    },

    _resetLobby() {
        this.roomCode = null;
        this.isHost = false;
        document.getElementById('lobbyRoomCode').textContent = '';
        document.getElementById('topRoomCode').textContent = '';
        document.getElementById('lobbyStatus').textContent = '';
        document.getElementById('playerList').innerHTML = '';
        document.getElementById('btnStartGame').classList.add('hidden');
        document.getElementById('btnLeaveRoom').classList.add('hidden');
        document.getElementById('createJoinRow').classList.remove('hidden');
        document.getElementById('rejoinRow').classList.add('hidden');
    },

    /** 更新玩家列表（由 room_state 事件触发） */
    updatePlayerList(roomState) {
        document.getElementById('playerList').innerHTML = roomState.players.map(p =>
            `<div class="lobby-player">
                <span>${p.name} ${p.ready ? '✅' : '⏳'} ${p.connected ? '' : '🔌断线'}</span>
                ${p.id === roomState.hostId ? '<span class="badge badge-dealer">房主</span>' : ''}
            </div>`
        ).join('');

        // 如果房主转移给了自己，显示开始按钮
        if (roomState.hostId === Network.myPlayerId) {
            this.isHost = true;
            document.getElementById('btnStartGame').classList.remove('hidden');
        }
    },

    _getNickname() {
        return document.getElementById('inputNickname').value.trim() || '玩家';
    },
};
