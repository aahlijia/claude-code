import type { ClientOptions } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'

// ─── OAuth token cache ────────────────────────────────────────────────────────

type TokenCache = { token: string; expiresAt: number }
let _tokenCache: TokenCache | null = null

export async function fetchOpenAICompatToken(): Promise<string> {
  const now = Date.now()
  if (_tokenCache && now < _tokenCache.expiresAt) {
    return _tokenCache.token
  }

  const endpoint = process.env.OPENAI_COMPAT_OAUTH_ENDPOINT!
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const res = await globalThis.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OPENAI_COMPAT_CLIENT_ID!,
      client_secret: process.env.OPENAI_COMPAT_CLIENT_SECRET!,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI compat OAuth failed ${res.status}: ${body}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number }
  const expiresIn = data.expires_in ?? 3600
  _tokenCache = {
    token: data.access_token,
    // Refresh 60 s before actual expiry
    expiresAt: now + (expiresIn - 60) * 1000,
  }
  logForDebugging(`[openai-compat] OAuth token fetched, expires in ${expiresIn}s`)
  return _tokenCache.token
}

export function invalidateOpenAICompatToken(): void {
  _tokenCache = null
}

// ─── Type definitions ─────────────────────────────────────────────────────────

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: unknown }
type AnthropicImageBlock = {
  type: 'image'
  source: { type: string; media_type: string; data?: string; url?: string }
}
type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | AnthropicContentBlock[]
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicSystemBlock = { type: string; text?: string; [key: string]: unknown }

type AnthropicToolDef = {
  type?: string
  name: string
  description?: string
  input_schema?: unknown
  defer_loading?: boolean
}

type AnthropicRequestBody = {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicSystemBlock[]
  max_tokens: number
  tools?: AnthropicToolDef[]
  tool_choice?: { type: string; name?: string }
  temperature?: number
  stream?: boolean
  [key: string]: unknown
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIMessage = {
  role: string
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

type OpenAIRequestBody = {
  model: string
  messages: OpenAIMessage[]
  max_tokens: number
  tools?: Array<{
    type: 'function'
    function: { name: string; description?: string; parameters: unknown }
  }>
  tool_choice?: unknown
  temperature?: number
  stream?: boolean
  stream_options?: { include_usage: boolean }
}

type OpenAIChunk = {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

// ─── Request translation ──────────────────────────────────────────────────────

function systemToString(
  system: string | AnthropicSystemBlock[] | undefined,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n\n')
}

function anthropicContentToOpenAI(
  content: AnthropicContentBlock[],
): { simple: string; parts: null } | { simple: null; parts: OpenAIContentPart[] } {
  const hasImages = content.some(b => b.type === 'image')
  if (!hasImages) {
    const text = content
      .filter(b => b.type === 'text')
      .map(b => (b as AnthropicTextBlock).text)
      .join('\n\n')
    return { simple: text, parts: null }
  }

  const parts: OpenAIContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: (block as AnthropicTextBlock).text })
    } else if (block.type === 'image') {
      const src = (block as AnthropicImageBlock).source
      const url =
        src.type === 'base64'
          ? `data:${src.media_type};base64,${src.data}`
          : (src.url ?? '')
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  return { simple: null, parts }
}

function toolResultText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text')
    .map(b => (b as AnthropicTextBlock).text)
    .join('\n')
}

function anthropicMessagesToOpenAI(messages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    const { role, content } = msg

    if (role === 'user') {
      if (typeof content === 'string') {
        result.push({ role: 'user', content })
        continue
      }

      const toolResults = content.filter(
        b => b.type === 'tool_result',
      ) as AnthropicToolResultBlock[]
      const other = content.filter(b => b.type !== 'tool_result') as AnthropicContentBlock[]

      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: toolResultText(tr.content),
        })
      }

      if (other.length > 0) {
        const { simple, parts } = anthropicContentToOpenAI(other)
        result.push({ role: 'user', content: parts ?? simple })
      }
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        result.push({ role: 'assistant', content })
        continue
      }

      const textBlocks = content.filter(b => b.type === 'text') as AnthropicTextBlock[]
      const toolUses = content.filter(b => b.type === 'tool_use') as AnthropicToolUseBlock[]

      const textContent = textBlocks.map(b => b.text).join('\n\n') || null

      if (toolUses.length > 0) {
        result.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolUses.map(b => ({
            id: b.id,
            type: 'function' as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        })
      } else {
        result.push({ role: 'assistant', content: textContent ?? '' })
      }
    }
  }

  return result
}

