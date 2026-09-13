import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTrends } from './trends.js';
import { ideate } from './ideate.js';
import { buildProject } from './build.js';
import { runGate } from './gate.js';
import { writeManifest } from './publish.js';
import { recordProject, recordRun, STATUS } from './store.js';
import { preflight } from './preflight.js';
import { config } from './config.js';
import { log } from './log.js';

/**
 * One day's run: find what the world is talking about, decide what is worth
 * building, build it, and prove it works. The run stops at the review queue.
 * Publishing is a separate, human-initiated command — see `forge ship`.
 */
export async function runDaily({ target = config.projectsPerDay, dryRun = false } = {}) {
  const runId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  log.blank();
  log.step(`run ${runId} — target ${target} project(s)`);

  // Fail here, legibly, rather than three quarters of the way through a build
  // with an ENOSPC from inside npm that nobody will read until tomorrow.
  const environment = await preflight();

  const { trends, health, totalItems } = await getTrends();
  if (trends.length === 0) {
    log.warn('no fresh trends today — everything on the front pages is already covered');
    recordRun({ id: runId, trends: 0, built: 0, passed: 0, note: 'no fresh trends' });
    return { runId, shipped: [], rejected: [] };
  }

  log.blank();
  trends.forEach((t, i) => log.info(`trend ${i + 1}: ${t.title.slice(0, 80)} [${t.sources.join(', ')}]`));
  log.blank();

  const specs = await ideate(trends);
  if (specs.length === 0) throw new Error('no usable specs came out of ideation');

  const passed = [];
  const rejected = [];

  for (const spec of specs) {
    if (passed.length >= target) {
      log.info(`target of ${target} reached — not building ${spec.name}`);
      break;
    }

    const id = `${runId}-${spec.name}`;
    recordProject({ id, ...spec, runId, status: STATUS.SPEC });

    if (dryRun) {
      log.info(`dry run: would build ${spec.name}`);
      passed.push({ id, spec, dryRun: true });
      continue;
    }

    let build;
    try {
      build = await buildProject(spec);
    } catch (err) {
      log.error(`build failed for ${spec.name}: ${err.message}`);
      // Record the directory even on failure. A timeout usually leaves a nearly
      // complete project on disk, and without the path `forge continue` cannot
      // find the work to finish it.
      const partial = join(config.workspace, spec.name);
      const salvageable = existsSync(partial);
      recordProject({
        id,
        status: STATUS.REJECTED,
        error: err.message,
        ...(salvageable ? { dir: partial } : {}),
      });
      if (salvageable) log.info(`partial build kept — finish it with: forge continue ${spec.name}`);
      rejected.push({ spec, reason: `build error: ${err.message}` });
      continue;
    }

    recordProject({ id, status: STATUS.BUILT, dir: build.dir, buildMs: build.durationMs });

    let gate;
    try {
      gate = await runGate(build.dir, spec);
    } catch (err) {
      log.error(`gate crashed on ${spec.name}: ${err.message}`);
      recordProject({ id, status: STATUS.REJECTED, error: `gate crashed: ${err.message}` });
      rejected.push({ spec, reason: `gate crashed: ${err.message}` });
      continue;
    }

    if (!gate.passed) {
      recordProject({ id, status: STATUS.REJECTED, gate });
      rejected.push({ spec, reason: gate.blocking.join(' | ') });
      continue;
    }

    writeManifest(build.dir, spec, gate);
    recordProject({ id, status: STATUS.REVIEW, gate, dir: build.dir });
    passed.push({ id, spec, dir: build.dir, gate });
    log.ok(`${spec.name} is ready for review`);
  }

  const durationMin = Math.round((Date.now() - startedAt) / 60_000);
  recordRun({
    id: runId,
    trends: trends.length,
    totalItems,
    sources: health,
    // Kept so a failed run can be diagnosed later without guessing what the
    // machine looked like at the time.
    environment: { freeGb: Number(environment.free.toFixed(1)), toolchains: environment.available },
    built: passed.length + rejected.length,
    passed: passed.length,
    durationMin,
  });

  log.blank();
  log.ok(`run ${runId} finished in ${durationMin} min — ${passed.length} ready, ${rejected.length} rejected`);
  if (passed.length > 0) {
    log.info('review them with:  forge review');
    log.info('then publish with: forge ship <name>');
  }

  return { runId, shipped: passed, rejected };
}
