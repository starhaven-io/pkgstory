import { describe, expect, it } from "vitest";
import { parseCask } from "../src/parse/cask.ts";
import { extractVersion } from "../src/parse/extract.ts";
import { parseFormula, versionFromUrl } from "../src/parse/formula.ts";
import { parseLifecycle } from "../src/parse/lifecycle.ts";
import { versionFromSubject } from "../src/parse/subject.ts";

describe("parseFormula", () => {
  it("reads the named package in a formula file that also declares a helper formula", () => {
    const helper = `class GitFlowCompletion < Formula
  url 'https://github.com/bobthecow/git-flow-completion/archive/0.4.2.2.tar.gz'
end`;
    const formula = `class GitFlow < Formula
  url 'https://github.com/nvie/gitflow.git', :tag => '0.4.1'
end`;
    for (const src of [
      [helper, formula],
      [formula, helper],
    ]) {
      expect(extractVersion("formula", "git-flow", "", src.join("\n")).version).toBe("0.4.1");
    }
  });

  it("retains historical URL and metadata selection when the package has no stable tag", () => {
    const src = `class BuildHelper < Formula
  url "https://example.org/helper-1.5.tar.gz"
  revision 2
  bottle do
    sha256 "abc" => :arm64_sonoma
  end
end
class Package < Formula
  url "https://example.org/package-3.0.tar.gz"
  head "https://example.org/development.git", tag: "unrelated-9.0"
end`;
    expect(parseFormula(src, "package")).toEqual({
      version: "1.5",
      revision: 2,
      versionSrc: "url",
      bottled: true,
      bottleTags: ["arm64_sonoma"],
    });
  });

  it.each(['tag: "stable-2.2.1"', ':tag => "stable-2.2.1"', ":tag=>'stable-2.2.1'"])(
    "reads Linkerd's version from the Git option %s",
    (tag) => {
      const src = `class Linkerd < Formula
  url "https://github.com/linkerd/linkerd2.git",
      ${tag},
      :revision => "5e47cb150a33150e5aeddc6672d8a64701a970de"
end`;
      expect(parseFormula(src)).toMatchObject({ version: "2.2.1", versionSrc: "url" });
    },
  );
  it.each([
    ["make", 'url "https://ftpmirror.gnu.org/make/make-4.4.1.tar.lz"', "4.4.1"],
    [
      "action-validator",
      'url "https://static.crates.io/crates/action-validator/action-validator-0.9.0.crate"',
      "0.9.0",
    ],
    ["antlr", 'url "https://www.antlr.org/download/antlr-4.13.2-complete.jar"', "4.13.2"],
    [
      "linkerd",
      'url "https://github.com/linkerd/linkerd2.git",\n      tag: "version-2.20"',
      "2.20",
    ],
    ["bun", 'url "https://github.com/oven-sh/bun.git", tag: "bun-v1.4.4"', "1.4.4"],
    ["autossh", 'url "https://www.harding.motd.ca/autossh/autossh-1.4g.tgz"', "1.4g"],
    ["quickjs", 'url "https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz"', "2026-06-04"],
    [
      "boost",
      'url "https://github.com/boostorg/boost/releases/download/boost-1.92.0/boost-1.92.0-b2-nodocs.tar.xz"',
      "1.92.0",
    ],
    [
      "openjdk",
      'url "https://github.com/openjdk/jdk27u/archive/refs/tags/jdk-27.0.1.0.3-ga.tar.gz"',
      "27.0.1.0.3",
    ],
    [
      "kafka",
      'url "https://www.apache.org/dyn/closer.lua?path=kafka/4.4.0/kafka_2.13-4.4.0.tgz"',
      "4.4.0",
    ],
    ["pypy", 'url "https://downloads.python.org/pypy/pypy2.7-v8.0.1-src.tar.gz"', "8.0.1"],
    ["wolfssl", 'url "https://github.com/wolfSSL/wolfssl.git", tag: "v5.9.4-stable"', "5.9.4"],
    ["jenkins", 'url "https://get.jenkins.io/war/2.590/jenkins.war"', "2.590"],
    ["nauty", 'url "https://pallini.di.uniroma1.it/nauty2_9_3.tar.gz"', "2.9.3"],
    ["apparix", 'url "https://micans.org/apparix/src/apparix-11-062.tar.gz"', "11-062"],
    ["lft", 'url "https://pwhois.org/dl/index.who?file=lft-4.03.tar.gz"', "4.03"],
    ["tzdb", 'url "https://data.iana.org/time-zones/releases/tzdb-2026f.tar.lz"', "2026f"],
    [
      "basis_universal",
      'url "https://github.com/BinomialLLC/basis_universal/archive/refs/tags/v2_50.tar.gz"',
      "2.50",
    ],
  ])("agrees with the Homebrew stable version of %s", (_name, stanza, expected) => {
    expect(parseFormula(`class Package < Formula\n  ${stanza}\nend`).version).toBe(expected);
  });

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
      bottled: false,
      bottleTags: [],
    });
  });

  it("reads a single-quoted version stanza, winning over a single-file url", () => {
    // ack's 2009-era formula: `version '2.02'` plus a beyondgrep single-file url.
    const src = `class Ack < Formula
  url 'http://beyondgrep.com/ack-2.02-single-file'
  version '2.02'
end`;
    expect(parseFormula(src)).toEqual({
      version: "2.02",
      revision: 0,
      versionSrc: "version-stanza",
      bottled: false,
      bottleTags: [],
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
      bottled: false,
      bottleTags: [],
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

  it("honors a literal version even when Homebrew strips its qualifier during tag detection", () => {
    const stanza = '  url "https://example.org/tool-9.0.tar.gz", tag: "tool-1.2.3-RELEASE"';
    expect(parseFormula(stanza)).toMatchObject({ version: "1.2.3", versionSrc: "url" });
    expect(parseFormula([stanza, '  version "1.2.3-RELEASE"'].join("\n"))).toMatchObject({
      version: "1.2.3-RELEASE",
      versionSrc: "version-stanza",
    });
    expect(
      parseFormula('  url "https://example.org/tool-9.0.tar.gz", tag: "stable"').version,
    ).toBeNull();
  });

  it("reads version metadata from a historical stable block", () => {
    const tagged = `class Bar < Formula
  stable do
    url "https://github.com/bar/bar.git",
        tag: "v3.1.4",
        revision: "deadbeef"
  end
end`;
    expect(parseFormula(tagged).version).toBe("3.1.4");

    const explicit = `class Bar < Formula
  stable do
    url "https://example.com/download"
    version "2.8.0-r3"
    revision 2
  end
end`;
    expect(parseFormula(explicit)).toMatchObject({
      version: "2.8.0-r3",
      revision: 2,
      versionSrc: "version-stanza",
    });
  });

  it("follows a url comma continuation even when the tag is only two-space indented", () => {
    const src = `class Bar < Formula
  url "https://github.com/bar/bar.git",
  tag: "v3.1.4"
end`;
    expect(parseFormula(src).version).toBe("3.1.4");
  });

  it("associates a tag only with the top-level package url", () => {
    const src = `class Foo < Formula
  url "https://example.com/foo-1.2.3.tar.gz"
  livecheck do
    url :stable
    strategy :github_latest do |json|
      json["tag_name"]
    end
  end
  resource "bar" do
    url "https://github.com/bar/bar.git", tag: "v9.9.9"
  end
end`;
    expect(parseFormula(src).version).toBe("1.2.3");
  });

  it("rejects revisions that cannot be represented exactly", () => {
    expect(
      parseFormula(`class X < Formula\n  revision ${Number.MAX_SAFE_INTEGER}\nend`).revision,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      parseFormula(`class X < Formula\n  revision ${BigInt(Number.MAX_SAFE_INTEGER) + 1n}\nend`),
    ).toThrow(/safe integer range/);
    expect(() => parseFormula(`class X < Formula\n  revision ${"9".repeat(400)}\nend`)).toThrow(
      /safe integer range/,
    );
    expect(() => parseFormula("class X < Formula\n  revision 12__345\nend")).toThrow(
      /unsupported formula revision/,
    );
    expect(() => parseFormula("class X < Formula\n  revision 9oops\nend")).toThrow(
      /unsupported formula revision/,
    );
  });

  it("parses Ruby digit separators across the complete revision token", () => {
    expect(parseFormula("class X < Formula\n  revision 1_000\nend").revision).toBe(1000);
    expect(parseFormula("class X < Formula\n  revision 0_10\nend").revision).toBe(8);
    expect(() => parseFormula("class X < Formula\n  revision 08\nend")).toThrow(
      /unsupported formula revision/,
    );
    expect(() => parseFormula(`class X < Formula\n  revision 9_007_199_254_740_992\nend`)).toThrow(
      /safe integer range/,
    );
  });

  it("does not parse formula-like text after Ruby's __END__ data marker", () => {
    const src = `class X < Formula
  url "https://example.com/x-1.0.tar.gz"
end
__END__
  revision 9oops
  bottle do
    sha256 "abc" => :sonoma
  end`;
    expect(parseFormula(src)).toMatchObject({ version: "1.0", revision: 0, bottled: false });
  });

  it("returns null version when nothing is parseable", () => {
    expect(parseFormula("class X < Formula\nend").version).toBeNull();
  });

  it("scans a long blank run in linear time", () => {
    const src = `class Foo < Formula\n  url "https://example.com/foo-1.0.tar.gz"\n${"\n".repeat(200_000)}end\n`;
    const start = performance.now();
    expect(parseFormula(src).version).toBe("1.0");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("accepts any whitespace but a newline as indentation", () => {
    expect(parseFormula("class X < Formula\n\f\v\xa0@version = '1.0'\nend").version).toBe("1.0");
    expect(
      parseFormula("class X < Formula\n\f\xa0@url = 'https://example.com/x-2.0.tar.gz'\nend")
        .version,
    ).toBe("2.0");
  });

  it("recognizes artifact bottle blocks but not modifiers, comments, or nested calls", () => {
    expect(
      parseFormula('class X < Formula\n  bottle do\n    sha256 "abc" => :arm64_tahoe\n  end\nend')
        .bottled,
    ).toBe(true);
    expect(
      parseFormula("class X < Formula\n  bottle 'https://example.com/x-1.0-bottle.tar.gz'\nend")
        .bottled,
    ).toBe(true);
    expect(
      parseFormula('class X < Formula\n  bottle "https://example.com/x-1.0-bottle.tar.gz"\nend')
        .bottled,
    ).toBe(true);
    expect(parseFormula("class X < Formula\n  bottle :unneeded\nend").bottled).toBe(false);
    expect(
      parseFormula('class X < Formula\n  bottle :disable,\n    "no bottles"\nend').bottled,
    ).toBe(false);
    expect(parseFormula("class X < Formula\n  # bottle do\nend").bottled).toBe(false);
    expect(parseFormula("class X < Formula\n  bottle do\n  end\nend").bottled).toBe(false);
    expect(
      parseFormula("class X < Formula\n  resource do\n    bottle do\n    end\n  end\nend").bottled,
    ).toBe(false);
  });

  it("extracts each modern bottle platform and preserves legacy bottles", () => {
    const modern = `class X < Formula
  bottle do
    sha256 cellar: :any_skip_relocation, arm64_sonoma: "aaa"
    sha256 cellar: :any, sonoma: "bbb"
    sha256 "ccc" => :ventura
  end
end`;
    expect(parseFormula(modern).bottleTags).toEqual(["arm64_sonoma", "sonoma", "ventura"]);
    expect(
      parseFormula("class X < Formula\n  bottle 'https://example.com/x-bottle.tar.gz'\nend")
        .bottleTags,
    ).toEqual(["legacy"]);
    expect(
      parseFormula('class X < Formula\n  bottle do\n    sha1 "abc"\n  end\nend').bottleTags,
    ).toEqual(["legacy"]);
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
  it("strips a build/artifact label the version regex swept in", () => {
    expect(versionFromUrl("https://x/activemq/6.2.6/apache-activemq-6.2.6-bin.tar.gz")).toBe(
      "6.2.6",
    );
    expect(versionFromUrl("https://x/installers/8.0/racket-minimal-8.0-src-builtpkgs.tgz")).toBe(
      "8.0",
    );
    expect(versionFromUrl("https://beyondgrep.com/ack-2.24-single-file")).toBe("2.24");
  });
  it("strips a trailing platform label", () => {
    expect(
      versionFromUrl("https://downloads.sourceforge.net/project/x/v1.9.2/ispc-v1.9.2-osx.tar.gz"),
    ).toBe("1.9.2");
  });
  it("follows Homebrew's numeric version detection for Swift release tags and artifact names", () => {
    expect(
      versionFromUrl(
        "https://github.com/swiftlang/swift/archive/refs/tags/swift-6.2.4-RELEASE.tar.gz",
      ),
    ).toBe("6.2.4");
    expect(versionFromUrl("https://x/foo-1.2.3-binutils.tar.gz")).toBe("1.2.3");
  });
  it.each([
    "1.2.3-beta",
    "1.2.3-beta.1",
    "1.2.3rc4",
    "1.2.3-p34",
    "1.2.3.post2",
    "1.2.3-post2",
    "1.2.3_post2",
  ])("keeps the release qualifier in %s", (version) => {
    expect(versionFromUrl(`https://x/foo-${version}.tar.gz`)).toBe(version);
  });
  it("reads SourceForge download redirects and URI-encoded release paths", () => {
    expect(versionFromUrl("https://sourceforge.net/project/foo/tool-1.9.tar.gz/download")).toBe(
      "1.9",
    );
    expect(versionFromUrl("https://sourceforge.net/pkg.1/download")).toBeNull();
    expect(versionFromUrl("https://example.org/releases/v%31%2e%39/tool.jar")).toBe("1.9");
    expect(versionFromUrl("https://example.org/broken%/tool-1.9.tar.gz")).toBe("1.9");
  });
  it("gives a numeric GitHub release directory precedence over an asset's version", () => {
    expect(
      versionFromUrl("https://github.com/example/tool/releases/download/v3.2/tool-3.2.0-src.tgz"),
    ).toBe("3.2");
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

describe("extractVersion", () => {
  it("uses the cask version stanza", () => {
    expect(
      extractVersion("cask", "app", "app 9.9", 'cask "app" do\n  version "2.5,123"\nend'),
    ).toEqual({
      version: "2.5,123",
      revision: 0,
      versionSrc: "version-stanza",
      bottled: false,
      bottleTags: [],
    });
  });

  it("falls back to a conservative matching commit subject", () => {
    expect(extractVersion("formula", "foo", "foo 1.2.3", "class Foo < Formula\nend")).toEqual({
      version: "1.2.3",
      revision: 0,
      versionSrc: "subject",
      bottled: false,
      bottleTags: [],
    });
    expect(extractVersion("cask", "app", "app 4.5", 'cask "app" do\nend')).toEqual({
      version: "4.5",
      revision: 0,
      versionSrc: "subject",
      bottled: false,
      bottleTags: [],
    });
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

  it("follows a stanza's arguments onto continuation lines", () => {
    // Casks/a/archi.rb in homebrew/cask
    const archi = `  disable! date:    "2025-11-18",
           because: "the developer intentionally makes distribution difficult for package managers"

  depends_on :macos`;
    expect(parseLifecycle(archi).disable).toEqual({
      date: "2025-11-18",
      reason: "the developer intentionally makes distribution difficult for package managers",
    });

    // A scheduled date on the continuation line must not read as already in effect.
    const scheduled = `  disable! because: :unmaintained,
           date:    "2099-01-01"`;
    expect(parseLifecycle(scheduled).disable).toEqual({
      date: "2099-01-01",
      reason: "is not maintained upstream",
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

  it("scans a long blank run in linear time", () => {
    const src = `class Foo < Formula\n  disable! because: :unmaintained\n${"\n".repeat(200_000)}end\n`;
    const start = performance.now();
    expect(parseLifecycle(src)).toEqual({
      deprecate: null,
      disable: { date: null, reason: "is not maintained upstream" },
    });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("accepts any whitespace but a newline as indentation", () => {
    const src =
      "class Foo < Formula\n\f\v\xa0deprecate! because: :unmaintained\n\f\xa0disable! because: :no_license\nend";
    expect(parseLifecycle(src)).toEqual({
      deprecate: { date: null, reason: "is not maintained upstream" },
      disable: { date: null, reason: "has no license" },
    });
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