function anthropicToolsToOpenAI(
  tools: AnthropicToolDef[] | undefined,
): OpenAIRequestBody['tools'] {
  if (!tools || tools.length === 0) return undefined
  const converted = tools
    .filter(t => !t.defer_loading && (!t.type || t.type === 'custom'))
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description && { description: t.description }),
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }))
  return converted.length > 0 ? converted : undefined
}

function anthropicToolChoiceToOpenAI(
  tc: AnthropicRequestBody['tool_choice'],
): unknown {
  if (!tc) return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } }
  }
  return undefined
}

export function translateAnthropicToOpenAI(
  body: AnthropicRequestBody,
  modelOverride: string | undefined,
): OpenAIRequestBody {
  const systemStr = systemToString(body.system)
  const messages: OpenAIMessage[] = []

  if (systemStr) {
    messages.push({ role: 'system', content: systemStr })
  }
  messages.push(...anthropicMessagesToOpenAI(body.messages))

  const tools = anthropicToolsToOpenAI(body.tools)
  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice)

  return {
    model: modelOverride ?? body.model,
    messages,
    max_tokens: body.max_tokens,
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.stream && {
      stream: true,
      stream_options: { include_usage: true },
    }),
  }
}

// ─── Streaming response translation ──────────────────────────────────────────

function mapFinishReason(reason: string | null): string {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

function encodeSSE(eventType: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
  )
}

async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIChunk | 'DONE'> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') {
          yield 'DONE'
          return
        }
        try {
          yield JSON.parse(payload) as OpenAIChunk
        } catch {
          // skip malformed chunk
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function translateOpenAIStreamToAnthropic(
  openAIBody: ReadableStream<Uint8Array>,
  messageId: string,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      let messageStarted = false
      let hasTextBlock = false
      let textBlockIndex = 0
      // OpenAI tool_call.index → Anthropic content block index
      const toolBlockIndex = new Map<number, { blockIndex: number; id: string }>()
      let nextBlockIndex = 0
      let finishReason: string | null = null
      let inputTokens = 0
      let outputTokens = 0

      try {
        for await (const chunk of parseOpenAISSE(openAIBody)) {
          if (chunk === 'DONE') break

          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens
            outputTokens = chunk.usage.completion_tokens
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta = choice.delta

          if (!messageStarted) {
            messageStarted = true
            controller.enqueue(
              encodeSSE('message_start', {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: requestedModel,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              }),
            )
            controller.enqueue(encodeSSE('ping', { type: 'ping' }))
          }

          // Text delta
          if (delta.content !== null && delta.content !== undefined) {
            if (!hasTextBlock) {
              hasTextBlock = true
              textBlockIndex = nextBlockIndex++
              controller.enqueue(
                encodeSSE('content_block_start', {
                  type: 'content_block_start',
                  index: textBlockIndex,
                  content_block: { type: 'text', text: '' },
                }),
              )
            }
            if (delta.content) {
              controller.enqueue(
                encodeSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: textBlockIndex,
                  delta: { type: 'text_delta', text: delta.content },
                }),
              )
            }
          }

          // Tool call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index

              if (!toolBlockIndex.has(idx)) {
                const blockIndex = nextBlockIndex++
                const id = tc.id ?? `toolu_${blockIndex}`
                toolBlockIndex.set(idx, { blockIndex, id })
                controller.enqueue(
                  encodeSSE('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id,
                      name: tc.function?.name ?? '',
                      input: {},
                    },
                  }),
                )
              }

              const { blockIndex } = toolBlockIndex.get(idx)!
              if (tc.function?.arguments) {
                controller.enqueue(
                  encodeSSE('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: tc.function.arguments,
                    },
                  }),
                )
              }
            }
          }
        }

        // Close open content blocks
        if (hasTextBlock) {
          controller.enqueue(
            encodeSSE('content_block_stop', {
              type: 'content_block_stop',
              index: textBlockIndex,
            }),
          )
        }
        for (const { blockIndex } of toolBlockIndex.values()) {
          controller.enqueue(
            encodeSSE('content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            }),
          )
        }

        // Emit message_delta with final usage
        controller.enqueue(
          encodeSSE('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: mapFinishReason(finishReason),
              stop_sequence: null,
            },
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            },
          }),
        )

        controller.enqueue(encodeSSE('message_stop', { type: 'message_stop' }))
      } catch (err) {
        controller.enqueue(
          encodeSSE('error', {
            type: 'error',
            error: { type: 'api_error', message: String(err) },
          }),
        )
      } finally {
        controller.close()
      }
    },
  })
}

