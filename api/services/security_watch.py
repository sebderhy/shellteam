"""Know when someone gets in (SHE-149).

Three layers, each usable alone:

1. **Security events, live.** Sign-ins, new devices, token changes, web
   terminals and wrong-token attempts are written to the journal as one
   ``SECURITY {json}`` line each (the system journal is root-owned: someone in
   the owner's shell can't edit it). Sign-ins, new devices, token changes and
   terminals also message the owner (Telegram/ntfy), flagged when the address
   is new.
2. **Command log.** With ``--command-log`` (part of ``--full``) install.sh has
   auditd record sudo/su and every command run from a login session other than
   the one ShellTeam's services run in (SSH, cron, anything else), in a
   root-owned log the owner can read.
3. **The daily check** (``python -m api.services.security_watch``, run by
   shellteam-security.timer) reads both and messages the owner only when
   something is unusual. ``--format markdown`` prints the full report (the
   operator's daily email uses it).

Limit, stated plainly: an agent that was talked into running something runs it
inside ShellTeam's own session, which the command log leaves out (that's the
agents' normal work; their transcripts are the record). What this catches is a
way in that isn't the cockpit, and every way in through the cockpit's front
door (sign-ins, devices, terminals).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

from api.services import notify

log = logging.getLogger(__name__)

EVENT_TAG = "SECURITY "
_pending: set = set()  # keep notification tasks alive until they finish

# Session kinds -> how the owner reads them.
_SIGNIN_HOW = {
    "login": "with your token",
    "url-token": "with a token link",
    "enroll": "on a new device, with a one-time link",
}


# --- State -------------------------------------------------------------------


def _state_path() -> Path:
    return Path(os.environ.get("SHELLTEAM_SECURITY_STATE", Path.home() / ".shellteam" / "security" / "known.json"))


def _load_state() -> dict:
    path = _state_path()
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def network_of(ip: str) -> str:
    """The network an address belongs to, coarse on purpose: a phone's address
    changes all day inside its carrier's range (46.210.x.x), and "new" should
    mean a new place, not a new lease. IPv4 keeps 2 numbers, IPv6 3 groups."""
    if ":" in ip:
        return ":".join(ip.split(":")[:3]) + "::"
    parts = ip.split(".")
    return ".".join(parts[:2]) + ".*.*" if len(parts) == 4 else ip


def _remember(kind: str, value: str) -> bool:
    """Add ``value`` to the known set ``kind``. True when it was new."""
    state = _load_state()
    known = set(state.get(kind, []))
    if value in known:
        return False
    state[kind] = sorted(known | {value})
    _save_state(state)
    return True


# --- Live events ---------------------------------------------------------------


def record(event: str, **fields) -> dict:
    """Write one security event to the journal (never a secret)."""
    entry = {"event": event, "ts": int(time.time()), **fields}
    log.warning("%s%s", EVENT_TAG, json.dumps(entry, sort_keys=True))
    return entry


def _alert(title: str, body: str) -> None:
    """Message the owner off-box. Never raises; logs when no channel is set."""
    if notify.notify_channel() == "none":
        log.info("Security alert not sent (no NOTIFY_* channel in .env): %s", title)
        return
    coro = notify.send_notification(title, body)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro)
        return
    task = loop.create_task(coro)
    _pending.add(task)
    task.add_done_callback(_pending.discard)


def _domain() -> str:
    return os.environ.get("APP_DOMAIN", "this box")


_NOT_YOU = "Not you? Settings, Sessions: Log out everywhere, then change OWNER_TOKEN."


def browser_of(ua: str | None) -> str:
    """'Chrome on Mac' from a User-Agent, good enough to recognise your own."""
    ua = ua or ""
    browser = next((name for key, name in (("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"),
                                            ("Safari/", "Safari"), ("curl/", "curl")) if key in ua), "an unknown browser")
    system = next((name for key, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
                                           ("Mac OS", "Mac"), ("Windows", "Windows"), ("Linux", "Linux")) if key in ua), "")
    return f"{browser} on {system}" if system else browser


def note_signin(kind: str, ip: str, ua: str | None) -> None:
    """A session was minted. Every real sign-in messages the owner."""
    new_ip = bool(ip) and _remember("signin_networks", network_of(ip))
    record("signin", kind=kind, ip=ip, browser=browser_of(ua), new_ip=new_ip)
    if kind == "migrated":  # an existing browser's old cookie upgraded in place: not a sign-in
        return
    first = " (first time from this network)" if new_ip else ""
    how = _SIGNIN_HOW.get(kind, f"({kind})")
    title = "ShellTeam: new device added" if kind == "enroll" else "ShellTeam: new sign-in"
    _alert(title, f"Signed in to {_domain()} {how}, from {ip or 'an unknown address'}{first}, "
                  f"{browser_of(ua)}. {_NOT_YOU}")


def note_token_changed(revoked: int) -> None:
    record("token_changed", sessions_revoked=revoked)
    _alert("ShellTeam: master token changed",
           f"The master token of {_domain()} was changed; {revoked} signed-in device(s) were signed out. "
           "If you didn't do this, someone has a shell on the box: treat it as compromised.")


def note_terminal_open(ip: str) -> None:
    new_ip = bool(ip) and _remember("signin_networks", network_of(ip))
    record("terminal_open", ip=ip, new_ip=new_ip)
    first = " (first time from this network)" if new_ip else ""
    _alert("ShellTeam: web terminal opened",
           f"A web terminal was opened on {_domain()} from {ip}{first}. {_NOT_YOU}")


def note_auth_failure(ip: str, path: str) -> None:
    record("auth_failure", ip=str(ip), path=str(path)[:80])


def note_signout_all(revoked: int) -> None:
    record("signout_all", sessions_revoked=revoked)


# --- Reading the record --------------------------------------------------------


def journal_events(since: float) -> list[dict]:
    """SECURITY events the API wrote since ``since`` (epoch seconds)."""
    out = subprocess.run(
        ["journalctl", "--user", "-u", "shellteam-api", "--since", f"@{int(since)}", "-o", "cat", "--no-pager"],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"journalctl failed: {out.stderr.strip()[:300]}")
    events = []
    for line in out.stdout.splitlines():
        i = line.find(EVENT_TAG + "{")
        if i < 0:
            continue
        try:
            events.append(json.loads(line[i + len(EVENT_TAG):]))
        except ValueError:
            log.warning("Unreadable security event line skipped: %r", line[:200])
    return events


_MINTED_RE = re.compile(r"Session \w+ minted \(kind=[\w-]+, ip=([0-9a-fA-F.:]+),")


def past_signin_networks(days: int = 60) -> set[str]:
    """Networks of past sign-ins, from the API's own session log lines."""
    out = subprocess.run(["journalctl", "--user", "-u", "shellteam-api", "--since", f"-{days}d", "-o", "cat",
                          "--no-pager", "--grep", "minted \\(kind="], capture_output=True, text=True, timeout=300)
    return {network_of(ip) for ip in _MINTED_RE.findall(out.stdout) if ip not in ("127.0.0.1", "::1")}


