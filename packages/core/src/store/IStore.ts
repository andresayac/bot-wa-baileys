/**
 * Storage interface — re-exported from the transport-agnostic contract in
 * `core/provider.ts`. This module keeps the historical `store/IStore.js` import
 * path stable. Implementations: MemoryStore (built-in), @bot-wa/sqlite-store,
 * @bot-wa/redis-store, etc.
 */

export type {
  IStore,
  StoredMessage,
  StoredChat,
  StoredContact,
  FlowCheckpoint,
  AIMessage,
  MessageRef,
} from '../core/provider.js'
export { messageKey } from '../core/provider.js'
