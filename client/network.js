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

            // 自动尝试重连已保存的房间
            const saved = Session.load();
            if (saved && saved.roomCode && saved.playerId) {
                console.log('🔄 自动重连...');
                this.socket.emit('reconnect_room', {
                    roomCode: saved.roomCode,
                    playerId: saved.playerId,
                }, (res) => {
                    if (res.ok) {
                        this.myPlayerId = res.playerId;
                        if (this.callbacks.reconnected) this.callbacks.reconnected(res);
                    } else {
                        // playerId 重连失败，尝试按昵称重连
                        if (saved.nickname) {
                            this.socket.emit('rejoin_room', {
                                roomCode: saved.roomCode,
                                nickname: saved.nickname,
                            }, (res2) => {
                                if (res2.ok) {
                                    this.myPlayerId = res2.playerId;
                                    Session.save(saved.roomCode, res2.playerId, saved.nickname);
                                    if (this.callbacks.reconnected) this.callbacks.reconnected(res2);
                                } else {
                                    Session.clear();
                                    if (this.callbacks.reconnectFailed) this.callbacks.reconnectFailed();
                                }
                            });
                        } else {
                            Session.clear();
                            if (this.callbacks.reconnectFailed) this.callbacks.reconnectFailed();
                        }
                    }
                });
                return;
            }

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
            Session.clear();
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
                if (res.ok) {
                    this.myPlayerId = res.playerId;
                    Session.save(res.roomCode, res.playerId, nickname);
                }
                resolve(res);
            });
        });
    },

    /** 加入房间 */
    joinRoom(roomCode, nickname) {
        return new Promise((resolve) => {
            this.socket.emit('join_room', { roomCode, nickname }, (res) => {
                if (res.ok) {
                    this.myPlayerId = res.playerId;
                    Session.save(roomCode, res.playerId, nickname);
                }
                resolve(res);
            });
        });
    },

    /** 手动重连（用户点击按钮） */
    rejoinRoom(roomCode, nickname) {
        return new Promise((resolve) => {
            this.socket.emit('rejoin_room', { roomCode, nickname }, (res) => {
                if (res.ok) {
                    this.myPlayerId = res.playerId;
                    Session.save(roomCode, res.playerId, nickname);
                }
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

/** SessionStorage 管理 — 掉线/刷新后恢复房间状态 */
const Session = {
    _key: 'pt_session',

    save(roomCode, playerId, nickname) {
        try {
            sessionStorage.setItem(this._key, JSON.stringify({
                roomCode, playerId, nickname,
                timestamp: Date.now(),
            }));
        } catch (e) { /* ignore */ }
    },

    load() {
        try {
            const raw = sessionStorage.getItem(this._key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            // 30 分钟内有效
            if (Date.now() - data.timestamp > 30 * 60 * 1000) {
                sessionStorage.removeItem(this._key);
                return null;
            }
            return data;
        } catch (e) { return null; }
    },

    clear() {
        try { sessionStorage.removeItem(this._key); } catch (e) { /* ignore */ }
    },
};
