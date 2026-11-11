/**
 * projects.mjs — the cockpit's list of projects (SHE-168).
 *
 * A project is a folder under $HOME that agents work in. The projects column
 * groups agents by it. Each project has the folder path (never editable here)
 * and a display name the owner can change. $HOME itself is never a project:
 * agents running there are listed under "Not in a project".
 *
 * The list is owner state, persisted in ~/.config/shellteam/projects.json
 * next to the cockpit's other state files. A folder that no longer exists is
 * hidden from the list but kept in the file, so a temporarily unmounted
 * folder does not lose its name.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HOME, PROJECTS_FILE, WORKSPACE_LOCK } from "./constants.mjs";

const execFileP = promisify(execFile);
const NAME_MAX = 40;
const CLONE_TIMEOUT_MS = 180_000;

let projects = null;   // [{ path, name }] in display order

function load() {
  if (projects) return projects;
  projects = [];
  if (existsSync(PROJECTS_FILE)) {
    const saved = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
    for (const p of saved.projects || []) {
      if (typeof p.path === "string" && isProjectPath(p.path)) {
        projects.push({ path: p.path, name: cleanName(p.name) || basename(p.path) });
      }
    }
  }
  return projects;
}

function save() {
  mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2));
}

function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A project is a real folder strictly inside $HOME, never a dot-folder. */
export function isProjectPath(path) {
  if (typeof path !== "string" || !path.startsWith(HOME + sep)) return false;
  return !path.slice(HOME.length + 1).split(sep).some((part) => part.startsWith("."));
}

function tildePath(path) {
  return "~" + path.slice(HOME.length);
}

/** The registered project that contains `cwd` (the deepest one), or null. */
export function projectFor(cwd) {
  let best = null;
  for (const p of load()) {
    if ((cwd === p.path || cwd.startsWith(p.path + sep)) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best;
}

/** Projects whose folder exists, in display order. */
export function listProjects() {
  if (WORKSPACE_LOCK) {
    // A locked (guest) cockpit has exactly one project: the lock.
    const saved = load().find((p) => p.path === WORKSPACE_LOCK);
    return [{ path: WORKSPACE_LOCK, name: saved?.name || basename(WORKSPACE_LOCK), label: basename(WORKSPACE_LOCK) }];
  }
  return load().filter((p) => isDir(p.path)).map((p) => ({ ...p, label: tildePath(p.path) }));
}

/**
 * Make sure the folder an agent works in belongs to a project. A folder inside
 * an existing project belongs to it; otherwise the folder becomes a project
 * named after itself. Returns true when the list changed.
 */
export function ensureProject(cwd) {
  if (WORKSPACE_LOCK || !isProjectPath(cwd) || projectFor(cwd)) return false;
  load().push({ path: cwd, name: basename(cwd) });
  save();
  console.log(`[projects] Added project ${cwd}`);
  return true;
}

export function renameProject(path, name) {
  const p = load().find((x) => x.path === path);
  if (!p) return false;
  p.name = cleanName(name) || basename(path);
  save();
  console.log(`[projects] Renamed ${path} -> "${p.name}"`);
  return true;
}

/** Take a project off the list. Its folder and files are not touched. */
export function removeProject(path) {
  const list = load();
  const i = list.findIndex((x) => x.path === path);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  console.log(`[projects] Removed ${path} from the list (folder untouched)`);
  return true;
}

export function reorderProjects(paths) {
  const list = load();
  const rank = new Map(paths.map((p, i) => [p, i]));
  list.sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity));
  save();
}

/** "My New Shop!" -> "my-new-shop": a folder name that is safe everywhere. */
export function folderNameFor(name) {
  return cleanName(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Create ~/<folder> for a new project. Returns { path } or { error }. */
export function createProject(name) {
  if (WORKSPACE_LOCK) return { error: "This cockpit is locked to one project." };
  const display = cleanName(name);
  const folder = folderNameFor(display);
  if (!folder) return { error: "Give the project a name with at least one letter or digit." };
  const path = join(HOME, folder);
  if (existsSync(path)) {
    if (!isDir(path)) return { error: `~/${folder} already exists and is not a folder.` };
    if (projectFor(path)?.path === path) return { error: `A project already uses ~/${folder}.` };
  } else {
    mkdirSync(path);
  }
  load().push({ path, name: display });
  save();
  console.log(`[projects] Created project "${display}" at ${path}`);
  return { path, name: display };
}

/** Open an existing folder as a project. Returns { path } or { error }. */
export function openProject(rawPath) {
  if (WORKSPACE_LOCK) return { error: "This cockpit is locked to one project." };
  const path = resolve(String(rawPath || "").replace(/^~(?=$|\/)/, HOME));
  if (!isProjectPath(path)) return { error: "A project must be a folder inside your home folder." };
  if (!isDir(path)) return { error: `${tildePath(path)} is not a folder.` };
  ensureProject(path);
  return { path: projectFor(path).path };
}

/**
 * "owner/repo", "https://github.com/owner/repo(.git)" or an SSH GitHub address
 * -> { url, folder }. Only GitHub is accepted: the address is handed to git,
 * so it is matched strictly rather than passed through.
 */
export function parseRepo(input) {
  const s = String(input || "").trim();
  const m = s.match(/^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, folder: m[2] };
}

/** Clone a GitHub repository into ~/<repo> and list it. { path } or { error }. */
export async function cloneProject(input) {
  if (WORKSPACE_LOCK) return { error: "This cockpit is locked to one project." };
  const repo = parseRepo(input);
  if (!repo) return { error: "Type a GitHub repository as owner/name or paste its github.com address." };
  const path = join(HOME, repo.folder);
  if (!isProjectPath(path)) return { error: `"${repo.folder}" cannot be used as a folder name here.` };
  if (existsSync(path)) return { error: `~/${repo.folder} already exists. Open that folder instead.` };
  try {
    await execFileP("git", ["clone", "--", repo.url, path], {
      cwd: HOME, timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    const detail = String(e.stderr || e.message).trim().split("\n").filter(Boolean).pop() || "git clone failed";
    console.error(`[projects] git clone ${repo.url} failed: ${e.stderr || e.message}`);
    return { error: `Could not clone ${repo.url.slice(19, -4)}: ${detail}` };
  }
  load().push({ path, name: repo.folder });
  save();
  console.log(`[projects] Cloned ${repo.url} into ${path}`);
  return { path, name: repo.folder };
}

/** Test hook: forget the in-memory list so the next call re-reads the file. */
export function _resetForTests() { projects = null; }
