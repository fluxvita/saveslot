// Moves an evaluation variant's dates to the day it runs: every date
// by the same number of days, so that "today" in the system prompt is the machine's date,
// which the hosts go by. What a whole-day shift cannot keep ("last week", "this month") is not
// rewritten: whether a variant can run on a day is worked out from what it says, and a day it
// cannot run on is refused. A weekday in a seed's evidence follows the seed's one date. A date
// written in a form this does not know stops the run, rather than staying unshifted.

type Obj = Record<string, unknown>;

/** One replacement: where in the variant (a YAML path), what it was, what it is now. */
export interface Replacement {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/** Something that looks like a date this does not know how to move, and where it is. */
export interface Unknown {
  readonly path: string;
  readonly text: string;
  readonly why: string;
}

// --- days ------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a valid `YYYY-MM-DD`; undefined when it is no such day. */
function dayNumber(y: number, m: number, d: number): number | undefined {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return t / DAY_MS;
}

export const parts = (n: number) => {
  const d = new Date(n * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
};
const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (n: number) => {
  const p = parts(n);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

/** The day of an ISO date (or of a date-time's date part). */
export function dayOf(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const n = m === null ? undefined : dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
  if (n === undefined) throw new Error(`not a date: ${s}`);
  return n;
}

/**
 * Whether the clock's offset still holds in `timezone` on the moved day: in a zone with daylight
 * saving, a shift across the change would keep an offset the day does not have.
 */
export function offsetHolds(clock: string, days: number, timezone: string): boolean {
  const m = /([+-]\d{2}):(\d{2})$/.exec(clock.replace(/\[.*\]$/, ""));
  if (m === null) return true;
  const offset = (m[1] as string).startsWith("-")
    ? -(Number((m[1] as string).slice(1)) * 60 + Number(m[2]))
    : Number((m[1] as string).slice(1)) * 60 + Number(m[2]);
  const at = new Date(new Date(clock.replace(/\[.*\]$/, "")).getTime() + days * DAY_MS);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((x) => x.type === "timeZoneName")?.value;
  const z = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name ?? "");
  if (z === null) return true;
  const actual =
    z[1] === undefined ? 0 : (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  return actual === offset;
}

/** Today, as `YYYY-MM-DD`, in `timezone`. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export const monthIndex = (n: number) => {
  const p = parts(n);
  return p.y * 12 + p.m - 1;
};

// --- what a variant says -----------------------------------------------------------------------

/** Words about weeks a whole-day shift moves the meaning of; a weekday a seed's date pins is not one. */
const WEEK_WORDS = /上周|这周|本周|下周|周末|上个星期|这个星期|下个星期|上礼拜|这礼拜|下礼拜/;
/** A weekday named: in a seed's evidence it follows the seed's date; anywhere else, a week word. */
export const WEEKDAY = /(周|星期|礼拜)([一二三四五六日天])/g;
const MONTH_WORDS = /上个月|这个月|本月|下个月|上月|月初|月底|月末/;

export const WEEKDAY_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

/** Every string in `x`, with its YAML path. */
function strings(x: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof x === "string") out.push([path, x]);
  else if (Array.isArray(x)) {
    for (const [i, y] of x.entries()) strings(y, `${path}[${i}]`, out);
  } else if (x !== null && typeof x === "object") {
    for (const [k, y] of Object.entries(x)) strings(y, path === "" ? k : `${path}.${k}`, out);
  }
  return out;
}

/** The calls of the seed and of the script steps, with their YAML paths. */
function calls(v: Obj): [string, Obj][] {
  const out: [string, Obj][] = [];
  const fixture = (v["fixture"] ?? {}) as Obj;
  for (const [i, c] of ((fixture["seed"] ?? []) as Obj[]).entries()) {
    out.push([`fixture.seed[${i}]`, c]);
  }
  for (const [i, s] of ((v["steps"] ?? []) as Obj[]).entries()) {
    for (const [j, c] of ((s["script"] ?? []) as Obj[]).entries()) {
      out.push([`steps[${i}].script[${j}]`, c]);
    }
  }
  return out;
}

const WHOLE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_MOMENT = /^\d{4}-\d{2}-\d{2}T[^\s]*$/;

/** The dates a call's parameters hold as whole values (not inside a text), with their paths. */
function callDates(path: string, c: Obj): [string, number][] {
  return strings(c["params"] ?? {}, `${path}.params`)
    .filter(([, s]) => WHOLE_DAY.test(s) || WHOLE_MOMENT.test(s))
    .map(([p, s]) => [p, dayOf(s)]);
}

/** The variant's dates: its clock and every whole date of its calls. */
function variantDates(v: Obj): number[] {
  return [
    dayOf(String(v["clock"])),
    ...calls(v).flatMap(([p, c]) => callDates(p, c).map(([, n]) => n)),
  ];
}

/** The texts a person reads in the variant: the users' lines and the seeds' and scripts' params. */
function readTexts(v: Obj): [string, string][] {
  const out: [string, string][] = [];
  ((v["steps"] ?? []) as Obj[]).forEach((s, i) => {
    if (typeof s["user"] === "string") out.push([`steps[${i}].user`, s["user"]]);
  });
  for (const [p, c] of calls(v)) out.push(...strings(c["params"] ?? {}, `${p}.params`));
  return out;
}

/**
 * The calendar units a derived rule groups or picks by (`date_trunc('week', …)`, `extract(dow
 * from …)`, `date_part('month', …)`): a day of the week or a week needs a shift by whole weeks; a
 * month, quarter or year needs every date to stay as many of them from the clock as it was.
 */
function ruleUnits(rules: readonly string[]): Set<"week" | "month" | "quarter" | "year"> {
  const out = new Set<"week" | "month" | "quarter" | "year">();
  for (const r of rules) {
    for (const m of r.matchAll(/(?:date_trunc|date_part)\(\s*'(\w+)'|extract\(\s*(\w+)\s+from/gi)) {
      const u = (m[1] ?? m[2] ?? "").toLowerCase();
      if (["week", "dow", "isodow", "isoyear"].includes(u)) out.add("week");
      else if (u === "month") out.add("month");
      else if (u === "quarter") out.add("quarter");
      else if (["year", "decade", "century", "millennium"].includes(u)) out.add("year");
    }
  }
  return out;
}

const quarterIndex = (n: number) => Math.floor(monthIndex(n) / 3);
const yearIndex = (n: number) => parts(n).y;

/**
 * Why the variant cannot run shifted by `days`, if it cannot: words about weeks, or a derived
 * table grouped by week, need a shift by whole weeks; words about months, or a table grouped by
 * month, need every date to stay as many months from the clock as it was. `rules`: the SQL of
 * the derived tables of the variant's slots.
 */
export function cannotRun(v: Obj, days: number, rules: readonly string[] = []): string[] {
  const why: string[] = [];
  const units = ruleUnits(rules);
  if (units.has("week") && days % 7 !== 0) {
    why.push("a derived table groups by week or weekday: it runs only on the clock's weekday");
  }
  const clockDay = dayOf(String(v["clock"]));
  for (const [unit, index] of [
    ["quarter", quarterIndex],
    ["year", yearIndex],
  ] as const) {
    if (!units.has(unit)) continue;
    const moved = variantDates(v).find(
      (d) => index(d + days) - index(clockDay + days) !== index(d) - index(clockDay),
    );
    if (moved !== undefined) {
      why.push(
        `a derived table groups by ${unit}: ${isoOf(moved)} would fall in another ${unit} relative to the clock`,
      );
    }
  }
  const texts = readTexts(v);
  const userLines = new Set(((v["steps"] ?? []) as Obj[]).map((_, i) => `steps[${i}].user`));
  const week = texts.find(
    ([p, s]) => WEEK_WORDS.test(s) || (userLines.has(p) && new RegExp(WEEKDAY.source).test(s)),
  );
  if (week !== undefined && days % 7 !== 0) {
    why.push(`${week[0]} speaks of weeks ("${week[1]}"): it runs only on the clock's weekday`);
  }
  const month: [string, string] | undefined =
    texts.find(([, s]) => MONTH_WORDS.test(s)) ??
    (units.has("month") ? ["a derived table", "grouped by month"] : undefined);
  if (month !== undefined) {
    const clock = dayOf(String(v["clock"]));
    const moved = variantDates(v).find(
      (d) => monthIndex(d + days) - monthIndex(clock + days) !== monthIndex(d) - monthIndex(clock),
    );
    if (moved !== undefined) {
      why.push(
        `${month[0]} speaks of months ("${month[1]}"): ${isoOf(moved)} would fall in another month relative to the clock`,
      );
    }
  }
  return why;
}

/** The next `n` days after `today` (exclusive) the variant can run on, within a year. */
export function nextRunDays(v: Obj, today: string, rules: readonly string[] = [], n = 3): string[] {
  const clock = dayOf(String(v["clock"]));
  const from = dayOf(today);
  const out: string[] = [];
  for (let t = from + 1; t <= from + 366 && out.length < n; t++) {
    if (cannotRun(v, t - clock, rules).length === 0) out.push(isoOf(t));
  }
  return out;
}

// --- moving the dates ------------------------------------------------------------------------------

/** The year that puts month `m`, day `d` nearest to `near`; undefined when it is no day. */
function nearest(m: number, d: number, near: number): number | undefined {
  const y = parts(near).y;
  const options = [y - 1, y, y + 1]
    .map((yy) => dayNumber(yy, m, d))
    .filter((x): x is number => x !== undefined);
  if (options.length === 0) return undefined;
  return options.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
}

/** How far a month-day may be from the variant's dates and still be read as one of them. */
const MONTH_DAY_REACH = 62;

/** Forms of a date this does not move: written so, they stop the run. */
export const UNKNOWN_FORMS: [RegExp, string][] = [
  [/(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])/g, "a date written with a slash"],
  [/[一二三四五六七八九十]+月[一二三四五六七八九十]+[日号]/g, "a date written in Chinese numerals"],
];

interface Context {
  /** The days the variant itself names: its clock, its calls' dates, the dates in its users' lines. */
  readonly named: ReadonlySet<number>;
  readonly days: number;
  readonly clock: number;
  readonly lo: number;
  readonly hi: number;
  readonly replacements: Replacement[];
  readonly unknown: Unknown[];
}

/**
 * A text with its dates moved: `YYYY-MM-DD`, "M 月 D 日/号", and `MM-DD` near the variant's
 * dates. In an assertion a `MM-DD` is moved only in an interval or a comparison; any other number
 * pair that could be a month and a day is reported.
 */
function moveText(s: string, path: string, cx: Context, assertion: boolean): string {
  // A replacement is held under a placeholder until the end, so that no later rule reads a date
  // already moved as one still to move.
  const held: string[] = [];
  const note = (from: string, to: string) => {
    if (from !== to) cx.replacements.push({ path, from, to });
    held.push(to);
    return `\uE000${"x".repeat(held.length)}\uE001`;
  };
  const report = (text: string, why: string) => cx.unknown.push({ path, text, why });
  for (const [re, why] of UNKNOWN_FORMS) for (const m of s.matchAll(re)) report(m[0], why);

  // Whole dates and moments.
  let out = s.replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (all, y, m, d) => {
    const n = dayNumber(Number(y), Number(m), Number(d));
    if (n === undefined) {
      report(all, "not a day");
      return all;
    }
    return note(all, isoOf(n + cx.days));
  });

  // "11 月 2 日到 9 日": the end, written with its day only, is in the start's month (or the next).
  out = out.replace(
    /(?<!\d)(\d{1,2})(\s*)月(\s*)(\d{1,2})(\s*)([日号]?)(\s*(?:到|至|~|～|—|-)\s*)(\d{1,2})(\s*)([日号])/g,
    (all, m, a, b, d, c, unit, sep, e, f, unit2) => {
      const start = nearest(Number(m), Number(d), cx.clock);
      const sm = parts(start ?? 0);
      const end =
        start === undefined
          ? undefined
          : (dayNumber(sm.y, sm.m, Number(e)) ?? undefined) !== undefined && Number(e) >= sm.d
            ? dayNumber(sm.y, sm.m, Number(e))
            : dayNumber(sm.m === 12 ? sm.y + 1 : sm.y, sm.m === 12 ? 1 : sm.m + 1, Number(e));
      if (start === undefined || end === undefined) {
        report(all, "not a stretch of days");
        return all;
      }
      const p = parts(start + cx.days);
      const q = parts(end + cx.days);
      const endText = q.m === p.m ? `${q.d}${f}${unit2}` : `${q.m} 月 ${q.d}${f}${unit2}`;
      return note(all, `${p.m}${a}月${b}${p.d}${c}${unit}${sep}${endText}`);
    },
  );

  // "11 月 2 号", "11月2日": the year nearest to the clock, written back without one.
  out = out.replace(
    /(?<!\d)(\d{1,2})(\s*)月(\s*)(\d{1,2})(\s*)([日号])/g,
    (all, m, a, b, d, c, unit) => {
      const n = nearest(Number(m), Number(d), cx.clock);
      if (n === undefined) {
        report(all, "not a day");
        return all;
      }
      const p = parts(n + cx.days);
      return note(all, `${p.m}${a}月${b}${p.d}${c}${unit}`);
    },
  );

  // A month: `2026-11`, "11 月" with no day after it. It moves as the clock's month moves (a
  // variant whose dates' months matter runs only where they keep their months: cannotRun).
  const months = monthIndex(cx.clock + cx.days) - monthIndex(cx.clock);
  const monthText = (y: number, mo: number) => {
    const i = y * 12 + mo - 1 + months;
    return { y: Math.floor(i / 12), m: (i % 12) + 1 };
  };
  out = out.replace(/(?<![\d-])(\d{4})-(\d{2})(?![\d-])/g, (all, y, mo) => {
    if (Number(mo) < 1 || Number(mo) > 12) {
      report(all, "not a month");
      return all;
    }
    const t = monthText(Number(y), Number(mo));
    return note(all, `${t.y}-${pad(t.m)}`);
  });
  out = out.replace(/(?<![\d-])(\d{1,2})(\s*)月(?!\s*\d)(?!初|底|末)/g, (all, mo, a) => {
    if (Number(mo) < 1 || Number(mo) > 12) return all;
    const t = monthText(parts(cx.clock).y, Number(mo));
    return note(all, `${t.m}${a}月`);
  });

  // MM-DD.
  out = out.replace(/(?<![\d-])(\d{1,2})-(\d{1,2})(?![\d-])/g, (all, m, d, at: number, whole) => {
    const n = nearest(Number(m), Number(d), cx.clock);
    if (n === undefined) return all;
    const near = n >= cx.lo - MONTH_DAY_REACH && n <= cx.hi + MONTH_DAY_REACH;
    const before = (whole as string).slice(Math.max(0, at - 6), at);
    const after = (whole as string).slice(at + all.length, at + all.length + 2);
    const inInterval = /[[(,，]\s*$/.test(before) || /^\s*[,，)\]]/.test(after);
    const inComparison = /(晚于|早于|之前|之后|以前|以后|从|到|至|起|截至)\s*$/.test(before);
    // Elsewhere in an assertion, a day the variant itself names ("11-03 has two records").
    // A month-day the variant names in two years: which one is not known.
    const sameDay = [...cx.named].filter((x) => {
      const p = parts(x);
      return p.m === Number(m) && p.d === Number(d);
    });
    if (sameDay.length > 1) {
      report(all, "a month-day the variant names in more than one year");
      return all;
    }
    const named = cx.named.has(n);
    if (!near || (assertion && !inInterval && !inComparison && !named)) {
      report(
        all,
        near
          ? "a month-day outside an interval or a comparison, and not a day the variant names"
          : "a month-day far from the variant's dates",
      );
      return all;
    }
    const p = parts(n + cx.days);
    // Into another year than the clock's: written with its year.
    const to =
      parts(n).y === parts(cx.clock).y && p.y !== parts(cx.clock + cx.days).y
        ? isoOf(n + cx.days)
        : `${pad(p.m)}-${pad(p.d)}`;
    return note(all, m.length === 1 && d.length === 1 && to.length === 5 ? `${p.m}-${p.d}` : to);
  });

  // A day of the month on its own ("9 日"): which month is not known.
  for (const m of s.matchAll(/(?<![\d月])(?<!月\s)(\d{1,2})\s*[日号](?!\s*(?:到|至))/g)) {
    const before = s.slice(0, m.index ?? 0);
    // The end of a stretch "M 月 D 日到 D 日" was moved with its start.
    if (/\d\s*月\s*\d{1,2}\s*[日号]?\s*(?:到|至|~|～|—|-)\s*$/.test(before)) continue;
    report(m[0], "a day of the month without its month");
  }
  return out.replace(/\uE000(x+)\uE001/g, (_, xs: string) => held[xs.length - 1] as string);
}

/** A whole date or moment moved; its time, offset and zone kept. */
function moveWhole(s: string, path: string, cx: Context): string {
  const to = isoOf(dayOf(s) + cx.days) + s.slice(10);
  if (to !== s) cx.replacements.push({ path, from: s, to });
  return to;
}

/** `x` with its strings moved, each as `f` says. */
function mapStrings(x: unknown, path: string, f: (s: string, path: string) => string): unknown {
  if (typeof x === "string") return f(x, path);
  if (Array.isArray(x)) return x.map((y, i) => mapStrings(y, `${path}[${i}]`, f));
  if (x !== null && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x).map(([k, y]) => [k, mapStrings(y, path === "" ? k : `${path}.${k}`, f)]),
    );
  }
  return x;
}

