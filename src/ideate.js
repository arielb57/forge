import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getDriver, parseJson } from './llm/index.js';
import { isRecentlyCovered, load } from './store.js';
import { log } from './log.js';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGES_ORDER = ['typescript', 'python', 'rust'];
const LANGUAGES = new Set(LANGUAGES_ORDER);

function renderTrends(trends) {
  return trends
    .map((t, i) => {
      const lines = [
        `### Trend ${i + 1}: ${t.title}`,
        `Signal score ${t.score}${t.corroborated ? ` — corroborated across ${t.sources.join(', ')}` : ` — ${t.sources[0]} only`}`,
        t.url ? `Link: ${t.url}` : null,
      ].filter(Boolean);

      if (t.evidence?.length > 1) {
        lines.push('Related items:');
        for (const e of t.evidence.slice(0, 4)) {
          lines.push(`  - [${e.source}${e.signal ? ` ${e.signal}` : ''}] ${e.title}`);
        }
      }
      if (t.context) lines.push(`Context: ${t.context.slice(0, 500)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Reject anything malformed before it reaches a build and wastes 20 minutes. */
function validate(spec) {
  const problems = [];
  if (!spec.name || !NAME_RE.test(spec.name)) problems.push('name must be kebab-case');
  if (spec.name && spec.name.length > 40) problems.push('name is too long');
  if (!spec.tagline || spec.tagline.length > 120) problems.push('tagline missing or over 120 chars');
  if (!LANGUAGES.has(spec.language)) problems.push(`language must be one of ${[...LANGUAGES].join(', ')}`);
  if (!spec.problem || spec.problem.length < 60) problems.push('problem statement is too thin');
  if (!spec.core || spec.core.length < 60) problems.push('technical core is too thin');
  if (!spec.verification || spec.verification.length < 40) problems.push('verification plan is too thin');
  if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0) problems.push('no deliverables');
  return problems;
}

export async function ideate(trends, { count = config.projectsPerDay * config.ideaOversample } = {}) {
  if (trends.length === 0) throw new Error('no trends to ideate from');

  const template = readFileSync(join(config.root, 'prompts', 'ideate.md'), 'utf8');
  const state = load();

  // Shipped (or awaiting review) is "do not repeat". Attempted-and-failed is
  // different: those ideas never became public work, so they may come back —
  // but only with an approach that answers why the last attempt failed.
  const exists = (p) => p.status === 'shipped' || p.status === 'review';
  const shipped = state.projects
    .filter(exists)
    .slice(0, 60)
    .map((p) => `- ${p.name} [${p.language}]: ${p.tagline}`)
    .join('\n');
  const attempted = state.projects
    .filter((p) => p.status === 'rejected' && p.tagline)
    .slice(0, 20)
    .map((p) => `- ${p.name}: ${p.tagline}${p.error ? ` (stopped: ${String(p.error).slice(0, 80)})` : ' (failed the quality gate)'}`)
    .join('\n');

  // Language balance across recent work. Building one project per run means
  // there is no batch to spread languages over, and the pipeline had drifted to
  // five Rust projects out of seven — a portfolio of one language reads as a
  // narrower range than the work actually shows.
  const recent = state.projects.slice(0, 12);
  const counts = LANGUAGES_ORDER.map((lang) => [lang, recent.filter((p) => p.language === lang).length]);
  const leanest = counts.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  const balance = recent.length === 0
    ? ''
    : [
        '## Language balance',
        '',
        `Recent projects by language: ${counts.map(([l, n]) => `${l} ${n}`).join(', ')}.`,
        `Unless a different language genuinely suits the problem better, prefer **${leanest}**.`,
        'A portfolio of one language reads as a narrower range than the work shows.',
      ].join('\n');

  const prompt = [
    template.replace('{{COUNT}}', String(count)),
    '',
    '## Today\'s trends',
    '',
    renderTrends(trends),
    '',
    shipped
      ? `## Already shipped — do not repeat these or anything close to them\n\n${shipped}`
      : '## Already shipped\n\nNothing yet. This is the first batch.',
    attempted
      ? `\n## Attempted but never published\n\nThese do not exist publicly. An idea here may be proposed again, but a build that failed the gate should come back with a narrower scope or a different approach, not the same spec.\n\n${attempted}`
      : '',
    '',
    balance,
  ].join('\n');

  log.step(`ideating ${count} specs from ${trends.length} trends`);
  const driver = getDriver();
  const raw = await driver.think(prompt, {
    system: 'You are a principal engineer selecting what is worth building. You are hard to impress.',
  });

  const parsed = parseJson(raw);
  const specs = Array.isArray(parsed) ? parsed : parsed.specs || [];
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('ideation returned no specs');
  }

  for (const r of parsed.rejected || []) {
    log.info(`rejected trend "${String(r.trend).slice(0, 50)}": ${r.reason}`);
  }

  const accepted = [];
  const seen = new Set();
  for (const spec of specs) {
    const problems = validate(spec);
    if (problems.length > 0) {
      log.warn(`spec "${spec.name || '(unnamed)'}" is invalid: ${problems.join('; ')}`);
      continue;
    }
    if (seen.has(spec.name)) {
      log.warn(`spec "${spec.name}" is duplicated within this batch`);
      continue;
    }
    if (isRecentlyCovered(`${spec.name} ${spec.tagline}`, state)) {
      log.warn(`spec "${spec.name}" is too close to something already shipped`);
      continue;
    }
    seen.add(spec.name);
    accepted.push(spec);
  }

  log.ok(`${accepted.length}/${specs.length} specs passed validation`);
  return accepted;
}
