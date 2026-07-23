"""ShellTeam's additive **agent launch-layer** (OSS native edition).

Instead of mutating the owner's coding-agent dotfiles (``~/.claude``,
``~/.claude.json`` …) — the Cloud-style behaviour in ``agent_config.py`` that
overwrote user hooks/MCP/permissions — the OSS edition composes ShellTeam's
additions **at agent-launch time** and persists them only inside ShellTeam's own
namespace (``~/.shellteam/agent-layer/``).

For Claude Code the whole bundle (skills + hooks + MCP servers) is packaged as a
single **session-only plugin** loaded with ``--plugin-dir``, plus a persona file
loaded with ``--append-system-prompt-file``. The cockpit and the ShellTeam-managed
terminal pass those flags; a ``claude`` the user runs by hand in their own shell
gets *only* their own config. See ``docs/design/vps-footprint.md``.

Nothing here ever writes to the user's dotfiles.
"""

import json
import logging
import os
import re
import shutil
from pathlib import Path

from api.config import APP_DOMAIN, MODULES
from api.services.agent_config import (
    CONFIG_TEMPLATE_DIR,
    SHARED_TEMPLATE_DIR,
)

log = logging.getLogger(__name__)

# ShellTeam's own namespace under the owner's home — removable as a unit.
STATE_DIRNAME = ".shellteam"
LAYER_SUBPATH = (STATE_DIRNAME, "agent-layer")

# Loopback CDP endpoint of the Steel browser container (see install.sh).
BROWSER_CDP_ENDPOINT = os.environ.get("BROWSER_CDP_ENDPOINT", "ws://127.0.0.1:3000")

# Where in-box tools (skills, persona snippets) reach the control plane. Native
# boxes talk to the loopback API port; the Cloud form `host.docker.internal:8000`
# never resolves outside a container, so any template still carrying it is
# rewritten at render time.
API_BASE = f"http://127.0.0.1:{os.environ.get('API_PORT', '8000')}"

PLUGIN_NAME = "shellteam"


def _hydrate(text: str, username: str) -> str:
    """Substitutions applied to every rendered template (persona + skills)."""
    text = text.replace("{username}", username)
    text = text.replace("{api_base}", API_BASE)
    # Legacy Cloud literal — rewrite so stale templates still work natively.
    return text.replace("http://host.docker.internal:8000", API_BASE)


def layer_dir(home_dir: Path) -> Path:
    """``~/.shellteam/agent-layer`` — ShellTeam's launch-layer root."""
    return home_dir.joinpath(*LAYER_SUBPATH)


def claude_plugin_dir(home_dir: Path) -> Path:
    return layer_dir(home_dir) / "claude"


def claude_system_prompt_file(home_dir: Path) -> Path:
    return layer_dir(home_dir) / "system-prompt.md"


def harness_skills_dir(home_dir: Path) -> Path:
    """Canonical, rendered ShellTeam skills shared by every cockpit agent."""
    return layer_dir(home_dir) / "harness" / "skills"


def antigravity_workspace_dir(home_dir: Path) -> Path:
    """A ShellTeam-owned workspace whose plugin is added to AGY per session.

    Antigravity discovers workspace plugins from ``.agents/plugins``. Passing
    this directory through its ``--add-dir`` flag loads the plugin for a cockpit
    session without installing anything into ``~/.gemini`` or the user's repo.
    """
    return layer_dir(home_dir) / "antigravity-workspace"


def antigravity_plugin_dir(home_dir: Path) -> Path:
    return antigravity_workspace_dir(home_dir) / ".agents" / "plugins" / PLUGIN_NAME


def codex_session_home_dir(home_dir: Path) -> Path:
    """ShellTeam-owned HOME overlay used only for cockpit Codex sessions.

    Codex discovers global skills under ``$HOME/.agents/skills``. The overlay
    exposes the owner's existing home entries through symlinks while placing the
    shared ShellTeam skills at that discovery path, so no user config is edited.
    """
    return layer_dir(home_dir) / "codex-home"


def codex_overrides_file(home_dir: Path) -> Path:
    return layer_dir(home_dir) / "codex" / "overrides.json"


