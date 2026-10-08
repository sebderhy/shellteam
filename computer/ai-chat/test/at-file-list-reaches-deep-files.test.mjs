/**
 * "@ finds files only up to depth 2" (Seb, 2026-10-02). listFiles stopped at 500
 * entries, breadth-first, so a folder with many shallow files never reached
 * the deeper levels the @ picker filters over.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "at-files-"));
const { listFiles } = await import("../lib/history.mjs");

test("a deep file is listed even when shallow levels hold over 500 entries", () => {
  const root = mkdtempSync(join(tmpdir(), "at-files-root-"));
  mkdirSync(join(root, "wide"));
  for (let i = 0; i < 800; i++) writeFileSync(join(root, "wide", `f${i}.txt`), "");
  mkdirSync(join(root, "a/b/c/d/e/f"), { recursive: true });
  writeFileSync(join(root, "a/b/c/d/e/f/deep.txt"), "");
  assert.ok(listFiles(root).includes("a/b/c/d/e/f/deep.txt"));
});
