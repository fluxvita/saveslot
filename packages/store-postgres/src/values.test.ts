// The same statements on PGlite and through this backend give the same JavaScript values: the
// kernel reads them as they are, so replay on the two is the same only if these are
// (02-architecture §8, §11 «测试矩阵»). Values are compared with their prototypes, not by `==`.

import { PGlite } from "@electric-sql/pglite";
import { SESSION_SETTINGS, type SqlValue } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgresTenantStore } from "./backend.ts";
import { PostgresStoreError } from "./errors.ts";
import { testCell, testPostgres } from "./testing/test-postgres.fixture.ts";
import { affectedRows, arrayText, parameter, parseArray } from "./values.ts";

const T = 60_000;

/** A value with what `toEqual` does not tell apart: its class, a Date's instant, a bigint. */
function shape(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return `bigint ${v}`;
  if (typeof v === "number") return `number ${Object.is(v, -0) ? "-0" : String(v)}`;
  if (typeof v !== "object") return `${typeof v} ${String(v)}`;
  const cls = Object.getPrototypeOf(v)?.constructor?.name ?? "no prototype";
  if (v instanceof Date) return `${cls} ${Number.isNaN(v.getTime()) ? "invalid" : v.toISOString()}`;
  if (v instanceof Uint8Array) return `${cls} ${Buffer.from(v).toString("hex")}`;
  if (Array.isArray(v)) return [cls, ...v.map(shape)];
  return [cls, ...Object.entries(v).map(([k, x]) => [k, shape(x)])];
}

describe("the parts that need no server", () => {
  it("an array's text: elements, NULL, quotes and escapes, nesting, the empty array", () => {
    const n = (s: string) => +s;
    expect(parseArray("{1,2,3}", n, 1016)).toEqual([1, 2, 3]);
    expect(parseArray("{NULL,1}", n, 1007)).toEqual([null, 1]);
    expect(parseArray("{}", n, 1007)).toEqual([]);
    expect(parseArray("{{1,2},{3,4}}", n, 1007)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parseArray('{a,"b c","d\\"e","f\\\\g","NULL",""}', undefined, 1009)).toEqual([
      "a",
      "b c",
      'd"e',
      "f\\g",
      "NULL",
      "",
    ]);
  });

  it("a parameter: bytes as bytes over the same memory, nothing as NULL, every other value by its text", () => {
    expect(parameter(null)).toBeNull();
    expect(parameter(undefined)).toBeNull();
    expect(parameter("x")).toBe("x");
    expect(parameter(7)).toBe("7");
    expect(parameter(2n ** 62n)).toBe("4611686018427387904");
    expect(parameter(true)).toBe("true");
    expect(parameter(new Date("2026-11-18T01:02:03.004Z"))).toBe("2026-11-18T01:02:03.004Z");
    const bytes = new Uint8Array([0, 1, 2, 255]).subarray(1, 3);
    const sent = parameter(bytes) as Buffer;
    expect([...sent]).toEqual([1, 2]);
  });

  it("an array parameter: its text, every element quoted and escaped, an absent one null", () => {
    expect(arrayText([])).toBe("{}");
    expect(arrayText([1, 2n, "3"])).toBe('{"1","2","3"}');
    expect(arrayText(["a b", 'c"d', "e\\f", "", "NULL", "x,y", "{z}"])).toBe(
      '{"a b","c\\"d","e\\\\f","","NULL","x,y","{z}"}',
    );
    expect(arrayText([null, undefined, "n"])).toBe('{null,null,"n"}');
    expect(arrayText([[1, 2], [3]])).toBe('{{"1","2"},{"3"}}');
    expect(arrayText([true, false])).toBe('{"true","false"}');
    expect(arrayText([new Uint8Array([1, 255])])).toBe('{"\\\\x01ff"}');
    expect(parameter(["a", "b"])).toBe('{"a","b"}');
  });

  it("rows changed: the count of a command that changes rows, 0 of any other", () => {
    expect(affectedRows("INSERT", 3)).toBe(3);
    expect(affectedRows("UPDATE", 0)).toBe(0);
    expect(affectedRows("DELETE", 2)).toBe(2);
    expect(affectedRows("SELECT", 5)).toBe(0);
    expect(affectedRows("CREATE", null)).toBe(0);
    expect(affectedRows(null, null)).toBe(0);
  });
});

