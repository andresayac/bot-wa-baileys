/**
 * Shared string builders for the `create-botmesh` templates (package.json,
 * the `defineBot` bot module, README, .gitignore) plus the dependency
 * versions stamped into generated projects. Pure — no I/O.
 */

import { BOTMESH_VERSIONS } from './versions.js'
import type { BotMeshPackage } from './versions.js'

/* Versions stamped into generated package.json files.
 *
 * The `@botmesh/*` ranges come from ./versions.ts, generated at build time from
 * the current version of each public workspace package (a caret over the exact
 * version, so a prerelease such as `^2.0.0-alpha.2` still resolves on npm). */
export { BOTMESH_VERSIONS }
export type { BotMeshPackage }

/** The range stamped for a public `@botmesh/*` package. */
export const botMeshRange = (name: BotMeshPackage): string => BOTMESH_VERSIONS[name]

export const CORE_VERSION = botMeshRange('@botmesh/core')
export const ANTHROPIC_SDK_VERSION = '^0.68.0'
export const BETTER_SQLITE3_VERSION = '^11.7.0'

/** WhatsApp Business Solution terms (the 2026-01-15 "AI Providers" policy), linked from the AI templates. */
export const AI_POLICY_URL = 'https://www.whatsapp.com/legal/business-solution-terms'

export const GITIGNORE = ['node_modules/', 'sessions/', '.env', '*.qr.png', '*.db', '*.db-*', ''].join('\n')

