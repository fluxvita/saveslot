// The saveslot operations the SDK uses, as an interface: what the service's HTTP surface offers a
// connector (docs/zh-CN/spec/05-surfaces.md §13–§14). `SaveslotClient` implements it.

/** One slot as the catalog lists it (04-contract-types §4.2 `CatalogList`). */
export interface SlotSummary {
  readonly slot: string;
  readonly slotId: string;
  /** The slot's schema version. */
  readonly sv: number;
  readonly timezone: string;
  /** Every table of the slot, over all pages of the catalog. */
  readonly tables: readonly { readonly table: string; readonly kind: string }[];
}

/** One table as the catalog describes it (04-contract-types §4.2 `CatalogTable`). */
export interface TableInfo {
  readonly slot: string;
  readonly table: string;
  /** The slot's schema version, sent back with writes. */
  readonly sv: number;
  /** `base` or `derived`. */
  readonly kind: string;
  readonly fields: readonly string[];
}

/** One op of a write (04-contract-types §5.1). */
export interface WriteOp {
  readonly intent: "insert" | "update" | "correct" | "revoke";
  /** `slot.table`, or the table alone when no other visible slot has it. */
  readonly table: string;
  readonly set?: Readonly<Record<string, unknown>>;
  readonly row?: string;
}

export interface WriteRequest {
  /** The schema version read; the last one read when left out. */
  readonly sv?: number;
  readonly ops: readonly WriteOp[];
}

export interface WriteOptions {
  /** Makes sending the same write again safe: it is applied once within 24 hours. */
  readonly idempotencyKey?: string;
  /** What the write is part of, shown in the slot's history (`X-Task-Id`). */
  readonly task?: string;
}

/** The parts of a write receipt the SDK reads (04-contract-types §5.1 `WriteResult`). */
export interface WriteReceipt {
  /** `saved`: in effect. `pending`: some of it waits for the user. */
  readonly status: "saved" | "pending";
  readonly sv: number;
  readonly seq?: number;
  readonly pending: readonly unknown[];
  /** The service had already applied a write with this idempotency key: this is its receipt. */
  readonly replayed?: true;
}

/** The parts of a schema-draft receipt the SDK reads (04-contract-types §5.3 `SchemaDraftResult`). */
export interface DraftReceipt {
  readonly draft: string;
  readonly slot: string;
  readonly slot_id: string;
  readonly target_sv: number;
  readonly outcome: "applied" | "pending";
  readonly sv?: number;
}

/** The saveslot operations a connector can perform with its credential. */
export interface SaveslotApi {
  /**
   * One slot (`GET /v1/slots/{slot}`), its tables over every page; `undefined` when the
   * credential cannot see it.
   */
  getSlot(slot: string): Promise<SlotSummary | undefined>;
  /** The named tables of a slot (`GET /v1/slots/{slot}/tables`). */
  getTables(slot: string, tables: readonly string[]): Promise<TableInfo[]>;
  /** One write (`POST /v1/writes`). */
  write(request: WriteRequest, options?: WriteOptions): Promise<WriteReceipt>;
  /** A schema draft (`POST /v1/drafts`). */
  submitDraft(
    document: Readonly<Record<string, unknown>>,
    options?: WriteOptions,
  ): Promise<DraftReceipt>;
}
