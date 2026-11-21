// The text of `saveslot policy show` (docs/zh-CN/spec/06-cli.md §4.3): which schema changes take
// effect without confirmation, and the tables and fields counted as high impact besides the
// defaults. What the service stored (a writer's name) stays inside the boundary.

import { AUTO_APPLY_CLASSES, type SlotPolicy } from "@fluxvita/saveslot-client";
import { actorOf, arr, count, obj, op, str } from "./reads.ts";
import { code, join, type Line, name, t, time } from "./text.ts";

const CLASSES: ReadonlySet<string> = new Set<string>(AUTO_APPLY_CLASSES);

/** `saveslot policy show <slot>`. */
export function policyShown(r: SlotPolicy): Line[] {
  const x = r as unknown as Record<string, unknown>;
  const auto = arr(x["auto_apply"]).map((c) => [code(String(c), CLASSES)]);
  const high = arr(x["high_impact"]).map((h) => {
    const e = obj(h);
    const fields = arr(e["fields"]).map((f) => [name(String(f))]);
    return t`${name(String(e["table"] ?? ""))}${fields.length > 0 ? t` (${join(fields, t`, `)})` : []}`;
  });
  return [
    t`slot ${name(String(x["slot"] ?? ""))} · policy version ${count(x["policy_version"])} · set by ${actorOf(x["set_by"])} at ${time(str(x["set_at"]) ?? "")} ${op(x["seq"])}`,
    auto.length > 0
      ? t`take effect without confirmation: ${join(auto, t`, `)}`
      : t`every schema change awaits confirmation`,
    high.length > 0
      ? t`high impact besides the defaults: ${join(high, t`; `)}`
      : t`high impact: the defaults only`,
  ];
}
