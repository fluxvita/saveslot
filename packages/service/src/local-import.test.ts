// Import into the local tenant, on a real home and real stores (02-architecture §8 «格式版本、导出、导
// 入与恢复» steps ①–⑥ and «重入»; 04-contract §17 `import`): the file replayed into a staging directory
// next to the data directory and swapped in by two renames; each step stopped and the tenant
// opened again ends empty (and imports again) or complete; a body cut midway leaves the tenant
// empty; a request authenticated before an import is not served after it. Fictional data.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AnchorStore,
  issueConnection,
  readTail,
  type StorageBackend,
  type TenantStore,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { localCallers } from "./callers.ts";
import { ContractError } from "./contract-error.ts";
import { Credentials, sessionFile } from "./credentials.ts";
import {
  IMPORT_BUSY_RETRY_AFTER,
  importLocalTenant,
  LocalTenantGate,
  repairLocalSwap,
  stagingDirOf,
} from "./local-import.ts";
import { type HomeLock, initLocalHome } from "./local-init.ts";
import {
  closeLocalTenant,
  type LocalTenant,
  localUserContext,
  openLocalTenant,
} from "./local-tenant.ts";

const T = 120_000;
const NOW = "2026-11-22T09:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "saveslot-local-import-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);
const backend: StorageBackend = testBackend();
// The home's lock is the daemon's; no process here runs on these homes.
const noLock: HomeLock = { acquire: async () => ({ release: async () => {} }) };

let n = 0;
async function initializedHome(): Promise<string> {
  const home = join(root, `h${n++}`);
  await initLocalHome({ home, backend, lock: noLock, now: NOW });
  return home;
}

/**
 * A home of its own for a case: a copy of one initialized home, made once (its data directory is
 * `<home>/data`, a path relative to the home). The copies share their tenant and user ids; no case
 * puts two of them together. The export's source home is initialized apart, with ids of its own.
 */
let blank: Promise<string> | undefined;
async function newHome(): Promise<string> {
  blank ??= initializedHome();
  const home = join(root, `h${n++}`);
  await cp(await blank, home, { recursive: true });
  expect(entries(home)).toEqual(entries(await blank));
  return home;
}

/** A directory's entries, each with its mode: what a copy must keep of the home it copies. */
const entries = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((x) => `${x} ${(statSync(join(dir, x)).mode & 0o7777).toString(8)}`)
    .concat(`. ${(statSync(dir).mode & 0o7777).toString(8)}`)
    .sort();

// The tenants a case opened, closed after it: each PGlite instance holds its memory until closed.
const open = new Set<LocalTenant>();
afterEach(async () => {
  for (const t of open) await closeLocalTenant(t).catch(() => {});
  open.clear();
}, T);

async function opened(home: string): Promise<LocalTenant> {
  const r = await openLocalTenant({ home, backend });
  if (!r.ok) throw new Error(`the tenant does not open: ${r.failure}`);
  open.add(r.tenant);
  return r.tenant;
}

async function closed(t: LocalTenant): Promise<void> {
  open.delete(t);
  await closeLocalTenant(t);
}

/** The export file: a source home's log (its genesis, a connection), as NDJSON lines. */
let file: string[];
let sourceTenant: string;
let sourceEnd: number;
beforeAll(async () => {
  const home = await initializedHome();
  const t = await opened(home);
  await issueConnection(t.store, localUserContext(t, { now: NOW }), { name: "desk", via: "token" });
  file = [];
  await t.store.read((tx) =>
    writeExport(tx, { exportedAt: "2026-11-22T08:00:00.000Z" as never }, async (l) => {
      file.push(l.slice(0, -1));
    }),
  );
  sourceTenant = t.tenant;
  sourceEnd = (await t.store.read((tx) => readTail(tx)))?.seq ?? 0;
  await closed(t);
}, T);

/** The file as a request body gives it: bytes, cut every `size`. */
async function* bodyOf(lines: readonly string[], size = 1000): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((l) => `${l}\n`).join(""));
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

/** What lies next to the data directory but itself. */
const besides = (dataDir: string) =>
  readdirSync(dirname(dataDir)).filter(
    (x) => x !== basename(dataDir) && x.startsWith(`${basename(dataDir)}.`),
  );

