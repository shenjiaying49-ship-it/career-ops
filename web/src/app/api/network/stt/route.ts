import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 语音转文字：网页录的音频 → 本地 whisper.cpp 识别 → 文本。
// 不依赖浏览器语音 API（Chrome 的 Web Speech 要连 Google 服务器，国内不可用），
// 模型文件在 agent/models/，推理全程本机，音频不上传。

const execFileAsync = promisify(execFile);
const MAX_BYTES = 25 * 1024 * 1024; // 25MB（约 25 分钟录音）

const MODEL_PATH = path.join(careerOpsRoot(), "agent", "models", "ggml-base-q5_1.bin");
// launchd 环境的 PATH 不含 homebrew，用绝对路径最稳
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const WHISPER = "/opt/homebrew/bin/whisper-cli";

export async function POST(req: Request) {
  let body: { audio?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const m = /^data:audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)[^;]*;base64,(.+)$/i.exec(body.audio ?? "");
  if (!m) return Response.json({ error: "需要 webm/ogg/mp4/wav 音频" }, { status: 400 });

  const ext = m[1].toLowerCase().replace("x-m4a", "m4a");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) return Response.json({ error: "录音太长（上限 25 分钟）" }, { status: 400 });

  const tmp = path.join(os.tmpdir(), `career-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const rawPath = `${tmp}-raw.${ext}`;
  // whisper 只吃 16kHz 单声道 wav → 先用 ffmpeg 转码
  const wavPath = `${tmp}.wav`;

  try {
    fs.writeFileSync(rawPath, buf);
    let ffErrDetail = "";
    try {
      await execFileAsync(FFMPEG, ["-y", "-i", rawPath, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", wavPath], { timeout: 30_000 });
    } catch (ffErr) {
      ffErrDetail = [ffErr instanceof Error ? ffErr.message : String(ffErr), (ffErr as { stderr?: string })?.stderr ?? ""].filter(Boolean).join(" | ").slice(0, 500);
      return Response.json({ error: `音频转码失败：${ffErrDetail}` }, { status: 422 });
    }

    // -np 关进度条；-l zh 固定中文（口述录入都是中文，避免语言误判繁体混杂）
    const { stdout } = await execFileAsync(
      WHISPER,
      ["-m", MODEL_PATH, "-l", "zh", "-np", "--no-prints", wavPath],
      { timeout: 100_000, maxBuffer: 4 * 1024 * 1024 },
    );
    // whisper-cli 输出行形如 [00:00:00.000 --> 00:00:04.600]  文本
    const text = stdout
      .split("\n")
      .map((l) => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "").trim())
      .filter((l) => l && !/^\(.*\)$/.test(l)) // 去掉 (空白提示) 行
      .join("\n")
      .trim();

    if (!text) return Response.json({ error: "没听清内容，再靠近麦克风说一次" }, { status: 422 });
    return Response.json({ text });
  } catch (err) {
    return Response.json({ error: `识别失败：${err instanceof Error ? err.message.slice(0, 140) : "unknown"}` }, { status: 500 });
  } finally {
    for (const p of [rawPath, wavPath]) {
      try { fs.rmSync(p, { force: true }); } catch { /* tmp 清理失败无所谓 */ }
    }
  }
}
