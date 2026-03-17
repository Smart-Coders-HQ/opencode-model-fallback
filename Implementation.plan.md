# Implementation Plan — opencode-model-fallback

## Status: All phases complete.

---

## Context

When using OpenCode with `openai/gpt-5.3-codex` as the primary model, rate limits and quota exhaustion cause OpenCode to enter a retry loop — sometimes waiting hours. There's no automatic failover. The existing `opencode-rate-limit-fallback` plugin only supports a single fallback model. Native support (Issue #7602) is still in discussion.

This plugin fills the gap with per-agent ordered fallback chains, a health state machine, and config aligned with the proposed native API for easy migration.

**User decisions:**

- UX: Inline toast notification on fallback + `/fallback-status` command
- Usage tracking: Leverage OpenCode's native token/cost data, enriched with fallback context
- Backward compat: Auto-migrate from old `rate-limit-fallback.json` format
- Subagents: Independent per-agent fallback chains and health tracking

---

## Architecture

### File Structure

```
opencode-model-fallback/
├── package.json                  # name: @smart-coders-hq/opencode-model-fallback
├── tsconfig.json                 # ES2022, ESNext modules
├── index.ts                      # Re-exports createPlugin from src/plugin.ts
├── biome.json                    # Biome lint/format configuration
├── .releaserc.json               # semantic-release configuration
├── CHANGELOG.md                  # Release notes maintained by semantic-release
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                # CI quality gates (lint, test, typecheck, build)
│   │   └── release.yml           # semantic-release pipeline on main
│   └── dependabot.yml            # Weekly dependency updates
├── src/
│   ├── plugin.ts                 # Plugin entry point — event router + chat.message hook
│   ├── preemptive.ts             # Sync preemptive redirect logic for chat.message hook
│   ├── types.ts                  # Shared type definitions
│   ├── config/
│   │   ├── schema.ts             # Zod schemas + validation + security bounds
│   │   ├── loader.ts             # Config discovery (.opencode/ → ~/.config/opencode/)
│   │   ├── defaults.ts           # Default config values (single source of truth)
│   │   ├── migrate.ts            # Auto-migration from old rate-limit-fallback.json
│   │   └── agent-loader.ts       # Parse fallback chains from agent .md/.json files
│   ├── detection/
│   │   ├── classifier.ts         # Error classification (rate_limit, 5xx, timeout, etc.)
│   │   └── patterns.ts           # Case-insensitive pattern matching
│   ├── state/
│   │   ├── model-health.ts       # Per-model health state machine
│   │   ├── session-state.ts      # Per-session fallback tracking + processing lock
│   │   └── store.ts              # Centralized in-memory store (single entry point)
│   ├── resolution/
│   │   ├── fallback-resolver.ts  # Walk fallback chain, select next healthy model
│   │   └── agent-resolver.ts     # Map session → agent → fallback config
│   ├── replay/
│   │   ├── orchestrator.ts       # abort → revert → prompt sequence (the fragile part)
│   │   └── message-converter.ts  # Convert stored message parts → prompt input format
│   ├── display/
│   │   ├── notifier.ts           # Inline notifications via client.tui.showToast()
│   │   └── usage.ts              # Query OpenCode's native usage data for fallback periods
│   ├── tools/
│   │   └── fallback-status.ts    # /fallback-status custom tool (Zod schema + execute)
│   └── logging/
│       └── logger.ts             # Structured file + client.app.log() logging
├── test/
│   ├── config.test.ts            # ✓ Config validation, schema, migration
│   ├── detection.test.ts         # ✓ Pattern matching, error classification
│   ├── health.test.ts            # ✓ Health state machine
│   ├── fallback.test.ts          # ✓ Chain resolution, session state, locks
│   ├── replay.test.ts            # ✓ Message part conversion
│   ├── orchestrator.test.ts      # ✓ Integration: full fallback flow, cascading, concurrency, depth reset
│   ├── preemptive.test.ts        # ✓ Preemptive redirect, depth reset, session sync, no circular trigger
│   ├── plugin.test.ts            # ✓ Event handler hardening (malformed payloads, recovery toast dedupe)
│   ├── fallback-status.test.ts   # ✓ Tool output with partially seeded session state
│   ├── agent-loader.test.ts      # ✓ Agent file parsing, frontmatter, overrides
│   └── helpers/
│       └── mock-client.ts        # Mock OpenCode client for integration tests
└── examples/
    └── model-fallback.json       # Example config
```

### Core Data Structures

