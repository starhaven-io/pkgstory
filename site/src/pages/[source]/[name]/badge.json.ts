import type { APIRoute } from 'astro';
import { getDb, packageMeta, timeline } from '../../../lib/d1.ts';
import {
  decodeRouteParam,
  displayVersion,
  isKnownSource,
  type LifecycleState,
  lifecycleState,
  todayISO,
} from '../../../lib/format.ts';

// shields.io endpoint-schema badge, so any project can embed its packaged
// version: https://img.shields.io/endpoint?url=https://pkgstory.dev/<source>/<name>/badge.json
export const prerender = false;

const BADGE_COLOR: Record<LifecycleState, string> = {
  active: 'blue',
  deprecated: 'yellow',
  disabled: 'orange',
  removed: 'red',
  renamed: 'red',
  migrated: 'red',
};

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

const notFound = () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: JSON_HEADERS });

export const GET: APIRoute = async ({ params }) => {
  const source = decodeRouteParam(params.source ?? '');
  const name = decodeRouteParam(params.name ?? '');
  if (!isKnownSource(source)) return notFound();

  const db = getDb();
  const [events, meta] = await Promise.all([timeline(db, source, name, 1), packageMeta(db, source, name)]);
  if (events.length === 0) return notFound();

  const state = meta ? lifecycleState(meta, todayISO()) : 'active';
  const version = meta?.latestVersion ?? events[0]!.version;
  const revision = meta?.latestVersion ? meta.latestRevision : events[0]!.revision;
  const shipped = displayVersion(version, revision);
  const message =
    state === 'active' ? shipped : state === 'deprecated' || state === 'disabled' ? `${shipped} (${state})` : state; // removed / renamed / migrated — there is no shipping version

  const body = {
    schemaVersion: 1,
    label: source === 'homebrew-cask' ? 'homebrew cask' : 'homebrew',
    message,
    color: BADGE_COLOR[state],
    cacheSeconds: 3600,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      ...JSON_HEADERS,
      // Badges are README traffic; cache harder than the page (freshness within
      // the hour is plenty for a version badge).
      'cache-control': 'public, max-age=300, s-maxage=3600',
    },
  });
};
