// Dates written as anchors, given on the day a variant runs (docs/zh-CN/spec/10-evals.md §2.1,
// §2.5): `@today`, `@month` (the 1st of this month), `@week` (this week's Monday), each with whole
// days added or taken (`@month+7`, `@week-7`). A whole value is an anchor (`@today-2`, or a moment
// `@today-2T18:30:00`, with the clock's offset); a text holds one as `{@month+2}`. The clock stays
// as written: the reference day, the day the variant was written for. A day the variant can run on
// is one on which every anchor keeps what it had on the reference day: earlier than today, today,
// or later; when the variant uses `@month`, as many months from today; when it uses `@week`, as
// many weeks (from Monday). `runs_when` adds conditions of its own. A variant uses anchors or
// written dates, not both: a date written out in it stops the run, as does a value or a
// placeholder that starts like an anchor and is not one.

import type { Replacement, Unknown } from "./shift.ts";
import { dayOf, isoOf, monthIndex, parts, UNKNOWN_FORMS, WEEKDAY, WEEKDAY_CHARS } from "./shift.ts";

type Obj = Record<string, unknown>;

const ANCHOR = /^@(today|month|week)([+-]\d+)?$/;
const ANCHOR_MOMENT = /^@(today|month|week)([+-]\d+)?T(\d{2}:\d{2}:\d{2})$/;
const PLACEHOLDER = /\{(@[^{}]*)\}/g;
const RUNS_WHEN = /^\s*(@\S+)\s*(<=|<|>=|>|==)\s*(@\S+)\s*$/;

interface Anchor {
  readonly base: "today" | "month" | "week";
  readonly days: number;
}

const anchorOf = (s: string): Anchor | undefined => {
  const m = ANCHOR.exec(s) ?? ANCHOR_MOMENT.exec(s);
  return m === null ? undefined : { base: m[1] as Anchor["base"], days: Number(m[2] ?? 0) };
};

/** This week's Monday. */
const mondayOf = (n: number) => n - ((parts(n).w + 6) % 7);

/** The day an anchor gives when today is `today`. */
export function anchorDay(a: string, today: number): number {
  const x = anchorOf(a);
  if (x === undefined) throw new Error(`not an anchor: ${a}`);
  const base =
    x.base === "today"
      ? today
      : x.base === "month"
        ? today - (parts(today).d - 1)
        : mondayOf(today);
  return base + x.days;
}

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

/** `x` with its strings replaced as `f` says. */
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

/** The strings anchors may be in: the calls' params, the users' lines, the assertions. */
function places(v: Obj): { path: string; s: string; whole: boolean; call: boolean }[] {
  const out: { path: string; s: string; whole: boolean; call: boolean }[] = [];
  for (const [p, c] of calls(v)) {
    for (const [path, s] of strings(c["params"] ?? {}, `${p}.params`)) {
      out.push({ path, s, whole: true, call: true });
    }
  }
  ((v["steps"] ?? []) as Obj[]).forEach((s, i) => {
    if (typeof s["user"] === "string") {
      out.push({ path: `steps[${i}].user`, s: s["user"], whole: false, call: false });
    }
  });
  for (const [path, s] of strings(v["assert"] ?? {}, "assert")) {
    out.push({ path, s, whole: true, call: false });
  }
  return out;
}

/** Whether the variant writes its dates as anchors. */
export function usesAnchors(v: Obj): boolean {
  return places(v).some(({ s, whole }) => (whole && s.startsWith("@")) || s.includes("{@"));
}

/** Dates written out: in a variant that uses anchors, each stops the run. */
const WRITTEN: [RegExp, string][] = [
  [/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, "a date written out"],
  [/(?<![\d-])\d{4}-\d{2}(?![\d-])/g, "a month written out"],
  [/(?<![\d-])(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?![\d-])/g, "a month-day written out"],
  [/(?<!\d)\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, "a date written out"],
  [/(?<![\d-])(?:0?[1-9]|1[0-2])\s*月(?!\s*\d)/g, "a month written out"],
  ...UNKNOWN_FORMS,
];

/** What one anchor keeps from the reference day: before, on or after today, and how far. */
export interface Relation {
  readonly date: string;
  readonly order: "earlier" | "today" | "later";
  readonly months?: number;
  readonly weeks?: number;
}

/** One anchor of the variant, where it is, and what it is on the reference day and on today. */
export interface AnchorUse {
  readonly anchor: string;
  readonly paths: string[];
  readonly reference: Relation;
  readonly today: Relation;
  readonly same: boolean;
}

export interface RunsWhen {
  readonly condition: string;
  readonly reference: boolean;
  readonly today: boolean;
}

