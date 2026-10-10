#!/bin/bash
# 启动微信 iLink 桥（后台常驻：被动记录主号新私聊 → 人脉系统）
# 用前先完成扫码登录：node wechat-ilink-agent.mjs login
cd "$(dirname "$0")"
mkdir -p logs
nohup node wechat-ilink-agent.mjs >> logs/ilink-agent.log 2>&1 &
echo "已启动（PID $!），日志: logs/ilink-agent.log"
echo "停止: pkill -f wechat-ilink-agent.mjs"
