import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaims, splitAreaParts, verifyClaims, verifyScopeClaim, areaPartMatchesPath } from "../src/claims.js";
import type { AttestResult, DiffFile } from "../src/types.js";
import { defaultConfig } from "../src/policy.js";

function mkFile(path: string, added: string[] = ["x"]): DiffFile {
  return {
    path,
    status: "modified",
    added: added.map((text, i) => ({ number: i + 1, text })),
    additions: added.length,
    deletions: 0,
    binary: false,
  };
}

function attestRuns(runs: Array<[string, string | null]>): AttestResult {
  const allRuns = runs.map(([name, conclusion]) => ({ name, status: "completed", conclusion }));
  return { verdict: "success", checks: [], allRuns };
}

/* ---------------- pattern recognition ---------------- */

test("claims: recognizes ran-tests phrasings", () => {
  const a = findClaims("Ran the full test suite.\nAll tests passed.");
  assert.equal(a.filter((c) => c.type === "ran-tests").length, 2);
  assert.equal(findClaims("I executed all the tests before opening this.").length, 1);
});

test("claims: benign sentences are not claims", () => {
  assert.equal(findClaims("We fixed a flaky test last week.").length, 0);
  assert.equal(findClaims("The build failed yesterday but passes after the retry.").length, 0);
  assert.equal(findClaims("This document explains how the API works.").length, 0);
});

test("claims: recognizes the other claim types", () => {
  const body = [
    "The build passes on all matrix legs.",
    "Benchmarks were run before and after.",
    "CI is green.",
    "No API changes.",
    "No breaking changes.",
    "No new dependencies.",
    "Docs updated in the usage section.",
    "Added tests for the retry path.",
  ].join("\n");
  const types = findClaims(body).map((c) => c.type);
  for (const expected of [
    "build-passing",
    "benchmarks-run",
    "ci-green",
    "no-api-changes",
    "no-breaking-changes",
    "no-new-dependencies",
    "docs-updated",
    "tests-added",
  ]) {
    assert.equal(types.includes(expected), true, `missing claim type ${expected}`);
  }
});

test("claims: scope claim captures the area phrase", () => {
  const m = findClaims("Only modified dependencies in package.json.")[0];
  assert.equal(m.type, "scope");
  assert.equal(m.capture, "dependencies in package.json");
  const m2 = findClaims("The only files changed are src/api and docs.")[0];
  assert.equal(m2.type, "scope");
});

test("claims: splitAreaParts splits phrases into normalized parts", () => {
  assert.deepEqual(splitAreaParts("dependencies in package.json"), ["dependencies", "package.json"]);
  assert.deepEqual(splitAreaParts("the tests"), ["tests"]);
  assert.deepEqual(splitAreaParts("docs and the readme"), ["docs", "readme"]);
});

/* ---------------- scope-claim verification ---------------- */

test("claims: scope area matching (categories, exact files, substrings)", () => {
  assert.equal(areaPartMatchesPath("dependencies", "package-lock.json"), true);
  assert.equal(areaPartMatchesPath("tests", "src/a.test.ts"), true);
  assert.equal(areaPartMatchesPath("docs", "README.md"), true);
  assert.equal(areaPartMatchesPath("package.json", "package.json"), true);
  assert.equal(areaPartMatchesPath("package.json", "src/package.json"), true);
  assert.equal(areaPartMatchesPath("auth", "src/auth/session.ts"), true);
  assert.equal(areaPartMatchesPath("dependencies", "src/auth/session.ts"), false);
});

test("claims: scope claim verified when all paths match", () => {
  const claim = findClaims("Only modified dependencies.")[0];
  const r = verifyScopeClaim(claim, [mkFile("package.json"), mkFile("package-lock.json")]);
  assert.equal(r.verdict, "verified");
});

test("claims: scope claim mismatches when diff touches other paths", () => {
  const claim = findClaims("Only modified dependencies in package.json.")[0];
  const r = verifyScopeClaim(claim, [mkFile("package.json"), mkFile("src/auth/session.ts"), mkFile(".github/workflows/deploy.yml")]);
  assert.equal(r.verdict, "mismatch");
  assert.ok(r.evidence.includes("src/auth/session.ts"));
  assert.ok(r.evidence.includes(".github/workflows/deploy.yml"));
});

