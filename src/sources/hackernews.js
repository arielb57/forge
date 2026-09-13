import { getJson } from './http.js';

const API = 'https://hn.algolia.com/api/v1/search';

/**
 * Hacker News front page over the last two days. Points and comment count are
 * combined because a story with heavy discussion signals an unsolved problem,
 * which is exactly what makes a good project brief.
 */
export const hackernews = {
  name: 'hackernews',
  weight: 1.0,
  async collect({ windowHours = 48, limit = 40 } = {}) {
    const since = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);
    const url = `${API}?tags=story&numericFilters=created_at_i>${since},points>40&hitsPerPage=${limit}`;
    const data = await getJson(url);
    return (data.hits || [])
      .filter((h) => h.title)
      .map((h) => ({
        source: 'hackernews',
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        score: (h.points || 0) + (h.num_comments || 0) * 1.5,
        createdAt: h.created_at,
        meta: { points: h.points, comments: h.num_comments },
      }));
  },
};

/**
 * Show HN separately: these are people shipping things, which is the closest
 * signal to "a project like this is worth building right now".
 */
export const showhn = {
  name: 'show-hn',
  weight: 1.15,
  async collect({ windowHours = 96, limit = 25 } = {}) {
    const since = Math.floor((Date.now() - windowHours * 3_600_000) / 1000);
    const url = `${API}?tags=show_hn&numericFilters=created_at_i>${since},points>15&hitsPerPage=${limit}`;
    const data = await getJson(url);
    return (data.hits || [])
      .filter((h) => h.title)
      .map((h) => ({
        source: 'show-hn',
        title: h.title.replace(/^Show HN:\s*/i, ''),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        score: (h.points || 0) + (h.num_comments || 0) * 1.5,
        createdAt: h.created_at,
        meta: { points: h.points, comments: h.num_comments },
      }));
  },
};
