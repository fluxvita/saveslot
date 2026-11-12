// Reference evaluator for replay, revert and privacy deletion (02-architecture §11 «测试矩阵»).
// A test oracle only: it must not depend on the kernel's judging code.

export { evaluate, evaluateAsWritten } from "./evaluate.ts";
export * from "./interval.ts";
export type * from "./model.ts";
export { findItem, itemsOf, segments, showIv, timeline } from "./views.ts";
