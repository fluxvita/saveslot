// Dates written as anchors (./anchors.ts): how each form is given, what stops the run, and on which
// days a variant can run, for the variants written with anchors and for each kind of anchor.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  anchorDay,
  anchored,
  cannotRunAnchored,
  nextAnchoredDays,
  usesAnchors,
} from "./anchors.ts";
import { dayOf, isoOf, monthIndex, parts } from "./shift.ts";

type Obj = Record<string, unknown>;

/** A variant on clock 2026-11-10 (a Tuesday) with the given seed, steps and assertions. */
const variant = (
  o: { seed?: Obj[]; steps?: Obj[]; assert?: Obj; clock?: string; runs_when?: unknown } = {},
): Obj => ({
  id: "t",
  clock: o.clock ?? "2026-11-10T09:00:00+08:00",
  fixture: { slots: [], connections: [], seed: o.seed ?? [] },
  steps: o.steps ?? [],
  ...(o.assert !== undefined ? { assert: o.assert } : {}),
  ...(o.runs_when !== undefined ? { runs_when: o.runs_when } : {}),
});
const write = (params: Obj): Obj => ({ as: "seed", op: "write", params });
const run = (date: string, text = "x"): Obj =>
  write({
    evidence: [{ kind: "user_message", text }],
    ops: [{ intent: "insert", table: "health.runs", set: { date } }],
  });
const d = dayOf;

describe("anchors given on a day", () => {
  it("today, this month's 1st, this week's Monday, with days added or taken", () => {
    expect(isoOf(anchorDay("@today-2", d("2026-11-20")))).toBe("2026-11-18");
    expect(isoOf(anchorDay("@month+7", d("2026-11-20")))).toBe("2026-11-08");
    expect(isoOf(anchorDay("@week", d("2026-11-20")))).toBe("2026-11-16");
    expect(isoOf(anchorDay("@week-7", d("2026-11-20")))).toBe("2026-11-09");
  });

  it("on a Sunday, @week is the Monday six days before", () => {
    expect(isoOf(anchorDay("@week", d("2026-11-22")))).toBe("2026-11-16");
    expect(isoOf(anchorDay("@week", d("2026-11-23")))).toBe("2026-11-23");
  });

  it("in January, @month-4 is in December of the year before", () => {
    expect(isoOf(anchorDay("@month-4", d("2027-01-15")))).toBe("2026-12-28");
  });

  it("in February, @month+28 is the 29th of a leap year and March 1st of another", () => {
    expect(isoOf(anchorDay("@month+28", d("2028-02-29")))).toBe("2028-02-29");
    expect(isoOf(anchorDay("@month+28", d("2027-02-28")))).toBe("2027-03-01");
    const v = variant({ clock: "2028-02-29T09:00:00+08:00", seed: [run("@month+28")] });
    expect(cannotRunAnchored(v, d("2028-02-29"))).toEqual([]);
    expect(cannotRunAnchored(v, d("2027-02-28"))).toHaveLength(1);
  });
});

