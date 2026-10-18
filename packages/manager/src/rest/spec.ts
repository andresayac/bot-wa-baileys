/**
 * Route table of the `/v1` REST API — the single source of truth for both the
 * router ({@link createRestApi}) and the OpenAPI document ({@link buildOpenApiDocument}).
 */

import { FLOW_DOCUMENT_SCHEMA } from '../flows/schema.js'

/** Permission a token needs for a route. `'*'` grants all of them. */
export type ApiScope =
  | 'bots:read' | 'bots:write' | 'bots:operate'
  | 'connections:read'
  | 'messages:read' | 'messages:send'
  | 'conversations:read' | 'conversations:write'
  | 'flows:read' | 'flows:write'
  | 'metrics:read'

/** Every scope, for docs and validation. */
export const API_SCOPES: readonly ApiScope[] = [
  'bots:read', 'bots:write', 'bots:operate', 'connections:read', 'messages:read', 'messages:send',
  'conversations:read', 'conversations:write', 'flows:read', 'flows:write', 'metrics:read',
]

type JsonSchema = Record<string, unknown>

/** Metadata of one REST route. */
export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path relative to the API prefix, with `{param}` placeholders. */
  path: string
  operationId: string
  summary: string
  tag: 'system' | 'bots' | 'lifecycle' | 'messaging' | 'conversations' | 'flows' | 'metrics'
  /** Required scope; `undefined` = public route (no token). */
  scope?: ApiScope
  /** `true` → public only while `publicDocs` is on (otherwise needs `bots:read`). */
  docs?: boolean
  body?: JsonSchema
  query?: Array<{ name: string; required?: boolean; schema: JsonSchema; description: string }>
  success: { status: 200 | 201 | 202 | 204; description: string; schema?: JsonSchema }
  /** Extra documented error statuses besides the common ones. */
  errors?: number[]
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })
const envelope = (data: JsonSchema): JsonSchema => ({
  type: 'object', required: ['data', 'requestId'], properties: { data, requestId: { type: 'string' } },
})
const arrayOf = (items: JsonSchema): JsonSchema => ({ type: 'array', items })
const lifecycle = (action: 'start' | 'stop' | 'restart', summary: string): RouteSpec => ({
  method: 'POST', path: `/bots/{botId}/${action}`, operationId: `${action}Bot`, summary, tag: 'lifecycle', scope: 'bots:operate',
  success: { status: 200, description: 'New running state.', schema: envelope(ref('BotStatus')) }, errors: [404, 500],
})

