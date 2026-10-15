import { deepseekJson, fetchPageText } from "@/lib/network/deepseek";
import { searchWeb } from "@/lib/network/research";
import { businessContextForPrompt } from "@/lib/network/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 人物联网检索：口述/导入解析出「姓名+组织」后，自动搜索这个人的公开背景
// （官网团队页、媒体报道、社交主页），综合成人物画像供档案补充。
// 只收公开信息，不做深度人肉；证据不足时 found=false 不编造。

const SYSTEM_PREAMBLE = `你是生态合作 BD 的人物调研助手。给你一个人名、他的组织、若干搜索结果和网页正文。综合判断这个人的公开背景，输出严格 JSON：
{
  "found": true/false（证据能确认"这个组织的这个人"真实存在且信息相关才为 true）,
  "title": "职位/头衔（证据里有才填，否则 null）",
  "background": "他的公开背景（2-3句：做什么、负责什么、有什么公开动态）",
  "keyPoints": ["2-4条：公开身份/项目/观点/近期动态"],
  "socialLinks": ["公开主页链接（领英/推特/公众号/团队页等，有才填）"],
  "businessMatch": {
    "matchedBusiness": "匹配到我方业务能力名称（从 MCN 推广服务/线下活动与直播/Token 服务/服务器租赁 中选，无匹配则 null）",
    "reason": "为什么匹配",
    "suggestion": "合作切入建议（一句话）"
  },
  "cooperation": "与我们可能的合作切入（1句）",
  "confidence": 0.0-1.0,
  "summary": "一段话总结（60字内）"
}
规则：
1. 只输出 JSON
2. 重名很常见：只有搜索结果里的"人名+组织"能对上号才确认 found；证据不足就 false + 低 confidence，不编造
3. businessMatch 认真判断：内容推广/流量/达人→MCN；活动/直播/黑客松→线下活动与直播；API/模型/token→Token 服务；算力/GPU/服务器→服务器租赁
4. 只用公开可查的信息，不推测隐私

${businessContextForPrompt()}`;

type PersonResearch = {
  found: boolean;
  title: string | null;
  background: string | null;
  keyPoints: string[];
  socialLinks: string[];
  businessMatch: { matchedBusiness: string | null; reason: string; suggestion: string } | null;
  cooperation: string | null;
  confidence: number;
  summary: string;
  sources: string[];
};

function extractJson(text: string): (PersonResearch & { error?: string }) | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
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
      .replace(/,\s*}/g, "}");
    // confidence 容错
    const fixed = jsonStr.replace(/"confidence"\s*:\s*[^,}\d]+([\d.]+)?/g, (match) => {
      const num = match.match(/[\d.]+$/);
      return `"confidence": ${num ? num[0] : "0.8"}`;
    });
    return JSON.parse(fixed) as PersonResearch & { error?: string };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { name?: string; org?: string; context?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  const org = (body.org ?? "").trim();
  const context = (body.context ?? "").trim().slice(0, 800);
  if (!name) return Response.json({ error: "姓名不能为空" }, { status: 400 });

  // 1. 搜索：人名+组织（有组织准确率高很多）。
  // 注意：搜狗对 OR 等操作符返回验证码页，用自然语言查询。
  const query = org ? `${org} ${name}` : `${name} 简介`;
  let hits: Awaited<ReturnType<typeof searchWeb>> = [];
  try {
    hits = await searchWeb(query, 6);
  } catch { /* 搜索失败 → 模型常识兜底 */ }

  // 2. 抓前 2 个页面
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
  const userPrompt = `人名：${name}${org ? `\n组织：${org}` : ""}${context ? `\n已知上下文：${context}` : ""}\n\n--- 搜索结果 ---\n${searchBlock}${pagesBlock}`;

  let raw: string;
  try {
    raw = await deepseekJson(SYSTEM_PREAMBLE, userPrompt, { maxTokens: 1200, timeoutMs: 90_000 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "分析失败" }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return Response.json({ error: "AI 返回格式无法解析" }, { status: 502 });
  }
  return Response.json({
    result: { ...parsed, sources: hits.slice(0, 4).map((h) => h.url) },
  });
}
