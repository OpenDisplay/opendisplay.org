// Renders the ```mermaid blocks in src/**/*.md (pages and diagram snippets in src/lib/diagrams) to SVG files in
// src/lib/markdown/diagrams/ (committed). Only new or changed diagrams are rendered, so a
// browser is needed only then. `--check` renders nothing and fails if any are missing.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import {
  CACHE_DIR,
  cachePath,
  config,
  findDiagrams,
  isRendered,
  key,
  theme,
} from '../src/lib/markdown/diagrams.js';

const diagrams = findDiagrams('src');
const missing = diagrams.filter((d) => !isRendered(d.source));

// Drop rendered SVGs no diagram uses any more.
const used = new Set(diagrams.map((d) => `${key(d.source)}.svg`));
mkdirSync(CACHE_DIR, { recursive: true });
for (const f of readdirSync(CACHE_DIR)) if (f.endsWith('.svg') && !used.has(f)) rmSync(CACHE_DIR + f);

if (process.argv.includes('--check')) {
  for (const d of missing) console.error(`Not rendered: diagram in ${d.file}. Run npm run diagrams.`);
  process.exit(missing.length ? 1 : 0);
}
if (!missing.length) process.exit(0);

const { chromium } = await import('@playwright/test');
const require = createRequire(import.meta.url);
const browser = await chromium.launch();
const page = await browser.newPage();

// Serve a blank page plus the site's fonts from a local origin, so tokens.css loads Geist
// exactly as the site does and text is measured with the font the page will show.
const ORIGIN = 'http://diagrams.local';
await page.route(`${ORIGIN}/**`, (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
  return route.fulfill({ path: `httpdocs${path}` });
});
await page.goto(`${ORIGIN}/`);
await page.addStyleTag({ path: 'src/lib/ui/tokens.css' });
await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
await page.evaluate(
  async ({ themeVariables, config }) => {
    // Load the weights diagrams use before measuring.
    await Promise.all(['400 14px Geist', '600 14px Geist'].map((f) => document.fonts.load(f)));
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables,
      securityLevel: 'strict',
      ...config,
    });
  },
  { themeVariables: theme(), config },
);

for (const d of missing) {
  const svg = await page.evaluate(async ({ id, source }) => (await window.mermaid.render(id, source)).svg, {
    id: `d${key(d.source)}`,
    source: d.source,
  });
  writeFileSync(cachePath(d.source), svg);
  console.log(`rendered ${basename(cachePath(d.source))} (${d.file})`);
}
await browser.close();
