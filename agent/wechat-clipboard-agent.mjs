#!/usr/bin/env node
// ─── 微信剪贴板人脉 Agent ───
// 常驻监听 macOS 剪贴板：在微信 Mac 客户端里选中聊天记录 Cmd+C，
// Agent 自动识别 → DeepSeek 分析 → 写入待入库队列 → macOS 通知。
// 打开 /network 网页一键确认入库。
//
// 不登录微信、不碰微信进程，只读你主动复制的剪贴板 —— 零封号风险。
//
// 用法：
//   node wechat-clipboard-agent.mjs            # 常驻监听
//   node wechat-clipboard-agent.mjs --once     # 只处理当前剪贴板一次
//   node wechat-clipboard-agent.mjs --test "聊天文本"  # 直接处理给定文本（测试）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const API = process.env.NETWORK_API ?? "http://localhost:3000";
const INTERVAL_MS = 1500;
const SEEN_MAX = 80;

const seen = new Map(); // hash → timestamp（LRU 去重，防止同一段聊天被反复分析）

const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString("sv-SE")}] ${msg}`;
  console.log(line);
};

async function getClipboard() {
  try {
    const { stdout } = await execFileAsync("pbpaste", ["-Prefer", "txt"]);
    return stdout;
  } catch {
    return "";
  }
}

function notify(title, message) {
  const safe = String(message).replace(/["\\]/g, "");
  const safeTitle = String(title).replace(/["\\]/g, "");
  execFile("osascript", ["-e", `display notification "${safe}" with title "${safeTitle}"`], () => {});
}

// 判断剪贴板文本像不像微信聊天记录。
// 放宽策略：≥2 行 + 含中文就先放行，交给 AI 判断——微信 ⌘A 复制的格式多变
//（有的没时间戳、有的多行消息挤在一起），宁可多分析一次也不漏掉真实聊天。
// 误入的（随机复制的一段新闻/代码）AI 会返回低置信或没名字，自动丢弃，不入库。
function chatRejectReason(text) {
  if (!text) return "剪贴板为空";
  if (text.length < 10) return "文本太短（至少 10 个字符）";
  if (text.length > 50_000) return "文本超过 50,000 字";
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return "只有一行，至少复制两条聊天内容";
  if (!/[\u4e00-\u9fff]/.test(text)) return "未检测到中文聊天内容";
  // 明显的代码/URL/JSON 大块直接跳过（省 DeepSeek 调用）
  const codeish = (text.match(/^(function|const |import |class |def |SELECT |{"|\s*[<>{};]\s*$|https?:\/\/\S+$)/gm) ?? []).length;
  if (codeish >= 3) return "像代码/链接，不是聊天";
  return "";
}

function looksLikeChat(text) {
  return !chatRejectReason(text);
}

async function analyze(text) {
  const r = await fetch(`${API}/api/network/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? `analyze ${r.status}`);
  if (!d.result?.person?.name) throw new Error("分析结果缺少人名");
  return d.result;
}

async function queueImport(result) {
  const r = await fetch(`${API}/api/network/queue-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result, source: "wechat-clipboard" }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? `queue-import ${r.status}`);
}

async function processText(text, { quiet = false } = {}) {
  const name0 = text.split("\n")[0].slice(0, 20);
  log(`识别到疑似聊天记录（${text.length} 字，首行: ${name0}），分析中…`);
  try {
    const result = await analyze(text);
    await queueImport(result);
    const who = [result.person?.name, result.person?.org].filter(Boolean).join(" · ");
    const intent = result.intent?.category ?? "";
    log(`✓ 已入待确认队列：${who}（${intent}）`);
    if (!quiet) notify("人脉助手已识别", `${who}（${intent}）→ 自动入库开启中，无需操作`);
    return true;
  } catch (err) {
    // AI 判定不是聊天/没解析出人名 → 静默丢弃（放宽识别后的正常噪音）
    log(`✗ 未入库（${err instanceof Error ? err.message.slice(0, 80) : err}）`);
    return false;
  }
}

function rememberHash(text) {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  if (seen.has(hash)) return false;
  seen.set(hash, Date.now());
  if (seen.size > SEEN_MAX) {
    const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) seen.delete(oldest[0]);
  }
  return true;
}

async function tick() {
  const text = await getClipboard();
  if (!text) return;
  const reason = chatRejectReason(text);
  if (reason) {
    log(`跳过剪贴板：${reason}`);
    return;
  }
  if (!rememberHash(text)) return; // 同一段聊天只处理一次
  const ok = await processText(text);
  if (!ok) seen.delete(crypto.createHash("sha256").update(text).digest("hex"));
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--test") {
    const text = args.slice(1).join(" ");
    if (!text) {
      console.error('用法: --test "聊天文本"');
      process.exit(1);
    }
    const ok = await processText(text, { quiet: true });
    process.exit(ok ? 0 : 1);
  }

  log(`人脉剪贴板 Agent 启动 · API=${API}`);
  log("在微信里选中聊天记录 Cmd+C 即可自动录入，Ctrl+C 退出本 Agent");

  if (args[0] === "--once") {
    const text = await getClipboard();
    if (text && looksLikeChat(text) && rememberHash(text)) await processText(text);
    else log("当前剪贴板不像聊天记录，跳过");
    return;
  }

  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick 异常：${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
