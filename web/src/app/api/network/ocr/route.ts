import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 截图识别导入：图片 → macOS Vision 本地 OCR → 文本。
// 图片不离开本机（不走任何外部 API），识别后由前端决定走「聊天记录分析」还是「名片解析」。

const execFileAsync = promisify(execFile);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function ocrBinary(): string {
  return path.join(careerOpsRoot(), "agent", "bin", "vision-ocr");
}

export async function POST(req: Request) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const dataUrl = body.image ?? "";
  const m = /^data:image\/(png|jpe?g|heic|webp);base64,(.+)$/i.exec(dataUrl);
  if (!m) return Response.json({ error: "需要 png/jpg/heic/webp 图片" }, { status: 400 });

  const mime = m[1].toLowerCase();
  const base64 = m[2];
  if (base64.length > MAX_BYTES) return Response.json({ error: "图片太大（上限 10MB）" }, { status: 400 });

  const buf = Buffer.from(base64, "base64");
  const tmp = path.join(os.tmpdir(), `career-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let imgPath = `${tmp}.${mime === "jpeg" ? "jpg" : mime}`;
  try {
    // Vision 不认 heic/webp → 用系统 sips 转 png
    if (mime === "heic" || mime === "webp") {
      const raw = `${tmp}.${mime}`;
      fs.writeFileSync(raw, buf);
      imgPath = `${tmp}.png`;
      await execFileAsync("sips", ["-s", "format", "png", raw, "--out", imgPath]);
      fs.rmSync(raw, { force: true });
    } else {
      fs.writeFileSync(imgPath, buf);
    }

    const { stdout } = await execFileAsync(ocrBinary(), [imgPath], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const text = stdout.trim();
    if (!text) return Response.json({ error: "没识别出文字，试试更清晰的截图" }, { status: 422 });
    return Response.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `OCR 失败：${msg.slice(0, 160)}` }, { status: 500 });
  } finally {
    fs.rmSync(imgPath, { force: true });
  }
}
