// ─── CSV 联系人表解析：飞书/Excel 导出的名单表 → 结构化联系人 ───
// 自动识别表头列（姓名/公司/职位/微信/城市/备注…），无表头则把首列当姓名。

export type CsvContact = {
  name: string;
  org?: string;
  title?: string;
  wechat?: string;
  phone?: string;
  email?: string;
  city?: string;
  note?: string;
};

/** 标准 CSV 切分：处理引号、逗号、换行 */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const HEADER_MAP: Array<{ keys: RegExp[]; field: keyof Omit<CsvContact, "name"> }> = [
  { keys: [/^公司$|^组织$|^单位$|^机构$|org|company|organization/i], field: "org" },
  { keys: [/^职位$|^职务$|^头衔$|^title$|position|job/i], field: "title" },
  { keys: [/微信|weixin|wechat/i], field: "wechat" },
  { keys: [/^手机$|^电话$|^phone$|^mobile$|tel/i], field: "phone" },
  { keys: [/邮箱|e-?mail/i], field: "email" },
  { keys: [/^城市$|^地区$|^所在地$|city/i], field: "city" },
  { keys: [/备注|说明|介绍|note|remark/i], field: "note" },
];

/** 解析 CSV 文本 → 联系人列表（识别不出任何姓名时返回空数组） */
export function parseCsvContacts(raw: string): CsvContact[] {
  const rows = splitCsv(raw.replace(/^\uFEFF/, ""));
  if (!rows.length) return [];

  // 判断第一行是不是表头：含"姓名/名字/昵称/name"或任意已知列名
  const first = rows[0].map((h) => h.trim());
  const headerLike = first.some((h) => /^(姓名|名字|昵称|名称|name|full ?name)$/i.test(h)) ||
    first.some((h) => HEADER_MAP.some(({ keys }) => keys.some((k) => k.test(h))));

  let dataRows = rows;
  let colByName = new Map<string, number>();
  if (headerLike) {
    dataRows = rows.slice(1);
    first.forEach((h, i) => colByName.set(h, i));
  }

  const nameIdx = headerLike
    ? first.findIndex((h) => /^(姓名|名字|昵称|名称|name|full ?name)$/i.test(h))
    : 0;

  const fieldIdx = new Map<keyof Omit<CsvContact, "name">, number>();
  if (headerLike) {
    for (const { keys, field } of HEADER_MAP) {
      const idx = first.findIndex((h) => keys.some((k) => k.test(h)));
      if (idx >= 0 && idx !== nameIdx) fieldIdx.set(field, idx);
    }
  } else {
    // 无表头：常见顺序 姓名,公司,职位,电话,微信 —— 只映射能对上的
    first.forEach((h, i) => {
      for (const { keys, field } of HEADER_MAP) {
        if (keys.some((k) => k.test(h)) && !fieldIdx.has(field) && i !== 0) fieldIdx.set(field, i);
      }
    });
  }

  const contacts: CsvContact[] = [];
  for (const row of dataRows) {
    const name = (row[nameIdx] ?? "").trim();
    if (!name) continue;
    const c: CsvContact = { name };
    for (const [field, idx] of fieldIdx) {
      const v = (row[idx] ?? "").trim();
      if (v && v !== name) c[field] = v;
    }
    contacts.push(c);
  }
  return contacts;
}
