"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  ArrowRight, Building2, Calendar, Camera, Check, ChevronDown, ChevronUp, Copy, Download,
  FileUp, Filter, Mic, MessageCircle, Network, Plus, ScanText, Search, Sparkles, Tag, Upload, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CATEGORIES, CATEGORY_COLORS, STAGE_COLORS, TAG_SUGGESTIONS,
  daysSince, localDatePlus, localToday, DEMO_STORE, STORAGE_KEY,
  type ContactCategory, type ContactStage, type Interaction, type NetworkStore,
  type Organization, type Person, type Priority,
} from "@/lib/network/types";

// ─── 话术生成：以人为核心 ───

function generateScript(p: Person, org?: Organization): string {
  // AI 从真实聊天记录生成的话术优先——它比模板更贴合语境
  if (p.aiReply) return p.aiReply;
  const days = daysSince(p.lastContactDate);
  const role = p.title || p.tags[0] || "";
  const who = org ? `${org.name}的${role || "朋友"}` : role || "朋友";
  const coop = p.cooperation ?? "双方的合作方向";
  const topic = p.whatTheyDo ? `你们在${p.whatTheyDo}方面的工作` : `${org?.category === "媒体与内容平台" ? "内容生态" : "社区生态"}方面的事情`;

  if (days !== null && days > 45) {
    return `${p.name}你好，好久不见！最近在做 AI 生态合作的一些新尝试，想到之前跟你聊过${coop}，有些新进展想跟你同步。最近方便聊 15 分钟吗？`;
  }
  if (days !== null && days > 14) {
    return `${p.name}你好，上次聊完${coop}之后我们这边有了一些新进展，想约个时间快速同步，看看接下来怎么推进。这周或下周哪天方便？`;
  }
  if (days !== null && days > 7) {
    return `${p.name}你好，上次聊到${coop}，想跟进一下进展。你那边有什么新想法或需要我配合的吗？`;
  }
  if (p.stage === "潜在") {
    return `你好${p.name}，一直关注${who}${topic}。我们最近在推进${coop}，觉得跟你们方向很契合，想约个时间聊聊合作机会。`;
  }
  return `${p.name}你好，上次聊得很愉快！关于${coop}，我整理了一些更具体的方案，想找时间跟你详细过一下。这周方便吗？`;
}

// ─── 行动引擎 ───

type Urgency = "overdue" | "today" | "soon" | "suggested";
type ActionItem = { person: Person; urgency: Urgency; reason: string };

function computeActions(store: NetworkStore): ActionItem[] {
  const items: ActionItem[] = [];
  for (const p of store.people) {
    if (p.stage === "暂停") continue;
    const until = p.nextFollowUpDate ? daysSince(p.nextFollowUpDate) : null;
    const since = daysSince(p.lastContactDate);

    if (until !== null && until > 0) {
      items.push({ person: p, urgency: "overdue", reason: `跟进已逾期 ${until} 天` });
    } else if (until === 0) {
      items.push({ person: p, urgency: "today", reason: "今天该联系" });
    } else if (until !== null && until >= -7) {
      items.push({ person: p, urgency: "soon", reason: `${-until} 天后该联系` });
    } else if (p.stage === "初步接触" && since !== null && since > 10) {
      items.push({ person: p, urgency: "suggested", reason: `${since} 天没联系了` });
    } else if (p.stage === "深度合作" && since !== null && since > 7) {
      items.push({ person: p, urgency: "suggested", reason: `深度合作，${since} 天没联系` });
    } else if (until === null && since === null && p.priority === "high") {
      items.push({ person: p, urgency: "suggested", reason: "高优先级，还没联系过" });
    }
  }
  const order: Record<Urgency, number> = { overdue: 0, today: 1, soon: 2, suggested: 3 };
  return items.sort((a, b) => order[a.urgency] - order[b.urgency]);
}

// ─── 微信 Agent 待入库条目 ───

type PendingImport = {
  id: string;
  queuedAt: string;
  source: string;
  meta?: { from?: string; messageCount?: number; firstAt?: string; lastAt?: string };
  result: AnalyzeResult;
};

type IngestBuffer = { from: string; count: number; firstAt: string; lastAt?: string };
type IngestStatus = { at: string; from: string; count: number; ok: boolean; error?: string };

// 智能自动入库开关的持久化 key
const AUTO_IMPORT_KEY = "career-ops:network-auto-import";

// 档案完整度维度：录人时最容易漏的关键信息（点击可跳去补）
const GUIDE_DIMS: Array<{ field: keyof Person; label: string }> = [
  { field: "title", label: "职位" },
  { field: "whatTheyDo", label: "他是干嘛的" },
  { field: "whatTheyWant", label: "他想要什么" },
  { field: "whatWeWant", label: "我们想要什么" },
  { field: "cooperation", label: "合作点" },
  { field: "howMet", label: "怎么认识" },
  { field: "city", label: "城市" },
  { field: "wechat", label: "微信" },
  { field: "tags", label: "标签" },
];

// ─── 分析结果 → 入库（微信 Agent / 待确认队列共用）───
// 已存在同名的人：合并更新；新人：创建。返回新的 store。

function applyAnalyzeResult(
  store: NetworkStore,
  result: AnalyzeResult,
): { next: NetworkStore; person: Person; existingId?: string } {
  const today = localToday();
  const name = (result.person.name ?? "").trim() || "未命名";
  const existing = store.people.find((x) => x.name === name) ?? null;
  const orgName = (result.person.org ?? "").trim();
  const org = orgName
    ? store.organizations.find((o) => o.name === orgName || o.name.includes(orgName) || orgName.includes(o.name))
    : undefined;
  let newOrg: Organization | undefined;
  if (orgName && !org) {
    newOrg = {
      id: `org-${Date.now()}`,
      name: orgName,
      category: "AI builder 社群",
      stage: "潜在",
      notes: `来源：微信转发导入 · ${today}（可用组织页「AI 检索」补资料）`,
    };
  }

  const interaction: Interaction = {
    id: `int-${Date.now()}`,
    personId: existing?.id ?? `p-${Date.now()}`,
    date: today,
    channel: "微信",
    summary: result.summary,
    nextAction: result.ourMove?.nextAction ?? undefined,
  };

  let person: Person;
  if (existing) {
    const aiStage = (["潜在", "初步接触", "深度合作"].includes(result.ourMove?.stage ?? "") ? result.ourMove.stage : null) as ContactStage | null;
    const rank: Record<string, number> = { "潜在": 0, "初步接触": 1, "深度合作": 2 };
    const stage = aiStage && rank[aiStage] > rank[existing.stage] ? aiStage : existing.stage;
    const interval = stage === "深度合作" ? 14 : stage === "初步接触" ? 14 : 30;
    person = {
      ...existing,
      orgId: existing.orgId ?? newOrg?.id ?? org?.id,
      title: existing.title ?? result.person.title ?? undefined,
      tags: [...new Set([...existing.tags, ...(result.person.tags ?? [])])],
      whatTheyDo: existing.whatTheyDo ?? result.person.whatTheyDo ?? undefined,
      whatTheyWant: existing.whatTheyWant ?? result.person.whatTheyWant ?? undefined,
      cooperation: existing.cooperation ?? result.ourMove?.cooperation ?? undefined,
      aiReply: result.ourMove.suggestedReply,
      stage,
      lastContactDate: today,
      nextFollowUpDate: localDatePlus(today, interval),
      updatedAt: today,
    };
  } else {
    person = {
      id: interaction.personId,
      name,
      orgId: newOrg?.id ?? org?.id,
      title: result.person.title ?? undefined,
      tags: result.person.tags ?? [],
      wechat: result.person.wechat ?? undefined,
      whatTheyDo: result.person.whatTheyDo ?? undefined,
      whatTheyWant: result.person.whatTheyWant ?? undefined,
      cooperation: result.ourMove?.cooperation ?? undefined,
      notes: `来源：微信转发导入 · ${result.summary}`,
      aiReply: result.ourMove.suggestedReply,
      stage: (["潜在", "初步接触", "深度合作"].includes(result.ourMove?.stage ?? "") ? result.ourMove.stage : "初步接触") as ContactStage,
      priority: "medium",
      createdAt: today,
      updatedAt: today,
    };
  }

  return {
    next: {
      ...store,
      people: existing ? store.people.map((x) => (x.id === existing.id ? person : x)) : [...store.people, person],
      organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
      interactions: [...store.interactions, interaction],
    },
    person,
    existingId: existing?.id,
  };
}

// ─── 主组件 ───

type Tab = "actions" | "people" | "orgs";

