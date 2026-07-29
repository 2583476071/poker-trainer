/* ============================================================
 * deploy/ssh_deploy.example.js — SSH 远程部署（示例）
 *
 * 使用前复制为 ssh_deploy.js 并填入真实凭据：
 *   cp deploy/ssh_deploy.example.js deploy/ssh_deploy.js
 *
 * ssh_deploy.js 已在 .gitignore 中，不会被提交到仓库。
 *
 * 用法: node deploy/ssh_deploy.js <服务器密码>
 *   或通过环境变量: POKER_PASS=xxx node deploy/ssh_deploy.js
 * ============================================================ */
const { Client } = require('ssh2');
const readline = require('readline');

// 从环境变量或命令行参数读取
const HOST = process.env.POKER_HOST || '你的服务器IP';
const PORT = 22;
const USER = process.env.POKER_USER || 'root';
const PASS = process.argv[2] || process.env.POKER_PASS;

if (!PASS) {
    console.error('用法: node deploy/ssh_deploy.js <服务器密码>');
    console.error('  或: POKER_HOST=IP POKER_PASS=密码 node deploy/ssh_deploy.js');
    process.exit(1);
}

const conn = new Client();

// 部署命令
const DEPLOY_COMMANDS = [
    'echo "🃏 开始部署..."',
    'curl -fsSL https://raw.githubusercontent.com/2583476071/poker-trainer/main/deploy/deploy.sh | bash',
];

let currentCmd = 0;

function runNextCommand() {
    if (currentCmd >= DEPLOY_COMMANDS.length) {
        console.log('\n✅ 部署完成！关闭连接...');
        conn.end();
        return;
    }

    const cmd = DEPLOY_COMMANDS[currentCmd];
    console.log(`\n$ ${cmd}`);
    currentCmd++;

    conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) { console.error('执行错误:', err); conn.end(); return; }

        stream.on('data', (data) => {
            process.stdout.write(data.toString());
        });

        stream.stderr.on('data', (data) => {
            process.stderr.write(data.toString());
        });

        stream.on('close', (code) => {
            console.log(`[exit=${code}]`);
            runNextCommand();
        });
    });
}

conn.on('ready', () => {
    console.log(`✅ SSH 已连接到 ${HOST}`);
    runNextCommand();
});

conn.on('error', (err) => {
    console.error('❌ SSH 连接失败:', err.message);
    process.exit(1);
});

conn.connect({
    host: HOST,
    port: PORT,
    username: USER,
    password: PASS,
    readyTimeout: 10000,
});
