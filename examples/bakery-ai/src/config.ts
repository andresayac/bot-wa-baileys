/**
 * Typed configuration from environment variables, validated up front with
 * clear errors. Error messages name the variable, never its value, and
 * {@link describeConfig} only returns non-secret fields, so secrets never reach
 * the logs.
 */
import { loadEnvFile } from 'node:process'
import { parseDuration } from '@bot-wa/core'
import { isPreset, type AIProviderName, type AIThinking, type Effort } from '@bot-wa/ai'

export type Env = Readonly<Record<string, string | undefined>>

/** All problems found in the environment (reported together, not one by one). */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

const NATIVE_PROVIDERS = ['ollama', 'anthropic', 'openai', 'gemini'] as const
const GROUP_MODES = ['all', 'mentions', 'commands'] as const
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]
const TRUE = ['on', 'true', '1', 'yes']
const FALSE = ['off', 'false', '0', 'no']

/** Defaults of the AI tuning variables. */
export const AI_DEFAULTS = { maxSteps: 5, memoryMaxFacts: 20 } as const

export type GroupMode = (typeof GROUP_MODES)[number]
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface AIEnvConfig {
  provider: AIProviderName
  model?: string
  /** Secret. Optional: each SDK/preset also reads its own env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY...). */
  apiKey?: string
  baseUrl?: string
  timeoutMs: number
  /** Long-term per-user memory (`AI_MEMORY`, `AI_MEMORY_MAX_FACTS`, `AI_MEMORY_TTL`); `false` = off. */
  memory: false | { maxFacts: number; ttl?: string }
  /** Anthropic extended thinking (`AI_THINKING`). Absent = the provider's `'auto'`. */
  thinking?: AIThinking
  /** Reasoning effort (`AI_EFFORT`), for the providers that support it. */
  effort?: Effort
  /** Output-token cap per model call (`AI_MAX_TOKENS`). Absent = the provider's default. */
  maxTokens?: number
  /** Model calls per turn in the tool loop (`AI_MAX_STEPS`). */
  maxSteps: number
  /** Chat history messages sent to the model (`AI_CONTEXT_MESSAGES`). Absent = the plugin's default. */
  contextMessages?: number
}

export interface CommonConfig {
  ai: AIEnvConfig
  /** Empty → everybody may talk to the bot. */
  allowedUsers: string[]
  groupMode: GroupMode
  logLevel: LogLevel
}

export interface BaileysConfig extends CommonConfig {
  channel: 'baileys'
  session: string
  sessionsDir: string
  /** Phone number (international format, digits only) to log in with a pairing code instead of the QR. */
  pairingPhone?: string
}

export interface TwilioConfig extends CommonConfig {
  channel: 'twilio'
  accountSid: string
  /** Secret. */
  authToken: string
  whatsappFrom: string
  smsFrom?: string
  /** Public base URL that reaches this process (e.g. the cloudflared tunnel). */
  publicUrl: string
  webhookPath: string
  /** `publicUrl + webhookPath`: the exact URL Twilio signs. */
  webhookUrl: string
  host: string
  port: number
}

/** Twilio's WhatsApp sandbox sender. */
export const TWILIO_SANDBOX_FROM = 'whatsapp:+14155238886'

/**
 * Load `.env` from the working directory into `process.env` if it exists
 * (variables already set in the environment win). Returns whether it was found.
 */
