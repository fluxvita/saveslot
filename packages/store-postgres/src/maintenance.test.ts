// The process's turns at the cell's maintenance database (./maintenance.ts): creations one at a time
// and drops one at a time, first come first served, each apart from the other; a creation waiting
// past its time refused with `maintenance_busy` and out of the line; a drop waits its turn. No
// database: the turns are what is checked.

import { afterEach, describe, expect, it } from "vitest";
import { PostgresStoreError } from "./errors.ts";
import { maintenanceForTests, withCreationTurn, withDropTurn } from "./maintenance.ts";

afterEach(() => {
  maintenanceForTests.waitMs = undefined;
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { opened, open };
}

describe("the maintenance database's turn", () => {
  it("one at a time, in the order they came", async () => {
    const order: string[] = [];
    const first = gate();
    const a = withCreationTurn(async () => {
      order.push("a in");
      await first.opened;
      order.push("a out");
    });
    const b = withCreationTurn(async () => {
      order.push("b in");
    });
    const c = withCreationTurn(async () => {
      order.push("c in");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["a in"]);
    first.open();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a in", "a out", "b in", "c in"]);
  });

  it("one waiting past its time: maintenance_busy, nothing run, and out of the line", async () => {
    maintenanceForTests.waitMs = 50;
    const first = gate();
    const a = withCreationTurn(() => first.opened);
    let ran = false;
    const late = withCreationTurn(async () => {
      ran = true;
    });
    await expect(late).rejects.toSatisfy(
      (e) => e instanceof PostgresStoreError && e.code === "maintenance_busy",
    );
    expect(ran).toBe(false);
    // The turn after a goes to the next one asking, not to the one that gave up.
    first.open();
    await a;
    let next = false;
    await withCreationTurn(async () => {
      next = true;
    });
    expect(next).toBe(true);
  });

  it("drops take their own turn: a slow drop holds back no creation, and a drop waits without a limit", async () => {
    maintenanceForTests.waitMs = 50;
    const drop = gate();
    const slow = withDropTurn(() => drop.opened);
    // A creation goes on while the drop waits for its checkpoint.
    expect(await withCreationTurn(async () => "created")).toBe("created");
    // Another drop waits past the creations' limit, and then runs.
    let second = false;
    const next = withDropTurn(async () => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(second).toBe(false);
    drop.open();
    await Promise.all([slow, next]);
    expect(second).toBe(true);
  });

  it("a turn whose work fails is given back all the same", async () => {
    await expect(withCreationTurn(() => Promise.reject(new Error("refused")))).rejects.toThrow(
      "refused",
    );
    expect(await withCreationTurn(async () => "next")).toBe("next");
  });
});
