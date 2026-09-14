#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { getTrends } from '../src/trends.js';
import { ideate } from '../src/ideate.js';
import { runDaily } from '../src/pipeline.js';
import { runGate } from '../src/gate.js';
import { resumeBuild } from '../src/build.js';
import { preflight } from '../src/preflight.js';
import { clean } from '../src/clean.js';
import { publishProject, writeManifest } from '../src/publish.js';
import { load, recordProject, findProject, STATUS } from '../src/store.js';
import { config } from '../src/config.js';
import { log } from '../src/log.js';

const HELP = `
forge — mines daily engineering trends and builds complete, tested projects

  forge trends              Show today's ranked trends and stop
  forge ideate              Show the project specs today's trends produce
  forge run [--target N]    Full pipeline: trends -> specs -> build -> quality gate
  forge review              List projects waiting for your review
  forge show <name>         Print one project's gate report and file listing
  forge gate <name>         Re-run the quality gate on a built project
  forge continue <name>     Give an unfinished build another session
  forge ship <name>         Publish a reviewed project to GitHub
  forge clean [--all]       Delete build artefacts of published projects
  forge doctor              Check this machine can run a build
  forge status              Ledger summary
  forge help

Flags
  --target N     Projects to ship this run (default ${config.projectsPerDay})
  --dry-run      Go through the motions without building or pushing
  --json         Machine-readable output where it applies

Publishing is never automatic. \`forge run\` stops at the review queue;
only \`forge ship\` pushes anything to GitHub.
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--target') { flags.target = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--target=')) flags.target = Number(arg.split('=')[1]);
    else positional.push(arg);
  }
  return { flags, positional };
}

const fmt = {
  status: (s) => ({
    [STATUS.REVIEW]: 'ready for review',
    [STATUS.SHIPPED]: 'published',
    [STATUS.REJECTED]: 'rejected',
    [STATUS.BUILT]: 'built',
    [STATUS.SPEC]: 'spec only',
  }[s] || s),
};

async function cmdTrends(flags) {
  const { trends } = await getTrends();
  if (flags.json) { console.log(JSON.stringify(trends, null, 2)); return; }
  log.blank();
  trends.forEach((t, i) => {
    console.log(`${i + 1}. [${t.score}] ${t.title}`);
    console.log(`   ${t.corroborated ? `corroborated: ${t.sources.join(', ')}` : t.sources[0]}`);
    if (t.url) console.log(`   ${t.url}`);
    console.log('');
  });
}

async function cmdIdeate(flags) {
  const { trends } = await getTrends();
  const specs = await ideate(trends);
  if (flags.json) { console.log(JSON.stringify(specs, null, 2)); return; }
  log.blank();
  for (const s of specs) {
    console.log(`## ${s.name}  [${s.language}]`);
    console.log(`   ${s.tagline}`);
    console.log(`   from: ${s.trend_origin}`);
    console.log(`   core: ${s.core.slice(0, 240)}`);
    console.log(`   why:  ${s.why_starred}`);
    console.log('');
  }
}

function cmdReview(flags) {
  const state = load();
  const waiting = state.projects.filter((p) => p.status === STATUS.REVIEW);
  if (flags.json) { console.log(JSON.stringify(waiting, null, 2)); return; }

  if (waiting.length === 0) {
    console.log('\nNothing waiting for review. Run `forge run` to build today\'s projects.\n');
    return;
  }

  console.log(`\n${waiting.length} project(s) waiting for review:\n`);
  for (const p of waiting) {
    const s = p.gate?.stats || {};
    console.log(`  ${p.name}  [${p.language}]`);
    console.log(`    ${p.tagline}`);
    console.log(`    ${s.testCases || 0} tests, ${s.assertions || 0} assertions, ${s.readmeWords || 0}-word README`);
    if (p.gate?.warnings?.length) console.log(`    warnings: ${p.gate.warnings.join('; ')}`);
    console.log(`    ${p.dir}`);
    console.log('');
  }
  console.log('Read the code, then: forge ship <name>\n');
}

function cmdShow(name) {
  const project = findProject(name);
  if (!project) { log.error(`no project named "${name}"`); process.exitCode = 1; return; }
  console.log(JSON.stringify(project, null, 2));
}

