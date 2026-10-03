// Static export: every page is rendered to HTML at build time.
// trailingSlash 'always' emits <route>/index.html, which the host serves without any
// server config. Switching to clean URLs without a slash is planned to be decided on
// the preview host (it needs an .htaccess rewrite); internal links go through
// #lib/paths.js so that switch stays a one-line change.
export const prerender = true;
export const trailingSlash = 'always';
