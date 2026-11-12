// Storage format v1 DDL applied on PGlite.

import { PGlite } from "@electric-sql/pglite";
import { formatV1Ddl, KERNEL_TABLES, SESSION_SETTINGS } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  for (const s of SESSION_SETTINGS) await db.exec(s);
  await db.exec(formatV1Ddl());
});

afterAll(async () => {
  await db.close();
});

describe("storage format v1 on PGlite", () => {
  it("runs a PostgreSQL release the architecture supports", async () => {
    const r = await db.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    // §8: PGlite 18.6 and later.
    expect(Number(r.rows[0]?.v)).toBeGreaterThanOrEqual(180006);
  });

  it("has the fixed session settings and a UTF8 database", async () => {
    const r = await db.query<{ enc: string; tz: string; ds: string }>(
      "SELECT current_setting('server_encoding') AS enc, current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds",
    );
    expect(r.rows[0]).toEqual({ enc: "UTF8", tz: "UTC", ds: "ISO, YMD" });
  });

  it("creates every kernel table", async () => {
    const r = await db.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(r.rows.map((x) => x.name)).toEqual(KERNEL_TABLES.map((t) => t.name).sort());
  });

  it("sorts text by code point, not by a locale", async () => {
    await db.exec(
      "INSERT INTO meta (key, value) VALUES ('b', '1'), ('B', '1'), ('a', '1'), ('é', '1'), ('_', '1')",
    );
    const r = await db.query<{ key: string }>(
      "SELECT key FROM meta WHERE key IN ('b','B','a','é','_') ORDER BY key",
    );
    expect(r.rows.map((x) => x.key)).toEqual(["B", "_", "a", "b", "é"]);
  });

  it("rejects a content block whose body and checksum disagree", async () => {
    await expect(
      db.query("INSERT INTO content (seq, path, body) VALUES (1, 'text', '{}')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        "INSERT INTO content (seq, path, body, checksum, removed_by) VALUES (1, 'text', '{}', 'x', 9)",
      ),
    ).rejects.toThrow(/check constraint/);
    await db.query("INSERT INTO content (seq, path, removed_by) VALUES (1, 'text', 9)");
  });
});
