import { deepseekJson } from "@/lib/network/deepseek";
import { businessContextForPrompt } from "@/lib/network/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// AI 人脉助手：三种模式
// 1. parse   —— 一句话描述 → 结构化人脉字段（智能添加）
// 2. suggest —— 已有人脉 → 补全 whatWeWant/cooperation/tags（详情页 AI 补全）
// 3. script  —— 结合业务能力 + 历史互动 → 定制话术

const SYSTEM_PREAMBLE = `你是生态合作 BD 的 AI 人脉助手。

${businessContextForPrompt()}

根据用户输入完成任务，输出严格合法的 JSON（数字必须是纯数字如 0.9，不要 ca./≈/~ 前缀）。`;

type Parsed = Record<string, unknown> & { error?: string };

function extractJson(text: string): Parsed | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
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
    // confidence 字段容错：模型有时填入非数字内容（如「准确度: 0.9」）
    jsonStr = jsonStr.replace(/"confidence"\s*:\s*[^,}\d]+(?:[\d.]+)?/g, (match) => {
      const numMatch = match.match(/[\d.]+$/);
      return `"confidence": ${numMatch ? numMatch[0] : "0.8"}`;
    });
    return JSON.parse(jsonStr) as Parsed;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { kind?: string; text?: string; person?: Record<string, unknown>; org?: Record<string, unknown> | null; interactions?: Array<{ date: string; summary: string }>; missing?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const kind = body.kind;

  let prompt = "";
  if (kind === "parse") {
    const text = (body.text ?? "").trim();
    if (!text) return Response.json({ error: "描述不能为空" }, { status: 400 });
    if (text.length > 2000) return Response.json({ error: "描述太长" }, { status: 400 });
    prompt = `任务：把用户对一个人脉的一句话描述解析成结构化字段。

描述：「${text}」

输出 JSON：
{
  "name": "姓名/昵称（必须有，从描述提取）",
  "org": "所属组织（描述里没有则 null）",
  "orgCategory": "组织的分类（如果识别出了组织，从：AI builder 社群/媒体与内容平台/AI人才生态合作伙伴/高校创业社团/支持单位/技术合作伙伴/AI工具公司/企业创新部门 里选最贴切的，否则 null）",
  "title": "职位/身份（没有则 null）",
  "wechat": "微信号（描述里明确提到才填，否则 null）",
  "tags": ["他是干嘛的标签 1-3 个，从：主理人、创始人/CEO、BD/商务、开发者关系、运营、记者/编辑、投资人、活动组织、技术专家、产品经理、高校老师、学生领袖、独立开发者、自媒体博主、公关/市场 里选，可自定义"],
  "whatTheyDo": "他具体做什么（一句话，没有则 null）",
  "howMet": "怎么认识的（描述里有才填，否则 null）",
  "city": "城市（有才填，否则 null）",
  "cooperation": "结合我的业务能力，和这个人可能的合作方向（一句话；信息太少则 null）",
  "confidence": 0.0
}`;
  } else if (kind === "parse-card") {
    const text = (body.text ?? "").trim();
    if (!text) return Response.json({ error: "识别文本不能为空" }, { status: 400 });
    if (text.length > 3000) return Response.json({ error: "识别文本太长（名片/资料页截图即可）" }, { status: 400 });
    prompt = `任务：下面是一张截图经 OCR 识别出的文本（可能是微信个人资料页、名片、或一段简介）。把它解析成结构化人脉字段。OCR 可能有错别字，按上下文合理纠正。

识别文本：
${text}

输出 JSON：
{
  "name": "姓名/昵称（必须有；资料页顶部最大的名字。OCR 里只有'设置''朋友圈'之类界面词时取实际人名）",
  "org": "所属组织/公司（没有则 null）",
  "orgCategory": "组织分类（识别出组织时从：AI builder 社群/媒体与内容平台/AI人才生态合作伙伴/高校创业社团/支持单位/技术合作伙伴/AI工具公司/企业创新部门 里选，否则 null）",
  "title": "职位/身份（没有则 null）",
  "wechat": "微信号（'微信号：xxx'那行，注意不是'微信名'；没有则 null）",
  "city": "城市（'地区：xx xx'那行；没有则 null）",
  "tags": ["他是干嘛的标签 1-3 个，从：主理人、创始人/CEO、BD/商务、开发者关系、运营、记者/编辑、投资人、活动组织、技术专家、产品经理、高校老师、学生领袖、独立开发者、自媒体博主、公关/市场 里选，可自定义"],
  "whatTheyDo": "他具体做什么（从签名/简介归纳一句话；没有则 null）",
  "cooperation": "结合我的业务能力，和这个人可能的合作方向（一句话；信息太少则 null）",
  "confidence": 0.0
}
规则：界面固定文案（如'设置''仅聊天''朋友圈''添加到通讯录'）不是信息，忽略；不要编造。`;
  } else if (kind === "parse-batch") {
    const text = (body.text ?? "").trim();
    if (!text) return Response.json({ error: "描述不能为空" }, { status: 400 });
    if (text.length > 10_000) return Response.json({ error: "内容太长（上限 1 万字符，约 100 人）" }, { status: 400 });
    prompt = `任务：用户粘贴了多行人脉描述（每行一个人）。把每一行解析成结构化字段，并判断每个人的录入价值。

描述：
${text}

输出 JSON：
{
  "people": [
    {
      "name": "姓名/昵称（必须有，从该行提取）",
      "org": "所属组织（该行没有则 null）",
      "orgCategory": "组织分类（识别出组织时从：AI builder 社群/媒体与内容平台/AI人才生态合作伙伴/高校创业社团/支持单位/技术合作伙伴/AI工具公司/企业创新部门 里选，否则 null）",
      "title": "职位/身份（没有则 null）",
      "tags": ["他是干嘛的标签 1-3 个，从：主理人、创始人/CEO、BD/商务、开发者关系、运营、记者/编辑、投资人、活动组织、技术专家、产品经理、高校老师、学生领袖、独立开发者、自媒体博主、公关/市场 里选，可自定义"],
      "whatTheyDo": "他具体做什么（一句话，没有则 null）",
      "howMet": "怎么认识的（有才填，否则 null）",
      "cooperation": "结合我的业务能力的合作方向（一句话；信息太少则 null）",
      "priority": "high/medium/low（录入价值：聊过具体合作事宜/有明确需求/能做具体的事=high；同行业六个月内大概率再碰到/组织重要=medium；只是寒暄换微信混脸熟=low）",
      "stage": "潜在/初步接触（聊过具体事情=初步接触，只是认识=潜在）",
      "reason": "价值判断的一句话依据"
    }
  ]
}
规则：每行一个人保持顺序；解析不出姓名的行直接跳过；不要编造；只输出 JSON。`;
  } else if (kind === "suggest") {
    const p = body.person ?? {};
    const org = body.org ?? null;
    prompt = `任务：为一个已录入的人脉生成 BD 视角的补全建议。

人脉信息：${JSON.stringify(p)}
所属组织：${org ? JSON.stringify(org) : "（无）"}

输出 JSON：
{
  "whatWeWant": "我们想从他这得到什么（1句话，结合他的身份/组织和我的业务能力判断，如：资源、渠道、品牌背书、商单）",
  "cooperation": "具体合作方向（1句话，优先指向我的某项业务能力）",
  "priority": "high/medium/low（根据合作价值判断）",
  "followUpDays": 14,
  "reason": "为什么这么建议（1-2句话）"
}
规则：followUpDays 是数字（潜在30/初步接触14/深度合作7 左右），置信高价值人就给 high。已有字段值仅供参考，给出更好的版本。`;
  } else if (kind === "script") {
    const p = body.person ?? {};
    const org = body.org ?? null;
    const recent = (body.interactions ?? []).slice(-5);
    prompt = `任务：为用户生成一条给这个人发的微信消息。

人脉信息：${JSON.stringify(p)}
所属组织：${org ? JSON.stringify(org) : "（无）"}
最近互动记录：${recent.length ? recent.map((i) => `${i.date}: ${i.summary}`).join("；") : "（无记录）"}

输出 JSON：
{
  "script": "微信消息正文（口语化、自然、符合中文商务习惯，60-120字；结合我的业务能力和这个人的身份定制；有明确合作方向就直接推进，别客套）",
  "angle": "这条话术的切入角度（一句话，如'用黑客松活动合作切入'）"
}`;
  } else if (kind === "questions") {
    const p = body.person ?? {};
    const org = body.org ?? null;
    const missing = Array.isArray(body.missing) ? (body.missing as string[]) : [];
    const recent = (body.interactions ?? []).slice(-5);
    prompt = `任务：为这个正在跟进的人脉生成 3-5 个「最值得补齐信息」的追问。用户每天认识很多人，容易漏细节——这些问题帮他下次聊之前快速回忆、或在聊天中自然问出来。

人脉信息（含已填字段）：${JSON.stringify(p)}
还缺的信息维度：${missing.join("、") || "无明显空缺，从模糊字段深挖"}
所属组织：${org ? JSON.stringify(org) : "（无）"}
最近互动：${recent.length ? recent.map((i) => `${i.date}: ${i.summary}`).join("；") : "（无记录）"}

输出 JSON：
{
  "questions": ["追问1（口语化，可以直接拿去问对方，或帮用户回忆）", "追问2", "追问3"],
  "focus": "当前最该优先补齐的一条建议（一句话，指明为什么）"
}
规则：只针对空缺/模糊的信息问；结合他的身份、组织和我的业务能力（MCN 推广/线下活动直播/Token 服务/服务器租赁）定制；每题一句话说人话；已填清楚的不要重复问。`;
  } else {
    return Response.json({ error: "未知任务类型" }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await deepseekJson(SYSTEM_PREAMBLE, prompt, { maxTokens: 1200, timeoutMs: 90_000 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "AI 调用失败" }, { status: 502 });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return Response.json({ error: "AI 返回格式无法解析，重试一次", raw: raw.slice(0, 400) }, { status: 502 });
  }
  delete parsed.error;
  return Response.json({ result: parsed });
}
