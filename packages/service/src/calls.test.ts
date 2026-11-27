// A surface's call made into a kernel call, without a tenant: permission by scope and session,
// where task and idempotency key may come from, paging handles signed and verified (forged,
// tampered, of another key, expired), and kernel errors as contract errors. Fictional IDs.
// The calls against a real tenant run in the daemon's tests.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadNotRecorded } from "@fluxvita/saveslot-kernel";
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "./auth.ts";
import { contractResult, kernelCall } from "./calls.ts";
import { ContractError, contractError } from "./contract-error.ts";
import { ControlFileError } from "./control-files.ts";
import { CursorKeys, CursorKeysCorrupt, cursorKeysFile } from "./cursor.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-calls-"));
// Removing the temporary directory can pass the default 10 s hook time under load.
afterAll(() => rm(root, { recursive: true, force: true }), 60_000);
let n = 0;
function home(): string {
  const h = join(root, String(n++));
  mkdirSync(join(h, "control"), { recursive: true, mode: 0o700 });
  return h;
}

const NOW = "2026-11-16T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const tenant = { tenant: `tn_${"8".repeat(26)}`, user: `u_${"1".repeat(26)}` } as never;
const user: Principal = {
  kind: "user",
  actor: `u_${"1".repeat(26)}`,
  scopes: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
  visibility: { kind: "all" },
};
const reader: Principal = {
  kind: "connection",
  actor: `ci_${"5".repeat(26)}`,
  scopes: ["saveslot.read"],
  visibility: { kind: "all" },
};
const windows = { requestKey: 600_000, idempotencyKey: 86_400_000 };
/** The principal handles are given to in the handle cases. */
const A = `ci_${"5".repeat(26)}`;

async function refused(f: () => unknown): Promise<Record<string, unknown>> {
  try {
    await f();
  } catch (e) {
    if (e instanceof ContractError) return { code: e.code, ...e.detail };
    throw e;
  }
  throw new Error("not refused");
}

/** Another base64url character with the same upper four bits (the last of 43 keeps only those). */
const sameBytesOtherSpelling = (c: string): string => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const i = ALPHABET.indexOf(c);
  return ALPHABET[(i & ~3) | ((i + 1) & 3)] as string;
};

