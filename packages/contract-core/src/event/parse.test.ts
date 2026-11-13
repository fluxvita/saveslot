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
    ["principal.registered", registered],
    ["principal.renamed", renamed],
    ["principal.revoked", revoked],
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
    expect([...CHECKED_SHAPES].sort()).toEqual([
      "GenesisTenant",
      "PrincipalCtx",
      "PrincipalName",
      "PrincipalRef",
      "RegisteredPrincipal",
      "SystemPrincipal",
      "UserPrincipal",
    ]);
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
    expect(issues(parse(withHeader(revoked, { actor: CONN })))).toEqual([
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

describe("parseEvent: shapes without a checker", () => {
  it("reports a write as unsupported, not ok", () => {
    const s = {
      header: { ...head("write.head"), slot: SLOT_A },
      blocks: { ctx: {}, request: {} },
    };
    expect(parse(s)).toEqual({
      ok: false,
      kind: "unsupported",
      shapes: ["WriteCtx", "WriteRequest"],
    });
  });

  it("reports invalid before unsupported", () => {
    const s = {
      header: { ...head("write.head"), slot: SLOT_A, v: 2 },
      blocks: { ctx: {}, request: {} },
    };
    expect(parse(s)).toEqual({
      ok: false,
      kind: "invalid",
      issues: ["header.v: unknown format version"],
    });
  });
});
