// The prompts (docs/zh-CN/spec/05-surfaces.md §10.1): `overview`, `pending` and `track`, each giving
// one user message of fixed wording. A prompt is listed when the tool its text sends the model to
// is in the credential's tool list (rule 3, and 05 §9 «按 scope 出现的句子»: prompts are composed as
// tool descriptions are): `track` needs `saveslot_schema_draft`, which needs `saveslot.schema`,
// and is not listed while that tool is not.
// No stored data goes into a prompt (rule 1): a `slot` argument is checked against the names the
// credential can see, which is the only thing read, and no read is recorded; `what` is the user's
// own words, typed right then, and goes in as given (rule 2), within its length and with no
// character that changes how text is laid out or shown.

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ToolName } from "./names.ts";
import { PROMPTS } from "./texts.ts";

export type PromptName = keyof typeof PROMPTS;

interface PromptDef {
  readonly name: PromptName;
  /** The tool the prompt's text sends the model to: listed only with it. */
  readonly needs: ToolName;
  readonly arguments: readonly { readonly name: string; readonly description: string }[];
}

/** The prompts, in the order listed, and the scope each needs (05 §10.1). */
export const PROMPT_DEFS: readonly PromptDef[] = [
  { name: "overview", needs: "saveslot_catalog", arguments: [] },
  {
    name: "pending",
    needs: "saveslot_pending",
    arguments: [{ name: "slot", description: PROMPTS.pending.slot }],
  },
  {
    name: "track",
    needs: "saveslot_schema_draft",
    arguments: [{ name: "what", description: PROMPTS.track.what }],
  },
];

/** `prompts/list` for a credential with these tools: the same list whatever its data. */
export function promptList(tools: ReadonlySet<ToolName>) {
  return {
    prompts: PROMPT_DEFS.filter((p) => tools.has(p.needs)).map((p) => ({
      name: p.name,
      description: PROMPTS[p.name].description,
      // Every argument is optional: a host passes words split on spaces (06-cli §3.3), so a
      // sentence cannot be counted on as one argument.
      arguments: p.arguments.map((a) => ({ ...a, required: false })),
    })),
  };
}

/** `what` at most, in code points (05 §10.1 rule 2). */
export const WHAT_MAX = 200;

/**
 * What `what` may not hold: C0 and C1 controls (line breaks and tabs among them), DEL, the line
 * and paragraph separators, and the bidirectional controls. Refused, not cleaned or escaped.
 */
const LAYOUT_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const holdsLayout = (s: string): boolean =>
  Array.from(s).some((c) => {
    const cp = c.codePointAt(0) as number;
    return LAYOUT_RANGES.some(([a, b]) => cp >= a && cp <= b);
  });

/** A slot name as names are (07-schema-evolution «名字»). */
const SLOT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

const invalid = (message: string) => new ProtocolError(ProtocolErrorCode.InvalidParams, message);

/** What `prompts/get` needs of the credential. */
export interface PromptCaller {
  readonly tools: ReadonlySet<ToolName>;
  /** Its slot range is some slots, not all (05 §10.1 `track`). */
  readonly scoped: boolean;
  /** The names of the slots it can see: read only when a `slot` is given. */
  readonly slotNames: () => Promise<ReadonlySet<string>>;
}

/** An argument's value: a string, or not given (an empty or blank one is taken as not given). */
function argument(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${key} is a string`);
  return v.trim() === "" ? undefined : v;
}

/** `prompts/get`: the prompt's one user message, or the protocol's invalid-params error. */
export async function promptGet(
  name: string,
  args: Readonly<Record<string, unknown>>,
  caller: PromptCaller,
) {
  const def = PROMPT_DEFS.find((p) => p.name === name && caller.tools.has(p.needs));
  if (def === undefined) throw invalid("Unknown prompt");
  for (const k of Object.keys(args)) {
    if (!def.arguments.some((a) => a.name === k)) throw invalid(`${def.name} takes no ${k}`);
  }
  const text = await textOf(def.name, args, caller);
  return {
    description: PROMPTS[def.name].description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

async function textOf(
  name: PromptName,
  args: Readonly<Record<string, unknown>>,
  caller: PromptCaller,
): Promise<string> {
  if (name === "overview") return PROMPTS.overview.text;
  if (name === "pending") {
    const slot = argument(args, "slot");
    // Not a name, or not a slot this credential sees: the same answer, so that it tells nothing
    // of slots outside its range.
    if (slot !== undefined && (!SLOT_NAME.test(slot) || !(await caller.slotNames()).has(slot))) {
      throw invalid("slot is not a slot this connection can see");
    }
    const p = PROMPTS.pending;
    const last = caller.tools.has("saveslot_resolve") ? p.resolve : p.noResolve;
    return `${p.list(slot)} ${p.show} ${last}`;
  }
  const what = argument(args, "what");
  if (what !== undefined) {
    if (Array.from(what).length > WHAT_MAX) throw invalid(`what is at most ${WHAT_MAX} characters`);
    if (holdsLayout(what)) throw invalid("what holds a control character");
  }
  const p = PROMPTS.track;
  return `${p.lead(what)} ${caller.scoped ? p.scoped : p.all}`;
}