/** An import into `home`'s tenant, as the daemon runs it: the tenant closed at the swap. */
async function imported(
  home: string,
  o: {
    body?: AsyncIterable<Uint8Array>;
    backend?: StorageBackend;
    anchor?: (a: AnchorStore) => AnchorStore;
    store?: (s: TenantStore, t: LocalTenant) => TenantStore;
    bodyIdleMs?: number;
    signal?: AbortSignal;
    /** Told when the import closes the tenant: the anchor's import marker then. */
    onClose?: (marker: string | undefined) => void;
    fs?: Parameters<typeof importLocalTenant>[0]["fs"];
    onLeftover?: (path: string) => void;
  } = {},
) {
  const t = await opened(home);
  try {
    return await importLocalTenant({
      backend: o.backend ?? backend,
      target: {
        tenant: t.tenant,
        store: o.store?.(t.store, t) ?? t.store,
        anchor: o.anchor?.(t.anchor) ?? t.anchor,
        dataDir: t.dataDir,
        close: async () => {
          o.onClose?.((await t.anchor.read(t.tenant)).importInProgress);
          await closed(t);
        },
      },
      user: t.user,
      body: o.body ?? bodyOf(file),
      now: NOW,
      ...(o.fs !== undefined ? { fs: o.fs } : {}),
      ...(o.bodyIdleMs !== undefined ? { bodyIdleMs: o.bodyIdleMs } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
      ...(o.onLeftover !== undefined ? { onLeftover: o.onLeftover } : {}),
    });
  } finally {
    if (open.has(t)) await closed(t);
  }
}

/** The tenant opened again: still empty, or the import complete; nothing left beside it. */
async function outcome(home: string): Promise<"empty" | "complete"> {
  const t = await opened(home);
  try {
    const end = (await t.store.read((tx) => readTail(tx)))?.seq;
    const a = await t.anchor.read(t.tenant);
    expect(a.importInProgress).toBeUndefined();
    expect(besides(t.dataDir)).toEqual([]);
    if (end === 1) {
      expect(a.restoreCount).toBe(0);
      return "empty";
    }
    expect({ end, highWater: a.highWater, restoreCount: a.restoreCount }).toEqual({
      end: sourceEnd + 1,
      highWater: sourceEnd + 1,
      restoreCount: 1,
    });
    expect(t.restorePoint).toEqual({ restoreCount: 1, seq: sourceEnd + 1, point: sourceEnd });
    return "complete";
  } finally {
    await closed(t);
  }
}

const reasonOf = (e: unknown) =>
  e instanceof ContractError ? { code: e.code, reason: e.detail.reason } : String(e);

/** An anchor store whose `method` dies (a process killed there): it and everything after throw. */
function dyingAt(method: keyof AnchorStore) {
  let dead = false;
  return (a: AnchorStore): AnchorStore =>
    new Proxy(a, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (dead || k === method) {
            dead = true;
            throw new Error("PROBE killed");
          }
          return (v as (...x: unknown[]) => unknown).apply(t, args);
        };
      },
    });
}

/** Directory operations that die (a process killed there): `rm` never runs, nothing is cleaned. */
const deadRm = () => {
  throw new Error("PROBE killed");
};

