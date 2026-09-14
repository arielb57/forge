import { getJson } from './http.js';
import { execFileSync } from 'node:child_process';

/** Reuse the gh CLI token when present: 5000 req/h instead of 60. */
function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Topics people actually tag finance repositories with. Deliberately excludes
 * `trading-bot` and `cryptocurrency`: those return price tickers and strategy
 * repos, which the ideation brief rules out anyway, and they would crowd out
 * everything else.
 */
const TOPICS = [
  'quantitative-finance',
  'market-microstructure',
  'order-book',
  'fix-protocol',
  'derivatives-pricing',
  'risk-management',
  'fintech',
  'algorithmic-trading',
];

/**
 * Finance repositories with recent traction.
 *
 * The general sources here — Hacker News, Lobsters — are not finance feeds, so
 * a brief that requires a finance angle would otherwise be working entirely
 * from trends that have nothing to do with it. This and arXiv's q-fin
 * categories are the two that do.
 */
export const githubFinance = {
  name: 'github-finance',
  weight: 1.05,
  async collect({ windowDays = 400, perTopic = 8, minStars = 25 } = {}) {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    const token = ghToken();
    const headers = {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };

    // GitHub combines repeated `topic:` qualifiers with AND, so one query
    // listing every topic matches nothing. Each topic is its own search.
    const searches = await Promise.allSettled(
      TOPICS.map(async (topic) => {
        const q = encodeURIComponent(`topic:${topic} pushed:>${since} stars:>${minStars}`);
        const url = `https://api.github.com/search/repositories?q=${q}&sort=updated&order=desc&per_page=${perTopic}`;
        const data = await getJson(url, { headers });
        return data.items || [];
      }),
    );

    const seen = new Set();
    const items = [];
    for (const result of searches) {
      if (result.status !== 'fulfilled') continue;
      for (const r of result.value) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        items.push({
          source: 'github-finance',
          title: `${r.name} — ${r.description || 'no description'}`.slice(0, 200),
          url: r.html_url,
          // Ranked by activity rather than raw stars: an old, large, quiet
          // project says less about where the work is now than a busy one.
          score: r.stargazers_count + r.forks_count * 3,
          createdAt: r.pushed_at,
          meta: {
            stars: r.stargazers_count,
            forks: r.forks_count,
            language: r.language,
            topics: r.topics || [],
          },
        });
      }
    }
    return items;
  },
};
