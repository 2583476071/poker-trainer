/* ================================================================
 * server/game_manager.js — 房间生命周期管理
 * ================================================================ */

const { Room } = require('./room.js');
const { PokerGame } = require('./poker_game.js');
const { AI_PERSONALITIES, STARTING_CHIPS, SMALL_BLIND, BIG_BLIND } = require('../shared/constants.js');
const { shuffle } = require('../shared/deck.js');

class GameManager {
    constructor() {
        this.rooms = new Map();           // roomCode → Room
        this.playerRooms = new Map();     // socketId → { roomCode, playerId }
        this._nextPlayerId = 1;
    }

    /** 生成 6 位房间码（排除易混淆字符） */
    _generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do {
            code = '';
            for (let i = 0; i < 6; i++) {
                code += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.rooms.has(code));
        return code;
    }

    _genPlayerId() {
        return this._nextPlayerId++;
    }

    // ==================== 房间操作 ====================

    /** 创建房间 */
    createRoom(socketId, name) {
        const code = this._generateRoomCode();
        const playerId = this._genPlayerId();
        const room = new Room(code, playerId, name);
        room.players.set(playerId, { id: playerId, name, socketId, ready: true, connected: true });
        this.rooms.set(code, room);
        this.playerRooms.set(socketId, { roomCode: code, playerId });
        console.log(`🏠 房间 ${code} 创建，房主: ${name} (${playerId})`);
        return { roomCode: code, playerId };
    }

    /** 加入房间（游戏中则作为观战者） */
    joinRoom(roomCode, socketId, name) {
        const room = this.rooms.get(roomCode);
        if (!room) return { error: '房间不存在' };
        if (!room.isJoinable()) return { error: '房间无法加入（已满或已开始游戏）' };

        const allNames = [...room.players.values(), ...room.spectators.values()]
            .map(p => p.name);
        if (allNames.includes(name)) {
            return { error: '昵称已被使用，请换一个' };
        }

        if (room.phase === 'playing' || room.phase === 'finished') {
            // 观战模式
            const playerId = this._genPlayerId();
            room.spectators.set(playerId, { id: playerId, name, socketId, connected: true });
            this.playerRooms.set(socketId, { roomCode, playerId });
            console.log(`👀 ${name} 观战房间 ${roomCode}`);

            // 立即发送当前游戏状态
            if (room.game) {
                const state = room.game.getSpectatorState(playerId);
                return { roomCode, playerId, spectator: true, state };
            }
            return { roomCode, playerId, spectator: true };
        }

        // 大厅正常加入
        const playerId = this._genPlayerId();
        room.players.set(playerId, { id: playerId, name, socketId, ready: false, connected: true });
        this.playerRooms.set(socketId, { roomCode, playerId });
        console.log(`👤 ${name} 加入房间 ${roomCode}`);
        return { roomCode, playerId };
    }

    /** 离开房间 */
    leaveRoom(socketId) {
        const info = this.playerRooms.get(socketId);
        if (!info) return;
        const room = this.rooms.get(info.roomCode);
        if (!room) return;

        // 观战者 → 直接移除
        const spectator = room.spectators.get(info.playerId);
        if (spectator) {
            if (spectator._dcTimer) { clearTimeout(spectator._dcTimer); spectator._dcTimer = null; }
            room.spectators.delete(info.playerId);
            this.playerRooms.delete(socketId);
            console.log(`👀 ${spectator.name} 退出观战 (房间 ${info.roomCode})`);
            return;
        }

        const player = room.players.get(info.playerId);
        if (player) {
            // 清除断线计时器（主动离开不需要宽限期）
            if (player._dcTimer) { clearTimeout(player._dcTimer); player._dcTimer = null; }
            if (room.phase === 'lobby') {
                // 大厅中 → 直接删除
                room.players.delete(info.playerId);
                if (info.playerId === room.hostId) {
                    const next = room.getConnectedPlayers()[0];
                    if (next) room.hostId = next.id;
                }
            } else if (room.game && room.phase === 'playing') {
                // 游戏中 → AI 接管
                room.game.convertToAI(info.playerId);
                console.log(`🚪 ${player.name} 退出游戏，AI 接管 (房间 ${info.roomCode})`);
            }
            player.connected = false;
        }
        this.playerRooms.delete(socketId);
        this._checkRoomClosed(info.roomCode);
    }

