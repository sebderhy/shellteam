import { timingSafeEqual } from "node:crypto";

/**
 * Gate for the cockpit's `/internal/*` endpoints — the ones in-box services
 * (the control plane, the dreaming timer) call to drive the cockpit.
 *
 * "Loopback-only" is NOT a boundary here. These endpoints listen on the same
 * host the owner browses from, so a page in the owner's browser connects from
 * 127.0.0.1 too: checking the socket address would authorise the attacker.
 * A cross-origin `fetch()` with `Content-Type: text/plain` is a CORS-safelisted
 * *simple* request — it is sent without a preflight, and the attacker never
 * needs to read the opaque response for the side effect to land. That is how
 * any website the owner visited could start a `--dangerously-skip-permissions`
 * agent on a localhost install.
 *
 * So the gate is two independent locks:
 *  1. A secret in a CUSTOM header. Custom headers are not CORS-safelisted, so
 *     sending one forces a preflight, which this server never answers.
 *  2. Refuse any request that carries an `Origin` header at all. Real in-box
 *     callers (httpx, curl) send none; browsers always do on cross-origin.
 *
 * Fails CLOSED when the secret is unset — a box with no SHELLTEAM_AI_TOKEN
 * loses the dream/mirror kickoff convenience rather than silently serving an
 * unauthenticated remote-agent-start endpoint.
 */
export const INTERNAL_AUTH_HEADER = "x-shellteam-internal";

function secretsMatch(presented, expected) {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * True when this request may drive an internal cockpit endpoint. Logs every
 * refusal with the reason — a silently-dropped internal call is a debugging
 * nightmare, and a refused one is a security event worth seeing in the journal.
 */
export function internalCallerAuthorized(req, { label = "internal" } = {}) {
  const origin = req.headers.origin;
  if (origin) {
    console.warn(`[ai-chat] ${label}: refused — request carries Origin: ${origin}`);
    return false;
  }
  const expected = process.env.SHELLTEAM_AI_TOKEN || "";
  if (!expected) {
    console.warn(
      `[ai-chat] ${label}: refused — SHELLTEAM_AI_TOKEN is not set in the cockpit's ` +
        "environment, so internal callers cannot be authenticated.",
    );
    return false;
  }
  const presented = req.headers[INTERNAL_AUTH_HEADER];
  if (typeof presented !== "string" || !secretsMatch(presented, expected)) {
    console.warn(`[ai-chat] ${label}: refused — missing or invalid ${INTERNAL_AUTH_HEADER}`);
    return false;
  }
  return true;
}
