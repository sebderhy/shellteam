"""Static checks on the installer/uninstaller and the templates they render.

The installer has no unit-test seam (it mutates a whole box), but its worst
regressions are statically detectable: shell syntax errors, the systemd
inline-comment .env foot-gun, dropping the post-start verification, and the
nginx symlink-follow hole.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).parent.parent


def _bash_n(script: str) -> None:
    result = subprocess.run(
        ["bash", "-n", str(REPO / script)], capture_output=True, text=True
    )
    assert result.returncode == 0, f"bash -n {script} failed:\n{result.stderr}"


def test_install_sh_parses():
    _bash_n("install.sh")


def test_uninstall_sh_parses():
    _bash_n("uninstall.sh")


@pytest.mark.skipif(shutil.which("shellcheck") is None, reason="shellcheck not installed")
@pytest.mark.parametrize("script", ["install.sh", "uninstall.sh"])
def test_shellcheck(script: str):
    result = subprocess.run(
        ["shellcheck", "--severity=error", str(REPO / script)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"shellcheck {script}:\n{result.stdout}"


def test_env_example_has_no_inline_comments():
    """systemd EnvironmentFile= does not strip inline comments — `KEY=  # note`
    hands the service a garbage non-empty value (silent auth failures)."""
    bad = [
        line
        for line in (REPO / ".env.example").read_text().splitlines()
        if re.match(r"^[A-Z_]+=.*#", line)
    ]
    assert not bad, f".env.example has inline comments on assignments: {bad}"


# Every shipped nginx file-server config must carry the same hardening.
_NGINX_CONFIGS = ["deploy/nginx/shellteam.conf"]


@pytest.mark.parametrize("conf_path", _NGINX_CONFIGS)
def test_nginx_config_disables_symlink_follow(conf_path):
    """Without disable_symlinks, `~/public/x -> /home/user/.ssh` serves the
    target unauthenticated — the dotfile deny only inspects the request path (H3)."""
    conf = (REPO / conf_path).read_text()
    assert "disable_symlinks if_not_owner;" in conf, f"{conf_path} follows symlinks"


@pytest.mark.parametrize("conf_path", _NGINX_CONFIGS)
def test_nginx_home_serving_locations_use_plain_prefix(conf_path):
    """A `^~` prefix suppresses regex-location checking, so the `location ~ /\\.`
    dotfile deny is skipped for `/_ls/.ssh/id_rsa` etc. The locations that alias
    or proxy $HOME (`/_ls/`, `/_files/`) MUST use a plain prefix so the deny still
    applies (M7)."""
    conf = (REPO / conf_path).read_text()
    for loc in ("/_ls/", "/_files/"):
        assert f"location ^~ {loc}" not in conf, f"{conf_path}: `^~ {loc}` suppresses the dotfile deny"


def test_installer_verifies_the_stack_after_start():
    """systemd Type=simple 'starts' a service that crashes on boot; the
    installer must probe /health and per-service ports before claiming success."""
    text = (REPO / "install.sh").read_text()
    assert "verify_stack" in text
    assert "/health" in text
    assert "preflight_ports" in text


def test_installer_never_dies_in_the_optional_browser_step():
    """A Docker hiccup in the opt-out browser module must not abort an install
    whose core stack is already up."""
    text = (REPO / "install.sh").read_text()
    browser_fn = text.split("provision_browser()")[1].split("\n}")[0]
    assert not re.search(r'\bdie "', browser_fn), "provision_browser must warn+skip, never die"


def test_installer_installs_the_shared_context7_mcp_binary():
    """Every agent receives Context7 in the shared harness, so native installs
    must also provide the executable used by its stdio MCP configuration."""
    text = (REPO / "install.sh").read_text()
    assert 'install_cli context7-mcp "@upstash/context7-mcp"' in text


def test_plan_flag_is_a_pure_dry_run():
    """--plan prints the mutation manifest and exits 0 before touching anything.
    Flags shape the plan (sudoers only with --create-owner, Caddy only with
    --remote) without triggering their side effects — --create-owner normally
    refuses to run without root, but under --plan it only prints."""
    r = _run_install("--plan")
    assert r.returncode == 0
    assert "nothing has been changed" in r.stdout
    assert "sudoers.d" not in r.stdout
    assert "caddy" not in r.stdout

    r2 = _run_install("--plan", "--create-owner", "bob", "--full", "--remote")
    assert r2.returncode == 0
    assert "/etc/sudoers.d/bob" in r2.stdout
    # Default plan: the grant is install-time only; --keep-sudo shows the
    # permanent NOPASSWD rule instead.
    assert "removed when it finishes" in r2.stdout
    assert "NOPASSWD" not in r2.stdout
    r3 = _run_install("--plan", "--create-owner", "bob", "--keep-sudo")
    assert r3.returncode == 0
    assert "NOPASSWD" in r3.stdout and "--keep-sudo" in r3.stdout
    assert "caddy" in r2.stdout
    assert "shellteam-dream" in r2.stdout  # --full enables the dreaming module


def test_third_party_installer_scripts_are_checksum_pinned():
    """Scripts fetched from the network must be sha256-verified before they run
    (the NodeSource one runs as root): no `curl | bash` pipes for those hosts,
    and every script goes through fetch_pinned_installer with a pinned hash."""
    text = (REPO / "install.sh").read_text()
    for domain in ("deb.nodesource.com", "astral.sh", "antigravity.google"):
        for line in text.splitlines():
            if domain in line and re.search(r"\|\s*(sudo\s+-?\S*\s+)?(bash|sh)\b", line):
                raise AssertionError(
                    f"unpinned pipe-to-shell for {domain}: {line.strip()}"
                )
    for url_var, sha_var in [
        ("NODESOURCE_SETUP_URL", "NODESOURCE_SETUP_SHA256"),
        ("UV_INSTALL_URL", "UV_INSTALL_SHA256"),
        ("ANTIGRAVITY_INSTALL_URL", "ANTIGRAVITY_INSTALL_SHA256"),
    ]:
        assert f'fetch_pinned_installer "${url_var}" "${sha_var}"' in text, url_var
        assert re.search(rf'^{url_var}="https://\S+"$', text, re.M), url_var
        assert re.search(rf"^{sha_var}=[0-9a-f]{{64}}$", text, re.M), sha_var


def test_uv_installer_url_is_an_immutable_versioned_artifact():
    """Regression, 2026-08-03: uv was pinned against https://astral.sh/uv/install.sh,
    which always serves *latest*. When Astral shipped 0.12.1 the hash stopped
    matching and EVERY fresh install died on the mismatch guard — including
    customer boxes, which install from a release tag and so could not be fixed
    without a new one.

    A "latest" URL plus a sha256 is a contradiction: it guarantees a break on the
    next upstream release. Pin the versioned release artifact, which is immutable,
    so the hash stays true until we deliberately bump it."""
    text = (REPO / "install.sh").read_text()

    version = re.search(r"^UV_VERSION=(\S+)$", text, re.M)
    assert version, "UV_VERSION constant missing"
    url = re.search(r'^UV_INSTALL_URL="(\S+)"$', text, re.M)
    assert url, "UV_INSTALL_URL constant missing"

    assert "astral.sh/uv/install.sh" not in text, (
        "uv is pinned to a mutable 'latest' installer URL again — pin the "
        "versioned release artifact instead"
    )
    assert "$UV_VERSION" in url.group(1), (
        f"uv installer URL is not version-scoped: {url.group(1)}"
    )


def test_create_owner_reexec_forwards_the_unpinned_escape_hatch():
    """Regression, 2026-08-03: --create-owner re-execs the installer as the owner
    with `su -`, a LOGIN shell, which wipes the environment. So
    SHELLTEAM_ALLOW_UNPINNED_INSTALLERS — the escape hatch our own mismatch error
    tells operators to use — was silently dropped on the one path that provisions
    every customer box. Setting it appeared to work and then failed with the
    identical mismatch.

    Anything operator-facing must be forwarded explicitly across the re-exec."""
    text = (REPO / "install.sh").read_text()
    reexec = re.search(r"^\s*su - .*install\.sh.*$", text, re.M)
    assert reexec, "the --create-owner su re-exec line moved or changed shape"
    # `exec env VAR=… ./install.sh`, never `exec VAR=… ./install.sh`: bash rejects
    # an assignment as exec's command ("exec: VAR=…: not found"), so the plain
    # form dropped every forwarded variable and killed the re-exec outright
    # (found by fresh-box QA on 2026-09-07, the first run with one actually set).
    assert "exec env ${env_fwd}./install.sh" in reexec.group(0), (
        "su - re-exec does not forward operator env vars through `env`: "
        + reexec.group(0).strip()
    )
    shape = subprocess.run(
        ["bash", "-c", 'f="X=1 "; exec env ${f}sh -c \'echo ok-$X\''],
        capture_output=True, text=True,
    )
    assert shape.stdout.strip() == "ok-1", shape.stderr
    assert re.search(
        r'env_fwd\+="SHELLTEAM_ALLOW_UNPINNED_INSTALLERS=1 "', text
    ), "the unpinned escape hatch is not in the forwarded env list"


def test_plan_quotes_the_installer_urls_it_actually_fetches():
    """--plan is the executable FOOTPRINT, so it must not carry its own copy of
    the URLs: the pinned constants are defined above print_plan precisely so the
    two cannot drift (the stale-copy failure mode that broke the uv pin)."""
    text = (REPO / "install.sh").read_text()
    plan_start = text.index("print_plan() {")
    for var in ("NODESOURCE_SETUP_URL", "UV_INSTALL_URL", "ANTIGRAVITY_INSTALL_URL"):
        assert text.index(f"{var}=") < plan_start, (
            f"{var} is defined after print_plan, so --plan would print it empty"
        )
        assert f"$" + var in text[plan_start:], f"--plan does not reference ${var}"


def test_installer_installs_the_antigravity_cli_the_registry_launches():
    """The registry invokes `agy`, so a fresh native install cannot provision
    only the retired Gemini CLI and leave Antigravity unavailable."""
    text = (REPO / "install.sh").read_text()
    assert "install_agy" in text
    assert "https://antigravity.google/cli/install.sh" in text
    assert "install_cli gemini" not in text


# ── Fresh-box QA findings (install-qa-report, 2026-07-15) ─────────────────────


def _run_install(*args):
    return subprocess.run(
        ["bash", str(REPO / "install.sh"), *args],
        capture_output=True,
        text=True,
    )


def test_create_owner_requires_root():
    """F1: --create-owner mutates the system (adduser/sudoers/linger), so it must
    refuse to run unless it's actually root — the guard fires before any change."""
    r = _run_install("--create-owner", "shellteam")
    assert r.returncode == 1
    assert "must be run as root" in r.stderr


