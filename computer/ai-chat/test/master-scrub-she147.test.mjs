// SHE-147: agents never inherit the master token, and box credentials are
// masked in what the cockpit shows. Runs in a child so the module captures a
// controlled environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the master is masked, then removed from the environment agents inherit", () => {
  const home = mkdtempSync(join(tmpdir(), "she147-"));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const m = await import(${JSON.stringify(new URL("../lib/secret-mask.mjs", import.meta.url).href)});
    m.scrubMasterToken();
    console.log(JSON.stringify({
      inherited: "OWNER_TOKEN" in process.env,
      shown: m.maskSecrets("tok=MASTER_abcdef123456 ai=AITOKEN_abcdef123 key=sk-ant-abcdef12345"),
    }));
  `], { env: { PATH: process.env.PATH, HOME: home, OWNER_TOKEN: "MASTER_abcdef123456",
               SHELLTEAM_AI_TOKEN: "AITOKEN_abcdef123", ANTHROPIC_API_KEY: "sk-ant-abcdef12345" } }).toString();
  const r = JSON.parse(out);
  assert.equal(r.inherited, false);
  assert.equal(r.shown, "tok=[secret OWNER_TOKEN] ai=[secret SHELLTEAM_AI_TOKEN] key=[secret ANTHROPIC_API_KEY]");
});
