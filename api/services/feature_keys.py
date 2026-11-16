"""ShellTeam's own keys: the API keys that turn on its optional features.

FIREWORKS_API_KEY (the Pi agent through the server-side proxy),
ELEVENLABS_API_KEY (voice in and out), COMPOSIO_API_KEY (app connections) and
LINEAR_API_KEY (Linear for agents). They are kept in Settings -> Secrets with
every other key (the vault); the settings router checks a pasted one with its
provider (``check``) and puts it to work (``apply``).

A key reaches its feature two ways at once:
- ShellTeam's ``.env`` (systemd EnvironmentFile + dotenv) survives restarts;
- ``os.environ`` in THIS process updates immediately, so request-time readers
  (``stt.py``, the fireworks proxy, the MCP relay) use it on the next request.

Composio and Linear are modules: pasting the key is the opt-in consent and
adds the module to MODULES=, clearing it removes it. ``config.MODULES`` and
the agent layer are process-start state, so turning one on or off needs a
restart; replacing the key of a module already on does not.

Key values are NEVER returned by any function here and NEVER logged.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from api.services import stt

log = logging.getLogger(__name__)

# The .env the whole stack reads: systemd units use EnvironmentFile=@REPO@/.env
# and api/main.py calls load_dotenv() from the repo root. SHELLTEAM_ENV_FILE
# overrides for hermetic tests / throwaway instances.
_REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATE_TIMEOUT = 10.0


def env_file_path() -> Path:
    return Path(os.environ.get("SHELLTEAM_ENV_FILE", str(_REPO_ROOT / ".env")))


# --- Validators -------------------------------------------------------------
# Each returns None when the key is valid, or a precise, user-facing error
# string. Network/HTTP failures are a system boundary here — they become error
# strings (the POST route turns them into a 400), never a 500 traceback.


async def _probe(
    url: str, headers: dict[str, str], provider: str
) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=VALIDATE_TIMEOUT) as client:
            resp = await client.get(url, headers=headers)
    except httpx.HTTPError as e:
        # Never the exception text: httpx quotes the offending header, i.e. the key.
        return f"Could not reach {provider} to validate the key ({type(e).__name__})."
    if resp.status_code == 200:
        return None
    if resp.status_code in (401, 403):
        return f"{provider} rejected this key (HTTP {resp.status_code}) — check that you pasted a valid key."
    return f"{provider} validation failed (HTTP {resp.status_code})."


async def validate_fireworks(key: str) -> str | None:
    return await _probe(
        "https://api.fireworks.ai/inference/v1/models",
        {"Authorization": f"Bearer {key}"},
        "Fireworks",
    )


async def validate_elevenlabs(key: str) -> str | None:
    return await _probe(
        "https://api.elevenlabs.io/v1/user",
        {"xi-api-key": key},
        "ElevenLabs",
    )


# Composio issues several key kinds; only a project key (ak_) drives the SDK and
# REST API the composio module uses. The others are valid keys for other doors,
# so "rejected" would send the owner looking for a typo (SHE-137).
COMPOSIO_WRONG_KEY_KINDS = {
    "ck_": "a Composio Connect key (it only works for Composio's own hosted assistant link)",
    "uak_": "a Composio user key (from `composio login`)",
}
COMPOSIO_PROJECT_KEY_HELP = (
    "ShellTeam needs a project API key, which starts with ak_. In the Composio "
    "dashboard: switch to Platform, pick your project, then Settings -> API Keys."
)


async def validate_composio(key: str) -> str | None:
    for prefix, kind in COMPOSIO_WRONG_KEY_KINDS.items():
        if key.startswith(prefix):
            return f"This is {kind}. {COMPOSIO_PROJECT_KEY_HELP}"
    # Same REST base + x-api-key auth the composio SDK and
    # composio.get_required_fields() use; /toolkits is a cheap authenticated
    # list (verified: 401 without a valid key).
    return await _probe(
        "https://backend.composio.dev/api/v3/toolkits?limit=1",
        {"x-api-key": key},
        "Composio",
    )


async def validate_linear(key: str) -> str | None:
    # A personal API key goes bare in Authorization for Linear's GraphQL API.
    try:
        async with httpx.AsyncClient(timeout=VALIDATE_TIMEOUT) as client:
            resp = await client.post("https://api.linear.app/graphql", json={"query": "{ viewer { id } }"},
                                     headers={"Authorization": key})
    except httpx.HTTPError as e:
        return f"Could not reach Linear to validate the key ({type(e).__name__})."
    if resp.status_code == 200 and "errors" not in resp.json():
        return None
    if resp.status_code in (400, 401, 403) or resp.status_code == 200:
        return "Linear rejected this key. Use a personal API key: Linear, Settings, Security & access."
    return f"Linear validation failed (HTTP {resp.status_code})."


# --- Spec -------------------------------------------------------------------


@dataclass(frozen=True)
class FeatureKey:
    name: str
    env_var: str
    label: str
    validate: Callable[[str], Awaitable[str | None]]
    # The live-capability flags this key unlocks in GET /internal/ai/status
    # (what the cockpit polls). Empty = the key gates no request-time
    # capability. One key can gate several: ElevenLabs is both ears and voice.
    capabilities: tuple[str, ...] = ()
    # The MODULES= entry this key is the opt-in consent for (pasting the key
    # enables the module, clearing it withdraws consent). None = no module.
    module: str | None = None
    # User-facing copy for the Settings row: what the key unlocks + where to
    # get one. Lives here so the registry is the WHOLE truth about a key — the
    # dashboard renders whatever status() returns, no client-side shadow map.
    hint: str = ""
    hint_url: str = ""
    # How the key starts, so Settings can name a pasted key by itself.
    prefixes: tuple[str, ...] = ()


FEATURE_KEYS: dict[str, FeatureKey] = {
    "fireworks": FeatureKey(
        name="fireworks",
        env_var="FIREWORKS_API_KEY",
        label="Pi coding agent (Fireworks)",
        validate=validate_fireworks,
        capabilities=("pi",),
        hint="Unlocks the Pi coding agent on frontier open-source models.",
        hint_url="https://fireworks.ai",
    ),
    "elevenlabs": FeatureKey(
        name="elevenlabs",
        env_var="ELEVENLABS_API_KEY",
        label="Voice in and out (ElevenLabs)",
        validate=validate_elevenlabs,
        capabilities=("stt", "tts"),
        hint="Unlocks voice input from the mic button, and spoken agent replies.",
        hint_url="https://elevenlabs.io",
    ),
    "composio": FeatureKey(
        name="composio",
        env_var="COMPOSIO_API_KEY",
        label="App connections (Composio)",
        validate=validate_composio,
        module="composio",
        prefixes=("ak_",),
        hint="Unlocks app connections (Gmail, Slack, Notion, …) for agents. "
        "Use a project API key (starts with ak_): Platform, your project, Settings -> API Keys.",
        hint_url="https://dashboard.composio.dev",
    ),
    "linear": FeatureKey(
        name="linear",
        env_var="LINEAR_API_KEY",
        label="Linear for agents",
        validate=validate_linear,
        module="linear",
        prefixes=("lin_api_",),
        hint="Lets agents read and file Linear issues. A project can have its own key in its .env.",
        hint_url="https://linear.app/settings/account/security",
    ),
}


def capability_status() -> dict[str, bool]:
    """Live `{capability: available}` flags for every key that gates one —
    read from os.environ at call time. The single source /internal/ai/status
    serves (never returns key values)."""
    flags = {
        capability: bool(os.environ.get(spec.env_var))
        for spec in FEATURE_KEYS.values()
        for capability in spec.capabilities
    }
    # Managed boxes transcribe through the relay with no ElevenLabs key on disk
    # (stt.transcribe's second source) — the mic must show for them too.
    flags["stt"] = flags["stt"] or stt.relay_configured()
    return flags


# --- .env persistence -------------------------------------------------------


def _set_env_line(text: str, var: str, value: str) -> str:
    """Update-or-append ``var=value`` in .env text, preserving every other
    line and comment exactly. No inline comments on the assignment line —
    systemd EnvironmentFile= doesn't strip them."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith(f"{var}="):
            lines[i] = f"{var}={value}"
            return "\n".join(lines)
    # Append, keeping exactly one trailing newline.
    if lines and lines[-1] == "":
        lines[-1] = f"{var}={value}"
        lines.append("")
    else:
        lines.append(f"{var}={value}")
        lines.append("")
    return "\n".join(lines)


