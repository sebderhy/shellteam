import { test } from "node:test";
import assert from "node:assert/strict";

import { browserProxyEnabled, proxyBrowserHttp } from "../lib/browser-proxy.mjs";

function fakeReq(url) {
  return { url, method: "GET", headers: {}, pipe() {} };
}
function fakeRes() {
  return { headersSent: false, writeHead() { this.headersSent = true; }, end() {} };
}

test("inert when STEEL_BROWSER_URL is unset (owner cockpit unaffected)", () => {
  delete process.env.STEEL_BROWSER_URL;
  assert.equal(browserProxyEnabled(), false);
  // Never claims a request — always falls through to the normal cockpit routes.
  assert.equal(proxyBrowserHttp(fakeReq("/ui"), fakeRes()), false);
  assert.equal(proxyBrowserHttp(fakeReq("/dashboard"), fakeRes()), false);
});

test("with a sidecar set, proxies only /ui and /v1, nothing else", () => {
  process.env.STEEL_BROWSER_URL = "http://sidecar.invalid:3000";
  try {
    assert.equal(browserProxyEnabled(), true);
    // Cockpit's own routes must NOT be hijacked.
    assert.equal(proxyBrowserHttp(fakeReq("/"), fakeRes()), false);
    assert.equal(proxyBrowserHttp(fakeReq("/ws"), fakeRes()), false);
    assert.equal(proxyBrowserHttp(fakeReq("/api/test-key"), fakeRes()), false);
    // The Steel viewer + its API are claimed (upstream error is handled async).
    assert.equal(proxyBrowserHttp(fakeReq("/ui"), fakeRes()), true);
    assert.equal(proxyBrowserHttp(fakeReq("/ui/assets/x.js"), fakeRes()), true);
    assert.equal(proxyBrowserHttp(fakeReq("/v1/sessions"), fakeRes()), true);
  } finally {
    delete process.env.STEEL_BROWSER_URL;
  }
});
