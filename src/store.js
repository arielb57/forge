import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const LEDGER = () => join(config.dataDir, 'ledger.json');

const EMPTY = {
  version: 1,
  createdAt: null,
  runs: [],      // one entry per daily pipeline run
  projects: [],  // one entry per project, from spec through to published URL
};

function ensureDir() {
  mkdirSync(config.dataDir, { recursive: true });
}

export function load() {
  ensureDir();
  const path = LEDGER();
  if (!existsSync(path)) return { ...EMPTY, createdAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...EMPTY, ...parsed };
  } catch (err) {
    // A corrupt ledger must not silently erase months of history.
    const backup = `${path}.corrupt-${Date.now()}`;
    renameSync(path, backup);
    throw new Error(`ledger.json was unreadable (${err.message}); moved to ${backup}`);
  }
}

export function save(state) {
  ensureDir();
  const path = LEDGER();
  const tmp = `${path}.tmp`;
  // Write-then-rename so an interrupted run cannot leave a half-written ledger.
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return result;
}

/** Normalised tokens used for near-duplicate detection across topics. */
export function tokenize(text) {
  const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on', 'at',
    'by', 'from', 'is', 'are', 'be', 'that', 'this', 'it', 'as', 'your', 'you',
    'using', 'use', 'via', 'how', 'why', 'what', 'new', 'open', 'source',
  ]);
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Jaccard overlap in [0,1]. 1 means the two token sets are identical. */
export function similarity(a, b) {
  const setA = a instanceof Set ? a : tokenize(a);
  const setB = b instanceof Set ? b : tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/**
 * True when we have already shipped something close enough to `topic` that a
 * reader would see the same project twice.
 */
export function isRecentlyCovered(topic, state = load(), threshold = 0.45) {
  const cutoff = Date.now() - config.topicCooldownDays * 86_400_000;
  const tokens = tokenize(topic);
  return state.projects.some((p) => {
    // Only work that exists counts. A spec killed mid-build, or one a usage
    // limit stopped, was blocking every similar idea as though it had shipped.
    if (!COVERING.has(p.status)) return false;
    if (new Date(p.createdAt).getTime() < cutoff) return false;
    const against = `${p.name} ${p.tagline || ''} ${(p.topics || []).join(' ')}`;
    return similarity(tokens, tokenize(against)) >= threshold;
  });
}

/**
 * Trend titles this pipeline has already turned into specs.
 *
 * Front pages move over days, not hours, so two runs an hour apart see almost
 * the same five trends. Without this, a back-to-back run re-proposes what the
 * previous one just built, and the only thing standing between that and a
 * duplicate repository is a name check.
 */
export function usedTrendTitles(state = load(), days = 7) {
  const cutoff = Date.now() - days * 86_400_000;
  const titles = [];
  for (const run of state.runs) {
    if (new Date(run.at).getTime() < cutoff) continue;
    for (const title of run.usedTrends || []) titles.push(title);
  }
  return titles;
}

/** True when `title` names a trend a recent run already worked from. */
export function isTrendUsed(title, state = load()) {
  const tokens = tokenize(title);
  return usedTrendTitles(state).some((used) => similarity(tokens, tokenize(used)) >= 0.6);
}

export function recordRun(entry) {
  return update((state) => {
    state.runs.unshift({ id: entry.id, at: new Date().toISOString(), ...entry });
    state.runs = state.runs.slice(0, 400);
    return state.runs[0];
  });
}

export function recordProject(project) {
  return update((state) => {
    const existing = state.projects.findIndex((p) => p.id === project.id);
    if (existing >= 0) {
      state.projects[existing] = { ...state.projects[existing], ...project };
      return state.projects[existing];
    }
    state.projects.unshift({ createdAt: new Date().toISOString(), ...project });
    return state.projects[0];
  });
}

/**
 * Builds that were stopped from outside — the process killed, not failed — and
 * left work on disk worth resuming.
 *
 * A killed process runs no catch block, so it records nothing: the project
 * stays at `spec` with whatever directory was noted when the build began.
 * Usage-limit stops are included too. Gate rejections are not: resuming the
 * same spec after the gate refused it would just produce the same refusal.
 */
export function findInterrupted(state = load(), hasWork = () => true) {
  const shippedNames = new Set(
    state.projects.filter((p) => p.status === STATUS.SHIPPED || p.status === STATUS.REVIEW).map((p) => p.name),
  );
  const seen = new Set();
  return state.projects
    .filter((p) => {
      if (!p.dir || shippedNames.has(p.name) || seen.has(p.name)) return false;
      const killed = p.status === STATUS.SPEC;
      const limited = p.status === STATUS.REJECTED && /usage limit/i.test(String(p.error || ''));
      if (!(killed || limited) || !hasWork(p.dir)) return false;
      seen.add(p.name);
      return true;
    })
    .reverse(); // oldest first: finish what was started earliest
}

export function findProject(idOrName, state = load()) {
  return state.projects.find((p) => p.id === idOrName || p.name === idOrName) || null;
}

/** Statuses that mean the project exists and a duplicate should be avoided. */
const COVERING = new Set(['shipped', 'review']);

export const STATUS = Object.freeze({
  SPEC: 'spec',           // ideated, not yet built
  BUILT: 'built',         // code on disk, gate not yet run
  REJECTED: 'rejected',   // failed the quality gate
  REVIEW: 'review',       // passed the gate, waiting for a human
  SHIPPED: 'shipped',     // pushed to GitHub by an explicit `forge ship`
});
