/**
 * _killTree signals a child's PROCESS GROUP with kill(-pid). Passed a bogus
 * pid, that primitive is a weapon: kill(-1) broadcasts to every process the
 * user owns (systemd user manager included: the whole session exits), kill(-0)
 * hits the cockpit's own group. A test's fake `{ pid: 1 }` did exactly that on
 * 2026-09-07, three outages in a day. The helper must refuse anything that is
 * not a real child pid, and never reach process.kill for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodingAgent } from "../lib/coding-agent.mjs";

function withKillSpy(fn) {
  const calls = [];
  const real = process.kill;
  process.kill = (pid, sig) => { calls.push([pid, sig]); return true; };
  try { fn(); } finally { process.kill = real; }
  return calls;
}

test("pid 1, 0, negative, fractional or non-numeric never reach process.kill", () => {
  const agent = new CodingAgent({ model: "x", cwd: "/tmp", env: {} });
  for (const pid of [1, 0, -1, 1.5, "1", NaN, Infinity, undefined, null]) {
    const calls = withKillSpy(() => agent._killTree({ pid }, "SIGINT"));
    assert.deepEqual(calls, [], `pid ${String(pid)} must be refused`);
  }
});

test("a real child pid is signalled as a process group", () => {
  const agent = new CodingAgent({ model: "x", cwd: "/tmp", env: {} });
  const calls = withKillSpy(() => agent._killTree({ pid: 4242 }, "SIGTERM"));
  assert.deepEqual(calls, [[-4242, "SIGTERM"]]);
});

test("an already-killed fake process is skipped (the pattern agent tests rely on)", () => {
  const agent = new CodingAgent({ model: "x", cwd: "/tmp", env: {} });
  const calls = withKillSpy(() => agent._killTree({ pid: 999, killed: true }, "SIGINT"));
  assert.deepEqual(calls, []);
});
