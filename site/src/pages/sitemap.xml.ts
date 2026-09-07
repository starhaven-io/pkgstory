import type { APIRoute } from 'astro';
import { sitemapXml } from '../lib/cache.ts';

// The crawler materializes the catalog-wide document once. Requests only stream its
// KV value, and HEAD avoids even that read.
export const prerender = false;

const HEADERS = {
  'content-type': 'application/xml; charset=utf-8',
  'cache-control': 'public, max-age=600, s-maxage=3600',
};

export const GET: APIRoute = async () => new Response(await sitemapXml(), { headers: HEADERS });

export const HEAD: APIRoute = () => new Response(null, { headers: HEADERS });
