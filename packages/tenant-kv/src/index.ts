/**
 * @botmesh/tenant-kv — tenant-scoped JSON documents with compare-and-set over any
 * `DurableKv` backend of `@botmesh/core` (`MemoryKv`, `FileDurability`, SQLite,
 * PostgreSQL, Redis). The shared storage glue of the product packages
 * (`@botmesh/inbox`, `@botmesh/crm`, `@botmesh/campaigns`, `@botmesh/deployments`,
 * `@botmesh/hub`): table naming, JSON codec + validation, the compare-and-set retry
 * loop and bounded listings.
 *
 * Private infrastructure package: not published to npm.
 */

export { TenantDocs, DocTable, CorruptDocumentError, KvContentionError, PRODUCT_TABLE_PREFIX } from './docs.js'
export type { TenantDocsOptions, Versioned, DocListOptions } from './docs.js'
export { encodeSegment, assertTenantId, isTenantId } from './encode.js'
