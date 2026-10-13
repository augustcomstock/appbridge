import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export const DATA_DIR = process.env.APPBRIDGE_HOME || join(homedir(), '.appbridge');
export const LIBRARY_DIR = join(DATA_DIR, 'library');
export const ICON_DIR = join(DATA_DIR, 'cache', 'icons');
export const TOOLS_DIR = join(DATA_DIR, 'tools');
// The only place outside the library where the agent may create file-based test targets.
export const TEST_DIR = join(homedir(), 'AppBridge Test');

export function ghidraDir() {
  if (process.env.GHIDRA_INSTALL_DIR) return process.env.GHIDRA_INSTALL_DIR;
  if (!existsSync(TOOLS_DIR)) return null;
  const hit = readdirSync(TOOLS_DIR).filter(n => n.startsWith('ghidra_')).sort().pop();
  return hit ? join(TOOLS_DIR, hit) : null;
}

export function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const brew = '/opt/homebrew/opt/openjdk@21';
  return existsSync(brew) ? brew : null;
}