describe("paging handles (cur_)", () => {
  it("round-trip: the position comes back from a handle this service signed", async () => {
    const keys = await CursorKeys.open(home());
    const c = keys.sign("POSITION", A, NOW);
    expect(c).toMatch(/^cur_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(keys.verify(c, A, later(59 * 60_000))).toBe("POSITION");
  });

  it("expired after an hour: handle_expired", async () => {
    const keys = await CursorKeys.open(home());
    const c = keys.sign("P", A, NOW);
    expect(await refused(() => keys.verify(c, A, later(60 * 60_000)))).toEqual({
      code: "handle_expired",
      reason: "expired",
      param: "cursor",
    });
  });

  it("forged or tampered: invalid_argument, malformed, before looking at the expiry", async () => {
    const h = home();
    const keys = await CursorKeys.open(h);
    const other = await CursorKeys.open(home());
    const c = keys.sign("P", A, NOW);
    const [payload, mac] = c.slice(4).split(".") as [string, string];
    const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const re = (x: unknown) => Buffer.from(JSON.stringify(x), "utf8").toString("base64url");
    const cases = [
      // Another position, the signature kept.
      `cur_${re({ ...o, p: "OTHER" })}.${mac}`,
      // A later expiry, the signature kept.
      `cur_${re({ ...o, x: later(10 * 60 * 60_000) })}.${mac}`,
      // Signed by another home's key.
      other.sign("P", A, NOW),
      // The signature altered (a character in the middle: every bit there counts).
      `cur_${payload}.${mac.slice(0, 20)}${mac[20] === "A" ? "B" : "A"}${mac.slice(21)}`,
      // The signature spelled another way that decodes to the same bytes (the last character's
      // spare bits): only the canonical spelling is taken.
      `cur_${payload}.${mac.slice(0, -1)}${sameBytesOtherSpelling(mac.at(-1) as string)}`,
      // Not of the form.
      "cur_",
      `cur_${payload}`,
      `cur_${payload}.${mac}x`,
      "P",
      42,
      null,
    ];
    for (const x of cases) {
      expect(await refused(() => keys.verify(x, A, NOW))).toEqual({
        code: "invalid_argument",
        reason: "malformed",
        param: "cursor",
      });
    }
    // Tampered and past its expiry: still malformed (the signature is checked first).
    expect(
      await refused(() =>
        keys.verify(`cur_${re({ ...o, p: "OTHER" })}.${mac}`, A, later(2 * 3_600_000)),
      ),
    ).toMatchObject({
      code: "invalid_argument",
    });
  });

  it("keys: made once, 0600 in a 0700 directory, read back; an old key still verifies", async () => {
    const h = home();
    const a = await CursorKeys.open(h);
    const c = a.sign("P", A, NOW);
    expect(statSync(cursorKeysFile(h)).mode & 0o777).toBe(0o600);
    expect(statSync(join(h, "control", "keys")).mode & 0o777).toBe(0o700);
    expect((await CursorKeys.open(h)).verify(c, A, NOW)).toBe("P");
    // A new current key: handles signed with the old one verify until they expire.
    const file = JSON.parse(readFileSync(cursorKeysFile(h), "utf8"));
    const fresh = { id: `k${"f".repeat(16)}`, secret: "e".repeat(64) };
    writeFileSync(
      cursorKeysFile(h),
      JSON.stringify({ format: 1, current: fresh.id, keys: [...file.keys, fresh] }),
      { mode: 0o600 },
    );
    const b = await CursorKeys.open(h);
    expect(b.verify(c, A, NOW)).toBe("P");
    expect(
      JSON.parse(
        Buffer.from(b.sign("Q", A, NOW).slice(4).split(".")[0] as string, "base64url").toString(),
      ).k,
    ).toBe(fresh.id);
  });

  it("given to one principal, refused to another, even on the same query", async () => {
    const keys = await CursorKeys.open(home());
    const c = keys.sign("P", A, NOW);
    expect(await refused(() => keys.verify(c, `ci_${"6".repeat(26)}`, NOW))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "cursor",
    });
  });

  it("rotating: the old key verifies its handles for the hour they live, then is deleted", async () => {
    const h = home();
    const old = await CursorKeys.open(h, NOW);
    const c = old.sign("P", A, NOW);
    const fresh = await CursorKeys.rotate(h, later(10 * 60_000));
    expect(fresh.keyIds()).toHaveLength(2);
    expect(fresh.verify(c, A, later(30 * 60_000))).toBe("P");
    // Signed with the new key from now on.
    const d = fresh.sign("Q", A, later(10 * 60_000));
    expect(d.slice(4).split(".")[0]).not.toBe(c.slice(4).split(".")[0]);
    // An hour after it was retired, the old key is gone from the file: at most the current key and
    // those retired in the last hour.
    const after = await CursorKeys.open(h, later(70 * 60_000 + 1));
    expect(after.keyIds()).toEqual(fresh.keyIds().slice(1));
    expect(JSON.parse(readFileSync(cursorKeysFile(h), "utf8")).keys).toHaveLength(1);
    expect(after.verify(d, A, later(65 * 60_000))).toBe("Q");
  });

  it("keys: refused when open to others or not of their form", async () => {
    const h = home();
    await CursorKeys.open(h);
    chmodSync(cursorKeysFile(h), 0o644);
    await expect(CursorKeys.open(h)).rejects.toBeInstanceOf(ControlFileError);
    chmodSync(cursorKeysFile(h), 0o600);
    for (const text of [
      "{",
      JSON.stringify({ format: 1, current: "k0", keys: [] }),
      JSON.stringify({
        format: 1,
        current: `k${"0".repeat(16)}`,
        keys: [{ id: `k${"1".repeat(16)}`, secret: "a".repeat(64) }],
      }),
      JSON.stringify({
        format: 1,
        current: `k${"0".repeat(16)}`,
        keys: [{ id: `k${"0".repeat(16)}`, secret: "short" }],
      }),
    ]) {
      writeFileSync(cursorKeysFile(h), text, { mode: 0o600 });
      await expect(CursorKeys.open(h)).rejects.toBeInstanceOf(CursorKeysCorrupt);
    }
  });
});

