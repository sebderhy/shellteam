/**
 * SHE-135 safety net: hide the owner's vault values in everything the cockpit
 * sends to a browser. Agents are taught to use secrets by name
 * (bin/shellteam-secrets), so a value should never reach a chat; if one slips
 * through (an agent cats a .env), the trace shows `[secret NAME]` instead.
 *
 * The vault (~/.shellteam/secrets.json, written by api/services/secrets_vault.py)
 * is re-read only when its mtime changes. This masks what the cockpit SHOWS;
 * the agent CLI's own transcript and the model already saw the raw output.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MIN_MASK_LEN = 8; // same floor as secrets_vault.MIN_MASK_LEN

// The box's own credentials, from the cockpit's environment (.env). An agent
// running `env` or `cat .env` showed the master token in the chat (SHE-147).
// The master is also removed from the environment agents inherit
// (scrubMasterToken); it is captured here first so it can still be masked.
const BOX_SECRET_NAMES = ["OWNER_TOKEN", "SHELLTEAM_AI_TOKEN"];
const BOX_SECRET_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_DSN|DATABASE_URL)$/;
const boxSecrets = new Map();

function captureBoxSecrets() {
  for (const [name, value] of Object.entries(process.env)) {
    if (!(BOX_SECRET_NAMES.includes(name) || BOX_SECRET_RE.test(name))) continue;
    if (typeof value === "string" && value.length >= MIN_MASK_LEN) boxSecrets.set(name, value);
  }
}
captureBoxSecrets();

/** Agents never need the master token: every agent tool uses SHELLTEAM_AI_TOKEN. */
export function scrubMasterToken() {
  delete process.env.OWNER_TOKEN;
}

function withVariants(list, value, label) {
  list.push([value, label]);
  // Inside a JSON frame the value appears escaped (quotes, backslashes, unicode).
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) list.push([escaped, label]);
}

export function vaultPath() {
  return process.env.SHELLTEAM_SECRETS_FILE || join(process.env.HOME || homedir(), ".shellteam", "secrets.json");
}

let cache = { mtimeMs: -1, pairs: [] };

function pairs() {
  let mtimeMs;
  try {
    mtimeMs = statSync(vaultPath()).mtimeMs;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    mtimeMs = 0;
  }
  if (mtimeMs === cache.mtimeMs) return cache.pairs;
  const secrets = mtimeMs ? JSON.parse(readFileSync(vaultPath(), "utf8")).secrets || {} : {};
  const list = [];
  for (const [name, value] of boxSecrets) withVariants(list, value, `[secret ${name}]`);
  for (const [name, s] of Object.entries(secrets)) {
    if (typeof s?.value !== "string" || s.value.length < MIN_MASK_LEN) continue;
    withVariants(list, s.value, `[secret ${name}]`);
  }
  list.sort((a, b) => b[0].length - a[0].length); // longest first
  cache = { mtimeMs, pairs: list };
  return list;
}

/** Replace every vault value in `text` with `[secret NAME]`. */
export function maskSecrets(text) {
  if (typeof text !== "string") return text;
  for (const [value, label] of pairs()) {
    if (text.includes(value)) text = text.split(value).join(label);
  }
  return text;
}

/** Make every string frame this socket sends go through maskSecrets. */
export function maskSocket(ws) {
  const send = ws.send.bind(ws);
  ws.send = (data, ...rest) => send(maskSecrets(data), ...rest);
  return ws;
}
