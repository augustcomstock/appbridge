import { mkdir, readFile, writeFile, readdir, appendFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIBRARY_DIR } from './paths.mjs';

const METHODS = new Set(['std', 'local', 'rea']);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

// A pair is identified by its two bundle IDs, independent of which side each is on.
export function pairDir(a, b) {
  return join(LIBRARY_DIR, [a, b].sort().join('__'));
}

export async function ensurePairDir(a, b) {
  const dir = pairDir(a, b);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export async function listIntegrations(a, b) {
  const dir = pairDir(a, b);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of await readdir(dir)) {
    const it = await readJson(join(dir, name, 'integration.json'));
    if (it && it.id === name && existsSync(join(dir, name, 'adapter.mjs'))) out.push(it);
  }
  return out.sort((x, y) => (x.builtAt || '').localeCompare(y.builtAt || ''));
}

export async function getIntegration(a, b, id) {
  if (!ID_RE.test(id)) return null;
  return readJson(join(pairDir(a, b), id, 'integration.json'));
}

export async function saveIntegration(a, b, integration) {
  const dir = join(pairDir(a, b), integration.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'integration.json'), JSON.stringify(integration, null, 2));
}

export function integrationDir(a, b, id) {
  return join(pairDir(a, b), id);
}

export async function readState(a, b, id) {
  return readJson(join(integrationDir(a, b, id), 'state.json'), {});
}

export async function writeState(a, b, id, state) {
  await writeFile(join(integrationDir(a, b, id), 'state.json'), JSON.stringify(state ?? {}, null, 2));
}

export async function appendRun(a, b, run) {
  await appendFile(join(pairDir(a, b), 'runs.jsonl'), JSON.stringify(run) + '\n');
}

// Each discovery starts a fresh candidate file; earlier ones are kept for inspection.
export async function rotateDiscovery(a, b) {
  const file = join(await ensurePairDir(a, b), 'discovery.jsonl');
  if (existsSync(file)) await rename(file, file.replace(/\.jsonl$/, `-${Date.now()}.jsonl`));
  await writeFile(file, '');
  return file;
}

// Normalises one agent-written candidate line. Returns null if it is unusable.
export function parseCandidate(line, a, b) {
  let c;
  try { c = JSON.parse(line); } catch { return null; }
  if (!c || !ID_RE.test(c.id || '') || !c.title) return null;
  const ids = new Set([a, b]);
  const directions = (Array.isArray(c.directions) ? c.directions : [])
    .filter(d => Array.isArray(d) && d.length === 2 && ids.has(d[0]) && ids.has(d[1]) && d[0] !== d[1]);
  if (!directions.length) return null;
  return {
    id: c.id,
    title: String(c.title).slice(0, 80),
    description: String(c.description || '').slice(0, 240),
    noun: String(c.noun || 'items').slice(0, 24),
    method: METHODS.has(c.method) ? c.method : 'local',
    status: c.status === 'validated' ? 'validated' : 'speculative',
    directions,
    evidence: (Array.isArray(c.evidence) ? c.evidence : []).slice(0, 20).map(e => ({
      source: e.source === 'rea' ? 'rea' : 'conventional',
      tool: String(e.tool || '').slice(0, 80),
      finding: String(e.finding || '').slice(0, 600)
    })),
    reaContribution: c.reaContribution ? String(c.reaContribution).slice(0, 800) : null
  };
}

export async function readCandidates(a, b) {
  const text = await readFile(join(pairDir(a, b), 'discovery.jsonl'), 'utf8').catch(() => '');
  const seen = new Map();
  for (const line of text.split('\n')) {
    const c = line.trim() && parseCandidate(line, a, b);
    if (c) seen.set(c.id, c);
  }
  return [...seen.values()];
}
