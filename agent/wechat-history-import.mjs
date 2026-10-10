#!/usr/bin/env node
// ─── 微信历史聊天导入管道（WechatExporter → 近30天 → 人脉库）───
// 前提：iPhone 已用访达做过「不加密」备份（数据在 ~/Library/Application Support/MobileSync/Backup/）
//
// 用法：
//   node wechat-history-import.mjs export           # 找到最新备份 → CLI 自动导出 HTML 到 output/
//   node wechat-history-import.mjs import [--days 30] [--dry-run] [--limit N] [--min-msgs 3]
//                                                    # 解析导出物 → 过滤近 N 天 → 逐人分析入待入库队列
//   node wechat-history-import.mjs sample [文件]     # 干跑看某个会话文件解析效果（前 3 人样本）

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API = process.env.NETWORK_API ?? "http://localhost:3000";

const TOOLS = "/Users/jyshen/WorkBuddy/原子公社/wechat-export/tools";
const CMD_BIN = path.join(TOOLS, "cmd", "WechatExporterCmd");
const OUTPUT_DIR = path.join(TOOLS, "..", "output");
const BACKUP_ROOT = path.join(process.env.HOME, "Library", "Application Support", "MobileSync", "Backup");

const log = (msg) => console.log(`[${new Date().toLocaleTimeString("sv-SE")}] ${msg}`);

// ── 1. 导出：定位最新备份 → 跑 CLI ──

function newestBackup() {
  if (!fs.existsSync(BACKUP_ROOT)) return null;
  const dirs = fs.readdirSync(BACKUP_ROOT)
    .map((d) => path.join(BACKUP_ROOT, d))
    .filter((d) => fs.existsSync(path.join(d, "Status.plist")) || fs.existsSync(path.join(d, "Manifest.plist")));
  if (!dirs.length) return null;
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function runExport() {
  const backup = newestBackup();
  if (!backup) {
    log(`✗ 没找到 iPhone 备份。请先用访达给 iPhone 做一次「不加密」备份：
  1. 数据线连接 iPhone，手机点「信任」
  2. 访达 → 侧栏选你的 iPhone
  3. 勾「将 iPhone 上的所有数据备份到这台 Mac」，【不要勾加密备份】
  4. 点「立即备份」等完成（首次约 30 分钟–数小时）`);
    process.exit(1);
  }
  log(`找到备份：${path.basename(backup)}（${new Date(fs.statSync(backup).mtimeMs).toLocaleString("sv-SE")}）`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  log(`开始导出到 ${OUTPUT_DIR}（联系人多时约几分钟）…`);
  try {
    const { stdout, stderr } = await execFileAsync(CMD_BIN, [backup, OUTPUT_DIR], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    (stdout ?? "").split("\n").filter(Boolean).slice(-10).forEach((l) => log("· " + l));
    if (stderr) log(`stderr: ${stderr.slice(0, 300)}`);
  } catch (err) {
    log(`✗ 导出失败：${err.message}`);
    if (String(err.stderr ?? "").includes("signature")) log("→ 重新签名试试：cd tools/cmd && codesign -s - -f WechatExporterCmd && find Frameworks -name '*.dylib' -exec codesign -s - -f {} +");
    process.exit(1);
  }
  log("✓ 导出完成。接着运行：node wechat-history-import.mjs import --dry-run 先看解析效果");
}

// ── 2. 解析：HTML/txt → 会话 → 近 N 天消息 ──

const DT_RE = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})[日]?\s*[,，]?\s*(?:周[一二三四五六日天]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** 一个会话文件 → [{dt, text}]（按时间切分，容忍多种格式） */
function parseSessionFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const text = file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm") ? htmlToText(raw) : raw;
  const lines = text.split("\n");
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    const m = DT_RE.exec(line);
    if (m) {
      if (cur && cur.text.trim()) msgs.push(cur);
      const rest = line.slice(m.index + m[0].length).trim();
      cur = { dt: `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")} ${String(m[4]).padStart(2, "0")}:${m[5]}`, rest, text: "" };
      if (rest) cur.text = rest;
      continue;
    }
    if (cur) cur.text += (cur.text ? "\n" : "") + line.trim();
  }
  if (cur && cur.text.trim()) msgs.push(cur);
  return msgs;
}

/** 消息数组 → 去掉系统行/空白，保留有效消息 */
function cleanMsgs(msgs) {
  return msgs.filter((m) => {
    const t = m.text.trim();
    if (!t) return false;
    if (/^(以上是打招呼|下面是新消息|你已添加|以下是新消息)/.test(t)) return false;
    if (t.length > 1500) return false;
    return true;
  });
}

function dateWithin(dt, days) {
  const d = new Date(dt.replace(/-/g, "/"));
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= days * 86400_000;
}

// ── 3. 入库：每个联系人的近 N 天消息 → analyze → 待入库队列 ──

