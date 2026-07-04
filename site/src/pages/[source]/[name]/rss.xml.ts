import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getDb, timeline } from '../../../lib/d1.ts';
import { decodeRouteParam, displayVersion, isKnownSource, sourceLabel } from '../../../lib/format.ts';

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
  const events = await timeline(getDb(), source, name);
  if (events.length === 0)
    return new Response('Not found', {
      status: 404,
      // Brief edge cache so a URL sweep can't reach D1 once per request.
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300' },
    });

  const res = await rss({
    title: `${name} updates · pkgstory`,
    description: `Version updates for ${name} (${sourceLabel(source)}).`,
    site: context.site ?? 'https://pkgstory.dev',
    items: events.map((e) => {
      const version = displayVersion(e.version, e.revision);
      return {
        title: `${name} ${version}`,
        link: `/${source}/${encodedName}/#${encodeURIComponent(version)}`,
        pubDate: new Date(e.introducedAt * 1000),
        description: `${name} updated to ${version}`,
      };
    }),
  });
  // Readers poll feeds hard; cache like the HTML pages so polls stop at the edge.
  res.headers.set('cache-control', 'public, max-age=300, s-maxage=600');
  return res;
}
