/* ================================================================
 * client/network.js — 高可靠连接层
 *
 * 核心设计：
 *   1. 应用层心跳 — 不依赖 Socket.IO 内置 ping/pong
 *   2. 状态恢复 — 断线重连后服务端下发完整游戏状态
 *   3. 重连 UI — 遮罩提示，不让玩家困惑
 * ================================================================ */

const Network = {
    socket: null,
    myPlayerId: null,
    callbacks: {},
    _heartbeatTimer: null,
    _heartbeatTimeout: null,
    _intentionalClose: false,

    connect() {
        if (this.socket) return;

        this._intentionalClose = false;
        this.socket = io({
            transports: ['polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 300,
            reconnectionDelayMax: 3000,
            randomizationFactor: 0.5,
            timeout: 12000,
            upgrade: false,
            forceNew: true,
        });

        // ---- 应用层心跳 ----
        this.socket.on('server_ping', () => {
            this.socket.emit('client_pong');
            this._resetHeartbeatTimeout();
        });
        this._startHeartbeatTimeout();

        // ---- Socket.IO 底层重连 ----
        this.socket.io.on('reconnect_attempt', (n) => {
            console.log('🔄 重连 #' + n);
            if (this.callbacks.reconnecting) this.callbacks.reconnecting(n);
        });
        this.socket.io.on('reconnect', () => {
            console.log('✅ Socket 重连，请求状态恢复...');
            this._startHeartbeatTimeout();
            this._recoverState();
        });
        this.socket.io.on('reconnect_error', (e) => {
            console.warn('⚠️ 重连失败:', e.message);
        });

        // ---- 连接/断开 ----
        this.socket.on('connect', () => {
            console.log('🔗 连接成功:', this.socket.id);
            this._startHeartbeatTimeout();
            // 首次连接：尝试恢复已有会话
            const saved = Session.load();
            if (saved && saved.roomCode) {
                this._recoverState();
                return;
            }
            if (this.callbacks.connect) this.callbacks.connect();
        });

        this.socket.on('disconnect', (reason) => {
            console.log('🔌 断开:', reason);
            this._clearHeartbeat();
            if (reason === 'io client disconnect' || reason === 'io server disconnect') {
                this._intentionalClose = true;
            }
            if (this.callbacks.disconnect) this.callbacks.disconnect(reason);
        });

        this.socket.on('connect_error', (e) => {
            console.error('连接失败:', e.message);
        });

        // ---- 游戏事件 ----
        this.socket.on('room_state', (s) => { if (this.callbacks.roomState) this.callbacks.roomState(s); });
        this.socket.on('state_update', (s) => { if (this.callbacks.stateUpdate) this.callbacks.stateUpdate(s); });
        this.socket.on('game_starting', () => { if (this.callbacks.gameStarting) this.callbacks.gameStarting(); });
        this.socket.on('game_over', (r) => { Session.clear(); if (this.callbacks.gameOver) this.callbacks.gameOver(r); });
        this.socket.on('room_closed', () => { this._intentionalClose = true; Session.clear(); if (this.callbacks.roomClosed) this.callbacks.roomClosed(); });
        this.socket.on('error', (e) => { console.error('服务器错误:', e.message); if (this.callbacks.error) this.callbacks.error(e); });
    },

    /** 断线重连后恢复游戏/房间状态 */
    _recoverState() {
        const saved = Session.load();
        if (!saved || !saved.roomCode) {
            if (this.callbacks.reconnectFailed) this.callbacks.reconnectFailed();
            return;
        }
        this.socket.emit('reconnect_room', {
            roomCode: saved.roomCode,
            playerId: saved.playerId,
        }, (res) => {
            if (res && res.ok) {
                this.myPlayerId = res.playerId;
                console.log('✅ 状态恢复成功');
                if (this.callbacks.reconnected) this.callbacks.reconnected(res);
                return;
            }
            // playerId 失效，尝试昵称
            if (saved.nickname) {
                this.socket.emit('rejoin_room', {
                    roomCode: saved.roomCode,
                    nickname: saved.nickname,
                }, (res2) => {
                    if (res2 && res2.ok) {
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

    // ---- 心跳 ----
    _startHeartbeatTimeout() {
        this._clearHeartbeat();
        this._heartbeatTimeout = setTimeout(() => {
            console.warn('💔 心跳超时，主动断开重连...');
            if (this.socket) this.socket.disconnect();
            if (this.socket) this.socket.connect();
        }, 20000);  // 20s 无心跳 → 主动重连
    },
    _resetHeartbeatTimeout() {
        if (this._heartbeatTimeout) {
            clearTimeout(this._heartbeatTimeout);
            this._heartbeatTimeout = null;
        }
        this._startHeartbeatTimeout();
    },
    _clearHeartbeat() {
        if (this._heartbeatTimeout) { clearTimeout(this._heartbeatTimeout); this._heartbeatTimeout = null; }
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    },

    // ---- API ----
    createRoom(nickname) {
        return this._emitP('create_room', { nickname }).then(r => {
            if (r.ok) { this.myPlayerId = r.playerId; Session.save(r.roomCode, r.playerId, nickname); }
            return r;
        });
    },
    joinRoom(roomCode, nickname) {
        return this._emitP('join_room', { roomCode, nickname }).then(r => {
            if (r.ok || r.spectator) { this.myPlayerId = r.playerId; Session.save(roomCode, r.playerId, nickname); }
            return r;
        });
    },
    rejoinRoom(roomCode, nickname) {
        return this._emitP('rejoin_room', { roomCode, nickname }).then(r => {
            if (r.ok) { this.myPlayerId = r.playerId; Session.save(roomCode, r.playerId, nickname); }
            return r;
        });
    },
    startGame() { return this._emitP('start_game', {}); },
    updateConfig(c) { return this._emitP('update_config', c); },
    joinSeat(i) { return this._emitP('join_seat', { seatIndex: i }); },
    rebuy() { return this._emitP('rebuy', {}); },
    takeSeat(id) { return this._emitP('take_seat', { targetPlayerId: id }); },
    sendAction(action, multiplier) { this.socket.emit('player_action', { action, multiplier }); },
    nextHand() { this.socket.emit('next_hand'); },

    _emitP(event, data) {
        return new Promise(resolve => {
            this.socket.emit(event, data, resolve);
        });
    },

    on(event, callback) { this.callbacks[event] = callback; },
};

/* ---- Session ---- */
const Session = {
    _key: 'pt_session',
    _nickKey: 'pt_nickname',
    save(roomCode, playerId, nickname) {
        try {
            localStorage.setItem(this._key, JSON.stringify({ roomCode, playerId, nickname, ts: Date.now() }));
            if (nickname) localStorage.setItem(this._nickKey, nickname);
        } catch (e) {}
    },
    load() {
        try {
            const d = JSON.parse(localStorage.getItem(this._key));
            if (!d) return null;
            if (Date.now() - d.ts > 30 * 60 * 1000) { localStorage.removeItem(this._key); return null; }
            return d;
        } catch (e) { return null; }
    },
    getNickname() { try { return localStorage.getItem(this._nickKey) || ''; } catch (e) { return ''; } },
    clear() { try { localStorage.removeItem(this._key); } catch (e) {} },
};
