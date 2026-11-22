import { describe, expect, it } from "vitest";
import { CHECKED_SHAPES, type ParseResult, parseEvent } from "./parse.ts";

const ZERO = "0".repeat(64);
const HASH = "a".repeat(64);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const CONN = `ci_${"2".repeat(26)}`;
const NODE = `n_${"3".repeat(26)}`;
const SLOT_A = `sl_${"4".repeat(16)}`;
const SLOT_B = `sl_${"5".repeat(16)}`;
const AT = "2026-11-10T04:41:07.123Z";

const genesis = {
  header: {
    type: "tenant.genesis",
    v: 1,
    seq: 1,
    at: AT,
    prev_hash: ZERO,
    actor: USER,
    node_id: NODE,
  },
  blocks: {
    tenant: { tenant_id: TENANT, storage_format: 1, event_format: 1 },
    user: { principal: USER, kind: "user" },
    system: { principal: "system", kind: "system" },
  },
};

const OTHER_TENANT = `tn_${"9".repeat(26)}`;
const imported = {
  header: {
    type: "tenant.imported",
    v: 1,
    seq: 43,
    at: AT,
    prev_hash: HASH,
    actor: USER,
    node_id: NODE,
    restore_count: 1,
    imported_upto: 42,
  },
  blocks: {
    tenant: {
      tenant_id: TENANT,
      previous_tenant_id: OTHER_TENANT,
      storage_format: 1,
      event_format: 1,
    },
    user: { principal: USER, kind: "user" },
    export: { exported_at: AT, pending_deletions: "placeholder" },
  },
};

const head = (type: string, seq = 2) => ({
  type,
  v: 1,
  seq,
  at: AT,
  prev_hash: HASH,
  actor: USER,
});
const ctx = { now: AT, ruleset_version: 1 };

const registered = {
  header: head("principal.registered"),
  blocks: {
    ctx,
    principal: { principal: CONN, kind: "connection", scopes: ["saveslot.read"], via: "token" },
    name: { name: "laptop" },
  },
};
const renamed = {
  header: head("principal.renamed", 3),
  blocks: { ctx, principal: { principal: CONN }, name: { name: "desk" } },
};
const revoked = {
  header: head("principal.revoked", 4),
  blocks: { ctx, principal: { principal: CONN } },
};

const slotRemoved = {
  header: { ...head("slot.removed", 9), slot: SLOT_A },
  blocks: { ctx, target: { slot_id: SLOT_A, sv: 1 }, name: { name: "home" } },
};

type Sample = { header: Record<string, unknown>; blocks: Record<string, unknown> };
const parse = (s: Sample, removed: string[] = []): ParseResult =>
  parseEvent(s.header, s.blocks, removed);
const withHeader = (s: Sample, patch: Record<string, unknown>): Sample => ({
  ...s,
  header: { ...s.header, ...patch },
});
const withBlock = (s: Sample, path: string, value: unknown): Sample => ({
  ...s,
  blocks: { ...s.blocks, [path]: value },
});
const without = <T extends Record<string, unknown>>(o: T, key: string): Record<string, unknown> => {
  const { [key]: _, ...rest } = o;
  return rest;
};
const issues = (r: ParseResult): readonly string[] =>
  !r.ok && r.kind === "invalid" ? r.issues : [];

