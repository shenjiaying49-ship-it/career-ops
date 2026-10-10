#!/bin/bash
# 启动微信剪贴板人脉 Agent（后台常驻，日志写到 agent/agent.log）
DIR="$(cd "$(dirname "$0")" && pwd)"
nohup node "$DIR/wechat-clipboard-agent.mjs" >> "$DIR/agent.log" 2>&1 &
echo "Agent 已启动（PID $!），日志: $DIR/agent.log"
echo "停止: pkill -f wechat-clipboard-agent"
