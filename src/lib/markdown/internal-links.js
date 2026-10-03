// rehype plugin for mdsvex: internal links in Markdown are plain paths. At build time each
// one goes through the redirect map (an old .html URL becomes the page's new URL) and the
// site's URL style (paths.js page()), so moving a page or changing the trailing-slash
// style never means editing Markdown. Broken links still fail the prerender.
import { page } from '../paths.js';
import { REDIRECTS } from '../redirects.js';

export function canonical(url) {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  const [, path, rest = ''] = url.match(/^([^?#]*)(.*)$/);
  const moved = REDIRECTS[path] ?? path;
  return (moved.endsWith('/') ? page(moved) : moved) + rest;
}

export default function internalLinks() {
  return (tree) => {
    const walk = (node) => {
      if (node.type === 'element' && node.tagName === 'a' && typeof node.properties?.href === 'string') {
        node.properties.href = canonical(node.properties.href);
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree);
  };
}
