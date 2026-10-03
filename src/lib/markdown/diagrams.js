// Shared by the render script and the Markdown plugin: where a diagram's rendered SVG
// lives. The key is a hash of the diagram source and the theme, so editing either one
// makes `npm run diagrams` render it again.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_DIR = fileURLToPath(new URL('./diagrams/', import.meta.url));
const TOKENS = fileURLToPath(new URL('../ui/tokens.css', import.meta.url));

/** Diagram colors and font, taken from the design tokens. */
export function theme() {
  const css = readFileSync(TOKENS, 'utf8');
  const token = (name) => css.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm'))[1].trim();
  return {
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif',
    fontSize: '14px',
    dropShadow: 'none', // flat, like the rest of the site
    background: token('bg'),
    primaryColor: token('bg-sunken'),
    primaryBorderColor: token('text-faint'),
    primaryTextColor: token('text'),
    secondaryColor: token('bg'),
    tertiaryColor: token('bg'),
    lineColor: token('text-muted'),
    textColor: token('text'),
    // sequence diagrams
    actorBkg: token('bg-sunken'),
    actorBorder: token('text-faint'),
    actorTextColor: token('text'),
    actorLineColor: token('line'),
    signalColor: token('text-muted'),
    signalTextColor: token('text'),
    noteBkgColor: token('bg-sunken'),
    noteBorderColor: token('line'),
    noteTextColor: token('text'),
    activationBkgColor: token('bg-sunken'),
    activationBorderColor: token('blue'),
    sequenceNumberColor: token('bg'),
  };
}

/** Mermaid settings besides the theme. Part of the cache key, like the theme. */
export const config = {
  sequence: { mirrorActors: false },
};

export function key(source) {
  return createHash('sha256')
    .update(JSON.stringify({ theme: theme(), config }))
    .update(source.trim())
    .digest('hex')
    .slice(0, 16);
}

export const cachePath = (source) => join(CACHE_DIR, `${key(source)}.svg`);

/** Every ```mermaid block in the Markdown pages under `dir`. */
export function findDiagrams(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...findDiagrams(path));
    else if (name.endsWith('.md')) {
      for (const m of readFileSync(path, 'utf8').matchAll(/^```mermaid\n([\s\S]*?)^```/gm)) {
        found.push({ file: path, source: m[1] });
      }
    }
  }
  return found;
}

export const isRendered = (source) => existsSync(cachePath(source));
