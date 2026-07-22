// 重启服务器
const { execSync, spawn } = require('child_process');

async function restart() {
    // 杀掉占用 3000 端口的进程
    try {
        const out = execSync('netstat -ano | findstr :3000.*LISTENING', { encoding: 'utf8' });
        const pids = [...new Set(out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/).pop()))];
        pids.forEach(pid => {
            try { execSync(`taskkill //F //PID ${pid}`, { stdio: 'ignore' }); } catch {}
        });
        console.log('✅ 旧进程已清理');
    } catch {}

    // 等端口释放
    await new Promise(r => setTimeout(r, 3000));

    // 启动
    console.log('🚀 启动服务器...');
    spawn('node', ['server/index.js'], { stdio: 'inherit' });
}

restart();
