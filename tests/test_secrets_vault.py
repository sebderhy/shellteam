"""SHE-135: the owner enters each API key once; agents use it by name, the value
never reaches stdout or the API, and replacing it updates every app that uses it.
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from api.services import secrets_vault as vault

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "bin" / "shellteam-secrets"
VALUE = "sk_live_ORIGINAL_value_123456"
NEW_VALUE = "sk_live_ROTATED_value_987654"


@pytest.fixture(autouse=True)
def vault_file(tmp_path, monkeypatch):
    path = tmp_path / "home" / ".shellteam" / "secrets.json"
    monkeypatch.setenv("SHELLTEAM_SECRETS_FILE", str(path))
    return path


def cli(*args, cwd=None):
    return subprocess.run([sys.executable, str(CLI), *args], capture_output=True, text=True,
                          cwd=cwd, env={**os.environ}, stdin=subprocess.DEVNULL)


def test_vault_is_owner_only(vault_file):
    vault.set_secret("STRIPE_KEY", VALUE)
    assert stat.S_IMODE(vault_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(vault_file.parent.stat().st_mode) == 0o700


def test_write_puts_the_value_in_the_file_but_never_on_stdout(tmp_path):
    vault.set_secret("STRIPE_KEY", VALUE)
    env = tmp_path / "app" / ".env"
    env.parent.mkdir()
    env.write_text("# my app\nPORT=3000\nexport STRIPE=old\n")
    r = cli("write", str(env), "STRIPE=STRIPE_KEY", "STRIPE_KEY")
    assert r.returncode == 0, r.stderr
    assert VALUE not in r.stdout + r.stderr
    assert env.read_text() == f"# my app\nPORT=3000\nexport STRIPE={VALUE}\nSTRIPE_KEY={VALUE}\n"


def test_new_env_file_is_owner_only(tmp_path):
    vault.set_secret("K", VALUE)
    env = tmp_path / ".env"
    vault.write_env(str(env), {"K": "K"})
    assert stat.S_IMODE(env.stat().st_mode) == 0o600


def test_replacing_a_key_rewrites_every_file_that_uses_it(tmp_path):
    vault.set_secret("STRIPE_KEY", VALUE)
    vault.set_secret("OTHER", "other_value_abcdef")
    a, b = tmp_path / "a.env", tmp_path / "b.env"
    vault.write_env(str(a), {"STRIPE_KEY": "STRIPE_KEY", "OTHER": "OTHER"})
    vault.write_env(str(b), {"PAY": "STRIPE_KEY"})
    results = vault.set_secret("STRIPE_KEY", NEW_VALUE)
    assert {r["target"] for r in results} == {str(a), str(b)}
    assert all(r["ok"] for r in results)
    assert a.read_text() == f"STRIPE_KEY={NEW_VALUE}\nOTHER=other_value_abcdef\n"
    assert b.read_text() == f"PAY={NEW_VALUE}\n"


def test_rotation_restarts_the_registered_unit(tmp_path, monkeypatch):
    vault.set_secret("K", VALUE)
    vault.write_env(str(tmp_path / ".env"), {"K": "K"}, restart="app-shop")
    calls = []
    real_run = subprocess.run

    def fake_run(argv, **kw):
        if argv[:2] == ["systemctl", "--user"]:
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, "", "")
        return real_run(argv, **kw)

    monkeypatch.setattr(vault.subprocess, "run", fake_run)
    [result] = vault.set_secret("K", NEW_VALUE)
    assert calls == [["systemctl", "--user", "restart", "app-shop"]]
    assert result["ok"] and "app-shop restarted" in result["detail"]


def test_shellteam_own_units_are_refused(tmp_path):
    vault.set_secret("K", VALUE)
    with pytest.raises(vault.SecretsError):
        vault.write_env(str(tmp_path / ".env"), {"K": "K"}, restart="shellteam-ai-chat")


def test_run_masks_values_and_remember_reruns_on_rotation(tmp_path):
    vault.set_secret("TOKEN", VALUE)
    out = tmp_path / "pushed.txt"
    r = cli("run", "TOKEN", "--remember", "--", "sh", "-c", f'echo "$TOKEN"; printf %s "$TOKEN" > {out}')
    assert r.returncode == 0, r.stderr
    assert VALUE not in r.stdout and "[secret TOKEN]" in r.stdout
    assert out.read_text() == VALUE
    [result] = vault.set_secret("TOKEN", NEW_VALUE)
    assert result["ok"], result
    assert out.read_text() == NEW_VALUE


def test_missing_secret_names_what_to_add_and_writes_nothing(tmp_path):
    env = tmp_path / ".env"
    r = cli("write", str(env), "STRIPE_KEY")
    assert r.returncode == 2
    assert "STRIPE_KEY" in r.stderr and "Settings -> Secrets" in r.stderr
    assert not env.exists()


def test_a_pasted_value_is_never_echoed_back(tmp_path):
    # An agent that pastes a value instead of a name must not get it printed back.
    r = cli("write", str(tmp_path / ".env"), "KEY=sk-live/abc+def")
    assert r.returncode == 2
    assert "sk-live/abc+def" not in r.stderr


def test_set_refuses_non_terminal_input():
    r = cli("set", "K")
    assert r.returncode == 2 and "Settings -> Secrets" in r.stderr


def test_values_that_need_quoting_round_trip_through_a_shell(tmp_path):
    tricky = "pa ss#word$HOME'x\"y"
    vault.set_secret("PW", tricky)
    env = tmp_path / ".env"
    vault.write_env(str(env), {"PW": "PW"})
    got = subprocess.run(["bash", "-c", f"set -a; . {env}; printf %s \"$PW\""],
                         capture_output=True, text=True).stdout
    assert got == tricky


def test_api_needs_the_owner(client):
    assert client.get("/api/settings/secrets").status_code == 401


def test_api_never_returns_values(client, auth_header, tmp_path):
    r = client.post("/api/settings/secrets", headers=auth_header, json={"name": "STRIPE_KEY", "value": VALUE})
    assert r.status_code == 200
    vault.write_env(str(tmp_path / ".env"), {"STRIPE_KEY": "STRIPE_KEY"})
    listing = client.get("/api/settings/secrets", headers=auth_header)
    assert listing.status_code == 200
    body = json.dumps(r.json()) + listing.text
    assert VALUE not in body
    [row] = listing.json()["secrets"]
    assert row["name"] == "STRIPE_KEY" and row["uses"][0]["file"] == str(tmp_path / ".env")
    rotated = client.post("/api/settings/secrets", headers=auth_header, json={"name": "STRIPE_KEY", "value": NEW_VALUE})
    assert NEW_VALUE not in rotated.text
    assert rotated.json()["results"][0]["ok"]
    assert client.delete("/api/settings/secrets/STRIPE_KEY", headers=auth_header).json() == {"secrets": []}


def test_api_rejects_a_bad_name(client, auth_header):
    r = client.post("/api/settings/secrets", headers=auth_header, json={"name": "not a name", "value": VALUE})
    assert r.status_code == 400


def test_persona_teaches_the_cli_by_absolute_path(tmp_path):
    from api.services import agent_layer
    text = agent_layer._render_persona("alice", tmp_path)
    assert f"{CLI} write" in text
    assert "{shellteam_secrets}" not in text


def test_deleting_a_key_stops_tracking_it(tmp_path):
    vault.set_secret("A", VALUE)
    vault.set_secret("B", NEW_VALUE)
    vault.write_env(str(tmp_path / "one.env"), {"A": "A", "B": "B"})
    vault.write_env(str(tmp_path / "two.env"), {"A": "A"})
    vault.delete_secret("A")
    assert vault.load()["uses"] == [
        {"kind": "file", "file": str(tmp_path / "one.env"), "vars": {"B": "B"}, "restart": None}
    ]
    assert (tmp_path / "two.env").read_text() == f"A={VALUE}\n"  # the app keeps its copy


def test_missing_key_error_says_where_to_get_it(tmp_path):
    # SHE-139: the agent can pass the link on to the owner.
    r = cli("write", str(tmp_path / ".env"), "STRIPE_SECRET_KEY", "MY_OWN_THING")
    assert r.returncode == 2
    assert "STRIPE_SECRET_KEY: get it at https://dashboard.stripe.com/apikeys" in r.stderr
    assert "MY_OWN_THING: get it" not in r.stderr


def test_suggestions_are_well_formed_and_served(client, auth_header):
    names = [s["name"] for s in vault.SUGGESTIONS]
    assert len(names) == len(set(names))
    for s in vault.SUGGESTIONS:
        assert vault.NAME_RE.match(s["name"]) and s["url"].startswith("https://")
        assert s["service"] and s["group"]
    body = client.get("/api/settings/secrets", headers=auth_header).json()
    assert body["suggestions"] == vault.SUGGESTIONS


def test_a_key_saved_under_the_wrong_well_known_name_is_flagged():
    # SHE-140: Seb's Supabase account token (sbp_) was saved as the service-role key.
    vault.set_secret("SUPABASE_SERVICE_ROLE_KEY", "sbp_" + "x" * 40)
    vault.set_secret("MY_THING", "sbp_" + "y" * 40)            # custom names: no opinion
    vault.set_secret("OPENAI_API_KEY", "sk-proj-" + "z" * 40)  # right name: no warning
    rows = {r["name"]: r["warning"] for r in vault.status()}
    assert rows["SUPABASE_SERVICE_ROLE_KEY"]["rename_to"] == "SUPABASE_ACCESS_TOKEN"
    assert "sbp_" in rows["SUPABASE_SERVICE_ROLE_KEY"]["message"]
    assert rows["MY_THING"] is None and rows["OPENAI_API_KEY"] is None


def test_rename_keeps_the_value_and_the_files_that_use_it(tmp_path, client, auth_header):
    vault.set_secret("WRONG", VALUE)
    env = tmp_path / ".env"
    vault.write_env(str(env), {"APP_KEY": "WRONG"})
    r = client.post("/api/settings/secrets/WRONG/rename", headers=auth_header, json={"to": "RIGHT"})
    assert r.status_code == 200 and VALUE not in r.text
    assert [s["name"] for s in r.json()["secrets"]] == ["RIGHT"]
    vault.set_secret("RIGHT", NEW_VALUE)  # rotation still reaches the file
    assert env.read_text() == f"APP_KEY={NEW_VALUE}\n"
    vault.set_secret("OTHER", VALUE)
    clash = client.post("/api/settings/secrets/OTHER/rename", headers=auth_header, json={"to": "RIGHT"})
    assert clash.status_code == 400


def test_shared_shapes_never_flag_a_correct_name():
    # SHE-142: AIza is both a Gemini and a Maps key; eyJ is both Supabase keys.
    assert vault.naming_warning("GOOGLE_MAPS_API_KEY", "AIza" + "x" * 30) is None
    assert vault.naming_warning("GEMINI_API_KEY", "AIza" + "x" * 30) is None
    assert vault.naming_warning("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOi" + "x" * 30) is None
    assert vault.naming_warning("SUPABASE_ANON_KEY", "eyJhbGciOi" + "x" * 30) is None


def test_guess_patterns_are_valid_regexes():
    import re
    for s in vault.SUGGESTIONS:
        for pattern in s.get("patterns", []):
            re.compile(pattern)


def test_backticks_never_run_when_the_file_is_sourced(tmp_path):
    # SHE-148: a value with both ' and ` went in double quotes, unescaped.
    tricky = "it's`touch " + str(tmp_path / "pwned") + "`$(id)"
    vault.set_secret("PW", tricky)
    env = tmp_path / ".env"
    vault.write_env(str(env), {"PW": "PW"})
    got = subprocess.run(["bash", "-c", f"set -a; . {env}; printf %s \"$PW\""],
                         capture_output=True, text=True).stdout
    assert got == tricky and not (tmp_path / "pwned").exists()


def test_a_symlinked_env_file_is_refused(tmp_path):
    # SHE-148: a cloned repo's .env -> ../somewhere would receive the secrets.
    vault.set_secret("K", VALUE)
    target = tmp_path / "published.txt"
    target.write_text("")
    link = tmp_path / "app" / ".env"
    link.parent.mkdir()
    link.symlink_to(target)
    with pytest.raises(vault.SecretsError):
        vault.write_env(str(link), {"K": "K"})
    assert target.read_text() == ""
