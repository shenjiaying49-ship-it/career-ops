import { analyzeChat } from "@/lib/network/analyze-chat";
import { pushPending } from "@/lib/network/pending-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 微信桥接推送入口：任何能发 HTTP 的微信机器人/桥接框架
// （chatgpt-on-wechat、claude-on-wechat、自建桥接…）把收到的消息逐条 POST 过来，
// 服务端按联系人攒批（4 分钟无新消息或满 20 条）→ DeepSeek 分析 → 待确认队列。
//
// POST { "from": "张三", "text": "消息内容" }            → 进攒批缓冲
// POST { "from": "张三", "text": "...", "flush": true }  → 立刻分析（调试用）
//
// 群聊过滤、跳过自己等逻辑由桥接端决定（见 agent/wechat-bridge-plugin/）。

type BufItem = { from: string; time: string; content: string };
type Buf = { items: BufItem[]; firstAt: number; lastAt: number; timer: ReturnType<typeof setTimeout> };
type IngestStatus = { at: string; from: string; count: number; ok: boolean; error?: string };

const IDLE_MS = 240_000; // 同一联系人 4 分钟没新消息就整体分析
const MAX_ITEMS = 20;    // 或攒满 20 条
const bufs = new Map<string, Buf>();
const recent: IngestStatus[] = [];

function rememberStatus(status: IngestStatus) {
  recent.unshift(status);
  recent.splice(20);
}

function flush(from: string) {
  const buf = bufs.get(from);
  bufs.delete(from);
  if (!buf || !buf.items.length) return;
  const text = buf.items.map((m) => `${m.from}\n${m.time}\n${m.content}`).join("\n\n");
  const meta = {
    from,
    messageCount: buf.items.length,
    firstAt: new Date(buf.firstAt).toISOString(),
    lastAt: new Date(buf.lastAt).toISOString(),
  };
  analyzeChat(text)
    .then((result) => {
      pushPending({
        id: `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        queuedAt: new Date().toISOString(),
        source: `wechat-bridge:${from}`.slice(0, 40),
        meta,
        result,
      });
      rememberStatus({ at: new Date().toISOString(), from, count: buf.items.length, ok: true });
      console.log(`[ingest] 已入待确认队列：${result.person?.name}（${from}，${buf.items.length} 条消息）`);
    })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      rememberStatus({ at: new Date().toISOString(), from, count: buf.items.length, ok: false, error: error.slice(0, 160) });
      console.error(`[ingest] 「${from}」分析失败：${error}`);
    });
}

export async function POST(req: Request) {
  let body: { from?: string; text?: string; flush?: boolean; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  // 立即分析所有攒批中的联系人（网页「立即分析」按钮）
  if (body.action === "flush-all") {
    const keys = [...bufs.keys()];
    for (const key of keys) {
      const buf = bufs.get(key);
      if (buf) clearTimeout(buf.timer);
      flush(key);
    }
    return Response.json({ ok: true, flushed: keys.length });
  }

  const from = (body.from ?? "").trim().slice(0, 40) || "微信好友";
  const content = (body.text ?? "").trim().slice(0, 2_000);
  if (!content) return Response.json({ error: "text required" }, { status: 400 });

  if (body.flush) {
    // 调试模式：直接分析这一条，不走攒批
    try {
      const now = new Date().toISOString();
      const result = await analyzeChat(`${from}\n${new Date().toLocaleString("sv-SE")}\n${content}`);
      pushPending({
        id: `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        queuedAt: now,
        source: `wechat-bridge:${from}`.slice(0, 40),
        meta: { from, messageCount: 1, firstAt: now, lastAt: now },
        result,
      });
      rememberStatus({ at: new Date().toISOString(), from, count: 1, ok: true });
      return Response.json({ ok: true, queued: true, name: result.person?.name });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "分析失败" }, { status: 502 });
    }
  }

  // 攒批：每条新消息重置空闲计时器
  let buf = bufs.get(from);
  if (!buf) {
    const now = Date.now();
    buf = { items: [], firstAt: now, lastAt: now, timer: setTimeout(() => flush(from), IDLE_MS) };
    bufs.set(from, buf);
  } else {
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flush(from), IDLE_MS);
  }
  buf.lastAt = Date.now();
  buf.items.push({ from, time: new Date().toLocaleString("sv-SE"), content });

  if (buf.items.length >= MAX_ITEMS) {
    flush(from);
    return Response.json({ ok: true, buffered: 0, flushed: true });
  }
  return Response.json({ ok: true, buffered: buf.items.length });
}

// GET：看当前攒批状态（调试）
export async function GET() {
  return Response.json({
    buffering: [...bufs.entries()].map(([from, b]) => ({
      from,
      count: b.items.length,
      firstAt: new Date(b.firstAt).toISOString(),
      lastAt: new Date(b.lastAt).toISOString(),
    })),
    recent,
  });
}
