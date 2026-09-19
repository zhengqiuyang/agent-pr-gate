// Portable test launcher: expands dist/test/*.test.js itself instead of relying
// on shell globbing or Node's glob support (glob arguments to --test need Node 21+).
// Also runs the tests with GITHUB_TOKEN / GITHUB_EVENT_PATH stripped from the env
// so fixture-mode e2e runs can never touch the network.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dir = fileURLToPath(new URL("./dist/test", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error("no test files found under dist/test — run `npm run build` first");
  process.exit(1);
}
const env = { ...process.env };
delete env.GITHUB_TOKEN;
delete env.GITHUB_EVENT_PATH;
execFileSync(process.execPath, ["--test", ...files], { stdio: "inherit", env });
