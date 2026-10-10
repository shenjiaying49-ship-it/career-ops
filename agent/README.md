# 微信剪贴板人脉 Agent

把微信聊天记录变成人脉库条目，全程只需一个 `Cmd+C`。

## 工作方式

```
微信 Mac 客户端：选中消息 → Cmd+C
        ↓
本地 Agent（常驻，监听剪贴板）
        ↓ 自动识别聊天格式 → DeepSeek 分析（人/意图/业务匹配/建议回复）
待入库队列（career-ops/data/network-pending.json）
        ↓ 网页轮询
打开 http://localhost:3000/network → 顶部「待确认」卡片 → 一键入库
```

**为什么不是挂微信机器人**：第三方协议登录个人微信是微信明令打击的行为，封号风险高。这个方案不登录微信、不碰微信进程，只读你主动复制到剪贴板的内容——体验上"复制=转发"，风险为零。

## 使用

1. 确保 `career-ops/web` 的 dev server 在跑（localhost:3000）
2. 启动 Agent：

```bash
cd career-ops/agent
./start-agent.sh          # 或: node wechat-clipboard-agent.mjs（前台运行）
```

3. 在微信 Mac 客户端里，选中一段聊天（可多选），`Cmd+C`
4. 右上角弹出通知「人脉助手已识别」，打开 /network 网页点「入库」

## 命令

| 命令 | 作用 |
|------|------|
| `node wechat-clipboard-agent.mjs` | 前台常驻 |
| `node wechat-clipboard-agent.mjs --once` | 只处理当前剪贴板一次 |
| `node wechat-clipboard-agent.mjs --test "文本"` | 直接处理给定文本（测试） |
| `pkill -f wechat-clipboard-agent` | 停止 |

## 识别规则（什么样的剪贴板内容会触发）

- ≥ 2 行、含中文
- 且满足其一：有时间戳（`14:32` / `2026-09-24`），或 ≥ 2 行「昵称: 内容」格式
- 同一段内容只处理一次（哈希去重）

## 开机自启（可选）

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.atomclub.network-agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.atomclub.network-agent</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>$(cd "$(dirname "$0")" && pwd)/wechat-clipboard-agent.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(cd "$(dirname "$0")" && pwd)/agent.log</string>
  <key>StandardErrorPath</key><string>$(cd "$(dirname "$0")" && pwd)/agent.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.atomclub.network-agent.plist
```

（`node` 路径用 `which node` 确认后替换）