def command_log_enabled() -> bool:
    return os.environ.get("COMMAND_LOG") == "1"


_AUDIT_MSG_RE = re.compile(r"msg=audit\((\d+)\.\d+:(\d+)\)")
_FIELD_RE = re.compile(r"(\w[\w-]*)=(\"[^\"]*\"|'[^']*'|\S+)")


def _fields(line: str) -> dict:
    out = {}
    for key, value in _FIELD_RE.findall(line):
        out.setdefault(key, value.strip("\"'"))
    # USER_* records carry the useful part inside msg='...'.
    inner = re.search(r"msg='([^']*)'", line)
    if inner:
        for key, value in _FIELD_RE.findall(inner.group(1)):
            out[key] = value.strip("\"'")
    return out


def _proctitle(raw: str) -> str:
    if re.fullmatch(r"[0-9A-Fa-f]+", raw or ""):
        return bytes.fromhex(raw).replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    return raw or ""


def _ausearch(args: list[str], since: float) -> list[dict]:
    """Audit events (grouped by serial) since ``since``. [] when none."""
    stamp = time.localtime(since)
    cmd = ["ausearch", "--input-logs", "--raw", "--start", time.strftime("%x", stamp),
           time.strftime("%X", stamp), *args]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env={**os.environ, "LC_ALL": "C"})
    if out.returncode not in (0, 1):  # 1 = no matches
        raise RuntimeError(f"ausearch failed: {out.stderr.strip()[:300]}")
    events: dict[str, dict] = defaultdict(dict)
    for line in out.stdout.splitlines():
        m = _AUDIT_MSG_RE.search(line)
        if not m:
            continue
        rtype = line.split(" ", 1)[0].removeprefix("type=")
        ev = events[m.group(2)]
        ev["ts"] = int(m.group(1))
        ev[rtype] = _fields(line)
        if rtype == "PROCTITLE":
            ev["proctitle"] = _proctitle(ev[rtype].get("proctitle", ""))
    return list(events.values())


