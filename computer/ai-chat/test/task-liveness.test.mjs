// hasWriter(): the idle reaper's liveness test for background Bash tasks
// (SHE-93). A running task's shell holds its output file open for writing;
// a finished one does not — and a reader never counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, openSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasWriter } from "../lib/task-liveness.mjs";

const dir = mkdtempSync(join(tmpdir(), "st-liveness-"));

test("a process holding the file open for writing is a writer; it stops being one when it exits", async () => {
  const file = join(dir, "running.output");
  const fd = openSync(file, "a");
  const child = spawn("sleep", ["30"], { stdio: ["ignore", fd, fd] });
  closeSync(fd); // only the child holds it now, like the harness's shell
  await once(child, "spawn");
  assert.equal(hasWriter(file), true, "a live task must count as a writer even though it prints nothing");
  child.kill("SIGKILL");
  await once(child, "close");
  assert.equal(hasWriter(file), false, "once the shell exits nobody writes the file");
});

test("a file nobody holds, and a missing file, have no writer", () => {
  const file = join(dir, "finished.output");
  writeFileSync(file, "[exited with code 0]\n");
  assert.equal(hasWriter(file), false);
  assert.equal(hasWriter(join(dir, "never-existed.output")), false);
});

test("a reader is not a writer", () => {
  const file = join(dir, "read-only.output");
  writeFileSync(file, "x");
  const fd = openSync(file, "r");
  try { assert.equal(hasWriter(file), false); }
  finally { closeSync(fd); }
});
