import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ICON_DIR } from './paths.mjs';

const run = promisify(execFile);

const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];

// Credential stores are out of scope for the MVP.
const SENSITIVE = /password|keychain|1password|bitwarden|lastpass|dashlane|keepass|authenticator|authy|wallet/i;

let cache = null;

async function readInfo(appPath) {
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')]);
    const p = JSON.parse(stdout);
    if (!p.CFBundleIdentifier) return null;
    const fileName = appPath.split('/').pop().replace(/\.app$/, '');
    return {
      bundleId: p.CFBundleIdentifier,
      name: p.CFBundleDisplayName || p.CFBundleName || fileName,
      version: p.CFBundleShortVersionString || p.CFBundleVersion || '',
      path: appPath
    };
  } catch {
    return null;
  }
}

export async function listApps() {
  if (cache) return cache;
  const seen = new Map();
  for (const dir of APP_DIRS) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    const infos = await Promise.all(names.filter(n => n.endsWith('.app')).map(n => readInfo(join(dir, n))));
    for (const info of infos) {
      if (!info || seen.has(info.bundleId)) continue;
      if (SENSITIVE.test(info.bundleId) || SENSITIVE.test(info.name)) continue;
      seen.set(info.bundleId, info);
    }
  }
  cache = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

export async function getApp(bundleId) {
  return (await listApps()).find(a => a.bundleId === bundleId) || null;
}

// NSWorkspace gives the icon the Finder shows, including for apps that ship only an asset catalog.
const ICON_JXA = `
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  img.setSize($.NSMakeSize(128, 128));
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 128, 128, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 128, 128), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[1], true);
}`;

export async function iconPath(bundleId) {
  const app = await getApp(bundleId);
  if (!app) return null;
  const out = join(ICON_DIR, `${bundleId}.png`);
  try { await access(out); return out; } catch {}
  await mkdir(ICON_DIR, { recursive: true });
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON_JXA, app.path, out]);
    await access(out);
    return out;
  } catch {
    return null;
  }
}
