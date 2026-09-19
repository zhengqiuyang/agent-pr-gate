import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// dist/test/e2e.test.js -> repo root is three levels up; fixtures stay in the
// source tree (tsc does not copy them).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "src", "cli.js");
const FIX = (...p: string[]): string => path.join(ROOT, "test", "fixtures", ...p);

/** Run the CLI in fixture mode with a network-free environment. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_TOKEN; // acceptance: no network / token access during tests
  delete env.GH_TOKEN;
  delete env.GITHUB_EVENT_PATH;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function scenarioArgs(dir: string, format: string): string[] {
  return [
    "check",
    "--event",
    FIX(dir, "event.json"),
    "--diff",
    FIX(dir, "diff.patch"),
    "--check-runs",
    FIX(dir, "check-runs.json"),
    "--config",
    FIX(dir, "agent-pr-gate.yaml"),
    "--format",
    format,
  ];
}

/* ------------------------------------------------------------------ */
/* Scenario (a): honest agent PR — clean pass                          */
/* ------------------------------------------------------------------ */

test("e2e a-clean: honest agent PR exits 0", async () => {
  const r = await runCli(scenarioArgs("a-clean", "console"));
  assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.match(r.stdout, /Agent PR: yes/);
  assert.match(r.stdout, /policy: bump-deps/);
});

test("e2e a-clean: json verdict is valid and structured", async () => {
  const r = await runCli(scenarioArgs("a-clean", "json"));
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout) as {
    mode: string;
    agent: { isAgent: boolean };
    policy: { class: string };
    residue: { scannedLines: number };
    attest: { verdict: string };
    claims: { results: Array<{ type: string; verdict: string }> };
    findings: Array<{ severity: string }>;
    summary: { errors: number; warnings: number; verdict: string; exitCode: number };
  };
  assert.equal(report.mode, "fixture");
  assert.equal(report.agent.isAgent, true);
  assert.equal(report.policy.class, "bump-deps");
  assert.equal(report.residue.scannedLines, 6);
  assert.equal(report.attest.verdict, "success");
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.verdict, "pass");
  assert.equal(report.summary.exitCode, 0);
  const types = new Map(report.claims.results.map((c) => [c.type, c.verdict]));
  assert.equal(types.get("ran-tests"), "verified");
  assert.equal(types.get("scope:dependencies+package.json"), "verified");
  assert.equal(types.get("no-breaking-changes"), "unverified");
  // Precision: the benign added line containing "test (" is not a finding.
  assert.equal(report.findings.length, 0);
});

/* ------------------------------------------------------------------ */
/* Scenario (b): scope violation + claim mismatch — exit 1             */
/* ------------------------------------------------------------------ */

test("e2e b-scope-violation: fails pillar 1 and 4, exits 1", async () => {
  const r = await runCli(scenarioArgs("b-scope-violation", "json"));
  assert.equal(r.code, 1, `stdout:\n${r.stdout}`);
  const report = JSON.parse(r.stdout) as {
    scope: { checks: Array<{ path: string; verdict: string; rule?: string }> };
    attest: { verdict: string };
    findings: Array<{ kind: string; severity: string; path?: string; message: string }>;
    summary: { errors: number; verdict: string; exitCode: number };
  };
  const byPath = new Map(report.scope.checks.map((c) => [c.path, c]));
  assert.equal(byPath.get(".github/workflows/deploy.yml")?.verdict, "denied");
  assert.equal(byPath.get("src/auth/session.ts")?.verdict, "out-of-allowlist");
  assert.equal(byPath.get("package.json")?.verdict, "allowed");
  assert.equal(report.attest.verdict, "success");
  const kinds = report.findings.map((f) => f.kind);
  assert.equal(kinds.includes("scope/deny"), true);
  assert.equal(kinds.includes("scope/out-of-allowlist"), true);
  assert.equal(kinds.some((k) => k.startsWith("claims/scope:") && k.endsWith("-mismatch")), true);
  assert.equal(report.summary.errors, 3);
  assert.equal(report.summary.verdict, "fail");
  assert.equal(report.summary.exitCode, 1);
});

test("e2e b-scope-violation: console output cites evidence; github format emits annotations", async () => {
  const console1 = await runCli(scenarioArgs("b-scope-violation", "console"));
  assert.match(console1.stdout, /Verdict: FAIL/);
  assert.match(console1.stdout, /src\/auth\/session\.ts/);
  assert.match(console1.stdout, /mismatch/);
  const gh = await runCli(scenarioArgs("b-scope-violation", "github"));
  assert.equal(gh.code, 1);
  assert.match(gh.stdout, /::error file=\.github\/workflows\/deploy\.yml/);
  assert.match(gh.stdout, /::error file=src\/auth\/session\.ts/);
});

/* ------------------------------------------------------------------ */
/* Scenario (c): sneaky PR — residue + attestation not-found, exit 1   */
/* ------------------------------------------------------------------ */