async function analyzeAndQueue(name, text) {
  const r = await fetch(`${API}/api/network/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? `analyze ${r.status}`);
  if (!d.result?.person?.name) throw new Error("分析结果缺少人名");
  const q = await fetch(`${API}/api/network/queue-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: d.result, source: "wechat-history" }),
  });
  if (!q.ok) throw new Error(`queue-import ${q.status}`);
}

async function runImport(opts) {
  const sessionDir = path.join(OUTPUT_DIR, "session");
  if (!fs.existsSync(sessionDir)) {
    log(`✗ 没找到导出物（${sessionDir}）。先运行：node wechat-history-import.mjs export`);
    process.exit(1);
  }
  const files = fs.readdirSync(sessionDir).filter((f) => /\.html?$/i.test(f));
  log(`导出物里共 ${files.length} 个会话文件，开始解析…`);

  let scanned = 0, queued = 0, skipped = 0, failed = 0;
  for (const f of files) {
    if (opts.limit && queued >= opts.limit) break;
    const file = path.join(sessionDir, f);
    let msgs;
    try { msgs = cleanMsgs(parseSessionFile(file)); } catch { skipped++; continue; }
    if (msgs.length < opts.minMsgs) { skipped++; continue; }
    const recent = msgs.filter((m) => dateWithin(m.dt, opts.days));
    if (recent.length < opts.minMsgs) { skipped++; continue; }

    // 会话名：优先文件名（WechatExporter 常以备注/昵称命名），否则取第一条消息的 rest/首行
    const fileStem = f.replace(/\.html?$/i, "").replace(/^session_?/i, "");
    const fallbackName = recent[0].rest?.slice(0, 20) || recent[0].text.slice(0, 20);
    const name = /^[\w-]{8,}$/.test(fileStem) ? fallbackName : decodeURIComponent(fileStem);

    // 拼成 analyze 认识的「昵称\n时间\n内容」格式；超长从最近往前截断
    let text = recent.map((m) => `${name}\n${m.dt}\n${m.text.trim()}`).join("\n\n");
    if (text.length > opts.maxChars) {
      const blocks = [];
      let size = 0;
      for (let i = recent.length - 1; i >= 0; i--) {
        const b = `${name}\n${recent[i].dt}\n${recent[i].text.trim()}`;
        if (size + b.length > opts.maxChars) break;
        blocks.unshift(b);
        size += b.length;
      }
      text = blocks.join("\n\n");
    }

    scanned++;
    if (opts.dryRun) {
      if (scanned <= 3) {
        log(`── 样本：${name}（近${opts.days}天 ${recent.length} 条，文本 ${text.length} 字）`);
        log(text.slice(0, 400) + (text.length > 400 ? "…" : ""));
      }
      queued++;
      continue;
    }
    try {
      await analyzeAndQueue(name, text);
      queued++;
      log(`✓ ${queued} ${name}（${recent.length} 条消息已入队）`);
    } catch (err) {
      failed++;
      log(`✗ ${name}：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // 别打爆 DeepSeek
  }
  log(`\n完成：解析 ${scanned} 人 · 入队 ${queued} · 跳过 ${skipped}（消息太少/超范围）· 失败 ${failed}`);
  if (!opts.dryRun) log("→ 打开 http://localhost:3000/network ，智能自动入库会把有价值的直接写进人脉库");
}

// ── 入口 ──

function parseOpts(argv) {
  const opts = { days: 30, dryRun: false, limit: 0, minMsgs: 3, maxChars: 6000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") opts.days = Number(argv[++i]) || 30;
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--limit") opts.limit = Number(argv[++i]) || 0;
    else if (argv[i] === "--min-msgs") opts.minMsgs = Number(argv[++i]) || 3;
    else if (argv[i] === "--max-chars") opts.maxChars = Number(argv[++i]) || 6000;
  }
  return opts;
}

async function main() {
  const cmd = process.argv[2] ?? "";
  if (cmd === "export") return runExport();
  if (cmd === "import") return runImport(parseOpts(process.argv.slice(3)));
  if (cmd === "sample") {
    const file = process.argv[3] ? path.join(OUTPUT_DIR, "session", process.argv[3]) : null;
    if (file && fs.existsSync(file)) {
      const msgs = cleanMsgs(parseSessionFile(file)).filter((m) => dateWithin(m.dt, parseOpts(process.argv.slice(4)).days));
      log(`近 30 天 ${msgs.length} 条，前 10 条：`);
      msgs.slice(0, 10).forEach((m) => log(`${m.dt} | ${m.text.replace(/\n/g, " ").slice(0, 80)}`));
      return;
    }
    log("用法：sample <session 目录里的文件名>");
    return;
  }
  console.log(`用法：
  node wechat-history-import.mjs export                  # 备份 → 导出 HTML
  node wechat-history-import.mjs import --dry-run        # 先干跑看解析效果
  node wechat-history-import.mjs import [--days 30]      # 正式导入近 30 天
参数：--days N 近 N 天 · --limit N 最多 N 人 · --min-msgs N 消息少于 N 条跳过 · --max-chars N 每人文本上限`);
}

main().catch((err) => { log(`✗ ${err instanceof Error ? err.message : err}`); process.exit(1); });
