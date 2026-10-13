// Child-process entry point: loads one adapter and runs one operation. Always started under sandbox-exec by runner.mjs.
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, op] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, 'utf8'));

// Apps reject Apple Events from sandboxed senders, so automation is brokered by the parent over the socket on fd 3.
const broker = new Socket({ fd: 3 });
const pending = new Map();
let seq = 0;
createInterface({ input: broker }).on('line', line => {
  const msg = JSON.parse(line);
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (p) msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.output);
});
const automate = ({ app, script, args = [] }) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  broker.write(JSON.stringify({ id, app, script, args: args.map(String) }) + '\n');
});

const adapter = await import(pathToFileURL(join(dir, 'adapter.mjs')).href);
if (typeof adapter[op] !== 'function') throw new Error(`adapter does not export ${op}()`);
const result = await adapter[op]({ ...input, automate });
process.stdout.write('\n@@APPBRIDGE_RESULT@@' + JSON.stringify(result ?? null), () => process.exit(0));
