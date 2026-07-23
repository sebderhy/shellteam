#!/usr/bin/env python3
"""One-time cleanup of ShellTeam's *legacy* injection into the owner's dotfiles.

Earlier OSS builds materialized ShellTeam's Cloud config template directly into
``~/.claude`` / ``~/.claude.json`` (overwriting hooks, MCP, permissions, and
seeding a bogus Cloud-container ``projects/-home-user`` dir). The current edition
never does this — it loads an additive launch-layer from ``~/.shellteam`` instead
(see ``docs/design/vps-footprint.md``). This script reverts the leftovers on a box
that ran an older build.

It is **conservative and reversible**: it backs up ``~/.claude`` and
``~/.claude.json`` first, then removes ONLY the artifacts ShellTeam is known to
have injected (its template MCP servers, its ``mcp__…(*)`` permission rules, its
hooks, its bundled skills, and the bogus memory dir) — leaving everything the user
added themselves intact. Idempotent; safe to run more than once.

Run:  uv run python scripts/cleanup-legacy-agent-config.py [--dry-run]
"""

import json
import shutil
import sys
import time
from pathlib import Path

# Allow running as a bare script (`python scripts/...`) — put the repo root on path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.services.agent_config import CONFIG_TEMPLATE_DIR

HOME = Path.home()
DRY = "--dry-run" in sys.argv
# One backup dir for the whole run — modified files are copied here before edits,
# and removed dirs are *moved* here (not deleted), so the cleanup is fully reversible.
BACKUP = HOME / f".claude-cleanup-backup.{int(time.time())}"


def _shellteam_mcp_names() -> set[str]:
    template = json.loads((CONFIG_TEMPLATE_DIR / "claude.json").read_text())
    return set(template.get("mcpServers", {})) | {"composio"}


def _shellteam_skill_names() -> set[str]:
    skills = CONFIG_TEMPLATE_DIR / "skills"
    return {d.name for d in skills.iterdir() if (d / "SKILL.md").is_file()} if skills.is_dir() else set()


def _looks_like_shellteam_hook(cmd: str) -> bool:
    return "claude-config/hooks/" in cmd or "/opt/claude-config" in cmd


def _rel_backup(path: Path) -> Path:
    """Mirror a path under BACKUP, preserving its location relative to HOME."""
    return BACKUP / path.relative_to(HOME)


def _backup_file(path: Path) -> None:
    """Copy a file we're about to modify into the backup dir."""
    if DRY or not path.exists():
        return
    dest = _rel_backup(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)


def _move_to_backup(path: Path) -> None:
    """Move a dir/file we're removing into the backup dir (reversible, no delete)."""
    if DRY or not path.exists():
        return
    dest = _rel_backup(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(dest))


def clean_settings(changes: list[str]) -> None:
    path = HOME / ".claude" / "settings.json"
    if not path.exists():
        return
    data = json.loads(path.read_text())

    allow = data.get("permissions", {}).get("allow", [])
    pruned = [p for p in allow if not (p.startswith("mcp__") and "(" in p)]
    if pruned != allow:
        changes.append(f"settings.json: dropped {len(allow) - len(pruned)} invalid mcp__…(*) rule(s)")
        data["permissions"]["allow"] = pruned

    hooks = data.get("hooks", {})
    removed_hooks = 0
    for event, groups in list(hooks.items()):
        kept_groups = []
        for group in groups:
            group_hooks = [h for h in group.get("hooks", []) if not _looks_like_shellteam_hook(h.get("command", ""))]
            removed_hooks += len(group.get("hooks", [])) - len(group_hooks)
            if group_hooks:
                group["hooks"] = group_hooks
                kept_groups.append(group)
        if kept_groups:
            hooks[event] = kept_groups
        else:
            del hooks[event]
    if removed_hooks:
        changes.append(f"settings.json: removed {removed_hooks} ShellTeam hook(s) (now loaded from the layer)")
        if hooks:
            data["hooks"] = hooks
        else:
            data.pop("hooks", None)

    if (pruned != allow or removed_hooks) and not DRY:
        _backup_file(path)
        path.write_text(json.dumps(data, indent=2))


def clean_claude_json(changes: list[str]) -> None:
    path = HOME / ".claude.json"
    if not path.exists():
        return
    data = json.loads(path.read_text())
    mcp = data.get("mcpServers", {})
    st_names = _shellteam_mcp_names()
    removed = [n for n in list(mcp) if n in st_names]
    for n in removed:
        del mcp[n]
    if removed:
        changes.append(f".claude.json: removed injected MCP server(s): {', '.join(removed)} (now in the layer)")
        data["mcpServers"] = mcp
        if not DRY:
            _backup_file(path)
            path.write_text(json.dumps(data, indent=2))


def clean_skills(changes: list[str]) -> None:
    skills_dir = HOME / ".claude" / "skills"
    if not skills_dir.is_dir():
        return
    for name in _shellteam_skill_names():
        d = skills_dir / name
        if d.is_dir():
            changes.append(f".claude/skills/{name}: removed ShellTeam skill (now in the layer)")
            _move_to_backup(d)


def clean_secondary_agent_configs(changes: list[str]) -> None:
    """Revert config files ShellTeam wholesale-wrote into Codex/OpenCode dirs.

    The old path overwrote these every restart, so they're ShellTeam's, not the
    user's. Move them to the backup (reversible) only when they carry a ShellTeam
    signature — leaving any config the user actually authored alone. Codex/OpenCode
    now get ShellTeam's layer via `-c` overrides / OPENCODE_CONFIG instead.
    """
    codex_toml = HOME / ".codex" / "config.toml"
    if codex_toml.exists():
        body = codex_toml.read_text()
        if 'sandbox_mode = "danger-full-access"' in body and 'approval_policy = "never"' in body:
            changes.append(".codex/config.toml: reverted ShellTeam-written config (now -c overrides)")
            _move_to_backup(codex_toml)

    opencode_json = HOME / ".config" / "opencode" / "opencode.json"
    if opencode_json.exists() and "/internal/ai/fireworks" in opencode_json.read_text():
        changes.append(".config/opencode/opencode.json: reverted ShellTeam-written config (now OPENCODE_CONFIG)")
        _move_to_backup(opencode_json)


def clean_bogus_memory(changes: list[str]) -> None:
    # `-home-user` is a *Cloud container* path — never valid on a native box.
    bogus = HOME / ".claude" / "projects" / "-home-user"
    if bogus.exists():
        changes.append(".claude/projects/-home-user: removed bogus Cloud-container memory dir")
        _move_to_backup(bogus)


def main() -> None:
    print("ShellTeam legacy agent-config cleanup" + (" (dry run)" if DRY else ""))

    changes: list[str] = []
    clean_settings(changes)
    clean_claude_json(changes)
    clean_skills(changes)
    clean_secondary_agent_configs(changes)
    clean_bogus_memory(changes)

    if not changes:
        print("Nothing to clean — no legacy injection found. ✓")
        return
    print(("Would make" if DRY else "Made") + " these changes:")
    for c in changes:
        print(f"  - {c}")
    if DRY:
        print("\nRe-run without --dry-run to apply.")
    elif BACKUP.exists():
        print(f"\nOriginals backed up under {BACKUP} (delete once you're happy).")


if __name__ == "__main__":
    main()
