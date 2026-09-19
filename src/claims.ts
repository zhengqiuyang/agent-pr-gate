/**
 * Pillar 4 — claims-vs-diff. A curated regex library recognizes ~10 claim
 * types in the PR body; each type has a deterministic verifier against the
 * diff, the attestation result or the config. Verdicts are verified /
 * mismatch (contradicted by evidence) / unverified (honestly cannot tell).
 * Mismatches never use an LLM — both sides of the contradiction are cited.
 */
import type { AttestResult, ClaimResult, ClaimVerdict, DiffFile, Finding } from "./types.js";
import type { GateConfig } from "./policy.js";
import { globMatch } from "./policy.js";
import { checkSubstringVerdict } from "./attest.js";
import { shortSha } from "./attest.js";

/* ------------------------------------------------------------------ */
/* Claim pattern library                                               */
/* ------------------------------------------------------------------ */

export interface ClaimPattern {
  type: string;
  label: string;
  regexes: RegExp[];
  /** scope claims carry a capture group with the claimed area. */
  capture?: boolean;
}

export const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    type: "ran-tests",
    label: "ran the tests / all tests pass",
    regexes: [
      /\bran\s+(?:the\s+)?(?:full\s+|entire\s+)?test suite\b/i,
      /\ball tests\s+(?:are\s+|were\s+)?pass(?:ed|ing)\b/i,
      /\btests?\s+(?:are\s+|were\s+)?passing\b/i,
      /\b(?:ran|executed)\s+(?:all\s+)?(?:the\s+)?tests\b/i,
      /\btests?\s+passed\b/i,
    ],
  },
  {
    type: "build-passing",
    label: "the build passes",
    regexes: [
      /\bbuild\s+(?:is\s+|was\s+)?(?:pass(?:es|ed|ing)|succeeded|green)\b/i,
      /\bbuild succeeded\b/i,
    ],
  },
  {
    type: "benchmarks-run",
    label: "benchmarks were run",
    regexes: [
      /\bran\s+(?:the\s+)?benchmarks?\b/i,
      /\bbenchmarks?\s+(?:were\s+|have\s+been\s+)?run\b/i,
    ],
  },
  {
    type: "ci-green",
    label: "CI is green",
    regexes: [/\bCI\s+(?:is\s+|was\s+)?(?:green|pass(?:ing|ed)|healthy)\b/i],
  },
  {
    type: "scope",
    label: "only touched <area>",
    capture: true,
    regexes: [
      // The area capture allows dots that are part of filenames ("package.json")
      // but stops at sentence-ending punctuation ("... dependencies. Ran ...").
      /\bonly\s+(?:modifi(?:ed|es)|chang(?:ed|es)|touch(?:ed|es)|updat(?:ed|es)|edit(?:ed|s)|add(?:ed|s))\s+((?:[^.!?\n]|\.(?=\S))*)/i,
      /\bchanges?\s+(?:are\s+|is\s+)?limited\s+to\s+((?:[^.!?\n]|\.(?=\S))*)/i,
      /\bthe\s+only\s+files?\s+(?:modified|changed|touched|updated)\s+(?:are|is|was|were)\s+((?:[^.!?\n]|\.(?=\S))*)/i,
    ],
  },
  {
    type: "no-api-changes",
    label: "no API changes",
    regexes: [
      /\bno\s+(?:breaking\s+)?api\s+changes?\b/i,
      /\bapi\s+(?:is|was|remains)\s+unchanged\b/i,
      /\bno\s+changes?\s+to\s+(?:the\s+)?api\b/i,
    ],
  },
  {
    type: "no-breaking-changes",
    label: "no breaking changes",
    regexes: [/\bno\s+breaking\s+changes?\b/i, /\bnon-breaking\b/i],
  },
  {
    type: "no-new-dependencies",
    label: "no new dependencies",
    regexes: [
      /\bno\s+new\s+(?:dependencies|deps)\b/i,
      /\b(?:did\s+not|didn'?t|don'?t|won'?t)\s+add\s+(?:any\s+)?(?:new\s+)?(?:dependencies|deps)\b/i,
    ],
  },
  {
    type: "docs-updated",
    label: "docs updated",
    regexes: [
      /\bdocs?\s+(?:have\s+been\s+|are\s+|were\s+|was\s+)?updated\b/i,
      /\bupdated\s+(?:the\s+)?(?:docs|documentation)\b/i,
      /\bdocumentation\s+(?:has\s+been\s+|is\s+)?updated\b/i,
    ],
  },
  {
    type: "tests-added",
    label: "tests were added",
    regexes: [
      /\b(?:added|wrote)\s+(?:new\s+)?tests?\b/i,
      /\btests?\s+(?:were\s+|have\s+been\s+|are\s+)?added\b/i,
    ],
  },
];

