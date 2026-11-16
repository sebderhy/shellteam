/**
 * ui-use.mjs — a private count of what the owner uses (SHE-204).
 *
 * The cockpit and the dashboard report the NAME of each control used (a fixed
 * identifier from the page's code, such as "chat.compact") and the screen it
 * was used on. This file adds them up per day in one JSON file on the box.
 * Nothing is sent anywhere, and nothing the owner wrote is kept: no message,
 * no chat title, no file name, no project name. `bin/shellteam-usage` prints
 * the ranking, so a UX change starts from real use instead of a guess.
 *
 * File shape: { "2026-11-15": { "desktop": { "chat.compact": 3 }, "phone": {…} } }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UI_USE_FILE } from "./constants.mjs";

export const SCREENS = ["desktop", "phone"];
const NAME_RE = /^[a-z][a-z0-9]*(?:[.+-][a-z0-9]+){0,5}$/;
const MAX_NAME = 64;
const MAX_NAMES_PER_DAY = 400;
const MAX_PER_REPORT = 500;
const KEEP_DAYS = 400;

const dayOf = (date) => date.toISOString().slice(0, 10);

export function readUse() {
  if (!existsSync(UI_USE_FILE)) return {};
  return JSON.parse(readFileSync(UI_USE_FILE, "utf8"));
}

/** Add one page's counts. Returns how many names were accepted. */
export function recordUse(screen, counts, now = new Date()) {
  if (!SCREENS.includes(screen) || !counts || typeof counts !== "object") return 0;
  const all = readUse();
  const day = (all[dayOf(now)] ||= {});
  const bucket = (day[screen] ||= {});
  let accepted = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (name.length > MAX_NAME || !NAME_RE.test(name) || !Number.isInteger(n) || n < 1) continue;
    if (!(name in bucket) && Object.keys(bucket).length >= MAX_NAMES_PER_DAY) continue;
    bucket[name] = (bucket[name] || 0) + Math.min(n, MAX_PER_REPORT);
    accepted++;
  }
  if (!accepted) return 0;
  const oldest = dayOf(new Date(now.getTime() - KEEP_DAYS * 86400000));
  for (const d of Object.keys(all)) if (d < oldest) delete all[d];
  mkdirSync(dirname(UI_USE_FILE), { recursive: true });
  const tmp = `${UI_USE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  renameSync(tmp, UI_USE_FILE);
  return accepted;
}

/** Controls by use over the last `days` days, most used first. */
export function ranking({ days = 30, now = new Date() } = {}) {
  const since = dayOf(new Date(now.getTime() - (days - 1) * 86400000));
  const all = readUse();
  const active = Object.keys(all).filter((d) => d >= since);
  const rows = new Map();
  for (const d of active) for (const screen of SCREENS) {
    for (const [name, n] of Object.entries(all[d][screen] || {})) {
      const row = rows.get(name) || { name, total: 0, desktop: 0, phone: 0, days: 0, _days: new Set() };
      row.total += n; row[screen] += n; row._days.add(d);
      rows.set(name, row);
    }
  }
  const out = [...rows.values()].map(({ _days, ...r }) => ({ ...r, days: _days.size }));
  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { since, activeDays: active.length, rows: out };
}

/** "all the time" (most days, many times), "daily", "weekly", "rare": the map's four shelves. */
export function shelf(row, activeDays) {
  const perDay = row.total / Math.max(1, activeDays);
  if (perDay >= 5) return "all the time";
  if (perDay >= 0.7) return "daily";
  if (perDay >= 0.12) return "weekly";
  return "rare";
}
