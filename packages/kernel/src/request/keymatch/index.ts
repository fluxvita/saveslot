// keymatch@1: when two keys are written alike (docs/zh-CN/spec/03-data-model/10-types-and-units.md
// «相近的键»). A hint, not a judgement: nothing here enters the log.
//
// The fold N(s): Unicode NFKC, then simple case folding (CaseFolding C and S), then every
// White_Space code point removed — on the Unicode data of ./data.ts (17.0.0), never the runtime's
// own normalization or locale. Then two keys compare by the first level that holds, lengths in
// code points of the folded forms: `fold` (equal), `affix` (one a prefix or suffix of the other,
// the shorter at least 2), `edit` (the shorter at least 3, the Levenshtein distance over code
// points, no transposition, at most 1; at most 2 when the shorter is at least 8).

import { CCC, COMPOSE, DECOMPOSE, FOLD, WHITE_SPACE } from "./data.ts";

export { UNICODE_VERSION } from "./data.ts";

const parse = (s: string) =>
  s.split(";").map((e) => {
    const [k, v] = e.split("=");
    return [k as string, v as string] as const;
  });
const hex = (s: string) => Number.parseInt(s, 16);

const ccc = new Map(parse(CCC).map(([k, v]) => [hex(k), hex(v)]));
const decompose = new Map(parse(DECOMPOSE).map(([k, v]) => [hex(k), v.split(" ").map(hex)]));
const compose = new Map(
  parse(COMPOSE).map(([k, v]) => [
    k
      .split(" ")
      .map((x) => hex(x))
      .join(" "),
    hex(v),
  ]),
);
const fold = new Map(parse(FOLD).map(([k, v]) => [hex(k), hex(v)]));
const space = new Set(WHITE_SPACE.split(";").map(hex));

// Hangul syllables (Unicode §3.12), by the algorithm.
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

const classOf = (cp: number) => ccc.get(cp) ?? 0;

/** NFKC of a sequence of code points (Unicode §3.11 decomposition, ordering, composition). */
export function nfkc(cps: readonly number[]): number[] {
  // Compatibility decomposition.
  const d: number[] = [];
  for (const cp of cps) {
    const s = cp - S_BASE;
    if (s >= 0 && s < S_COUNT) {
      d.push(L_BASE + Math.floor(s / N_COUNT), V_BASE + Math.floor((s % N_COUNT) / T_COUNT));
      if (s % T_COUNT !== 0) d.push(T_BASE + (s % T_COUNT));
    } else {
      const m = decompose.get(cp);
      if (m === undefined) d.push(cp);
      else d.push(...m);
    }
  }
  // Canonical ordering: each run of non-starters, stably by class.
  for (let i = 0; i < d.length; i++) {
    if (classOf(d[i] as number) === 0) continue;
    let j = i;
    while (j < d.length && classOf(d[j] as number) !== 0) j++;
    const run = d.slice(i, j).map((cp, k) => ({ cp, k }));
    run.sort((a, b) => classOf(a.cp) - classOf(b.cp) || a.k - b.k);
    for (let k = 0; k < run.length; k++) d[i + k] = (run[k] as { cp: number }).cp;
    i = j;
  }
  // Canonical composition.
  const out: number[] = [];
  let starter = -1;
  let lastClass = -1;
  for (const cp of d) {
    const c = classOf(cp);
    if (starter >= 0) {
      const s = out[starter] as number;
      // Hangul: L + V, LV + T.
      const l = s - L_BASE;
      const v = cp - V_BASE;
      const lv = s - S_BASE;
      const t = cp - T_BASE;
      if (lastClass === -1 && l >= 0 && l < L_COUNT && v >= 0 && v < V_COUNT) {
        out[starter] = S_BASE + (l * V_COUNT + v) * T_COUNT;
        continue;
      }
      if (
        lastClass === -1 &&
        lv >= 0 &&
        lv < S_COUNT &&
        lv % T_COUNT === 0 &&
        t > 0 &&
        t < T_COUNT
      ) {
        out[starter] = s + t;
        continue;
      }
      // Not blocked: nothing between, or the last one between of a lower class.
      if (lastClass === -1 || (lastClass !== 0 && lastClass < c)) {
        const composite = compose.get(`${s} ${cp}`);
        if (composite !== undefined) {
          out[starter] = composite;
          continue;
        }
      }
    }
    if (c === 0) {
      starter = out.length;
      lastClass = -1;
    } else lastClass = c;
    out.push(cp);
  }
  return out;
}

