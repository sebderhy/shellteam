import assert from "node:assert/strict";
import { test } from "node:test";
import { autoCompactLimitForModel, codexUsage } from "../lib/codex-agent.mjs";
import { contextLimitForId } from "../lib/model-catalog.mjs";

// A real Codex catalog entry (400k window). The proactive limit must sit well
// below the ceiling so compaction fires with headroom to spare.
test("Codex proactive auto-compact limit is a fraction of the model window", () => {
  assert.equal(contextLimitForId("gpt-5.6-sol-max"), 400_000);
  assert.equal(autoCompactLimitForModel("gpt-5.6-sol-max"), 320_000);
  assert.ok(
    autoCompactLimitForModel("gpt-5.6-sol-max") < contextLimitForId("gpt-5.6-sol-max"),
    "the limit must leave headroom below the hard window",
  );
});

// Unknown/uncatalogued models must still get a safe finite limit, never the
// undefined that would disable proactive compaction.
test("unknown models fall back to the standard window, still with headroom", () => {
  assert.equal(contextLimitForId("some-unlisted-model"), 200_000);
  assert.equal(autoCompactLimitForModel("some-unlisted-model"), 160_000);
});

test("long-context [1m] variants scale the limit to the 1M window", () => {
  assert.equal(contextLimitForId("codex-experimental [1m]"), 1_000_000);
  assert.equal(autoCompactLimitForModel("codex-experimental [1m]"), 800_000);
});

// A stale/cli-form model id (e.g. "gpt-5.6-sol" persisted in a saved tab, whose
// catalog id is "gpt-5.6-sol-max") must resolve to the real 400k window via the
// catalog `cli` value — not silently fall back to 200k, which would halve the
// context meter's denominator and compact at 160k instead of 320k.
test("cli-form model ids resolve to the real catalog window", () => {
  assert.equal(contextLimitForId("gpt-5.6-sol"), 400_000);
  assert.equal(autoCompactLimitForModel("gpt-5.6-sol"), 320_000);
});

// SHE-66: the context meter read "not reported by this agent yet" because
// Codex's turn.completed usage was dropped. codexUsage maps it to the meter's
// shape — forwarding input_tokens ALONE (it already includes the cached
// prefix, unlike Claude) so the meter doesn't double-count cached tokens.
test("codexUsage forwards input_tokens as the context occupancy", () => {
  const u = codexUsage({ input_tokens: 14394, cached_input_tokens: 9984, output_tokens: 5 });
  assert.deepEqual(u, { input_tokens: 14394 });
  // The meter sums input + cache_read + cache_creation; only input is set, so
  // the cached prefix (already inside input_tokens) is not counted twice.
  const meterTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  assert.equal(meterTokens, 14394);
});

test("codexUsage returns undefined when Codex reports no usage", () => {
  assert.equal(codexUsage(undefined), undefined);
  assert.equal(codexUsage({}), undefined);
  assert.equal(codexUsage({ output_tokens: 5 }), undefined);
});
