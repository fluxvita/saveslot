import type { JsonValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { type BlockState, buildOperation, type NewOperation } from "../log/index.ts";
import { ApplyError, type ApplyEvent, eventsOf, internalDetailOf, planEvent } from "./apply.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}` as const;
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const NOW = "2026-11-10T04:41:07.123Z" as NewOperation["now"];
const HASH = "a".repeat(64);
const ctx = { now: NOW, ruleset_version: 1 };

const genesis = eventsOf(
  buildOperation(undefined, {
    actor: USER,
    now: NOW,
    events: [
      {
        type: "tenant.genesis",
        node_id: `n_${"3".repeat(26)}`,
        blocks: {
          tenant: { tenant_id: TENANT, storage_format: 1, event_format: 1 },
          user: { principal: USER, kind: "user" },
          system: { principal: "system", kind: "system" },
        },
      },
    ],
  }),
)[0] as ApplyEvent;

const event = (
  type: string,
  blocks: Record<string, JsonValue>,
  removed: string[] = [],
  seq = 2,
): ApplyEvent => ({
  seq,
  header: { type, v: 1, seq, at: NOW, prev_hash: HASH, actor: USER },
  blocks: new Map<string, BlockState>([
    ...Object.entries(blocks).map(
      ([p, value]) => [p, { state: "present" as const, value }] as const,
    ),
    ...removed.map((p) => [p, { state: "removed" as const, by: 9 }] as const),
  ]),
});

const reason = (ev: ApplyEvent) => {
  try {
    planEvent(ev);
  } catch (e) {
    if (e instanceof ApplyError) return `${e.reason} @${e.seq}: ${e.message}`;
    throw e;
  }
  return "applied";
};

const base = { name: null, scopes: null, slots: null, via: null, client: null };

describe("planEvent", () => {
  it("genesis: the current tenant ID, the user and system principals", () => {
    expect(planEvent(genesis)).toEqual([
      { kind: "tenant_id", tenant_id: TENANT },
      {
        kind: "principal_insert",
        row: { ...base, id: USER, kind: "user", state: "active", registered_seq: 1 },
      },
      {
        kind: "principal_insert",
        row: { ...base, id: "system", kind: "system", state: "active", registered_seq: 1 },
      },
    ]);
  });

  it("principal.registered: a connection row; JSON columns as JCS text", () => {
    const ev = event("principal.registered", {
      ctx,
      principal: {
        principal: CONN,
        kind: "connection",
        scopes: ["saveslot.read", "saveslot.delete"],
        slots: [SLOT],
        via: "oauth",
        client: "Claude Desktop",
      },
      name: { name: "desk" },
    });
    expect(planEvent(ev)).toEqual([
      {
        kind: "principal_insert",
        row: {
          id: CONN,
          kind: "connection",
          name: "desk",
          scopes: '["saveslot.read","saveslot.delete"]',
          slots: `["${SLOT}"]`,
          via: "oauth",
          client: "Claude Desktop",
          state: "active",
          registered_seq: 2,
        },
      },
    ]);
  });

  it("principal.registered without slots means all slots", () => {
    const ev = event("principal.registered", {
      ctx,
      principal: { principal: CONN, kind: "connection", scopes: ["saveslot.read"], via: "token" },
      name: { name: "desk" },
    });
    expect(planEvent(ev)).toMatchObject([{ row: { slots: null, client: null } }]);
  });

  it("principal.renamed and principal.revoked", () => {
    const p = { principal: CONN };
    expect(
      planEvent(event("principal.renamed", { ctx, principal: p, name: { name: "x" } })),
    ).toEqual([{ kind: "principal_rename", id: CONN, name: "x" }]);
    expect(planEvent(event("principal.revoked", { ctx, principal: p }))).toEqual([
      { kind: "principal_revoke", id: CONN },
    ]);
  });

  it("a removed name block leaves the name empty", () => {
    const ev = event("principal.renamed", { ctx, principal: { principal: CONN } }, ["name"]);
    expect(planEvent(ev)).toEqual([{ kind: "principal_rename", id: CONN, name: null }]);
  });
});

describe("apply stops, never skips", () => {
  it("on an invalid event", () => {
    const ev = event("principal.revoked", { ctx, principal: { principal: CONN, extra: 1 } });
    expect(reason(ev)).toBe(
      "invalid @2: apply stopped at seq 2: invalid event: principal: unknown key extra",
    );
  });

  it("on a block shape it cannot check yet", () => {
    // `write.base` `duplicate` has no shape check yet (similar keys, P2).
    const ev = {
      ...event("write.base", {
        target: {
          table: "t1",
          row: `r_${"6".repeat(26)}`,
          intent: "insert",
          sv: 1,
          cause: "request",
          op_index: 0,
        },
        duplicate: {},
      }),
    };
    const header = { ...ev.header, actor: CONN, slot: SLOT, op: 2 };
    expect(reason({ ...ev, header })).toBe(
      "unsupported @2: apply stopped at seq 2: block shapes not supported yet: Duplicate",
    );
  });

  it("on a ruleset version the kernel does not know", () => {
    const ev = event("principal.revoked", {
      ctx: { now: NOW, ruleset_version: 2 },
      principal: { principal: CONN },
    });
    expect(reason(ev)).toBe(
      "unknown_version @2: apply stopped at seq 2: unknown ruleset_version 2",
    );
  });

  it("on a literal checker the kernel does not know (09 §1.6)", () => {
    const head = (checker: string) => {
      const ev = event("write.head", {
        ctx: {
          now: NOW,
          today: "2026-11-10",
          ruleset_version: 1,
          policy_version: 1,
          literal_checker: checker,
        },
        request: { sv: 1, sv_basis: "explicit", op_count: 1 },
      });
      return { ...ev, header: { ...ev.header, actor: CONN, slot: SLOT } };
    };
    expect(reason(head("literal@2"))).toBe(
      "unknown_version @2: apply stopped at seq 2: unknown literal_checker literal@2",
    );
    expect(reason(head("literal@1"))).toBe("applied");
  });

  it("on a type whose blocks it does not support yet (deletion)", () => {
    const ev = event(
      "deletion.executed",
      {
        target: { deletion: `pi_${"7".repeat(16)}`, confirmed_event: 2, reason: "expiry" },
        positions: [{ seq: 2, path: "request" }],
      },
      [],
      10,
    );
    const header = { ...ev.header, actor: "system", trigger: "deletion_expiry", slot: SLOT };
    expect(reason({ ...ev, header })).toBe(
      "unsupported @10: apply stopped at seq 10: block shapes not supported yet: DeletionExecutedTarget, Positions",
    );
  });

  it("a restore changes nothing in the materialized state (§5.2)", () => {
    const ev = event("tenant.restored", {}, [], 10);
    const header = {
      ...ev.header,
      actor: "system",
      trigger: "restore",
      node_id: `n_${"5".repeat(26)}`,
      restore_id: `rs_${"6".repeat(16)}`,
      restore_count: 1,
      restored_to: 8,
      high_water: 9,
    };
    expect(planEvent({ ...ev, header })).toEqual([]);
  });
});

describe("the internal error of a stop", () => {
  it("is not_implemented as such, any other stop inconsistent, apply's reason kept beside it", () => {
    // The two reasons the kernel gives `internal` (contract-core KERNEL_OUTER_ERROR_REASONS): the
    // service layer gives the first as not_in_this_version and the other as an incident only.
    const of = (r: ApplyError["reason"]) => internalDetailOf(new ApplyError(r, 7 as never, "x"));
    expect(of("not_implemented")).toEqual({
      reason: "not_implemented",
      apply_reason: "not_implemented",
      seq: 7,
    });
    for (const r of ["invalid", "unsupported", "unknown_version", "inconsistent"] as const) {
      expect(of(r)).toEqual({ reason: "inconsistent", apply_reason: r, seq: 7 });
    }
  });
});
