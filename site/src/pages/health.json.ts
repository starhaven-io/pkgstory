import type { APIRoute } from 'astro';
import { getDb, lastCheckedBySource } from '../lib/d1.ts';
import { healthReport, KNOWN_SOURCES } from '../lib/format.ts';

// Freshness probe for the crawl pipeline. crawl_state.last_crawled_at advances
// on every run, including up-to-date ones, so an old value means that source's
// crawls are not completing.
export const prerender = false;

// The trigger fires every 30 minutes; 2h means four consecutive misses.
const STALE_AFTER_SECONDS = 2 * 60 * 60;

export const GET: APIRoute = async () => {
  const bySource = await lastCheckedBySource(getDb());
  const now = Math.floor(Date.now() / 1000);
  const report = healthReport(KNOWN_SOURCES, bySource, now, STALE_AFTER_SECONDS);
  return new Response(JSON.stringify(report), {
    status: report.stale ? 503 : 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};
