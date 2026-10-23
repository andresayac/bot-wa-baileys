/**
 * Project templates for `create-botmesh`.
 *
 * Each template is a pure string-builder set: given a package name it
 * returns the full file list of a runnable @botmesh project (package.json,
 * src/bot.js, .env.example, .gitignore, README.md, AGENTS.md). No I/O here — see
 * `scaffold.ts` for the writer.
 */

import { agentsMd } from './agentsMd.js'
import { DOMAIN_TEMPLATES, DOMAIN_AGENT_NOTES } from './domainTemplates.js'
import {
  AI_POLICY_URL,
  ANTHROPIC_SDK_VERSION,
  CORE_VERSION,
  GITIGNORE,
  aiBotConfig,
  baileysMain,
  botModule,
  botMeshRange,
  packageJson,
  readme,
} from './shared.js'

export type TemplateName =
  | 'baileys'
  | 'meta'
  | 'telegram'
  | 'ai'
  | 'games'
  | 'support'
  | 'store'
  | 'restaurant'
  | 'clinic'
  | 'ai-full'

/** One file to write into the generated project. */
export interface TemplateFile {
  /** Repo-relative POSIX path, e.g. `src/bot.js`. */
  path: string
  contents: string
}

export interface ProjectTemplate {
  name: TemplateName
  /** Human-readable label, e.g. `WhatsApp · Baileys`. */
  label: string
  description: string
  /** Build every file for a project named `name`. */
  files: (name: string) => TemplateFile[]
}

/* Shared builders and the versions stamped into generated package.json files live in ./shared.ts. */

/* baileys ---------------------------------------------------------------- */

const baileys: ProjectTemplate = {
  name: 'baileys',
  label: 'WhatsApp · Baileys',
  description: 'WhatsApp bot over the Baileys socket (QR login, no Meta account needed).',
  files: (name) => [
    {
      path: 'package.json',
      contents: packageJson(name, {
        '@botmesh/core': CORE_VERSION,
        '@botmesh/baileys': botMeshRange('@botmesh/baileys'),
      }),
    },
    {
      path: 'src/bot.js',
      contents: botModule({
        imports: ["import { BaileysProvider } from '@botmesh/baileys'"],
        main: baileysMain('my-bot', '✅ Bot connected — send it "hola"'),
      }),
    },
    {
      path: '.env.example',
      contents: ['# Session/auth folder name (sessions/<name>). No other secrets needed for Baileys.', 'BOT_SESSION=my-bot', ''].join('\n'),
    },
    { path: '.gitignore', contents: GITIGNORE },
    {
      path: 'README.md',
      contents: readme(name, baileysLabel(), baileys.description, [
        'On first start a **QR code** is printed — scan it with WhatsApp → Linked devices.',
        'Auth is cached under `sessions/` so later starts connect automatically.',
      ]),
    },
  ],
}
function baileysLabel(): string { return 'WhatsApp · Baileys' }

/* meta ------------------------------------------------------------------- */

