// 分析核心：聊天记录 → 结构化人脉信息。
// 被 /api/network/analyze（网页粘贴）和 /api/network/ingest（微信桥接推送）共用。

import { deepseekJson } from "@/lib/network/deepseek";
import { businessContextForPrompt } from "@/lib/network/business-profile";

const SYSTEM_PREAMBLE = `你是一个生态合作 BD 的人脉分析助手。用户会粘贴一段与联系人（客户/合作伙伴）的聊天记录（通常从微信复制，格式可能是"昵称
时间
内容"或"昵称: 内容"）。

${businessContextForPrompt()}

你的任务：分析这段聊天，输出严格的 JSON。

JSON 结构：
{
  "person": {
    "name": "对方的名字/昵称",
    "title": "对方的职位或身份（聊天中能推断才填，否则 null）",
    "org": "对方所属组织/公司（能推断才填，否则 null）",
    "wechat": "微信号（聊天中出现才填，否则 null）",
    "tags": ["他是干嘛的标签，1-4个"],
    "whatTheyDo": "对方具体做什么（一句话）",
    "whatTheyWant": "对方想要什么（从聊天中推断）"
  },
  "intent": {
    "category": "意图分类，必须是以下之一：活动合作/内容合作/商务商单/技术合作/资源对接/咨询请教/闲聊维护/无明显意向",
    "confidence": 0.95,
    "evidence": "判断依据（引用聊天中的关键句）"
  },
  "businessMatch": {
    "matchedBusiness": "匹配到的我方业务能力名称（从 MCN 推广服务/线下活动与直播/Token 服务/服务器租赁 中选，无匹配则 null）",
    "reason": "为什么匹配（引用对方需求或特征）",
    "suggestion": "具体的合作切入建议（一句话，要具体到能做什么）"
  },
  "ourMove": {
    "suggestedReply": "给对方的建议回复（口语化、自然、符合中文商务沟通习惯，80-150字，推进合作但不谄媚，如果匹配到业务能力要自然融入）",
    "cooperation": "潜在合作方向（一句话，优先指向具体业务能力）",
    "nextAction": "我们下一步该做什么（一句话）",
    "stage": "建议阶段：潜在/初步接触/深度合作 之一"
  },
  "summary": "这次沟通的一句话总结"
}

规则：
1. 只输出合法 JSON（数字不能加 ca. ≈ 等前缀，必须是 0.95 这样的纯数字）
2. 聊天里推断不出的字段用 null，不要编造
3. suggestedReply 要符合用户身份：推进 AI 生态合作、社区联动、活动共创；如果对方需求匹配某项业务能力，回复中要自然提及我们能提供什么
4. businessMatch 必须认真判断：对方提到流量/推广/内容需求→MCN；提到活动/线下/直播/黑客松→线下活动与直播；提到 API/模型/token/调用→Token 服务；提到服务器/GPU/算力/云资源→服务器租赁
5. tags 只从这些里选（可自定义但尽量贴近）：主理人、创始人/CEO、BD/商务、开发者关系、运营、记者/编辑、投资人、活动组织、技术专家、产品经理、高校老师、学生领袖、独立开发者、自媒体博主、公关/市场
6. 如果聊天记录里有多个人在说话，分析"对方"（通常不是"我"的那一方）`;

export type AnalyzeChatResult = {
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

export function extractAnalyzeJson(text: string): AnalyzeChatResult | null {
  // 去掉可能的 markdown 代码块标记
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  // 截断的输出尝试补全
  let end = cleaned.lastIndexOf("}");
  let jsonStr: string;
  if (end === -1 || end <= start) {
    jsonStr = cleaned.slice(start);
    if ((jsonStr.match(/"/g) || []).length % 2 === 1) jsonStr += '"';
    const opens = (jsonStr.match(/{/g) || []).length;
    let closes = (jsonStr.match(/}/g) || []).length;
    while (opens > closes) { jsonStr += "}"; closes++; }
  } else {
    jsonStr = cleaned.slice(start, end + 1);
  }

  try {
    jsonStr = jsonStr
      .replace(/ca\.\s*/gi, "")
      .replace(/≈\s*/g, "")
      .replace(/~\s*/g, "")
      .replace(/PARTIAL_PROMPT_INPUT_ERROR[,\s]*/gi, "0.9, ")
      .replace(/,\s*}/g, "}");
    // confidence 字段容错：模型有时填入非数字内容
    jsonStr = jsonStr.replace(/"confidence"\s*:\s*[^,}\d]+(?:[\d.]+)?/g, (match) => {
      const numMatch = match.match(/[\d.]+$/);
      return `"confidence": ${numMatch ? numMatch[0] : "0.8"}`;
    });
    return JSON.parse(jsonStr) as AnalyzeChatResult;
  } catch {
    return null;
  }
}

export async function analyzeChat(text: string): Promise<AnalyzeChatResult> {
  const raw = await deepseekJson(SYSTEM_PREAMBLE, `--- 聊天记录 ---\n${text}`, { maxTokens: 2000, timeoutMs: 90_000 });
  const parsed = extractAnalyzeJson(raw);
  if (!parsed?.person?.name) {
    throw new Error("AI 返回的格式无法解析");
  }
  return parsed;
}
