import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function step(file: string, name: string): string {
  const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const body = workflow.split(`      - name: ${name}\n`)[1]?.split("        run: |\n")[1];
  if (body === undefined) throw new Error(`missing workflow step ${name}`);
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

describe("CI workflow contracts", () => {
  it("routes site, trigger, and workflow regressions through root tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkgstory-matrix-"));
    const output = join(dir, "output");
    try {
      for (const file of [
        "trigger/src/index.ts",
        "site/src/pages/health.json.ts",
        ".github/workflows/crawl.yml",
        "scripts/check-npm-install-policy.mjs",
      ]) {
        const result = spawnSync(
          "bash",
          [
            "-euo",
            "pipefail",
            "-c",
            `git() { printf "%s\\n" "$CHANGED_FILES"; }\n${step("ci.yml", "Generate CI matrix")}`,
          ],
          {
            env: {
              ...process.env,
              EVENT_NAME: "pull_request",
              BASE_SHA: "base",
              CHANGED_FILES: file,
              GITHUB_OUTPUT: output,
            },
            encoding: "utf8",
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const lines = readFileSync(output, "utf8").trim().split("\n");
        const matrixLine = lines.filter((line) => line.startsWith("matrix=")).at(-1);
        if (matrixLine === undefined) throw new Error("matrix output missing");
        const checks = (JSON.parse(matrixLine.slice(7)) as { check: string }[]).map(
          (entry) => entry.check,
        );
        expect(checks, file).toContain("lint");
        expect(checks, file).toContain("test");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires matrix generation and every selected check to succeed", () => {
    const base = {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      MATRIX_RESULT: "success",
      MATRIX: '[{"check":"test"}]',
      RUN_CODEQL: "true",
      RUN_CODECOV: "true",
      CODECOV_ELIGIBLE: "true",
      RUN_ZIZMOR: "true",
      COMMITS_RESULT: "success",
      CHECK_RESULT: "success",
      CODEQL_RESULT: "success",
      CODECOV_RESULT: "success",
      ZIZMOR_RESULT: "success",
    };
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync("bash", ["-euo", "pipefail", "-c", step("ci.yml", "Result")], { env }).status;
    expect(run(base)).toBe(0);
    for (const key of [
      "MATRIX_RESULT",
      "COMMITS_RESULT",
      "CHECK_RESULT",
      "CODEQL_RESULT",
      "CODECOV_RESULT",
      "ZIZMOR_RESULT",
    ]) {
      for (const result of ["failure", "cancelled", "skipped", ""]) {
        expect(run({ ...base, [key]: result }), `${key}: ${result}`).not.toBe(0);
      }
    }
    expect(
      run({
        ...base,
        GITHUB_EVENT_NAME: "push",
        COMMITS_RESULT: "skipped",
        RUN_CODEQL: "false",
        CODEQL_RESULT: "skipped",
        RUN_ZIZMOR: "false",
        ZIZMOR_RESULT: "skipped",
      }),
    ).toBe(0);
    expect(
      run({
        ...base,
        MATRIX: "[]",
        CHECK_RESULT: "skipped",
        RUN_CODEQL: "false",
        CODEQL_RESULT: "skipped",
        RUN_CODECOV: "false",
        CODECOV_RESULT: "skipped",
        RUN_ZIZMOR: "false",
        ZIZMOR_RESULT: "skipped",
      }),
    ).toBe(0);
    expect(run({ ...base, RUN_CODEQL: "" })).not.toBe(0);
  });

  it("requires main for every privileged manual job", () => {
    for (const file of ["crawl.yml", "deploy-site.yml", "deploy-trigger.yml"]) {
      const workflow = readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow).toMatch(/^ {4}if: .*github\.ref == 'refs\/heads\/main'$/m);
    }
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toContain("needs: [generate-matrix, commits, check, codeql, codecov, zizmor]");
  });

  it("keeps rejected dispatches outside production concurrency groups", () => {
    for (const [file, group, rejected] of [
      ["crawl.yml", "crawl", "rejected-crawl"],
      ["deploy-site.yml", "deploy-site", "rejected-deploy"],
      ["deploy-trigger.yml", "deploy-trigger", "rejected-deploy-trigger"],
    ]) {
      const workflow = readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow).toContain(
        `group: \${{ github.ref == 'refs/heads/main' && '${group}' || format('${rejected}-{0}', github.run_id) }}`,
      );
      if (file === "crawl.yml") {
        expect(workflow).toContain("cancel-in-progress: false");
      } else {
        const push = workflow.split("  workflow_dispatch:")[0];
        expect(push).toContain(`      - ".github/workflows/${file}"`);
        expect(push).toContain('      - "scripts/check-npm-install-policy.mjs"');
      }
    }
  });
});
