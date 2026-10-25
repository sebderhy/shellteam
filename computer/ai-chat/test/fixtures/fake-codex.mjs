// Puts a fake `codex` (fake-codex-app-server.mjs) first on PATH for one test.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url));

/** { dir, env, records(), cleanup() } — env holds PATH plus the FAKE_CODEX_* knobs. */
export function fakeCodex(knobs = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const logFile = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${SERVER}" "$@"\n`);
  chmodSync(join(dir, "codex"), 0o755);
  const env = {
    PATH: `${dir}:${process.env.PATH}`, HOME: dir, CODEX_HOME: join(dir, "codex-home"),
    FAKE_CODEX_LOG: logFile,
    ...Object.fromEntries(Object.entries(knobs).map(([k, v]) => [`FAKE_CODEX_${k}`, String(v)])),
  };
  return {
    dir,
    env,
    // Every argv and request the fake codex processes received, in order.
    records: () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
