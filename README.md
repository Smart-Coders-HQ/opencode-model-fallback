# opencode-model-fallback

OpenCode plugin for ordered model fallback chains, preemptive redirect, and automatic rate limit recovery.

When a primary model becomes rate-limited, overloaded, times out, or hits a configured 5xx path, the plugin automatically redirects or replays the message with the next healthy model in your fallback chain. It helps keep OpenCode sessions running when GPT, Claude, Gemini, and other providers temporarily stop accepting requests.

## What problem does this solve?

If you use OpenCode with multiple models or providers, rate limits and transient provider failures can interrupt chats and force manual model switching. This plugin adds automatic model failover so OpenCode can continue with the next healthy model instead of getting stuck on repeated retries, 429s, or provider overload errors.

## How does model fallback work in OpenCode?

The plugin tracks model health globally, keeps fallback depth per session, and walks an ordered fallback chain when the active model fails. If a model is already known to be unhealthy, the `chat.message` hook can preemptively redirect the next prompt before the provider returns another 429.

## Features

- Preemptive redirect via `chat.message` when a model is already known to be rate-limited
- Reactive fallback from both `session.status` retry events and `session.error` API errors
- Per-agent ordered fallback chains with `"*"` wildcard support
- Global model health tracking with automatic recovery windows
- `/fallback-status` slash command for session depth, history, and model health
- Structured logs with provider free-form error text redacted

## Installation

Add the plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["@smart-coders-hq/opencode-model-fallback"],
}
```

For local development:

```jsonc
{
  "plugin": ["file:///path/to/opencode-model-fallback/dist/index.js"],
}
```

## Configuration

Create `model-fallback.json` in either:

- `.opencode/model-fallback.json`
- `~/.config/opencode/model-fallback.json`

Minimal example:

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
  "logging": true,
  "logLevel": "info",
  "logPath": "~/.local/share/opencode/logs/model-fallback.log"
}
```

Most important knobs:

- `defaults.fallbackOn` - which error categories trigger fallback
- `defaults.cooldownMs` - how long a rate-limited model stays unavailable
- `defaults.retryOriginalAfterMs` - when a cooled-down model becomes healthy again
- `defaults.maxFallbackDepth` - max cascading fallbacks within one message
- `agents` - ordered fallback chains per agent
- `logging`, `logLevel`, `logPath` - structured file logging controls

Per-agent example:

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

If you still have `rate-limit-fallback.json`, it is discovered and auto-migrated on load.

## `/fallback-status`

Run `/fallback-status` in any OpenCode session to see:

- current session fallback depth and history
- tracked model health and time remaining
- active agent name

Verbose mode adds token and cost breakdown by fallback period:

```text
/fallback-status verbose:true
```

When enabled, the plugin auto-creates `~/.config/opencode/commands/fallback-status.md` at startup.

## Troubleshooting

- **No toast appears** - toasts require an active OpenCode TUI session; headless/API runs still log events
- **`/fallback-status` is missing** - verify `~/.config/opencode/commands/` is writable and check logs for `fallback-status.command.write.failed`
- **"no fallback chain configured"** - add `agents["*"]` or an entry for the active agent with at least one `fallbackModels` value
- **"all fallback models exhausted"** - every configured fallback is currently rate-limited; wait for recovery or add more models
- **"max fallback depth reached"** - all models in the chain failed within one message; start a new session or raise `maxFallbackDepth`
- **Reactive fallback logged `replay.revert.failed`** - if OpenCode applied the revert but returned an invalid revert response, newer plugin builds verify session revert state and continue replay instead of aborting immediately

Check logs with:

```bash
tail -f ~/.local/share/opencode/logs/model-fallback.log | jq .
```

For more event detail, set `"logLevel": "debug"` and restart OpenCode.

## Development

```bash
bun install
bun run lint
bun test
bunx tsc --noEmit
bun run build
```

Local plugin config:

```jsonc
{ "plugin": ["file:///absolute/path/to/dist/index.js"] }
```

For local testing, place `model-fallback.json` in `.opencode/` in your project directory.
