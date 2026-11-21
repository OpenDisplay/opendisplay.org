#!/usr/bin/env node
/*
 * Local dev server for manual testing (hardware qualification, poking at the
 * app). Serves httpdocs with NO-CACHE headers.
 *
 * Why not `python3 -m http.server`: it sends Last-Modified with no
 * Cache-Control, so Chrome heuristically caches the ES modules. Editing a
 * module and reloading then silently runs the OLD code — which cost a
 * debugging session while verifying stroke dragging, and would waste far more
 * time mid-qualification.
 *
 *   node tests/webapp/tools/devserver.mjs [port]
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const HTTPDOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../httpdocs');
const PORT = Number(process.argv[2] ?? 8081);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.yaml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  let file = join(HTTPDOCS, path);
  if (!file.startsWith(HTTPDOCS)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`404 ${path}`);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // The whole point: never let the browser reuse a stale module.
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
  });
  res.end(readFileSync(file));
}).listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${HTTPDOCS} on http://localhost:${PORT}/`);
  console.log(`  the app:  http://localhost:${PORT}/app/`);
  console.log('  (no-store headers: edits are picked up on a plain reload)');
});
