import { describe, expect, it } from "vitest";
import { parseCask } from "../src/parse/cask.ts";
import { parseFormula, versionFromUrl } from "../src/parse/formula.ts";
import { parseLifecycle } from "../src/parse/lifecycle.ts";
import { versionFromSubject } from "../src/parse/subject.ts";

describe("parseFormula", () => {
  it("prefers an explicit version stanza and reads revision", () => {
    const src = `class Foo < Formula
  url "https://example.com/foo.tar.gz"
  version "1.2.3"
  revision 2
end`;
    expect(parseFormula(src)).toEqual({
      version: "1.2.3",
      revision: 2,
      versionSrc: "version-stanza",
    });
  });

  it("mines the version from a release tarball url", () => {
    const src = `class Git < Formula
  url "https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz"
end`;
    const p = parseFormula(src);
    expect(p.version).toBe("2.54.0");
    expect(p.versionSrc).toBe("url");
  });

  it("ignores nested resource urls when the formula has no version", () => {
    const src = `class Foo < Formula
  resource "bar" do
    url "https://example.com/bar-9.9.9.tar.gz"
  end
end`;
    expect(parseFormula(src).version).toBeNull();
  });

  it("ignores source archive labels on release tarball urls", () => {
    const src = `class Rust < Formula
  url "https://static.rust-lang.org/dist/rustc-1.96.0-src.tar.gz"
end`;
    expect(parseFormula(src).version).toBe("1.96.0");
  });

  it("mines versions from old-style Homebrew instance variable urls", () => {
    const src = `class Dos2unix <Formula
  @url='http://www.sfr-fresh.com/linux/misc/dos2unix-3.1.tar.gz'
end`;
    expect(parseFormula(src).version).toBe("3.1");
  });

  it("reads old-style Homebrew instance variable versions", () => {
    const src = `class Ack <UncompressedScriptFormula
  def initialize
    @version='1.88'
    @url="http://ack.googlecode.com/svn/tags/#{@version}/ack"
  end
end`;
    expect(parseFormula(src)).toEqual({
      version: "1.88",
      revision: 0,
      versionSrc: "version-stanza",
    });
  });

  it("reads a git tag option", () => {
    const src = `class Bar < Formula
  url "https://github.com/bar/bar.git",
      tag:      "v3.1.4",
      revision: "deadbeef"
end`;
    expect(parseFormula(src).version).toBe("3.1.4");
  });

  it("returns null version when nothing is parseable", () => {
    expect(parseFormula("class X < Formula\nend").version).toBeNull();
  });
});

describe("versionFromUrl", () => {
  it("handles GitHub archive tags", () => {
    expect(versionFromUrl("https://github.com/a/b/archive/refs/tags/v1.7.1.tar.gz")).toBe("1.7.1");
  });
  it("handles releases/download", () => {
    expect(
      versionFromUrl("https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-1.7.1.tar.gz"),
    ).toBe("1.7.1");
  });
  it("mines a bare-integer version from the filename", () => {
    expect(
      versionFromUrl(
        "https://github.com/apple-oss-distributions/bsdmake/archive/refs/tags/bsdmake-24.tar.gz",
      ),
    ).toBe("24");
  });
  it("mines a date-style integer version", () => {
    expect(
      versionFromUrl(
        "https://deb.debian.org/debian/pool/main/c/crm114/crm114_20100106.orig.tar.gz",
      ),
    ).toBe("20100106");
  });
  it("normalizes an underscore-encoded version", () => {
    expect(
      versionFromUrl("https://github.com/conformal/clens/archive/refs/tags/CLENS_0_7_0.tar.gz"),
    ).toBe("0.7.0");
  });
  it("finds the tarball inside a closer.lua mirror query", () => {
    expect(
      versionFromUrl(
        "https://www.apache.org/dyn/closer.lua?path=arrow/apache-arrow-adbc-23/apache-arrow-adbc-23.tar.gz",
      ),
    ).toBe("23");
  });
});

