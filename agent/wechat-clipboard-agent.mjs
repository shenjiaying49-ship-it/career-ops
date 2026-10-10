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

// 判断剪贴板文本像不像微信聊天记录：
// ≥2 行、含中文、且有时间戳或多行「昵称: 内容」格式
function chatRejectReason(text) {
  if (!text) return "剪贴板为空";
  if (text.length < 10) return "文本太短（至少 10 个字符）";
  if (text.length > 50_000) return "文本超过 50,000 字";
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return "只有一行，至少复制两条聊天内容";
  if (!/[\u4e00-\u9fff]/.test(text)) return "未检测到中文聊天内容";
  const hasTime = /\d{1,2}:\d{2}/.test(text) || /20\d{2}[-/年]/.test(text);
  const colonLines = (text.match(/^[^\n:：]{1,20}[:：]\s*\S/gm) ?? []).length;
  if (!hasTime && colonLines < 2) return "没有时间戳或‘昵称：内容’格式";
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
  log(`识别到聊天记录（${text.length} 字，首行: ${name0}），分析中…`);
  try {
    const result = await analyze(text);
    await queueImport(result);
    const who = [result.person?.name, result.person?.org].filter(Boolean).join(" · ");
    const intent = result.intent?.category ?? "";
    log(`✓ 已入待确认队列：${who}（${intent}）`);
    if (!quiet) notify("人脉助手已识别", `${who}（${intent}）→ 打开网页一键入库`);
    return true;
  } catch (err) {
    log(`✗ 处理失败：${err instanceof Error ? err.message : err}`);
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
