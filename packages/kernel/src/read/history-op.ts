// `history`: the mode and the target, then `timeline`, `as_of` or `changes` (04-contract-types.md §4.5).

import { get, isObj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { changesInTx } from "./changes.ts";
import {
  asOfInTx,
  type HistoryInput,
  type HistoryOutput,
  historyMode,
  historyTarget,
} from "./history.ts";
import { timelineInTx } from "./timeline.ts";
import { type AsOfResult, type ChangesResult, invalid, type TimelineResult } from "./types.ts";

export async function historyInTx(
  tx: ReadTx,
  input: HistoryInput,
): Promise<HistoryOutput<TimelineResult | AsOfResult | ChangesResult>> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const table = get(params, "table");
  const mode = historyMode(params, typeof table === "string" ? table : "");
  if (mode === "changes")
    return changesInTx(tx, input, params, await historyTarget(tx, params, input.visibility, mode));
  const target = await historyTarget(tx, params, input.visibility);
  return mode === "as_of"
    ? asOfInTx(tx, input, params, target)
    : timelineInTx(tx, input, params, target);
}
