// Experiment 9 shapes: the schema documents and deterministic generators of the write requests.
// Every generator is a function of its seed: the same seed gives the same requests.

/** A small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
export const dayOf = (start: string, n: number) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// --- C: minute series --------------------------------------------------------------------------

export const SENSOR = {
  slot: "sensor",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "readings",
      kind: "base",
      description: "one reading a minute",
      time: { type: "event", field: "day" },
      fields: [
        { name: "day", type: "date", required: true, description: "the day" },
        {
          name: "minute",
          type: "integer",
          required: true,
          min: 0,
          max: 1439,
          description: "minute of the day",
        },
        { name: "value", type: "decimal", scale: 2, required: true, description: "the reading" },
      ],
    },
    {
      name: "daily",
      kind: "derived",
      description: "per day",
      rule: {
        sql: "SELECT day, count(*) AS n, sum(value) AS total, min(value) AS low, max(value) AS high FROM readings GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "day", description: "the day" },
        { name: "n", description: "readings" },
        { name: "total", description: "sum" },
        { name: "low", description: "lowest" },
        { name: "high", description: "highest" },
      ],
    },
    {
      name: "monthly",
      kind: "derived",
      description: "per month",
      rule: {
        sql: "SELECT date_trunc('month', day::timestamp)::date AS month, count(*) AS n, sum(value) AS total FROM readings GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "month", description: "first day of the month" },
        { name: "n", description: "readings" },
        { name: "total", description: "sum" },
      ],
    },
  ],
};

/** Rows `from`..`from+n-1` of the minute series, as one write request. */
export function readings(from: number, n: number, seed: number) {
  const r = rng(seed ^ from);
  const ops = [];
  for (let i = from; i < from + n; i++) {
    ops.push({
      intent: "insert",
      table: "sensor.readings",
      set: {
        day: dayOf("2016-01-01", Math.floor(i / 1440)),
        minute: String(i % 1440),
        value: (50 + r() * 100).toFixed(2),
      },
    });
  }
  return { sv: 1, evidence: [{ kind: "tool_result", text: `readings ${from}+${n}` }], ops };
}

// --- the shapes the runner drives ---------------------------------------------------------------

type Obj = Record<string, unknown>;
type Op = Obj;
export interface Receipt {
  readonly ops: readonly {
    readonly target: { row?: string; entity?: string };
    readonly ver: string;
  }[];
}

/** What the runner needs of a shape. Units are rows (C, C-state: segments) or events (A, B). */
export interface Shape {
  readonly name: string;
  readonly documents: readonly Obj[];
  readonly unit: "rows" | "events";
  /** The next build request, of at most `n` units of work; and how many rows it adds. */
  build(n: number): { params: Obj; rows: number };
  /** Called with every request written and its receipt, in order. */
  seen(params: Obj, r: Receipt): void;
  /** A request inserting `n` new rows (the write probes). */
  insert(n: number): Obj;
  /** A request correcting `n` sampled rows; undefined while there is nothing to correct. */
  correct(n: number): Obj | undefined;
  /** Read probes: name → query params. */
  reads(): Record<string, Obj>;
  /** History as_of probe target (`as_of` is added by the runner). */
  historyTarget(): Obj | undefined;
}

const req = (sv: number, text: string, ops: Op[]): Obj => ({
  sv,
  evidence: [{ kind: "tool_result", text }],
  ops,
});

