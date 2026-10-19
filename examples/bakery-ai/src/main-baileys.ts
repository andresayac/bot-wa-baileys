/**
 * Bakery assistant on WhatsApp through Baileys (WhatsApp Web protocol).
 *
 *   pnpm --filter @bot-wa/example-bakery-ai build
 *   pnpm --filter @bot-wa/example-bakery-ai start:baileys
 *
 * Scan the QR printed in the terminal from WhatsApp → Linked devices. The
 * session is saved in WA_SESSIONS_DIR (git-ignored): never commit or share it.
 */
import { BaileysProvider } from '@bot-wa/baileys'
import { createBakeryBot } from './bot.js'
import { describeConfig, loadBaileysConfig } from './config.js'
import { attachBotLogging, createLogger, loadConfigOrExit, onShutdown } from './runtime.js'

const config = loadConfigOrExit(() => loadBaileysConfig())
const logger = createLogger(config.logLevel)
logger.info(describeConfig(config), 'starting bakery assistant')
if (config.allowedUsers.length === 0) logger.warn('ALLOWED_USERS is empty: the bot will answer every chat on this number')

const provider = new BaileysProvider({
  session: config.session,
  sessionsDir: config.sessionsDir,
  qr: { terminal: !config.pairingPhone },
  ...(config.pairingPhone ? { pairingCode: config.pairingPhone } : {}),
  markOnlineOnConnect: false,
  ignoreNewsletters: true,
  ignoreBroadcasts: true,
})

const bot = createBakeryBot(provider, {
  ai: config.ai,
  allowedUsers: config.allowedUsers,
  groupMode: config.groupMode,
  logger,
})
attachBotLogging(bot, logger)
// With a pairing code, the code to type in WhatsApp also arrives on 'qr' (after the QR
// payload, which is a credential and is never logged): show only the short code.
if (config.pairingPhone) {
  bot.on('qr', (payload) => {
    if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(payload)) logger.info(`Pairing code: ${payload} (WhatsApp → Linked devices → Link with phone number)`)
  })
}

onShutdown(logger, () => bot.stop())
await bot.start()
