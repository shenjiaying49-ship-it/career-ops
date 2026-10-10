import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 人脉库本地磁盘备份：每次保存自动触发（fire-and-forget）。
// latest.json 永远是最新全量；每天最多留一份带日期快照，保留最近 30 份。
// 数据永远在用户自己机器上，浏览器炸了/换电脑都能从这里恢复。

const KEEP_SNAPSHOTS = 30;

export async function POST(req: Request) {
  let body: { store?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const store = body.store;
  if (!store || typeof store !== "object") {
    return Response.json({ error: "store required" }, { status: 400 });
  }

  try {
    const dir = path.join(careerOpsRoot(), "data", "network-backups");
    fs.mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(store, null, 2);
    fs.writeFileSync(path.join(dir, "latest.json"), json, "utf8");

    // 每天一份快照（同一天覆盖同名文件，不堆积）
    const today = new Date().toLocaleDateString("sv-SE");
    fs.writeFileSync(path.join(dir, `snapshot-${today}.json`), json, "utf8");

    // 清理超过保留数的旧快照
    const snapshots = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .reverse();
    for (const old of snapshots.slice(KEEP_SNAPSHOTS)) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {
        /* ignore */
      }
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: `备份写入失败: ${err instanceof Error ? err.message : "unknown"}` }, { status: 500 });
  }
}

// GET：列出可用备份（供将来做恢复界面）
export async function GET() {
  try {
    const dir = path.join(careerOpsRoot(), "data", "network-backups");
    if (!fs.existsSync(dir)) return Response.json({ backups: [] });
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    return Response.json({ backups });
  } catch {
    return Response.json({ backups: [] });
  }
}
