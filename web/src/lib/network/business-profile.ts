// ─── 业务能力配置 ───
// 存储 BD 的核心业务能力，在分析人脉时自动注入上下文
// 用于识别合作机会：这个组织/人适合哪类合作

export type BusinessCapability = {
  id: string;
  name: string;           // 业务名称
  description: string;    // 详细描述
  keywords: string[];     // 触发关键词（用于匹配）
  examples: string[];     // 合作场景示例
};

export type BusinessProfile = {
  identity: string;        // 我是谁（组织/个人）
  role: string;            // 我的角色
  coreBusiness: BusinessCapability[];
};

export const BUSINESS_PROFILE_KEY = "career-ops:business-profile";

// 默认配置：原子公社的业务能力
export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  identity: "原子公社",
  role: "AI 生态合作 BD",
  coreBusiness: [
    {
      id: "mcn",
      name: "MCN 推广服务",
      description: "有 MCN 机构，可提供内容推广、流量扶持、达人合作等服务",
      keywords: ["推广", "流量", "达人", "内容合作", "新媒体", "短视频", "直播", "账号运营"],
      examples: ["内容推广合作", "达人资源对接", "流量扶持计划"],
    },
    {
      id: "events",
      name: "线下活动与直播",
      description: "可举办丰富的线下活动，以及线上直播；活动形式包括黑客松、沙龙、峰会、工作坊等",
      keywords: ["活动", "线下", "直播", "黑客松", "沙龙", "峰会", "工作坊", "meetup", "meetup", "分享会"],
      examples: ["联合举办黑客松", "线下沙龙活动承办", "线上直播分享", "技术峰会赞助"],
    },
    {
      id: "token",
      name: "Token 服务",
      description: "提供 AI 模型 token 服务，支持调用、计费、资源池",
      keywords: ["token", "API", "模型调用", "LLM", "GPT", "推理", "算力"],
      examples: ["API 调用服务", "模型推理资源", "token 打包方案"],
    },
    {
      id: "server",
      name: "服务器租赁",
      description: "提供服务器、GPU 资源租赁服务",
      keywords: ["服务器", "GPU", "算力", "云资源", "租赁", "云主机", "显卡"],
      examples: ["GPU 服务器租赁", "算力资源支持", "云资源合作"],
    },
  ],
};

// 获取业务配置（优先从 localStorage，否则用默认值）
export function getBusinessProfile(): BusinessProfile {
  if (typeof window === "undefined") return DEFAULT_BUSINESS_PROFILE;
  try {
    const stored = localStorage.getItem(BUSINESS_PROFILE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<BusinessProfile>;
      // 合并默认值，确保新增字段有兜底
      return {
        identity: parsed.identity ?? DEFAULT_BUSINESS_PROFILE.identity,
        role: parsed.role ?? DEFAULT_BUSINESS_PROFILE.role,
        coreBusiness: parsed.coreBusiness ?? DEFAULT_BUSINESS_PROFILE.coreBusiness,
      };
    }
  } catch {}
  return DEFAULT_BUSINESS_PROFILE;
}

// 保存业务配置
export function saveBusinessProfile(profile: BusinessProfile): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BUSINESS_PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}

// 生成用于 AI prompt 的业务上下文描述
export function businessContextForPrompt(profile: BusinessProfile = getBusinessProfile()): string {
  const business = profile.coreBusiness
    .map((b) => `- **${b.name}**：${b.description}\n  合作场景：${b.examples.join("、")}`)
    .join("\n");
  return `## 我的身份与业务能力

**身份**：${profile.identity}（${profile.role}）

**核心业务能力**：
${business}

**合作判断原则**：
1. 优先识别对方/组织的需求是否与上述业务能力匹配
2. 匹配度高时，cooperation 字段应具体指向某项业务（如"适合 MCN 推广合作"而非泛泛的"合作机会"）
3. 若对方有流量、内容、技术、算力需求，明确指出可以用哪项业务能力对接`;
}