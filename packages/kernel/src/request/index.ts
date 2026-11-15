// Write requests: checking and normalizing before anything depends on the tenant's state
// (docs/zh-CN/spec/03-data-model/04-write-and-read.md «判定顺序» step 1).

// Shared with `read` (02-architecture §4: names, values and business time in query parameters by
// the same rules as in writes).
export {
  canonical,
  compare,
  divide,
  multiply,
  parseDecimal,
  type Rational,
  rationalOf,
} from "./decimal.ts";
export { echoName, echoPath, fold, type Named, nearest, splitTableName } from "./names.ts";
export {
  checkSvCompatibility,
  normalizeWrite,
  type ResolveWriteSlotResult,
  resolveWriteSlot,
  type SlotTables,
} from "./normalize.ts";
export { decimalText, isJsonNumber, JsonNumber, jsonNumber, keepNumberText } from "./number.ts";
export { get, has, isDenseArray, isObj, keysOf, type Obj } from "./own.ts";
export { instantText, type ParsedDateTime, parseDateTime, validDate } from "./times.ts";
export type * from "./types.ts";
export { normalizeValue, type ValueResult } from "./values.ts";
