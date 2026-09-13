import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const COLORS = {
  info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m',
  error: '\x1b[31m', dim: '\x1b[90m', reset: '\x1b[0m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (level, text) => (useColor ? `${COLORS[level] || ''}${text}${COLORS.reset}` : text);

let logFile = null;
function fileSink() {
  if (logFile !== null) return logFile;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    logFile = join(config.dataDir, 'forge.log');
  } catch {
    logFile = false; // logging to disk is a convenience, never a hard failure
  }
  return logFile;
}

function write(level, symbol, parts) {
  const message = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const stamp = new Date().toISOString();
  console.log(`${paint('dim', stamp.slice(11, 19))} ${paint(level, symbol)} ${message}`);
  const sink = fileSink();
  if (sink) {
    try {
      appendFileSync(sink, `${stamp} [${level}] ${message}\n`);
    } catch { /* read-only or full disk: never take the run down over a log line */ }
  }
}

export const log = {
  info: (...a) => write('info', '·', a),
  ok: (...a) => write('ok', '✓', a),
  warn: (...a) => write('warn', '!', a),
  error: (...a) => write('error', '✗', a),
  step: (...a) => write('info', '▸', a),
  blank: () => console.log(''),
};
