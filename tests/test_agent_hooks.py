"""Tests for the Claude Code hook scripts shipped in the agent layer
(computer/claude-config/hooks/).

The PreToolUse sanitize hook must strip the metered coding-agent credentials
(so a child ``claude -p`` / ``codex exec`` spawned from Bash can never silently
run on the owner's API key: the $575 lesson, see
docs/decisions/20260710-ai-employees-product.md) while LEAVING the box's own
service credentials intact: SHELLTEAM_AI_TOKEN and SHELLTEAM_USER_ID are the
documented auth for the /internal/ai and ports APIs, and the layer's own
content (the stt skill, the persona's ports section) teaches curl commands
that pass them. Unsetting them broke those workflows with empty credentials.
"""

import json
import os
import subprocess
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent.parent / "computer" / "claude-config" / "hooks"
SANITIZE_HOOK = HOOKS_DIR / "sanitize-bash.sh"


def run_sanitize_hook(command: str) -> dict:
    """Feed a Bash tool call through the PreToolUse hook, as Claude Code would."""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    result = subprocess.run(
        ["bash", str(SANITIZE_HOOK)],
        input=payload, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def run_sanitized_command(command: str, env_overrides: dict[str, str]) -> str:
    """Execute the hook-rewritten command in a shell with the given env,
    returning stdout. This exercises the actual runtime behavior (which vars
    survive the unset prefix), not just the rewritten string."""
    updated = run_sanitize_hook(command)["hookSpecificOutput"]["updatedInput"]["command"]
    env = {"PATH": os.environ["PATH"], **env_overrides}
    result = subprocess.run(
        ["bash", "-c", updated], capture_output=True, text=True, env=env, check=True
    )
    return result.stdout


SENSITIVE_ENV = {
    "ANTHROPIC_API_KEY": "sk-ant-metered",
    "CLAUDE_CODE_OAUTH_TOKEN": "oauth-metered",
    "SHELLTEAM_AI_TOKEN": "st-ai-token",
    "SHELLTEAM_USER_ID": "st-user-id",
}

PROBE = 'echo "ai=[$SHELLTEAM_AI_TOKEN] uid=[$SHELLTEAM_USER_ID] key=[$ANTHROPIC_API_KEY] oauth=[$CLAUDE_CODE_OAUTH_TOKEN]"'


def test_sanitize_strips_metered_agent_credentials():
    """Child agent CLIs spawned from Bash must not inherit the owner's metered
    Anthropic credentials (they would silently bill the API key)."""
    stdout = run_sanitized_command(PROBE, SENSITIVE_ENV)
    assert "key=[]" in stdout
    assert "oauth=[]" in stdout


def test_sanitize_preserves_shellteam_service_credentials():
    """Regression (would fail on the old hook): SHELLTEAM_AI_TOKEN and
    SHELLTEAM_USER_ID must survive: the stt skill and the persona's ports
    section instruct curl calls that authenticate with exactly these vars."""
    stdout = run_sanitized_command(PROBE, SENSITIVE_ENV)
    assert "ai=[st-ai-token]" in stdout
    assert "uid=[st-user-id]" in stdout


def test_sanitize_handles_empty_command():
    payload = json.dumps({"tool_name": "Bash", "tool_input": {}})
    result = subprocess.run(
        ["bash", str(SANITIZE_HOOK)],
        input=payload, capture_output=True, text=True, check=True,
    )
    assert json.loads(result.stdout) == {}


def test_layer_content_and_hook_agree_on_service_credentials():
    """The contract behind the regression: every env var the layer's own
    skills/persona teach the agent to pass in a Bash command must NOT be in the
    hook's unset list. Catches reintroduction under a new name."""
    hook_text = SANITIZE_HOOK.read_text()
    unset_lines = [
        line for line in hook_text.splitlines() if line.startswith("UNSET_PREFIX=")
    ]
    assert len(unset_lines) == 1
    templates_dir = Path(__file__).resolve().parent.parent / "computer" / "claude-config"
    taught_vars = set()
    for md in [templates_dir / "CLAUDE.md", *templates_dir.glob("skills/*/SKILL.md")]:
        for var in ("SHELLTEAM_AI_TOKEN", "SHELLTEAM_USER_ID"):
            if f"${var}" in md.read_text():
                taught_vars.add(var)
    assert taught_vars, "expected the layer content to teach the service credentials"
    for var in taught_vars:
        assert var not in unset_lines[0], (
            f"sanitize-bash.sh unsets {var}, but the layer's own content "
            "teaches Bash commands that authenticate with it"
        )
