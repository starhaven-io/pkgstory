import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = (context) => {
  const origin = (context.site?.href ?? "https://pkgstory.dev/").replace(
    /\/$/,
    "",
  );
  const body = `User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml
`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
};
