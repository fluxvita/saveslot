// Moving a variant's dates to the day it runs (./shift.ts): one case for each form a date is
// written in, for each form that is reported instead, and for each reason a day is refused.

import { describe, expect, it } from "vitest";
import { cannotRun, dayOf, nextRunDays, offsetHolds, shiftVariant, todayIn } from "./shift.ts";

type Obj = Record<string, unknown>;

/** A variant on clock 2026-11-10 (a Tuesday) with the given seed, steps and assertions. */
const variant = (o: { seed?: Obj[]; steps?: Obj[]; assert?: Obj } = {}): Obj => ({
  id: "t",
  clock: "2026-11-10T09:00:00+08:00",
  fixture: { slots: [], connections: [], seed: o.seed ?? [] },
  steps: o.steps ?? [],
  ...(o.assert !== undefined ? { assert: o.assert } : {}),
});
const write = (params: Obj): Obj => ({ as: "seed", op: "write", params });
const user = (line: string): Obj => ({ agent: "A", user: line });

describe("the dates moved", () => {
  it("the clock, whole dates and moments in params: the time, offset and zone kept", () => {
    const r = shiftVariant(
      variant({
        seed: [
          write({
            evidence: [
              {
                kind: "user_message",
                text: "x",
                stated_at: "2026-11-01T08:30:00+08:00[Asia/Shanghai]",
              },
            ],
            ops: [{ valid_from: "2026-10-01", valid_during: ["2026-10-01", "2026-11-01"] }],
          }),
        ],
      }),
      10,
    );
    const v = r.variant as { clock: string; fixture: { seed: { params: Obj }[] } };
    expect(v.clock).toBe("2026-11-20T09:00:00+08:00");
    expect(v.fixture.seed[0]?.params).toEqual({
      evidence: [
        { kind: "user_message", text: "x", stated_at: "2026-11-11T08:30:00+08:00[Asia/Shanghai]" },
      ],
      ops: [{ valid_from: "2026-10-11", valid_during: ["2026-10-11", "2026-11-11"] }],
    });
    expect(r.replacements).toContainEqual({
      path: "fixture.seed[0].params.ops[0].valid_during[1]",
      from: "2026-11-01",
      to: "2026-11-11",
    });
    expect(r.unknown).toEqual([]);
  });

  it("dates in texts: ISO, Chinese, a stretch with its end's day only, a month", () => {
    const r = shiftVariant(
      variant({
        steps: [
          user("11 月 2 号起改成 3000"),
          user("11 月 5 到 7 号那段"),
          user("11月28日到3日"),
          user("2026-11-03 那次"),
          user("11 月的总数"),
        ],
        assert: { reply: [{ rubric: "说明 11 月 5 日到 7 日，monthly_total 2026-11" }] },
      }),
      10,
    );
    const lines = (r.variant as { steps: { user: string }[] }).steps.map((s) => s.user);
    expect(lines).toEqual([
      "11 月 12 号起改成 3000",
      "11 月 15 到 17 号那段",
      // 11-28 to 12-03, moved 10 days: 12-08 to 12-13.
      "12月8日到13日",
      "2026-11-13 那次",
      "11 月的总数",
    ]);
    expect((r.variant as { assert: { reply: { rubric: string }[] } }).assert.reply[0]?.rubric).toBe(
      "说明 11 月 15 日到 17 日，monthly_total 2026-11",
    );
    expect(r.unknown).toEqual([]);
  });

  it("a stretch moved once: its start is not moved again as a date of its own", () => {
    const r = shiftVariant(variant({ steps: [user("11 月 5 日到 7 日")] }), 8);
    expect((r.variant as { steps: { user: string }[] }).steps[0]?.user).toBe("11 月 13 日到 15 日");
  });

  it("a month moves with the clock's month", () => {
    const r = shiftVariant(variant({ steps: [user("2026-11 与 11 月")] }), 25);
    expect((r.variant as { steps: { user: string }[] }).steps[0]?.user).toBe("2026-12 与 12 月");
  });

  it("MM-DD in an assertion: in an interval, in a comparison, or a day the variant names", () => {
    const r = shiftVariant(
      variant({
        seed: [write({ ops: [{ valid_from: "2026-10-01" }] })],
        steps: [user("11 月 2 号起")],
        assert: {
          state: [
            { text: "`[10-01, 11-02)` 5000" },
            { text: "晚于 11-10 的日期" },
            { text: "抹掉了 11-02 的变化点；valid_from: 10-01" },
          ],
        },
      }),
      10,
    );
    const texts = (r.variant as { assert: { state: { text: string }[] } }).assert.state.map(
      (s) => s.text,
    );
    expect(texts).toEqual([
      "`[10-11, 11-12)` 5000",
      "晚于 11-20 的日期",
      "抹掉了 11-12 的变化点；valid_from: 10-11",
    ]);
    expect(r.unknown).toEqual([]);
  });

  it("MM-DD moved into another year than the clock's: written with its year", () => {
    // Clock 2026-11-10 moved 45 days is 2026-12-25; 2026-12-20 moved is 2027-02-03.
    const r = shiftVariant(variant({ assert: { state: [{ text: "`[11-10, 12-20)`" }] } }), 45);
    expect((r.variant as { assert: { state: { text: string }[] } }).assert.state[0]?.text).toBe(
      "`[12-25, 2027-02-03)`",
    );
  });

  it("a weekday in a seed's evidence follows the seed's one date", () => {
    const r = shiftVariant(
      variant({
        seed: [
          write({
            evidence: [{ kind: "user_message", text: "周日跑了 10 公里" }],
            ops: [{ set: { date: "2026-11-08" } }],
          }),
        ],
      }),
      10,
    );
    // 2026-11-18 is a Wednesday.
    expect(
      (r.variant as { fixture: { seed: { params: { evidence: { text: string }[] } }[] } }).fixture
        .seed[0]?.params.evidence[0]?.text,
    ).toBe("周三跑了 10 公里");
    expect(r.replacements).toContainEqual({
      path: "fixture.seed[0].params.evidence[0].text",
      from: "周日",
      to: "周三",
    });
  });
});

