// The text of `saveslot reads` and `saveslot verify` (docs/zh-CN/spec/06-cli.md §4.8): who read
// what, versions and no values, the connect self-check marked as such; the log's check, each
// problem with where it is.

import {
  type LogVerifyResult,
  READ_OPERATIONS,
  type ReadsListResult,
} from "@fluxvita/saveslot-client";
import { actorOf, arr, count, idOf, int, isObj, obj, op, type R, str, targetOf } from "./reads.ts";
import { code, handle, join, type Line, name, num, t, table, time, untrusted } from "./text.ts";

const OPERATIONS: ReadonlySet<string> = new Set<string>(READ_OPERATIONS);

/** `saveslot reads` (06 §4.8): each read, newest as given; the self-check of `connect` marked. */
export function readsList(r: ReadsListResult): Line[] {
  const x = r as unknown as R;
  const reads = arr(x["reads"]);
  const out: Line[] = [
    t`${num(reads.length)} reads · kept since ${time(String(x["covered_since"] ?? ""))}`,
  ];
  for (const rd of reads) {
    const e = obj(rd);
    const where =
      e["table"] !== undefined
        ? t`  ${table(String(e["table"]))}`
        : e["slot"] !== undefined
          ? t`  slot ${name(String(e["slot"]))}`
          : [];
    const sv = e["sv"] !== undefined ? t` (sv ${count(e["sv"])})` : [];
    const rows = arr(e["rows"]);
    const total = int(e["rows_total"]);
    const rowsRead =
      rows.length > 0
        ? t`  rows ${join(
            rows.map((x) => t`${targetOf(obj(x)["target"])} ${op(obj(x)["seq"])}`),
            t`, `,
          )}${total !== undefined && total > rows.length ? t` (of ${num(total)})` : []}`
        : [];
    const coarse = arr(e["coarse"]);
    const tables =
      coarse.length > 0
        ? t`  whole tables ${join(
            coarse.map((c) => t`${table(String(obj(c)["table"] ?? ""))} to ${op(obj(c)["pos"])}`),
            t`, `,
          )}`
        : [];
    const task = e["task"] !== undefined ? t`  task ${untrusted(String(e["task"]))}` : [];
    const valid = isObj(e["valid"])
      ? t`  at business time ${untrusted(JSON.stringify(e["valid"]))}`
      : [];
    const source = e["source"] !== undefined ? t`  source ${idOf(e["source"])}` : [];
    // `task` is the caller's word; the mark is the service's own (`selfcheck`), not a guarantee.
    const selfcheck = e["selfcheck"] === true ? t`  self-check (saveslot connect)` : [];
    out.push(
      t`${time(String(e["at"] ?? ""))}  ${actorOf(e["actor"])}  ${code(String(e["operation"] ?? ""), OPERATIONS)}${where}${sv}${rowsRead}${tables}${valid}${source}${task}${selfcheck}`,
    );
  }
  const next = str(x["next_cursor"]);
  if (next !== undefined) out.push(t`next page: the same command with --cursor ${handle(next)}`);
  return out;
}

/** Whether `saveslot verify` found anything: exit 9 then (06 §6.2). */
export function verifyFound(r: LogVerifyResult): boolean {
  return (
    !r.chain.intact ||
    r.checksum_mismatch.length > 0 ||
    r.index_mismatch.length > 0 ||
    r.gaps.length > 0
  );
}

/** `saveslot verify` (06 §4.8): events, the chain, each mismatch, removed content, gaps. */
export function logVerified(r: LogVerifyResult): Line[] {
  const x = r as unknown as R;
  const chain = obj(x["chain"]);
  const out: Line[] = [
    t`${num(int(x["events"]) ?? 0)} events · chain ${chain["intact"] === true ? t`intact` : t`broken from ${op(chain["broken_at"])}`}`,
  ];
  for (const m of arr(x["checksum_mismatch"])) {
    out.push(
      t`  checksum does not match: ${op(obj(m)["seq"])} at ${untrusted(String(obj(m)["path"] ?? ""))}`,
    );
  }
  for (const m of arr(x["index_mismatch"])) {
    out.push(t`  index columns differ from the event: ${op(obj(m)["seq"])}`);
  }
  out.push(t`  content removed by deletions: ${num(int(x["removed"]) ?? 0)}`);
  for (const g of arr(x["gaps"])) {
    const gap = obj(g);
    out.push(
      t`  a gap a restore left: after ${op(gap["after"])}, before ${op(gap["before"])} (restore ${op(gap["restore"])})`,
    );
  }
  out.push(verifyFound(r) ? t`problems found` : t`no problems found`);
  return out;
}
