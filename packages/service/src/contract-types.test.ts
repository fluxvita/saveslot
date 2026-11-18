// The service's results against the contract's types (04-contract-types §4–§9), checked by the
// compiler: each kernel operation's result, as the service gives it, must be assignable to the
// contract's type for that operation. `pnpm typecheck` checks this file (tsconfig.tests.json); the
// test below only makes it a test file. Whether an array is readonly is not part of the shape the
// contract gives, so each result is made mutable first.
//
// Known differences are marked with @ts-expect-error, each on one assertion of its own, so that a
// new difference elsewhere is not swallowed; once fixed, the marker itself fails and goes.

import type * as C from "@fluxvita/saveslot-contract";
import type {
  catalog,
  DecisionResolution,
  history,
  logEnd,
  logVerify,
  pending,
  query,
  readsList,
  resolve,
  schemaDraft,
  WriteValidationDetail,
  write,
} from "@fluxvita/saveslot-kernel";
import { describe, expect, it } from "vitest";
import type { ERROR_CODES } from "./contract-error.ts";
import type { connectionOut } from "./operations.ts";

/**
 * An object whose `result` is a union, as the union of one object per value: the same type, in
 * the form the contract writes a result (a union discriminated by `result`), which the compiler
 * does not split by itself.
 */
type Each<T> = T extends { readonly result: infer R }
  ? R extends unknown
    ? { [K in keyof T]: K extends "result" ? R : T[K] }
    : never
  : T;

/** `T` with every array, tuple and property mutable (a mapped type keeps a tuple a tuple). */
type Mutable<T> = T extends object ? Each<{ -readonly [K in keyof T]: Mutable<T[K]> }> : T;

/** What the service gives for a kernel call: its result, `next_position` signed into `next_cursor`. */
type Out<F extends (...a: never[]) => unknown> =
  Awaited<ReturnType<F>> extends infer T
    ? T extends unknown
      ? Omit<T, "next_position"> &
          ("next_position" extends keyof T ? { next_cursor?: C.Cursor } : unknown)
      : never
    : never;

/** The keys of `A` that `B` does not have: `never` when `A`'s are a subset of `B`'s. */
type ExtraKeys<A, B> = Exclude<keyof A, keyof B>;

/** `A` assignable to `B`. */
const fits = <B>(_: B) => true;
const as = <A>() => undefined as unknown as A;

export const checks = [
  fits<C.CatalogResult>(as<Mutable<Out<typeof catalog>>>()),
  fits<C.SchemaDraftResult>(as<Mutable<Out<typeof schemaDraft>>>()),
  fits<C.ReadsListResult>(as<Mutable<Out<typeof readsList>>>()),
  fits<C.LogVerifyResult>(as<Mutable<Out<typeof logVerify>>>()),
  // Null for an empty log: no paging handle to sign, so the kernel's result as it is.
  fits<C.LogEndResult>(as<Awaited<ReturnType<typeof logEnd>>>()),
  fits<C.Connection>(as<Mutable<ReturnType<typeof connectionOut>>>()),

  fits<C.QueryResult>(as<Mutable<Out<typeof query>>>()),
  fits<C.HistoryResult>(as<Mutable<Out<typeof history>>>()),
  fits<C.WriteResult>(as<Mutable<Out<typeof write>>>()),
  fits<C.ResolveResult>(as<Mutable<Out<typeof resolve>>>()),

  fits<C.PendingResult>(as<Mutable<Out<typeof pending>>>()),

  // How a decision closed an item, as the details and item_closed give it (note included), and
  // no key the contract does not have.
  fits<C.ItemResolution>(as<Mutable<DecisionResolution<C.Actor>>>()),
  fits<never>(
    as<ExtraKeys<DecisionResolution<C.Actor>, Extract<C.ItemResolution, { decision: unknown }>>>(),
  ),

  // A write's validation details, the judgement's `required_in_gap` among them; and no key the
  // contract does not have (an extra optional key is assignable, so it is checked on its own).
  fits<C.ValidationDetail>(as<Mutable<WriteValidationDetail>>()),
  fits<never>(as<ExtraKeys<WriteValidationDetail, C.ValidationDetail>>()),

  // Every code of the contract's is one the service can give.
  fits<(typeof ERROR_CODES)[number]>(as<C.ErrorCode>()),
  // The fourth request: one list of error codes, the contract's.
  // @ts-expect-error the service's list has two codes of later versions (referenced, lease_expired)
  fits<C.ErrorCode>(as<(typeof ERROR_CODES)[number]>()),
];

describe("the service's results against the contract's types", () => {
  it("are checked by the compiler (pnpm typecheck)", () => {
    expect(checks.every(Boolean)).toBe(true);
  });
});
