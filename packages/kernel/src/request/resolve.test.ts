// Checking and normalizing a resolve request (04-contract `resolve`; 04-contract-types
// `ResolveParams`): what does not depend on the tenant's state.

import { describe, expect, it } from "vitest";
import { normalizeResolve } from "./resolve.ts";

const ID = `pi_${"7".repeat(16)}`;
const ok = (params: unknown) => {
  const r = normalizeResolve(params);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.request;
};
const refused = (params: unknown) => {
  const r = normalizeResolve(params);
  return r.ok ? undefined : r.error;
};

describe("normalizeResolve", () => {
  it("the item, the decision, the item version, the candidate, the note", () => {
    const r = ok({
      id: ID,
      decision: "take_candidate",
      item_ver: `iv_${"7".repeat(16)}.41.0`,
      candidate: 1,
      note: "the later one",
    });
    expect(r).toMatchObject({
      id: ID,
      decision: "take_candidate",
      itemVer: { op: 41, restoreCount: 0 },
      candidate: 1,
      note: "the later one",
      evidence: [],
    });
    // Without `task` and `idempotency_key`: the request's content for its key.
    expect(ok({ id: ID, decision: "keep_effective", task: "t" }).requestKey.content).toBe(
      ok({ id: ID, decision: "keep_effective" }).requestKey.content,
    );
    expect(ok({ id: ID, decision: "reject", idempotency_key: "k" }).requestKey).toMatchObject({
      idempotencyKey: "k",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    [
      "an unknown key",
      { id: ID, decision: "reject", why: 1 },
      { code: "invalid_argument", param: "why" },
    ],
    ["no id", { decision: "reject" }, { code: "invalid_argument", reason: "missing", param: "id" }],
    ["another kind of ID", { id: `r_${"1".repeat(26)}`, decision: "reject" }, { param: "id" }],
    ["an unknown decision", { id: ID, decision: "maybe" }, { param: "decision" }],
    [
      "another item's version",
      { id: ID, decision: "reject", item_ver: `iv_${"8".repeat(16)}.41.0` },
      { reason: "malformed", param: "item_ver" },
    ],
    [
      "a candidate with another decision",
      { id: ID, decision: "keep_effective", candidate: 0 },
      { reason: "malformed", param: "candidate" },
    ],
    [
      "a negative candidate",
      { id: ID, decision: "take_candidate", candidate: -1 },
      { reason: "malformed", param: "candidate" },
    ],
    ["an empty note", { id: ID, decision: "reject", note: "" }, { param: "note" }],
    [
      "a note too large",
      { id: ID, decision: "reject", note: "x".repeat(32 * 1024 + 1) },
      { code: "too_large", param: "note" },
    ],
  ])("refuses %s", (_, params, error) => {
    expect(refused(params)).toMatchObject(error);
  });

  it.each([
    ["a later decision", { id: ID, decision: "cancel" }, "decision"],
    [
      "evidence_by_field",
      { id: ID, decision: "confirm", evidence_by_field: {} },
      "evidence_by_field",
    ],
    ["diff_upto", { id: ID, decision: "confirm", diff_upto: 3 }, "diff_upto"],
  ])("%s: not in this version", (_, params, param) => {
    expect(refused(params)).toMatchObject({ code: "not_in_this_version", param });
  });
});
