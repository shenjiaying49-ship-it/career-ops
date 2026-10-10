# 微信助手 → 人脉工作台 · 对接文档

把你的微信助手收到的聊天消息推送到人脉系统，全自动分析入库。

## 接口定义（就这一个）

```
POST http://<工作台地址>:3000/api/network/ingest
Content-Type: application/json

{
  "from": "发送者昵称",        // 必填。对方微信昵称/备注名，用于区分对话
  "text": "消息文本内容",      // 必填。这条消息的正文
  "flush": false              // 可选。true=跳过攒批立即分析（调试用），默认 false
}
```

**工作台地址怎么填：**
- 微信助手部署在**这台 Mac 上** → `http://localhost:3000`
- 部署在**同一局域网的其他机器**（如学校服务器）→ `http://10.31.71.135:3000`（Mac 的内网 IP，用 `ipconfig getifaddr en0` 查）
- 部署在**公网服务器** → 需要打通隧道（见下文「公网部署」）

## 返回值

```json
{ "ok": true, "buffered": 3 }      // 正常：已进攒批缓冲（该联系人累计 3 条）
{ "ok": true, "flushed": true }    // 攒满 20 条，已触发分析
{ "error": "text required" }       // 缺 from/text
```

## 工作台这边的自动行为（你不用做任何事）

1. **攒批**：同一联系人的消息攒 4 分钟（无新消息）或满 20 条，合成一段完整对话
2. **分析**：DeepSeek 识别对方是谁、什么意图、匹配哪项业务（MCN/活动/Token/服务器）
3. **待确认**：进入队列，用户打开网页（/network）看到卡片，点「入库」完成录入

## 你的微信助手需要做的（推送规则）

| 规则 | 说明 |
|------|------|
| 只推**私聊** | 群聊消息不推（噪音大） |
| 跳过指令 | `#` 开头的消息不推 |
| 带上昵称 | `from` 用对方的微信昵称或你给他的备注名 |
| 失败静默 | 推送超时/失败直接跳过，不要重试阻塞主流程 |
| 不用推自己 | 用户自己发的消息不用推（推了也会被识别跳过） |

伪代码：

```python
def on_message(msg):
    if msg.is_group or msg.text.startswith("#"):
        return
    try:
        requests.post("http://10.31.71.135:3000/api/network/ingest",
                      json={"from": msg.sender_name, "text": msg.text}, timeout=10)
    except Exception:
        pass
```

## 联调测试（不接微信也能测）

```bash
# 立即分析一条（flush=true 不走攒批）
curl -X POST http://localhost:3000/api/network/ingest \
  -H "Content-Type: application/json" \
  -d '{"from":"张三","text":"你们GPU租赁怎么收费","flush":true}'
# → {"ok":true,"queued":true,"name":"张三"}
# 然后打开 http://localhost:3000/network 看「待确认」卡片

# 看当前攒批状态
curl http://localhost:3000/api/network/ingest
# → {"buffering":[{"from":"张三","count":2,...}]}
```

## 公网部署（可选）

如果微信助手在公网服务器上，需要把 Mac 的 3000 端口暴露出去：

```bash
# 方案一：cloudflared（免费、无需公网 IP）
cloudflared tunnel --url http://localhost:3000
# 会给你一个 https://xxx.trycloudflare.com 地址
# 微信助手推送到 https://xxx.trycloudflare.com/api/network/ingest

# 方案二：ngrok
ngrok http 3000
```

⚠️ 隧道地址是公开的，知道地址的人都能往你的队列塞消息。建议加一层访问控制（cloudflared access / 自定义 token），或优先用内网方案。

## 重要提醒：机器人能看到什么

微信助手**只能推送它自己账号收到的消息**：
- 助手登录的是**独立小号** → 只能看到发给小号的消息
- 助手登录的是**你自己的微信号**（协议号方式）→ 能看到你收到的所有消息，但协议号登录有封号风险，自行权衡
- 公众号/企业微信通道 → 只能看到发给该公众号/企微的消息（官方接口，无风险）