describe("kernelCall", () => {
  const call = async (over: Partial<Parameters<typeof kernelCall>[0]>) =>
    kernelCall({
      principal: user,
      tenant,
      operation: "query",
      body: {},
      now: NOW,
      windows,
      cursors: await CursorKeys.open(home()),
      ...over,
    });

  it("a scope the credential lacks, or a management operation for a connection: insufficient_scope", async () => {
    expect(await refused(() => call({ principal: reader, operation: "write" }))).toEqual({
      code: "insufficient_scope",
      required_scope: "saveslot.write",
    });
    expect(await refused(() => call({ principal: reader, operation: "connections.list" }))).toEqual(
      {
        code: "insufficient_scope",
        required_scope: "user_session",
      },
    );
    expect((await call({ principal: reader, operation: "query" })).ctx.actor).toBe(reader.actor);
  });

  it("task and idempotency key from the surface only; the kernel's checks see them in the parameters", async () => {
    const c = await call({
      operation: "write",
      body: { ops: [] },
      task: "weekly",
      idempotencyKey: "k1",
    });
    expect(c.params).toEqual({ ops: [], task: "weekly", idempotency_key: "k1" });
    for (const k of ["task", "idempotency_key", "position"]) {
      expect(await refused(() => call({ operation: "write", body: { [k]: "x" } }))).toMatchObject({
        code: "invalid_argument",
        param: k,
      });
    }
    expect(await refused(() => call({ operation: "query", idempotencyKey: "k" }))).toMatchObject({
      param: "idempotency_key",
    });
    expect(await refused(() => call({ operation: "log.verify", task: "t" }))).toMatchObject({
      param: "task",
    });
    expect(
      await refused(() => call({ operation: "catalog", body: { cursor: "x" } })),
    ).toMatchObject({
      param: "cursor",
    });
    expect(await refused(() => call({ body: [] }))).toMatchObject({ code: "invalid_argument" });
  });

  it("a cursor is verified and given to the kernel as its position; a next position goes back signed", async () => {
    const keys = await CursorKeys.open(home());
    const c = kernelCall({
      principal: user,
      tenant,
      operation: "query",
      body: { table: "t", cursor: keys.sign("POS", user.actor, NOW) },
      now: NOW,
      windows,
      cursors: keys,
    });
    expect(c.params).toEqual({ table: "t", position: "POS" });
    const out = contractResult(
      { rows: [], next_position: "NEXT" },
      keys,
      user.actor,
      NOW,
    ) as Record<string, unknown>;
    expect(out).not.toHaveProperty("next_position");
    expect(keys.verify(out["next_cursor"], user.actor, NOW)).toBe("NEXT");
  });
});

