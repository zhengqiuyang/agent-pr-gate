/**
 * Unified-diff parser: turns `git diff` / `gh pr diff` / GitHub pull-files
 * patch text into structured files + added lines (context lines are dropped —
 * the residue scan must only ever see what the PR adds).
 *
 * CRLF-tolerant: input may use \n, \r\n or a mix; the parser splits on /\r?\n/.
 */
import type { AddedLine, DiffFile } from "./types.js";

export interface FilePatch {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "changed";
  patch?: string;
}

/** Parse a full unified diff (`diff --git a/x b/y ...` blocks). */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let newPath: string | null = null;
  let oldPath: string | null = null;
  let gitHeaderPath: string | null = null;
  let newLine = 0;
  let inHunk = false;

  const flush = (): void => {
    if (current === null) return;
    if (newPath !== null && newPath !== "/dev/null") current.path = newPath;
    else if (oldPath !== null && oldPath !== "/dev/null") current.path = oldPath;
    else if (gitHeaderPath !== null) current.path = gitHeaderPath; // binary diffs have no ---/+++
    if (current.status === "renamed" && oldPath !== null && oldPath !== "/dev/null") {
      current.oldPath = oldPath;
    }
    if (current.path !== "") files.push(current);
    current = null;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      flush();
      newPath = null;
      oldPath = null;
      gitHeaderPath = gitHeaderPathFrom(raw);
      inHunk = false;
      current = { path: "", status: "changed", added: [], additions: 0, deletions: 0, binary: false };
      continue;
    }
    if (current === null) {
      // A bare patch (GitHub pull-files `patch` field) without the `diff --git`
      // header: start a file on the first `---` marker instead.
      if (raw.startsWith("--- ")) {
        current = { path: "", status: "changed", added: [], additions: 0, deletions: 0, binary: false };
        oldPath = parseMarkerLine(raw.slice(4));
        newPath = null;
        inHunk = false;
      }
      continue;
    }
    if (raw.startsWith("--- ")) {
      oldPath = parseMarkerLine(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      newPath = parseMarkerLine(raw.slice(4));
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      newLine = m !== null ? parseInt(m[1], 10) : 1;
      inHunk = true;
      continue;
    }
    if (raw.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      current.status = "renamed";
      oldPath = unescapePath(raw.slice("rename from ".length).replace(/\r$/, ""));
      continue;
    }
    if (raw.startsWith("rename to ")) {
      newPath = unescapePath(raw.slice("rename to ".length).replace(/\r$/, ""));
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (
      raw.startsWith("index ") ||
      raw.startsWith("old mode ") ||
      raw.startsWith("new mode ") ||
      raw.startsWith("similarity index ") ||
      raw.startsWith("dissimilarity index ")
    ) {
      continue;
    }
    if (raw.startsWith("\\ No newline at end of file")) {
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      const added: AddedLine = { number: newLine, text: raw.slice(1).replace(/\r$/, "") };
      current.added.push(added);
      current.additions += 1;
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      current.deletions += 1;
      continue;
    }
    if (raw.startsWith(" ") || raw === "") {
      // Context line (a fully empty line inside a hunk is an empty context line).
      newLine += 1;
      continue;
    }
  }
  flush();
  return files;
}

/** `--- a/path` / `+++ b/path` / `--- /dev/null` -> path (git quoting handled). */
function parseMarkerLine(rest: string): string {
  return unescapePath(rest.replace(/\r$/, ""));
}

/**
 * Extract the path from a `diff --git a/x b/x` header (used for binary diffs,
 * which carry no ---/+++ markers). Git quotes paths containing spaces.
 */
function gitHeaderPathFrom(raw: string): string | null {
  const rest = raw.slice("diff --git ".length).replace(/\r$/, "");
  const quoted = /^"a\/(.+)" "b\/.*"$/.exec(rest);
  if (quoted !== null) return unquote(quoted[1]);
  const plain = /^a\/(.+) b\/.*$/.exec(rest);
  if (plain !== null) return plain[1];
  return null;
}

function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  return s
    .slice(1, -1)
    .replace(/\\(?:\\|\"|t|n|[0-7]{1,3})/g, (esc) => {
      switch (esc[1]) {
        case "\\":
          return "\\";
        case '"':
          return '"';
        case "t":
          return "\t";
        case "n":
          return "\n";
        default:
          return String.fromCharCode(parseInt(esc.slice(1), 8));
      }
    });
}

/**
 * Resolve a `---`/`+++` path: strip the a/ or b/ prefix git adds (only when
 * present), and unquote C-style quoted paths ("a/pa\th").
 */
function unescapePath(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
    // Minimal git C-style unescape: \\ \" \t \n and octal \nnn.
    s = s.replace(/\\(?:\\|\"|t|n|[0-7]{1,3})/g, (esc) => {
      switch (esc[1]) {
        case "\\":
          return "\\";
        case '"':
          return '"';
        case "t":
          return "\t";
        case "n":
          return "\n";
        default:
          return String.fromCharCode(parseInt(esc.slice(1), 8));
      }
    });
  }
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

/**
 * Convert GitHub `pulls/{n}/files` JSON entries (filename + per-file patch)
 * into DiffFiles by reusing the unified parser on a synthesized header pair.
 */
export function filesFromGitHubApi(entries: FilePatch[]): DiffFile[] {
  const out: DiffFile[] = [];
  for (const entry of entries) {
    if (entry.patch === undefined) {
      out.push({
        path: entry.path,
        status: entry.status,
        added: [],
        additions: 0,
        deletions: 0,
        binary: true,
      });
      continue;
    }
    const oldPfx = entry.status === "added" ? "/dev/null" : `a/${entry.path}`;
    const newPfx = entry.status === "deleted" ? "/dev/null" : `b/${entry.path}`;
    const synth = `--- ${oldPfx}\n+++ ${newPfx}\n${entry.patch}`;
    const parsed = parseUnifiedDiff(synth);
    const file = parsed[parsed.length - 1];
    if (file !== undefined && file.path === entry.path) {
      file.status = entry.status;
      out.push(file);
    } else if (file !== undefined) {
      // e.g. quoted paths — trust the API filename.
      file.path = entry.path;
      file.status = entry.status;
      if (entry.status === "renamed") file.oldPath = undefined;
      out.push(file);
    }
  }
  return out;
}
