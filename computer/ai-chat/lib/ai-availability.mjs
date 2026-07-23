/**
 * Live AI-capability availability — asks the control plane instead of
 * trusting this process's stale env.
 *
 * The cockpit inherits FIREWORKS_API_KEY / ELEVENLABS_API_KEY from systemd's
 * EnvironmentFile at spawn, but the dashboard's Settings → Feature keys can
 * set/clear those keys in the RUNNING control plane (os.environ) without any
 * restart. GET /internal/ai/status is the live truth; this module caches it
 * and falls back to process env only when the control plane is unreachable.
 */

import { INTERNAL_API_BASE, internalAiAuthHeaders } from "../../shared/media-handlers.mjs";

// Last good control-plane answer, or null before the first successful fetch.
let _cached = null;

function envFallback() {
  return {
    opencode: !!process.env.FIREWORKS_API_KEY,
    stt: !!process.env.ELEVENLABS_API_KEY,
  };
}

/**
 * The current availability flags `{ opencode, stt }` — the cached
 * control-plane answer, or the process-env fallback before the first
 * successful fetch. Synchronous so status builders can call it inline.
 */
export function aiAvailability() {
  return _cached ?? envFallback();
}

/**
 * Refresh the cache from GET /internal/ai/status. Returns the fresh flags on
 * success; on any failure logs a loud warning, keeps the previous cache, and
 * returns null (status building falls back via aiAvailability() — a control
 * plane hiccup must never crash or blank the status payload).
 *
 * `fetchImpl` is injectable for tests.
 */
export async function refreshAiAvailability({ fetchImpl = fetch } = {}) {
  const headers = internalAiAuthHeaders();
  try {
    if (!headers) throw new Error("SHELLTEAM_AI_TOKEN not set");
    const resp = await fetchImpl(`${INTERNAL_API_BASE}/internal/ai/status`, {
      headers,
      // Bounded probe: a wedged control plane must not stack pending fetches
      // across poll ticks (undici's default timeout is minutes).
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _cached = { opencode: !!data.opencode, stt: !!data.stt };
    return _cached;
  } catch (err) {
    console.warn(
      `[ai-availability] control-plane status fetch failed (${err.message}) — ` +
      `falling back to ${_cached ? "the last good answer" : "process env"}`,
    );
    return null;
  }
}

/**
 * Poll the control plane every `intervalMs`, invoking `onChange()` whenever
 * the flags actually change (so the server can re-broadcast status to
 * connected clients). Kicks off an immediate first refresh. The timer is
 * unref'd so it never keeps the process alive.
 */
export function startAiAvailabilityPolling({ intervalMs = 30_000, onChange } = {}) {
  // No token → this process can NEVER reach /internal/ai (env is fixed at
  // spawn). One loud warning instead of re-detecting the same unrecoverable
  // condition every tick forever (e.g. a dev `node server.mjs` run, or an
  // employee container that deliberately gets no master token).
  if (!internalAiAuthHeaders()) {
    console.warn(
      "[ai-availability] SHELLTEAM_AI_TOKEN not set — live feature-key polling " +
      "disabled; capability flags come from process env for this run",
    );
    return null;
  }
  let last = JSON.stringify(aiAvailability());
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return; // never stack probes on a slow control plane
    inFlight = true;
    try {
      const fresh = await refreshAiAvailability();
      if (!fresh) return;
      const now = JSON.stringify(fresh);
      if (now !== last) {
        last = now;
        console.log(`[ai-availability] capability change: ${now}`);
        onChange?.();
      }
    } finally {
      inFlight = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

/** Test hook — reset the module cache between test cases. */
export function _resetAiAvailabilityCache() {
  _cached = null;
}