def _atomic_write_private(path: Path, text: str) -> None:
    """Write via a 0600 temp file and rename, so .env is never half-written or
    briefly readable by others."""
    import tempfile

    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def persist(env_var: str, value: str) -> None:
    """Write ``env_var=value`` to .env AND sync os.environ so request-time
    readers see the change immediately. ``value=''`` clears the key."""
    path = env_file_path()
    if path.exists():
        text = path.read_text()
    else:
        log.warning("feature-keys: %s does not exist — creating it", path)
        text = ""
    _atomic_write_private(path, _set_env_line(text, env_var, value))
    if value:
        os.environ[env_var] = value
        log.info("feature-keys: %s set (persisted to %s + live in os.environ)", env_var, path)
    else:
        os.environ.pop(env_var, None)
        log.info("feature-keys: %s cleared (persisted to %s + removed from os.environ)", env_var, path)


def _read_modules(text: str) -> list[str]:
    from api.config import parse_modules

    for line in text.split("\n"):
        if line.startswith("MODULES="):
            return parse_modules(line[len("MODULES="):])
    return []


def set_module_enabled(module: str, enabled: bool) -> bool:
    """Add/remove ``module`` in the .env MODULES= line. Returns True when the
    line actually changed. Takes effect at next service start (config.MODULES
    and the agent layer are process-start state)."""
    path = env_file_path()
    text = path.read_text() if path.exists() else ""
    modules = _read_modules(text)
    if enabled == (module in modules):
        return False
    if enabled:
        modules.append(module)
    else:
        modules = [m for m in modules if m != module]
    path.write_text(_set_env_line(text, "MODULES", ",".join(modules)))
    path.chmod(0o600)
    log.warning(
        "feature-keys: module '%s' %s in %s MODULES= (now: %s) — takes effect after "
        "`systemctl --user restart shellteam-api shellteam-ai-chat`",
        module, "ENABLED" if enabled else "DISABLED", path, ",".join(modules) or "(none)",
    )
    return True


