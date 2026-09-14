import { getText, extractTags, stripXml } from './http.js';

// q-fin carries the computational-finance, microstructure, risk and pricing
// feeds. They are the only source here that is finance-native, so they are
// listed first: the RSS reader takes a fixed slice per category.
const CATEGORIES = ['q-fin.CP', 'q-fin.TR', 'q-fin.RM', 'q-fin.PR', 'cs.LG', 'cs.SE'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * arXiv's export API throttles aggressively and answers 429 to whole IP ranges,
 * so the RSS service is the primary transport and the API is only a fallback.
 *
 * The feed carries `<skipDays>Saturday, Sunday</skipDays>` and is genuinely
 * empty at weekends — an empty result here is normal, not a failure.
 */
async function viaRss(category) {
  const xml = await getText(`https://rss.arxiv.org/rss/${category}`, { timeoutMs: 20_000, retries: 1 });
  return extractTags(xml, 'item').map((item) => ({
    title: stripXml(extractTags(item, 'title')[0] || ''),
    link: stripXml(extractTags(item, 'link')[0] || ''),
    abstract: stripXml(extractTags(item, 'description')[0] || '').replace(/^Abstract:\s*/i, ''),
    published: stripXml(extractTags(item, 'pubDate')[0] || ''),
  }));
}

async function viaApi(limit) {
  const q = CATEGORIES.map((c) => `cat:${c}`).join('+OR+');
  const xml = await getText(
    `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`,
    { timeoutMs: 25_000, retries: 0 },
  );
  return extractTags(xml, 'entry').map((entry) => ({
    title: stripXml(extractTags(entry, 'title')[0] || ''),
    link: ((entry.match(/<id>([^<]+)<\/id>/) || [])[1] || '').trim(),
    abstract: stripXml(extractTags(entry, 'summary')[0] || ''),
    published: stripXml(extractTags(entry, 'published')[0] || ''),
  }));
}

/**
 * Recent arXiv submissions. Papers are the one source with no popularity
 * signal at all, which is precisely their value here: they push the pipeline
 * toward work that has not been packaged as a tool yet.
 */
export const arxiv = {
  name: 'arxiv',
  weight: 0.85,
  async collect({ limit = 24, perCategory = 10 } = {}) {
    const raw = [];
    for (const category of CATEGORIES) {
      try {
        raw.push(...(await viaRss(category)).slice(0, perCategory));
      } catch { /* try the next category rather than abandoning the source */ }
      await sleep(400); // stay well inside arXiv's rate guidance
    }

    if (raw.length === 0) {
      // Weekend, or RSS is down. The API is worth one attempt before giving up.
      try {
        raw.push(...(await viaApi(limit)));
      } catch { /* an empty arXiv day is acceptable; other sources carry the run */ }
    }

    const seen = new Set();
    return raw
      .filter((e) => e.title && !seen.has(e.link) && seen.add(e.link))
      .slice(0, limit)
      .map((e, index) => ({
        source: 'arxiv',
        title: e.title,
        url: e.link,
        // No stars or upvotes exist here, so rank by recency within the batch.
        score: Math.max(10, 60 - index * 2),
        createdAt: e.published,
        meta: { abstract: e.abstract.slice(0, 700) },
      }));
  },
};
