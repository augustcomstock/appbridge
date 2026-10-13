import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getApp } from './apps.mjs';
import { realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'adapter-host.mjs');
const ACTIONS = new Set(['create', 'update', 'skip', 'delete']);

const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const expand = p => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const q = s => JSON.stringify(s);

// Adapters run with no network and no file writes except the paths their integration declared
// (shown to the user before a run). plan/verify get no declared write paths at all.
// App automation goes through brokerAutomate below, limited to the declared apps.
export function sandboxProfile(writePaths) {
  const allowed = [real(tmpdir()), '/private/var/folders', ...writePaths.map(p => real(expand(p)))];
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network* (local unix-socket) (remote unix-socket))',
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") ${allowed.map(p => `(subpath ${q(p)})`).join(' ')})`
  ].join('\n');
}

// AppleScript features that reach beyond the target app (shell, other scripts, UI scripting, files).
const SCRIPT_DENY = /do\s+shell\s+script|run\s+script|load\s+script|store\s+script|system\s+events|keystroke|key\s+code|open\s+location|posix\s+file|scripting\s+additions|osascript|\bcurl\b|using\s+terms\s+from/i;

// Runs one AppleScript on behalf of a sandboxed adapter, only against apps its integration declared.
async function brokerAutomate(req, automates) {
  if (!automates.includes(req.app)) throw new Error(`automation of ${req.app} was not declared in resources.automates`);
  const script = String(req.script || '');
  if (SCRIPT_DENY.test(script)) throw new Error('script uses a feature AppBridge does not allow (shell, UI scripting, files or other scripts)');
  const allowed = new Set();
  for (const id of automates) { const app = await getApp(id); allowed.add(id.toLowerCase()); if (app) allowed.add(app.name.toLowerCase()); }
  const targets = [...script.matchAll(/application\s+(?:id\s+)?"([^"]+)"/gi)].map(m => m[1].toLowerCase());
  if (!targets.length) throw new Error('script must address its app with: tell application id "<bundle id>"');
  const stray = targets.find(t => !allowed.has(t));
  if (stray) throw new Error(`script addresses an undeclared application: ${stray}`);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script, ...(req.args || [])], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout.replace(/\n$/, ''));
    });
  });
}

function runOp(dir, op, input, writePaths, automates = [], timeoutMs = 300000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile(writePaths), process.execPath, HOST, dir, op], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), TMPDIR: tmpdir() }
    });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdio[3].on('error', () => {});
    createInterface({ input: child.stdio[3] }).on('line', async line => {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      const reply = await brokerAutomate(req, automates).then(output => ({ id: req.id, output }), e => ({ id: req.id, error: e.message }));
      if (child.stdio[3].writable) child.stdio[3].write(JSON.stringify(reply) + '\n');
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      const i = out.lastIndexOf('@@APPBRIDGE_RESULT@@');
      if (code !== 0 || i < 0) {
        const lines = (err || out).trim().split('\n');
        return reject(new Error(`adapter ${op} failed: ${(lines.find(l => /Error\b/.test(l)) || lines.pop() || `exit ${code}`).trim()}`));
      }
      try { resolvePromise(JSON.parse(out.slice(i + 20))); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function normaliseItems(result) {
  const items = Array.isArray(result?.items) ? result.items : null;
  if (!items) throw new Error('adapter plan() must return { items: [...] }');
  return items.map((it, i) => {
    if (!ACTIONS.has(it.action)) throw new Error(`plan item ${i} has invalid action "${it.action}"`);
    return { ...it, key: String(it.key ?? i), name: String(it.name ?? it.key ?? `item ${i + 1}`), meta: it.meta ? String(it.meta) : '' };
  });
}

export async function plan(dir, integration, direction, state) {
  const result = await runOp(dir, 'plan', { direction, config: integration.config || {}, state }, [], integration.resources?.automates);
  return normaliseItems(result);
}

export async function apply(dir, integration, direction, state, items) {
  const writePaths = integration.resources?.write || [];
  return runOp(dir, 'apply', { direction, config: integration.config || {}, state, items }, writePaths, integration.resources?.automates, 600000);
}

export async function verify(dir, integration, direction, items) {
  const result = await runOp(dir, 'verify', { direction, config: integration.config || {}, items }, [], integration.resources?.automates);
  return { ok: !!result?.ok, checked: result?.checked ?? 0, missing: Array.isArray(result?.missing) ? result.missing : [] };
}

export function counts(items) {
  const c = { create: 0, update: 0, skip: 0, delete: 0 };
  for (const it of items) c[it.action]++;
  return c;
}
