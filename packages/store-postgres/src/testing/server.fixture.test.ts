// How the test databases are dropped (./server.fixture.ts): several at once, every one of them,
// whatever one of them does. No server: the statements are given to a stand-in.

import { describe, expect, it } from "vitest";
import { DROPS_AT_ONCE, dropDatabases } from "./server.fixture.ts";

const CELL = { host: "nowhere.invalid", user: "nobody" };

/** A stand-in for `sqlOn`: each statement takes `ms`; the ones named in `failing` fail. */
function standIn(ms: number, failing: readonly string[] = []) {
  const seen: { database: string; text: string }[] = [];
  let now = 0;
  let most = 0;
  const run = async (_: unknown, database: string, text: string) => {
    seen.push({ database, text });
    most = Math.max(most, ++now);
    await new Promise((r) => setTimeout(r, ms));
    now--;
    if (failing.some((f) => text.includes(`"${f}"`))) throw new Error("refused");
    return { rows: [], command: "DROP DATABASE", rowCount: null } as never;
  };
  return { run: run as never, seen, most: () => most };
}

describe("dropping a run's test databases", () => {
  it("drops each, on the maintenance database, several at once and no more than DROPS_AT_ONCE", async () => {
    const names = Array.from({ length: 3 * DROPS_AT_ONCE + 1 }, (_, i) => `sst_x_${i}`);
    const s = standIn(5);
    await dropDatabases(CELL, names, s.run);
    expect(s.seen.map((x) => x.text).sort()).toEqual(
      names.map((n) => `DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).sort(),
    );
    expect(new Set(s.seen.map((x) => x.database))).toEqual(new Set(["postgres"]));
    expect(s.most()).toBe(DROPS_AT_ONCE);
  });

  it("a drop that fails does not stop the others, and the first failure is given back", async () => {
    const names = ["sst_x_a", "sst_x_b", "sst_x_c"];
    const s = standIn(1, ["sst_x_a"]);
    const error = await dropDatabases(CELL, names, s.run);
    expect(error?.message).toBe("refused");
    expect(s.seen.map((x) => x.text)).toHaveLength(3);
  });

  it("nothing to drop: nothing run", async () => {
    const s = standIn(1);
    await dropDatabases({ ...CELL, maintenanceDatabase: "maint" }, [], s.run);
    expect(s.seen).toEqual([]);
  });

  it("the cell's maintenance database, when it names one", async () => {
    const s = standIn(1);
    await dropDatabases({ ...CELL, maintenanceDatabase: "maint" }, ["sst_x_a"], s.run);
    expect(s.seen).toEqual([
      { database: "maint", text: 'DROP DATABASE IF EXISTS "sst_x_a" WITH (FORCE)' },
    ]);
  });
});
