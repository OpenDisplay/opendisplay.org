import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      // Static export only: every route is prerendered (src/routes/+layout.js) and the
      // build/ folder is uploaded to the Netcup web root as plain files.
      adapter: adapter({ strict: true }),
      files: {
        // httpdocs/ is both the static folder and, after the build, the remote web root.
        // Pages not yet ported live here as plain files and are copied through unchanged.
        assets: 'httpdocs',
      },
    }),
  ],
  server: {
    proxy: {
      // fwproxy.php only runs on the real host; use the live one in development.
      '/firmware/fwproxy.php': { target: 'https://opendisplay.org', changeOrigin: true },
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
