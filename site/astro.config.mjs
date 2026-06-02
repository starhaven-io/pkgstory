// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://pkgstory.dev",
  adapter: cloudflare({
    // Prerender in Node so build-time pages can read the SQLite index via node:sqlite.
    prerenderEnvironment: "node",
    imageService: "passthrough",
    // Expose the D1 binding to `astro dev` (and SSR) so on-demand pages can query it.
    platformProxy: { enabled: true },
  }),
});