def opencode_config_file(home_dir: Path) -> Path:
    return layer_dir(home_dir) / "opencode.json"


def layer_manifest_file(home_dir: Path) -> Path:
    """``~/.shellteam/agent-layer/layer.json`` — the purity-gate manifest.

    Written on every build. Records the enabled modules and which layer
    artifacts exist, so the Node spawners (``agent-layer.mjs``) know whether to
    pass any flags at all WITHOUT parsing .env. No manifest + no artifacts =
    pure core; the contract test pins the spawn argv in that state.
    """
    return layer_dir(home_dir) / "layer.json"


def claude_mcp_config_file(home_dir: Path) -> Path:
    """``~/.shellteam/agent-layer/claude-mcp.json`` — ShellTeam's MCP servers.

    Passed to Claude with ``--mcp-config`` (additive, NOT ``--strict``). MCP must
    ride here, *not* in the plugin's ``.mcp.json``: Claude Code health-checks a
    plugin's MCP servers but never exposes their tools to the agent, so cockpit
    agents saw zero MCP tools (browser/linear/deepwiki all dark). ``--mcp-config``
    is the path that actually surfaces the tools. Verified 2026-06-30.
    """
    return layer_dir(home_dir) / "claude-mcp.json"


def _browser_server(cdp_endpoint: str, tmp_dir: str) -> dict:
    """The Playwright/Steel browser MCP from the template, rewritten for a
    concrete deployment: the template ships Cloud placeholders (loopback CDP,
    ``/home/user/tmp``); every consumer (owner box, employee container) supplies
    its own endpoint + screenshot dir through here."""
    template = json.loads((CONFIG_TEMPLATE_DIR / "claude.json").read_text())
    browser = template["mcpServers"]["browser"]
    if "args" in browser:
        browser["args"] = [
            tmp_dir if a == "/home/user/tmp"
            else (cdp_endpoint if a == "ws://127.0.0.1:3000" else a)
            for a in browser["args"]
        ]
    return browser


def canonical_mcp_servers(
    home_dir: Path, user_id: str = "", modules: frozenset | set | None = None
) -> dict:
    """The MCP servers ShellTeam adds to cockpit agents — single source of truth.

    Rendered for the *native* box (real ``$HOME``, loopback Steel endpoint).
    Every server is module-gated (the core-purity guarantee): with no modules
    enabled this returns ``{}`` and cockpit agents see zero ShellTeam MCP.

      persona  → context7 + deepwiki (the docs lookups the persona/skills teach)
      browser  → the Steel browser MCP
      composio → Composio Tool Router (needs COMPOSIO_API_KEY too)
      linear   → Linear's hosted MCP (needs LINEAR_API_KEY too)

    This dict is fed to Claude's ``--mcp-config`` and (in the OSS path) to the
    secondary-agent config builders, so all agents see the same servers.
    """
    if modules is None:
        modules = MODULES
    template = json.loads((CONFIG_TEMPLATE_DIR / "claude.json").read_text())
    template_servers = template.get("mcpServers", {})

    servers: dict = {}
    if "persona" in modules:
        servers.update(
            {n: cfg for n, cfg in template_servers.items() if n != "browser"}
        )

    if "browser" in modules and "browser" in template_servers:
        servers["browser"] = _browser_server(BROWSER_CDP_ENDPOINT, str(home_dir / "tmp"))

    if "composio" in modules:
        if user_id and os.environ.get("COMPOSIO_API_KEY"):
            try:
                from api.services.composio import generate_mcp_config
                servers["composio"] = generate_mcp_config(user_id)
            except Exception:
                log.warning("Composio MCP generation failed for %s", user_id, exc_info=True)
        else:
            log.warning(
                "Module 'composio' is enabled but COMPOSIO_API_KEY is not set — "
                "Composio MCP NOT added. Set the key in .env or drop the module."
            )

    # Linear's hosted server accepts a personal API key straight in the
    # Authorization header, so agents can file/read issues with no interactive
    # OAuth — the right fit for a single-owner box. (Get a key at Linear →
    # Settings → Security & access → Personal API keys.) https://linear.app/docs/mcp
    if "linear" in modules:
        linear_key = os.environ.get("LINEAR_API_KEY")
        if linear_key:
            servers["linear"] = {
                "type": "http",
                "url": "https://mcp.linear.app/mcp",
                "headers": {"Authorization": f"Bearer {linear_key}"},
            }
            log.info("Linear MCP enabled (LINEAR_API_KEY set)")
        else:
            log.warning(
                "Module 'linear' is enabled but LINEAR_API_KEY is not set — "
                "Linear MCP NOT added. Set the key in .env or drop the module."
            )

    return servers


