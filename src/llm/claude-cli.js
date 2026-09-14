import { spawn } from 'node:child_process';
import { log } from '../log.js';

/**
 * Tools a build agent is allowed: writing its own files, and the package
 * managers and test runners it needs to prove they work. Nothing that touches
 * git remotes — publishing is forge's job, never the model's.
 *
 * Glob and Grep are deliberately absent. They take an explicit `path` and
 * honour no workspace boundary, so an agent that cannot find a dependency uses
 * them to search the whole disk: an early run went hunting for a TypeScript
 * compiler and started reading an unrelated private project's node_modules.
 * A project being built from an empty directory has nothing to search, so
 * removing them costs nothing and closes the escape hatch.
 */
const BUILD_TOOLS = [
  'Read', 'Write', 'Edit',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
  'Bash(python3:*)', 'Bash(pip3:*)', 'Bash(uv:*)', 'Bash(pytest:*)',
  'Bash(cargo:*)', 'Bash(mkdir:*)', 'Bash(ls:*)', 'Bash(wc:*)',
  'Bash(chmod:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(touch:*)', 'Bash(echo:*)',
];

function run(args, { cwd, timeoutMs, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      // SIGTERM first, then insist — a wedged build must not hold the day's run.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      reject(new Error(`claude timed out after ${Math.round(timeoutMs / 60_000)} min`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not start claude: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.slice(-500) || stdout.slice(-500);
        // A usage limit is not a failed build: retrying costs nothing but
        // wall-clock, and the caller needs to stop rather than burn through
        // every remaining spec in thirty seconds.
        const limit = detail.match(/(?:session limit|usage limit|rate limit)[^"]*?(?:resets?[^"]*?)?(?=["}]|$)/i);
        if (limit || /"api_error_status":\s*429/.test(detail)) {
          const err = new Error(`usage limit reached${limit ? ` — ${limit[0].trim()}` : ''}`);
          err.rateLimited = true;
          reject(err);
          return;
        }
        reject(new Error(`claude exited ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export function createClaudeCliDriver({ model = 'opus' } = {}) {
  return {
    name: 'claude-cli',

    /** Text/JSON generation with no tools and no filesystem access. */
    async think(prompt, { timeoutMs = 300_000, system } = {}) {
      const args = [
        '-p', '--output-format', 'json', '--model', model,
        '--restricted', // removes Bash and every code-execution tool
        ...(system ? ['--append-system-prompt', system] : []),
      ];
      const raw = await run(args, { cwd: process.cwd(), timeoutMs, input: prompt });
      try {
        const envelope = JSON.parse(raw);
        return envelope.result ?? envelope.text ?? raw;
      } catch {
        return raw; // older CLI versions print bare text
      }
    },

    /** Tool-using build inside a single directory. */
    async build(prompt, { cwd, timeoutMs = 1_500_000, system } = {}) {
      const args = [
        '-p', '--output-format', 'json', '--model', model,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', ...BUILD_TOOLS,
        '--add-dir', cwd,
        ...(system ? ['--append-system-prompt', system] : []),
      ];
      log.info(`claude build in ${cwd}`);
      const raw = await run(args, { cwd, timeoutMs, input: prompt });
      try {
        const envelope = JSON.parse(raw);
        return {
          text: envelope.result ?? '',
          turns: envelope.num_turns,
          costUsd: envelope.total_cost_usd,
          durationMs: envelope.duration_ms,
        };
      } catch {
        return { text: raw };
      }
    },
  };
}
