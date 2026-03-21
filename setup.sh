#!/bin/bash
# Podcast Digest — 一键安装脚本
# 用法：bash setup.sh

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.podcast-digest"

echo "=== Podcast Digest 安装脚本 ==="
echo ""

# 1. 检查依赖
echo "[1/4] 检查依赖..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "  ✗ 缺少依赖：$1"
    echo "    安装方式：$2"
    MISSING=1
  else
    echo "  ✓ $1 ($(command -v "$1"))"
  fi
}

MISSING=0
check_cmd node "brew install node"
check_cmd yt-dlp "brew install yt-dlp"
check_cmd docker "https://docs.docker.com/desktop/mac/install/"

if [ "$MISSING" = "1" ]; then
  echo ""
  echo "请先安装以上依赖后重新运行。"
  exit 1
fi

# 2. 安装 npm 依赖
echo ""
echo "[2/4] 安装 npm 依赖..."
cd "$SKILL_DIR"
npm install --silent
echo "  ✓ 完成"

# 3. 初始化 RSSHub（Docker）
echo ""
echo "[3/4] 启动 RSSHub 本地服务..."
if docker ps --format '{{.Names}}' | grep -q '^rsshub$'; then
  echo "  ✓ RSSHub 容器已在运行"
elif docker ps -a --format '{{.Names}}' | grep -q '^rsshub$'; then
  docker start rsshub
  echo "  ✓ 已启动已有 RSSHub 容器"
else
  docker run -d --name rsshub --restart always -p 1200:1200 diygod/rsshub
  echo "  ✓ 已创建并启动 RSSHub 容器"
fi

# 验证 RSSHub 是否可访问
sleep 2
if curl -s http://localhost:1200 -o /dev/null -w "%{http_code}" | grep -q '200\|302'; then
  echo "  ✓ RSSHub 可访问：http://localhost:1200"
else
  echo "  ⚠ RSSHub 可能还在启动中，稍后可用 docker logs rsshub 查看状态"
fi

# 4. 初始化配置文件
echo ""
echo "[4/4] 初始化配置..."
mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_DIR/config.json" ]; then
  echo "  ✓ 配置文件已存在：$CONFIG_DIR/config.json（跳过）"
else
  cp "$SKILL_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "  ✓ 已创建配置文件：$CONFIG_DIR/config.json"
  echo ""
  echo "  ⚠ 请编辑配置文件，填入以下内容："
  echo "     - dashscope.apiKey  → 阿里云 DashScope API Key（用于 ASR + Qwen）"
  echo "     - email.apiKey      → Resend API Key（用于发邮件）"
  echo "     - email.to          → 收件人邮箱"
  echo "     - email.proxy       → HTTP 代理地址（如不需要可删除此字段）"
fi

if [ ! -f "$CONFIG_DIR/state.json" ]; then
  echo '{"processedEpisodes":{},"lastRun":null}' > "$CONFIG_DIR/state.json"
  echo "  ✓ 已创建状态文件：$CONFIG_DIR/state.json"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "下一步："
echo "  1. 编辑配置文件：$CONFIG_DIR/config.json"
echo "  2. 测试单集：node $SKILL_DIR/scripts/daily-digest.js --test --podcast 硅谷101"
echo "  3. 完整运行：node $SKILL_DIR/scripts/daily-digest.js"
echo ""
echo "可选：设置每日定时任务"
echo "  crontab -e"
echo "  加入：0 2 * * * cd $SKILL_DIR && node scripts/daily-digest.js >> /tmp/podcast-digest.log 2>&1"