def _toml_value(v) -> str:
    """Encode a Python value as a TOML literal for a Codex ``-c key=<value>`` flag.

    JSON happens to be valid TOML for strings and string-arrays; dicts need an
    inline table (`{ k = "v" }`), which JSON doesn't produce.
    """
    if isinstance(v, dict):
        inner = ", ".join(f"{json.dumps(k)} = {json.dumps(val)}" for k, val in v.items())
        return f"{{ {inner} }}"
    return json.dumps(v)


def build_codex_overrides(
    home_dir: Path,
    mcp_servers: dict,
    include_doc_fallback: bool = True,
    developer_instructions: str | None = None,
) -> list[str]:
    """Codex `-c key=value` overrides — ShellTeam's additions, composed at launch.

    Codex has no `--plugin-dir`; instead it layers `-c` overrides on top of the
    user's base `~/.codex/config.toml` (verified additive). Model, sandbox, and
    approval are already passed as spawn flags by the cockpit, so this adds the
    MCP servers and (persona module only) the AGENTS.md/CLAUDE.md doc fallback.
    The Node launch adapter supplies the shared rendered harness as an additive
    `developer_instructions` override at spawn, so project knowledge is composed
    identically for all agents. Never use `model_instructions_file`, which
    REPLACES Codex's base instructions. Without the additive prompt Codex
    invented file URLs — port subdomains, raw /home paths, `:N` suffixes
    (SHE-64).
    The optional OpenAI-API provider block is added by the cockpit at spawn (it
    depends on runtime key state, not on this build). Writes nothing.
    """
    overrides: list[str] = []
    if include_doc_fallback:
        overrides.append(
            f"project_doc_fallback_filenames={_toml_value(['AGENTS.md', 'CLAUDE.md'])}"
        )
    if developer_instructions:
        overrides.append(f"developer_instructions={_toml_value(developer_instructions)}")
    for name, cfg in mcp_servers.items():
        if "url" in cfg:
            overrides.append(f"mcp_servers.{name}.url={_toml_value(cfg['url'])}")
            if cfg.get("headers"):
                overrides.append(f"mcp_servers.{name}.http_headers={_toml_value(cfg['headers'])}")
        elif "command" in cfg:
            overrides.append(f"mcp_servers.{name}.command={_toml_value(cfg['command'])}")
            if cfg.get("args"):
                overrides.append(f"mcp_servers.{name}.args={_toml_value(cfg['args'])}")
    return overrides


def _render_box_template(template: str, username: str, home_dir: Path) -> str:
    """Rewrite a Cloud-placeholder template for the *real* box.

    The templates use Cloud placeholders: `/home/user`, `{username}.localhost`
    (file host), and `{username}-PORT.localhost` (port host). Rewrite them to this
    box's real home and domain. On a public deploy APP_DOMAIN is the owner's file
    host (e.g. `box.example.com`); port hosts hang off its registrable base.

    On a LOCALHOST box the subdomain forms must not survive hydration: the old
    passthrough taught agents `https://<owner>.localhost/…` — no TLS, no port,
    dead links (SHE-77). Render the canonical main-domain path form instead
    (`http://localhost:<API_PORT>/…`), and point port previews at the sibling
    local port (`http://localhost:3000`), which is how a localhost box actually
    exposes them.
    """
    if APP_DOMAIN and APP_DOMAIN != "localhost":
        rendered = template.replace("{username}.localhost", APP_DOMAIN)
        # Port-preview hosts hang off the FULL dashboard domain — the proxy's
        # SUBDOMAIN_RE matches `<owner>-<port>.<APP_DOMAIN>` and the Caddy
        # wildcard covers `*.APP_DOMAIN`. The old registrable-base rewrite
        # (`owner-3000.example.com` for APP_DOMAIN=box.example.com) taught URLs
        # that resolve nowhere (SHE-77 sibling defect).
        rendered = rendered.replace(".localhost", f".{APP_DOMAIN}")  # port hosts
    else:
        api_port = os.environ.get("API_PORT", "8000")
        rendered = re.sub(
            r"https://\{username\}-(PORT|[0-9]+)\.localhost", r"http://localhost:\1", template
        )
        rendered = rendered.replace("https://{username}.localhost", f"http://localhost:{api_port}")
    rendered = _hydrate(rendered, username)
    return rendered.replace("/home/user", str(home_dir))


