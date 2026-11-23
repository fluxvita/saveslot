// What a connector developer implements: the slot and the tables the connector writes to,
// declared on a `SchemaBuilder` the SDK hands over. The SDK creates the slot at `init` when it
// does not exist yet.

import { SaveslotError } from "../errors.ts";
import type { TableDefinition } from "./definition.ts";

/** Implemented by the connector developer and set on the SDK's builder. */
export interface ConnectorProvider {
  /** Add the slot and its tables to `schema`, and return it. Called once, by `init`. */
  defineSchema(schema: SchemaBuilder): SchemaBuilder;
}

/** What `defineSchema` declared. */
export interface DeclaredSchema {
  readonly slot: string;
  readonly timezone: string;
  readonly tables: readonly TableDefinition[];
}

/** Collects the slot and the tables a connector writes to. */
export class SchemaBuilder {
  #slot: { name: string; timezone: string } | undefined;
  readonly #tables: TableDefinition[] = [];

  /** The slot written to, and its IANA time zone (`UTC`, `Asia/Shanghai`). Exactly once. */
  addSlot(slot: string, timezone: string): this {
    if (this.#slot !== undefined) {
      throw invalidSchema("a connector writes to one slot: addSlot was called twice");
    }
    if (slot.trim() === "" || timezone.trim() === "") {
      throw invalidSchema("addSlot needs a slot name and a time zone");
    }
    this.#slot = { name: slot, timezone };
    return this;
  }

  /** A table in the slot. Table names are unique regardless of ASCII case. */
  addTable(table: TableDefinition): this {
    const name = table.name.toLowerCase();
    if (this.#tables.some((t) => t.name.toLowerCase() === name)) {
      throw invalidSchema(`the table ${table.name} was added twice`);
    }
    this.#tables.push(table);
    return this;
  }

  /** @internal What was declared; the SDK calls it after `defineSchema`. */
  declared(): DeclaredSchema {
    if (this.#slot === undefined) throw invalidSchema("defineSchema did not call addSlot");
    if (this.#tables.length === 0) throw invalidSchema("defineSchema did not add any table");
    return { slot: this.#slot.name, timezone: this.#slot.timezone, tables: [...this.#tables] };
  }
}

function invalidSchema(message: string): SaveslotError {
  return new SaveslotError("invalid_schema", message);
}
