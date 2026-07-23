/**
 * SHE-86: the Workspace picker only listed home folders that were git repos
 * (plus ~/projects/*), so a plain project folder like ~/sidecar never appeared and
 * could only be reached by typing its full path. listWorkspaces() must surface
 * every real top-level folder under $HOME.
 *
 * constants.mjs reads HOME at module-eval, so HOME is set before the import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "she86-"));
process.env.HOME = HOME;
delete process.env.SHELLTEAM_WORKSPACE_LOCK;

const gitRepo = (name) => {
  mkdirSync(join(HOME, name, ".git"), { recursive: true });
};
const plainDir = (name) => {
  mkdirSync(join(HOME, name), { recursive: true });
};

// A git repo (would have shown before), a PLAIN folder (the bug), a dot-dir and
// a dependency cache (must stay hidden), plus a ~/projects child.
gitRepo("webapp");
plainDir("sidecar");
plainDir("toolkit");
mkdirSync(join(HOME, ".cache"), { recursive: true });
mkdirSync(join(HOME, "node_modules"), { recursive: true });
mkdirSync(join(HOME, "projects", "sub"), { recursive: true });
writeFileSync(join(HOME, "notes.txt"), "a file, not a folder");

const { listWorkspaces } = await import("../lib/workspaces.mjs");

test("SHE-86: a plain (non-git) home folder appears in the workspace list", () => {
  const labels = listWorkspaces().map((w) => w.label);
  assert.ok(labels.includes("~/sidecar"), `~/sidecar missing from ${JSON.stringify(labels)}`);
  // The folders that already worked still do.
  assert.ok(labels.includes("~/webapp"));
  assert.ok(labels.includes("~/toolkit"));
  assert.ok(labels.includes("~/projects/sub"));
  assert.equal(labels[0], "~", "home is always first");
});

test("SHE-86: dot-dirs, dependency caches and plain files stay out of the list", () => {
  const labels = listWorkspaces().map((w) => w.label);
  assert.ok(!labels.includes("~/.cache"), "dot-dirs excluded");
  assert.ok(!labels.includes("~/node_modules"), "node_modules excluded");
  assert.ok(!labels.some((l) => l.endsWith("notes.txt")), "files excluded");
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
