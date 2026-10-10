import { analyzeChat } from "@/lib/network/analyze-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 聊天记录分析（网页粘贴入口）。核心逻辑在 lib/network/analyze-chat.ts，
// 与 /api/network/ingest（微信桥接推送）共用。

export async function POST(req: Request) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ error: "聊天记录不能为空" }, { status: 400 });
  if (text.length > 50_000) return Response.json({ error: "聊天记录太长（上限 5 万字符）" }, { status: 400 });

  try {
    const result = await analyzeChat(text);
    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "分析失败" }, { status: 502 });
  }
}
