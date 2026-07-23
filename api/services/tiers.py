"""Feature config for ShellTeam OSS.

Single-user, single tier: the owner gets every feature. The tier machinery is
kept (as a thin shim) only so existing call sites keep working without churn.
"""

OWNER_FEATURES: dict = {
    "coo_model": "claude-opus-4-8",
}


def get_tier_features(tier: str | None = None) -> dict:
    """Return the owner feature set. Tier argument is ignored (always all-true)."""
    return dict(OWNER_FEATURES)