describe("the variant as it runs", () => {
  it("whole values, moments with the clock's offset, a user's line, an assertion", () => {
    const r = anchored(
      variant({
        seed: [
          write({
            evidence: [{ kind: "user_message", text: "x", stated_at: "@today-1T18:30:00" }],
            ops: [{ valid_from: "@month" }],
          }),
        ],
        steps: [{ agent: "A", user: "{@month+2} 那次记错了" }],
        assert: { state: [{ where: { date: "@month+2" }, text: "{@month+2} 只有一条" }] },
      }),
      d("2026-12-20"),
    );
    const v = r.variant as {
      clock: string;
      fixture: { seed: { params: Obj }[] };
      steps: { user: string }[];
      assert: Obj;
    };
    expect(r.unknown).toEqual([]);
    expect(v.clock).toBe("2026-12-20T09:00:00+08:00");
    expect(v.fixture.seed[0]?.params).toEqual({
      evidence: [{ kind: "user_message", text: "x", stated_at: "2026-12-19T18:30:00+08:00" }],
      ops: [{ valid_from: "2026-12-01" }],
    });
    expect(v.steps[0]?.user).toBe("12 月 3 日 那次记错了");
    expect(v.assert).toEqual({
      state: [{ where: { date: "2026-12-03" }, text: "12-03 只有一条" }],
    });
    expect(r.replacements).toContainEqual({
      path: "fixture.seed[0].params.ops[0].valid_from",
      from: "@month",
      to: "2026-12-01",
    });
    expect(r.bases).toEqual({ today: "2026-12-20", month: "2026-12-01", week: "2026-12-14" });
  });

  it("a weekday in a call's text follows the call's one date", () => {
    const r = anchored(variant({ seed: [run("@month+7", "周日跑了 10 公里")] }), d("2026-12-20"));
    const seed = (r.variant as { fixture: { seed: { params: { evidence: Obj[] } }[] } }).fixture
      .seed;
    // 2026-12-08 is a Tuesday.
    expect(seed[0]?.params.evidence[0]?.["text"]).toBe("周二跑了 10 公里");
    expect(r.unknown).toEqual([]);
  });
});

describe("what stops the run", () => {
  const why = (v: Obj) => anchored(v, d("2026-11-20")).unknown.map((u) => [u.text, u.why]);

  it("a value or a placeholder that starts like an anchor and is not one", () => {
    expect(why(variant({ seed: [run("@month+")] }))).toEqual([
      ["@month+", "starts with @ and is not an anchor"],
    ]);
    expect(why(variant({ seed: [run("@yesterday")] }))[0]?.[1]).toBe(
      "starts with @ and is not an anchor",
    );
    expect(
      why(variant({ seed: [run("@today")], steps: [{ agent: "A", user: "{@monthly} 那次" }] })),
    ).toEqual([["{@monthly}", "a placeholder that is not an anchor"]]);
  });

  it("a date written out beside anchors: the clock alone is written out", () => {
    const u = why(
      variant({
        seed: [run("@today"), run("2026-11-03"), run("@today", "11 月 2 号跑的")],
        assert: { reply: [{ rubric: "没有把 11-03 算进去，也没有把 10 月算进去" }] },
      }),
    );
    expect(u.map(([t]) => t)).toEqual(["2026-11-03", "11 月 2 号", "11-03", "10 月"]);
  });

  it("a weekday in a user's line or an assertion: nothing moves it", () => {
    const u = why(
      variant({ seed: [run("@today")], steps: [{ agent: "A", user: "周三那次记错了" }] }),
    );
    expect(u).toEqual([["周三", "a weekday outside a call's text: nothing moves it"]]);
  });

  it("runs_when not written as two anchors compared, or not holding on the reference day", () => {
    expect(why(variant({ seed: [run("@today")], runs_when: "@month+8 <= today" }))).toEqual([
      ["@month+8 <= today", "not <anchor> <op> <anchor>"],
    ]);
    expect(why(variant({ seed: [run("@today")], runs_when: "@month+20 <= @today" }))).toEqual([
      ["@month+20 <= @today", "does not hold on the reference day"],
    ]);
  });

  it("a variant without anchors is not one", () => {
    expect(usesAnchors(variant({ seed: [run("2026-11-03")] }))).toBe(false);
    expect(usesAnchors(variant({ seed: [run("@month")] }))).toBe(true);
    expect(usesAnchors(variant({ steps: [{ agent: "A", user: "{@today} 跑了" }] }))).toBe(true);
  });
});

