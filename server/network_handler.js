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

        socket.on('take_seat', ({ targetPlayerId }, callback) => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (!info) { callback?.({ error: '不在房间中' }); return; }
            const room = gameManager.getRoom(socket.id);
            if (!room || !room.game) { callback?.({ error: '游戏未开始' }); return; }
            // 确认是观战者
            if (!room.spectators.has(info.playerId)) { callback?.({ error: '你不是观战者' }); return; }
            const spec = room.spectators.get(info.playerId);
            const result = room.game.takeSeat(info.playerId, targetPlayerId, spec.name);
            if (result.ok) {
                // 从观战者列表移到玩家列表
                room.spectators.delete(info.playerId);
                room.players.set(info.playerId, { id: info.playerId, name: spec.name, socketId: socket.id, ready: true, connected: true });
                // 立刻发送个性化状态
                const state = room.game.getState(info.playerId);
                callback?.({ ok: true, state });
                _broadcastRoomState(gameManager, info.roomCode);
            } else {
                callback?.(result);
            }
        });

        socket.on('join_seat', ({ seatIndex }, callback) => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (!info) { callback?.({ error: '不在房间中' }); return; }
            const result = gameManager.joinEmptySeat(socket.id, info.roomCode, seatIndex);
            if (result.error) { callback?.(result); return; }
            socket.join(info.roomCode);  // 确保 socket 在房间中
            callback?.({ ok: true, state: result.state, playerId: result.playerId });
            _broadcastRoomState(gameManager, info.roomCode);
        });

        socket.on('rebuy', (_, callback) => {
            const info = gameManager.getPlayerInfo(socket.id);
            if (!info) { callback?.({ error: '不在房间中' }); return; }
            const room = gameManager.getRoom(socket.id);
            if (!room || !room.game) { callback?.({ error: '游戏未开始' }); return; }
            const result = room.game.rebuy(info.playerId);
            callback?.(result || { ok: true });
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

        // 掉线后通过昵称重新加入
        socket.on('rejoin_room', ({ roomCode, nickname }, callback) => {
            const result = gameManager.reconnectByName(socket.id, roomCode, nickname);
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
