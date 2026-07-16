import { createHash } from "node:crypto";
import type { GitIdentity, RawCommit } from "./git.ts";

export type ContributorRole = "author" | "coauthor";

export interface Contributor {
  key: string;
  displayName: string;
  githubLogin: string | null;
  isBot: boolean;
}

export interface ContributorAttribution extends Contributor {
  role: ContributorRole;
}

const GITHUB_NOREPLY =
  /^(?:\d+\+)?([a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?)@users\.noreply\.github\.com$/i;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contributorFromIdentity(identity: GitIdentity): Contributor {
  const name = identity.name.trim();
  const email = identity.email.trim().toLowerCase();
  const githubLogin = email.match(GITHUB_NOREPLY)?.[1] ?? null;
  const displayName = name || githubLogin || "Unknown contributor";
  const botLogin = githubLogin?.toLowerCase() ?? "";
  const isBot =
    botLogin.endsWith("[bot]") ||
    botLogin === "dependabot" ||
    botLogin === "renovate" ||
    /Bot$/.test(displayName) ||
    /(?:^|[ _-])bot$/i.test(displayName);

  return {
    // Automation is a role, not a person: BrewTestBot has authored under four
    // addresses since 2014, so keying it by mailbox splits one bot into four
    // cards. Key bots by the name they run under and no alias list is needed.
    // People stay keyed by address — merging those would mean asserting who is
    // who, which is a claim this crawler has no basis to make.
    key: isBot
      ? `bot:${displayName.toLowerCase()}`
      : githubLogin
        ? `github:${githubLogin.toLowerCase()}`
        : `email:${digest(email || displayName.toLowerCase())}`,
    displayName,
    githubLogin,
    isBot,
  };
}

/** Primary author first, then co-authors, deduped by stable identity. */
export function commitAttributions(commit: RawCommit): ContributorAttribution[] {
  const out: ContributorAttribution[] = [];
  const seen = new Set<string>();
  for (const [identity, role] of [
    [commit.author, "author"],
    ...commit.coauthors.map((identity) => [identity, "coauthor"] as const),
  ] as const) {
    const contributor = contributorFromIdentity(identity);
    if (seen.has(contributor.key)) continue;
    seen.add(contributor.key);
    out.push({ ...contributor, role });
  }
  return out;
}
