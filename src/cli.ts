#!/usr/bin/env node
/**
 * agent-pr-gate — deterministic CI verification gate for AI-agent-authored
 * pull requests. Four pillars, zero LLM calls in the trust path:
 *   1. scope enforcement    (policy file + tiny glob matcher)
 *   2. residue scan         (injection / disabled tests / stubs / hidden unicode)
 *   3. run attestation      (check runs on the PR head SHA)
 *   4. claims-vs-diff       (PR body claims verified against evidence)
 *
 * Exit codes: 0 pass · 1 findings · 2 config/harness error (same contract as mcp-test).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffFile, Finding, GateReport, PrContext } from "./types.js";
import {
  ConfigError,
  checkScope,
  detectAgent,
  errMsg,
  loadConfig,
  resolvePolicy,
  type PolicyResolution,
} from "./policy.js";
import { parseUnifiedDiff } from "./diff.js";
import { gitleaksScan, scanBody, scanResidue, type GitleaksResult } from "./residue.js";
import { attestFindings, attestFromApi, attestFromFixture, attestFromGh } from "./attest.js";
import { findClaims, verifyClaims, claimFindings, type ClaimsContext } from "./claims.js";
import {
  HarnessError,
  fetchPrFiles,
  ghPrContext,
  ghPrDiff,
  prContextFromEvent,
  readJsonFile,
  readTextFile,
  token,
  type FetchLike,
} from "./github.js";
import { renderConsole, renderGithub, renderJson } from "./report.js";

const VERSION = "0.1.0";

const USAGE = `agent-pr-gate ${VERSION} — deterministic verification gate for AI-agent-authored PRs

Usage:
  agent-pr-gate check [options]

Input modes (first match wins):
  --event <file> --diff <file> [--check-runs <file>]   Fixture mode: full offline run from files
  GITHUB_EVENT_PATH env set (Actions)                  Actions mode: payload + GitHub API
  --repo <owner/name> --pr <number>                    Local mode: gh CLI

Options:
  -c, --config <path>      Policy file (default search: ./agent-pr-gate.yaml, ./.agent-pr-gate.yaml;
                           built-in defaults when neither exists)
      --repo <slug>        owner/name for local mode
      --pr <number>        PR number for local mode
      --event <file>       pull_request event JSON (fixture mode)
      --diff <file>        unified diff of the PR (fixture mode)
      --check-runs <file>  check-runs API response JSON (fixture mode attestation)
  -f, --format <fmt>       Output: console (default), github (workflow annotations), json
      --force-agent        Treat the PR as agent-authored regardless of signals
  -V, --version            Print version
  -h, --help               Show this help

Exit codes:
  0   gate passed (no error-level findings)
  1   findings — scope violations, residue, attestation gaps or claim mismatches (onMismatch=fail)
  2   configuration or harness error (bad config, missing gh, unreadable fixture, ...)

Examples:
  agent-pr-gate check --event event.json --diff pr.patch --check-runs runs.json
  agent-pr-gate check --repo octocat/widgets --pr 42 --format github
  agent-pr-gate check --format json`;

interface CliArgs {
  command: string | undefined;
  configPath?: string;
  repo?: string;
  pr?: number;
  eventPath?: string;
  diffPath?: string;
  checkRunsPath?: string;
  format: "console" | "github" | "json";
  forceAgent: boolean;
  showVersion: boolean;
  showHelp: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: undefined, format: "console", forceAgent: false, showVersion: false, showHelp: false };
  const needValue = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) throw new HarnessError(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "check":
        if (args.command !== undefined) throw new HarnessError(`unexpected second command '${arg}'`);
        args.command = arg;
        break;
      case "-c":
      case "--config":
        args.configPath = needValue(i, arg);
        i += 1;
        break;
      case "--repo":
        args.repo = needValue(i, arg);
        i += 1;
        break;
      case "--pr": {
        const v = needValue(i, arg);
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n <= 0) throw new HarnessError(`--pr expects a positive integer, got '${v}'`);
        args.pr = n;
        i += 1;
        break;
      }
      case "--event":
        args.eventPath = needValue(i, arg);
        i += 1;
        break;
      case "--diff":
        args.diffPath = needValue(i, arg);
        i += 1;
        break;
      case "--check-runs":
        args.checkRunsPath = needValue(i, arg);
        i += 1;
        break;
      case "-f":
      case "--format": {
        const v = needValue(i, arg);
        if (v !== "console" && v !== "github" && v !== "json") throw new HarnessError(`--format expects console|github|json, got '${v}'`);
        args.format = v;
        i += 1;
        break;
      }
      case "--force-agent":
        args.forceAgent = true;
        break;
      case "-V":
      case "--version":
        args.showVersion = true;
        break;
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      default:
        throw new HarnessError(`unknown argument '${arg}' (see --help)`);
    }
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Input mode resolution                                               */
/* ------------------------------------------------------------------ */

