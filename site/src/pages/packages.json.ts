import type { APIRoute } from "astro";
import { catalogJson } from "../lib/cache.ts";

// Search index for the whole catalog. Served verbatim from the precomputed KV blob
// (one lookup, no D1), and edge-cached so the browser fetches it once per session
// and Cloudflare keeps it warm between crawls.
export const prerender = false;

export const GET: APIRoute = async () => {
  return new Response(await catalogJson(), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300, s-maxage=900",
    },
  });
};
