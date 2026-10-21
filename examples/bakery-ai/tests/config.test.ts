import { describe, it, expect } from 'vitest'
import { ConfigError, describeConfig, loadBaileysConfig, loadTwilioConfig } from '../src/config.js'

const TWILIO = {
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
  TWILIO_AUTH_TOKEN: 'super-secret-token',
  PUBLIC_URL: 'https://bakery.example.com/',
}

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn()
  } catch (err) {
    if (err instanceof ConfigError) return err.problems
    throw err
  }
  throw new Error('expected a ConfigError')
}

describe('config', () => {
  it('defaults to Ollama on localhost', () => {
    const c = loadBaileysConfig({})
    expect(c.ai).toEqual({
      provider: 'ollama', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 120_000,
      maxSteps: 5, memory: { maxFacts: 20 },
    })
    expect(c).toMatchObject({ channel: 'baileys', session: 'bakery', sessionsDir: 'sessions', groupMode: 'commands', allowedUsers: [] })
  })

  it('reads any @botmesh/ai provider or preset', () => {
    expect(loadBaileysConfig({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }).ai).toMatchObject({ provider: 'anthropic', apiKey: 'k', timeoutMs: 120_000 })
    expect(loadBaileysConfig({ AI_PROVIDER: 'anthropic' }).ai).not.toHaveProperty('model')
    expect(loadBaileysConfig({ AI_PROVIDER: 'groq', AI_MODEL: 'm' }).ai).toMatchObject({ provider: 'groq', model: 'm' })
    expect(loadBaileysConfig({ OLLAMA_URL: 'http://gpu-box:11434/' }).ai.baseUrl).toBe('http://gpu-box:11434')
  })

  it('reads the AI tuning options (memory, thinking, effort, budgets)', () => {
    const c = loadBaileysConfig({
      AI_PROVIDER: 'anthropic', AI_MEMORY: 'on', AI_MEMORY_MAX_FACTS: '50', AI_MEMORY_TTL: '30d',
      AI_THINKING: 'Adaptive', AI_EFFORT: 'LOW', AI_MAX_TOKENS: '2048', AI_MAX_STEPS: '8', AI_CONTEXT_MESSAGES: '30',
    })
    expect(c.ai).toMatchObject({
      memory: { maxFacts: 50, ttl: '30d' }, thinking: 'adaptive', effort: 'low', maxTokens: 2048, maxSteps: 8, contextMessages: 30,
    })
    expect(loadBaileysConfig({ AI_THINKING: '4096' }).ai.thinking).toEqual({ budgetTokens: 4096 })
    expect(loadBaileysConfig({ AI_THINKING: 'off' }).ai.thinking).toBe('off')
    for (const off of ['off', 'false', '0', 'no', 'NO']) expect(loadBaileysConfig({ AI_MEMORY: off }).ai.memory, off).toBe(false)
    expect(loadBaileysConfig({}).ai).not.toHaveProperty('thinking')
  })

  it('rejects invalid AI tuning options, naming the variable', () => {
    const problems = problemsOf(() => loadBaileysConfig({
      AI_MEMORY: 'maybe', AI_MEMORY_MAX_FACTS: '0', AI_MEMORY_TTL: 'forever', AI_THINKING: 'deep', AI_EFFORT: 'extreme',
      AI_MAX_TOKENS: '10', AI_MAX_STEPS: '99', AI_CONTEXT_MESSAGES: 'all',
    }))
    expect(problems).toHaveLength(8)
    for (const name of ['AI_MEMORY ', 'AI_MEMORY_MAX_FACTS', 'AI_MEMORY_TTL', 'AI_THINKING', 'AI_EFFORT', 'AI_MAX_TOKENS', 'AI_MAX_STEPS', 'AI_CONTEXT_MESSAGES']) {
      expect(problems.some((p) => p.startsWith(name)), name).toBe(true)
    }
    expect(problemsOf(() => loadBaileysConfig({ AI_THINKING: '512' }))).toEqual(['AI_THINKING must be auto, adaptive, off or a thinking budget in tokens (an integer between 1024 and 128000).'])
  })

  it('logs the AI tuning in the summary', () => {
    expect(describeConfig(loadBaileysConfig({ AI_MEMORY: 'off', AI_THINKING: 'off', AI_MAX_TOKENS: '1000' }))).toMatchObject({
      aiMemory: 'off', aiThinking: 'off', aiMaxTokens: 1000,
    })
    expect(describeConfig(loadBaileysConfig({}))).toMatchObject({ aiMemory: 'on (20 facts)', aiThinking: 'auto', aiMaxTokens: '(provider default)' })
  })

  it('splits the allow-list', () => {
    expect(loadBaileysConfig({ ALLOWED_USERS: ' 15551234567@s.whatsapp.net, ,whatsapp:+15551234567 ' }).allowedUsers)
      .toEqual(['15551234567@s.whatsapp.net', 'whatsapp:+15551234567'])
  })

  it('reports every problem at once', () => {
    const problems = problemsOf(() => loadBaileysConfig({ AI_PROVIDER: 'skynet', GROUP_MODE: 'loud', AI_TIMEOUT_MS: 'soon', WA_SESSION: '../x' }))
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toMatch(/AI_PROVIDER/)
  })

  it('only accepts plain decimal integers (no 0x10, 1e3 or 3000.0)', () => {
    for (const port of ['0x10', '1e3', '3000.0', '+80']) {
      expect(problemsOf(() => loadTwilioConfig({ ...TWILIO, PORT: port })), port).toEqual(['PORT must be an integer between 1 and 65535.'])
    }
    expect(loadTwilioConfig({ ...TWILIO, PORT: ' 8080 ' }).port).toBe(8080)
  })

  it('matches AI_PROVIDER, GROUP_MODE and LOG_LEVEL case-insensitively', () => {
    const c = loadBaileysConfig({ AI_PROVIDER: 'Anthropic', GROUP_MODE: 'Mentions', LOG_LEVEL: 'DEBUG' })
    expect(c).toMatchObject({ ai: { provider: 'anthropic' }, groupMode: 'mentions', logLevel: 'debug' })
  })

  it('builds the Twilio webhook URL from PUBLIC_URL', () => {
    const c = loadTwilioConfig(TWILIO)
    expect(c).toMatchObject({
      channel: 'twilio',
      whatsappFrom: 'whatsapp:+14155238886',
      webhookUrl: 'https://bakery.example.com/twilio/webhook',
      host: '127.0.0.1',
      port: 3000,
    })
  })

  it('requires the Twilio credentials and an https PUBLIC_URL', () => {
    expect(problemsOf(() => loadTwilioConfig({})).join('\n')).toMatch(/TWILIO_ACCOUNT_SID[\s\S]*TWILIO_AUTH_TOKEN[\s\S]*PUBLIC_URL/)
    expect(problemsOf(() => loadTwilioConfig({ ...TWILIO, PUBLIC_URL: 'http://insecure.example.com' }))).toEqual(['PUBLIC_URL must start with https://.'])
  })

  it('never puts secret values in errors or in the logged summary', () => {
    const err = problemsOf(() => loadTwilioConfig({ ...TWILIO, TWILIO_ACCOUNT_SID: 'not-a-sid-secret', PORT: '99999' })).join('\n')
    expect(err).not.toContain('not-a-sid-secret')
    const summary = JSON.stringify(describeConfig(loadTwilioConfig({ ...TWILIO, AI_API_KEY: 'sk-live-123' })))
    expect(summary).not.toContain('super-secret-token')
    expect(summary).not.toContain('sk-live-123')
    expect(summary).not.toContain(TWILIO.TWILIO_ACCOUNT_SID)
  })
})
