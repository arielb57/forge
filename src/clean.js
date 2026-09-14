import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { load, STATUS } from './store.js';
import { log } from './log.js';

/**
 * Build artefacts, not sources. A single Rust project's `target/` runs to
 * 160 MB and a Node project's `node_modules/` to 200 MB, so a fortnight of
 * daily runs fills a disk long before the code itself becomes large.
 */
const ARTEFACTS = ['target', 'node_modules', 'dist', '.venv', 'venv', '__pycache__', 'coverage', '.pytest_cache'];

function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    let info;
    try {
      info = statSync(current);
    } catch { continue; }
    if (info.isDirectory()) {
      try {
        for (const entry of readdirSync(current)) stack.push(join(current, entry));
      } catch { /* unreadable directory: skip rather than fail the sweep */ }
    } else {
      total += info.size;
    }
  }
  return total;
}

const mb = (bytes) => (bytes / 1024 ** 2).toFixed(0);

/**
 * Remove build artefacts from projects that are already published. Sources are
 * never touched, and a project still waiting for review is left completely
 * alone — it may still need `forge continue`, and that needs its dependencies.
 */
export function clean({ all = false, dryRun = false } = {}) {
  if (!existsSync(config.workspace)) {
    log.info('no workspace to clean');
    return { freed: 0, cleaned: [] };
  }

  const state = load();
  const shippable = new Set(
    state.projects.filter((p) => p.status === STATUS.SHIPPED).map((p) => p.name),
  );

  let freed = 0;
  const cleaned = [];

  for (const name of readdirSync(config.workspace)) {
    const dir = join(config.workspace, name);
    if (!statSync(dir).isDirectory()) continue;

    if (!all && !shippable.has(name)) {
      log.info(`skipping ${name} — not published yet`);
      continue;
    }

    // Builds are nested one level inside a per-project sandbox; older ones sit
    // flat in the workspace. Sweep both rather than silently missing half.
    const roots = [dir, join(dir, 'repo')].filter((r) => existsSync(r));

    let projectFreed = 0;
    for (const root of roots) {
      for (const artefact of ARTEFACTS) {
        const path = join(root, artefact);
        if (!existsSync(path)) continue;
        const size = sizeOf(path);
        projectFreed += size;
        if (!dryRun) rmSync(path, { recursive: true, force: true });
      }
    }

    if (projectFreed > 0) {
      freed += projectFreed;
      cleaned.push({ name, freedMb: Number(mb(projectFreed)) });
      log.ok(`${dryRun ? 'would free' : 'freed'} ${mb(projectFreed)} MB from ${name}`);
    }
  }

  if (cleaned.length === 0) log.info('nothing to clean');
  else log.ok(`${dryRun ? 'would free' : 'freed'} ${mb(freed)} MB in total`);

  return { freed, cleaned };
}
