"""SHE-149: know when someone gets in. Sign-ins alert the owner, the daily
check sorts the record into unusual/normal, and the command log is wired so it
records logins other than ShellTeam's own."""

import subprocess
import time
from pathlib import Path

import pytest

from api.services import security_watch as sw
from api.services import sessions

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELLTEAM_SECURITY_STATE", str(tmp_path / "known.json"))
    sent = []
    monkeypatch.setattr(sw.notify, "notify_channel", lambda: "telegram")
    monkeypatch.setattr(sw, "_alert", lambda title, body: sent.append((title, body)))
    sessions.revoke_all()
    sent.clear()
    yield sent
    sessions.revoke_all()


def test_every_sign_in_messages_the_owner_and_flags_a_new_network(_fresh):
    sessions.mint("login", ip="203.0.113.7", ua="Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130")
    sessions.mint("login", ip="203.0.113.99", ua="Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130")  # same /16
    sessions.mint("enroll", ip="198.51.100.4", ua="Mozilla/5.0 (iPhone) Safari/605")
    sessions.mint("migrated", ip="198.51.100.4")
    titles = [t for t, _ in _fresh]
    bodies = [b for _, b in _fresh]
    assert titles == ["ShellTeam: new sign-in", "ShellTeam: new sign-in", "ShellTeam: new device added"]
    assert "203.0.113.7 (first time from this network), Chrome on Mac" in bodies[0]
    assert "first time" not in bodies[1]  # a phone's new lease is not a new place
    assert "Safari on iPhone" in bodies[2]


def test_a_token_change_alerts_but_a_first_start_does_not(_fresh, monkeypatch):
    sessions.mint("login", ip="203.0.113.7")
    _fresh.clear()
    monkeypatch.setattr(sessions, "_epoch", lambda: "a-new-token-epoch")
    with sessions._lock:
        sessions._live()
    assert [t for t, _ in _fresh] == ["ShellTeam: master token changed"]


def _summary(events, monkeypatch, first_run=False):
    monkeypatch.setattr(sw, "journal_events", lambda since: events)
    monkeypatch.setattr(sw, "command_log_enabled", lambda: False)
    monkeypatch.setattr(sw, "ssh_logins_from_last", lambda since: [])
    if not first_run:
        sw._save_state({"ssh_networks": [], "scheduled": []})
    return sw.summarize(0)


def test_daily_check_sorts_what_needs_a_look(monkeypatch):
    s = _summary([
        {"event": "signin", "kind": "login", "ip": "203.0.113.7", "browser": "Chrome on Mac", "new_ip": True},
        {"event": "signin", "kind": "login", "ip": "203.0.113.8", "browser": "Chrome on Mac", "new_ip": False},
        {"event": "signin", "kind": "enroll", "ip": "203.0.113.8", "browser": "Safari on iPhone", "new_ip": False},
        {"event": "token_changed", "sessions_revoked": 2},
        {"event": "terminal_open", "ip": "203.0.113.8", "new_ip": False},
        *[{"event": "auth_failure", "ip": "198.51.100.1", "path": "/"}] * 25,
    ], monkeypatch)
    text = sw.render_markdown(s)
    assert len(s["unusual"]) == 4  # new network, new device, token change, 25 wrong tokens from one address
    assert "Web terminal opened from 203.0.113.8" in s["normal"]
    assert "**4 thing(s) to look at**" in text and "command log is off" in text


def test_a_quiet_day_says_so(monkeypatch):
    s = _summary([{"event": "auth_failure", "ip": "198.51.100.1", "path": "/"}], monkeypatch)
    assert s["unusual"] == [] and sw.render_markdown(s).startswith("**Nothing unusual.**")


# --- the command log ------------------------------------------------------------

