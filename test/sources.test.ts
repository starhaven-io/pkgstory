import { describe, expect, it } from "vitest";
import { makeSource } from "../src/sources/index.ts";

const formula = makeSource(
  {
    id: "homebrew-formula",
    label: "Formula",
    tap: "homebrew/core",
    dir: "Formula",
    kind: "formula",
  },
  "/tmp/core",
);
const cask = makeSource(
  {
    id: "homebrew-cask",
    label: "Cask",
    tap: "homebrew/cask",
    dir: "Casks",
    kind: "cask",
  },
  "/tmp/cask",
);

describe("source path mapping", () => {
  it("accepts supported current and historical roots", () => {
    expect(formula.packageOf("Formula/foo.rb")).toBe("foo");
    expect(formula.packageOf("Formula/f/foo.rb")).toBe("foo");
    expect(formula.packageOf("Library/Formula/foo.rb")).toBe("foo");
    expect(cask.packageOf("Casks/app.rb")).toBe("app");
    expect(cask.packageOf("Casks/a/app.rb")).toBe("app");
    expect(cask.packageOf("Casks/font/font-a/font-abc.rb")).toBe("font-abc");
    expect(cask.packageOf("Casks/f/font-abc.rb")).toBe("font-abc");
    expect(cask.packageOf("Casks/c/kuaitie.rb")).toBe("kuaitie");
    expect(formula.packageOf("Formula/l/libfoo.rb")).toBe("libfoo");
  });

  it("rejects decoy roots, excess nesting, traversal, and non-Ruby files", () => {
    for (const path of [
      "docs/Formula/foo.rb",
      "Library/Homebrew/test/Formula/foo.rb",
      "Formula/fixtures/foo.rb",
      "Formula/z/foo.rb",
      "Formula/a/b/foo.rb",
      "Formula/../foo.rb",
      "Formula/...rb",
      "Formula/über.rb",
      "Formula/%2e%2e.rb",
      "Formula/foo.txt",
      "/Formula/foo.rb",
    ]) {
      expect(formula.packageOf(path)).toBeNull();
    }
    expect(cask.packageOf("Casks/a/b/c/app.rb")).toBeNull();
    expect(cask.packageOf("Casks/a/b/app.rb")).toBeNull();
  });

  it("includes legacy formula paths and rejects unsafe curated names", () => {
    expect(formula.pathsFor("foo")).toContain("Library/Formula/foo.rb");
    expect(formula.pathsFor("libfoo")).toContain("Formula/l/libfoo.rb");
    expect(cask.pathsFor("font-abc")).toContain("Casks/f/font-abc.rb");
    expect(cask.pathsFor("kuaitie")).toContain(":(glob)Casks/?/kuaitie.rb");
    expect(() => formula.pathsFor("../foo")).toThrow(/invalid package name/);
  });
});
