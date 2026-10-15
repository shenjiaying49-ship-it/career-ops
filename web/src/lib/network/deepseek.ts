// DeepSeek API 直连客户端（OpenAI 兼容格式）
// key 从环境变量 DEEPSEEK_API_KEY 读取（career-ops/web/.env.local 或 shell env）

const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("未配置 DEEPSEEK_API_KEY：请在 career-ops/web/.env.local 里加入 DEEPSEEK_API_KEY=sk-… 后重启服务");
  }
  return key;
}

/** 调 DeepSeek chat，强制 JSON 输出，返回原始 content 字符串 */
export async function deepseekJson(
  system: string,
  user: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string> {
  // AtomClub 中转的 401 是间歇性的（坏时段连着来）：最多试 3 次，指数退避
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOnce(system, user, opts);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof Error && err.message.includes("401"))) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function callOnce(
  system: string,
  user: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 90_000);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        max_tokens: opts?.maxTokens ?? 2000,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("DeepSeek API key 无效（401），检查 .env.local 里的 DEEPSEEK_API_KEY");
      throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    let content = choice?.message?.content;
    if (!content || !content.trim()) {
      // 空返回两种情况：思考型模型 token 被推理吃光（带 reasoning_content），
      // 或中转偶发空响应。都加大预算重试一次。
      const retried = await retryWithBiggerBudget(system, user, opts);
      if (retried && retried.trim()) return retried;
      if (choice?.message?.reasoning_content) {
        throw new Error("模型只返回了推理内容没有答案（已自动加大预算重试仍失败），换非思考型模型如 deepseek-v4-flash");
      }
      throw new Error("DeepSeek 返回为空");
    }
    return content;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("DeepSeek 请求超时，重试一次");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 思考型模型 token 不够时：推理 + 3x 预算重试一次 */
async function retryWithBiggerBudget(
  system: string,
  user: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string | null> {
  const budget = (opts?.maxTokens ?? 2000) * 3 + 2000;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        max_tokens: budget,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** 服务端抓取网页 → 纯文本。先直连（快），失败或内容太少走 r.jina.ai 渲染兜底
 * （能处理 JS 单页应用和直连不稳的海外站点）。 */
export async function fetchPageText(url: string, maxChars = 12_000): Promise<string> {
  let direct = "";
  try {
    direct = await directFetchText(url, maxChars);
  } catch { /* 走兜底 */ }
  if (direct.length >= 200) return direct;

  try {
    return await jinaFetchText(url, maxChars);
  } catch (err) {
    // 兜底也失败：直连有一点内容就用一点，否则抛出可读错误
    if (direct.length >= 50) return direct;
    const cause = err instanceof Error && err.cause ? String(err.cause) : "";
    throw new Error(
      err instanceof Error && err.name === "AbortError"
        ? "网页抓取超时（直连和渲染通道都不通）"
        : `网页抓取失败: ${err instanceof Error ? err.message : "unknown"}${cause ? ` (${cause})` : ""}`,
    );
  }
}

async function directFetchText(url: string, maxChars: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`网页返回 ${res.status}，可能需要登录或是反爬拦截`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf")) throw new Error("暂不支持 PDF 链接，换一个网页链接试试");
    const html = await res.text();
    return htmlToText(html).slice(0, maxChars);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("网页抓取超时");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function jinaFetchText(url: string, maxChars: number): Promise<string> {
  // r.jina.ai 在部分网络下时通时断：自动重试 2 次
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await fetch(`https://r.jina.ai/${url}`, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) throw new Error(`渲染通道返回 ${res.status}`);
      const text = await res.text();
      // jina 返回 markdown（"Title: …\nURL Source: …\nMarkdown Content:\n…"），已是纯文本
      return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("渲染通道失败");
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