const cell = testCell();

describe.skipIf(cell === undefined)("the same values as PGlite", () => {
  const pg = testPostgres(cell);
  let lite: PGlite;
  let store: PostgresTenantStore;
  let messagesInEnglish = true;

  beforeAll(async () => {
    lite = await PGlite.create();
    for (const s of SESSION_SETTINGS) await lite.exec(s);
    store = await pg.backend.open(pg.ref(pg.name()), { create: true });
    // PGlite's messages are the untranslated ones; a server's follow its lc_messages, which only
    // a superuser can set.
    const lc = await store.read((tx) =>
      tx.query<{ m: string }>("SELECT current_setting('lc_messages') AS m"),
    );
    messagesInEnglish = /^(C|POSIX|en_)/.test(lc.rows[0]?.m ?? "");
  }, T);
  afterAll(async () => {
    await store?.close();
    await lite?.close();
  }, T);

  type Outcome =
    | { rows: unknown[]; affectedRows: number | undefined }
    | { sqlState: string | undefined; message: string };

  const onLite = async (sql: string, params: readonly SqlValue[]): Promise<Outcome> => {
    try {
      const r = await lite.query(sql, [...params]);
      return { rows: r.rows, affectedRows: r.affectedRows };
    } catch (e) {
      return { sqlState: (e as { code?: string }).code, message: (e as Error).message };
    }
  };
  const onPostgres = async (sql: string, params: readonly SqlValue[]): Promise<Outcome> => {
    try {
      // A write transaction, so that the statements that change rows run too.
      return await store.write(async (tx) => {
        const r = await tx.query(sql, params);
        return { rows: [...r.rows], affectedRows: r.affectedRows };
      });
    } catch (e) {
      if (!(e instanceof PostgresStoreError)) throw e;
      return { sqlState: e.sqlState, message: e.message };
    }
  };

  /** Runs `sql` on both and holds them to the same outcome; returns PGlite's. */
  async function same(sql: string, params: readonly SqlValue[] = []): Promise<Outcome> {
    const a = await onLite(sql, params);
    const b = await onPostgres(sql, params);
    if (!("rows" in a) && !("rows" in b) && !messagesInEnglish) {
      // A server that words its messages in another language: the SQLSTATE is what is the same.
      expect(b.sqlState, sql).toBe(a.sqlState);
      return a;
    }
    expect(shape(b), sql).toEqual(shape(a));
    expect(b, sql).toStrictEqual(a);
    return a;
  }

  const rowsOf = (o: Outcome): Record<string, unknown>[] => {
    if (!("rows" in o)) throw new Error(`refused: ${o.message}`);
    return o.rows as Record<string, unknown>[];
  };

  it(
    "integers: a number while exact, a bigint beyond",
    async () => {
      const r = rowsOf(
        await same(`SELECT 1::int2 AS a, 2::int4 AS b, 3::int8 AS c, 9007199254740991::int8 AS d,
          9007199254740992::int8 AS e, (-9007199254740992)::int8 AS f,
          9223372036854775807::int8 AS g, 7::oid AS h, count(*) AS n, sum(x) AS s, avg(x) AS m
          FROM (VALUES (1::int8), (2)) t(x)`),
      )[0];
      // What the kernel was written against, said once here.
      expect(r?.["c"]).toBe(3);
      expect(r?.["d"]).toBe(9007199254740991);
      expect(r?.["e"]).toBe(9007199254740992n);
      expect(r?.["n"]).toBe(2);
      expect(r?.["s"]).toBe("3");
    },
    T,
  );

  it(
    "decimals stay text, digits and all",
    async () => {
      const r = rowsOf(
        await same(`SELECT 1.50::numeric AS a, 0.0000001::numeric AS b, 1e30::numeric AS c,
          'NaN'::numeric AS d, 123456789012345678901234567890.123456789::numeric AS e,
          1::numeric / 3 AS f, round(2.5) AS g, 10::numeric / 4 AS h, (-0.0)::numeric AS i,
          1.50::numeric(10, 4) AS j, trunc(1.999, 2) AS k, mod(7.5, 2) AS l`),
      )[0];
      expect(r?.["a"]).toBe("1.50");
    },
    T,
  );

  it(
    "floating point, with its specials",
    async () => {
      await same(`SELECT 0.1::float8 + 0.2::float8 AS a, 'NaN'::float8 AS b, 'Infinity'::float8 AS c,
        '-Infinity'::float8 AS d, 1e300::float8 AS e, 1.5::float4 AS f, 0.1::float4 AS g,
        '-0'::float8 AS h, 1e-320::float8 AS i`);
    },
    T,
  );

  it(
    "booleans and nulls of each type",
    async () => {
      await same(`SELECT true AS a, false AS b, NULL::boolean AS c, NULL::text AS d, NULL::int8 AS e,
        NULL::numeric AS f, NULL::date AS g, NULL::timestamptz AS h, NULL::bytea AS i,
        NULL::jsonb AS j, NULL::int8[] AS k, NULL AS l`);
    },
    T,
  );

  it(
    "text of every kind, and the types that have no parser",
    async () => {
      await same(`SELECT 'a' AS a, '' AS b, E'tab\\tnew\\nline' AS c, '中文' AS d, '😀' AS e,
        'x'::varchar(5) AS f, 'x'::char(3) AS g, 'x'::"char" AS h, 'n'::name AS i,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS j, '192.168.0.1'::inet AS k,
        '12:34:56'::time AS l, '1 day 02:03:04'::interval AS m, '1 year 2 mons'::interval AS n,
        '12:34:56+08'::timetz AS o, '(1,2)'::point AS p, B'101' AS q`);
    },
    T,
  );

  it(
    "dates and instants",
    async () => {
      const r = rowsOf(
        await same(`SELECT '2026-11-18'::date AS a, '0001-01-01'::date AS b, 'infinity'::date AS c,
          '-infinity'::date AS d, '2026-11-18 01:02:03.123456+08'::timestamptz AS e,
          '2026-11-18 01:02:03'::timestamp AS f, 'infinity'::timestamptz AS g,
          '0044-03-15 BC'::date AS h, '1969-12-31 23:59:59.999+00'::timestamptz AS i,
          '294276-12-31'::date AS j, '2026-11-18 01:02:03.9999995+00'::timestamptz AS k`),
      )[0];
      expect(r?.["a"]).toEqual(new Date("2026-11-18T00:00:00.000Z"));
      expect(r?.["e"]).toEqual(new Date("2026-11-17T17:02:03.123Z"));
      expect(r?.["c"]).toBe(Infinity);
    },
    T,
  );

  it(
    "what the kernel asks of instants in SQL, a zone's name among it",
    async () => {
      await same(`SELECT
        to_char('2026-11-18 01:02:03.123456+08'::timestamptz AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a,
        '2026-11-18 01:02:03.5+08'::timestamptz::text AS b,
        date_trunc('month', '2026-11-18 01:02:03+08'::timestamptz) AS c,
        extract(epoch FROM '2026-11-18 01:02:03.25+00'::timestamptz) AS d,
        extract(year FROM '2026-11-18'::date) AS e,
        make_date(2026, 2, 28) + 1 AS f,
        '2026-11-18'::date::text AS g,
        ('2026-11-18'::date - '2026-01-01'::date) AS h,
        '2026-03-29 02:30 Europe/Berlin'::timestamptz AS i,
        '2026-10-25 02:30 Europe/Berlin'::timestamptz AS j,
        '2026-11-18 12:00 Asia/Shanghai'::timestamptz AS k,
        '1900-01-01 00:00 Asia/Shanghai'::timestamptz AS l,
        '2026-11-18 12:00+00'::timestamptz AT TIME ZONE 'America/Sao_Paulo' AS m,
        current_setting('TimeZone') AS n, current_setting('DateStyle') AS o,
        current_setting('IntervalStyle') AS p`);
    },
    T,
  );

  it(
    "numbers written out by to_char: no locale's separators or currency",
    async () => {
      await same(`SELECT to_char(1234567.891::numeric, 'FM9G999G999D000') AS a,
        to_char(12.5, 'L99D9') AS b, to_char(-1234, '9,999PR') AS c,
        to_char('2026-11-18'::date, 'TMDay TMMonth') AS d, 1234567.5::numeric::text AS e`);
    },
    T,
  );

  it(
    "JSON: parsed, key order as stored, large numbers as JavaScript reads them",
    async () => {
      await same(`SELECT '{"a":1,"b":[1,2,{"c":null}],"n":12345678901234567890}'::jsonb AS a,
        '{"b":1,"a":2}'::json AS b, '"s"'::jsonb AS c, 'null'::jsonb AS d, '1.0'::json AS e,
        '[]'::jsonb AS f, '{"k":"\\u00e9😀"}'::jsonb AS g, to_jsonb(1.50::numeric) AS h,
        jsonb_build_object('t', '2026-11-18 01:02:03+08'::timestamptz) AS i`);
    },
    T,
  );

  it(
    "bytes",
    async () => {
      const r = rowsOf(
        await same(`SELECT '\\x'::bytea AS a, '\\x00ff10'::bytea AS b, 'abc'::bytea AS c,
          sha256('abc'::bytea) AS d`),
      )[0];
      expect(Object.getPrototypeOf(r?.["b"])).toBe(Uint8Array.prototype);
    },
    T,
  );

  it(
    "arrays: elements by their type's parser, text for a type without one",
    async () => {
      await same(`SELECT ARRAY[1, 2, 3]::int8[] AS a, ARRAY[9007199254740993]::int8[] AS b,
        ARRAY['a', 'b c', 'd"e', 'f\\g', 'NULL', '', 'x,y', '{z}']::text[] AS c,
        ARRAY[NULL, 1]::int4[] AS d, ARRAY[[1, 2], [3, 4]] AS e, ARRAY[true, false] AS f,
        ARRAY[1.50, 2]::numeric[] AS g, ARRAY['2026-11-18'::date] AS h, '{}'::int4[] AS i,
        ARRAY['{"a":1}'::jsonb, '[1,"x"]'::jsonb] AS j, ARRAY[1.5::float8, 'NaN'] AS k,
        ARRAY['2026-11-18 01:02:03+08'::timestamptz] AS l, ARRAY['\\x01ff'::bytea] AS m,
        ARRAY['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid] AS n, ARRAY[NULL]::text[] AS o,
        ARRAY['中', '😀']::text[] AS p, '[2:3]={7,8}'::int4[] AS q, ARRAY['x'::varchar] AS r,
        ARRAY[1::int2] AS s, ARRAY['1 day'::interval] AS t`);
    },
    T,
  );

  it(
    "rows: column names, repeated names, no name, no row, many rows in order",
    async () => {
      await same("SELECT 1 AS a, 2 AS a, 3");
      await same("SELECT 1 AS a WHERE false");
      await same("SELECT g AS n, g::text AS t FROM generate_series(1, 300) g ORDER BY g");
      await same('SELECT 1 AS "Mixed Case", 2 AS "__proto__", 3 AS "constructor"');
    },
    T,
  );

  it(
    "parameters of every kind the port takes",
    async () => {
      await same(
        `SELECT $1::text AS t, $2::int8 AS i, $3::int8 AS big, $4::boolean AS b, $5::bytea AS by,
           $6::text AS n, $7::numeric AS num, $8::float8 AS f, $9::date AS d,
           $10::timestamptz AS ts, $11::jsonb AS j`,
        [
          "x",
          7,
          2n ** 62n,
          true,
          new Uint8Array([0, 255]),
          null,
          "1.50",
          0.1,
          "2026-11-18",
          "2026-11-18T01:02:03.123Z",
          '{"a":[1,2]}',
        ],
      );
      // Where the statement gives the parameter its type.
      await same("SELECT $1 = 'a' AS eq, length($2) AS len, $3 + 1 AS n", ["a", "中文😀", 41]);
      await same("SELECT $1::text AS n, $2::text AS b, $3::text AS big", [42, false, -(2n ** 62n)]);
      await same("SELECT $1::int8 AS v", ["9007199254740993"]);
      await same("SELECT $1::bytea AS v", [new Uint8Array(0)]);
      // Arrays, which the kernel passes though the port's type does not name them.
      const arr = (v: unknown) => v as SqlValue;
      await same("SELECT $1::int8[] AS a, $2::text[] AS t, $3::int8[] AS e", [
        arr([1, 2, 9007199254740993n]),
        arr(["a b", 'c"d', "e\\f", "", "NULL", "x,y", "{z}", "中😀"]),
        arr([]),
      ]);
      await same("SELECT g FROM generate_series(1, 6) g WHERE g = ANY($1) ORDER BY g", [
        arr([2, 4, 9]),
      ]);
      await same("SELECT v FROM (VALUES ('a'), ('b'), ('c')) t(v) WHERE v = ANY($1) ORDER BY v", [
        arr(["c", "a", "zz"]),
      ]);
      await same("SELECT $1::text[] AS t, $2::int4[] AS n, $3::boolean[] AS b", [
        arr([null, "x", undefined]),
        arr([
          [1, 2],
          [3, 4],
        ]),
        arr([true, false]),
      ]);
      await same("SELECT $1::text AS nothing", [arr(undefined)]);
    },
    T,
  );

  it(
    "rows changed, for each command; a statement that returns rows gives both",
    async () => {
      for (const s of [lite, store] as const) {
        const ddl = "CREATE TABLE probe (id BIGINT PRIMARY KEY, v TEXT)";
        if (s === lite) await lite.exec(ddl);
        else await store.write((tx) => tx.exec(ddl));
      }
      expect(await same("INSERT INTO probe VALUES (1, 'a'), (2, 'b'), (3, 'c')")).toMatchObject({
        affectedRows: 3,
      });
      expect(await same("UPDATE probe SET v = 'z' WHERE id > $1", [1])).toMatchObject({
        affectedRows: 2,
      });
      await same("UPDATE probe SET v = 'y' WHERE id > 100");
      await same("SELECT id, v FROM probe ORDER BY id");
      await same("INSERT INTO probe VALUES (4, 'd') RETURNING id, v");
      await same("INSERT INTO probe VALUES (4, 'd') ON CONFLICT (id) DO NOTHING");
      await same("DELETE FROM probe WHERE id IN (1, 2) RETURNING id");
      expect(await same("DELETE FROM probe")).toMatchObject({ affectedRows: 2 });
    },
    T,
  );

  it(
    "a statement the database refuses: the same SQLSTATE, and the same message where the server's are in English",
    async () => {
      const refused = async (sql: string, params: readonly SqlValue[] = []) => {
        const o = await same(sql, params);
        if ("rows" in o) throw new Error(`not refused: ${sql}`);
        return o.sqlState;
      };
      expect(await refused("SELECT 1 / 0")).toBe("22012");
      expect(await refused("SELECT 'x'::int8")).toBe("22P02");
      expect(await refused("SELECT 99999999999::int4")).toBe("22003");
      expect(await refused("SELECT '2026-02-30'::date")).toBe("22008");
      expect(await refused("SELECT * FROM no_such_table")).toBe("42P01");
      expect(await refused("SELEC 1")).toBe("42601");
      expect(await refused("INSERT INTO probe VALUES (9, 'a'), (9, 'b')")).toBe("23505");
      expect(await refused("INSERT INTO probe VALUES (NULL, 'a')")).toBe("23502");
      // One statement to a query, on both: a script is `exec`'s.
      expect(await refused("SELECT 1; SELECT 2")).toBe("42601");
      expect(await refused("SELECT $1::int8", ["x"])).toBe("22P02");
    },
    T,
  );

  const WORDS = [
    "a",
    "B",
    "b",
    "A",
    "Z",
    "_",
    "~",
    "",
    " ",
    "é",
    "É",
    "z",
    "ä",
    "中",
    "文",
    "😀",
    "a😀",
    "ab",
    "aB",
    "Ab",
    "ａ",
    "1",
    "10",
    "2",
    "ß",
    "ss",
    "İ",
    "i",
    "ı",
    "\u{10FFFF}",
    "￿",
  ];

  it(
    'the order of text: by code point, with or without COLLATE "C", from a value list and from columns',
    async () => {
      const values = WORDS.map((_, i) => `($${i + 1})`).join(", ");
      const plain = rowsOf(await same(`SELECT v FROM (VALUES ${values}) t(v) ORDER BY v`, WORDS));
      await same(`SELECT v FROM (VALUES ${values}) t(v) ORDER BY v COLLATE "C"`, WORDS);
      await same(`SELECT v FROM (VALUES ${values}) t(v) ORDER BY v DESC, length(v)`, WORDS);
      // Code point order is byte order in UTF-8.
      const bytes = [...WORDS].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      expect(plain.map((r) => r["v"])).toEqual(bytes);

      const ddl = 'CREATE TABLE words (c TEXT COLLATE "C", d TEXT)';
      await lite.exec(ddl);
      await store.write((tx) => tx.exec(ddl));
      await same(`INSERT INTO words SELECT v, v FROM (VALUES ${values}) t(v)`, WORDS);
      await same("SELECT c FROM words ORDER BY c");
      await same("SELECT d FROM words ORDER BY d");
      await same("SELECT min(d) AS lo, max(d) AS hi, min(c) AS clo, max(c) AS chi FROM words");
      await same("SELECT d FROM words WHERE d > 'a' AND d < 'b' ORDER BY d");
      await same("SELECT DISTINCT d FROM words ORDER BY d");
      await same("SELECT d, count(*)::int4 AS n FROM words GROUP BY d ORDER BY d");
    },
    T,
  );

  it(
    "text functions of the restricted SQL: counted by character",
    async () => {
      const values = WORDS.map((_, i) => `($${i + 1})`).join(", ");
      await same(
        `SELECT v, length(v) AS len, char_length(v) AS clen, substr(v, 1, 1) AS first,
           left(v, 1) AS l, right(v, 1) AS r, strpos(v, 'b') AS pos, starts_with(v, 'a') AS sw,
           btrim(v) AS bt, replace(v, 'a', 'x') AS rep, split_part(v, 'b', 1) AS sp,
           octet_length(v) AS bytes
         FROM (VALUES ${values}) t(v) ORDER BY v`,
        WORDS,
      );
    },
    T,
  );

  it(
    "letters' case and classes (outside the restricted SQL): where the two differ, said here",
    async () => {
      // Not `same`: PGlite classifies characters by its C library's C.UTF-8, this backend's
      // databases by PostgreSQL's own Unicode tables (the builtin provider). The restricted SQL
      // has none of these functions; the differences are listed so that a new one is seen.
      const values = WORDS.map((_, i) => `($${i + 1})`).join(", ");
      const sql = `SELECT v, upper(v) AS up, lower(v) AS lo, initcap(v) AS cap,
           v ~ '^\\w+$' AS word, v ~* '^[a-z]+$' AS az, v ILIKE 'A%' AS ilike
         FROM (VALUES ${values}) t(v) ORDER BY v`;
      const a = rowsOf(await onLite(sql, WORDS));
      const b = rowsOf(await onPostgres(sql, WORDS));
      expect(b.map((r) => r["v"])).toEqual(a.map((r) => r["v"]));
      const differ: string[] = [];
      a.forEach((row, i) => {
        for (const [k, v] of Object.entries(row)) {
          const other = b[i]?.[k];
          if (other !== v) differ.push(`${k}(${row["v"]}): PGlite ${v}, PostgreSQL ${other}`);
        }
      });
      // German sharp s: the C library gives it the capital letter U+1E9E, Unicode's simple case
      // mapping (the builtin provider's) leaves it as it is.
      expect(differ).toEqual(["up(ß): PGlite ẞ, PostgreSQL ß", "cap(ß): PGlite ẞ, PostgreSQL ß"]);
    },
    T,
  );
});