async function cmdGate(name) {
  const project = findProject(name);
  if (!project?.dir) { log.error(`no built project named "${name}"`); process.exitCode = 1; return; }
  const gate = await runGate(project.dir, project);
  recordProject({ id: project.id, gate, status: gate.passed ? STATUS.REVIEW : STATUS.REJECTED });
  console.log(JSON.stringify(gate, null, 2));
}

/**
 * Hand an unfinished build another session. Ambitious projects routinely spend
 * the whole budget on the core and its tests, and the brief writes the README
 * last — so a timeout often lands on something nearly complete.
 */
async function cmdContinue(name) {
  const project = findProject(name);
  if (!project?.dir || !existsSync(project.dir)) {
    log.error(`no built project named "${name}"`);
    process.exitCode = 1;
    return;
  }

  await resumeBuild(project, project.dir, project.gate?.blocking);

  const gate = await runGate(project.dir, project);
  recordProject({ id: project.id, gate, status: gate.passed ? STATUS.REVIEW : STATUS.REJECTED });

  if (gate.passed) log.ok(`${name} now passes — review it, then: forge ship ${name}`);
  else log.error(`${name} still rejected:\n  ${gate.blocking.join('\n  ')}`);
}

async function cmdShip(name, flags) {
  const project = findProject(name);
  if (!project) { log.error(`no project named "${name}"`); process.exitCode = 1; return; }
  if (!project.dir || !existsSync(project.dir)) {
    log.error(`${name} has no build on disk`);
    process.exitCode = 1;
    return;
  }
  if (project.status === STATUS.SHIPPED) {
    log.warn(`${name} is already published: ${project.url}`);
    return;
  }
  if (project.status !== STATUS.REVIEW && !flags.yes) {
    log.error(`${name} is "${fmt.status(project.status)}", not reviewed. Re-run the gate, or pass --yes to override.`);
    process.exitCode = 1;
    return;
  }

  writeManifest(project.dir, project, project.gate);
  const result = await publishProject(project, project.dir, { dryRun: flags.dryRun });
  if (!result.dryRun) {
    recordProject({ id: project.id, status: STATUS.SHIPPED, url: result.url, repo: result.repo, shippedAt: new Date().toISOString() });
  }
}

function cmdStatus(flags) {
  const state = load();
  if (flags.json) { console.log(JSON.stringify({ runs: state.runs.slice(0, 10), projects: state.projects }, null, 2)); return; }

  const by = (s) => state.projects.filter((p) => p.status === s).length;
  const languages = {};
  for (const p of state.projects) {
    if (p.status === STATUS.SHIPPED) languages[p.language] = (languages[p.language] || 0) + 1;
  }

  console.log(`
forge status
  runs            ${state.runs.length}
  projects        ${state.projects.length}
    published     ${by(STATUS.SHIPPED)}
    in review     ${by(STATUS.REVIEW)}
    rejected      ${by(STATUS.REJECTED)}
  languages       ${Object.entries(languages).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}
  driver          ${config.driver} (${config.model})
  workspace       ${config.workspace}
`);

  const last = state.runs[0];
  if (last) {
    console.log(`  last run      ${last.at?.slice(0, 16).replace('T', ' ')} — ${last.passed}/${last.built} passed the gate\n`);
  }
}

async function cmdDoctor() {
  try {
    const env = await preflight({ requirePublisher: true });
    console.log(`
Ready to build.
  free space    ${env.free.toFixed(1)} GB
  toolchains    ${Object.entries(env.available).filter(([, ok]) => ok).map(([k]) => k).join(', ') || 'none'}
  driver        ${config.driver} (${config.model})
`);
  } catch {
    console.log('\nNot ready — fix the problems above and run `forge doctor` again.\n');
    process.exitCode = 1;
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'help';

  switch (command) {
    case 'trends': return cmdTrends(flags);
    case 'ideate': return cmdIdeate(flags);
    case 'run': return void (await runDaily({ target: flags.target || config.projectsPerDay, dryRun: flags.dryRun }));
    case 'review': return cmdReview(flags);
    case 'show': return cmdShow(positional[1]);
    case 'gate': return cmdGate(positional[1]);
    case 'continue': return void (await cmdContinue(positional[1]));
    case 'ship': return cmdShip(positional[1], flags);
    case 'clean': return void clean({ all: flags.all, dryRun: flags.dryRun });
    case 'doctor': return void (await cmdDoctor());
    case 'status': return cmdStatus(flags);
    case 'help': case '--help': case '-h': return void console.log(HELP);
    default:
      log.error(`unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error(err.message);
  if (process.env.FORGE_DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
