import { collectAll } from './sources/index.js';
import { tokenize, similarity, isRecentlyCovered, load } from './store.js';
import { log } from './log.js';
import { config } from './config.js';

/**
 * Raw scores are not comparable across sources: Hugging Face counts downloads
 * in the millions, Lobsters counts upvotes in the dozens. Ranking within each
 * source and keeping only the percentile puts every item on the same axis.
 */
function normalizeWithinSource(items) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }

  const out = [];
  for (const group of bySource.values()) {
    const sorted = [...group].sort((a, b) => b.score - a.score);
    const n = sorted.length;
    sorted.forEach((item, index) => {
      // Top item scores 1, last scores just above 0.
      const percentile = n === 1 ? 1 : 1 - index / (n - 1);
      out.push({ ...item, rawScore: item.score, normalized: percentile });
    });
  }
  return out;
}

/** Items older than a few days matter less; nothing is discarded outright. */
function recencyFactor(createdAt) {
  if (!createdAt) return 0.85;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0.85;
  return Math.max(0.35, Math.exp(-ageDays / 10));
}

/**
 * Single-link clustering over title tokens. The point is cross-source
 * corroboration: the same story on Hacker News, Lobsters and GitHub in one day
 * is a real trend, whereas one front page is just one front page.
 */
export function cluster(items, threshold = 0.34) {
  const clusters = [];
  for (const item of items) {
    const tokens = tokenize(`${item.title} ${(item.meta?.topics || item.meta?.tags || []).join(' ')}`);
    let placed = false;
    for (const c of clusters) {
      if (similarity(tokens, c.tokens) >= threshold) {
        c.items.push(item);
        for (const t of tokens) c.tokens.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ tokens, items: [item] });
  }
  return clusters;
}

function scoreCluster(c) {
  const sources = new Set(c.items.map((i) => i.source));
  const base = c.items.reduce(
    (sum, i) => sum + i.normalized * (i.weight ?? 1) * recencyFactor(i.createdAt),
    0,
  );
  // Corroboration is sub-linear: three sources is much better than one, but not
  // three times better — otherwise every cluster collapses toward the biggest.
  const corroboration = 1 + Math.log2(sources.size) * 0.6;
  return { score: base * corroboration, sources: [...sources] };
}

/**
 * Produce the day's ranked trends: normalised, clustered, corroborated, and
 * filtered against everything the pipeline has already shipped.
 */
export async function getTrends({ limit = config.trendsPerDay, skipDedup = false } = {}) {
  log.step('collecting trend sources');
  const { items, health } = await collectAll();

  const normalized = normalizeWithinSource(items);
  const clusters = cluster(normalized);

  const state = load();
  const ranked = clusters
    .map((c) => {
      const { score, sources } = scoreCluster(c);
      const lead = [...c.items].sort((a, b) => b.normalized - a.normalized)[0];
      return {
        title: lead.title,
        url: lead.url,
        score: Number(score.toFixed(3)),
        sources,
        corroborated: sources.length > 1,
        evidence: c.items
          .sort((a, b) => b.normalized - a.normalized)
          .slice(0, 5)
          .map((i) => ({
            source: i.source,
            title: i.title,
            url: i.url,
            signal: i.meta?.stars ? `${i.meta.stars}★`
              : i.meta?.points ? `${i.meta.points} pts`
              : i.meta?.likes ? `${i.meta.likes} likes`
              : i.meta?.comments ? `${i.meta.comments} comments`
              : null,
          })),
        context: c.items.map((i) => i.meta?.abstract).find(Boolean) || null,
      };
    })
    .sort((a, b) => b.score - a.score);

  const fresh = skipDedup
    ? ranked
    : ranked.filter((t) => {
        if (isRecentlyCovered(t.title, state)) {
          log.info(`skipping "${t.title.slice(0, 60)}" — too close to something already shipped`);
          return false;
        }
        return true;
      });

  log.ok(`${fresh.length} candidate trends from ${items.length} items across ${health.filter((h) => h.ok).length} sources`);
  return { trends: fresh.slice(0, limit), health, totalItems: items.length };
}