export interface Anchored {
  readonly variant: Obj;
  readonly replacements: Replacement[];
  readonly unknown: Unknown[];
  readonly reference: string;
  readonly today: string;
  /** What each anchor base is on the day it runs. */
  readonly bases: { today: string; month: string; week: string };
  readonly uses: AnchorUse[];
  readonly runsWhen: RunsWhen[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const spoken = (n: number) => `${parts(n).m} 月 ${parts(n).d} 日`;
const monthDay = (n: number) => `${pad(parts(n).m)}-${pad(parts(n).d)}`;
const offsetOf = (clock: string) => /(Z|[+-]\d{2}:\d{2})(\[[^\]]*\])?$/.exec(clock)?.[0] ?? "";

function relation(day: number, today: number, months: boolean, weeks: boolean): Relation {
  return {
    date: isoOf(day),
    order: day < today ? "earlier" : day === today ? "today" : "later",
    ...(months ? { months: monthIndex(day) - monthIndex(today) } : {}),
    ...(weeks ? { weeks: (mondayOf(day) - mondayOf(today)) / 7 } : {}),
  };
}

/**
 * The variant with its anchors given for `today` (a day number), what was replaced, what is
 * not an anchor or is a date written out, and what each anchor keeps from the reference day.
 */
export function anchored(v: Obj, today: number): Anchored {
  const clock = String(v["clock"]);
  const reference = dayOf(clock);
  const replacements: Replacement[] = [];
  const unknown: Unknown[] = [];
  const found = new Map<string, string[]>();
  const use = (a: string, path: string) => found.set(a, [...(found.get(a) ?? []), path]);

  // What is an anchor, what only looks like one, and what is a date written out.
  for (const { path, s, whole, call } of places(v)) {
    if (whole && s.startsWith("@")) {
      if (anchorOf(s) !== undefined) use(s.replace(/T.*$/, ""), path);
      else unknown.push({ path, text: s, why: "starts with @ and is not an anchor" });
      continue;
    }
    for (const m of s.matchAll(PLACEHOLDER)) {
      const a = m[1] as string;
      if (ANCHOR.test(a)) use(a, path);
      else unknown.push({ path, text: m[0], why: "a placeholder that is not an anchor" });
    }
    const rest = s.replace(PLACEHOLDER, " ");
    // A weekday follows a call's one date; in a user's line or an assertion nothing moves it.
    if (!call) {
      for (const m of rest.matchAll(WEEKDAY)) {
        unknown.push({
          path,
          text: m[0],
          why: "a weekday outside a call's text: nothing moves it",
        });
      }
    }
    for (const [re, why] of WRITTEN) {
      for (const m of rest.matchAll(re)) {
        unknown.push({ path, text: m[0], why: `${why}: write it as an anchor` });
      }
    }
  }
  const runsWhenRaw = v["runs_when"];
  const conditions = (
    runsWhenRaw === undefined ? [] : Array.isArray(runsWhenRaw) ? runsWhenRaw : [runsWhenRaw]
  ).map(String);
  const parsed = conditions.flatMap((c, i) => {
    const m = RUNS_WHEN.exec(c);
    if (m === null || !ANCHOR.test(m[1] as string) || !ANCHOR.test(m[3] as string)) {
      unknown.push({ path: `runs_when[${i}]`, text: c, why: "not <anchor> <op> <anchor>" });
      return [];
    }
    return [{ condition: c, a: m[1] as string, op: m[2] as string, b: m[3] as string }];
  });

  const months = [...found.keys()].some((a) => a.startsWith("@month"));
  const weeks = [...found.keys()].some((a) => a.startsWith("@week"));
  const uses = [...found].map(([a, paths]): AnchorUse => {
    const r = relation(anchorDay(a, reference), reference, months, weeks);
    const t = relation(anchorDay(a, today), today, months, weeks);
    const same = r.order === t.order && r.months === t.months && r.weeks === t.weeks;
    return { anchor: a, paths, reference: r, today: t, same };
  });
  const holds = (x: { a: string; op: string; b: string }, day: number) => {
    const a = anchorDay(x.a, day);
    const b = anchorDay(x.b, day);
    return x.op === "<="
      ? a <= b
      : x.op === "<"
        ? a < b
        : x.op === ">="
          ? a >= b
          : x.op === ">"
            ? a > b
            : a === b;
  };
  const runsWhen = parsed.map((x) => ({
    condition: x.condition,
    reference: holds(x, reference),
    today: holds(x, today),
  }));
  for (const [i, r] of runsWhen.entries()) {
    if (!r.reference) {
      unknown.push({
        path: `runs_when[${i}]`,
        text: r.condition,
        why: "does not hold on the reference day",
      });
    }
  }

  // The variant as it runs on `today`.
  const offset = offsetOf(clock);
  const note = (path: string, from: string, to: string) => {
    replacements.push({ path, from, to });
    return to;
  };
  const whole = (s: string, path: string): string | undefined => {
    if (!s.startsWith("@") || anchorOf(s) === undefined) return undefined;
    const time = ANCHOR_MOMENT.exec(s)?.[3];
    const day = isoOf(anchorDay(s.replace(/T.*$/, ""), today));
    return note(path, s, time === undefined ? day : `${day}T${time}${offset}`);
  };
  const text = (s: string, path: string, form: (n: number) => string) =>
    s.replace(PLACEHOLDER, (all, a: string) =>
      ANCHOR.test(a) ? note(path, all, form(anchorDay(a, today))) : all,
    );
  const moveCall = (c: Obj, path: string): Obj => {
    const dates = strings(c["params"] ?? {}, `${path}.params`)
      .filter(([, s]) => s.startsWith("@") && anchorOf(s) !== undefined)
      .map(([, s]) => anchorDay(s.replace(/T.*$/, ""), today));
    const params = mapStrings(c["params"] ?? {}, `${path}.params`, (s, p) => {
      const w = whole(s, p);
      if (w !== undefined) return w;
      const out = text(s, p, spoken);
      if (!new RegExp(WEEKDAY.source).test(out)) return out;
      // A weekday in a text goes with the call's one date.
      if (dates.length !== 1) {
        unknown.push({
          path: p,
          text: s,
          why: `a weekday in a call with ${dates.length} dates: which one it goes with is not known`,
        });
        return out;
      }
      const ch = WEEKDAY_CHARS[parts(dates[0] as number).w] as string;
      return out.replace(new RegExp(WEEKDAY.source, "g"), (all, word: string, was: string) => {
        const to = `${word}${was === "天" && ch === "日" ? "天" : ch}`;
        return to === all ? all : note(p, all, to);
      });
    });
    return { ...c, params };
  };

  const out: Obj = { ...v, clock: note("clock", clock, isoOf(today) + clock.slice(10)) };
  const fixture = (v["fixture"] ?? {}) as Obj;
  out["fixture"] = {
    ...fixture,
    ...(fixture["seed"] !== undefined
      ? { seed: (fixture["seed"] as Obj[]).map((c, i) => moveCall(c, `fixture.seed[${i}]`)) }
      : {}),
  };
  out["steps"] = ((v["steps"] ?? []) as Obj[]).map((s, i) => {
    if (typeof s["user"] === "string") {
      return { ...s, user: text(s["user"], `steps[${i}].user`, spoken) };
    }
    if (Array.isArray(s["script"])) {
      return {
        ...s,
        script: (s["script"] as Obj[]).map((c, j) => moveCall(c, `steps[${i}].script[${j}]`)),
      };
    }
    return s;
  });
  if (v["assert"] !== undefined) {
    out["assert"] = mapStrings(
      v["assert"],
      "assert",
      (s, p) => whole(s, p) ?? text(s, p, monthDay),
    );
  }

  return {
    variant: out,
    replacements: replacements.filter((r) => r.from !== r.to),
    unknown,
    reference: isoOf(reference),
    today: isoOf(today),
    bases: {
      today: isoOf(today),
      month: isoOf(anchorDay("@month", today)),
      week: isoOf(anchorDay("@week", today)),
    },
    uses,
    runsWhen,
  };
}

const describe = (r: Relation) =>
  [
    r.date,
    r.order,
    ...(r.months !== undefined ? [`${r.months} months`] : []),
    ...(r.weeks !== undefined ? [`${r.weeks} weeks`] : []),
  ].join(", ");

/** Why the variant cannot run with `today` (a day number), if it cannot. */
export function cannotRunAnchored(v: Obj, today: number): string[] {
  const r = anchored(v, today);
  return [
    ...r.uses
      .filter((u) => !u.same)
      .map(
        (u) =>
          `${u.anchor} (${u.paths[0]}): on the reference day ${describe(u.reference)}; on ${r.today} ${describe(u.today)}`,
      ),
    ...r.runsWhen
      .filter((w) => !w.today)
      .map((w) => `runs_when ${w.condition} does not hold on ${r.today}`),
  ];
}

/** The next `n` days after `today` (exclusive) the variant can run on, within a year. */
export function nextAnchoredDays(v: Obj, today: string, n = 3): string[] {
  const from = dayOf(today);
  const out: string[] = [];
  for (let t = from + 1; t <= from + 366 && out.length < n; t++) {
    if (cannotRunAnchored(v, t).length === 0) out.push(isoOf(t));
  }
  return out;
}