```typescript
// Model health — tracked GLOBALLY per model (rate limits are account-wide)
interface ModelHealth {
  modelKey: string; // "anthropic/claude-sonnet-4-20250514"
  state: "healthy" | "rate_limited" | "cooldown";
  lastFailure: number | null; // Date.now() of last rate limit hit
  failureCount: number;
  cooldownExpiresAt: number | null; // when rate_limited → cooldown
  retryOriginalAt: number | null; // when cooldown → healthy
}

// Session state — tracked PER SESSION (independent per-agent)
interface SessionFallbackState {
  sessionId: string;
  agentName: string | null; // resolved lazily from messages API
  originalModel: ModelKey | null;
  currentModel: ModelKey | null;
  fallbackDepth: number;
  isProcessing: boolean; // mutex for replay operations
  lastFallbackAt: number | null; // deduplication window
  fallbackHistory: FallbackEvent[]; // for /fallback-status reporting
}
```

### Critical Code Paths

#### Path A: Preemptive Redirect (fast, no 429)

```
chat.message hook fires (new user message)
  │
  ├─ Sync session state: setOriginalModel, detect TUI revert → reset fallbackDepth
  ├─ Check model health: is target model rate_limited?
  │   └─ No → return (message proceeds normally)
  │
  ├─ Resolve fallback chain → pick healthy model
  ├─ Mutate output.message.model → redirect to fallback
  └─ Message goes directly to fallback model (no 429 round-trip)
```

#### Path B: Reactive Fallback (after 429 error)

```
session.status event (type: "retry", message: "Rate limited...")
  │
  ├─ Pattern match against config.patterns (case-insensitive includes)
  ├─ Classify: rate_limit | quota_exceeded | 5xx | timeout | overloaded
  ├─ Check: is category in config.defaults.fallbackOn?
  │
  ├─ Acquire per-session processing lock (prevents double-fallback)
  ├─ Check deduplication window (3s since lastFallbackAt)
  │
  ├─ Resolve agent name (from cache or client.session.messages())
  ├─ Look up fallback chain: config.agents[agentName] ?? config.agents["*"]
  │
  ├─ Fetch messages → sync currentModel (detect TUI revert → reset fallbackDepth)
  ├─ Check maxFallbackDepth not exceeded (after sync so reset takes effect)
  ├─ Walk chain: skip rate_limited models, prefer healthy, cooldown as last resort
  │
  ├─ Step 1: client.session.abort() — stop retry loop
  ├─ Step 2: client.session.revert({ messageID }) — undo failed attempt
  ├─ Step 3: client.session.prompt({ model: fallbackModel, parts }) — replay
  │
  ├─ Update state: mark original model rate_limited, increment fallbackDepth
  ├─ Notify user: inline toast "Switched from X to Y (rate_limit)"
  └─ Log: structured entry to file + client.app.log()
```

### Health State Machine

```
healthy ──[rate limit detected]──→ rate_limited
rate_limited ──[cooldownMs elapsed]──→ cooldown
cooldown ──[retryOriginalAfterMs elapsed]──→ healthy
```

- Transitions checked by periodic timer (every 30s)
- Model health is global (shared across sessions) — rate limits are account-wide
- Session fallback chains are independent per-agent

### Recovery Logic

- Do NOT auto-switch back mid-conversation
- On `session.idle`, if original model recovered → show toast: "Original model available again"
- New sessions always prefer the configured (original) model if healthy

### Concurrency Safety

1. **Per-session processing lock** — only one fallback operation at a time per session
2. **3-second deduplication window** — prevents stale retry events from re-triggering
3. **Replay tracking** — lock + dedup window cover re-entry; explicit pre-prompt timestamp pending (omf-owh.2)
4. **Session deletion guard** — `session.deleted` cleans up state; each replay step has try/catch

---

## Config Schema

**File: `model-fallback.json`** (checked: `.opencode/` → `~/.config/opencode/`)

```json
{
  "enabled": true,
  "defaults": {
    "fallbackOn": [
      "rate_limit",
      "quota_exceeded",
      "5xx",
      "timeout",
      "overloaded"
    ],
    "cooldownMs": 300000,
    "retryOriginalAfterMs": 900000,
    "maxFallbackDepth": 3
  },
  "agents": {
    "build": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-3-pro",
        "openai/gpt-4o"
      ]
    },
    "*": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-flash-2-5"
      ]
    }
  },
  "patterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded",
    "overloaded",
    "capacity exceeded",
    "credits exhausted",
    "billing limit",
    "429"
  ],
  "logging": true,
  "logPath": "~/.local/share/opencode/logs/model-fallback.log"
}
```

**Validation bounds** (enforced by Zod):

- `cooldownMs` minimum: 10000 (10s)
- `maxFallbackDepth` maximum: 10
- `logPath` must be within `$HOME`
- Model identifiers must match `^[a-zA-Z0-9_-]+/[a-zA-Z0-9._-]+$`

**Auto-migration** from old `rate-limit-fallback.json`:

- `fallbackModel` (string) → `agents.*.fallbackModels: [model]`
- `cooldownMs`, `patterns`, `logging` map directly

---

## Known Risks & Mitigations

