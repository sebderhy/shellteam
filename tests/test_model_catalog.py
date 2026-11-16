"""The model catalog (config/models.json) is the single source of truth for the
Fireworks proxy allowlist and Pi's provider registration. These tests pin the
invariants the control plane relies on."""

import json

from api.services import model_catalog


def test_catalog_file_parses():
    cat = model_catalog.load_catalog()
    ids = [a["id"] for a in cat["agents"]]
    assert ids == ["claude", "codex", "antigravity", "pi"]


def test_pi_default_is_glm_5p3():
    assert model_catalog.pi_default_model() == "glm-5p3"


def test_default_model_is_in_the_pi_list():
    ids = {m["id"] for m in model_catalog.pi_agent()["models"]}
    assert model_catalog.pi_default_model() in ids


def test_allowlist_derives_from_upstream_ids():
    allow = model_catalog.fireworks_allowlist()
    assert "accounts/fireworks/models/glm-5p3" in allow
    # Every allowlisted id is a fully-qualified Fireworks path.
    assert all(x.startswith("accounts/fireworks/models/") for x in allow)


def test_provider_models_shape_matches_allowlist():
    models = model_catalog.pi_provider_models()
    # A list of {id: upstream, name, alias, contextWindow, maxTokens, reasoningEffort?, cost?}.
    assert {m["id"] for m in models} == model_catalog.fireworks_allowlist()
    assert [m["alias"] for m in models] == [m["id"] for m in model_catalog.pi_agent()["models"]]
    glm = models[0]
    assert glm["id"] == "accounts/fireworks/models/glm-5p3"
    assert glm["name"] == "GLM 5.3"
    assert glm["contextWindow"] == 1048576
    # Pi gets the model's real output ceiling: no clamp.
    assert glm["maxTokens"] == 131072
    assert glm["reasoningEffort"] == "max"
    assert glm["cost"] == {"input": 1.4, "output": 4.4}


def test_every_pi_model_is_fully_specified():
    """A Fireworks model added without ``cost`` still bills the owner's key, but
    the cockpit's spend readout has nothing to multiply and shows $0.00 — a
    silently wrong number, which is worse than no number. ``upstream`` and
    ``limit.context`` are equally load-bearing: the first is what the proxy
    allowlists, the second is what the context meter measures against.
    """
    for m in model_catalog.pi_agent()["models"]:
        assert m["upstream"].startswith("accounts/fireworks/models/"), m["id"]
        assert m["limit"]["context"] > 0, m["id"]
        assert m["limit"]["output"] > 0, m["id"]
        assert m["cost"]["input"] > 0 and m["cost"]["output"] > 0, m["id"]


def test_catalog_is_valid_json_no_trailing_junk():
    # The Node cockpit parses the same file — guard against comments/trailing commas.
    json.loads(model_catalog.CATALOG_PATH.read_text())
