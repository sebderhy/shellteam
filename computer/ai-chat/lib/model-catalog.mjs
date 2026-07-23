import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// config/models.json is the single source of truth for the model catalog (the
// Python control plane reads it too — see api/services/model_catalog.py). This
// module gives the cockpit model->agent routing, the OpenCode default, and the
// raw catalog it serves to the browser for the model dropdown.
//
// Add a model there + restart the cockpit — no code change here.
const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "models.json",
);

let _catalog = null;

export function loadCatalog() {
  // Cached after first read; restart the cockpit to pick up catalog edits.
  if (!_catalog) _catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  return _catalog;
}

export function agents() {
  return loadCatalog().agents || [];
}

/**
 * Which coding-agent family a model string belongs to. A model routes by exact
 * membership in an agent's models[] list first, then by match.prefixes, then
 * falls back to the first agent (Claude). Mirrors the Python-free routing the
 * cockpit needs; the browser uses the same rules via loadCatalog().
 */
export function agentIdForModel(model) {
  const list = agents();
  if (!model || !list.length) return list[0]?.id ?? "claude";
  for (const a of list) {
    if ((a.models || []).some((m) => m.id === model)) return a.id;
  }
  for (const a of list) {
    if ((a.match?.prefixes || []).some((p) => model.startsWith(p))) return a.id;
  }
  return list[0].id;
}

/**
 * The value to pass to a CLI's `--model` flag for a catalog model id. For most
 * agents the id IS the CLI model id, but Antigravity's `agy --model` wants the
 * human display name ("Gemini 3.1 Pro (High)"), so its catalog entries carry a
 * `cli` override. Falls back to the id when none is set.
 */
export function cliModelForId(model) {
  for (const a of agents()) {
    const m = (a.models || []).find((x) => x.id === model);
    if (m) return m.cli || m.id;
  }
  return model;
}

/**
 * Extra CLI config overrides attached to a catalog model. This lets the cockpit
 * expose variants such as "same upstream model, different reasoning effort"
 * while still keeping the catalog as the single source of truth.
 */
export function configArgsForId(model) {
  for (const a of agents()) {
    const m = (a.models || []).find((x) => x.id === model);
    if (m?.config) return m.config.flatMap((c) => ["-c", c]);
  }
  return [];
}

/**
 * The model's context window in tokens, from the catalog's `limit.context`
 * (the single source of truth the browser meter also reads). Matches a catalog
 * model by id OR by its `cli` value, so a stale/cli-form id (e.g. "gpt-5.6-sol"
 * from a saved tab, whose catalog id is "gpt-5.6-sol-max") still resolves to
 * the real 400k window instead of silently falling back. Falls back to 1M for
 * long-context "[1m]" variants and 200k otherwise — matching
 * `contextWindowForModel` in public/app.js so the meter and the auto-compact
 * threshold agree.
 */
export function contextLimitForId(model) {
  for (const a of agents()) {
    const m = (a.models || []).find((x) => x.id === model || x.cli === model);
    if (m?.limit?.context) return m.limit.context;
  }
  if (/\[1m\]/i.test(model || "")) return 1_000_000;
  return 200_000;
}

export function opencodeAgent() {
  return agents().find((a) => a.id === "opencode") || null;
}

/** Short id of OpenCode's default model (e.g. "glm-5p2"). */
export function opencodeDefaultModel() {
  const a = opencodeAgent();
  if (!a) return "";
  return a.default || a.models?.[0]?.id || "";
}