/** All routes of the v1 API. */
export const ROUTES: readonly RouteSpec[] = [
  {
    method: 'GET', path: '/health', operationId: 'getHealth', summary: 'Liveness probe (public).', tag: 'system',
    success: { status: 200, description: 'The API is up.', schema: envelope({ type: 'object', properties: { status: { const: 'ok' }, uptimeMs: { type: 'integer' } } }) },
  },
  {
    method: 'GET', path: '/openapi.json', operationId: 'getOpenApi', summary: 'This OpenAPI 3.1 document.', tag: 'system', docs: true,
    success: { status: 200, description: 'OpenAPI document (not wrapped in an envelope).', schema: { type: 'object' } },
  },
  {
    method: 'GET', path: '/flows/schema', operationId: 'getFlowSchema', summary: 'JSON Schema of flow documents (v1).', tag: 'flows', docs: true,
    success: { status: 200, description: 'JSON Schema draft 2020-12 (not wrapped in an envelope).', schema: { type: 'object' } },
  },
  {
    method: 'GET', path: '/metrics', operationId: 'getManagerMetrics', summary: 'Aggregated metrics of the bots visible to the token.', tag: 'metrics', scope: 'metrics:read',
    success: { status: 200, description: 'Totals and per-bot metrics.', schema: envelope(ref('ManagerMetrics')) },
  },
  {
    method: 'GET', path: '/bots', operationId: 'listBots', summary: 'List bots (scoped to the token tenant).', tag: 'bots', scope: 'bots:read',
    query: [{ name: 'tenantId', schema: { type: 'string' }, description: 'Filter by tenant (all-tenant tokens only).' }],
    success: { status: 200, description: 'Bots.', schema: envelope(arrayOf(ref('BotStatus'))) },
  },
  {
    method: 'POST', path: '/bots', operationId: 'createBot', summary: 'Create a bot from a serializable config (needs a factory).', tag: 'bots', scope: 'bots:write',
    body: ref('CreateBotInput'),
    success: { status: 201, description: 'Created.', schema: envelope(ref('BotDetail')) }, errors: [400, 409, 501],
  },
  {
    method: 'GET', path: '/bots/{botId}', operationId: 'getBot', summary: 'Status, config and connection state of one bot.', tag: 'bots', scope: 'bots:read',
    success: { status: 200, description: 'Bot.', schema: envelope(ref('BotDetail')) }, errors: [404],
  },
  {
    method: 'PUT', path: '/bots/{botId}', operationId: 'updateBot', summary: 'Update a config-backed bot (provider/flows changes rebuild it).', tag: 'bots', scope: 'bots:write',
    body: ref('UpdateBotInput'),
    success: { status: 200, description: 'Updated.', schema: envelope(ref('BotDetail')) }, errors: [400, 404, 409, 501],
  },
  {
    method: 'DELETE', path: '/bots/{botId}', operationId: 'deleteBot', summary: 'Stop, unregister and delete a bot and its config.', tag: 'bots', scope: 'bots:write',
    success: { status: 204, description: 'Deleted.' }, errors: [404],
  },
  lifecycle('start', 'Start a bot.'),
  lifecycle('stop', 'Stop a bot.'),
  lifecycle('restart', 'Restart a bot.'),
  {
    method: 'GET', path: '/bots/{botId}/connection', operationId: 'getConnection', summary: 'Connection state and current QR / pairing payload.', tag: 'lifecycle', scope: 'connections:read',
    success: { status: 200, description: 'Connection snapshot.', schema: envelope(ref('Connection')) }, errors: [404],
  },
  {
    method: 'POST', path: '/bots/{botId}/send', operationId: 'sendMessage', summary: 'Send a message to a chat.', tag: 'messaging', scope: 'messages:send',
    body: ref('SendInput'),
    success: { status: 200, description: 'Sent.', schema: envelope({ type: 'object', properties: { messageId: { type: 'string' }, chatId: { type: 'string' }, skipped: { type: 'boolean' } } }) },
    errors: [400, 404, 413, 422, 501, 503],
  },
  {
    method: 'POST', path: '/bots/{botId}/trigger', operationId: 'triggerFlow', summary: 'Start a flow proactively in a chat.', tag: 'conversations', scope: 'conversations:write',
    body: ref('TriggerInput'),
    success: { status: 202, description: 'Flow started (runs asynchronously).', schema: envelope({ type: 'object', properties: { started: { const: true } } }) },
    errors: [400, 404, 409, 501],
  },
  {
    method: 'GET', path: '/bots/{botId}/conversations', operationId: 'listConversations', summary: 'Live conversations.', tag: 'conversations', scope: 'conversations:read',
    success: { status: 200, description: 'Conversations.', schema: envelope(arrayOf(ref('Conversation'))) }, errors: [404, 501],
  },
  {
    method: 'POST', path: '/bots/{botId}/conversations/{key}/cancel', operationId: 'cancelConversation', summary: 'Abort a live conversation by key.', tag: 'conversations', scope: 'conversations:write',
    success: { status: 200, description: 'Cancelled.', schema: envelope({ type: 'object', properties: { cancelled: { const: true } } }) }, errors: [404, 501],
  },
  {
    method: 'GET', path: '/bots/{botId}/messages', operationId: 'listMessages', summary: 'Stored messages of a chat, newest first, cursor-paginated.', tag: 'messaging', scope: 'messages:read',
    query: [
      { name: 'chatId', required: true, schema: { type: 'string' }, description: 'Chat id (opaque).' },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Page size.' },
      { name: 'cursor', schema: { type: 'string' }, description: '`nextCursor` of the previous page.' },
    ],
    success: { status: 200, description: 'A page of messages.', schema: { type: 'object', properties: { data: arrayOf(ref('Message')), nextCursor: { type: ['string', 'null'] }, requestId: { type: 'string' } } } },
    errors: [400, 404, 501],
  },
  {
    method: 'GET', path: '/bots/{botId}/metrics', operationId: 'getBotMetrics', summary: 'Counters of one bot.', tag: 'metrics', scope: 'metrics:read',
    success: { status: 200, description: 'Metrics.', schema: envelope(ref('BotMetrics')) }, errors: [404],
  },
  {
    method: 'GET', path: '/bots/{botId}/flows', operationId: 'listFlows', summary: 'Registered flows and stored JSON flow documents.', tag: 'flows', scope: 'flows:read',
    success: { status: 200, description: 'Flows.', schema: envelope({ type: 'object', properties: { registered: arrayOf({ type: 'object' }), documents: arrayOf(ref('FlowDocument')) } }) },
    errors: [404],
  },
  {
    method: 'POST', path: '/bots/{botId}/flows', operationId: 'createFlow', summary: 'Register a JSON flow document.', tag: 'flows', scope: 'flows:write',
    body: ref('FlowDocument'),
    success: { status: 201, description: 'Registered.', schema: envelope({ type: 'object', properties: { id: { type: 'string' } } }) }, errors: [400, 404, 409, 501],
  },
  {
    method: 'GET', path: '/bots/{botId}/flows/{flowId}', operationId: 'getFlow', summary: 'One stored JSON flow document.', tag: 'flows', scope: 'flows:read',
    success: { status: 200, description: 'Flow document.', schema: envelope(ref('FlowDocument')) }, errors: [404],
  },
  {
    method: 'PUT', path: '/bots/{botId}/flows/{flowId}', operationId: 'putFlow', summary: 'Create or hot-swap a JSON flow (its id must match).', tag: 'flows', scope: 'flows:write',
    body: ref('FlowDocument'),
    success: { status: 200, description: 'Replaced (201 when created).', schema: envelope({ type: 'object', properties: { id: { type: 'string' }, created: { type: 'boolean' } } }) },
    errors: [400, 404, 501],
  },
  {
    method: 'DELETE', path: '/bots/{botId}/flows/{flowId}', operationId: 'deleteFlow', summary: 'Unregister a flow.', tag: 'flows', scope: 'flows:write',
    success: { status: 204, description: 'Deleted.' }, errors: [404, 501],
  },
]