def test_create_owner_requires_a_username():
    """F1: a bare --create-owner with no name is a usage error, not a silent no-op."""
    r = _run_install("--create-owner")
    assert r.returncode == 1
    assert "requires a username" in (r.stderr + r.stdout)


def test_create_owner_validates_username_and_forwards_other_flags():
    """F1: bootstrap_owner must reject shell-unsafe usernames and re-exec the
    installer as the new user with every OTHER flag forwarded (the --create-owner
    pair dropped)."""
    text = (REPO / "install.sh").read_text()
    fn = text.split("bootstrap_owner() {")[1].split('\nif [ -n "$CREATE_OWNER"')[0]
    assert "^[a-z_][a-z0-9_-]" in fn, "username charset must be validated"
    # both spellings of the flag are skipped when reconstructing forwarded args
    assert "--create-owner)" in fn and "--create-owner=*)" in fn
    assert 'su - "$user" -c' in fn, "must re-run the installer as the new owner"


def test_create_owner_sudo_is_install_time_only_unless_kept():
    """A --create-owner user is the user every agent runs as. Leaving passwordless
    sudo behind made any agent action root; on a shared box that was the whole
    blast radius. The grant now lives only for the install run (the re-exec'd
    child), is removed when it returns, and --keep-sudo is the explicit opt-out."""
    text = (REPO / "install.sh").read_text()
    fn = text.split("bootstrap_owner() {")[1].split('\nif [ -n "$CREATE_OWNER"')[0]
    assert "exec su - " not in fn, "exec would lose the root shell that revokes the grant"
    after_su = fn.split('su - "$user" -c', 1)[1]
    assert 'rm -f "/etc/sudoers.d/$user"' in after_su
    assert 'if [ "${KEEP_SUDO:-0}" != 1 ]; then' in after_su
    assert 'exit "$rc"' in after_su
    assert "--keep-sudo)     KEEP_SUDO=1 ;;" in text
    # The child run is told it was bootstrapped so its closing note gives the
    # root re-run recipe (its own sudo is about to disappear).
    assert "SHELLTEAM_OWNER_BOOTSTRAP=" in fn
    assert "sudo ./install.sh --create-owner ${SHELLTEAM_OWNER_BOOTSTRAP} <flags>" in text


