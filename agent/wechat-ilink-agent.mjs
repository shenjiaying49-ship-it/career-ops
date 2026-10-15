#!/usr/bin/env node
// ─── 微信 iLink 官方机器人桥（被动记录版）───
// 用微信官方 iLink Bot API（2026 年开放，个人号扫码接入，无封号风险）：
// 收到主号的新私聊 → 转发到人脉系统 /api/network/ingest → AI 分析 → 待确认入库。
// 只记录、不回复：朋友无感知，你照常手动聊微信。
//
// 一个微信号同时只能有一个程序消费 getupdates —— 用了本 Agent 就不要
// 在 Cola 里对同一个号 /wechat login（二选一）。
//
// 用法：
//   node wechat-ilink-agent.mjs login    # 扫码登录（终端出二维码）
//   node wechat-ilink-agent.mjs          # 常驻收消息
//   node wechat-ilink-agent.mjs --status # 看登录状态
//   node wechat-ilink-agent.mjs logout   # 清除本地凭证

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.NETWORK_API ?? "http://localhost:3000";
const STATE_PATH = path.join(__dirname, "wechat-ilink-state.json");

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "0.1.0";
const CLIENT_VERSION = 100; // 0.1.0 → major*10000+minor*100+patch

const log = (msg) => console.log(`[${new Date().toLocaleTimeString("sv-SE")}] ${msg}`);

// ── HTTP 基础 ──

function commonHeaders() {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
}

function authHeaders(token) {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": uin,
    ...commonHeaders(),
    Authorization: `Bearer ${token.trim()}`,
  };
}

async function getJson(base, endpoint, timeoutMs = 35_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${endpoint}`, { method: "GET", headers: commonHeaders(), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${endpoint} ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(base, endpoint, body, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? 35_000);
  try {
    const res = await fetch(`${base}/${endpoint}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${endpoint} ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── 状态存取 ──

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ── 登录：拿二维码 → 终端渲染 → 轮询直到 confirmed ──

async function login() {
  let base = DEFAULT_BASE;
  let baseInfo = null;
  const QR_MAX_REFRESH = 3;

  for (let round = 1; round <= QR_MAX_REFRESH; round++) {
    log(`获取登录二维码（第 ${round} 轮）…`);
    const qr = await getJson(base, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent("3")}`);
    if (!qr.qrcode) throw new Error(`未拿到二维码: ${JSON.stringify(qr).slice(0, 160)}`);

    await renderQr(qr.qrcode_img_content || qr.qrcode);

    const deadline = Date.now() + 8 * 60_000; // 二维码 8 分钟有效
    let refresh = false;
    while (Date.now() < deadline) {
      let st;
      try {
        st = await getJson(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, 35_000);
      } catch (err) {
        if (err.name === "AbortError") continue; // 轮询超时属于正常，继续
        throw err;
      }
      switch (st.status) {
        case "confirmed": {
          if (!st.ilink_bot_id) throw new Error("登录失败：服务器未返回 ilink_bot_id");
          baseInfo = {
            botId: st.ilink_bot_id,
            userId: st.ilink_user_id ?? "",
            token: st.bot_token,
            baseUrl: st.baseurl ? st.baseurl.replace(/\/$/, "") : base,
            loggedInAt: new Date().toISOString(),
          };
          break;
        }
        case "scaned_but_redirect": {
          if (st.redirect_host) {
            base = `https://${st.redirect_host}`;
            log(`区域重定向 → 轮询主机切换到 ${base}`);
          }
          break;
        }
        case "wait":
        case "scaned":
          break; // 继续等
        default:
          if (/expire|timeout|invalid/i.test(String(st.status))) {
            log("二维码已过期，刷新…");
            refresh = true;
          } else {
            log(`状态: ${st.status}`);
          }
      }
      if (baseInfo) break;
      if (refresh) break;
      await sleep(1000);
    }
    if (baseInfo) break;
    if (!refresh) { log("二维码等待超时"); }
  }

  if (!baseInfo) throw new Error("登录未完成（二维码过期 3 次或超时），重新运行 login");

  const state = { ...baseInfo, cursor: "" };
  saveState(state);
  log(`✓ 登录成功 botId=${mask(baseInfo.botId)} · 已保存到 ${path.basename(STATE_PATH)}`);
  log("现在运行常驻模式：node wechat-ilink-agent.mjs");
}