_RAW_LOGINS = """\
type=USER_START msg=audit(1762426565.230:2010): pid=1 uid=0 auid=1002 ses=44009 msg='op=PAM:session_open acct="seb" exe="/usr/sbin/sshd" hostname=203.0.113.7 addr=203.0.113.7 terminal=ssh res=success'
type=USER_START msg=audit(1762426600.000:2020): pid=2 uid=0 auid=1002 ses=44010 msg='op=PAM:session_open acct="seb" exe="/usr/sbin/cron" hostname=? addr=? terminal=cron res=success'
"""
_RAW_LOGIN_CMDS = """\
type=SYSCALL msg=audit(1762426565.276:2012): arch=c000003e syscall=59 success=yes exit=0 ppid=1 pid=3 auid=1002 uid=1002 ses=44009 comm="bash" exe="/usr/bin/bash" key="shellteam-login"
type=EXECVE msg=audit(1762426565.276:2012): argc=3 a0="bash"
type=PROCTITLE msg=audit(1762426565.276:2012): proctitle=62617368002D630065636F206869
type=SYSCALL msg=audit(1762426600.100:2021): arch=c000003e syscall=59 success=yes exit=0 ppid=1 pid=4 auid=1002 uid=1002 ses=44010 comm="sh" exe="/usr/bin/dash" key="shellteam-login"
type=EXECVE msg=audit(1762426600.100:2021): argc=3 a0="sh"
type=PROCTITLE msg=audit(1762426600.100:2021): proctitle=2F62696E2F7368002D63006E65772D6A6F62
"""
_RAW_ROOT = """\
type=CONFIG_CHANGE msg=audit(1762426000.000:1172): auid=1002 ses=7437 op=add_rule key="shellteam-root" list=4 res=1
type=SYSCALL msg=audit(1762426700.000:3001): arch=c000003e syscall=59 success=yes exit=0 auid=1002 uid=1002 ses=7437 comm="sudo" exe="/usr/bin/sudo" key="shellteam-root"
type=EXECVE msg=audit(1762426700.000:3001): argc=3 a0="sudo"
type=PROCTITLE msg=audit(1762426700.000:3001): proctitle=7375646F002D6E002D6C
type=SYSCALL msg=audit(1762426800.000:3002): arch=c000003e syscall=59 success=yes exit=0 auid=1002 uid=1002 ses=44009 comm="sudo" exe="/usr/bin/sudo" key="shellteam-root"
type=EXECVE msg=audit(1762426800.000:3002): argc=2 a0="sudo"
type=PROCTITLE msg=audit(1762426800.000:3002): proctitle=7375646F006964
"""


def _fake_ausearch(cmd, **kw):
    out = _RAW_LOGINS if "USER_START" in cmd else _RAW_ROOT if "shellteam-root" in cmd else _RAW_LOGIN_CMDS
    return subprocess.CompletedProcess(cmd, 0, out, "")


def test_the_command_log_is_read_by_session(monkeypatch):
    monkeypatch.setattr(sw.subprocess, "run", _fake_ausearch)
    monkeypatch.setattr(sw, "journal_events", lambda since: [])
    monkeypatch.setattr(sw, "command_log_enabled", lambda: True)
    monkeypatch.setattr(sw, "shellteam_session", lambda: "7437")
    monkeypatch.setattr(sw, "command_log_started", lambda: 0.0)
    sw._save_state({"ssh_networks": [], "scheduled": []})
    s = sw.summarize(1762426000, update_known=True)
    assert "SSH login as seb from 203.0.113.7 at" in s["unusual"][0] and "1 command(s) (bash)" in s["unusual"][0]
    assert "1 as root (sudo), e.g. `sudo id`" in s["unusual"][0]  # root commands belong to their login
    assert any("new-job" in u and "not seen before" in u for u in s["unusual"])
    assert any("1 root command(s) run by your agents" in n for n in s["normal"]) is False  # `sudo -n -l` is skipped
    assert not any("rule" in line for line in s["unusual"] + s["normal"])  # config changes aren't commands
    again = sw.summarize(1762426000)
    assert again["unusual"] == []  # now known


def test_network_of():
    assert sw.network_of("198.51.100.145") == "198.51.*.*"
    assert sw.network_of("2a01:cb00:5d3:46::1") == "2a01:cb00:5d3::"


# --- install wiring --------------------------------------------------------------

def test_install_wires_the_command_log_and_the_daily_check():
    src = (ROOT / "install.sh").read_text()
    full = next(line for line in src.splitlines() if line.strip().startswith("--full)"))
    assert "WITH_COMMAND_LOG=1" in full
    body = src.split("provision_command_log() {", 1)[1].split("\n}\n", 1)[0]
    assert "sessionid!=" in body and "-k shellteam-login" in body  # ShellTeam's own session excluded
    assert "ExecStartPost=+" in body  # re-applied on every user-manager start
    assert "log_group = $group" in body and "NEEDRESTART_MODE=l" in body
    assert "shellteam-security.timer" in src
    uninstall = (ROOT / "uninstall.sh").read_text()
    assert "shellteam-command-log.conf" in uninstall and "shellteam-security.timer" in uninstall
    timer = (ROOT / "deploy/systemd/shellteam-security.timer").read_text()
    assert "Persistent=true" in timer
    assert "--notify" in (ROOT / "deploy/systemd/shellteam-security.service").read_text()


