// Import the REAL app modules in Node.
//
// The app ships .js module files (browser MIME safety, plan §2) which Node
// treats as CommonJS, and a data: URL cannot resolve their relative imports.
// So mirror httpdocs/app/v1/js into a temp tree as .mjs, rewriting relative
// specifiers — the sources are copied verbatim otherwise, so tests exercise
// the shipped code, not a transformed copy.
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join } from 'node:path';

const APP_JS = join(dirname(fileURLToPath(import.meta.url)), '../../../httpdocs/app/v1/js');

let mirrorDir = null;

function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function buildMirror() {
  const dir = mkdtempSync(join(tmpdir(), 'od-app-modules-'));
  cpSync(APP_JS, dir, { recursive: true });
  walk(dir, (file) => {
    if (extname(file) !== '.js') return;
    const src = readFileSync(file, 'utf8')
      // Only relative specifiers are rewritten; nothing else is touched.
      .replace(/(from\s+['"])(\.[^'"]*?)\.js(['"])/g, '$1$2.mjs$3')
      .replace(/(import\s*\(\s*['"])(\.[^'"]*?)\.js(['"]\s*\))/g, '$1$2.mjs$3');
    writeFileSync(file, src);
    renameSync(file, file.replace(/\.js$/, '.mjs'));
  });
  return dir;
}

/** Import an app module by its path relative to httpdocs/app/v1/js. */
export function loadAppModule(relPath) {
  if (!mirrorDir) mirrorDir = buildMirror();
  const target = join(mirrorDir, relPath.replace(/\.js$/, '.mjs'));
  return import(pathToFileURL(target).href);
}