def test_docker_group_is_the_browser_modules_consent_not_bootstraps():
    """Docker-socket access is root-equivalent, so --create-owner no longer adds
    the owner to the docker group for existing. Only the browser module does,
    and it runs docker through `dk` (sudo fallback) so the same install run
    still works before the group lands."""
    text = (REPO / "install.sh").read_text()
    fn = text.split("bootstrap_owner() {")[1].split('\nif [ -n "$CREATE_OWNER"')[0]
    assert "usermod" not in fn and "docker" not in fn
    browser = text.split("provision_browser() {")[1].split("\nif [ \"$WITH_BROWSER\"")[0]
    assert "ensure_docker_group" in browser
    for verb in ("pull", "rm -f", "run -d", "logs --tail"):
        assert f"dk {verb}" in browser, f"docker {verb} must go through dk"
    assert "\n    docker " not in browser and "! docker " not in browser
    assert 'sudo usermod -aG docker "$(id -un)"' in text


def test_create_owner_never_replaces_or_recursively_chowns_a_live_checkout():
    text = (REPO / "install.sh").read_text()
    fn = text.split("bootstrap_owner() {")[1].split('\nif [ -n "$CREATE_OWNER"')[0]
    assert 'rm -rf "$dest"' not in fn
    assert 'frontend/dashboard.html' in fn and 'pyproject.toml' in fn
    assert "stat -c '%u'" in fn
    existing_branch = fn.split('if [ -e "$dest" ]; then', 1)[1].split("else", 1)[0]
    assert "chown -R" not in existing_branch
    direct_clone_branch = fn.split("# Root cloned straight into the owner's home", 1)[1]
    assert 'if [ "$dest_uid" = "$user_uid" ]; then' in direct_clone_branch
    assert 'elif [ "$dest_uid" = "0" ]; then' in direct_clone_branch


