// Reliable cron for the crawl: GitHub's own `schedule:` drops most fires under load.
// Each tick fires a repository_dispatch authenticated as the starhaven-bot App.

const OWNER = "starhaven-io";
const REPO = "pkgstory";
const EVENT_TYPE = "crawl"; // must match repository_dispatch types: in crawl.yml
const API = "https://api.github.com";
const UA = "pkgstory-crawl-trigger"; // GitHub 403s API requests with no User-Agent

export interface Env {
  APP_ID: string;
  APP_PRIVATE_KEY: string; // PKCS#8 PEM
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
}

async function appJwt(appId: string, pkcs8Pem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const seg = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const header = { alg: "RS256", typ: "JWT" };
  // iat backdated 60s for skew; GitHub caps exp 10 min out.
  const claims = { iat: now - 60, exp: now + 540, iss: appId };
  const input = `${seg(header)}.${seg(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

function ghFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...init?.headers,
    },
  });
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
}

async function ghJson<T>(
  path: string,
  token: string,
  what: string,
  init?: RequestInit,
): Promise<T> {
  const res = await ghFetch(path, token, init);
  await ensureOk(res, what);
  return res.json() as Promise<T>;
}

async function dispatchCrawl(env: Env): Promise<void> {
  const jwt = await appJwt(env.APP_ID, env.APP_PRIVATE_KEY);
  const inst = await ghJson<{ id: number }>(
    `/repos/${OWNER}/${REPO}/installation`,
    jwt,
    "installation lookup",
  );
  const { token } = await ghJson<{ token: string }>(
    `/app/installations/${inst.id}/access_tokens`,
    jwt,
    "token mint",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositories: [REPO], permissions: { contents: "write" } }),
    },
  );

  const res = await ghFetch(`/repos/${OWNER}/${REPO}/dispatches`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: EVENT_TYPE }),
  });
  await ensureOk(res, "repository_dispatch");
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(dispatchCrawl(env));
  },
} satisfies ExportedHandler<Env>;
