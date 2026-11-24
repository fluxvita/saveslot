// The deletion module (docs/zh-CN/spec/02-architecture.md §4, L5 `delete`): what a privacy deletion
// takes away and lists, and its events' blocks. The `delete` operation itself comes later (D3).

export {
  type CancellationContent,
  type DeletionContent,
  encodeCancellation,
  encodeDeletion,
  restatementOut,
} from "./encode.ts";
export {
  type DepHit,
  type HeadBlocks,
  type PositionIndex,
  type PositionsInput,
  positionsOf,
  readDeletionPositions,
  readPositionIndex,
} from "./positions.ts";
export { type BaseCitations, cites, readCitations, takenAway } from "./taken.ts";
