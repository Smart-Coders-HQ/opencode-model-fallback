# OpenCode Model Fallback Plugin — Planning Prompt

I need you to help me design and build an OpenCode plugin that provides **automatic model fallback on rate limits, quota exhaustion, and provider errors** — with per-agent ordered fallback chains.

---

## Context & Problem

OpenCode (https://opencode.ai) is an open-source AI coding agent (terminal + desktop). It supports multiple providers (OpenAI, Anthropic, Google, Groq, OpenRouter, etc.) and has a plugin system built on event hooks.

**The core problem:** When I'm deep in a coding session and my primary model (e.g., `openai/gpt-5.3-codex`) hits a rate limit or quota ceiling, OpenCode enters a retry loop — sometimes waiting hours. There's no automatic failover to a different model. I have to manually switch models or wait it out. This kills flow.

**What exists today (and why it's not enough):**

1. **`opencode-rate-limit-fallback`** (github.com/liamvinberg/opencode-rate-limit-fallback) — A simple plugin that listens for `session.status` events, detects rate-limit patterns in retry messages, aborts the retry, reverts the session to the last user message via undo, and replays with a single fallback model. Limitation: only supports ONE fallback model, no ordered chain, no per-agent config.

2. **`opencode-rate-limit` npm package** (v1.4.0) — More robust: priority-based model pool, circuit breakers, jitter, health tracking, a `/rate-limit-status` command. But it's a heavyweight solution with its own config system that doesn't align with OpenCode's native agent config patterns.

3. **Native support (Issue #7602)** — There's an open feature request by `thdxr` (core maintainer) proposing first-class fallback with config like `agents.build.model.fallback: ["claude-sonnet", "gpt-4o-mini"]`. Still in discussion status — not implemented.

**My goal:** Build a plugin that fills this gap NOW, but designs its config schema to align with the proposed native API (issue #7602) so migration is trivial when/if native support ships.

---

## My Setup

- **Agent config location:** `~/.config/opencode/agents/` (markdown agent files) and `~/.config/opencode/opencode.json` (JSON agent config)
- **I define agents in both formats** — some as `.md` files in the agents directory, some in the JSON config
- **Current agents include:** build, plan, and several custom subagents (coder, reviewer, etc.)
- **Providers I use:** OpenAI, Anthropic, Google — I want fallback chains that can cross provider boundaries

---

## Desired Plugin Behavior

### Config Schema

The plugin should read fallback configuration from a dedicated config file AND/OR respect inline agent config. Priority order for config resolution:

**Option A — Dedicated plugin config file** (e.g., `~/.config/opencode/model-fallback.json`):

```json
{
  "enabled": true,
  "defaults": {
    "fallbackOn": ["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"],
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
    "coder": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "deepseek/deepseek-r1"
      ]
    },
    "plan": {
      "fallbackModels": [
        "anthropic/claude-haiku-4-20250514",
        "google/gemini-3-flash"
      ]
    },
    "*": {
      "fallbackModels": [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-3-flash"
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

Key design points:
- `"*"` wildcard agent provides a default fallback chain for any agent not explicitly configured
- `fallbackModels` is an ordered array — tried sequentially, first healthy model wins
- `fallbackOn` defines which error categories trigger fallback
- `cooldownMs` — how long a model stays marked "unhealthy" after a rate limit hit
- `retryOriginalAfterMs` — when to attempt returning to the original/preferred model
- `maxFallbackDepth` — safety valve to prevent infinite fallback cascading

### Core Logic Flow

1. **Detection:** Listen to `session.status` events. Match retry messages against configured patterns (case-insensitive). Also listen for `session.error` events for 5xx / timeout scenarios.

2. **Model Health State Machine:**
   - Each model has a state: `healthy` | `rate_limited` | `cooldown`
   - On rate limit detection → mark current model as `rate_limited`, record timestamp
   - After `cooldownMs` → transition to `cooldown` (eligible for retry but not preferred)
   - After `retryOriginalAfterMs` → transition back to `healthy`
   - State is tracked in-memory (resets on plugin restart — this is fine)

3. **Fallback Resolution:**
   - Identify which agent is active in the current session
   - Look up that agent's `fallbackModels` array (or fall back to `"*"` wildcard)
   - Walk the array in order, skip any model currently in `rate_limited` state
   - Models in `cooldown` state are eligible but deprioritized (only used if all preferred models are rate-limited)
   - If ALL models (including original) are rate-limited, log a warning and let OpenCode's native retry proceed

4. **Replay Mechanism:**
   - Abort the current retry loop
   - Retrieve the last user message from the session
   - Revert the session to before that message (undo the failed attempt)
   - Re-send the original user message with the selected fallback model
   - Log the transition: `[FALLBACK] build: openai/gpt-5.3-codex → anthropic/claude-sonnet-4 (rate_limit)`

5. **Recovery:**
   - Periodically check if original model's cooldown has expired
   - On next new user message (not replay), prefer the original model if it's back to `healthy`
   - Don't mid-conversation switch back — only on new user-initiated messages

### Plugin Events to Hook

Based on OpenCode's plugin system:
- `session.status` — primary detection point for rate limit retry messages
- `session.error` — catch 5xx, timeout, provider down errors
- `session.idle` — good place to check/log model health state
- `session.created` — initialize per-session state tracking

### Commands

Register a custom slash command (if OpenCode supports it via plugins — investigate):
- `/fallback-status` — show current model health states, which agents are on fallback, cooldown timers remaining

### Logging

Structured log entries:
```
[2026-03-17T14:23:01Z] [DETECT] session=abc123 agent=build model=openai/gpt-5.3-codex trigger="rate limit" message="Rate limited. Quick retry in 1s..."
[2026-03-17T14:23:01Z] [FALLBACK] session=abc123 agent=build from=openai/gpt-5.3-codex to=anthropic/claude-sonnet-4-20250514 reason=rate_limit
[2026-03-17T14:23:45Z] [HEALTH] openai/gpt-5.3-codex: rate_limited (cooldown in 4m15s) | anthropic/claude-sonnet-4: healthy | google/gemini-3-pro: healthy
[2026-03-17T14:28:01Z] [RECOVER] openai/gpt-5.3-codex: rate_limited → cooldown
```

---

## Technical Constraints

- Plugin must be TypeScript, using `@opencode-ai/plugin` types
- Must work as both a local plugin (`.opencode/plugins/`) and publishable to npm
- Should gracefully degrade — if config is missing or malformed, log a warning and do nothing (don't crash OpenCode)
- The undo/replay approach is acknowledged as fragile (the oh-my-opencode maintainer called it "a house of cards") — we need robust error handling around it
- Config file locations to check (in order): `.opencode/model-fallback.json`, `~/.config/opencode/model-fallback.json`

## User experience
Be sure that the fallback information is somewhat displayed to the user in whatever form is possible. that the user is aware that the fallback took place and that a different model is currently used. it would be also great to track usage information for that particular model that is being used right now. be sure to leverage opencode utilities to display that to the user

---

## Deliverables (Planning Phase)

Right now I need you to:

1. **Analyze feasibility** — Read through OpenCode's plugin SDK, event system, and session management. Identify any gaps or limitations that would block this design.

2. **Propose the architecture** — File structure, module breakdown, state management approach, config loading strategy.

3. **Identify risks** — What parts of the undo/replay mechanism are most fragile? What edge cases could cause data loss or conversation corruption? How do we handle concurrent subagent sessions?

4. **Design the config schema** — Finalize it. Consider backward compatibility with the simpler `opencode-rate-limit-fallback` config format.

5. **Draft a phased implementation plan:**
   - Phase 1: Config loading + pattern detection + logging (no replay yet — just detect and log)
   - Phase 2: Single-model fallback with undo/replay
   - Phase 3: Ordered fallback chains with health state machine
   - Phase 4: Recovery logic + `/fallback-status` command
   - Phase 5: npm packaging + documentation

6. **Output the plan as a structured document** I can reference throughout implementation.

Do NOT write implementation code yet. This is planning mode. Think critically, poke holes, and give me a plan I can trust.
