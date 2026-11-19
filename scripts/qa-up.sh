#!/bin/zsh
# 一句话起「真机问答」所需的两个本机进程，并把新隧道地址自动写进云数据库。
#
#   ./scripts/qa-up.sh
#
# 做四件事（原本要开两个终端 + 手工改数据库）：
#   1. Fit Agent 没起来就起（生产模式，127.0.0.1:3000）
#   2. 起 Cloudflare 快速隧道，从日志里抓本次的 https://xxx.trycloudflare.com
#   3. 调 scripts/set_base_url.py 把该地址写回云数据库 fit_agent_config.baseUrl
#   4. 前台守着；Ctrl-C 一起收掉隧道（服务若本就在跑则不动）
#
# 为什么不用 launchd 常驻隧道：快速隧道域名随进程变，自启没意义；且这台机器
# launchd 注册失败过（见 service.sh 注释）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
SERVICE_LOG="$HOME/Library/Logs/fitness-agent.log"
TUNNEL_LOG="${TMPDIR:-/tmp}/fit-agent-tunnel.log"
TUNNEL_PID=""
STARTED_SERVICE=0

cleanup() {
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    echo ""
    echo "  隧道已停（云数据库里还留着最后那个 URL，重建会覆盖）"
  fi
  if [[ "$STARTED_SERVICE" == "1" ]] && kill -0 "$SERVICE_PID" 2>/dev/null; then
    kill "$SERVICE_PID" 2>/dev/null || true
    echo "  Fit Agent 已停"
  fi
}
trap cleanup INT TERM

probe() { curl -s --noproxy '*' -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/ask" 2>/dev/null; }

echo "① Fit Agent（127.0.0.1:$PORT）"
if probe; then
  echo "   已在跑，复用"
else
  [[ -f "$REPO/.next/BUILD_ID" ]] || { echo "   ✗ 没有生产构建，先跑：cd '$REPO' && npm run build"; exit 1; }
  ( cd "$REPO" && exec npm run start -- -p "$PORT" ) >>"$SERVICE_LOG" 2>&1 &
  SERVICE_PID=$!
  STARTED_SERVICE=1
  ok=0
  for _ in {1..40}; do
    if probe; then ok=1; break; fi
    sleep 1
  done
  [[ "$ok" == "1" ]] || { echo "   ✗ 40 秒内没起来，看 $SERVICE_LOG"; exit 1; }
  echo "   已启动（日志 $SERVICE_LOG）"
fi

echo "② Cloudflare 隧道"
if [[ -n "$(pgrep -f 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:'$PORT 2>/dev/null || true)" ]]; then
  echo "   ⚠ 已有隧道在跑（可能是另一个终端起的）。本次仍会新建一个并覆盖数据库地址。"
fi
: >"$TUNNEL_LOG"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
URL=""
for _ in {1..60}; do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
  [[ -n "$URL" ]] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "   ✗ 隧道进程退出了："
    tail -5 "$TUNNEL_LOG"
    exit 1
  fi
  sleep 1
done
[[ -n "$URL" ]] || { echo "   ✗ 60 秒内没拿到隧道地址，看 $TUNNEL_LOG"; exit 1; }
echo "   $URL"

echo "③ 写回云数据库"
python3 "$REPO/scripts/set_base_url.py" "$URL" || {
  echo "   ✗ 自动写回失败。手动改：微信开发者工具 → 云开发 → 数据库 → fit_agent_config → baseUrl"
  echo "     （隧道仍在跑，Ctrl-C 退出）"
}

echo ""
echo "✓ 可以问了：手机「历史」页输入框。隧道保持前台，Ctrl-C 收工。"
wait "$TUNNEL_PID"
