// mdsvex code-block hook. ```mermaid blocks become their pre-rendered SVG (see
// scripts/render-diagrams.js); every other block is plain, escaped <pre><code>.
// Both go through {@html} so braces in code or in the SVG's styles never reach Svelte.
import { readFileSync } from 'node:fs';
import { cachePath, isRendered } from './diagrams.js';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlighter(code, lang) {
  if (lang === 'mermaid') {
    if (!isRendered(code)) {
      throw new Error('A mermaid diagram is not rendered yet. Run `npm run diagrams`.');
    }
    const svg = readFileSync(cachePath(code), 'utf8');
    return `<figure class="diagram">{@html ${JSON.stringify(svg)}}</figure>`;
  }
  const cls = lang ? ` class="language-${lang}"` : '';
  return `<pre${cls}>{@html ${JSON.stringify(`<code>${escape(code)}</code>`)}}</pre>`;
}
