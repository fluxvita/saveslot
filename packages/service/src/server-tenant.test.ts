// createServerTenant on either backend (02-architecture §5, §8): a tenant registered, its database
// made with its genesis, then active; a creation stopped at each point finished by calling it again;
// a cell the deployment does not have refused before anything is written, and a creation stopped in
// one cell not taken up in another; two creations for one owner giving one tenant. Fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import type { TenantEntry, TenantId } from "./control-plane.ts";
import {
  initControlPlane,
  openControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";
import {
  createServerTenant,
  creatingBusy,
  creationForTests,
  databaseOf,
  ServerTenantError,
} from "./server-tenant.ts";

const T = 120_000;
const NOW = "2026-11-20T10:00:00.000Z";
const CELL = "cell_a";
/** The cells of the deployment in these tests. */
const CELLS: ReadonlySet<string> = new Set([CELL, "cell_b"]);
const root = mkdtempSync(join(tmpdir(), "saveslot-server-tenant-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** The server mode's tenant storage in a test: a database of a cell is a directory of the test backend. */
const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
  },
};

let control: TenantStore;
let cp: ServerControlPlane;
beforeAll(async () => {
  control = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  cp = await initControlPlane(control);
}, T);
afterAll(async () => {
  await control?.close();
}, T);

let users = 0;
/** An owner no test has used. */
const owner = () => `u_${String(++users).padStart(26, "0")}` as const;

/** The genesis events in the tenant's storage. */
async function geneses(e: TenantEntry): Promise<number> {
  const s = await backend.open(e.ref, {});
  try {
    const r = await s.read((tx) =>
      tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM events WHERE type = 'tenant.genesis'",
      ),
    );
    return Number(r.rows[0]?.n);
  } finally {
    await s.close();
  }
}

/** A tenant registered as a creation stopped right after the control plane's row would leave it. */
async function registered(u: `u_${string}`, cell = CELL): Promise<TenantEntry> {
  const id = `tn_${String(users).padStart(26, "0")}` as TenantId;
  return cp.registerTenant({
    id,
    owner: u,
    ref: { kind: "postgres", cell, database: databaseOf(id) },
  });
}

describe("createServerTenant", () => {
  it(
    "registers the tenant, makes its database with the genesis, and activates it",
    async () => {
      const u = owner();
      const e = await createServerTenant({
        control: cp,
        backend,
        owner: u,
        cell: CELL,
        cells: CELLS,
        now: NOW,
      });
      expect(e).toMatchObject({ owner: u, state: "active", ref: { kind: "postgres", cell: CELL } });
      expect(e.ref).toEqual({ kind: "postgres", cell: CELL, database: databaseOf(e.id) });
      expect(await cp.tenantOf(u)).toEqual(e);
      expect(await geneses(e)).toBe(1);
    },
    T,
  );

  it(
    "gives an owner's active tenant as it is, without opening its storage",
    async () => {
      const u = owner();
      const e = await createServerTenant({
        control: cp,
        backend,
        owner: u,
        cell: CELL,
        cells: CELLS,
        now: NOW,
      });
      const refusing: StorageBackend = {
        open: () => Promise.reject(new Error("the storage must not be opened")),
      };
      expect(
        await createServerTenant({
          control: cp,
          backend: refusing,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        }),
      ).toEqual(e);
    },
    T,
  );

  describe("finishes a creation stopped", () => {
    it(
      "after the registration, before the database was made",
      async () => {
        const u = owner();
        const r = await registered(u);
        expect(r.state).toBe("creating");
        const e = await createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        });
        expect(e).toEqual({ ...r, state: "active" });
        expect(await geneses(e)).toBe(1);
      },
      T,
    );

    it(
      "after the database was made, before its genesis",
      async () => {
        const u = owner();
        const r = await registered(u);
        await (await backend.open(r.ref, { create: true })).close();
        const e = await createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        });
        expect(e).toEqual({ ...r, state: "active" });
        expect(await geneses(e)).toBe(1);
      },
      T,
    );

    it(
      "after the genesis, before the tenant was activated",
      async () => {
        const u = owner();
        const r = await registered(u);
        const s = await backend.open(r.ref, { create: true });
        try {
          await createTenant(
            s,
            createOpsContext({
              tenant: r.id,
              actor: u,
              trigger: null,
              task: null,
              visibility: { kind: "all" },
              idempotency_key_window: 0,
              idempotency_window: 0,
              now: NOW,
              confirmation: null,
            }),
          );
        } finally {
          await s.close();
        }
        expect((await cp.tenant(r.id))?.state).toBe("creating");
        const e = await createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        });
        expect(e).toEqual({ ...r, state: "active" });
        expect(await geneses(e)).toBe(1);
      },
      T,
    );
  });

  describe("refuses a cell", () => {
    it(
      "the deployment does not have, before anything is registered; the right one then creates",
      async () => {
        const u = owner();
        const typo = createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: "cell_typo",
          cells: CELLS,
          now: NOW,
        });
        await expect(typo).rejects.toThrow(ServerTenantError);
        await expect(typo).rejects.toMatchObject({ code: "unknown_cell" });
        expect(await cp.tenantOf(u)).toBeUndefined();
        const e = await createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        });
        expect(e).toMatchObject({ state: "active", ref: { cell: CELL } });
        expect(await geneses(e)).toBe(1);
      },
      T,
    );

    it(
      "other than the one a creation stopped in, rather than going on in either",
      async () => {
        const u = owner();
        const r = await registered(u, "cell_b");
        const other = createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: CELL,
          cells: CELLS,
          now: NOW,
        });
        await expect(other).rejects.toMatchObject({
          name: "ServerTenantError",
          code: "cell_mismatch",
        });
        expect(await cp.tenantOf(u)).toEqual(r);
        const e = await createServerTenant({
          control: cp,
          backend,
          owner: u,
          cell: "cell_b",
          cells: CELLS,
          now: NOW,
        });
        expect(e).toEqual({ ...r, state: "active" });
        expect(await geneses(e)).toBe(1);
      },
      T,
    );
  });

  it(
    "two creations for one owner at the same time give one tenant with one genesis",
    async () => {
      const u = owner();
      const [a, b] = await Promise.all([
        createServerTenant({ control: cp, backend, owner: u, cell: CELL, cells: CELLS, now: NOW }),
        createServerTenant({ control: cp, backend, owner: u, cell: CELL, cells: CELLS, now: NOW }),
      ]);
      expect(a).toEqual(b);
      expect(await geneses(a)).toBe(1);
    },
    T,
  );
});

