// @ts-check
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://pkgstory.dev',
  // Never inline bundled scripts into the HTML: script-src carries no
  // 'unsafe-inline', so an inlined script (anything under the default 4 KB
  // limit) would be CSP-blocked. External /_astro/*.js is also cached immutable.
  vite: { build: { assetsInlineLimit: 0 } },
  adapter: cloudflare({
    // Prerender in Node so build-time pages can read the SQLite index via node:sqlite.
    prerenderEnvironment: 'node',
    imageService: 'passthrough',
    // Expose the D1 binding to `astro dev` (and SSR) so on-demand pages can query it.
    platformProxy: { enabled: true },
  }),
});
