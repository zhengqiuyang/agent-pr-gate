import { test } from "node:test";
import assert from "node:assert/strict";
import { filesFromGitHubApi, parseUnifiedDiff } from "../src/diff.js";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -3,4 +3,6 @@ export function main() {
   const a = 1;
-  const old = 2;
+  const fresh = 2;
+  const newer = 3;
   const ctx = 4;
 }
diff --git a/docs/readme.md b/docs/readme.md
old mode 100644
new mode 100755
similarity index 90%
rename from docs/old-readme.md
rename to docs/readme.md
@@ -1,2 +1,3 @@
 # Title
+New line under the title.
 body
`;

test("diff: parses files, paths, added lines with numbers", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/app.ts");
  assert.equal(files[0].status, "changed");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.deepEqual(
    files[0].added.map((l) => [l.number, l.text]),
    [
      [4, "  const fresh = 2;"],
      [5, "  const newer = 3;"],
    ],
  );
});

test("diff: context lines are never included as added lines", () => {
  const files = parseUnifiedDiff(SAMPLE);
  const texts = files.flatMap((f) => f.added.map((l) => l.text));
  assert.equal(texts.includes("  const a = 1;"), false);
  assert.equal(texts.includes("  const ctx = 4;"), false);
});

test("diff: renames use the new path and keep the old one", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files[1].path, "docs/readme.md");
  assert.equal(files[1].oldPath, "docs/old-readme.md");
  assert.equal(files[1].status, "renamed");
});

test("diff: CRLF input parses identically to LF input", () => {
  const crlf = SAMPLE.split("\n").join("\r\n");
  const files = parseUnifiedDiff(crlf);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files[0].added.map((l) => l.text),
    ["  const fresh = 2;", "  const newer = 3;"],
  );
  assert.equal(files[1].path, "docs/readme.md");
});

test("diff: new and deleted files resolve their path", () => {
  const patch = `diff --git a/added.txt b/added.txt
new file mode 100644
index 000..333
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 444..000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-goodbye
`;
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "added.txt");
  assert.equal(files[0].status, "added");
  assert.deepEqual(files[0].added.map((l) => l.text), ["hello"]);
  assert.equal(files[1].path, "gone.txt");
  assert.equal(files[1].status, "deleted");
  assert.equal(files[1].added.length, 0);
});

test("diff: binary files are marked and contribute no lines", () => {
  const patch = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].added.length, 0);
});

test("diff: filesFromGitHubApi reuses the unified parser on per-file patches", () => {
  const files = filesFromGitHubApi([
    {
      path: "src/x.ts",
      status: "modified",
      patch: "@@ -1,3 +1,4 @@\n line1\n-old\n+new\n+extra\n line3",
    },
    { path: "assets/logo.png", status: "modified" },
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/x.ts");
  assert.deepEqual(
    files[0].added.map((l) => [l.number, l.text]),
    [
      [2, "new"],
      [3, "extra"],
    ],
  );
  assert.equal(files[1].binary, true);
});
