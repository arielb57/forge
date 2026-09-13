import { spawn } from 'node:child_process';
import { log } from '../log.js';

/**
 * Commands a build agent is allowed to run. Deliberately narrow: package
 * managers, test runners and local file inspection. Nothing that reaches the
 * network, mutates anything outside the project directory, or touches git
 * remotes — publishing is forge's job, never the model's.
 */
const BUILD_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)',
  'Bash(python3:*)', 'Bash(pip3:*)', 'Bash(uv:*)', 'Bash(pytest:*)',
  'Bash(cargo:*)', 'Bash(mkdir:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(sed:*)', 'Bash(grep:*)',
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
        reject(new Error(`claude exited ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`));
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
