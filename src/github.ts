/**
 * Input adapters: GitHub REST (Actions mode, global fetch — zero deps), gh CLI
 * (local mode), event-payload parsing and fixture loading. Everything that
 * talks to the outside world lives here so the pillar logic stays pure.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { CheckRunInfo, DiffFile, PrContext } from "./types.js";
import { filesFromGitHubApi, parseUnifiedDiff, type FilePatch } from "./diff.js";

/** Harness-level errors -> exit code 2 (config/harness error). */
export class HarnessError extends Error {}

/** Injectable fetch — tests and fixtures never provide one, so they never network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_API_URL = "https://api.github.com";

export function apiUrl(): string {
  return process.env.GITHUB_API_URL !== undefined && process.env.GITHUB_API_URL !== ""
    ? process.env.GITHUB_API_URL
    : DEFAULT_API_URL;
}

export function token(): string | undefined {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return t !== undefined && t !== "" ? t : undefined;
}

function apiHeaders(tokenValue: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-pr-gate",
  };
  if (tokenValue !== undefined) headers.Authorization = `Bearer ${tokenValue}`;
  return headers;
}

/* ------------------------------------------------------------------ */
/* Event payload (Actions + fixture modes)                             */
/* ------------------------------------------------------------------ */

export interface EventContext {
  pr: PrContext;
  /** Raw pull_request payload section (unused beyond metadata). */
  eventName: string;
}

/** Parse a `pull_request` webhook/workflow event JSON into a PrContext. */
export function prContextFromEvent(event: unknown, source: string): EventContext {
  if (typeof event !== "object" || event === null) {
    throw new HarnessError(`event payload in ${source} is not an object`);
  }
  const root = event as Record<string, unknown>;
  const prRaw = root.pull_request;
  if (typeof prRaw !== "object" || prRaw === null) {
    throw new HarnessError(`event payload in ${source} is not a pull_request event (no .pull_request)`);
  }
  const pr = prRaw as Record<string, unknown>;
  const repoRaw = root.repository as Record<string, unknown> | undefined;
  const repoOwner = (repoRaw?.owner as Record<string, unknown> | undefined)?.login;
  const prHead = pr.head as Record<string, unknown> | undefined;
  const user = pr.user as Record<string, unknown> | undefined;

  const owner = typeof repoOwner === "string" ? repoOwner : "";
  const name = typeof repoRaw?.name === "string" ? (repoRaw.name as string) : "";
  const number = pr.number;
  const title = pr.title;
  const body = pr.body;
  const login = user?.login;
  const sha = prHead?.sha;

  if (owner === "" || name === "" || typeof number !== "number" || typeof title !== "string" || typeof body !== "string" || typeof login !== "string" || typeof sha !== "string") {
    throw new HarnessError(`event payload in ${source} is missing required PR fields (repository, number, title, body, user.login, head.sha)`);
  }
  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((l) => (typeof (l as Record<string, unknown>)?.name === "string" ? ((l as Record<string, unknown>).name as string) : "")).filter((l) => l !== "")
    : [];

  return {
    eventName: typeof root.action === "string" ? `pull_request.${root.action}` : "pull_request",
    pr: { repo: { owner, name }, number, title, body, authorLogin: login, labels, headSha: sha },
  };
}

export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new HarnessError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new HarnessError(`invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new HarnessError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* REST API (Actions mode)                                             */
/* ------------------------------------------------------------------ */

const MAX_FILE_PAGES = 10;

/** Fetch the PR's changed files via /repos/{o}/{r}/pulls/{n}/files. */
export async function fetchPrFiles(
  repo: { owner: string; name: string },
  number: number,
  tokenValue: string | undefined,
  fetchImpl: FetchLike,
): Promise<DiffFile[]> {
  const entries: FilePatch[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const url = `${apiUrl()}/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers: apiHeaders(tokenValue) });
    if (!res.ok) {
      throw new HarnessError(`GitHub API ${res.status} fetching PR files: ${url}`);
    }
    const batch = (await res.json()) as Array<Record<string, unknown>>;
    for (const item of batch) {
      const filename = item.filename;
      const status = item.status;
      const patch = item.patch;
      if (typeof filename !== "string" || typeof status !== "string") continue;
      entries.push({
        path: filename,
        status: normalizeStatus(status),
        patch: typeof patch === "string" ? patch : undefined,
      });
    }
    if (batch.length < 100) break;
  }
  return filesFromGitHubApi(entries);
}