def _persona_template_with_environment() -> str:
    """The raw CLAUDE.md harness with the shared environment snippet injected —
    the single source of truth both the owner persona and the employee harness
    render from (so the cloud-computer guidance is never duplicated)."""
    template = (CONFIG_TEMPLATE_DIR / "CLAUDE.md").read_text()
    env_snippet = (SHARED_TEMPLATE_DIR / "environment.md").read_text().strip()
    return re.sub(
        r"<!-- BEGIN:environment -->.*?<!-- END:environment -->",
        f"<!-- BEGIN:environment -->\n{env_snippet}\n<!-- END:environment -->",
        template,
        flags=re.DOTALL,
    )


def _render_persona(username: str, home_dir: Path) -> str:
    """Render the CLAUDE.md template into an appended-system-prompt string.

    Same hydration the Cloud path applied (environment snippet + ``{username}``)
    but targeted at the *real* box. Never written to ``~/.claude/CLAUDE.md``.
    """
    return _render_box_template(_persona_template_with_environment(), username, home_dir)


def _scaffold_plugin(home_dir: Path, description: str) -> Path:
    """A fresh, empty plugin dir with its plugin.json — shared scaffolding for
    the persona and employee plugins (rebuilt from scratch so updates propagate)."""
    plugin = claude_plugin_dir(home_dir)
    if plugin.exists():
        shutil.rmtree(plugin)
    (plugin / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (plugin / ".claude-plugin" / "plugin.json").write_text(json.dumps({
        "name": PLUGIN_NAME,
        "version": "0.1.0",
        "description": description,
    }, indent=2))
    return plugin


def _copy_rendered_skills(
    skills_src: Path, destination: Path, username: str,
    only: set[str] | None = None, render=None,
) -> None:
    """Copy + render each skill dir from ``skills_src`` into ``destination``,
    ADDITIVELY (never clears ``destination``, so several sources can be layered).
    ``only`` limits to the named skills; ``render`` transforms each SKILL.md
    (defaults to the plain ``{username}`` hydration used for the owner harness)."""
    if not skills_src.is_dir():
        return
    if render is None:
        render = lambda text: _hydrate(text, username)
    destination.mkdir(parents=True, exist_ok=True)
    for skill_dir in sorted(skills_src.iterdir()):
        if only is not None and skill_dir.name not in only:
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            continue
        dst = destination / skill_dir.name
        shutil.copytree(skill_dir, dst)
        (dst / "SKILL.md").write_text(render(skill_md.read_text()))


def _render_skills(skills_src: Path, destination: Path, username: str) -> None:
    """Render the owner harness skills into the canonical, agent-neutral dir."""
    _remove_artifact(destination)
    _copy_rendered_skills(skills_src, destination, username)


def _copy_canonical_skills(skills_dir: Path, destination: Path) -> None:
    """Copy the already-rendered source of truth into a CLI-specific package."""
    if skills_dir.is_dir():
        shutil.copytree(skills_dir, destination / "skills")


def _build_claude_plugin(home_dir: Path, skills_dir: Path) -> Path:
    """(Re)build the session-only Claude plugin: skills + hooks.

    Loaded with ``--plugin-dir``. Rebuilt from scratch each call so template
    updates propagate; lives entirely under ``~/.shellteam`` — never user dotfiles.
    MCP servers are NOT bundled here — Claude Code doesn't surface a plugin's MCP
    tools to the agent; they go in ``claude-mcp.json`` (loaded via ``--mcp-config``).
    """
    plugin = _scaffold_plugin(home_dir, "ShellTeam agent layer — skills and hooks.")
    _copy_canonical_skills(skills_dir, plugin)

    # Hooks — point at the repo's hook scripts (absolute), wrapped in the plugin
    # hooks.json shape ({ "hooks": { <Event>: [...] } }).
    settings = json.loads((CONFIG_TEMPLATE_DIR / "settings.json").read_text())
    hooks = settings.get("hooks", {})
    hooks_str = json.dumps({"hooks": hooks}).replace(
        "/opt/claude-config", str(CONFIG_TEMPLATE_DIR)
    )
    (plugin / "hooks").mkdir(exist_ok=True)
    (plugin / "hooks" / "hooks.json").write_text(hooks_str)

    return plugin




def _remove_artifact(path: Path) -> None:
    """Delete a layer artifact (file or dir) if present — purity means ABSENT,
    not just unreferenced, so a box downgraded to core actually sheds the layer."""
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _antigravity_mcp_server(config: dict) -> dict | None:
    """Translate the canonical MCP schema into Antigravity's native shape."""
    if "url" in config:
        result = {"serverUrl": config["url"]}
        if config.get("headers"):
            result["headers"] = config["headers"]
        return result
    if "command" in config:
        result = {"command": config["command"]}
        for key in ("args", "env", "cwd"):
            if config.get(key):
                result[key] = config[key]
        return result
    return None


def _build_antigravity_plugin(
    home_dir: Path,
    skills_dir: Path,
    prompt_file: Path,
    mcp_servers: dict,
) -> Path:
    """Build AGY's session-only workspace plugin under ShellTeam's namespace."""
    workspace = antigravity_workspace_dir(home_dir)
    _remove_artifact(workspace)
    plugin = antigravity_plugin_dir(home_dir)
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "plugin.json").write_text(json.dumps({
        "$schema": "https://antigravity.google/schemas/v1/plugin.json",
        "name": PLUGIN_NAME,
        "description": "ShellTeam shared coding-agent harness.",
    }, indent=2))
    _copy_canonical_skills(skills_dir, plugin)

    if prompt_file.is_file():
        rules = plugin / "rules"
        rules.mkdir(exist_ok=True)
        (rules / "shellteam.md").write_text(prompt_file.read_text())

    servers = {
        name: translated
        for name, cfg in mcp_servers.items()
        if (translated := _antigravity_mcp_server(cfg)) is not None
    }
    if servers:
        (plugin / "mcp_config.json").write_text(json.dumps({"mcpServers": servers}, indent=2))
    return workspace