describe("parseCask", () => {
  it("reads a version stanza with a build suffix", () => {
    expect(parseCask('cask "x" do\n  version "1.122.1,abc123"\nend').version).toBe(
      "1.122.1,abc123",
    );
  });
  it("maps :latest", () => {
    expect(parseCask('cask "x" do\n  version :latest\nend').version).toBe("latest");
  });
  it("reads an arch-conditional version inside an on_arm block", () => {
    const src = `cask "y" do
  on_arm do
    version "2.5.0,arm64.001"
    sha256 "aaaa"
  end
  on_intel do
    version "2.5.0,x64.001"
    sha256 "bbbb"
  end
end`;
    expect(parseCask(src).version).toBe("2.5.0,arm64.001");
  });
});

describe("parseLifecycle", () => {
  it("keeps both stanzas (terraform's BUSL exit)", () => {
    const src = `class Terraform < Formula
  url "https://github.com/hashicorp/terraform/archive/refs/tags/v1.5.7.tar.gz"
  deprecate! date: "2024-04-04", because: "changed its license to BUSL on the next release"
  disable! date: "2025-04-12", because: "changed its license to BUSL on the next release"
end`;
    expect(parseLifecycle(src)).toEqual({
      deprecate: { date: "2024-04-04", reason: "changed its license to BUSL on the next release" },
      disable: { date: "2025-04-12", reason: "changed its license to BUSL on the next release" },
    });
  });

  it("reads a lone deprecate! (no disable scheduled)", () => {
    expect(parseLifecycle('  deprecate! date: "2023-01-02", because: "is unmaintained"')).toEqual({
      deprecate: { date: "2023-01-02", reason: "is unmaintained" },
      disable: null,
    });
  });

  it("captures a future-dated, scheduled disable separately", () => {
    expect(
      parseLifecycle(
        '  deprecate! date: "2026-11-10", because: "needs end-of-life .NET 9"\n  disable! date: "2027-11-10", because: "needs end-of-life .NET 9"',
      ),
    ).toEqual({
      deprecate: { date: "2026-11-10", reason: "needs end-of-life .NET 9" },
      disable: { date: "2027-11-10", reason: "needs end-of-life .NET 9" },
    });
  });

  it("maps a symbol reason to brew's predicate phrasing", () => {
    expect(
      parseLifecycle('  disable! date: "2024-12-31", because: :repo_archived').disable,
    ).toEqual({
      date: "2024-12-31",
      reason: "has an archived upstream repository",
    });
  });

  it("falls back to a grammatical predicate for an unknown symbol", () => {
    expect(parseLifecycle("  disable! because: :some_new_reason").disable?.reason).toBe(
      "is some new reason",
    );
  });

  it("returns null stanzas for an active formula", () => {
    expect(parseLifecycle('class Foo < Formula\n  version "1.0"\nend')).toEqual({
      deprecate: null,
      disable: null,
    });
  });

  it("ignores the keyword in a comment or caveat string", () => {
    const src = `class Foo < Formula
  # disable! is coming next release
  def caveats
    "Run disable! to turn it off"
  end
end`;
    expect(parseLifecycle(src)).toEqual({ deprecate: null, disable: null });
  });
});

describe("versionFromSubject", () => {
  it("parses a plain bump", () => {
    expect(versionFromSubject("git", "git 2.54.0")).toBe("2.54.0");
  });
  it("parses a bump with a trailing PR number", () => {
    expect(versionFromSubject("visual-studio-code", "visual-studio-code 1.122.1 (#12345)")).toBe(
      "1.122.1",
    );
  });
  it("ignores non-bump subjects", () => {
    expect(versionFromSubject("git", "git: remove iconv dependency.")).toBeNull();
  });
  it("ignores old formula-addition subjects", () => {
    expect(versionFromSubject("dos2unix", "dos2unix formula")).toBeNull();
  });
  it("keeps subject fallback conservative for cask-style and tilde versions", () => {
    expect(versionFromSubject("foo", "foo 1.2.3,456")).toBeNull();
    expect(versionFromSubject("foo", "foo 1.2.3~rc1")).toBeNull();
  });
});
