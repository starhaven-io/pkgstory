import {
  displayVersion,
  type KnownSource,
  lifecycleState,
  type PackageMeta,
  todayISO,
  type VersionEvent,
} from './format.ts';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

export function timelinePage(pageParam: string | null): number | null {
  if (pageParam === null) return 1;
  const page = Number.parseInt(pageParam, 10);
  return Number.isInteger(page) && page >= 1 && String(page) === pageParam ? page : null;
}

interface PackageJsonInput {
  source: KnownSource;
  name: string;
  events: VersionEvent[];
  meta: PackageMeta | null;
  checkedAt: number | null;
  page: number;
  timelineLimit: number;
  today?: string;
}

export function packageJsonPayload({
  source,
  name,
  events,
  meta,
  checkedAt,
  page,
  timelineLimit,
  today = todayISO(),
}: PackageJsonInput) {
  const first = events[0];
  if (!first) return null;

  const latestVersion = meta?.latestVersion ?? first.version;
  const latestRevision = meta?.latestVersion != null ? meta.latestRevision : first.revision;
  const eventCount = meta?.eventCount ?? events.length;

  return {
    source,
    name,
    status: meta ? lifecycleState(meta, today) : 'active',
    latest: {
      version: latestVersion,
      revision: latestRevision,
      display: displayVersion(latestVersion, latestRevision),
      introducedAt: meta?.latestAt ?? null,
    },
    eventCount,
    firstIntroducedAt: meta?.firstIntroducedAt ?? null,
    removed:
      meta?.removedAt != null
        ? {
            at: meta.removedAt,
            commit: meta.removedCommit,
            renamedTo: meta.renamedTo,
            migratedTo: meta.migratedTo,
          }
        : null,
    deprecate:
      meta != null && (meta.deprecateDate != null || meta.deprecateReason != null)
        ? { date: meta.deprecateDate, reason: meta.deprecateReason }
        : null,
    disable:
      meta != null && (meta.disableDate != null || meta.disableReason != null)
        ? { date: meta.disableDate, reason: meta.disableReason }
        : null,
    checkedAt,
    page,
    totalPages: Math.max(1, Math.ceil(eventCount / timelineLimit)),
    events: events.map((event) => ({
      version: event.version,
      revision: event.revision,
      display: displayVersion(event.version, event.revision),
      introducedAt: event.introducedAt,
      commitSha: event.commitSha,
      subject: event.subject,
    })),
    license: 'CC-BY-4.0',
  };
}

export function packageJsonNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: JSON_HEADERS,
  });
}

export function packageJsonResponse(payload: NonNullable<ReturnType<typeof packageJsonPayload>>): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      ...JSON_HEADERS,
      'cache-control': 'public, max-age=300, s-maxage=600',
    },
  });
}
