"""Contract tests for scripts/mirror-inventory.sh (Environment Mirror).

The script's promise is a security contract with two tiers:

- DEFAULT mode (shareable tarball): whitelist-only staging, credential files
  never staged, secret-looking lines redacted, secret *locations* mapped.
- --stage mode (import-wizard engine): everything above PLUS opt-in `secure/`
  sections (agent logins, MCP tokens, chat history) staged unredacted — they
  only ever travel on a direct TLS upload to the user's own box, and --pack
  must keep them out of any selection that doesn't ask for them.

These tests run the real script against a planted fake HOME and inspect what
it produces.
"""

import ast
import json
import os
import re
import subprocess
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "mirror-inventory.sh"
WIZARD = SCRIPT.parent / "mirror-import.sh"

# Realistic-shaped fakes, assembled at runtime so the release residue scanner
# (make-public-snapshot.sh) never sees a secret-shaped literal in this source.
FAKE_OPENAI_KEY = "sk-" + "abcdefghijklmnopqrstuvwxyz123456"
FAKE_GITHUB_PAT = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
FAKE_OAUTH_TOKEN = "fake-oauth-refresh-token-do-not-leak"
PRIVATE_KEY = "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nhunter2material\n-----END OPENSSH " + "PRIVATE KEY-----\n"


def build_fake_home(home: Path) -> None:
    """A laptop HOME with both safe config and planted secrets/credentials."""
    # A secrets-manager CLI on the PATH (the Infisical/Doppler case: secrets
    # live in a service, not in files — the box needs the CLI + one login).
    bin_dir = home / "bin"
    bin_dir.mkdir()
    fake_cli = bin_dir / "infisical"
    fake_cli.write_text("#!/bin/sh\necho infisical 0.31.0\n")
    fake_cli.chmod(0o755)
    (home / ".zshrc").write_text(
        "alias gs='git status'\n"
        f"export OPENAI_API_KEY={FAKE_OPENAI_KEY}\n"
        "export EDITOR=vim\n"
    )
    (home / ".gitconfig").write_text("[user]\n  name = Test User\n")
    (home / ".bash_history").write_text("cd code/myrepo\ngit push\n")
    ssh = home / ".ssh"
    ssh.mkdir()
    (ssh / "config").write_text("Host myserver\n  HostName example.com\n")
    (ssh / "id_rsa").write_text(PRIVATE_KEY)
    claude = home / ".claude"
    claude.mkdir()
    (claude / "CLAUDE.md").write_text("# My global instructions\n")
    (claude / ".credentials.json").write_text('{"token": "%s"}' % FAKE_GITHUB_PAT)
    project = claude / "projects" / "-home-test-myrepo"
    (project / "memory").mkdir(parents=True)
    (project / "memory" / "MEMORY.md").write_text("# Project memory\n- prefers pytest\n")
    (project / "session-abc.jsonl").write_text('{"role": "user", "content": "private chat"}\n')
    (claude / "settings.json").write_text(json.dumps({
        "model": "opus",
        "env": {"MY_SERVICE_TOKEN": FAKE_GITHUB_PAT},
    }))
    (home / ".claude.json").write_text(json.dumps({
        "oauthAccount": {"refreshToken": FAKE_OAUTH_TOKEN},
        "mcpServers": {
            "context7": {"command": "npx", "args": ["context7"]},
            "private-api": {
                "url": "https://mcp.example.com",
                "headers": {"Authorization": f"Bearer {FAKE_OPENAI_KEY}"},
            },
        },
    }))
    codex = home / ".codex"
    codex.mkdir()
    (codex / "config.toml").write_text('model = "gpt-5.6-codex"\n')
    (codex / "auth.json").write_text(json.dumps({"tokens": {"refresh_token": FAKE_OAUTH_TOKEN}}))
    session_dir = codex / "sessions" / "2026" / "07" / "26"
    session_dir.mkdir(parents=True)
    (session_dir / "rollout-1.jsonl").write_text('{"type": "message", "text": "codex private chat"}\n')
    (codex / "history.jsonl").write_text('{"text": "codex prompt history"}\n')
    aws = home / ".aws"
    aws.mkdir()
    (aws / "credentials").write_text("[default]\naws_secret_access_key = shh\n")
    repo = home / "code" / "myrepo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(
        ["git", "remote", "add", "origin", "git@github.com:test/myrepo.git"],
        cwd=repo, check=True,
    )
    (repo / ".env").write_text(f"GITHUB_TOKEN={FAKE_GITHUB_PAT}\n")