test("claims: scope claim with unmappable area is unverified, not a failure", () => {
  const claim = findClaims("Only changed formatting.")[0];
  const r = verifyScopeClaim(claim, [mkFile("package.json")]);
  assert.equal(r.verdict, "unverified");
});

/* ---------------- attestation-backed verification ---------------- */

test("claims: ran-tests verified against successful check runs", () => {
  const claims = findClaims("Ran the full test suite.");
  const results = verifyClaims(claims, {
    files: [],
    attest: attestRuns([["test (ubuntu)", "success"], ["build", "success"]]),
    config: defaultConfig(),
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(results[0].verdict, "verified");
});

test("claims: ran-tests mismatches when no matching check runs exist", () => {
  const claims = findClaims("All tests passed.");
  const results = verifyClaims(claims, {
    files: [],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(results[0].verdict, "mismatch");
  assert.ok(results[0].evidence.includes("no check runs"));
});

test("claims: benchmarks-run not-found is unverified (not part of the attestation contract)", () => {
  const claims = findClaims("Benchmarks were run.");
  const results = verifyClaims(claims, {
    files: [],
    attest: attestRuns([["test", "success"]]),
    config: defaultConfig(),
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(results[0].verdict, "unverified");
});

test("claims: skipped attestation yields unverified, never a mismatch", () => {
  const claims = findClaims("Ran the full test suite.");
  const results = verifyClaims(claims, {
    files: [],
    attest: { verdict: "skipped", reason: "GITHUB_TOKEN not set", checks: [], allRuns: [] },
    config: defaultConfig(),
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(results[0].verdict, "unverified");
});

/* ---------------- diff-backed verification ---------------- */

test("claims: docs-updated verified/mismatch by diff paths", () => {
  const config = defaultConfig();
  const ok = verifyClaims(findClaims("Docs updated."), {
    files: [mkFile("README.md")],
    attest: attestRuns([]),
    config,
    headSha: "a",
  });
  assert.equal(ok[0].verdict, "verified");
  const bad = verifyClaims(findClaims("Docs updated."), {
    files: [mkFile("src/a.ts")],
    attest: attestRuns([]),
    config,
    headSha: "a",
  });
  assert.equal(bad[0].verdict, "mismatch");
});

test("claims: no-new-dependencies contradicted by a lockfile change", () => {
  const results = verifyClaims(findClaims("No new dependencies."), {
    files: [mkFile("package-lock.json")],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "a",
  });
  assert.equal(results[0].verdict, "mismatch");
});

test("claims: no-api-changes needs claims.apiPaths, else unverified", () => {
  const without = verifyClaims(findClaims("No API changes."), {
    files: [mkFile("src/api/routes.ts")],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "a",
  });
  assert.equal(without[0].verdict, "unverified");

  const config = defaultConfig();
  config.claims.apiPaths = ["src/api/**"];
  const withPaths = verifyClaims(findClaims("No API changes."), {
    files: [mkFile("src/api/routes.ts")],
    attest: attestRuns([]),
    config,
    headSha: "a",
  });
  assert.equal(withPaths[0].verdict, "mismatch");

  const clean = verifyClaims(findClaims("No API changes."), {
    files: [mkFile("src/lib/util.ts")],
    attest: attestRuns([]),
    config,
    headSha: "a",
  });
  assert.equal(clean[0].verdict, "verified");
});

test("claims: no-breaking-changes mismatches on a BREAKING CHANGE marker", () => {
  const results = verifyClaims(findClaims("No breaking changes."), {
    files: [mkFile("CHANGELOG.md", ["BREAKING CHANGE: drops the v1 client"])],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "a",
  });
  assert.equal(results[0].verdict, "mismatch");
  const clean = verifyClaims(findClaims("No breaking changes."), {
    files: [mkFile("src/a.ts", ["const x = 1;"])],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "a",
  });
  assert.equal(clean[0].verdict, "unverified");
});

test("claims: tests-added verified when test files are in the diff", () => {
  const results = verifyClaims(findClaims("Added tests for the retry path."), {
    files: [mkFile("test/retry.test.ts")],
    attest: attestRuns([]),
    config: defaultConfig(),
    headSha: "a",
  });
  assert.equal(results[0].verdict, "verified");
});
