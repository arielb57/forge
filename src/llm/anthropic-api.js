import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../log.js';

const exec = promisify(execFile);

/**
 * The API driver exists so the pipeline outlives a Claude Code subscription:
 * same behaviour, billed per token instead. It owns its agent loop rather than
 * using the SDK tool runner, because the sandbox rules below — every path
 * confined to one directory, every command matched against an allowlist — are
 * the reason this is safe to run unattended, and they belong in the loop.
 */

const MODEL = process.env.FORGE_API_MODEL || 'claude-opus-5';

/** Same posture as the CLI driver: build tooling only, nothing that reaches out. */
const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'node', 'python3', 'pip3', 'uv', 'pytest', 'cargo',
  'mkdir', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'sed', 'chmod',
  'cp', 'mv', 'touch', 'echo', 'test',
]);

/** Reject anything that could escape the project directory. */
function safePath(root, candidate) {
  const full = resolve(root, candidate);
  const rel = relative(root, full);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`path escapes the project directory: ${candidate}`);
  }
  return full;
}

const TOOLS = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file, relative to the project root. Parent directories are created automatically.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the project root' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a file relative to the project root.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description: 'Recursively list files under a directory relative to the project root.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory, "." for the root' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run a build or test command inside the project root. Only local build tooling is permitted ' +
      `(${[...ALLOWED_COMMANDS].join(', ')}); network and VCS commands are rejected.`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name, e.g. "npm"' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments' },
      },
      required: ['command', 'args'],
      additionalProperties: false,
    },
  },
];

function walk(dir, root, out = [], depth = 0) {
  if (depth > 8 || out.length > 800) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.venv')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out, depth + 1);
    else out.push(relative(root, full));
  }
  return out;
}

async function runTool(root, name, input) {
  switch (name) {
    case 'write_file': {
      const full = safePath(root, input.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, input.content);
      return `wrote ${input.path} (${input.content.length} bytes)`;
    }
    case 'read_file': {
      const full = safePath(root, input.path);
      return readFileSync(full, 'utf8').slice(0, 60_000);
    }
    case 'list_files': {
      const full = safePath(root, input.path || '.');
      if (!statSync(full).isDirectory()) throw new Error(`${input.path} is not a directory`);
      return walk(full, root).join('\n') || '(empty)';
    }
    case 'run_command': {
      if (!ALLOWED_COMMANDS.has(input.command)) {
        throw new Error(`command "${input.command}" is not on the allowlist`);
      }
      const { stdout, stderr } = await exec(input.command, input.args || [], {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 30_000) || '(no output)';
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function loadSdk() {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return mod.default || mod;
  } catch {
    throw new Error(
      'the anthropic-api driver needs the SDK: npm install @anthropic-ai/sdk (and set ANTHROPIC_API_KEY)',
    );
  }
}

export function createAnthropicApiDriver({ model = MODEL } = {}) {
  let client = null;
  const getClient = async () => {
    if (!client) {
      const Anthropic = await loadSdk();
      client = new Anthropic();
    }
    return client;
  };

  return {
    name: 'anthropic-api',

    async think(prompt, { system, effort = 'high' } = {}) {
      const anthropic = await getClient();
      // Streaming even for "short" calls: ideation output is long JSON and a
      // non-streaming request can hit the SDK's HTTP timeout.
      const stream = anthropic.messages.stream({
        model,
        max_tokens: 32_000,
        ...(system ? { system } : {}),
        thinking: { type: 'adaptive' },
        output_config: { effort },
        messages: [{ role: 'user', content: prompt }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new Error(`request declined: ${message.stop_details?.explanation || 'no explanation'}`);
      }
      return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    },

    async build(prompt, { cwd, system, maxTurns = 120 } = {}) {
      const anthropic = await getClient();
      const messages = [{ role: 'user', content: prompt }];
      let turns = 0;
      let lastText = '';

      while (turns < maxTurns) {
        turns += 1;
        const stream = anthropic.messages.stream({
          model,
          max_tokens: 64_000,
          ...(system ? { system } : {}),
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          tools: TOOLS,
          messages,
        });
        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
          throw new Error(`build declined: ${message.stop_details?.explanation || 'no explanation'}`);
        }

        lastText = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || lastText;
        messages.push({ role: 'assistant', content: message.content });

        const calls = message.content.filter((b) => b.type === 'tool_use');
        if (calls.length === 0) break;

        // Every tool_result for one assistant turn goes back in a single user
        // message — splitting them teaches the model to stop calling in parallel.
        const results = await Promise.all(
          calls.map(async (call) => {
            try {
              const output = await runTool(cwd, call.name, call.input);
              return { type: 'tool_result', tool_use_id: call.id, content: String(output) };
            } catch (err) {
              return {
                type: 'tool_result',
                tool_use_id: call.id,
                content: `error: ${err.message}`,
                is_error: true,
              };
            }
          }),
        );
        messages.push({ role: 'user', content: results });
      }

      if (turns >= maxTurns) log.warn(`build hit the ${maxTurns}-turn ceiling`);
      return { text: lastText, turns };
    },
  };
}
