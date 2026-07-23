/**
 * Integration tests for the file CRUD API endpoints in server.mjs.
 *
 * Spins up the server on a random port, then exercises every /_api/ route
 * through real HTTP requests. Uses a temp directory as HOME so tests are
 * isolated and leave no mess behind.
 *
 * Run:  node --test computer/ai-chat/test-file-api.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");

// --- Helpers ---

/** POST JSON to the server, with or without the nginx guard header. */
async function apiPost(port, path, body, { asNginx = true, rawBody, headers = {} } = {}) {
  const h = { ...headers };
  if (asNginx) h["X-Forwarded-By"] = "nginx";
  if (rawBody) {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: h,
      body: rawBody,
    });
    return { status: resp.status, data: await resp.json() };
  }
  h["Content-Type"] = "application/json";
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json() };
}

describe("File API", () => {
  let server;
  let port;
  let tempHome;

  before(async () => {
    // Create an isolated temp HOME directory
    tempHome = mkdtempSync(join(tmpdir(), "file-api-test-"));
    // Server needs a public dir for static files
    mkdirSync(join(tempHome, ".config", "shellteam"), { recursive: true });

    // Pick a random high port
    port = 30000 + Math.floor(Math.random() * 10000);

    server = spawn("node", [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        HOME: tempHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for server to start listening
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server start timeout")), 10000);
      server.stderr.on("data", (d) => {
        // server logs to stderr via console.error/warn
      });
      server.stdout.on("data", () => {});
      server.on("error", reject);

      // Poll until server accepts connections
      const poll = setInterval(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}/health-check-noop`);
          // Even a 404 means the server is up
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        } catch {
          // Not ready yet
        }
      }, 100);
    });
  });

  after(() => {
    if (server) server.kill("SIGTERM");
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  // --- safePath / security ---

  describe("security", () => {
    it("rejects requests without X-Forwarded-By header", async () => {
      const { status, data } = await apiPost(port, "/_api/write", { path: "x.txt", content: "hi" }, { asNginx: false });
      assert.equal(status, 403);
      assert.equal(data.error, "Direct access forbidden");
    });

    it("rejects path traversal with ..", async () => {
      const { status, data } = await apiPost(port, "/_api/write", { path: "../../etc/passwd", content: "pwned" });
      assert.equal(status, 400);
      assert.equal(data.error, "Invalid path");
    });

    it("treats leading-slash paths as relative to HOME (not absolute)", async () => {
      // "/etc/shadow" becomes HOME/etc/shadow — safe, just an odd filename
      const { status } = await apiPost(port, "/_api/write", { path: "/etc/shadow", content: "relative" });
      assert.equal(status, 200);
      assert.equal(readFileSync(join(tempHome, "etc/shadow"), "utf8"), "relative");
      // clean up
      rmSync(join(tempHome, "etc"), { recursive: true });
    });

    it("rejects null bytes in path", async () => {
      const { status, data } = await apiPost(port, "/_api/write", { path: "foo\0bar.txt", content: "x" });
      assert.equal(status, 400);
      assert.equal(data.error, "Invalid path");
    });

    it("rejects empty path", async () => {
      const { status, data } = await apiPost(port, "/_api/write", { path: "", content: "x" });
      assert.equal(status, 400);
      assert.equal(data.error, "Invalid path");
    });
  });

  // --- Write ---

  describe("/_api/write", () => {
    it("creates a new file", async () => {
      const { status, data } = await apiPost(port, "/_api/write", { path: "hello.txt", content: "world" });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(readFileSync(join(tempHome, "hello.txt"), "utf8"), "world");
    });

    it("overwrites an existing file", async () => {
      writeFileSync(join(tempHome, "overwrite.txt"), "old");
      const { status } = await apiPost(port, "/_api/write", { path: "overwrite.txt", content: "new" });
      assert.equal(status, 200);
      assert.equal(readFileSync(join(tempHome, "overwrite.txt"), "utf8"), "new");
    });

    it("creates parent directories automatically", async () => {
      const { status } = await apiPost(port, "/_api/write", { path: "deep/nested/dir/file.txt", content: "deep" });
      assert.equal(status, 200);
      assert.equal(readFileSync(join(tempHome, "deep/nested/dir/file.txt"), "utf8"), "deep");
    });
  });

  // --- Upload (binary) ---

  describe("/_api/upload", () => {
    it("uploads a binary file", async () => {
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header
      const { status, data } = await apiPost(port, "/_api/upload", null, {
        rawBody: binaryContent,
        headers: { "X-File-Path": "image.png" },
      });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const saved = readFileSync(join(tempHome, "image.png"));
      assert.deepEqual(saved, binaryContent);
    });

    it("rejects upload with invalid path", async () => {
      const { status, data } = await apiPost(port, "/_api/upload", null, {
        rawBody: Buffer.from("x"),
        headers: { "X-File-Path": "../../etc/evil" },
      });
      assert.equal(status, 400);
      assert.equal(data.error, "Invalid path");
    });
  });

  // --- Mkdir ---

  describe("/_api/mkdir", () => {
    it("creates a directory", async () => {
      const { status, data } = await apiPost(port, "/_api/mkdir", { path: "newdir" });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(existsSync(join(tempHome, "newdir")));
    });

    it("creates nested directories", async () => {
      const { status } = await apiPost(port, "/_api/mkdir", { path: "a/b/c" });
      assert.equal(status, 200);
      assert.ok(existsSync(join(tempHome, "a/b/c")));
    });
  });

  // --- Delete ---

  describe("/_api/delete", () => {
    it("deletes a file", async () => {
      writeFileSync(join(tempHome, "to-delete.txt"), "bye");
      const { status, data } = await apiPost(port, "/_api/delete", { path: "to-delete.txt" });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(!existsSync(join(tempHome, "to-delete.txt")));
    });

    it("deletes a directory recursively", async () => {
      mkdirSync(join(tempHome, "del-dir/sub"), { recursive: true });
      writeFileSync(join(tempHome, "del-dir/sub/f.txt"), "x");
      const { status } = await apiPost(port, "/_api/delete", { path: "del-dir" });
      assert.equal(status, 200);
      assert.ok(!existsSync(join(tempHome, "del-dir")));
    });

    it("returns 404 for non-existent path", async () => {
      const { status, data } = await apiPost(port, "/_api/delete", { path: "nonexistent.txt" });
      assert.equal(status, 404);
      assert.equal(data.error, "Not found");
    });
  });

  // --- Rename ---

  describe("/_api/rename", () => {
    it("renames a file", async () => {
      writeFileSync(join(tempHome, "old-name.txt"), "content");
      const { status, data } = await apiPost(port, "/_api/rename", { oldPath: "old-name.txt", newPath: "new-name.txt" });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(!existsSync(join(tempHome, "old-name.txt")));
      assert.equal(readFileSync(join(tempHome, "new-name.txt"), "utf8"), "content");
    });

    it("moves a file to a new directory", async () => {
      writeFileSync(join(tempHome, "moveme.txt"), "move");
      const { status } = await apiPost(port, "/_api/rename", { oldPath: "moveme.txt", newPath: "subdir/moved.txt" });
      assert.equal(status, 200);
      assert.ok(existsSync(join(tempHome, "subdir/moved.txt")));
    });

    it("returns 404 for non-existent source", async () => {
      const { status, data } = await apiPost(port, "/_api/rename", { oldPath: "ghost.txt", newPath: "new.txt" });
      assert.equal(status, 404);
      assert.equal(data.error, "Not found");
    });

    it("rejects traversal in newPath", async () => {
      writeFileSync(join(tempHome, "safe.txt"), "x");
      const { status, data } = await apiPost(port, "/_api/rename", { oldPath: "safe.txt", newPath: "../../etc/evil" });
      assert.equal(status, 400);
      assert.equal(data.error, "Invalid path");
    });
  });

  // --- Unknown route ---

  describe("unknown routes", () => {
    it("returns 404 for unknown API path", async () => {
      const { status, data } = await apiPost(port, "/_api/unknown", {});
      assert.equal(status, 404);
      assert.equal(data.error, "Unknown API route");
    });

    it("returns 405 for GET on API route", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/_api/write`, {
        headers: { "X-Forwarded-By": "nginx" },
      });
      assert.equal(resp.status, 405);
    });
  });
});
