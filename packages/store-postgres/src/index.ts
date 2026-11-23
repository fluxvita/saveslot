// PostgreSQL storage backend for the saveslot kernel (02-architecture §7, §8).
export {
  BUILTIN_LOCALE,
  DATABASE_NAME,
  PostgresBackend,
  type PostgresBackendOptions,
  PostgresTenantStore,
  SERVER_MAJOR,
  WRITE_LOCK,
} from "./backend.ts";
export type { PostgresCell } from "./connection.ts";
export { type ControlDatabase, openControlDatabase } from "./control-database.ts";
export {
  checkDiscard,
  type DiscardRequest,
  discardDatabase,
  stagingDatabaseShape,
} from "./discard.ts";
export { type ErrorCode, PostgresStoreError } from "./errors.ts";
