"""The model catalog (config/models.json) is the single source of truth for the
Fireworks proxy allowlist and OpenCode's provider block. These tests pin the
invariants the control plane relies on."""

import json

from api.services import model_catalog


def test_catalog_file_parses():
    cat = model_catalog.load_catalog()
    ids = [a["id"] for a in cat["agents"]]
    assert ids == ["claude", "codex", "antigravity", "opencode"]


def test_opencode_default_is_glm_5p2():
    assert model_catalog.opencode_default_model() == "glm-5p2"


def test_default_model_is_in_the_opencode_list():
    ids = {m["id"] for m in model_catalog.opencode_agent()["models"]}
    assert model_catalog.opencode_default_model() in ids


def test_allowlist_derives_from_upstream_ids():
    allow = model_catalog.fireworks_allowlist()
    assert "accounts/fireworks/models/glm-5p2" in allow
    # Every allowlisted id is a fully-qualified Fireworks path.
    assert all(x.startswith("accounts/fireworks/models/") for x in allow)


def test_provider_models_shape_matches_allowlist():
    models = model_catalog.opencode_provider_models()
    # Keyed by short id, valued by {id: upstream, name, limit, cost?}.
    assert {m["id"] for m in models.values()} == model_catalog.fireworks_allowlist()
    glm = models["glm-5p2"]
    assert glm["id"] == "accounts/fireworks/models/glm-5p2"
    assert glm["name"] == "GLM 5.2"
    assert glm["limit"]["context"] == 1048576
    # cost is optional and omitted for GLM (no verified pricing) — must not appear.
    assert "cost" not in glm


def test_catalog_is_valid_json_no_trailing_junk():
    # The Node cockpit parses the same file — guard against comments/trailing commas.
    json.loads(model_catalog.CATALOG_PATH.read_text())
