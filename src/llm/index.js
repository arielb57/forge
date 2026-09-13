import { createClaudeCliDriver } from './claude-cli.js';
import { createAnthropicApiDriver } from './anthropic-api.js';
import { config } from '../config.js';

const DRIVERS = {
  'claude-cli': createClaudeCliDriver,
  'anthropic-api': createAnthropicApiDriver,
};

export function getDriver(name = config.driver) {
  const factory = DRIVERS[name];
  if (!factory) {
    throw new Error(`unknown driver "${name}" (available: ${Object.keys(DRIVERS).join(', ')})`);
  }
  return factory({ model: config.model });
}

/**
 * Models are asked for JSON, and models sometimes wrap JSON in prose or fences.
 * Pull the first balanced JSON value out of whatever came back rather than
 * failing the whole day's run on a stray "Here you go:".
 */
export function parseJson(text) {
  const trimmed = String(text).trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch { /* fall through to bracket scanning */ }
  }

  // Scan from whichever delimiter appears first. Trying '[' before '{'
  // unconditionally would return the inner array of `{"specs":[...]}` whenever
  // the object itself is preceded by prose.
  const starts = [['[', ']'], ['{', '}']]
    .map(([open, close]) => ({ open, close, at: trimmed.indexOf(open) }))
    .filter((c) => c.at !== -1)
    .sort((a, b) => a.at - b.at);

  for (const { open, close, at: start } of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch { break; }
        }
      }
    }
  }

  throw new Error(`could not parse JSON from model output: ${trimmed.slice(0, 200)}`);
}
