// Test helpers of the kernel for other packages' tests (store-pglite): hand-written events, the
// anchor store conformance cases, the judged scenarios of the comparison, the events of judged
// logs, and the write pipeline with identifiers chosen by the test. Source only (not built); only
// test files may import it.

export * from "./apply/slot.fixture.ts";
export {
  type Decision,
  type Judged,
  judged,
  scenario,
  shape,
} from "./judge/scenarios.fixture.ts";
// `query` in a transaction, with the hook to read the state after an operation as a later page
// does (tests compare it with the first page's path).
export { type QueryInput, queryInTx } from "./read/query.ts";
export * from "./store/anchor-conformance.fixture.ts";
export {
  asInThisPhase,
  DecisionOverItems,
  eventsOfRequest,
  eventsOfSteps,
  FIRST_OP,
  type LoggedEvent,
} from "./write/log.fixture.ts";
export { type WriteInput, writeInTx } from "./write/pipeline.ts";
