"""Company LLM gateway, seen from the Python side (dreaming).

Mirrors ``gatewayFor`` / ``applyGatewayVars`` in computer/ai-chat/lib/session.mjs:
same Settings files, same .env variables, same precedence, so a headless run
goes exactly where the cockpit's agents go. A gateway entered in Settings wins
over .env; a base URL with no token is ignored and stripped, so a subscription
login never travels to a third-party host. See
docs/decisions/20260925-company-llm-gateway.md.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Family:
    settings_file: str
    url_var: str
    token_var: str
    token_vars: tuple[str, ...]
    key_file: str  # the Settings API key, a token the .env gateway may use


_FAMILIES = {
    "claude": _Family("claude-gateway.json", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
                      ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"), "api-key"),
    "codex": _Family("openai-gateway.json", "OPENAI_BASE_URL", "OPENAI_API_KEY",
                     ("OPENAI_API_KEY",), "openai-api-key"),
}


@dataclass(frozen=True)
class Gateway:
    base_url: str
    token: str
    token_var: str
    source: str  # "settings" | "env"


def _config_dir(home: Path) -> Path:
    return home / ".config" / "shellteam"


def _read_text(path: Path) -> str:
    return path.read_text().strip() if path.exists() else ""


def gateway_for(family: str, home: Path, environ: dict[str, str]) -> Gateway | None:
    fam = _FAMILIES[family]
    settings = _config_dir(home) / fam.settings_file
    if settings.exists():
        saved = json.loads(settings.read_text())
        if saved.get("baseUrl") and saved.get("token"):
            return Gateway(saved["baseUrl"], saved["token"], fam.token_var, "settings")
    url = environ.get(fam.url_var, "").strip()
    if not url:
        return None
    key_file = _read_text(_config_dir(home) / fam.key_file)
    for var in fam.token_vars:
        # The Settings key file wins over .env for the API key, as in session.mjs.
        token = key_file if var == fam.token_vars[-1] and key_file else environ.get(var, "").strip()
        if token:
            return Gateway(url.rstrip("/"), token, var, "env")
    log.warning("%s is set but no gateway token is: ignoring the gateway. Set %s too.",
                fam.url_var, " or ".join(fam.token_vars))
    return None


def apply_gateway(env: dict[str, str], family: str, home: Path) -> Gateway | None:
    """Point ``env`` at the family's gateway, or strip every gateway variable."""
    fam = _FAMILIES[family]
    gateway = gateway_for(family, home, env)
    env.pop(fam.url_var, None)
    if family == "claude":
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
    if gateway:
        for var in fam.token_vars:
            env.pop(var, None)
        env[fam.url_var] = gateway.base_url
        env[gateway.token_var] = gateway.token
    return gateway


def codex_provider_overrides(base_url: str) -> list[str]:
    """Codex's provider block for a gateway, as ``-c`` values (the same ones
    codexProviderOverrides in computer/ai-chat/lib/agent-layer.mjs emits)."""
    return [
        'model_provider="openai-api"',
        'model_providers.openai-api.name="OpenAI API"',
        f"model_providers.openai-api.base_url={json.dumps(base_url)}",
        'model_providers.openai-api.env_key="OPENAI_API_KEY"',
    ]
