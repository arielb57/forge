// The store reads its location from config at import time, so the override has
// to be in place before anything under src/ is loaded.
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'forge-store-'));
process.env.FORGE_DATA_DIR = scratch;

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { load, save, recordProject, recordRun, findProject, isRecentlyCovered, STATUS } =
  await import('../src/store.js');

after(() => rmSync(scratch, { recursive: true, force: true }));

const reset = () => save({ version: 1, createdAt: new Date().toISOString(), runs: [], projects: [] });

test('an empty ledger loads without error', () => {
  rmSync(join(scratch, 'ledger.json'), { force: true });
  const state = load();
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.runs, []);
});

test('a recorded project can be read back by name and by id', () => {
  reset();
  recordProject({ id: 'run1-alpha', name: 'alpha', tagline: 'does a thing', status: STATUS.REVIEW });
  assert.equal(findProject('alpha').id, 'run1-alpha');
  assert.equal(findProject('run1-alpha').name, 'alpha');
  assert.equal(findProject('nope'), null);
});

test('recording the same id twice merges rather than duplicating', () => {
  reset();
  recordProject({ id: 'x', name: 'alpha', status: STATUS.BUILT });
  recordProject({ id: 'x', status: STATUS.SHIPPED, url: 'https://example.com/alpha' });

  const state = load();
  assert.equal(state.projects.length, 1, 'a second write must not create a second row');
  assert.equal(state.projects[0].status, STATUS.SHIPPED);
  assert.equal(state.projects[0].name, 'alpha', 'fields not in the update must survive');
  assert.equal(state.projects[0].url, 'https://example.com/alpha');
});

test('createdAt is set once and never overwritten by an update', () => {
  reset();
  recordProject({ id: 'y', name: 'beta' });
  const first = load().projects[0].createdAt;
  recordProject({ id: 'y', status: STATUS.SHIPPED });
  assert.equal(load().projects[0].createdAt, first);
});

test('the run history is capped so the ledger cannot grow without bound', () => {
  reset();
  for (let i = 0; i < 420; i += 1) recordRun({ id: `r${i}`, passed: 1, built: 1 });
  const { runs } = load();
  assert.equal(runs.length, 400);
  assert.equal(runs[0].id, 'r419', 'the newest run must be first');
});

test('a recently shipped topic is reported as covered', () => {
  reset();
  recordProject({
    id: 'a', name: 'ninja-whatif',
    tagline: 'predicts how much faster a Ninja build gets if you speed up one target',
    topics: ['ninja', 'build'], status: STATUS.SHIPPED,
  });
  assert.equal(isRecentlyCovered('ninja whatif predicts faster Ninja build target speedups'), true);
});

test('an unrelated topic is not reported as covered', () => {
  reset();
  recordProject({
    id: 'a', name: 'ninja-whatif',
    tagline: 'predicts how much faster a Ninja build gets if you speed up one target',
    status: STATUS.SHIPPED,
  });
  assert.equal(isRecentlyCovered('safetensors checkpoint layer differ for fine-tunes'), false);
});

test('a topic older than the cooldown stops being covered', () => {
  reset();
  const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const state = load();
  state.projects.push({
    id: 'old', name: 'ninja-whatif',
    tagline: 'predicts how much faster a Ninja build gets if you speed up one target',
    createdAt: longAgo, status: STATUS.SHIPPED,
  });
  save(state);
  assert.equal(isRecentlyCovered('ninja whatif predicts faster Ninja build target speedups'), false);
});

test('a corrupt ledger is preserved, not silently discarded', () => {
  reset();
  recordProject({ id: 'keep', name: 'important' });
  writeFileSync(join(scratch, 'ledger.json'), '{ this is not json');

  assert.throws(() => load(), /unreadable/);
  // Months of history must survive a bad write — a copy is kept to recover from.
  assert.ok(
    readdirSync(scratch).some((f) => f.startsWith('ledger.json.corrupt-')),
    'the unreadable file should be moved aside, not deleted',
  );
});

test('a write is atomic: no temp file is left behind', () => {
  reset();
  recordProject({ id: 'z', name: 'gamma' });
  assert.ok(!readdirSync(scratch).includes('ledger.json.tmp'));
});

/* --- trend reuse across runs ---------------------------------------------- */

test('a trend a recent run worked from is reported as used', async () => {
  const { recordRun: rr, isTrendUsed } = await import('../src/store.js');
  reset();
  rr({ id: 'r1', usedTrends: ['Linux Zoom Client Proactively Reads X11 Clipboard'] });
  assert.equal(isTrendUsed('Linux Zoom client proactively reads the X11 clipboard'), true);
});

test('an unrelated trend is not reported as used', async () => {
  const { recordRun: rr, isTrendUsed } = await import('../src/store.js');
  reset();
  rr({ id: 'r1', usedTrends: ['Linux Zoom Client Proactively Reads X11 Clipboard'] });
  assert.equal(isTrendUsed('A new garbage collector lands in OCaml'), false);
});

test('trend reuse expires, so a story can come back weeks later', async () => {
  const { isTrendUsed } = await import('../src/store.js');
  reset();
  const state = load();
  state.runs.push({
    id: 'old',
    at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    usedTrends: ['Linux Zoom Client Proactively Reads X11 Clipboard'],
  });
  save(state);
  assert.equal(isTrendUsed('Linux Zoom Client Proactively Reads X11 Clipboard'), false);
});

test('a run with no usedTrends field does not break the lookup', async () => {
  const { recordRun: rr, isTrendUsed } = await import('../src/store.js');
  reset();
  rr({ id: 'legacy', passed: 1, built: 1 });
  assert.equal(isTrendUsed('anything at all'), false);
});
