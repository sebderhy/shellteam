"""Secrets vault (SHE-135): the owner's API keys, entered once, used by every agent
without the values ever passing through a chat trace.

The owner pastes keys in Settings -> Secrets (or ``shellteam-secrets set`` in a
terminal). Agents only ever handle NAMES:

- ``write``: puts named secrets into an app's env file. The value goes straight
  from the vault into the file and never reaches stdout.
- ``run``: runs one command with named secrets in its environment and masks
  their values in its output (for pushing a key to a CLI such as vercel).

Every ``write`` (and ``run --remember``) is recorded as a *use*, so replacing a
key rewrites every file that holds it, restarts the app units registered with
it, and re-runs the remembered commands: one paste rotates everything.

What this protects against: keys leaking into transcripts, AI provider logs and
screenshots. What it does not: anyone with a shell as the owner (or root) can
read the vault file, like any secret on the same machine. See
docs/decisions/20261105-secrets-vault.md.

Stdlib only: ``bin/shellteam-secrets`` imports this module with the system
python, outside the API's virtualenv. Values are never logged.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

log = logging.getLogger(__name__)

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
UNIT_RE = re.compile(r"^[A-Za-z0-9@_.:-]{1,200}$")
# Values shorter than this are not masked: masking "abc" would shred output.
MIN_MASK_LEN = 8
# A value is written to an env file unquoted only when it is plainly safe.
_BARE_VALUE_RE = re.compile(r"^[A-Za-z0-9_\-./+=:@~,%]*$")
COMMAND_TIMEOUT = 120


# Common keys, with the name apps conventionally read them under and the page
# where each is created (links checked 2026-11-05). Shown in Settings -> Secrets
# so a non-developer knows what to fetch, and in the CLI's "missing key" error.
SUGGESTIONS: list[dict] = [
    # AI models
    {"name": "OPENAI_API_KEY", "service": "OpenAI", "group": "AI", "url": "https://platform.openai.com/api-keys", "hint": "starts with sk-", "prefixes": ["sk-proj-", "sk-"]},
    {"name": "ANTHROPIC_API_KEY", "service": "Anthropic (Claude)", "group": "AI", "url": "https://platform.claude.com/settings/keys", "hint": "starts with sk-ant-", "prefixes": ["sk-ant-"]},
    {"name": "GEMINI_API_KEY", "service": "Google Gemini", "group": "AI", "url": "https://aistudio.google.com/apikey", "hint": "", "prefixes": ["AIza"]},
    {"name": "OPENROUTER_API_KEY", "service": "OpenRouter", "group": "AI", "url": "https://openrouter.ai/settings/keys", "hint": "starts with sk-or-", "prefixes": ["sk-or-"]},
    {"name": "MISTRAL_API_KEY", "service": "Mistral", "group": "AI", "url": "https://console.mistral.ai/api-keys", "hint": ""},
    {"name": "GROQ_API_KEY", "service": "Groq", "group": "AI", "url": "https://console.groq.com/keys", "hint": "starts with gsk_", "prefixes": ["gsk_"]},
    {"name": "REPLICATE_API_TOKEN", "service": "Replicate", "group": "AI", "url": "https://replicate.com/account/api-tokens", "hint": "starts with r8_", "prefixes": ["r8_"]},
    {"name": "FAL_KEY", "service": "fal.ai", "group": "AI", "url": "https://fal.ai/dashboard/keys", "hint": ""},
    {"name": "HF_TOKEN", "service": "Hugging Face", "group": "AI", "url": "https://huggingface.co/settings/tokens", "hint": "starts with hf_", "prefixes": ["hf_"]},
    {"name": "ELEVENLABS_API_KEY", "service": "ElevenLabs (voice)", "group": "AI", "url": "https://elevenlabs.io/app/developers/api-keys", "hint": ""},
    {"name": "TAVILY_API_KEY", "service": "Tavily (web search)", "group": "AI", "url": "https://app.tavily.com/home", "hint": "starts with tvly-", "prefixes": ["tvly-"]},
    {"name": "FIRECRAWL_API_KEY", "service": "Firecrawl (web scraping)", "group": "AI", "url": "https://www.firecrawl.dev/app/api-keys", "hint": "starts with fc-", "prefixes": ["fc-"]},
    # Payments
    {"name": "STRIPE_SECRET_KEY", "service": "Stripe secret key", "group": "Payments", "url": "https://dashboard.stripe.com/apikeys", "hint": "starts with sk_live_ (or sk_test_ for testing)", "prefixes": ["sk_live_", "sk_test_", "rk_live_", "rk_test_"]},
    {"name": "STRIPE_PUBLISHABLE_KEY", "service": "Stripe publishable key", "group": "Payments", "url": "https://dashboard.stripe.com/apikeys", "hint": "starts with pk_live_", "prefixes": ["pk_live_", "pk_test_"]},
    {"name": "STRIPE_WEBHOOK_SECRET", "service": "Stripe webhook secret", "group": "Payments", "url": "https://dashboard.stripe.com/webhooks", "hint": "starts with whsec_; open your webhook, then Signing secret", "prefixes": ["whsec_"]},
    # Database and auth
    {"name": "SUPABASE_URL", "service": "Supabase project URL", "group": "Database", "url": "https://supabase.com/dashboard/project/_/settings/api-keys", "hint": "looks like https://xxxx.supabase.co", "patterns": ["^https://[a-z0-9]+\\.supabase\\.co/?$"]},
    {"name": "SUPABASE_ANON_KEY", "service": "Supabase public key", "group": "Database", "url": "https://supabase.com/dashboard/project/_/settings/api-keys", "hint": "the publishable / anon key", "prefixes": ["sb_publishable_", "eyJ"]},
    {"name": "SUPABASE_SERVICE_ROLE_KEY", "service": "Supabase secret key", "group": "Database", "url": "https://supabase.com/dashboard/project/_/settings/api-keys", "hint": "the secret / service_role key (sb_secret_ or eyJ…): full database access", "prefixes": ["sb_secret_", "eyJ"]},
    {"name": "SUPABASE_ACCESS_TOKEN", "service": "Supabase account token (for the CLI and deploys)", "group": "Database", "url": "https://supabase.com/dashboard/account/tokens", "hint": "starts with sbp_; manages all your projects", "prefixes": ["sbp_"]},
    {"name": "DATABASE_URL", "service": "Database connection string", "group": "Database", "url": "https://supabase.com/dashboard/project/_/database/settings", "hint": "starts with postgresql://", "prefixes": ["postgresql://", "postgres://"]},
    # Email and messaging
    {"name": "RESEND_API_KEY", "service": "Resend (email)", "group": "Email & messaging", "url": "https://resend.com/api-keys", "hint": "starts with re_", "prefixes": ["re_"]},
    {"name": "SENDGRID_API_KEY", "service": "SendGrid (email)", "group": "Email & messaging", "url": "https://app.sendgrid.com/settings/api_keys", "hint": "starts with SG.", "prefixes": ["SG."]},
    {"name": "TWILIO_ACCOUNT_SID", "service": "Twilio account SID", "group": "Email & messaging", "url": "https://console.twilio.com/", "hint": "starts with AC; on the console home page", "patterns": ["^AC[0-9a-f]{32}$"]},
    {"name": "TWILIO_AUTH_TOKEN", "service": "Twilio auth token", "group": "Email & messaging", "url": "https://console.twilio.com/", "hint": "on the console home page"},
    {"name": "SLACK_BOT_TOKEN", "service": "Slack bot", "group": "Email & messaging", "url": "https://api.slack.com/apps", "hint": "starts with xoxb-; your app, then OAuth & Permissions", "prefixes": ["xoxb-"]},
    # Hosting and tools
    {"name": "GITHUB_TOKEN", "service": "GitHub", "group": "Hosting & tools", "url": "https://github.com/settings/personal-access-tokens", "hint": "starts with github_pat_", "prefixes": ["github_pat_", "ghp_"]},
    {"name": "VERCEL_TOKEN", "service": "Vercel", "group": "Hosting & tools", "url": "https://vercel.com/account/settings/tokens", "hint": ""},
    {"name": "CLOUDFLARE_API_TOKEN", "service": "Cloudflare", "group": "Hosting & tools", "url": "https://dash.cloudflare.com/profile/api-tokens", "hint": ""},
    {"name": "NOTION_API_KEY", "service": "Notion", "group": "Hosting & tools", "url": "https://www.notion.so/profile/integrations", "hint": "starts with ntn_; create an internal integration", "prefixes": ["ntn_"]},
    {"name": "GOOGLE_MAPS_API_KEY", "service": "Google Maps", "group": "Hosting & tools", "url": "https://console.cloud.google.com/google/maps-apis/credentials", "hint": "starts with AIza", "prefixes": ["AIza"]},
    {"name": "POSTHOG_API_KEY", "service": "PostHog (analytics)", "group": "Hosting & tools", "url": "https://us.posthog.com/settings/project", "hint": "starts with phc_", "prefixes": ["phc_"]},
]
_SUGGESTION_URLS = {s["name"]: s["url"] for s in SUGGESTIONS}
_SUGGESTION_BY_NAME = {s["name"]: s for s in SUGGESTIONS}


def naming_warning(name: str, value: str) -> dict | None:
    """When a well-known name holds a value shaped like a DIFFERENT well-known key
    (e.g. a Supabase account token, sbp_, saved as SUPABASE_SERVICE_ROLE_KEY),
    say what it looks like. Custom names are never second-guessed (SHE-140)."""
    if name not in _SUGGESTION_BY_NAME:
        return None
    # Shapes some keys share (AIza: Gemini and Maps; eyJ: both Supabase keys).
    if any(value.startswith(p) for p in _SUGGESTION_BY_NAME[name].get("prefixes", [])):
        return None
    best = max(((p, s) for s in SUGGESTIONS for p in s.get("prefixes", []) if value.startswith(p)),
               key=lambda ps: len(ps[0]), default=None)
    if best is None or best[1]["name"] == name:
        return None
    prefix, sug = best
    what = re.sub(r"\s*\(.*\)", "", sug["service"])
    if not re.search(r"(key|token|secret|URL|SID|string)$", what):
        what += " key"
    return {"message": f"This value starts with {prefix}, so it's probably your {what}. "
                       f"That one is usually saved as {sug['name']}, not {name}.",
            "rename_to": sug["name"]}


class SecretsError(ValueError):
    """A user-facing error. Its message never contains a secret value."""


def vault_path() -> Path:
    override = os.environ.get("SHELLTEAM_SECRETS_FILE")
    if override:
        return Path(override)
    return Path(os.environ.get("HOME", str(Path.home()))) / ".shellteam" / "secrets.json"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load() -> dict:
    path = vault_path()
    if not path.exists():
        return {"secrets": {}, "uses": []}
    data = json.loads(path.read_text())
    data.setdefault("secrets", {})
    data.setdefault("uses", [])
    return data


def save(data: dict) -> None:
    """Atomic write, owner-only (0700 dir, 0600 file)."""
    path = vault_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".secrets-", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def check_name(name: str) -> str:
    if not NAME_RE.match(name or ""):
        # Never echo the input: an agent may have pasted a value by mistake.
        raise SecretsError(
            "Secret names are letters, digits and underscores, starting with a "
            "letter (like STRIPE_SECRET_KEY). Values never go on the command line."
        )
    return name


def _require(data: dict, names: list[str]) -> None:
    missing = [n for n in names if n not in data["secrets"]]
    if missing:
        where = "".join(f"\n  {n}: get it at {_SUGGESTION_URLS[n]}" for n in missing if n in _SUGGESTION_URLS)
        raise SecretsError(
            f"Not in the vault yet: {', '.join(missing)}. Ask the owner to add "
            f"{'it' if len(missing) == 1 else 'them'} in Settings -> Secrets.{where}"
        )


# --- Masking -----------------------------------------------------------------


def mask(text: str, data: dict | None = None) -> str:
    """Replace every vault value found in ``text`` with ``[secret NAME]``."""
    data = load() if data is None else data
    pairs = sorted(
        ((s["value"], n) for n, s in data["secrets"].items() if len(s["value"]) >= MIN_MASK_LEN),
        key=lambda p: -len(p[0]),  # longest first, so a value inside another loses
    )
    for value, name in pairs:
        text = text.replace(value, f"[secret {name}]")
    return text


# --- Status (never values) ---------------------------------------------------


def status() -> list[dict]:
    data = load()
    out = []
    for name in sorted(data["secrets"]):
        uses = [_describe_use(u) for u in data["uses"] if name in u["vars"].values()]
        out.append({"name": name, "updated_at": data["secrets"][name]["updated_at"], "uses": uses,
                    "warning": naming_warning(name, data["secrets"][name]["value"])})
    return out


def _describe_use(use: dict) -> dict:
    if use["kind"] == "file":
        return {"kind": "file", "file": use["file"], "restart": use.get("restart")}
    return {"kind": "command", "command": use["command"], "cwd": use["cwd"]}


# --- Env files ---------------------------------------------------------------


def _env_line(var: str, value: str) -> str:
    if "\n" in value or "\r" in value:
        raise SecretsError(f"{var}: multi-line values can't go in an env file; use `run` instead.")
    if _BARE_VALUE_RE.match(value):
        return f"{var}={value}"
    if "'" not in value:
        return f"{var}='{value}'"
    # Inside double quotes a shell still expands \ " $ and the backtick; an
    # unescaped backtick ran a command when the file was sourced (SHE-148).
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")
    return f'{var}="{escaped}"'


def _upsert_env_file(path: Path, assignments: dict[str, str]) -> None:
    """Set each VAR in the env file, keeping every other line as it was."""
    if path.is_symlink() or (path.exists() and not path.is_file()):
        # A symlinked .env (a cloned repo can ship one) would get the secrets
        # written into, and read back from, whatever it points at (SHE-148).
        raise SecretsError(f"{path} is a symlink or not a regular file; point at the real file.")
    lines = path.read_text().splitlines() if path.exists() else []
    pending = dict(assignments)
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and m.group(2) in pending:
            lines[i] = m.group(1) + _env_line(m.group(2), pending.pop(m.group(2)))
    lines += [_env_line(var, value) for var, value in pending.items()]
    new = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    mode = 0o600 if new else (path.stat().st_mode & 0o777)
    if mode & 0o077:
        log.warning("secrets: %s is readable by other users (mode %o); consider chmod 600", path, mode)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def parse_mapping(specs: list[str]) -> dict[str, str]:
    """``VAR`` or ``VAR=SECRET_NAME`` -> {VAR: SECRET_NAME}."""
    mapping = {}
    for spec in specs:
        var, _, name = spec.partition("=")
        mapping[check_name(var)] = check_name(name or var)
    return mapping


def check_unit(unit: str | None) -> str | None:
    if unit is None:
        return None
    if not UNIT_RE.match(unit):
        raise SecretsError("That is not a valid systemd unit name.")
    if unit.startswith("shellteam-"):
        raise SecretsError("ShellTeam's own services are not app units; pick your app's unit.")
    return unit


def write_env(file: str, mapping: dict[str, str], restart: str | None = None) -> Path:
    """Write the named secrets into ``file`` and remember it for rotations."""
    # absolute(), not resolve(): resolving would silently follow a symlinked
    # .env to its target; _upsert_env_file refuses it instead.
    path = Path(os.path.normpath(Path(file).expanduser().absolute()))
    restart = check_unit(restart)
    data = load()
    _require(data, list(mapping.values()))
    _upsert_env_file(path, {var: data["secrets"][n]["value"] for var, n in mapping.items()})
    use = next((u for u in data["uses"] if u["kind"] == "file" and u["file"] == str(path)), None)
    if use is None:
        use = {"kind": "file", "file": str(path), "vars": {}, "restart": None}
        data["uses"].append(use)
    use["vars"].update(mapping)
    if restart:
        use["restart"] = restart
    save(data)
    log.info("secrets: wrote %s into %s", ", ".join(mapping), path)
    return path


def forget(target: str) -> int:
    """Stop updating a file (or remembered command) on rotation. Returns how many."""
    data = load()
    resolved = str(Path(target).expanduser().resolve())
    keep = [u for u in data["uses"] if u.get("file") != resolved and u.get("command") != target]
    removed = len(data["uses"]) - len(keep)
    data["uses"] = keep
    save(data)
    return removed


# --- Commands ----------------------------------------------------------------


def command_env(names: list[str], data: dict) -> dict[str, str]:
    _require(data, names)
    from api.config import child_env

    return {**child_env(), **{n: data["secrets"][n]["value"] for n in names}}


def run(names: list[str], argv: list[str], remember: bool = False, cwd: str | None = None) -> int:
    """Run ``argv`` with the named secrets in its env, masking them in its output."""
    if not argv:
        raise SecretsError("Nothing to run: put the command after `--`.")
    for n in names:
        check_name(n)
    data = load()
    env = command_env(names, data)
    cwd = cwd or os.getcwd()
    proc = subprocess.Popen(argv, env=env, cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    for line in proc.stdout:
        sys.stdout.write(mask(line, data))
        sys.stdout.flush()
    code = proc.wait()
    if remember and code == 0:
        command = shlex.join(argv)
        data = load()
        data["uses"] = [u for u in data["uses"] if u.get("command") != command]
        data["uses"].append({"kind": "command", "command": command, "argv": argv,
                             "cwd": cwd, "vars": {n: n for n in names}})
        save(data)
    return code


# --- Setting a value = rotating it everywhere ----------------------------------


def set_secret(name: str, value: str) -> list[dict]:
    """Store ``name`` and push the new value to every recorded use.

    Returns one result per affected use: ``{"target", "ok", "detail"}``. A failed
    use is reported (and logged), never hidden, and does not stop the others.
    """
    check_name(name)
    if not value or not value.strip():
        raise SecretsError("The value is empty.")
    data = load()
    data["secrets"][name] = {"value": value, "updated_at": _now()}
    save(data)
    log.info("secrets: %s saved", name)
    return propagate(name, data)


def rename_secret(name: str, new_name: str) -> None:
    """Move a secret to a new name; files keep their variable names (SHE-140)."""
    check_name(new_name)
    data = load()
    if name not in data["secrets"]:
        raise SecretsError(f"No secret named {check_name(name)}.")
    if new_name in data["secrets"]:
        raise SecretsError(f"{new_name} already exists; delete or replace it first.")
    data["secrets"][new_name] = data["secrets"].pop(name)
    for use in data["uses"]:
        use["vars"] = {var: (new_name if n == name else n) for var, n in use["vars"].items()}
    save(data)
    log.info("secrets: %s renamed to %s", name, new_name)


def delete_secret(name: str) -> None:
    data = load()
    if name not in data["secrets"]:
        raise SecretsError(f"No secret named {check_name(name)}.")
    del data["secrets"][name]
    # Stop tracking it: drop it from every use, and uses left with nothing.
    for use in data["uses"]:
        use["vars"] = {var: n for var, n in use["vars"].items() if n != name}
    data["uses"] = [u for u in data["uses"] if u["vars"]]
    save(data)
    log.info("secrets: %s deleted (files that hold it are left as they are)", name)


def propagate(name: str, data: dict) -> list[dict]:
    results = []
    for use in data["uses"]:
        if name not in use["vars"].values():
            continue
        if use["kind"] == "file":
            results.append(_refresh_file(use, data))
        else:
            results.append(_rerun(use, data))
    for r in results:
        (log.info if r["ok"] else log.warning)("secrets: rotate %s -> %s: %s", name, r["target"], r["detail"])
    return results


def _refresh_file(use: dict, data: dict) -> dict:
    target = use["file"]
    present = {var: n for var, n in use["vars"].items() if n in data["secrets"]}
    try:
        _upsert_env_file(Path(target), {v: data["secrets"][n]["value"] for v, n in present.items()})
    except OSError as e:
        return {"target": target, "ok": False, "detail": f"could not write the file: {e.strerror}"}
    if not use.get("restart"):
        return {"target": target, "ok": True, "detail": "file updated (no app restart registered)"}
    proc = subprocess.run(["systemctl", "--user", "restart", use["restart"]],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        return {"target": target, "ok": False,
                "detail": f"file updated, but restarting {use['restart']} failed: {mask(proc.stderr.strip(), data)}"}
    return {"target": target, "ok": True, "detail": f"file updated, {use['restart']} restarted"}


def _rerun(use: dict, data: dict) -> dict:
    target = use["command"]
    try:
        proc = subprocess.run(use["argv"], env=command_env(list(use["vars"].values()), data),
                              cwd=use["cwd"], capture_output=True, text=True, timeout=COMMAND_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired, SecretsError) as e:
        return {"target": target, "ok": False, "detail": mask(str(e), data)}
    if proc.returncode != 0:
        tail = mask((proc.stdout + proc.stderr).strip()[-400:], data)
        return {"target": target, "ok": False, "detail": f"exit {proc.returncode}: {tail}"}
    return {"target": target, "ok": True, "detail": "command re-run"}
