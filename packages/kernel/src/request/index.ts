// Write requests: checking and normalizing before anything depends on the tenant's state
// (docs/zh-CN/spec/03-data-model/04-write-and-read.md «判定顺序» step 1).

export {
  checkSvCompatibility,
  normalizeWrite,
  type ResolveWriteSlotResult,
  resolveWriteSlot,
  type SlotTables,
} from "./normalize.ts";
export { isJsonNumber, JsonNumber, jsonNumber, keepNumberText } from "./number.ts";
export type * from "./types.ts";
