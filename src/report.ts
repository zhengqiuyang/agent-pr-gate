/**
 * Report rendering: console (ANSI, grouped by pillar), github (workflow
 * annotations + summary) and json (the full structured verdict). Pure
 * formatting — no policy decisions here.
 */
import type { Finding, GateReport, ClaimResult } from "./types.js";

/* ------------------------------------------------------------------ */
/* ANSI helpers (no deps; off when NO_COLOR or not a TTY)               */
/* ------------------------------------------------------------------ */

const noColor = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const wrap =
  (code: string) =>
  (s: string): string =>
    noColor ? s : `\u001b[${code}m${s}\u001b[0m`;
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");
const cyan = wrap("36");

const OK = "✓";
const BAD = "✗";
const NOTE = "·";

function verdictMark(verdict: string): string {
  if (verdict === "verified" || verdict === "allowed" || verdict === "success" || verdict === "pass") return green(OK);
  if (verdict === "skipped" || verdict === "unverified") return cyan(NOTE);
  return red(BAD);
}

function truncate(s: string, max = 100): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* Console report                                                      */
/* ------------------------------------------------------------------ */

export function renderConsole(r: GateReport): string {
  const out: string[] = [];
  const modeNote =
    r.mode === "fixture"
      ? "fixture mode (offline)"
      : r.mode === "actions"
        ? "GitHub Actions mode (GITHUB_EVENT_PATH)"
        : "local mode (gh CLI)";
  out.push(bold(`agent-pr-gate v${r.version} — ${modeNote}`));
  out.push("");
  out.push(`PR #${r.pr.number} ${dim(`"${truncate(r.pr.title, 60)}"`)} by ${r.pr.author}`);
  out.push(
    `${r.agent.isAgent ? green("Agent PR: yes") : yellow("Agent PR: no")} ${dim(`(${r.agent.reason})`)}`,
  );
  if (r.agent.isAgent) out.push(dim(`repo ${r.pr.repo} · head ${r.pr.headSha.slice(0, 10)} · labels [${r.pr.labels.join(", ")}]`));
  out.push("");

  if (!r.agent.isAgent) {
    out.push(yellow("Not an agent-authored PR — all pillars skipped (use --force-agent to gate anyway)."));
    out.push("");
    pushSummary(out, r);
    return out.join("\n");
  }

  /* Pillar 1 — scope */
  if (r.scope !== undefined && r.policy !== undefined) {
    out.push(bold(`Scope (policy: ${r.policy.class} — selected via ${r.policy.source})`));
    for (const c of r.scope.checks) {
      if (c.verdict === "allowed") {
        out.push(`  ${verdictMark(c.verdict)} ${c.path} ${dim(c.rule !== undefined ? `allowed (${c.rule})` : "allowed")}`);
      } else if (c.verdict === "denied") {
        out.push(`  ${verdictMark(c.verdict)} ${c.path} ${red(`matches deny rule '${c.rule}'`)}`);
      } else {
        out.push(`  ${verdictMark(c.verdict)} ${c.path} ${red("outside the policy allow-list")}`);
      }
    }
    out.push("");
  }

  /* Pillar 2 — residue */
  if (r.residue !== undefined) {
    const g = r.residue.gitleaks;
    const gitleaksNote =
      g.status === "ran"
        ? `gitleaks: ran, ${g.findings} advisory finding(s)`
        : g.status === "skipped"
          ? `gitleaks: ${g.detail ?? "skipped"}`
          : `gitleaks: wrapper error (${g.detail ?? ""}) — advisory`;
    out.push(bold("Residue"));
    out.push(dim(`  scanned ${r.residue.scannedLines} added line(s) across ${r.residue.scannedFiles} file(s); ${gitleaksNote}`));
    const main = r.findings.filter(
      (f) => f.pillar === "residue" && !f.kind.startsWith("residue/body/") && !f.kind.startsWith("residue/gitleaks"),
    );
    const advisory = r.findings.filter(
      (f) => f.pillar === "residue" && (f.kind.startsWith("residue/body/") || f.kind.startsWith("residue/gitleaks")),
    );
    if (main.length === 0 && advisory.length === 0) {
      out.push(`  ${green(OK)} no residue findings`);
    } else {
      for (const f of main) {
        out.push(`  ${red(BAD)} ${red(f.message)}`);
        out.push(dim(`      ${f.path}:${f.line}  ${f.evidence ?? ""}`));
      }
      if (advisory.length > 0) {
        out.push(dim(`  advisory:`));
        for (const f of advisory) {
          out.push(`    ${yellow(NOTE)} ${f.message}`);
          if (f.evidence !== undefined) out.push(dim(`        ${truncate(f.evidence, 110)}`));
        }
      }
    }
    out.push("");
  }

  /* Pillar 3 — attestation */
  if (r.attest !== undefined) {
    out.push(bold(`Attestation (head ${r.pr.headSha.slice(0, 10)})`));
    if (r.attest.verdict === "skipped") {
      out.push(`  ${verdictMark("skipped")} skipped — ${r.attest.reason ?? "no data"}${r.attest.fixture === true ? "" : ""}`);
    } else if (r.attest.checks.length === 0) {
      out.push(`  ${verdictMark("skipped")} no attest.testChecks configured`);
    } else {
      for (const c of r.attest.checks) {
        const names = c.matched.map((m) => `'${m.name}' -> ${m.conclusion ?? m.status}`).join(", ");
        if (c.verdict === "success") {
          out.push(`  ${verdictMark(c.verdict)} check '${c.substring}' ${dim(names)}`);
        } else if (c.verdict === "not-found") {
          out.push(`  ${verdictMark(c.verdict)} ${red(`check '${c.substring}' — no matching check runs on this SHA (${r.attest.allRuns.length} run(s) total)`)}`);
        } else if (c.verdict === "failed") {
          out.push(`  ${verdictMark(c.verdict)} ${red(`check '${c.substring}' ${names}`)}`);
        } else {
          out.push(`  ${verdictMark(c.verdict)} check '${c.substring}' ${yellow(names)}`);
        }
      }
    }
    out.push("");
  }

  /* Pillar 4 — claims */
  if (r.claims !== undefined) {
    out.push(bold(`Claims (verify ${r.claims.verify ? "on" : "off"}, onMismatch=${r.claims.onMismatch})`));
    if (!r.claims.verify) {
      out.push(`  ${verdictMark("skipped")} claims verification disabled`);
    } else if (r.claims.results.length === 0) {
      out.push(`  ${verdictMark("skipped")} no recognizable claims in the PR body`);
    } else {
      for (const c of r.claims.results) {
        out.push(claimLine(c));
      }
    }
    out.push("");
  }

  pushSummary(out, r);
  return out.join("\n");
}

