// Test helpers of the kernel for other packages' tests (store-pglite): hand-written events, the
// anchor store conformance cases, the judged scenarios of the comparison, the events of judged
// logs, and the write pipeline with identifiers chosen by the test. Source only (not built); only
// test files may import it.

export { withConfirmations } from "./apply/confirmation.fixture.ts";
export * from "./apply/slot.fixture.ts";
// The states of a target at a version position, and their comparison.
export { stateAt, targetDelta } from "./delta/index.ts";
// One judgement on a state, for a test asking what a decision would do now.
export { judgeOp } from "./judge/index.ts";
export {
  type Decision,
  type Judged,
  judged,
  scenario,
  shape,
} from "./judge/scenarios.fixture.ts";
// Which judged steps give a row a new version, as the version table has it.
export { cellsOf, givesVersion, seenAsVersions, versionsOf } from "./judge/versions.fixture.ts";
// An item's entries as its events give them (tests check a detail against them).
export { actorsNow, itemEntries } from "./pending/index.ts";
// `query` in a transaction, with the hook to read the state after an operation as a later page
// does (tests compare it with the first page's path).
export { type QueryInput, queryInTx } from "./read/query.ts";
// `sql` in a transaction, for tests that wrap the transaction to see the statements it is given.
export { type SqlInput, type SqlOutput, sqlInTx } from "./read/sql.ts";
export { decodeColumns } from "./request/index.ts";
// The write path takes `external_key` (tests only, until the entry opens).
export { acceptExternalKeyForTests } from "./request/normalize.ts";
export * from "./store/anchor-conformance.fixture.ts";
export { failPremiseDetectionForTests } from "./write/detect-premises.ts";
// The literal checker, for tests holding a write's literal blocks to it.
export { checkLiteral, indexEvidence } from "./write/literal.ts";
export {
  asWritten,
  eventsOfRequest,
  eventsOfSteps,
  FIRST_OP,
  judgeStateFromLog,
  type LoggedEvent,
} from "./write/log.fixture.ts";
export { type WriteInput, writeInTx } from "./write/pipeline.ts";
// A compiled table's shape, for tests that read a row's state back from the log.
export { tableShape } from "./write/plan.ts";
// A write's `premise_affected` with a visibility of its own (tests pin the rows not listed).
export { premiseAffected } from "./write/premise-affected.ts";
export { premiseFanInLimitForTests } from "./write/premises.ts";
export { resolveInTx, revertEntriesOf } from "./write/resolve.ts";
