// 一键重启服务器
const { execSync, spawn } = require('child_process');

async function restart() {
    // 杀掉占用 3000 端口的进程
    try {
        const out = execSync('netstat -ano | findstr ":3000"', { encoding: 'utf8' });
        const lines = out.trim().split('\n').filter(l => l.includes('LISTENING'));
        const pids = [...new Set(lines.map(l => l.trim().split(/\s+/).pop()))];
        for (const pid of pids) {
            try { execSync(`taskkill //F //PID ${pid}`, { stdio: 'ignore' }); } catch {}
        }
        if (pids.length > 0) console.log('✅ 旧进程已清理 (PID: ' + pids.join(', ') + ')');
    } catch (e) {
        // 没找到进程，端口空闲
    }

    await new Promise(r => setTimeout(r, 2000));

    console.log('🚀 启动服务器...');
    const proc = spawn('node', ['server/index.js'], { stdio: 'inherit' });
    proc.on('error', () => { console.log('请手动运行: node server/index.js'); });
}

restart();