def test_installer_uses_locked_reproducible_dependency_installs():
    text = (REPO / "install.sh").read_text()
    assert '"$UV" sync --frozen' in text
    assert "uv pip install -e" not in text
    assert "npm ci --omit=dev" in text


def test_installer_leaves_existing_clis_untouched_and_installs_latest():
    """Coding-agent CLIs are deliberately NOT version-pinned (new models need
    new CLIs — docs/decisions/20260719-release-qa-hardening.md); an existing
    user-managed CLI is never replaced."""
    text = (REPO / "install.sh").read_text()
    for package in (
        "@anthropic-ai/claude-code",
        "@openai/codex",
        "opencode-ai",
        "@upstash/context7-mcp",
    ):
        assert f'"{package}"' in text, f"{package} must be installed"
        assert f'"{package}" "' not in text, f"{package} must not carry a version pin"
    assert "leaving it untouched" in text


def test_installer_is_additive_to_shell_profiles():
    """Third-party installers (uv, Antigravity) must run under the dotfile
    guard: any profile edit is reverted loudly (docs/FOOTPRINT.md)."""
    text = (REPO / "install.sh").read_text()
    assert "UV_NO_MODIFY_PATH=1" in text
    assert "run_preserving_dotfiles()" in text
    assert 'run_preserving_dotfiles "The uv installer"' in text
    assert 'run_preserving_dotfiles "The Antigravity installer"' in text
    for profile in (".bashrc", ".profile", ".bash_profile", ".zshrc"):
        assert profile in text


