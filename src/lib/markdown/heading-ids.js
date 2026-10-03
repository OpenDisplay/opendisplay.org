// rehype plugin for mdsvex: gives every h2 and h3 a stable id from its text (unless it
// has one), so sections are linkable and Page's "On this page" list can find them.
const text = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(text).join(''));

export const slug = (value) =>
  value
    .replace(/^\s*\d+(\.\d+)*\.?\s+/, '') // drop section numbers like "1." or "2.4"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export default function headingIds() {
  return (tree) => {
    const used = new Set();
    const walk = (node) => {
      if (node.type === 'element' && (node.tagName === 'h2' || node.tagName === 'h3')) {
        node.properties ??= {};
        if (!node.properties.id) {
          const base = slug(text(node)) || 'section';
          let id = base;
          for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
          node.properties.id = id;
        }
        used.add(node.properties.id);
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree);
  };
}
