/**
 * Tests for tool spinner lifecycle.
 *
 * Verifies that the spinning indicator on tool blocks is properly removed
 * when: (a) a tool_result arrives, and (b) the agent finishes (result message).
 *
 * Run:  node --test computer/ai-chat/test-tool-spinner.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Minimal DOM mock ---
// Just enough to exercise Chat's spinner-related logic without a browser.

function createElement(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _parent: null,
    className: "",
    id: "",
    dataset: {},
    style: {},
    textContent: "",
    innerHTML: "",
    onclick: null,

    appendChild(child) {
      this._children.push(child);
      child._parent = this;
      return child;
    },
    insertBefore(child, ref) {
      const idx = this._children.indexOf(ref);
      if (idx >= 0) this._children.splice(idx, 0, child);
      else this._children.push(child);
      child._parent = this;
      return child;
    },
    remove() {
      if (this._parent) {
        this._parent._children = this._parent._children.filter(c => c !== this);
        this._parent = null;
      }
    },
    querySelector(sel) { return queryOne(this, sel); },
    querySelectorAll(sel) { return queryAll(this, sel); },
    classList: (() => {
      const set = new Set();
      return {
        add(c) { set.add(c); },
        remove(c) { set.delete(c); },
        toggle(c) { set.has(c) ? set.delete(c) : set.add(c); },
        contains(c) { return set.has(c); },
      };
    })(),
    get children() { return this._children; },
    get parentElement() { return this._parent; },
    get nextSibling() {
      if (!this._parent) return null;
      const idx = this._parent._children.indexOf(this);
      return this._parent._children[idx + 1] || null;
    },
  };
  return el;
}

function matchesSelector(el, sel) {
  // Supports: .class, [data-x="v"], .class[data-x="v"], tag.class
  if (sel.startsWith(".")) {
    const m = sel.match(/^\.([a-zA-Z0-9_-]+)(\[.+\])?$/);
    if (!m) return false;
    const cls = m[1];
    const hasClass = el.className.split(/\s+/).includes(cls);
    if (!hasClass) return false;
    if (m[2]) return matchAttr(el, m[2]);
    return true;
  }
  if (sel.startsWith("[")) return matchAttr(el, sel);
  return false;
}

function matchAttr(el, attrSel) {
  const m = attrSel.match(/\[data-([a-z-]+)="([^"]+)"\]/);
  if (!m) return false;
  const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return el.dataset[key] === m[2];
}

function queryAll(root, sel) {
  const results = [];
  function walk(node) {
    if (matchesSelector(node, sel)) results.push(node);
    for (const child of (node._children || [])) walk(child);
  }
  walk(root);
  return results;
}

function queryOne(root, sel) { return queryAll(root, sel)[0] || null; }

// --- Build a Chat instance with mocked globals ---

function buildChat() {
  const messages = createElement("div");
  messages.id = "messages";

  const globals = {
    App: {
      el: { messages },
      state: { isReplayingHistory: false, totalCost: 0 },
    },
    setGenerating: () => {},
    setStatus: () => {},
    scrollToBottom: () => {},
    escHtml: (s) => s,
    truncate: (s, n) => (s.length > n ? s.slice(0, n) : s),
    marked: { parse: (s) => s },
    PlanMode: { enter() {}, renderCard() {} },
  };

  // Re-implement Chat methods exactly as in chat.js so we test real logic.
  // (We can't import browser JS in Node, so we replicate the module.)
  const Chat = {
    currentAssistantEl: null,
    currentTextEl: null,
    streamingText: "",
    currentToolBlocks: new Map(),
    toolInputBuffers: new Map(),
    blockIndexToToolId: new Map(),
    nextBlockIndex: 0,
    taskToolBlocks: new Map(),

    clearMessages() {
      messages._children = [];
      this.currentAssistantEl = null;
      this.currentTextEl = null;
      this.streamingText = "";
      this.currentToolBlocks.clear();
      this.toolInputBuffers.clear();
      this.blockIndexToToolId.clear();
      this.nextBlockIndex = 0;
      this.taskToolBlocks.clear();
    },

    ensureAssistantEl() {
      if (!this.currentAssistantEl) {
        this.currentAssistantEl = createElement("div");
        this.currentAssistantEl.className = "msg-assistant";
        messages.appendChild(this.currentAssistantEl);
        this.blockIndexToToolId.clear();
        this.nextBlockIndex = 0;
      }
    },

    ensureTextEl() {
      this.ensureAssistantEl();
      if (!this.currentTextEl) {
        this.currentTextEl = createElement("div");
        this.currentTextEl.className = "content";
        this.currentAssistantEl.appendChild(this.currentTextEl);
      }
    },

    finalizeStreaming() {
      if (this.currentTextEl && this.streamingText) {
        this.currentTextEl.innerHTML = globals.marked.parse(this.streamingText);
      }
      this.streamingText = "";
      this.currentTextEl = null;
    },

    commitAssistantEl() {
      this.currentAssistantEl = null;
      this.currentTextEl = null;
      this.streamingText = "";
      this.currentToolBlocks.clear();
      this.toolInputBuffers.clear();
      globals.scrollToBottom();
    },

    createToolBlock(id, name) {
      this.ensureAssistantEl();
      this.blockIndexToToolId.set(this.nextBlockIndex++, id);

      const block = createElement("div");
      block.className = "tool-block";
      block.dataset.toolId = id;

      const header = createElement("div");
      header.className = "tool-header";
      // Build child elements like the real code
      const chevron = createElement("span");
      chevron.className = "tool-chevron";
      const nameEl = createElement("span");
      nameEl.className = "tool-name";
      nameEl.textContent = name;
      const preview = createElement("span");
      preview.className = "tool-preview";
      preview.dataset.toolPreview = "";
      const spinner = createElement("span");
      spinner.className = "tool-spinner";

      header.appendChild(chevron);
      header.appendChild(nameEl);
      header.appendChild(preview);
      header.appendChild(spinner);

      const detail = createElement("div");
      detail.className = "tool-detail";
      const inputDiv = createElement("div");
      inputDiv.className = "tool-input";
      detail.appendChild(inputDiv);

      block.appendChild(header);
      block.appendChild(detail);
      this.currentAssistantEl.appendChild(block);
      this.currentToolBlocks.set(id, block);

      if (name === "Task") {
        this.taskToolBlocks.set(id, { el: block, turns: 0 });
      }

      globals.scrollToBottom();
    },

    attachToolResult(block) {
      let toolEl = this.currentToolBlocks.get(block.tool_use_id);
      if (!toolEl) toolEl = messages.querySelector(`.tool-block[data-tool-id="${block.tool_use_id}"]`);
      if (!toolEl) return;
      const spinner = toolEl.querySelector(".tool-spinner");
      if (spinner) spinner.remove();
      const detail = toolEl.querySelector(".tool-detail");
      if (!detail) return;
      let outputText = "";
      if (typeof block.content === "string") {
        outputText = block.content;
      } else if (Array.isArray(block.content)) {
        outputText = block.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      }
      if (outputText) {
        const outputEl = createElement("div");
        outputEl.className = "tool-output" + (block.is_error ? " error" : "");
        outputEl.textContent = globals.truncate(outputText, 2000);
        detail.appendChild(outputEl);
      }
    },

    handleStreamEvent(msg) {
      const event = msg.event;
      if (!event) return;
      globals.setGenerating(true);
      switch (event.type) {
        case "message_start":
          this.finalizeStreaming();
          this.ensureAssistantEl();
          this.streamingText = "";
          this.currentTextEl = null;
          break;
        case "content_block_start":
          if (event.content_block?.type === "text") {
            this.streamingText = "";
            this.ensureTextEl();
          } else if (event.content_block?.type === "tool_use") {
            const b = event.content_block;
            this.toolInputBuffers.set(b.id, "");
            this.createToolBlock(b.id, b.name);
          }
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            this.streamingText += event.delta.text;
          }
          break;
        case "content_block_stop":
          this.currentTextEl = null;
          this.streamingText = "";
          break;
      }
    },

    handleAssistantMessage(msg) {
      if (!msg.message || !msg.message.content) return;
      this.finalizeStreaming();
      if (this.currentAssistantEl && this.currentAssistantEl.children.length > 0) {
        this.commitAssistantEl();
        return;
      }
      this.ensureAssistantEl();
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          const div = createElement("div");
          div.className = "content";
          div.innerHTML = globals.marked.parse(block.text);
          this.currentAssistantEl.appendChild(div);
        } else if (block.type === "tool_use") {
          this.createToolBlock(block.id, block.name);
        }
      }
      this.commitAssistantEl();
    },

    handleUserToolResult(msg) {
      if (!msg.message?.content) return;
      const content = Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content];
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          this.attachToolResult(block);
        }
      }
    },

    handleResult(msg) {
      globals.setGenerating(false);
      if (msg.total_cost_usd !== undefined) globals.App.state.totalCost = msg.total_cost_usd;
      this.finalizeStreaming();
      this.commitAssistantEl();
      // Safety net: remove any lingering tool spinners
      for (const s of queryAll(messages, ".tool-spinner")) s.remove();
      globals.setStatus("idle", "Idle");
    },

    updateSubagentProgress(msg) {
      const parentId = msg.parent_tool_use_id;
      const tracked = this.taskToolBlocks.get(parentId);
      if (!tracked) return;
      if (msg.type === "assistant" || msg.type === "stream_event") {
        if (msg.type === "assistant" || msg.event?.type === "message_start") {
          tracked.turns++;
        }
      }
      const previewEl = tracked.el.querySelector("[data-tool-preview]");
      if (previewEl) {
        previewEl.textContent = `Agent working... step ${tracked.turns}`;
      }
      if (msg.type === "result") {
        const spinner = tracked.el.querySelector(".tool-spinner");
        if (spinner) spinner.remove();
        if (previewEl) {
          previewEl.textContent = `Agent done (${tracked.turns} steps)`;
        }
      }
    },
  };

  return { Chat, messages, globals };
}

// --- Helper: count spinners in the messages container ---
function countSpinners(messages) {
  return queryAll(messages, ".tool-spinner").length;
}

// =============================================================================
// Tests
// =============================================================================

describe("Tool spinner lifecycle", () => {
  let Chat, messages;

  beforeEach(() => {
    ({ Chat, messages } = buildChat());
  });

  describe("attachToolResult removes spinner", () => {
    it("removes spinner from a tool block when tool_result arrives", () => {
      // Create a tool block with spinner
      Chat.ensureAssistantEl();
      Chat.createToolBlock("tool-1", "Bash");
      assert.equal(countSpinners(messages), 1, "spinner should exist after createToolBlock");

      // Simulate tool result
      Chat.attachToolResult({
        tool_use_id: "tool-1",
        content: "hello world",
      });

      assert.equal(countSpinners(messages), 0, "spinner should be removed after attachToolResult");
    });

    it("finds tool block via DOM query after commitAssistantEl clears the map", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("tool-2", "Read");
      Chat.commitAssistantEl(); // clears currentToolBlocks

      assert.equal(countSpinners(messages), 1, "spinner still in DOM after commit");

      Chat.attachToolResult({
        tool_use_id: "tool-2",
        content: "file contents",
      });

      assert.equal(countSpinners(messages), 0, "spinner removed via DOM fallback query");
    });
  });

  describe("handleResult cleans up lingering spinners", () => {
    it("removes all remaining spinners when result arrives", () => {
      // Simulate: tool blocks created, but tool_result never arrived
      Chat.ensureAssistantEl();
      Chat.createToolBlock("tool-a", "Bash");
      Chat.createToolBlock("tool-b", "Read");
      Chat.commitAssistantEl();

      assert.equal(countSpinners(messages), 2, "two spinners present before result");

      // Agent finishes — result arrives without tool_results
      Chat.handleResult({ type: "result", subtype: "success" });

      assert.equal(countSpinners(messages), 0,
        "BUG: spinners should be removed when agent finishes (result message)");
    });

    it("handles case where some tool_results arrived but one didn't", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("tool-x", "Bash");
      Chat.createToolBlock("tool-y", "Read");
      Chat.commitAssistantEl();

      // Only tool-x gets a result
      Chat.attachToolResult({ tool_use_id: "tool-x", content: "ok" });
      assert.equal(countSpinners(messages), 1, "one spinner remains");

      Chat.handleResult({ type: "result", subtype: "success" });
      assert.equal(countSpinners(messages), 0, "remaining spinner cleaned up by handleResult");
    });
  });

  describe("streaming flow → tool_result → no lingering spinners", () => {
    it("full Claude streaming flow: stream tool → tool_result → clean", () => {
      // Stream: message_start
      Chat.handleStreamEvent({ event: { type: "message_start" } });

      // Stream: text block
      Chat.handleStreamEvent({ event: { type: "content_block_start", content_block: { type: "text" } } });
      Chat.handleStreamEvent({ event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me run that." } } });
      Chat.handleStreamEvent({ event: { type: "content_block_stop", index: 0 } });

      // Stream: tool_use block
      Chat.handleStreamEvent({
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-s1", name: "Bash" },
        },
      });
      Chat.handleStreamEvent({ event: { type: "content_block_stop", index: 1 } });

      assert.equal(countSpinners(messages), 1, "spinner present during tool execution");

      // Complete assistant message (dedup — early return path)
      Chat.handleAssistantMessage({
        message: {
          content: [
            { type: "text", text: "Let me run that." },
            { type: "tool_use", id: "tool-s1", name: "Bash", input: { command: "ls" } },
          ],
        },
      });

      // Tool result arrives
      Chat.handleUserToolResult({
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-s1", content: "file.txt" }],
        },
      });

      assert.equal(countSpinners(messages), 0, "spinner removed after tool_result");
    });

    it("Codex flow: assistant message with tool_use → tool_result → clean", () => {
      // Codex: assistant message creates tool block directly (no streaming)
      Chat.handleAssistantMessage({
        message: {
          content: [{ type: "tool_use", id: "cdx-1", name: "Bash", input: { command: "echo hi" } }],
        },
      });

      assert.equal(countSpinners(messages), 1, "spinner present from assistant message");

      Chat.handleUserToolResult({
        message: {
          content: [{ type: "tool_result", tool_use_id: "cdx-1", content: "hi" }],
        },
      });

      assert.equal(countSpinners(messages), 0, "spinner removed after tool_result");
    });
  });

  describe("subagent (Task) tool spinner", () => {
    it("removes Task spinner when subagent result arrives", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("task-1", "Task");
      Chat.commitAssistantEl();

      assert.equal(countSpinners(messages), 1);

      // Subagent result
      Chat.updateSubagentProgress({
        parent_tool_use_id: "task-1",
        type: "result",
      });

      assert.equal(countSpinners(messages), 0, "Task spinner removed on subagent result");
    });

    it("handleResult cleans up Task spinner if subagent result was missed", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("task-2", "Task");
      Chat.commitAssistantEl();

      assert.equal(countSpinners(messages), 1);

      // No subagent result — agent finishes directly
      Chat.handleResult({ type: "result", subtype: "success" });

      assert.equal(countSpinners(messages), 0,
        "BUG: Task spinner should be cleaned up when agent finishes");
    });
  });

  describe("multiple tools in one turn", () => {
    it("all spinners removed after individual tool_results", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("m1", "Bash");
      Chat.createToolBlock("m2", "Read");
      Chat.createToolBlock("m3", "Grep");
      Chat.commitAssistantEl();

      assert.equal(countSpinners(messages), 3);

      Chat.attachToolResult({ tool_use_id: "m1", content: "ok" });
      assert.equal(countSpinners(messages), 2);

      Chat.attachToolResult({ tool_use_id: "m2", content: "ok" });
      assert.equal(countSpinners(messages), 1);

      Chat.attachToolResult({ tool_use_id: "m3", content: "ok" });
      assert.equal(countSpinners(messages), 0);
    });

    it("handleResult cleans up any stragglers", () => {
      Chat.ensureAssistantEl();
      Chat.createToolBlock("m1", "Bash");
      Chat.createToolBlock("m2", "Read");
      Chat.createToolBlock("m3", "Grep");
      Chat.commitAssistantEl();

      // Only one tool_result arrives
      Chat.attachToolResult({ tool_use_id: "m1", content: "ok" });
      assert.equal(countSpinners(messages), 2);

      Chat.handleResult({ type: "result", subtype: "success" });
      assert.equal(countSpinners(messages), 0, "all straggler spinners cleaned up");
    });
  });
});
