/* ================================================================
 * client/network.js — Socket.IO 客户端封装
 * ================================================================ */

const Network = {
    socket: null,
    myPlayerId: null,
    callbacks: {},

    /** 连接服务器 */
    connect() {
        if (this.socket) return;
        this.socket = io({ transports: ['websocket'] });

        this.socket.on('connect', () => {
            console.log('🔗 已连接:', this.socket.id);
            if (this.callbacks.connect) this.callbacks.connect();
        });

        this.socket.on('disconnect', () => {
            console.log('🔌 已断开');
            if (this.callbacks.disconnect) this.callbacks.disconnect();
        });

        this.socket.on('room_state', (state) => {
            if (this.callbacks.roomState) this.callbacks.roomState(state);
        });

        this.socket.on('state_update', (state) => {
            if (this.callbacks.stateUpdate) this.callbacks.stateUpdate(state);
        });

        this.socket.on('game_starting', () => {
            if (this.callbacks.gameStarting) this.callbacks.gameStarting();
        });

        this.socket.on('game_over', (results) => {
            if (this.callbacks.gameOver) this.callbacks.gameOver(results);
        });

        this.socket.on('error', (err) => {
            console.error('服务器错误:', err.message);
            if (this.callbacks.error) this.callbacks.error(err);
        });
    },

    /** 创建房间 */
    createRoom(nickname) {
        return new Promise((resolve) => {
            this.socket.emit('create_room', { nickname }, (res) => {
                if (res.ok) this.myPlayerId = res.playerId;
                resolve(res);
            });
        });
    },

    /** 加入房间 */
    joinRoom(roomCode, nickname) {
        return new Promise((resolve) => {
            this.socket.emit('join_room', { roomCode, nickname }, (res) => {
                if (res.ok) this.myPlayerId = res.playerId;
                resolve(res);
            });
        });
    },

    /** 开始游戏（仅房主） */
    startGame() {
        return new Promise((resolve) => {
            this.socket.emit('start_game', {}, resolve);
        });
    },

    /** 发送玩家行动 */
    sendAction(action, multiplier) {
        this.socket.emit('player_action', { action, multiplier });
    },

    /** 下一局 */
    nextHand() {
        this.socket.emit('next_hand');
    },

    /** 注册回调 */
    on(event, callback) {
        this.callbacks[event] = callback;
    },
};