def audit_logins(since: float) -> list[dict]:
    """Login sessions that opened (SSH, cron, console), any user."""
    rows = []
    for ev in _ausearch(["-m", "USER_START"], since):
        f = ev.get("USER_START", {})
        exe = f.get("exe", "")
        rows.append({
            "ts": ev["ts"], "ses": f.get("ses"), "user": f.get("acct", "?"),
            "via": "ssh" if exe.endswith("sshd") else "cron" if exe.endswith("cron") else Path(exe).name or "?",
            "ip": f.get("addr") if f.get("addr") not in (None, "?") else "",
            "ok": f.get("res") == "success",
        })
    return rows


def session_origins(logins: list[dict]) -> dict[str, dict]:
    """Where each audit session started. sudo and su open a record of their own
    inside the session they run in, so only the first non-sudo record counts:
    otherwise an SSH user's `sudo cat x` reads as "the sudo session of root"."""
    origin: dict[str, dict] = {}
    for lg in sorted(logins, key=lambda lg: lg["ts"]):
        if lg["via"] not in ("sudo", "su"):
            origin.setdefault(lg["ses"], lg)
    return origin


def _sample(cmds: list[dict], n: int = 3) -> str:
    return "; ".join(f"`{c}`" for c in sorted({c["cmd"][:80] for c in cmds})[:n])


def _ssh_group_line(user: str, ip: str, group: list[dict], by_ses: dict, root_by_ses: dict) -> str:
    cmds = [c for lg in group for c in by_ses.get(lg["ses"], [])]
    roots = [c for lg in group for c in root_by_ses.get(lg["ses"], [])]
    when = lambda lg: time.strftime("%H:%M", time.localtime(lg["ts"]))
    head = (f"SSH login as {user} from {ip} at {when(group[0])}" if len(group) == 1 else
            f"{len(group)} SSH logins as {user} from {ip} between {when(group[0])} and {when(group[-1])}")
    progs = Counter(Path(c["exe"]).name for c in cmds).most_common(4)
    line = head + f", {len(cmds)} command(s)" + (f" ({', '.join(p for p, _ in progs)})" if progs else "")
    if roots:
        line += f", {len(roots)} as root (sudo), e.g. {_sample(roots)}"
    return line


_SUDO_LIST_RE = re.compile(r"^sudo( -n)? -l$")  # lists permissions, runs nothing (ShellTeam's own health probe)


