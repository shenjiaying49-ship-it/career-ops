import { parseVcf } from "@/lib/network/vcf";
import { parseCsvContacts } from "@/lib/network/csv-contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 文件导入解析：通讯录（.vcf）/ 名单表（.csv）→ 结构化联系人列表。
// 纯本地解析（不调 AI），返回后由前端复用批量确认界面。

const MAX_RAW = 5 * 1024 * 1024; // 5MB

export async function POST(req: Request) {
  let body: { kind?: string; raw?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const raw = body.raw ?? "";
  if (!raw.trim()) return Response.json({ error: "文件内容为空" }, { status: 400 });
  if (raw.length > MAX_RAW) return Response.json({ error: "文件太大（上限 5MB）" }, { status: 400 });

  if (body.kind === "vcf") {
    const people = parseVcf(raw);
    if (!people.length) return Response.json({ error: "没解析出联系人，确认是通讯录导出的 .vcf 文件" }, { status: 422 });
    return Response.json({ people });
  }
  if (body.kind === "csv") {
    const people = parseCsvContacts(raw);
    if (!people.length) return Response.json({ error: "没解析出姓名，确认表格里有「姓名」列" }, { status: 422 });
    return Response.json({ people });
  }
  return Response.json({ error: "kind 必须是 vcf 或 csv" }, { status: 400 });
}