/** Fetch check runs for a commit SHA via /commits/{sha}/check-runs. */
export async function fetchCheckRuns(
  repo: { owner: string; name: string },
  sha: string,
  tokenValue: string | undefined,
  fetchImpl: FetchLike,
): Promise<CheckRunInfo[]> {
  const url = `${apiUrl()}/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`;
  const res = await fetchImpl(url, { headers: apiHeaders(tokenValue) });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} fetching check runs for ${sha}`);
  }
  const data = (await res.json()) as { check_runs?: Array<Record<string, unknown>> };
  return (data.check_runs ?? []).map((r) => ({
    name: typeof r.name === "string" ? r.name : "",
    status: typeof r.status === "string" ? r.status : "unknown",
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
  }));
}

function normalizeStatus(status: string): FilePatch["status"] {
  if (status === "added" || status === "modified" || status === "deleted" || status === "renamed" || status === "changed") {
    return status;
  }
  return "changed";
}

/* ------------------------------------------------------------------ */
/* gh CLI (local mode)                                                 */
/* ------------------------------------------------------------------ */

function gh(execArgs: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  const bin = process.platform === "win32" ? "gh.exe" : "gh";
  const res = spawnSync(bin, execArgs, { encoding: "utf8", windowsHide: true });
  if (res.error !== undefined) {
    return { ok: false, error: `gh CLI not found on PATH — install it from https://cli.github.com/ (local mode needs it). (${res.error.message})` };
  }
  if (res.status !== 0) {
    return { ok: false, error: `gh ${execArgs.join(" ")} exited ${res.status}: ${(res.stderr ?? "").trim().slice(0, 300)}` };
  }
  return { ok: true, stdout: res.stdout ?? "" };
}

/** Local mode: PR metadata via `gh pr view --json`. */
export function ghPrContext(repo: { owner: string; name: string }, number: number): PrContext {
  const res = gh(["pr", "view", String(number), "--repo", `${repo.owner}/${repo.name}`, "--json", "number,title,body,author,labels,headRefOid"]);
  if (!res.ok) throw new HarnessError(res.error);
  const data = JSON.parse(res.stdout) as Record<string, unknown>;
  const author = data.author as Record<string, unknown> | undefined;
  const labels = Array.isArray(data.labels)
    ? data.labels.map((l) => (typeof (l as Record<string, unknown>)?.name === "string" ? ((l as Record<string, unknown>).name as string) : "")).filter((l) => l !== "")
    : [];
  const numberRaw = data.number;
  const titleRaw = data.title;
  const bodyRaw = data.body;
  const loginRaw = author?.login;
  const shaRaw = data.headRefOid;
  if (typeof numberRaw !== "number" || typeof titleRaw !== "string" || typeof bodyRaw !== "string" || typeof loginRaw !== "string" || typeof shaRaw !== "string") {
    throw new HarnessError(`gh pr view returned unexpected JSON for PR #${number}`);
  }
  return {
    repo,
    number: numberRaw,
    title: titleRaw,
    body: bodyRaw,
    authorLogin: loginRaw,
    labels,
    headSha: shaRaw,
  };
}

/** Local mode: full unified diff via `gh pr diff`. */
export function ghPrDiff(repo: { owner: string; name: string }, number: number): DiffFile[] {
  const res = gh(["pr", "diff", String(number), "--repo", `${repo.owner}/${repo.name}`, "--patch"]);
  if (!res.ok) throw new HarnessError(res.error);
  return parseUnifiedDiff(res.stdout);
}

/** Local mode: check runs via `gh api` (reuses gh's own auth). */
export function ghCheckRuns(repo: { owner: string; name: string }, sha: string): CheckRunInfo[] {
  const res = gh(["api", `repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`]);
  if (!res.ok) throw new HarnessError(res.error);
  const data = JSON.parse(res.stdout) as { check_runs?: Array<Record<string, unknown>> };
  return (data.check_runs ?? []).map((r) => ({
    name: typeof r.name === "string" ? r.name : "",
    status: typeof r.status === "string" ? r.status : "unknown",
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
  }));
}
