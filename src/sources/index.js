import { hackernews, showhn } from './hackernews.js';
import { githubRising } from './github.js';
import { arxiv } from './arxiv.js';
import { lobsters } from './lobsters.js';
import { huggingface } from './huggingface.js';
import { log } from '../log.js';

export const SOURCES = [hackernews, showhn, githubRising, arxiv, lobsters, huggingface];

/**
 * Collect from every source in parallel. A source that is down, rate-limited or
 * has changed its API must not take the day's run with it — the pipeline is
 * useful with four sources out of six, and useless if one outage stops it.
 */
export async function collectAll(options = {}) {
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const items = await source.collect(options[source.name] || {});
      return items.map((item) => ({ ...item, weight: source.weight }));
    }),
  );

  const items = [];
  const health = [];
  results.forEach((result, i) => {
    const source = SOURCES[i];
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      health.push({ source: source.name, ok: true, count: result.value.length });
      log.info(`${source.name}: ${result.value.length} items`);
    } else {
      health.push({ source: source.name, ok: false, error: String(result.reason?.message || result.reason) });
      log.warn(`${source.name} unavailable: ${result.reason?.message || result.reason}`);
    }
  });

  const live = health.filter((h) => h.ok).length;
  if (live === 0) throw new Error('every trend source failed — check network connectivity');
  if (live < 3) log.warn(`only ${live}/${SOURCES.length} sources responded; trend quality will be poor`);

  return { items, health };
}
