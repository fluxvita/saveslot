// The upgrade steps: the kernel's list chains from the oldest upgradable format to its own.

import { describe, expect, it } from "vitest";
import { STORAGE_FORMAT_VERSION } from "./format-v1.ts";
import {
  OLDEST_UPGRADABLE_FORMAT,
  transactionControl,
  UPGRADE_STEPS,
  upgradePath,
} from "./upgrade.ts";

describe("upgrade steps", () => {
  it("the kernel's steps go from the oldest upgradable format to its own, one each", () => {
    expect(upgradePath(OLDEST_UPGRADABLE_FORMAT, STORAGE_FORMAT_VERSION)).toHaveLength(
      STORAGE_FORMAT_VERSION - OLDEST_UPGRADABLE_FORMAT,
    );
    expect(UPGRADE_STEPS.every((s) => s.from >= OLDEST_UPGRADABLE_FORMAT)).toBe(true);
  });

  it("a path is the steps in order; a missing or doubled step is an error", () => {
    const steps = [
      { from: 5, sql: "A" },
      { from: 6, sql: "B" },
    ];
    expect(upgradePath(5, 7, steps).map((s) => s.sql)).toEqual(["A", "B"]);
    expect(upgradePath(6, 7, steps).map((s) => s.sql)).toEqual(["B"]);
    expect(upgradePath(7, 7, steps)).toEqual([]);
    expect(() => upgradePath(5, 8, steps)).toThrow("0 steps from format 7");
    expect(() => upgradePath(5, 6, [...steps, { from: 5, sql: "C" }])).toThrow(
      "2 steps from format 5",
    );
  });

  it("a step that controls its transaction is an error, wherever in the list", () => {
    for (const sql of [
      "CREATE TABLE a (x int); COMMIT; CREATE TABLE b (x int);",
      "begin; CREATE TABLE a (x int)",
      "CREATE TABLE a (x int);\n  rollback",
      "SAVEPOINT s; CREATE TABLE a (x int); RELEASE s",
      "START  TRANSACTION",
      "end;",
      "/* c */ COMMIT",
      "PREPARE TRANSACTION 'p'",
    ]) {
      expect(transactionControl(sql), sql).not.toEqual([]);
      expect(
        () =>
          upgradePath(6, 7, [
            { from: 5, sql },
            { from: 6, sql: "A" },
          ]),
        sql,
      ).toThrow("the step from format 5 controls its transaction");
    }
  });

  it("transaction words in comments, literals, identifiers and function bodies are not statements", () => {
    for (const sql of [
      "",
      "CREATE TABLE a (x int); -- then COMMIT;\nINSERT INTO a VALUES (1)",
      "/* COMMIT; */ CREATE TABLE a (x int)",
      "INSERT INTO t VALUES ('a; COMMIT; b'), ('it''s; END')",
      'CREATE TABLE "commit" (x int); ALTER TABLE "commit" ADD COLUMN "end" int',
      "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;",
      "CREATE FUNCTION g() RETURNS int LANGUAGE plpgsql AS $b$ BEGIN RETURN 1; END; $b$",
      "UPDATE meta SET value = 'x' WHERE key = 'committed'",
    ]) {
      expect(transactionControl(sql), sql).toEqual([]);
    }
  });
});
