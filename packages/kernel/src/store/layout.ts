// The physical layout of a slot's tables (02-architecture §8): the business table and its
// version table by name, a field's column, and the columns a reader selects a field's value
// from. Names go into SQL as identifiers, so each is checked by shape here.

import type { CompiledBaseField, CompiledBaseTable } from "@fluxvita/saveslot-contract-core";

/**
 * A name that is not a physical table's or a field's: the compiled schema and the layout disagree.
 * An internal error, as reads and writes report one (`code` "internal").
 */
export class LayoutError extends Error {
  override readonly name = "LayoutError";
  readonly code = "internal";
  readonly detail: Readonly<Record<string, unknown>> = {};
}

/** An instant column as the event format writes it: UTC, milliseconds, `Z`. */
export const INSTANT_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The physical names, checked by shape: they go into SQL as identifiers. */
export function physical(t: CompiledBaseTable): { business: string; versions: string } {
  const name = t.physical.table;
  if (!new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name) || !/^t[1-9][0-9]{0,8}$/.test(t.id))
    throw new LayoutError(`not a physical table name: ${JSON.stringify(name)}`);
  return { business: `"${name}"`, versions: `"${name}__ver"` };
}

/** A field's column. */
export const column = (f: CompiledBaseField): string => {
  if (!/^f[1-9][0-9]{0,8}$/.test(f.id))
    throw new LayoutError(`not a field ID: ${JSON.stringify(f.id)}`);
  return `"f_${f.id}"`;
};

/** A field's columns as text a reader decodes (instants in the event format's UTC form). */
export function selectOf(f: CompiledBaseField): string[] {
  const c = column(f);
  switch (f.type) {
    case "zoned_datetime":
      return [`to_char(${c}, ${INSTANT_TEXT})`, `"f_${f.id}__zone"`];
    case "boolean":
      return [c];
    default:
      return [`${c}::text`];
  }
}
