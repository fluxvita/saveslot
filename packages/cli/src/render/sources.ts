// The text of `saveslot sources` (docs/zh-CN/spec/06-cli.md §4.7; 04-contract-types §4.6): each
// source a line, newest first (its ID, kind, the correction mark, slot, time, writer and the
// start of its text); one source with its text or file and what it produced. What was stored
// (text, excerpts, a file's name, a writer's name) goes as untrusted text, as in `history` and
// `reads`.

import {
  SOURCE_KINDS,
  SOURCE_LEVELS,
  type SourcesGetResult,
  type SourcesListResult,
} from "@fluxvita/saveslot-client";
import { actorOf, arr, idOf, isObj, obj, op, type R, str, targetOf } from "./reads.ts";
import { code, join, type Line, name, num, t, time, untrusted } from "./text.ts";

const KINDS: ReadonlySet<string> = new Set<string>(SOURCE_KINDS);
const LEVELS: ReadonlySet<string> = new Set<string>(SOURCE_LEVELS);
const ROLES: ReadonlySet<string> = new Set(["value", "operation"]);

/** A file reference: its name, type and size. */
const fileOf = (f: R) =>
  t`file ${untrusted(String(f["name"] ?? ""))} (${untrusted(String(f["mime"] ?? ""))}, ${num(Number(f["size"] ?? 0))} bytes)`;

/** `saveslot sources` / `sources search`: a line a source. */
export function sourcesList(r: SourcesListResult): Line[] {
  const x = r as unknown as R;
  const items = arr(x["sources"]);
  const more = str(x["next_cursor"]) !== undefined;
  const out: Line[] = [
    more
      ? t`the latest ${num(items.length)} sources (more on the next page)`
      : t`${num(items.length)} sources`,
  ];
  for (const it of items) {
    const s = obj(it);
    const said =
      s["excerpt"] !== undefined
        ? t` · ${untrusted(String(s["excerpt"]))}`
        : isObj(s["file"])
          ? t` · ${fileOf(obj(s["file"]))}`
          : [];
    out.push(
      t`${idOf(s["id"])} ${code(String(s["kind"] ?? ""), KINDS)}${s["correction"] === true ? t` (correction)` : []} · ${name(String(s["slot"] ?? ""))} · ${time(String(s["recorded_at"] ?? ""))} · ${actorOf(s["actor"])}${said}`,
    );
  }
  return out;
}

/** `saveslot sources get`: one source, its text or file, and what it produced. */
export function sourceDetail(r: SourcesGetResult): Line[] {
  const s = r as unknown as R;
  const out: Line[] = [
    t`${idOf(s["id"])} ${code(String(s["kind"] ?? ""), KINDS)}${s["correction"] === true ? t` (correction)` : []} · ${name(String(s["slot"] ?? ""))} · level ${code(String(s["level"] ?? ""), LEVELS)}`,
    t`  recorded ${time(String(s["recorded_at"] ?? ""))} by ${actorOf(s["actor"])}`,
  ];
  if (s["stated_at"] !== undefined) out.push(t`  stated at ${time(String(s["stated_at"]))}`);
  if (s["text"] !== undefined) out.push(t`  text ${untrusted(String(s["text"]))}`);
  if (isObj(s["file"])) {
    const f = obj(s["file"]);
    out.push(t`  ${fileOf(f)} sha256 ${untrusted(String(f["sha256"] ?? ""))}`);
    if (f["origin"] !== undefined) out.push(t`    origin ${untrusted(String(f["origin"]))}`);
    if (f["excerpt"] !== undefined) out.push(t`    excerpt ${untrusted(String(f["excerpt"]))}`);
  }
  const produced = arr(s["produced"]);
  if (produced.length === 0) {
    out.push(t`  produced nothing you can see`);
  } else {
    out.push(t`  produced:`);
    for (const p of produced) {
      const e = obj(p);
      const fields = arr(e["fields"]).map((f) => t`${name(String(f))}`);
      out.push(
        t`    ${targetOf(e["target"])} ${op(e["seq"])} ${fields.length > 0 ? join(fields, t`, `) : t`(the row)`} as ${code(String(e["role"] ?? ""), ROLES)} source`,
      );
    }
  }
  return out;
}