describe("what is reported instead of moved", () => {
  const unknown = (o: Parameters<typeof variant>[0]) =>
    shiftVariant(variant(o), 10).unknown.map((u) => `${u.path}: ${u.text}`);

  it("a slash, Chinese numerals, a day without its month", () => {
    expect(
      unknown({ steps: [user("11/2 那天"), user("十一月二号"), user("到 9 号为止")] }),
    ).toEqual(["steps[0].user: 11/2", "steps[1].user: 十一月二号", "steps[2].user: 9 号"]);
  });

  it("in an assertion, MM-DD in prose that the variant does not name, or far from its dates", () => {
    expect(
      unknown({ assert: { calls: [{ text: "第 3-4 步之间" }, { text: "`[03-01, 03-05)`" }] } }),
    ).toEqual([
      "assert.calls[0].text: 3-4",
      "assert.calls[1].text: 03-01",
      "assert.calls[1].text: 03-05",
    ]);
  });

  it("a month-day the variant names in two years", () => {
    expect(
      unknown({
        seed: [write({ ops: [{ valid_from: "2025-11-03" }, { valid_from: "2026-11-03" }] })],
        assert: { state: [{ text: "指出 11-03 有两条" }] },
      }),
    ).toEqual(["assert.state[0].text: 11-03"]);
  });

  it("a weekday in a call with two dates: which one it goes with is not known", () => {
    expect(
      unknown({
        seed: [
          write({
            evidence: [{ kind: "user_message", text: "周日" }],
            ops: [{ valid_from: "2026-11-01", valid_to: "2026-11-08" }],
          }),
        ],
      }),
    ).toEqual(["fixture.seed[0].params.evidence[0].text: 周日"]);
  });
});

describe("whether a variant can run on a day", () => {
  const rows = [
    write({ ops: [{ set: { date: "2026-10-28" } }] }),
    write({ ops: [{ set: { date: "2026-11-01" } }] }),
  ];

  it("nothing about weeks or months: any day", () => {
    expect(cannotRun(variant({ seed: rows, steps: [user("今天跑了多少")] }), 3)).toEqual([]);
  });

  it("words about weeks, or a weekday in a user's line: whole weeks only", () => {
    expect(cannotRun(variant({ steps: [user("上周跑了多少")] }), 7)).toEqual([]);
    expect(cannotRun(variant({ steps: [user("上周跑了多少")] }), 3)).toHaveLength(1);
    expect(cannotRun(variant({ steps: [user("周日那次")] }), 3)).toHaveLength(1);
  });

  it("words about months: every date as many months from the clock as it was", () => {
    const v = variant({ seed: rows, steps: [user("这个月跑了多少")] });
    // Clock 11-10, dates 10-28 and 11-01: on the 10th to the 13th of a month.
    expect(cannotRun(v, dayOf("2026-12-10") - dayOf("2026-11-10"))).toEqual([]);
    expect(cannotRun(v, dayOf("2026-12-14") - dayOf("2026-11-10"))).toHaveLength(1);
    expect(nextRunDays(v, "2026-11-20")).toEqual(["2026-12-10", "2026-12-11", "2026-12-12"]);
  });

  it("a derived table grouped by week, month, quarter or year", () => {
    const v = variant({ seed: rows });
    const week = ["SELECT date_trunc('week', date::timestamp)::date AS w FROM runs GROUP BY 1"];
    const dow = ["SELECT extract(dow FROM date) AS d FROM runs GROUP BY 1"];
    const month = ["SELECT date_part('month', date) AS m FROM runs GROUP BY 1"];
    const year = ["SELECT date_trunc('year', date::timestamp)::date AS y FROM runs GROUP BY 1"];
    expect(cannotRun(v, 3, week)).toHaveLength(1);
    expect(cannotRun(v, 7, week)).toEqual([]);
    expect(cannotRun(v, 3, dow)).toHaveLength(1);
    expect(cannotRun(v, dayOf("2026-11-20") - dayOf("2026-11-10"), month)).toHaveLength(1);
    // Every date stays in the clock's year: 2026-10-28 and 2026-11-01 moved 30 days.
    expect(cannotRun(v, 30, year)).toEqual([]);
    expect(cannotRun(v, 60, year)).toHaveLength(1);
    expect(nextRunDays(v, "2026-11-20", week)).toEqual(["2026-11-24", "2026-12-01", "2026-12-08"]);
  });
});

it("today is the day in the variant's time zone", () => {
  // 2026-11-19T17:00Z is 11-20 in Shanghai and 11-19 in New York.
  const now = new Date("2026-11-19T17:00:00Z");
  expect(todayIn("Asia/Shanghai", now)).toBe("2026-11-20");
  expect(todayIn("America/New_York", now)).toBe("2026-11-19");
});

it("the clock's offset on the moved day: kept where the zone has no daylight saving, refused across a change", () => {
  expect(offsetHolds("2026-11-10T09:00:00+08:00", 200, "Asia/Shanghai")).toBe(true);
  // New York is -05:00 in November and -04:00 from 2027-03-14.
  expect(offsetHolds("2026-11-10T09:00:00-05:00", 30, "America/New_York")).toBe(true);
  expect(offsetHolds("2026-11-10T09:00:00-05:00", 130, "America/New_York")).toBe(false);
});
