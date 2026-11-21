import { MACOS_RELEASE_ORDER } from "../../site/src/lib/macos-releases.ts";

export interface ParsedCask {
  version: string | null;
}

const VERSION = /^version[ \t]+(?:(["'])([^"'\r\n]+)\1|:(latest)\b)/;
const TOP_LEVEL_VERSION = /^ {2}version[ \t]+(?:(["'])([^"'\r\n]+)\1|:(latest)\b)/m;
const PLATFORM_BLOCK = /^on_([a-z_]+)(?:\s+:(or_newer|or_older))?\s+do\s*(?:#.*)?$/;
const SYSTEM_BLOCK =
  /^on_system\s+:linux,\s*macos:\s*:([a-z_]+?)(?:_(or_newer|or_older))?\s+do\s*(?:#.*)?$/;
const CONDITIONAL =
  /^(if|elsif)\s+(?:Hardware::CPU\.intel\?|MacOS\.(?:version|release)\s*<=\s*:([a-z_]+))\s*(?:#.*)?$/;
// A lower index wins. Linux follows all macOS releases. Intel is the only
// architecture with a macOS release before Big Sur in Homebrew's cask DSL.
const unlistedRelease = "(unlisted macOS)";
const releases = [unlistedRelease, ...[...MACOS_RELEASE_ORDER.keys()].reverse()];
const knownPlatforms = new Set(["arm", "intel", "macos", "linux", ...MACOS_RELEASE_ORDER.keys()]);
const oldestArmIndex = releases.indexOf("big_sur");
const preferredPlatforms = releases.concat("linux").flatMap((os, index) =>
  (os === "linux" || index <= oldestArmIndex ? ["arm", "intel"] : ["intel"]).map((arch) => ({
    os,
    arch,
  })),
);
type Platform = (typeof preferredPlatforms)[number];
interface Block {
  platforms: Platform[];
  unlisted: boolean;
  otherwise?: Platform[];
}

function matchesPlatform(platform: Platform, name: string, range?: string): boolean {
  if (name === "arm" || name === "intel") return platform.arch === name;
  if (name === "linux" || name === "macos") return (platform.os === "linux") === (name === "linux");
  if (platform.os === "linux") return false;
  const release = MACOS_RELEASE_ORDER.get(name) ?? Infinity;
  const current = MACOS_RELEASE_ORDER.get(platform.os) ?? Infinity;
  if (range === "or_newer") return current >= release;
  if (range === "or_older") return current <= release;
  return current === release;
}

export function parseCask(src: string): ParsedCask {
  const common = TOP_LEVEL_VERSION.exec(src);
  if (common) return { version: common[2] ?? common[3] ?? null };

  let bestRank = Infinity;
  let version: string | null = null;
  const blocks: Block[] = [{ platforms: preferredPlatforms, unlisted: false }];
  for (const line of src.split("\n")) {
    const indent = line.search(/\S/);
    if (indent < 2 || line[indent] === "#" || indent % 2 !== 0) continue;
    const depth = indent / 2;
    // Only a platform block can introduce another level of package metadata.
    // This excludes similarly named calls inside livecheck and Ruby hooks.
    const parent = blocks[depth - 1];
    const otherwise = blocks[depth]?.otherwise;
    if (blocks.length > depth) blocks.length = depth;
    if (!parent || parent.platforms.length === 0) continue;
    const statement = line.slice(indent);
    const literal = VERSION.exec(statement);
    if (literal) {
      // Only an explicit unlisted release can outrank the newest known macOS.
      const firstPlatform = parent.platforms.find(
        (p) => parent.unlisted || p.os !== unlistedRelease,
      );
      if (!firstPlatform) continue;
      const rank = preferredPlatforms.indexOf(firstPlatform);
      if (rank < bestRank) {
        version = literal[2] ?? literal[3] ?? null;
        if (rank === 0) return { version };
        bestRank = rank;
      }
      continue;
    }
    if (/^language\s+["'][^#]*,\s*default:\s*true\s+do\s*(?:#.*)?$/.test(statement)) {
      blocks[depth] = { platforms: parent.platforms, unlisted: parent.unlisted };
      continue;
    }
    if (/^else\s*(?:#.*)?$/.test(statement)) {
      if (otherwise) blocks[depth] = { platforms: otherwise, unlisted: parent.unlisted };
      continue;
    }
    const conditional = CONDITIONAL.exec(statement);
    if (conditional) {
      const candidates = conditional[1] === "if" ? parent.platforms : otherwise;
      if (!candidates) continue;
      const selected: Platform[] = [];
      const remaining: Platform[] = [];
      for (const platform of candidates) {
        const matches = conditional[2]
          ? matchesPlatform(platform, conditional[2], "or_older")
          : platform.arch === "intel";
        (matches ? selected : remaining).push(platform);
      }
      blocks[depth] = { platforms: selected, otherwise: remaining, unlisted: parent.unlisted };
      continue;
    }
    const condition = PLATFORM_BLOCK.exec(statement) ?? SYSTEM_BLOCK.exec(statement);
    if (condition?.[1]) {
      const name = condition[1];
      const withLinux = statement.startsWith("on_system ");
      blocks[depth] = {
        platforms: parent.platforms.filter(
          (p) => (withLinux && p.os === "linux") || matchesPlatform(p, name, condition[2]),
        ),
        unlisted: parent.unlisted || !knownPlatforms.has(name),
      };
    }
  }
  return { version };
}
