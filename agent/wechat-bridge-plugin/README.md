# 微信桥接插件

把微信机器人收到的**私聊消息**自动推送到人脉工作台。

## 什么时候用这个

你的微信里有个 AI 机器人（比如 "Claude，由 Anthropic 开发的 AI 助手"），并且：

1. **这个机器人是你自己部署的**（chatgpt-on-wechat / claude-on-wechat / 自建桥接，你有服务器和代码）
   → 装本插件，机器人收到的每条私聊都会进人脉系统
2. **机器人是第三方服务，你只是加了个好友**
   → 它读不到你和别人的聊天记录，此路不通。
   → 继续用已运行的剪贴板 Agent（微信里选中消息 Cmd+C）。

## 工作链路

```
对方给你（机器人账号）发微信
   ↓ 桥接框架收到消息
本插件（plugins/wechat_bridge_ingest/）
   ↓ POST localhost:3000/api/network/ingest {from, text}
服务端攒批（同一联系人 4 分钟 / 满 20 条）
   ↓ DeepSeek 分析（人 / 意图 / 业务匹配 / 建议回复）
待确认队列 → /network 页面一键入库
```

## 安装（chatgpt-on-wechat 类框架）

```bash
# 1. 拷进插件目录
cp -r wechat-bridge-plugin /path/to/your-bot/plugins/wechat_bridge_ingest

# 2. config.json 里启用
"plugins": { "plugin_list": ["wechat_bridge_ingest"] }

# 3. 重启桥接服务
```

## 测试（不用机器人，手动模拟）

```bash
curl -X POST http://localhost:3000/api/network/ingest \
  -H "Content-Type: application/json" \
  -d '{"from":"张三","text":"你们GPU租赁怎么收费","flush":true}'
```

`flush: true` 跳过攒批立即分析。不带 flush 则进缓冲（GET /api/network/ingest 可看攒批状态）。

## 注意

- 机器人只能看到**发给它的消息**。如果机器人登录的是你自己的微信号（协议号方式），能看到你收到的所有消息——但协议号登录本身有封号风险，自行权衡。
- 群聊默认不推；指令（# 开头）不推。
