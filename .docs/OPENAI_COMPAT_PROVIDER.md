# OpenAI-Compatible Provider

Route Claude Code through an internally-hosted OpenAI-compatible endpoint without
running a local proxy process. The translation between Anthropic and OpenAI wire
formats happens inside the CLI via a custom fetch interceptor.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Running from source](#running-from-source)
3. [Environment variables](#environment-variables)
4. [Quickstart](#quickstart)
5. [Wrapper script](#wrapper-script)
6. [OAuth token lifecycle](#oauth-token-lifecycle)
7. [What gets translated](#what-gets-translated)
8. [Debugging](#debugging)
9. [Limitations](#limitations)
10. [Comparison with Option 1 (LiteLLM proxy)](#comparison-with-option-1-litellm-proxy)

---

## How it works

When `CLAUDE_CODE_USE_OPENAI_COMPAT=1` is set, `getAnthropicClient()` returns a
standard Anthropic SDK client wired with a translating fetch override. Every call
the SDK makes to `/v1/messages` is intercepted, converted to `/chat/completions`
format, forwarded to your backend, and the response is translated back to
Anthropic SSE (or a message object for non-streaming calls) before the SDK sees
it.

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

## Running from source

This repository contains the TypeScript source only — there is no pre-built
binary or `package.json`. Before you can use the custom provider you need to set
up a working runtime environment.

### 1. Install Bun

Claude Code is built on [Bun](https://bun.sh). Install it if you haven't already:

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify:

```bash
bun --version   # should be 1.x
```

### 2. Get the package manifest and dependencies

This source fork does not include a `package.json`. The easiest way to obtain one
is to pull it from the official npm package and then install into this repo:

```bash
# Download the official package tarball without installing it globally
npm pack @anthropic-ai/claude-code --dry-run 2>/dev/null || true
npm install --ignore-scripts @anthropic-ai/claude-code

# Copy the package.json out of the downloaded package
cp node_modules/@anthropic-ai/claude-code/package.json ./package.json

# Remove the downloaded package — we will use our own source
rm -rf node_modules
```

Then install dependencies against your local `package.json`:

```bash
bun install
```

> **Note:** If the official package version does not match the source in this
> fork you may see type errors on install. They are generally safe to ignore for
> runtime purposes — the built output is what matters.

### 3. Verify the entry point

The CLI entry point is `src/main.tsx`. Confirm it exists:

```bash
ls src/main.tsx
```

### 4. Run Claude Code from source

```bash
bun src/main.tsx
```

You can pass any normal Claude Code flags:

```bash
bun src/main.tsx --help
bun src/main.tsx "explain this file" --print
```

To make this easier to type, create a local alias or symlink:

```bash
# Option A: shell alias (add to ~/.zshrc or ~/.bashrc)
alias claude-dev="bun /path/to/this/repo/src/main.tsx"

# Option B: executable wrapper
echo '#!/usr/bin/env bash\nexec bun /path/to/this/repo/src/main.tsx "$@"' > ~/bin/claude-dev
chmod +x ~/bin/claude-dev
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
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Recommended | Set to `1` to strip beta-only fields from tool schemas that OpenAI-compatible backends reject with `400` |

---

## Quickstart

Once the [source is set up](#running-from-source), set your environment variables
and launch:

```bash
export CLAUDE_CODE_USE_OPENAI_COMPAT=1
export OPENAI_COMPAT_BASE_URL=https://your-internal-host
export OPENAI_COMPAT_OAUTH_ENDPOINT=https://your-oauth-host/oauth/token
export OPENAI_COMPAT_CLIENT_ID=my-client-id
export OPENAI_COMPAT_CLIENT_SECRET=my-client-secret
export OPENAI_COMPAT_MODEL=your-model-name
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

bun /path/to/this/repo/src/main.tsx
```

---

## Wrapper script

For day-to-day use, put the setup and configuration in a single script:

```bash
#!/usr/bin/env bash
# claude-internal.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export CLAUDE_CODE_USE_OPENAI_COMPAT=1
export OPENAI_COMPAT_BASE_URL=https://your-internal-host
export OPENAI_COMPAT_OAUTH_ENDPOINT=https://your-oauth-host/oauth/token
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

# Load credentials from your secret store
export OPENAI_COMPAT_CLIENT_ID=$(secret-tool get client-id your-app)
export OPENAI_COMPAT_CLIENT_SECRET=$(secret-tool get client-secret your-app)

# Optional: override the model name sent to your backend
export OPENAI_COMPAT_MODEL=your-model-name

exec bun "$REPO_DIR/src/main.tsx" "$@"
```

```bash
chmod +x claude-internal.sh
./claude-internal.sh
```

Place the script on your `PATH` or create an alias to use it like a normal CLI.

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

Enable debug logging to see `[openai-compat]` prefixed lines that show which
requests are intercepted and any backend errors:

```bash
export CLAUDE_DEBUG=1   # or CLAUDE_CODE_LOG_LEVEL=debug depending on your build
bun src/main.tsx
```

Example output:

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
- **No pre-built binary** — this fork must be run from source via Bun; there
  is no compiled executable included in the repository.

---

## Comparison with Option 1 (LiteLLM proxy)

| | Option 1 — LiteLLM | Option 2 — built-in (this) |
|---|---|---|
| Source changes | None | `providers.ts`, `client.ts`, new `openai-compat.ts` |
| External dependency | LiteLLM process | None (Bun runtime only) |
| Survives upstream updates | Yes | Requires re-applying on source updates |
| Token refresh | Wrapper script or LiteLLM hook | Automatic (in-process cache) |
| Proxy support | Via LiteLLM config | Not currently implemented |
| Distribution | Each user runs LiteLLM | Run from source via Bun |
