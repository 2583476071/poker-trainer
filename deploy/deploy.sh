#!/bin/bash
# ============================================================
# 德州扑克 AI 训练器 — 云服务器一键部署脚本
# 在 Ubuntu 22.04 云服务器上运行（以 root 身份）
#
# 用法：
#   1. SSH 登录服务器:  ssh root@你的服务器IP
#   2. 下载并运行:     curl -fsSL https://raw.githubusercontent.com/2583476071/poker-trainer/main/deploy/deploy.sh | bash
#   3. 或者手动:       git clone 后运行 ./deploy/deploy.sh
# ============================================================

set -e

APP_DIR="/opt/poker-trainer"
APP_USER="poker"
REPO_URL="https://github.com/2583476071/poker-trainer.git"
PORT=3000

echo ""
echo "🃏  德州扑克 AI 训练器 — 云服务器部署"
echo "============================================"
echo ""

# ---- 1. 系统基础 ----
echo "📦 [1/6] 更新系统软件包..."
apt update -qq && apt upgrade -y -qq

# ---- 2. 安装 Node.js 20.x ----
if command -v node &>/dev/null && [ $(node -v | cut -d. -f1 | tr -d 'v') -ge 18 ]; then
    echo "✅ [2/6] Node.js 已安装: $(node -v)"
else
    echo "📦 [2/6] 安装 Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
    echo "   Node.js $(node -v) 安装完成"
fi

# ---- 3. 安装 git ----
if ! command -v git &>/dev/null; then
    echo "📦 [3/6] 安装 git..."
    apt install -y git
else
    echo "✅ [3/6] git 已安装"
fi

# ---- 4. 克隆/更新代码 ----
echo "📥 [4/6] 部署代码到 ${APP_DIR}..."

if [ -d "${APP_DIR}" ]; then
    echo "   目录已存在，执行 git pull..."
    cd "${APP_DIR}"
    git pull origin main
else
    git clone "${REPO_URL}" "${APP_DIR}"
    cd "${APP_DIR}"
fi

# ---- 5. 安装依赖 ----
echo "📦 [5/6] 安装 npm 依赖..."
cd "${APP_DIR}/server"
npm install --production

# ---- 6. 创建系统服务 ----
echo "⚙️  [6/6] 配置系统服务..."

# 创建专用用户
if ! id "${APP_USER}" &>/dev/null; then
    useradd -r -s /bin/false "${APP_USER}"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# systemd service 文件
cat > /etc/systemd/system/poker-trainer.service << EOF
[Unit]
Description=Texas Hold'em Poker Trainer Server
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3
Environment=PORT=${PORT}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
systemctl daemon-reload
systemctl enable poker-trainer
systemctl restart poker-trainer

# ---- 完成 ----
echo ""
echo "============================================"
echo "  ✅ 部署完成！"
echo "============================================"
echo ""

# 获取服务器 IP
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s ipinfo.io/ip 2>/dev/null || echo "你的服务器IP")

echo "  🎮 访问地址："
echo "     单人训练: http://${SERVER_IP}:${PORT}"
echo "     联机对战: http://${SERVER_IP}:${PORT}/client/"
echo ""

echo "  📋 常用命令："
echo "     查看状态:  systemctl status poker-trainer"
echo "     查看日志:  journalctl -u poker-trainer -f"
echo "     重启服务:  systemctl restart poker-trainer"
echo "     停止服务:  systemctl stop poker-trainer"
echo ""

echo "  ⚠️  别忘了在阿里云控制台 → 轻量应用服务器 → 防火墙 → 放行 TCP ${PORT} 端口！"
echo ""
