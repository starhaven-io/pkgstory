import { posix } from "node:path";

// Adapted from Homebrew/brew's Library/Homebrew/version.rb (Version.detect),
// version/parser.rb (Version::StemParser) and extend/pathname.rb (archive extensions).
// The upstream BSD-2-Clause notice is in homebrew-version.LICENSE.txt.
type VersionRule = readonly [
  part: "stem" | "spec",
  pattern: RegExp,
  normalize?: (version: string) => string,
];
const contentSuffix = "[._-](?i:bin|dist|stable|src|sources?|final|full)";

// First match wins. An archive can name both a runtime and a package version,
// or carry a build number in a suffix (pypy2.7-v8.0.1-src, boost-1.92.0-b2-nodocs).
const VERSION_RULES: readonly VersionRule[] = [
  ["stem", /(\d{4}-\d{2}-\d{2})/],
  ["spec", /github\.com\/.+\/(?:zip|tar)ball\/(?:v|\w+-)?((?:\d+[._-])+\d*)$/],
  ["spec", /github\.com\/.+\/releases\/download\/(?:[rvV]_?)?(\d+(?:\.\d+)+)\//],
  ["spec", /[_-]([Rr]\d+[AaBb]\d*(?:-\d+)?)/],
  ["stem", /((?:\d+_)+\d+)$/, (version) => version.replaceAll("_", ".")],

  ["stem", new RegExp(String.raw`[_-](\d+(?:\.\d+)+-(?:p|P|rc|RC)?\d+)(?:${contentSuffix})?$`)],
  ["stem", /^v?(\d+(?:\.\d+)+(?:-\d+(?:\.\d+)*)+)/],
  ["spec", /[-v](\d+(?:\.\d+)*)$/],
  ["stem", /-(\d+-\d+)/],
  ["stem", /-(\d+(?:\.\d+)*)$/],
  // Upstream accepts multiple post-release separators, including .post2 and -post2.
  ["stem", /-(\d+(?:\.\d+)*.post\d+)$/],
  ["stem", /-(\d+(?:\.\d+)*(?:[abc]|rc|RC)\d*)$/],
  ["stem", /-(\d+(?:\.\d+)*-(?:alpha|beta|rc)\d*)$/],

  ["stem", /-(\d+(?:\.\d+){1,2})-w(?:in)?(?:32|64)$/],
  ["stem", /\.(\d+(?:\.\d+){1,2})\+opam$/],
  ["stem", /[_-](\d+(?:\.\d+){1,2}(?:-\d+)?)[._-](?:i[36]86|x86|x64(?:[_-](?:32|64))?)$/],
  ["stem", /(\d+(?:\.\d+)+[._-]?(?:alpha|beta|pre|rc)\.?\d{0,2})/i],
  ["stem", /(\d+(?:\.\d+)*)$/],
  ["stem", new RegExp(String.raw`[-vV](\d+(?:\.\d+)+[abc]?)${contentSuffix}$`)],
  ["stem", /-(\d+(?:\.\d+)+)-/],
  ["stem", /_(\d+(?:\.\d+)*[abc]?)\.orig$/],

  ["stem", /-v?(\d[^-]+)/],
  ["stem", /_v?(\d[^_]+)/],
  ["spec", /\/(?:[rvV]_?)?(\d+\.\d+(?:\.\d+){0,2})/],
  ["stem", /\.v(\d+[a-z]?)/],
  ["spec", /(\d+(?:\.\d+)+(?:[._-]?(?:alpha|beta|pre|rc)\.?\d{0,2})?)/i],
];

function sourceStem(spec: string): string {
  const sourceForgeDownload = /(?:sourceforge\.net|sf\.net)\/.*\/download$/.test(spec);
  const file = posix.basename(sourceForgeDownload ? posix.dirname(spec) : spec);
  if (!sourceForgeDownload && /\.[^a-zA-Z]+$/.test(spec)) return file;
  const archive =
    /\.(?:[a-z0-9_]+\.bottle\.(?:\d+\.)?tar\.gz|(?:tar|cpio|pax)\.(?:gz|bz2|lz|xz|zst|Z))$/.exec(
      file,
    );
  if (archive) return file.slice(0, archive.index);
  // File.extname treats the final component of an unarchived version as an extension.
  if (/\b\d+\.\d+[^.]*$/.test(file) && !file.endsWith(".7z")) return file;
  return posix.basename(file, posix.extname(file));
}

/** Homebrew applies the same ordered detection to a literal Git tag or a download URL. */
export function versionFromUrl(url: string, tag?: string): string | null {
  let spec = tag ?? url;
  if (/[+%]/.test(spec)) {
    try {
      spec = decodeURIComponent(spec.replaceAll("+", " "));
    } catch {
      // A malformed historical URL may still carry a readable version in its filename.
    }
  }
  const inputs = { spec, stem: sourceStem(spec) };
  for (const [part, pattern, normalize] of VERSION_RULES) {
    const version = pattern.exec(inputs[part])?.[1];
    if (version) return normalize ? normalize(version) : version;
  }
  return null;
}
