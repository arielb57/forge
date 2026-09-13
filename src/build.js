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
 * Build one project into its own directory. The agent gets the directory and
 * nothing else: no git, no remote, no network. Everything it produces is
 * inspected by the quality gate before a human ever sees it.
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
