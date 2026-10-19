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
    expect(c.ai).toEqual({ provider: 'ollama', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 120_000 })
    expect(c).toMatchObject({ channel: 'baileys', session: 'bakery', sessionsDir: 'sessions', groupMode: 'commands', allowedUsers: [] })
  })

  it('reads any @bot-wa/ai provider or preset', () => {
    expect(loadBaileysConfig({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }).ai).toEqual({ provider: 'anthropic', apiKey: 'k', timeoutMs: 120_000 })
    expect(loadBaileysConfig({ AI_PROVIDER: 'groq', AI_MODEL: 'm' }).ai).toMatchObject({ provider: 'groq', model: 'm' })
    expect(loadBaileysConfig({ OLLAMA_URL: 'http://gpu-box:11434/' }).ai.baseUrl).toBe('http://gpu-box:11434')
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
