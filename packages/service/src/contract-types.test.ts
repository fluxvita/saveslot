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
  history,
  logVerify,
  pending,
  query,
  readsList,
  resolve,
  schemaDraft,
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

/** A `zoned_datetime` value as the log and the kernel hold it (09-event-format §1.3). */
type ZonedObject = { readonly instant: string; readonly zone: string };

/** As `Mutable`, with a `zoned_datetime` value as the contract writes it, a string. */
type Zoned<T> = T extends ZonedObject
  ? string
  : T extends object
    ? Each<{ -readonly [K in keyof T]: Zoned<T[K]> }>
    : T;

/** What the service gives for a kernel call: its result, `next_position` signed into `next_cursor`. */
type Out<F extends (...a: never[]) => unknown> =
  Awaited<ReturnType<F>> extends infer T
    ? T extends unknown
      ? Omit<T, "next_position"> &
          ("next_position" extends keyof T ? { next_cursor?: C.Cursor } : unknown)
      : never
    : never;

/** `A` assignable to `B`. */
const fits = <B>(_: B) => true;
const as = <A>() => undefined as unknown as A;

/**
 * The write receipt as the contract writes it, with two differences the third request settles
 * left open on demand (`write/receipt.ts`): `W`, the candidate and awaiting fields the kernel gives
 * only when it has them; `V`, a state table's part without its interval (a `noop` part, a part with
 * no span). Each assertion below opens what it is not about, so a marker covers one difference.
 */
type Partly<T, K extends PropertyKey> = Omit<T, K> & Partial<Pick<T, Extract<keyof T, K>>>;
type FieldResultW<W extends boolean> = W extends false
  ? C.FieldResult
  : C.FieldResult extends infer F
    ? F extends { result: "candidate" }
      ? Partly<F, "item" | "effective" | "current_ver" | "by" | "previous">
      : F extends { result: "awaiting" }
        ? Partly<F, "item" | "impact">
        : F
    : never;
type OpWV<W extends boolean, V extends boolean> = Omit<C.OpResult, "fields"> & {
  fields?: Record<
    string,
    | FieldResultW<W>
    | (FieldResultW<W> & (V extends false ? { valid: C.Interval } : { valid?: C.Interval }))[]
  >;
};
type WriteWV<W extends boolean, V extends boolean> = Omit<C.WriteResult, "ops"> & {
  ops: OpWV<W, V>[];
};
type ResolveWV<W extends boolean, V extends boolean> = Omit<C.ResolveResult, "write"> & {
  write?: Omit<NonNullable<C.ResolveResult["write"]>, "ops"> & { ops: OpWV<W, V>[] };
};

export const checks = [
  fits<C.CatalogResult>(as<Mutable<Out<typeof catalog>>>()),
  fits<C.SchemaDraftResult>(as<Mutable<Out<typeof schemaDraft>>>()),
  fits<C.ReadsListResult>(as<Mutable<Out<typeof readsList>>>()),
  fits<C.LogVerifyResult>(as<Mutable<Out<typeof logVerify>>>()),
  fits<C.Connection>(as<Mutable<ReturnType<typeof connectionOut>>>()),

  // With a zoned_datetime value written as the contract writes it.
  fits<C.QueryResult>(as<Zoned<Out<typeof query>>>()),
  fits<C.HistoryResult>(as<Zoned<Out<typeof history>>>()),
  fits<WriteWV<true, true>>(as<Zoned<Out<typeof write>>>()),
  fits<ResolveWV<true, true>>(as<Zoned<Out<typeof resolve>>>()),

  // The second request: zoned_datetime values out as RFC 9557 strings.
  // @ts-expect-error a zoned_datetime value is an object, not the contract's string
  fits<C.QueryResult>(as<Mutable<Out<typeof query>>>()),
  // @ts-expect-error a zoned_datetime value is an object, not the contract's string
  fits<C.HistoryResult>(as<Mutable<Out<typeof history>>>()),
  // @ts-expect-error a zoned_datetime value is an object, not the contract's string
  fits<WriteWV<true, true>>(as<Mutable<Out<typeof write>>>()),
  // @ts-expect-error a zoned_datetime value is an object, not the contract's string
  fits<ResolveWV<true, true>>(as<Mutable<Out<typeof resolve>>>()),

  // The third request: the receipt's candidate and awaiting fields given only when present.
  // @ts-expect-error candidate and awaiting fields the contract requires are optional
  fits<WriteWV<false, true>>(as<Zoned<Out<typeof write>>>()),
  // @ts-expect-error candidate and awaiting fields the contract requires are optional
  fits<ResolveWV<false, true>>(as<Zoned<Out<typeof resolve>>>()),
  // The third request: a state table's part given without its interval (a noop part).
  // @ts-expect-error a state table's part may have no interval
  fits<WriteWV<true, false>>(as<Zoned<Out<typeof write>>>()),
  // @ts-expect-error a state table's part may have no interval
  fits<ResolveWV<true, false>>(as<Zoned<Out<typeof resolve>>>()),
  // The third request: pending's result has no type of its own yet.
  // @ts-expect-error pending's result is a record of unknowns
  fits<C.PendingResult>(as<Zoned<Out<typeof pending>>>()),

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