describe("parseEvent: valid events", () => {
  it.each([
    ["tenant.genesis", genesis],
    ["tenant.imported", imported],
    ["principal.registered", registered],
    ["principal.renamed", renamed],
    ["principal.revoked", revoked],
    ["slot.removed", slotRemoved],
  ] as const)("accepts %s", (type, s) => {
    expect(parse(s)).toEqual({ ok: true, type });
  });

  it("accepts optional slots and an oauth client", () => {
    const p = {
      principal: CONN,
      kind: "connection",
      scopes: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
      via: "oauth",
      client: "Claude Desktop",
      slots: [SLOT_A, SLOT_B],
    };
    expect(parse(withBlock(registered, "principal", p))).toEqual({
      ok: true,
      type: "principal.registered",
    });
  });

  it("counts a removed block as present and skips its shape", () => {
    const s = { ...registered, blocks: without(registered.blocks, "name") };
    expect(parse(s, ["name"])).toEqual({ ok: true, type: "principal.registered" });
  });

  it("checks the shapes of exactly these blocks so far", () => {
    expect([...CHECKED_SHAPES].sort()).toEqual(
      [
        "GenesisTenant",
        "ImportedExport",
        "ImportedTenant",
        "PrincipalCtx",
        "PrincipalName",
        "PrincipalRef",
        "RegisteredPrincipal",
        "SystemPrincipal",
        "UserPrincipal",
        // deletion events (parse-deletion.test.ts)
        "DeletionCancelledTarget",
        "DeletionConfirmedTarget",
        "DeletionExecutedTarget",
        "ItemIdList",
        "KeptEffective",
        "KeptSuperseded",
        "Positions",
        "Recreated",
        "Restated",
        "ResultExistence",
        "ResultField",
        "ResultTarget",
        "Summary",
        // slot policy and schema events (parse-schema.test.ts)
        "BackfillRows",
        "BackfillSegment",
        "Changes",
        "Compiled",
        "CompiledTarget",
        "ConfirmedTarget",
        "Draft",
        "DraftSubmittedTarget",
        "MigrationFailedTarget",
        "MigrationStartedTarget",
        "Policy",
        "RejectedTarget",
        "SchemaSupersededTarget",
        "SlotCtx",
        "SlotName",
        "SlotRemovedTarget",
        "SwitchedTable",
        "SwitchedTarget",
        // a write's events (parse-write.test.ts)
        "Ack",
        "Acknowledge",
        "Baseline",
        "Candidate",
        "Checksum",
        "Confirmation",
        "CurrentEntry",
        "DerivedKey",
        "DerivedTarget",
        "PreviousEntry",
        "ExistenceItem",
        "ExistenceSpan",
        "FieldEntry",
        "FieldIdList",
        "FieldItem",
        "Idempotency",
        "Impact",
        "ItemCreatedTarget",
        "ItemMergedTarget",
        "ItemRefreshedTarget",
        "ItemResolvedTarget",
        "ItemSupersededTarget",
        "Literal",
        "OpRevert",
        "OpTarget",
        "Premise",
        "PremiseCovers",
        "PremiseTarget",
        "PremiseValid",
        "PremisesCleared",
        "RawValue",
        "RequestKey",
        "ResolveCtx",
        "Revert",
        "ScopeValid",
        "SourceFile",
        "SourceRequest",
        "SourceSeqList",
        "SourceTarget",
        "SourceText",
        "Sources",
        "Span",
        "StatedAt",
        "Take",
        "Task",
        "ValidParam",
        "WriteBaseTarget",
        "WriteCtx",
        "WriteRequest",
      ].sort(),
    );
  });
});

describe("parseEvent: tenant.imported (§5.2)", () => {
  it.each([
    [
      "a tenant ID not of a tenant",
      "tenant",
      { ...imported.blocks.tenant, tenant_id: USER },
      "tenant: tenant_id",
    ],
    [
      "a previous tenant ID not of a tenant",
      "tenant",
      { ...imported.blocks.tenant, previous_tenant_id: "x" },
      "tenant: previous_tenant_id",
    ],
    [
      "another event format",
      "tenant",
      { ...imported.blocks.tenant, event_format: 2 },
      "tenant: event_format",
    ],
    [
      "an export time not an instant",
      "export",
      { ...imported.blocks.export, exported_at: "today" },
      "export: exported_at",
    ],
    [
      "another pending deletions mode",
      "export",
      { ...imported.blocks.export, pending_deletions: "some" },
      "export: pending_deletions",
    ],
  ] as const)("rejects %s", (_, path, value, issue) => {
    expect(issues(parse(withBlock(imported, path, value)))).toContain(issue);
  });

  it("rejects a restore count below 1, and a user other than the actor", () => {
    expect(issues(parse(withHeader(imported, { restore_count: 0 })))).toContain(
      "header: restore_count at least 1",
    );
    expect(
      issues(
        parse(withBlock(imported, "user", { principal: `u_${"2".repeat(26)}`, kind: "user" })),
      ),
    ).toContain("user: principal is the actor");
  });

  it("rejects a block with a key of its own, or without one it needs", () => {
    expect(parse(withBlock(imported, "export", { ...imported.blocks.export, x: 1 })).ok).toBe(
      false,
    );
    expect(
      parse(withBlock(imported, "tenant", without(imported.blocks.tenant, "previous_tenant_id")))
        .ok,
    ).toBe(false);
  });
});