interface Inputs {
  mode: "fixture" | "actions" | "local";
  pr: PrContext;
  files: DiffFile[];
  /** Raw check runs already loaded (fixture mode), otherwise undefined. */
  fixtureCheckRuns?: boolean;
  fetchImpl: FetchLike;
}

async function resolveInputs(args: CliArgs): Promise<Inputs> {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);

  if (args.eventPath !== undefined) {
    // Fixture mode: full offline run from files.
    if (args.diffPath === undefined) throw new HarnessError("fixture mode needs --diff alongside --event");
    const event = readJsonFile(args.eventPath);
    const { pr } = prContextFromEvent(event, args.eventPath);
    const files = parseUnifiedDiff(readTextFile(args.diffPath));
    return { mode: "fixture", pr, files, fixtureCheckRuns: args.checkRunsPath !== undefined, fetchImpl };
  }

  const eventEnv = process.env.GITHUB_EVENT_PATH;
  if (eventEnv !== undefined && eventEnv !== "") {
    // Actions mode.
    const event = readJsonFile(eventEnv);
    const { pr } = prContextFromEvent(event, eventEnv);
    const files = await fetchPrFiles(pr.repo, pr.number, token(), fetchImpl);
    return { mode: "actions", pr, files, fetchImpl };
  }

  if (args.repo !== undefined && args.pr !== undefined) {
    // Local mode via gh.
    const parsed = parseRepoSlug(args.repo);
    const pr = ghPrContext(parsed, args.pr);
    const files = ghPrDiff(parsed, args.pr);
    return { mode: "local", pr, files, fetchImpl };
  }

  throw new HarnessError(
    "no input mode: pass --event/--diff (fixture), set GITHUB_EVENT_PATH (Actions), or pass --repo and --pr (local gh mode)",
  );
}

function parseRepoSlug(slug: string): { owner: string; name: string } {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(slug);
  if (m === null) throw new HarnessError(`--repo expects owner/name, got '${slug}'`);
  return { owner: m[1], name: m[2] };
}