const meta: ProjectTemplate = {
  name: 'meta',
  label: 'WhatsApp · Cloud API (Meta)',
  description: 'WhatsApp bot over the official Meta Cloud API (webhook-based, no ban risk).',
  files: (name) => [
    {
      path: 'package.json',
      contents: packageJson(name, {
        '@botmesh/core': CORE_VERSION,
        '@botmesh/meta': botMeshRange('@botmesh/meta'),
      }),
    },
    {
      path: 'src/bot.js',
      contents: botModule({
        imports: ["import { createServer } from 'node:http'", "import { CloudAPIProvider } from '@botmesh/meta'"],
        main: [
          '// Secrets come from .env when present (loaded via `node --env-file-if-exists=.env`).',
          '// META_TOKEN / META_PHONE_ID: Meta developer portal → WhatsApp → API setup.',
          'const provider = new CloudAPIProvider({',
          '  accessToken: process.env.META_TOKEN,',
          '  phoneNumberId: process.env.META_PHONE_ID,',
          '  verifyToken: process.env.META_VERIFY_TOKEN, // must match the webhook config',
          '  appSecret: process.env.META_APP_SECRET, // required: verifies X-Hub-Signature-256',
          '})',
          'const bot = await createBot(provider)',
          "bot.on('ready', () => bot.logger.info('✅ Bot ready — wire the /webhook URL in the Meta portal'))",
          '',
          '// Tiny zero-dep webhook host (node:http). GET = Meta handshake, POST = inbound events.',
          'const server = createServer((req, res) => {',
          "  const url = new URL(req.url ?? '/', 'http://localhost')",
          "  if (url.pathname !== '/webhook') { res.writeHead(404).end(); return }",
          "  if (req.method === 'GET') {",
          '    const challenge = provider.verifyChallenge(Object.fromEntries(url.searchParams))',
          "    if (challenge === null) { res.writeHead(403).end(); return }",
          "    res.writeHead(200, { 'content-type': 'text/plain' }).end(challenge)",
          '    return',
          '  }',
          "  if (req.method === 'POST') {",
          '    const MAX_WEBHOOK_BYTES = 1024 * 1024',
          '    const chunks = []',
          '    let size = 0',
          '    let rejected = false',
          '    req.on(\'data\', (chunk) => {',
          '      if (rejected) return',
          '      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)',
          '      size += bytes.length',
          '      if (size > MAX_WEBHOOK_BYTES) {',
          '        rejected = true',
          '        res.writeHead(413).end()',
          '        req.destroy()',
          '        return',
          '      }',
          '      chunks.push(bytes)',
          '    })',
          "    req.on('end', () => {",
          '      if (rejected) return',
          '      try {',
          '        const raw = Buffer.concat(chunks)',
          '        const status = provider.ingest(raw, req.headers)',
          '        res.writeHead(status).end()',
          '      } catch {',
          '        res.writeHead(400).end()',
          '      }',
          '    })',
          '    return',
          '  }',
          '  res.writeHead(405).end()',
          '})',
          '',
          'const PORT = Number(process.env.PORT ?? 3000)',
          'await bot.start()',
          "server.listen(PORT, () => bot.logger.info('Webhook listening on http://localhost:' + PORT + '/webhook'))",
        ],
      }),
    },
    {
      path: '.env.example',
      contents:
        [
          '# Meta developer portal → WhatsApp → API setup (permanent token + phone number id).',
          'META_TOKEN=',
          'META_PHONE_ID=',
          '# Verify token you choose; set the same value when configuring the webhook URL.',
          'META_VERIFY_TOKEN=',
          '# Required: validates X-Hub-Signature-256 on inbound webhooks.',
          'META_APP_SECRET=',
          '# Local webhook port (expose via tunnel, e.g. `cloudflared tunnel --url http://localhost:3000`).',
          'PORT=3000',
          '',
        ].join('\n'),
    },
    { path: '.gitignore', contents: GITIGNORE },
    {
      path: 'README.md',
      contents: readme(name, metaLabel(), meta.description, [
        'This transport is **webhook-based**: start the bot, expose it (e.g. `cloudflared tunnel --url http://localhost:3000`)',
        'and set the public `…/webhook` URL + your `META_VERIFY_TOKEN` in the Meta developer portal.',
      ]),
    },
  ],
}
function metaLabel(): string { return 'WhatsApp · Cloud API (Meta)' }

/* telegram --------------------------------------------------------------- */