# --- Public API (used by the settings router) --------------------------------
# ShellTeam's own keys are kept in Settings -> Secrets with every other key
# (the vault); this module says which names they are, checks a pasted one with
# its provider, and applies it to ShellTeam.


def by_env_var(name: str) -> FeatureKey | None:
    return next((spec for spec in FEATURE_KEYS.values() if spec.env_var == name), None)


def suggestions() -> list[dict]:
    """ShellTeam's own keys, in the shape of the vault's suggestions."""
    return [{"name": spec.env_var, "service": spec.label, "group": "ShellTeam", "url": spec.hint_url,
             "hint": spec.hint, **({"prefixes": list(spec.prefixes)} if spec.prefixes else {})}
            for spec in FEATURE_KEYS.values()]


async def check(spec: FeatureKey, key: str) -> str | None:
    """Why ``key`` can't be used for ``spec``, or None. Never quotes the key."""
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in key):
        # A line break inside a key would add a line to .env (any variable,
        # even OWNER_TOKEN) and leaked the key in the validator's error (SHE-148).
        return "This key contains a line break or a control character. Paste it on one line."
    error = await spec.validate(key)
    if error is not None:
        log.warning("feature-keys: validation failed for %s: %s", spec.env_var, error)
    return error


def apply(spec: FeatureKey, key: str) -> dict:
    """Put ``key`` (or nothing, ``""``) to work in ShellTeam: .env and this
    process at once, and its module on or off. Returns a result row for
    Settings: ``{"target": "ShellTeam", "ok", "detail"}``."""
    persist(spec.env_var, key)
    changed = bool(spec.module) and set_module_enabled(spec.module, enabled=bool(key))
    what = spec.label
    if changed:
        detail = (f"{what} turns {'on' if key else 'off'} after a restart: Settings, then Restart ShellTeam.")
    elif key:
        detail = f"{what}: in use now."
    else:
        detail = f"{what}: off."
    return {"target": "ShellTeam", "ok": True, "detail": detail}
