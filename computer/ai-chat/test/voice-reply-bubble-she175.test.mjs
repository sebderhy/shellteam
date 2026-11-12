// SHE-175: "When I activate it, I'd like ST to reply just with an audio voice
// message, somehow like in WhatsApp." The spoken reply is a player bubble; the
// written text is folded behind "Show text" and returns if audio fails.
// Runs the real speakReply from chat.js against a minimal DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const chat = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/chat.js"), "utf8");
const m = chat.match(/    async speakReply\(container, markdown\) \{[\s\S]*?\n    \},\n/);
assert.ok(m, "chat.js must define speakReply");

function el(tag) {
  const classes = new Set();
  return {
    tag, children: [], attrs: {}, textContent: "", className: "",
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...kids) { this.children.push(...kids); },
    appendChild(k) { this.children.push(k); },
    insertBefore(k) { this.children.unshift(k); },
    remove() { this.removed = true; },
    replaceWith(other) { this.replacedBy = other; },
  };
}

function run(response) {
  const container = el("div");
  const played = [];
  const env = {
    document: { createElement: el },
    fetch: async () => response,
    URL: { createObjectURL: () => "blob:x" },
    Audio: function (src) { this.src = src; this.play = () => { played.push(src); return Promise.resolve(); }; this.pause = () => {}; },
    scrollToBottom: () => {},
    console: { warn() {}, error() {} },
  };
  const speakReply = new Function(...Object.keys(env), `return ({ stopSpeaking() {}, ${m[0]} }).speakReply;`)(...Object.values(env));
  const self = { stopSpeaking() {}, currentAudio: null };
  return speakReply.call(self, container, "Hello there").then(() => ({ container, played, player: container.children[0] }));
}

const ok = (status, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k] ?? null }, blob: async () => ({}), json: async () => ({ error: "No voice key" }) });

test("a spoken reply is a voice message: text folded, player playing, one click shows the text", async () => {
  const { container, played, player } = await run(ok(200));
  assert.ok(container.classList.contains("voice-folded"));
  assert.deepEqual(played, ["blob:x"]);
  const toggle = player.children.find((c) => c.className === "reply-audio-text");
  assert.equal(toggle.textContent, "Show text");
  toggle.onclick();
  assert.ok(!container.classList.contains("voice-folded"));
  assert.equal(toggle.textContent, "Hide text");
});

test("when the audio cannot be made the text comes back by itself", async () => {
  const { container, player } = await run(ok(502));
  assert.ok(!container.classList.contains("voice-folded"));
  assert.ok(player.classList.contains("reply-audio-error"));
});

test("a reply with nothing to say out loud stays a written reply", async () => {
  const { container, player } = await run(ok(204));
  assert.ok(!container.classList.contains("voice-folded"));
  assert.ok(player.removed);
});
