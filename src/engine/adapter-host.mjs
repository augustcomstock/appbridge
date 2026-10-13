// Child-process entry point: loads one adapter and runs one operation. Always started under sandbox-exec by runner.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir, op] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, 'utf8'));
const adapter = await import(pathToFileURL(join(dir, 'adapter.mjs')).href);
if (typeof adapter[op] !== 'function') throw new Error(`adapter does not export ${op}()`);
const result = await adapter[op](input);
process.stdout.write('\n@@APPBRIDGE_RESULT@@' + JSON.stringify(result ?? null));
