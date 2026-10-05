import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TITLE = "Hourly crawl dispatches are missing";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
type Run = {
  event?: string;
  head_branch?: string;
  path?: string;
  actor?: { login?: string };
  created_at?: string;
};

export function dispatchHealthy(pages: unknown, now: Date): boolean {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("Unreadable workflow run list");
  return pages
    .flatMap((page) => {
      if (!Array.isArray(page?.workflow_runs)) throw new Error("Unreadable workflow run page");
      return page.workflow_runs as Run[];
    })
    .some((run) => {
      if (!run || typeof run !== "object") throw new Error("Unreadable workflow run");
      const created = Date.parse(run.created_at ?? "");
      const age = now.getTime() - created;
      return (
        run.event === "workflow_dispatch" &&
        run.head_branch === "main" &&
        run.path === ".github/workflows/crawl.yml" &&
        run.actor?.login === "starhaven-bot[bot]" &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= MAX_AGE_MS
      );
    });
}

type GitHub = (args: string[], input?: string) => string;
const github: GitHub = (args, input) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });

export function checkDispatch(repository: string, gh: GitHub = github, now = new Date()): boolean {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GH_REPO must identify one repository");
  let healthy = false;
  let body =
    "No starhaven-bot crawl dispatch was created on main in the past two hours. " +
    "Scheduled fallback crawls and reruns of older dispatches do not establish recovery. " +
    "Check the trigger Worker and its GitHub App credentials. This check will close the issue when dispatches recover.";
  try {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const pages: unknown = JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "--method",
        "GET",
        `repos/${repository}/actions/workflows/crawl.yml/runs`,
        "-f",
        "branch=main",
        "-f",
        "event=workflow_dispatch",
        "-f",
        "actor=starhaven-bot[bot]",
        "-f",
        `created=>=${since}`,
        "-f",
        "per_page=100",
      ]),
    );
    healthy = dispatchHealthy(pages, now);
  } catch {
    body =
      "The dispatch check could not read or validate the crawl workflow run list. " +
      "Dispatch health is unknown. Check GitHub API access and rerun this check; a fallback crawl does not resolve it.";
  }
  const pages: unknown = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      "--method",
      "GET",
      `repos/${repository}/issues`,
      "-f",
      "state=open",
      "-f",
      "creator=github-actions[bot]",
      "-f",
      "per_page=100",
    ]),
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("Unreadable dispatch issue list");
  }
  const issues = pages
    .flat()
    .filter(
      (issue) =>
        issue.title === TITLE && !issue.pull_request && issue.user?.login === "github-actions[bot]",
    );
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || issue.number <= 0)
      throw new Error("Invalid issue number");
    if (healthy) {
      gh([
        "issue",
        "close",
        String(issue.number),
        "--repo",
        repository,
        "--reason",
        "completed",
        "--comment",
        "A recent starhaven-bot crawl dispatch on main confirms that dispatching has recovered.",
      ]);
    } else if (issue.body !== body) {
      gh(["issue", "edit", String(issue.number), "--repo", repository, "--body-file", "-"], body);
    }
  }
  if (!healthy && issues.length === 0) {
    gh(["issue", "create", "--repo", repository, "--title", TITLE, "--body-file", "-"], body);
  }
  return healthy;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!checkDispatch(process.env.GH_REPO ?? "")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dispatch check failed");
    process.exitCode = 1;
  }
}
