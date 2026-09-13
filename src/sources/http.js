const UA = 'forge/1.0 (+https://github.com/arielb57/forge)';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a timeout, a polite User-Agent, and retries on the failures that
 * are actually worth retrying (network blips, 429, 5xx). A 404 or a 403 is a
 * real answer and comes straight back as an error.
 */
export async function request(url, { timeoutMs = 15_000, retries = 2, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': UA, accept: 'application/json, text/xml, */*', ...headers },
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => '');
      lastError = new HttpError(res.status, url, body.slice(0, 300));
      if (!retryable) throw lastError;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && !(err.status === 429 || err.status >= 500)) throw err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(600 * 2 ** attempt);
  }
  throw lastError;
}

export async function getJson(url, opts) {
  const res = await request(url, opts);
  return res.json();
}

export async function getText(url, opts) {
  const res = await request(url, opts);
  return res.text();
}

/** Minimal tag extraction — enough for the two Atom feeds we read, no XML dep. */
export function extractTags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let match;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

export function stripXml(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
