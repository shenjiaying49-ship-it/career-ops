#!/usr/bin/env node
// ─── 微信 Agent 接口适配器 ───
// 轮询你的微信 Agent API → 过滤（跳过自己/群聊）→ 同一联系人攒批
// → DeepSeek 分析 → 待确认队列（/network 网页一键入库）。
//
// 用法：
//   1. 配好 wechat-api-config.json（baseUrl / 鉴权 / 字段映射）
//   2. 先离线验证字段映射：
//      node wechat-api-agent.mjs --sample '[{"id":1,"from_name":"张三","content":"你好","create_time":"2026-09-24 10:00"}]'
//   3. 实际轮询：
//      node wechat-api-agent.mjs
//      node wechat-api-agent.mjs --once     # 只拉一次

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.NETWORK_API ?? "http://localhost:3000";
const CONFIG_PATH = path.join(__dirname, "wechat-api-config.json");
const STATE_PATH = path.join(__dirname, "wechat-api-state.json");

const log = (msg) => console.log(`[${new Date().toLocaleTimeString("sv-SE")}] ${msg}`);

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

const cfg = loadJson(CONFIG_PATH, null);
if (!cfg) {
  console.error(`缺少配置文件 ${CONFIG_PATH}`);
  process.exit(1);
}

// ── 消息规范化：把任意字段名映射成统一结构 ──
function normalize(raw) {
  const get = (obj, ...keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  };
  const id = String(get(raw, cfg.idField, "id", "msg_id", "msgid") ?? "");
  const from = String(get(raw, cfg.fromField, "from", "from_name", "sender", "talker", "nickname") ?? "").trim();
  const content = String(get(raw, cfg.contentField, "content", "text", "msg") ?? "").trim();
  const time = get(raw, cfg.timeField, "create_time", "ts", "time", "timestamp");
  const isGroup = Boolean(get(raw, cfg.isGroupField, "is_group", "isGroup", "room"));
  const isSelf = from === cfg.selfName || Boolean(get(raw, "is_self", "isSelf", "from_self"));
  if (!id || !from || !content) return null;
  return { id, from, content, time: fmtTime(time), isGroup, isSelf };
}

function fmtTime(t) {
  if (!t) return "";
  const d = new Date(typeof t === "number" ? (t > 1e12 ? t : t * 1000) : /^\d+$/.test(String(t)) ? Number(t) > 1e12 ? Number(t) : Number(t) * 1000 : t);
  return isNaN(d.getTime()) ? String(t) : d.toLocaleString("sv-SE").replace(" ", " ");
}

// ── 攒批：同一联系人 batchWindowMs 内的消息合成一段聊天 ──
const buffers = new Map(); // from → { msgs: [], firstAt: ms }

function pushToBuffer(msg) {
  let buf = buffers.get(msg.from);
  if (!buf) { buf = { msgs: [], firstAt: Date.now() }; buffers.set(msg.from, buf); }
  buf.msgs.push(msg);
}

function flushable(convs) {
  const now = Date.now();
  return convs.filter(([, b]) => now - b.firstAt >= (cfg.batchWindowMs ?? 300000) || b.msgs.length >= 20);
}

function bufferToText(buf) {
  return buf.msgs.map((m) => `${m.from}\n${m.time}\n${m.content}`).join("\n\n");
}

// ── 分析 + 入队（复用剪贴板 Agent 的链路）──
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
    body: JSON.stringify({ result, source: "wechat-api" }),
  });
  if (!r.ok) throw new Error(`queue-import ${r.status}`);
}

async function flushConversation(from, buf) {
  const text = bufferToText(buf);
  buffers.delete(from);
  log(`分析「${from}」的 ${buf.msgs.length} 条消息…`);
  try {
    const result = await analyze(text);
    await queueImport(result);
    const who = [result.person?.name, result.person?.org].filter(Boolean).join(" · ");
    log(`✓ 已入待确认队列：${who}（${result.intent?.category ?? ""}）`);
  } catch (err) {
    log(`✗ 「${from}」处理失败：${err instanceof Error ? err.message : err}`);
  }
}

// ── 拉取 ──
function loadCursor() {
  return loadJson(STATE_PATH, { lastId: null }).lastId;
}
function saveCursor(id) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ lastId: id }, null, 2), "utf8");
}

async function fetchMessages() {
  const cursor = loadCursor();
  const url = new URL(cfg.messagesPath, cfg.baseUrl);
  if (cursor) url.searchParams.set(cfg.sinceParam ?? "since_id", cursor);
  const headers = {};
  if (cfg.authToken && cfg.authHeader) headers[cfg.authHeader] = cfg.authToken;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`拉取 ${r.status}`);
  const d = await r.json();
  // 兼容 { messages: [...] } / { data: [...] } / [ ... ] 三种返回形状
  const list = Array.isArray(d) ? d : (d.messages ?? d.data ?? d.list ?? []);
  return list;
}

async function pollOnce() {
  let list;
  try { list = await fetchMessages(); }
  catch (err) { log(`拉取失败：${err instanceof Error ? err.message : err}`); return; }

  let cursor = loadCursor();
  let used = 0;
  for (const raw of list) {
    const msg = normalize(raw);
    if (!msg) {
      log(`跳过消息：字段映射失败（需要 id/from/content），原始字段=${Object.keys(raw ?? {}).join(",") || "无"}`);
      continue;
    }
    if (msg.isSelf) { cursor = msg.id; log(`跳过自己的消息：${msg.from}`); continue; }          // 自己的消息只推进游标
    if (msg.isGroup && !cfg.includeGroups) { cursor = msg.id; log(`跳过群聊消息：${msg.from}`); continue; } // 群聊跳过
    pushToBuffer(msg);
    cursor = msg.id;
    used++;
  }
  if (cursor) saveCursor(cursor);
  if (used) log(`新增 ${used} 条消息（分布在 ${buffers.size} 个对话）`);
}

async function flushLoop() {
  const ready = flushable([...buffers.entries()]);
  for (const [from] of ready) await flushConversation(from, buffers.get(from));
}

async function main() {
  const args = process.argv.slice(2);

  // 离线验证：--sample '[...]' 只做字段映射演示，不调 API
  if (args[0] === "--sample") {
    const raw = JSON.parse(args.slice(1).join(" "));
    const list = Array.isArray(raw) ? raw : (raw.messages ?? raw.data ?? raw.list ?? []);
    console.log(`解析出 ${list.length} 条消息：`);
    for (const r of list) {
      const m = normalize(r);
      if (!m) { console.log(`  ✗ 字段映射失败：${JSON.stringify(r).slice(0, 120)}`); continue; }
      console.log(`  ${m.isGroup ? "[群]" : ""}${m.isSelf ? "[自己]" : ""}${m.from} | ${m.time} | ${m.content.slice(0, 40)}`);
    }
    console.log("\n字段映射没问题的话，直接运行：node wechat-api-agent.mjs");
    return;
  }

  log(`微信 API Agent 启动 · 接口=${cfg.baseUrl}${cfg.messagesPath} · API=${API}`);
  log(`群聊${cfg.includeGroups ? "录入" : "跳过"} · 攒批窗口 ${Math.round((cfg.batchWindowMs ?? 300000) / 1000)} 秒`);

  if (args[0] === "--once") {
    await pollOnce();
    for (const [from] of [...buffers.entries()]) await flushConversation(from, buffers.get(from));
    return;
  }

  for (;;) {
    await pollOnce();
    await flushLoop();
    await new Promise((r) => setTimeout(r, cfg.pollMs ?? 5000));
  }
}

main();
