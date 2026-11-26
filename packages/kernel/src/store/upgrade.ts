// The in-place upgrade of a storage format (02-architecture §8 «格式版本、导出、导入与恢复»;
// docs/zh-CN/process/decisions/data-compatibility.md): a store written by a released version is
// opened by any later one, its format upgraded where it is, one step at a time. The steps are here,
// in the kernel; the backends run them when they open a store, each step in a transaction of its
// own whose last statement sets the format, so that a store is never between two formats.

/** One step: what turns a store of format `from` into one of format `from + 1`. */
export interface UpgradeStep {
  readonly from: number;
  /** The statements, run in one transaction before the format is set to `from + 1`. */
  readonly sql: string;
}

/**
 * The oldest format a released version wrote (0.1.0's): stores of it and later are upgraded; older
 * ones are development formats, refused (`format_too_old`).
 */
export const OLDEST_UPGRADABLE_FORMAT = 5;

/** The steps, from OLDEST_UPGRADABLE_FORMAT to the kernel's format: none while that is 5. */
export const UPGRADE_STEPS: readonly UpgradeStep[] = [];

/**
 * The steps that take a store of format `from` to format `to`, one after another; an error when a
 * step is missing or given twice (the kernel's own list, so it is a fault of this version).
 */
export function upgradePath(
  from: number,
  to: number,
  steps: readonly UpgradeStep[] = UPGRADE_STEPS,
): readonly UpgradeStep[] {
  const path: UpgradeStep[] = [];
  for (let f = from; f < to; f++) {
    const step = steps.filter((s) => s.from === f);
    if (step.length !== 1)
      throw new Error(`upgrade steps: ${step.length} steps from format ${f} (one expected)`);
    path.push(step[0] as UpgradeStep);
  }
  return path;
}
