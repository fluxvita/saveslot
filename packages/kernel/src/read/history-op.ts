// `history`: the mode and the target, then `timeline` or `as_of` (04-contract-types.md §4.5).

import { get, isObj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import {
  asOfInTx,
  type HistoryInput,
  type HistoryOutput,
  historyMode,
  historyTarget,
} from "./history.ts";
import { timelineInTx } from "./timeline.ts";
import { type AsOfResult, invalid, type TimelineResult } from "./types.ts";

export async function historyInTx(
  tx: ReadTx,
  input: HistoryInput,
): Promise<HistoryOutput<TimelineResult | AsOfResult>> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const table = get(params, "table");
  const mode = historyMode(params, typeof table === "string" ? table : "");
  const target = await historyTarget(tx, params, input.visibility);
  return mode === "as_of"
    ? asOfInTx(tx, input, params, target)
    : timelineInTx(tx, input, params, target);
}
