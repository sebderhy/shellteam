/**
 * OpenCode clamps every reply to 32000 tokens unless
 * OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX is set, whatever the model's
 * `limit.output` says (captured from a real `opencode run` request, 1.17.12).
 * GLM 5.3 and Kimi K3 reason at max, so a 32000 budget can be spent entirely on
 * thinking and the step ends with nothing done. The cockpit lifts the clamp to
 * the catalog's own limits whenever it hands OpenCode ShellTeam's config.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "opencode-output-max-"));
process.env.HOME = tempHome;
const layerDir = join(tempHome, ".shellteam", "agent-layer");
mkdirSync(layerDir, { recursive: true });
writeFileSync(join(layerDir, "opencode.json"), JSON.stringify({ provider: {} }));

const { getCliEnv } = await import("../lib/session.mjs");
const { opencodeAgent, opencodeOutputTokenMax } = await import("../lib/model-catalog.mjs");

after(() => rmSync(tempHome, { recursive: true, force: true }));

describe("OpenCode output budget", () => {
  it("is the largest catalog limit, above OpenCode's 32000 default", () => {
    const limits = opencodeAgent().models.map((m) => m.limit.output);
    assert.equal(opencodeOutputTokenMax(), Math.max(...limits));
    assert.ok(opencodeOutputTokenMax() > 32000);
  });

  it("reaches the OpenCode spawn env alongside ShellTeam's config", () => {
    const env = getCliEnv();
    assert.ok(env.OPENCODE_CONFIG);
    assert.equal(env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, String(opencodeOutputTokenMax()));
  });

  it("asks every catalog model for max reasoning", () => {
    for (const m of opencodeAgent().models) {
      assert.deepEqual(m.options, { reasoningEffort: "max" }, m.id);
    }
  });
});
