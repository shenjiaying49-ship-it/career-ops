// ─── vCard（.vcf）解析：Mac 通讯录 / iPhone 导出的联系人 → 结构化联系人 ───
// 无外部依赖，支持 vCard 2.1/3.0/4.0、quoted-printable 中文、item 分组、PHOTO 数据跳过。

export type VcfContact = {
  name: string;
  org?: string;
  title?: string;
  wechat?: string;
  phone?: string;
  email?: string;
  city?: string;
  note?: string;
};

/** quoted-printable 解码（=XX），UTF-8 */
function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

/** 按规范展开折叠行（以空格/Tab 开头的行接上一行；QP 编码行以 = 结尾也算延续） */
function unfold(raw: string): string[] {
  const lines = raw.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!out.length) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    if (/^[ \t]/.test(line)) {
      out[out.length - 1] = prev + line.slice(1);
    } else if (prev.endsWith("=") && /ENCODING=QUOTED-PRINTABLE/i.test(prev)) {
      out[out.length - 1] = prev.slice(0, -1) + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeValue(value: string, params: string): string {
  let v = value;
  if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) v = decodeQuotedPrintable(v);
  // vCard 默认就是 UTF-8；旧版可能给 CHARSET=UTF-8，TextDecoder 已处理
  v = v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
  return v.trim();
}

/** 解析 .vcf 文本 → 联系人列表（解析失败返回空数组） */
export function parseVcf(raw: string): VcfContact[] {
  const contacts: VcfContact[] = [];
  let cur: Partial<VcfContact> | null = null;

  for (const line of unfold(raw)) {
    if (/^BEGIN:VCARD/i.test(line)) {
      cur = {};
      continue;
    }
    if (/^END:VCARD/i.test(line)) {
      if (cur && (cur.name || cur.wechat || cur.phone)) {
        contacts.push({
          name: cur.name || cur.wechat || cur.phone || "未命名",
          org: cur.org || undefined,
          title: cur.title || undefined,
          wechat: cur.wechat || undefined,
          phone: cur.phone || undefined,
          email: cur.email || undefined,
          city: cur.city || undefined,
          note: cur.note || undefined,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    // 形如  [group.]PROP[;PARAM=..;..]:VALUE  —— PHOTO/LOGO/SOUND 等大数据直接跳过
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (/^(PHOTO|LOGO|SOUND|AGENT|KEY|X-ABPHOTO)/i.test(left.split(";").pop() ?? "")) continue;

    const parts = left.split(";");
    const propRaw = parts[0] ?? "";
    const prop = propRaw.replace(/^item\d+\./i, "").toUpperCase();
    const params = parts.slice(1).join(";");

    // 只取首选值（N 是 姓;名;… 结构，FN 是完整显示名，优先 FN）
    const first = (v: string) => decodeValue(v.split(";")[0] ?? "", params);
    const full = (v: string) => decodeValue(v, params);

    switch (prop) {
      case "FN":
        cur.name = cur.name || full(value) || undefined;
        break;
      case "N":
        if (!cur.name) {
          const seg = value.split(";");
          cur.name = decodeValue(seg.slice(0, 2).reverse().filter(Boolean).join(" ") || seg[0] || "", params) || undefined;
        }
        break;
      case "ORG":
        cur.org = cur.org || first(value) || undefined;
        break;
      case "TITLE":
        cur.title = cur.title || full(value) || undefined;
        break;
      case "TEL":
        if (!cur.phone) cur.phone = full(value) || undefined;
        break;
      case "EMAIL":
        if (!cur.email) cur.email = full(value) || undefined;
        break;
      case "ADR":
        if (!cur.city) {
          const seg = value.split(";");
          cur.city = decodeValue(seg[3] ?? "", params) || undefined;
        }
        break;
      case "NOTE":
        cur.note = cur.note || full(value) || undefined;
        break;
      case "X-WECHAT":
      case "X-WEIXIN":
        cur.wechat = cur.wechat || full(value) || undefined;
        break;
      default:
        // 微信号常被存在各种自定义字段里（微信/QQ/alias）
        if (/WECHAT|WEIXIN/i.test(prop) && !cur.wechat) cur.wechat = full(value) || undefined;
        break;
    }
  }
  return contacts;
}