def test_browser_module_is_pinned_and_probes_a_real_session():
    text = (REPO / "install.sh").read_text()
    # Tag+digest form: the digest pins, the tag documents where it came from.
    assert "ghcr.io/steel-dev/steel-browser:latest@sha256:" in text
    assert "--shm-size=1g" in text
    # The session probe targets the configurable STEEL_PORT (default 3877 —
    # deliberately off :3000, which belongs to the user's own dev servers).
    assert 'http://127.0.0.1:$STEEL_PORT/v1/sessions' in text
    assert 'prev_steel_port:-3877' in text
    # --no-start must not pull the image or start the container.
    assert "--no-start: skipping Steel browser provisioning" in text


def test_installer_relocates_privileged_ports_to_unprivileged_space():
    """F3: a FILE_PORT :80 conflict must relocate to >=1024 (no setcap needed),
    not to :81 which is still privileged and would fail identically."""
    text = (REPO / "install.sh").read_text()
    fn = text.split("autopick_port() {")[1].split("\n}")[0]
    assert 'if [ "$cur" -lt 1024 ]; then next=8080' in fn


def test_installer_frames_llm_keys_as_optional_not_required():
    """F4: subscription sign-in is the recommended path; the installer must not
    tell a fresh box its agents "can't run" merely because no API key is set."""
    text = (REPO / "install.sh").read_text()
    assert "can't run yet" not in text
    assert "no API key needed" in text


def test_install_md_tab_count_matches_dashboard():
    """F2: INSTALL.md's dashboard check must match the static tab buttons."""
    actual = (REPO / "frontend/dashboard.html").read_text().count('<button class="tab')
    install = (REPO / "INSTALL.md").read_text()
    claims = re.findall(r"grep -c '<button class=\"tab'.*?#\s*→\s*(\d+)", install)
    assert claims, "INSTALL.md should assert an expected data-tab count"
    for n in claims:
        assert int(n) == actual, f"INSTALL.md claims {n} tabs; dashboard has {actual}"


# ── Interactive first-run questions (access mode + install depth) ──────────────


def _probed_installer(tmp_path):
    """A copy of install.sh that exits right after the first-run questions,
    printing the chosen state — so tests exercise the REAL chooser logic
    without letting the install proceed to apt/systemd."""
    text = (REPO / "install.sh").read_text()
    anchor = '    [ -z "$REQUESTED_MODULES" ] && choose_install_depth\nfi\n'
    assert anchor in text, "chooser call anchor moved — update this test"
    probe = (
        anchor
        + 'echo "PROBE MODE=$PUBLIC_MODE DOMAIN=${PUBLIC_DOMAIN:-none}'
        + ' TS=$TAILSCALE_HINT MODS=${REQUESTED_MODULES:-none}"; exit 0\n'
    )
    script = tmp_path / "install.sh"
    script.write_text(text.replace(anchor, probe, 1))
    script.chmod(0o755)
    return script


def _run_probed(script, *args, stdin=""):
    # subprocess pipes = no TTY, exactly how CI and coding agents run it
    return subprocess.run(
        ["bash", str(script), *args],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=script.parent,
        timeout=30,
    )


def test_noninteractive_install_never_prompts(tmp_path):
    """CI / coding agents pipe stdin (no TTY): the chooser must not fire and the
    install must proceed with the localhost default."""
    r = _run_probed(_probed_installer(tmp_path))
    assert "How will you access" not in r.stdout + r.stderr
    assert "PROBE MODE=none" in r.stdout


def test_mode_flags_skip_the_chooser(tmp_path):
    """--remote / --minimal / --full already answer a question — no prompt for
    it even on a fresh box (and non-TTY never prompts at all)."""
    script = _probed_installer(tmp_path)
    r = _run_probed(script, "--remote")
    assert "How will you access" not in r.stdout + r.stderr
    assert "PROBE MODE=sslip" in r.stdout
    r = _run_probed(script, "--minimal")
    assert "PROBE MODE=none" in r.stdout and "MODS=none" in r.stdout
    r = _run_probed(script, "--full")
    assert "MODS=persona,browser,dreaming" in r.stdout


