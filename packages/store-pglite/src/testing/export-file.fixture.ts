// Export files for the import tests, written from a stored log (09-event-format §8): the manifest,
// then one line per event, each line JCS, blocks present or removed as the log has them. The
// kernel's own export is not used: the import tests check what an import does with a file of the
// format, whoever wrote it. Also: a body cut into byte chunks the way a request body comes, and
// what an import must reproduce of a storage.

import { encode, KERNEL_TABLES, type ReadTx, type TenantStore } from "@fluxvita/saveslot-kernel";
import { snapshot } from "./reusable-store.fixture.ts";

const n = (v: unknown): number => Number(v);

/** One event line as JSON: `{h, c?}`. */
export type ExportLine = { h: Record<string, unknown>; c?: Record<string, unknown> };

/** The event lines of a stored log with `after < seq <= upto`, blocks in their stored state. */
export async function exportLinesOf(
  tx: ReadTx,
  o: { readonly after?: number; readonly upto?: number } = {},
): Promise<ExportLine[]> {
  const after = o.after ?? 0;
  const upto = o.upto ?? Number.MAX_SAFE_INTEGER;
  const evs = await tx.query<{ seq: unknown; header: string }>(
    "SELECT seq, header FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq",
    [after, upto],
  );
  const blocks = await tx.query<{
    seq: unknown;
    path: string;
    body: string | null;
    checksum: string | null;
    removed_by: unknown;
  }>("SELECT seq, path, body, checksum, removed_by FROM content WHERE seq > $1 AND seq <= $2", [
    after,
    upto,
  ]);
  const bySeq = new Map<number, Record<string, unknown>>();
  for (const b of blocks.rows) {
    const c = bySeq.get(n(b.seq)) ?? {};
    bySeq.set(n(b.seq), c);
    c[b.path] =
      b.removed_by !== null
        ? { removed_by: n(b.removed_by) }
        : { v: JSON.parse(b.body as string) as unknown, sum: b.checksum as string };
  }
  return evs.rows.map((e) => {
    const c = bySeq.get(n(e.seq));
    return { h: JSON.parse(e.header) as Record<string, unknown>, ...(c ? { c } : {}) };
  });
}

/**
 * A segment: its manifest, then its lines, each as JCS text. A segment without lines names the
 * header the one before ended at in `uptoHash`.
 */
export function segmentOf(
  lines: readonly ExportLine[],
  o: {
    readonly tenant: string;
    readonly after?: number;
    readonly uptoHash?: string;
    readonly manifest?: object;
  } = {
    tenant: "",
  },
): string[] {
  const last = lines.at(-1);
  const manifest = {
    saveslot_export: 1,
    tenant_id: o.tenant,
    event_format: 1,
    restore_count: 0,
    ...(o.after !== undefined ? { after: o.after } : {}),
    upto: (last?.h["seq"] as number | undefined) ?? o.after ?? 0,
    upto_hash: last !== undefined ? encode(last.h as never).hash : (o.uptoHash ?? ""),
    events: lines.length,
    exported_at: "2026-11-10T08:00:00.000Z",
    pending_deletions: "placeholder",
    ...o.manifest,
  };
  return [manifest, ...lines].map((l) => encode(l as never).text);
}

/** The export file of a whole stored log, cut into segments after the `seq`s given in `cuts`. */
export async function exportFileOf(
  store: TenantStore,
  tenant: string,
  cuts: readonly number[] = [],
): Promise<string[]> {
  const lines = await store.read((tx) => exportLinesOf(tx));
  const out: string[] = [];
  let after: number | undefined;
  let uptoHash = "";
  for (const cut of [...cuts, Number.MAX_SAFE_INTEGER]) {
    const part = lines.filter((l) => {
      const seq = l.h["seq"] as number;
      return seq > (after ?? 0) && seq <= cut;
    });
    out.push(...segmentOf(part, { tenant, uptoHash, ...(after !== undefined ? { after } : {}) }));
    const last = part.at(-1);
    if (last !== undefined) uptoHash = encode(last.h as never).hash;
    after = cut;
  }
  return out;
}

/** The file as a request body: its bytes, newline-terminated lines, cut every `size` bytes. */
export async function* bodyOf(lines: readonly string[], size = 4096): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((l) => `${l}\n`).join(""));
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

const LOCAL = new Set(KERNEL_TABLES.filter((t) => t.class === "local").map((t) => t.name));

/**
 * What an import must reproduce of a storage: every table's rows but the local ones (the log, the
 * materialized state and the physical tables apply made; not `meta`, the read records or what the
 * process keeps for itself).
 */
export async function replicated(tx: ReadTx): Promise<Record<string, string[]>> {
  const all = await snapshot(tx);
  return Object.fromEntries(Object.entries(all).filter(([t]) => !LOCAL.has(t)));
}
