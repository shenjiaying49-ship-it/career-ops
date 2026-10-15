// ─── 人脉行动引擎 · 数据模型 v4 ───
// 核心：以"人"为主，组织只是分组容器

export type ContactCategory =
  | "AI builder 社群"
  | "媒体与内容平台"
  | "AI人才生态合作伙伴"
  | "高校创业社团"
  | "支持单位"
  | "技术合作伙伴"
  | "AI工具公司"
  | "企业创新部门";

export type ContactStage = "潜在" | "初步接触" | "深度合作" | "暂停";
export type Priority = "high" | "medium" | "low";

// ─── 人（核心实体）───
export type Person = {
  id: string;
  name: string;
  orgId?: string;         // 所属组织（可选，独立个人可不填）
  title?: string;         // 职位 / 身份
  tags: string[];         // 他是干嘛的（可多个）
  wechat?: string;
  phone?: string;
  email?: string;
  city?: string;
  howMet?: string;        // 怎么认识的
  whatTheyDo?: string;    // 具体做什么
  whatWeWant?: string;    // 我们想从他这得到什么
  whatTheyWant?: string;  // 他想要什么
  cooperation?: string;   // 合作方向
  notes?: string;
  aiReply?: string;       // AI 根据聊天记录生成的建议回复（优先于模板话术）
  stage: ContactStage;
  priority: Priority;
  lastContactDate?: string;
  nextFollowUpDate?: string;
  createdAt: string;
  updatedAt: string;
};

// ─── 组织（分组容器）───
export type Organization = {
  id: string;
  name: string;
  category: ContactCategory;
  stage: ContactStage;
  notes?: string;
  defaultCooperation?: string; // 添加该组织下的人时预填
};

export type Interaction = {
  id: string;
  personId: string;
  date: string;
  channel: "微信" | "电话" | "见面" | "邮件" | "飞书" | "其他";
  summary: string;
  nextAction?: string;
};

// ─── 合作事项（deal）：需要推进到闭环的一件事 ───
// AI 从聊天/口述里自动提取（"聊了MCN推广，下周发方案"→ 推进中，跟进日期=下周）
// 状态：推进中 → 达成 / 完结 / 搁置。推进中且过了跟进日期 → 今日行动置顶提醒。
export type DealStatus = "推进中" | "达成" | "完结" | "搁置";

export type Deal = {
  id: string;
  personId: string;
  title: string;            // 一句话说什么合作（"MCN 推广试点"）
  status: DealStatus;
  nextStep?: string;        // 下一步动作（"等我们发方案"）
  nextFollowUpDate?: string; // 什么时候该推一把
  createdAt: string;
  updatedAt: string;
  closedAt?: string;        // 达成/完结/搁置时间
  feedback?: string;        // 合作反馈（每行 "日期：内容"）
  feedbackAt?: string;      // 最近一次反馈时间
  isFollowUpVisit?: boolean; // 达成后自动生成的回访任务
};

export type NetworkStore = {
  version: 4;
  people: Person[];
  organizations: Organization[];
  interactions: Interaction[];
  deals?: Deal[];           // 可选：老数据没有这字段，读到 undefined 就当 []
};

export const STORAGE_KEY = "career-ops:network-v4";

// ─── 操作者本人：任何情况下不作为人脉录入 ───
// 转发的聊天里会出现本人（"我"/昵称/英文名），AI 和代码两层都要挡住。
export const SELF_NAMES = ["沈佳颖", "Jocelyn佳颖", "Jocelyn", "佳颖"];

export function isSelfName(name?: string | null): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n || n.length < 2) return false;
  if (n === "我") return true;
  return SELF_NAMES.some((s) => {
    const t = s.toLowerCase();
    return n === t || n.includes(t) || t.includes(n);
  });
}

export const CATEGORIES: ContactCategory[] = [
  "AI builder 社群",
  "媒体与内容平台",
  "AI人才生态合作伙伴",
  "高校创业社团",
  "支持单位",
  "技术合作伙伴",
  "AI工具公司",
  "企业创新部门",
];

export const CATEGORY_COLORS: Record<ContactCategory, string> = {
  "AI builder 社群": "#6366f1",
  "媒体与内容平台": "#f59e0b",
  "AI人才生态合作伙伴": "#10b981",
  "高校创业社团": "#ec4899",
  "支持单位": "#8b5cf6",
  "技术合作伙伴": "#3b82f6",
  "AI工具公司": "#14b8a6",
  "企业创新部门": "#f97316",
};

export const STAGE_COLORS: Record<ContactStage, string> = {
  "潜在": "#5b6b7a",
  "初步接触": "#60a5fa",
  "深度合作": "#34d399",
  "暂停": "#8a95a1",
};

