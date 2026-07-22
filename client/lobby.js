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
        document.getElementById('btnStartGame').addEventListener('click', () => this.startGame());
        document.getElementById('btnLeaveRoom').addEventListener('click', () => this.leaveRoom());
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

    async createRoom() {
        const name = this._getNickname();
        const res = await Network.createRoom(name);
        if (res.error) { alert(res.error); return; }
        this.roomCode = res.roomCode;
        this.isHost = true;
        document.getElementById('lobbyRoomCode').textContent = res.roomCode;
        document.getElementById('lobbyStatus').textContent = '等待玩家加入...';
        document.getElementById('btnStartGame').classList.remove('hidden');
        document.getElementById('btnLeaveRoom').classList.remove('hidden');
        document.getElementById('createJoinRow').classList.add('hidden');
    },

    async joinRoom() {
        const name = this._getNickname();
        const code = document.getElementById('inputRoomCode').value.trim().toUpperCase();
        if (!code) { alert('请输入房间码'); return; }
        const res = await Network.joinRoom(code, name);
        if (res.error) { alert(res.error); return; }
        this.roomCode = code;
        this.isHost = false;
        document.getElementById('lobbyRoomCode').textContent = code;
        document.getElementById('lobbyStatus').textContent = '等待房主开始游戏...';
        document.getElementById('btnStartGame').classList.add('hidden');
        document.getElementById('btnLeaveRoom').classList.remove('hidden');
        document.getElementById('createJoinRow').classList.add('hidden');
    },

    async startGame() {
        const res = await Network.startGame();
        if (res.error) { alert(res.error); return; }
        document.getElementById('lobbyStatus').textContent = '游戏开始！';
    },

    leaveRoom() {
        Network.socket.emit('leave_room');
        this.roomCode = null;
        this.isHost = false;
        document.getElementById('lobbyRoomCode').textContent = '';
        document.getElementById('lobbyStatus').textContent = '';
        document.getElementById('playerList').innerHTML = '';
        document.getElementById('btnStartGame').classList.add('hidden');
        document.getElementById('btnLeaveRoom').classList.add('hidden');
        document.getElementById('createJoinRow').classList.remove('hidden');
    },

    /** 更新玩家列表（由 room_state 事件触发） */
    updatePlayerList(roomState) {
        document.getElementById('playerList').innerHTML = roomState.players.map(p =>
            `<div class="lobby-player">
                <span>${p.name} ${p.ready ? '✅' : '⏳'} ${p.connected ? '' : '🔌'}</span>
                ${p.id === roomState.hostId ? '<span class="badge badge-dealer">房主</span>' : ''}
            </div>`
        ).join('');
    },

    _getNickname() {
        return document.getElementById('inputNickname').value.trim() || '玩家';
    },
};
