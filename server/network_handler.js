/* ================================================================
 * server/network_handler.js — Socket.IO 事件处理
 * ================================================================ */

function setupNetworkHandlers(io, gameManager) {
    gameManager.setIO(io);

    io.on('connection', (socket) => {
        console.log(`🔗 新连接: ${socket.id}`);

        // ========== 房间操作 ==========

        socket.on('create_room', ({ nickname }, callback) => {
            try {
                const result = gameManager.createRoom(socket.id, nickname || '玩家');
                socket.join(result.roomCode);
                callback({ ok: true, ...result });
                // 广播房间状态
                _broadcastRoomState(gameManager, result.roomCode);
            } catch (e) {
                callback({ error: e.message });
            }
        });

        socket.on('join_room', ({ roomCode, nickname }, callback) => {
            try {
                const result = gameManager.joinRoom(roomCode, socket.id, nickname || '玩家');
                if (result.error) { callback(result); return; }
                socket.join(roomCode);
                callback({ ok: true, ...result });
                _broadcastRoomState(gameManager, roomCode);
            } catch (e) {
                callback({ error: e.message });
            }
        });

        socket.on('set_ready', ({ ready }, callback) => {
            const result = gameManager.setReady(socket.id, ready);
            callback?.(result || { ok: true });
            const info = gameManager.getPlayerInfo(socket.id);
            if (info) _broadcastRoomState(gameManager, info.roomCode);
        });

        socket.on('update_config', (config, callback) => {
            const result = gameManager.updateConfig(socket.id, config);
            callback?.(result || { ok: true });
            const info = gameManager.getPlayerInfo(socket.id);
            if (info) _broadcastRoomState(gameManager, info.roomCode);
        });

        socket.on('start_game', (_, callback) => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (!info) { callback?.({ error: '不在房间中' }); return; }
            const result = gameManager.startGame(info.roomCode, socket.id);
            callback?.(result || { ok: true });
            if (result.ok) {
                // 通知所有玩家游戏开始
                io.to(info.roomCode).emit('game_starting', {});
            }
        });

        // ========== 游戏操作 ==========

        socket.on('player_action', ({ action, multiplier }) => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (!info) return;
            const room = gameManager.getRoom(socket.id);
            if (!room || !room.game) return;

            const ok = room.game.receiveHumanAction(info.playerId, action, multiplier);
            if (!ok) {
                socket.emit('error', { code: 'INVALID_ACTION', message: '无效的行动' });
            }
        });

        socket.on('next_hand', () => {
            const room = gameManager.getRoom(socket.id);
            if (!room || !room.game) return;
            room.game.nextHand();
        });

        // ========== 离开/断线 ==========

        socket.on('leave_room', () => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (info) {
                gameManager.leaveRoom(socket.id);
                socket.leave(info.roomCode);
                _broadcastRoomState(gameManager, info.roomCode);
            }
        });

        socket.on('disconnect', () => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (info) {
                gameManager.handleDisconnect(socket.id);
                _broadcastRoomState(gameManager, info.roomCode);
            }
            console.log(`🔌 断开: ${socket.id}`);
        });

        // ========== 重连 ==========

        socket.on('reconnect_room', ({ roomCode, playerId }, callback) => {
            const result = gameManager.reconnect(socket.id, playerId, roomCode);
            if (result.error) { callback?.(result); return; }
            socket.join(roomCode);
            callback?.({ ok: true, ...result });
            if (roomCode) _broadcastRoomState(gameManager, roomCode);
        });
    });
}

/** 向房间所有已连接玩家广播房间状态 */
function _broadcastRoomState(gameManager, roomCode) {
    const room = gameManager.rooms.get(roomCode);
    if (!room) return;
    const state = room.toJSON();
    for (const player of room.players.values()) {
        if (player.connected) {
            // 通过 socket ID 发送
            const io = gameManager._io;
            if (io) io.to(player.socketId).emit('room_state', state);
        }
    }
}

module.exports = { setupNetworkHandlers };
