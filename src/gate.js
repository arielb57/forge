import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { countTestSignals, findPlaceholders as scanPlaceholders, assessReadmeText, judgeTests } from './analyze.js';
import { log } from './log.js';

const exec = promisify(execFile);

/**
 * The quality gate is what stops the pipeline from becoming a repository mill.
 * Anything it rejects never reaches the review queue, let alone GitHub.
 *
 * Checks are graded: BLOCKING failures reject the project outright, WARNINGS
 * are reported and travel with the project into review so a human sees them.
 */

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.rs', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '__pycache__', 'dist', 'build', '.venv', 'venv']);

function walk(dir, root = dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out, depth + 1);
    else out.push({ path: full, rel: relative(root, full) });
  }
  return out;
}

async function run(command, args, cwd, timeoutMs = 600_000) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout || ''}${err.stderr || ''}${err.message}`,
      timedOut: err.killed === true,
    };
  }
}

function detectToolchain(dir) {
  if (existsSync(join(dir, 'package.json'))) return 'node';
  if (existsSync(join(dir, 'Cargo.toml'))) return 'rust';
  if (
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'setup.py')) ||
    existsSync(join(dir, 'requirements.txt')) ||
    walk(dir).some((f) => extname(f.rel) === '.py')
  ) return 'python';
  return null;
}

/** Install dependencies and run the language's standard test command. */
async function runTests(dir, toolchain) {
  switch (toolchain) {
    case 'node': {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const hasDeps =
        Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
      if (hasDeps) {
        const install = await run('npm', ['install', '--no-audit', '--no-fund'], dir, 420_000);
        if (!install.ok) return { ...install, phase: 'install' };
      }
      if (!pkg.scripts?.test) return { ok: false, output: 'package.json declares no test script', phase: 'test' };
      return { ...(await run('npm', ['test'], dir)), phase: 'test' };
    }
    case 'python': {
      // uv is present and fast; fall back to the interpreter's own module runner.
      const withUv = await run('uv', ['run', '--quiet', 'pytest', '-q'], dir, 420_000);
      if (withUv.ok) return { ...withUv, phase: 'test' };
      const direct = await run('python3', ['-m', 'pytest', '-q'], dir, 420_000);
      if (direct.ok) return { ...direct, phase: 'test' };
      // Report whichever attempt got furthest rather than the last one blindly.
      const chosen = withUv.output.length > direct.output.length ? withUv : direct;
      return { ...chosen, phase: 'test' };
    }
    case 'rust':
      return { ...(await run('cargo', ['test', '--quiet'], dir, 600_000)), phase: 'test' };
    default:
      return { ok: false, output: 'no recognised toolchain', phase: 'detect' };
  }
}

/**
 * Run the project's own linter, when it declares one.
 *
 * The gate used to run only the test suite, and passed a project whose CI then
 * failed on a clippy lint — the generated workflows run `clippy -D warnings`
 * and `cargo fmt --check`, so a project that fails those is broken on arrival
 * no matter how green its tests are. Whatever CI enforces, the gate enforces.
 */
async function runLint(dir, toolchain) {
  switch (toolchain) {
    case 'rust': {
      const fmt = await run('cargo', ['fmt', '--all', '--check'], dir, 120_000);
      if (!fmt.ok) return { ok: false, output: fmt.output, tool: 'cargo fmt' };
      const clippy = await run('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'], dir, 600_000);
      return { ok: clippy.ok, output: clippy.output, tool: 'cargo clippy' };
    }
    case 'node': {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (!pkg.scripts?.lint) return { ok: true, skipped: true };
      const lint = await run('npm', ['run', 'lint'], dir, 300_000);
      return { ok: lint.ok, output: lint.output, tool: 'npm run lint' };
    }
    case 'python': {
      if (!existsSync(join(dir, 'ruff.toml')) && !existsSync(join(dir, 'pyproject.toml'))) {
        return { ok: true, skipped: true };
      }
      const ruff = await run('uv', ['run', '--quiet', 'ruff', 'check', '.'], dir, 180_000);
      // No ruff configured is not a failure; a ruff that runs and complains is.
      if (!ruff.ok && /No such file|not found|unrecognized/i.test(ruff.output)) {
        return { ok: true, skipped: true };
      }
      return { ok: ruff.ok, output: ruff.output, tool: 'ruff check' };
    }
    default:
      return { ok: true, skipped: true };
  }
}

/**
 * Aggregate the per-file signals across the whole suite. The judgement itself
 * lives in analyze.js, where it is tested against the exact code shapes it has
 * to catch.
 */
function assessTests(dir) {
  const files = walk(dir).filter((f) => {
    const name = f.rel.toLowerCase();
    return (
      SOURCE_EXTENSIONS.has(extname(f.rel)) &&
      (name.includes('test') || name.includes('spec') || name.startsWith('tests/'))
    );
  });

  const total = { cases: 0, assertions: 0, trivial: 0, files: files.length };
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch { continue; }
    const counts = countTestSignals(text);
    total.cases += counts.cases;
    total.assertions += counts.assertions;
    total.trivial += counts.trivial;
  }
  return total;
}

function findPlaceholders(dir) {
  const hits = [];
  for (const file of walk(dir)) {
    if (!SOURCE_EXTENSIONS.has(extname(file.rel)) && extname(file.rel) !== '.md') continue;
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch { continue; }
    for (const hit of scanPlaceholders(text)) hits.push(`${file.rel}:${hit.line} ${hit.text}`);
  }
  return hits;
}

function assessReadme(dir) {
  const path = ['README.md', 'readme.md', 'Readme.md'].map((n) => join(dir, n)).find(existsSync);
  if (!path) return { exists: false };
  return { exists: true, ...assessReadmeText(readFileSync(path, 'utf8')) };
}

export async function runGate(dir, spec) {
  const blocking = [];
  const warnings = [];

  const toolchain = detectToolchain(dir);
  if (!toolchain) {
    return { passed: false, blocking: ['no recognisable project (no package.json, Cargo.toml or Python sources)'], warnings: [], toolchain: null };
  }

  const sourceFiles = walk(dir).filter((f) => SOURCE_EXTENSIONS.has(extname(f.rel)));
  if (sourceFiles.length < 2) blocking.push(`only ${sourceFiles.length} source file(s) — nothing was really built`);

  log.info(`gate: running ${toolchain} test suite`);
  const tests = await runTests(dir, toolchain);
  if (!tests.ok) {
    const tail = tests.output.split('\n').filter(Boolean).slice(-12).join('\n');
    blocking.push(`${tests.phase} failed${tests.timedOut ? ' (timed out)' : ''}:\n${tail}`);
  }

  const suite = assessTests(dir);
  blocking.push(...judgeTests(suite));

  // Only worth linting a project whose tests already pass; a compile error
  // would otherwise be reported twice in different words.
  let lint = { ok: true, skipped: true };
  if (tests.ok) {
    log.info(`gate: linting`);
    lint = await runLint(dir, toolchain);
    if (!lint.ok) {
      const tail = lint.output.split('\n').filter(Boolean).slice(-14).join('\n');
      blocking.push(`${lint.tool} failed — the project's own CI runs this and would reject it:\n${tail}`);
    }
  }

  const placeholders = findPlaceholders(dir);
  if (placeholders.length > 0) {
    blocking.push(`${placeholders.length} placeholder(s) left in the code:\n  ${placeholders.slice(0, 6).join('\n  ')}`);
  }

  const readme = assessReadme(dir);
  if (!readme.exists) blocking.push('no README.md');
  else {
    if (readme.words < 250) blocking.push(`README is ${readme.words} words — too thin for a stranger to use this`);
    if (!readme.hasCodeBlock) blocking.push('README has no code block — no usage a reader can copy');
    if (!readme.explainsApproach) blocking.push('README never explains how it works');
    if (!readme.hasUsage) warnings.push('README has no clear install/usage section');
    if (!readme.hasLimitations) warnings.push('README states no limitations — reviewers read that section first');
  }

  if (!existsSync(join(dir, 'LICENSE'))) warnings.push('no LICENSE file');
  if (!existsSync(join(dir, '.gitignore'))) warnings.push('no .gitignore');
  if (!existsSync(join(dir, '.github', 'workflows'))) warnings.push('no CI workflow');

  if (spec?.benchmark && spec.benchmark !== 'null') {
    const hasBench = walk(dir).some((f) => /bench|perf/i.test(f.rel));
    if (!hasBench) warnings.push('the spec promised a benchmark and none is present');
  }

  const passed = blocking.length === 0;
  const report = {
    passed,
    blocking,
    warnings,
    toolchain,
    stats: {
      sourceFiles: sourceFiles.length,
      testFiles: suite.files,
      testCases: suite.cases,
      assertions: suite.assertions,
      readmeWords: readme.words || 0,
      testsPassed: tests.ok,
      lintPassed: lint.skipped ? null : lint.ok,
    },
    testOutput: tests.output.split('\n').filter(Boolean).slice(-25).join('\n'),
  };

  if (passed) log.ok(`gate passed: ${suite.cases} tests, ${suite.assertions} assertions, ${readme.words}-word README`);
  else log.error(`gate rejected ${spec?.name || dir}: ${blocking.length} blocking issue(s)`);
  for (const w of warnings) log.warn(`  warning: ${w}`);

  return report;
}
