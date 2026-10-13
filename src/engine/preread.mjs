// Per-app pre-read, cached by bundle ID + version so it is paid for once and reused across every pair:
//  - a capability profile written by a fast agent (interfaces, data stores, read and write mechanisms)
//  - for native apps, one server-run Ghidra session through REA whose outputs are saved as searchable files
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ghidraDir, javaHome } from './paths.mjs';
import { runAgent, reaEnv, reaCommand } from './agent.mjs';
import { profilePrompt } from './prompts.mjs';

const PROFILE_DIR = join(DATA_DIR, 'profiles');
const GHIDRA_CACHE = join(DATA_DIR, 'cache', 'ghidra');
const key = app => `${app.bundleId}@${app.version || '0'}`.replace(/[^\w.@-]/g, '_');
const inFlight = new Map();

function once(name, work) {
  if (!inFlight.has(name)) inFlight.set(name, work().finally(() => inFlight.delete(name)));
  return inFlight.get(name);
}

const isElectron = app => existsSync(join(app.path, 'Contents', 'Frameworks', 'Electron Framework.framework'));

export const profilePath = app => join(PROFILE_DIR, `${key(app)}.md`);
export const ghidraDumpDir = app => { const dir = join(GHIDRA_CACHE, key(app)); return existsSync(join(dir, 'done.json')) ? dir : null; };
export const readProfile = app => readFile(profilePath(app), 'utf8').catch(() => null);

// Resolves with the profile text, running the profile agent only if this app version has not been read before.
export function ensureProfile(app, hooks = {}) {
  return once(`profile:${key(app)}`, async () => {
    const cached = await readProfile(app);
    if (cached) return cached;
    const work = join(PROFILE_DIR, 'work', key(app));
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const result = await runAgent({
      cwd: work,
      apps: [app.bundleId],
      model: 'sonnet',
      maxTurns: 40,
      prompt: profilePrompt({ app, electron: isElectron(app), ghidraDump: ghidraDumpDir(app) }),
      logFile: join(PROFILE_DIR, 'logs', `${key(app)}-${Date.now()}.jsonl`),
      onStatus: hooks.onStatus,
      onLog: hooks.onLog
    });
    const written = join(work, 'profile.md');
    if (!existsSync(written)) throw new Error(result.error || `Could not profile ${app.name}.`);
    const footer = `\n\n<!-- profiled ${new Date().toISOString()}; REA tools run: ${[...new Set(result.reaCalls.map(c => c.tool))].join(', ') || 'none'} -->\n`;
    await writeFile(written, (await readFile(written, 'utf8')) + footer);
    await rename(written, profilePath(app));
    return readProfile(app);
  });
}

// REA tool names recorded in a profile's footer, so the "was REA actually used" check covers cached pre-reads too.
export function profileReaTools(profile) {
  const m = /REA tools run: ([^>]*) -->/.exec(profile || '');
  return m && m[1].trim() !== 'none' ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

// Minimal MCP client for one REA session.
function reaSession() {
  const [cmd, ...args] = reaCommand();
  const child = spawn(cmd, args, { env: { ...process.env, ...reaEnv(), REA_MCP_MAX_RESPONSE_BYTES: String(256 * 1024 * 1024) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  child.on('close', () => pending.forEach(p => p.reject(new Error('REA exited'))));
  const rpc = (method, params) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return {
    async start() { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'appbridge', version: '0.1.0' } }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); },
    async call(name, args = {}) {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = (result.content || []).map(c => c.text || '').join('\n');
      if (result.isError) throw new Error(text.slice(0, 300));
      return text;
    },
    stop() { child.kill(); }
  };
}

// Function names worth decompiling up front: where apps handle URLs, scripting, pasteboard, import/export and persistence.
const INTERESTING = /openURL|handleURL|URLScheme|userActivity|scripting|AppleEvent|pasteboard|importFrom|exportTo|readFromURL|writeToURL|NSItemProvider|shareExtension|deepLink/i;

// One Ghidra session per native app version; later agents search the saved files instead of waiting ~7 minutes each.
export function ensureGhidraDump(app) {
  if (!ghidraDir() || !javaHome() || isElectron(app) || ghidraDumpDir(app)) return Promise.resolve(ghidraDumpDir(app));
  return once(`ghidra:${key(app)}`, async () => {
    const dir = join(GHIDRA_CACHE, key(app));
    await mkdir(dir, { recursive: true });
    const rea = reaSession();
    const tools = [];
    const save = async (file, tool, args) => { const text = await rea.call(tool, args); tools.push(tool); await writeFile(join(dir, file), text); return text; };
    try {
      await rea.start();
      await rea.call('open_binary', { path: app.path, provider_id: 'ghidra' }); tools.push('open_binary');
      const procedures = await save('procedures.txt', 'list_procedures');
      await save('strings.txt', 'list_strings');
      await save('objc-classes.txt', 'get_objc_classes').catch(() => {});
      await save('swift-types.txt', 'analyze_swift_types').catch(() => {});
      const names = [...new Set((procedures.match(/[-+]\[[^\]\n"]+\]|\b[A-Za-z_$][\w$.:]*\b/g) || []).filter(n => INTERESTING.test(n)))].slice(0, 40);
      if (names.length) await save('decompiled.txt', 'batch_decompile', { addresses: names }).catch(e => writeFile(join(dir, 'decompiled-error.txt'), e.message));
      await writeFile(join(dir, 'done.json'), JSON.stringify({ app: key(app), at: new Date().toISOString(), tools, decompiled: names }, null, 2));
      return dir;
    } catch (e) {
      await writeFile(join(dir, 'error.txt'), e.message);
      return null;
    } finally {
      rea.stop();
    }
  });
}

export const ghidraTools = app => { try { return JSON.parse(readFileSync(join(ghidraDumpDir(app), 'done.json'), 'utf8')).tools; } catch { return []; } };

// Kick off both pre-reads in the background (called when the user settles on an app).
export function prewarm(app) {
  ensureGhidraDump(app).catch(() => {});
  ensureProfile(app).catch(() => {});
}
