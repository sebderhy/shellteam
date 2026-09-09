/**
 * workspaces.mjs — the Workspace picker's folder list.
 *
 * Extracted from server.mjs so it can be unit-tested against a throwaway HOME
 * without spawning the whole cockpit (SHE-86).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME, WORKSPACE_LOCK } from "./constants.mjs";

// Real top-level subdirectories of `dir`, alphabetised — skipping dot-dirs and
// dependency caches. Returns [] for an unreadable/absent directory.
function dirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")
        && e.name !== "node_modules" && e.name !== "__pycache__")
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return []; /* unreadable / absent — skip */
  }
}

export function listWorkspaces() {
  // A locked cockpit has exactly one workspace — the lock. Never list ~ or
  // sibling projects to a guest.
  if (WORKSPACE_LOCK) {
    const label = WORKSPACE_LOCK.startsWith(HOME + "/")
      ? `~${WORKSPACE_LOCK.slice(HOME.length)}`
      : WORKSPACE_LOCK;
    return [{ path: WORKSPACE_LOCK, label }];
  }
  const workspaces = [{ path: HOME, label: "~" }];
  const seen = new Set([HOME]);
  const add = (path, label) => {
    if (!seen.has(path)) { seen.add(path); workspaces.push({ path, label }); }
  };

  // Every real top-level folder under $HOME — not just git repos. A plain
  // project folder like ~/avsv is a legitimate workspace and must appear
  // without the user having to type its path first (SHE-86).
  for (const entry of dirEntries(HOME)) {
    add(join(HOME, entry.name), `~/${entry.name}`);
  }

  // Expand ~/projects/ (the conventional multi-project parent) one level deeper.
  for (const entry of dirEntries(join(HOME, "projects"))) {
    add(join(HOME, "projects", entry.name), `~/projects/${entry.name}`);
  }

  return workspaces;
}