function mask(s) {
  s = String(s);
  return s.length <= 6 ? "***" : s.slice(0, 3) + "…" + s.slice(-3);
}

async function renderQr(content) {
  try {
    const { default: qrcode } = await import("qrcode-terminal");
    qrcode.generate(String(content), { small: true });
    log("↑ 用微信「扫一扫」扫上面的二维码（8 分钟内有效）");
  } catch {
    log("（未安装 qrcode-terminal，请把下面内容生成二维码后扫码）");
    console.log(String(content));
  }
}

// ── 消息提取（与 Cola 官方插件同一套字段逻辑）───

function extractText(msg) {
  const items = msg.item_list ?? [];
  const parts = [];
  for (const it of items) {
    if (it.type === 1 && it.text_item?.text) parts.push(it.text_item.text); // TEXT=1
    if (it.type === 3 && it.voice_item?.text) parts.push(it.voice_item.text); // VOICE=3（已自动转文字）
  }
  for (const it of items) {
    if (it.ref_msg?.title) parts.push(`[引用: ${it.ref_msg.title}]`);
  }
  // 合并转发的聊天记录等 appmsg：不是 TEXT 类型，但通常带 title/des 字段——尽力提取
  if (!parts.length) {
    for (const it of items) {
      const title = it.title ?? it.appmsg?.title ?? it.des ?? it.appmsg?.des;
      if (typeof title === "string" && title.trim()) parts.push(`[转发] ${title.trim().slice(0, 400)}`);
    }
  }
  return parts.join("\n");
}

// ── 常驻：长轮询 getupdates → 私聊转发 ingest ──

const seenIds = new Map(); // 消息 id → ts（游标回退重投时去重）
function rememberSeen(id) {
  const key = String(id);
  if (seenIds.has(key)) return false;
  seenIds.set(key, Date.now());
  if (seenIds.size > 300) {
    const oldest = [...seenIds.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) seenIds.delete(oldest[0]);
  }
  return true;
}

