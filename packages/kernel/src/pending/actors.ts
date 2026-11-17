// The principals as they are now (04-contract-types §1.6 `Actor`): what reads give, and what an
// error's details give. A write's receipt names them as of its own operation instead
// (log/actors.ts); both fall back the same way for a principal they have no name for.

import type { ActorAsOf as Actor } from "../log/index.ts";
import type { ReadTx } from "../store/ports.ts";

/** The principals by ID, from the `principals` table. */
export async function actorsNow(tx: ReadTx, ids: readonly string[]): Promise<Map<string, Actor>> {
  const out = new Map<string, Actor>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const r = await tx.query<{ id: string; kind: string; name: string | null; state: string }>(
    "SELECT id, kind, name, state FROM principals WHERE id = ANY($1)",
    [unique] as never,
  );
  for (const p of r.rows) {
    out.set(p.id, {
      kind: p.kind as Actor["kind"],
      id: p.id,
      name: p.name ?? p.id,
      ...(p.state === "revoked" || p.state === "disabled" ? { state: p.state } : {}),
    });
  }
  for (const id of unique)
    if (!out.has(id)) out.set(id, { kind: id === "system" ? "system" : "user", id, name: id });
  return out;
}
