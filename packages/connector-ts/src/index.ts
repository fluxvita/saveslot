// The TypeScript SDK for writing a saveslot connector. `ConnectorClient` is the one public entry;
// the developer implements `ConnectorProvider` and extends `SlotRecord`. The internal
// `SaveslotClient` is not exported.

export type * from "./client/api.ts";
export { MAX_RETRIES, MAX_WAIT_MS } from "./client/saveslot-client.ts";
export * from "./errors.ts";
export {
  CONNECTOR_PLATFORMS,
  type ConnectorManifest,
  ConnectorPlatform,
} from "./protocol/manifest.ts";
export { SlotRecord, type WriteResult } from "./record/slot-record.ts";
export type * from "./schema/definition.ts";
export { type ConnectorProvider, SchemaBuilder } from "./schema/schema-builder.ts";
export {
  ConnectorClient,
  type ConnectorClientBuilder,
  RECORDS_PER_WRITE,
  SDK_VERSION,
  type WriteCallOptions,
} from "./sdk/connector-client.ts";
