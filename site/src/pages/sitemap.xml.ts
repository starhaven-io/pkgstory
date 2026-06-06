import type { APIRoute } from "astro";
import { catalogJson } from "../lib/cache.ts";

// On-demand so the URL set tracks the catalog the crawler republishes to KV — one KV
// lookup, edge-cached. The catalog is already the lean search index, so no extra read.
export const prerender = false;

interface Entry {
  n: string; // name
  s: "c" | "f"; // cask | formula
}

export const GET: APIRoute = async (context) => {
  const origin = (context.site?.href ?? "https://pkgstory.dev/").replace(
    /\/$/,
    "",
  );
  const catalog = JSON.parse(await catalogJson()) as Entry[];

  const locs = [`${origin}/`];
  for (const e of catalog) {
    const src = e.s === "c" ? "homebrew-cask" : "homebrew-formula";
    locs.push(`${origin}/${src}/${encodeURIComponent(e.n)}/`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n")}
</urlset>
`;
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=600, s-maxage=3600",
    },
  });
};