    /** 切换准备状态 */
    setReady(socketId, ready) {
        const info = this.playerRooms.get(socketId);
        if (!info) return { error: '不在房间中' };
        const room = this.rooms.get(info.roomCode);
        if (!room) return { error: '房间不存在' };
        const player = room.players.get(info.playerId);
        if (!player) return { error: '玩家不存在' };
        player.ready = ready;
        return { ok: true };
    }

    /** 更新房间配置 */
    updateConfig(socketId, config) {
        const info = this.playerRooms.get(socketId);
        if (!info) return { error: '不在房间中' };
        const room = this.rooms.get(info.roomCode);
        if (!room) return { error: '房间不存在' };
        if (info.playerId !== room.hostId) return { error: '仅房主可修改配置' };
        Object.assign(room.config, config);
        return { ok: true };
    }

    /** 开始游戏 */
    startGame(roomCode, socketId) {
        const room = this.rooms.get(roomCode);
        if (!room) return { error: '房间不存在' };
        if (room.hostId !== this.playerRooms.get(socketId)?.playerId) {
            return { error: '仅房主可开始游戏' };
        }
        if (room.phase !== 'lobby') return { error: '游戏已开始' };

        const humans = room.getConnectedPlayers();
        if (humans.length < 1) return { error: '至少需要1名玩家' };

        // 计算AI数量：房主可选择 0~N 个AI
        const aiCount = Math.max(0, parseInt(room.config.aiCount) || 0);
        const maxAI = 9 - humans.length;
        const actualAI = Math.min(aiCount, maxAI);
        const totalPlayers = humans.length + actualAI;

        // 分配座位：人类与 AI 随机混排，剩余座位为空
        const seats = [];
        const shuffledAI = shuffle([...AI_PERSONALITIES]);

        // 随机抽座位给有人的位置
        const occupiedSeats = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).slice(0, totalPlayers);
        const humanSeats = new Set(occupiedSeats.slice(0, humans.length));
        const aiSeats = new Set(occupiedSeats.slice(humans.length));

        let humanIdx = 0;
        let aiIdx = 0;
        for (let seat = 0; seat < 9; seat++) {
            if (humanSeats.has(seat)) {
                const human = humans[humanIdx++];
                seats.push({
                    seatIndex: seat,
                    playerId: human.id,
                    name: human.name,
                    isHuman: true,
                    aiProfile: null,
                });
            } else if (aiSeats.has(seat)) {
                const aiProfile = room.config.gameMode === 'competitive'
                    ? shuffledAI[Math.floor(Math.random() * shuffledAI.length)]
                    : shuffledAI[aiIdx % shuffledAI.length];
                seats.push({
                    seatIndex: seat,
                    playerId: this._genPlayerId(),
                    name: `AI-${aiIdx + 1}`,
                    isHuman: false,
                    aiProfile,
                });
                aiIdx++;
            }
            // else: 空位，不加入 seats（PokerGame 内部 this.players 不包含该座位）
        }

        // 创建 PokerGame
        const game = new PokerGame({
            seats,
            smallBlind: room.config.smallBlind,
            bigBlind: room.config.bigBlind,
            startingChips: room.config.startingChips,
            gameMode: room.config.gameMode,
            turnTimeout: room.config.turnTimeout,
        });

        // 存储空位信息供观战者加入时验证
        room._emptySeats = new Set();
        for (let seat = 0; seat < 9; seat++) {
            if (!humanSeats.has(seat) && !aiSeats.has(seat)) {
                room._emptySeats.add(seat);
            }
        }

        // 设置广播回调（玩家）
        game.onBroadcast = (playerId, state) => {
            for (const [sid, info] of this.playerRooms) {
                if (info.roomCode === roomCode && info.playerId === playerId) {
                    const io = this._io;
                    if (io) io.to(sid).emit('state_update', state);
                    break;
                }
            }
        };

        // 设置广播回调（观战者）
        game._onSpectatorBroadcast = (state) => {
            for (const [sid, info] of this.playerRooms) {
                if (info.roomCode === roomCode && room.spectators.has(info.playerId)) {
                    if (this._io) this._io.to(sid).emit('state_update', state);
                }
            }
        };

        game.onGameOver = (results) => {
            // 广播游戏结束
            for (const p of room.players.values()) {
                if (p.connected) {
                    const info = [...this.playerRooms.entries()]
                        .find(([, v]) => v.roomCode === roomCode && v.playerId === p.id);
                    if (info) this._io?.to(info[0]).emit('game_over', results);
                }
            }
            room.phase = 'finished';
        };