describe("contractError", () => {
  class WriteError extends Error {
    override readonly name = "WriteError";
    readonly code: string;
    readonly detail: Record<string, unknown>;
    constructor(
      code: string,
      message: string,
      detail: Record<string, unknown> = {},
      options?: { cause?: unknown },
    ) {
      super(message, options);
      this.code = code;
      this.detail = detail;
    }
  }
  const warnings: [string, Readonly<Record<string, string>>][] = [];
  const warn = (e: string, f: Readonly<Record<string, string>>) => warnings.push([e, f]);

  it("passes a kernel error's code and detail through; the page position is the caller's cursor", () => {
    expect(
      contractError(new WriteError("read_first", "m", { param: "ops/0/ver" }), warn),
    ).toMatchObject({
      code: "read_first",
      detail: { param: "ops/0/ver" },
    });
    expect(
      contractError(new WriteError("invalid_argument", "m", { param: "position" }), warn).detail,
    ).toEqual({
      param: "cursor",
    });
  });

  it("a read whose record could not be written: unavailable (busy), told by the cause's name and code only", () => {
    warnings.length = 0;
    const cause = Object.assign(new Error("disk full on db.example.internal"), {
      code: "io_failed",
    });
    const e = contractError(new ReadNotRecorded(cause), warn);
    expect([e.code, e.detail]).toEqual(["unavailable", { reason: "busy", retry_after: 1 }]);
    expect(e.message).not.toContain("example");
    expect(warnings).toEqual([["read_not_recorded", { cause: "Error", cause_code: "io_failed" }]]);
  });

  it("a read whose record met the connection gone, committed or not: unavailable (busy), told as the connection lost with its code", () => {
    warnings.length = 0;
    const gone = (code: string) =>
      Object.assign(new Error("connection to db.example.internal ended"), { code });
    for (const code of ["connection_lost", "commit_unknown"]) {
      const e = contractError(new ReadNotRecorded(gone(code)), warn, { tenant: "tn_x" });
      expect([code, e.code, e.detail]).toEqual([
        code,
        "unavailable",
        { reason: "busy", retry_after: 1 },
      ]);
    }
    expect(warnings).toEqual([
      ["tenant_connection_lost", { tenant: "tn_x", code: "connection_lost" }],
      ["tenant_connection_lost", { tenant: "tn_x", code: "commit_unknown" }],
    ]);
  });

  it("a tenant's connection gone under a use: certainly not committed is unavailable (busy); maybe committed stays internal", () => {
    warnings.length = 0;
    const gone = (code: string) =>
      Object.assign(new Error("connection to db.example.internal ended"), { code });
    const lost = contractError(gone("connection_lost"), warn, { tenant: "tn_x" });
    expect([lost.code, lost.detail]).toEqual(["unavailable", { reason: "busy", retry_after: 1 }]);
    expect(lost.message).not.toContain("example");
    // Raised over another: the same.
    const over = new Error("over", { cause: gone("connection_lost") });
    expect(contractError(over, warn).code).toBe("unavailable");
    const unknown = contractError(gone("commit_unknown"), warn, { tenant: "tn_x" });
    expect(unknown.code).toBe("internal");
    expect(warnings).toEqual([
      ["tenant_connection_lost", { tenant: "tn_x", code: "connection_lost" }],
      ["tenant_connection_lost", { code: "connection_lost" }],
      ["tenant_connection_lost", { tenant: "tn_x", code: "commit_unknown" }],
      ["internal", expect.objectContaining({ incident: unknown.detail["incident"] })],
    ]);
  });

  it("the tenant's storage newer than this server: unavailable (stopping) to retry elsewhere; sealed: importing", () => {
    warnings.length = 0;
    const store = (code: string) =>
      Object.assign(new Error("storage format 6 is newer than this version's 5"), { code });
    const newer = contractError(store("format_too_new"), warn, { tenant: "tn_x" });
    expect([newer.code, newer.detail]).toEqual([
      "unavailable",
      { reason: "stopping", retry_after: 1 },
    ]);
    expect(warnings).toEqual([["tenant_format_too_new", { tenant: "tn_x" }]]);
    const sealed = contractError(store("tenant_sealed"), warn);
    expect([sealed.code, sealed.detail]).toEqual(["unavailable", { reason: "importing" }]);
  });

  it("a read whose record was refused for a newer format: answered as the read would be (stopping), not busy", () => {
    warnings.length = 0;
    const newer = Object.assign(new Error("storage format 6 is newer than this version's 5"), {
      code: "format_too_new",
    });
    const e = contractError(new ReadNotRecorded(newer), warn, { tenant: "tn_x" });
    expect([e.code, e.detail]).toEqual(["unavailable", { reason: "stopping", retry_after: 1 }]);
    expect(warnings).toEqual([["tenant_format_too_new", { tenant: "tn_x" }]]);
  });

  it("a path not implemented yet: not_in_this_version, reason kept, reported by structure", () => {
    const e = contractError(
      new WriteError("internal", "writing a table a derived rule reads is not implemented", {
        reason: "not_implemented",
        param: "ops/0/table",
      }),
      warn,
    );
    expect([e.code, e.detail]).toEqual([
      "not_in_this_version",
      { reason: "not_implemented", param: "ops/0/table" },
    ]);
    expect(warnings.at(-1)).toEqual([
      "not_implemented",
      { error: "WriteError", param: "ops/0/table" },
    ]);
  });

  it("an internal error over another: the incident only, the other one logged by name and code", () => {
    const e = contractError(
      new WriteError(
        "internal",
        "the item's detail could not be read for the mismatch",
        { reason: "inconsistent" },
        { cause: new WriteError("not_found", "SECRET-MESSAGE", { reason: "item", param: "id" }) },
      ),
      warn,
    );
    expect(e.code).toBe("internal");
    expect(Object.keys(e.detail)).toEqual(["incident"]);
    expect(warnings.at(-1)).toEqual([
      "internal",
      {
        incident: e.detail["incident"],
        error: "WriteError",
        code: "internal",
        cause: "WriteError",
        cause_code: "not_found",
      },
    ]);
  });

  it("a path not implemented is reported by its structure only: names of the caller's are starred", () => {
    contractError(
      new WriteError("internal", "m", {
        reason: "not_implemented",
        param: "ops/0/set/secret_field",
      }),
      warn,
    );
    expect(warnings.at(-1)).toEqual([
      "not_implemented",
      { error: "WriteError", param: "ops/0/set/*" },
    ]);
  });

  it("an error of any kernel class with a contract code passes; a system error's code does not", () => {
    class SchemaDraftError extends Error {
      override readonly name = "SchemaDraftError";
      readonly code = "invalid_argument";
      readonly detail = { reason: "malformed", param: "document" };
    }
    expect(contractError(new SchemaDraftError("m"), warn)).toMatchObject({
      code: "invalid_argument",
      detail: { param: "document" },
    });
    const system = Object.assign(new Error("ENOENT: /secret/path"), { code: "ENOENT" });
    expect(contractError(system, warn)).toMatchObject({ code: "internal" });
  });

  it("any other internal error, or an error of no contract: internal with an incident, nothing of the cause", () => {
    for (const cause of [
      new WriteError("internal", "SECRET in a message", { reason: "inconsistent", seq: 3 }),
      new Error("SECRET thrown"),
      new WriteError("made_up_code", "SECRET"),
      "a string",
    ]) {
      const e = contractError(cause, warn);
      expect(e.code).toBe("internal");
      expect(Object.keys(e.detail)).toEqual(["incident"]);
      expect(JSON.stringify([e.message, e.detail])).not.toContain("SECRET");
      expect(JSON.stringify(warnings.at(-1))).not.toContain("SECRET");
    }
  });
});
