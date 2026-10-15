// 联网搜索：搜狗优先（国内可达、无验证码、中文质量好）→ 必应兜底。
// 百度 302 验证码墙、DDG 202 反爬、jina 免费通道关闭——都已弃用。

export type SearchHit = { title: string; url: string; snippet: string };

export async function searchWeb(query: string, maxHits = 6): Promise<SearchHit[]> {
  try {
    const hits = await sogouSearch(query, maxHits);
    if (hits.length) return hits;
  } catch { /* 走兜底 */ }
  return bingSearch(query, maxHits);
}

const SOGOU_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function sogouSearch(query: string, maxHits: number): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": SOGOU_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`sogou ${res.status}`);
    const html = await res.text();
    // 疑似验证码页（体积很小）直接判失败走兜底
    if (html.length < 20_000) throw new Error("sogou captcha");
    return parseSogouResults(html, maxHits);
  } finally {
    clearTimeout(timer);
  }
}

function parseSogouResults(html: string, maxHits: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < maxHits) {
    let url = m[1];
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (url.startsWith("/link?url=")) url = `https://www.sogou.com${url}`; // 相对跳转链补全
    if (!/^https?:\/\//.test(url) || /sogou\.com\/(?:web|pic|weibo|v)/.test(url)) continue;
    if (!title || title.length < 4 || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 140), url, snippet: "" });
  }
  return hits;
}

async function bingSearch(query: string, maxHits: number): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=zh-CN`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`bing ${res.status}`);
    return parseBingResults(await res.text(), maxHits);
  } finally {
    clearTimeout(timer);
  }
}

function parseBingResults(html: string, maxHits: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < maxHits * 3) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (/bing\.com|microsoft|msn\.com|miit\.gov|mps\.gov|go\.msft/i.test(url)) continue;
    if (!text || text.length < 8) continue;
    const title = text.replace(/^[\w.-]+https?:\/\/\S+/, "").trim() || text;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 120), url, snippet: "" });
  }
  return hits.slice(0, maxHits);
}
