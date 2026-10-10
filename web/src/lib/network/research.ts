// 组织联网检索：必应国内版搜索 → 抓取结果页 → DeepSeek 综合出组织画像

export type SearchHit = { title: string; url: string; snippet: string };

/** 必应国内版搜索（服务器直连可达，HTML 服务端渲染可解析） */
export async function searchWeb(query: string, maxHits = 6): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=zh-CN`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`搜索返回 ${res.status}`);
    const html = await res.text();
    return parseBingResults(html, maxHits);
  } finally {
    clearTimeout(timer);
  }
}

function parseBingResults(html: string, maxHits: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  // 抓所有外链 + 锚文本；过滤必应/微软自身与备案页
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < maxHits * 3) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (/bing\.com|microsoft|msn\.com|miit\.gov|mps\.gov|go\.msft/i.test(url)) continue;
    if (!text || text.length < 8) continue;
    // 去掉形如 "baidu.comhttps://baike.baidu.com › …" 的面包屑前缀标题
    const title = text.replace(/^[\w.-]+https?:\/\/\S+/, "").trim() || text;
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 120), url, snippet: "" });
  }
  // 命中数不够再放宽
  return hits.slice(0, maxHits);
}
