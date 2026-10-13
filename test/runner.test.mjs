import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../src/engine/runner.mjs';
import { parseCandidate } from '../src/engine/library.mjs';

// Declared write targets must sit outside the temp dir, which the sandbox always allows.
const base = mkdtempSync(join(homedir(), '.appbridge-test-'));
const dir = join(base, 'integration'); mkdirSync(dir);
const allowed = join(base, 'allowed'); mkdirSync(allowed);
const forbidden = join(base, 'forbidden'); mkdirSync(forbidden);

writeFileSync(join(dir, 'adapter.mjs'), `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export async function plan({ config, state }) {
  return { items: config.names.map(n => ({ action: state[n] ? 'skip' : 'create', key: n, name: n, payload: { text: n.toUpperCase() } })) };
}
export async function apply({ config, state, items }) {
  for (const it of items) { writeFileSync(join(config.out, it.key + '.txt'), it.payload.text); state[it.key] = true; }
  return { applied: items.map(i => i.key), state };
}
export async function verify({ config, items }) {
  const missing = items.filter(i => !existsSync(join(config.out, i.key + '.txt'))).map(i => i.key);
  return { ok: missing.length === 0, checked: items.length, missing };
}
export async function net() { const r = await fetch('https://example.com'); return { status: r.status }; }
`);

const integration = out => ({ config: { names: ['a', 'b'], out }, resources: { write: [allowed] } });
const direction = ['x', 'y'];

test('plan, apply and verify round-trip inside declared write paths', async () => {
  const items = await runner.plan(dir, integration(allowed), direction, {});
  assert.deepEqual(runner.counts(items), { create: 2, update: 0, skip: 0, delete: 0 });
  const result = await runner.apply(dir, integration(allowed), direction, {}, items);
  assert.deepEqual(result.applied, ['a', 'b']);
  assert.equal(readFileSync(join(allowed, 'a.txt'), 'utf8'), 'A');
  assert.equal((await runner.verify(dir, integration(allowed), direction, items)).ok, true);
  const again = await runner.plan(dir, integration(allowed), direction, result.state);
  assert.equal(runner.counts(again).skip, 2);
});

test('sandbox blocks writes outside declared paths', async () => {
  const items = await runner.plan(dir, integration(forbidden), direction, {});
  await assert.rejects(runner.apply(dir, integration(forbidden), direction, {}, items), /EPERM|not permitted/);
  assert.equal(existsSync(join(forbidden, 'a.txt')), false);
});

test('sandbox blocks network access', async () => {
  const { spawnSync } = await import('node:child_process');
  const host = new URL('../src/engine/adapter-host.mjs', import.meta.url).pathname;
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', runner.sandboxProfile([]), process.execPath, host, dir, 'net'], { input: '{}', stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 20000 });
  assert.notEqual(r.status, 0);
});

test('automation is brokered only to declared apps and safe scripts', async () => {
  writeFileSync(join(dir, 'adapter.mjs'), `export async function plan({ config, automate }) {
    const out = await automate({ app: config.app, script: config.script, args: ['x'] }).catch(e => 'ERR ' + e.message);
    return { items: [{ action: 'skip', key: 'k', name: out }] };
  }`);
  const run = (app, script, automates) => runner.plan(dir, { config: { app, script }, resources: { automates } }, direction, {}).then(i => i[0].name);
  assert.match(await run('com.apple.reminders', 'tell application id "com.apple.reminders" to count of lists', []), /not declared/);
  assert.match(await run('com.apple.reminders', 'tell application id "com.apple.reminders" to do shell script "id"', ['com.apple.reminders']), /does not allow/);
  assert.match(await run('com.apple.reminders', 'tell application "Finder" to count of windows', ['com.apple.reminders']), /undeclared application/);
});

test('plan rejects invalid actions', async () => {
  writeFileSync(join(dir, 'adapter.mjs'), `export async function plan() { return { items: [{ action: 'nuke', key: 1 }] }; }`);
  await assert.rejects(runner.plan(dir, integration(allowed), direction, {}), /invalid action/);
});

test('candidates are validated against the selected pair', () => {
  const ok = parseCandidate(JSON.stringify({ id: 'tasks-to-list', title: 'T', method: 'rea', directions: [['a', 'b'], ['a', 'zzz']] }), 'a', 'b');
  assert.deepEqual(ok.directions, [['a', 'b']]);
  assert.equal(ok.status, 'speculative');
  assert.equal(parseCandidate('{"id":"../x","title":"T","directions":[["a","b"]]}', 'a', 'b'), null);
  assert.equal(parseCandidate('not json', 'a', 'b'), null);
});
