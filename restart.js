// 一键重启服务器（杀进程树 + 等端口释放 + 可选隧道）
const { execSync, spawn } = require('child_process');
const net = require('net');

const PORT = process.env.PORT || 3000;
const useTunnel = process.argv.includes('--tunnel');

function killPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8' });
        const lines = out.trim().split('\n').filter(l => l.includes('LISTENING'));
        const pids = [...new Set(lines.map(l => l.trim().split(/\s+/).pop()))];
        for (const pid of pids) {
            console.log(`  Killing PID ${pid} + children...`);
            try { execSync(`taskkill //F //T //PID ${pid}`, { stdio: 'ignore' }); } catch {}
        }
        return pids.length > 0;
    } catch { return false; }
}

function waitPortFree(port, timeout) {
    return new Promise((resolve) => {
        const start = Date.now();
        function check() {
            const s = new net.Socket();
            s.once('error', () => { s.destroy(); resolve(true); });
            s.once('connect', () => { s.destroy(); if (Date.now() - start > timeout) resolve(false); else setTimeout(check, 500); });
            s.connect(port, '127.0.0.1');
        }
        check();
    });
}

async function main() {
    // 1. 杀旧进程
    console.log('🔍 检查端口 ' + PORT + '...');
    const killed = killPort(PORT);
    if (killed) {
        console.log('⏳ 等待端口释放...');
        const freed = await waitPortFree(PORT, 10000);
        if (!freed) { console.log('⚠️ 端口未释放，继续启动...'); }
        console.log('✅ 端口已释放');
    }

    // 2. 启动服务器
    console.log('🚀 启动服务器...\n');
    const server = spawn('node', ['server/index.js'], { stdio: 'inherit' });

    // 3. 可选：启动内网穿透
    if (useTunnel) {
        // 等服务器先起来
        await new Promise(r => setTimeout(r, 3000));
        try {
            const tunnel = spawn('npx', ['localtunnel', '--port', String(PORT)], { stdio: 'inherit' });
            tunnel.on('error', () => {});
        } catch {}
    }

    server.on('error', (err) => { console.error('启动失败:', err.message); process.exit(1); });
}

main();
