import { Buffer } from "node:buffer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import trigger, { type Env } from "../trigger/src/index.ts";

interface ScheduledHandler {
  scheduled(
    controller: unknown,
    env: Env,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): void | Promise<void>;
}

let privateKeyPem = "";
let publicKey: CryptoKey;

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  publicKey = keys.publicKey;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const body =
    Buffer.from(pkcs8)
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function runScheduled(env: Env): Promise<void> {
  let pending: Promise<unknown> | undefined;
  const handler = trigger as ScheduledHandler;
  await handler.scheduled({}, env, {
    waitUntil(promise) {
      pending = promise;
    },
  });
  if (!pending) throw new Error("scheduled handler did not register work");
  await pending;
}

describe("crawl trigger Worker", () => {
  it("mints an installation token and dispatches the crawl event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/installation")) {
        return new Response(JSON.stringify({ id: 42 }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runScheduled({ APP_ID: "12345", APP_PRIVATE_KEY: privateKeyPem });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/starhaven-io/pkgstory/installation",
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/repos/starhaven-io/pkgstory/dispatches",
    ]);
    const jwt = String(
      (requests[0]?.init.headers as Record<string, string> | undefined)?.Authorization,
    ).replace("Bearer ", "");
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    expect(JSON.parse(Buffer.from(segments[0] ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(claims).toEqual({
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 540,
      iss: "12345",
    });
    await expect(
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        Buffer.from(segments[2] ?? "", "base64url"),
        new TextEncoder().encode(segments.slice(0, 2).join(".")),
      ),
    ).resolves.toBe(true);
    expect(requests[1]?.init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      repositories: ["pkgstory"],
      permissions: { contents: "write" },
    });
    expect(requests[2]?.init).toMatchObject({ method: "POST" });
    expect(requests[2]?.init.headers).toMatchObject({
      Authorization: "Bearer installation-token",
      "User-Agent": "pkgstory-crawl-trigger",
    });
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({ event_type: "crawl" });
  });

  it("logs and rethrows a GitHub API failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Unavailable" })),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runScheduled({ APP_ID: "12345", APP_PRIVATE_KEY: privateKeyPem })).rejects.toThrow(
      "installation lookup failed: 503 Unavailable — unavailable",
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("crawl dispatch failed: Error: installation lookup failed"),
    );
  });

  it("identifies a failed repository dispatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/installation")) {
          return new Response(JSON.stringify({ id: 42 }));
        }
        if (url.endsWith("/access_tokens")) {
          return new Response(JSON.stringify({ token: "installation-token" }));
        }
        return new Response("invalid event", { status: 422, statusText: "Unprocessable Content" });
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runScheduled({ APP_ID: "12345", APP_PRIVATE_KEY: privateKeyPem })).rejects.toThrow(
      "repository_dispatch failed: 422 Unprocessable Content — invalid event",
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("crawl dispatch failed: Error: repository_dispatch failed"),
    );
  });
});
