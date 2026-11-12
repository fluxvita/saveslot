// Experiment 1 workload and checks (pre-dev-w0-experiments 实验 1).
//
// One transaction, shaped like a saveslot write: insert an "event header" row with a monotonic n
// and the previous row's hash, insert a ~1 KB "content" row with a checksum, update one row of a
// "business" table, commit.

import { createHash } from "node:crypto";
import type { ReadTx, TenantStore, Tx } from "@fluxvita/saveslot-kernel";

export const DDL = `
CREATE TABLE IF NOT EXISTS exp_events (n BIGINT PRIMARY KEY, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exp_content (n BIGINT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exp_business (id INT PRIMARY KEY, last_n BIGINT NOT NULL, total BIGINT NOT NULL);
`;

export const GENESIS = "0".repeat(64);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** ~1 KB of content derived from n. */
export function body(n: number): string {
  let s = "";
  let h = sha256(`content-${n}`);
  while (s.length < 1024) {
    s += h;
    h = sha256(h);
  }
  return s.slice(0, 1024);
}

export const hashOf = (prev: string, n: number, checksum: string) =>
  sha256(`${prev}|${n}|${checksum}`);

export async function tail(tx: ReadTx): Promise<{ n: number; hash: string }> {
  const r = await tx.query<{ n: string; hash: string }>(
    "SELECT n::text AS n, hash FROM exp_events ORDER BY exp_events.n DESC LIMIT 1",
  );
  const row = r.rows[0];
  return row ? { n: Number(row.n), hash: row.hash } : { n: 0, hash: GENESIS };
}

/** The body of one workload transaction for event n. */
export async function writeOne(tx: Tx, n: number, prevHash: string): Promise<string> {
  const b = body(n);
  const checksum = sha256(b);
  const hash = hashOf(prevHash, n, checksum);
  await tx.query("INSERT INTO exp_events (n, prev_hash, hash) VALUES ($1, $2, $3)", [
    n,
    prevHash,
    hash,
  ]);
  await tx.query("INSERT INTO exp_content (n, body, checksum) VALUES ($1, $2, $3)", [
    n,
    b,
    checksum,
  ]);
  await tx.query(
    `INSERT INTO exp_business (id, last_n, total) VALUES (1, $1, 1)
     ON CONFLICT (id) DO UPDATE SET last_n = $1, total = exp_business.total + 1`,
    [n],
  );
  return hash;
}

export interface CheckResult {
  /** Checks 2–5 of the experiment; check 1 is "the store opened", check 6 is amcheck. */
  readonly maxN: number;
  readonly confirmed: number;
  readonly lostConfirmed: boolean;
  readonly gaps: number;
  readonly badChain: number;
  readonly badChecksum: number;
  readonly tablesInconsistent: number;
  readonly amcheckErrors: readonly string[];
}

export async function check(store: TenantStore, confirmed: number): Promise<CheckResult> {
  const data = await store.read((tx) => checkData(tx, confirmed));
  return { ...data, amcheckErrors: await amcheck(store) };
}

async function checkData(
  tx: ReadTx,
  confirmed: number,
): Promise<Omit<CheckResult, "amcheckErrors">> {
  const ev = await tx.query<{ n: string; prev_hash: string; hash: string }>(
    "SELECT n::text AS n, prev_hash, hash FROM exp_events ORDER BY exp_events.n",
  );
  const ct = await tx.query<{ n: string; body: string; checksum: string }>(
    "SELECT n::text AS n, body, checksum FROM exp_content ORDER BY exp_content.n",
  );
  const bz = await tx.query<{ last_n: string; total: string }>(
    "SELECT last_n::text AS last_n, total::text AS total FROM exp_business WHERE id = 1",
  );
  const content = new Map(ct.rows.map((r) => [Number(r.n), r]));
  let gaps = 0;
  let badChain = 0;
  let badChecksum = 0;
  let inconsistent = 0;
  let prev = GENESIS;
  let expect = 1;
  for (const r of ev.rows) {
    const n = Number(r.n);
    if (n !== expect) gaps++;
    expect = n + 1;
    const c = content.get(n);
    if (!c) {
      inconsistent++;
      continue;
    }
    if (sha256(c.body) !== c.checksum) badChecksum++;
    if (r.prev_hash !== prev || r.hash !== hashOf(r.prev_hash, n, c.checksum)) badChain++;
    prev = r.hash;
  }
  const maxN = ev.rows.length ? Number(ev.rows[ev.rows.length - 1]?.n) : 0;
  if (ct.rows.length !== ev.rows.length) inconsistent++;
  const b = bz.rows[0];
  if (ev.rows.length > 0) {
    if (!b || Number(b.last_n) !== maxN || Number(b.total) !== ev.rows.length) inconsistent++;
  } else if (b) inconsistent++;

  return {
    maxN,
    confirmed,
    lostConfirmed: maxN < confirmed,
    gaps,
    badChain,
    badChecksum,
    tablesInconsistent: inconsistent,
  };
}

/** Check 6: amcheck over every heap table and B-tree index in the public and catalog schemas. */
async function amcheck(store: TenantStore): Promise<string[]> {
  const amcheckErrors: string[] = [];
  await store.write((tx) => tx.exec("CREATE EXTENSION IF NOT EXISTS amcheck"));
  const rels = await store.read((tx) =>
    tx.query<{ oid: number; name: string; kind: string }>(
      `SELECT c.oid::int AS oid, n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_am am ON am.oid = c.relam
      WHERE n.nspname IN ('public', 'pg_catalog')
        AND (c.relkind = 'r' OR (c.relkind = 'i' AND am.amname = 'btree'))
      ORDER BY 1`,
    ),
  );
  // One read transaction per relation: an amcheck error aborts the transaction it runs in.
  for (const rel of rels.rows) {
    try {
      if (rel.kind === "r") {
        const v = await store.read((tx) =>
          tx.query<{ msg: string }>(
            "SELECT blkno || ':' || coalesce(offnum::text, '') || ' ' || msg AS msg FROM verify_heapam($1::oid::regclass)",
            [rel.oid],
          ),
        );
        for (const m of v.rows) amcheckErrors.push(`${rel.name} ${m.msg}`);
      } else {
        await store.read((tx) =>
          tx.query("SELECT bt_index_check($1::oid::regclass, true)", [rel.oid]),
        );
      }
    } catch (e) {
      amcheckErrors.push(`${rel.name} ${String(e)}`);
    }
  }
  return amcheckErrors;
}
