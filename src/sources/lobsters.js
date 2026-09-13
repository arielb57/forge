import { getJson } from './http.js';

/**
 * Lobsters skews to systems, languages and tooling — the topics Hacker News
 * under-weights in favour of product launches. Having both keeps the pipeline
 * from producing ten variations on the same AI wrapper.
 */
export const lobsters = {
  name: 'lobsters',
  weight: 0.95,
  async collect({ limit = 25 } = {}) {
    const data = await getJson('https://lobste.rs/hottest.json');
    return (Array.isArray(data) ? data : []).slice(0, limit).map((s) => ({
      source: 'lobsters',
      title: s.title,
      url: s.url || s.short_id_url,
      discussion: s.comments_url,
      score: (s.score || 0) * 3 + (s.comment_count || 0) * 2,
      createdAt: s.created_at,
      meta: { tags: s.tags || [], comments: s.comment_count },
    }));
  },
};
