/* ============================================================
 * deploy/sftp_upload.example.js — SFTP 文件上传（示例）
 *
 * 使用前复制为 sftp_upload.js 并填入真实凭据：
 *   cp deploy/sftp_upload.example.js deploy/sftp_upload.js
 *
 * sftp_upload.js 已在 .gitignore 中，不会被提交到仓库。
 * ============================================================ */
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const conn = new Client();

const files = [
    'server/poker_game.js',
    'game.js',
    'client/renderer.js',
    '.gitignore',
];

conn.on('ready', () => {
    console.log('SSH已连接, SFTP上传文件...\n');
    conn.sftp((err, sftp) => {
        if (err) { console.error('SFTP错误:', err); conn.end(); return; }

        let idx = 0;
        function uploadNext() {
            if (idx >= files.length) {
                console.log('\n所有文件上传完成，重启服务...');
                conn.exec('systemctl restart poker-trainer && sleep 2 && systemctl status poker-trainer --no-pager -l 2>&1 | head -10', { pty: true }, (err, stream) => {
                    stream.on('data', (d) => process.stdout.write(d.toString()));
                    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
                    stream.on('close', () => { console.log('\n✅ 部署完成！'); conn.end(); });
                });
                return;
            }

            const name = files[idx++];
            const localPath = path.join(__dirname, '..', name);
            const remotePath = '/opt/poker-trainer/' + name;

            const content = fs.readFileSync(localPath);
            const wstream = sftp.createWriteStream(remotePath);
            wstream.on('close', () => {
                console.log('  ✅ ' + name);
                uploadNext();
            });
            wstream.on('error', (e) => {
                console.error('  ❌ ' + name + ': ' + e.message);
                uploadNext();
            });
            wstream.end(content);
        }

        uploadNext();
    });
});

// 从环境变量读取凭据（不回显到终端）
const HOST = process.env.POKER_HOST || '你的服务器IP';
const USER = process.env.POKER_USER || 'root';
const PASS = process.env.POKER_PASS || '你的密码';

if (!process.env.POKER_HOST || !process.env.POKER_PASS) {
    console.warn('⚠️  未设置环境变量，使用默认值（可能不正确）');
    console.warn('   建议: export POKER_HOST=你的IP POKER_PASS=你的密码');
}

conn.connect({
    host: HOST,
    port: 22,
    username: USER,
    password: PASS,
    readyTimeout: 10000,
});
