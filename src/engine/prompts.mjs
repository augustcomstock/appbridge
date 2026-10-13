import { TEST_DIR } from './paths.mjs';

const appBlock = app => `- ${app.name} — bundle ID \`${app.bundleId}\`, version ${app.version || 'unknown'}, at \`${app.path}\``;

const RULES = `## Ground rules
- You are investigating real applications on the user's Mac. Investigation is READ-ONLY: never create, change or delete data in either application, and never launch UI automation that clicks or types.
- Look at structure, not content: schemas, key names, type definitions, scripting dictionaries, URL schemes, file formats, counts. Do not print the user's actual notes, tasks, messages or documents, and never print credentials or tokens.
- Report only what you observed. Never invent a tool result, and never describe something as working unless you ran a probe that showed it.
- You work in the current directory (this app pair's library folder). \`notes.md\` there holds findings from earlier sessions: read it first if it exists and append durable findings to it as you go, so later sessions do not repeat the work.`;

const METHODS = `## Classifying the method
- \`std\`: official or documented interfaces (AppleScript/JXA dictionary, documented URL scheme, documented CLI, supported import/export, public API).
- \`local\`: local files or databases that are accessible but not a documented interface.
- \`rea\`: reverse engineering with REA/Ghidra materially contributed, meaning you would not have found or could not have implemented it from the conventional sources alone. Calling a REA tool is not enough; if a conventional source would have told you the same thing, it is not \`rea\`.`;

const SANDBOX = `## Your environment
- Your shell is sandboxed: no network, no Apple Events, no connecting to other apps' sockets. \`osascript\` against an app, \`sdef\`, and app CLIs that talk to a running app all fail there. Do not try them.
- To ask an app something, use the \`mcp__appbridge__probe_app\` tool: one read-only AppleScript expression (get / count / exists / name of / properties of). It refuses anything that changes data or UI. Ask for structure and counts, not the user's content.
- Scripting dictionaries are files: read \`<app>/Contents/Resources/*.sdef\` directly.
- Quick static looks need no special tool: \`plutil -p\`, \`strings\`, \`nm\`, \`otool -L\`, \`sqlite3 -readonly <db> .schema\`.`;

const REA_TOOLS = 'open_binary, inspect_plist, inspect_macho, inspect_signature, decode_interface_builder, inspect_keyed_archive, analyze_javascript_application, trace_application_feature, get_objc_classes, analyze_swift_types, search_strings, search_procedures, procedure_pseudo_code, batch_decompile, xrefs, trace_feature';
const REA_LOAD = `The REA tools are named \`mcp__rea__<name>\`. The ones relevant to macOS apps are: ${REA_TOOLS}. Load the ones you need in a single ToolSearch call (\`select:mcp__rea__open_binary,mcp__rea__inspect_macho,...\`) instead of searching one at a time. Call \`open_binary\` on the app first; the others act on the open target.`;

const ghidraBlock = dump => dump
  ? `A full Ghidra analysis of this app's main binary has already been run through REA and saved in \`${dump}\`: \`procedures.txt\` (every function), \`strings.txt\`, \`objc-classes.txt\`, \`swift-types.txt\` and \`decompiled.txt\` (decompiled URL, scripting, pasteboard and import/export handlers). Search those files with Grep; that is instant. Do NOT call REA tools that need a fresh native analysis (search_strings, search_procedures, procedure_pseudo_code, xrefs, batch_decompile, binary_overview, trace_feature): each new session re-runs Ghidra for several minutes.`
  : `No saved Ghidra analysis exists for this app yet. Do NOT call REA tools that need a full native analysis (search_strings, search_procedures, procedure_pseudo_code, xrefs, batch_decompile, binary_overview, trace_feature): they take 7 minutes or more. Use the light REA tools (inspect_macho, inspect_plist, inspect_signature, decode_interface_builder, inspect_keyed_archive) and shell \`strings\` / \`nm\` instead.`;

