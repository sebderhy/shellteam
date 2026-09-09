import { test } from "node:test";
import assert from "node:assert/strict";

import { isKnownModel, resolveModelId, opencodeDefaultModel } from "../lib/model-catalog.mjs";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_ANTIGRAVITY_MODEL,
} from "../lib/constants.mjs";

// A model dropped from the catalog (renamed/removed) must not strand a saved
// tab on a dead pin the picker can't select — it resolves to the family default.
// Regression for the Opus 4.8 -> Opus 5 catalog swap.

test("orphaned Claude model resolves to the Claude default", () => {
  assert.equal(isKnownModel("claude-opus-4-8"), false);
  assert.equal(resolveModelId("claude-opus-4-8"), DEFAULT_CLAUDE_MODEL);
});

test("known models pass through untouched (by id and by cli form)", () => {
  // catalog id
  assert.equal(resolveModelId("claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(resolveModelId("claude-sonnet-5"), "claude-sonnet-5");
  // the current default is itself a known model
  assert.equal(resolveModelId(DEFAULT_CLAUDE_MODEL), DEFAULT_CLAUDE_MODEL);
  // cli-form id (catalog id is gpt-5.6-sol-max) is still a known model
  assert.equal(isKnownModel("gpt-5.6-sol"), true);
  assert.equal(resolveModelId("gpt-5.6-sol"), "gpt-5.6-sol");
});

test("orphans resolve within their own family, not always Claude", () => {
  // A removed Codex model routes by the gpt- prefix -> Codex default.
  assert.equal(isKnownModel("gpt-5.5"), false);
  assert.equal(resolveModelId("gpt-5.5"), DEFAULT_CODEX_MODEL);
  // A removed Antigravity model routes by the gemini- prefix -> Antigravity default.
  assert.equal(isKnownModel("gemini-2.5-pro"), false);
  assert.equal(resolveModelId("gemini-2.5-pro"), DEFAULT_ANTIGRAVITY_MODEL);
  // OpenCode has no DEFAULT_ constant — its default comes from the catalog, so
  // this is the family most likely to regress when a model is retired. Kimi K2.6,
  // GLM 5.1 and GLM 5.2 left when their successors (K3, 5.2, 5.3) shipped.
  for (const gone of ["kimi-k2p6", "glm-5p1", "glm-5p2"]) {
    assert.equal(isKnownModel(gone), false);
    assert.equal(resolveModelId(gone), opencodeDefaultModel());
  }
});

test("empty / falsy input is returned as-is", () => {
  assert.equal(resolveModelId(""), "");
  assert.equal(resolveModelId(null), null);
  assert.equal(resolveModelId(undefined), undefined);
});