describe("parseEvent: removed blocks (§1.1)", () => {
  it("rejects a removed metadata block", () => {
    const s = { ...revoked, blocks: without(revoked.blocks, "principal") };
    expect(issues(parse(s, ["principal"]))).toEqual(["principal: removed, but not a data block"]);
  });

  it("rejects a path both present and removed", () => {
    expect(issues(parse(renamed, ["name"]))).toEqual(["name: both present and removed"]);
  });

  it("still checks the shape of a present block that is also listed as removed", () => {
    const s = withBlock(renamed, "name", { name: 3 });
    expect(issues(parse(s, ["name"]))).toEqual(["name: both present and removed", "name: name"]);
  });
});

describe("parseEvent: slot.removed (§5.4)", () => {
  it.each([
    ["by a connection", withHeader(slotRemoved, { actor: CONN })],
    ["without a slot", { ...slotRemoved, header: without(slotRemoved.header, "slot") }],
    ["as a member", withHeader(slotRemoved, { op: 9 })],
    ["with a request key", withBlock(slotRemoved, "request_key", { key: "k" })],
    ["with a judging ctx", withBlock(slotRemoved, "ctx", { ...ctx, today: "2026-11-10" })],
    [
      "with a name in the target",
      withBlock(slotRemoved, "target", { slot_id: SLOT_A, sv: 1, name: "home" }),
    ],
    ["with a version 0", withBlock(slotRemoved, "target", { slot_id: SLOT_A, sv: 0 })],
    ["without the name", { ...slotRemoved, blocks: without(slotRemoved.blocks, "name") }],
  ] as const)("refuses one %s", (_, s) => {
    expect(issues(parse(s as Sample))).not.toEqual([]);
  });
});

describe("parseEvent: strict parsing (§1.6)", () => {
  // The four kinds of extension an older reader must refuse, not skip.
  it("rejects an unknown key inside a block", () => {
    const s = withBlock(renamed, "name", { name: "desk", color: "blue" });
    expect(issues(parse(s))).toEqual(["name: unknown key color"]);
  });

  it("rejects an unknown path", () => {
    const s = withBlock(revoked, "name", { name: "x" });
    expect(issues(parse(s))).toEqual(["name: not in the vocabulary of principal.revoked"]);
  });

  it("rejects an unknown removed path", () => {
    expect(issues(parse(revoked, ["reason"]))).toEqual([
      "reason: not in the vocabulary of principal.revoked",
    ]);
  });

  it("rejects an unknown format version", () => {
    expect(issues(parse(withHeader(revoked, { v: 2 })))).toEqual([
      "header.v: unknown format version",
    ]);
  });

  it("rejects an unknown event type", () => {
    expect(issues(parse(withHeader(revoked, { type: "principal.suspended" })))).toEqual([
      "header.type: unknown event type",
    ]);
  });

  it("rejects an unknown header field", () => {
    expect(issues(parse(withHeader(revoked, { flags: 1 })))).toEqual([
      "header: unknown field flags",
    ]);
  });

  it("rejects an unknown enum value", () => {
    const p = { ...registered.blocks.principal, scopes: ["saveslot.admin"] };
    expect(issues(parse(withBlock(registered, "principal", p)))).toEqual(["principal: scopes"]);
  });
});

