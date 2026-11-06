// SHE-148: the cockpit file API refuses dotfiles and symlinks out of home, and
// session ids can't be paths. Runs in a child with a throwaway HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("file API paths stay inside home and off dotfiles", () => {
  const root = mkdtempSync(join(tmpdir(), "she148-"));
  const home = join(root, "home");
  mkdirSync(join(home, "proj"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id"), "k");
  writeFileSync(join(root, "outside.txt"), "o");
  symlinkSync(join(home, ".ssh"), join(home, "proj", "keys"));
  symlinkSync(join(root, "outside.txt"), join(home, "proj", "out.txt"));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const h = await import(${JSON.stringify(new URL("../lib/history.mjs", import.meta.url).href)});
    const r = {};
    for (const p of ["proj/a.txt", "proj/new/dir/b.txt", ".env", "proj/.git/config", "proj/keys/id", "proj/out.txt", "../outside.txt"])
      r[p] = h.safeFileApiPath(p) !== null;
    r.ids = ["0199a-bc_d", "../../etc/passwd", "a/b", ""].map(h.isSafeSessionId);
    r.find = h.findSessionFile("../../../etc/hosts");
    console.log(JSON.stringify(r));
  `], { env: { PATH: process.env.PATH, HOME: home } }).toString();
  const r = JSON.parse(out.trim().split("\n").pop());
  assert.equal(r["proj/a.txt"], true);
  assert.equal(r["proj/new/dir/b.txt"], true);
  for (const p of [".env", "proj/.git/config", "proj/keys/id", "proj/out.txt", "../outside.txt"]) assert.equal(r[p], false, p);
  assert.deepEqual(r.ids, [true, false, false, false]);
  assert.equal(r.find, null);
});
