import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch } from "../src/policy.js";

test("glob: exact path matches", () => {
  assert.equal(globMatch("package.json", "package.json"), true);
  assert.equal(globMatch("package.json", "src/package.json"), false);
  assert.equal(globMatch("CODEOWNERS", "CODEOWNERS"), true);
});

test("glob: * stays within one segment", () => {
  assert.equal(globMatch("*.ts", "cli.ts"), true);
  assert.equal(globMatch("*.ts", "src/cli.ts"), false);
  assert.equal(globMatch("*.test.ts", "a.test.ts"), true);
  assert.equal(globMatch("src/*.ts", "src/a.ts"), true);
  assert.equal(globMatch("src/*.ts", "src/sub/a.ts"), false);
});

test("glob: ? matches exactly one non-separator char", () => {
  assert.equal(globMatch("a?.ts", "ab.ts"), true);
  assert.equal(globMatch("a?.ts", "abc.ts"), false);
  assert.equal(globMatch("a?.ts", "a.ts"), false);
});

test("glob: ** crosses segments", () => {
  assert.equal(globMatch("src/**", "src/a.ts"), true);
  assert.equal(globMatch("src/**", "src/x/y/z.ts"), true);
  assert.equal(globMatch("src/**", "srcx/a.ts"), false);
  assert.equal(globMatch("**/*.test.ts", "a.test.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "x/y/a.test.ts"), true);
  assert.equal(globMatch("**/*.test.ts", "a.test.js"), false);
  assert.equal(globMatch(".github/workflows/**", ".github/workflows/ci.yml"), true);
  assert.equal(globMatch(".github/workflows/**", ".github/actions/ci.yml"), false);
  assert.equal(globMatch("deps/**", "deps/a/b.txt"), true);
  assert.equal(globMatch("deps/**", "dep/a.txt"), false);
});

test("glob: matching is case-sensitive", () => {
  assert.equal(globMatch("SRC/**", "src/a.ts"), false);
  assert.equal(globMatch("src/**", "SRC/a.ts"), false);
});

test("glob: trailing slash is a directory prefix", () => {
  assert.equal(globMatch("docs/", "docs/readme.md"), true);
  assert.equal(globMatch("docs/", "docs/x/readme.md"), true);
  assert.equal(globMatch("docs/", "src/docs.ts"), false);
});

test("glob: regex metacharacters in patterns are literal", () => {
  assert.equal(globMatch("a+b.c", "a+b.c"), true);
  assert.equal(globMatch("a+b.c", "aabbc"), false);
});
