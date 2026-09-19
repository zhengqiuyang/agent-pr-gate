import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { checkScope, detectAgent, normalizeConfig, resolvePolicy, ConfigError } from "../src/policy.js";
import type { DiffFile, PrContext } from "../src/types.js";

const EXAMPLE_YAML = `
agentSignals:
  actors: ["copilot-sweeper-agent", "github-actions[bot]", "app/claude"]
  labels: ["agent", "ai-generated"]
policies:
  bump-deps:
    allow: ["package.json", "package-lock.json", "pnpm-lock.yaml", "deps/**"]
    deny: [".github/workflows/**", "CODEOWNERS", "**/*.test.ts"]
  default:
    deny: [".github/workflows/**", "CODEOWNERS", "agent-pr-gate.yaml"]
attest:
  testChecks: ["test", "build"]
claims:
  verify: true
  onMismatch: fail
`;

function files(paths: string[]): DiffFile[] {
  return paths.map((path) => ({ path, status: "modified" as const, added: [], additions: 0, deletions: 0, binary: false }));
}

function pr(overrides: Partial<PrContext> = {}): PrContext {
  return {
    repo: { owner: "example", name: "widgets" },
    number: 1,
    title: "t",
    body: "",
    authorLogin: "octocat",
    labels: [],
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

/* ---------------- config ---------------- */

test("policy: config normalizes from YAML", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  assert.deepEqual(config.agentSignals.actors, ["copilot-sweeper-agent", "github-actions[bot]", "app/claude"]);
  assert.deepEqual(config.policies["bump-deps"]?.allow, ["package.json", "package-lock.json", "pnpm-lock.yaml", "deps/**"]);
  assert.deepEqual(config.policies.default?.deny, [".github/workflows/**", "CODEOWNERS", "agent-pr-gate.yaml"]);
  assert.deepEqual(config.attest.testChecks, ["test", "build"]);
  assert.equal(config.claims.verify, true);
  assert.equal(config.claims.onMismatch, "fail");
});

test("policy: partial config falls back to built-in defaults", () => {
  const config = normalizeConfig({ policies: { default: { deny: ["SECRET"] } } });
  assert.deepEqual(config.agentSignals.labels, ["agent", "ai-generated"]);
  assert.deepEqual(config.attest.testChecks, ["test", "build"]);
  assert.deepEqual(config.policies.default?.deny, ["SECRET"]);
});

test("policy: invalid onMismatch is a config error", () => {
  assert.throws(() => normalizeConfig({ claims: { onMismatch: "explode" } }), ConfigError);
  assert.throws(() => normalizeConfig({ policies: { x: { allow: "not-a-list" } } }), ConfigError);
});

test("policy: a policy with no deny list and empty allow is rejected", () => {
  assert.throws(() => normalizeConfig({ policies: { x: { allow: [] } } }), ConfigError);
});

/* ---------------- agent signals ---------------- */

test("policy: actor substring match makes the PR an agent PR", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  assert.equal(detectAgent(pr({ authorLogin: "copilot-sweeper-agent" }), config, false).isAgent, true);
  assert.equal(detectAgent(pr({ authorLogin: "copilot-sweeper-agent-beta" }), config, false).isAgent, true);
});

test("policy: 'app/claude' matches the claude[bot] login form", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  assert.equal(detectAgent(pr({ authorLogin: "claude[bot]" }), config, false).isAgent, true);
});

test("policy: label match works with OR semantics", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  assert.equal(detectAgent(pr({ authorLogin: "alice", labels: ["agent"] }), config, false).isAgent, true);
  assert.equal(detectAgent(pr({ authorLogin: "alice", labels: ["ai-generated"] }), config, false).isAgent, true);
  assert.equal(detectAgent(pr({ authorLogin: "alice", labels: ["bug"] }), config, false).isAgent, false);
});

test("policy: --force-agent overrides detection", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  const d = detectAgent(pr({ authorLogin: "alice" }), config, true);
  assert.equal(d.isAgent, true);
  assert.equal(d.reason, "--force-agent");
});

/* ---------------- policy resolution ---------------- */

test("policy: PR label selects the policy class", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  const r = resolvePolicy(config, pr({ labels: ["bump-deps"] }), files(["package.json"]));
  assert.equal(r.name, "bump-deps");
  assert.equal(r.source, "label");
});

test("policy: unknown label falls through to the path heuristic", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  const r = resolvePolicy(config, pr({ labels: ["deps-typo"] }), files(["package.json", "package-lock.json"]));
  assert.equal(r.name, "bump-deps");
  assert.equal(r.source, "path-heuristic");
});

test("policy: path heuristic picks the policy with most allow-list hits", () => {
  const config = normalizeConfig({
    policies: {
      "bump-deps": { allow: ["package.json"] },
      docs: { allow: ["docs/**", "*.md"] },
      default: { deny: [".github/workflows/**"] },
    },
  });
  const r = resolvePolicy(config, pr(), files(["docs/a.md", "docs/b.md", "package.json"]));
  assert.equal(r.name, "docs");
});

test("policy: no label and no heuristic hit resolves to default", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  const r = resolvePolicy(config, pr(), files(["src/a.ts", "README.md"]));
  assert.equal(r.name, "default");
  assert.equal(r.source, "default");
});

/* ---------------- scope checking ---------------- */

test("policy: deny wins over allow", () => {
  const config = normalizeConfig(parseYaml(EXAMPLE_YAML));
  const entry = resolvePolicy(config, pr({ labels: ["bump-deps"] }), files(["package.json", ".github/workflows/ci.yml", "src/a.test.ts"])).entry;
  const checks = checkScope(entry, files(["package.json", ".github/workflows/ci.yml", "src/a.test.ts"]));
  assert.deepEqual(
    checks.map((c) => c.verdict),
    ["allowed", "denied", "denied"],
  );
  assert.equal(checks[1].rule, ".github/workflows/**");
});

test("policy: allow-list-only policies flag everything else", () => {
  const checks = checkScope({ allow: ["package.json"] }, files(["package.json", "src/a.ts"]));
  assert.deepEqual(
    checks.map((c) => c.verdict),
    ["allowed", "out-of-allowlist"],
  );
});

test("policy: deny-only policies allow anything not denied", () => {
  const checks = checkScope({ deny: ["CODEOWNERS"] }, files(["package.json", "src/a.ts"]));
  assert.deepEqual(
    checks.map((c) => c.verdict),
    ["allowed", "allowed"],
  );
});
