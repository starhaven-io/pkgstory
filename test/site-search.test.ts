import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the bundled page script with a small DOM boundary and deferred fetch.
function searchPage(fetch: typeof globalThis.fetch) {
  const listeners = new Map<string, () => Promise<void>>();
  const input = {
    value: "",
    addEventListener: (name: string, callback: () => Promise<void>) =>
      listeners.set(name, callback),
  };
  const results = { hidden: true, innerHTML: "", textContent: "" };
  const recent = { hidden: false };
  const elements = new Map<string, unknown>([
    ["q", input],
    ["results", results],
    ["recent", recent],
  ]);
  const page = readFileSync(new URL("../site/src/pages/index.astro", import.meta.url), "utf8");
  const script = page.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) throw new Error("home-page search script missing");
  runInNewContext(stripTypeScriptTypes(script), {
    document: { getElementById: (id: string) => elements.get(id) },
    fetch,
  });
  return {
    results,
    recent,
    search: async (value: string) => {
      input.value = value;
      const listener = listeners.get("input");
      if (!listener) throw new Error("input listener missing");
      await listener();
    },
  };
}

const catalog = [{ n: "alpha", s: "f", v: "1.0", r: 0, c: 2 }];

function pendingResponse() {
  let complete: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve: (response: Response) => {
      if (!complete) throw new Error("response resolver missing");
      complete(response);
    },
  };
}

describe("home-page search", () => {
  it("shares an in-flight catalog request and keeps the newest query", async () => {
    const response = pendingResponse();
    const fetch = vi.fn(() => response.promise);
    const page = searchPage(fetch);
    const first = page.search("alpha");
    const second = page.search("beta");
    response.resolve(Response.json(catalog));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(page.results.innerHTML).toContain("0 matches");
    expect(page.results.innerHTML).not.toContain("/alpha/");
  });

  it("does not restore old results when the query is cleared during loading", async () => {
    const response = pendingResponse();
    const page = searchPage(vi.fn(() => response.promise));
    const pending = page.search("alpha");
    await page.search("");
    response.resolve(Response.json(catalog));
    await pending;
    expect(page.results.hidden).toBe(true);
    expect(page.results.innerHTML).toBe("");
    expect(page.recent.hidden).toBe(false);
  });

  it("shows a retryable error and then uses the successful catalog", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(catalog));
    const page = searchPage(fetch);
    await page.search("alpha");
    expect(page.results.textContent).toContain("Try again");
    expect(page.recent.hidden).toBe(false);
    await page.search("alpha");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(page.results.innerHTML).toContain("/alpha/");
    expect(page.recent.hidden).toBe(true);
  });
});
