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

// 全局异常捕获 — 记录错误但不崩进程（防止 AI 决策中的 bug 炸服）
process.on('uncaughtException', (err) => {
    console.error('💥 未捕获异常:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 未处理的Promise拒绝:', reason);
});

const { GameManager } = require('./game_manager.js');
const { setupNetworkHandlers } = require('./network_handler.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['polling'],      // 仅轮询，禁用 WebSocket（避免升级失败断线）
    pingTimeout: 60000,           // 60s 宽容超时
    pingInterval: 15000,          // 每 15s 心跳
    connectTimeout: 20000,
    allowUpgrades: false,         // 禁止升级到 WebSocket
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
