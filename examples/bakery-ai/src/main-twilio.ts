/**
 * Bakery assistant on WhatsApp through Twilio (official WhatsApp Business API).
 *
 *   pnpm --filter @bot-wa/example-bakery-ai build
 *   pnpm --filter @bot-wa/example-bakery-ai start:twilio
 *
 * Twilio POSTs every incoming message to PUBLIC_URL + WEBHOOK_PATH. The
 * provider verifies the X-Twilio-Signature against that exact URL, so
 * PUBLIC_URL must be what Twilio calls (your tunnel or reverse proxy).
 */
import { createServer } from 'node:http'
import { createIngress, createNodeHandler } from '@bot-wa/server'
import { TwilioProvider } from '@bot-wa/twilio'
import { createBakeryBot } from './bot.js'
import { describeConfig, loadTwilioConfig } from './config.js'
import { attachBotLogging, createLogger, loadConfigOrExit, onShutdown } from './runtime.js'

const config = loadConfigOrExit(() => loadTwilioConfig())
const logger = createLogger(config.logLevel)
logger.info(describeConfig(config), 'starting bakery assistant')
if (config.allowedUsers.length === 0) logger.warn('ALLOWED_USERS is empty: the bot will answer every sender')

const provider = new TwilioProvider({
  accountSid: config.accountSid,
  authToken: config.authToken,
  whatsappFrom: config.whatsappFrom,
  ...(config.smsFrom ? { smsFrom: config.smsFrom } : {}),
  webhookUrl: config.webhookUrl,
})

const bot = createBakeryBot(provider, {
  ai: config.ai,
  allowedUsers: config.allowedUsers,
  groupMode: config.groupMode,
  logger,
})
attachBotLogging(bot, logger)
bot.on('status', (s) => logger.debug({ status: s.status }, 'delivery status'))

// Raw-body capture (for the signature), size/time/concurrency limits, plus
// GET /healthz (liveness) and GET /readyz (200 once the bot is ready).
const ingress = createIngress({
  routes: [{ path: config.webhookPath, provider }],
  bot,
  maxBodyBytes: 256 * 1024,
  logger: logger.child({ module: 'ingress' }),
})
const server = createServer(createNodeHandler(ingress))

onShutdown(logger, async () => {
  // Stop taking webhooks first (Twilio retries what got a 503), then the bot.
  await ingress.close({ timeoutMs: 5_000 })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await bot.stop({ drain: true, timeout: 5_000 })
})

await bot.start()
server.listen(config.port, config.host, () => {
  logger.info({ listen: `http://${config.host}:${config.port}`, webhook: config.webhookUrl }, 'webhook server listening')
})
