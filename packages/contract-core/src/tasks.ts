// Task identifiers the contract gives a meaning to (docs/zh-CN/spec/04-contract-types.md §8.3;
// 06-cli.md §3 step 7, §3.2).

/**
 * The task of the `catalog` call `saveslot connect` makes with a newly issued token. A `catalog`
 * read under this task is recorded as the self-check (`reads.list` gives it `selfcheck: true`).
 * The task is self-reported: the mark tells the self-check apart, it is no guarantee.
 */
export const SELFCHECK_TASK = "saveslot-connect-selfcheck";