describe("parseEvent: required and forbidden parts", () => {
  it("requires every always-present block", () => {
    const s = { ...revoked, blocks: without(revoked.blocks, "ctx") };
    expect(issues(parse(s))).toEqual(["ctx: required"]);
  });

  it("requires every key of a block", () => {
    const s = withBlock(genesis, "tenant", { tenant_id: TENANT, event_format: 1 });
    expect(issues(parse(s))).toEqual(["tenant: missing key storage_format"]);
  });

  it("rejects a block that is not an object", () => {
    expect(issues(parse(withBlock(renamed, "name", "desk")))).toEqual(["name: not an object"]);
  });

  it.each([
    ["tenant_id", { tenant_id: "tn_short" }, "tenant: tenant_id"],
    ["event_format", { event_format: 2 }, "tenant: event_format"],
    ["storage_format", { storage_format: "1" }, "tenant: storage_format"],
  ])("checks the genesis %s", (_, patch, issue) => {
    const s = withBlock(genesis, "tenant", { ...genesis.blocks.tenant, ...patch });
    expect(issues(parse(s))).toEqual([issue]);
  });

  it("checks the user and system principals of genesis", () => {
    const s = withBlock(withBlock(genesis, "user", { principal: CONN, kind: "user" }), "system", {
      principal: "system",
      kind: "user",
    });
    expect(issues(parse(s))).toEqual(["user: principal", "system: kind"]);
  });

  it("checks ctx", () => {
    const s = withBlock(revoked, "ctx", { now: "2026-11-10", ruleset_version: -1 });
    expect(issues(parse(s))).toEqual(["ctx: now", "ctx: ruleset_version"]);
  });

  it("rejects a policy_version or today in a principal ctx", () => {
    const s = withBlock(revoked, "ctx", { ...ctx, today: "2026-11-10" });
    expect(issues(parse(s))).toEqual(["ctx: unknown key today"]);
  });

  it.each([
    ["a user as the principal", { principal: USER }, "principal: principal"],
    ["no scopes", { scopes: [] }, "principal: scopes"],
    ["no read scope", { scopes: ["saveslot.write"] }, "principal: scopes"],
    ["repeated scopes", { scopes: ["saveslot.read", "saveslot.read"] }, "principal: scopes"],
    ["scopes out of order", { scopes: ["saveslot.write", "saveslot.read"] }, "principal: scopes"],
    ["another kind", { kind: "user" }, "principal: kind"],
    ["an unknown via", { via: "password" }, "principal: via"],
    ["empty slots", { slots: [] }, "principal: slots"],
    ["unsorted slots", { slots: [SLOT_B, SLOT_A] }, "principal: slots"],
    ["repeated slots", { slots: [SLOT_A, SLOT_A] }, "principal: slots"],
    ["a malformed slot", { slots: ["sl_1"] }, "principal: slots"],
    ["oauth without a client", { via: "oauth" }, "principal: client required with via oauth"],
    ["a client with token", { client: "x" }, "principal: client only with via oauth"],
  ])("rejects a registered principal with %s", (_, patch, issue) => {
    const p = { ...registered.blocks.principal, ...patch };
    expect(issues(parse(withBlock(registered, "principal", p)))).toEqual([issue]);
  });

  it("rejects a name that is not a string", () => {
    expect(issues(parse(withBlock(renamed, "name", { name: 3 })))).toEqual(["name: name"]);
  });
});

