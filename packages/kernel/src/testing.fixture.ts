// Test helpers of the kernel for other packages' tests (store-pglite): hand-written events, the
// anchor store conformance cases, the judged scenarios of the comparison, and the events of
// judged logs. Source only (not built); only test files may import it.

export * from "./apply/slot.fixture.ts";
export {
  type Decision,
  type Judged,
  judged,
  scenario,
  shape,
} from "./judge/scenarios.fixture.ts";
export * from "./store/anchor-conformance.fixture.ts";
export {
  asInThisPhase,
  eventsOfRequest,
  eventsOfSteps,
  FIRST_OP,
  type LoggedEvent,
} from "./write/log.fixture.ts";
