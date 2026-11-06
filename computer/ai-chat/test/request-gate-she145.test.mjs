// SHE-145: other websites must not drive the cockpit (shell, gateway, rebinding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { refuseCrossSite } from "../lib/request-gate.mjs";

process.env.APP_DOMAIN = "seb.example.com";
process.env.OWNER_USERNAME = "seb";
delete process.env.SHELLTEAM_USERNAME;

const req = (method, host, origin) => ({ method, headers: { host, ...(origin ? { origin } : {}) } });

test("a foreign website cannot open a socket or post", () => {
  assert.ok(refuseCrossSite(req("GET", "127.0.0.1:3456", "https://evil.example"), 3456, { upgrade: true }));
  assert.ok(refuseCrossSite(req("POST", "127.0.0.1:3456", "https://evil.example"), 3456));
  assert.ok(refuseCrossSite(req("POST", "127.0.0.1:3456", "null"), 3456)); // sandboxed report
  assert.ok(refuseCrossSite(req("POST", "127.0.0.1:3456", "https://seb-5173.seb.example.com"), 3456)); // an app
  assert.ok(refuseCrossSite(req("POST", "127.0.0.1:3456", "https://foo-3456.seb.example.com"), 3456)); // named route
  assert.ok(refuseCrossSite(req("POST", "localhost:3456", "http://localhost:5173"), 3456)); // dev server
});

test("a rebound name is refused even for reads", () => {
  assert.ok(refuseCrossSite(req("GET", "rebind.evil.example:3456"), 3456));
  assert.ok(refuseCrossSite(req("GET", "st-emp-acme:3456"), 3456));
});

test("the cockpit itself, the proxy and tools still work", () => {
  assert.equal(refuseCrossSite(req("GET", "127.0.0.1:3456", "https://seb-3456.seb.example.com"), 3456, { upgrade: true }), null);
  assert.equal(refuseCrossSite(req("POST", "127.0.0.1:41234", "https://seb-41234.seb.example.com"), 3456), null); // employee
  assert.equal(refuseCrossSite(req("GET", "localhost:3456", "http://localhost:3456"), 3456, { upgrade: true }), null);
  assert.equal(refuseCrossSite(req("POST", "100.94.1.2:3456", "http://100.94.1.2:3456"), 3456), null); // tailnet
  assert.equal(refuseCrossSite(req("POST", "127.0.0.1:3456"), 3456), null); // curl, httpx
  assert.equal(refuseCrossSite(req("GET", "127.0.0.1:3456", "https://evil.example"), 3456), null); // plain GET
});