const telegram: ProjectTemplate = {
  name: 'telegram',
  label: 'Telegram · Bot API',
  description: 'Telegram bot over the Bot API (long-polling, works behind any NAT).',
  files: (name) => [
    {
      path: 'package.json',
      contents: packageJson(name, {
        '@botmesh/core': CORE_VERSION,
        '@botmesh/telegram': botMeshRange('@botmesh/telegram'),
      }),
    },
    {
      path: 'src/bot.js',
      contents: botModule({
        imports: ["import { TelegramProvider } from '@botmesh/telegram'"],
        main: [
          '// TELEGRAM_TOKEN: create a bot with @BotFather and paste the token in .env.',
          'const bot = await createBot(new TelegramProvider({ token: process.env.TELEGRAM_TOKEN }))',
          "bot.on('ready', () => bot.logger.info('✅ Telegram bot polling — send it \"hola\"'))",
          'await bot.start()',
        ],
      }),
    },
    {
      path: '.env.example',
      contents: ['# Bot token from @BotFather.', 'TELEGRAM_TOKEN=', ''].join('\n'),
    },
    { path: '.gitignore', contents: GITIGNORE },
    {
      path: 'README.md',
      contents: readme(name, telegramLabel(), telegram.description, [
        'Create the bot with [@BotFather](https://t.me/BotFather), copy the token into `.env`, and start —',
        'long-polling means no webhook/tunnel setup is required.',
      ]),
    },
  ],
}
function telegramLabel(): string { return 'Telegram · Bot API' }

/* ai (baileys + @botmesh/ai) ----------------------------------------------- */

/* Since 2026-01-15 Meta's WhatsApp Business Platform terms ("AI Providers")
 * prohibit general-purpose AI assistants; AI that serves the business's own
 * customers (support, sales, bookings) is allowed. The template therefore ships
 * a persona scoped to one business instead of an open-ended assistant
 * (AI_POLICY_URL lives in ./shared.ts). */

const ai: ProjectTemplate = {
  name: 'ai',
  label: 'WhatsApp · Baileys + AI',
  description: 'WhatsApp bot (Baileys) with a business-scoped AI customer-support autoresponder via @botmesh/ai (Anthropic).',
  files: (name) => [
    {
      path: 'package.json',
      contents: packageJson(name, {
        '@botmesh/core': CORE_VERSION,
        '@botmesh/baileys': botMeshRange('@botmesh/baileys'),
        '@botmesh/ai': botMeshRange('@botmesh/ai'),
        '@anthropic-ai/sdk': ANTHROPIC_SDK_VERSION,
      }),
    },
    {
      path: 'src/bot.js',
      contents: botModule({
        imports: ["import { BaileysProvider } from '@botmesh/baileys'", "import { aiPlugin } from '@botmesh/ai'"],
        prelude: [
          '// Business-scoped persona: keep the AI on YOUR business (support, sales, bookings).',
          '// Since 2026-01-15 the WhatsApp Business Platform terms prohibit general-purpose',
          '// AI assistants (open-ended, ChatGPT-style chatbots); AI that serves your own',
          '// customers is allowed. Policy: ' + AI_POLICY_URL,
          "const BUSINESS = process.env.BUSINESS_NAME ?? 'Mi Negocio'",
          'const PERSONA = [',
          "  'Eres el asistente de atención al cliente de ' + BUSINESS + '.',",
          "  'Solo respondes sobre sus productos, servicios, precios, pedidos, horarios y reservas.',",
          "  'Si te piden algo ajeno al negocio, explica con amabilidad que solo puedes ayudar con temas de ' + BUSINESS + ' y ofrece hablar con una persona.',",
          "  'Responde breve y en español. Si no sabes un dato, dilo; no lo inventes.',",
          "].join(' ')",
        ],
        config: aiBotConfig('provider'),
        setup: [
          '// AI autoresponder: answers text messages that no command/handler/flow consumed.',
          "// Also adds ctx.tools.ai and a /reset command to clear a chat's context.",
          'bot.plug(',
          '  aiPlugin({',
          "    provider: 'anthropic',",
          '    apiKey: process.env.ANTHROPIC_API_KEY,',
          '    persona: PERSONA,',
          '  }),',
          ')',
          '',
        ],
        main: baileysMain('my-ai-bot', '✅ Bot connected — unhandled text messages get a business-scoped AI reply'),
      }),
    },
    {
      path: '.env.example',
      contents:
        [
          '# Anthropic API key (console.anthropic.com) — used by the AI autoresponder.',
          'ANTHROPIC_API_KEY=',
          '# Your business name — the AI persona only answers about this business.',
          'BUSINESS_NAME=Mi Negocio',
          '# Session/auth folder name (sessions/<name>).',
          'BOT_SESSION=my-ai-bot',
          '',
        ].join('\n'),
    },
    { path: '.gitignore', contents: GITIGNORE },
    {
      path: 'README.md',
      contents: readme(name, aiLabel(), ai.description, [
        'On first start a **QR code** is printed — scan it with WhatsApp → Linked devices.',
        'Text messages that no command, handler or flow consumed are answered by the AI, scoped to your business',
        '(`BUSINESS_NAME` in `.env`, `PERSONA` in `src/bot.js`); send `/reset` in a chat to clear its context.',
        'Switch providers by changing `provider` in `src/bot.js` (e.g. `openai`, `gemini`, `ollama`) and its env key.',
        '',
        '## WhatsApp AI policy',
        '',
        'Since 2026-01-15 the Meta terms for the **WhatsApp Business Platform** prohibit **general-purpose AI assistants**',
        '(open-ended, ChatGPT-style chatbots whose main purpose is the AI itself). AI that serves your own business —',
        'customer support, sales, bookings — is allowed. Keep `PERSONA` scoped to your business, especially if you move',
        'this bot to the official Cloud API (`@botmesh/meta`). Baileys is an unofficial WhatsApp Web client and is also',
        'subject to WhatsApp\'s terms. Check the [current terms](' + AI_POLICY_URL + ') before going live.',
      ]),
    },
  ],
}
function aiLabel(): string { return 'WhatsApp · Baileys + AI' }

