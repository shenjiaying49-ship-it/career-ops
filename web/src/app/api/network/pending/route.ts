import { readPending, removePending } from "@/lib/network/pending-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 待入库队列（浏览器读取/确认后清除）。
// GET  → { pending: [...] }
// POST { action: "remove", ids: ["pend-..."] } → 移除已入库/已忽略的条目

export async function GET() {
  return Response.json({ pending: readPending() });
}

export async function POST(req: Request) {
  let body: { action?: string; ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (body.action !== "remove" || !Array.isArray(body.ids)) {
    return Response.json({ error: "action:'remove' and ids[] required" }, { status: 400 });
  }
  const remaining = removePending(body.ids);
  return Response.json({ ok: true, remaining });
}