def _symlink_session_home_entry(link: Path, target: Path) -> None:
    """Expose an existing owner-home entry from Codex's ShellTeam-owned overlay.

    RELATIVE symlink, never absolute: the employee home is bind-mounted at a
    different path inside the container (``/home/employee``), so an absolute
    host path would dangle there — silently breaking ``.gitconfig`` (git push
    auth) and ``MEMORY.md`` for Codex sessions. A relative link resolves under
    both roots (target and link always share the home tree)."""
    if link.exists() or link.is_symlink():
        return
    rel = os.path.relpath(target, link.parent)
    link.symlink_to(rel, target_is_directory=target.is_dir())


def _build_codex_session_home(home_dir: Path, skills_dir: Path) -> Path:
    """Build a HOME overlay so Codex discovers the shared skills natively.

    ``CODEX_HOME`` still points at the user's real ``~/.codex`` at launch, so
    auth and their normal Codex configuration remain intact. The overlay changes
    only the discovery location for cockpit-provided skills and lives wholly in
    ``~/.shellteam``.
    """
    session_home = codex_session_home_dir(home_dir)
    _remove_artifact(session_home)
    session_home.mkdir(parents=True, exist_ok=True)

    for entry in home_dir.iterdir():
        if entry.name in {".agents", ".shellteam"}:
            continue
        _symlink_session_home_entry(session_home / entry.name, entry)
    # The shared knowledge and other ShellTeam-owned state keep their usual
    # ``~/.shellteam`` path even while Codex is using the overlay as HOME.
    if (home_dir / ".shellteam").exists():
        _symlink_session_home_entry(session_home / ".shellteam", home_dir / ".shellteam")

    owner_agents = home_dir / ".agents"
    overlay_agents = session_home / ".agents"
    overlay_agents.mkdir(exist_ok=True)
    if owner_agents.is_dir():
        for entry in owner_agents.iterdir():
            if entry.name != "skills":
                _symlink_session_home_entry(overlay_agents / entry.name, entry)

    overlay_skills = overlay_agents / "skills"
    overlay_skills.mkdir(exist_ok=True)
    owner_skills = owner_agents / "skills"
    if owner_skills.is_dir():
        for skill in owner_skills.iterdir():
            _symlink_session_home_entry(overlay_skills / skill.name, skill)
    if skills_dir.is_dir():
        for skill in skills_dir.iterdir():
            destination = overlay_skills / skill.name
            _remove_artifact(destination)
            shutil.copytree(skill, destination)
    return session_home


