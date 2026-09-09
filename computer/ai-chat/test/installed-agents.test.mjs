import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, installedAgents } from "../lib/agents/registry.mjs";

// Regression: the setup screen advertised all four agent families even on boxes
// that only ship some of the CLIs (the employee container has claude + codex
// only), giving guests a dead "Connecting…" tab. The status payload now carries
// installedAgents — a PATH probe per family — and the UI hides absent families.
test("installedAgents reports exactly the families whose CLI is on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "st-agents-"));
  const savedPath = process.env.PATH;
  try {
    for (const cmd of ["claude", "codex"]) {
      const bin = join(dir, cmd);
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
    }
    process.env.PATH = dir;
    assert.deepEqual(installedAgents(), {
      claude: true,
      codex: true,
      antigravity: false,
      opencode: false,
    });
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installedAgents covers every registry family", () => {
  assert.deepEqual(Object.keys(installedAgents()).sort(), AGENTS.map((a) => a.id).sort());
});
