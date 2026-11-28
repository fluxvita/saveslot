// A tenant of the server mode created (docs/zh-CN/spec/02-architecture.md §5 «租户目录», §8 «租户存储»,
// §9): registered as `creating` in the control plane, its database made and its genesis written,
// then `active`. Each step looks at what is there first, so a creation stopped at any point is
// finished by calling it again; an owner with a tenant gets that tenant. The cell is checked against
// the deployment's before anything is registered, and a creation stopped in one cell is not taken up
// in another: the registration's cell and database cannot be changed afterwards. The control plane
// holds no storage backend: this flow does.
//
// Two creations for one owner in this process take turns: the second finds the first's tenant.
// Creations of different owners take turns too, one at a time in a process, so that a process
// holds at most one connection to a tenant's database being created (02-architecture §7 «连接»,
// the connection budget); one waiting longer than CREATION_WAIT_MS is refused with `busy`. Two
// processes meet at the owner's unique row: both get the same tenant, and both may have its storage
// open, their writes taking turns under the tenant's lock (§7); no opener takes it from another.

import {
  createOpsContext,
  createTenant,
  randomCrockford,
  readTail,
  type StorageBackend,
} from "@fluxvita/saveslot-kernel";
import type { ServerControl, TenantEntry, TenantId, UserId } from "./control-plane.ts";

/** A tenant's database: its ID in lower case (`tn_` and 26 characters, a name PostgreSQL takes). */
export const databaseOf = (tenant: TenantId): string => tenant.toLowerCase();

/**
 * Why a tenant was not created:
 * - `unknown_cell`: the cell asked for is not one of the deployment's; nothing was registered.
 * - `cell_mismatch`: the owner's tenant is still being created, registered in another cell.
 * - `busy`: another tenant was being created in this process for longer than CREATION_WAIT_MS;
 *   nothing was done for this one: try again shortly.
 */
export type ServerTenantErrorCode = "unknown_cell" | "cell_mismatch" | "busy";

/**
 * Whether a tenant's creation was refused for waiting past its turn: this process's creations
 * (`busy`), or the cell's maintenance database (the PostgreSQL backend's `maintenance_busy`, read
 * by its code: this package does not depend on that backend). Either is a retry in a moment.
 */
export function creatingBusy(e: unknown): boolean {
  if (e instanceof ServerTenantError) return e.code === "busy";
  return (e as { code?: unknown } | null)?.code === "maintenance_busy";
}

/** How long a creation waits for its turn among this process's creations. */
export const CREATION_WAIT_MS = 5_000;

/** Tests only: the wait, in place of CREATION_WAIT_MS. */
export const creationForTests = { waitMs: undefined as number | undefined };

let creating = false;
const creations: { go: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

/** Runs `fn` with this process's one turn at creating a tenant. */
async function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (creating || creations.length > 0) {
    await new Promise<void>((go, refuse) => {
      const waiter = {
        go,
        timer: setTimeout(() => {
          const i = creations.indexOf(waiter);
          if (i >= 0) creations.splice(i, 1);
          refuse(
            new ServerTenantError(
              "busy",
              "another tenant is being created in this process: try again shortly",
            ),
          );
        }, creationForTests.waitMs ?? CREATION_WAIT_MS),
      };
      creations.push(waiter);
    });
  } else {
    creating = true;
  }
  try {
    return await fn();
  } finally {
    const next = creations.shift();
    if (next === undefined) creating = false;
    else {
      clearTimeout(next.timer);
      next.go();
    }
  }
}

export class ServerTenantError extends Error {
  override readonly name = "ServerTenantError";
  readonly code: ServerTenantErrorCode;
  constructor(code: ServerTenantErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const inProgress = new WeakMap<ServerControl, Map<UserId, Promise<TenantEntry>>>();

export function createServerTenant(o: {
  readonly control: ServerControl;
  readonly backend: StorageBackend;
  readonly owner: UserId;
  /** The cell the tenant's database is made in; one of `cells`. */
  readonly cell: string;
  /** The cells this deployment has (its configuration's), the ones `backend` can open. */
  readonly cells: ReadonlySet<string>;
  readonly now: string;
}): Promise<TenantEntry> {
  let byOwner = inProgress.get(o.control);
  if (byOwner === undefined) {
    byOwner = new Map();
    inProgress.set(o.control, byOwner);
  }
  const running = byOwner.get(o.owner);
  if (running !== undefined) return running;
  const p = inTurn(() => create(o)).finally(() => byOwner.delete(o.owner));
  byOwner.set(o.owner, p);
  return p;
}

async function create(o: {
  readonly control: ServerControl;
  readonly backend: StorageBackend;
  readonly owner: UserId;
  readonly cell: string;
  readonly cells: ReadonlySet<string>;
  readonly now: string;
}): Promise<TenantEntry> {
  let entry = await o.control.tenantOf(o.owner);
  if (entry?.state === "active") return entry;
  if (!o.cells.has(o.cell)) {
    throw new ServerTenantError("unknown_cell", `the deployment has no cell named ${o.cell}`);
  }
  if (entry === undefined) {
    const id = `tn_${randomCrockford(26)}` as TenantId;
    entry = await o.control.registerTenant({
      id,
      owner: o.owner,
      ref: { kind: "postgres", cell: o.cell, database: databaseOf(id) },
    });
  }
  if (entry.state === "active") return entry;
  // Found, or registered by another process meanwhile: its cell is the one it stays in.
  if (entry.ref.kind === "postgres" && entry.ref.cell !== o.cell) {
    throw new ServerTenantError(
      "cell_mismatch",
      `the owner's tenant is being created in cell ${entry.ref.cell}, not ${o.cell}`,
    );
  }

  // Made if it is not there; the genesis written if the log is empty.
  const store = await o.backend.open(entry.ref, { create: true });
  try {
    if ((await store.read((tx) => readTail(tx))) === undefined) {
      await createTenant(
        store,
        createOpsContext({
          tenant: entry.id,
          actor: o.owner,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 0,
          idempotency_window: 0,
          now: o.now,
          confirmation: null,
        }),
      );
    }
  } finally {
    await store.close();
  }
  await o.control.activateTenant(entry.id);
  return { ...entry, state: "active" };
}
