/**
 * Pillar 1 — scope enforcement: config loading, glob matching, agent-signal
 * detection and policy resolution. Pure functions, no I/O except config load.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DiffFile, PrContext, ScopeCheck } from "./types.js";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export class ConfigError extends Error {}

export interface PolicyEntry {
  allow?: string[];
  deny?: string[];
}

export interface GateConfig {
  agentSignals: { actors: string[]; labels: string[] };
  policies: Record<string, PolicyEntry>;
  claims: {
    verify: boolean;
    onMismatch: "fail" | "warn";
    apiPaths?: string[];
  };
  attest: { testChecks: string[] };
  /** Path the config was loaded from (absent for built-in defaults). */
  source?: string;
}

export const DEFAULT_CONFIG_PATHS = ["agent-pr-gate.yaml", ".agent-pr-gate.yaml"];

/** Built-in defaults: identical to agent-pr-gate.example.yaml. */
export function defaultConfig(): GateConfig {
  return {
    agentSignals: {
      actors: ["copilot-sweeper-agent", "github-actions[bot]", "app/claude"],
      labels: ["agent", "ai-generated"],
    },
    policies: {
      "bump-deps": {
        allow: ["package.json", "package-lock.json", "pnpm-lock.yaml", "deps/**"],
        deny: [".github/workflows/**", "CODEOWNERS", "**/*.test.ts"],
      },
      default: {
        deny: [".github/workflows/**", "CODEOWNERS", "agent-pr-gate.yaml", ".agent-pr-gate.yaml"],
      },
    },
    claims: { verify: true, onMismatch: "fail" },
    attest: { testChecks: ["test", "build"] },
  };
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${where}: expected an array of strings`);
  }
  return (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
}

function asPolicyEntry(value: unknown, where: string): PolicyEntry {
  if (typeof value !== "object" || value === null) {
    throw new ConfigError(`${where}: expected a policy mapping`);
  }
  const record = value as Record<string, unknown>;
  const entry: PolicyEntry = {};
  if (record.allow !== undefined) entry.allow = asStringArray(record.allow, `${where}.allow`);
  if (record.deny !== undefined) entry.deny = asStringArray(record.deny, `${where}.deny`);
  if (entry.allow !== undefined && entry.allow.length === 0 && (entry.deny === undefined || entry.deny.length === 0)) {
    throw new ConfigError(`${where}: policy has empty allow and deny lists`);
  }
  return entry;
}

/** Parse + validate a config object (already YAML-parsed). Throws ConfigError. */
export function normalizeConfig(raw: unknown, source?: string): GateConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("config root must be a mapping");
  }
  const root = raw as Record<string, unknown>;
  const defaults = defaultConfig();

  const signalsRaw = (root.agentSignals ?? {}) as Record<string, unknown>;
  const policiesRaw = (root.policies ?? {}) as Record<string, unknown>;
  const claimsRaw = (root.claims ?? {}) as Record<string, unknown>;
  const attestRaw = (root.attest ?? {}) as Record<string, unknown>;

  const policies: Record<string, PolicyEntry> = {};
  for (const [name, value] of Object.entries(policiesRaw)) {
    policies[name] = asPolicyEntry(value, `policies.${name}`);
  }
  if (Object.keys(policies).length === 0) policies.default = defaults.policies.default;
  if (policies.default === undefined) {
    // Synthesize an empty default so resolution always has somewhere to land.
    policies.default = {};
  }

  const onMismatchRaw = claimsRaw.onMismatch ?? defaults.claims.onMismatch;
  if (onMismatchRaw !== "fail" && onMismatchRaw !== "warn") {
    throw new ConfigError(`claims.onMismatch: expected "fail" or "warn", got ${JSON.stringify(onMismatchRaw)}`);
  }

  const config: GateConfig = {
    agentSignals: {
      actors: signalsRaw.actors !== undefined ? asStringArray(signalsRaw.actors, "agentSignals.actors") : defaults.agentSignals.actors,
      labels: signalsRaw.labels !== undefined ? asStringArray(signalsRaw.labels, "agentSignals.labels") : defaults.agentSignals.labels,
    },
    policies,
    claims: {
      verify: claimsRaw.verify !== undefined ? Boolean(claimsRaw.verify) : defaults.claims.verify,
      onMismatch: onMismatchRaw,
      apiPaths: claimsRaw.apiPaths !== undefined ? asStringArray(claimsRaw.apiPaths, "claims.apiPaths") : undefined,
    },
    attest: {
      testChecks: attestRaw.testChecks !== undefined ? asStringArray(attestRaw.testChecks, "attest.testChecks") : defaults.attest.testChecks,
    },
  };
  if (source !== undefined) config.source = source;
  return config;
}

/**
 * Load config from an explicit path (error if missing/invalid) or from the
 * default search paths (fall back to built-in defaults when none exist).
 * CRLF-tolerant: the YAML parser does not care, and we never split on raw \n.
 */
export function loadConfig(explicitPath: string | undefined, cwd = process.cwd()): { config: GateConfig; note?: string } {
  if (explicitPath !== undefined) {
    if (!fs.existsSync(explicitPath)) {
      throw new ConfigError(`config file not found: ${explicitPath}`);
    }
    return { config: readConfigFile(explicitPath) };
  }
  for (const name of DEFAULT_CONFIG_PATHS) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) {
      return { config: readConfigFile(candidate) };
    }
  }
  return { config: defaultConfig(), note: `no ${DEFAULT_CONFIG_PATHS.join(" / ")} found — using built-in defaults` };
}

function readConfigFile(file: string): GateConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${errMsg(err)}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`invalid YAML in ${file}: ${errMsg(err)}`);
  }
  return normalizeConfig(raw, file);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* Glob matcher (tiny, deterministic)                                  */
/* ------------------------------------------------------------------ */

/**
 * Match a diff path against a glob pattern.
 * Supported: `**` (any number of path segments, including zero when leading),
 * `*` (anything but `/`), `?` (one char, not `/`). Everything else literal.
 * Case-sensitive, like POSIX globs. Trailing `/` in a pattern matches a prefix.
 */
export function globMatch(pattern: string, filePath: string): boolean {
  if (pattern.endsWith("/")) {
    // "docs/" matches everything under docs/ (and docs itself).
    return filePath.startsWith(pattern) || globMatchSegments(pattern.slice(0, -1).split("/"), filePath.split("/"));
  }
  return globMatchSegments(pattern.split("/"), filePath.split("/"));
}

function globMatchSegments(patternSegs: string[], pathSegs: string[]): boolean {
  if (patternSegs.length === 0) return pathSegs.length === 0;
  const head = patternSegs[0];
  if (head === "**") {
    // `**` consumes zero or more path segments.
    for (let i = 0; i <= pathSegs.length; i += 1) {
      if (globMatchSegments(patternSegs.slice(1), pathSegs.slice(i))) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  if (!segmentMatch(head, pathSegs[0])) return false;
  return globMatchSegments(patternSegs.slice(1), pathSegs.slice(1));
}

function segmentMatch(patternSeg: string, pathSeg: string): boolean {
  let re = "^";
  for (let i = 0; i < patternSeg.length; i += 1) {
    const ch = patternSeg[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(pathSeg);
}

/** First glob in `patterns` that matches `filePath`, or undefined. */
export function firstMatch(patterns: string[] | undefined, filePath: string): string | undefined {
  if (patterns === undefined) return undefined;
  for (const p of patterns) {
    if (globMatch(p, filePath)) return p;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Agent-signal detection                                              */
/* ------------------------------------------------------------------ */

export interface AgentDetection {
  isAgent: boolean;
  reason: string;
}

/**
 * Is this PR agent-authored? OR semantics: any actor substring or any label
 * match counts. `force` (--force-agent) short-circuits to yes.
 */
export function detectAgent(pr: PrContext, config: GateConfig, force: boolean): AgentDetection {
  if (force) {
    return { isAgent: true, reason: "--force-agent" };
  }
  // Candidate identity strings for the author: the bare login, plus the
  // "app/<name>" form gh and GitHub show for app/bot accounts ("claude[bot]"
  // -> "app/claude"), so config entries written either way both work.
  const login = pr.authorLogin.toLowerCase();
  const appForm = `app/${login.replace(/\[bot\]$/, "")}`;
  const candidates = [login, appForm];
  for (const actor of config.agentSignals.actors) {
    const needle = actor.toLowerCase();
    if (candidates.some((c) => c.includes(needle))) {
      return { isAgent: true, reason: `author login '${pr.authorLogin}' matches actor signal '${actor}'` };
    }
  }
  for (const label of pr.labels) {
    const l = label.toLowerCase();
    if (config.agentSignals.labels.some((signal) => l === signal || l.includes(signal))) {
      return { isAgent: true, reason: `PR label '${label}' matches label signal` };
    }
  }
  return { isAgent: false, reason: `author '${pr.authorLogin}' and labels [${pr.labels.join(", ")}] match no agent signal` };
}

/* ------------------------------------------------------------------ */
/* Policy resolution + scope checking                                  */
/* ------------------------------------------------------------------ */

export interface PolicyResolution {
  name: string;
  entry: PolicyEntry;
  source: "label" | "path-heuristic" | "default";
  /** Explanation shown in the report (matched label or heuristic counts). */
  detail: string;
}

/**
 * Resolve the policy class for a PR:
 * 1. exact label named after a policy class -> that policy;
 * 2. otherwise the non-default policy whose allow-list matches the most
 *    changed paths (ties broken by config order) -> path heuristic;
 * 3. otherwise `default`.
 * Unknown policy label -> default (deterministic, never an error).
 */
export function resolvePolicy(config: GateConfig, pr: PrContext, files: DiffFile[]): PolicyResolution {
  const names = Object.keys(config.policies);
  for (const label of pr.labels) {
    if (label === "default") continue;
    if (names.includes(label)) {
      return { name: label, entry: config.policies[label], source: "label", detail: `PR label '${label}'` };
    }
  }
  let best: { name: string; count: number } | undefined;
  for (const name of names) {
    if (name === "default") continue;
    const allow = config.policies[name].allow;
    if (allow === undefined) continue;
    const count = files.filter((f) => firstMatch(allow, f.path) !== undefined).length;
    if (count > 0 && (best === undefined || count > best.count)) {
      best = { name, count };
    }
  }
  if (best !== undefined) {
    return {
      name: best.name,
      entry: config.policies[best.name],
      source: "path-heuristic",
      detail: `${best.count}/${files.length} changed path(s) match the '${best.name}' allow-list`,
    };
  }
  const entry = config.policies.default ?? {};
  return { name: "default", entry, source: "default", detail: "no label or path heuristic matched" };
}

/** Check every changed path against the resolved policy. Deny wins over allow. */
export function checkScope(entry: PolicyEntry, files: DiffFile[]): ScopeCheck[] {
  return files.map((f) => {
    const deniedBy = firstMatch(entry.deny, f.path);
    if (deniedBy !== undefined) {
      return { path: f.path, verdict: "denied" as const, rule: deniedBy };
    }
    const allowedBy = firstMatch(entry.allow, f.path);
    if (allowedBy !== undefined) {
      return { path: f.path, verdict: "allowed" as const, rule: allowedBy };
    }
    if (entry.allow !== undefined && entry.allow.length > 0) {
      return { path: f.path, verdict: "out-of-allowlist" as const };
    }
    return { path: f.path, verdict: "allowed" as const };
  });
}
