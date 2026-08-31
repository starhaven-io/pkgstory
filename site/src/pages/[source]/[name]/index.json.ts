import type { APIRoute } from 'astro';
import {
  bottleHistory,
  BOTTLE_HISTORY_LIMIT,
  getDb,
  lastCheckedBySource,
  packageMeta,
  timeline,
  TIMELINE_LIMIT,
} from '../../../lib/d1.ts';
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
  const bottlePage = timelinePage(url.searchParams.get('bottle-page'));
  if (bottlePage === null || (source !== 'homebrew-formula' && url.searchParams.has('bottle-page')))
    return packageJsonNotFound();

  const db = getDb();
  const [events, bottleEvents, meta, checkedBySource] = await Promise.all([
    timeline(db, source, name, TIMELINE_LIMIT, (page - 1) * TIMELINE_LIMIT),
    source === 'homebrew-formula'
      ? bottleHistory(db, source, name, BOTTLE_HISTORY_LIMIT, (bottlePage - 1) * BOTTLE_HISTORY_LIMIT)
      : Promise.resolve([]),
    packageMeta(db, source, name),
    lastCheckedBySource(db),
  ]);
  const payload = packageJsonPayload({
    source,
    name,
    events,
    bottleEvents,
    meta,
    checkedAt: checkedBySource.get(source) ?? null,
    page,
    timelineLimit: TIMELINE_LIMIT,
    bottlePage,
    bottleHistoryLimit: BOTTLE_HISTORY_LIMIT,
  });
  if (payload === null) return packageJsonNotFound();
  if (payload.bottle && bottlePage > payload.bottle.totalPages) return packageJsonNotFound();
  return packageJsonResponse(payload);
};
