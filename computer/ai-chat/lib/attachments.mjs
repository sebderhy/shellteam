// Images pasted into the composer arrive as Anthropic-style content blocks
// ({type:"image", source:{media_type, data}}). Claude Code takes those blocks
// as-is; every other CLI takes a prompt STRING, and their adapters used to keep
// only the text blocks, so a pasted screenshot silently never reached Codex,
// OpenCode or Antigravity ("it says it can't see my screenshot").
//
// Here the images become files the CLI can open: Codex attaches them natively
// (`--image`), the others get the paths in the prompt and read them with their
// own file tools.
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME } from "./constants.mjs";

export const ATTACHMENTS_DIR = join(HOME, ".shellteam", "attachments");
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function pruneOld(now = Date.now()) {
  for (const name of readdirSync(ATTACHMENTS_DIR)) {
    const path = join(ATTACHMENTS_DIR, name);
    if (now - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
  }
}

function saveImage(block) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  pruneOld();
  const ext = EXT[block.source.media_type] || "png";
  const path = join(ATTACHMENTS_DIR, `${randomUUID()}.${ext}`);
  writeFileSync(path, Buffer.from(block.source.data, "base64"), { mode: 0o600 });
  console.log(`[attachments] saved pasted image → ${path}`);
  return path;
}

/** Split composer content into the prompt text and saved image file paths. */
export function splitContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content), images: [] };
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const images = content.filter((b) => b.type === "image" && b.source?.data).map(saveImage);
  return { text, images };
}

/** Prompt text for a CLI with no image flag: point the agent at the files. */
export function textWithImagePaths({ text, images }) {
  if (!images.length) return text;
  const list = images.map((p) => `- ${p}`).join("\n");
  return `${text}\n\n[The user attached ${images.length === 1 ? "an image" : `${images.length} images`}. Open ${images.length === 1 ? "it" : "them"} with your file-reading tool to see ${images.length === 1 ? "it" : "them"}:\n${list}]`;
}
