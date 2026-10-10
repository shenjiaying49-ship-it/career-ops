import { pushPending } from "@/lib/network/pending-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 微信剪贴板 Agent 的入库队列：Agent 分析完的聊天结果写到这里，
// 浏览器 /network 页面轮询 /api/network/pending 展示并一键入库。
// 队列是文件（career-ops/data/network-pending.json），服务重启不丢。

export async function POST(req: Request) {
  let body: { result?: unknown; source?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const result = body.result;
  if (!result || typeof result !== "object") {
    return Response.json({ error: "result required" }, { status: 400 });
  }
  const item = {
    id: `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: new Date().toISOString(),
    source: (body.source ?? "clipboard").slice(0, 40),
    result,
  };
  const total = pushPending(item);
  return Response.json({ ok: true, queued: 1, total });
}
