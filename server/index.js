/* ================================================================
 * server/index.js — 联机服务器入口
 *
 * 启动: npm start  或  node server/index.js
 * 单人: http://localhost:3000
 * 联机: http://localhost:3000/client/
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
    pingTimeout: 30000,     // 30s 内未收到 pong → 判定断开（从 60s 缩短）
    pingInterval: 10000,    // 每 10s 发一次 ping（从 25s 缩短，低于常见 NAT 超时）
    connectTimeout: 15000,  // 客户端连接超时 15s
});

// 静态文件托管
app.use(express.static(path.join(__dirname, '..')));          // 根目录（单人模式）
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use('/client', express.static(path.join(__dirname, '..', 'client')));

// 游戏管理
const gameManager = new GameManager();
setupNetworkHandlers(io, gameManager);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    let lanIP = 'localhost';
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                lanIP = iface.address; break;
            }
        }
    }
    console.log('');
    console.log('  🃏 德州扑克 联机服务器已启动');
    console.log(`  本机访问: http://localhost:${PORT}`);
    console.log(`  局域网:   http://${lanIP}:${PORT}`);
    console.log(`  单人模式: http://localhost:${PORT}`);
    console.log(`  联机模式: http://localhost:${PORT}/client/`);
    console.log('');
});
