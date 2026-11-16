"""The model catalog — a thin reader over ``config/models.json``.

``config/models.json`` is the single source of truth for which models the cockpit
offers per coding-agent family (see that file's ``$comment``). The Node cockpit
reads it too (``computer/ai-chat/lib/model-catalog.mjs``). Adding a model — a new
Fireworks or Anthropic release — is a one-line edit there plus a stack restart; no
code change here.

This module derives the two things the *control plane* needs from that catalog:
the Fireworks proxy allowlist and the Pi provider registration.
"""

import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)

CATALOG_PATH = Path(__file__).parent.parent.parent / "config" / "models.json"


def load_catalog() -> dict:
    """Parse ``config/models.json``. Read fresh each call (cheap) so a rebuilt
    agent-layer picks up catalog edits without a full process restart."""
    return json.loads(CATALOG_PATH.read_text())


def _agents() -> list[dict]:
    return load_catalog().get("agents", [])


def pi_agent() -> dict:
    """The Pi/Fireworks family entry, or an empty dict if none is defined."""
    for agent in _agents():
        if agent.get("id") == "pi":
            return agent
    log.warning("model catalog has no 'pi' agent — Pi disabled")
    return {}


def pi_default_model() -> str:
    """Short id of Pi's default model (e.g. ``glm-5p3``)."""
    agent = pi_agent()
    default = agent.get("default")
    if default:
        return default
    models = agent.get("models", [])
    return models[0]["id"] if models else ""


def fireworks_allowlist() -> set[str]:
    """Upstream Fireworks model ids the /internal/ai proxy will forward.

    Sourced from every Pi model's ``upstream`` field, so allowlisting a new
    Fireworks model is just adding it to the catalog.
    """
    ids = {m["upstream"] for m in pi_agent().get("models", []) if m.get("upstream")}
    if not ids:
        log.warning("fireworks allowlist is empty — no Pi models in catalog")
    return ids


def pi_provider_models() -> list[dict]:
    """The ``provider.models`` list of the Pi launch-layer's ``layer.json``.

    One entry per catalog model: ``{id, name, alias, contextWindow, maxTokens,
    reasoningEffort?, cost?}``. ``id`` is the upstream Fireworks id (what Pi sends
    as ``model``), ``alias`` the catalog's short id. The static extension
    (``computer/pi-layer/shellteam.ts``) maps these onto Pi's own model shape.
    ``cost`` is optional (omitted where we have no verified pricing).
    """
    models: list[dict] = []
    for m in pi_agent().get("models", []):
        limit = m.get("limit", {})
        entry = {
            "id": m["upstream"],
            "name": m.get("name", m["id"]),
            "alias": m["id"],
            "contextWindow": limit.get("context"),
            "maxTokens": limit.get("output"),
        }
        effort = m.get("options", {}).get("reasoningEffort")
        if effort:
            entry["reasoningEffort"] = effort
        if m.get("cost"):
            entry["cost"] = {"input": m["cost"]["input"], "output": m["cost"]["output"]}
        models.append(entry)
    return models
