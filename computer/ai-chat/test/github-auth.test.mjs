import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDeviceFlow, getStatus, disconnect } from "../lib/github-auth.mjs";

// A fake `gh` on PATH — prints a canned device code for `auth login`, and
// reports auth state from FAKE_GH_USER / FAKE_GH_ENVTOKEN for `auth status`.
let fakeBin;
const realPath = process.env.PATH;

before(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(fakeBin, "gh"), `#!/bin/bash
case "$1 $2" in
  "auth login")
    echo "! First copy your one-time code: ABCD-1234"
    echo "Open this URL to continue in your web browser: https://github.com/login/device"
    sleep 5
    ;;
  "auth status")
    if [ -n "$FAKE_GH_MULTI" ]; then
      # Two accounts, real gh 2.x layout: an env token masking a stored login
      # (the SHE-74 shape). The ACTIVE one must be reported.
      echo "github.com"
      echo "  ✓ Logged in to github.com account owner-bot (GH_TOKEN)"
      echo "  - Active account: true"
      echo "  ✓ Logged in to github.com account octocat (/home/employee/.config/gh/hosts.yml)"
      echo "  - Active account: false"
      exit 0
    fi
    if [ -n "$FAKE_GH_USER" ]; then
      echo "github.com"
      if [ -n "$FAKE_GH_ENVTOKEN" ]; then
        echo "  ✓ Logged in to github.com account $FAKE_GH_USER (GH_TOKEN)"
      else
        echo "  ✓ Logged in to github.com account $FAKE_GH_USER (keyring)"
      fi
      echo "  - Active account: true"
      exit 0
    fi
    echo "You are not logged into any GitHub hosts." >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`);
  chmodSync(join(fakeBin, "gh"), 0o755);
  process.env.PATH = `${fakeBin}:${realPath}`;
});

after(async () => {
  await disconnect(); // reap the fake login left polling in the background
  process.env.PATH = realPath;
  rmSync(fakeBin, { recursive: true, force: true });
});

test("startDeviceFlow parses the one-time code and verification URL", async () => {
  const flow = await startDeviceFlow();
  assert.equal(flow.userCode, "ABCD-1234");
  assert.equal(flow.verificationUrl, "https://github.com/login/device");
});

test("getStatus reports signed-out, signed-in, and env-token states", async () => {
  delete process.env.FAKE_GH_USER;
  assert.equal((await getStatus()).authenticated, false);

  process.env.FAKE_GH_USER = "alice";
  let s = await getStatus();
  assert.deepEqual({ authenticated: s.authenticated, username: s.username, viaEnvToken: s.viaEnvToken },
    { authenticated: true, username: "alice", viaEnvToken: false });

  process.env.FAKE_GH_ENVTOKEN = "1";
  s = await getStatus();
  assert.equal(s.viaEnvToken, true);
  delete process.env.FAKE_GH_USER;
  delete process.env.FAKE_GH_ENVTOKEN;
});

test("getStatus reports the ACTIVE account when several are logged in", async () => {
  // SHE-74: an env token (owner-bot) masked the guest's stored login; the
  // card must show the identity gh actually uses, never just the first block.
  process.env.FAKE_GH_MULTI = "1";
  const s = await getStatus();
  assert.deepEqual({ authenticated: s.authenticated, username: s.username, viaEnvToken: s.viaEnvToken },
    { authenticated: true, username: "owner-bot", viaEnvToken: true });
  delete process.env.FAKE_GH_MULTI;
});
