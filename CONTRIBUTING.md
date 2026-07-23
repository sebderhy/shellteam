# Contributing to ShellTeam

Thanks for helping! ShellTeam is a single-user, self-hosted cockpit for coding
agents — read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first for the lay of
the land.

## Dev setup

```bash
git clone https://github.com/sebderhy/shellteam && cd shellteam
uv sync                                   # Python deps (Python 3.12+)
uv pip install pytest pytest-asyncio respx  # test deps (uv sync --group dev doesn't work)
cd computer/ai-chat && npm install        # cockpit deps
```

Run the API locally: `uv run uvicorn api.main:app --host 127.0.0.1 --port 8000`.

## Tests

```bash
uv run pytest                             # Python suite (hermetic — pins its own env)
cd computer/ai-chat && npm test           # cockpit suite (node --test)
```

Both suites must be green before a PR. New functionality needs tests — including
bug fixes (a regression test that fails before the fix).

## Hard rules

- **Never write to the user's coding-agent config** (`~/.claude`,
  `~/.claude.json`, `~/.codex`, `~/.gitconfig`, …). ShellTeam's additions load
  at agent-spawn time from `~/.shellteam/agent-layer/` only. See
  [docs/design/vps-footprint.md](docs/design/vps-footprint.md).
- **Fail loudly, log generously.** No silent `except`/`catch` — every
  significant operation logs its outcome so issues can be diagnosed from
  `journalctl` alone.
- **No Cloud concepts.** The multi-tenant Cloud edition is a separate codebase.
  Don't reintroduce containers-per-user, Supabase, billing tiers, or
  "included/managed" copy here.

## Conventions

- Python: type hints, async/await, Pydantic schemas, Black formatting, `uv`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- Keep code DRY — extract shared logic instead of copy-pasting.
- Significant decisions get a doc in `docs/decisions/YYYYMMDD-<slug>.md`
  (context, decision, reasoning, revisit triggers).

## Contributor License Agreement (CLA)

Your **first** pull request will get a comment from the CLA bot — sign once
(a single reply comment) and every future PR is covered. The agreement is
short and readable: [CLA.md](CLA.md). In one sentence: you keep your
copyright, your contribution stays AGPL-3.0 for everyone, and the maintainer
may also license it under other terms (which is how an independent project
like this stays funded). No `Signed-off-by:` line is needed — the CLA covers
provenance. See
[docs/decisions/20260717-cla-over-dco.md](docs/decisions/20260717-cla-over-dco.md).

## Reporting bugs

Use GitHub issues, or — if you run ShellTeam — the in-product **Send feedback**
button, which files straight to the maintainers with logs and a screenshot.
