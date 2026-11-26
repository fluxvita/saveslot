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
 * The statements of `sql` that control the transaction (BEGIN, COMMIT, ROLLBACK, SAVEPOINT, …), by
 * their first words, comments, quoted literals and identifiers and dollar-quoted bodies left out.
 * A step runs as one script in the transaction that sets the format last: a COMMIT in it would
 * make what comes before it stay when the rest fails, a store neither of the old format nor of the
 * new.
 */
export function transactionControl(sql: string): readonly string[] {
  let bare = "";
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i);
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      bare += " ";
    } else if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      bare += " ";
    } else if (rest[0] === "'" || rest[0] === '"') {
      const q = rest[0];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q && sql[j + 1] === q) j += 2;
        else if (sql[j] === q) break;
        else j++;
      }
      i = j + 1;
      bare += " x ";
    } else if (dollar !== null) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      i = end === -1 ? sql.length : end + dollar[0].length;
      bare += " x ";
    } else {
      bare += sql[i];
      i++;
    }
  }
  return bare
    .split(";")
    .map((st) => st.trim())
    .filter((st) =>
      /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS)\b/i.test(
        st,
      ),
    );
}

/**
 * The steps that take a store of format `from` to format `to`, one after another; an error when a
 * step is missing or given twice, or when a step of the list controls the transaction it runs in
 * (`transactionControl`): the kernel's own list, so it is a fault of this version.
 */
export function upgradePath(
  from: number,
  to: number,
  steps: readonly UpgradeStep[] = UPGRADE_STEPS,
): readonly UpgradeStep[] {
  for (const s of steps) {
    const found = transactionControl(s.sql);
    if (found.length > 0)
      throw new Error(
        `upgrade steps: the step from format ${s.from} controls its transaction (${found.join("; ")})`,
      );
  }
  const path: UpgradeStep[] = [];
  for (let f = from; f < to; f++) {
    const step = steps.filter((s) => s.from === f);
    if (step.length !== 1)
      throw new Error(`upgrade steps: ${step.length} steps from format ${f} (one expected)`);
    path.push(step[0] as UpgradeStep);
  }
  return path;
}