export function NetworkDashboard() {
  const [store, setStore] = useState<NetworkStore>(DEMO_STORE);
  const [tab, setTab] = useState<Tab>("actions");
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<ContactStage | "全部">("全部");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<string | null>(null); // orgId
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // 导入中心：hub 统一入口，ocr 截图识别 / file 通讯录·表格文件 / voice 口述录入
  const [hubOpen, setHubOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [chatInitialText, setChatInitialText] = useState<string | undefined>(undefined);
  const [batchInitialText, setBatchInitialText] = useState<string | undefined>(undefined);
  const [addOrgPreselect, setAddOrgPreselect] = useState<string | undefined>(undefined);
  // 组织批量检索：AI 补资料
  const [orgBatch, setOrgBatch] = useState<{ done: number; total: number; current: string; found: number } | null>(null);
  const [orgBusyId, setOrgBusyId] = useState<string | null>(null);
  const batchStopRef = useRef(false);
  const storeRef = useRef(store);
  useEffect(() => { storeRef.current = store; }, [store]);

  // ── 微信 Agent 待入库队列 ──
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const [ingestBuffers, setIngestBuffers] = useState<IngestBuffer[]>([]);
  const [ingestRecent, setIngestRecent] = useState<IngestStatus[]>([]);
  const [ingestCheckedAt, setIngestCheckedAt] = useState<string | null>(null);
  const [ingestConnected, setIngestConnected] = useState<boolean | null>(null);
  const [ingestHelpOpen, setIngestHelpOpen] = useState(false);
  const loadPending = useCallback(async () => {
    try {
      const r = await fetch("/api/network/pending");
      const d = await r.json();
      if (r.ok && Array.isArray(d.pending)) setPendingImports(d.pending as PendingImport[]);
    } catch { /* 服务不在就静默 */ }
  }, []);
  const loadIngestStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/network/ingest", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error("status unavailable");
      setIngestBuffers(Array.isArray(d.buffering) ? d.buffering : []);
      setIngestRecent(Array.isArray(d.recent) ? d.recent : []);
      setIngestConnected(true);
      setIngestCheckedAt(new Date().toISOString());
    } catch {
      setIngestConnected(false);
      setIngestCheckedAt(new Date().toISOString());
    }
  }, []);
  useEffect(() => {
    loadPending();
    loadIngestStatus();
    const t = window.setInterval(() => { loadPending(); loadIngestStatus(); }, 20_000);
    const onFocus = () => { loadPending(); loadIngestStatus(); };
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [loadPending, loadIngestStatus]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setStore(JSON.parse(raw) as NetworkStore);
    } catch { /* demo fallback */ }
  }, []);

  // ── 智能自动入库：默认开启（只有明确关过才保持关闭）──
  const [autoImport, setAutoImport] = useState(true);
  useEffect(() => {
    setAutoImport(localStorage.getItem(AUTO_IMPORT_KEY) !== "0");
  }, []);
  const toggleAutoImport = useCallback(() => {
    setAutoImport((v) => {
      const next = !v;
      localStorage.setItem(AUTO_IMPORT_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const save = useCallback((next: NetworkStore) => {
    setStore(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* 存储满等情况：磁盘备份兜底 */ }
    // 磁盘自动备份（fire-and-forget）：数据落在 career-ops/data/network-backups/，
    // 浏览器数据丢失时仍可从这里恢复。
    fetch("/api/network/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store: next }),
    }).catch(() => { /* 静默：下次保存会再试 */ });
  }, []);

  const notify = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  // ── 微信 Agent 待入库：确认/忽略 ──

  const removePending = useCallback((ids: string[]) => {
    setPendingImports((prev) => prev.filter((x) => !ids.includes(x.id)));
    fetch("/api/network/pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", ids }),
    }).catch(() => {});
  }, []);

  const acceptPending = useCallback((item: PendingImport) => {
    if (!item.result?.person?.name) { removePending([item.id]); return; }
    const { next, person, existingId } = applyAnalyzeResult(storeRef.current, item.result);
    save(next);
    removePending([item.id]);
    setSelectedId(person.id);
    notify(existingId ? `已更新 ${person.name} 的资料` : `已入库 ${person.name}`);
  }, [save, notify, removePending]);

  const acceptAllPending = useCallback(() => {
    const valid = pendingImports.filter((x) => x.result?.person?.name);
    if (!valid.length) { removePending(pendingImports.map((x) => x.id)); return; }
    let cur = storeRef.current;
    let updated = 0;
    for (const item of valid) {
      const r = applyAnalyzeResult(cur, item.result);
      cur = r.next;
      if (r.existingId) updated++;
    }
    save(cur);
    removePending(valid.map((x) => x.id));
    notify(`已入库 ${valid.length} 人（${updated} 人为更新）`);
  }, [pendingImports, save, notify, removePending]);

  // ── 智能自动入库：开关打开时，有价值的条目直接入库（不用点确认）──
  // 纯闲聊且无业务信号的留在待确认里人工筛；没名字的垃圾条目直接清掉。
  useEffect(() => {
    if (!autoImport || !pendingImports.length) return;
    const lowValue = (x: PendingImport) => {
      const r = x.result;
      const cat = r?.intent?.category;
      return (cat === "闲聊维护" || cat === "无明显意向") && !r?.businessMatch?.matchedBusiness && !r?.person?.whatTheyWant;
    };
    const auto = pendingImports.filter((x) => x.result?.person?.name && !lowValue(x));
    const junk = pendingImports.filter((x) => !x.result?.person?.name).map((x) => x.id);
    if (junk.length) removePending(junk);
    if (!auto.length) return;
    let cur = storeRef.current;
    let updated = 0;
    for (const item of auto) {
      const r = applyAnalyzeResult(cur, item.result);
      cur = r.next;
      if (r.existingId) updated++;
    }
    save(cur);
    removePending(auto.map((x) => x.id));
    notify(`⚡ 自动入库 ${auto.length} 人${updated ? `（${updated} 人为更新）` : ""}`);
  }, [autoImport, pendingImports, save, notify, removePending]);

  // ── 攒批中的消息立即触发分析（不用等 4 分钟）──
  const flushIngest = useCallback(async () => {
    try {
      const r = await fetch("/api/network/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flush-all" }),
      });
      const d = await r.json();
      if (r.ok && d.flushed > 0) {
        notify(`已触发 ${d.flushed} 个联系人的分析`);
        window.setTimeout(() => { loadPending(); loadIngestStatus(); }, 2500);
      } else if (r.ok) {
        notify("没有在攒批的消息");
      }
    } catch { notify("服务未连接"); }
  }, [notify, loadPending, loadIngestStatus]);

  const orgOf = useCallback(
    (p: Person) => store.organizations.find((o) => o.id === p.orgId),
    [store.organizations],
  );

  // ── Actions ──

  const actions = useMemo(() => computeActions(store), [store]);

  const markContacted = useCallback((p: Person) => {
    const today = localToday();
    const interaction: Interaction = {
      id: `int-${Date.now()}`, personId: p.id, date: today, channel: "微信", summary: "主动联系",
    };
    const interval = p.stage === "深度合作" ? 14 : p.stage === "初步接触" ? 14 : 30;
    save({
      ...store,
      people: store.people.map((x) =>
        x.id === p.id ? { ...x, lastContactDate: today, nextFollowUpDate: localDatePlus(today, interval), updatedAt: today } : x,
      ),
      interactions: [...store.interactions, interaction],
    });
    notify(`已记录与 ${p.name} 的联系`);
  }, [store, save, notify]);

  const snooze = useCallback((p: Person, days: number) => {
    save({
      ...store,
      people: store.people.map((x) =>
        x.id === p.id ? { ...x, nextFollowUpDate: localDatePlus(localToday(), days), updatedAt: localToday() } : x,
      ),
    });
    notify(`已延后 ${days} 天`);
  }, [store, save, notify]);

  const copyScript = useCallback((p: Person) => {
    navigator.clipboard.writeText(generateScript(p, orgOf(p))).then(() => {
      setCopied(p.id);
      notify("话术已复制");
      window.setTimeout(() => setCopied(null), 2000);
    });
  }, [orgOf, notify]);

  const exportData = useCallback(() => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `network-backup-${localToday()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("数据已导出");
  }, [store, notify]);

  const importData = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result)) as NetworkStore;
          if (data.version === 4 && Array.isArray(data.people)) {
            save(data);
            notify("数据已导入");
          } else {
            notify("文件格式不对（需要 v4 备份）");
          }
        } catch { notify("文件解析失败"); }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [save, notify]);

  // ── 组织 AI 检索（自动补资料）──

  const researchSingleOrg = useCallback(async (o: Organization): Promise<Organization> => {
    const r = await fetch("/api/network/research-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: o.name }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "检索失败");
    const res = d.result as OrgResearch;
    if (!res?.found) {
      // 没找到也标记，避免批量时反复重试同一批
      return { ...o, notes: o.notes ?? "（联网检索未找到可靠资料，待手动补充）" };
    }
    return {
      ...o,
      notes: [
        res.summary,
        res.whatTheyDo ?? "",
        res.keyPoints.map((k) => `· ${k}`).join("\n"),
        res.officialUrl ? `官网：${res.officialUrl}` : "",
        res.businessMatch?.matchedBusiness
          ? `业务匹配：${res.businessMatch.matchedBusiness} — ${res.businessMatch.suggestion}`
          : "",
      ].filter(Boolean).join("\n"),
      defaultCooperation: o.defaultCooperation ?? res.cooperation ?? undefined,
    };
  }, []);

  const researchOneOrg = useCallback(async (o: Organization) => {
    if (orgBusyId || orgBatch) return;
    setOrgBusyId(o.id);
    try {
      const updated = await researchSingleOrg(o);
      save({ ...storeRef.current, organizations: storeRef.current.organizations.map((x) => (x.id === o.id ? updated : x)) });
      notify(updated.notes?.startsWith("（联网检索") ? `「${o.name}」未找到可靠资料` : `「${o.name}」资料已更新`);
    } catch {
      notify(`「${o.name}」检索失败`);
    } finally {
      setOrgBusyId(null);
    }
  }, [orgBusyId, orgBatch, researchSingleOrg, save, notify]);

  const runBatchOrgResearch = useCallback(async () => {
    const targets = storeRef.current.organizations.filter((o) => !o.notes);
    if (!targets.length) return;
    batchStopRef.current = false;
    let done = 0;
    let found = 0;
    for (const o of targets) {
      if (batchStopRef.current) break;
      setOrgBatch({ done, total: targets.length, current: o.name, found });
      try {
        const updated = await researchSingleOrg(o);
        if (!updated.notes?.startsWith("（联网检索")) found++;
        save({ ...storeRef.current, organizations: storeRef.current.organizations.map((x) => (x.id === o.id ? updated : x)) });
      } catch { /* 单个失败跳过，继续 */ }
      done++;
      setOrgBatch({ done, total: targets.length, current: o.name, found });
    }
    setOrgBatch(null);
    notify(batchStopRef.current ? "批量检索已停止" : `批量检索完成：${found}/${targets.length} 个组织找到资料`);
  }, [researchSingleOrg, save, notify]);

  const stopBatchOrgResearch = useCallback(() => {
    batchStopRef.current = true;
  }, []);

  // ── 添加人脉 ──

  const openAdd = useCallback((orgId?: string) => {
    setAddOrgPreselect(orgId);
    setAddOpen(true);
  }, []);

  // ── 数据 ──

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of store.people) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [store.people]);

  const filteredPeople = useMemo(() => {
    let list = store.people;
    if (stageFilter !== "全部") list = list.filter((p) => p.stage === stageFilter);
    if (tagFilter) list = list.filter((p) => p.tags.includes(tagFilter));
    if (orgFilter) list = list.filter((p) => p.orgId === orgFilter);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((p) => {
        const org = orgOf(p);
        return `${p.name} ${p.title ?? ""} ${p.tags.join(" ")} ${org?.name ?? ""} ${p.whatTheyDo ?? ""} ${p.notes ?? ""}`
          .toLowerCase().includes(q);
      });
    }
    return list;
  }, [store.people, stageFilter, tagFilter, orgFilter, query, orgOf]);

  const selected = useMemo(() => store.people.find((p) => p.id === selectedId) ?? null, [store.people, selectedId]);

  const peopleCountByOrg = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of store.people) if (p.orgId) m.set(p.orgId, (m.get(p.orgId) ?? 0) + 1);
    return m;
  }, [store.people]);

  const filteredOrgs = useMemo(() => {
    if (!query) return store.organizations;
    const q = query.toLowerCase();
    return store.organizations.filter((o) => o.name.toLowerCase().includes(q) || o.category.includes(q));
  }, [store.organizations, query]);

  // ── Render ──

  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-[600px] w-[600px] rounded-full bg-indigo-500/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-40 h-[500px] w-[500px] rounded-full bg-emerald-500/8 blur-[100px]" />
        <div className="absolute -bottom-20 left-1/3 h-[400px] w-[400px] rounded-full bg-amber-500/6 blur-[80px]" />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 py-6 md:px-8">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-white/40">
              <Network className="size-3.5" /> Network
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">人脉工作台</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={importData} className="text-white/60 hover:bg-white/10 hover:text-white" title="导入备份">
              <Upload className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={exportData} className="text-white/60 hover:bg-white/10 hover:text-white" title="导出备份">
              <Download className="size-4" />
            </Button>
            <Button size="sm" onClick={() => setHubOpen(true)} className="border-0 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30">
              <ScanText className="size-4" /> 快速导入
            </Button>
            <Button size="sm" onClick={() => openAdd()} className="border-0 bg-white/10 text-white hover:bg-white/20">
              <Plus className="size-4" /> 添加人脉
            </Button>
          </div>
        </header>

        {/* 微信自动入库：解释入口与当前服务状态 */}
        <section className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setIngestHelpOpen((v) => !v)} className="flex min-w-0 items-center gap-2 text-left">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-white/75">
                <MessageCircle className="size-4 shrink-0 text-emerald-300" />
                <span className="truncate">微信自动入库怎么工作？</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${ingestConnected === true ? "bg-emerald-500/15 text-emerald-300" : ingestConnected === false ? "bg-amber-500/15 text-amber-300" : "bg-white/10 text-white/40"}`}>
                  {ingestConnected === true ? "本地接口在线" : ingestConnected === false ? "接口未连接" : "检查中"}
                </span>
              </span>
              {ingestHelpOpen ? <ChevronUp className="size-4 shrink-0 text-white/40" /> : <ChevronDown className="size-4 shrink-0 text-white/40" />}
            </button>
            {/* 智能自动入库开关：打开后聊天/截图分析完直接入库，不用手点 */}
            <button
              onClick={toggleAutoImport}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${autoImport ? "bg-emerald-500/20 text-emerald-300" : "bg-white/5 text-white/40 hover:bg-white/10"}`}
              title={autoImport ? "已开启：有业务价值的人脉自动入库，纯闲聊留在待确认" : "关闭中：所有分析结果都停在待确认，需手动入库"}
            >
              <span className={`size-1.5 rounded-full ${autoImport ? "bg-emerald-400" : "bg-white/30"}`} />
              智能自动入库 {autoImport ? "已开启" : "已关闭"}
            </button>
          </div>
          {autoImport && (
            <p className="mt-2 text-[11px] text-emerald-300/60">已开启：微信聊天 / 截图 / 剪贴板分析完成后直接入库（同名自动合并），纯闲聊和无法判断的仍留在下方待确认。</p>
          )}
          {!autoImport && <p className="mt-2 text-xs text-white/40">它不会自动读取整部手机微信；只有被 Agent/助手实际送到本系统的消息，才会进入分析。</p>}
          {ingestHelpOpen && (
            <div className="mt-4 grid gap-3 text-xs text-white/60 md:grid-cols-3">
              <div className="rounded-lg bg-white/[0.04] p-3">
                <strong className="text-white/80">剪贴板 Agent</strong>
                <p className="mt-1 leading-5">你在微信中选中一段聊天并按 Cmd+C，它只读取这次复制的文本。没有主动复制，就不会读到任何聊天。</p>
              </div>
              <div className="rounded-lg bg-white/[0.04] p-3">
                <strong className="text-white/80">微信助手接口</strong>
                <p className="mt-1 leading-5">只接收助手账号实际收到、并 POST 到 <code className="text-emerald-300">/api/network/ingest</code> 的私聊文本；群聊、非文本和 # 指令默认跳过。</p>
              </div>
              <div className="rounded-lg bg-white/[0.04] p-3">
                <strong className="text-white/80">分析与入库</strong>
                <p className="mt-1 leading-5">同一联系人攒满 20 条，或 4 分钟没有新消息，才调用 AI。分析后先放在下方待确认，点击「入库」才会保存。</p>
              </div>
              <div className="md:col-span-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.05] p-3 leading-5 text-amber-100/70">
                没录入通常是因为：助手根本看不到那段聊天、消息被识别为群聊/指令、接口未推送、仍在 4 分钟攒批中、AI 分析失败，或你还没有点击「入库」。系统不会因为“聊过一次”就自动写入人脉库。
              </div>
              {ingestBuffers.length > 0 && (
                <div className="md:col-span-3 rounded-lg bg-indigo-500/[0.08] p-3 text-indigo-100/75">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-indigo-200">当前正在等待分析</div>
                    <button onClick={flushIngest} className="shrink-0 rounded-lg bg-indigo-500/25 px-2.5 py-1 text-[11px] text-indigo-100 transition-colors hover:bg-indigo-500/40">
                      立即分析（不等 4 分钟）
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">{ingestBuffers.map((b) => <span key={b.from} className="rounded-full bg-indigo-500/15 px-2 py-1">{b.from} · {b.count} 条</span>)}</div>
                </div>
              )}
              {ingestRecent.some((x) => !x.ok) && (
                <div className="md:col-span-3 text-amber-300/70">最近一次分析失败：{ingestRecent.find((x) => !x.ok)?.error ?? "请检查 Agent 日志和 API 配置"}</div>
              )}
              {ingestCheckedAt && <div className="md:col-span-3 text-[10px] text-white/25">状态检查：{new Date(ingestCheckedAt).toLocaleTimeString()}</div>}
            </div>
          )}
        </section>

        {/* Tabs */}
        <div className="mb-6 flex gap-1 rounded-xl bg-white/5 p-1 backdrop-blur-xl">
          {([
            { id: "actions" as Tab, label: "今日行动", icon: Sparkles, count: actions.length },
            { id: "people" as Tab, label: "人脉", icon: Users, count: store.people.length },
            { id: "orgs" as Tab, label: "组织", icon: Building2, count: store.organizations.length },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                tab === t.id ? "bg-white/10 text-white shadow-sm" : "text-white/50 hover:text-white/70"
              }`}
            >
              <t.icon className="size-3.5" />
              {t.label}
              <span className="text-xs text-white/30">{t.count}</span>
            </button>
          ))}
        </div>

        {/* ── 微信 Agent 待确认入库 ── */}
        {pendingImports.length > 0 && (
          <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-amber-300">
                <MessageCircle className="size-4" />
                微信助手转来 {pendingImports.length} 条人脉待确认
                {autoImport && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">自动入库开启中·这些是筛下来的低价值/待判断条目</span>}
              </span>
              <div className="flex gap-2">
                <Button size="sm" onClick={acceptAllPending} className="h-7 border-0 bg-amber-500/25 px-3 text-xs text-amber-100 hover:bg-amber-500/40">
                  <Check className="size-3" /> 全部入库
                </Button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {pendingImports.map((item) => {
                const r = item.result;
                const intentColor = INTENT_COLORS[r.intent?.category] ?? "#6b7280";
                const exists = store.people.some((p) => p.name === (r.person?.name ?? "").trim());
                return (
                  <div key={item.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{r.person?.name ?? "未知"}</span>
                          <span className="text-[10px] text-white/30">{item.source.replace("wechat-", "微信 · ")}</span>
                          {r.person?.title && <span className="text-xs text-white/40">{r.person.title}</span>}
                          {r.person?.org && <span className="text-xs text-white/40">· {r.person.org}</span>}
                          {r.intent?.category && (
                            <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: intentColor + "25", color: intentColor }}>
                              {r.intent.category}
                            </span>
                          )}
                          {exists && (
                            <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">已有 → 将更新</span>
                          )}
                        </div>
                        {item.meta?.messageCount && (
                          <p className="mt-1 text-[10px] text-white/30">本批 {item.meta.messageCount} 条 · {new Date(item.queuedAt).toLocaleString()}</p>
                        )}
                        {r.businessMatch?.matchedBusiness && (
                          <p className="mt-1 text-[11px] text-amber-200/70">🎯 {r.businessMatch.matchedBusiness}：{r.businessMatch.suggestion}</p>
                        )}
                        {r.ourMove?.suggestedReply && (
                          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/40">回复建议：{r.ourMove.suggestedReply}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => acceptPending(item)} className="h-7 px-2.5 text-xs text-amber-200 hover:bg-amber-500/20">
                          <Check className="size-3" /> 入库
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => removePending([item.id])} className="h-7 px-2.5 text-xs text-white/35 hover:bg-white/10 hover:text-white/70">
                          忽略
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 今日行动 ── */}
        {tab === "actions" && (
          <div className="space-y-5">
            {(["overdue", "today"] as const).map((u) => {
              const list = actions.filter((a) => a.urgency === u);
              if (!list.length) return null;
              return (
                <section key={u}>
                  <h2 className={`mb-3 flex items-center gap-2 text-sm font-medium ${u === "overdue" ? "text-red-400" : "text-amber-400"}`}>
                    <Calendar className="size-4" /> {u === "overdue" ? "已逾期" : "今天该联系"}
                  </h2>
                  <div className="space-y-2">
                    {list.map((a) => (
                      <ActionCard key={a.person.id} action={a} orgOf={orgOf} onContact={markContacted} onSnooze={snooze} onSelect={setSelectedId} onCopy={copyScript} copied={copied} />
                    ))}
                  </div>
                </section>
              );
            })}
            {actions.filter((a) => a.urgency === "soon").length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/60">
                  <ArrowRight className="size-4" /> 即将到期
                </h2>
                <div className="space-y-2">
                  {actions.filter((a) => a.urgency === "soon").slice(0, 5).map((a) => (
                    <ActionCard key={a.person.id} action={a} orgOf={orgOf} onContact={markContacted} onSnooze={snooze} onSelect={setSelectedId} onCopy={copyScript} copied={copied} />
                  ))}
                </div>
              </section>
            )}
            {actions.filter((a) => a.urgency === "suggested").length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/50">
                  <Sparkles className="size-4" /> 建议联系
                </h2>
                <div className="space-y-2">
                  {actions.filter((a) => a.urgency === "suggested").slice(0, 5).map((a) => (
                    <ActionCard key={a.person.id} action={a} orgOf={orgOf} onContact={markContacted} onSnooze={snooze} onSelect={setSelectedId} onCopy={copyScript} copied={copied} />
                  ))}
                </div>
              </section>
            )}
            {actions.length === 0 && (
              <EmptyState
                icon={Sparkles}
                title={store.people.length === 0 ? "先添加你的人脉" : "今天没有需要行动的人脉"}
                hint={store.people.length === 0
                  ? "你的人脉都在微信里，从组织页或右上角「添加人脉」把他们加进来"
                  : "去「人脉」页看看有没有可以推进的关系"}
                action={store.people.length === 0 ? { label: "添加第一个人脉", onClick: () => openAdd() } : undefined}
              />
            )}
          </div>
        )}

        {/* ── 人脉 ── */}
        {tab === "people" && (
          <div>
            <div className="mb-4 space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 size-4 text-white/30" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索姓名、组织、标签…"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-white outline-none backdrop-blur-xl placeholder-white/30 focus:border-white/20"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {(["全部", "潜在", "初步接触", "深度合作", "暂停"] as const).map((s) => (
                  <FilterButton key={s} active={stageFilter === s} onClick={() => setStageFilter(s as ContactStage | "全部")}>
                    {s}
                  </FilterButton>
                ))}
              </div>
              {allTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Tag className="size-3.5 text-white/30" />
                  {allTags.slice(0, 12).map(([t, n]) => (
                    <FilterButton key={t} active={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)}>
                      {t} <span className="ml-0.5 text-xs opacity-50">{n}</span>
                    </FilterButton>
                  ))}
                </div>
              )}
              {orgFilter && (
                <div className="flex items-center gap-2 text-xs text-white/40">
                  组织筛选：
                  <span className="rounded-md bg-white/10 px-2 py-1 text-white/70">
                    {store.organizations.find((o) => o.id === orgFilter)?.name}
                  </span>
                  <button onClick={() => setOrgFilter(null)} className="text-white/40 hover:text-white"><X className="size-3.5" /></button>
                </div>
              )}
            </div>
            <div className="space-y-2">
              {filteredPeople.map((p) => (
                <PersonRow key={p.id} person={p} org={orgOf(p)} onSelect={setSelectedId} />
              ))}
              {filteredPeople.length === 0 && (
                <EmptyState
                  icon={Users}
                  title={store.people.length === 0 ? "还没有人脉" : "没有匹配的人脉"}
                  hint={store.people.length === 0 ? "从微信通讯录里，把你想盘活的人一个个加进来" : "换个筛选条件试试"}
                  action={store.people.length === 0 ? { label: "添加人脉", onClick: () => openAdd() } : undefined}
                />
              )}
            </div>
          </div>
        )}

        {/* ── 组织 ── */}
        {tab === "orgs" && (
          <div>
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 size-4 text-white/30" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索组织…"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-white outline-none backdrop-blur-xl placeholder-white/30 focus:border-white/20"
                />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <p className="text-xs text-white/30">组织是你能触达的渠道，点击组织把里面的人加进来</p>
                {orgBatch ? (
                  <div className="flex items-center gap-2 rounded-lg bg-violet-500/15 px-2.5 py-1">
                    <span className="size-3 animate-spin rounded-full border-2 border-violet-300/30 border-t-violet-300" />
                    <span className="text-xs text-violet-200">
                      正在检索「{orgBatch.current}」{orgBatch.done}/{orgBatch.total}（找到 {orgBatch.found}）
                    </span>
                    <button onClick={stopBatchOrgResearch} className="text-xs text-white/40 hover:text-white">停止</button>
                  </div>
                ) : (
                  store.organizations.filter((o) => !o.notes).length > 0 && (
                    <button
                      onClick={runBatchOrgResearch}
                      disabled={!!orgBusyId}
                      className="flex items-center gap-1 rounded-lg bg-violet-500/20 px-2.5 py-1 text-xs text-violet-200 transition-colors hover:bg-violet-500/30 disabled:opacity-40"
                    >
                      <Sparkles className="size-3" />
                      AI 批量补资料（{store.organizations.filter((o) => !o.notes).length} 个待补）
                    </button>
                  )
                )}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {filteredOrgs.map((o) => {
                const count = peopleCountByOrg.get(o.id) ?? 0;
                const researching = orgBusyId === o.id;
                return (
                  <div
                    key={o.id}
                    className="group rounded-xl border border-white/5 bg-white/[0.03] p-3 backdrop-blur-xl transition-all hover:border-white/10 hover:bg-white/[0.06]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button onClick={() => { setOrgFilter(o.id); setTab("people"); setQuery(""); }} className="min-w-0 flex-1 text-left">
                        <span className="text-sm font-medium leading-5">{o.name}</span>
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-white/40">
                          <span className="inline-block size-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[o.category] }} />
                          {o.category}
                        </div>
                        <div className="mt-1 text-xs text-white/30">
                          {count > 0 ? `${count} 位联系人` : "还没添加人"}
                        </div>
                        {o.notes && <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-white/35">{o.notes}</p>}
                      </button>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ backgroundColor: STAGE_COLORS[o.stage] + "20", color: STAGE_COLORS[o.stage] }}
                        >
                          {o.stage}
                        </span>
                        <button
                          onClick={() => researchOneOrg(o)}
                          disabled={researching || !!orgBatch}
                          title="AI 联网检索这个组织的资料"
                          className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40 opacity-0 transition-all hover:bg-white/10 hover:text-white group-hover:opacity-100 disabled:opacity-60"
                        >
                          {researching ? (
                            <span className="size-2.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                          ) : (
                            <Sparkles className="size-2.5" />
                          )}
                          {researching ? "检索中" : o.notes ? "重新检索" : "AI 检索"}
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => openAdd(o.id)}
                      className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-white/5 py-1.5 text-xs text-white/50 opacity-0 transition-all hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    >
                      <Plus className="size-3" /> 添加此人脉
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 添加人脉弹窗 ── */}
        {addOpen && (
          <AddPersonModal
            store={store}
            preselectOrgId={addOrgPreselect}
            onClose={() => setAddOpen(false)}
            onSave={(p, newOrg) => {
              save({
                ...store,
                people: [...store.people, p],
                organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
              });
              setAddOpen(false);
              setSelectedId(p.id);
              notify(newOrg ? `已添加 ${p.name}，新组织「${newOrg.name}」已入库` : `已添加 ${p.name}`);
            }}
          />
        )}

        {/* ── 导入中心 ── */}
        {hubOpen && (
          <ImportHubModal
            onClose={() => setHubOpen(false)}
            onOpen={(kind) => {
              setHubOpen(false);
              if (kind === "ocr") setOcrOpen(true);
              else if (kind === "file") setFileOpen(true);
              else if (kind === "voice") setVoiceOpen(true);
              else if (kind === "chat") { setChatInitialText(undefined); setChatOpen(true); }
              else if (kind === "batch") { setBatchInitialText(undefined); setBatchOpen(true); }
            }}
          />
        )}

        {/* ── 截图识别导入 ── */}
        {ocrOpen && (
          <OcrImportModal
            store={store}
            onClose={() => setOcrOpen(false)}
            onChatText={(text) => { setOcrOpen(false); setChatInitialText(text); setChatOpen(true); }}
            onSave={(p, newOrg) => {
              save({
                ...store,
                people: [...store.people, p],
                organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
              });
              setOcrOpen(false);
              setSelectedId(p.id);
              notify(newOrg ? `已导入 ${p.name}，新组织「${newOrg.name}」已入库` : `已导入 ${p.name}`);
            }}
          />
        )}

        {/* ── 口述录入 ── */}
        {voiceOpen && (
          <VoiceImportModal
            store={store}
            onClose={() => setVoiceOpen(false)}
            onChatText={(text) => { setVoiceOpen(false); setChatInitialText(text); setChatOpen(true); }}
            onBatchText={(text) => { setVoiceOpen(false); setBatchInitialText(text); setBatchOpen(true); }}
            onSave={(p, newOrg) => {
              save({
                ...store,
                people: [...store.people, p],
                organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
              });
              setVoiceOpen(false);
              setSelectedId(p.id);
              notify(newOrg ? `已录入 ${p.name}，新组织「${newOrg.name}」已入库` : `已录入 ${p.name}`);
            }}
          />
        )}

        {/* ── 通讯录 / 表格文件导入 ── */}
        {fileOpen && (
          <FileImportModal
            store={store}
            onClose={() => setFileOpen(false)}
            onSave={(people, newOrgs) => {
              save({
                ...store,
                people: [...store.people, ...people],
                organizations: newOrgs.length ? [...store.organizations, ...newOrgs] : store.organizations,
              });
              setFileOpen(false);
              notify(`已导入 ${people.length} 位人脉${newOrgs.length ? `，${newOrgs.length} 个新组织入库` : ""}`);
            }}
            onTextFile={(text) => { setFileOpen(false); setBatchInitialText(text); setBatchOpen(true); }}
          />
        )}

        {/* ── 批量录入弹窗 ── */}
        {batchOpen && (
          <BatchAddModal
            store={store}
            initialText={batchInitialText}
            onClose={() => { setBatchOpen(false); setBatchInitialText(undefined); }}
            onSave={(people, newOrgs) => {
              save({
                ...store,
                people: [...store.people, ...people],
                organizations: newOrgs.length ? [...store.organizations, ...newOrgs] : store.organizations,
              });
              setBatchOpen(false);
              notify(`已批量录入 ${people.length} 位人脉${newOrgs.length ? `，${newOrgs.length} 个新组织入库` : ""}`);
            }}
          />
        )}

        {/* ── 粘贴聊天记录弹窗 ── */}
        {chatOpen && (
          <ImportChatModal
            store={store}
            initialText={chatInitialText}
            onClose={() => { setChatOpen(false); setChatInitialText(undefined); }}
            onSave={(person, interaction, newOrg, existingId) => {
              if (existingId) {
                // 更新已有的人
                save({
                  ...store,
                  people: store.people.map((x) => (x.id === existingId ? person : x)),
                  organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
                  interactions: [...store.interactions, interaction],
                });
                notify(`已更新 ${person.name} 的资料`);
              } else {
                save({
                  ...store,
                  people: [...store.people, person],
                  organizations: newOrg ? [...store.organizations, newOrg] : store.organizations,
                  interactions: [...store.interactions, interaction],
                });
                notify(newOrg ? `已导入 ${person.name}，新组织「${newOrg.name}」已入库` : `已导入 ${person.name}`);
              }
              setChatOpen(false);
              setSelectedId(person.id);
            }}
          />
        )}

        {/* ── 详情抽屉 ── */}
        {selected && (
          <PersonDrawer
            key={selected.id}
            person={selected}
            org={orgOf(selected)}
            store={store}
            onClose={() => setSelectedId(null)}
            onSave={(p) => {
              save({ ...store, people: store.people.map((x) => (x.id === p.id ? p : x)) });
            }}
            onContact={markContacted}
            onSnooze={snooze}
            onCopy={copyScript}
            copied={copied === selected.id}
          />
        )}

        {/* Toast */}
        {toast && (
          <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm text-white shadow-xl backdrop-blur-xl">
            {toast}
          </div>
        )}
      </div>
    </main>
  );
}

// ─── 添加人脉弹窗（一句话 → AI 解析）───

type ParseResult = {
  name: string;
  org: string | null;
  orgCategory: string | null;
  title: string | null;
  tags: string[];
  whatTheyDo: string | null;
  howMet: string | null;
  city: string | null;
  cooperation: string | null;
};

function AddPersonModal({
  store, preselectOrgId, onClose, onSave,
}: {
  store: NetworkStore;
  preselectOrgId?: string;
  onClose: () => void;
  onSave: (p: Person, newOrg?: Organization) => void;
}) {
  const [desc, setDesc] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(preselectOrgId ?? "");
  const [newOrgName, setNewOrgName] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [customTag, setCustomTag] = useState("");
  const [wechat, setWechat] = useState("");
  const [howMet, setHowMet] = useState("");
  const [whatTheyDo, setWhatTheyDo] = useState("");
  const [stage, setStage] = useState<ContactStage>("潜在");

  const canSave = name.trim().length > 0;
  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const runParse = async () => {
    if (!desc.trim()) return;
    setParsing(true);
    setParseError("");
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parse", text: desc.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "解析失败");
      const res = d.result as ParseResult;
      setParsed(res);
      // AI 解析结果直接填进表单，用户可继续改
      if (res.name) setName(res.name);
      if (res.title) setTitle(res.title);
      if (res.tags?.length) setTags(res.tags);
      if (res.whatTheyDo) setWhatTheyDo(res.whatTheyDo);
      if (res.howMet) setHowMet(res.howMet);
      // 组织匹配：库里已有 → 选中；没有 → 记下新组织名
      if (res.org) {
        const existingOrg = store.organizations.find(
          (o) => o.name === res.org || o.name.includes(res.org!) || res.org!.includes(o.name),
        );
        if (existingOrg) setOrgId(existingOrg.id);
        else setNewOrgName(res.org);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setParsing(false);
    }
  };

  const submit = () => {
    if (!canSave) return;
    // 新组织一起入库
    let newOrg: Organization | undefined;
    const trimmedNewOrg = newOrgName.trim();
    if (trimmedNewOrg && !orgId) {
      const dup = store.organizations.find(
        (o) => o.name === trimmedNewOrg || o.name.includes(trimmedNewOrg) || trimmedNewOrg.includes(o.name),
      );
      if (dup) {
        newOrg = undefined;
        onSave({
          id: `p-${Date.now()}`,
          name: name.trim(),
          orgId: dup.id,
          title: title.trim() || undefined,
          tags,
          wechat: wechat.trim() || undefined,
          howMet: howMet.trim() || undefined,
          stage,
          priority: "medium",
          createdAt: localToday(),
          updatedAt: localToday(),
        });
        return;
      }
      newOrg = {
        id: `org-${Date.now()}`,
        name: trimmedNewOrg,
        category: (parsed?.orgCategory && CATEGORIES.includes(parsed.orgCategory as ContactCategory)
          ? parsed.orgCategory
          : "AI builder 社群") as ContactCategory,
        stage: "潜在",
        notes: parsed ? `AI 从一句话描述识别 · ${desc.trim()}` : undefined,
        defaultCooperation: parsed?.cooperation ?? undefined,
      };
    }
    const existingOrg = store.organizations.find((o) => o.id === orgId);
    onSave(
      {
        id: `p-${Date.now()}`,
        name: name.trim(),
        orgId: orgId || newOrg?.id,
        title: title.trim() || undefined,
        tags,
        wechat: wechat.trim() || undefined,
        howMet: howMet.trim() || undefined,
        whatTheyDo: whatTheyDo.trim() || undefined,
        cooperation: parsed?.cooperation ?? existingOrg?.defaultCooperation,
        stage,
        priority: "medium",
        createdAt: localToday(),
        updatedAt: localToday(),
      },
      newOrg,
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">添加人脉</h3>
        <p className="mb-4 text-xs text-white/40">一句话描述，AI 帮你填好表单；也可以直接手动填</p>

        {/* 一句话智能输入 */}
        <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.05] p-3">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
            placeholder={"如：张三，极客公园的记者，上周在AI大会上认识，聊得不错"}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/25 focus:border-white/20"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-white/25">{parsed ? "已解析 ✓ 表单已填好，可修改" : "AI 自动识别姓名、组织、职位、标签"}</span>
            <Button
              size="sm"
              onClick={runParse}
              disabled={!desc.trim() || parsing}
              className="h-7 border-0 bg-indigo-500/30 px-3 text-xs text-indigo-100 hover:bg-indigo-500/50 disabled:opacity-30"
            >
              {parsing ? (
                <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              AI 识别
            </Button>
          </div>
          {parseError && <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{parseError}</p>}
        </div>

        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="姓名 / 昵称 *"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={orgId}
              onChange={(e) => { setOrgId(e.target.value); if (e.target.value) setNewOrgName(""); }}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/20 [&>option]:bg-[#111116]"
            >
              <option value="">{newOrgName.trim() ? `新建：${newOrgName.trim()}` : "无组织（独立个人）"}</option>
              {store.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <input
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="新组织名（可选）"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
            />
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="职位 / 身份"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
          />
          <input
            value={whatTheyDo}
            onChange={(e) => setWhatTheyDo(e.target.value)}
            placeholder="他是干嘛的（AI 可识别）"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium text-white/40">他是干嘛的（可多选）</label>
            <div className="flex flex-wrap gap-1.5">
              {TAG_SUGGESTIONS.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleTag(t)}
                  className={`rounded-lg px-2 py-1 text-xs transition-all ${
                    tags.includes(t) ? "bg-indigo-500/30 text-indigo-200" : "bg-white/5 text-white/40 hover:bg-white/10"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                placeholder="自定义标签"
                className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs outline-none placeholder-white/30 focus:border-white/20"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customTag.trim()) {
                    e.preventDefault();
                    if (!tags.includes(customTag.trim())) setTags([...tags, customTag.trim()]);
                    setCustomTag("");
                  }
                }}
              />
              {tags.filter((t) => !TAG_SUGGESTIONS.includes(t)).map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-lg bg-indigo-500/30 px-2 py-1 text-xs text-indigo-200">
                  {t}
                  <button onClick={() => setTags(tags.filter((x) => x !== t))}><X className="size-3" /></button>
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              value={wechat}
              onChange={(e) => setWechat(e.target.value)}
              placeholder="微信号（可选）"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
            />
            <input
              value={howMet}
              onChange={(e) => setHowMet(e.target.value)}
              placeholder="怎么认识的（AI 可识别）"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-white/40">阶段</label>
            <div className="flex gap-1.5">
              {(["潜在", "初步接触", "深度合作", "暂停"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStage(s)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                    stage === s ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:bg-white/10"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="ghost" onClick={onClose} className="flex-1 text-white/50 hover:bg-white/10 hover:text-white">取消</Button>
          <Button onClick={submit} disabled={!canSave} className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20 disabled:opacity-30">添加</Button>
        </div>
      </div>
    </div>
  );
}

// ─── 批量录入弹窗（每行一个人 → AI 批量解析 + 价值判断）───

type BatchParsed = {
  name: string;
  org: string | null;
  orgCategory: string | null;
  title: string | null;
  tags: string[];
  whatTheyDo: string | null;
  howMet: string | null;
  cooperation: string | null;
  priority: "high" | "medium" | "low";
  stage: "潜在" | "初步接触";
  reason: string;
};

const PRIORITY_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  high: { bg: "rgba(52,211,153,0.15)", text: "#34d399", label: "值得录入" },
  medium: { bg: "rgba(96,165,250,0.15)", text: "#60a5fa", label: "可以录入" },
  low: { bg: "rgba(148,163,184,0.15)", text: "#94a3b8", label: "价值待定" },
};

function BatchAddModal({
  store, initialText, onClose, onSave,
}: {
  store: NetworkStore;
  initialText?: string;
  onClose: () => void;
  onSave: (people: Person[], newOrgs: Organization[]) => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<(BatchParsed & { checked: boolean; exists: boolean })[]>([]);

  const runParse = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setError("");
    setItems([]);
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parse-batch", text: text.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "解析失败");
      const list = (d.result?.people ?? []) as BatchParsed[];
      if (!list.length) throw new Error("没识别出任何人，检查一下格式（每行一个人）");
      setItems(
        list
          .filter((x) => x?.name?.trim())
          .map((x) => {
            const exists = store.people.some((p) => p.name === x.name.trim());
            return { ...x, name: x.name.trim(), checked: !exists, exists };
          }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setParsing(false);
    }
  };

  const submit = () => {
    const today = localToday();
    const newOrgs: Organization[] = [];
    const orgIdByParsedName = new Map<string, string>();
    const people: Person[] = items
      .filter((x) => x.checked)
      .map((x, idx) => {
        let orgId: string | undefined;
        const orgName = (x.org ?? "").trim();
        if (orgName) {
          const existingOrg = store.organizations.find(
            (o) => o.name === orgName || o.name.includes(orgName) || orgName.includes(o.name),
          );
          if (existingOrg) {
            orgId = existingOrg.id;
          } else if (orgIdByParsedName.has(orgName)) {
            orgId = orgIdByParsedName.get(orgName)!;
          } else {
            const newOrg: Organization = {
              id: `org-${Date.now()}-${newOrgs.length}`,
              name: orgName,
              category: (x.orgCategory && CATEGORIES.includes(x.orgCategory as ContactCategory)
                ? x.orgCategory
                : "AI builder 社群") as ContactCategory,
              stage: "潜在",
              notes: undefined,
              defaultCooperation: x.cooperation ?? undefined,
            };
            newOrgs.push(newOrg);
            orgIdByParsedName.set(orgName, newOrg.id);
            orgId = newOrg.id;
          }
        }
        return {
          id: `p-${Date.now()}-${idx}`,
          name: x.name,
          orgId,
          title: x.title ?? undefined,
          tags: x.tags ?? [],
          whatTheyDo: x.whatTheyDo ?? undefined,
          howMet: x.howMet ?? undefined,
          cooperation: x.cooperation ?? undefined,
          notes: x.reason ? `录入判断：${x.reason}` : undefined,
          stage: x.stage === "初步接触" ? "初步接触" : "潜在",
          priority: (["high", "medium", "low"].includes(x.priority) ? x.priority : "medium") as Priority,
          createdAt: today,
          updatedAt: today,
        } as Person;
      });
    onSave(people, newOrgs);
  };

  const checkedCount = items.filter((x) => x.checked).length;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-semibold">批量录入人脉</h3>
        <p className="mb-4 text-xs text-white/40">每行一个人，一句话描述就行，AI 批量识别并判断录入价值</p>

        {/* 录入标准 */}
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-5 text-white/50">
          <p className="mb-1 font-medium text-white/70">该不该录？不用纠结，按这三条：</p>
          <p>· <span className="text-emerald-300">聊过具体的事</span>（合作、需求、能互相帮上忙）→ 值得，AI 会标为「初步接触」</p>
          <p>· <span className="text-sky-300">同行业、六个月内大概率再碰到</span> → 值得，标为「潜在」</p>
          <p>· <span className="text-white/40">只是寒暄/换微信/混脸熟</span> → 可以不录。组织已经在库里了，等真聊了再录</p>
        </div>

        {!items.length ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"每行一个人，例如：\n\n张伟，WaytoAGI的内容运营，上个月杭州AI聚会认识的\n李娜，Datawhale主理人，聊过课程共建\n小王，某创业公司的技术，活动上加的微信"}
              className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/25 focus:border-white/20"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end">
              <span className="text-xs text-white/25">{text.split("\n").filter((l) => l.trim()).length} 行</span>
            </div>
            {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={onClose} className="flex-1 text-white/50 hover:bg-white/10 hover:text-white">取消</Button>
              <Button
                onClick={runParse}
                disabled={!text.trim() || parsing}
                className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              >
                {parsing ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    AI 批量识别中…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" /> AI 识别
                  </>
                )}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-white/40">
                识别出 {items.length} 人 · 已选 {checkedCount} 人入库（点击卡片可取消）
              </p>
              <button onClick={() => setItems(items.map((x) => ({ ...x, checked: !x.checked })))} className="text-xs text-white/40 hover:text-white">
                全选/全不选
              </button>
            </div>
            <div className="space-y-2">
              {items.map((x, i) => {
                const badge = PRIORITY_BADGE[x.priority] ?? PRIORITY_BADGE.medium;
                return (
                  <button
                    key={i}
                    onClick={() => setItems(items.map((y, j) => (j === i ? { ...y, checked: !y.checked } : y)))}
                    className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                      x.checked ? "border-white/15 bg-white/[0.05]" : "border-white/5 bg-white/[0.02] opacity-50"
                    }`}
                  >
                    <div className="flex size-5 shrink-0 items-center justify-center rounded-md border" style={{
                      borderColor: x.checked ? "#6366f1" : "rgba(255,255,255,0.15)",
                      backgroundColor: x.checked ? "#6366f1" : "transparent",
                    }}>
                      {x.checked && <Check className="size-3.5 text-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{x.name}</span>
                        {x.exists && (
                          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">人脉库已有（默认跳过）</span>
                        )}
                        <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ backgroundColor: badge.bg, color: badge.text }}>
                          {badge.label} · {x.stage}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-white/40">
                        {[x.title, x.org].filter(Boolean).join(" · ") || "身份未知"}
                        {x.howMet ? ` · ${x.howMet}` : ""}
                      </p>
                      {x.reason && <p className="mt-1 text-[11px] leading-4 text-white/35">{x.reason}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
            {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setItems([])} className="text-white/50 hover:bg-white/10 hover:text-white">重新粘贴</Button>
              <Button onClick={submit} disabled={!checkedCount} className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20 disabled:opacity-30">
                <Check className="size-4" /> 保存 {checkedCount} 人入库
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 人脉详情抽屉（可编辑）───

function PersonDrawer({
  person: initial, org, store, onClose, onSave, onContact, onSnooze, onCopy, copied,
}: {
  person: Person;
  org?: Organization;
  store: NetworkStore;
  onClose: () => void;
  onSave: (p: Person) => void;
  onContact: (p: Person) => void;
  onSnooze: (p: Person, days: number) => void;
  onCopy: (p: Person) => void;
  copied: boolean;
}) {
  const [p, setP] = useState<Person>(initial);
  const [draft, setDraft] = useState<Person>(initial);
  const [editing, setEditing] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [editingField, setEditingField] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<"" | "suggest" | "script">("");
  const [aiHint, setAiHint] = useState("");
  const [guideBusy, setGuideBusy] = useState(false);
  const [guide, setGuide] = useState<{ questions?: string[]; focus?: string } | null>(null);
  const orgColor = org ? CATEGORY_COLORS[org.category] : "#6366f1";

  useEffect(() => {
    setP(initial);
    setDraft(initial);
    setEditing(false);
    setEditingField(null);
  }, [initial.id]);

  const update = (patch: Partial<Person>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const commitPatch = (patch: Partial<Person>) => {
    const next = { ...p, ...patch, updatedAt: localToday() };
    setP(next);
    setDraft(next);
    onSave(next);
  };

  const saveChanges = () => {
    const next = { ...draft, updatedAt: localToday(), name: draft.name.trim() || p.name };
    setP(next);
    setDraft(next);
    setEditing(false);
    setEditingField(null);
    onSave(next);
  };

  const cancelChanges = () => {
    setDraft(p);
    setEditing(false);
    setEditingField(null);
  };

  // AI 引导式追问：针对空缺维度生成下一步该问什么/回忆什么
  const runGuideQuestions = async () => {
    setGuideBusy(true);
    setGuide(null);
    try {
      const dims = GUIDE_DIMS.map((d) => ({
        ...d,
        filled: d.field === "tags" ? p.tags.length > 0 : Boolean(((p[d.field] as string | undefined) ?? "").trim()),
      }));
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "questions",
          person: {
            name: p.name, title: p.title, tags: p.tags, whatTheyDo: p.whatTheyDo,
            whatTheyWant: p.whatTheyWant, whatWeWant: p.whatWeWant, cooperation: p.cooperation,
            howMet: p.howMet, city: p.city, stage: p.stage,
          },
          org: org ? { name: org.name, category: org.category } : null,
          missing: dims.filter((d) => !d.filled).map((d) => d.label),
          interactions: ints.map((i) => ({ date: i.date, summary: i.summary })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "生成失败");
      setGuide(d.result as { questions?: string[]; focus?: string });
    } catch (e) {
      setAiHint(e instanceof Error ? e.message : "生成失败");
    } finally {
      setGuideBusy(false);
    }
  };

  const days = daysSince(p.lastContactDate);
  const ints = store.interactions.filter((i) => i.personId === p.id);

  // AI 补全：根据组织+身份生成 whatWeWant / cooperation / 优先级 / 跟进节奏
  const runSuggest = async () => {
    setAiBusy("suggest");
    setAiHint("");
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "suggest",
          person: { name: p.name, title: p.title, tags: p.tags, whatTheyDo: p.whatTheyDo, stage: p.stage, cooperation: p.cooperation },
          org: org ? { name: org.name, category: org.category, notes: org.notes?.slice(0, 500) } : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "AI 补全失败");
      const s = d.result as { whatWeWant?: string; cooperation?: string; priority?: string; followUpDays?: number; reason?: string };
      commitPatch({
        whatWeWant: p.whatWeWant || s.whatWeWant || undefined,
        cooperation: p.cooperation || s.cooperation || undefined,
        priority: (["high", "medium", "low"].includes(s.priority ?? "") ? s.priority : p.priority) as Priority,
        nextFollowUpDate: p.nextFollowUpDate || (s.followUpDays ? localDatePlus(localToday(), Math.max(3, Number(s.followUpDays) || 14)) : undefined),
      });
      setAiHint(s.reason ?? "已补全");
    } catch (e) {
      setAiHint(e instanceof Error ? e.message : "AI 补全失败");
    } finally {
      setAiBusy("");
    }
  };

  // AI 定制话术：结合业务能力 + 历史互动生成微信消息
  const runScript = async () => {
    setAiBusy("script");
    setAiHint("");
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "script",
          person: { name: p.name, title: p.title, tags: p.tags, whatTheyDo: p.whatTheyDo, whatWeWant: p.whatWeWant, cooperation: p.cooperation, stage: p.stage, lastContactDate: p.lastContactDate },
          org: org ? { name: org.name, category: org.category, defaultCooperation: org.defaultCooperation } : null,
          interactions: ints.map((i) => ({ date: i.date, summary: i.summary })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "话术生成失败");
      const s = d.result as { script?: string; angle?: string };
      if (s.script) commitPatch({ aiReply: s.script });
      setAiHint(s.angle ? `切入角度：${s.angle}` : "已生成");
    } catch (e) {
      setAiHint(e instanceof Error ? e.message : "话术生成失败");
    } finally {
      setAiBusy("");
    }
  };

  const EditableField = ({ field, label, placeholder, multiline }: { field: keyof Person; label: string; placeholder: string; multiline?: boolean }) => {
    const value = (draft[field] as string) ?? "";
    const active = editing || editingField === field;
    return (
      <div>
        <label className="text-xs font-medium text-white/40">{label}</label>
        {active ? (
          multiline ? (
            <textarea
              value={value}
              autoFocus={editingField === field}
              rows={2}
              onChange={(e) => update({ [field]: e.target.value } as Partial<Person>)}
              onFocus={() => setEditingField(field)}
              className="mt-1 w-full resize-none rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
            />
          ) : (
            <input
              value={value}
              autoFocus={editingField === field}
              onChange={(e) => update({ [field]: e.target.value } as Partial<Person>)}
              onFocus={() => setEditingField(field)}
              onKeyDown={(e) => e.key === "Enter" && !multiline && setEditingField(null)}
              className="mt-1 w-full rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
            />
          )
        ) : (
          <button onClick={() => { setEditing(true); setEditingField(field); }} className="mt-1 w-full rounded-xl bg-white/[0.04] px-3 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/[0.08]">
            {value || <span className="text-white/25">{placeholder}</span>}
          </button>
        )}
      </div>
    );
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-30 w-full max-w-md overflow-y-auto border-l border-white/10 bg-[#111116]/95 p-6 shadow-2xl backdrop-blur-2xl">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-xl text-lg font-semibold" style={{ backgroundColor: orgColor + "20", color: orgColor }}>
            {p.name.charAt(0)}
          </div>
          <div>
            <h2 className="text-xl font-semibold">{p.name}</h2>
            <p className="text-sm text-white/40">
              {p.title ? `${p.title}` : ""}
              {org ? `${p.title ? " · " : ""}${org.name}` : p.title ? "" : "独立个人"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!editing ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="text-xs text-white/50 hover:bg-white/10 hover:text-white">
              编辑资料
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={cancelChanges} className="text-xs text-white/50 hover:bg-white/10 hover:text-white">取消</Button>
              <Button size="sm" onClick={saveChanges} className="border-0 bg-indigo-500/25 text-xs text-indigo-100 hover:bg-indigo-500/40">保存修改</Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white/40 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </Button>
        </div>
      </div>

      {/* 基本资料 */}
      <div className="mt-4 space-y-3">
        <EditableField field="name" label="姓名 / 昵称" placeholder="点击填写" />
        <div className="grid grid-cols-2 gap-2">
          <EditableField field="title" label="职位 / 身份" placeholder="点击填写" />
          <EditableField field="city" label="城市" placeholder="点击填写" />
        </div>
      </div>

      {/* 标签 */}
      <div className="mt-4">
        <div className="flex flex-wrap gap-1.5">
          {draft.tags.map((t) => (
            <span key={t} className="group flex items-center gap-1 rounded-lg bg-indigo-500/20 px-2 py-1 text-xs text-indigo-200">
              {t}
              {editing && <button onClick={() => update({ tags: draft.tags.filter((x) => x !== t) })} className="opacity-40 hover:opacity-100">
                <X className="size-3" />
              </button>}
            </span>
          ))}
          <div className="flex items-center gap-1">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              disabled={!editing}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTag.trim()) {
                  if (!draft.tags.includes(newTag.trim())) update({ tags: [...draft.tags, newTag.trim()] });
                  setNewTag("");
                }
              }}
              placeholder={editing ? "+ 标签" : "点击编辑后添加"}
              className="w-28 rounded-lg bg-white/5 px-2 py-1 text-xs outline-none placeholder-white/25 focus:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </div>
      </div>

      {/* 阶段 */}
      <div className="mt-5">
        <label className="text-xs font-medium text-white/40">阶段</label>
        <div className="mt-1.5 flex gap-1.5">
          {(["潜在", "初步接触", "深度合作", "暂停"] as const).map((s) => (
            <button
              key={s}
              onClick={() => editing && update({ stage: s })}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                draft.stage === s ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:bg-white/10"
              } ${!editing ? "cursor-default opacity-70" : ""}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* AI 结果提示 */}
      {aiHint && !aiBusy && (
        <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2 text-xs text-indigo-200/80">
          {aiHint}
        </div>
      )}

      {/* 详细信息（点击即编辑 + AI 补全） */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs font-medium text-white/40">详细信息</label>
          <button
            onClick={runSuggest}
            disabled={!!aiBusy}
            className="flex items-center gap-1 rounded-lg bg-indigo-500/20 px-2 py-1 text-[11px] text-indigo-200 transition-colors hover:bg-indigo-500/30 disabled:opacity-40"
          >
            {aiBusy === "suggest" ? (
              <span className="size-3 animate-spin rounded-full border-2 border-indigo-300/30 border-t-indigo-300" />
            ) : (
              <Sparkles className="size-3" />
            )}
            AI 补全建议
          </button>
        </div>
        <div className="space-y-3">
          <EditableField field="whatTheyDo" label="他是干嘛的" placeholder="点击填写，或用 AI 补全" multiline />
          <EditableField field="whatWeWant" label="我想从他这得到什么" placeholder="点击填写，或用 AI 补全" multiline />
          <EditableField field="whatTheyWant" label="他想要什么" placeholder="点击填写" multiline />
          <EditableField field="cooperation" label="合作方向" placeholder="点击填写，或用 AI 补全" multiline />
          <EditableField field="howMet" label="怎么认识的" placeholder="点击填写" />
          <EditableField field="wechat" label="微信" placeholder="点击填写" />
          <EditableField field="notes" label="备注" placeholder="点击填写" multiline />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-white/40">优先级</label>
              <select
                value={draft.priority}
                disabled={!editing}
                onChange={(e) => update({ priority: e.target.value as Priority })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none disabled:opacity-60 [&>option]:bg-[#111116]"
              >
                <option value="high">高</option>
                <option value="medium">中</option>
                <option value="low">低</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-white/40">下次跟进</label>
              <input
                type="date"
                value={draft.nextFollowUpDate ?? ""}
                disabled={!editing}
                onChange={(e) => update({ nextFollowUpDate: e.target.value || undefined })}
                className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none disabled:opacity-60"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 档案完整度 + AI 引导追问（防止漏掉关键信息） */}
      <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
        {(() => {
          const dims = GUIDE_DIMS.map((d) => ({
            ...d,
            filled: d.field === "tags" ? p.tags.length > 0 : Boolean(((p[d.field] as string | undefined) ?? "").trim()),
          }));
          const done = dims.filter((d) => d.filled).length;
          return (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-white/40">档案完整度 {done}/{dims.length}</span>
                <button
                  onClick={runGuideQuestions}
                  disabled={guideBusy}
                  className="flex items-center gap-1 rounded-lg bg-fuchsia-500/20 px-2 py-1 text-[11px] text-fuchsia-200 transition-colors hover:bg-fuchsia-500/30 disabled:opacity-40"
                >
                  {guideBusy ? <span className="size-3 animate-spin rounded-full border-2 border-fuchsia-300/30 border-t-fuchsia-300" /> : <Sparkles className="size-3" />}
                  AI 给我列追问
                </button>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-500/60 to-emerald-400/80 transition-all" style={{ width: `${Math.round((done / dims.length) * 100)}%` }} />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {dims.map((d) => (
                  <button
                    key={d.field}
                    onClick={() => { setEditing(true); setEditingField(d.field === "tags" ? null : d.field); }}
                    className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${d.filled ? "bg-emerald-500/15 text-emerald-300/80" : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/60"}`}
                  >
                    {d.filled ? "✓ " : ""}{d.label}
                  </button>
                ))}
              </div>
              {guide && (
                <div className="mt-3 space-y-1.5 border-t border-white/5 pt-3">
                  {guide.focus && <p className="text-[11px] font-medium text-fuchsia-200/80">📌 {guide.focus}</p>}
                  {(guide.questions ?? []).map((q, i) => (
                    <p key={i} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs leading-5 text-white/60">{i + 1}. {q}</p>
                  ))}
                  <p className="text-[10px] text-white/25">下次聊之前看一眼；答案点上方对应的灰色标签直接补进去</p>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* 链接画像 */}
      <div className="mt-5">
        <LinkEnrichCard
          context={[p.name, p.title, org?.name].filter(Boolean).join(" ")}
          onMerge={(info, url) => {
            const blocks: string[] = [`🔗 ${url}`, info.summary];
            if (info.keyPoints.length) blocks.push(...info.keyPoints.map((k) => `· ${k}`));
            const addition = blocks.join("\n");
            commitPatch({
              notes: p.notes ? `${p.notes}\n\n${addition}` : addition,
              whatTheyDo: p.whatTheyDo || info.org.whatTheyDo || info.person.background || undefined,
              cooperation: p.cooperation || info.cooperation || undefined,
              title: p.title || info.person.title || undefined,
            });
          }}
        />
      </div>

      {/* 联系状态 */}
      <div className="mt-5">
        <label className="text-xs font-medium text-white/40">联系状态</label>
        <p className="mt-1 text-sm">
          {p.lastContactDate ? `${days} 天前联系过` : "还没联系过"}
        </p>
        {p.nextFollowUpDate && (
          <p className="mt-0.5 text-xs text-white/30">下次跟进：{p.nextFollowUpDate}</p>
        )}
      </div>

      {/* 话术 */}
      <div className="mt-5">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-white/40">
            建议话术{p.aiReply ? " · AI 定制" : ""}
          </label>
          <button
            onClick={runScript}
            disabled={!!aiBusy}
            className="flex items-center gap-1 rounded-lg bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/30 disabled:opacity-40"
          >
            {aiBusy === "script" ? (
              <span className="size-3 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {p.aiReply ? "重新生成" : "AI 定制话术"}
          </button>
        </div>
        <div className="mt-1.5 rounded-xl bg-white/[0.04] p-3 text-xs leading-5 text-white/60">
          {generateScript(p, org)}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onCopy(p)} className="mt-2 h-7 px-2 text-xs text-white/50 hover:bg-white/10 hover:text-white">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          <span className="ml-1">{copied ? "已复制" : "复制话术"}</span>
        </Button>
      </div>

      {/* 互动历史 */}
      {ints.length > 0 && (
        <div className="mt-5">
          <label className="text-xs font-medium text-white/40">互动记录（{ints.length}）</label>
          <div className="mt-1.5 space-y-2">
            {ints.slice(-5).reverse().map((i) => (
              <div key={i.id} className="rounded-lg bg-white/[0.04] p-2.5 text-xs">
                <div className="flex justify-between text-white/30">
                  <span>{i.date}</span>
                  <span>{i.channel}</span>
                </div>
                <p className="mt-1 text-white/60">{i.summary}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 操作 */}
      <div className="mt-6 flex gap-2 pb-4">
        <Button onClick={() => onContact(p)} className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20">
          <MessageCircle className="size-4" /> 已联系
        </Button>
        <Button variant="ghost" onClick={() => onSnooze(p, 7)} className="text-white/50 hover:bg-white/10 hover:text-white">
          延后7天
        </Button>
      </div>
    </aside>
  );
}

// ─── 链接画像：抓取 URL 丰富上下文 ───

type EnrichResult = {
  org: { name: string | null; whatTheyDo: string | null; relevance: string | null };
  person: { title: string | null; background: string | null; recentWork: string | null };
  keyPoints: string[];
  businessMatch: { matchedBusiness: string | null; reason: string; suggestion: string } | null;
  cooperation: string | null;
  summary: string;
};

async function enrichUrl(url: string, context: string): Promise<EnrichResult> {
  const r = await fetch("/api/network/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, context }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "抓取失败");
  return d.result as EnrichResult;
}

function LinkEnrichCard({
  context, onMerge,
}: {
  context: string;
  onMerge: (info: EnrichResult, url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ result: EnrichResult; url: string } | null>(null);

  const run = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    setInfo(null);
    try {
      const result = await enrichUrl(url.trim(), context);
      setInfo({ result, url: url.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "抓取失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="text-xs font-medium text-white/40">链接画像</label>
      <p className="mt-0.5 text-[11px] text-white/25">贴他的主页/文章/组织官网，AI 抓取后补充上下文</p>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="https://…"
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none placeholder-white/25 focus:border-white/20"
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={run}
          disabled={busy || !url.trim()}
          className="h-8 shrink-0 px-2.5 text-xs text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"
        >
          {busy ? (
            <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          抓取
        </Button>
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
      {info && (
        <div className="mt-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-3">
          <p className="text-xs leading-5 text-white/75">{info.result.summary}</p>
          {info.result.keyPoints.length > 0 && (
            <ul className="mt-2 space-y-1">
              {info.result.keyPoints.map((k, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-4 text-white/50">
                  <span className="text-sky-300/60">·</span>
                  {k}
                </li>
              ))}
            </ul>
          )}
          {info.result.businessMatch?.matchedBusiness && (
            <div className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5">
              <p className="text-[11px] text-amber-300">🎯 业务匹配：{info.result.businessMatch.matchedBusiness}</p>
              <p className="mt-0.5 text-[11px] text-white/60">{info.result.businessMatch.suggestion}</p>
            </div>
          )}
          {info.result.cooperation && (
            <p className="mt-2 text-[11px] leading-4 text-sky-200/80">合作切入：{info.result.cooperation}</p>
          )}
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => onMerge(info.result, info.url)} className="h-7 px-2 text-xs text-sky-300 hover:bg-white/10">
              <Check className="size-3" /> 并入资料
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigator.clipboard.writeText(`${info.result.summary}\n${info.result.keyPoints.map((k) => `· ${k}`).join("\n")}`)}
              className="h-7 px-2 text-xs text-white/40 hover:bg-white/10 hover:text-white"
            >
              <Copy className="size-3" /> 复制
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 粘贴聊天记录导入（仿 crush-monitor：手动粘贴 → AI 结构化解析）───

type AnalyzeResult = {
  person: {
    name: string;
    title: string | null;
    org: string | null;
    wechat: string | null;
    tags: string[];
    whatTheyDo: string | null;
    whatTheyWant: string | null;
  };
  intent: { category: string; confidence: number; evidence: string };
  businessMatch: { matchedBusiness: string | null; reason: string; suggestion: string } | null;
  ourMove: { suggestedReply: string; cooperation: string | null; nextAction: string | null; stage: string };
  summary: string;
};

const INTENT_COLORS: Record<string, string> = {
  "活动合作": "#f59e0b",
  "内容合作": "#e36d8a",
  "商务商单": "#34d399",
  "技术合作": "#3b82f6",
  "资源对接": "#8b5cf6",
  "咨询请教": "#60a5fa",
  "闲聊维护": "#94a3b8",
  "无明显意向": "#6b7280",
};

type OrgResearch = {
  found: boolean;
  officialUrl: string | null;
  category: string;
  whatTheyDo: string | null;
  keyPoints: string[];
  businessMatch: { matchedBusiness: string | null; reason: string; suggestion: string } | null;
  cooperation: string | null;
  confidence: number;
  summary: string;
  sources: string[];
};

function ImportChatModal({
  store, initialText, onClose, onSave,
}: {
  store: NetworkStore;
  initialText?: string;
  onClose: () => void;
  onSave: (person: Person, interaction: Interaction, newOrg?: Organization, existingId?: string) => void;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkInfo, setLinkInfo] = useState<{ result: EnrichResult; url: string } | null>(null);
  const [linkError, setLinkError] = useState("");
  const [orgResearch, setOrgResearch] = useState<{ orgName: string; status: "running" | "done" | "failed"; data?: OrgResearch } | null>(null);

  const isNewOrg = useCallback((orgName: string | null | undefined): boolean => {
    const n = (orgName ?? "").trim();
    if (!n) return false;
    return !store.organizations.some((o) => o.name.includes(n) || n.includes(o.name));
  }, [store.organizations]);

  // 自动匹配已存在的人：粘贴的聊天如果是老朋友，更新而不是重复添加
  const existing = useMemo(() => {
    if (!result?.person?.name) return null;
    const n = result.person.name.trim();
    if (!n || n.length < 2) return null; // 单字匹配太模糊，跳过
    return store.people.find((x) => x.name === n) ?? null;
  }, [result, store.people]);

  const researchOrg = useCallback((orgName: string, context: string) => {
    setOrgResearch({ orgName, status: "running" });
    fetch("/api/network/research-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: orgName, context }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "检索失败");
        setOrgResearch({ orgName, status: "done", data: d.result as OrgResearch });
      })
      .catch(() => setOrgResearch({ orgName, status: "failed" }));
  }, []);

  const analyze = async () => {
    if (!text.trim()) return;
    setAnalyzing(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/network/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (!r.ok) setError(d.error ?? "分析失败");
      else {
        setResult(d.result as AnalyzeResult);
        // 发现新组织：自动联网检索组织资料
        const orgName = (d.result.person?.org ?? "").trim();
        if (isNewOrg(orgName)) {
          researchOrg(orgName, [d.result.person?.whatTheyDo, d.result.person?.whatTheyWant].filter(Boolean).join(" "));
        } else {
          setOrgResearch(null);
        }
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setAnalyzing(false);
    }
  };

  const save = () => {
    if (!result) return;
    const org = store.organizations.find(
      (o) => o.name === (result.person.org ?? "").trim() || o.name.includes((result.person.org ?? "\u0000").trim()),
    );
    // 新组织自动入库（带检索到的资料）
    let newOrg: Organization | undefined;
    if (!org && orgResearch && orgResearch.status === "done" && isNewOrg(orgResearch.orgName)) {
      const d = orgResearch.data!;
      newOrg = {
        id: `org-${Date.now()}`,
        name: orgResearch.orgName,
        category: d.category as ContactCategory,
        stage: "潜在",
        notes: d.found
          ? [d.summary, d.whatTheyDo ?? "", d.keyPoints.map((k) => `· ${k}`).join("\n"), d.officialUrl ? `官网：${d.officialUrl}` : "", d.sources.length ? `检索来源：${d.sources.join("、")}` : ""].filter(Boolean).join("\n")
          : "联网检索未找到可靠资料，待手动补充",
        defaultCooperation: d.cooperation ?? undefined,
      };
    }

    // ── 已存在的人：合并更新（不重复添加）──
    if (existing) {
      const today = localToday();
      const aiStage = (["潜在", "初步接触", "深度合作"].includes(result.ourMove.stage) ? result.ourMove.stage : null) as ContactStage | null;
      const stageRank: Record<string, number> = { "潜在": 0, "初步接触": 1, "深度合作": 2 };
      const nextStage = aiStage && stageRank[aiStage] > stageRank[existing.stage] ? aiStage : existing.stage;
      const interval = nextStage === "深度合作" ? 14 : nextStage === "初步接触" ? 14 : 30;
      const merged: Person = {
        ...existing,
        orgId: existing.orgId ?? newOrg?.id ?? org?.id,
        title: existing.title ?? result.person.title ?? linkInfo?.result.person.title ?? undefined,
        tags: [...new Set([...existing.tags, ...(result.person.tags ?? [])])],
        wechat: existing.wechat ?? result.person.wechat ?? undefined,
        whatTheyDo: existing.whatTheyDo ?? result.person.whatTheyDo ?? undefined,
        whatTheyWant: existing.whatTheyWant ?? result.person.whatTheyWant ?? undefined,
        cooperation: existing.cooperation ?? result.ourMove.cooperation ?? undefined,
        notes: [
          existing.notes,
          linkInfo ? `🔗 ${linkInfo.url}\n${linkInfo.result.summary}` : null,
        ].filter(Boolean).join("\n\n") || undefined,
        aiReply: result.ourMove.suggestedReply,
        stage: nextStage,
        lastContactDate: today,
        nextFollowUpDate: localDatePlus(today, interval),
        updatedAt: today,
      };
      const interaction: Interaction = {
        id: `int-${Date.now()}`,
        personId: existing.id,
        date: today,
        channel: "微信",
        summary: result.summary,
        nextAction: result.ourMove.nextAction ?? undefined,
      };
      onSave(merged, interaction, newOrg, existing.id);
      return;
    }

    // ── 新人：创建 ──
    const person: Person = {
      id: `p-${Date.now()}`,
      name: result.person.name || "未命名",
      orgId: newOrg?.id ?? org?.id,
      title: result.person.title ?? linkInfo?.result.person.title ?? undefined,
      tags: result.person.tags ?? [],
      wechat: result.person.wechat ?? undefined,
      whatTheyDo: result.person.whatTheyDo ?? linkInfo?.result.org.whatTheyDo ?? undefined,
      whatTheyWant: result.person.whatTheyWant ?? undefined,
      cooperation: result.ourMove.cooperation ?? linkInfo?.result.cooperation ?? undefined,
      notes: [
        `来源：聊天记录导入 · ${result.summary}`,
        linkInfo
          ? `🔗 ${linkInfo.url}\n${linkInfo.result.summary}${linkInfo.result.keyPoints.length ? "\n" + linkInfo.result.keyPoints.map((k) => `· ${k}`).join("\n") : ""}`
          : null,
      ].filter(Boolean).join("\n\n"),
      aiReply: result.ourMove.suggestedReply,
      stage: (["潜在", "初步接触", "深度合作"].includes(result.ourMove.stage) ? result.ourMove.stage : "初步接触") as ContactStage,
      priority: "medium",
      createdAt: localToday(),
      updatedAt: localToday(),
    };
    const interaction: Interaction = {
      id: `int-${Date.now()}`,
      personId: person.id,
      date: localToday(),
      channel: "微信",
      summary: result.summary,
      nextAction: result.ourMove.nextAction ?? undefined,
    };
    onSave(person, interaction, newOrg);
  };

  const runLink = async () => {
    if (!linkUrl.trim() || !result) return;
    setLinkBusy(true);
    setLinkError("");
    try {
      const r = await enrichUrl(
        linkUrl.trim(),
        [result.person.name, result.person.org].filter(Boolean).join(" "),
      );
      setLinkInfo({ result: r, url: linkUrl.trim() });
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "抓取失败");
    } finally {
      setLinkBusy(false);
    }
  };

  const intentColor = result ? INTENT_COLORS[result.intent.category] ?? "#6b7280" : "#6b7280";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {!result ? (
          <>
            <h3 className="mb-1 text-lg font-semibold">粘贴聊天记录</h3>
            <p className="mb-4 text-xs text-white/40">从微信多选消息复制，直接粘贴进来。AI 自动识别对方是谁、想要什么、怎么回。</p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={"示例（微信复制格式）：\n\n张三\n2026-09-20 14:32\n你好，我们下个月有个开发者活动，想邀请你们参与\n\n我\n2026-09-20 14:40\n好啊，具体什么形式？"}
              className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/25 focus:border-white/20"
              autoFocus
            />
            <div className="mt-3 flex items-center justify-end">
              <span className="text-xs text-white/25">{text.length} 字</span>
            </div>
            {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
            <div className="mt-5 flex gap-2">
              <Button variant="ghost" onClick={onClose} className="flex-1 text-white/50 hover:bg-white/10 hover:text-white">取消</Button>
              <Button
                onClick={analyze}
                disabled={!text.trim() || analyzing}
                className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20 disabled:opacity-30"
              >
                {analyzing ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    AI 分析中（约 10-60 秒）
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" /> 分析
                  </>
                )}
              </Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-1 text-lg font-semibold">识别结果</h3>
            <p className="mb-4 text-xs text-white/40">确认无误后保存，信息都可以改</p>

            {/* 已存在的人：更新而非重复添加 */}
            {existing && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2">
                <Check className="size-3.5 shrink-0 text-emerald-300" />
                <p className="text-xs text-emerald-200/90">
                  人脉库里已有「{existing.name}」— 本次保存会<b>更新他的资料</b>（合并新信息、记录这次互动、刷新建议回复），不会重复添加
                </p>
              </div>
            )}

            {/* 人脉预览 */}
            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-xl bg-indigo-500/20 text-lg font-semibold text-indigo-300">
                  {result.person.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold">{result.person.name}</div>
                  <div className="truncate text-xs text-white/40">
                    {[result.person.title, result.person.org].filter(Boolean).join(" · ") || "身份/组织未知"}
                  </div>
                </div>
                <div
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium"
                  style={{ backgroundColor: intentColor + "25", color: intentColor }}
                  title={`置信度 ${(result.intent.confidence * 100).toFixed(0)}%`}
                >
                  {result.intent.category}
                </div>
              </div>
              {result.person.tags.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {result.person.tags.map((t) => (
                    <span key={t} className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-200">{t}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 space-y-1.5 text-xs leading-5 text-white/60">
                {result.person.whatTheyDo && <p><span className="text-white/35">做什么：</span>{result.person.whatTheyDo}</p>}
                {result.person.whatTheyWant && <p><span className="text-white/35">他想要：</span>{result.person.whatTheyWant}</p>}
                <p><span className="text-white/35">判断依据：</span>{result.intent.evidence}</p>
              </div>
            </div>

            {/* 业务能力匹配 */}
            {result.businessMatch?.matchedBusiness && (
              <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-3.5 text-amber-300" />
                  <span className="text-xs font-medium text-amber-300">业务匹配 · {result.businessMatch.matchedBusiness}</span>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-white/75">{result.businessMatch.suggestion}</p>
                <p className="mt-1 text-[11px] text-amber-200/60">匹配理由：{result.businessMatch.reason}</p>
              </div>
            )}

            {/* 新组织自动检索 */}
            {orgResearch && (
              <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
                {orgResearch.status === "running" ? (
                  <p className="flex items-center gap-2 text-xs text-violet-200/80">
                    <span className="size-3 animate-spin rounded-full border-2 border-violet-300/30 border-t-violet-300" />
                    发现新组织「{orgResearch.orgName}」，正在联网检索资料…
                  </p>
                ) : orgResearch.status === "done" && orgResearch.data?.found ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-violet-300">
                        新组织「{orgResearch.orgName}」· 检索完成（保存时自动入库）
                      </span>
                      <span className="shrink-0 rounded-full bg-violet-500/25 px-2 py-0.5 text-[10px] text-violet-200">
                        {orgResearch.data.category}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-white/70">{orgResearch.data.whatTheyDo}</p>
                    {orgResearch.data.keyPoints.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {orgResearch.data.keyPoints.slice(0, 3).map((k, i) => (
                          <li key={i} className="flex gap-1.5 text-[11px] leading-4 text-white/45">
                            <span className="text-violet-300/60">·</span>{k}
                          </li>
                        ))}
                      </ul>
                    )}
                    {orgResearch.data.businessMatch?.matchedBusiness && (
                      <div className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5">
                        <p className="text-[11px] text-amber-300">🎯 业务匹配：{orgResearch.data.businessMatch.matchedBusiness}</p>
                        <p className="mt-0.5 text-[11px] text-white/60">{orgResearch.data.businessMatch.suggestion}</p>
                      </div>
                    )}
                    {orgResearch.data.cooperation && (
                      <p className="mt-1.5 text-[11px] text-violet-200/70">合作切入：{orgResearch.data.cooperation}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-white/40">
                    「{orgResearch.orgName}」是新组织，联网检索未找到可靠资料。保存时会先入组织库，资料以后手动补。
                  </p>
                )}
              </div>
            )}

            {/* 补充链接，丰富画像 */}
            <div className="mt-3">
              <div className="flex gap-1.5">
                <input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runLink()}
                  placeholder="有他的主页/文章/组织官网？贴链接补充上下文（可选）"
                  className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none placeholder-white/25 focus:border-white/20"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={runLink}
                  disabled={linkBusy || !linkUrl.trim()}
                  className="h-8 shrink-0 px-2.5 text-xs text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"
                >
                  {linkBusy ? (
                    <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  抓取
                </Button>
              </div>
              {linkError && <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{linkError}</p>}
              {linkInfo && (
                <div className="mt-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-3">
                  <p className="text-xs leading-5 text-white/75">{linkInfo.result.summary}</p>
                  {linkInfo.result.keyPoints.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {linkInfo.result.keyPoints.map((k, i) => (
                        <li key={i} className="flex gap-1.5 text-[11px] leading-4 text-white/50">
                          <span className="text-sky-300/60">·</span>
                          {k}
                        </li>
                      ))}
                    </ul>
                  )}
                  {linkInfo.result.businessMatch?.matchedBusiness && (
                    <div className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5">
                      <p className="text-[11px] text-amber-300">🎯 业务匹配：{linkInfo.result.businessMatch.matchedBusiness}</p>
                      <p className="mt-0.5 text-[11px] text-white/60">{linkInfo.result.businessMatch.suggestion}</p>
                    </div>
                  )}
                  <p className="mt-1.5 text-[11px] text-sky-200/60">保存时自动并入资料</p>
                </div>
              )}
            </div>

            {/* 建议回复 */}
            <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-emerald-300">建议回复（保存后可在详情页复制）</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(result.ourMove.suggestedReply); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  className="flex items-center gap-1 text-xs text-white/40 hover:text-white"
                >
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />} 复制
                </button>
              </div>
              <p className="text-sm leading-6 text-white/80">{result.ourMove.suggestedReply}</p>
              {result.ourMove.nextAction && (
                <p className="mt-2 text-xs text-emerald-200/60">下一步：{result.ourMove.nextAction}</p>
              )}
            </div>

            <div className="mt-5 flex gap-2">
              <Button variant="ghost" onClick={() => { setResult(null); setOrgResearch(null); }} className="text-white/50 hover:bg-white/10 hover:text-white">重新分析</Button>
              <Button onClick={save} className="flex-1 border-0 bg-white/10 text-white hover:bg-white/20">
                <Check className="size-4" /> 保存到人脉库
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 通用小组件 ───

function PersonRow({ person: p, org, onSelect }: { person: Person; org?: Organization; onSelect: (id: string) => void }) {
  const days = daysSince(p.lastContactDate);
  const orgColor = org ? CATEGORY_COLORS[org.category] : "#6366f1";
  return (
    <button
      onClick={() => onSelect(p.id)}
      className="flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3 text-left backdrop-blur-xl transition-all hover:border-white/10 hover:bg-white/[0.06]"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold" style={{ backgroundColor: orgColor + "20", color: orgColor }}>
        {p.name.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{p.name}</span>
          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: STAGE_COLORS[p.stage] + "20", color: STAGE_COLORS[p.stage] }}>
            {p.stage}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-white/40">
          {p.title && <span className="truncate">{p.title}</span>}
          {org && <span className="truncate">· {org.name}</span>}
          {days !== null && (
            <span className={days > 30 ? "shrink-0 text-red-400/70" : days > 14 ? "shrink-0 text-amber-400/70" : "shrink-0"}>
              · {days}天前
            </span>
          )}
        </div>
        {p.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {p.tags.slice(0, 4).map((t) => (
              <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/40">{t}</span>
            ))}
          </div>
        )}
      </div>
      <ChevronDown className="size-4 shrink-0 -rotate-90 text-white/20" />
    </button>
  );
}

function ActionCard({
  action, orgOf, onContact, onSnooze, onSelect, onCopy, copied,
}: {
  action: ActionItem;
  orgOf: (p: Person) => Organization | undefined;
  onContact: (p: Person) => void;
  onSnooze: (p: Person, days: number) => void;
  onSelect: (id: string) => void;
  onCopy: (p: Person) => void;
  copied: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = action.person;
  const org = orgOf(p);
  const orgColor = org ? CATEGORY_COLORS[org.category] : "#6366f1";

  const urgencyStyles: Record<Urgency, string> = {
    overdue: "border-red-500/20 bg-red-500/[0.05]",
    today: "border-amber-500/20 bg-amber-500/[0.05]",
    soon: "border-white/5 bg-white/[0.03]",
    suggested: "border-white/5 bg-white/[0.03]",
  };

  return (
    <div className={`rounded-xl border backdrop-blur-xl transition-all ${urgencyStyles[action.urgency]}`}>
      <div className="flex items-center gap-3 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold" style={{ backgroundColor: orgColor + "20", color: orgColor }}>
          {p.name.charAt(0)}
        </div>
        <button onClick={() => onSelect(p.id)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{p.name}</span>
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: STAGE_COLORS[p.stage] + "20", color: STAGE_COLORS[p.stage] }}>
              {p.stage}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-white/40">
            {action.reason}
            {p.title || org ? ` · ${[p.title, org?.name].filter(Boolean).join(" · ")}` : ""}
          </div>
        </button>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} className="h-8 w-8 p-0 text-white/40 hover:bg-white/10 hover:text-white" title="展开话术">
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onContact(p)} className="h-8 w-8 p-0 text-white/50 hover:bg-white/10 hover:text-white" title="标记已联系">
            <Check className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSnooze(p, 7)} className="h-8 px-2 text-white/50 hover:bg-white/10 hover:text-white">
            延后
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-white/5 px-3 pb-3 pt-2">
          <div className="rounded-lg bg-white/[0.04] p-3 text-xs leading-5 text-white/60">
            {generateScript(p, org)}
          </div>
          <Button size="sm" variant="ghost" onClick={() => onCopy(p)} className="mt-2 h-7 px-2 text-xs text-white/50 hover:bg-white/10 hover:text-white">
            {copied === p.id ? <Check className="size-3" /> : <Copy className="size-3" />}
            <span className="ml-1">{copied === p.id ? "已复制" : "复制话术"}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
        active ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon: Icon, title, hint, action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-white/[0.03] py-16 backdrop-blur-xl">
      <Icon className="mb-3 size-8 text-white/20" />
      <p className="text-sm text-white/40">{title}</p>
      <p className="mt-1 max-w-xs text-center text-xs text-white/25">{hint}</p>
      {action && (
        <Button size="sm" onClick={action.onClick} className="mt-4 border-0 bg-white/10 text-white hover:bg-white/20">
          <Plus className="size-3.5" /> {action.label}
        </Button>
      )}
    </div>
  );
}

// ─── 导入中心：所有快速入库方式的统一入口 ───

function ImportHubModal({
  onClose, onOpen,
}: {
  onClose: () => void;
  onOpen: (kind: "voice" | "ocr" | "chat" | "file" | "batch") => void;
}) {
  const cards: Array<{ kind: "voice" | "ocr" | "chat" | "file" | "batch"; icon: React.ComponentType<{ className?: string }>; title: string; desc: string; badge?: string; accent: string; wide?: boolean }> = [
    { kind: "voice", icon: Mic, title: "口述录入", desc: "按住说话就行：「今天见了XX公司的李总，想聊活动合作」——AI 自动建档、打标签、给合作建议", badge: "最快", accent: "text-fuchsia-300 bg-fuchsia-500/15", wide: true },
    { kind: "ocr", icon: Camera, title: "截图识别", desc: "微信名片/资料页/聊天截图粘贴进来，本地 OCR，图片不上传", badge: "新", accent: "text-emerald-300 bg-emerald-500/15" },
    { kind: "chat", icon: MessageCircle, title: "粘贴聊天记录", desc: "复制一段微信聊天，AI 提取人脉、意图、合作建议", accent: "text-indigo-300 bg-indigo-500/15" },
    { kind: "file", icon: FileUp, title: "通讯录 / 名单表", desc: "Mac 通讯录 .vcf、飞书/Excel .csv 名单，一次导入一批", accent: "text-sky-300 bg-sky-500/15" },
    { kind: "batch", icon: Users, title: "批量描述", desc: "每行一个人，AI 批量解析并判断录入价值", accent: "text-amber-300 bg-amber-500/15" },
  ];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">快速导入人脉</h3>
            <p className="mt-0.5 text-xs text-white/40">五种方式，识别后都可以改再保存</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white/40 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {cards.map((c) => (
            <button
              key={c.kind}
              onClick={() => onOpen(c.kind)}
              className={`group rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-all hover:border-white/20 hover:bg-white/[0.06] ${c.wide ? "col-span-2" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className={`flex size-9 items-center justify-center rounded-lg ${c.accent}`}>
                  <c.icon className="size-4.5" />
                </span>
                {c.badge && <span className="rounded-full bg-fuchsia-500/20 px-1.5 py-0.5 text-[10px] text-fuchsia-300">{c.badge}</span>}
              </div>
              <p className="mt-2.5 text-sm font-medium">{c.title}</p>
              <p className="mt-1 text-[11px] leading-4 text-white/35">{c.desc}</p>
            </button>
          ))}
        </div>
        <p className="mt-4 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] leading-4 text-white/30">
          自动化：微信新私聊自动分析入库（iLink 桥，扫码授权后免操作）；微信里 Cmd+C 复制聊天也会被后台 Agent 识别。
        </p>
      </div>
    </div>
  );
}

// ─── 截图识别导入：粘贴/拖入图片 → 本地 OCR → 按聊天或名片解析 ───

type CardParsed = {
  name: string;
  org: string | null;
  orgCategory: string | null;
  title: string | null;
  wechat: string | null;
  city: string | null;
  tags: string[];
  whatTheyDo: string | null;
  howMet?: string | null;
  cooperation: string | null;
};

function OcrImportModal({
  store, onClose, onChatText, onSave,
}: {
  store: NetworkStore;
  onClose: () => void;
  onChatText: (text: string) => void;
  onSave: (p: Person, newOrg?: Organization) => void;
}) {
  const [image, setImage] = useState<string | null>(null); // dataUrl
  const [ocrBusy, setOcrBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"" | "card">("");
  const [cardBusy, setCardBusy] = useState(false);
  const [card, setCard] = useState<CardParsed | null>(null);
  const [newOrgName, setNewOrgName] = useState("");

  const loadFile = (file: File) => {
    if (!file.type.startsWith("image/")) { setError("请放图片文件（png/jpg）"); return; }
    if (file.size > 10 * 1024 * 1024) { setError("图片太大（上限 10MB）"); return; }
    setError("");
    setCard(null);
    setMode("");
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setImage(dataUrl);
      runOcr(dataUrl); // 放进来就自动识别，少点一次按钮
    };
    reader.readAsDataURL(file);
  };

  const runOcr = async (dataUrlParam?: string) => {
    const dataUrl = dataUrlParam ?? image;
    if (!dataUrl) return;
    setOcrBusy(true);
    setError("");
    try {
      const r = await fetch("/api/network/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "识别失败");
      setText(d.text as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "识别失败");
    } finally {
      setOcrBusy(false);
    }
  };

  const parseCard = async () => {
    if (!text.trim()) return;
    setCardBusy(true);
    setError("");
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parse-card", text: text.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "解析失败");
      const res = d.result as CardParsed;
      if (!res?.name?.trim()) throw new Error("没解析出姓名，检查截图内容");
      setCard(res);
      setMode("card");
      const orgName = (res.org ?? "").trim();
      if (orgName && !store.organizations.some((o) => o.name.includes(orgName) || orgName.includes(o.name))) {
        setNewOrgName(orgName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setCardBusy(false);
    }
  };

  const saveCard = () => {
    if (!card?.name.trim()) return;
    const orgName = newOrgName.trim();
    let org = store.organizations.find((o) => o.name === orgName || o.name.includes(orgName) || orgName.includes(o.name));
    let newOrg: Organization | undefined;
    if (orgName && !org) {
      newOrg = {
        id: `org-${Date.now()}`,
        name: orgName,
        category: (card.orgCategory && CATEGORIES.includes(card.orgCategory as ContactCategory) ? card.orgCategory : "AI builder 社群") as ContactCategory,
        stage: "潜在",
        notes: "来源：截图识别导入（可用组织页「AI 检索」补资料）",
      };
    }
    const today = localToday();
    onSave({
      id: `p-${Date.now()}`,
      name: card.name.trim(),
      orgId: newOrg?.id ?? org?.id,
      title: card.title ?? undefined,
      tags: card.tags ?? [],
      wechat: card.wechat ?? undefined,
      city: card.city ?? undefined,
      whatTheyDo: card.whatTheyDo ?? undefined,
      cooperation: card.cooperation ?? undefined,
      notes: `来源：截图识别导入 · ${today}`,
      stage: "初步接触",
      priority: "medium",
      createdAt: today,
      updatedAt: today,
    }, newOrg);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onPaste={(e) => {
          const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/"));
          if (f) { e.preventDefault(); loadFile(f); }
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">截图识别导入</h3>
            <p className="mt-0.5 text-xs text-white/40">在微信里截图（名片页/资料页/聊天），这里直接 ⌘V 粘贴</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white/40 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </Button>
        </div>

        {/* 图片放置区 */}
        {!image && (
          <label
            className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] py-10 transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/[0.04]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); }}
          >
            <Camera className="size-7 text-white/25" />
            <p className="mt-2 text-sm text-white/50">粘贴、拖入截图，或点击选择</p>
            <p className="mt-1 text-[11px] text-white/25">本地识别，图片不会上传</p>
            <input type="file" accept="image/png,image/jpeg,image/heic,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
          </label>
        )}

        {image && (
          <div className="mt-4">
            <div className="relative overflow-hidden rounded-xl border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="待识别截图" className="max-h-56 w-full object-contain" />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <button onClick={() => { setImage(null); setText(""); setCard(null); setMode(""); }} className="text-xs text-white/40 hover:text-white">
                换一张
              </button>
              <Button size="sm" onClick={() => runOcr()} disabled={ocrBusy} className="h-8 border-0 bg-emerald-500/25 px-3 text-xs text-emerald-100 hover:bg-emerald-500/40 disabled:opacity-40">
                {ocrBusy ? <span className="size-3 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" /> : <ScanText className="size-3.5" />}
                {text ? "重新识别" : "识别文字"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        {/* OCR 结果：可修的文本 + 两种解析方式 */}
        {text && mode !== "card" && (
          <div className="mt-4">
            <label className="text-xs font-medium text-white/40">识别结果（可修正错字）</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/20"
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => onChatText(text)} className="flex-1 border-0 bg-indigo-500/25 text-xs text-indigo-100 hover:bg-indigo-500/40">
                <MessageCircle className="size-3.5" /> 按聊天记录分析
              </Button>
              <Button size="sm" onClick={parseCard} disabled={cardBusy} className="flex-1 border-0 bg-white/10 text-xs text-white hover:bg-white/20 disabled:opacity-40">
                {cardBusy ? <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Sparkles className="size-3.5" />}
                按名片/资料解析
              </Button>
            </div>
          </div>
        )}

        {/* 名片解析结果：可编辑表单 */}
        {mode === "card" && card && (
          <div className="mt-4 space-y-2.5">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
              <input
                value={card.name}
                onChange={(e) => setCard({ ...card, name: e.target.value })}
                className="w-full bg-transparent text-lg font-semibold outline-none"
              />
              <input
                value={card.title ?? ""}
                onChange={(e) => setCard({ ...card, title: e.target.value || null })}
                placeholder="职位 / 身份"
                className="mt-1 w-full bg-transparent text-sm text-white/60 outline-none placeholder-white/25"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder={card.org ?? "组织（可改）"}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
              />
              <input
                value={card.wechat ?? ""}
                onChange={(e) => setCard({ ...card, wechat: e.target.value || null })}
                placeholder="微信号"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
              />
            </div>
            <input
              value={card.city ?? ""}
              onChange={(e) => setCard({ ...card, city: e.target.value || null })}
              placeholder="城市"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
            />
            {card.whatTheyDo && (
              <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs leading-5 text-white/50">{card.whatTheyDo}</p>
            )}
            {card.cooperation && (
              <p className="rounded-lg bg-emerald-500/[0.06] px-3 py-2 text-xs leading-5 text-emerald-200/70">🎯 {card.cooperation}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setMode("")} className="flex-1 text-xs text-white/50 hover:bg-white/10 hover:text-white">返回修改文字</Button>
              <Button size="sm" onClick={saveCard} disabled={!card.name.trim()} className="flex-1 border-0 bg-emerald-500/25 text-xs text-emerald-100 hover:bg-emerald-500/40 disabled:opacity-40">入库</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 口述录入：说话 → 语音转文字 → AI 建档 ───

// Web Speech API 的最小类型（浏览器内置，TS 没有官方声明）
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = { isFinal: boolean; length: number; 0: SpeechRecognitionAlternativeLike } & ArrayLike<SpeechRecognitionAlternativeLike>;
type SpeechRecognitionResultListLike = { length: number } & ArrayLike<SpeechRecognitionResultLike>;
type SpeechRecognitionEventLike = { resultIndex: number; results: SpeechRecognitionResultListLike };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function VoiceImportModal({
  store, onClose, onChatText, onBatchText, onSave,
}: {
  store: NetworkStore;
  onClose: () => void;
  onChatText: (text: string) => void;
  onBatchText: (text: string) => void;
  onSave: (p: Person, newOrg?: Organization) => void;
}) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");

  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<CardParsed | null>(null);
  const [newOrgName, setNewOrgName] = useState("");

  const start = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) { setSupported(false); setError("浏览器不支持语音识别。可以按 fn fn 两下用系统听写，直接打进下面的文本框"); return; }
    setError("");
    finalRef.current = "";
    setTranscript("");
    setInterim("");
    setCard(null);
    const rec = new Ctor();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let final = "";
      let temp = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else temp += r[0].transcript;
      }
      if (final) {
        finalRef.current += final;
        setTranscript(finalRef.current);
      }
      setInterim(temp);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      const code = e.error ?? "unknown";
      if (code === "not-allowed") setError("麦克风权限被拒绝：点地址栏🔒图标 → 麦克风 → 允许，或用系统听写（fn fn）打进文本框");
      else if (code === "no-speech") { /* 没检测到语音，静默 */ }
      else setError(`语音识别出错（${code}），可以改用系统听写（fn fn）打进文本框`);
      setListening(false);
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stop = () => {
    recRef.current?.stop();
    setListening(false);
  };

  // 单人解析（复用 ai-assist parse：一段口语描述 → 结构化字段）
  const parseSingle = async () => {
    if (!transcript.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/network/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "parse", text: transcript.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "解析失败");
      const res = d.result as CardParsed;
      if (!res?.name?.trim()) throw new Error("没解析出姓名，多说一句对方是谁");
      setCard(res);
      const orgName = (res.org ?? "").trim();
      if (orgName && !store.organizations.some((o) => o.name.includes(orgName) || orgName.includes(o.name))) {
        setNewOrgName(orgName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setBusy(false);
    }
  };

  const saveCard = () => {
    if (!card?.name.trim()) return;
    const orgName = newOrgName.trim();
    let org = store.organizations.find((o) => o.name === orgName || o.name.includes(orgName) || orgName.includes(o.name));
    let newOrg: Organization | undefined;
    if (orgName && !org) {
      newOrg = {
        id: `org-${Date.now()}`,
        name: orgName,
        category: (card.orgCategory && CATEGORIES.includes(card.orgCategory as ContactCategory) ? card.orgCategory : "AI builder 社群") as ContactCategory,
        stage: "潜在",
        notes: "来源：口述录入（可用组织页「AI 检索」补资料）",
      };
    }
    const today = localToday();
    onSave({
      id: `p-${Date.now()}`,
      name: card.name.trim(),
      orgId: newOrg?.id ?? org?.id,
      title: card.title ?? undefined,
      tags: card.tags ?? [],
      wechat: card.wechat ?? undefined,
      city: card.city ?? undefined,
      whatTheyDo: card.whatTheyDo ?? undefined,
      howMet: card.howMet ?? undefined,
      cooperation: card.cooperation ?? undefined,
      notes: `来源：口述录入 · ${transcript.trim().slice(0, 200)}`,
      stage: "初步接触",
      priority: "medium",
      createdAt: today,
      updatedAt: today,
    }, newOrg);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">口述录入</h3>
            <p className="mt-0.5 text-xs text-white/40">像跟同事聊天一样说一句：「今天认识了个XX公司的李总，想做活动合作」</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white/40 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </Button>
        </div>

        {/* 录音区 */}
        {!card && (
          <div className="mt-5 flex flex-col items-center">
            <button
              onClick={listening ? stop : start}
              className={`flex size-20 items-center justify-center rounded-full transition-all ${listening ? "animate-pulse bg-red-500/30 text-red-200" : "bg-fuchsia-500/20 text-fuchsia-200 hover:bg-fuchsia-500/30"}`}
            >
              <Mic className="size-8" />
            </button>
            <p className="mt-3 text-xs text-white/40">
              {listening ? "正在听…（说完点一下停止）" : supported ? "点一下开始说" : "此浏览器不支持，请用系统听写（fn fn）打进下面的框"}
            </p>
            {(listening || interim) && (
              <p className="mt-2 min-h-6 max-h-24 overflow-y-auto text-center text-sm leading-6 text-white/70">
                {transcript} <span className="text-white/35">{interim}</span>
              </p>
            )}
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        {/* 转写文本：可编辑 + 三种解析方式 */}
        {!card && (transcript || !listening) && (
          <div className="mt-4">
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={5}
              placeholder="也可以直接打字（支持系统听写 fn fn）"
              className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm leading-6 outline-none placeholder-white/25 focus:border-white/20"
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={parseSingle} disabled={!transcript.trim() || busy} className="flex-1 border-0 bg-fuchsia-500/25 text-xs text-fuchsia-100 hover:bg-fuchsia-500/40 disabled:opacity-40">
                {busy ? <span className="size-3 animate-spin rounded-full border-2 border-fuchsia-300/30 border-t-fuchsia-300" /> : <Sparkles className="size-3.5" />}
                AI 建档（一个人）
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onBatchText(transcript)} disabled={!transcript.trim()} className="flex-1 text-xs text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-40">
                多个人
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onChatText(transcript)} disabled={!transcript.trim()} className="flex-1 text-xs text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-40">
                按聊天分析
              </Button>
            </div>
          </div>
        )}

        {/* 解析结果：可编辑卡片 */}
        {card && (
          <div className="mt-4 space-y-2.5">
            <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.06] p-3">
              <input
                value={card.name}
                onChange={(e) => setCard({ ...card, name: e.target.value })}
                className="w-full bg-transparent text-lg font-semibold outline-none"
              />
              <input
                value={card.title ?? ""}
                onChange={(e) => setCard({ ...card, title: e.target.value || null })}
                placeholder="职位 / 身份"
                className="mt-1 w-full bg-transparent text-sm text-white/60 outline-none placeholder-white/25"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder={card.org ?? "组织（可改）"}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
              />
              <input
                value={card.city ?? ""}
                onChange={(e) => setCard({ ...card, city: e.target.value || null })}
                placeholder="城市"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder-white/30 focus:border-white/20"
              />
            </div>
            {card.whatTheyDo && (
              <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs leading-5 text-white/50">{card.whatTheyDo}</p>
            )}
            {card.cooperation && (
              <p className="rounded-lg bg-fuchsia-500/[0.06] px-3 py-2 text-xs leading-5 text-fuchsia-200/70">🎯 合作建议：{card.cooperation}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {card.tags.map((t) => (
                <span key={t} className="rounded-lg bg-fuchsia-500/15 px-2 py-1 text-xs text-fuchsia-200">{t}</span>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setCard(null)} className="flex-1 text-xs text-white/50 hover:bg-white/10 hover:text-white">重新说/改文字</Button>
              <Button size="sm" onClick={saveCard} disabled={!card.name.trim()} className="flex-1 border-0 bg-fuchsia-500/25 text-xs text-fuchsia-100 hover:bg-fuchsia-500/40 disabled:opacity-40">入库</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}



type FileContact = {
  name: string;
  org?: string;
  title?: string;
  wechat?: string;
  phone?: string;
  email?: string;
  city?: string;
  note?: string;
};

// ─── 文件导入：通讯录 .vcf / 名单表 .csv → 勾选确认入库 ───

function FileImportModal({
  store, onClose, onSave, onTextFile,
}: {
  store: NetworkStore;
  onClose: () => void;
  onSave: (people: Person[], newOrgs: Organization[]) => void;
  onTextFile: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [items, setItems] = useState<(FileContact & { checked: boolean; exists: boolean })[]>([]);

  const loadFile = (file: File) => {
    setError("");
    setItems([]);
    setFileName(file.name);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const reader = new FileReader();
    reader.onload = async () => {
      const raw = String(reader.result ?? "");
      if (ext === "txt" || ext === "md") { onTextFile(raw); return; }
      if (ext !== "vcf" && ext !== "csv") { setError("只支持 .vcf（通讯录）、.csv（名单表）、.txt（文本）"); return; }
      setBusy(true);
      try {
        const r = await fetch("/api/network/parse-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: ext, raw }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "解析失败");
        const people = d.people as FileContact[];
        setItems(
          people
            .filter((x) => x.name?.trim())
            .map((x) => {
              const exists = store.people.some((p) => p.name === x.name.trim());
              return { ...x, name: x.name.trim(), checked: !exists, exists };
            }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "解析失败");
      } finally {
        setBusy(false);
      }
    };
    reader.readAsText(file);
  };

  const submit = () => {
    const today = localToday();
    const newOrgs: Organization[] = [];
    const orgIdByName = new Map<string, string>();
    const people: Person[] = items.filter((x) => x.checked).map((x, idx) => {
      let orgId: string | undefined;
      const orgName = (x.org ?? "").trim();
      if (orgName) {
        const existingOrg = store.organizations.find((o) => o.name === orgName || o.name.includes(orgName) || orgName.includes(o.name));
        if (existingOrg) {
          orgId = existingOrg.id;
        } else if (orgIdByName.has(orgName)) {
          orgId = orgIdByName.get(orgName)!;
        } else {
          const newOrg: Organization = {
            id: `org-${Date.now()}-${newOrgs.length}`,
            name: orgName,
            category: "AI builder 社群",
            stage: "潜在",
            notes: fileName.endsWith(".vcf") ? "来源：通讯录导入" : "来源：名单表导入",
          };
          newOrgs.push(newOrg);
          orgIdByName.set(orgName, newOrg.id);
          orgId = newOrg.id;
        }
      }
      return {
        id: `p-${Date.now()}-${idx}`,
        name: x.name,
        orgId,
        title: x.title || undefined,
        tags: [],
        wechat: x.wechat || undefined,
        phone: x.phone || undefined,
        email: x.email || undefined,
        city: x.city || undefined,
        notes: x.note || `来源：${fileName.endsWith(".vcf") ? "通讯录" : "名单表"}导入 · ${today}`,
        stage: "潜在" as const,
        priority: "medium" as const,
        createdAt: today,
        updatedAt: today,
      };
    });
    if (!people.length) return;
    onSave(people, newOrgs);
  };

  const checkedCount = items.filter((x) => x.checked).length;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#111116] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">通讯录 / 名单表导入</h3>
            <p className="mt-0.5 text-xs text-white/40">Mac 通讯录导出 .vcf · 飞书/Excel 导出 .csv · 文本 .txt</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="text-white/40 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </Button>
        </div>

        {!items.length && !busy && (
          <label
            className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] py-10 transition-colors hover:border-sky-400/40 hover:bg-sky-500/[0.04]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); }}
          >
            {busy ? (
              <span className="size-6 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" />
            ) : (
              <FileUp className="size-7 text-white/25" />
            )}
            <p className="mt-2 text-sm text-white/50">{busy ? "解析中…" : "拖入文件，或点击选择"}</p>
            <p className="mt-1 text-[11px] text-white/25">{fileName || "通讯录：全选联系人 → 导出 vCard"}</p>
            <input type="file" accept=".vcf,.csv,.txt,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
          </label>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        {items.length > 0 && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-white/40">{fileName} · {items.length} 人（勾选 {checkedCount}）</span>
              <button onClick={() => setItems((prev) => prev.map((x) => ({ ...x, checked: !x.exists ? !prev.every((y) => y.checked) : x.checked })))} className="text-xs text-sky-300 hover:text-sky-200">
                全选/反选
              </button>
            </div>
            <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
              {items.map((x, i) => (
                <label key={`${x.name}-${i}`} className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${x.checked ? "border-sky-500/25 bg-sky-500/[0.06]" : "border-white/5 bg-white/[0.02]"}`}>
                  <input
                    type="checkbox"
                    checked={x.checked}
                    onChange={(e) => setItems((prev) => prev.map((y, j) => (j === i ? { ...y, checked: e.target.checked } : y)))}
                    className="size-3.5 accent-sky-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{x.name}</span>
                      {x.exists && <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">已存在</span>}
                    </span>
                    {(x.org || x.title || x.wechat) && (
                      <span className="mt-0.5 block truncate text-[11px] text-white/35">{[x.org, x.title, x.wechat, x.city].filter(Boolean).join(" · ")}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="flex-1 text-xs text-white/50 hover:bg-white/10 hover:text-white">取消</Button>
              <Button size="sm" onClick={submit} disabled={!checkedCount} className="flex-1 border-0 bg-sky-500/25 text-xs text-sky-100 hover:bg-sky-500/40 disabled:opacity-40">
                导入 {checkedCount} 人
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