/** Rows kept for corrections (every `every`-th row written), with their last `ver`. */
class Sample {
  readonly rows: { table: string; row: string; ver: string }[] = [];
  readonly #every: number;
  #seen = 0;
  constructor(every: number) {
    this.#every = every;
  }
  /** Updates vers of known rows; adds every `every`-th inserted row. */
  seen(params: Obj, r: Receipt): void {
    const ops = params["ops"] as Op[];
    r.ops.forEach((o, i) => {
      const p = ops[i] as Op;
      const id = o.target.row ?? o.target.entity;
      if (id === undefined) return;
      if (p["intent"] === "insert") {
        if (this.#seen++ % this.#every === 0)
          this.rows.push({ table: p["table"] as string, row: id, ver: o.ver });
        return;
      }
      const k = this.rows.findIndex((x) => x.row === id);
      if (k < 0) return;
      if (p["intent"] === "revoke") this.rows.splice(k, 1);
      else (this.rows[k] as { ver: string }).ver = o.ver;
    });
  }
  /** `n` distinct sampled rows (of one table when `table` is given). */
  pick(n: number, r: () => number, table?: string) {
    const pool = table === undefined ? this.rows : this.rows.filter((x) => x.table === table);
    const out = new Set<(typeof pool)[number]>();
    for (let tries = 0; out.size < Math.min(n, pool.length) && tries < n * 20; tries++)
      out.add(pool[Math.floor(r() * pool.length)] as (typeof pool)[number]);
    return [...out];
  }
}

export class ShapeC implements Shape {
  readonly name = "C";
  readonly documents = [SENSOR];
  readonly unit = "rows" as const;
  #rows = 0;
  readonly #seed: number;
  readonly #r: () => number;
  readonly #sample = new Sample(100);
  /** `start`: rows already in the store (resume.ts), so new rows continue the sequence. */
  constructor(seed: number, start = 0) {
    this.#seed = seed;
    this.#r = rng(seed * 31);
    this.#rows = start;
  }
  /** Adds a row already in the store to the correction sample (resume.ts). */
  sampled(row: string, ver: string) {
    this.#sample.rows.push({ table: "sensor.readings", row, ver });
  }
  build(n: number) {
    const k = Math.min(1000, n);
    return { params: this.insert(k), rows: k };
  }
  seen(params: Obj, r: Receipt) {
    this.#sample.seen(params, r);
  }
  insert(n: number) {
    const p = readings(this.#rows, n, this.#seed);
    this.#rows += n;
    return p;
  }
  correct(n: number) {
    const rows = this.#sample.pick(n, this.#r);
    if (rows.length === 0) return undefined;
    return req(
      1,
      "fix",
      rows.map((x) => ({
        intent: "correct",
        table: "sensor.readings",
        row: x.row,
        ver: x.ver,
        set: { value: (50 + this.#r() * 100).toFixed(2) },
      })),
    );
  }
  reads() {
    const last = dayOf("2016-01-01", Math.floor((this.#rows - 1) / 1440));
    const mid = dayOf("2016-01-01", Math.floor(this.#rows / 2880));
    return {
      plain_day: { table: "sensor.readings", where: [{ field: "day", op: "=", value: mid }] },
      range: { table: "sensor.readings", valid_during: [mid, last] },
      derived_daily: { table: "sensor.daily", where: [{ field: "day", op: ">=", value: mid }] },
      derived_monthly: { table: "sensor.monthly" },
    };
  }
  historyTarget() {
    const s = this.#sample.rows[Math.floor(this.#sample.rows.length / 2)];
    return s && { table: "sensor.readings", row: s.row };
  }
}

// --- C-state: a state table, segments by entity ---------------------------------------------------

export const DEVICES = {
  slot: "devices",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "status",
      kind: "base",
      description: "a device's level, from a day on",
      time: { type: "state", granularity: "date" },
      entity_key: ["device"],
      fields: [
        { name: "device", type: "text", required: true, description: "device name" },
        { name: "level", type: "decimal", scale: 2, required: true, description: "level" },
      ],
    },
  ],
};

export class ShapeCState implements Shape {
  readonly name = "C-state";
  readonly documents = [DEVICES];
  readonly unit = "rows" as const;
  readonly #entities: number;
  /** device index → entity ID and ver, once created; and the next segment's day per device. */
  readonly #ent = new Map<number, { entity: string; ver: string }>();
  readonly #day: number[];
  #next = 0;
  readonly #r: () => number;
  constructor(seed: number, entities = 1000) {
    this.#entities = entities;
    this.#day = new Array(entities).fill(0);
    this.#r = rng(seed * 17);
  }
  #op(d: number): Op {
    const e = this.#ent.get(d);
    const day = dayOf("2000-01-01", this.#day[d] as number);
    this.#day[d] = (this.#day[d] as number) + 1;
    const set = { level: (this.#r() * 100).toFixed(2) };
    return e === undefined
      ? {
          intent: "update",
          table: "devices.status",
          entity_key: { device: `d${d}` },
          valid_from: day,
          set,
        }
      : {
          intent: "update",
          table: "devices.status",
          entity: e.entity,
          ver: e.ver,
          valid_from: day,
          set,
        };
  }
  build(n: number) {
    const k = Math.min(1000, n, this.#entities);
    const ops: Op[] = [];
    for (let i = 0; i < k; i++) ops.push(this.#op((this.#next + i) % this.#entities));
    this.#next = (this.#next + k) % this.#entities;
    return { params: req(1, "levels", ops), rows: k };
  }
  seen(params: Obj, r: Receipt) {
    const ops = params["ops"] as Op[];
    r.ops.forEach((o, i) => {
      const p = ops[i] as Op;
      const key = p["entity_key"] as { device: string } | undefined;
      const d = key
        ? Number(key.device.slice(1))
        : [...this.#ent].find(([, v]) => v.entity === p["entity"])?.[0];
      if (d !== undefined && o.target.entity)
        this.#ent.set(d, { entity: o.target.entity, ver: o.ver });
    });
  }
  insert(n: number) {
    return this.build(n).params;
  }
  correct(n: number) {
    // A retroactive change: the level of one device from an earlier day on.
    const ops: Op[] = [];
    for (let i = 0; i < n; i++) {
      const d = Math.floor(this.#r() * this.#entities);
      const e = this.#ent.get(d);
      if (!e) continue;
      const back = Math.floor(this.#r() * (this.#day[d] as number));
      ops.push({
        intent: "correct",
        table: "devices.status",
        entity: e.entity,
        ver: e.ver,
        valid_from: dayOf("2000-01-01", back),
        valid_to: dayOf("2000-01-01", back + 1),
        set: { level: (this.#r() * 100).toFixed(2) },
      });
    }
    return ops.length ? req(1, "fix", ops) : undefined;
  }
  reads() {
    const e = this.#ent.get(0);
    const mid = dayOf("2000-01-01", Math.floor((this.#day[0] as number) / 2));
    return {
      valid_at_all: { table: "devices.status", valid_at: mid },
      one_entity_all_segments: e
        ? {
            table: "devices.status",
            where: [{ field: "device", op: "=", value: "d0" }],
            valid_during: ["2000-01-01", null],
          }
        : { table: "devices.status" },
    };
  }
  historyTarget() {
    const e = this.#ent.get(0);
    return e && { table: "devices.status", entity: e.entity };
  }
}

// --- A: human rhythm, the eval fixtures' three slots ------------------------------------------------

export class ShapeA implements Shape {
  readonly name = "A";
  readonly unit = "events" as const;
  readonly documents: readonly Obj[];
  readonly #r: () => number;
  readonly #sample = new Sample(10);
  #runs = 0;
  #spend = 0;
  readonly #budget = new Map<number, { entity: string; ver: string }>();
  readonly #budgetDay = new Array(30).fill(0) as number[];
  constructor(seed: number, documents: readonly Obj[]) {
    this.documents = documents;
    this.#r = rng(seed * 13);
  }
  #run(): Op {
    const n = this.#runs++;
    return {
      intent: "insert",
      table: "health.runs",
      set: {
        date: dayOf("2000-01-01", Math.floor(n / 1000)),
        distance: { value: (3 + (n % 1000) / 100).toFixed(2), unit: "km" },
        duration: { value: String(20 + Math.floor(this.#r() * 60)), unit: "min" },
        feeling: "ok",
      },
    };
  }
  #expense(): Op {
    const n = this.#spend++;
    const cats = ["餐饮", "交通", "日用", "娱乐", "医疗", "教育", "住房", "其他"];
    return {
      intent: "insert",
      table: "ledger.expenses",
      set: {
        date: dayOf("2000-01-01", Math.floor(n / 200)),
        category: cats[n % 8],
        amount: { value: (1 + (n % 200) + this.#r()).toFixed(2), unit: "CNY" },
      },
    };
  }
  #fix(table: string, revoke: boolean): Op | undefined {
    const [x] = this.#sample.pick(1, this.#r, table);
    if (!x) return undefined;
    if (revoke) return { intent: "revoke", table, row: x.row, ver: x.ver };
    const set =
      table === "health.runs"
        ? { feeling: `better ${Math.floor(this.#r() * 1000)}` }
        : { note: `fixed ${Math.floor(this.#r() * 1000)}` };
    return { intent: "correct", table, row: x.row, ver: x.ver, set };
  }
  #budgetOp(c: number): Op {
    const e = this.#budget.get(c);
    const day = dayOf("2000-01-01", (this.#budgetDay[c] as number) * 7);
    this.#budgetDay[c] = (this.#budgetDay[c] as number) + 1;
    const set = { amount: { value: String(1000 + Math.floor(this.#r() * 5000)), unit: "CNY" } };
    return e === undefined
      ? {
          intent: "update",
          table: "plan.budgets",
          entity_key: { category: `c${c}` },
          valid_from: day,
          set,
        }
      : {
          intent: "update",
          table: "plan.budgets",
          entity: e.entity,
          ver: e.ver,
          valid_from: day,
          set,
        };
  }
  build(n: number) {
    const k = Math.min(1000, n);
    const u = this.#r();
    const ops: Op[] = [];
    if (u < 0.1) {
      for (let c = 0; c < Math.min(30, k); c++) ops.push(this.#budgetOp(c));
    } else {
      const table = u < 0.6 ? "ledger.expenses" : "health.runs";
      const used = new Set<string>();
      while (ops.length < k) {
        const v = this.#r();
        const fix = v < 0.1 ? this.#fix(table, v < 0.03) : undefined;
        const row = fix?.["row"] as string | undefined;
        if (fix && row && !used.has(row)) {
          used.add(row);
          ops.push(fix);
        } else ops.push(table === "health.runs" ? this.#run() : this.#expense());
      }
    }
    return {
      params: req(1, "batch", ops),
      rows: ops.filter((o) => o["intent"] === "insert").length,
    };
  }
  seen(params: Obj, r: Receipt) {
    this.#sample.seen(params, r);
    const ops = params["ops"] as Op[];
    r.ops.forEach((o, i) => {
      const p = ops[i] as Op;
      if (p["table"] !== "plan.budgets" || !o.target.entity) return;
      const key = p["entity_key"] as { category: string } | undefined;
      const c = key
        ? Number(key.category.slice(1))
        : [...this.#budget].find(([, v]) => v.entity === p["entity"])?.[0];
      if (c !== undefined) this.#budget.set(c, { entity: o.target.entity, ver: o.ver });
    });
  }
  insert(n: number) {
    const ops: Op[] = [];
    for (let i = 0; i < n; i++) ops.push(this.#expense());
    return req(1, "probe", ops);
  }
  correct(n: number) {
    const ops = this.#sample.pick(n, this.#r, "ledger.expenses").map((x) => ({
      intent: "correct",
      table: x.table,
      row: x.row,
      ver: x.ver,
      set: { note: "probe" },
    }));
    return ops.length ? req(1, "fix", ops) : undefined;
  }
  reads() {
    const mid = dayOf("2000-01-01", Math.floor(this.#spend / 400));
    return {
      plain_day: { table: "ledger.expenses", where: [{ field: "date", op: "=", value: mid }] },
      derived_monthly: { table: "ledger.monthly_total" },
      derived_weekly: { table: "health.weekly_mileage" },
      state_valid_at: { table: "plan.budgets", valid_at: mid },
    };
  }
  historyTarget() {
    const s = this.#sample.rows.find((x) => x.table === "ledger.expenses");
    return s && { table: s.table, row: s.row };
  }
}

// --- B: health data at summary grain, 10 years -------------------------------------------------------

const METRICS = [
  "steps",
  "resting_hr",
  "hrv",
  "sleep_min",
  "deep_min",
  "kcal",
  "weight",
  "body_fat",
  "spo2",
  "stress",
];

export const BODY = {
  slot: "body",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "daily",
      kind: "base",
      description: "one row a day: the day's summary metrics",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        ...METRICS.map((m) => ({ name: m, type: "decimal", scale: 2, description: m })),
      ],
    },
    {
      name: "activities",
      kind: "base",
      description: "one row an activity",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "kind", type: "text", required: true, description: "kind" },
        { name: "duration", type: "quantity", unit: "min", description: "duration" },
        { name: "distance", type: "quantity", unit: "km", description: "distance" },
      ],
    },
    {
      name: "weekly",
      kind: "derived",
      description: "per week",
      rule: {
        sql: `SELECT date_trunc('week', date::timestamp)::date AS week, ${METRICS.map((m) => `avg(${m}) AS ${m}`).join(", ")} FROM daily GROUP BY 1`,
        time_dependency: "bucketed",
      },
      fields: [
        { name: "week", description: "monday" },
        ...METRICS.map((m) => ({ name: m, description: m })),
      ],
    },
    {
      name: "monthly",
      kind: "derived",
      description: "per month",
      rule: {
        sql: "SELECT date_trunc('month', date::timestamp)::date AS month, count(*) AS n, sum(duration) AS minutes, sum(distance) AS km FROM activities GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "month", description: "first day" },
        { name: "n", description: "activities" },
        { name: "minutes", description: "minutes" },
        { name: "km", description: "km" },
      ],
    },
  ],
};

export class ShapeB implements Shape {
  readonly name = "B";
  readonly documents = [BODY];
  readonly unit = "rows" as const;
  readonly #r: () => number;
  readonly #sample = new Sample(10);
  #day = 0;
  constructor(seed: number) {
    this.#r = rng(seed * 7);
  }
  #daily(d: number): Op {
    const set: Obj = { date: dayOf("2016-01-01", d) };
    for (const m of METRICS) set[m] = (this.#r() * 100).toFixed(2);
    return { intent: "insert", table: "body.daily", set };
  }
  #activity(d: number): Op {
    return {
      intent: "insert",
      table: "body.activities",
      set: {
        date: dayOf("2016-01-01", d),
        kind: this.#r() < 0.5 ? "run" : "ride",
        duration: { value: String(20 + Math.floor(this.#r() * 90)), unit: "min" },
        distance: { value: (2 + this.#r() * 30).toFixed(2), unit: "km" },
      },
    };
  }
  /** One day's sync: the summary row and 0–2 activities. */
  build(_n: number) {
    const d = this.#day++;
    const ops = [this.#daily(d)];
    const a = Math.floor(this.#r() * 3);
    for (let i = 0; i < a; i++) ops.push(this.#activity(d));
    // B counts days, not rows: its points are days of sync.
    return { params: req(1, `sync ${d}`, ops), rows: 1 };
  }
  seen(params: Obj, r: Receipt) {
    this.#sample.seen(params, r);
  }
  insert(n: number) {
    const ops: Op[] = [];
    for (let i = 0; i < n; i++) ops.push(this.#activity(this.#day));
    return req(1, "probe", ops);
  }
  correct(n: number) {
    const ops = this.#sample.pick(n, this.#r, "body.daily").map((x) => ({
      intent: "correct",
      table: x.table,
      row: x.row,
      ver: x.ver,
      set: { steps: (this.#r() * 100).toFixed(2) },
    }));
    return ops.length ? req(1, "fix", ops) : undefined;
  }
  reads() {
    const mid = dayOf("2016-01-01", Math.floor(this.#day / 2));
    return {
      plain_day: { table: "body.daily", where: [{ field: "date", op: "=", value: mid }] },
      range_year: {
        table: "body.activities",
        valid_during: [mid, dayOf("2016-01-01", Math.floor(this.#day / 2) + 365)],
      },
      derived_weekly: { table: "body.weekly" },
      derived_monthly: { table: "body.monthly" },
    };
  }
  historyTarget() {
    const s = this.#sample.rows[0];
    return s && { table: s.table, row: s.row };
  }
}
