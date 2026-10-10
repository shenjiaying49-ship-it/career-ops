#!/bin/bash
# 人脉工作台网页服务看门狗：3000 端口没服务就拉起 next dev，有就每 30 秒巡检一次。
# 由 launchd 管理（com.atomclub.career-ops-web）：开机自启、脚本挂了自动拉起。
# 效果：不管重启多少次、进程怎么崩，网页和人脉自动入库链路永远在线。
WEB_DIR="/Users/jyshen/claude folder/自我分析与规划/career-ops/web"
LOG_DIR="/Users/jyshen/claude folder/自我分析与规划/career-ops/agent/logs"
NODE_BIN="/opt/homebrew/opt/node@22/bin/node"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

while true; do
  if nc -z 127.0.0.1 3000 2>/dev/null; then
    sleep 30
  else
    echo "[$(date '+%F %T')] 端口 3000 无服务，启动 next dev" >> "$LOG_DIR/web-server.log"
    cd "$WEB_DIR" || { sleep 60; continue; }
    "$NODE_BIN" "node_modules/next/dist/bin/next" dev >> "$LOG_DIR/web-server.log" 2>&1
    sleep 5
  fi
done