/** A call's params moved: whole dates, the dates in its texts, a weekday its one date pins. */
function moveCall(c: Obj, path: string, cx: Context): Obj {
  const dates = callDates(path, c);
  const params = mapStrings(c["params"] ?? {}, `${path}.params`, (s, p) => {
    if (WHOLE_DAY.test(s) || WHOLE_MOMENT.test(s)) return moveWhole(s, p, cx);
    let out = moveText(s, p, cx, false);
    if (new RegExp(WEEKDAY.source).test(out)) {
      if (dates.length !== 1) {
        cx.unknown.push({
          path: p,
          text: s,
          why: `a weekday in a call with ${dates.length} dates: which one it goes with is not known`,
        });
        return out;
      }
      const w = WEEKDAY_CHARS[parts((dates[0] as [string, number])[1] + cx.days).w] as string;
      out = out.replace(new RegExp(WEEKDAY.source, "g"), (all, word: string, ch: string) => {
        const to = `${word}${ch === "天" && w === "日" ? "天" : w}`;
        if (to !== all) cx.replacements.push({ path: p, from: all, to });
        return to;
      });
    }
    return out;
  });
  return { ...c, params };
}

/** The days the users' lines name: `YYYY-MM-DD`, "M 月 D 日/号", `MM-DD` (the year nearest the clock). */
function userDays(v: Obj, clock: number): number[] {
  const out: number[] = [];
  ((v["steps"] ?? []) as Obj[]).forEach((s) => {
    if (typeof s["user"] !== "string") return;
    const line = s["user"];
    for (const m of line.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
      const n = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
      if (n !== undefined) out.push(n);
    }
    for (const m of line.matchAll(
      /(?<![\d-])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<![\d-])(\d{1,2})-(\d{1,2})(?![\d-])/g,
    )) {
      const n = nearest(Number(m[1] ?? m[3]), Number(m[2] ?? m[4]), clock);
      if (n !== undefined) out.push(n);
    }
  });
  return out;
}