        room.game = game;
        room.phase = 'playing';
        console.log(`🎮 房间 ${roomCode} 游戏开始，${humans.length} 人类 + ${actualAI} AI，${9 - totalPlayers} 空位`);
        return { ok: true };
    }

    /** 通过 socketId 获取所在房间 */
    getRoom(socketId) {
        const info = this.playerRooms.get(socketId);
        if (!info) return null;
        return this.rooms.get(info.roomCode);
    }

    /** 通过 socketId 获取玩家信息 */
    getPlayerInfo(socketId) {
        return this.playerRooms.get(socketId) || null;
    }

    /** 处理断线 */
    handleDisconnect(socketId) {
        const info = this.playerRooms.get(socketId);
        if (!info) return;
        const room = this.rooms.get(info.roomCode);
        if (!room) return;

        // 观战者断线 → 标记断线，30s 宽限期后清理
        const spectator = room.spectators.get(info.playerId);
        if (spectator) {
            spectator.connected = false;
            spectator._disconnectTime = Date.now();
            console.log(`👀 ${spectator.name} 观战者断开 (房间 ${info.roomCode})，30s 宽限期`);
            // 30s 后检查是否重连
            spectator._dcTimer = setTimeout(() => {
                const freshRoom = this.rooms.get(info.roomCode);
                if (!freshRoom) return;
                const freshSpec = freshRoom.spectators.get(info.playerId);
                if (freshSpec && !freshSpec.connected) {
                    freshRoom.spectators.delete(info.playerId);
                    for (const [sid, pinfo] of this.playerRooms) {
                        if (pinfo.playerId === info.playerId) {
                            this.playerRooms.delete(sid); break;
                        }
                    }
                    console.log(`👀 ${spectator.name} 观战者超时未重连，已清理 (房间 ${info.roomCode})`);
                }
            }, 30000);
            return;
        }

        const player = room.players.get(info.playerId);
        if (!player) return;

        player.connected = false;
        player._disconnectTime = Date.now();

        // 大厅中房主断线 → 转移房主给下一个在线玩家
        if (room.phase === 'lobby' && info.playerId === room.hostId) {
            const next = room.getConnectedPlayers().find(p => p.id !== info.playerId);
            if (next) room.hostId = next.id;
        }

        console.log(`🔌 ${player.name} 断线 (房间 ${info.roomCode})`);

        // 大厅玩家：60s 宽限期后才清理
        if (room.phase === 'lobby') {
            player._dcTimer = setTimeout(() => {
                const freshRoom = this.rooms.get(info.roomCode);
                if (!freshRoom) return;
                const freshPlayer = freshRoom.players.get(info.playerId);
                if (freshPlayer && !freshPlayer.connected) {
                    freshRoom.players.delete(info.playerId);
                    for (const [sid, pinfo] of this.playerRooms) {
                        if (pinfo.playerId === info.playerId) {
                            this.playerRooms.delete(sid); break;
                        }
                    }
                    console.log(`🚫 ${player.name} 超时未重连，移出房间 (房间 ${info.roomCode})`);
                    this._checkRoomClosed(info.roomCode);
                }
            }, 60000);
        } else {
            // 游戏中玩家：60s 宽限期后才关闭房间
            player._dcTimer = setTimeout(() => {
                this._checkRoomClosed(info.roomCode);
            }, 60000);
        }
        // 不要立即关闭房间，给 60s 重连宽限期
    }

    /** 重连（通过 playerId） */
    reconnect(socketId, playerId, roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) return { error: '房间不存在' };
        const player = room.players.get(playerId);
        if (!player) return { error: '玩家不存在，可能已被移除' };

        return this._doReconnect(room, player, socketId, roomCode, playerId);
    }

    /** 重连（通过昵称 — 适合掉线后忘记 playerId 的情况） */
    reconnectByName(socketId, roomCode, playerName) {
        const room = this.rooms.get(roomCode);
        if (!room) return { error: '房间不存在或已过期' };

        // 按名称查找断线玩家
        let found = null;
        for (const [id, p] of room.players) {
            if (p.name === playerName && !p.connected) {
                found = { player: p, playerId: id };
                break;
            }
        }
        if (!found) return { error: '未找到该昵称的断线玩家，或玩家已在线' };

        return this._doReconnect(room, found.player, socketId, roomCode, found.playerId);
    }

    /** 观战者加入空位（场上无AI时可入座） */
    joinEmptySeat(socketId, roomCode, seatIndex) {
        const room = this.rooms.get(roomCode);
        if (!room) return { error: '房间不存在' };
        if (!room.game || room.phase !== 'playing') return { error: '游戏未开始' };

        // 验证观战者身份
        const spectator = room.spectators.get(this.playerRooms.get(socketId)?.playerId);
        if (!spectator) return { error: '你不是观战者' };

        // 验证座位为空
        if (!room._emptySeats || !room._emptySeats.has(seatIndex)) {
            return { error: '该座位不可加入（非空位或已被占用）' };
        }

        const playerId = this.playerRooms.get(socketId).playerId;
        const specName = spectator.name;

        // 调用游戏逻辑加入空位
        const result = room.game.joinEmptySeat(playerId, specName, seatIndex);
        if (result.error) return result;

        // 从空位集中移除
        room._emptySeats.delete(seatIndex);

        // 从观战者移到玩家列表
        room.spectators.delete(playerId);
        room.players.set(playerId, { id: playerId, name: specName, socketId, ready: true, connected: true });

        // 返回个性化游戏状态
        const state = room.game.getState(playerId);
        console.log(`🪑 ${specName} 加入空位 ${seatIndex} (房间 ${roomCode})`);
        return { ok: true, state, playerId };
    }

    _doReconnect(room, player, socketId, roomCode, playerId) {
        // 清除断线计时器
        if (player._dcTimer) {
            clearTimeout(player._dcTimer);
            player._dcTimer = null;
        }
        player._disconnectTime = null;

        // 清除房间过期定时器
        if (room._cleanupTimer) {
            clearTimeout(room._cleanupTimer);
            room._cleanupTimer = null;
        }

        player.connected = true;
        player.socketId = socketId;
        room.touch();

        // 更新 socket 映射
        for (const [sid, info] of this.playerRooms) {
            if (info.playerId === playerId && sid !== socketId) {
                this.playerRooms.delete(sid);
            }
        }
        this.playerRooms.set(socketId, { roomCode, playerId });

        console.log(`🔄 ${player.name} 重连 (房间 ${roomCode})`);

        // 如果在游戏中，发送当前状态
        if (room.game && room.phase === 'playing') {
            const state = room.game.getState(playerId);
            return { reconnected: true, state, playerId };
        }

        return { reconnected: true, playerId };
    }

    /** 检查房间是否为空，空则延迟关闭（给断线玩家重连机会） */
    _checkRoomClosed(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) return;
        const hasPlayer = [...room.players.values()].some(p => p.connected);
        if (!hasPlayer) {
            // 如果已经有定时器在跑，不重复设置
            if (room._cleanupTimer) return;
            console.log(`⏳ 房间 ${roomCode} 所有玩家断开，60s 后关闭...`);
            room._cleanupTimer = setTimeout(() => {
                const freshRoom = this.rooms.get(roomCode);
                if (!freshRoom) return;
                const stillEmpty = ![...freshRoom.players.values()].some(p => p.connected);
                if (stillEmpty) {
                    console.log(`🚫 房间 ${roomCode} 超时无重连，关闭房间`);
                    if (this._io) {
                        for (const [sid, info] of this.playerRooms) {
                            if (info.roomCode === roomCode) {
                                this._io.to(sid).emit('room_closed', {});
                            }
                        }
                    }
                    for (const [sid, info] of this.playerRooms) {
                        if (info.roomCode === roomCode) this.playerRooms.delete(sid);
                    }
                    // 清除所有待处理的断线计时器
                    for (const [, p] of freshRoom.players) {
                        if (p._dcTimer) { clearTimeout(p._dcTimer); p._dcTimer = null; }
                    }
                    for (const [, s] of freshRoom.spectators) {
                        if (s._dcTimer) { clearTimeout(s._dcTimer); s._dcTimer = null; }
                    }
                    freshRoom._cleanupTimer = null;
                    this.rooms.delete(roomCode);
                } else {
                    room._cleanupTimer = null;
                    console.log(`✅ 房间 ${roomCode} 有玩家重连，取消关闭`);
                }
            }, 60000);
        }
    }

    /** 设置 Socket.IO 实例（供 network_handler 调用） */
    setIO(io) { this._io = io; }
}

module.exports = { GameManager };
