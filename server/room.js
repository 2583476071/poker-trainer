/* ================================================================
 * server/room.js — 房间数据结构
 * ================================================================ */

class Room {
    constructor(code, hostId, hostName) {
        this.code = code;               // 6位房间码，如 "A3F9K2"
        this.hostId = hostId;           // 房主 playerId
        this.players = new Map();       // playerId → { id, name, socketId, ready, connected }
        this.phase = 'lobby';           // 'lobby' | 'playing' | 'finished'
        this.game = null;               // PokerGame 实例（null 直到游戏开始）
        this.createdAt = Date.now();
        this.config = {
            aiCount: 8,
            startingChips: 20000,
            smallBlind: 100,
            bigBlind: 200,
            gameMode: 'training',
            turnTimeout: 60,
        };
    }

    /** 获取所有已连接的玩家 */
    getConnectedPlayers() {
        return [...this.players.values()].filter(p => p.connected);
    }

    /** 获取所有准备就绪的玩家 */
    getReadyPlayers() {
        return [...this.players.values()].filter(p => p.ready && p.connected);
    }

    /** 房间是否可加入 */
    isJoinable() {
        return this.phase === 'lobby' && this.getConnectedPlayers().length < 9;
    }

    /** 转为可序列化的 JSON（通过 Socket.IO 发送） */
    toJSON() {
        return {
            code: this.code,
            hostId: this.hostId,
            players: [...this.players.values()].map(p => ({
                id: p.id,
                name: p.name,
                ready: p.ready,
                connected: p.connected,
            })),
            phase: this.phase,
            config: this.config,
            playerCount: this.getConnectedPlayers().length,
        };
    }
}

module.exports = { Room };
