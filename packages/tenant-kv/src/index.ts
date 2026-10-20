/**
 * @bot-wa/tenant-kv — tenant-scoped JSON documents with compare-and-set over any
 * `DurableKv` backend of `@bot-wa/core` (`MemoryKv`, `FileDurability`, SQLite,
 * PostgreSQL, Redis). The shared storage glue of the product packages
 * (`@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/campaigns`, `@bot-wa/deployments`,
 * `@bot-wa/hub`): table naming, JSON codec + validation, the compare-and-set retry
 * loop and bounded listings.
 *
 * Private infrastructure package: not published to npm.
 */

export { TenantDocs, DocTable, CorruptDocumentError, KvContentionError, PRODUCT_TABLE_PREFIX } from './docs.js'
export type { TenantDocsOptions, Versioned, DocListOptions } from './docs.js'
export { encodeSegment, assertTenantId, isTenantId } from './encode.js'
