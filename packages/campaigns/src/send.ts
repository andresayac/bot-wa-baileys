/**
 * sendCampaign — plans a campaign and sends it with `bot.broadcast()`, settling every
 * queued delivery from the real broadcast result: accepted sends count (`sent`), final
 * failures and chats a hook skipped or the abort left pending release their slot
 * (`failed`). The per-chat FIFO is not involved (broadcast bypasses it); the bot's
 * `before`/`after('send')` hooks still run for every send.
 */

import type { Bot, BroadcastOptions, BroadcastResult, OutboundContent } from '@bot-wa/core'
import type { CampaignPlanner } from './planner.js'
import type { Campaign, CampaignRecipient, Delivery } from './types.js'

/** One delivery the run could not settle (the broadcast itself already finished). */
export interface CampaignSettleError {
  deliveryId: string
  error: Error
}

/** What {@link sendCampaign} returns. */
export interface CampaignRun {
  /** Final deliveries, in the order `plan()` returned them (queued ones could not be settled). */
  deliveries: Delivery[]
  /** The raw broadcast result. */
  broadcast: BroadcastResult
  /** Settlements that failed (e.g. contention); the slot is released by its TTL. */
  settleErrors: CampaignSettleError[]
}

/**
 * Plan `campaign` over `recipients` and send `content` to the queued ones with
 * `bot.broadcast()`. A queued delivery is settled as `sent` when its chat appears in the
 * accepted sends, and as `failed` when it failed, was skipped by a `before('send')` hook
 * or was left pending by an abort (with a reason in `error`). Two recipients that share
 * a `chatId` (defaults to the recipient id) are sent once; the repeats fail with
 * `'duplicate chatId'`.
 *
 * `options` is passed to `bot.broadcast()` (`batchSize`, `delayBetween`, `concurrency`,
 * `maxRetries`, `sendOptions`, `onProgress`, `onFail`, `signal`).
 */
export async function sendCampaign(
  bot: Bot,
  planner: CampaignPlanner,
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  content: string | OutboundContent,
  options: BroadcastOptions = {},
): Promise<CampaignRun> {
  const deliveries = await planner.plan(campaign, recipients)
  const byId = new Map(recipients.map((recipient) => [recipient.id, recipient]))
  const chatOf = (delivery: Delivery): string => byId.get(delivery.recipientId)?.chatId ?? delivery.recipientId
  const settleErrors: CampaignSettleError[] = []

  // One target per chat: the first queued delivery wins, the repeats release their slot.
  const targets: string[] = []
  const queued: Delivery[] = []
  const claimed = new Set<string>()
  for (const delivery of deliveries) {
    if (delivery.state !== 'queued' || !delivery.deliveryId) continue
    const chatId = chatOf(delivery)
    if (claimed.has(chatId)) {
      const settled = await settle(delivery, settleErrors, () => planner.markFailed(delivery.deliveryId!, 'duplicate chatId'))
      if (settled) applySettled(delivery, settled)
      continue
    }
    claimed.add(chatId)
    targets.push(chatId)
    queued.push(delivery)
  }

  const broadcast = await bot.broadcast(targets, content, options)
  const accepted = new Set(broadcast.messages.map((message) => message.ref.chatId))
  const failed = new Map(broadcast.errors.map((failure) => [failure.chatId, failure.error]))
  const pending = new Set(broadcast.pending)

  for (const delivery of queued) {
    const chatId = chatOf(delivery)
    const settleAs = (): Promise<Delivery> => {
      if (accepted.has(chatId)) return planner.markSent(delivery.deliveryId!)
      if (failed.has(chatId)) return planner.markFailed(delivery.deliveryId!, failed.get(chatId)!.message)
      if (pending.has(chatId)) return planner.markFailed(delivery.deliveryId!, 'cancelled')
      return planner.markFailed(delivery.deliveryId!, 'skipped')
    }
    const settled = await settle(delivery, settleErrors, settleAs)
    if (settled) applySettled(delivery, settled)
  }

  return { deliveries, broadcast, settleErrors }
}

/** Copy the final state (and the failure reason, if any) onto the planned delivery. */
function applySettled(delivery: Delivery, settled: Delivery): void {
  delivery.state = settled.state
  if (settled.error !== undefined) delivery.error = settled.error
}

async function settle(
  delivery: Delivery,
  errors: CampaignSettleError[],
  run: () => Promise<Delivery>,
): Promise<Delivery | undefined> {
  try {
    return await run()
  } catch (error) {
    errors.push({ deliveryId: delivery.deliveryId!, error: error instanceof Error ? error : new Error(String(error)) })
    return undefined
  }
}