export interface ClaimMatch {
  type: string;
  raw: string;
  line: number;
  /** For scope claims: the captured area phrase. */
  capture?: string;
}

/** Find claim statements in the PR body (line-numbered). */
export function findClaims(body: string): ClaimMatch[] {
  const matches: ClaimMatch[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of CLAIM_PATTERNS) {
      for (const re of pattern.regexes) {
        const m = re.exec(lines[i]);
        if (m === null) continue;
        matches.push({
          type: pattern.type,
          raw: m[0],
          line: i + 1,
          capture: pattern.capture === true ? (m[1] ?? "") : undefined,
        });
        break; // one hit per pattern per line is enough
      }
    }
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/* Path heuristics used by verifiers                                   */
/* ------------------------------------------------------------------ */

const DEP_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
  "bun.lockb",
]);
const DEP_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
  "bun.lockb",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
]);
const DEP_MANIFESTS = new Set(["package.json", "pyproject.toml", "cargo.toml", "go.mod", "gemfile", "composer.json"]);

export function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

export function isTestPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    /\.(test|spec)\.[tj]sx?$/.test(lower) ||
    /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(lower) ||
    /_test\.(py|go|rs)$/.test(lower) ||
    /(^|\/)conftest\.py$/.test(lower) ||
    /(^|\/)test_[^/]*\.py$/.test(lower)
  );
}

export function isDocsPath(p: string): boolean {
  const lower = p.toLowerCase();
  return /\.(md|mdx|rst)$/.test(lower) || /(^|\/)docs?\//.test(lower) || /^readme/.test(baseName(lower)) || /(^|\/)changelog(\.|$)/.test(lower);
}

function isDepsPath(p: string): boolean {
  const lower = p.toLowerCase();
  const base = baseName(lower);
  if (DEP_FILES.has(base)) return true;
  return /(^|\/)(deps?|dependencies|node_modules|vendor)(\/|$)/.test(lower);
}

/* ------------------------------------------------------------------ */
/* Scope-claim area matching                                           */
/* ------------------------------------------------------------------ */

const AREA_FILLER = new Set(["the", "a", "an", "some", "file", "files", "stuff", "things"]);

