import { deepseekJson, fetchPageText } from "@/lib/network/deepseek";
import { businessContextForPrompt } from "@/lib/network/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 链接画像：服务端抓取网页 → 提取纯文本 → DeepSeek 分析组织与个人上下文。
// 原文不落盘。

const SYSTEM_PREAMBLE = `你是生态合作 BD 的人脉调研助手。用户给你一个网页的正文内容（可能是：组织官网、公众号文章、个人主页、开源项目页、活动页面等），以及可选的已知人脉上下文。

${businessContextForPrompt()}

分析并输出严格的 JSON：
{
  "org": {
    "name": "组织/公司/社区名称",
    "whatTheyDo": "这个组织做什么（2-3句话，具体：领域、产品、影响力）",
    "relevance": "与 AI 生态合作 BD 的相关点：可以合作什么（1-2句）"
  },
  "person": {
    "title": "这个人的职位/身份（页面有才填，否则 null）",
    "background": "这个人的背景（2-3句：经历、专长、影响力）",
    "recentWork": "他最近在做什么/代表作/近期动态（1-2句，页面有才填）"
  },
  "keyPoints": ["3-5个关键要点，每条一句话：谁、做什么、有什么资源、对我们有什么用"],
  "businessMatch": {
    "matchedBusiness": "匹配到的我方业务能力名称（从 MCN 推广服务/线下活动与直播/Token 服务/服务器租赁 中选，无匹配则 null）",
    "reason": "为什么匹配（引用页面内容）",
    "suggestion": "具体的合作切入建议（一句话）"
  },
  "cooperation": "基于这个页面看到的潜在合作切入方向（1句具体建议，优先指向具体业务能力）",
  "summary": "一段话总结（80字内）：这个页面让我了解到什么"
}

规则：
1. 只输出 JSON
2. 页面内容与人物/组织无关时，各字段如实填 null，keyPoints 总结页面实际内容
3. 推断不出的字段用 null，不要编造
4. 视角始终是：用户是 AI 领域生态合作 BD，关心社区、媒体、活动、技术合作、商务机会
5. businessMatch 认真判断：页面内容涉及流量/推广/内容→MCN；活动/线下/直播/黑客松→线下活动与直播；API/模型/token/调用→Token 服务；服务器/GPU/算力/云资源→服务器租赁`;

type EnrichResult = {
  org: { name: string | null; whatTheyDo: string | null; relevance: string | null };
  person: { title: string | null; background: string | null; recentWork: string | null };
  keyPoints: string[];
  businessMatch: { matchedBusiness: string | null; reason: string; suggestion: string } | null;
  cooperation: string | null;
  summary: string;
};

function extractJson(text: string): (EnrichResult & { error?: string }) | null {
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
    return JSON.parse(jsonStr) as EnrichResult & { error?: string };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { url?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  const context = (body.context ?? "").trim().slice(0, 2000);
  if (!url || !/^https?:\/\//i.test(url)) {
    return Response.json({ error: "请提供有效的 http(s) 链接" }, { status: 400 });
  }

  // 1. 服务端抓取网页正文
  let pageText: string;
  try {
    pageText = await fetchPageText(url);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "网页抓取失败" }, { status: 422 });
  }
  if (pageText.length < 50) {
    return Response.json({ error: "页面内容太少，可能是反爬或需要 JS 渲染的页面" }, { status: 422 });
  }

  // 2. DeepSeek 分析
  const userPrompt = `已知人脉上下文（供参考）：${context || "（无）"}\n\n--- 网页内容（URL: ${url}）---\n${pageText}`;
  let raw: string;
  try {
    raw = await deepseekJson(SYSTEM_PREAMBLE, userPrompt, { maxTokens: 1500, timeoutMs: 90_000 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "分析失败" }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return Response.json({ error: "AI 返回的格式无法解析，重试一次", raw: raw.slice(0, 500) }, { status: 502 });
  }
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 422 });
  return Response.json({ result: parsed });
}
