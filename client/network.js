/* ================================================================
 * client/network.js — Socket.IO 客户端封装（高可用版）
 * ================================================================ */

const Network = {
    socket: null,
    myPlayerId: null,
    callbacks: {},
    _reconnecting: false,

    /** 连接服务器 */
    connect() {
        if (this.socket) return;
        this.socket = io({
            transports: ['polling'],        // 仅轮询，不用 WebSocket（最稳定）
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 500,
            reconnectionDelayMax: 5000,
            randomizationFactor: 0.5,
            timeout: 15000,
            upgrade: false,
        });

        // ---- Socket.IO 底层重连事件 ----
        this.socket.io.on('reconnect_attempt', (attempt) => {
            console.log(`🔄 重连尝试 #${attempt}...`);
            this._reconnecting = true;
            if (this.callbacks.reconnecting) this.callbacks.reconnecting(attempt);
        });

        this.socket.io.on('reconnect', () => {
            console.log('✅ Socket 重连成功，重新加入房间...');
            this._reconnecting = false;
            this._rejoinAfterReconnect();
        });

        this.socket.io.on('reconnect_error', (err) => {
            console.warn('⚠️ 重连失败:', err.message);
        });

        this.socket.io.on('reconnect_failed', () => {
            console.error('❌ 重连彻底失败');
            this._reconnecting = false;
            if (this.callbacks.reconnectFailed) this.callbacks.reconnectFailed();
        });

        // ---- 应用层事件 ----
        this.socket.on('connect', () => {
            console.log('🔗 已连接:', this.socket.id);
            // 首次连接才触发 connect 回调；重连走 _rejoinAfterReconnect
            if (!this._reconnecting) {
                const saved = Session.load();
                if (saved && saved.roomCode && saved.playerId) {
                    this._rejoinAfterReconnect();
                    return;
                }
                if (this.callbacks.connect) this.callbacks.connect();
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('🔌 断开:', reason);
            if (this.callbacks.disconnect) this.callbacks.disconnect(reason);
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

        this.socket.on('room_closed', () => {
            Session.clear();
            if (this.callbacks.roomClosed) this.callbacks.roomClosed();
        });

        this.socket.on('connect_error', (err) => {
            console.error('⚠️ 连接失败:', err.message);
            if (this.callbacks.connectError) this.callbacks.connectError(err);
        });

        this.socket.on('error', (err) => {
            console.error('服务器错误:', err.message);
            if (this.callbacks.error) this.callbacks.error(err);
        });
    },

    /** Socket 重连后尝试重新加入房间 */
    _rejoinAfterReconnect() {
        const saved = Session.load();
        if (!saved || !saved.roomCode) return;

        console.log('🔄 重新加入房间:', saved.roomCode);
        this.socket.emit('reconnect_room', {
            roomCode: saved.roomCode,
            playerId: saved.playerId,
        }, (res) => {
            if (res.ok) {
                this.myPlayerId = res.playerId;
                console.log('✅ 重连成功');
                if (this.callbacks.reconnected) this.callbacks.reconnected(res);
            } else if (saved.nickname) {
                // 尝试昵称重连
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
                if (res.ok || res.spectator) {
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

    /** 更新房间配置（仅房主） */
    updateConfig(config) {
        return new Promise((resolve) => {
            this.socket.emit('update_config', config, resolve);
        });
    },

    /** 加入空位（观战者） */
    joinSeat(seatIndex) {
        return new Promise((resolve) => {
            this.socket.emit('join_seat', { seatIndex }, resolve);
        });
    },

    /** 发送玩家行动 */
    sendAction(action, multiplier) {
        this.socket.emit('player_action', { action, multiplier });
    },

    /** 补码 */
    rebuy() {
        return new Promise((resolve) => {
            this.socket.emit('rebuy', {}, resolve);
        });
    },

    /** 观战者接管 AI 座位 */
    takeSeat(targetPlayerId) {
        return new Promise((resolve) => {
            this.socket.emit('take_seat', { targetPlayerId }, resolve);
        });
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

/** localStorage 管理 — 掉线/刷新/关闭浏览器后恢复房间状态 */
const Session = {
    _key: 'pt_session',
    _nickKey: 'pt_nickname',

    save(roomCode, playerId, nickname) {
        try {
            localStorage.setItem(this._key, JSON.stringify({
                roomCode, playerId, nickname,
                timestamp: Date.now(),
            }));
            if (nickname) localStorage.setItem(this._nickKey, nickname);
        } catch (e) {}
    },

    load() {
        try {
            const raw = localStorage.getItem(this._key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (Date.now() - data.timestamp > 30 * 60 * 1000) {
                localStorage.removeItem(this._key);
                return null;
            }
            return data;
        } catch (e) { return null; }
    },

    getNickname() {
        try { return localStorage.getItem(this._nickKey) || ''; } catch (e) { return ''; }
    },

    clear() {
        try { localStorage.removeItem(this._key); } catch (e) {}
    },
};
