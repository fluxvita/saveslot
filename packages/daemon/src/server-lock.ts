// "The server is running" (docs/zh-CN/spec/06-cli.md §4.1 `saveslot server start`, `server restore`;
// 02-architecture §9: one process a deployment): a session-level advisory lock on the control
// database. `server start` will take it when it starts and hold it on its connection while it
// runs, so that another `server start` on the same control database does not start; until then
// only `server restore` takes it, which tries it and does nothing while another holder has it. The
// lock goes with the connection: a process that dies releases it.

import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";

/** The lock's key, fixed: "SaveSrv1". */
export const SERVER_LOCK = 0x5361_7665_5372_7631n;

/** Takes the lock on `db`'s connection if no other session holds it; whether it did. */
export async function takeServerLock(db: ControlDatabase): Promise<boolean> {
  const r = await db.write((tx) =>
    tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [SERVER_LOCK.toString()]),
  );
  return r.rows[0]?.got === true;
}

/** Releases the lock taken on `db`'s connection. */
export async function releaseServerLock(db: ControlDatabase): Promise<void> {
  await db.write((tx) => tx.query("SELECT pg_advisory_unlock($1)", [SERVER_LOCK.toString()]));
}
