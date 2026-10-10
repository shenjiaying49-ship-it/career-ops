# 微信桥接插件：收到的私聊消息 → 人脉工作台
#
# 适用于 chatgpt-on-wechat / claude-on-wechat 及其衍生框架（插件机制一致）。
# 机器人在哪个账号上收到私聊消息，就会把消息推给本地人脉系统：
#   POST http://localhost:3000/api/network/ingest  {"from": "昵称", "text": "内容"}
# 服务端自动按联系人攒批 → DeepSeek 分析 → /network 页面待确认入库。
#
# 安装：
#   1. 把本目录拷到你桥接项目的 plugins/ 下（保持目录名 wechat_bridge_ingest）
#   2. config.json 的 plugins.plugins 中加入 "wechat_bridge_ingest"
#   3. 重启桥接服务
#
# 说明：
#   - 只推私聊，群聊不推（机器人被拉进的群通常很吵，噪音大于价值）
#   - 以 # 开头的消息不推（那是指令）
#   - 推送失败静默跳过，不影响机器人本身工作

import logging
import requests

logging.basicConfig(
    level=logging.INFO,
    format="[wechat-bridge] %(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

try:
    from bridge.context import ContextType
    from plugins import Plugin, Event, EventContext
except ImportError:  # 允许在框架外 import 本文件做语法检查
    ContextType = None
    Plugin = object
    Event = None
    EventContext = None

INGEST_URL = "http://localhost:3000/api/network/ingest"


class WechatBridgeIngestPlugin(Plugin):
    name = "wechat_bridge_ingest"
    desc = "把私聊消息推送到人脉工作台（localhost:3000）"
    version = "0.1"
    author = "atomclub"
    enabled = True

    def __init__(self):
        super().__init__()
        self.handlers[Event.ON_RECEIVE_MESSAGE] = self.on_receive_message

    def on_receive_message(self, ectx: EventContext, context):
        try:
            if ContextType is not None and context.type != ContextType.TEXT:
                return
            msg = context
            is_group = getattr(msg, "is_group", False) or msg.get("isgroup", False) if hasattr(msg, "get") else getattr(msg, "is_group", False)
            if is_group:
                return
            content = (msg.get("content") if hasattr(msg, "get") else getattr(msg, "content", "")) or ""
            content = content.strip()
            if not content or content.startswith("#"):
                return
            nick = (msg.get("from_user_nickname") if hasattr(msg, "get") else getattr(msg, "from_user_nickname", None)) \
                or (msg.get("from_user_id") if hasattr(msg, "get") else getattr(msg, "from_user_id", None)) \
                or "微信好友"
            requests.post(INGEST_URL, json={"from": str(nick), "text": content}, timeout=10)
        except Exception as exc:
            # 只写本地日志，不打扰微信对话；否则接口地址/服务宕机时无法排查。
            log.warning("推送人脉接口失败：%s", exc)
