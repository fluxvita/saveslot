// The cell's maintenance database, at most two connections a process (02-architecture §7 «连接»;
// 06-cli §4.1 «服务器模式的配置», the connection budget): one for creating databases, one for
// dropping them, each a turn taken first come first served, whatever the number of first sign-ins,
// imports or drops at once.
//
// They are two turns, not one, because a drop waits for a checkpoint, which on a busy server takes
// many seconds: in one turn with creations, a drop would hold back every first sign-in behind it.
// A creation is waited for by a request: one waiting more than MAINTENANCE_WAIT_MS is refused with
// `maintenance_busy`, a retry later. A drop is waited for by no one (it comes after an import's
// answer, or on a tenant's opening, which goes on without it when it fails): it waits its turn.

import { PostgresStoreError } from "./errors.ts";

/** How long a database's creation waits for its turn at the maintenance database. */
export const MAINTENANCE_WAIT_MS = 5_000;

/** Tests only: the creations' wait, in place of MAINTENANCE_WAIT_MS. */
export const maintenanceForTests = { waitMs: undefined as number | undefined };

/** One turn: one holder at a time, the others in line in the order they came. */
class Turn {
  #busy = false;
  readonly #line: { go: () => void; timer?: ReturnType<typeof setTimeout> }[] = [];

  /** Runs `fn` in its turn; with `waitMs`, refused by `refused()` if the turn is not had by then. */
  async run<T>(fn: () => Promise<T>, waitMs?: number, refused?: () => Error): Promise<T> {
    if (this.#busy || this.#line.length > 0) {
      await new Promise<void>((go, refuse) => {
        const waiter: { go: () => void; timer?: ReturnType<typeof setTimeout> } = { go };
        if (waitMs !== undefined && refused !== undefined) {
          waiter.timer = setTimeout(() => {
            const i = this.#line.indexOf(waiter);
            if (i >= 0) this.#line.splice(i, 1);
            refuse(refused());
          }, waitMs);
        }
        this.#line.push(waiter);
      });
    } else {
      this.#busy = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.#line.shift();
      if (next === undefined) this.#busy = false;
      else {
        clearTimeout(next.timer);
        next.go();
      }
    }
  }
}

const creating = new Turn();
const dropping = new Turn();

/** Runs `fn`, which creates a database, with the process's one turn at creating databases. */
export function withCreationTurn<T>(fn: () => Promise<T>): Promise<T> {
  return creating.run(
    fn,
    maintenanceForTests.waitMs ?? MAINTENANCE_WAIT_MS,
    () =>
      new PostgresStoreError(
        "maintenance_busy",
        "another database is being created in this process: try again shortly",
      ),
  );
}

/** Runs `fn`, which drops a database, with the process's one turn at dropping databases. */
export function withDropTurn<T>(fn: () => Promise<T>): Promise<T> {
  return dropping.run(fn);
}