describe("an import into the local tenant", () => {
  it(
    "replays the file next to the data directory, swaps it in, and says what it did",
    async () => {
      const home = await newHome();
      const r = await imported(home);
      expect(r).toEqual({
        tenant_id: JSON.parse(readFileSync(join(home, "control", "tenant.json"), "utf8")).tenant,
        previous_tenant_id: sourceTenant,
        events: sourceEnd,
        seq: sourceEnd + 1,
        restore_count: 1,
        // The source's user and its connection: active before the import, disabled by it.
        principals_disabled: 2,
        slots: 0,
        removed: 0,
        pending_deletions: { executed: 0, carried: 0 },
        exported_at: "2026-11-22T08:00:00.000Z",
        not_imported: ["read_log", "credentials", "external_files"],
      });
      // In this order on the wire, as the server mode gives it too.
      expect(Object.keys(r)).toEqual([
        "tenant_id",
        "previous_tenant_id",
        "events",
        "seq",
        "principals_disabled",
        "slots",
        "removed",
        "pending_deletions",
        "exported_at",
        "not_imported",
        "restore_count",
      ]);
      // The replaced data directory removed by the import itself, before any opening would.
      expect(besides(join(home, "data"))).toEqual([]);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "into a tenant not empty: tenant_not_empty, no staging directory made, the tenant unchanged",
    async () => {
      const home = await newHome();
      await imported(home);
      // Refused before the body is read: no staging directory made and replayed into.
      let read = false;
      async function* watched() {
        read = true;
        yield* bodyOf(file);
      }
      const e = await imported(home, { body: watched() }).catch((x: unknown) => x);
      expect(reasonOf(e)).toEqual({ code: "invalid_argument", reason: "tenant_not_empty" });
      expect(read).toBe(false);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "of a file refused: import_rejected, the staging directory removed, the tenant still empty",
    async () => {
      const home = await newHome();
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      const e = await imported(home, { body: bodyOf(broken) }).catch((x: unknown) => x);
      expect(reasonOf(e)).toEqual({ code: "import_rejected", reason: "checksum_mismatch" });
      // Removed by the import itself, before any opening would.
      expect(besides(join(home, "data"))).toEqual([]);
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "closes the staging storage by the time it returns: complete, its file refused, or stopped before the swap",
    async () => {
      // Whether each storage opened in a staging directory was closed.
      const staged: { closed: boolean }[] = [];
      const watching: StorageBackend = {
        async open(at, opts) {
          const store = await backend.open(at, opts);
          if (at.kind !== "pglite" || !basename(at.dir).startsWith("data.import-")) return store;
          const seen = { closed: false };
          staged.push(seen);
          return new Proxy(store, {
            get(t, k) {
              const v = Reflect.get(t, k);
              if (typeof v !== "function") return v;
              if (k !== "close") return v.bind(t);
              return async () => {
                seen.closed = true;
                await v.apply(t);
              };
            },
          });
        },
      };
      const closedAfter = async (o: Parameters<typeof imported>[1]) => {
        const from = staged.length;
        await imported(await newHome(), { ...o, backend: watching }).catch(() => {});
        return staged.slice(from).map((x) => x.closed);
      };
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      expect(await closedAfter({})).toEqual([true]);
      expect(await closedAfter({ body: bodyOf(broken) })).toEqual([true]);
      expect(await closedAfter({ anchor: dyingAt("beginImport") })).toEqual([true]);
    },
    T,
  );

  it(
    "a body cut midway, ending early or failing: the tenant still empty, no staging left, a new import succeeds",
    async () => {
      const home = await newHome();
      const bytes = new TextEncoder().encode(file.map((l) => `${l}\n`).join(""));
      // Ending at a line's end, before the file's last events: fewer than the manifest counts.
      const cut = new TextEncoder().encode(
        file
          .slice(0, 2)
          .map((l) => `${l}\n`)
          .join(""),
      ).length;
      async function* ends() {
        yield bytes.slice(0, cut);
      }
      const e1 = await imported(home, { body: ends() }).catch((x: unknown) => x);
      expect(reasonOf(e1)).toEqual({ code: "import_rejected", reason: "incomplete" });
      expect(await outcome(home)).toBe("empty");
      async function* fails() {
        yield bytes.slice(0, Math.floor(bytes.length / 2));
        throw new Error("PROBE the connection went away");
      }
      const e2 = await imported(home, { body: fails() }).catch((x: unknown) => x);
      // The client gone: the file cut short, not an internal error.
      expect(reasonOf(e2)).toEqual({ code: "import_rejected", reason: "incomplete" });
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );
});

describe("killed after each step, the tenant opened again (§11)", () => {
  it(
    "after ③ (killed taking the marker): the staging directory left is removed on opening; empty; imports again",
    async () => {
      const home = await newHome();
      const e = await imported(home, { anchor: dyingAt("beginImport"), fs: { rm: deadRm } }).catch(
        (x: unknown) => x,
      );
      expect(String(e)).toContain("PROBE killed");
      const t = await opened(home);
      const dataDir = t.dataDir;
      await closed(t);
      expect(besides(dataDir)).toEqual([]);
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "after ④, before the first rename: rolled back on opening, the staging directory removed; empty",
    async () => {
      const home = await newHome();
      const e = await imported(home, {
        fs: {
          rename: () => {
            throw new Error("PROBE killed");
          },
          rm: deadRm,
        },
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE killed");
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "a failure after ④ with the anchor up (the first rename refused): the staging directory kept for the re-entry",
    async () => {
      const home = await newHome();
      let refused = false;
      const e = await imported(home, {
        fs: {
          rename: (from, to) => {
            if (!refused) {
              refused = true;
              throw new Error("PROBE rename refused");
            }
            renameSync(from, to);
          },
        },
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE rename refused");
      // The marker is this import's: the staging directory is the re-entry's, not removed.
      expect(besides(join(home, "data")).map((x) => x.split("-")[0])).toEqual(["data.import"]);
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "between the two renames (no data directory): opening finishes the second rename, then the import",
    async () => {
      const home = await newHome();
      let renames = 0;
      let dataDir = "";
      const e = await imported(home, {
        fs: {
          rename: (from, to) => {
            if (++renames === 2) {
              dataDir = String(to);
              throw new Error("PROBE killed");
            }
            renameSync(from, to);
          },
          rm: deadRm,
        },
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE killed");
      expect(existsSync(dataDir)).toBe(false);
      expect(
        besides(dataDir)
          .sort()
          .map((x) => x.split("-")[0]),
      ).toEqual([`${basename(dataDir)}.import`, `${basename(dataDir)}.replaced`]);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "after ⑤ (killed rebuilding the anchor): finished on opening; complete",
    async () => {
      const home = await newHome();
      const e = await imported(home, { anchor: dyingAt("endImport"), fs: { rm: deadRm } }).catch(
        (x: unknown) => x,
      );
      expect(String(e)).toContain("PROBE killed");
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "after ⑥, the replaced data directory not removed: told; the import stands; removed on opening",
    async () => {
      const home = await newHome();
      const left: string[] = [];
      const r = await imported(home, { fs: { rm: deadRm }, onLeftover: (p) => left.push(p) });
      expect(r.seq).toBe(sourceEnd + 1);
      expect(left).toHaveLength(1);
      expect(existsSync(left[0] as string)).toBe(true);
      expect(await outcome(home)).toBe("complete");
      expect(existsSync(left[0] as string)).toBe(false);
    },
    T,
  );
});

describe("the swap made durable before ⑥ (§8: ⑤ before ⑥)", () => {
  it(
    "fsyncs the data directory's parent after the two renames, before the anchor is rebuilt",
    async () => {
      const home = await newHome();
      const steps: string[] = [];
      let dataDir = "";
      await imported(home, {
        fs: {
          rename: (from, to) => {
            renameSync(from, to);
            steps.push("rename");
          },
          fsyncDir: (path) => {
            steps.push(path === dirname(dataDir) ? "fsync the parent" : `fsync ${path}`);
          },
        },
        anchor: (a) => {
          dataDir = join(home, "data");
          return new Proxy(a, {
            get(t, k) {
              const v = Reflect.get(t, k);
              if (typeof v !== "function") return v;
              if (k !== "endImport") return v.bind(t);
              return (...args: unknown[]) => {
                steps.push("endImport");
                return (v as (...x: unknown[]) => unknown).apply(t, args);
              };
            },
          });
        },
      });
      expect(steps).toEqual(["rename", "rename", "fsync the parent", "endImport"]);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it(
    "stopped after its renames and before its own fsync: the opening that finishes it fsyncs the parent before ⑥",
    async () => {
      const home = await newHome();
      const e = await imported(home, {
        fs: {
          fsyncDir: () => {
            throw new Error("PROBE killed before the fsync");
          },
        },
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE killed before the fsync");
      // The swap is done (the data directory already there, so no repair renames), ⑥ is not.
      const marker = () =>
        Object.values(
          JSON.parse(readFileSync(join(home, "control", "anchor.json"), "utf8")).tenants as Record<
            string,
            { importInProgress?: string }
          >,
        )[0]?.importInProgress;
      expect(marker()).toMatch(/^im_/);
      const synced: [string, string | undefined][] = [];
      const r = await openLocalTenant({
        home,
        backend,
        fsyncDir: (path) => synced.push([path, marker()]),
      });
      if (r.ok) await closeLocalTenant(r.tenant);
      expect(r.ok).toBe(true);
      // Once, on the parent, with the marker still there: before ⑥ cleared it.
      expect(synced).toEqual([[home, expect.stringMatching(/^im_/)]]);
      expect(marker()).toBeUndefined();
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );

  it("the repair's rename on opening is fsynced too, after it", () => {
    const dir = mkdtempSync(join(root, "repair-"));
    const dataDir = join(dir, "data");
    const id = "im_0123456789ABCDEF" as Parameters<typeof stagingDirOf>[1];
    mkdirSync(stagingDirOf(dataDir, id));
    const synced: [string, boolean][] = [];
    expect(repairLocalSwap(dataDir, id, (p) => synced.push([p, existsSync(dataDir)]))).toBe(true);
    expect(synced).toEqual([[dir, true]]);
  });
});

describe("an import's body that stalls, or a service that stops (before ④)", () => {
  /** What `p` gives, or "still waiting" after 30 s: a stall the import does not end shows as such. */
  const within = <V>(p: Promise<V>) =>
    Promise.race([p, new Promise<string>((r) => setTimeout(() => r("still waiting"), 30_000))]);
  /** A body that gives its first bytes, then nothing. */
  async function* stalled() {
    yield new TextEncoder().encode(`${file[0]}\n`);
    await new Promise(() => {});
  }

  it(
    "nothing for the idle time: import_rejected (incomplete), nothing left, the tenant empty",
    async () => {
      const home = await newHome();
      const e = await within(
        imported(home, { body: stalled(), bodyIdleMs: 300 }).catch((x: unknown) => x),
      );
      expect(reasonOf(e)).toEqual({ code: "import_rejected", reason: "incomplete" });
      expect(besides(join(home, "data"))).toEqual([]);
      expect(await outcome(home)).toBe("empty");
    },
    T,
  );

  it(
    "aborted while it waits for the body: import_rejected (incomplete), nothing left, the tenant empty",
    async () => {
      const home = await newHome();
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 300);
      const e = await within(
        imported(home, { body: stalled(), signal: abort.signal }).catch((x: unknown) => x),
      );
      expect(reasonOf(e)).toEqual({ code: "import_rejected", reason: "incomplete" });
      expect(besides(join(home, "data"))).toEqual([]);
      expect(await outcome(home)).toBe("empty");
    },
    T,
  );
});

describe("an import's body is its owner's to end", () => {
  it(
    "a refused import does not end the body: the HTTP surface still answers on its request",
    async () => {
      const home = await newHome();
      // A request's iterator: ending it (return) would destroy the request and its connection.
      let ended = 0;
      const first = new TextEncoder().encode(`${file[0]}\n`);
      let given = false;
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (!given) {
              given = true;
              return { done: false, value: first };
            }
            return new Promise<never>(() => {});
          },
          return: async () => {
            ended++;
            return { done: true, value: undefined };
          },
        }),
      };
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 300);
      const e = await imported(home, { body, signal: abort.signal }).catch((x: unknown) => x);
      expect(reasonOf(e)).toEqual({ code: "import_rejected", reason: "incomplete" });
      expect(ended).toBe(0);
      expect(await outcome(home)).toBe("empty");
    },
    T,
  );
});

describe("an import's leftover that cannot be removed", () => {
  it.skipIf(process.getuid?.() === 0)(
    "is told, and the tenant opens all the same",
    async () => {
      const home = await newHome();
      const dataDir = join(home, "data");
      const left = `${dataDir}.replaced-im_0123456789ABCDEF`;
      mkdirSync(join(left, "locked"), { recursive: true });
      writeFileSync(join(left, "locked", "f"), "");
      chmodSync(join(left, "locked"), 0o500);
      try {
        const told: string[] = [];
        const r = await openLocalTenant({
          home,
          backend,
          onLeftover: (path, e) =>
            told.push(`${basename(path)} ${(e as NodeJS.ErrnoException).code}`),
        });
        if (r.ok) await closeLocalTenant(r.tenant);
        expect(r.ok).toBe(true);
        // The error's code only (ENOTEMPTY on macOS, EACCES on Linux).
        expect(told).toHaveLength(1);
        expect(told[0]).toMatch(new RegExp(`^${basename(left)} E[A-Z]+$`));
      } finally {
        chmodSync(join(left, "locked"), 0o700);
      }
    },
    T,
  );
});

describe("a failure from ④ on, before the swap closed the tenant (§8: no reads or writes with the marker)", () => {
  /** The target's reads failing once the anchor holds an import marker (④'s second half). */
  const readFailing = (s: TenantStore, t: LocalTenant): TenantStore =>
    new Proxy(s, {
      get(target, k) {
        const v = Reflect.get(target, k);
        if (typeof v !== "function") return v;
        if (k !== "read") return v.bind(target);
        return async (...args: unknown[]) => {
          if ((await t.anchor.read(t.tenant)).importInProgress !== undefined) {
            throw new Error("PROBE the target's read failed");
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  /** The staging storage's close failing (after it closed): the swap's first step. */
  const stagingCloseFailing: StorageBackend = {
    async open(at, opts) {
      const store = await backend.open(at, opts);
      if (at.kind !== "pglite" || !basename(at.dir).startsWith("data.import-")) return store;
      return new Proxy(store, {
        get(target, k) {
          const v = Reflect.get(target, k);
          if (typeof v !== "function") return v;
          if (k !== "close") return v.bind(target);
          return async () => {
            await v.apply(target);
            throw new Error("PROBE closing the staging storage failed");
          };
        },
      });
    },
  };

  it.each([
    ["the target's read", { store: readFailing }],
    ["closing the staging storage", { backend: stagingCloseFailing }],
  ] as const)(
    "%s: the import closes the tenant with its marker there; opened again, rolled back; a retry imports",
    async (_, inject) => {
      const home = await newHome();
      const markers: (string | undefined)[] = [];
      const e = await imported(home, {
        ...inject,
        onClose: (m) => markers.push(m),
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE");
      // Closed by the import itself, the marker there: nothing is served from it meanwhile.
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(/^im_/);
      // The host opens it again (the daemon does, at once): the re-entry rolls the import back.
      expect(await outcome(home)).toBe("empty");
      await imported(home);
      expect(await outcome(home)).toBe("complete");
    },
    T,
  );
});

describe("the tenant's gate, and a request across an import", () => {
  it("refuses uses while an import holds the tenant (importing), another import (busy)", async () => {
    const gate = new LocalTenantGate();
    let release = () => {};
    const held = gate.exclusive(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    expect(reasonOf(await gate.use(async () => "used").catch((x: unknown) => x))).toEqual({
      code: "unavailable",
      reason: "importing",
    });
    const again = await gate.exclusive(async () => "again").catch((x: unknown) => x);
    expect(reasonOf(again)).toEqual({ code: "rate_limited", reason: "busy" });
    // rate_limited always says when to try again (04-contract-types, 05-surfaces §14).
    expect((again as ContractError).detail["retry_after"]).toBe(IMPORT_BUSY_RETRY_AFTER);
    release();
    await held;
    expect(await gate.use(async () => "used")).toBe("used");
  });

  it("an import waits for the uses in progress before it holds the tenant", async () => {
    const gate = new LocalTenantGate();
    const order: string[] = [];
    let finish = () => {};
    const use = gate.use(
      () =>
        new Promise<void>((r) => {
          finish = () => {
            order.push("use ended");
            r();
          };
        }),
    );
    const held = gate.exclusive(async () => {
      order.push("import began");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    finish();
    await Promise.all([use, held]);
    expect(order).toEqual(["use ended", "import began"]);
  });

  it(
    "a request authenticated before an import completes is not served on the new tenant (importing)",
    async () => {
      const home = await newHome();
      const session = readFileSync(sessionFile(home), "utf8").trim();
      const credentials = await Credentials.load(home);
      let current = await opened(home);
      const callers = localCallers({ tenant: () => current, credentials });
      const caller = await callers.resolve(`Bearer ${session}`);
      if (!("principal" in caller)) throw new Error("the session does not authenticate");
      expect(await caller.use(async (t) => t.tenant)).toBe(current.tenant);
      // The import completes between the request's authentication and its use.
      await closed(current);
      await imported(home);
      current = await opened(home);
      expect(reasonOf(await caller.use(async () => "served").catch((x: unknown) => x))).toEqual({
        code: "unavailable",
        reason: "importing",
      });
    },
    T,
  );
});
