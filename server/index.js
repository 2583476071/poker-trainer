/* ================================================================
 * server/index.js — 联机服务器入口
 *
 * 启动: node index.js
 * 单人模式: http://localhost:3000
 * 联机模式: http://localhost:3000/client/（Phase 3 完成后）
 * ================================================================ */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { GameManager } = require('./game_manager.js');
const { setupNetworkHandlers } = require('./network_handler.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// 静态文件托管（三种路径）
// 1. 根目录 → 单人模式（原有 index.html + game.js）
app.use(express.static(path.join(__dirname, '..')));
// 2. shared 模块
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
// 3. client → 联机模式（Phase 3）
app.use('/client', express.static(path.join(__dirname, '..', 'client')));

// 游戏管理
const gameManager = new GameManager();
setupNetworkHandlers(io, gameManager);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   🃏 德州扑克 联机服务器已启动      ║');
    console.log(`║   地址: http://localhost:${PORT}       ║`);
    console.log('║   单人模式: 打开根路径即可          ║');
    console.log('║   联机模式: Phase 3 开发中...       ║');
    console.log('╚══════════════════════════════════════╝');
});
