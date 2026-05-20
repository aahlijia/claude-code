# OpenAI-Compatible Provider

Route Claude Code through an internally-hosted OpenAI-compatible endpoint without
running a local proxy process. The translation between Anthropic and OpenAI wire
formats happens inside the CLI via a custom fetch interceptor.

---

## How it works

When `CLAUDE_CODE_USE_OPENAI_COMPAT=1` is set, `getAnthropicClient()` returns a
standard Anthropic SDK client wired with a translating fetch override. Every call
the SDK makes to `/v1/messages` is intercepted, converted to
`/chat/completions` format, forwarded to your backend, and the response is
translated back to Anthropic SSE (or a message object for non-streaming calls)
before the SDK sees it.

```
Claude Code → Anthropic SDK → /v1/messages (intercepted)
                                    ↓
                          translateAnthropicToOpenAI()
                                    ↓
                  POST {OPENAI_COMPAT_BASE_URL}/chat/completions
                  Authorization: Bearer <oauth_token>
                                    ↓
                         translateOpenAIStreamToAnthropic()
                                    ↓
                    Anthropic SSE → SDK → Claude Code
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `CLAUDE_CODE_USE_OPENAI_COMPAT` | Yes | Set to `1` to activate this provider |
| `OPENAI_COMPAT_BASE_URL` | Yes | Base URL of your backend (e.g. `https://your-host`). The path `/chat/completions` is appended automatically |
| `OPENAI_COMPAT_OAUTH_ENDPOINT` | Yes | Token endpoint for `client_credentials` grant |
| `OPENAI_COMPAT_CLIENT_ID` | Yes | OAuth client ID |
| `OPENAI_COMPAT_CLIENT_SECRET` | Yes | OAuth client secret |
| `OPENAI_COMPAT_MODEL` | No | Model name to send to your backend. If unset, the Claude model name is passed through (e.g. `claude-sonnet-4-6`) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | Recommended | Strips beta-only fields from tool schemas that OpenAI-compatible backends reject with `400` |

---

## Quickstart

```bash
export CLAUDE_CODE_USE_OPENAI_COMPAT=1
export OPENAI_COMPAT_BASE_URL=https://your-internal-host
export OPENAI_COMPAT_OAUTH_ENDPOINT=https://your-oauth-host/oauth/token
export OPENAI_COMPAT_CLIENT_ID=my-client-id
export OPENAI_COMPAT_CLIENT_SECRET=my-client-secret
export OPENAI_COMPAT_MODEL=your-model-name
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

claude
```

---

## Wrapper script

For day-to-day use, put the configuration in a script so you don't need to export
every variable by hand:

```bash
#!/usr/bin/env bash
# claude-internal.sh

set -euo pipefail

export CLAUDE_CODE_USE_OPENAI_COMPAT=1
export OPENAI_COMPAT_BASE_URL=https://your-internal-host
export OPENAI_COMPAT_OAUTH_ENDPOINT=https://your-oauth-host/oauth/token
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

# Load credentials from your secret store
export OPENAI_COMPAT_CLIENT_ID=$(secret-tool get client-id your-app)
export OPENAI_COMPAT_CLIENT_SECRET=$(secret-tool get client-secret your-app)

# Optional: override the model name
export OPENAI_COMPAT_MODEL=your-model-name

exec claude "$@"
```

```bash
chmod +x claude-internal.sh
./claude-internal.sh
```

---

## OAuth token lifecycle

The token is fetched on first use and cached in memory with automatic renewal
60 seconds before it expires. The `expires_in` field from the token response is
used to compute the expiry; if the field is absent, a 3600-second TTL is assumed.

The token is not persisted to disk. Restarting Claude Code triggers a fresh fetch.

---

## What gets translated

### Request

| Anthropic field | OpenAI equivalent | Notes |
|---|---|---|
| `system` (string or blocks) | `messages[0]` with `role: system` | Cache control markers are stripped |
| `messages[].content` (text blocks) | `content` string | Multiple text blocks are joined with `\n\n` |
| `messages[].content` (image blocks) | `content` array with `image_url` parts | base64 → `data:` URI |
| `messages[].content` (tool_use blocks) | `tool_calls` array | `input` is JSON-serialised to `arguments` |
| `messages[].content` (tool_result blocks) | Separate `role: tool` messages | `tool_use_id` → `tool_call_id` |
| `tools[].input_schema` | `function.parameters` | |
| `tool_choice: auto` | `tool_choice: "auto"` | |
| `tool_choice: any` | `tool_choice: "required"` | |
| `tool_choice: {type: tool, name}` | `tool_choice: {type: function, function: {name}}` | |
| `thinking` blocks | Stripped | Not supported by OpenAI format |
| `betas`, `cache_control` | Stripped | Not forwarded |
| `defer_loading` tools | Stripped | Deferred tools are not sent to the backend |
| Server tools (advisor, etc.) | Stripped | Only `custom` type tools are forwarded |

### Streaming response

OpenAI SSE chunks are translated to Anthropic SSE events in order:

```
message_start → ping → content_block_start → content_block_delta (×N)
→ content_block_stop → message_delta → message_stop
```

Text deltas and parallel tool call streams are handled. Final token counts are
read from the usage chunk emitted by `stream_options: {include_usage: true}` and
reported in `message_delta.usage`.

### Stop reason mapping

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|---|---|
| `stop` | `end_turn` |
| `tool_calls` | `tool_use` |
| `length` | `max_tokens` |
| `content_filter` | `end_turn` |

---

## Debugging

Set `CLAUDE_CODE_LOG_LEVEL=debug` (or the equivalent debug flag for your build)
to see `[openai-compat]` prefixed log lines that show which requests are
intercepted and any backend errors:

```
[openai-compat] OAuth token fetched, expires in 3600s
[openai-compat] intercepting https://api.anthropic.com/v1/messages → https://your-internal-host/chat/completions
```

Backend error responses are surfaced as Anthropic `error` events so Claude Code
displays them rather than silently failing.

---

## Limitations

- **Thinking / extended thinking** — not supported; the model on your backend
  will not receive thinking configuration and will not return thinking blocks.
- **Prompt caching** — `cache_control` markers are stripped; your backend is
  responsible for any caching it performs.
- **Beta features** — first-party-only beta headers (tool search, fast mode,
  AFK mode, etc.) are sent by the SDK but ignored by the translation layer.
  Set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to prevent them from being
  added in the first place.
- **Proxy support** — the underlying fetch to your backend does not currently
  inherit Claude Code's HTTP proxy settings (`HTTPS_PROXY` etc.).
- **Token counts** — `message_start.usage.input_tokens` is always `0`; accurate
  counts appear in `message_delta.usage` once the stream completes.

---

## Comparison with Option 1 (LiteLLM proxy)

| | Option 1 — LiteLLM | Option 2 — built-in (this) |
|---|---|---|
| Source changes | None | `providers.ts`, `client.ts`, new `openai-compat.ts` |
| External dependency | LiteLLM process | None |
| Survives upstream updates | Yes | Requires re-applying on source updates |
| Token refresh | Wrapper script or LiteLLM hook | Automatic (in-process cache) |
| Proxy support | Via LiteLLM config | Not currently implemented |
| Distribution | Each user runs LiteLLM | Baked into the binary |