export function loadDotEnv(path = '.env'): boolean {
  try {
    loadEnvFile(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Reads variables and collects problems instead of throwing on the first one. */
class Reader {
  readonly problems: string[] = []
  constructor(private readonly env: Env) {}

  str(name: string): string | undefined {
    const v = this.env[name]?.trim()
    return v ? v : undefined
  }

  required(name: string, hint: string): string {
    const v = this.str(name)
    if (v === undefined) this.problems.push(`${name} is required (${hint}).`)
    return v ?? ''
  }

  /** One of `allowed`, matched case-insensitively (`Mentions` → `mentions`). */
  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const v = this.str(name)?.toLowerCase()
    if (v === undefined) return fallback
    if ((allowed as readonly string[]).includes(v)) return v as T
    this.problems.push(`${name} must be one of: ${allowed.join(', ')}.`)
    return fallback
  }

  /** A plain decimal integer in `[min, max]` (`Number()` alone would also take `0x10` or `1e3`). */
  int(name: string, fallback: number, min: number, max: number): number {
    const v = this.str(name)
    if (v === undefined) return fallback
    const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
    if (!Number.isInteger(n) || n < min || n > max) {
      this.problems.push(`${name} must be an integer between ${min} and ${max}.`)
      return fallback
    }
    return n
  }

  /** An optional integer in `[min, max]` (absent → `undefined`). */
  optInt(name: string, min: number, max: number): number | undefined {
    if (this.str(name) === undefined) return undefined
    const n = this.int(name, Number.NaN, min, max)
    return Number.isNaN(n) ? undefined : n
  }

  /** An optional value of `allowed`, case-insensitive. */
  optOneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    if (this.str(name) === undefined) return undefined
    return this.oneOf<T | ''>(name, allowed, '') || undefined
  }

  /** on/off, true/false, yes/no, 1/0. */
  bool(name: string, fallback: boolean): boolean {
    const v = this.str(name)?.toLowerCase()
    if (v === undefined) return fallback
    if (TRUE.includes(v)) return true
    if (FALSE.includes(v)) return false
    this.problems.push(`${name} must be on or off (also true/false, yes/no, 1/0).`)
    return fallback
  }

  /** A positive duration (`30d`, `12h`, `90m`, milliseconds). */
  duration(name: string): string | undefined {
    const v = this.str(name)
    if (v === undefined) return undefined
    let ms = Number.NaN
    try {
      ms = parseDuration(v)
    } catch {
      // reported below
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      this.problems.push(`${name} must be a duration such as 30d, 12h or 90m.`)
      return undefined
    }
    return v
  }

  url(name: string, value: string | undefined, opts: { https?: boolean } = {}): string | undefined {
    if (value === undefined) return undefined
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      this.problems.push(`${name} must be a valid URL.`)
      return undefined
    }
    if (opts.https ? parsed.protocol !== 'https:' : !/^https?:$/.test(parsed.protocol)) {
      this.problems.push(`${name} must start with ${opts.https ? 'https://' : 'http:// or https://'}.`)
      return undefined
    }
    if (parsed.search || parsed.hash) {
      this.problems.push(`${name} must not have a query string or fragment.`)
      return undefined
    }
    return value.replace(/\/+$/, '')
  }

  list(name: string): string[] {
    return (this.str(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  }
}

function readAI(r: Reader): AIEnvConfig {
  const raw = (r.str('AI_PROVIDER') ?? 'ollama').toLowerCase()
  let provider: AIProviderName = 'ollama'
  if ((NATIVE_PROVIDERS as readonly string[]).includes(raw) || isPreset(raw)) provider = raw as AIProviderName
  else r.problems.push(`AI_PROVIDER must be one of: ${NATIVE_PROVIDERS.join(', ')} or an @bot-wa/ai preset (deepseek, groq, openrouter, ...).`)

  const isOllama = provider === 'ollama'
  // Ollama has no default model; the other providers and presets do.
  const model = r.str('AI_MODEL') ?? (isOllama ? 'llama3.1' : undefined)
  // AI_BASE_URL wins; OLLAMA_URL is the friendlier name for the Ollama server.
  const baseUrlVar = !r.str('AI_BASE_URL') && isOllama ? 'OLLAMA_URL' : 'AI_BASE_URL'
  const baseUrl = r.url(baseUrlVar, r.str(baseUrlVar) ?? (isOllama ? 'http://127.0.0.1:11434' : undefined))
  const apiKey = r.str('AI_API_KEY')
  const memoryOn = r.bool('AI_MEMORY', true)
  const maxFacts = r.int('AI_MEMORY_MAX_FACTS', AI_DEFAULTS.memoryMaxFacts, 1, 500)
  const ttl = r.duration('AI_MEMORY_TTL')
  const thinking = readThinking(r)
  const effort = r.optOneOf('AI_EFFORT', EFFORTS)
  const maxTokens = r.optInt('AI_MAX_TOKENS', 64, 128_000)
  const contextMessages = r.optInt('AI_CONTEXT_MESSAGES', 1, 500)
  return {
    provider,
    timeoutMs: r.int('AI_TIMEOUT_MS', 120_000, 1_000, 600_000),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    maxSteps: r.int('AI_MAX_STEPS', AI_DEFAULTS.maxSteps, 1, 20),
    memory: memoryOn ? { maxFacts, ...(ttl ? { ttl } : {}) } : false,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextMessages !== undefined ? { contextMessages } : {}),
  }
}

/** `AI_THINKING`: auto | adaptive | off | a budget in tokens (Anthropic only). */
function readThinking(r: Reader): AIThinking | undefined {
  const v = r.str('AI_THINKING')?.toLowerCase()
  if (v === undefined) return undefined
  if (v === 'auto' || v === 'adaptive' || v === 'off') return v
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
  if (Number.isInteger(n) && n >= 1024 && n <= 128_000) return { budgetTokens: n }
  r.problems.push('AI_THINKING must be auto, adaptive, off or a thinking budget in tokens (an integer between 1024 and 128000).')
  return undefined
}

function readCommon(r: Reader): CommonConfig {
  return {
    ai: readAI(r),
    allowedUsers: r.list('ALLOWED_USERS'),
    groupMode: r.oneOf('GROUP_MODE', GROUP_MODES, 'commands'),
    logLevel: r.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
  }
}

/** Configuration of `main-baileys`. Throws {@link ConfigError}. */
export function loadBaileysConfig(env: Env = process.env): BaileysConfig {
  const r = new Reader(env)
  const common = readCommon(r)
  const session = r.str('WA_SESSION') ?? 'bakery'
  if (!/^[\w-]+$/.test(session)) r.problems.push('WA_SESSION may only contain letters, digits, "_" and "-".')
  const pairingPhone = r.str('WA_PAIRING_PHONE')
  if (pairingPhone !== undefined && !/^\d{8,15}$/.test(pairingPhone)) {
    r.problems.push('WA_PAIRING_PHONE must be the number in international format, digits only (e.g. 15551234567).')
  }
  if (r.problems.length) throw new ConfigError(r.problems)
  return {
    channel: 'baileys',
    ...common,
    session,
    sessionsDir: r.str('WA_SESSIONS_DIR') ?? 'sessions',
    ...(pairingPhone ? { pairingPhone } : {}),
  }
}

/** Configuration of `main-twilio`. Throws {@link ConfigError}. */
export function loadTwilioConfig(env: Env = process.env): TwilioConfig {
  const r = new Reader(env)
  const common = readCommon(r)
  const accountSid = r.required('TWILIO_ACCOUNT_SID', 'Twilio Console → Account info, starts with AC')
  if (accountSid && !/^AC[0-9a-fA-F]{32}$/.test(accountSid)) r.problems.push('TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters.')
  const authToken = r.required('TWILIO_AUTH_TOKEN', 'Twilio Console → Account info; it also verifies webhook signatures')
  const whatsappFrom = r.str('TWILIO_WHATSAPP_FROM') ?? TWILIO_SANDBOX_FROM
  if (!/^whatsapp:\+\d{6,15}$/.test(whatsappFrom)) r.problems.push('TWILIO_WHATSAPP_FROM must look like whatsapp:+14155238886.')
  const smsFrom = r.str('TWILIO_SMS_FROM')
  const publicUrlRaw = r.required('PUBLIC_URL', 'the public https URL of this server, e.g. your cloudflared tunnel')
  const publicUrl = publicUrlRaw ? r.url('PUBLIC_URL', publicUrlRaw, { https: true }) : undefined
  const webhookPath = r.str('WEBHOOK_PATH') ?? '/twilio/webhook'
  if (!webhookPath.startsWith('/')) r.problems.push('WEBHOOK_PATH must start with "/".')
  const port = r.int('PORT', 3000, 1, 65_535)
  if (r.problems.length) throw new ConfigError(r.problems)
  return {
    channel: 'twilio',
    ...common,
    accountSid,
    authToken,
    whatsappFrom,
    ...(smsFrom ? { smsFrom } : {}),
    publicUrl: publicUrl!,
    webhookPath,
    webhookUrl: publicUrl + webhookPath,
    host: r.str('HOST') ?? '127.0.0.1',
    port,
  }
}

/** Non-secret summary of a config, safe to log. */
export function describeConfig(config: BaileysConfig | TwilioConfig): Record<string, unknown> {
  const common = {
    channel: config.channel,
    aiProvider: config.ai.provider,
    aiModel: config.ai.model ?? '(provider default)',
    aiMemory: config.ai.memory ? `on (${config.ai.memory.maxFacts} facts${config.ai.memory.ttl ? `, ttl ${config.ai.memory.ttl}` : ''})` : 'off',
    aiThinking: typeof config.ai.thinking === 'object' ? `budget ${config.ai.thinking.budgetTokens}` : (config.ai.thinking ?? 'auto'),
    aiMaxTokens: config.ai.maxTokens ?? '(provider default)',
    allowList: config.allowedUsers.length ? `${config.allowedUsers.length} id(s)` : 'off (everybody)',
    groupMode: config.groupMode,
  }
  if (config.channel === 'baileys') return { ...common, session: config.session, sessionsDir: config.sessionsDir }
  return { ...common, webhookUrl: config.webhookUrl, listen: `${config.host}:${config.port}`, whatsappFrom: config.whatsappFrom }
}
