/* SFTP upload script */
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

conn.connect({
    host: '8.148.232.155',
    port: 22,
    username: 'root',
    password: 'Jki@13469291161',
    readyTimeout: 10000,
});