| Risk                                  | Severity | Mitigation                                                                             |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| abort→revert→prompt race window       | High     | Per-session mutex, dedup window, guard checks between each step                        |
| Agent name not on Session type        | Medium   | Fetch from messages API, cache in session state                                        |
| Fallback model also rate-limited      | Medium   | Event loop naturally re-triggers detection; maxFallbackDepth prevents infinite cascade |
| Session deleted during replay         | Low      | Check session exists before each step; graceful abort                                  |
| Config malformed                      | Low      | Zod partial validation; use defaults for invalid fields, log warnings                  |
| Log path traversal                    | Low      | Validate within $HOME                                                                  |
| Stale events after abort              | Medium   | 3-second deduplication window after lastFallbackAt                                     |
| Compaction disrupts message history   | Medium   | Tracked: omf-owh.3                                                                     |
| Manual model switch makes state stale | Low      | Tracked: omf-owh.4                                                                     |

**Fundamental fragility**: The abort-revert-prompt sequence has no transactional guarantee. If revert succeeds but prompt fails, the session is left in a reverted state. The user can manually retry. All failures are logged with enough context for manual recovery.

---

## Phased Implementation

### Phase 1: Foundation — Config + Detection + Logging ✓

- Project scaffolding: `package.json`, `tsconfig.json`
- `src/types.ts` — shared type definitions
- `src/config/*` — Zod schema, file discovery, defaults, old-format migration
- `src/detection/*` — pattern matching, error classification
- `src/logging/logger.ts` — structured file + app.log logging
- `src/plugin.ts` — `session.status` and `session.error` event handlers

### Phase 2: Single-Model Fallback — Replay Mechanism ✓

- `src/state/*` — FallbackStore, ModelHealth, SessionFallbackState, processing lock
- `src/replay/orchestrator.ts` — abort → revert → prompt sequence
- `src/replay/message-converter.ts` — convert message parts for replay
- `src/display/notifier.ts` — inline toast notification on fallback

### Phase 3: Ordered Chains + Health State Machine ✓

- `src/state/model-health.ts` — full state machine with timer-based transitions
- `src/resolution/fallback-resolver.ts` — chain walker with healthy/cooldown priority
- `src/resolution/agent-resolver.ts` — agent→config with wildcard fallback
- Full `maxFallbackDepth` cascading enabled

### Phase 4: Recovery + Status Command + Usage ✓

- `src/display/usage.ts` — token/cost breakdown by model period
- `src/tools/fallback-status.ts` — `/fallback-status` tool with verbose flag
- Recovery on `session.idle` — toast when original model recovers

### Phase 5: Polish + Packaging ✓

All issues resolved:

- omf-owh.1: Integration tests — `test/orchestrator.test.ts` + `test/helpers/mock-client.ts`
- omf-owh.2: Fix replay dedup race window — optimistic `lastFallbackAt` in orchestrator
- omf-owh.3: Session compaction edge case — `session.compacted` handler in plugin.ts
- omf-owh.4: Manual model switch staleness — model sync in orchestrator
- omf-owh.5: README — comprehensive docs with config examples, migration guide, troubleshooting

### Phase 6: Preemptive Fallback + Depth Reset ✓

Addresses two problems: wasted 429 round-trips per message after a successful fallback, and `fallbackDepth` exhaustion from TUI model reverts.

- **Depth reset on TUI revert** — orchestrator model sync block detects revert to `originalModel` and resets `fallbackDepth = 0`; depth check moved after sync so reset takes effect before the guard
- **Preemptive redirect** — `src/preemptive.ts` with `tryPreemptiveRedirect()` for testable sync logic; `chat.message` hook in `src/plugin.ts` mutates `output.message.model` to redirect rate-limited models before they hit the provider
- **Tests** — 3 new orchestrator depth-reset tests, full `test/preemptive.test.ts` suite (redirect, depth reset, session sync, no circular triggering)

---

## Verification Plan

1. **Unit tests** (per module): config validation, pattern matching, classification, health transitions, chain resolution, message conversion, agent loader, preemptive redirect, plugin events, fallback-status tool — **101/101 passing**
2. **Integration tests** (mock client): full fallback flow, cascading, max depth, concurrent events, session deletion — **complete**
3. **Manual E2E test**: Install as local plugin, configure fallback chains, trigger rate limit, verify:
   - Detection logged correctly
   - Session aborted, reverted, replayed with fallback model
   - Inline toast shown
   - `/fallback-status` shows correct state
   - After cooldown, new session uses original model
4. **Stress test**: Rapid-fire retry events to verify dedup + mutex prevent double-fallback

---

## API Surface Used

- `@opencode-ai/plugin` — Plugin type, `tool()` helper, Zod via `tool.schema`
- `client.session.abort/revert/prompt/messages` — Core replay mechanism
- `client.tui.showToast()` — User-facing notifications
- `client.app.log()` — Structured logging to OpenCode's log system
- OpenCode's native token/cost tracking via `AssistantMessage.tokens` / `.cost`
- Zod (peer dep from `@opencode-ai/plugin`) — config validation
