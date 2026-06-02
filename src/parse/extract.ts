import type { PackageKind } from "../sources/index.ts";
import { parseCask } from "./cask.ts";
import { parseFormula } from "./formula.ts";
import { versionFromSubject } from "./subject.ts";

export interface Extracted {
  version: string | null;
  revision: number;
  versionSrc: string;
}

/** Version + revision for a package blob, with a commit-subject fallback. */
export function extractVersion(
  kind: PackageKind,
  name: string,
  subject: string,
  blob: string,
): Extracted {
  let version: string | null;
  let versionSrc: string;
  let revision = 0;

  if (kind === "formula") {
    const parsed = parseFormula(blob);
    version = parsed.version;
    revision = parsed.revision;
    versionSrc = parsed.versionSrc;
  } else {
    version = parseCask(blob).version;
    versionSrc = version ? "version-stanza" : "none";
  }

  if (!version) {
    const fromSubject = versionFromSubject(name, subject);
    if (fromSubject) {
      version = fromSubject;
      versionSrc = "subject";
    }
  }

  return { version, revision, versionSrc };
}
