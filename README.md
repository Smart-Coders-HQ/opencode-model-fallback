# opencode-model-fallback

OpenCode plugin that adds automatic model fallback when your primary model hits a rate limit or quota. Instead of waiting in a retry loop, it immediately switches to the next healthy model in a configured chain — per-agent, with a health state machine that tracks recovery.

## How it works

1. **Preemptive redirect** — intercepts outgoing messages via `chat.message` hook; if the target model is known to be rate-limited, redirects the message to a healthy fallback _before_ it hits the provider (no 429 round-trip)
2. **Reactive fallback** — if a 429 still occurs (first hit, or preemptive not available), listens for `session.status: retry` events, aborts the retry loop, reverts the failed message, and replays it with the next healthy fallback model
3. Shows an inline toast notification and logs the event
4. Tracks model health globally (rate limits are account-wide) — automatically recovers after configurable cooldown periods
5. **Depth reset** — when the TUI reverts to the original model between messages, `fallbackDepth` resets so `maxFallbackDepth` only guards true cascading failures within a single message

## Installation

Add to the `plugin` array in your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    // ... existing plugins
    "opencode-model-fallback",
  ],
}
```

Or load locally during development:

```jsonc
{
  "plugin": ["file:///path/to/opencode-model-fallback/dist/index.js"],
}
```

Then create a config file (see [Configuration](#configuration)).

## Configuration

Place `model-fallback.json` at either:

- `.opencode/model-fallback.json` — project-local
- `~/.config/opencode/model-fallback.json` — global

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

### All config fields

| Field                           | Type     | Default                                           | Description                                                              |
| ------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `enabled`                       | boolean  | `true`                                            | Enable/disable the plugin                                                |
| `defaults.fallbackOn`           | string[] | all categories                                    | Error categories that trigger fallback                                   |
| `defaults.cooldownMs`           | number   | `300000` (5 min)                                  | How long before a rate-limited model enters cooldown. Min: 10000         |
| `defaults.retryOriginalAfterMs` | number   | `900000` (15 min)                                 | How long before a cooldown model is considered healthy again. Min: 10000 |
| `defaults.maxFallbackDepth`     | number   | `3`                                               | Maximum number of fallbacks per session. Max: 10                         |
| `agents`                        | object   | `{"*": {}}`                                       | Per-agent fallback chains (see below)                                    |
| `patterns`                      | string[] | see defaults                                      | Case-insensitive substrings to match in retry messages                   |
| `logging`                       | boolean  | `true`                                            | Write structured logs to `logPath`                                       |
| `logPath`                       | string   | `~/.local/share/opencode/logs/model-fallback.log` | Log file path (must be within `$HOME`)                                   |

### Error categories

- `rate_limit` — 429, "rate limit", "too many requests", "usage limit"
- `quota_exceeded` — "quota exceeded", "credits exhausted", "billing limit"
- `overloaded` — "overloaded", "capacity exceeded"
- `timeout` — "timeout", "timed out"
- `5xx` — 500/502/503/504, "internal server error", "bad gateway"

## Per-agent chains

Configure different fallback chains for different agents using the agent name as the key. The `"*"` wildcard is used for any agent without a specific entry.

```json
{
  "agents": {
    "build": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-3-pro",
        "openai/gpt-4o"
      ]
    },
    "coder": {
      "fallbackModels": ["anthropic/claude-sonnet-4-20250514"]
    },
    "*": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-flash-2-5"
      ]
    }
  }
}
```

Models are tried in order. Rate-limited models are skipped; cooldown models are used as a last resort.

## Migrating from opencode-rate-limit-fallback

If you have an existing `rate-limit-fallback.json` config, the plugin auto-migrates it on load — no manual steps needed.

**Old format:**

```json
{
  "fallbackModel": "anthropic/claude-opus-4-5",
  "cooldownMs": 300000,
  "patterns": ["rate limit"],
  "logging": true
}
```

**Automatically converted to:**

```json
{
  "agents": { "*": { "fallbackModels": ["anthropic/claude-opus-4-5"] } },
  "defaults": { "cooldownMs": 300000 },
  "patterns": ["rate limit"],
  "logging": true
}
```

The plugin checks both `rate-limit-fallback.json` and `model-fallback.json` — old configs are found and migrated automatically.

## `/fallback-status` command

Run `/fallback-status` in any OpenCode session to see:

- Current session's fallback depth and history
- Health state of all tracked models (healthy / cooldown / rate_limited) with time remaining
- Which agent is active

With the `verbose` flag:

```
/fallback-status verbose:true
```

Includes token/cost breakdown per model period.

## Health state machine

```
healthy ──[rate limit detected]──→ rate_limited
rate_limited ──[cooldownMs elapsed]──→ cooldown
cooldown ──[retryOriginalAfterMs elapsed]──→ healthy
```

- **healthy** — model is usable; preferred for fallback selection
- **rate_limited** — recently hit a limit; skipped when walking fallback chain
- **cooldown** — cooling off; used as last resort if no healthy model is available
- State transitions are checked every 30 seconds via a background timer
- When the original model recovers to healthy, a toast appears on the next `session.idle`

## Troubleshooting

**Toast doesn't appear**
The TUI notification requires an active OpenCode TUI session. Headless/API usage won't show toasts but logs are always written.

**"no fallback chain configured"**
Your `model-fallback.json` has no `agents["*"].fallbackModels` (or no entry for the active agent). Add at least a wildcard entry with one model.

**"all fallback models exhausted"**
All configured fallback models are currently rate-limited. Wait for `cooldownMs` to elapse or add more models to the chain.

**"max fallback depth reached"**
The session has hit `maxFallbackDepth` cascading fallbacks within a single message (all models failing in sequence). Depth resets automatically when the TUI reverts to the original model between messages, so this typically indicates all configured models are rate-limited simultaneously. Start a new session or increase `maxFallbackDepth` in config.

**Check the logs:**

```bash
tail -f ~/.local/share/opencode/logs/model-fallback.log | jq .
```

Key log events: `plugin.init`, `retry.detected`, `fallback.success`, `fallback.exhausted`, `health.transition`, `recovery.available`

## Release automation

- Uses **Conventional Commits** + `semantic-release` for automated versioning/changelog/release notes
- CI runs lint, tests, type check, and build on every push/PR via `.github/workflows/ci.yml`
- Release workflow runs on `main` after successful CI via `.github/workflows/release.yml`
- To publish to npm, set repository secret `NPM_TOKEN`

## Development

```bash
bun install
bun run lint          # lint checks
bun test              # 101 tests
bunx tsc --noEmit     # type check
bun run build         # build to dist/
```

Load locally in OpenCode:

```jsonc
{ "plugin": ["file:///absolute/path/to/dist/index.js"] }
```

Config for testing: place `model-fallback.json` in `.opencode/` in your project directory.
