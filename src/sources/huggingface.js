import { getJson } from './http.js';

/**
 * Models trending on Hugging Face this week. A model climbing here usually has
 * no decent tooling around it yet, which is a reliable source of briefs that
 * are useful rather than decorative.
 */
export const huggingface = {
  name: 'huggingface',
  weight: 0.9,
  async collect({ limit = 20 } = {}) {
    const url = `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${limit}&full=false`;
    const data = await getJson(url);
    return (Array.isArray(data) ? data : []).map((m) => ({
      source: 'huggingface',
      title: `${m.modelId || m.id} (${(m.pipeline_tag || 'model').replace(/-/g, ' ')})`,
      url: `https://huggingface.co/${m.modelId || m.id}`,
      score: (m.likes || 0) * 2 + Math.log10((m.downloads || 0) + 1) * 20,
      createdAt: m.createdAt || m.lastModified,
      meta: { likes: m.likes, downloads: m.downloads, task: m.pipeline_tag, tags: m.tags || [] },
    }));
  },
};
