/**
 * The versioned JSON Schema of flow documents now lives in `@botmesh/flow-schema`.
 * Served by the REST API at `GET /v1/flows/schema`; this module keeps the path stable.
 */

export {
  FLOW_DOCUMENT_LIMITS,
  FLOW_DOCUMENT_SCHEMA,
  FLOW_DOCUMENT_SCHEMA_ID,
  FLOW_DOCUMENT_VERSION,
  FLOW_ID_PATTERN,
} from '@botmesh/flow-schema'
