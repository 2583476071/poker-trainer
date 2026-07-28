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
        this.socket = io({
            transports: ['websocket', 'polling'],  // 双通道：WebSocket优先，自动降级到轮询
            reconnection: true,
            reconnectionAttempts: Infinity,         // 无限重试
            reconnectionDelay: 1000,                // 首次重连延迟 1s
            reconnectionDelayMax: 10000,            // 最大重连延迟 10s（指数退避）
            randomizationFactor: 0.3,               // ±30% 随机抖动，避免重连风暴
            timeout: 20000,                         // 连接超时 20s
        });

        // 重连事件日志
        this.socket.io.on('reconnect_attempt', (attempt) => {
            console.log(`🔄 重连尝试 #${attempt}...`);
        });
        this.socket.io.on('reconnect', () => {
            console.log('✅ 重连成功');
        });
        this.socket.io.on('reconnect_error', (err) => {
            console.warn('⚠️ 重连失败:', err.message);
        });
        this.socket.io.on('reconnect_failed', () => {
            console.error('❌ 所有重连尝试失败');
        });

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

/** SessionStorage → localStorage 管理 — 掉线/刷新/关闭浏览器后恢复房间状态 */
const Session = {
    _key: 'pt_session',

    save(roomCode, playerId, nickname) {
        try {
            localStorage.setItem(this._key, JSON.stringify({
                roomCode, playerId, nickname,
                timestamp: Date.now(),
            }));
            console.log(`💾 Session 已保存: ${roomCode} / ${nickname} (pid=${playerId})`);
        } catch (e) { console.warn('Session 保存失败:', e.message); }
    },

    load() {
        try {
            const raw = localStorage.getItem(this._key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            // 2 小时内有效（原 30 分钟，延长以适应长游戏局）
            if (Date.now() - data.timestamp > 2 * 60 * 60 * 1000) {
                localStorage.removeItem(this._key);
                console.log('🗑️ Session 已过期，已清除');
                return null;
            }
            console.log(`📂 Session 已加载: ${data.roomCode} / ${data.nickname}`);
            return data;
        } catch (e) { console.warn('Session 加载失败:', e.message); return null; }
    },

    clear() {
        try { localStorage.removeItem(this._key); console.log('🧹 Session 已清除'); } catch (e) { /* ignore */ }
    },
};
