// Minimal stdio MCP server given to the build agent: lets it dry-run an adapter's plan() exactly as AppBridge will run it
// (sandboxed, with brokered app automation), since the agent's own shell cannot send Apple Events.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as runner from './runner.mjs';

const pairDir = process.argv[2];
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
  if (req.method === 'tools/list') return send({ id: req.id, result: { tools: [TOOL] } });
  if (req.method === 'tools/call' && req.params?.name === TOOL.name) {
    const result = await dryRun(req.params.arguments || {}).then(r => ({ content: [{ type: 'text', text: JSON.stringify(r) }] }), e => ({ content: [{ type: 'text', text: e.message }], isError: true }));
    return send({ id: req.id, result });
  }
  send({ id: req.id, error: { code: -32601, message: 'Method not found' } });
});