def test_rerun_with_existing_env_never_prompts(tmp_path):
    """Re-runs (the .env exists) must stay silent — the chooser is first-run only."""
    script = _probed_installer(tmp_path)
    (tmp_path / ".env").write_text("MODULES=\n")
    r = _run_probed(script)
    assert "How will you access" not in r.stdout + r.stderr
    assert "PROBE MODE=none" in r.stdout


def test_interactive_chooser_maps_choices_to_modes(tmp_path):
    """On a real TTY both first-run questions fire and map: access Enter→private
    (localhost + the Tailscale hint), 2→sslip, 3→domain (read from the prompt);
    depth Enter→pure core, 2→persona+browser+dreaming."""
    import pty

    script = _probed_installer(tmp_path)

    def run_tty(stdin: str) -> str:
        import os

        master, slave = pty.openpty()
        proc = subprocess.Popen(
            ["bash", str(script)],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=script.parent,
        )
        os.close(slave)
        os.write(master, stdin.encode())
        out = b""
        try:
            while chunk := os.read(master, 4096):
                out += chunk
        except OSError:
            pass  # EIO when the child closes the pty — normal EOF on Linux
        proc.wait(timeout=30)
        os.close(master)
        return out.decode(errors="replace")

    out = run_tty("\n\n")
    assert "How will you access" in out and "Which install?" in out
    assert "PROBE MODE=none" in out and "TS=1" in out and "MODS=none" in out
    out = run_tty("2\n2\n")
    assert "PROBE MODE=sslip" in out and "TS=0" in out and "MODS=persona,browser,dreaming" in out
    out = run_tty("3\nexample.com\n1\n")
    assert "PROBE MODE=domain DOMAIN=example.com" in out


def test_nginx_mask_is_guarded_by_existing_service_check():
    """Regression (field report 2026-07-17): install.sh masked the system
    nginx.service unconditionally — on a box whose operator already ran nginx
    on :80/:443, their site would silently fail to come back on reboot. The
    mask may only apply when no nginx is active or enabled before install."""
    text = (REPO / "install.sh").read_text()
    guard = text.index("is-active --quiet nginx.service")
    mask = text.index("systemctl mask nginx.service")
    assert guard < mask, "the mask must sit behind the existing-nginx guard"
    assert "is-enabled --quiet nginx.service" in text, "enabled-but-stopped nginx must also be left alone"


def test_log_helpers_are_defined_before_the_arg_loop():
    """Regression: the arg loop runs at parse time and --experimental calls
    warn(); with log/warn/die defined after the loop, `./install.sh
    --experimental` died with 'warn: command not found' under set -e."""
    text = (REPO / "install.sh").read_text()
    helpers = text.index('warn() {')
    arg_loop = text.index('while [ $# -gt 0 ]; do')
    assert helpers < arg_loop, "log/warn/die must be defined before the arg-parse loop"


_USER_MANAGER_DROPIN = 'user@$(id -u).service.d/shellteam-restart.conf'


def test_installer_makes_the_user_manager_restart_on_exit():
    """The whole stack lives under user@UID.service. Linger keeps that manager
    alive without a login but does NOT restart it if it exits, and a broadcast
    signal (`kill -1`, a broad pkill from any of the owner's processes) makes it
    exit via exit.target: every unit stopped until a human logged in (3.5h
    outage, 2026-09-07). The installer must write a system drop-in that restarts
    the manager unconditionally, and actually call it."""
    text = (REPO / "install.sh").read_text()
    definition, after = text.split("harden_user_manager()", 1)
    body = after.split("\n}")[0]
    assert _USER_MANAGER_DROPIN in body
    for directive in ("Restart=always", "StartLimitIntervalSec=0"):
        assert directive in body, f"drop-in lacks {directive}"
    assert re.search(r"^\s*harden_user_manager\s*$", after, re.M), "defined but never called"


def test_uninstaller_removes_the_user_manager_dropin():
    """The drop-in is the one root-owned file that is purely ours (Tier 3 in
    docs/FOOTPRINT.md), so uninstall.sh must reverse it at the very path
    install.sh writes."""
    assert _USER_MANAGER_DROPIN in (REPO / "uninstall.sh").read_text()