const stringMap = { type: 'object', additionalProperties: true }

/** Reusable component schemas of the OpenAPI document. */
export const COMPONENT_SCHEMAS: Record<string, JsonSchema> = {
  Error: {
    type: 'object', required: ['error'],
    properties: {
      error: {
        type: 'object', required: ['code', 'message', 'requestId'],
        properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: {} },
      },
    },
  },
  BotStatus: {
    type: 'object', required: ['id', 'running'],
    properties: { id: { type: 'string' }, running: { type: 'boolean' }, tenantId: { type: 'string' }, name: { type: 'string' }, meta: stringMap },
  },
  BotDetail: {
    allOf: [ref('BotStatus'), {
      type: 'object',
      properties: {
        connection: { type: 'string', enum: ['connecting', 'authenticating', 'ready', 'closed', 'unknown'] },
        config: { oneOf: [ref('BotConfig'), { type: 'null' }] },
      },
    }],
  },
  BotConfig: {
    type: 'object', required: ['id', 'tenantId', 'desiredState', 'version', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' }, tenantId: { type: 'string' }, name: { type: 'string' }, provider: ref('ProviderConfig'),
      flows: arrayOf(ref('FlowDocument')), meta: stringMap, desiredState: { enum: ['running', 'stopped'] },
      version: { type: 'integer' }, createdAt: { type: 'integer' }, updatedAt: { type: 'integer' },
    },
  },
  ProviderConfig: {
    type: 'object', required: ['type'], additionalProperties: false,
    properties: { type: { type: 'string', minLength: 1 }, options: stringMap },
    description: 'Opaque to the manager: interpreted by the BotFactory. Never put raw secrets here (they are persisted as is).',
  },
  CreateBotInput: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' },
      tenantId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' },
      name: { type: 'string', maxLength: 200 }, provider: ref('ProviderConfig'), flows: arrayOf(ref('FlowDocument')), meta: stringMap,
      autoStart: { type: 'boolean', default: true },
    },
  },
  UpdateBotInput: {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 200 }, provider: ref('ProviderConfig'), flows: arrayOf(ref('FlowDocument')), meta: stringMap,
      desiredState: { enum: ['running', 'stopped'] }, expectedVersion: { type: 'integer', description: 'Optimistic concurrency: 409 when the stored version differs.' },
    },
  },
  Connection: {
    type: 'object', required: ['state'],
    properties: {
      state: { enum: ['connecting', 'authenticating', 'ready', 'closed', 'unknown'] }, reason: { type: 'string' },
      authPayload: { type: 'string', description: 'QR string or pairing code while authenticating. Sensitive.' }, updatedAt: { type: 'integer' },
    },
  },
  SendInput: {
    type: 'object', required: ['chatId'], additionalProperties: false,
    properties: {
      chatId: { type: 'string', minLength: 1, maxLength: 256 },
      text: { type: 'string', minLength: 1, maxLength: 4096 },
      content: {
        type: 'object', required: ['kind'],
        description: 'OutboundContent subset: text, image, video, audio, voice, document, sticker (media as { url: "https://…" } only), location, contact, poll.',
        properties: { kind: { enum: ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll'] } },
      },
    },
    oneOf: [{ required: ['text'] }, { required: ['content'] }],
  },
  TriggerInput: {
    type: 'object', required: ['flowId', 'chatId'], additionalProperties: false,
    properties: {
      flowId: { type: 'string' }, chatId: { type: 'string', minLength: 1, maxLength: 256 }, userId: { type: 'string', maxLength: 256 },
      isGroup: { type: 'boolean' }, state: { type: 'object', description: 'Seeded into c.state (max 16 KiB JSON).' },
    },
  },
  Conversation: {
    type: 'object', required: ['key', 'waiting', 'queued'],
    properties: {
      key: { type: 'string' }, state: stringMap, waiting: { type: 'boolean' }, queued: { type: 'integer' },
      // What the pending wait takes: 'text', 'any' or a list of message types (absent when not waiting).
      accepts: { oneOf: [{ type: 'string', enum: ['text', 'any'] }, { type: 'array', items: { type: 'string' } }] },
    },
  },
  Message: {
    type: 'object', required: ['id', 'chatId', 'timestamp', 'type'],
    properties: {
      id: { type: 'string' }, chatId: { type: 'string' }, senderId: { type: 'string' }, timestamp: { type: 'integer' }, type: { type: 'string' },
      body: { type: 'string' }, direction: { enum: ['inbound', 'outbound'] }, status: { type: 'string' }, fromMe: { type: 'boolean' },
    },
  },
  BotMetrics: {
    type: 'object',
    properties: {
      id: { type: 'string' }, running: { type: 'boolean' }, connection: { type: 'string' }, startedAt: { type: 'integer' }, uptimeMs: { type: 'integer' },
      messagesIn: { type: 'integer' }, errors: { type: 'integer' }, starts: { type: 'integer' }, restarts: { type: 'integer' },
      reconnectAttempts: { type: 'integer' }, activeConversations: { type: 'integer' }, flows: { type: 'integer' },
    },
  },
  ManagerMetrics: {
    type: 'object',
    properties: { bots: { type: 'integer' }, running: { type: 'integer' }, messagesIn: { type: 'integer' }, items: arrayOf(ref('BotMetrics')) },
  },
  FlowDocument: FLOW_DOCUMENT_SCHEMA as unknown as JsonSchema,
}
