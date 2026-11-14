// The unit vocabulary `units@1` (docs/zh-CN/spec/03-data-model/10-types-and-units.md «单位词表»):
// a fixed list of codes, each with its dimension and its factor to the dimension's base unit.
// Currencies and temperatures are each a dimension of their own and have no factor.

import type { CompiledUnit } from "@fluxvita/saveslot-contract-core";
import { CURRENCY_MINOR_UNITS } from "./units-currency.ts";

/** Codes with a factor, by dimension: code → factor to the base unit (an exact decimal). */
const CONVERTIBLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  length: {
    mm: "0.001",
    cm: "0.01",
    m: "1",
    km: "1000",
    in: "0.0254",
    ft: "0.3048",
    yd: "0.9144",
    mi: "1609.344",
  },
  mass: {
    ug: "0.000001",
    mg: "0.001",
    g: "1",
    kg: "1000",
    oz: "28.349523125",
    lb: "453.59237",
  },
  duration: { ms: "0.001", s: "1", min: "60", h: "3600", d: "86400", wk: "604800" },
  volume: { mL: "0.001", L: "1", floz: "0.0295735295625" },
  energy: { J: "1", kJ: "1000", cal: "4.184", kcal: "4184" },
  frequency: { "/d": "1", "/h": "24", "/min": "1440", "/s": "86400" },
  speed: { "km/h": "1", "m/s": "3.6", "mi/h": "1.609344" },
  dimensionless: { "1": "1", "%": "0.01" },
};

/** Temperature codes: each its own dimension `temperature:<code>`, not converted in v1. */
const TEMPERATURES = ["Cel", "degF", "K"] as const;

const UNITS: ReadonlyMap<string, CompiledUnit> = new Map([
  ...Object.entries(CONVERTIBLE).flatMap(([dimension, codes]) =>
    Object.entries(codes).map(([code, to_base]): [string, CompiledUnit] => [
      code,
      { code, dimension, to_base: to_base as CompiledUnit["to_base"] & string },
    ]),
  ),
  ...TEMPERATURES.map((code): [string, CompiledUnit] => [
    code,
    { code, dimension: `temperature:${code}` },
  ]),
  ...Object.keys(CURRENCY_MINOR_UNITS).map((code): [string, CompiledUnit] => [
    code,
    { code, dimension: `currency:${code}` },
  ]),
]);

/** The unit of a code (case-sensitive), or undefined when the code is not in `units@1`. */
export function unitOf(code: string): CompiledUnit | undefined {
  return UNITS.get(code);
}

/** Every code of `units@1`. */
export function unitCodes(): readonly string[] {
  return [...UNITS.keys()];
}

/** The default scale of a quantity field in `unit` (10 «精度与舍入»): a currency's minor unit, else 6. */
export function defaultScale(unit: CompiledUnit): number {
  return unit.dimension.startsWith("currency:") ? (CURRENCY_MINOR_UNITS[unit.code] ?? 6) : 6;
}

/**
 * Written forms of the units (10 «单位同义表»), used here only to suggest a code for a unit that is
 * not one. Latin letters compare without case.
 */
const SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  CNY: ["元", "块", "块钱", "圆", "人民币", "RMB", "¥", "￥"],
  USD: ["美元", "美金", "dollar", "dollars", "$"],
  EUR: ["欧元", "euro", "euros", "€"],
  JPY: ["日元", "円", "yen"],
  HKD: ["港币", "港元", "HK$"],
  GBP: ["英镑", "pound", "pounds", "£"],
  km: ["公里", "千米"],
  m: ["米", "meter", "meters"],
  cm: ["厘米", "公分"],
  mm: ["毫米"],
  mi: ["英里", "mile", "miles"],
  ft: ["英尺", "foot", "feet"],
  in: ["英寸", "inch", "inches"],
  yd: ["码", "yard", "yards"],
  kg: ["公斤", "千克"],
  g: ["克"],
  mg: ["毫克"],
  ug: ["微克", "µg", "μg", "mcg"],
  lb: ["磅", "lbs", "pound", "pounds"],
  oz: ["盎司"],
  h: ["小时", "钟头", "hr", "hrs", "hour", "hours"],
  min: ["分钟", "分", "mins", "minute", "minutes"],
  s: ["秒", "秒钟", "sec", "secs"],
  ms: ["毫秒"],
  d: ["天", "日", "day", "days"],
  wk: ["周", "星期", "礼拜", "week", "weeks"],
  L: ["升"],
  mL: ["毫升"],
  floz: ["液量盎司", "液体盎司", "盎司", "fl oz", "fl. oz.", "oz"],
  kcal: ["千卡", "大卡"],
  cal: ["卡"],
  kJ: ["千焦"],
  J: ["焦", "焦耳"],
  "/min": ["次/分", "次/分钟", "每分钟", "bpm"],
  "/s": ["每秒"],
  "/h": ["每小时"],
  "/d": ["每天"],
  "km/h": ["公里/小时", "公里每小时", "kph"],
  "m/s": ["米/秒", "米每秒"],
  "mi/h": ["英里/小时", "mph"],
  "%": ["％", "percent"],
  Cel: ["度", "摄氏度", "℃", "°C"],
  degF: ["华氏度", "℉", "°F"],
  K: ["开"],
};

const foldLatin = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Codes to suggest for a unit that is not in `units@1` (10 «单位词表»: `unit_unknown` with the
 * candidates of the same kind): codes equal to it without case, and codes one of whose written
 * forms it is. Sorted; empty when nothing matches.
 */
export function unitCandidates(text: string): string[] {
  const t = foldLatin(text.trim());
  const out = new Set<string>();
  for (const code of UNITS.keys()) if (foldLatin(code) === t) out.add(code);
  for (const [code, forms] of Object.entries(SPELLINGS)) {
    if (forms.some((f) => foldLatin(f) === t)) out.add(code);
  }
  return [...out].sort();
}
