// Old URL → new URL for every page that moved. Entries are only ever added: links to the
// old URLs live on in other READMEs, forum posts, bookmarks and search results.
// Each old URL is built as a small redirect page (src/routes/[...legacy=legacy]).
export const REDIRECTS = {
  '/impressum.html': '/impressum/',
  '/datenschutz.html': '/datenschutz/',
  '/protocol/flex-tools.html': '/protocol/flex-tools/',
  '/protocol/flex-standard.html': '/protocol/flex-standard/',
  '/protocol/reference-firmware-variants.html': '/protocol/reference-firmware-variants/',
  '/protocol/open-display-language.html': '/protocol/open-display-language/',
};