describe("the days a variant can run on", () => {
  it("a seed later than today on the reference day is refused when it would be today", () => {
    const v = variant({ seed: [run("@month+7")] });
    expect(cannotRunAnchored(v, d("2026-12-09"))).toEqual([]);
    expect(cannotRunAnchored(v, d("2026-12-08"))).toEqual([
      "@month+7 (fixture.seed[0].params.ops[0].set.date): on the reference day 2026-11-08, earlier, 0 months; on 2026-12-08 2026-12-08, today, 0 months",
    ]);
    expect(nextAnchoredDays(v, "2026-11-30")).toEqual(["2026-12-09", "2026-12-10", "2026-12-11"]);
  });

  it("@week: as many weeks from today, and before, on or after it as on the reference day", () => {
    // On Tuesday 2026-11-10, @week+6 is the Sunday after: later, the same week. It is today on a
    // Sunday, so Sundays are refused.
    const v = variant({ seed: [run("@week+6")] });
    for (let t = d("2026-11-16"); t < d("2026-11-23"); t++) {
      expect(cannotRunAnchored(v, t).length === 0, isoOf(t)).toBe(parts(t).w !== 0);
    }
  });

  it("with @month: @today-10 stays as many months from today", () => {
    // On 2026-11-20, @today-10 is 11-10, this month: from the 11th of a month on.
    const v = variant({
      clock: "2026-11-20T09:00:00+08:00",
      seed: [run("@month"), run("@today-10")],
    });
    for (let t = d("2026-12-01"); t <= d("2026-12-31"); t++) {
      expect(cannotRunAnchored(v, t).length === 0, isoOf(t)).toBe(parts(t).d >= 11);
    }
    // Without @month, how many months is not kept.
    expect(cannotRunAnchored(variant({ seed: [run("@today-10")] }), d("2026-12-05"))).toEqual([]);
  });

  it("with @week: @today-3 stays as many weeks from today", () => {
    // On Tuesday 2026-11-10, @today-3 is the Saturday of the week before, and @week is earlier
    // than today: Tuesdays and Wednesdays only.
    const v = variant({ seed: [run("@week"), run("@today-3")] });
    for (let t = d("2026-11-16"); t < d("2026-11-23"); t++) {
      expect(cannotRunAnchored(v, t).length === 0, isoOf(t)).toBe([2, 3].includes(parts(t).w));
    }
  });

  it("runs_when makes it stricter", () => {
    const v = variant({ seed: [run("@month+7")], runs_when: ["@month+9 <= @today"] });
    expect(cannotRunAnchored(v, d("2026-12-09"))).toEqual([
      "runs_when @month+9 <= @today does not hold on 2026-12-09",
    ]);
    expect(cannotRunAnchored(v, d("2026-12-10"))).toEqual([]);
  });
});

describe("1a, 1c and 7c: from the 9th of every month on, with the same seeds this and last month", () => {
  const load = (id: string) =>
    parse(readFileSync(new URL(`../${id}.yaml`, import.meta.url), "utf8")) as Obj;
  /** The seeds' dates as given on `today`, counted by how many months from today they are. */
  const byMonth = (v: Obj, today: number) => {
    const r = anchored(v, today);
    const seed = (r.variant as { fixture: { seed: { params: Obj }[] } }).fixture.seed;
    const out = new Map<number, number>();
    for (const c of seed) {
      const ops = c.params["ops"] as { set?: { date?: string } }[];
      const date = ops[0]?.set?.date;
      if (date === undefined) continue;
      const m = monthIndex(d(date)) - monthIndex(today);
      out.set(m, (out.get(m) ?? 0) + 1);
    }
    return [...out].sort(([a], [b]) => a - b);
  };

  for (const [id, expected] of [
    [
      "1a",
      [
        [-1, 1],
        [0, 4],
      ],
    ],
    [
      "1c",
      [
        [-1, 1],
        [0, 6],
      ],
    ],
    [
      "7c",
      [
        [-1, 1],
        [0, 4],
      ],
    ],
  ] as const) {
    it(id, () => {
      const v = load(id);
      expect(usesAnchors(v)).toBe(true);
      const reference = d(String(v["clock"]));
      expect(anchored(v, reference).unknown).toEqual([]);
      expect(byMonth(v, reference)).toEqual(expected);
      for (let t = reference; t < reference + 400; t++) {
        const runs = cannotRunAnchored(v, t).length === 0;
        expect(runs, isoOf(t)).toBe(parts(t).d >= 9);
        if (runs) expect(byMonth(v, t), isoOf(t)).toEqual(expected);
      }
    });
  }
});
