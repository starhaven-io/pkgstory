import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { changes, getDb, sourceCrawl } from '../../../lib/d1.ts';
import {
  dateFromUnixSeconds,
  decodeRouteParam,
  displayVersion,
  isKnownSource,
  sourceLabel,
} from '../../../lib/format.ts';

export const prerender = false;

export async function GET(context: APIContext) {
  const raw = context.params as { source: string; name: string };
  const source = decodeRouteParam(raw.source);
  const name = decodeRouteParam(raw.name);
  if (!isKnownSource(source))
    return new Response('Not found', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
    });

  const encodedName = encodeURIComponent(name);
  const db = getDb();
  const [events, crawl] = await Promise.all([
    changes(db, source, name),
    source === 'homebrew-cask' ? sourceCrawl(db, source) : null,
  ]);
  if (events.length === 0)
    return new Response('Not found', {
      status: 404,
      // Brief edge cache so a URL sweep can't reach D1 once per request.
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
    });

  const res = await rss({
    title: `${name} updates · pkgstory`,
    description: [`Version updates for ${name} (${sourceLabel(source)}).`, crawl?.versionSelection]
      .filter(Boolean)
      .join(' '),
    site: context.site ?? 'https://pkgstory.dev',
    items: events.flatMap((e, index) => {
      const pubDate = dateFromUnixSeconds(e.introducedAt);
      if (!pubDate) return [];
      const version = displayVersion(e.version, e.revision);
      const changeId = encodeURIComponent(e.commitSha ?? `${e.introducedAt}-${index}`);
      return [
        {
          title: `${name} ${version}`,
          link: e.commitSha
            ? `https://github.com/Homebrew/${source === 'homebrew-cask' ? 'homebrew-cask' : 'homebrew-core'}/commit/${encodeURIComponent(e.commitSha)}`
            : `/${source}/${encodedName}/`,
          pubDate,
          description: `${name} updated to ${version}`,
          customData: `<guid isPermaLink="false">urn:pkgstory:${source}:${encodedName}:${changeId}</guid>`,
        },
      ];
    }),
  });
  // Readers poll feeds hard; cache like the HTML pages so polls stop at the edge.
  res.headers.set('cache-control', 'public, max-age=300, s-maxage=600');
  return res;
}
