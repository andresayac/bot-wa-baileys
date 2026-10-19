import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import type { AnthropicLike, AnthropicMessage, AnthropicStreamEvent } from '../src/providers/anthropic.js'
import { anthropicModelSupport } from '../src/providers/anthropicModels.js'
import type { AIConfig } from '../src/types.js'

type Args = Record<string, unknown>

const OK: AnthropicMessage = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm' }

/** An SDK-like API error (the SDK's errors carry a numeric `status`). */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function fake(responses: Array<AnthropicMessage | Error> = [OK]) {
  const calls: Args[] = []
  const create = vi.fn(async (args: Args): Promise<AnthropicMessage> => {
    calls.push(structuredClone(args))
    const next = responses.length > 1 ? responses.shift()! : responses[0]!
    if (next instanceof Error) throw next
    return next
  })
  const client: AnthropicLike = { messages: { create } }
  return { client, calls, create }
}

async function argsFor(cfg: AIConfig, model?: string): Promise<Args> {
  const { client, calls } = fake()
  await new AnthropicProvider(client, cfg).generate({ messages: [{ role: 'user', content: 'hi' }], ...(model ? { model } : {}) })
  return calls[0]!
}

describe('anthropicModelSupport', () => {
  it('knows which families take adaptive thinking and effort', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-4-6',
      'claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'anthropic.claude-opus-4-7', 'us.anthropic.claude-sonnet-5']) {
      expect(anthropicModelSupport(id), id).toMatchObject({ adaptiveThinking: true, effort: true, known: true })
    }
    for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514',
      'claude-opus-4-1', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-opus-4-5@20251101']) {
      expect(anthropicModelSupport(id).adaptiveThinking, id).toBe(false)
    }
    expect(anthropicModelSupport('claude-opus-4-5').effort).toBe(true)
    expect(anthropicModelSupport('claude-haiku-4-5').effort).toBe(false)
    expect(anthropicModelSupport('claude-sonnet-4-5').effort).toBe(false)
  })

  it('assumes an unknown id is a current model', () => {
    expect(anthropicModelSupport('my-gateway-alias')).toEqual({ adaptiveThinking: true, effort: true, known: false })
  })
})

describe('AnthropicProvider thinking', () => {
  it('defaults to adaptive thinking on models that support it', async () => {
    expect((await argsFor({ model: 'claude-opus-4-8' })).thinking).toEqual({ type: 'adaptive' })
    expect((await argsFor({})).thinking).toEqual({ type: 'adaptive' }) // default model
  })

  it('sends no thinking (nor effort) by default to older models such as Haiku 4.5', async () => {
    const args = await argsFor({ model: 'claude-haiku-4-5', effort: 'low' })
    expect('thinking' in args).toBe(false)
    expect('output_config' in args).toBe(false)
  })

  it('is model-aware per call (input.model wins over the configured model)', async () => {
    expect('thinking' in (await argsFor({ model: 'claude-opus-4-8' }, 'claude-haiku-4-5'))).toBe(false)
  })

  it("thinking: 'off' omits the parameter; 'adaptive' forces it", async () => {
    expect('thinking' in (await argsFor({ model: 'claude-opus-4-8', thinking: 'off' }))).toBe(false)
    expect((await argsFor({ model: 'claude-haiku-4-5', thinking: 'adaptive' })).thinking).toEqual({ type: 'adaptive' })
  })

  it('budgetTokens enables budgeted thinking on older models and keeps room for the answer', async () => {
    const args = await argsFor({ model: 'claude-haiku-4-5', maxTokens: 1000, thinking: { budgetTokens: 2000 } })
    expect(args.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 })
    expect(args.max_tokens).toBe(3000)
    // The API minimum is 1024.
    const small = await argsFor({ model: 'claude-haiku-4-5', maxTokens: 4096, thinking: { budgetTokens: 10 } })
    expect(small.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(small.max_tokens).toBe(4096)
  })

  it('budgetTokens falls back to adaptive on models that only take adaptive thinking', async () => {
    expect((await argsFor({ model: 'claude-opus-4-8', thinking: { budgetTokens: 2000 } })).thinking).toEqual({ type: 'adaptive' })
  })

  it('keeps effort for models that support it', async () => {
    expect((await argsFor({ model: 'claude-opus-4-8', effort: 'low' })).output_config).toEqual({ effort: 'low' })
  })

  it('retries once without thinking on a 400 that names thinking, and remembers it for the model', async () => {
    const { client, calls } = fake([apiError(400, 'thinking.type: adaptive thinking is not supported on this model'), OK])
    const p = new AnthropicProvider(client, { model: 'my-gateway-alias', effort: 'high' })
    const r = await p.generate({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.thinking).toEqual({ type: 'adaptive' })
    expect('thinking' in calls[1]!).toBe(false)
    expect(calls[1]!.output_config).toEqual({ effort: 'high' })
    await p.generate({ messages: [{ role: 'user', content: 'again' }] })
    expect(calls).toHaveLength(3)
    expect('thinking' in calls[2]!).toBe(false)
  })

  it('drops effort on a 400 that names effort', async () => {
    const { client, calls } = fake([apiError(400, 'output_config.effort: Extra inputs are not permitted'), OK])
    await new AnthropicProvider(client, { model: 'my-gateway-alias', effort: 'high' }).generate({ messages: [] })
    expect(calls).toHaveLength(2)
    expect('output_config' in calls[1]!).toBe(false)
    expect(calls[1]!.thinking).toEqual({ type: 'adaptive' })
  })

  it('does not retry other errors, nor a 400 the thinking fallback would not fix', async () => {
    const other = fake([apiError(400, 'messages: roles must alternate')])
    await expect(new AnthropicProvider(other.client, {}).generate({ messages: [] })).rejects.toThrow(/alternate/)
    expect(other.calls).toHaveLength(1)
    const server = fake([apiError(500, 'thinking overloaded')])
    await expect(new AnthropicProvider(server.client, {}).generate({ messages: [] })).rejects.toThrow(/overloaded/)
    expect(server.calls).toHaveLength(1)
    // A history error that mentions thinking blocks is not a parameter-support error.
    const history = fake([apiError(400, 'messages.1.content.0.thinking.signature: invalid signature in thinking block')])
    await expect(new AnthropicProvider(history.client, {}).generate({ messages: [] })).rejects.toThrow(/signature/)
    expect(history.calls).toHaveLength(1)
    // thinking: 'off' sends no thinking, so a 400 naming it is not retried.
    const off = fake([apiError(400, 'thinking is weird')])
    await expect(new AnthropicProvider(off.client, { thinking: 'off', model: 'claude-haiku-4-5' }).generate({ messages: [] })).rejects.toThrow()
    expect(off.calls).toHaveLength(1)
  })

  it('stream retries without thinking when the 400 arrives before any text', async () => {
    const calls: Args[] = []
    let n = 0
    const client: AnthropicLike = {
      messages: {
        create: vi.fn(async () => OK),
        stream(args: Args) {
          calls.push(structuredClone(args))
          const attempt = ++n
          return (async function* (): AsyncGenerator<AnthropicStreamEvent> {
            if (attempt === 1) throw apiError(400, 'thinking: unsupported for this model')
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hola' } }
          })()
        },
      },
    }
    const out: string[] = []
    for await (const t of new AnthropicProvider(client, { model: 'x-alias' }).stream({ messages: [] })) out.push(t)
    expect(out).toEqual(['hola'])
    expect(calls).toHaveLength(2)
    expect('thinking' in calls[1]!).toBe(false)
  })
})
