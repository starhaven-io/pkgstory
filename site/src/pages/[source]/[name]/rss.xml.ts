import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getDb, timeline } from "../../../lib/d1.ts";
import { displayVersion, sourceLabel } from "../../../lib/format.ts";

export const prerender = false;

export async function GET(context: APIContext) {
  const { source, name } = context.params as { source: string; name: string };
  const events = await timeline(getDb(), source, name);
  if (events.length === 0) return new Response("Not found", { status: 404 });

  return rss({
    title: `${name} updates · pkgstory`,
    description: `Version updates for ${name} (${sourceLabel(source)}).`,
    site: context.site ?? "https://pkgstory.dev",
    items: events.map((e) => {
      const version = displayVersion(e.version, e.revision);
      return {
        title: `${name} ${version}`,
        link: `/${source}/${name}/#${encodeURIComponent(version)}`,
        pubDate: new Date(e.introducedAt * 1000),
        description: `${name} updated to ${version}`,
      };
    }),
  });
}
