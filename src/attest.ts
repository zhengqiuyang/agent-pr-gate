/**
 * Pillar 3 — run attestation. For the PR head SHA, the configured
 * attest.testChecks substrings must resolve to check runs with
 * conclusion=success. On an agent PR, "claims tests but no matching check runs
 * exist for this SHA" is itself a finding. No token / offline -> graceful
 * "skipped" verdict, never a crash and never a failure.
 */
import type { AttestCheckResult, AttestResult, CheckRunInfo, Finding } from "./types.js";
import { fetchCheckRuns, ghCheckRuns, readJsonFile, type FetchLike } from "./github.js";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substring matching with a start word boundary: "test" matches the word
 * "test" in "test (ubuntu)" and prefixes like "tests", but NOT the "test"
 * inside "ubuntu-latest" (no boundary before it). Substrings that do not
 * start with a word character fall back to plain inclusion.
 */
export function checkNameMatches(name: string, substring: string): boolean {
  if (/^[A-Za-z0-9_]/.test(substring)) {
    return new RegExp(`\\b${escapeRegExp(substring)}`, "i").test(name);
  }
  return name.toLowerCase().includes(substring.toLowerCase());
}

/** Verdict for one configured substring against the full check-run list. */
export function checkSubstringVerdict(substring: string, allRuns: CheckRunInfo[]): AttestCheckResult {
  const matched = allRuns.filter((r) => checkNameMatches(r.name, substring));
  if (matched.length === 0) {
    return { substring, verdict: "not-found", matched };
  }
  if (matched.some((r) => FAILED_CONCLUSIONS.has(r.conclusion ?? ""))) {
    return { substring, verdict: "failed", matched };
  }
  if (matched.every((r) => r.conclusion === "success")) {
    return { substring, verdict: "success", matched };
  }
  return { substring, verdict: "pending", matched };
}

/** Overall verdict: worst of the per-substring verdicts. */
export function overallVerdict(checks: AttestCheckResult[]): AttestResult["verdict"] {
  if (checks.some((c) => c.verdict === "failed")) return "failed";
  if (checks.some((c) => c.verdict === "not-found")) return "not-found";
  if (checks.some((c) => c.verdict === "pending")) return "pending";
  return checks.length === 0 ? "skipped" : "success";
}

/** Build the AttestResult once the raw check runs are known. */
export function buildAttestResult(testChecks: string[], allRuns: CheckRunInfo[], fixture: boolean): AttestResult {
  const checks = testChecks.map((s) => checkSubstringVerdict(s, allRuns));
  return { verdict: overallVerdict(checks), checks, allRuns, fixture };
}

/** Attest from a fixture file (check-runs API response shape). Throws HarnessError on bad JSON. */
export function attestFromFixture(testChecks: string[], file: string): AttestResult {
  const raw = readJsonFile(file) as { check_runs?: unknown };
  const runsRaw = Array.isArray(raw.check_runs) ? raw.check_runs : [];
  const allRuns: CheckRunInfo[] = runsRaw.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      name: typeof rec.name === "string" ? rec.name : "",
      status: typeof rec.status === "string" ? rec.status : "unknown",
      conclusion: typeof rec.conclusion === "string" ? rec.conclusion : null,
    };
  });
  return buildAttestResult(testChecks, allRuns, true);
}

/** Attest from the GitHub REST API (Actions mode). Graceful skip on no-token/offline/HTTP errors. */
export async function attestFromApi(
  testChecks: string[],
  repo: { owner: string; name: string },
  sha: string,
  tokenValue: string | undefined,
  fetchImpl: FetchLike,
): Promise<AttestResult> {
  if (tokenValue === undefined) {
    return {
      verdict: "skipped",
      reason: "GITHUB_TOKEN not set — cannot query check runs",
      checks: [],
      allRuns: [],
    };
  }
  let allRuns: CheckRunInfo[];
  try {
    allRuns = await fetchCheckRuns(repo, sha, tokenValue, fetchImpl);
  } catch (err) {
    return {
      verdict: "skipped",
      reason: `check-run API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      checks: [],
      allRuns: [],
    };
  }
  return buildAttestResult(testChecks, allRuns, false);
}

/** Attest via gh CLI (local mode). Graceful skip on gh/API errors. */
export function attestFromGh(
  testChecks: string[],
  repo: { owner: string; name: string },
  sha: string,
): AttestResult {
  let allRuns: CheckRunInfo[];
  try {
    allRuns = ghCheckRuns(repo, sha);
  } catch (err) {
    return {
      verdict: "skipped",
      reason: `gh api check-runs failed: ${err instanceof Error ? err.message : String(err)}`,
      checks: [],
      allRuns: [],
    };
  }
  return buildAttestResult(testChecks, allRuns, false);
}

/** Findings from an attestation result (skipped produces none). */
export function attestFindings(attest: AttestResult, headSha: string): Finding[] {
  const findings: Finding[] = [];
  if (attest.verdict === "skipped") return findings;
  for (const check of attest.checks) {
    if (check.verdict === "not-found") {
      findings.push({
        pillar: "attest",
        kind: "attest/not-found",
        severity: "error",
        message: `agent PR has no check runs matching '${check.substring}' for head SHA ${shortSha(headSha)} — the agent claims CI ran, but nothing on this SHA says so`,
        evidence: `${attest.allRuns.length} check run(s) exist for this SHA; none match '${check.substring}'`,
      });
    } else if (check.verdict === "failed") {
      const failed = check.matched.filter((m) => FAILED_CONCLUSIONS.has(m.conclusion ?? ""));
      findings.push({
        pillar: "attest",
        kind: "attest/failed",
        severity: "error",
        message: `check runs matching '${check.substring}' did not succeed for head SHA ${shortSha(headSha)}`,
        evidence: failed.map((f) => `${f.name} -> ${f.conclusion}`).join("; "),
      });
    } else if (check.verdict === "pending") {
      findings.push({
        pillar: "attest",
        kind: "attest/pending",
        severity: "warn",
        message: `check runs matching '${check.substring}' are still pending for head SHA ${shortSha(headSha)}`,
        evidence: check.matched.map((m) => `${m.name} -> ${m.status}`).join("; "),
      });
    }
  }
  return findings;
}

export function shortSha(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}
