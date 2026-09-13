import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getDriver } from './llm/index.js';
import { log } from './log.js';

function renderPrompt(spec) {
  const template = readFileSync(join(config.root, 'prompts', 'build.md'), 'utf8');
  return template
    .replace('{{NAME}}', spec.name)
    .replace('{{TAGLINE}}', spec.tagline)
    .replace('{{LANGUAGE}}', spec.language)
    .replace('{{PROBLEM}}', spec.problem)
    .replace('{{CORE}}', spec.core)
    .replace('{{DELIVERABLES}}', (spec.deliverables || []).map((d) => `\n  - ${d}`).join(''))
    .replace('{{VERIFICATION}}', spec.verification)
    .replace('{{BENCHMARK}}', spec.benchmark || 'none — this project makes no performance claim');
}

/**
 * Prompt for a build that ran out of time. Ambitious specs routinely use the
 * whole budget on the core and its tests, and the brief puts the README last —
 * so a timeout tends to land on a project that is nearly complete and would
 * fail the gate on documentation alone. Throwing that away is wasteful; giving
 * it a second, focused session is not.
 */
function resumePrompt(spec, blocking) {
  const brief = readFileSync(join(config.root, 'prompts', 'build.md'), 'utf8');
  const marker = '## What "done" means';
  const requirements = brief.includes(marker) ? marker + brief.split(marker)[1] : brief;

  return [
    `You are finishing **${spec.name}** — ${spec.tagline}`,
    '',
    'A previous session ran out of time partway through. The code already on',
    'disk is yours: read it first, keep it, and complete what is missing.',
    'Do not start over and do not rewrite code that already works.',
    '',
    blocking?.length
      ? `The quality gate currently rejects this project for:\n${blocking.map((b) => `  - ${b}`).join('\n')}`
      : 'Work out what is missing against the requirements below.',
    '',
    requirements,
    '',
    'Finish, run the full test suite one final time, and stop.',
  ].join('\n');
}

/**
 * Build one project into its own directory. The agent gets the directory and
 * nothing else: no git, no remote, no reach outside it. Everything it produces
 * is inspected by the quality gate before a human ever sees it.
 */
export async function buildProject(spec, { fresh = true } = {}) {
  const dir = join(config.workspace, spec.name);

  if (fresh && existsSync(dir)) {
    log.warn(`clearing previous build at ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });

  const driver = getDriver();
  const started = Date.now();
  log.step(`building ${spec.name} (${spec.language})`);

  const result = await driver.build(renderPrompt(spec), {
    cwd: dir,
    timeoutMs: config.buildTimeoutMinutes * 60_000,
    system:
      'You are a careful open-source engineer shipping a small, complete, well-tested project. ' +
      'You never leave placeholders and you never claim a test suite passes without running it.',
  });

  const durationMs = Date.now() - started;
  log.ok(`${spec.name} built in ${Math.round(durationMs / 1000)}s${result.turns ? ` (${result.turns} turns)` : ''}`);

  return {
    dir,
    durationMs,
    turns: result.turns ?? null,
    costUsd: result.costUsd ?? null,
    summary: (result.text || '').slice(0, 4000),
  };
}

/**
 * Re-enter an existing build directory to finish an incomplete project.
 * Used by `forge continue`, and only ever on a directory forge itself built.
 */
export async function resumeBuild(spec, dir, blocking) {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist — nothing to resume`);

  const driver = getDriver();
  const started = Date.now();
  log.step(`resuming ${spec.name}`);

  const result = await driver.build(resumePrompt(spec, blocking), {
    cwd: dir,
    timeoutMs: config.buildTimeoutMinutes * 60_000,
    system:
      'You are finishing a project another session started. Read what is there before changing anything. ' +
      'You never leave placeholders and you never claim a test suite passes without running it.',
  });

  const durationMs = Date.now() - started;
  log.ok(`${spec.name} resumed in ${Math.round(durationMs / 1000)}s`);
  return { dir, durationMs, turns: result.turns ?? null, summary: (result.text || '').slice(0, 4000) };
}
