import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTrends } from './trends.js';
import { ideate } from './ideate.js';
import { buildProject, resumeBuild } from './build.js';
import { runGate } from './gate.js';
import { writeManifest } from './publish.js';
import { recordProject, recordRun, findInterrupted, STATUS } from './store.js';
import { preflight } from './preflight.js';
import { clean } from './clean.js';
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

  // Finish interrupted work before starting new work. A build killed from
  // outside has already been paid for; resuming it costs a fraction of a fresh
  // build and skips ideation entirely.
  const resumed = [];
  if (!dryRun) {
    const hasWork = (dir) => existsSync(dir) && readdirSync(dir).length > 0;
    for (const project of findInterrupted(undefined, hasWork)) {
      if (resumed.length >= target) break;
      log.step(`resuming interrupted build ${project.name}`);
      try {
        await resumeBuild(project, project.dir, project.gate?.blocking);
      } catch (err) {
        if (err.rateLimited) throw err;
        log.error(`could not resume ${project.name}: ${err.message}`);
        recordProject({ id: project.id, status: STATUS.REJECTED, error: `resume failed: ${err.message}` });
        continue;
      }
      const gate = await runGate(project.dir, project);
      if (gate.passed) {
        writeManifest(project.dir, project, gate);
        recordProject({ id: project.id, status: STATUS.REVIEW, gate });
        resumed.push(project.name);
        log.ok(`${project.name} is ready for review`);
      } else {
        recordProject({ id: project.id, status: STATUS.REJECTED, gate });
      }
    }
    if (resumed.length >= target) {
      log.ok(`target reached by resuming ${resumed.join(', ')} — no new ideation this run`);
      recordRun({ id: runId, trends: 0, built: resumed.length, passed: resumed.length, note: 'resumed interrupted builds' });
      return { runId, shipped: resumed.map((name) => ({ spec: { name } })), rejected: [] };
    }
  }

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
  let rateLimited = null;

  for (const spec of specs) {
    if (passed.length + resumed.length >= target) {
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

    // Note the directory before the build starts. If the process is killed
    // mid-build nothing else gets recorded, and this is what lets the next run
    // find the work and resume it.
    recordProject({ id, dir: join(config.workspace, spec.name, 'repo') });

    let build;
    try {
      build = await buildProject(spec);
    } catch (err) {
      // Record the directory on every failure, a usage limit included. A
      // stopped build usually leaves real work on disk — at minimum the README
      // written as a design document — and without the path `forge continue`
      // cannot find it. The limit branch used to break out before this ran.
      // Nested is the sandbox layout in build.js; flat is the older layout.
      const nested = join(config.workspace, spec.name, 'repo');
      const flat = join(config.workspace, spec.name);
      const partial = existsSync(nested) ? nested : flat;
      const salvageable = existsSync(partial);

      recordProject({
        id,
        status: STATUS.REJECTED,
        error: err.message,
        ...(salvageable ? { dir: partial } : {}),
      });
      if (salvageable) log.info(`partial build kept — finish it with: forge continue ${spec.name}`);

      if (err.rateLimited) {
        log.error(`stopping the run: ${err.message}`);
        rateLimited = err;
        break;
      }
      log.error(`build failed for ${spec.name}: ${err.message}`);
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
    // Kept so the next run looks further down the ranking instead of
    // re-proposing today's front page.
    usedTrends: trends.map((t) => t.title),
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
  if (rateLimited) {
    const err = new Error(rateLimited.message);
    err.rateLimited = true;
    log.ok(`run ${runId} stopped after ${durationMin} min — ${passed.length} ready`);
    if (passed.length > 0) log.info('review them with:  forge review');
    throw err;
  }
  log.ok(`run ${runId} finished in ${durationMin} min — ${passed.length} ready, ${rejected.length} rejected`);
  if (passed.length > 0) {
    log.info('review them with:  forge review');
    log.info('then publish with: forge ship <name>');
  }

  return { runId, shipped: passed, rejected };
}

/**
 * Run the pipeline repeatedly.
 *
 * Between iterations it sweeps the build artefacts of anything already
 * published, because a Rust `target/` is ~350 MB and three unattended runs
 * will otherwise fill a disk that had room for thirty. Preflight runs at the
 * start of every iteration, so a loop that runs out of space stops with a
 * clear reason instead of failing halfway through a build.
 */
export async function runRepeatedly({ times = Infinity, target = config.projectsPerDay } = {}) {
  const results = [];

  for (let i = 1; i <= times; i += 1) {
    log.blank();
    log.step(`iteration ${i}${Number.isFinite(times) ? ` of ${times}` : ''}`);

    try {
      results.push(await runDaily({ target }));
    } catch (err) {
      log.error(`iteration ${i} stopped: ${err.message}`);
      // Preflight failures and usage limits are conditions a later iteration
      // hits too. Without this the loop spends every remaining iteration
      // failing in seconds and reports ten attempts that never ran.
      if (err.rateLimited) {
        log.error('not continuing — start the loop again once the limit resets');
        break;
      }
      if (/preflight/.test(err.message)) {
        log.error('not continuing — fix the environment and start the loop again');
        break;
      }
      results.push({ error: err.message });
    }

    if (i < times) {
      const { freed } = clean();
      if (freed > 0) log.info(`swept ${(freed / 1024 ** 2).toFixed(0)} MB before the next iteration`);
    }
  }

  const shipped = results.reduce((n, r) => n + (r.shipped?.length || 0), 0);
  log.blank();
  log.ok(`${results.length} iteration(s), ${shipped} project(s) ready for review`);
  return results;
}
