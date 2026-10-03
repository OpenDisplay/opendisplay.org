import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { mdsvex } from 'mdsvex';
import headingIds from './src/lib/markdown/heading-ids.js';
import internalLinks from './src/lib/markdown/internal-links.js';
import { defineConfig } from 'vite';

const STATIC = 'httpdocs';
// BUILD_CHECK=1 builds and previews from separate folders, so tests and reviews never
// replace files under a dev or preview server someone else is running.
const CHECK = process.env.BUILD_CHECK === '1';

/** True when a site path is served from the static folder (a file, or a folder's index.html). */
function isStaticPage(path) {
  const file = `${STATIC}${decodeURIComponent(path.split(/[?#]/)[0])}`;
  if (!existsSync(file)) return false;
  return statSync(file).isDirectory() ? existsSync(`${file.replace(/\/$/, '')}/index.html`) : true;
}

export default defineConfig({
  plugins: [
    sveltekit({
      extensions: ['.svelte', '.md'],
      // Markdown pages: frontmatter → Page, body → Prose (src/lib/markdown/Layout.svelte).
      preprocess: [
        mdsvex({
          extensions: ['.md'],
          layout: { _: fileURLToPath(new URL('./src/lib/markdown/Layout.svelte', import.meta.url)) },
          rehypePlugins: [headingIds, internalLinks],
        }),
      ],
      // Static export only: every route is prerendered (src/routes/+layout.js) and the
      // build/ folder is uploaded to the Netcup web root as plain files.
      adapter: adapter({
        strict: true,
        pages: CHECK ? '.build-check' : 'build',
        assets: CHECK ? '.build-check' : 'build',
      }),
      outDir: CHECK ? '.svelte-kit-check' : '.svelte-kit',
      files: {
        // httpdocs/ is both the static folder and, after the build, the remote web root.
        // Pages not yet ported live here as plain files and are copied through unchanged.
        assets: STATIC,
      },
      prerender: {
        // Broken internal links fail the build. Links to pages that are still plain files in
        // httpdocs/ are fine: the crawler can't fetch them, but the host serves them.
        handleHttpError({ path, message }) {
          if (isStaticPage(path)) return;
          throw new Error(message);
        },
      },
    }),
  ],
  server: {
    proxy: {
      // fwproxy.php only runs on the real host; use the live one in development.
      '/firmware/fwproxy.php': { target: 'https://opendisplay.org', changeOrigin: true },
    },
  },
  // Component tests mount Svelte in jsdom, so they need Svelte's browser build.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    include: ['tests/**/*.test.js'],
  },
});
