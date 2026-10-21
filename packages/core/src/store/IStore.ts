/**
 * Storage interface — re-exported from the transport-agnostic contract in
 * `core/provider.ts`. This module keeps the historical `store/IStore.js` import
 * path stable. Implementations: MemoryStore (built-in), @botmesh/sqlite-store,
 * @botmesh/redis-store, etc.
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
export { messageKey, legacyMessageKey } from '../core/provider.js'
