import { defineMiddleware } from "astro:middleware";

// Cloudflare applies public/_headers only to static assets (/_astro/*), but every
// pkgstory route is `prerender = false`, so those responses come from the SSR Worker
// and would ship without these headers. Re-apply them here for all SSR routes — HTML
// pages and the JSON/XML/text feeds alike, so nosniff/HSTS cover the data endpoints
// too. Set-if-absent lets a route opt out. Keep in sync with the /* block in _headers.
const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-XSS-Protection": "0",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) {
      response.headers.set(name, value);
    }
  }

  return response;
});
