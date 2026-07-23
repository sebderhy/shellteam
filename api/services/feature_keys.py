"""Feature keys — dashboard-managed API keys for optional capabilities.

Three keys unlock optional features: FIREWORKS_API_KEY (the OpenCode agent via
the server-side proxy), ELEVENLABS_API_KEY (voice input / STT), and
COMPOSIO_API_KEY (the composio module's app connections). Historically they
could only be set by hand-editing ``.env`` over SSH; this service lets the
dashboard Settings UI validate and persist them.

Persistence is two-layered so fireworks/elevenlabs need no restart:
- the ``.env`` file (systemd EnvironmentFile + dotenv) survives restarts;
- ``os.environ`` in THIS process updates immediately, so request-time readers
  (``stt.py``, the fireworks proxy, ``computers.py``'s openCodeAvailable)
  pick the change up on the very next request.

The composio key additionally toggles the ``composio`` entry in the MODULES=
line (pasting the key is the opt-in consent for the module). ``config.MODULES``
and the agent layer are process-start state, so that one reports
``needs_restart=True``.

Key values are NEVER returned by any function here and NEVER logged.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import httpx

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
        return f"Could not reach {provider} to validate the key: {e}"
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


async def validate_composio(key: str) -> str | None:
    # Same REST base + x-api-key auth the composio SDK and
    # composio.get_required_fields() use; /toolkits is a cheap authenticated
    # list (verified: 401 without a valid key).
    return await _probe(
        "https://backend.composio.dev/api/v3/toolkits?limit=1",
        {"x-api-key": key},
        "Composio",
    )


# --- Spec -------------------------------------------------------------------


@dataclass(frozen=True)
class FeatureKey:
    name: str
    env_var: str
    label: str
    validate: Callable[[str], Awaitable[str | None]]
    # True when setting/clearing this key changes process-start state (MODULES,
    # the agent layer) that only a service restart re-reads.
    needs_restart: bool = False
    # The live-capability flag this key unlocks in GET /internal/ai/status
    # (what the cockpit polls). None = the key gates no request-time capability.
    capability: str | None = None
    # The MODULES= entry this key is the opt-in consent for (pasting the key
    # enables the module, clearing it withdraws consent). None = no module.
    module: str | None = None
    # User-facing copy for the Settings row: what the key unlocks + where to
    # get one. Lives here so the registry is the WHOLE truth about a key — the
    # dashboard renders whatever status() returns, no client-side shadow map.
    hint: str = ""
    hint_url: str = ""


FEATURE_KEYS: dict[str, FeatureKey] = {
    "fireworks": FeatureKey(
        name="fireworks",
        env_var="FIREWORKS_API_KEY",
        label="OpenCode coding agent (Fireworks)",
        validate=validate_fireworks,
        capability="opencode",
        hint="Unlocks the OpenCode coding agent on frontier open-source models.",
        hint_url="https://fireworks.ai",
    ),
    "elevenlabs": FeatureKey(
        name="elevenlabs",
        env_var="ELEVENLABS_API_KEY",
        label="Voice input (ElevenLabs)",
        validate=validate_elevenlabs,
        capability="stt",
        hint="Unlocks voice input — dictate to agents from the mic button.",
        hint_url="https://elevenlabs.io",
    ),
    "composio": FeatureKey(
        name="composio",
        env_var="COMPOSIO_API_KEY",
        label="App connections (Composio)",
        validate=validate_composio,
        needs_restart=True,
        module="composio",
        hint="Unlocks app connections (Gmail, Slack, Notion, …) for agents.",
        hint_url="https://composio.dev",
    ),
}


def capability_status() -> dict[str, bool]:
    """Live `{capability: available}` flags for every key that gates one —
    read from os.environ at call time. The single source /internal/ai/status
    serves (never returns key values)."""
    return {
        spec.capability: bool(os.environ.get(spec.env_var))
        for spec in FEATURE_KEYS.values()
        if spec.capability
    }


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


def persist(env_var: str, value: str) -> None:
    """Write ``env_var=value`` to .env AND sync os.environ so request-time
    readers see the change immediately. ``value=''`` clears the key."""
    path = env_file_path()
    if path.exists():
        text = path.read_text()
    else:
        log.warning("feature-keys: %s does not exist — creating it", path)
        text = ""
    path.write_text(_set_env_line(text, env_var, value))
    path.chmod(0o600)
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


def status() -> dict[str, dict]:
    """Set/not-set + display copy per key. NEVER returns key values."""
    return {
        spec.name: {
            "set": bool(os.environ.get(spec.env_var)),
            "label": spec.label,
            "hint": spec.hint,
            "hint_url": spec.hint_url,
        }
        for spec in FEATURE_KEYS.values()
    }


async def set_key(name: str, key: str) -> dict:
    """Validate (unless clearing), persist, and apply side effects for one
    feature key. Returns ``{"set": bool, "needs_restart": bool}``. Raises
    ValueError with a user-facing message on an unknown name or a key the
    provider rejects."""
    spec = FEATURE_KEYS.get(name)
    if spec is None:
        raise ValueError(f"Unknown feature key '{name}' — known: {', '.join(sorted(FEATURE_KEYS))}")

    key = key.strip()
    if key:
        error = await spec.validate(key)
        if error is not None:
            log.warning("feature-keys: validation failed for %s: %s", spec.env_var, error)
            raise ValueError(error)

    persist(spec.env_var, key)

    if spec.module:
        # Pasting a module-gated key is the opt-in consent for its module;
        # clearing it withdraws that consent.
        set_module_enabled(spec.module, enabled=bool(key))

    return {"set": bool(key), "needs_restart": spec.needs_restart}