/** N(s): NFKC, simple case folding, White_Space removed; as code points. */
export function foldKey(s: string): number[] {
  const cps = nfkc([...s].map((c) => c.codePointAt(0) as number));
  return cps.map((cp) => fold.get(cp) ?? cp).filter((cp) => !space.has(cp));
}

/** Levenshtein distance over code points: insert, delete, substitute 1 each; no transposition. */
export function distance(a: readonly number[], b: readonly number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

export type Match = "fold" | "affix" | "edit";
/** The levels, widest last. */
const LEVELS: readonly Match[] = ["fold", "affix", "edit"];

const startsWith = (a: readonly number[], b: readonly number[]) => b.every((x, i) => a[i] === x);
const endsWith = (a: readonly number[], b: readonly number[]) =>
  b.every((x, i) => a[a.length - b.length + i] === x);

/**
 * The Levenshtein distance when it is at most `k`, else `k + 1`: only the cells within `k` of the
 * diagonal are worked out (a cell further off is more than `k` already), and a row all over `k`
 * ends it. O(n·k) in time, O(k) in space: a row keeps its band only, cell `j` of row `i` at
 * `j - i + k`.
 */
export function distanceWithin(a: readonly number[], b: readonly number[], k: number): number {
  if (Math.abs(a.length - b.length) > k) return k + 1;
  const far = k + 1;
  const w = 2 * k + 1;
  let prev = new Array<number>(w).fill(far);
  let cur = new Array<number>(w).fill(far);
  for (let j = 0; j <= Math.min(k, b.length); j++) prev[j + k] = j;
  for (let i = 1; i <= a.length; i++) {
    cur.fill(far);
    if (i <= k) cur[k - i] = i;
    let least = i <= k ? i : far;
    const from = Math.max(1, i - k);
    const to = Math.min(b.length, i + k);
    for (let j = from; j <= to; j++) {
      const d = j - i + k;
      const v = Math.min(
        (d + 1 < w ? (prev[d + 1] as number) : far) + 1,
        (d > 0 ? (cur[d - 1] as number) : far) + 1,
        (prev[d] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur[d] = v > far ? far : v;
      if (v < least) least = v;
    }
    if (least > k) return far;
    [prev, cur] = [cur, prev];
  }
  const d = prev[b.length - a.length + k] as number;
  return d > k ? far : d;
}

/**
 * How two folded keys compare (code points, as `foldKey` gives them: fold each key once and compare
 * it with many): the first level that holds, and their distance; undefined: not alike. `fold` is
 * equality; `affix`'s distance is the difference in length; `edit` works out the distance only
 * within its threshold.
 */
export function matchFolded(
  x: readonly number[],
  y: readonly number[],
): { match: Match; distance: number } | undefined {
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length === long.length && startsWith(long, short))
    return { match: "fold", distance: 0 };
  if (short.length >= 2 && (startsWith(long, short) || endsWith(long, short)))
    return { match: "affix", distance: long.length - short.length };
  if (short.length < 3) return undefined;
  const k = short.length >= 8 ? 2 : 1;
  const d = distanceWithin(x, y, k);
  return d <= k ? { match: "edit", distance: d } : undefined;
}

/** How two texts compare (`matchFolded` of their folded forms). */
export function matchText(a: string, b: string): { match: Match; distance: number } | undefined {
  return matchFolded(foldKey(a), foldKey(b));
}

/**
 * How two keys of several fields compare (10-types-and-units «多字段的键»): a field not `text` the
 * same value (`equal`, by the same-value criterion), each `text` field the same as written or alike
 * at some level, at least one not the same as written; the key's level the widest of its fields',
 * its distance theirs summed. Undefined: not alike (a key without a `text` field never is).
 */
export function matchKey(
  fields: readonly (
    | {
        readonly text: true;
        readonly a: string;
        readonly b: string;
        /** `a` and `b` folded, when the caller folded them already (`foldKey`). */
        readonly folded?: { readonly a: readonly number[]; readonly b: readonly number[] };
      }
    | { readonly text: false; readonly equal: boolean }
  )[],
): { match: Match; distance: number } | undefined {
  let level = -1;
  let total = 0;
  let differs = false;
  for (const f of fields) {
    if (!f.text) {
      if (!f.equal) return undefined;
      continue;
    }
    if (f.a === f.b) continue;
    const m = f.folded !== undefined ? matchFolded(f.folded.a, f.folded.b) : matchText(f.a, f.b);
    if (m === undefined) return undefined;
    differs = true;
    level = Math.max(level, LEVELS.indexOf(m.match));
    total += m.distance;
  }
  return differs ? { match: LEVELS[level] as Match, distance: total } : undefined;
}
