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
    if (new Date(p.createdAt).getTime() < cutoff) return false;
    const against = `${p.name} ${p.tagline || ''} ${(p.topics || []).join(' ')}`;
    return similarity(tokens, tokenize(against)) >= threshold;
  });
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

export function findProject(idOrName, state = load()) {
  return state.projects.find((p) => p.id === idOrName || p.name === idOrName) || null;
}

export const STATUS = Object.freeze({
  SPEC: 'spec',           // ideated, not yet built
  BUILT: 'built',         // code on disk, gate not yet run
  REJECTED: 'rejected',   // failed the quality gate
  REVIEW: 'review',       // passed the gate, waiting for a human
  SHIPPED: 'shipped',     // pushed to GitHub by an explicit `forge ship`
});
