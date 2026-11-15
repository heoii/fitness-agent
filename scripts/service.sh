#!/bin/zsh
# fitness-agent 常驻服务管理（macOS launchd）
#
#   ./scripts/service.sh install    装：登录时自启，崩了自动拉起
#   ./scripts/service.sh uninstall  卸：停掉并移除自启
#   ./scripts/service.sh status     看：在不在、监听在哪、接口通不通
#   ./scripts/service.sh logs       看最近 40 行日志
#   ./scripts/service.sh restart    改完代码后重启（重新读知识库）
#
# 为什么用生产模式而不是 `npm run dev`：dev 会热重载模块，而检索索引是
# globalThis 上的单例，跨版本时旧对象缺字段会把接口搞崩（W15 那次事故）。
# 常驻服务要的是「不自己变」，改完代码显式 restart 一次。
#
# plist 只在本机 ~/Library/LaunchAgents/ 生成，不进仓 —— 里面含本机绝对路径。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.heoii.fitness-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/fitness-agent.log"
ERR="$HOME/Library/Logs/fitness-agent.err.log"
PORT="${PORT:-3000}"
NODE_BIN="$(dirname "$(command -v node)")"

render_plist() {
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-c</string>
    <string>cd '$REPO' &amp;&amp; exec '$NODE_BIN/npm' run start -- -p $PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$ERR</string>
</dict>
</plist>
PLIST
}

need_build() {
  if [[ ! -f "$REPO/.next/BUILD_ID" ]]; then
    echo "✗ 没有生产构建产物，先跑：cd '$REPO' && npm run build" >&2
    return 1
  fi
}

case "${1:-status}" in
  install)
    need_build
    if [[ -f "$PLIST" ]]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
    render_plist
    # bootstrap 需要真实 GUI 登录上下文。在 SSH / Agent 会话里会报
    # "Bootstrap failed: 5: Input/output error"（连最小 plist 都一样）。
    # 此时**不谎报成功**：plist 已落在 ~/Library/LaunchAgents，
    # 下次登录 launchd 会自动加载；但「崩溃自动拉起」当场没验证过。
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
      echo "✓ 已注册并启动：$LABEL"
      echo "  登录时自动启动、崩溃自动拉起；日志 $LOG"
    else
      echo "⚠ 配置文件已写入：$PLIST"
      echo "  当前会话无法注册 launchd（无 GUI 登录上下文）。"
      echo "  · 下次登录会自动加载，或在你自己的终端里执行："
      echo "      launchctl bootstrap gui/$(id -u) $PLIST"
      echo "  · 在此之前请用 '$0 start-once' 临时起服务。"
      echo "  ⚠ 「登录自启 / 崩溃自动拉起」尚未在本机验证。"
    fi
    sleep 2
    "$0" status
    ;;
  start-once)
    need_build
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "  端口 $PORT 已有服务，不重复起"; "$0" status; exit 0
    fi
    echo "  前台启动生产服务（Ctrl-C 停止）；生产模式不热重载，改完代码要重启"
    cd "$REPO" && exec npm run start -- -p "$PORT"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ 已卸载并停止"
    ;;
  restart)
    need_build
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || {
      echo "✗ 服务没装，先跑：$0 install" >&2; exit 1;
    }
    echo "✓ 已重启（索引会重新读一遍知识库）"
    sleep 2
    "$0" status
    ;;
  status)
    echo "--- launchd ---"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" | head -4 || echo "  未安装"
    echo "--- 监听地址（应为 127.0.0.1，不是 *）---"
    lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print "  "$1" "$2" "$9}' || true
    echo "--- 接口（**必须绕过代理**：环境里的 HTTP_PROXY 会给连不上的地址回一个 502，\n     看起来像「服务开着」，其实是代理自己答的。W15 实测踩过）---"
    printf "  本机: "; curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" --max-time 3 "http://127.0.0.1:$PORT/api/ask" || true
    LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    if [[ -n "$LAN" ]]; then
      printf "  局域网 %s（应为 000）: " "$LAN"
      curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" --max-time 3 "http://$LAN:$PORT/" || true
    fi
    ;;
  logs)
    echo "=== stdout（最近 40 行）==="; tail -40 "$LOG" 2>/dev/null || echo "  无"
    echo "=== stderr（最近 40 行）==="; tail -40 "$ERR" 2>/dev/null || echo "  无"
    ;;
  *)
    echo "用法: $0 {install|uninstall|status|logs|restart}" >&2; exit 2;;
esac