// One app, once per version: a compact capability profile that later pair discoveries build on.
export function profilePrompt({ app, electron, ghidraDump }) {
  return `You are profiling one macOS application for AppBridge, so that later sessions can work out how to move data in and out of it without repeating this investigation. Be fast and concrete: aim to finish in about 20 tool calls.

## The application
${appBlock(app)}
${electron ? 'It is an Electron app: its logic is JavaScript in `Contents/Resources/*.asar` (and possibly an updated copy under ~/Library/Application Support/<name>/). REA\'s `analyze_javascript_application` can be very large; prefer extracting or grepping the asar for the specific things below.' : 'It is a native app.'}

${RULES.replace(/- You work in the current directory[^\n]*\n?/, '')}

${SANDBOX}

## Reverse engineering
${REA_LOAD}
${electron ? '' : ghidraBlock(ghidraDump)}
Use REA for what the ordinary sources cannot tell you: undeclared URL-scheme parameters, private file-format fields, hidden CLI commands or flags, what a scripting command really does, undeclared pasteboard or document types.

## What to find out
1. Scripting: is there a scripting dictionary? Which classes, which properties are writable, which commands (make, delete, custom)?
2. URL schemes and document/pasteboard types (Info.plist), and what the URL handlers accept.
3. Command-line tools shipped in the bundle and their subcommands.
4. Where its data lives (files, SQLite, plists under ~/Library, app/group containers) and its shape: schema, file format. Which of it is readable from outside.
5. Plugins or extension points that are installed and relevant to data exchange.

## Output
Write \`profile.md\` in the current directory, under 120 lines, with exactly these sections:

# ${app.name} ${app.version || ''} (${app.bundleId})
## Data model            (the kinds of objects it holds and their main fields)
## Ways to read          (each: mechanism, what it returns, whether you ran it, any catch)
## Ways to write         (each: mechanism, what it can create or change, whether it is documented, any catch)
## Local storage         (paths and formats; note anything that needs special permission)
## What reverse engineering added   (specific findings with the tool that produced each; say "nothing beyond the conventional sources" if so)
## Dead ends             (things that look promising but do not work, so nobody retries them)

State only what you observed. Mark anything you inferred but did not run as "(not run)".`;
}

export function discoveryPrompt({ a, b, request, existing, profiles, ghidraDumps }) {
  return `You are the discovery agent for AppBridge. Find ways to move structured data between two applications installed on this Mac that were not designed to work together. Both apps have already been investigated; their profiles are below. Your job is to combine them into concrete integrations, verify each one quickly, and report it the moment it is verified. The user is watching the list fill in, so speed to the first verified result matters.

## The two applications
${appBlock(a)}
${appBlock(b)}

${request ? `## What the user asked for\n"${request}"\nCover this request first, then other useful structured-data transfers.\n` : 'The user gave no specific request: look for useful structured-data transfers.\n'}
${existing.length ? `## Already built for this pair (do not report these again)\n${existing.map(e => `- ${e.id}: ${e.title}`).join('\n')}\n` : ''}
## Profile: ${a.name}
${profiles[0]}

## Profile: ${b.name}
${profiles[1]}

${RULES}

${SANDBOX}

## Reverse-engineering evidence on hand
${[a, b].map((app, i) => `${app.name}: ${ghidraDumps[i] ? `saved Ghidra analysis in \`${ghidraDumps[i]}\` (procedures.txt, strings.txt, objc-classes.txt, swift-types.txt, decompiled.txt). Grep it when a question is about how the app really behaves.` : 'no saved native analysis (see its profile for what was examined).'}`).join('\n')}
Do not start a fresh native analysis with REA during discovery: it takes minutes. ${REA_LOAD}

## How to work
1. In your first message, with no tool calls, list 4 to 6 candidate integrations as one line each (what moves, which direction, the read mechanism, the write mechanism), most useful first. Use the profiles; do not re-investigate the apps.
2. Then take them one at a time, in that order. For each, spend at most 3 or 4 tool calls confirming that the read side really returns what you expect (a read-only probe, or parsing a file) and that the write mechanism exists as the profile says. Then IMMEDIATELY call \`mcp__appbridge__report_candidate\` before starting the next one.
   - \`status: "validated"\` only if a probe you ran in this session showed the read side working AND the profile or your check shows the write mechanism exists. Writes can never be executed during discovery, so say so in the evidence rather than implying they were.
   - If you cannot confirm it within that budget, move on and keep it for step 3.
3. At the end, report the remaining plausible ones with \`status: "speculative"\`. Drop any that your checks disproved.
4. Stop. Finish with two sentences on what reverse engineering did and did not add for this pair.

${METHODS}

Each report needs: a kebab-case \`id\`, a \`title\` of at most 5 words, a one-sentence \`description\` a non-technical user would understand, a \`noun\` (what is transferred), \`method\`, \`status\`, \`directions\` (every [fromBundleId, toBundleId] you believe is implementable), \`evidence\` (each with source "conventional" or "rea", the tool, and exactly what was observed), and \`reaContribution\` (what reverse engineering added beyond conventional sources, or null).`;
}

export function buildPrompt({ a, b, candidate, directions, existingNotes, profiles = [], ghidraDumps = [] }) {
  return `You are the build agent for AppBridge. Build a reusable, deterministic adapter that transfers data between two applications on this Mac.

## The two applications
${appBlock(a)}
${appBlock(b)}

## The integration to build
${JSON.stringify(candidate, null, 2)}

Directions to implement: ${directions.map(d => `${d[0]} → ${d[1]}`).join(' and ')}

${RULES}
${existingNotes ? '\n`notes.md` already has findings from earlier sessions for this pair.\n' : ''}
${SANDBOX}

${profiles[0] ? `## Profile: ${a.name}\n${profiles[0]}\n` : ''}
${profiles[1] ? `## Profile: ${b.name}\n${profiles[1]}\n` : ''}
${[a, b].map((app, i) => (ghidraDumps[i] ? `A saved Ghidra analysis of ${app.name} is in \`${ghidraDumps[i]}\` (procedures.txt, strings.txt, decompiled.txt): grep it before considering a fresh native analysis.` : '')).filter(Boolean).join('\n')}
${REA_LOAD}

## What to produce, in \`./${candidate.id}/\`

### 1. \`adapter.mjs\`
A Node.js ES module using only the Node standard library (it may spawn read-only system executables such as \`/usr/bin/sqlite3\`). It is executed later by AppBridge, without you, inside a sandbox with no network and with file writes allowed only under the paths you declare in \`resources.write\`.

Apps reject Apple Events from sandboxed processes, so the adapter must NOT spawn \`osascript\`. Instead every function receives an \`automate\` helper that AppBridge runs outside the sandbox:

\`\`\`js
const out = await automate({ app: 'com.apple.reminders', script: 'on run argv\\n tell application id "com.apple.reminders" to ...\\nend run', args: ['passed', 'as argv'] });
// resolves with the script's stdout text; rejects with the AppleScript error
\`\`\`

Rules AppBridge enforces on \`automate\`: AppleScript only; \`app\` must be listed in \`resources.automates\`; the script may only address declared apps (use \`tell application id "<bundle id>"\`); no \`do shell script\`, \`run script\`, System Events, keystrokes, file or URL commands. Pass all data through \`args\` / \`on run argv\`, never by building it into the script text. Batch work into few scripts (one script that returns many records, with explicit field and record delimiters) rather than one call per item.

It must export:

\`\`\`js
// Read both sides and decide what would change. MUST NOT modify anything.
export async function plan({ direction, config, state, automate }) {
  // direction: [fromBundleId, toBundleId]
  return { items: [{ action: 'create' | 'update' | 'skip' | 'delete', key: 'stable id of the source item', name: 'human-readable name', meta: 'short detail', payload: { /* whatever apply needs */ } }] };
}
// Perform exactly the given items (AppBridge passes the items the user approved; deletes only if explicitly confirmed).
export async function apply({ direction, config, state, items, automate }) {
  return { applied: ['keys...'], state: { /* updated mapping state, persisted by AppBridge */ } };
}
// Independently re-read the DESTINATION and confirm each applied item is really there. Do not trust apply's own bookkeeping.
export async function verify({ direction, config, items, automate }) {
  return { ok: true, checked: 3, missing: [] };
}
\`\`\`

Requirements:
- Non-destructive by default: never overwrite or delete unless the plan item says so. Only emit \`delete\` items if the integration's meaning truly requires it.
- Idempotent: running twice must not duplicate. Use \`state\` (a JSON object you define, e.g. source key → destination id) plus a check against the destination, and emit \`skip\` for items already transferred.
- All targets come from \`config\`; no hard-coded user paths in the code.
- Fail with a clear error message rather than guessing.

### 2. Safe default targets
Default \`config\` must point at dedicated test targets, never at the user's existing data:
- For file-based sides, use a folder under \`${TEST_DIR}\` (you may create it and seed it with a handful of realistic synthetic items so there is something to transfer).
- For app-managed sides (lists, folders, notebooks inside an app), use a container named "AppBridge Test". Do NOT create it yourself: the adapter's \`apply\` creates it if missing, after the user approves.

### 3. \`adapter.test.mjs\`
Tests using \`node:test\` and synthetic fixtures (temp directories, fake records) covering the transformation logic, idempotency and edge cases (empty input, odd characters, already-transferred items). Tests must not touch real application data: inject a fake \`automate\` that records calls and returns canned output. Run them with \`node --test ./${candidate.id}/\` and fix failures.

### 4. A read-only dry run
Call the \`mcp__appbridge__dry_run_plan\` tool with the default config to confirm the real read path works exactly as AppBridge will run it (your own shell cannot reach the apps). Fix the adapter until it returns a sensible plan. There is no way for you to run \`apply()\` and you must not try: the user approves the transfer in AppBridge. So make the write scripts conservative and check them carefully against the scripting dictionary or what you learned from REA.

### 5. \`integration.json\`
Write it last, only once tests pass:

{"id":"${candidate.id}","title":"...","description":"...","noun":"...","method":"std|local|rea","directions":[["from","to"]],"config":{...},"resources":{"read":["absolute paths or app names read"],"write":["absolute paths written (empty if writes go through an app's scripting interface)"],"automates":["bundle IDs controlled via Apple Events"]},"validation":{"status":"passed|failed","tests":<number of tests>,"dryRun":"what the read-only plan() showed, e.g. '4 create, 0 skip'","notes":"anything the user should know"},"evidence":[{"source":"conventional|rea","tool":"...","finding":"..."}],"reaContribution":"... or null"}

${METHODS}

Carry over the candidate's evidence, correct it where building taught you otherwise, and add what you learned. Use REA (\`mcp__rea__*\`) whenever you need to know how the app really behaves and conventional sources do not say. If the integration turns out not to be buildable, do not write integration.json; explain why in your final message instead.`;
}
