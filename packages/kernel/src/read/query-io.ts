// The input and output of `query` (04-contract.md §10 `query`), apart from the code that reads base
// and derived tables, so that both can name them.

import type { Instant, PrincipalId } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadId } from "../audit/index.ts";
import type { Visibility } from "./slots.ts";
import type { QueryReadResult } from "./types.ts";

export interface QueryInput {
  readonly actor: PrincipalId;
  /** The context's task; the parameters' own `task` takes its place when given. */
  readonly task: string | null;
  readonly now: Instant;
  readonly visibility: Visibility;
  readonly params: unknown;
  /** The ID the read is recorded under. */
  readonly read: ReadId;
  /** Tests only: read the state after this operation, as a later page does. */
  readonly asOf?: number;
}

export interface QueryOutput {
  readonly result: QueryReadResult;
  /** The read to record. */
  readonly entry: ReadEntry;
}
