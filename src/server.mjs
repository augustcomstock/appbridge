import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listApps, getApp, iconPath } from './engine/apps.mjs';
import * as lib from './engine/library.mjs';
import * as runner from './engine/runner.mjs';
import { runAgent, health } from './engine/agent.mjs';
import { discoveryPrompt, buildPrompt } from './engine/prompts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 4317);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const STATIC = { '/vendor/preact.js': 'node_modules/preact/dist/preact.module.js', '/vendor/hooks.js': 'node_modules/preact/hooks/dist/hooks.module.js', '/vendor/htm.js': 'node_modules/htm/dist/htm.module.js' };

const jobs = new Map();   // id -> { events: [], listeners: Set, done }
const plans = new Map();  // token -> { a, b, id, parts: [{ direction, items }] }

function createJob() {
  const job = { id: randomUUID(), events: [], listeners: new Set(), done: false };
  jobs.set(job.id, job);
  return job;
}
function emit(job, event) {
  job.events.push(event);
  if (event.type === 'done') job.done = true;
  for (const send of job.listeners) send(event);
}

async function pairApps(a, b) {
  const [A, B] = await Promise.all([getApp(a), getApp(b)]);
  if (!A || !B || a === b) throw Object.assign(new Error('Unknown or identical applications'), { status: 400 });
  return [A, B];
}

// An integration only counts as reverse-engineered if REA tools actually ran in the session that produced it.
const honestMethod = (method, reaCalls) => (method === 'rea' && reaCalls.length === 0 ? 'local' : method);

async function discover(job, a, b, request) {
  const [A, B] = await pairApps(a, b);
  const file = await lib.rotateDiscovery(a, b);
  const dir = lib.pairDir(a, b);
  const existing = await lib.listIntegrations(a, b);
  const built = new Set(existing.map(e => e.id));
  const sent = new Set();
  const flush = async () => {
    for (const c of await lib.readCandidates(a, b)) {
      if (sent.has(c.id) || built.has(c.id)) continue;
      sent.add(c.id);
      emit(job, { type: 'candidate', candidate: c });
    }
  };
  const watcher = watch(file, () => { flush().catch(() => {}); });
  const result = await runAgent({
    cwd: dir,
    prompt: discoveryPrompt({ a: A, b: B, request, existing }),
    logFile: join(dir, 'agent-logs', `discover-${Date.now()}.jsonl`),
    onStatus: text => emit(job, { type: 'status', text }),
    onLog: entry => emit(job, { type: 'log', label: 'Discovery', ...entry })
  });
  watcher.close();
  await flush();
  await writeFile(join(dir, 'discovery-meta.json'), JSON.stringify({ at: new Date().toISOString(), request, reaToolCalls: result.reaCalls.map(c => c.tool) }, null, 2));
  if (result.reaCalls.length === 0) {
    for (const c of await lib.readCandidates(a, b)) {
      if (c.method === 'rea') emit(job, { type: 'candidate', candidate: { ...c, method: 'local' } });
    }
  }
  emit(job, { type: 'done', ok: result.ok, error: result.error, reaCalls: result.reaCalls.length, found: sent.size });
}

async function build(job, a, b, selections) {
  const [A, B] = await pairApps(a, b);
  const dir = lib.pairDir(a, b);
  const candidates = await lib.readCandidates(a, b);
  const discoveryCalls = JSON.parse(await readFile(join(dir, 'discovery-meta.json'), 'utf8').catch(() => '{}')).reaToolCalls || [];
  for (const sel of selections) {
    const candidate = candidates.find(c => c.id === sel.id);
    if (!candidate) { emit(job, { type: 'failed', id: sel.id, error: 'Unknown candidate' }); continue; }
    const directions = candidate.directions.filter(d => sel.directions.some(s => s[0] === d[0] && s[1] === d[1]));
    const result = await runAgent({
      cwd: dir,
      prompt: buildPrompt({ a: A, b: B, candidate, directions: directions.length ? directions : candidate.directions, existingNotes: existsSync(join(dir, 'notes.md')) }),
      logFile: join(dir, 'agent-logs', `build-${candidate.id}-${Date.now()}.jsonl`),
      onStatus: text => emit(job, { type: 'status', id: candidate.id, text }),
      onLog: entry => emit(job, { type: 'log', label: `Build · ${candidate.title}`, ...entry })
    });
    const written = await lib.getIntegration(a, b, candidate.id);
    const ok = written && existsSync(join(dir, candidate.id, 'adapter.mjs')) && written.validation?.status === 'passed';
    if (!ok) {
      emit(job, { type: 'failed', id: candidate.id, error: result.error || written?.validation?.notes || 'The agent could not produce a working adapter.' });
      continue;
    }
    const integration = {
      ...written,
      id: candidate.id,
      method: honestMethod(written.method, [...discoveryCalls, ...result.reaCalls]),
      status: 'built',
      apps: [A, B].map(({ bundleId, name, version }) => ({ bundleId, name, version })),
      builtAt: new Date().toISOString(),
      reaToolCalls: [...discoveryCalls, ...result.reaCalls.map(c => c.tool)],
      lastRun: null
    };
    await lib.saveIntegration(a, b, integration);
    emit(job, { type: 'built', integration });
  }
  emit(job, { type: 'done', ok: true });
}