// ─── 常用标签建议（他是干嘛的）───
export const TAG_SUGGESTIONS = [
  "主理人", "创始人/CEO", "BD/商务", "开发者关系", "运营",
  "记者/编辑", "投资人", "活动组织", "技术专家", "产品经理",
  "高校老师", "学生领袖", "独立开发者", "自媒体博主", "公关/市场",
];

export function localToday(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export function localDatePlus(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysSince(date?: string): number | null {
  if (!date) return null;
  const today = new Date(localToday() + "T00:00:00");
  const target = new Date(date + "T00:00:00");
  return Math.floor((today.getTime() - target.getTime()) / 86400000);
}

// ─── 117 个组织（从飞书导入，作为分组容器）───
const orgData: Array<[string, ContactCategory, ContactStage, string?]> = [
  ["Datawhale", "AI人才生态合作伙伴", "初步接触", "联合活动、课程共建、人才推荐"],
  ["去探索", "AI builder 社群", "初步接触"],
  ["杭州AI工坊", "AI builder 社群", "初步接触"],
  ["出海去", "AI builder 社群", "潜在"],
  ["云谷中心", "支持单位", "潜在"],
  ["Y/our Space", "支持单位", "潜在"],
  ["SeeAI", "AI人才生态合作伙伴", "初步接触"],
  ["WaytoAGI", "AI人才生态合作伙伴", "初步接触", "内容共创、活动联办"],
  ["十堰黑客松", "AI builder 社群", "潜在"],
  ["清华创协", "高校创业社团", "初步接触", "校园活动、创业大赛"],
  ["北京理工大学创业协会", "高校创业社团", "潜在"],
  ["北理工灵动工厂", "高校创业社团", "潜在"],
  ["vibefriends", "AI builder 社群", "潜在"],
  ["AGI Bar知识蒸馏", "AI人才生态合作伙伴", "初步接触"],
  ["EPIC", "AI builder 社群", "初步接触"],
  ["BoHack", "AI builder 社群", "潜在"],
  ["一支烟花", "AI builder 社群", "潜在"],
  ["超越之路", "AI人才生态合作伙伴", "潜在"],
  ["AtomGit", "技术合作伙伴", "潜在", "技术合作、开发者工具"],
  ["多多群岛", "AI工具公司", "潜在"],
  ["she Nicest", "AI builder 社群", "初步接触"],
  ["Rebuild-Z", "AI builder 社群", "潜在"],
  ["徽客松", "AI builder 社群", "潜在"],
  ["周周黑客松", "AI builder 社群", "潜在"],
  ["知乎科技", "媒体与内容平台", "初步接触"],
  ["小红书科技", "媒体与内容平台", "初步接触"],
  ["Bonjour!", "AI工具公司", "初步接触"],
  ["北京大学学生创新学社", "高校创业社团", "初步接触"],
  ["原子公社", "AI builder 社群", "初步接触"],
  ["创思行", "支持单位", "初步接触"],
  ["MoonStone（矿大）", "高校创业社团", "初步接触"],
  ["芝兰（北理工）", "高校创业社团", "初步接触"],
  ["MiXerAI", "媒体与内容平台", "初步接触"],
  ["ZORERO", "媒体与内容平台", "初步接触"],
  ["AI TIME", "AI人才生态合作伙伴", "初步接触", "学术活动、人才对接"],
  ["硅星人Pro", "媒体与内容平台", "初步接触"],
  ["AI异类弗兰克", "媒体与内容平台", "初步接触"],
  ["四木相对论", "媒体与内容平台", "初步接触"],
  ["ttc", "支持单位", "初步接触"],
  ["QLAB", "媒体与内容平台", "初步接触"],
  ["36氪", "媒体与内容平台", "初步接触", "内容合作、活动报道"],
  ["创业邦", "媒体与内容平台", "初步接触"],
  ["钛媒体", "媒体与内容平台", "初步接触"],
  ["投资界", "媒体与内容平台", "初步接触"],
  ["小饭桌", "媒体与内容平台", "初步接触"],
  ["中国搜索", "媒体与内容平台", "初步接触"],
  ["中国证券报", "媒体与内容平台", "初步接触"],
  ["AI科技评论", "媒体与内容平台", "初步接触"],
  ["极客公园", "媒体与内容平台", "初步接触", "内容合作、活动联办"],
  ["FluxVerse", "AI builder 社群", "潜在"],
  ["阶跃星辰", "技术合作伙伴", "潜在", "技术合作、模型接入"],
  ["硅星人", "媒体与内容平台", "潜在"],
  ["XTION", "AI builder 社群", "潜在"],
  ["AdventureX", "AI builder 社群", "初步接触", "活动联办、品牌合作"],
  ["深客松", "AI builder 社群", "潜在"],
  ["赛托邦", "AI builder 社群", "潜在"],
  ["通客松", "AI builder 社群", "潜在"],
  ["冀客松", "AI builder 社群", "潜在"],
  ["Sophnet/算能", "技术合作伙伴", "潜在"],
  ["观猹", "媒体与内容平台", "初步接触"],
  ["特工宇宙", "媒体与内容平台", "初步接触"],
  ["云梦智联", "AI工具公司", "初步接触"],
  ["开源社", "技术合作伙伴", "潜在", "开源活动、社区共建"],
  ["S创客松", "AI builder 社群", "潜在"],
  ["Google", "技术合作伙伴", "初步接触", "技术活动、开发者关系"],
  ["香港高升", "支持单位", "初步接触"],
  ["椒盐玉兔", "媒体与内容平台", "初步接触"],
  ["魔搭社区", "技术合作伙伴", "初步接触", "技术活动、模型生态"],
  ["COC（CSDN 城市开发者社区）", "AI builder 社群", "潜在"],
  ["小红书内容平台", "媒体与内容平台", "潜在"],
  ["上海未来启点社区", "支持单位", "潜在"],
  ["浦发银行·杭州分行", "支持单位", "潜在"],
  ["赛博禅心", "媒体与内容平台", "潜在"],
  ["手工川", "媒体与内容平台", "初步接触"],
  ["塔塔tabtab", "媒体与内容平台", "潜在"],
  ["三金", "媒体与内容平台", "潜在"],
  ["AI产品黄叔", "媒体与内容平台", "潜在"],
  ["AI产品银海", "媒体与内容平台", "潜在"],
  ["这很容易", "媒体与内容平台", "潜在"],
  ["AI春晚", "媒体与内容平台", "潜在"],
  ["摹宙", "AI工具公司", "潜在"],
  ["InfoQ", "媒体与内容平台", "初步接触", "内容合作、技术大会"],
  ["conste星社", "AI人才生态合作伙伴", "初步接触"],
  ["长江大学计算机协会", "高校创业社团", "初步接触"],
  ["IF land", "高校创业社团", "潜在"],
  ["AgentGuard", "AI工具公司", "潜在"],
  ["GMI", "技术合作伙伴", "潜在"],
  ["Horizon Startup", "AI builder 社群", "初步接触"],
  ["NextStep", "AI人才生态合作伙伴", "初步接触"],
  ["出海同学会", "支持单位", "初步接触"],
  ["星连资本", "支持单位", "初步接触", "投资对接、项目推荐"],
  ["Wteam", "高校创业社团", "潜在"],
  ["阿里钉钉事业部", "企业创新部门", "初步接触", "企业合作、渠道对接"],
  ["aihour开源社区", "AI人才生态合作伙伴", "潜在"],
  ["七牛云", "AI工具公司", "初步接触", "技术合作、资源支持"],
  ["ai闹", "媒体与内容平台", "初步接触"],
  ["潮汐", "AI人才生态合作伙伴", "初步接触"],
  ["百度 秒哒", "AI工具公司", "潜在"],
  ["AttraX", "AI builder 社群", "潜在"],
  ["WAVE 联合创始人", "企业创新部门", "潜在"],
  ["百度ai技术生态", "企业创新部门", "潜在"],
  ["segmentfault 思否", "媒体与内容平台", "潜在"],
  ["ninjialab", "AI工具公司", "初步接触"],
  ["mushanghai", "AI builder 社群", "潜在"],
  ["崔牛会", "媒体与内容平台", "潜在"],
  ["AWS", "技术合作伙伴", "潜在", "技术活动、云资源支持"],
  ["腾讯云", "技术合作伙伴", "潜在", "技术活动、云资源支持"],
  ["浙大DAlab", "高校创业社团", "潜在"],
  ["复旦ai创协", "高校创业社团", "潜在"],
  ["中科院他山社区", "AI人才生态合作伙伴", "潜在", "学术合作、人才对接"],
  ["甲子光年", "媒体与内容平台", "潜在"],
  ["LEV0", "高校创业社团", "初步接触"],
  ["vibehack", "AI builder 社群", "潜在"],
  ["李颖杰", "媒体与内容平台", "潜在"],
  ["liar社区", "AI工具公司", "潜在"],
  ["delta x", "支持单位", "潜在"],
  ["ventureD", "AI builder 社群", "潜在"],
];

export const DEMO_STORE: NetworkStore = {
  version: 4,
  people: [],
  organizations: orgData.map(([name, category, stage, coop], i) => ({
    id: `org-${i + 1}`,
    name,
    category,
    stage,
    defaultCooperation: coop,
  })),
  interactions: [],
};
