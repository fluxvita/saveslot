// Calls against a real tenant, as a surface makes them (02-architecture §5 «权限», «句柄»;
// 04-contract §12–§16): a credential's principal, a kernel call, the operation run, its result in
// the contract's shape or its contract error. Paging handles: a cursor pages on; the same cursor
// on another query is refused; a forged one is refused; an expired one is `handle_expired`.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate,
  ContractError,
  Credentials,
  CursorKeys,
  closeLocalTenant,
  flushLocalReads,
  initLocalHome,
  kernelCall,
  type LocalTenant,
  type Operation,
  openLocalTenant,
  type Principal,
  runOperation,
  sessionFile,
} from "@fluxvita/saveslot-service";
import { recordTestRead } from "@fluxvita/saveslot-service/testing";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-calls-"));
const home = join(root, "home");
const NOW = "2026-11-16T12:00:00.000Z";
let t: LocalTenant;
let credentials: Credentials;
let cursors: CursorKeys;
let user: Principal;
const warnings: string[] = [];

async function principal(token: string): Promise<Principal> {
  const p = await authenticate({ credentials, tenant: t, authorization: `Bearer ${token}` });
  if (!("kind" in p)) throw new Error(p.reason);
  return p;
}

/** Calls `operation` as `who`; the result, or the refusal as `{code, ...detail}`. */
async function call(
  who: Principal,
  operation: Operation,
  body: unknown,
  o: { now?: string; task?: string } = {},
): Promise<Record<string, unknown>> {
  try {
    const c = kernelCall({
      principal: who,
      tenant: t,
      operation,
      body,
      ...(o.task !== undefined ? { task: o.task } : {}),
      now: o.now ?? NOW,
      windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
      cursors,
    });
    return (await runOperation({
      tenant: t,
      credentials,
      cursors,
      operation,
      call: c,
      warn: (e) => warnings.push(e),
    })) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ContractError) return { refused: e.code, ...e.detail };
    throw e;
  }
}

beforeAll(async () => {
  await initLocalHome({ home, backend: testBackend(), lock: osFileLock, now: NOW });
  const r = await openLocalTenant({ home, backend: testBackend() });
  if (!r.ok) throw new Error(r.failure);
  t = r.tenant;
  credentials = await Credentials.load(home);
  cursors = await CursorKeys.open(home);
  user = await principal(readFileSync(sessionFile(home), "utf8").trim());
  // Three reads in the audit, to page through.
  for (let i = 0; i < 3; i++) recordTestRead(t);
  await flushLocalReads(t);
}, T);
afterAll(async () => {
  await closeLocalTenant(t);
  rmSync(root, { recursive: true, force: true });
}, T);

describe("paging handles against the kernel's positions", () => {
  it("a cursor pages on; on another query it is refused; forged, refused; expired, handle_expired", async () => {
    const first = await call(user, "reads.list", { limit: 1 });
    expect((first["reads"] as unknown[]).length).toBe(1);
    expect(first).not.toHaveProperty("next_position");
    const cursor = first["next_cursor"] as string;
    expect(cursor).toMatch(/^cur_/);

    const second = await call(user, "reads.list", { limit: 1, cursor });
    expect((second["reads"] as unknown[]).length).toBe(1);
    expect(second["reads"]).not.toEqual(first["reads"]);

    // The same handle on another query: its position is bound to the first query's parameters.
    expect(
      await call(user, "reads.list", { limit: 1, cursor, since: "2026-01-01T00:00:00.000Z" }),
    ).toMatchObject({ refused: "invalid_argument", param: "cursor" });

    // Forged: a position of the kernel's own form, not signed by this service.
    const [, mac] = cursor.slice(4).split(".") as [string, string];
    const forged = `cur_${Buffer.from(JSON.stringify({ v: 1, k: "k0000000000000000", p: "x", x: "2099-01-01T00:00:00.000Z" })).toString("base64url")}.${mac}`;
    expect(await call(user, "reads.list", { limit: 1, cursor: forged })).toEqual({
      refused: "invalid_argument",
      reason: "malformed",
      param: "cursor",
    });

    // An hour later.
    expect(
      await call(user, "reads.list", { limit: 1, cursor }, { now: "2026-11-16T13:00:00.000Z" }),
    ).toEqual({ refused: "handle_expired", reason: "expired", param: "cursor" });
  });
});

describe("connections in the contract's shape, and who may call what", () => {
  it("issued: the contract's Connection with its token once; listed without it", async () => {
    const issued = await call(user, "connections.issue", {
      name: "desk",
      scopes: ["saveslot.read"],
    });
    expect(issued).toMatchObject({
      name: "desk",
      scopes: ["saveslot.read"],
      via: "token",
      created_at: NOW,
      token: expect.stringMatching(/^slt_/),
    });
    expect(issued).not.toHaveProperty("state");
    expect(issued).not.toHaveProperty("registered_seq");
    const listed = await call(user, "connections.list", {});
    expect(listed["connections"]).toEqual(
      [{ ...issued, token: undefined }].map(({ token: _, ...c }) => c),
    );
    expect(JSON.stringify(listed)).not.toContain(issued["token"] as string);

    // The connection: reads, but neither writes nor manages.
    const desk = await principal(issued["token"] as string);
    expect(await call(desk, "catalog", {})).not.toHaveProperty("refused");
    expect(await call(desk, "write", { ops: [] })).toEqual({
      refused: "insufficient_scope",
      required_scope: "saveslot.write",
    });
    expect(await call(desk, "connections.list", {})).toEqual({
      refused: "insufficient_scope",
      required_scope: "user_session",
    });

    // Revoked: the contract's state and time.
    const revoked = await call(user, "connections.revoke", { id: issued["id"] });
    expect(revoked).toMatchObject({ state: "revoked", revoked_at: NOW });
  });

  it("a slot named that does not exist: not_found; a parameter of another type: invalid_argument", async () => {
    expect(await call(user, "connections.issue", { name: "x", slots: ["health"] })).toEqual({
      refused: "not_found",
      reason: "slot",
      param: "slots",
    });
    expect(await call(user, "connections.update", { id: 1, name: "y" })).toMatchObject({
      refused: "invalid_argument",
      param: "id",
    });
  });

  it("log.verify for the user session", async () => {
    expect(await call(user, "log.verify", {})).toMatchObject({ chain: { intact: true } });
  });

  it("log.end for the user session: the newest event; a connection is refused; no parameters", async () => {
    const end = await call(user, "log.end", {});
    expect(end).toEqual({ seq: expect.any(Number), recorded_at: NOW });
    const issued = await call(user, "connections.issue", { name: "log-end reader" });
    const reader = await principal(issued["token"] as string);
    expect(await call(reader, "log.end", {})).toEqual({
      refused: "insufficient_scope",
      required_scope: "user_session",
    });
    expect(await call(user, "log.end", { since: 1 })).toMatchObject({
      refused: "invalid_argument",
    });
  });

  it("no path not implemented and no internal error was met", () => {
    expect(warnings).toEqual([]);
  });
});