def test_jobs_scheduled_in_the_first_week_are_learned_not_flagged(monkeypatch):
    """2026-11-07: the first morning email flagged the owner's own nightly cron
    jobs, because the baseline was taken at midday before they had ever run."""
    monkeypatch.setattr(sw.subprocess, "run", _fake_ausearch)
    monkeypatch.setattr(sw, "journal_events", lambda since: [])
    monkeypatch.setattr(sw, "command_log_enabled", lambda: True)
    monkeypatch.setattr(sw, "shellteam_session", lambda: "7437")
    monkeypatch.setattr(sw, "command_log_started", lambda: 0.0)
    monkeypatch.setattr(sw, "past_signin_networks", lambda: set())
    monkeypatch.setattr(sw, "ssh_logins_from_last", lambda since: [])
    sw._save_state({"ssh_networks": ["203.0.*.*"], "scheduled": [], "learn_scheduled_until": time.time() + 3600})
    s = sw.summarize(1762426000, update_known=True)
    assert not any("new-job" in u for u in s["unusual"])
    assert any("Learned a scheduled job" in n and "new-job" in n for n in s["normal"])
    sw._save_state({**sw._load_state(), "learn_scheduled_until": 0, "scheduled": []})
    assert any("new-job" in u for u in sw.summarize(1762426000)["unusual"])  # after the week: flagged


def test_the_first_check_opens_the_learning_week(monkeypatch):
    monkeypatch.setattr(sw, "journal_events", lambda since: [])
    monkeypatch.setattr(sw, "command_log_enabled", lambda: False)
    monkeypatch.setattr(sw, "ssh_logins_from_last", lambda since: [])
    monkeypatch.setattr(sw, "past_signin_networks", lambda: set())
    sw.summarize(0, update_known=True)
    assert sw._load_state()["learn_scheduled_until"] > time.time() + 7 * 86400


def _ssh_then_sudo(n_logins):
    """n SSH logins from one address, each running sudo, the way an agent on a
    laptop works (one SSH connection per command)."""
    starts, roots = [], []
    for i in range(n_logins):
        ses, ts = 50000 + i, 1762426600 + 60 * i
        starts.append(f'type=USER_START msg=audit({ts}.000:{9000 + 3 * i}): pid=1 uid=0 auid=1001 ses={ses} msg=\'op=PAM:session_open '
                      f'acct="serge" exe="/usr/sbin/sshd" hostname=203.0.113.9 addr=203.0.113.9 terminal=ssh res=success\'')
        starts.append(f'type=USER_START msg=audit({ts}.500:{9001 + 3 * i}): pid=2 uid=0 auid=1001 ses={ses} msg=\'op=PAM:session_open '
                      f'acct="root" exe="/usr/bin/sudo" hostname=? addr=? terminal=? res=success\'')
        roots += [f'type=SYSCALL msg=audit({ts}.400:{9002 + 3 * i}): arch=c000003e syscall=59 success=yes exit=0 auid=1001 uid=1001 '
                  f'ses={ses} comm="sudo" exe="/usr/bin/sudo" key="shellteam-root"',
                  f'type=EXECVE msg=audit({ts}.400:{9002 + 3 * i}): argc=2 a0="sudo"',
                  f'type=PROCTITLE msg=audit({ts}.400:{9002 + 3 * i}): proctitle=7375646F006964']
    def run(cmd, **kw):
        out = "\n".join(starts) if "USER_START" in cmd else "\n".join(roots) if "shellteam-root" in cmd else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")
    return run


def test_sudo_from_an_ssh_login_is_reported_as_that_login(monkeypatch):
    """2026-11-08: Serge's laptop agent logged in 23 times and ran sudo; the
    email listed ~50 lines 'Root command in the sudo session of root' and
    '0 command(s)' on every SSH line. It looked like an unknown root session."""
    monkeypatch.setattr(sw.subprocess, "run", _ssh_then_sudo(3))
    monkeypatch.setattr(sw, "journal_events", lambda since: [])
    monkeypatch.setattr(sw, "command_log_enabled", lambda: True)
    monkeypatch.setattr(sw, "shellteam_session", lambda: "7437")
    monkeypatch.setattr(sw, "command_log_started", lambda: 0.0)
    sw._save_state({"ssh_networks": ["203.0.*.*"], "scheduled": []})
    s = sw.summarize(1762426000)
    lines = s["normal"] + s["unusual"]
    assert s["unusual"] == []
    assert not any("session of root" in line for line in lines)
    ssh = [line for line in lines if "SSH login" in line]
    assert len(ssh) == 1 and ssh[0].startswith("3 SSH logins as serge from 203.0.113.9 between")
    assert "3 as root (sudo), e.g. `sudo id`" in ssh[0]