/** Split "dependencies in package.json and docs" into normalized area parts. */
export function splitAreaParts(phrase: string): string[] {
  return phrase
    .split(/,|\band\b|\bor\b|\bin\b|\bplus\b|\balong\s+with\b/i)
    .map((part) => {
      let s = part
        .toLowerCase()
        .replace(/[`"'*_~[\]()]/g, "")
        .replace(/^[\/\.]+|[\/\.;:,!]+$/g, "")
        .trim();
      // Strip filler words ("the tests" -> "tests") from both ends.
      let words = s.split(/\s+/).filter((w) => w !== "");
      while (words.length > 0 && AREA_FILLER.has(words[0])) words = words.slice(1);
      while (words.length > 0 && AREA_FILLER.has(words[words.length - 1])) words = words.slice(0, -1);
      s = words.join(" ");
      return s;
    })
    .filter((part) => part !== "" && !AREA_FILLER.has(part));
}

function singular(word: string): string {
  return word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Does one claimed area part cover this path? Conservative matching. */
export function areaPartMatchesPath(part: string, filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = baseName(lower);
  if (part === "deps" || part === "dependency" || part === "dependencies" || part === "dev dependencies" || part === "dev deps" || part === "package" || part === "packages" || part === "lockfile" || part === "lockfiles" || part === "manifest" || part === "manifests") {
    return isDepsPath(filePath);
  }
  if (part === "test" || part === "tests" || part === "unit test" || part === "unit tests" || part === "spec" || part === "specs" || part === "test suite" || part === "test file" || part === "test files") {
    return isTestPath(filePath);
  }
  if (part === "doc" || part === "docs" || part === "documentation" || part === "readme" || part === "changelog" || part === "markdown") {
    return isDocsPath(filePath);
  }
  if (part === "workflow" || part === "workflows" || part === "ci" || part === "ci config" || part === "github actions") {
    return /^\.github\/(workflows|actions)\//.test(lower);
  }
  // Exact filename ("package.json", "src/auth/session.ts") or glob-ish exact path.
  if (part.includes("/") || part.includes(".")) {
    if (part.includes("*") || part.includes("?")) return globMatch(part, filePath);
    return lower === part || lower.endsWith(`/${part}`);
  }
  // Generic fallback: singular/plural substring of the path.
  return lower.includes(part) || lower.includes(singular(part));
}

/* ------------------------------------------------------------------ */
/* Verifiers                                                           */
/* ------------------------------------------------------------------ */

export interface ClaimsContext {
  files: DiffFile[];
  attest: AttestResult;
  config: GateConfig;
  headSha: string;
}

function result(type: string, raw: string, line: number, verdict: ClaimVerdict, evidence: string): ClaimResult {
  return { type, raw, line, verdict, evidence };
}

/** Verify one claimed area phrase ("only modified X") against the diff paths. */
export function verifyScopeClaim(claim: ClaimMatch, files: DiffFile[]): ClaimResult {
  const parts = splitAreaParts(claim.capture ?? "");
  const type = `scope:${parts.join("+")}`.replace(/\s+/g, "-");
  if (parts.length === 0 || files.length === 0) {
    return result(type, claim.raw, claim.line, "unverified", "claimed area could not be mapped to changed paths");
  }
  const matchedAny = files.some((f) => parts.some((p) => areaPartMatchesPath(p, f.path)));
  if (!matchedAny) {
    return result(type, claim.raw, claim.line, "unverified", `claimed area '${claim.capture}' does not map to any changed path — cannot verify`);
  }
  const outside = files.filter((f) => !parts.some((p) => areaPartMatchesPath(p, f.path)));
  if (outside.length > 0) {
    return result(
      type,
      claim.raw,
      claim.line,
      "mismatch",
      `claimed 'only ${claim.capture}' but diff also touches: ${outside.map((f) => f.path).join(", ")}`,
    );
  }
  return result(type, claim.raw, claim.line, "verified", `all ${files.length} changed path(s) match the claimed area`);
}

/**
 * Verify a substring-backed claim (test/build/bench checks) against the
 * attested check runs. If the substring is part of the configured
 * attest.testChecks contract, absence is a contradiction; otherwise absence
 * is merely unverifiable.
 */
function verifySubstringClaim(
  claim: ClaimMatch,
  substring: string,
  ctx: ClaimsContext,
  fallbackSubstringList: string[],
): ClaimResult {
  if (ctx.attest.verdict === "skipped") {
    return result(claim.type, claim.raw, claim.line, "unverified", `attestation skipped (${ctx.attest.reason ?? "no data"}) — cannot verify`);
  }
  const check = checkSubstringVerdict(substring, ctx.attest.allRuns);
  const configured = ctx.config.attest.testChecks.some((t) => substring.includes(t.toLowerCase()) || t.toLowerCase().includes(substring));
  if (check.verdict === "success") {
    return result(claim.type, claim.raw, claim.line, "verified", `check run(s) ${check.matched.map((m) => `'${m.name}'`).join(", ")} succeeded for ${shortSha(ctx.headSha)}`);
  }
  if (check.verdict === "failed") {
    return result(claim.type, claim.raw, claim.line, "mismatch", `check run(s) ${check.matched.filter((m) => m.conclusion !== "success").map((m) => `'${m.name}' -> ${m.conclusion}`).join(", ")} did not succeed`);
  }
  if (check.verdict === "pending") {
    return result(claim.type, claim.raw, claim.line, "unverified", `matching check runs still pending (${check.matched.map((m) => m.name).join(", ")})`);
  }
  // not-found
  if (configured || fallbackSubstringList.includes(substring)) {
    return result(claim.type, claim.raw, claim.line, "mismatch", `no check runs matching '${substring}' exist for head SHA ${shortSha(ctx.headSha)} (${ctx.attest.allRuns.length} run(s) total)`);
  }
  return result(claim.type, claim.raw, claim.line, "unverified", `no check runs matching '${substring}' for head SHA ${shortSha(ctx.headSha)}, and '${substring}' is not part of the attestation contract`);
}

function verifyRanTests(claim: ClaimMatch, ctx: ClaimsContext): ClaimResult {
  const r = verifySubstringClaim(claim, ctx.config.attest.testChecks[0] ?? "test", ctx, ["test"]);
  return { ...r, type: "ran-tests" };
}

function verifyClaim(claim: ClaimMatch, ctx: ClaimsContext): ClaimResult {
  switch (claim.type) {
    case "scope":
      return verifyScopeClaim(claim, ctx.files);
    case "ran-tests":
      return verifyRanTests(claim, ctx);
    case "build-passing":
      return verifySubstringClaim(claim, "build", ctx, ["build"]);
    case "benchmarks-run":
      return verifySubstringClaim(claim, "bench", ctx, []);
    case "ci-green": {
      if (ctx.attest.verdict === "skipped") {
        return result(claim.type, claim.raw, claim.line, "unverified", `attestation skipped (${ctx.attest.reason ?? "no data"}) — cannot verify`);
      }
      if (ctx.attest.allRuns.length === 0) {
        return result(claim.type, claim.raw, claim.line, "mismatch", `claimed CI green but no check runs exist for head SHA ${shortSha(ctx.headSha)}`);
      }
      const failed = ctx.attest.allRuns.filter((r) => r.conclusion !== null && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral");
      if (failed.length > 0) {
        return result(claim.type, claim.raw, claim.line, "mismatch", `check runs not green: ${failed.map((f) => `'${f.name}' -> ${f.conclusion}`).join(", ")}`);
      }
      return result(claim.type, claim.raw, claim.line, "verified", `${ctx.attest.allRuns.length} check run(s) for ${shortSha(ctx.headSha)}, none failing`);
    }
    case "no-api-changes": {
      const apiPaths = ctx.config.claims.apiPaths;
      if (apiPaths === undefined || apiPaths.length === 0) {
        return result(claim.type, claim.raw, claim.line, "unverified", "claims.apiPaths not configured — cannot verify");
      }
      const hit = ctx.files.find((f) => apiPaths.some((p) => globMatch(p, f.path)));
      if (hit !== undefined) {
        const rule = apiPaths.find((p) => globMatch(p, hit.path));
        return result(claim.type, claim.raw, claim.line, "mismatch", `diff touches API path ${hit.path} (matches claims.apiPaths '${rule}')`);
      }
      return result(claim.type, claim.raw, claim.line, "verified", `no changed path matches claims.apiPaths [${apiPaths.join(", ")}]`);
    }
    case "no-breaking-changes": {
      for (const f of ctx.files) {
        for (const line of f.added) {
          if (/breaking[ -]change/i.test(line.text)) {
            return result(claim.type, claim.raw, claim.line, "mismatch", `added line contains a BREAKING CHANGE marker: ${f.path}:${line.number}`);
          }
        }
      }
      return result(claim.type, claim.raw, claim.line, "unverified", "absence of breaking changes cannot be proven deterministically");
    }
    case "no-new-dependencies": {
      const lockHit = ctx.files.find((f) => DEP_LOCKFILES.has(baseName(f.path).toLowerCase()));
      if (lockHit !== undefined) {
        return result(claim.type, claim.raw, claim.line, "mismatch", `lockfile changed: ${lockHit.path}`);
      }
      const manifestHit = ctx.files.find((f) => DEP_MANIFESTS.has(baseName(f.path).toLowerCase()));
      if (manifestHit !== undefined) {
        return result(claim.type, claim.raw, claim.line, "unverified", `dependency manifest ${manifestHit.path} changed — cannot rule out new dependencies from the diff alone`);
      }
      return result(claim.type, claim.raw, claim.line, "verified", "no dependency manifests or lockfiles in the diff");
    }
    case "docs-updated": {
      const hit = ctx.files.find((f) => isDocsPath(f.path));
      if (hit !== undefined) {
        return result(claim.type, claim.raw, claim.line, "verified", `documentation file in diff: ${hit.path}`);
      }
      return result(claim.type, claim.raw, claim.line, "mismatch", "no documentation files in the diff");
    }
    case "tests-added": {
      const hit = ctx.files.find((f) => isTestPath(f.path));
      if (hit !== undefined) {
        return result(claim.type, claim.raw, claim.line, "verified", `test file in diff: ${hit.path}`);
      }
      return result(claim.type, claim.raw, claim.line, "mismatch", "no test files in the diff");
    }
    default:
      return result(claim.type, claim.raw, claim.line, "unverified", "no verifier for this claim type");
  }
}

/** Verify every claim found in the body. */
export function verifyClaims(claims: ClaimMatch[], ctx: ClaimsContext): ClaimResult[] {
  return claims.map((c) => verifyClaim(c, ctx));
}

/** Findings from claim mismatches; severity decided by claims.onMismatch. */
export function claimFindings(results: ClaimResult[], onMismatch: "fail" | "warn"): Finding[] {
  const findings: Finding[] = [];
  for (const r of results) {
    if (r.verdict !== "mismatch") continue;
    findings.push({
      pillar: "claims",
      kind: `claims/${r.type}-mismatch`,
      severity: onMismatch === "fail" ? "error" : "warn",
      message: `PR body claims '${firstWords(r.raw)}' but the evidence contradicts it`,
      evidence: r.evidence,
    });
  }
  return findings;
}

function firstWords(s: string, n = 8): string {
  const words = s.split(/\s+/);
  return words.length <= n ? s : `${words.slice(0, n).join(" ")}…`;
}
