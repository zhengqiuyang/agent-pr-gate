/**
 * Shared types for agent-pr-gate.
 *
 * The trust path of this tool is fully deterministic: every verdict is an
 * itemized Finding with the evidence that produced it, and nothing in this
 * module (or the pillar modules) ever calls an LLM.
 */

/** Which pillar produced a finding. */
export type Pillar = "scope" | "residue" | "attest" | "claims" | "gate";

export type Severity = "error" | "warn";

/** One itemized, auditable verdict item. */
export interface Finding {
  pillar: Pillar;
  /** Stable machine-readable rule id, e.g. "scope/deny", "residue/injection". */
  kind: string;
  severity: Severity;
  message: string;
  /** Diff path the finding cites, when applicable. */
  path?: string;
  /** New-file line number in the diff, when applicable. */
  line?: number;
  /** Short evidence excerpt (<=120 chars) or citation. */
  evidence?: string;
}

/** Pull-request metadata, normalized across Actions / gh / fixture input modes. */
export interface PrContext {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  body: string;
  authorLogin: string;
  labels: string[];
  headSha: string;
}

/** A diff line added by the PR, with its line number in the new file. */
export interface AddedLine {
  /** 1-based line number in the new (post-patch) file. */
  number: number;
  text: string;
}

export interface DiffFile {
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "changed";
  added: AddedLine[];
  additions: number;
  deletions: number;
  /** Binary files or files without a text patch. */
  binary: boolean;
}

export interface CheckRunInfo {
  name: string;
  status: string;
  conclusion: string | null;
}

export type AttestCheckVerdict =
  | "success"
  | "failed"
  | "not-found"
  | "pending";

export interface AttestCheckResult {
  /** Configured substring, e.g. "test". */
  substring: string;
  verdict: AttestCheckVerdict;
  /** Check runs whose name matched the substring. */
  matched: CheckRunInfo[];
}

export interface AttestResult {
  verdict: AttestCheckVerdict | "skipped";
  /** Why a skipped/absent verdict happened (no token, offline, ...). */
  reason?: string;
  /** Per configured testCheck substring. */
  checks: AttestCheckResult[];
  /** Every check run found for the head SHA (used by claim verification). */
  allRuns: CheckRunInfo[];
  /** True when attestation ran from a local fixture file (demo/tests). */
  fixture?: boolean;
}

export type ClaimVerdict = "verified" | "mismatch" | "unverified";

export interface ClaimResult {
  type: string;
  /** The phrase from the PR body that matched the claim pattern. */
  raw: string;
  /** 1-based line number in the PR body. */
  line: number;
  verdict: ClaimVerdict;
  evidence: string;
}

export type ScopeVerdict = "allowed" | "denied" | "out-of-allowlist";

export interface ScopeCheck {
  path: string;
  verdict: ScopeVerdict;
  /** The rule that decided the verdict (glob from allow/deny list). */
  rule?: string;
}

/** The full structured verdict — what `--format json` emits. */
export interface GateReport {
  tool: string;
  version: string;
  mode: "fixture" | "actions" | "local";
  runAt: string;
  agent: {
    isAgent: boolean;
    reason: string;
  };
  pr: {
    repo: string;
    number: number;
    title: string;
    author: string;
    labels: string[];
    headSha: string;
  };
  policy?: {
    class: string;
    source: "label" | "path-heuristic" | "default";
  };
  scope?: {
    checks: ScopeCheck[];
  };
  residue?: {
    scannedLines: number;
    scannedFiles: number;
    bodyScanned: boolean;
    gitleaks: {
      status: "ran" | "skipped" | "error";
      detail?: string;
      findings: number;
    };
  };
  attest?: AttestResult;
  claims?: {
    verify: boolean;
    onMismatch: "fail" | "warn";
    results: ClaimResult[];
  };
  findings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    verdict: "pass" | "fail" | "skipped";
    exitCode: number;
  };
}