async function preview(a, b, id) {
  const integration = await lib.getIntegration(a, b, id);
  if (!integration) throw Object.assign(new Error('Unknown integration'), { status: 404 });
  const dir = lib.integrationDir(a, b, id);
  const state = await lib.readState(a, b, id);
  const parts = [];
  for (const direction of integration.directions) {
    parts.push({ direction, items: await runner.plan(dir, integration, direction, state) });
  }
  const token = randomUUID();
  plans.set(token, { a, b, id, parts });
  const items = parts.flatMap(p => p.items.map(({ payload, ...rest }) => ({ ...rest, to: p.direction[1] })));
  return { token, counts: runner.counts(items), items, resources: integration.resources || {} };
}

async function execute(token, allowDelete) {
  const planned = plans.get(token);
  if (!planned) throw Object.assign(new Error('This preview has expired. Review the changes again.'), { status: 409 });
  plans.delete(token);
  const { a, b, id, parts } = planned;
  const integration = await lib.getIntegration(a, b, id);
  const dir = lib.integrationDir(a, b, id);
  const total = { create: 0, update: 0, skip: 0, delete: 0 };
  let verified = true, checked = 0;
  const missing = [];
  for (const { direction, items } of parts) {
    const approved = items.filter(it => it.action !== 'skip' && (it.action !== 'delete' || allowDelete));
    if (!approved.length) { total.skip += items.length; continue; }
    const state = await lib.readState(a, b, id);
    const result = await runner.apply(dir, integration, direction, state, approved);
    if (result?.state) await lib.writeState(a, b, id, result.state);
    const appliedKeys = new Set((result?.applied || []).map(String));
    const applied = approved.filter(it => appliedKeys.has(it.key));
    const c = runner.counts(applied);
    for (const k of Object.keys(c)) total[k] += c[k];
    total.skip += items.length - applied.length;
    const v = await runner.verify(dir, integration, direction, applied.filter(it => it.action !== 'delete'));
    verified = verified && v.ok;
    checked += v.checked;
    missing.push(...v.missing);
  }
  const run = { id, at: new Date().toISOString(), counts: total, verified, checked, missing, allowDelete: !!allowDelete };
  await lib.appendRun(a, b, run);
  await lib.saveIntegration(a, b, { ...integration, lastRun: run });
  return run;
}

async function inspect(a, b, id) {
  const integration = await lib.getIntegration(a, b, id);
  if (integration) return integration;
  return (await lib.readCandidates(a, b)).find(c => c.id === id) || null;
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', d => { data += d; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
});

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);
  try {
    // Only this machine's own UI may call the API.
    if (req.headers.origin && req.headers.origin !== `http://localhost:${PORT}` && req.headers.origin !== `http://127.0.0.1:${PORT}`) return json(res, 403, { error: 'Forbidden' });

    if (url.pathname === '/api/apps') return json(res, 200, (await listApps()).map(({ bundleId, name, version }) => ({ bundleId, name, version })));
    if (url.pathname === '/api/health') return json(res, 200, await health());
    if (url.pathname === '/api/icon') {
      const file = await iconPath(q.id || '');
      if (!file) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      return res.end(await readFile(file));
    }
    if (url.pathname === '/api/pair') {
      await pairApps(q.a, q.b);
      return json(res, 200, { saved: await lib.listIntegrations(q.a, q.b) });
    }
    if (url.pathname === '/api/inspect') return json(res, 200, await inspect(q.a, q.b, q.id));
    if (url.pathname === '/api/events') {
      const job = jobs.get(q.job);
      if (!job) return json(res, 404, { error: 'Unknown job' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
      job.events.forEach(send);
      job.listeners.add(send);
      req.on('close', () => job.listeners.delete(send));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (url.pathname === '/api/discover') {
        await pairApps(body.a, body.b);
        const job = createJob();
        discover(job, body.a, body.b, String(body.prompt || '').slice(0, 500)).catch(e => emit(job, { type: 'done', ok: false, error: e.message }));
        return json(res, 200, { job: job.id });
      }
      if (url.pathname === '/api/build') {
        await pairApps(body.a, body.b);
        const job = createJob();
        build(job, body.a, body.b, body.selections || []).catch(e => emit(job, { type: 'done', ok: false, error: e.message }));
        return json(res, 200, { job: job.id });
      }
      if (url.pathname === '/api/preview') return json(res, 200, await preview(body.a, body.b, body.id));
      if (url.pathname === '/api/run') return json(res, 200, await execute(body.token, body.allowDelete === true));
    }
    if (STATIC[url.pathname]) return serveFile(res, join(ROOT, STATIC[url.pathname]));
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('..')) { res.writeHead(400); return res.end(); }
    const file = join(ROOT, 'public', rel);
    if ((await stat(file).catch(() => null))?.isFile()) return serveFile(res, file);
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`AppBridge running at http://localhost:${PORT}`));