def build_agent_layer(
    home_dir: Path, username: str, user_id: str = "", email: str = "",
    mcp_servers: dict | None = None,
    modules: frozenset | set | None = None,
) -> dict:
    """(Re)build ShellTeam's launch-layer according to the enabled MODULES.

    Pure core (no modules): every behavior-injecting artifact is REMOVED —
    cockpit agents spawn bit-identical to a hand-run CLI. Each module re-adds
    exactly its own pieces:

      persona  → one shared prompt, skill set, and docs MCP exposed through
                 Claude, Codex, Antigravity, and OpenCode adapters
      browser/composio/linear → their MCP server (all agents)

    OpenCode's config is ALWAYS built: it carries the proxied Fireworks
    provider — credential plumbing without which the OpenCode agent cannot run
    at all. In core mode it contains ONLY the provider block (no MCP, no
    skills, no instructions); this is the one documented core-mode artifact
    (see docs/decisions/20260704-purity-gate-modules.md).

    Idempotent and additive to the USER's config: writes only under
    ``~/.shellteam/agent-layer/`` and finishes by writing the ``layer.json``
    manifest the Node spawners gate on. Never touches user dotfiles.
    """
    if modules is None:
        modules = MODULES
    if mcp_servers is None:
        mcp_servers = canonical_mcp_servers(home_dir, user_id, modules=modules)

    layer_dir(home_dir).mkdir(parents=True, exist_ok=True)
    persona_on = "persona" in modules
    employee_on = False
    plugin_on = persona_on or employee_on

    # Render skills ONCE into the portable harness. Each CLI-specific adapter
    # copies this canonical tree rather than independently rendering templates,
    # which makes the content byte-identical across every cockpit agent.
    skills_dir = harness_skills_dir(home_dir)
    if persona_on:
        _render_skills(CONFIG_TEMPLATE_DIR / "skills", skills_dir, username)
    else:
        _remove_artifact(skills_dir.parent)

    # One rendered prompt is likewise the source of truth. Claude appends the
    # file; Codex receives its contents as an additive developer message;
    # Antigravity loads it as a plugin rule; OpenCode lists the same path as an
    # instruction. 'persona' (owner cockpit) and 'employee' remain exclusive.
    plugin = claude_plugin_dir(home_dir)
    prompt_file = claude_system_prompt_file(home_dir)
    if persona_on:
        prompt_file.write_text(_render_persona(username, home_dir))
    else:
        _remove_artifact(prompt_file)

    # Claude retains its native session-only plugin for hooks; its skills are a
    # verbatim copy of the canonical harness tree above.
    if persona_on:
        plugin = _build_claude_plugin(home_dir, skills_dir)
    else:
        _remove_artifact(plugin)

    # MCP servers — passed to Claude via --mcp-config (the plugin can't surface
    # them; see claude_mcp_config_file). Additive on the user's own MCP config.
    mcp_file = claude_mcp_config_file(home_dir)
    if mcp_servers:
        mcp_file.write_text(json.dumps({"mcpServers": mcp_servers}, indent=2))
    else:
        _remove_artifact(mcp_file)

    # Codex layer — `-c` overrides the cockpit splices in at spawn (no ~/.codex
    # write). The current shared prompt is injected by agent-layer.mjs at launch,
    # so workspace knowledge can be composed consistently across all four CLIs.
    codex_file = codex_overrides_file(home_dir)
    codex_overrides = build_codex_overrides(
        home_dir,
        mcp_servers,
        include_doc_fallback=plugin_on,
    )
    if codex_overrides:
        codex_file.parent.mkdir(parents=True, exist_ok=True)
        codex_file.write_text(json.dumps(codex_overrides, indent=2))
    else:
        _remove_artifact(codex_file)
        _remove_artifact(codex_file.parent)

    # OpenCode layer — config the cockpit points OPENCODE_CONFIG at (merges with
    # the user's own; no ~/.config/opencode write). Provider always; its prompt
    # and skills point at the same canonical harness as the other adapters.
    from api.services.agent_config import _build_opencode_json
    oc_file = opencode_config_file(home_dir)
    oc_file.write_text(_build_opencode_json(
        home_dir, mcp_servers,
        skills_paths=[str(skills_dir)] if plugin_on else [],
        instructions=[str(prompt_file)] if plugin_on else [],
    ))

    # Antigravity accepts native plugins, but only from a global user config or
    # a workspace. We build the latter inside ShellTeam's namespace; the launch
    # adapter passes it through --add-dir, keeping the user's ~/.gemini pristine.
    # Dreaming and Linear can add a prompt/MCP only at runtime for the active
    # workspace, so they also need this otherwise-empty transport plugin.
    runtime_antigravity_transport = bool({"dreaming", "linear"} & set(modules))
    antigravity_on = bool(plugin_on or mcp_servers or runtime_antigravity_transport)
    antigravity_workspace = antigravity_workspace_dir(home_dir)
    if antigravity_on:
        antigravity_workspace = _build_antigravity_plugin(
            home_dir, skills_dir, prompt_file, mcp_servers
        )
    else:
        _remove_artifact(antigravity_workspace)

    # Codex natively discovers skills from $HOME/.agents/skills. Its cockpit-only
    # HOME overlay exposes the canonical skills and symlinks every other owner
    # home entry, while CODEX_HOME continues to point at the real user config.
    codex_session_home = codex_session_home_dir(home_dir)
    if plugin_on:
        codex_session_home = _build_codex_session_home(home_dir, skills_dir)
    else:
        _remove_artifact(codex_session_home)

    manifest = {
        "modules": sorted(modules),
        "artifacts": {
            "claude_plugin": plugin_on,
            "claude_mcp": bool(mcp_servers),
            "claude_system_prompt": plugin_on,
            "codex_overrides": bool(codex_overrides),
            "codex_session_home": plugin_on,
            "harness_skills": plugin_on,
            "antigravity_plugin": antigravity_on,
            "opencode_config": True,
        },
    }
    layer_manifest_file(home_dir).write_text(json.dumps(manifest, indent=2))

    if modules:
        log.info(
            "Built agent-layer at %s (modules=%s; %d MCP servers) — user dotfiles untouched",
            layer_dir(home_dir), sorted(modules), len(mcp_servers),
        )
    else:
        log.info(
            "Agent-layer built in PURE CORE mode at %s — no plugin, no MCP, no "
            "persona; cockpit agents spawn identical to hand-run CLIs (OpenCode "
            "keeps its provider-only config). Enable modules via MODULES= in .env.",
            layer_dir(home_dir),
        )
    return {
        "plugin_dir": str(plugin) if plugin_on else None,
        "system_prompt_file": str(prompt_file) if plugin_on else None,
        "codex_overrides_file": str(codex_file) if codex_overrides else None,
        "codex_session_home": str(codex_session_home) if plugin_on else None,
        "antigravity_workspace": str(antigravity_workspace) if antigravity_on else None,
        "opencode_config_file": str(oc_file),
        "manifest_file": str(layer_manifest_file(home_dir)),
    }