// One creation at a time in a process, so that it holds one connection to a tenant's database
// being made (02-architecture §7 «连接», the connection budget).
describe("creations of different owners in one process", () => {
  /** The backend, its first open held until released. */
  function heldFirst() {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    let first = true;
    const b: StorageBackend = {
      open: async (ref, opts) => {
        if (first) {
          first = false;
          reached();
          await released;
        }
        return backend.open(ref, opts);
      },
    };
    return { backend: b, release, reached: reachedP };
  }
  const make = (b: StorageBackend, u: `u_${string}`) =>
    createServerTenant({ control: cp, backend: b, owner: u, cell: CELL, cells: CELLS, now: NOW });
  /** A few turns of the event loop: what is queued behind a pending step has run by then. */
  const turns = async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  };
  // No case here depends on how fast the machine is: a creation waits as long as it must (an hour),
  // except the one a case means to see refused, which waits on a creation held until released.
  const LONG = 3_600_000;

  it(
    "take turns: the second opens nothing until the first is done",
    async () => {
      creationForTests.waitMs = LONG;
      try {
        const h = heldFirst();
        const opened: string[] = [];
        const counting: StorageBackend = {
          open: (ref, opts) => {
            opened.push(ref.kind === "postgres" ? ref.database : "");
            return h.backend.open(ref, opts);
          },
        };
        const a = make(counting, owner());
        await h.reached;
        const b = make(counting, owner());
        await turns();
        expect(opened).toHaveLength(1);
        h.release();
        const [ea, eb] = await Promise.all([a, b]);
        expect([ea.state, eb.state]).toEqual(["active", "active"]);
        expect(opened).toEqual([databaseOf(ea.id), databaseOf(eb.id)]);
      } finally {
        creationForTests.waitMs = undefined;
      }
    },
    T,
  );

  it(
    "one waiting past its time: busy, nothing registered; the next one after goes on",
    async () => {
      creationForTests.waitMs = LONG;
      try {
        const h = heldFirst();
        const a = make(h.backend, owner());
        await h.reached;
        // a holds the turn until released: the late one is refused once its short wait is up,
        // whatever the load.
        const late = owner();
        creationForTests.waitMs = 50;
        const asked = make(h.backend, late);
        creationForTests.waitMs = LONG;
        const refused = await asked.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(refused).toBeInstanceOf(ServerTenantError);
        expect((refused as ServerTenantError).code).toBe("busy");
        expect(creatingBusy(refused)).toBe(true);
        expect(await cp.tenantOf(late)).toBeUndefined();
        h.release();
        await a;
        expect((await make(h.backend, late)).state).toBe("active");
      } finally {
        creationForTests.waitMs = undefined;
      }
    },
    T,
  );

  it("the PostgreSQL backend's maintenance_busy is a busy creation too; another error is not", () => {
    expect(creatingBusy({ code: "maintenance_busy" })).toBe(true);
    expect(creatingBusy(new ServerTenantError("unknown_cell", "m"))).toBe(false);
    expect(creatingBusy(new Error("m"))).toBe(false);
  });
});

describe.runIf(TEST_BACKEND === "postgres")("two processes creating one owner's tenant", () => {
  // Not in v1 (one process a deployment): both register the same tenant and open its database. No
  // opener takes the tenant from another (§7): both are given it.
  it(
    "at the same time both give that one tenant; called again, the one tenant, one database, one genesis",
    async () => {
      const dir = join(root, "control");
      const create = (control: ServerControlPlane, u: `u_${string}`) =>
        createServerTenant({ control, backend, owner: u, cell: CELL, cells: CELLS, now: NOW });
      for (let round = 0; round < 5; round++) {
        const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
        try {
          const [cpa, cpb] = await Promise.all([openControlPlane(a), openControlPlane(b)]);
          const u = owner();
          const results = await Promise.allSettled([create(cpa, u), create(cpb, u)]);
          const e = await create(cp, u);
          expect(e.state, `round ${round}`).toBe("active");
          for (const r of results) {
            expect(r.status === "fulfilled" ? r.value : r.reason, `round ${round}`).toEqual(e);
          }
          const rows = await control.read((tx) =>
            tx.query<{ id: string; database: string }>(
              "SELECT id, database FROM tenants WHERE owner = $1",
              [u],
            ),
          );
          expect(rows.rows, `round ${round}`).toEqual([{ id: e.id, database: databaseOf(e.id) }]);
          expect(await geneses(e), `round ${round}`).toBe(1);
        } finally {
          await a.close();
          await b.close();
        }
      }
    },
    T,
  );
});
