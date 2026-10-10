import { deepseekJson, fetchPageText } from "@/lib/network/deepseek";
import { searchWeb } from "@/lib/network/research";
import { businessContextForPrompt } from "@/lib/network/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 组织自动检索：搜索 → 抓取前几条结果 → DeepSeek 综合出组织画像。
// 用于聊天导入时发现的新组织：自动入组织库并带出上下文。

const CATEGORIES = [
  "AI builder 社群", "媒体与内容平台", "AI人才生态合作伙伴", "高校创业社团",
  "支持单位", "技术合作伙伴", "AI工具公司", "企业创新部门",
];

const SYSTEM_PREAMBLE = `你是生态合作 BD 的组织调研助手。用户给你一个组织名称、若干搜索结果标题，以及可能抓取到的网页正文。综合判断这个组织是什么，输出严格 JSON：
{
  "found": true/false（综合证据判断是否真的找到了这个组织；搜索结果明显不相关时为 false）,
  "officialUrl": "组织官网/主页（证据里有才填，否则 null）",
  "category": "从以下选最贴切的一个：${CATEGORIES.join(" / ")}",
  "whatTheyDo": "组织做什么（2-3句：领域、产品/活动、影响力）",
  "keyPoints": ["2-4条要点：做什么、有什么资源、对我们的价值"],
  "businessMatch": {
    "matchedBusiness": "匹配到的我方业务能力名称（从 MCN 推广服务/线下活动与直播/Token 服务/服务器租赁 中选，无匹配则 null）",
    "reason": "为什么匹配（引用检索内容）",
    "suggestion": "具体的合作切入建议（一句话）"
  },
  "cooperation": "与我们（AI 生态合作 BD）可能的合作切入（1句，优先指向具体业务能力）",
  "confidence": 0.0-1.0,
  "summary": "一段话总结（60字内）"
}
规则：
1. 只输出 JSON
2. 证据不足就在 found 填 false、confidence 给低分，不要编造
3. 判断依据优先级：官网/官方账号 > 权威媒体报道 > 社区讨论
4. businessMatch 认真判断：组织涉及内容推广/流量/达人→MCN；举办活动/线下沙龙/黑客松/直播→线下活动与直播；提供/需要 API/模型/token→Token 服务；提供/需要算力/GPU/服务器→服务器租赁`;

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

function extractJson(text: string): (OrgResearch & { error?: string }) | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const jsonStr = cleaned
      .slice(start, end + 1)
      .replace(/ca\.\s*/gi, "")
      .replace(/≈\s*/g, "")
      .replace(/~\s*/g, "")
      .replace(/PARTIAL_PROMPT_INPUT_ERROR[,\s]*/gi, "0.9, ")
      .replace(/,\s*}/g, "}");
    return JSON.parse(jsonStr) as OrgResearch & { error?: string };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { name?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  const context = (body.context ?? "").trim().slice(0, 1000);
  if (!name) return Response.json({ error: "组织名称不能为空" }, { status: 400 });

  // 1. 搜索（失败不阻塞，走模型常识兜底）
  let hits: Awaited<ReturnType<typeof searchWeb>> = [];
  try {
    hits = await searchWeb(`${name} 组织 AI`, 6);
  } catch { /* 搜索失败 → 兜底 */ }

  // 2. 抓取前 2 个结果页（并行、各自尽力而为）
  const pages = await Promise.allSettled(
    hits.slice(0, 2).map(async (h) => {
      const text = await fetchPageText(h.url, 4000);
      return `【来源】${h.title}\n${h.url}\n${text}`;
    }),
  );
  const pageBlocks = pages
    .filter((p): p is PromiseFulfilledResult<string> => p.status === "fulfilled")
    .map((p) => p.value);

  // 3. DeepSeek 综合
  const searchBlock = hits.length
    ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}`).join("\n")
    : "（搜索不可用，无结果）";
  const pagesBlock = pageBlocks.length ? `\n\n--- 网页正文 ---\n${pageBlocks.join("\n\n")}` : "";
  const userPrompt = `组织名称：${name}${context ? `\n已知上下文：${context}` : ""}\n\n--- 搜索结果 ---\n${searchBlock}${pagesBlock}`;

  let raw: string;
  try {
    raw = await deepseekJson(SYSTEM_PREAMBLE, userPrompt, { maxTokens: 1200, timeoutMs: 90_000 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "分析失败" }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return Response.json({ error: "AI 返回的格式无法解析，重试一次" }, { status: 502 });
  }
  return Response.json({
    result: {
      ...parsed,
      category: CATEGORIES.includes(parsed.category as never) ? parsed.category : "AI builder 社群",
      sources: hits.slice(0, 4).map((h) => h.url),
    },
  });
}