export function packageJson(name: string, deps: Record<string, string>): string {
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: 'A bot built with @botmesh/core',
    engines: { node: '>=22' },
    scripts: {
      start: 'node --env-file=.env src/bot.js',
      // Terminal chat simulator with hot reload (ships with @botmesh/core).
      dev: 'botmesh dev src/bot.js --env-file .env',
    },
    dependencies: deps,
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

/** The /hola handler + a tiny menu flow shared by the transport templates' bot.js. */
export const HANDLERS = [
  "// Simple keyword handler — reply 'hola' and get a greeting.",
  "bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))",
  '',
  '// A small conversational flow: ask a question, capture the answer, reply.',
  'bot.useFlow(',
  "  flow('menu')",
  "    .say('📋 *Menú*\\n1️⃣ Info\\n2️⃣ Ping')",
  "    .ask('Responde 1 o 2:', 'choice')",
  "    .say(async (_msg, c) => (c.state.choice === '1' ? 'ℹ️ Hecho con @botmesh/core' : '🏓 ¡pong!'))",
  '    // Abandoned conversations end after 5 minutes without an answer.',
  "    .timeout('5m'),",
  ')',
]

export interface BotModuleParts {
  /** Import lines after the `@botmesh/core` import (transport, plugins, stores). */
  imports: string[]
  /** Extra named imports from `@botmesh/core` (besides Bot, defineBot, flow, isMainModule). */
  coreImports?: string[]
  /** Module-level lines right after the imports (constants the factory reads). */
  prelude?: string[]
  /** Factory parameter list (default `provider`). */
  params?: string
  /** `new Bot(...)` config literal (default `{ provider }`). */
  config?: string
  /** Lines before the handlers inside the factory (plugins, config). */
  setup?: string[]
  /** Handler lines inside the factory (default: the shared HANDLERS). */
  handlers?: string[]
  /** Lines of the `isMainModule(import.meta)` block that connects the real provider. */
  main: string[]
}

/**
 * Assemble `src/bot.js` in the defineBot factory pattern:
 *  - `createBot` (the default export) builds the bot around ANY provider —
 *    `npm run dev` (`botmesh dev`) calls it with the terminal simulator;
 *  - the `isMainModule(import.meta)` block runs only on `npm start` and
 *    connects the real provider.
 * `setup`, `handlers` and `main` lines are written at column 0 and indented into place here.
 */
export function botModule(parts: BotModuleParts): string {
  const indent = (lines: string[]) => lines.map((line) => (line ? '  ' + line : line))
  const coreNames = ['Bot', 'defineBot', 'flow', 'isMainModule', ...(parts.coreImports ?? [])]
  return [
    'import { ' + coreNames.join(', ') + " } from '@botmesh/core'",
    ...parts.imports,
    '',
    ...(parts.prelude ? [...parts.prelude, ''] : []),
    '// Your bot as a factory: give it a transport provider, get the configured Bot back.',
    '// `npm start` passes the real provider (bottom of this file); `npm run dev` passes the',
    '// botmesh dev terminal simulator, so you can try flows with no phone and no ban risk.',
    'const createBot = defineBot((' + (parts.params ?? 'provider') + ') => {',
    '  const bot = new Bot(' + (parts.config ?? '{ provider }') + ')',
    '',
    ...indent([...(parts.setup ?? []), ...(parts.handlers ?? HANDLERS)]),
    '',
    '  return bot',
    '})',
    '',
    'export default createBot',
    '',
    '// `npm start` runs this file directly: connect the real provider.',
    '// (`botmesh dev` only imports the factory above, so this block is skipped there.)',
    'if (isMainModule(import.meta)) {',
    ...indent(parts.main),
    '}',
    '',
  ].join('\n')
}

export function readme(name: string, label: string, description: string, notes: string[]): string {
  const fence = '```'
  return [
    '# ' + name,
    '',
    '> ' + description,
    '',
    'Template: **' + label + '** — generated by [`create-botmesh`](https://www.npmjs.com/package/create-botmesh).',
    '',
    '## Run',
    '',
    fence + 'bash',
    'npm install          # or: pnpm install',
    'cp .env.example .env # then fill in your credentials',
    'npm run dev          # chat with your bot in the terminal (no phone, hot reload)',
    'npm start            # connect the real provider',
    fence,
    '',
    ...notes,
    '',
    '## Try it in the terminal',
    '',
    '`npm run dev` starts the **botmesh dev** simulator: you type as a user, the bot answers right there, and',
    'saving a file reloads it. Nothing is sent to a real chat, so there is no ban risk. Type `:help` inside for',
    'commands (`:as <user>`, `:group <id>`, `:media image ./cat.png`, `:click <n>`, `:state`, `:reset`, `:quit`).',
    '',
    '## Structure',
    '',
    '- `src/bot.js` — your bot: a `defineBot` factory (handlers + flows) and the block that connects the real provider on `npm start`.',
    '- `.env.example` — the env vars this bot reads (copy to `.env`, never commit `.env`).',
    '- `AGENTS.md` — instructions for AI coding agents (the current v2 API and the commands to run).',
    '- `sessions/` — auth artifacts (gitignored).',
    '',
    '## Learn more',
    '',
    '- [`@botmesh/core`](https://www.npmjs.com/package/@botmesh/core) — `when`, `flow`, `conversation`, plugins, hooks, scheduler.',
    '',
  ].join('\n')
}

/** `main` block lines shared by every Baileys-based template. */
export function baileysMain(defaultSession: string, readyLine: string, createArgs = ''): string[] {
  return [
    '// Secrets/config come from .env (loaded via `node --env-file=.env`; `npm run dev` loads it too).',
    '// The session name just picks which sessions/<name> auth folder to use.',
    "const bot = await createBot(new BaileysProvider({ session: process.env.BOT_SESSION ?? '" + defaultSession + "' })" + createArgs + ')',
    "bot.on('qr', () => bot.logger.info('Scan the QR printed in the terminal to link WhatsApp'))",
    "bot.on('ready', () => bot.logger.info('" + readyLine.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'))",
    'await bot.start()',
  ]
}

/**
 * `new Bot(...)` config literal of the AI templates: `fields` plus `i18n` pinned to
 * Spanish, so the built-in texts (slash commands, the AI's "¿Confirmas?" prompt and
 * its Sí/No buttons) always match the Spanish persona, even when a client reports
 * another language (e.g. Telegram's `language_code`).
 */
export function aiBotConfig(fields: string): string {
  return [
    '{',
    '    ' + fields + ',',
    '    // Built-in texts (commands, AI confirmations, Sí/No) in Spanish, like the persona.',
    '    // To serve more languages: list them here and translate PERSONA (see the i18n guide).',
    "    i18n: { defaultLocale: 'es', locales: ['es'] },",
    '  }',
  ].join('\n')
}
