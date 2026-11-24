// Two deletions of one row confirmed and cancelled in turn (09 §5.9 `deletion.cancelled` `apply`
// with another deletion pending; 03-deletion «撤回与宽限期»), on three rows: a timeless row
// corrected twice, a timeless row whose correction is undone (an item carried back), a state
// entity over three writes. Each sequence ends in the state its counterpart reaches: a deletion
// confirmed then cancelled leaves the state as before it; with another pending, as that one alone
// leaves it. The whole materialized state is compared (business and version tables, the source
// table, blocks pending, sources, deletions, items), and every sequence is replayed from an empty
// storage with no mismatch. Fictional names.
//
// Not here: two deletions of the same source, and a deletion confirmed after another was
// cancelled compared with it alone; both are open questions of the positions and the
// confirmation's check, not of the cancellation.

import {
  createOpsContext,
  createTenant,
  type ReadTx,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeletionSession } from "./testing/deletion.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 240_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const LUNCH = {
  name: "lunches",
  kind: "base",
  description: "one row per lunch",
  time: { type: "none" },
  fields: [{ name: "amount", type: "text", required: true, description: "what it cost" }],
};
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
};

// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const now = () => `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: now(),
    confirmation: null,
  });
const w = (ops: unknown[], evidence?: string): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    ...(evidence !== undefined ? { evidence: [{ kind: "user_message", text: evidence }] } : {}),
    ops,
  });
const sourceOf = (text: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ seq: unknown }>(
      `SELECT c.seq FROM content c JOIN events e ON e.seq = c.seq
       WHERE e.type = 'source.recorded' AND c.path = 'text' AND c.body LIKE $1`,
      [`%${text}%`],
    );
    if (r.rows.length !== 1) throw new Error(`source ${text}: ${r.rows.length}`);
    return Number(r.rows[0]?.seq);
  });
const compiled = (name: string) =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ body: string }>(
      `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE v.state = 'current'`,
    );
    return (JSON.parse(r.rows[0]?.body as string).tables as Any[]).find((t) => t.name === name);
  });
const slotId = () =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ slot_id: string }>("SELECT slot_id FROM schema_versions LIMIT 1");
    return r.rows[0]?.slot_id as string;
  });

const replaysTheSame = async () => {
  await scratch.reset();
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
};

beforeAll(async () => {
  s = await openReusable("saveslot-deletion-sessions-");
  scratch = await openReusable("saveslot-deletion-sessions-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
const fresh = async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH, BUDGET] },
  });
};

const A = `pi_${"2".repeat(16)}`;
const B = `pi_${"4".repeat(16)}`;
const ID = { A, B };

/** Writes a row; its table, its ID and its three writes' sources. */
type Setup = () => Promise<{ table: Any; row: string; src: Record<string, number> }>;