function notify(title, message) {
  const safe = String(message).replace(/["\\]/g, "");
  const safeTitle = String(title).replace(/["\\]/g, "");
  execFile("osascript", ["-e", `display notification "${safe}" with title "${safeTitle}"`], () => {});
}

// 会话过期时自动弹出终端扫码窗口（每次过期只弹一次）
let reloginPrompted = false;
function promptRelogin() {
  if (reloginPrompted) return;
  reloginPrompted = true;
  notify("微信桥·需要重新扫码", "iLink 会话已过期，正在为你打开扫码窗口");
  const cmd = `cd '${__dirname}' && node wechat-ilink-agent.mjs login`;
  execFile("osascript", ["-e", `tell application "Terminal"\nactivate\ndo script "${cmd.replace(/"/g, '\\"')}"\nend tell`], (err) => {
    if (err) log(`自动打开终端失败（手动运行: node wechat-ilink-agent.mjs login）: ${err.message}`);
  });
}

async function forwardToIngest(from, text) {
  const r = await fetch(`${API}/api/network/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, text }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`ingest ${r.status}: ${d.error ?? ""}`);
  }
  return r.json();
}

async function runLoop() {
  if (!loadState()?.token) {
    log("未登录。先运行：node wechat-ilink-agent.mjs login");
    process.exit(1);
  }
  log(`iLink 桥启动 · 人脉系统=${API}`);
  log("被动记录模式：只收不回，Ctrl+C 退出");

  let cursor = loadState().cursor ?? "";
  let failStreak = 0;
  let sessionErrors = 0;
  let lastHeartbeat = Date.now();

  for (;;) {
    // 每轮重读状态文件：重新扫码换 token 后无需重启本进程，自动接上
    const state = loadState();
    if (!state?.token) { await sleep(5_000); continue; }
    const base = state.baseUrl || DEFAULT_BASE;

    let resp;
    try {
      resp = await postJson(base, "ilink/bot/getupdates", {
        get_updates_buf: cursor || "",
        base_info: { channel_version: CHANNEL_VERSION },
      }, state.token, 40_000);
      failStreak = 0;
    } catch (err) {
      if (err.name === "AbortError") continue; // 长轮询空转超时，正常
      failStreak++;
      log(`✗ getupdates 失败（连续 ${failStreak}）: ${err.message}`);
      if (failStreak >= 10) {
        log("连续失败过多，暂停 60 秒后重试");
        await sleep(60_000);
      } else {
        await sleep(3_000);
      }
      continue;
    }

    // 关键：HTTP 200 也可能带业务错误（如 errcode -14 session timeout）
    if (resp.errcode && resp.errcode !== 0) {
      sessionErrors++;
      const expired = resp.errcode === -14 || /session|token|auth/i.test(String(resp.errmsg ?? ""));
      if (expired) {
        log(`✗ 微信会话已过期（errcode ${resp.errcode}: ${resp.errmsg}）— 需要重新扫码，已弹窗`);
        promptRelogin();
        await sleep(30_000);
        // 重新扫码后 state 文件会更新，下一轮自动用新 token；重置弹窗标记
        if (loadState()?.loggedInAt !== state.loggedInAt) reloginPrompted = false;
        continue;
      }
      log(`✗ getupdates 业务错误 errcode=${resp.errcode}: ${resp.errmsg}`);
      await sleep(10_000);
      continue;
    }
    sessionErrors = 0;

    // 心跳：静默不代表挂了，每 10 分钟报一次平安
    if (Date.now() - lastHeartbeat > 10 * 60_000) {
      log(`心跳：轮询正常（累计 ${sessionErrors} 次会话错误已恢复）`);
      lastHeartbeat = Date.now();
    }

    const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
    let forwarded = 0;
    let userMsgs = 0;
    for (const msg of msgs) {
      const mid = msg.client_id ?? msg.msg_id ?? `${msg.from_user_id}-${extractText(msg).slice(0, 40)}`;
      if (!rememberSeen(mid)) continue;
      if (msg.message_type !== 1) continue;              // 只处理 USER=1 的消息
      if (!msg.from_user_id) continue;
      userMsgs++;
      // 自己发出的消息若被镜像（如转发到文件传输助手）→ 也当录入语料，标记来源
      const isSelf = msg.from_user_id === state.userId;
      if (msg.group_id) { log(`跳过群聊消息（群 ${msg.group_id}）：官方 API 不支持群`); continue; }
      const text = extractText(msg);
      if (!text.trim()) continue;
      try {
        const from = isSelf ? "我的转发" : msg.from_user_id;
        const d = await forwardToIngest(from, text);
        forwarded++;
        log(`→ 已转发 ${from}${d.buffered ? `（攒批第 ${d.buffered} 条）` : "（已触发分析）"}`);
        notify(isSelf ? "人脉桥·我的转发已录入" : "人脉桥·微信", `${from}: ${text.slice(0, 30)}${text.length > 30 ? "…" : ""}`);
      } catch (err) {
        log(`✗ 转发失败：${err.message}（游标暂不推进，下一轮重投）`);
        await sleep(2_000);
        break; // 保留 cursor，重试这一批
      }
    }

    // 只有整批都转发成功才推进游标；空 msgs 也推进（正常心跳）
    if (resp.get_updates_buf && forwarded === userMsgs) {
      cursor = resp.get_updates_buf;
      const fresh = loadState();
      if (fresh?.token) saveState({ ...fresh, cursor });
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 入口 ──

async function main() {
  const cmd = process.argv[2] ?? "";
  if (cmd === "login") {
    await login();
  } else if (cmd === "logout") {
    if (fs.existsSync(STATE_PATH)) fs.rmSync(STATE_PATH);
    log("已清除本地凭证（微信侧可另行解绑）");
  } else if (cmd === "--status") {
    const s = loadState();
    if (!s?.token) { log("未登录"); return; }
    log(`已登录 botId=${mask(s.botId)} · 登录于 ${s.loggedInAt} · cursor=${s.cursor ? "有" : "无"}`);
  } else {
    await runLoop();
  }
}

main().catch((err) => {
  log(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
