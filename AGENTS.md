# FireDrill AR — shared agent instructions

Committed and shared by the whole team, for any coding agent (Claude Code, Codex, Cursor, Copilot, …). Personal preferences go in your agent's local or global config (e.g. `CLAUDE.local.md`, gitignored), not here.

`README.md` is the team handbook: idea, roles, file ownership, shared contracts, timeline. Read it before making changes.

## Keep the docs current

With every commit or meaningful bit of progress, update the docs in the same commit:

- **`README.md`** — if you changed a shared contract (section 7: `room.json`, scenario functions, effects API, drill API, voice commands, haptics message), a setup step, the folder layout, ports/URLs, or a troubleshooting fix you discovered.
- **Progress** — tick off or note status in the build plan (section 8) for the owner's steps, e.g. `✅ done`, `🚧 in progress`, `⚠️ blocked: <why>`.
- Any other `.md` in the repo that the change makes stale.

Keep edits short and factual. Don't rewrite other people's sections beyond what your change affects.

## Team rules (from the handbook)

- Only edit files you own (section 5 / folder layout). Touching someone else's file? Say so in the commit message.
- Work on your own branch (`prakhar`, `varnika`, `eileen`, `devaj`, `emma`); Prakhar merges into `main`.
- Never commit `server/.env` or any API key.
- After 5:30 PM: no new features, fixes only.
- The team is mixed Mac (Prakhar, Varnika, Emma) and Windows (Eileen, Devaj). Code and commands must work on both; follow README section 5, "Mac vs Windows". Add new cross-platform gotchas there.
