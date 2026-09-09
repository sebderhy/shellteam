## What & why


## How it was verified

- [ ] `uv run pytest` green
- [ ] `cd computer/ai-chat && npm test` green
- [ ] Exercised end-to-end on a running box (describe)

## Hard-rule check

- [ ] No writes to user dotfiles (`~/.claude`, `~/.codex`, …)
- [ ] No silent error swallowing; new operations log their outcome
