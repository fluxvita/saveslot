// Reference evaluator for replay, revert and privacy deletion (02-architecture §11 «测试矩阵»).
// A test oracle only: it must not depend on the kernel's judging code.

export { cutSegment, evaluate, evaluateAsWritten, evaluateLog } from "./evaluate.ts";
export * from "./interval.ts";
export type * from "./model.ts";
export { findItem, itemsOf, segments, showIv, stateWithoutIndices, timeline } from "./views.ts";
