// Runs headless Claude Code as the investigation/build agent, with REA attached over MCP.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghidraDir, javaHome, TEST_DIR } from './paths.mjs';

const run = promisify(execFile);

export function claudeBin() {
  if (process.env.APPBRIDGE_CLAUDE) return process.env.APPBRIDGE_CLAUDE;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }
  // Claude Code as bundled with the Claude desktop app.
  const root = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  if (!existsSync(root)) return null;
  for (const version of readdirSync(root).sort().reverse()) {
    for (const build of readdirSync(join(root, version))) {
      const bin = join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

export function reaEntry() {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, 'rea'))) return join(dir, 'rea');
  }
  try { return createRequire(import.meta.url).resolve('rea-agents/scripts/rea.mjs'); } catch { return null; }
}

export async function health() {
  const bin = claudeBin();
  let loggedIn = false;
  if (bin) {
    try { loggedIn = !!JSON.parse((await run(bin, ['auth', 'status'])).stdout).loggedIn; } catch {}
  }
  return { claude: !!bin, loggedIn, rea: !!reaEntry(), ghidra: !!ghidraDir() && !!javaHome() };
}

const TOOLS_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'agent-tools.mjs');

function mcpConfig(cwd) {
  // Ghidra's first analysis of a large app binary takes longer than REA's 5.5-minute default.
  const env = { REA_GHIDRA_STARTUP_TIMEOUT_MS: '2400000' };
  if (ghidraDir()) env.GHIDRA_INSTALL_DIR = ghidraDir();
  env.PATH = [javaHome() && `${javaHome()}/bin`, dirname(process.execPath), process.env.PATH].filter(Boolean).join(':');
  if (javaHome()) env.JAVA_HOME = javaHome();
  return JSON.stringify({ mcpServers: {
    rea: { command: process.execPath, args: [realpathSync(reaEntry()), '--mcp'], env },
    appbridge: { command: process.execPath, args: [TOOLS_SERVER, cwd] }
  } });
}

// Bash runs inside Claude Code's OS sandbox: no network, writes confined to the working directories.
const SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }
});

const short = (s, n = 70) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function describeTool(name, input = {}) {
  if (name.startsWith('mcp__rea__')) {
    const target = input.path || input.binary_path || input.app_path || input.query || input.name || input.address || '';
    return `REA · ${name.slice(10).replace(/_/g, ' ')}${target ? ' · ' + short(basename(String(target)), 36) : ''}`;
  }
  if (name === 'mcp__appbridge__dry_run_plan') return 'Dry-running the adapter against the real apps';
  if (name === 'ToolSearch') return 'Looking up tools';
  if (name === 'Bash') return short(input.description || input.command);
  if (name === 'Read') return `Reading ${basename(input.file_path || '')}`;
  if (name === 'Write' || name === 'Edit') return `Writing ${basename(input.file_path || '')}`;
  if (name === 'Grep' || name === 'Glob') return `Searching ${short(input.pattern, 40)}`;
  return name;
}

// Resolves with { ok, reaCalls, tools, error } once the agent exits. onStatus gets one-line progress.
export function runAgent({ cwd, prompt, logFile, onStatus = () => {}, maxTurns = 120 }) {
  const bin = claudeBin();
  if (!bin) return Promise.resolve({ ok: false, error: 'Claude Code was not found on this Mac.', reaCalls: [] });
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig(cwd), '--strict-mcp-config',
    '--settings', SETTINGS,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'mcp__rea', 'mcp__appbridge',
    '--add-dir', TEST_DIR,
    '--max-turns', String(maxTurns)
  ];
  return new Promise(async resolve => {
    await mkdir(dirname(logFile), { recursive: true });
    await mkdir(TEST_DIR, { recursive: true });
    const log = createWriteStream(logFile);
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const reaCalls = [];
    let buf = '', stderr = '', final = null;
    const handle = line => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content || []) {
          if (block.type !== 'tool_use') continue;
          if (block.name.startsWith('mcp__rea__')) reaCalls.push({ tool: block.name.slice(10), input: block.input, at: new Date().toISOString() });
          onStatus(describeTool(block.name, block.input));
        }
      } else if (ev.type === 'result') {
        final = ev;
      }
    };
    child.stdout.on('data', d => {
      log.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => resolve({ ok: false, error: e.message, reaCalls }));
    child.on('close', code => {
      if (buf.trim()) handle(buf);
      log.end();
      const ok = code === 0 && final && !final.is_error;
      const error = ok ? null : short(final?.result || stderr || `agent exited with code ${code}`, 300);
      resolve({ ok, error, reaCalls, costUsd: final?.total_cost_usd ?? null, turns: final?.num_turns ?? null });
    });
  });
}
