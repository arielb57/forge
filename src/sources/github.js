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
 * Repositories created in the last few weeks that already have traction. A new
 * repo climbing fast is a live problem with an audience — the ideal seed for a
 * project that will not read as an exercise.
 */
export const githubRising = {
  name: 'github-rising',
  weight: 1.1,
  async collect({ windowDays = 21, limit = 30, minStars = 120 } = {}) {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    const q = encodeURIComponent(`created:>${since} stars:>${minStars}`);
    const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`;
    const token = ghToken();
    const data = await getJson(url, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    return (data.items || []).map((r) => ({
      source: 'github-rising',
      title: `${r.name} — ${r.description || 'no description'}`.slice(0, 200),
      url: r.html_url,
      score: r.stargazers_count,
      createdAt: r.created_at,
      meta: {
        stars: r.stargazers_count,
        language: r.language,
        topics: r.topics || [],
        starsPerDay: Math.round(
          r.stargazers_count / Math.max(1, (Date.now() - new Date(r.created_at)) / 86_400_000),
        ),
      },
    }));
  },
};