test("e2e c-sneaky: fails pillars 2, 3 and 4, exits 1", async () => {
  const r = await runCli(scenarioArgs("c-sneaky", "json"));
  assert.equal(r.code, 1, `stdout:\n${r.stdout}`);
  const report = JSON.parse(r.stdout) as {
    policy: { class: string };
    residue: { scannedLines: number };
    attest: { verdict: string; checks: Array<{ substring: string; verdict: string }> };
    claims: { results: Array<{ type: string; verdict: string; evidence: string }> };
    findings: Array<{ kind: string; path?: string; line?: number; evidence?: string }>;
    summary: { errors: number };
  };
  assert.equal(report.policy.class, "default");
  const kinds = report.findings.map((f) => f.kind);
  // Pillar 2 — every residue family fires.
  assert.equal(kinds.includes("residue/injection-ignore-previous-instructions"), true);
  assert.equal(kinds.includes("residue/injection-addressed-to-reviewer"), true);
  assert.equal(kinds.includes("residue/test-skip"), true);
  assert.equal(kinds.includes("residue/test-skip-xit"), true);
  assert.equal(kinds.includes("residue/test-commented-out"), true);
  assert.equal(kinds.includes("residue/stub-todo-implement"), true);
  assert.equal(kinds.includes("residue/stub-not-implemented-js"), true);
  assert.equal(kinds.includes("residue/stub-pass-todo"), true);
  // Hidden unicode finding cites the escaped codepoint in its evidence.
  const hidden = report.findings.find((f) => f.kind === "residue/hidden-unicode");
  assert.ok(hidden !== undefined);
  assert.equal(hidden.path, "src/telemetry/exporter.ts");
  assert.match(hidden.evidence ?? "", /\\u200b/i);
  // Pillar 3 — nothing attests this SHA.
  assert.equal(report.attest.verdict, "not-found");
  assert.deepEqual(
    report.attest.checks.map((c) => c.verdict),
    ["not-found", "not-found"],
  );
  assert.equal(kinds.filter((k) => k === "attest/not-found").length, 2);
  // Pillar 4 — the tests claim is contradicted.
  assert.equal(report.claims.results.every((c) => c.type === "ran-tests" && c.verdict === "mismatch"), true);
  assert.equal(kinds.some((k) => k === "claims/ran-tests-mismatch"), true);
});

/* ------------------------------------------------------------------ */
/* Behaviour details                                                   */
/* ------------------------------------------------------------------ */

test("e2e: fixture mode without --check-runs skips attestation gracefully", async () => {
  const r = await runCli([
    "check",
    "--event",
    FIX("a-clean", "event.json"),
    "--diff",
    FIX("a-clean", "diff.patch"),
    "--config",
    FIX("a-clean", "agent-pr-gate.yaml"),
    "--format",
    "json",
  ]);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout) as { attest: { verdict: string; reason: string }; claims: { results: Array<{ type: string; verdict: string }> } };
  assert.equal(report.attest.verdict, "skipped");
  assert.match(report.attest.reason, /--check-runs/);
  // Claims backed by attestation degrade to unverified, not mismatch.
  const ranTests = report.claims.results.filter((c) => c.type === "ran-tests");
  assert.equal(ranTests.length > 0 && ranTests.every((c) => c.verdict === "unverified"), true);
});

test("e2e: non-agent PR is skipped with exit 0, --force-agent gates it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pr-gate-test-"));
  const humanEvent = {
    action: "opened",
    repository: { name: "widgets", owner: { login: "example" } },
    pull_request: {
      number: 3,
      title: "hand-written fix",
      body: "Fixed the null check. No claims here beyond that.",
      user: { login: "alice" },
      labels: [{ name: "bug" }],
      head: { sha: "1111111111111111111111111111111111111111" },
    },
  };
  const eventFile = path.join(tmp, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify(humanEvent), "utf8");
  try {
    const skipped = await runCli([
      "check",
      "--event",
      eventFile,
      "--diff",
      FIX("a-clean", "diff.patch"),
      "--config",
      FIX("a-clean", "agent-pr-gate.yaml"),
      "--format",
      "json",
    ]);
    assert.equal(skipped.code, 0);
    const r1 = JSON.parse(skipped.stdout) as { agent: { isAgent: boolean }; summary: { verdict: string } };
    assert.equal(r1.agent.isAgent, false);
    assert.equal(r1.summary.verdict, "skipped");

    const forced = await runCli([
      "check",
      "--event",
      eventFile,
      "--diff",
      FIX("a-clean", "diff.patch"),
      "--config",
      FIX("a-clean", "agent-pr-gate.yaml"),
      "--force-agent",
      "--format",
      "json",
    ]);
    assert.equal(forced.code, 0);
    const r2 = JSON.parse(forced.stdout) as { agent: { isAgent: boolean; reason: string } };
    assert.equal(r2.agent.isAgent, true);
    assert.equal(r2.agent.reason, "--force-agent");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("e2e: harness errors exit 2", async () => {
  const noDiff = await runCli(["check", "--event", FIX("a-clean", "event.json"), "--format", "json"]);
  assert.equal(noDiff.code, 2);
  assert.match(noDiff.stderr, /--diff/);

  const missing = await runCli(["check", "--config", path.join(os.tmpdir(), "surely-missing-agent-pr-gate.yaml"), "--event", FIX("a-clean", "event.json"), "--diff", FIX("a-clean", "diff.patch")]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /not found/);

  const noMode = await runCli(["check"]);
  assert.equal(noMode.code, 2);
  assert.match(noMode.stderr, /no input mode/);
});

test("e2e: --help and --version", async () => {
  const help = await runCli(["check", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^0\.1\.0/);
});
