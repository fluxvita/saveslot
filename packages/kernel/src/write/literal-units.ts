// The unit synonym table `units@1`, part of the literal checker `literal@1` (10-types-and-units
// «单位同义表»): the writings of each unit the checker takes in evidence text. Row for row as the
// spec's table, writings as written there (`dollar(s)` for `dollar` and `dollars`); a test reads
// the spec's table and holds this one to it. Changing it is a new checker version.

/** One row of the spec's table: its codes, and for each code its writings. */
export interface SynonymRow {
  readonly codes: readonly string[];
  readonly writings: readonly (readonly string[])[];
}

export const UNIT_SYNONYM_ROWS: readonly SynonymRow[] = [
  { codes: ["CNY"], writings: [["元", "块", "块钱", "圆", "人民币", "RMB", "CNY", "¥", "￥"]] },
  { codes: ["USD"], writings: [["美元", "美金", "USD", "dollar(s)", "$"]] },
  { codes: ["EUR"], writings: [["欧元", "EUR", "euro(s)", "€"]] },
  { codes: ["JPY"], writings: [["日元", "円", "JPY", "yen"]] },
  { codes: ["HKD"], writings: [["港币", "港元", "HKD", "HK$"]] },
  { codes: ["GBP"], writings: [["英镑", "GBP", "pound(s)", "£"]] },
  { codes: ["km"], writings: [["公里", "千米", "km"]] },
  { codes: ["m"], writings: [["米", "m", "meter(s)"]] },
  {
    codes: ["cm", "mm"],
    writings: [
      ["厘米", "公分", "cm"],
      ["毫米", "mm"],
    ],
  },
  {
    codes: ["mi", "ft", "in", "yd"],
    writings: [
      ["英里", "mile(s)", "mi"],
      ["英尺", "foot", "feet", "ft"],
      ["英寸", "inch(es)", "in"],
      ["码", "yard(s)", "yd"],
    ],
  },
  {
    codes: ["kg", "g", "mg"],
    writings: [
      ["公斤", "千克", "kg"],
      ["克", "g"],
      ["毫克", "mg"],
    ],
  },
  { codes: ["ug"], writings: [["微克", "µg", "μg", "ug", "mcg"]] },
  {
    codes: ["lb", "oz"],
    writings: [
      ["磅", "lb", "lbs", "pound(s)"],
      ["盎司", "oz"],
    ],
  },
  {
    codes: ["h", "min", "s", "ms"],
    writings: [
      ["小时", "钟头", "h", "hr(s)", "hour(s)"],
      ["分钟", "分", "min(s)", "minute(s)"],
      ["秒", "秒钟", "s", "sec(s)"],
      ["毫秒", "ms"],
    ],
  },
  {
    codes: ["d", "wk"],
    writings: [
      ["天", "日", "d", "day(s)"],
      ["周", "星期", "礼拜", "wk", "week(s)"],
    ],
  },
  {
    codes: ["L", "mL"],
    writings: [
      ["升", "L"],
      ["毫升", "mL"],
    ],
  },
  {
    codes: ["floz"],
    writings: [["液量盎司", "液体盎司", "盎司", "fl oz", "fl. oz.", "floz", "oz"]],
  },
  {
    codes: ["kcal", "cal", "kJ", "J"],
    writings: [
      ["千卡", "大卡", "kcal"],
      ["卡", "cal"],
      ["千焦", "kJ"],
      ["焦", "焦耳", "J"],
    ],
  },
  {
    codes: ["/min", "/s", "/h", "/d"],
    writings: [
      ["次/分", "次/分钟", "每分钟", "bpm", "/min"],
      ["每秒", "/s"],
      ["每小时", "/h"],
      ["每天", "/d"],
    ],
  },
  {
    codes: ["km/h", "m/s", "mi/h"],
    writings: [
      ["公里/小时", "公里每小时", "km/h", "kph"],
      ["米/秒", "米每秒", "m/s"],
      ["英里/小时", "mph", "mi/h"],
    ],
  },
  { codes: ["%"], writings: [["%", "％", "percent"]] },
  {
    codes: ["Cel", "degF", "K"],
    writings: [
      ["度", "摄氏度", "℃", "°C"],
      ["华氏度", "℉", "°F"],
      ["开", "K"],
    ],
  },
];

/** Currency symbols: the writings that may stand before the number (`¥45`, `$12.5`). */
export const CURRENCY_SYMBOLS: ReadonlySet<string> = new Set(["¥", "￥", "$", "€", "£", "HK$"]);

/** `dollar(s)` → `dollar`, `dollars`; `inch(es)` → `inch`, `inches`; any other as it is. */
export function expandWriting(w: string): string[] {
  const m = /^(.*)\(([a-z]+)\)$/.exec(w);
  return m === null ? [w] : [m[1] as string, `${m[1]}${m[2]}`];
}

const BY_CODE: ReadonlyMap<string, readonly string[]> = new Map(
  UNIT_SYNONYM_ROWS.flatMap((r) =>
    r.codes.map((code, k) => [code, (r.writings[k] ?? []).flatMap(expandWriting)] as const),
  ),
);

/**
 * The writings of a unit's code in evidence: the table's; a currency not in it, only its ISO code;
 * the unit `1` none (the number alone); any other code not in the table, none.
 */
export function writingsOf(code: string, isCurrency: boolean): readonly string[] {
  return BY_CODE.get(code) ?? (isCurrency ? [code] : []);
}