def run_script(home: Path, *args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = {"HOME": str(home), "PATH": f"{home}/bin:/usr/bin:/bin:/usr/local/bin", **(env_extra or {})}
    result = subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, f"script failed:\n{result.stdout}\n{result.stderr}"
    return result


def read_tarball(path: Path) -> dict:
    with tarfile.open(path) as tf:
        return {
            m.name.lstrip("./"): (tf.extractfile(m).read().decode() if m.isfile() else None)
            for m in tf.getmembers()
        }


@pytest.fixture(scope="module")
def mirror(tmp_path_factory):
    """DEFAULT mode: build a fake HOME, run the script, return the tarball."""
    home = tmp_path_factory.mktemp("fake-home")
    build_fake_home(home)
    run_script(home)
    tarballs = list(home.glob("shellteam-mirror-*.tar.gz"))
    assert len(tarballs) == 1, f"expected exactly one tarball, got {tarballs}"
    return read_tarball(tarballs[0])


@pytest.fixture(scope="module")
def staged(tmp_path_factory):
    """--stage mode (wizard engine): returns (stage_dir, {relpath: content})."""
    home = tmp_path_factory.mktemp("fake-home-stage")
    build_fake_home(home)
    stage = tmp_path_factory.mktemp("stage") / "s"
    run_script(home, "--stage", str(stage))
    contents = {}
    for path in stage.rglob("*"):
        if path.is_file():
            contents[str(path.relative_to(stage))] = path.read_text()
    return stage, contents


# ── Default (shareable) tarball: the v1 secrets-never-travel contract ─────────

def test_whitelisted_files_staged(mirror):
    assert "dotfiles/.gitconfig" in mirror
    assert "dotfiles/.ssh/config" in mirror
    assert "agents/claude/CLAUDE.md" in mirror
    assert "manifest.json" in mirror
    manifest = json.loads(mirror["manifest.json"])
    assert manifest["os"] == "Linux"


def test_credential_files_never_staged(mirror):
    names = set(mirror)
    assert not any("id_rsa" in n for n in names)
    assert not any(".credentials" in n for n in names)
    assert not any("auth.json" in n for n in names)
    assert not any("aws" in n.lower() and "credentials" in n for n in names)


def test_default_tarball_has_no_secure_sections(mirror):
    """Credentials, chat history, and shell history are wizard-only opt-ins:
    a default (shareable) tarball must never contain a secure/ member."""
    assert not any(n.startswith("secure/") for n in mirror)
    assert not any("session-abc" in n for n in mirror)
    assert not any("rollout-1" in n for n in mirror)
    assert not any("bash_history" in n for n in mirror)


def test_no_secret_value_anywhere_in_archive(mirror):
    """The strongest claim: no planted secret survives, in any staged file."""
    blob = "\n".join(body for body in mirror.values() if body)
    assert FAKE_OPENAI_KEY not in blob
    assert FAKE_GITHUB_PAT not in blob
    assert FAKE_OAUTH_TOKEN not in blob
    assert "hunter2material" not in blob


def test_zshrc_redacted_but_kept(mirror):
    zshrc = mirror["dotfiles/.zshrc"]
    assert "alias gs=" in zshrc, "non-secret lines must survive"
    assert "REDACTED" in zshrc, "the key line must be visibly redacted"
    assert "dotfiles/.zshrc" in mirror["redactions.txt"]


def test_mcp_servers_extracted_without_tokens(mirror):
    extracted = json.loads(mirror["agents/claude/mcp-servers.json"])
    assert "context7" in extracted["mcpServers"]
    assert "oauthAccount" not in mirror["agents/claude/mcp-servers.json"]


def test_redacted_json_stays_parseable(mirror):
    """Regression (found in the container e2e run): line-wise redaction used to
    corrupt JSON files. Scrubbed JSON must stay valid, with only the secret
    values replaced."""
    mcp = json.loads(mirror["agents/claude/mcp-servers.json"])
    auth = mcp["mcpServers"]["private-api"]["headers"]["Authorization"]
    assert FAKE_OPENAI_KEY not in auth
    assert "REDACTED" in auth
    assert mcp["mcpServers"]["private-api"]["url"] == "https://mcp.example.com"

    settings = json.loads(mirror["agents/claude/settings.json"])
    assert settings["model"] == "opus", "non-secret values must survive"
    assert "REDACTED" in settings["env"]["MY_SERVICE_TOKEN"]


def test_project_memory_staged_transcripts_never(mirror):
    """Auto-memory travels (it's half of what makes the agent 'yours');
    session transcripts never do (in the default tarball)."""
    mem = mirror["agents/claude/project-memory/-home-test-myrepo/MEMORY.md"]
    assert "prefers pytest" in mem
    assert "private chat" not in "\n".join(b for b in mirror.values() if b)


def test_secrets_map_lists_locations_only(mirror):
    secrets_map = mirror["SECRETS-MAP.md"]
    assert "~/.aws/credentials" in secrets_map
    assert "id_rsa" in secrets_map
    assert "code/myrepo/.env (project env file: recreate by hand)" in secrets_map


def test_repos_listed_with_remotes(mirror):
    assert "code/myrepo\tgit@github.com:test/myrepo.git" in mirror["repos.tsv"]


def test_secrets_manager_cli_detected(mirror):
    """Infisical/Doppler-style users have no key files to move — the mirror
    must record the CLI so the box installs it and asks for ONE login instead
    of walking the user through .env recreation."""
    assert "infisical" in mirror["packages/secrets-managers.txt"]
    assert "infisical" in mirror["SECRETS-MAP.md"]
    assert "log in ONCE" in mirror["SECRETS-MAP.md"]


def test_secrets_manager_detection_is_idempotent_on_a_reused_stage_dir(tmp_path):
    """secrets-managers.txt is append-built; --stage into the same dir twice
    (mkdir -p, no emptiness check) must not duplicate the entries."""
    home = tmp_path / "home"
    home.mkdir()
    build_fake_home(home)
    stage = tmp_path / "stage"
    run_script(home, "--stage", str(stage))
    run_script(home, "--stage", str(stage))
    lines = (stage / "packages" / "secrets-managers.txt").read_text().splitlines()
    assert lines == ["infisical"]


# ── --stage mode: the wizard engine and its secure/ opt-in sections ───────────

def test_stage_collects_agent_logins_intact(staged):
    """The whole point of the logins section: credentials arrive usable."""
    _stage, files = staged
    creds = json.loads(files["secure/logins/claude/credentials.json"])
    assert creds["token"] == FAKE_GITHUB_PAT
    oauth = json.loads(files["secure/logins/claude/oauth-account.json"])
    assert oauth["oauthAccount"]["refreshToken"] == FAKE_OAUTH_TOKEN
    codex = json.loads(files["secure/logins/codex/auth.json"])
    assert codex["tokens"]["refresh_token"] == FAKE_OAUTH_TOKEN


def test_stage_collects_mcp_with_auth_intact(staged):
    """secure/ MCP copy keeps tokens; the shareable agents/ copy stays scrubbed."""
    _stage, files = staged
    secure_mcp = json.loads(files["secure/logins/mcp/mcp-servers.json"])
    assert secure_mcp["mcpServers"]["private-api"]["headers"]["Authorization"] == f"Bearer {FAKE_OPENAI_KEY}"
    safe_mcp = json.loads(files["agents/claude/mcp-servers.json"])
    assert FAKE_OPENAI_KEY not in json.dumps(safe_mcp)


def test_stage_collects_chat_history_for_both_agents(staged):
    _stage, files = staged
    assert "private chat" in files["secure/history/claude/projects/-home-test-myrepo/session-abc.jsonl"]
    assert "codex private chat" in files["secure/history/codex/sessions/2026/07/26/rollout-1.jsonl"]
    assert "codex prompt history" in files["secure/history/codex/history.jsonl"]


def test_stage_collects_shell_history(staged):
    _stage, files = staged
    assert "git push" in files["secure/shell-history/.bash_history"]


def test_stage_collects_env_files_at_repo_path(staged):
    """Project .env CONTENTS travel (opt-in), staged at their repo path so the
    box drops them back — the safe alternative to pasting keys into an agent."""
    _stage, files = staged
    env = files["secure/env/code/myrepo/.env"]
    assert f"GITHUB_TOKEN={FAKE_GITHUB_PAT}" in env, "the real value must survive (secure/ is redaction-exempt)"


def test_env_never_in_default_or_saved_tarball(mirror):
    """Same rule as the other secure sections: a shareable tarball has no .env
    values — the whole reason .env is direct-upload-only."""
    assert not any(n.startswith("secure/env") for n in mirror)
    assert FAKE_GITHUB_PAT not in "\n".join(b for b in mirror.values() if b)


def test_stage_still_scrubs_safe_sections(staged):
    """secure/ is exempt from redaction; everything else is NOT."""
    _stage, files = staged
    assert "REDACTED" in files["dotfiles/.zshrc"]
    assert FAKE_OPENAI_KEY not in files["agents/claude/mcp-servers.json"]
    assert not any("id_rsa" in n for n in files), "ssh keys never travel, even staged"


def test_stage_writes_summary(staged):
    _stage, files = staged
    summary = json.loads(files["summary.json"])
    s = summary["sections"]
    assert s["logins"]["claude"] and s["logins"]["codex"] and s["logins"]["mcp"]
    assert s["history"]["claude_files"] >= 1 and s["history"]["codex_files"] >= 2
    assert s["repos"]["count"] == 1
    assert s["shell-history"]["present"]
    assert s["env"]["present"] and s["env"]["files"] >= 1


def test_manifest_survives_a_tool_printing_control_characters(tmp_path_factory):
    """A real WSL `docker --version` printed an ANSI escape; the manifest became
    unparseable JSON, the redaction pass deleted it as unscrubbable, and the
    wizard died on a missing manifest.json. Any tool output must stay contained.
    """
    home = tmp_path_factory.mktemp("fake-home-ctrl")
    build_fake_home(home)
    docker = home / "bin" / "docker"
    docker.write_text('#!/bin/sh\nprintf \'\\033[1mDocker version 28.0.1\\r\\n\'\n')
    docker.chmod(0o755)
    stage = tmp_path_factory.mktemp("stage-ctrl") / "s"
    run_script(home, "--stage", str(stage))

    manifest = json.loads((stage / "manifest.json").read_text())
    assert "Docker version 28.0.1" in manifest["tools"]["docker"]
    assert not any(ord(c) < 0x20 for c in manifest["tools"]["docker"])
    assert (stage / "summary.json").exists(), "the wizard's summary must be written"


def test_oauth_account_staged_when_the_login_lives_in_a_keystore(tmp_path_factory):
    """No ~/.claude/.credentials.json (Windows Credential Manager, or signed
    out) must not swallow the account identity: secure/logins/ did not exist
    yet, so the extraction's redirect failed with a raw shell error."""
    home = tmp_path_factory.mktemp("fake-home-keystore")
    build_fake_home(home)
    (home / ".claude" / ".credentials.json").unlink()
    stage = tmp_path_factory.mktemp("stage-keystore") / "s"
    result = run_script(home, "--stage", str(stage))

    account = stage / "secure" / "logins" / "claude" / "oauth-account.json"
    assert account.exists(), "the logged-in account must still be recorded"
    assert "oauthAccount" in json.loads(account.read_text())
    assert "No such file or directory" not in result.stderr


def test_inventories_a_home_other_than_the_callers(tmp_path_factory):
    """WSL: the user's real work lives in the Windows profile (/mnt/c/Users/X),
    not the Linux $HOME. Pointing HOME at it must inventory that tree."""
    other = tmp_path_factory.mktemp("windows-profile")
    build_fake_home(other)
    stage = tmp_path_factory.mktemp("stage-other") / "s"
    run_script(other, "--stage", str(stage))

    assert "myrepo" in (stage / "repos.tsv").read_text()
    assert (stage / "secure" / "env" / "code" / "myrepo" / ".env").exists()
    assert (stage / "agents" / "claude" / "CLAUDE.md").exists()


def test_home_flag_scans_the_given_profile_not_the_callers(tmp_path_factory):
    """`--home DIR` (what the wizard's folder question passes) must scan DIR
    while HOME points elsewhere, survive a trailing slash, and find repos in
    Windows-profile conventions like GitHub Desktop's Documents/GitHub.

    The repo here is a PHANTOM (.git exists but is not a valid repository) on
    purpose: `git status` exits 128 on it, which under pipefail used to kill
    the whole inventory — such repos must be listed, not fatal."""
    caller = tmp_path_factory.mktemp("caller-home")
    build_fake_home(caller)
    win = tmp_path_factory.mktemp("windows-profile-flag")
    repo = win / "Documents" / "GitHub" / "winapp"
    (repo / ".git").mkdir(parents=True)
    (repo / ".env").write_text("API_KEY=win-secret\n")
    stage = tmp_path_factory.mktemp("stage-home-flag") / "s"
    run_script(caller, "--stage", str(stage), "--home", str(win) + "/")

    repo_paths = [line.split("\t")[0] for line in (stage / "repos.tsv").read_text().splitlines()]
    assert "Documents/GitHub/winapp" in repo_paths
    assert (stage / "secure" / "env" / "Documents" / "GitHub" / "winapp" / ".env").exists()
    # The caller's own home must not leak into the scan.
    assert "code/myrepo" not in repo_paths
    manifest = json.loads((stage / "manifest.json").read_text())
    assert manifest["home"] == str(win)


def test_history_cap_prunes_everything_at_zero(tmp_path_factory):
    """MIRROR_MAX_HISTORY_MB bounds the upload; at 0 nothing is collected."""
    home = tmp_path_factory.mktemp("fake-home-cap")
    build_fake_home(home)
    stage = tmp_path_factory.mktemp("stage-cap") / "s"
    run_script(home, "--stage", str(stage), env_extra={"MIRROR_MAX_HISTORY_MB": "0"})
    assert not any((stage / "secure" / "history").rglob("*.jsonl"))


# ── --pack mode: selection is the boundary ────────────────────────────────────

def test_pack_without_secure_sections_excludes_them(staged, tmp_path):
    stage, _files = staged
    out = tmp_path / "safe.tar.gz"
    run_script(stage.parent, "--pack", str(stage), "--sections", "packages,dotfiles,repos,agents", "--out", str(out))
    contents = read_tarball(out)
    assert not any(n.startswith("secure/") for n in contents)
    assert "dotfiles/.gitconfig" in contents
    assert "repos.tsv" in contents
    blob = "\n".join(b for b in contents.values() if b)
    assert FAKE_OPENAI_KEY not in blob and FAKE_OAUTH_TOKEN not in blob


def test_pack_with_selected_secure_sections_includes_only_those(staged, tmp_path):
    stage, _files = staged
    out = tmp_path / "direct.tar.gz"
    run_script(stage.parent, "--pack", str(stage), "--sections", "dotfiles,logins", "--out", str(out))
    contents = read_tarball(out)
    assert "secure/logins/claude/credentials.json" in contents
    assert not any(n.startswith("secure/history/") for n in contents), "unticked sections must not ride along"
    assert not any(n.startswith("secure/shell-history/") for n in contents)
    assert not any(n.startswith("secure/env/") for n in contents), "unticked .env must not ride along"
    assert oct(os.stat(out).st_mode & 0o777) == "0o600"


def test_secrets_map_says_a_staged_env_was_placed_not_recreated(staged):
    """SECRETS-MAP.md ships in every archive, so it must not tell the box agent
    to walk the user through recreating a file whose values are sitting in
    secure/env/ — that's a pointless interrogation about secrets already in
    hand, and it makes the map's own "contents are not copied" claim false."""
    _stage, files = staged
    assert "code/myrepo/.env (project env file: values staged in secure/env/" in files["SECRETS-MAP.md"]
    assert "recreate by hand" not in files["SECRETS-MAP.md"]


def _wizard_sections() -> list[str]:
    """The section ids the wizard offers (mirror-import.sh's two lists)."""
    text = WIZARD.read_text()
    names = []
    for var in ("SAFE_SECTIONS", "SECURE_SECTIONS"):
        match = re.search(rf"^{var} = (\[[^\]]*\])", text, re.M)
        assert match, f"{var} not found in {WIZARD.name}"
        names += ast.literal_eval(match.group(1))
    return names


def _packer_sections() -> list[str]:
    """The section ids --pack knows how to resolve (section_paths' case arms)."""
    body = re.search(r"section_paths\(\) \{(.*?)\n\}", SCRIPT.read_text(), re.S)
    assert body, "section_paths() not found"
    return re.findall(r"^\s*([a-z-]+)\)\s+echo", body.group(1), re.M)


def test_wizard_and_packer_agree_on_the_section_list(staged, tmp_path):
    """The wizard's checkboxes and the packer's section_paths are two halves of
    one contract, edited in different files. A section the wizard offers but the
    packer can't resolve aborts the upload with "unknown section"; one the packer
    knows but the wizard never shows can never travel. Pack each for real."""
    offered, packable = _wizard_sections(), _packer_sections()
    assert sorted(offered) == sorted(packable)
    stage, _files = staged
    for name in offered:
        run_script(stage.parent, "--pack", str(stage), "--sections", name,
                   "--out", str(tmp_path / f"{name}.tar.gz"))


def test_pack_env_section_included_only_when_selected(staged, tmp_path):
    stage, _files = staged
    out = tmp_path / "with-env.tar.gz"
    run_script(stage.parent, "--pack", str(stage), "--sections", "repos,env", "--out", str(out))
    contents = read_tarball(out)
    assert "secure/env/code/myrepo/.env" in contents
    assert not any(n.startswith("secure/logins/") for n in contents)


def test_pack_rejects_unknown_section(staged, tmp_path):
    stage, _files = staged
    result = subprocess.run(
        ["bash", str(SCRIPT), "--pack", str(stage), "--sections", "ssh-keys", "--out", str(tmp_path / "x.tar.gz")],
        env={"HOME": str(stage.parent), "PATH": "/usr/bin:/bin:/usr/local/bin"},
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode != 0