/** Rebuild a patch-shaped text from parsed files (input to gitleaks). */
function synthesizePatch(files: DiffFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (f.added.length === 0) continue;
    parts.push(`--- a/${f.path}\n+++ b/${f.path}`);
    for (const line of f.added) parts.push(`+${line.text}`);
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Gate run                                                            */
/* ------------------------------------------------------------------ */

export async function runGate(args: CliArgs): Promise<GateReport> {
  const { config, note } = loadConfig(args.configPath);
  const inputs = await resolveInputs(args);
  const { pr, files, mode } = inputs;
  const agent = detectAgent(pr, config, args.forceAgent);

  const findings: Finding[] = [];
  const report: GateReport = {
    tool: "agent-pr-gate",
    version: VERSION,
    mode,
    runAt: new Date().toISOString(),
    agent,
    pr: {
      repo: `${pr.repo.owner}/${pr.repo.name}`,
      number: pr.number,
      title: pr.title,
      author: pr.authorLogin,
      labels: pr.labels,
      headSha: pr.headSha,
    },
    findings,
    summary: { errors: 0, warnings: 0, verdict: "pass", exitCode: 0 },
  };
  if (note !== undefined) findings.push({ pillar: "gate", kind: "gate/config-defaults", severity: "warn", message: note });

  if (!agent.isAgent) {
    report.summary = { errors: 0, warnings: findings.filter((f) => f.severity === "warn").length, verdict: "skipped", exitCode: 0 };
    return report;
  }

  /* Pillar 1 — scope enforcement */
  const resolution: PolicyResolution = resolvePolicy(config, pr, files);
  const scopeChecks = checkScope(resolution.entry, files);
  report.policy = { class: resolution.name, source: resolution.source };
  report.scope = { checks: scopeChecks };
  for (const c of scopeChecks) {
    if (c.verdict === "denied") {
      findings.push({
        pillar: "scope",
        kind: "scope/deny",
        severity: "error",
        message: `changed path '${c.path}' matches deny rule '${c.rule}' of policy '${resolution.name}'`,
        path: c.path,
        evidence: `policy '${resolution.name}' (${resolution.source}: ${resolution.detail})`,
      });
    } else if (c.verdict === "out-of-allowlist") {
      findings.push({
        pillar: "scope",
        kind: "scope/out-of-allowlist",
        severity: "error",
        message: `changed path '${c.path}' is outside the allow-list of policy '${resolution.name}'`,
        path: c.path,
        evidence: `allow: [${(resolution.entry.allow ?? []).join(", ")}]`,
      });
    }
  }

  /* Pillar 2 — residue scan */
  const residue = scanResidue(files);
  const bodyFindings = scanBody(pr.title, pr.body);
  const gitleaks: GitleaksResult = gitleaksScan(synthesizePatch(files));
  report.residue = {
    scannedLines: residue.scannedLines,
    scannedFiles: residue.scannedFiles,
    bodyScanned: true,
    gitleaks: { status: gitleaks.status, detail: gitleaks.detail, findings: gitleaks.findings.length },
  };
  findings.push(...residue.findings, ...bodyFindings, ...gitleaks.findings);

  /* Pillar 3 — run attestation */
  let attest;
  if (config.attest.testChecks.length === 0) {
    attest = { verdict: "skipped" as const, reason: "no attest.testChecks configured", checks: [], allRuns: [] };
  } else if (args.checkRunsPath !== undefined) {
    attest = attestFromFixture(config.attest.testChecks, args.checkRunsPath);
  } else if (mode === "actions") {
    attest = await attestFromApi(config.attest.testChecks, pr.repo, pr.headSha, token(), inputs.fetchImpl);
  } else if (mode === "local") {
    attest = attestFromGh(config.attest.testChecks, pr.repo, pr.headSha);
  } else {
    attest = { verdict: "skipped" as const, reason: "fixture mode without --check-runs — attestation skipped", checks: [], allRuns: [] };
  }
  report.attest = attest;
  findings.push(...attestFindings(attest, pr.headSha));

  /* Pillar 4 — claims-vs-diff */
  if (config.claims.verify) {
    const claimsCtx: ClaimsContext = { files, attest, config, headSha: pr.headSha };
    const matches = findClaims(pr.body);
    const results = verifyClaims(matches, claimsCtx);
    report.claims = { verify: true, onMismatch: config.claims.onMismatch, results };
    findings.push(...claimFindings(results, config.claims.onMismatch));
  } else {
    report.claims = { verify: false, onMismatch: config.claims.onMismatch, results: [] };
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  report.summary = {
    errors,
    warnings,
    verdict: errors > 0 ? "fail" : "pass",
    exitCode: errors > 0 ? 1 : 0,
  };
  return report;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`agent-pr-gate: ${errMsg(err)}`);
    console.error("run `agent-pr-gate check --help` for usage");
    return 2;
  }
  if (args.showVersion) {
    console.log(VERSION);
    return 0;
  }
  if (args.showHelp || args.command === undefined) {
    console.log(USAGE);
    return args.command === undefined && !args.showHelp ? 2 : 0;
  }

  let report: GateReport;
  try {
    report = await runGate(args);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof HarnessError) {
      console.error(`agent-pr-gate: ${err.message}`);
      return 2;
    }
    console.error(`agent-pr-gate: unexpected error: ${errMsg(err)}`);
    return 2;
  }

  const text = args.format === "json" ? renderJson(report) : args.format === "github" ? renderGithub(report) : renderConsole(report);
  console.log(text.endsWith("\n") ? text.slice(0, -1) : text);
  return report.summary.exitCode;
}

// Entry point when run as a script (not under node:test).
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error(`agent-pr-gate: unexpected error: ${errMsg(err)}`);
      process.exit(2);
    },
  );
}
