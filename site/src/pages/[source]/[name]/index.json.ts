import type { APIRoute } from 'astro';
import { getDb, lastCheckedBySource, packageMeta, timeline, TIMELINE_LIMIT } from '../../../lib/d1.ts';
import { decodeRouteParam, isKnownSource } from '../../../lib/format.ts';
import {
  packageJsonNotFound,
  packageJsonPayload,
  packageJsonResponse,
  timelinePage,
} from '../../../lib/package-json.ts';

// Machine-readable package timeline: the same D1 reads and edge cache as the
// HTML page. Data is CC-BY-4.0, so the payload says so and CORS is open.
export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  const source = decodeRouteParam(params.source ?? '');
  const name = decodeRouteParam(params.name ?? '');
  if (!isKnownSource(source)) return packageJsonNotFound();

  // Same ?page= contract as the HTML timeline (offset pages of TIMELINE_LIMIT).
  const page = timelinePage(url.searchParams.get('page'));
  if (page === null) return packageJsonNotFound();

  const db = getDb();
  const [events, meta, checkedBySource] = await Promise.all([
    timeline(db, source, name, TIMELINE_LIMIT, (page - 1) * TIMELINE_LIMIT),
    packageMeta(db, source, name),
    lastCheckedBySource(db),
  ]);
  const payload = packageJsonPayload({
    source,
    name,
    events,
    meta,
    checkedAt: checkedBySource.get(source) ?? null,
    page,
    timelineLimit: TIMELINE_LIMIT,
  });
  return payload === null ? packageJsonNotFound() : packageJsonResponse(payload);
};
