import { test } from "node:test";
import assert from "node:assert/strict";
import { attestFindings, buildAttestResult, checkNameMatches, checkSubstringVerdict } from "../src/attest.js";
import type { CheckRunInfo } from "../src/types.js";

function runs(...entries: Array<[string, string | null]>): CheckRunInfo[] {
  return entries.map(([name, conclusion]) => ({ name, status: "completed", conclusion }));
}

test("attest: substring matching respects word boundaries", () => {
  assert.equal(checkNameMatches("test (ubuntu-latest, node 20)", "test"), true);
  // "latest" contains "test" but must NOT count as a test check.
  assert.equal(checkNameMatches("lint (ubuntu-latest)", "test"), false);
  assert.equal(checkNameMatches("build (node 22)", "build"), true);
  assert.equal(checkNameMatches("benchmark matrix", "bench"), true);
});

test("attest: per-substring verdicts", () => {
  assert.equal(checkSubstringVerdict("test", runs(["test (a)", "success"])).verdict, "success");
  assert.equal(checkSubstringVerdict("test", runs(["test (a)", "failure"])).verdict, "failed");
  assert.equal(checkSubstringVerdict("test", []).verdict, "not-found");
  assert.equal(checkSubstringVerdict("test", runs(["test (a)", null])).verdict, "pending");
  // All matched runs must succeed.
  assert.equal(checkSubstringVerdict("test", runs(["test (a)", "success"], ["test (b)", "timed_out"])).verdict, "failed");
});

test("attest: overall verdict takes the worst per-check result", () => {
  const all = runs(["build", "success"], ["test (a)", "success"]);
  assert.equal(buildAttestResult(["build", "test"], all, false).verdict, "success");
  assert.equal(buildAttestResult(["build", "bench"], all, false).verdict, "not-found");
  assert.equal(buildAttestResult(["build", "test"], runs(["build", "failure"]), false).verdict, "failed");
});

test("attest: findings — not-found and failed are errors, pending is a warning", () => {
  const empty = buildAttestResult(["test", "build"], [], false);
  const emptyFindings = attestFindings(empty, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(emptyFindings.length, 2);
  assert.ok(emptyFindings.every((f) => f.kind === "attest/not-found" && f.severity === "error"));
  assert.match(emptyFindings[0].message, /aaaaaaaaaa/);

  const failed = buildAttestResult(["build"], runs(["build (ci)", "failure"]), false);
  const failedFindings = attestFindings(failed, "aaaa");
  assert.equal(failedFindings[0].kind, "attest/failed");
  assert.match(failedFindings[0].evidence ?? "", /build \(ci\) -> failure/);

  const pending = buildAttestResult(["build"], runs(["build", null]), false);
  assert.equal(attestFindings(pending, "aaaa")[0].severity, "warn");
});

test("attest: skipped verdict produces no findings", () => {
  const skipped = { verdict: "skipped" as const, reason: "no token", checks: [], allRuns: [] };
  assert.equal(attestFindings(skipped, "aaaa").length, 0);
});
