#!/bin/bash
# 德州扑克 AI 训练器 — 云服务器部署 (从已克隆的 repo 直接执行)
set -e
APP_DIR="/opt/poker-trainer"
APP_USER="poker"
PORT=3000

echo "🃏 德州扑克 AI 训练器 — 部署开始"
echo "============================================"

# 1. 系统更新 + Node.js
echo "[1/5] 安装 Node.js..."
if ! command -v node &>/dev/null; then
    apt update -qq && apt install -y curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "   Node.js $(node -v)"

# 2. server 依赖
echo "[2/5] 安装 server npm 依赖..."
cd "${APP_DIR}/server"
npm install

# 3. 创建专用用户
echo "[3/5] 创建 poker 用户..."
if ! id "${APP_USER}" &>/dev/null; then
    useradd -r -s /bin/false "${APP_USER}"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# 4. systemd 服务
echo "[4/5] 创建 systemd 服务..."
cat > /etc/systemd/system/poker-trainer.service << 'SERVICEEOF'
[Unit]
Description=Texas Holdem Poker Trainer
After=network.target

[Service]
Type=simple
User=poker
WorkingDirectory=/opt/poker-trainer
ExecStart=/usr/bin/node /opt/poker-trainer/server/index.js
Restart=on-failure
RestartSec=3
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEEOF

# 5. 启动
echo "[5/5] 启动服务..."
systemctl daemon-reload
systemctl enable poker-trainer
systemctl restart poker-trainer
sleep 2

echo ""
echo "============================================"
echo "  ✅ 部署完成！"
echo "============================================"
echo ""
echo "  访问地址:"
echo "    http://8.148.232.155:3000"
echo "    http://8.148.232.155:3000/client/"
echo ""
echo "  常用命令:"
echo "    查看状态: systemctl status poker-trainer"
echo "    查看日志: journalctl -u poker-trainer -f"
echo "    重启服务: systemctl restart poker-trainer"
echo ""
systemctl status poker-trainer --no-pager --lines=5 2>&1 || true
