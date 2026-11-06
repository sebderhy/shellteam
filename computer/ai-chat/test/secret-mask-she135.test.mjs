/**
 * SHE-135: a vault value that slips into a chat frame is shown as [secret NAME].
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "secret-mask-"));
const vault = join(dir, "secrets.json");
process.env.SHELLTEAM_SECRETS_FILE = vault;
const { maskSecrets, maskSocket } = await import("../lib/secret-mask.mjs");

const write = (secrets) => {
  writeFileSync(vault, JSON.stringify({ secrets, uses: [] }));
};

test("values are masked in raw text and inside JSON frames", () => {
  write({ STRIPE_KEY: { value: "sk_live_abcdef123456" }, QUOTED: { value: 'pa"ss\\word99' }, SHORT: { value: "abc" } });
  assert.equal(maskSecrets("STRIPE_KEY=sk_live_abcdef123456"), "STRIPE_KEY=[secret STRIPE_KEY]");
  const frame = JSON.stringify({ type: "tool_result", content: 'PW=pa"ss\\word99 abc' });
  assert.equal(JSON.parse(maskSecrets(frame)).content, "PW=[secret QUOTED] abc");
});

test("a socket's frames go through the mask, and a rotation is picked up", async () => {
  write({ K: { value: "first_value_123" } });
  const sent = [];
  const ws = maskSocket({ send: (d) => sent.push(d) });
  ws.send("x first_value_123");
  await new Promise((r) => setTimeout(r, 20)); // new mtime
  write({ K: { value: "second_value_456" } });
  ws.send("x second_value_456 first_value_123");
  assert.deepEqual(sent, ["x [secret K]", "x [secret K] first_value_123"]);
});

test("no vault means nothing to mask", () => {
  process.env.SHELLTEAM_SECRETS_FILE = join(dir, "missing.json");
  assert.equal(maskSecrets("hello"), "hello");
  process.env.SHELLTEAM_SECRETS_FILE = vault;
});
