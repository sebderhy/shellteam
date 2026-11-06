# Know when someone gets in

Date: 2026-11-06. Ticket: SHE-149.

## Context

After the 2026-11-03 break-in the owner asked: can we tell whether a hacker
ran commands? We couldn't reliably. Everything ShellTeam runs is the owner's
user, so an intruder with a shell can delete anything that user owns (bash
history, agent transcripts), and nothing told the owner when someone signed in.

## Decision

1. **Security events.** Sign-ins, new devices, token changes, web terminals and
   wrong tokens are written to the journal as `SECURITY {json}` lines (the
   journal is root-owned). All but wrong tokens also message the owner on the
   `NOTIFY_*` channel. "New" is judged per network (two IPv4 numbers, three IPv6
   groups): a phone changes address all day inside its carrier's range.
2. **Command log (`--command-log`, part of `--full`).** auditd records sudo/su
   and every command run under the owner's uid from a login session other than
   the one ShellTeam's services run in. On this box the user manager itself
   has a login session (`auid` is set for agents too), so the rule excludes its
   session id; a root drop-in on `user@<uid>` re-applies the rule on each start
   because the id changes. The log is root-owned, readable by the owner's group.
3. **Daily check** (`shellteam-security.timer`, every box): messages only when
   something is unusual. Its markdown output feeds the operator's daily email.

## Limits

- A hijacked agent runs inside ShellTeam's own session, which the command log
  leaves out (that is the agents' normal work; their transcripts are the
  record). The sign-in and terminal alerts cover the cockpit's front door.
- Root can erase the audit log too. Alerts already sent off-box can't be.
- Existing boxes get the alerts and the daily check on update; the command log
  needs `./install.sh --command-log` once (it installs a system package).

## Revisit when

- Agents get their own uid (then the command log can cover them too).
- Owners want the record shipped off-box continuously, not only alerts.