function claimLine(c: ClaimResult): string {
  const mark = verdictMark(c.verdict);
  const label = c.verdict === "verified" ? green("verified") : c.verdict === "mismatch" ? red("mismatch") : cyan("unverified");
  return `  ${mark} ${label.padEnd(noColor ? 11 : 11)} ${bold(c.type)} ${dim(`"${truncate(c.raw, 48)}" (body line ${c.line})`)}\n      ${dim(truncate(c.evidence, 110))}`;
}

function pushSummary(out: string[], r: GateReport): void {
  const line =
    r.summary.verdict === "pass"
      ? green(`Verdict: PASS — ${r.summary.errors} error(s), ${r.summary.warnings} warning(s)`)
      : r.summary.verdict === "skipped"
        ? yellow(`Verdict: SKIPPED (not an agent PR) — exit ${r.summary.exitCode}`)
        : red(`Verdict: FAIL — ${r.summary.errors} error(s), ${r.summary.warnings} warning(s)`);
  out.push(bold(line));
}

/* ------------------------------------------------------------------ */
/* GitHub annotations format                                           */
/* ------------------------------------------------------------------ */

function escapeAnnotation(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function renderGithub(r: GateReport): string {
  const out: string[] = [];
  if (!r.agent.isAgent) {
    out.push(`::notice::agent-pr-gate: not an agent-authored PR (${r.agent.reason}) — gate skipped`);
    return out.join("\n");
  }
  for (const f of r.findings) {
    const cmd = f.severity === "error" ? "::error" : "::warning";
    const props: string[] = [];
    if (f.path !== undefined && !f.path.startsWith("PR body")) props.push(`file=${f.path}`);
    if (f.line !== undefined) props.push(`line=${f.line}`);
    const propStr = props.length > 0 ? ` ${props.join(",")}` : "";
    out.push(`${cmd}${propStr}::agent-pr-gate [${f.kind}] ${escapeAnnotation(f.message)}${f.evidence !== undefined ? ` — ${escapeAnnotation(f.evidence)}` : ""}`);
  }
  if (r.findings.length === 0) {
    out.push(`::notice::agent-pr-gate: PASS — agent PR verified clean (${r.summary.errors} errors, ${r.summary.warnings} warnings)`);
  } else {
    out.push(`agent-pr-gate: ${r.summary.verdict.toUpperCase()} — ${r.findings.length} finding(s): ${r.summary.errors} error(s), ${r.summary.warnings} warning(s)`);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* JSON format                                                         */
/* ------------------------------------------------------------------ */

export function renderJson(r: GateReport): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}
