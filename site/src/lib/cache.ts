import { env } from "cloudflare:workers";
import type { RecentChange, StatusCode } from "./format.ts";

// The precomputed site-cache KV namespace (binding CACHE). Populated by the crawler
// after every run; serving from it costs one KV lookup regardless of traffic.

interface KVNamespace {
  get(key: string): Promise<string | null>;
}

function kv(): KVNamespace {
  return (env as unknown as { CACHE: KVNamespace }).CACHE;
}

export interface CatalogEntry {
  n: string; // name
  s: "c" | "f"; // cask | formula
  v: string | null; // latest version
  r: number; // latest revision
  c: number; // event count
  x?: StatusCode; // lifecycle marker (absent = active)
}

export interface HomePayload {
  formulae: number;
  casks: number;
  recent: RecentChange[];
  checkedAt: number | null;
}

const EMPTY_HOME: HomePayload = {
  formulae: 0,
  casks: 0,
  recent: [],
  checkedAt: null,
};

/** Raw JSON string of the search index — passed straight through to the client. */
export async function catalogJson(): Promise<string> {
  return (await kv().get("catalog")) ?? "[]";
}

export async function home(): Promise<HomePayload> {
  const raw = await kv().get("home");
  return raw ? (JSON.parse(raw) as HomePayload) : EMPTY_HOME;
}