// ─── Non-streaming response translation ──────────────────────────────────────

type OpenAICompletion = {
  id: string
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

function translateOpenAICompletionToAnthropic(
  completion: OpenAICompletion,
  requestedModel: string,
): unknown {
  const choice = completion.choices[0]
  const content: unknown[] = []

  if (choice?.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        // leave as empty object if arguments are not valid JSON yet
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  return {
    id: completion.id,
    type: 'message',
    role: 'assistant',
    content,
    model: requestedModel,
    stop_reason: mapFinishReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  }
}

// ─── Body parsing helper ──────────────────────────────────────────────────────

async function readRequestBody(body: BodyInit | null | undefined): Promise<AnthropicRequestBody> {
  if (body === null || body === undefined) return {} as AnthropicRequestBody
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body))
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return JSON.parse(new TextDecoder().decode(merged))
  }
  return JSON.parse(String(body))
}

// ─── Fetch override factory ───────────────────────────────────────────────────

/**
 * Returns a fetch function that intercepts Anthropic SDK calls to /v1/messages,
 * translates them to OpenAI /chat/completions format, and translates the
 * response back to Anthropic SSE or message format.
 */
export function makeAnthropicToOpenAIFetch(
  baseUrl: string,
  getToken: () => Promise<string>,
): ClientOptions['fetch'] {
  const modelOverride = process.env.OPENAI_COMPAT_MODEL
  const completionsUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)

    if (!url.includes('/v1/messages')) {
      // Pass through non-messages requests unchanged
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      return globalThis.fetch(input, init)
    }

    logForDebugging(`[openai-compat] intercepting ${url} → ${completionsUrl}`)

    const token = await getToken()
    const anthropicBody = await readRequestBody(init?.body as BodyInit | null | undefined)
    const openAIBody = translateAnthropicToOpenAI(anthropicBody, modelOverride)

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const response = await globalThis.fetch(completionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: openAIBody.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(openAIBody),
      signal: init?.signal as AbortSignal | undefined,
    })

    if (!response.ok) {
      const errText = await response.text()
      logForDebugging(`[openai-compat] backend error ${response.status}: ${errText}`)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Backend ${response.status}: ${errText}` },
        }),
        {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    const messageId = `msg_oai_${Date.now()}`

    if (openAIBody.stream && response.body) {
      const anthropicStream = translateOpenAIStreamToAnthropic(
        response.body,
        messageId,
        anthropicBody.model,
      )
      return new Response(anthropicStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'x-request-id': messageId,
        },
      })
    }

    // Non-streaming path
    const completion = (await response.json()) as OpenAICompletion
    const anthropicResponse = translateOpenAICompletionToAnthropic(
      completion,
      anthropicBody.model,
    )
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': completion.id ?? messageId,
      },
    })
  }
}
