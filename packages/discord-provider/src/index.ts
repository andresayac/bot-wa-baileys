/**
 * @bot-wa/discord — Discord transport for @bot-wa/core. Gateway websocket for
 * events, REST for sending; buttons/selects/slash commands as interactions.
 */

export { DiscordProvider } from './DiscordProvider.js'
export { GatewaySocket, defaultSocketFactory, gatewayConnectUrl } from './gateway.js'
export { DiscordRestClient, toProviderError } from './restClient.js'
export { toOutbound } from './toOutbound.js'
export type { DiscordFile, DiscordOutboundPayload } from './toOutbound.js'
export { parseDispatch, snowflakeTimestamp } from './parseInbound.js'
export type {
  DiscordProviderConfig,
  SocketLike,
  SocketFactory,
  GatewayPayload,
  DiscordUser,
  DiscordAttachment,
  DiscordMessagePayload,
  DiscordInteractionData,
  DiscordInteractionPayload,
  DiscordApiErrorBody,
  DiscordMessageResponse,
} from './types.js'
export {
  GatewayOpcode,
  GatewayIntents,
  InteractionType,
  ComponentType,
  DEFAULT_INTENTS,
  FATAL_CLOSE_CODES,
  FRESH_SESSION_CODES,
} from './types.js'
