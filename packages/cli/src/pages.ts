// Reading every page of a list (06-cli §6.1: 200 a page), with a bound, for the commands that need
// the whole of one: the tables of a slot, every connection instance.

import type { Client, Connection } from "@fluxvita/saveslot-client";
import { TEXTS } from "./texts.ts";
import { Failed } from "./usage.ts";

/** The most pages a command reads to have every item (200 a page). */
export const MAX_PAGES = 1000;

/**
 * Every item, page after page, until a page has no next cursor. Stopped, as an error (1), at
 * `MAX_PAGES` pages or at a cursor given twice: either way the pages would not end.
 */
export async function everyPage<T>(
  page: (cursor: string | undefined) => Promise<{ items: readonly T[]; next?: string | undefined }>,
): Promise<T[]> {
  const out: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const p = await page(cursor);
    out.push(...p.items);
    if (p.next === undefined) return out;
    if (cursors.has(p.next)) throw new Failed(TEXTS.pagesRepeat, 1);
    cursors.add(p.next);
    cursor = p.next;
  }
  throw new Failed(TEXTS.pagesTooMany, 1);
}

/** Every connection instance, revoked and disabled ones too, page after page (200 a page). */
export async function allConnections(c: Client): Promise<Connection[]> {
  return everyPage(async (cursor) => {
    const page = await c.connections.list({
      include_revoked: true,
      limit: 200,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return { items: page.connections, next: page.next_cursor };
  });
}
