// What an operation did to its tenant's log, for the server mode's call records
// (docs/zh-CN/process/decisions/server-call-records.md; 02-architecture §9 «调用记录»): appended a
// head event (its operation number), replayed an earlier result (that operation's number), or
// appended nothing. Kept beside the operation's result, never in it: no contract result and no
// type outside the kernel carries it. `effectOf` reads it back from the result the operation
// returned, before the service turns that result into the contract's.

import type { ReadTx } from "../store/ports.ts";
import { restoreCount } from "../store/restore-point.ts";

export interface CallEffect {
  /** `appended`: a head event; `replayed`: an earlier result given again; `none`: nothing. */
  readonly effect: "appended" | "replayed" | "none";
  /** With `appended` and `replayed`: the operation's number in the tenant's log. */
  readonly seq?: number;
  /** With `seq`: the tenant's restore count, the operation numbers' epoch. */
  readonly restores?: number;
  /** A write's, and a resolve's triggered write's, status. */
  readonly status?: "saved" | "pending";
}

const effects = new WeakMap<object, CallEffect>();

/** Notes what the operation that returns `result` did; returns `result` as it is. */
export function noteEffect<T>(result: T, effect: CallEffect): T {
  if (typeof result === "object" && result !== null) effects.set(result, effect);
  return result;
}

/** What the operation that returned `result` did, if it noted it. */
export function effectOf(result: unknown): CallEffect | undefined {
  return typeof result === "object" && result !== null ? effects.get(result) : undefined;
}

const restores = new WeakMap<object, number>();

/**
 * The tenant's restore count, read once for a store and kept with it: it changes only by a restore
 * or an import, after which the tenant is opened again (a new store). So a call that notes its
 * effect reads it at most once in the store's life, not once a call.
 */
export async function restoresOf(store: object, tx: ReadTx): Promise<number> {
  const known = restores.get(store);
  if (known !== undefined) return known;
  const n = await restoreCount(tx);
  restores.set(store, n);
  return n;
}

/** Forgets a store's restore count: a restore or an import just appended its event on it. */
export function forgetRestores(store: object): void {
  restores.delete(store);
}
