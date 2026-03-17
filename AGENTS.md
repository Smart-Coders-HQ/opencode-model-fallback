# opencode-model-fallback — Agent Guide

## Project

OpenCode plugin that adds ordered model fallback chains with a health state machine. When the primary model hits a rate limit, it automatically aborts the retry loop, reverts the failed message, and replays it with the next healthy model in the configured chain.

**Stack:** TypeScript, Bun, `@opencode-ai/plugin` SDK, Zod

## Commands

```bash
bun test              # Run all unit tests (78 tests across 7 files)
bunx tsc --noEmit     # Type check
bun run build         # Build to dist/
```

## Architecture

```
src/
  plugin.ts           # Entry point — thin event router
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

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**

- `bd ready` — Find unblocked work
- `bd list --parent omf-owh` — See all Phase 5 remaining tasks
- `bd create "Title" --type task --priority 2` — Create issue
- `bd close <id>` — Complete work

Current open work: `bd list`

## Testing

Unit tests live in `test/`. Run with `bun test`.

Integration tests for the replay orchestrator and full fallback flow exist in `test/orchestrator.test.ts`, using the mock client helper in `test/helpers/mock-client.ts`.

## Config

Plugin reads `model-fallback.json` from:

1. `.opencode/model-fallback.json` (project-local)
2. `~/.config/opencode/model-fallback.json` (global)

Auto-migrates from old `rate-limit-fallback.json` format on load.
