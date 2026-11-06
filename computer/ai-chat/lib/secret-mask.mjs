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

export function vaultPath() {
  return process.env.SHELLTEAM_SECRETS_FILE || join(process.env.HOME || homedir(), ".shellteam", "secrets.json");
}

let cache = { mtimeMs: -1, pairs: [] };

function pairs() {
  let mtimeMs;
  try {
    mtimeMs = statSync(vaultPath()).mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  if (mtimeMs === cache.mtimeMs) return cache.pairs;
  const secrets = JSON.parse(readFileSync(vaultPath(), "utf8")).secrets || {};
  const list = [];
  for (const [name, s] of Object.entries(secrets)) {
    if (typeof s?.value !== "string" || s.value.length < MIN_MASK_LEN) continue;
    const label = `[secret ${name}]`;
    list.push([s.value, label]);
    // Inside a JSON frame the value appears escaped (quotes, backslashes, unicode).
    const escaped = JSON.stringify(s.value).slice(1, -1);
    if (escaped !== s.value) list.push([escaped, label]);
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
