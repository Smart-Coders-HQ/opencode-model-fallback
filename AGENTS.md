# opencode-model-fallback — Agent Guide

## Project

OpenCode plugin that adds ordered model fallback chains with a health state machine. When the primary model hits a rate limit, it automatically aborts the retry loop, reverts the failed message, and replays it with the next healthy model in the configured chain. Includes preemptive redirect via `chat.message` hook to avoid 429 round-trips entirely.

**Stack:** TypeScript, Bun, `@opencode-ai/plugin` SDK, Zod

## Commands

```bash
bun test              # Run all unit tests (145 tests across 11 files)
bunx tsc --noEmit     # Type check
bun run build         # Build to dist/
```

## Implementation Cycle Checklist

After each successful implementation cycle (feature, fix, refactor), execute all of the following before considering the work done:

1. **Quality gates**
   ```bash
   bun test              # All tests pass
   bunx tsc --noEmit     # No type errors
   bun run build         # Clean build
   ```
2. **Update project docs** — Keep these files in sync with the code:
   - `AGENTS.md` — Architecture diagram, test counts, file structure, key invariants
   - `Implementation.plan.md` — Phase status, verification plan test counts, new phases/tasks
   - `README.md` — Test counts, feature descriptions, troubleshooting entries
3. **Update metadata** — If new modules/files were added, reflect them in the architecture sections above and in `Implementation.plan.md`'s file structure

## Architecture

```
src/
  plugin.ts           # Entry point — event router + chat.message hook (preemptive redirect)
  preemptive.ts       # Sync preemptive redirect logic for chat.message hook
  types.ts            # Shared type definitions
  config/             # Zod schema, file discovery, defaults, auto-migration
  detection/          # Pattern matching + error classification
  state/              # ModelHealthStore (global), SessionStateStore (per-session), FallbackStore
  resolution/         # Chain walker, agent→config resolver
  replay/             # abort→revert→prompt orchestrator, message-part converter
  display/            # Toast notifications, usage enrichment
  tools/              # /fallback-status tool
  logging/            # Structured file + client.app.log() logger
```

Key invariants:

- **Model health is global** — rate limits are account-wide, shared across all sessions
- **Session state is per-session** — independent fallback depth and history per agent
- **No mid-conversation auto-switch** — once fallen back, stays on fallback model until session ends
- **Replay is fragile** — abort→revert→prompt has no transactional guarantee; failures are logged
- **Preemptive redirect** — `chat.message` hook redirects messages away from rate-limited models before they hit the provider, avoiding 429 round-trips
- **Depth resets on TUI revert** — when the TUI reverts to the original model between messages, `fallbackDepth` resets to 0 so `maxFallbackDepth` only guards true cascading within a single message

## Issue Tracking (bd / beads)

This project uses **bd (beads)** for all task and issue tracking. Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.

Run `bd prime` at session start for full workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Periodic checks — do these at the start of each session and before closing:**

```bash
bd ready                    # Find unblocked work ready to start
bd list --status=open       # See all open issues
bd list --status=in_progress  # Check active work (yours or others')
bd stats                    # Project health overview
```

**Working on issues:**

```bash
bd show <id>                # View issue details + dependencies
bd update <id> --claim      # Claim an issue before starting work
bd close <id>               # Complete work (close multiple: bd close <id1> <id2> ...)
bd close <id> --reason="why"  # Close with explanation
```

**Creating issues:**

```bash
bd create --title="Summary" --description="Why and what" --type=task|bug|feature --priority=2
bd dep add <issue> <depends-on>  # Add dependency
```

**Persistent memory (cross-session knowledge):**

```bash
bd remember "insight"       # Save knowledge for future sessions
bd memories <keyword>       # Search saved memories
```

**Important:**

- Always check `bd ready` and `bd list` at session start to understand current state
- Create issues BEFORE writing code; claim them when starting
- Close all completed issues before ending a session (`bd close <id1> <id2> ...`)
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files
- Do NOT use `bd edit` — it opens an interactive editor that blocks agents

## GPG Signing

Commits and tags are signed with GPG key `60BFBD78D728EEE4`.

**Local — unlock the GPG agent (run once per session):**

```bash
./scripts/gpg-unlock.sh
```

Fetches the passphrase via `op environment read opencode-env` (1Password Environments) and presets it into `gpg-agent` so subsequent `git commit`/`git tag` calls don't prompt. Env var overrides:

| Variable | Default | Purpose |
|---|---|---|
| `GPG_SIGN_KEY` | `60BFBD78D728EEE4` | Key ID to unlock |
| `OPENCODE_MANIFEST_SIGN_1PASSWORD_ENV_ID` | `opencode-env` | 1Password environment name |
| `OPENCODE_MANIFEST_SIGN_1PASSWORD_ACCOUNT` | _(CLI default)_ | 1Password account |
| `OPENCODE_MANIFEST_SIGN_1PASSWORD_VAR` | `OPENCODE_MANIFEST_SIGN_PASSPHRASE` | Variable name in the env |

**CI — GitHub Actions:**

`release.yml` uses `crazy-max/ghaction-import-gpg` with `secrets.GPG_PRIVATE_KEY` and `secrets.GPG_PASSPHRASE` stored as org-level GitHub secrets. The CI key is a dedicated key separate from the personal signing key — rotate it independently without touching local config. No 1Password service account is needed in CI.

## Testing

Unit tests live in `test/`. Run with `bun test`.

Integration tests for the replay orchestrator and full fallback flow exist in `test/orchestrator.test.ts`, using the mock client helper in `test/helpers/mock-client.ts`. Preemptive redirect tests are in `test/preemptive.test.ts`.

Plugin event-handler hardening tests are in `test/plugin.test.ts`. `/fallback-status` tool output tests are in `test/fallback-status.test.ts`.

## Config

Plugin reads `model-fallback.json` from:

1. `.opencode/model-fallback.json` (project-local)
2. `~/.config/opencode/model-fallback.json` (global)

Auto-migrates from old `rate-limit-fallback.json` format on load.
