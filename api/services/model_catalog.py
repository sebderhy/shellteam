"""The model catalog — a thin reader over ``config/models.json``.

``config/models.json`` is the single source of truth for which models the cockpit
offers per coding-agent family (see that file's ``$comment``). The Node cockpit
reads it too (``computer/ai-chat/lib/model-catalog.mjs``). Adding a model — a new
Fireworks or Anthropic release — is a one-line edit there plus a stack restart; no
code change here.

This module derives the two things the *control plane* needs from that catalog:
the Fireworks proxy allowlist and the OpenCode provider block.
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


def opencode_agent() -> dict:
    """The OpenCode/Fireworks family entry, or an empty dict if none is defined."""
    for agent in _agents():
        if agent.get("id") == "opencode":
            return agent
    log.warning("model catalog has no 'opencode' agent — OpenCode disabled")
    return {}


def opencode_default_model() -> str:
    """Short id of OpenCode's default model (e.g. ``glm-5p2``)."""
    agent = opencode_agent()
    default = agent.get("default")
    if default:
        return default
    models = agent.get("models", [])
    return models[0]["id"] if models else ""


def fireworks_allowlist() -> set[str]:
    """Upstream Fireworks model ids the /internal/ai proxy will forward.

    Sourced from every OpenCode model's ``upstream`` field, so allowlisting a new
    Fireworks model is just adding it to the catalog.
    """
    ids = {m["upstream"] for m in opencode_agent().get("models", []) if m.get("upstream")}
    if not ids:
        log.warning("fireworks allowlist is empty — no OpenCode models in catalog")
    return ids


def opencode_provider_models() -> dict:
    """The ``provider.fireworks.models`` block for OpenCode's config, keyed by short id.

    Shape matches what ``@ai-sdk/openai-compatible`` expects: ``{id, name, limit, cost?}``.
    ``cost`` is optional (omitted where we have no verified pricing).
    """
    models: dict = {}
    for m in opencode_agent().get("models", []):
        entry = {"id": m["upstream"], "name": m.get("name", m["id"])}
        if m.get("limit"):
            entry["limit"] = m["limit"]
        if m.get("cost"):
            entry["cost"] = m["cost"]
        models[m["id"]] = entry
    return models
