// Whether a write is a correction (04-contract §7, 04-contract-types §2 "correction"): its
// `write.base` target's intent is `correct`. The one place that says so: `history`'s timeline marks
// the sources of such a write, and `sources` marks a source that such a write took a value from.

/** Whether a `write.base` target block (as parsed) is of a correction. */
export function isCorrection(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as Record<string, unknown>)["intent"] === "correct"
  );
}
