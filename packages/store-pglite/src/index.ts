// PGlite storage backend for the saveslot kernel (02-architecture §7, §8).
export {
  createPgdata,
  creation,
  PGDATA_DIR,
  PgliteBackend,
  type PgliteBackendOptions,
  PgliteTenantStore,
} from "./backend.ts";
export { type ErrorCode, PgliteStoreError } from "./errors.ts";
export { type DirLock, type DirLockHandle, LOCK_FILE, osFileLock } from "./lock.ts";
export { OWNER_FILE } from "./owner.ts";
export type { Durability, HostSyncStats } from "./protocol.ts";