describe("parseEvent: header", () => {
  it("rejects a header that is not an object", () => {
    expect(issues(parseEvent([], {}))).toEqual(["header: not an object"]);
  });

  it.each([
    ["seq", { seq: 0 }, "header.seq: not a seq"],
    ["at", { at: "2026-11-10T04:41:07Z" }, "header.at: not an instant"],
    ["prev_hash", { prev_hash: "A".repeat(64) }, "header.prev_hash: not a hash"],
    ["actor", { actor: "root" }, "header.actor: not a principal"],
  ])("checks %s", (_, patch, issue) => {
    expect(issues(parse(withHeader(revoked, patch)))).toContain(issue);
  });

  it("rejects an actor the type does not allow", () => {
    expect(issues(parse(withHeader(renamed, { actor: CONN })))).toEqual([
      "header.actor: not allowed for this type",
    ]);
  });

  it("rejects op on a head event", () => {
    expect(issues(parse(withHeader(revoked, { op: 4 })))).toEqual(["header.op: on a head event"]);
  });

  it("requires op on a member event", () => {
    const s = { header: { ...head("slot.policy_set"), slot: SLOT_A }, blocks: {} };
    expect(issues(parse(s))).toContain("header.op: missing on a member event");
  });

  it("rejects trigger on a head event by a caller", () => {
    expect(issues(parse(withHeader(revoked, { trigger: "migration" })))).toEqual([
      "header.trigger: only on head events by system",
    ]);
  });

  it("rejects a slot where the type has none", () => {
    expect(issues(parse(withHeader(revoked, { slot: SLOT_A })))).toEqual([
      "header.slot: not allowed",
    ]);
  });

  it("requires node_id on genesis and forbids it elsewhere", () => {
    const g = { ...genesis, header: without(genesis.header, "node_id") };
    expect(issues(parse(g))).toEqual(["header.node_id: required"]);
    expect(issues(parse(withHeader(revoked, { node_id: NODE })))).toEqual([
      "header.node_id: not allowed",
    ]);
    expect(issues(parse(withHeader(genesis, { node_id: "n_1" })))).toEqual([
      "header.node_id: malformed",
    ]);
  });
});

describe("parseEvent: principal.revoked's three actors (§5.3)", () => {
  const OTHER = `ci_${"6".repeat(26)}`;

  it("by a user, by the connection itself, by system for a replayed refresh token", () => {
    expect(parse(revoked)).toEqual({ ok: true, type: "principal.revoked" });
    expect(parse(withHeader(revoked, { actor: CONN }))).toEqual({
      ok: true,
      type: "principal.revoked",
    });
    expect(
      parse(withHeader(revoked, { actor: "system", trigger: "oauth_refresh_replay" })),
    ).toEqual({ ok: true, type: "principal.revoked" });
  });

  it("a connection revoking another principal: refused", () => {
    expect(issues(parse(withHeader(revoked, { actor: OTHER })))).toEqual([
      "principal: a connection revokes no principal but itself",
    ]);
  });

  it("a user revokes any connection", () => {
    expect(parse(withBlock(revoked, "principal", { principal: OTHER }))).toEqual({
      ok: true,
      type: "principal.revoked",
    });
  });

  it.each([
    ["system without a trigger", { actor: "system" }, "header.trigger: missing or not allowed"],
    [
      "system with another trigger",
      { actor: "system", trigger: "restore" },
      "header.trigger: missing or not allowed",
    ],
    [
      "the connection with a trigger",
      { actor: CONN, trigger: "oauth_refresh_replay" },
      "header.trigger: only on head events by system",
    ],
    [
      "a user with a trigger",
      { trigger: "oauth_refresh_replay" },
      "header.trigger: only on head events by system",
    ],
  ])("%s: refused", (_, patch, issue) => {
    expect(issues(parse(withHeader(revoked, patch)))).toContain(issue);
  });

  it("the trigger is not taken on the other principal events", () => {
    expect(
      issues(parse(withHeader(renamed, { actor: "system", trigger: "oauth_refresh_replay" }))),
    ).toContain("header.actor: not allowed for this type");
  });
});

describe("parseEvent: shapes without a checker", () => {
  // `write.base` `duplicate` is not checked yet (similar keys, P2).
  const derived = {
    header: { ...head("write.base"), op: 25, slot: SLOT_A },
    blocks: {
      target: {
        table: "t1",
        row: `r_${"6".repeat(26)}`,
        intent: "insert",
        sv: 1,
        cause: "request",
        op_index: 0,
      },
      duplicate: {},
    },
  };

  it("reports a block whose shape has no checker as unsupported, not ok", () => {
    expect(parse(derived)).toEqual({
      ok: false,
      kind: "unsupported",
      shapes: ["Duplicate"],
    });
  });

  it("reports invalid before unsupported", () => {
    const s = { ...derived, header: { ...derived.header, v: 2 } };
    expect(parse(s)).toEqual({
      ok: false,
      kind: "invalid",
      issues: ["header.v: unknown format version"],
    });
  });
});
