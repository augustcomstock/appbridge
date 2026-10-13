// Minimal stdio MCP server given to AppBridge's agents, whose own shell cannot reach other apps:
//  dry_run_plan      run an adapter's plan() exactly as AppBridge will (sandboxed, brokered automation)
//  probe_app         one read-only AppleScript expression against one of the session's apps
//  report_candidate  add a discovered integration to the list the user is watching
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync, appendFileSync } from 'node:fs';
import { parseCandidate } from './library.mjs';
import * as runner from './runner.mjs';

const pairDir = process.argv[2];
const apps = (process.argv[3] || '').split(',').filter(Boolean);

const PROBE = {
  name: 'probe_app',
  description: 'Ask one of the apps under investigation a read-only question: a single AppleScript using `tell application id "<bundle id>"` with get / count / exists / name of / properties of. Scripts that change data or UI (set, make, delete, open, show, ...) are refused. Returns the script output (truncated). Ask for structure and counts, not user content.',
  inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'Bundle ID' }, script: { type: 'string' } }, required: ['app', 'script'] }
};

const REPORT = {
  name: 'report_candidate',
  description: 'Report one discovered integration. It appears in the user\'s list immediately, so call this as soon as a candidate is ready rather than at the end. Reporting the same id again replaces the earlier entry.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'kebab-case' }, title: { type: 'string' }, description: { type: 'string' }, noun: { type: 'string' },
      method: { type: 'string', enum: ['std', 'local', 'rea'] }, status: { type: 'string', enum: ['validated', 'speculative'] },
      directions: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
      evidence: { type: 'array', items: { type: 'object', properties: { source: { type: 'string', enum: ['conventional', 'rea'] }, tool: { type: 'string' }, finding: { type: 'string' } }, required: ['source', 'tool', 'finding'] } },
      reaContribution: { type: ['string', 'null'] }
    },
    required: ['id', 'title', 'description', 'method', 'status', 'directions', 'evidence']
  }
};

async function probe(a) {
  if (!apps.includes(a.app)) throw new Error(`${a.app} is not one of this session's apps (${apps.join(', ')})`);
  const out = await runner.brokerAutomate({ app: a.app, script: a.script }, apps, { readOnly: true });
  return out.length > 2000 ? out.slice(0, 2000) + ` … [${out.length - 2000} more characters]` : out;
}

function report(a) {
  const line = JSON.stringify(a);
  if (apps.length !== 2 || !parseCandidate(line, apps[0], apps[1])) throw new Error('Rejected: needs a kebab-case id, a title, and directions made only of the two bundle IDs ' + apps.join(' and '));
  appendFileSync(join(pairDir, 'discovery.jsonl'), line + '\n');
  return `Listed "${a.title}".`;
}

const TOOL = {
  name: 'dry_run_plan',
  description: "Run the plan() of ./<integration_id>/adapter.mjs the way AppBridge will: sandboxed (no network, no file writes) with app automation brokered to the apps listed in `automates`. Returns the action counts and the first items, or the error. plan() must be read-only.",
  inputSchema: {
    type: 'object',
    properties: {
      integration_id: { type: 'string' },
      direction: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: '[fromBundleId, toBundleId]' },
      config: { type: 'object' },
      automates: { type: 'array', items: { type: 'string' }, description: 'Bundle IDs the adapter automates' },
      state: { type: 'object' }
    },
    required: ['integration_id', 'direction', 'config']
  }
};

async function dryRun(a) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(a.integration_id || '')) throw new Error('invalid integration_id');
  const dir = join(pairDir, a.integration_id);
  if (!existsSync(join(dir, 'adapter.mjs'))) throw new Error(`no adapter.mjs in ./${a.integration_id}/`);
  const items = await runner.plan(dir, { config: a.config, resources: { automates: a.automates || [] } }, a.direction, a.state || {});
  return { counts: runner.counts(items), first: items.slice(0, 8).map(({ action, key, name, meta }) => ({ action, key, name, meta })) };
}

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;
  if (req.method === 'initialize') return send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'appbridge', version: '0.1.0' } } });
  if (req.method === 'tools/list') return send({ id: req.id, result: { tools: [TOOL, PROBE, REPORT] } });
  const handler = req.method === 'tools/call' && { dry_run_plan: dryRun, probe_app: probe, report_candidate: async a => report(a) }[req.params?.name];
  if (handler) {
    const result = await handler(req.params.arguments || {}).then(r => ({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }), e => ({ content: [{ type: 'text', text: e.message }], isError: true }));
    return send({ id: req.id, result });
  }
  send({ id: req.id, error: { code: -32601, message: 'Method not found' } });
});
