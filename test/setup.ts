import { execFileSync } from "node:child_process";

// Git exports repository-local paths into hooks; fixtures must discover their own repositories.
const gitEnvNames = execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
});
for (const name of gitEnvNames.trim().split("\n")) delete process.env[name];
