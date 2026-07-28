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
            room.spectators.delete(info.playerId);
            this.playerRooms.delete(socketId);
            console.log(`👀 ${spectator.name} 退出观战 (房间 ${info.roomCode})`);
            return;
        }

        const player = room.players.get(info.playerId);
        if (player) {
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

        // 分配座位：人类与 AI 随机混排
        const seats = [];
        const shuffledAI = shuffle([...AI_PERSONALITIES]);

        // 随机抽座位给人类
        const allSeats = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        const humanSeats = new Set(allSeats.slice(0, humans.length));

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
            } else {
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
        console.log(`🎮 房间 ${roomCode} 游戏开始，${humans.length} 人类 + ${9 - humans.length} AI`);
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

        // 观战者断线 → 直接清理
        const spectator = room.spectators.get(info.playerId);
        if (spectator) {
            room.spectators.delete(info.playerId);
            this.playerRooms.delete(socketId);
            console.log(`👀 ${spectator.name} 观战者断开 (房间 ${info.roomCode})`);
            return;
        }

        const player = room.players.get(info.playerId);
        if (!player) return;

        player.connected = false;

        // 大厅中房主断线 → 转移房主给下一个在线玩家
        if (room.phase === 'lobby' && info.playerId === room.hostId) {
            const next = room.getConnectedPlayers().find(p => p.id !== info.playerId);
            if (next) room.hostId = next.id;
        }

        console.log(`🔌 ${player.name} 断线 (房间 ${info.roomCode})`);

        // 游戏中 → 启动房间保活定时器
        if (room.phase !== 'lobby' && !room._cleanupTimer) {
            room._cleanupTimer = setTimeout(() => {
                const hasConnected = [...room.players.values()].some(p => p.connected);
                if (!hasConnected) {
                    console.log(`🧹 房间 ${room.code} 所有玩家离线超时，清理`);
                    this.rooms.delete(room.code);
                    for (const [sid, inf] of this.playerRooms) {
                        if (inf.roomCode === room.code) this.playerRooms.delete(sid);
                    }
                }
            }, 30 * 60 * 1000);
        }
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

    _doReconnect(room, player, socketId, roomCode, playerId) {
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

    /** 设置 Socket.IO 实例（供 network_handler 调用） */
    setIO(io) { this._io = io; }
}

module.exports = { GameManager };