const lunch3: Setup = async () => {
  const r1 = await w([{ intent: "insert", table: "lunches", set: { amount: "45" } }], "s1 45");
  const row = r1.ops[0].target.row as string;
  await w([{ intent: "correct", table: "lunches", row, set: { amount: "35" } }], "s2 35");
  await w([{ intent: "correct", table: "lunches", row, set: { amount: "30" } }], "s3 30");
  return {
    table: await compiled("lunches"),
    row,
    src: { s1: await sourceOf("s1 45"), s2: await sourceOf("s2 35"), s3: await sourceOf("s3 30") },
  };
};
// A value taken back: #3 undoes the correction, writing 45 back carried from #1.
const lunchUndo: Setup = async () => {
  const r1 = await w([{ intent: "insert", table: "lunches", set: { amount: "45" } }], "s1 45");
  const row = r1.ops[0].target.row as string;
  const r2 = await w(
    [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
    "s2 35",
  );
  await w(
    [{ intent: "correct", table: "lunches", row, ver: r2.ops[0].ver, revert: { undo: r2.seq } }],
    "s3 undo",
  );
  return {
    table: await compiled("lunches"),
    row,
    src: {
      s1: await sourceOf("s1 45"),
      s2: await sourceOf("s2 35"),
      s3: await sourceOf("s3 undo"),
    },
  };
};
const budget3: Setup = async () => {
  const r1 = await w(
    [{ intent: "insert", table: "budget", set: { amount: "100" }, valid_from: "2026-01-01" }],
    "s1 100",
  );
  const row = r1.ops[0].target.entity as string;
  await w(
    [
      {
        intent: "update",
        table: "budget",
        entity: row,
        set: { amount: "200" },
        valid_from: "2026-03-01",
      },
    ],
    "s2 200",
  );
  await w(
    [
      {
        intent: "update",
        table: "budget",
        entity: row,
        set: { amount: "300" },
        valid_from: "2026-02-01",
        valid_to: "2026-05-01",
      },
    ],
    "s3 300",
  );
  return {
    table: await compiled("budget"),
    row,
    src: {
      s1: await sourceOf("s1 100"),
      s2: await sourceOf("s2 200"),
      s3: await sourceOf("s3 300"),
    },
  };
};

const setups: [string, Setup][] = [
  ["lunch3", lunch3],
  ["lunchUndo", lunchUndo],
  ["budget3", budget3],
];
/** Which write's source each deletion deletes. */
const picks: [string, string][] = [
  ["s1", "s2"],
  ["s2", "s1"],
  ["s3", "s2"],
];
type Step = ["+" | "-", "A" | "B"];
/** Each sequence, and the one whose state it must end in (none: the state before any). */
const sequences: [string, Step[], Step[] | null][] = [
  [
    "+A -A",
    [
      ["+", "A"],
      ["-", "A"],
    ],
    null,
  ],
  [
    "+A +B -A = +B",
    [
      ["+", "A"],
      ["+", "B"],
      ["-", "A"],
    ],
    [["+", "B"]],
  ],
  [
    "+A +B -B = +A",
    [
      ["+", "A"],
      ["+", "B"],
      ["-", "B"],
    ],
    [["+", "A"]],
  ],
  [
    "+A +B -A -B",
    [
      ["+", "A"],
      ["+", "B"],
      ["-", "A"],
      ["-", "B"],
    ],
    null,
  ],
  [
    "+A +B -B -A",
    [
      ["+", "A"],
      ["+", "B"],
      ["-", "B"],
      ["-", "A"],
    ],
    null,
  ],
  [
    "+A -A +B -B",
    [
      ["+", "A"],
      ["-", "A"],
      ["+", "B"],
      ["-", "B"],
    ],
    null,
  ],
];

/** Writes the row, then plays `steps`; the state before and after, and the log replayed. */
async function run(setup: Setup, steps: readonly Step[], pick: Record<"A" | "B", string>) {
  await fresh();
  const { table, row, src } = await setup();
  const session = new DeletionSession(s.store, { slot: await slotId(), table, row, actor: USER });
  const before = await snapshot();
  for (const [op, who] of steps) {
    if (op === "+") await session.confirm(ID[who], [src[pick[who]] as number], now());
    else await session.cancel(ID[who], now());
  }
  const after = await snapshot();
  await replaysTheSame();
  return { before, after };
}

/**
 * Known to fail, for a reason outside the cancellation: a deletion confirmed while another is
 * pending lists fewer of an item's blocks (`proposed/0`, `scope_valid`) than it does alone (the
 * positions, `delete/positions.ts`). Each runs as failing (`it.fails`), so it shows when fixed.
 */
const KNOWN = new Set(["budget3, A deletes s3, B s2: +A +B -A = +B"]);

describe("two deletions of one row, confirmed and cancelled in turn", () => {
  for (const [name, setup] of setups) {
    for (const [a, b] of picks) {
      for (const [label, steps, ref] of sequences) {
        const title = `${name}, A deletes ${a}, B ${b}: ${label}`;
        (KNOWN.has(title) ? it.fails : it)(
          title,
          async () => {
            const pick = { A: a, B: b };
            const r = await run(setup, steps, pick);
            const want = ref === null ? r.before : (await run(setup, ref, pick)).after;
            expect(r.after).toEqual(want);
          },
          T,
        );
      }
    }
  }
});

/** The materialized state, deletion event seqs named by their deletion, cancelled ones left out. */
async function snapshot() {
  return s.store.read(async (tx) => {
    const d = await tx.query<{ id: string; state: string; confirmed_seq: unknown }>(
      "SELECT id, state, confirmed_seq FROM deletions ORDER BY id",
    );
    const delSeqs = new Set(
      (
        await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE type IN ('deletion.confirmed','deletion.cancelled')",
        )
      ).rows.map((x) => Number(x.seq)),
    );
    const label = new Map(d.rows.map((x) => [Number(x.confirmed_seq), x.id]));
    const all = async (sql: string) => (await tx.query<Any>(sql)).rows;
    const tables = (
      await all(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 't\\_%' ORDER BY table_name",
      )
    ).map((x: Any) => x.table_name as string);
    const biz: Record<string, unknown> = {};
    for (const t of tables) {
      const rows = await all(`SELECT * FROM "${t}"`);
      biz[t] = rows
        .filter((r: Any) => !t.endsWith("__ver") || r.rec_to === null)
        .map((r: Any) => {
          const o: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r))
            if (!/^(rec_from|rec_to|intent|ver|version_op|op)$/.test(k)) o[k] = v;
          return JSON.stringify(o);
        })
        .sort();
    }
    const cancelledIds = new Map(
      d.rows.filter((x) => x.state === "cancelled").map((x) => [Number(x.confirmed_seq), x.id]),
    );
    const norm = (x: string) =>
      x
        .replace(/"[re]_[0-9A-Z]{26}"/g, '"ROW"')
        .replace(/"pi_(?!2{16}|4{16})[0-9A-Z]{16}"/g, '"ITEM"');
    const j = (rows: readonly Any[]) => rows.map((r) => norm(JSON.stringify(r))).sort();
    for (const t of Object.keys(biz)) biz[t] = (biz[t] as string[]).map(norm).sort();
    return {
      biz,
      // Where an item's content is (`given_seq`, `given_path`) is compared by the content found
      // there, the item's own block when none is named: two blocks giving the same content are the
      // same item (a later deletion restating it judges by either). A block of a cancelled deletion
      // never is. The columns themselves are held by the replay from empty (`reconcileLog`).
      base_sources: j(
        await Promise.all(
          (await all("SELECT * FROM base_sources")).map(async (r: Any) => {
            const g = r.given_seq === null ? null : Number(r.given_seq);
            const { given_seq: _s, given_path: _p, ...rest } = r;
            if (g !== null && cancelledIds.has(g))
              return { ...rest, given: `CANCELLED ${cancelledIds.get(g)}` };
            const at =
              g === null
                ? [Number(r.event_seq), `fields/${r.field_id}/${r.k}`]
                : [g, r.given_path as string];
            const body = (
              await tx.query<{ body: string | null }>(
                "SELECT body FROM content WHERE seq = $1 AND path = $2",
                at,
              )
            ).rows[0]?.body;
            const c = body == null ? null : (JSON.parse(body) as Record<string, unknown>);
            return {
              ...rest,
              given:
                c === null
                  ? null
                  : { value: c["value"], no_value: c["no_value"], uncovered: c["uncovered"] },
            };
          }),
        ),
      ),
      block_deps: j(
        (await all("SELECT * FROM block_deps")).filter((r: Any) => !delSeqs.has(Number(r.seq))),
      ),
      sources: j(await all("SELECT seq, deletion_state FROM sources")),
      pending_blocks: j(
        (await all("SELECT seq, path, deletion_seq FROM pending_blocks"))
          .filter((r: Any) => !cancelledIds.has(Number(r.seq)))
          .map((r: Any) => ({
            seq: label.get(Number(r.seq)) ?? Number(r.seq),
            path: r.path,
            by: label.get(Number(r.deletion_seq)),
          })),
      ),
      deletions: d.rows.filter((x) => x.state !== "cancelled").map((x) => [x.id, x.state]),
      counts: j(await all("SELECT * FROM counts")),
      row_origins: j(await all("SELECT * FROM row_origins")),
      flags: j(await all("SELECT * FROM flags")),
      pending_items: j(await all("SELECT id, state, decision FROM pending_items")),
      external_keys: j(await all("SELECT * FROM external_keys")),
    };
  });
}
