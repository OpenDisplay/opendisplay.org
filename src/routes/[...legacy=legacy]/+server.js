// Writes a redirect page at each old URL (e.g. build/impressum.html). The host serves plain
// files only, so this is an HTML redirect rather than an HTTP 301; it keeps the query
// string and #hash, and tells search engines the new URL is canonical.
import { REDIRECTS } from '#lib/redirects.js';

export const prerender = true;

export function entries() {
  return Object.keys(REDIRECTS).map((from) => ({ legacy: from.slice(1) }));
}

const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function GET({ params }) {
  const to = escape(REDIRECTS[`/${params.legacy}`]);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved · OpenDisplay</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="https://opendisplay.org${to}">
<meta http-equiv="refresh" content="0; url=${to}">
<script>location.replace(${JSON.stringify(to)} + location.search + location.hash);</script>
</head>
<body><p>This page moved to <a href="${to}">${to}</a>.</p></body>
</html>
`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
