import { test } from "node:test";
import assert from "node:assert/strict";

import { internalCallerAuthorized, INTERNAL_AUTH_HEADER } from "../lib/internal-auth.mjs";

// The cockpit's /internal/* endpoints can START AN AGENT from a caller-supplied
// prompt (mirror kickoff). They were reachable by any website the owner visited:
// a cross-origin fetch with Content-Type: text/plain is a CORS-safelisted simple
// request, so it is sent with no preflight, and the attacker never needs to read
// the opaque response for the side effect to land. "Loopback only" is not a
// boundary — the attacking browser runs ON the box, so its socket is 127.0.0.1.

const req = (headers) => ({ headers });

function withToken(token, fn) {
  const prev = process.env.SHELLTEAM_AI_TOKEN;
  process.env.SHELLTEAM_AI_TOKEN = token;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SHELLTEAM_AI_TOKEN;
    else process.env.SHELLTEAM_AI_TOKEN = prev;
  }
}

test("a real in-box caller presenting the secret is authorized", () => {
  withToken("s3cr3t", () => {
    assert.equal(internalCallerAuthorized(req({ [INTERNAL_AUTH_HEADER]: "s3cr3t" })), true);
  });
});

test("no secret header — the CSRF shape — is refused", () => {
  withToken("s3cr3t", () => {
    // Exactly what a cross-origin fetch(..., {mode:'no-cors'}) sends.
    assert.equal(
      internalCallerAuthorized(req({ "content-type": "text/plain;charset=UTF-8" })),
      false,
    );
  });
});

test("a wrong secret is refused", () => {
  withToken("s3cr3t", () => {
    assert.equal(internalCallerAuthorized(req({ [INTERNAL_AUTH_HEADER]: "guess" })), false);
    // Length mismatch must be a plain false, never a timingSafeEqual throw.
    assert.equal(internalCallerAuthorized(req({ [INTERNAL_AUTH_HEADER]: "x" })), false);
  });
});

test("any request carrying an Origin is refused even with the right secret", () => {
  withToken("s3cr3t", () => {
    assert.equal(
      internalCallerAuthorized(
        req({ [INTERNAL_AUTH_HEADER]: "s3cr3t", origin: "https://evil.example" }),
      ),
      false,
    );
    // Including the box's own origin: in-box HTTP clients never send one, so a
    // present Origin always means "a browser sent this".
    assert.equal(
      internalCallerAuthorized(req({ [INTERNAL_AUTH_HEADER]: "s3cr3t", origin: "null" })),
      false,
    );
  });
});

test("fails CLOSED when the box has no internal secret configured", () => {
  withToken("", () => {
    assert.equal(internalCallerAuthorized(req({ [INTERNAL_AUTH_HEADER]: "" })), false);
    assert.equal(internalCallerAuthorized(req({})), false);
  });
});
