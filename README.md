# OpenCode Credit Switcher Plugin

This plugin retries a session with a fallback model when the primary provider reports a credit exhaustion error, and switches back after a daily credit check.

## Files

- `.opencode/plugins/credit-switcher.js` - Plugin implementation.
- `.opencode/credit-switcher.json` - Plugin configuration.
- `.opencode/credit-switcher.state.json` - Plugin state (last exhausted time and original model).

## Install

### From npm

Add the plugin to your OpenCode config:

```jsonc
// opencode.jsonc
{
  "plugin": ["opencode-credit-switcher@latest"]
}
```

### From local files

Copy `.opencode/plugins/credit-switcher.js` into one of:

- `.opencode/plugins/` (project)
- `~/.config/opencode/plugins/` (global)

## Configure

1. Update `.opencode/credit-switcher.json` with your primary and fallback models.
2. Ensure your providers are configured in `opencode.json` and credentials are stored via `/connect`.

Example `opencode.json` for a self-hosted OpenAI-compatible endpoint:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "llama.cpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama-server (local)",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1"
      },
      "models": {
        "qwen3-coder:a3b": {
          "name": "Qwen3-Coder a3b"
        }
      }
    }
  }
}
```

## How it works

- Listens for `session.error` events.
- Detects credit exhaustion via status codes, error codes, or message text.
- Replays the last user message using `fallbackModel`.
- If `confirmOnFallback` is enabled and the confirm dialog is available, asks before retrying.
- Once per day, attempts to switch sessions back to the original model after credits likely reset.

## Notes

- The plugin only retries once per session to avoid loops.
- Fallback requires your providers to exist in OpenCode config.
- Customize matching via `.opencode/credit-switcher.json`.
