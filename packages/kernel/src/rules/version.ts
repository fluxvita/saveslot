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

/**
 * The restricted SQL whitelist versions this kernel evaluates (03-data-model/11-restricted-sql.md
 * «白名单的版本与变更»): a compiled definition's `rsql` and each rule's. `apply` stops on others
 * (09-event-format §7).
 */
export const KNOWN_RSQL_VERSIONS: ReadonlySet<string> = new Set(["rsql@1"]);

export function isKnownRsqlVersion(version: string): boolean {
  return KNOWN_RSQL_VERSIONS.has(version);
}

/**
 * The literal checker versions this kernel knows (04-write-and-read «来源级别», with the unit
 * writings `units@1`): a head event's `ctx.literal_checker`. `apply` stops on others (09 §1.6).
 */
export const KNOWN_LITERAL_CHECKERS: ReadonlySet<string> = new Set(["literal@1"]);

export function isKnownLiteralChecker(version: string): boolean {
  return KNOWN_LITERAL_CHECKERS.has(version);
}

/** The whitelist version this kernel compiles new definitions with (09-event-format §7 `rsql`). */
export const CURRENT_RSQL_VERSION = "rsql@1";
