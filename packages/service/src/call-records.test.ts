// A call's record (02-architecture §9 «调用记录»): its fields from how the call ended, a reason only
// from the contract's list, and the writer that never holds a call up: a bound on what waits,
// records dropped past it or when the output fails, the drops of a minute told once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallRecord, CallRecorder, callRecord, newCallId } from "./call-records.ts";
import { connectionSource, SESSION_SOURCE } from "./caller-source.ts";
import { ContractError } from "./contract-error.ts";

const base = {
  call: "call_0123456789abcdef0123456789abcdef",
  at: "2026-11-27T10:00:00.000Z",
  started: 100,
  now: 112.4,
  tenant: "tn_00000000000000000000000001",
  actor: "u_00000000000000000000000001",
  source: SESSION_SOURCE,
  surface: "http" as const,
  operation: "write",
  route: "writes",
};

describe("a call record", () => {
  it("a write that appended: the effect, status, operation and restore count", () => {
    expect(
      callRecord({
        ...base,
        end: {
          ok: true,
          effect: { effect: "appended", seq: 42, restores: 1, status: "saved" },
        },
      }),
    ).toEqual({
      record: "call",
      v: 1,
      call: base.call,
      at: base.at,
      ms: 12,
      tenant: base.tenant,
      actor: base.actor,
      via: "session",
      surface: "http",
      operation: "write",
      route: "writes",
      outcome: "ok",
      effect: "appended",
      status: "saved",
      seq: 42,
      restores: 1,
    });
  });

  it("nothing appended: effect none, no operation; a read: no effect at all", () => {
    expect(callRecord({ ...base, end: { ok: true, effect: { effect: "none" } } })).toMatchObject({
      outcome: "ok",
      effect: "none",
    });
    const read = callRecord({ ...base, operation: "query", route: "query", end: { ok: true } });
    expect(Object.keys(read)).not.toContain("effect");
    expect(Object.keys(read)).not.toContain("seq");
  });

  it("an error: its code; its reason only when the contract lists it for that code; internal with its incident", () => {
    const err = (code: string, detail: Record<string, unknown>) =>
      callRecord({
        ...base,
        end: { ok: false, error: new ContractError(code as never, "m", detail) },
      });
    expect(err("read_first", { reason: "no_read", param: "since" })).toMatchObject({
      outcome: "read_first",
      reason: "no_read",
    });
    // A reason not among the code's (a caller's text, a field name) is left out.
    const odd = err("invalid_argument", { reason: "MARKER_not_a_reason", param: "MARKER_field" });
    expect(odd.outcome).toBe("invalid_argument");
    expect(JSON.stringify(odd)).not.toContain("MARKER");
    const internal = err("internal", { incident: "inc_0011223344556677" });
    expect(internal).toMatchObject({ outcome: "internal", incident: "inc_0011223344556677" });
    // An incident only with internal.
    expect(Object.keys(err("conflict", { incident: "inc_x" }))).not.toContain("incident");
  });

  it("a streamed call: complete, true or false", () => {
    expect(callRecord({ ...base, end: { ok: true, complete: false } }).complete).toBe(false);
  });

  it("a connection's source: token, or an authorization with its client document's origin only", () => {
    expect(connectionSource("token", null)).toEqual({ via: "token" });
    expect(
      connectionSource("oauth", "https://agent.example.org/clients/MARKER_path/client.json"),
    ).toEqual({ via: "oauth", registration: "document", client: "https://agent.example.org" });
    const r = callRecord({
      ...base,
      source: connectionSource("oauth", "https://agent.example.org/MARKER_path"),
      end: { ok: true },
    });
    expect(JSON.stringify(r)).not.toContain("MARKER");
  });

  it("call IDs: call_ and 32 hex characters, new each time", () => {
    const a = newCallId();
    expect(a).toMatch(/^call_[0-9a-f]{32}$/);
    expect(newCallId()).not.toBe(a);
  });
});

describe("the call record writer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const rec = callRecord({ ...base, end: { ok: true } }) as CallRecord;

  it("an output that does not read: at most the bound waits; past it records are dropped, told once a minute", async () => {
    const lines: string[] = [];
    const warned: [string, Record<string, string>][] = [];
    // Never resolved: the collector has stopped reading.
    const w = new CallRecorder({
      sink: (line) => {
        lines.push(line);
        return new Promise(() => {});
      },
      warn: (e, f) => warned.push([e, { ...f }]),
      max: 3,
    });
    for (let i = 0; i < 10; i++) w.write(rec);
    expect(lines).toHaveLength(3);
    expect(w.pending).toBe(3);
    expect(warned).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warned).toEqual([["call_record_failed", { dropped: "7" }]]);
    for (let i = 0; i < 2; i++) w.write(rec);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warned).toEqual([
      ["call_record_failed", { dropped: "7" }],
      ["call_record_failed", { dropped: "2" }],
    ]);
  });

  it("an output that fails: the record dropped and counted, the call not told", async () => {
    const warned: string[] = [];
    const w = new CallRecorder({
      sink: () => Promise.reject(new Error("EPIPE")),
      warn: (e, f) => warned.push(`${e} ${f["dropped"]}`),
    });
    w.write(rec);
    w.write(rec);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.pending).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warned).toEqual(["call_record_failed 2"]);
  });

  it("written: one line of JSON a record, nothing waiting after", async () => {
    const lines: string[] = [];
    const w = new CallRecorder({
      sink: async (line) => {
        lines.push(line);
      },
      warn: () => {},
    });
    w.write(rec);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([rec]);
    expect(w.pending).toBe(0);
  });
});