/**
 * The variant with every date moved by `days`, the replacements made, and what could not be
 * moved. The caller refuses to run when `unknown` is not empty.
 */
export function shiftVariant(
  v: Obj,
  days: number,
): { variant: Obj; replacements: Replacement[]; unknown: Unknown[] } {
  const dates = variantDates(v);
  const clock = dayOf(String(v["clock"]));
  const cx: Context = {
    named: new Set([...dates, ...userDays(v, clock)]),
    days,
    clock: dayOf(String(v["clock"])),
    lo: Math.min(...dates),
    hi: Math.max(...dates),
    replacements: [],
    unknown: [],
  };
  const out: Obj = { ...v, clock: moveWhole(String(v["clock"]), "clock", cx) };
  const fixture = (v["fixture"] ?? {}) as Obj;
  out["fixture"] = {
    ...fixture,
    ...(fixture["seed"] !== undefined
      ? {
          seed: (fixture["seed"] as Obj[]).map((c, i) => moveCall(c, `fixture.seed[${i}]`, cx)),
        }
      : {}),
  };
  out["steps"] = ((v["steps"] ?? []) as Obj[]).map((s, i) => {
    if (typeof s["user"] === "string") {
      return { ...s, user: moveText(s["user"], `steps[${i}].user`, cx, false) };
    }
    if (Array.isArray(s["script"])) {
      return {
        ...s,
        script: (s["script"] as Obj[]).map((c, j) => moveCall(c, `steps[${i}].script[${j}]`, cx)),
      };
    }
    return s;
  });
  if (v["assert"] !== undefined) {
    out["assert"] = mapStrings(v["assert"], "assert", (s, p) => moveText(s, p, cx, true));
  }
  return { variant: out, replacements: cx.replacements, unknown: cx.unknown };
}