def audit_commands(since: float) -> list[dict]:
    """Programs started from login sessions other than ShellTeam's own, and
    sudo/su. Only real program starts (an EXECVE record), not rule changes."""
    rows = []
    for key in ("shellteam-login", "shellteam-root"):
        for ev in _ausearch(["-k", key], since):
            if "EXECVE" not in ev:
                continue
            sc = ev.get("SYSCALL", {})
            cmd = ev.get("proctitle") or sc.get("comm", "")
            if key == "shellteam-root" and _SUDO_LIST_RE.match(cmd):
                continue
            rows.append({"ts": ev["ts"], "key": key, "ses": sc.get("ses"), "uid": sc.get("uid"),
                         "exe": sc.get("exe", ""), "cmd": cmd})
    return rows


def shellteam_session() -> str | None:
    """The audit session ShellTeam's services (agents, web terminal) run in:
    the owner's systemd user manager's."""
    out = subprocess.run(["systemctl", "show", f"user@{os.getuid()}.service", "-p", "MainPID", "--value"],
                         capture_output=True, text=True, timeout=30)
    pid = out.stdout.strip()
    if not pid or pid == "0":
        return None
    return Path(f"/proc/{pid}/sessionid").read_text().strip()


#: How long after the first check new scheduled jobs are learned, not flagged.
#: A week plus a day covers weekly jobs.
SCHEDULED_LEARNING_SECONDS = 8 * 86400


def command_log_started() -> float | None:
    """When the oldest record still in the audit log was written."""
    logs = sorted(Path("/var/log/audit").glob("audit.log*"), key=lambda f: f.stat().st_mtime)
    for f in logs:
        with f.open(errors="replace") as fh:
            m = _AUDIT_MSG_RE.search(fh.readline())
        if m:
            return float(m.group(1))
    return None


def ssh_logins_from_last(since: float) -> list[dict]:
    """SSH logins from wtmp (works without the command log)."""
    args = ["last", "-i", "--time-format", "iso"] + (["--since", f"@{int(since)}"] if since else [])
    out = subprocess.run(args, capture_output=True, text=True, timeout=60)
    rows = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1].startswith("pts/"):
            rows.append({"user": parts[0], "ip": parts[2], "when": parts[3], "via": "ssh", "ok": True})
    return rows


# --- The daily check -----------------------------------------------------------


