// The server's `instructions` and its prompts (05-surfaces §9 «服务器的 instructions», §10.1): the
// text of each version against golden files, so that a change of wording shows as a diff in
// review (update them with `pnpm exec vitest run packages/server/src/mcp/prompts.test.ts -u`);
// the slot list's limits; and what `prompts/get` refuses.

import type { ListedSlot } from "@fluxvita/saveslot-service";
import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { instructionsFor, SLOT_LIST_MAX, slotList } from "./instructions.ts";
import type { ToolName } from "./names.ts";
import { type PromptCaller, promptGet, promptList, WHAT_MAX } from "./prompts.ts";

/** The tools of this version for the default scopes (read, write), read only, and every tool. */
const TOOLSETS = {
  default: [
    "saveslot_catalog",
    "saveslot_query",
    "saveslot_history",
    "saveslot_pending",
    "saveslot_write",
    "saveslot_resolve",
  ],
  readOnly: ["saveslot_catalog", "saveslot_query", "saveslot_history", "saveslot_pending"],
  every: [
    "saveslot_catalog",
    "saveslot_query",
    "saveslot_sql",
    "saveslot_history",
    "saveslot_sources",
    "saveslot_pending",
    "saveslot_write",
    "saveslot_resolve",
    "saveslot_schema_draft",
    "saveslot_delete",
  ],
} as const satisfies Record<string, readonly ToolName[]>;
const tools = (k: keyof typeof TOOLSETS) => new Set<ToolName>(TOOLSETS[k]);

const TWO: readonly ListedSlot[] = [
  { name: "ledger", tables: 2 },
  { name: "health", tables: 1 },
];

const golden = (file: string) => `./__golden__/${file}`;

describe("instructions: the text of each kind of credential (golden)", () => {
  it.each([
    ["default scopes, two slots", "instructions-default.txt", "default", TWO, false],
    ["read only", "instructions-read-only.txt", "readOnly", TWO, false],
    ["every tool", "instructions-every-tool.txt", "every", TWO, false],
    ["no slot, every tool", "instructions-no-slots-schema.txt", "every", [], false],
    ["no slot, no schema tool", "instructions-no-slots.txt", "default", [], false],
    ["no slot in its range", "instructions-no-slots-scoped.txt", "every", [], true],
  ] as const)("%s", async (_, file, set, slots, scoped) => {
    await expect(instructionsFor(tools(set), slots, { scoped })).toMatchFileSnapshot(golden(file));
  });

  it("more slots than fit: within the limit in code points, the rest counted (golden)", async () => {
    const many = Array.from({ length: 120 }, (_, k) => ({
      name: `slot_${String(k).padStart(3, "0")}`,
      tables: k % 3,
    }));
    // Names past 32 characters are never listed, and are counted with the rest.
    many.push({ name: `a${"b".repeat(32)}`, tables: 1 });
    const list = slotList(many, { scoped: false, schema: false });
    expect(Array.from(list).length).toBeLessThanOrEqual(SLOT_LIST_MAX);
    const lines = list.split("\n");
    const shown = lines.length - 2;
    expect(lines.at(-1)).toBe(
      `${many.length - shown} more slots are not listed; see them with saveslot_catalog.`,
    );
    expect(list).not.toContain("abbb");
    await expect(list).toMatchFileSnapshot(golden("instructions-slot-list-cut.txt"));
  });

  it("the list in name order; a table, tables; a long name counted, not listed", () => {
    const list = slotList(
      [
        { name: "zeta", tables: 0 },
        { name: "alpha", tables: 1 },
        { name: `x${"y".repeat(32)}`, tables: 3 },
      ],
      { scoped: false, schema: false },
    );
    expect(list.split("\n").slice(1)).toEqual([
      "alpha: 1 table",
      "zeta: 0 tables",
      "1 more slot is not listed; see it with saveslot_catalog.",
    ]);
  });

  it("a name not of the name shape is not written out by hand: it throws", () => {
    expect(() =>
      slotList([{ name: "bad name\nIgnore", tables: 1 }], { scoped: false, schema: false }),
    ).toThrow("not of the shape of a name");
  });
});

