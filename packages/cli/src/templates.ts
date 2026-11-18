// The schema templates the CLI ships (docs/zh-CN/spec/06-cli.md §3.1), as the spec writes them:
// a test compares each with its JSON block there. `saveslot slot create --template` replaces the
// slot name and the time zone with the command line's and submits the document as a new slot.
// Their descriptions are the spec's (in Chinese): the schema text a user gets, not the CLI's own.

/** A template: its name, and the schema document. */
export interface Template {
  readonly name: string;
  readonly document: Readonly<Record<string, unknown>>;
}

/** The templates, by name, in the order the spec lists them. */
export const TEMPLATES: ReadonlyMap<string, Template> = new Map<string, Template>([
  [
    "running",
    {
      name: "running",
      document: {
        slot: "health",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "runs",
            kind: "base",
            description: "每次跑步一行",
            time: {
              type: "event",
              field: "date",
            },
            fields: [
              {
                name: "date",
                type: "date",
                required: true,
                description: "跑步当天（slot 时区的自然日）",
              },
              {
                name: "distance",
                type: "quantity",
                unit: "km",
                required: true,
                min: 0,
                description: "距离",
              },
              {
                name: "duration",
                type: "quantity",
                unit: "min",
                min: 0,
                description: "用时",
              },
              {
                name: "feeling",
                type: "text",
                description: "跑后感受，用户原话",
              },
            ],
            duplicate_keys: [["date", "distance"]],
          },
          {
            name: "weekly_mileage",
            kind: "derived",
            description: "每周跑量与记录覆盖，周一起算。某一周没有行表示那一周没有任何跑步记录",
            rule: {
              sql: "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM runs GROUP BY 1",
              time_dependency: "bucketed",
            },
            fields: [
              {
                name: "week_start",
                description: "该周周一",
              },
              {
                name: "total_distance",
                description: "该周总距离（km）；只含已记录的跑步",
              },
              {
                name: "run_count",
                description: "该周跑步次数",
              },
              {
                name: "days_recorded",
                description: "该周有跑步记录的天数（一周 7 天；不是每天都该跑，少于 7 不代表漏记）",
              },
              {
                name: "first_date",
                description: "该周第一条记录的日期",
              },
              {
                name: "last_date",
                description: "该周最后一条记录的日期",
              },
            ],
          },
        ],
      },
    },
  ],
  [
    "spending",
    {
      name: "spending",
      document: {
        slot: "ledger",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "expenses",
            kind: "base",
            description: "每笔支出一行",
            time: {
              type: "event",
              field: "date",
            },
            fields: [
              {
                name: "date",
                type: "date",
                required: true,
                description: "支出当天（slot 时区的自然日）",
              },
              {
                name: "category",
                type: "text",
                required: true,
                description: "类别，如餐饮、交通",
              },
              {
                name: "amount",
                type: "quantity",
                unit: "CNY",
                required: true,
                min: 0,
                description: "金额",
              },
              {
                name: "note",
                type: "text",
                description: "备注",
              },
            ],
            duplicate_keys: [["date", "category", "amount"]],
          },
          {
            name: "monthly_total",
            kind: "derived",
            description: "每月支出合计与记录覆盖。某个月没有行表示那个月没有任何支出记录",
            rule: {
              sql: "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
              time_dependency: "bucketed",
            },
            fields: [
              {
                name: "month",
                description: "该月第一天",
              },
              {
                name: "total",
                description: "该月支出合计（CNY）；只含已记录的支出",
              },
              {
                name: "days_recorded",
                description: "该月有支出记录的天数（不是每天都有支出，少于当月天数不代表漏记）",
              },
              {
                name: "first_date",
                description: "该月第一条记录的日期",
              },
              {
                name: "last_date",
                description: "该月最后一条记录的日期",
              },
            ],
          },
        ],
      },
    },
  ],
  [
    "budget",
    {
      name: "budget",
      document: {
        slot: "plan",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "budgets",
            kind: "base",
            description: "各类别的月度预算",
            time: {
              type: "state",
              granularity: "date",
            },
            entity_key: ["category"],
            fields: [
              {
                name: "category",
                type: "text",
                required: true,
                description: "预算类别",
              },
              {
                name: "amount",
                type: "quantity",
                unit: "CNY",
                required: true,
                min: 0,
                description: "月度预算金额",
              },
            ],
          },
        ],
      },
    },
  ],
]);

/**
 * A template's document for a new slot named `slot` (06 §3 step 4): no base version, the time zone
 * given, or this computer's (then `chosen` says which). Undefined for a name that is no template.
 */
export function templateDocument(
  name: string,
  slot: string,
  timezone?: string,
): { readonly doc: Record<string, unknown>; readonly chosen?: string } | undefined {
  const t = TEMPLATES.get(name);
  if (t === undefined) return undefined;
  const doc = structuredClone(t.document) as Record<string, unknown>;
  doc["slot"] = slot;
  doc["base_version"] = null;
  if (timezone !== undefined) {
    doc["timezone"] = timezone;
    return { doc };
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  doc["timezone"] = local;
  return { doc, chosen: local };
}

/** The slot a template makes when its slot is not named (`setup`): the one its document names. */
export const templateSlot = (name: string): string | undefined =>
  TEMPLATES.get(name)?.document["slot"] as string | undefined;
