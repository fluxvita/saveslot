// The tenant-creation entry and the connection operations on PGlite, and K12 for what apply
// maintains so far (02-architecture §3 "日志是唯一事实来源", §11 «测试矩阵»): replaying the log
// into an empty storage gives the same materialized tables. Fictional IDs and names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvents,
  createOpsContext,
  createTenant,
  issueConnection,
  KERNEL_TABLES,
  listConnections,
  logVerify,
  OpsError,
  ReadError,
  type ReadTx,
  readEvents,
  readTail,
  renameConnection,
  revokeConnection,
  verifyLog,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER_USER = `u_${"7".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const T = 60_000;

const ctx = (actor: string, minute: number, extra: Record<string, unknown> = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 86_400_000,
    now: `2026-11-10T04:${String(minute).padStart(2, "0")}:00.000Z`,
    confirmation: null,
    ...extra,
  });

const roots: string[] = [];
const open = async (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `saveslot-${name}-`));
  roots.push(root);
  return testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OpsError || e instanceof ReadError) return { code: e.code, ...e.detail };
    throw e;
  }
  return "accepted";
};

const tail = (s: PgliteTenantStore) => s.read(async (tx) => (await readTail(tx))?.seq);

let store: PgliteTenantStore;
let desk: string;
let phone: string;

beforeAll(async () => {
  store = await open("principals");
}, T);

afterAll(async () => {
  await store?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

describe("createTenant", () => {
  it("appends the genesis event and registers the user and system", async () => {
    const r = await createTenant(store, ctx(USER, 0));
    expect(r.seq).toBe(1);
    expect(r.node_id).toMatch(/^n_[0-9A-HJKMNP-TV-Z]{26}$/);
    const rows = await store.read((tx) =>
      tx.query("SELECT id, kind, state, registered_seq FROM principals ORDER BY id"),
    );
    expect(rows.rows).toEqual([
      { id: "system", kind: "system", state: "active", registered_seq: 1 },
      { id: USER, kind: "user", state: "active", registered_seq: 1 },
    ]);
    const meta = await store.read((tx) =>
      tx.query("SELECT value FROM meta WHERE key = 'tenant_id'"),
    );
    expect(meta.rows).toEqual([{ value: TENANT }]);
  });

  it("refuses a storage whose log is not empty", async () => {
    expect(await refusal(createTenant(store, ctx(USER, 1)))).toEqual({ code: "internal" });
    expect(await tail(store)).toBe(1);
  });
});

describe("connections", () => {
  it("issues with the default scopes", async () => {
    const c = await issueConnection(store, ctx(USER, 2), { name: "desk", via: "token" });
    desk = c.id;
    expect(c).toEqual({
      id: desk,
      name: "desk",
      scopes: ["saveslot.read", "saveslot.write"],
      via: "token",
      state: "active",
      registered_seq: 2,
      created_at: "2026-11-10T04:02:00.000Z",
    });
  });

  it("normalizes scopes to unique, in enum order; records the OAuth client", async () => {
    const c = await issueConnection(store, ctx(USER, 3), {
      name: "phone",
      scopes: ["saveslot.delete", "saveslot.read", "saveslot.delete"],
      via: "oauth",
      client: "Claude iOS",
    });
    phone = c.id;
    expect(c).toMatchObject({ scopes: ["saveslot.read", "saveslot.delete"], client: "Claude iOS" });
    const evs = await store.read((tx) => readEvents(tx, 3, 3));
    expect(evs[0]?.blocks.get("principal")).toEqual({
      state: "present",
      value: {
        principal: phone,
        kind: "connection",
        scopes: ["saveslot.read", "saveslot.delete"],
        via: "oauth",
        client: "Claude iOS",
      },
    });
  });

  it.each([
    [
      "a name in use",
      { name: "desk", via: "token" },
      { code: "invalid_argument", reason: "duplicate_name", param: "name" },
    ],
    [
      "no read scope",
      { name: "w", scopes: ["saveslot.write"], via: "token" },
      { code: "invalid_argument", reason: "missing_read_scope", param: "scopes" },
    ],
    [
      "empty slots",
      { name: "w", slots: [], via: "token" },
      { code: "invalid_argument", reason: "empty_slots", param: "slots" },
    ],
    // Temporary: no slot event is applied yet, so the slots table is empty and every slot is
    // unknown. Once slots are applied, an existing visible slot is accepted.
    [
      "a slot (temporarily: no slot exists yet)",
      { name: "w", slots: [SLOT], via: "token" },
      {
        code: "not_found",
        reason: "slot",
        param: "slots",
      },
    ],
  ] as const)("refuses %s and appends nothing", async (_, params, expected) => {
    const before = await tail(store);
    expect(await refusal(issueConnection(store, ctx(USER, 4), params as never))).toEqual(expected);
    expect(await tail(store)).toBe(before);
  });

  it("is for user sessions only", async () => {
    const asConnection = issueConnection(store, ctx(desk, 4), { name: "x", via: "token" });
    expect(await refusal(asConnection)).toEqual({
      code: "insufficient_scope",
      required_scope: "user_session",
    });
    const unknownUser = issueConnection(store, ctx(OTHER_USER, 4), { name: "x", via: "token" });
    expect(await refusal(unknownUser)).toMatchObject({ code: "insufficient_scope" });
  });

  it("refuses a context for another tenant", async () => {
    const other = ctx(USER, 4, { tenant: `tn_${"9".repeat(26)}` });
    expect(await refusal(issueConnection(store, other, { name: "x", via: "token" }))).toEqual({
      code: "internal",
    });
  });

  it("renames; the same name again appends nothing; another's name is refused", async () => {
    expect(
      await renameConnection(store, ctx(USER, 5), { id: desk as never, name: "study" }),
    ).toMatchObject({ name: "study" });
    const before = await tail(store);
    await renameConnection(store, ctx(USER, 6), { id: desk as never, name: "study" });
    expect(await tail(store)).toBe(before);
    expect(
      await refusal(renameConnection(store, ctx(USER, 6), { id: desk as never, name: "phone" })),
    ).toEqual({ code: "invalid_argument", reason: "duplicate_name", param: "name" });
    // Names compare by code point, without case folding.
    expect(
      await renameConnection(store, ctx(USER, 6), { id: desk as never, name: "Phone" }),
    ).toMatchObject({ name: "Phone" });
  });

  it("revokes; revoking again appends nothing", async () => {
    expect(await revokeConnection(store, ctx(USER, 7), { id: phone as never })).toMatchObject({
      state: "revoked",
      revoked_at: "2026-11-10T04:07:00.000Z",
    });
    const before = await tail(store);
    expect(await revokeConnection(store, ctx(USER, 8), { id: phone as never })).toMatchObject({
      state: "revoked",
    });
    expect(await tail(store)).toBe(before);
  });

  it("a revoked connection keeps its name taken and can be renamed", async () => {
    expect(
      await refusal(issueConnection(store, ctx(USER, 9), { name: "phone", via: "token" })),
    ).toMatchObject({ reason: "duplicate_name" });
    expect(
      await renameConnection(store, ctx(USER, 9), { id: phone as never, name: "old phone" }),
    ).toMatchObject({ name: "old phone", state: "revoked" });
  });

  it("refuses an unknown connection and the user principal", async () => {
    for (const id of [`ci_${"5".repeat(26)}`, USER]) {
      expect(await refusal(revokeConnection(store, ctx(USER, 9), { id: id as never }))).toEqual({
        code: "not_found",
        reason: "connection",
        param: "id",
      });
    }
  });
});

describe("a connection's name", () => {
  it("is always a string; a connection row without one is an internal error, not a null name", async () => {
    // The connection issued above, its name cleared for this test only and put back after it.
    const name = (await listConnections(store, ctx(USER, 10))).connections.find(
      (x) => x.id === desk,
    )?.name;
    expect(typeof name).toBe("string");
    const setName = (n: string | null) =>
      store.write((tx) => tx.query("UPDATE principals SET name = $1 WHERE id = $2", [n, desk]));
    await setName(null);
    try {
      expect(await refusal(listConnections(store, ctx(USER, 10)))).toEqual({ code: "internal" });
    } finally {
      await setName(name as string);
    }
  });
});

describe("connections.list and log.verify (04-contract §17)", () => {
  it("lists the active connections in the order they were registered, without any token", async () => {
    const r = await listConnections(store, ctx(USER, 10));
    expect(r).toEqual({
      total: 1,
      connections: [
        expect.objectContaining({
          id: desk,
          name: "Phone",
          state: "active",
          created_at: "2026-11-10T04:02:00.000Z",
        }),
      ],
    });
    // Only the contract's fields: no token, no hash.
    const allowed = [
      "id",
      "name",
      "scopes",
      "slots",
      "via",
      "client",
      "state",
      "registered_seq",
      "created_at",
      "revoked_at",
    ];
    for (const c of r.connections)
      expect(Object.keys(c).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/slt_|"hash"/);
  });

  it("include_revoked: the revoked one too, with when it was revoked", async () => {
    const r = await listConnections(store, ctx(USER, 10), { include_revoked: true });
    expect(r.total).toBe(2);
    expect(r.connections.map((c) => [c.id, c.state, c.revoked_at])).toEqual([
      [desk, "active", undefined],
      [phone, "revoked", "2026-11-10T04:07:00.000Z"],
    ]);
  });

  it("pages by limit and position", async () => {
    const first = await listConnections(store, ctx(USER, 10), { include_revoked: true, limit: 1 });
    expect(first.connections.map((c) => c.id)).toEqual([desk]);
    expect(first.next_position).toEqual(expect.any(String));
    const second = await listConnections(store, ctx(USER, 10), {
      include_revoked: true,
      limit: 1,
      position: first.next_position as string,
    });
    expect(second.connections.map((c) => c.id)).toEqual([phone]);
    expect(second).not.toHaveProperty("next_position");
    // A position belongs to its parameters.
    expect(
      await refusal(
        listConnections(store, ctx(USER, 10), { position: first.next_position as string }),
      ),
    ).toMatchObject({ code: "invalid_argument", param: "position" });
  });

  it("refuses a wrong parameter", async () => {
    expect(
      await refusal(listConnections(store, ctx(USER, 10), { include_revoked: "yes" } as never)),
    ).toMatchObject({ code: "invalid_argument", param: "include_revoked" });
    expect(
      await refusal(listConnections(store, ctx(USER, 10), { all: true } as never)),
    ).toMatchObject({ code: "invalid_argument", param: "all" });
  });

  it("log.verify: the log is intact", async () => {
    expect(await logVerify(store, ctx(USER, 10))).toEqual({
      events: await tail(store),
      chain: { intact: true },
      checksum_mismatch: [],
      removed: 0,
      gaps: [],
      index_mismatch: [],
    });
  });

  it("both are for user sessions only: a connection instance is refused", async () => {
    for (const p of [listConnections(store, ctx(desk, 10)), logVerify(store, ctx(desk, 10))]) {
      expect(await refusal(p)).toEqual({
        code: "insufficient_scope",
        required_scope: "user_session",
      });
    }
  });
});

describe("connections.issue with an ID the caller chose", () => {
  it("takes the ID the caller chose; refuses one in use or of another form", async () => {
    const id = `ci_${"6".repeat(26)}`;
    expect(
      await issueConnection(store, ctx(USER, 9), { name: "chosen", via: "token", id: id as never }),
    ).toMatchObject({ id, name: "chosen" });
    for (const bad of [id, desk, `ci_${"6".repeat(25)}`, USER]) {
      expect(
        await refusal(
          issueConnection(store, ctx(USER, 9), { name: `x${bad}`, via: "token", id: bad as never }),
        ),
      ).toEqual({ code: "internal" });
    }
  });
});

// ---- K12 ---------------------------------------------------------------------------------------

/** Every row of every materialized table, in a fixed order. */
async function materialized(tx: ReadTx): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of KERNEL_TABLES.filter((t) => t.class === "materialized")) {
    const r = await tx.query(`SELECT * FROM ${t.name}`);
    out[t.name] = r.rows
      .map((row) => JSON.stringify(row, (_, v) => (typeof v === "bigint" ? String(v) : v)))
      .sort();
  }
  const meta = await tx.query("SELECT value FROM meta WHERE key = 'tenant_id'");
  out["meta.tenant_id"] = [...meta.rows];
  return out;
}

describe("K12: replaying the log from an empty storage gives the same state", () => {
  let replica: PgliteTenantStore;

  beforeAll(async () => {
    replica = await open("replica");
    // Copy the log as stored, then hand it to apply in order, in one transaction.
    const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
    const content = await store.read((tx) => tx.query("SELECT * FROM content ORDER BY seq, path"));
    await replica.write(async (tx) => {
      for (const e of events.rows) {
        const cols = Object.keys(e);
        await tx.query(
          `INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(e) as never,
        );
      }
      for (const c of content.rows) {
        const cols = Object.keys(c);
        await tx.query(
          `INSERT INTO content (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(c) as never,
        );
      }
      const last = (await readTail(tx))?.seq ?? 0;
      await applyEvents(tx, await readEvents(tx, 1, last));
    });
  }, T);

  afterAll(async () => {
    await replica?.close();
  }, 120_000);

  it("the replica's log is the same, intact log", async () => {
    expect(await tail(replica)).toBe(await tail(store));
    expect(await replica.read((tx) => verifyLog(tx))).toMatchObject({ chain: { intact: true } });
  });

  it("every materialized table and the current tenant ID are equal", async () => {
    const live = await store.read(materialized);
    // The user, system, and the three connections issued above.
    expect(live["principals"]).toHaveLength(5);
    expect(await replica.read(materialized)).toEqual(live);
  });

  it("a change that bypassed apply is found", async () => {
    await store.write((tx) => tx.query(`UPDATE principals SET name = 'x' WHERE id = '${desk}'`));
    expect(await replica.read(materialized)).not.toEqual(await store.read(materialized));
  });
});