/* Registry --------------------------------------------------------------- */

/**
 * Append the AGENTS.md (AI coding-agent instructions) to a template's files.
 * Its dependency list is read back from the generated package.json.
 */
function withAgentsMd(template: ProjectTemplate, notes: string[] = []): ProjectTemplate {
  return {
    ...template,
    files: (name) => {
      const files = template.files(name)
      const pkgFile = files.find((f) => f.path === 'package.json')
      const deps = pkgFile ? Object.keys((JSON.parse(pkgFile.contents) as { dependencies?: Record<string, string> }).dependencies ?? {}) : []
      return [...files, { path: 'AGENTS.md', contents: agentsMd({ name, label: template.label, dependencies: deps, notes }) }]
    },
  }
}

export const TEMPLATES: Record<TemplateName, ProjectTemplate> = {
  baileys: withAgentsMd(baileys),
  meta: withAgentsMd(meta, ['- Webhook transport: the raw request body must reach `provider.ingest(raw, headers)` untouched (signature check).']),
  telegram: withAgentsMd(telegram),
  ai: withAgentsMd(ai, [
    '- `aiPlugin` is a catch-all: it answers text nothing else consumed. Register handlers/flows normally; keep the persona',
    '  scoped to the business (WhatsApp Business Platform terms forbid general-purpose AI assistants).',
  ]),
  games: withAgentsMd(DOMAIN_TEMPLATES.games, DOMAIN_AGENT_NOTES.games),
  support: withAgentsMd(DOMAIN_TEMPLATES.support, DOMAIN_AGENT_NOTES.support),
  store: withAgentsMd(DOMAIN_TEMPLATES.store, DOMAIN_AGENT_NOTES.store),
  restaurant: withAgentsMd(DOMAIN_TEMPLATES.restaurant, DOMAIN_AGENT_NOTES.restaurant),
  clinic: withAgentsMd(DOMAIN_TEMPLATES.clinic, DOMAIN_AGENT_NOTES.clinic),
  'ai-full': withAgentsMd(DOMAIN_TEMPLATES['ai-full'], DOMAIN_AGENT_NOTES['ai-full']),
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[]

/** Look up a template; throws a helpful error for unknown names. */
export function getTemplate(name: string): ProjectTemplate {
  const template = TEMPLATES[name as TemplateName]
  if (!template) {
    throw new Error('Unknown template "' + String(name) + '". Valid templates: ' + TEMPLATE_NAMES.join(', '))
  }
  return template
}