def summarize(since: float, update_known: bool = False) -> dict:
    """Everything security-relevant since ``since``, split into ``unusual``
    (worth your attention) and ``normal`` (for the record)."""
    unusual: list[str] = []
    normal: list[str] = []
    state = _load_state()
    first_run = not state
    events = journal_events(since)

    signins = [e for e in events if e["event"] == "signin" and e.get("kind") != "migrated"]
    for e in signins:
        line = f"Sign-in {_SIGNIN_HOW.get(e.get('kind'), '')} from {e.get('ip')}, {e.get('browser')}"
        if e.get("kind") == "enroll" or e.get("new_ip"):
            unusual.append(line + (" (new network)" if e.get("new_ip") else " (a new device)"))
        else:
            normal.append(line)
    for e in events:
        if e["event"] == "token_changed":
            unusual.append(f"The master token was changed ({e.get('sessions_revoked', 0)} device(s) signed out). "
                           "Fine if it was you.")
        elif e["event"] == "terminal_open":
            line = f"Web terminal opened from {e.get('ip')}"
            (unusual if e.get("new_ip") else normal).append(line + (" (new network)" if e.get("new_ip") else ""))
        elif e["event"] == "signout_all":
            normal.append(f"Log out everywhere ({e.get('sessions_revoked', 0)} device(s))")
    failures = Counter(e.get("ip") for e in events if e["event"] == "auth_failure")
    if failures:
        top = ", ".join(f"{ip} x{n}" for ip, n in failures.most_common(3))
        line = f"{sum(failures.values())} wrong-token attempt(s) from {len(failures)} address(es) ({top})"
        (unusual if failures.most_common(1)[0][1] >= 20 else normal).append(line)

    known_ssh = set(state.get("ssh_networks", []))
    known_scheduled = set(state.get("scheduled", []))
    new_ssh, new_scheduled = set(), set()
    if command_log_enabled():
        # Sessions can outlive the window (an SSH login from yesterday still
        # open): find where each one started up to a week back.
        all_logins = audit_logins(since - 7 * 86400)
        logins = [lg for lg in all_logins if lg["ts"] >= since]
        origin = session_origins(all_logins)
        commands = audit_commands(since)
        by_ses, root_by_ses = defaultdict(list), defaultdict(list)
        for c in commands:
            (by_ses if c["key"] == "shellteam-login" else root_by_ses)[c["ses"]].append(c)
        ssh_groups = defaultdict(list)  # an agent on a laptop logs in once per command: one line per person+address
        for lg in logins:
            if lg["via"] == "ssh" and lg["ok"] and origin.get(lg["ses"]) is lg:
                ssh_groups[(lg["user"], lg["ip"])].append(lg)
        for (user, ip), group in ssh_groups.items():
            line = _ssh_group_line(user, ip, group, by_ses, root_by_ses)
            if ip and network_of(ip) not in known_ssh:
                new_ssh.add(network_of(ip))
                unusual.append(line + " (new network)")
            else:
                normal.append(line)
        failed_ssh = [lg for lg in logins if lg["via"] == "ssh" and not lg["ok"]]
        if failed_ssh:
            normal.append(f"{len(failed_ssh)} failed SSH login attempt(s)")
        scheduled = {c["cmd"][:160] for lg in logins if lg["via"] == "cron" for c in by_ses.get(lg["ses"], [])}
        learning = time.time() < state.get("learn_scheduled_until", 0)
        for cmd in sorted(scheduled - known_scheduled):
            new_scheduled.add(cmd)
            if learning:  # nightly jobs haven't run yet when the baseline is taken
                normal.append(f"Learned a scheduled job (first day of the command log): `{cmd}`")
            else:
                unusual.append(f"A scheduled job ran a command not seen before: `{cmd}`")
        if scheduled & known_scheduled:
            normal.append(f"{len(scheduled & known_scheduled)} known scheduled command(s) ran")
        ours = shellteam_session()
        by_ses.pop(ours, None)  # recorded before the rule excluded it (rule just installed)
        login_ses = {lg["ses"] for lg in logins}
        for ses, cs in by_ses.items():
            lg = origin.get(ses)
            if ses in login_ses or lg is None:
                continue
            normal.append(f"{len(cs)} command(s) in the {lg['via']} session of {lg['user']} from "
                          f"{lg['ip'] or 'this box'} opened {time.strftime('%Y-%m-%d %H:%M', time.localtime(lg['ts']))}")
        orphan = [c for ses, cs in by_ses.items() if ses not in origin for c in cs]
        if orphan:
            sample = "; ".join(sorted({c["cmd"][:80] for c in orphan})[:5])
            started = command_log_started()
            if started and started > since - 7 * 86400:
                # The log is younger than a week: these sessions simply began
                # before it existed (an SSH login left open, a long tmux).
                normal.append(f"{len(orphan)} command(s) in session(s) opened before the command log started "
                              f"({time.strftime('%Y-%m-%d %H:%M', time.localtime(started))}): {sample}")
            else:
                unusual.append(f"{len(orphan)} command(s) from a login session with no known start (not SSH, "
                               f"not cron, not in the last week): {sample}")
        roots = [c for c in commands if c["key"] == "shellteam-root"]
        mine = [c for c in roots if c["ses"] == ours]
        if mine:
            sample = "; ".join(sorted({c["cmd"][:60] for c in mine})[:3])
            normal.append(f"{len(mine)} root command(s) run by your agents or ShellTeam (sudo), e.g. {sample}")
        grouped = {lg["ses"] for g in ssh_groups.values() for lg in g}  # already counted on their login line
        for ses, cs in root_by_ses.items():
            if ses == ours or ses in grouped:
                continue
            lg = origin.get(ses)
            if lg is None:
                unusual += [f"Root command from a session with no known start: `{c['cmd'][:120]}`" for c in cs]
            else:
                normal.append(f"{len(cs)} root command(s) in the {lg['via']} session of {lg['user']}"
                              f"{' from ' + lg['ip'] if lg['ip'] else ''}, e.g. {_sample(cs)}")
    else:
        for lg in ssh_logins_from_last(since):
            line = f"SSH login as {lg['user']} from {lg['ip']} at {lg['when']}"
            if network_of(lg["ip"]) not in known_ssh:
                new_ssh.add(network_of(lg["ip"]))
                unusual.append(line + " (new network)")
            else:
                normal.append(line)

    if first_run:
        # Nothing to compare against yet: today's addresses and jobs become the
        # baseline, listed for the record rather than flagged.
        baseline = [u for u in unusual if "(new network)" in u or "not seen before" in u]
        unusual = [u for u in unusual if u not in baseline]
        normal += [u.replace(" (new network)", "").replace("ran a command not seen before", "runs") for u in baseline]
        # Every address that ever logged in over SSH (wtmp) is the owner's usual.
        new_ssh |= {network_of(lg["ip"]) for lg in ssh_logins_from_last(0) if lg["ip"]}
        # ...and every network the dashboard was signed in from (60 days of journal).
        state["signin_networks"] = sorted(set(state.get("signin_networks", [])) | past_signin_networks())
        # Scheduled jobs run nightly or weekly, so the first check rarely sees
        # them: anything scheduled in the next 8 days joins the baseline quietly.
        state["learn_scheduled_until"] = time.time() + SCHEDULED_LEARNING_SECONDS
        normal.append("First check on this box: today's addresses and scheduled jobs are now the known baseline.")
    if update_known and (new_ssh or new_scheduled or first_run):
        state["ssh_networks"] = sorted(known_ssh | new_ssh)
        state["scheduled"] = sorted(known_scheduled | new_scheduled)
        _save_state(state)
    return {"since": int(since), "until": int(time.time()), "unusual": unusual, "normal": normal,
            "command_log": command_log_enabled(), "domain": _domain()}


