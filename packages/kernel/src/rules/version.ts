// The ruleset version (docs/zh-CN/spec/02-architecture.md §3 "判定的版本",
// docs/zh-CN/spec/09-event-format.md §1.6, §5.1).
//
// One integer for the kernel's mechanical judgements as a whole. Every operation's head event
// records the version it judged with (`ctx.ruleset_version`); a deletion replay recomputes an old
// write by the version that write recorded. `apply` stops on a version it does not know rather than
// judging by another one.
//
// A leaf file: it imports nothing, so any module allowed to import `rules` can read it.

/** The version this kernel judges with and records into new head events. */
export const RULESET_VERSION = 1;

/** Every version this kernel can judge by: the ones `apply` accepts in recorded events. */
export const KNOWN_RULESET_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Whether the kernel can judge by `version`. */
export function isKnownRulesetVersion(version: number): boolean {
  return KNOWN_RULESET_VERSIONS.has(version);
}