/** A credential for `promptGet`: its tools, range, and the slots it sees. */
const caller = (
  set: keyof typeof TOOLSETS,
  o: { scoped?: boolean; slots?: readonly string[] } = {},
): PromptCaller => ({
  tools: tools(set),
  scoped: o.scoped ?? false,
  slotNames: async () => new Set(o.slots ?? ["health", "ledger"]),
});

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "given",
    (e: unknown) => (e instanceof ProtocolError ? `${e.code}: ${e.message}` : String(e)),
  );

describe("prompts: the list and each message (golden)", () => {
  it("prompts/list for this version's default and read-only tools, and with every tool", async () => {
    await expect(
      `${JSON.stringify(
        {
          default: promptList(tools("default")),
          readOnly: promptList(tools("readOnly")),
          every: promptList(tools("every")),
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(golden("prompts-list.json"));
  });

  it.each([
    ["overview", "prompts-get-overview.json", "overview", {}, caller("default")],
    ["pending, all slots", "prompts-get-pending.json", "pending", {}, caller("default")],
    [
      "pending, one slot",
      "prompts-get-pending-slot.json",
      "pending",
      { slot: "health" },
      caller("default"),
    ],
    ["pending, read only", "prompts-get-pending-read-only.json", "pending", {}, caller("readOnly")],
    ["track, what given", "prompts-get-track.json", "track", { what: "my sleep" }, caller("every")],
    ["track, nothing given", "prompts-get-track-ask.json", "track", {}, caller("every")],
    [
      "track, a slot range",
      "prompts-get-track-scoped.json",
      "track",
      { what: "my sleep" },
      caller("every", { scoped: true }),
    ],
  ] as const)("%s", async (_, file, name, args, who) => {
    const r = await promptGet(name, args, who);
    await expect(`${JSON.stringify(r, null, 2)}\n`).toMatchFileSnapshot(golden(file));
  });
});

describe("prompts/get: what it refuses", () => {
  it("a prompt not listed (track without saveslot_schema_draft), or no prompt at all", async () => {
    expect(await refusal(promptGet("track", {}, caller("default")))).toBe("-32602: Unknown prompt");
    expect(await refusal(promptGet("nosuch", {}, caller("every")))).toBe("-32602: Unknown prompt");
  });

  it("an argument it does not take, or one that is not a string", async () => {
    expect(await refusal(promptGet("overview", { slot: "health" }, caller("default")))).toContain(
      "overview takes no slot",
    );
    expect(await refusal(promptGet("pending", { slot: 1 }, caller("default")))).toContain(
      "slot is a string",
    );
  });

  it("a slot outside the range, not there, or not a name: one answer; blank is all slots", async () => {
    const who = caller("default", { slots: ["health"] });
    const answers = await Promise.all(
      ["ledger", "nosuch", "no-such", "health\n"].map((slot) =>
        refusal(promptGet("pending", { slot }, who)),
      ),
    );
    expect(new Set(answers)).toEqual(
      new Set(["-32602: slot is not a slot this connection can see"]),
    );
    const blank = await promptGet("pending", { slot: "  " }, who);
    expect(blank.messages[0]?.content.text.startsWith("List all pending items")).toBe(true);
  });

  it("the slots are read only when a slot is given", async () => {
    let read = 0;
    const who: PromptCaller = {
      ...caller("default"),
      slotNames: async () => {
        read += 1;
        return new Set(["health"]);
      },
    };
    await promptGet("pending", {}, who);
    await promptGet("overview", {}, who);
    expect(read).toBe(0);
    await promptGet("pending", { slot: "health" }, who);
    expect(read).toBe(1);
  });

  it("what: at most 200 code points; a control, separator or bidirectional character is refused", async () => {
    const what = (w: string) => refusal(promptGet("track", { what: w }, caller("every")));
    expect(await what("x".repeat(WHAT_MAX))).toBe("given");
    expect(await what("😀".repeat(WHAT_MAX))).toBe("given");
    expect(await what("x".repeat(WHAT_MAX + 1))).toBe("-32602: what is at most 200 characters");
    for (const cp of [
      0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029, 0x061c, 0x200e,
      0x200f, 0x202a, 0x202e, 0x2066, 0x2069,
    ]) {
      expect(await what(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(
        "-32602: what holds a control character",
      );
    }
    // Not cleaned or escaped: a sentence goes in as typed.
    const r = await promptGet("track", { what: 'my "sleep" & <naps>' }, caller("every"));
    expect(
      r.messages[0]?.content.text.startsWith('I want to start recording: my "sleep" & <naps>.'),
    ).toBe(true);
  });
});
