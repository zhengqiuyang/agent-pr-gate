// Offline demo: runs all three fixture scenarios through the real CLI and
// prints each verdict. No network, no token — fixture mode only.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "src", "cli.js");
const FIX = join(ROOT, "test", "fixtures");

const scenarios = [
  { dir: "a-clean", label: "(a) honest agent PR — expected exit 0" },
  { dir: "b-scope-violation", label: "(b) scope-violating PR — expected exit 1" },
  { dir: "c-sneaky", label: "(c) sneaky PR (injection + skipped tests + hidden unicode) — expected exit 1" },
];

for (const s of scenarios) {
  const bar = "=".repeat(72);
  console.log(`\n${bar}\n${s.label}\n${bar}`);
  try {
    execFileSync(
      process.execPath,
      [
        CLI,
        "check",
        "--event",
        join(FIX, s.dir, "event.json"),
        "--diff",
        join(FIX, s.dir, "diff.patch"),
        "--check-runs",
        join(FIX, s.dir, "check-runs.json"),
        "--config",
        join(FIX, s.dir, "agent-pr-gate.yaml"),
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    // Nonzero exit is an expected outcome for scenarios b and c.
    const code = err && typeof err === "object" && "status" in err ? err.status : 1;
    console.log(`(exit code ${code})`);
  }
}
console.log("\ndone.");
