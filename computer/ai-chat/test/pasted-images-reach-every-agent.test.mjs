/**
 * "I tried uploading a screenshot and ShellTeam says it can't see it" (Seb,
 * office VDI, 2026-09-27, on Codex). Only Claude Code takes pasted images as
 * content blocks. The Codex, OpenCode and Antigravity adapters kept only the
 * text blocks, so the screenshot was silently dropped before the CLI ever ran.
 *
 * Now the image is saved to a file: Codex attaches it natively (--image), the
 * others get its path in the prompt and open it with their own file tools.
 * Verified live the same day: gpt-6-luna read "PURPLE ELEPHANT 7342" off a
 * pasted probe image; the pre-fix adapter answered without ever seeing it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

process.env.HOME = mkdtempSync(join(tmpdir(), "pasted-images-"));
const { splitContent, textWithImagePaths, ATTACHMENTS_DIR } = await import("../lib/attachments.mjs");
const { CodexAgent } = await import("../lib/codex-agent.mjs");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const content = [
  { type: "text", text: "what does this say?" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
];

test("a pasted image becomes an owner-only file next to the prompt text", () => {
  const { text, images } = splitContent(content);
  assert.equal(text, "what does this say?");
  assert.equal(images.length, 1);
  assert.ok(images[0].startsWith(ATTACHMENTS_DIR) && images[0].endsWith(".png"));
  assert.deepEqual(readFileSync(images[0]), PNG, "the exact bytes the user pasted");
  assert.equal(statSync(images[0]).mode & 0o777, 0o600);
});

test("a CLI with no image flag is told where the image is", () => {
  const prompt = textWithImagePaths(splitContent(content));
  assert.match(prompt, /^what does this say\?/);
  assert.match(prompt, /attached an image/);
  assert.match(prompt, new RegExp(ATTACHMENTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[0-9a-f-]+\\.png"));
  assert.equal(textWithImagePaths(splitContent("plain text")), "plain text", "no note without images");
});

test("Codex is spawned with the pasted image attached, and the prompt still goes over stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const log = join(dir, "args.json");
  const fake = join(dir, "codex");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
let stdin = ""; process.stdin.on("data", d => stdin += d);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
});
`);
  chmodSync(fake, 0o755);
  const agent = new CodexAgent({ model: "gpt-6-luna-max", cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  agent.start();
  const done = once(agent, "turn_done");
  agent.sendMessage(content);
  await done;
  const { argv, stdin } = JSON.parse(readFileSync(log, "utf8"));
  const image = argv.find((a) => a.startsWith("--image="));
  assert.ok(image, `codex must get --image, argv was: ${argv.join(" ")}`);
  assert.ok(existsSync(image.slice("--image=".length)), "the attached file exists");
  assert.equal(argv.at(-1), "-", "the `-` stdin sentinel stays last, not swallowed by --image");
  assert.equal(stdin, "what does this say?");
  agent.stop();
});