def render_markdown(summary: dict) -> str:
    lines = []
    if summary["unusual"]:
        lines.append(f"**{len(summary['unusual'])} thing(s) to look at**")
        lines += [f"- {u}" for u in summary["unusual"]]
    else:
        lines.append("**Nothing unusual.**")
    if summary["normal"]:
        lines += ["", "**For the record**"] + [f"- {n}" for n in summary["normal"]]
    if not summary["command_log"]:
        lines += ["", "_The command log is off on this box (install with `--command-log` to record SSH and "
                      "sudo commands in a log an intruder can't erase)._"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m api.services.security_watch")
    p.add_argument("--hours", type=float, default=24)
    p.add_argument("--format", choices=("markdown", "json"), default="markdown")
    p.add_argument("--notify", action="store_true",
                   help="message the owner when something is unusual, and remember today's addresses")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    summary = summarize(time.time() - a.hours * 3600, update_known=a.notify)
    print(json.dumps(summary, indent=1) if a.format == "json" else render_markdown(summary), end="")
    if a.notify and summary["unusual"]:
        result = asyncio.run(notify.send_notification(
            f"ShellTeam: {len(summary['unusual'])} unusual thing(s) on {summary['domain']}",
            "\n".join(f"- {u}" for u in summary["unusual"])))
        if not result.get("ok"):
            log.error("Daily security check: the alert could not be delivered (%s)", result)
            return 1
    log.info("Daily security check done: %d unusual, %d normal", len(summary["unusual"]), len(summary["normal"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
