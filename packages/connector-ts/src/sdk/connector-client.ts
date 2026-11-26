// `ConnectorClient`: the SDK's one public entry. It is made only through its builder, which takes
// the connector's manifest, its credential, the service's address and the developer's
// `ConnectorProvider`. `build()` makes the one instance of the process; any file reaches it with
// `ConnectorClient.with()`. It holds the internal `SaveslotClient` and does every saveslot
// operation through it: at `init` it creates the slot the provider declares when it does not exist
// and checks it when it does, and `write` turns the developer's `SlotRecord`s into writes: inserts,
// or writes by source key for a table that declares one.

import type { TableInfo, WriteOp } from "../client/api.ts";
import {
  checkHeaderText,
  MAX_RETRIES,
  RESERVED_HEADERS,
  SaveslotClient,
} from "../client/saveslot-client.ts";
import { SaveslotError } from "../errors.ts";
import {
  CONNECTOR_PLATFORMS,
  type ConnectorManifest,
  ConnectorPlatform,
} from "../protocol/manifest.ts";
import {
  emptyWriteResult,
  type SlotRecord,
  toKeyedOps,
  toOps,
  type WriteResult,
} from "../record/slot-record.ts";
import { newSlotDocument } from "../schema/definition.ts";
import {
  type ConnectorProvider,
  type DeclaredSchema,
  SchemaBuilder,
} from "../schema/schema-builder.ts";

/** This SDK's version, sent in `User-Agent`. */
export const SDK_VERSION = "0.0.1";

/** Ops in one write: more records go in several writes. */
export const RECORDS_PER_WRITE = 100;

/** The characters of a bearer token (RFC 6750 §2.1, `b64token`). */
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Only this module can make a `ConnectorClient`: the builder is the way in. */
const CREATE = Symbol("create");

/** The one instance, once built. */
let instance: ConnectorClient | undefined;
const REQUIRED: readonly (keyof ConnectorManifest)[] = [
  "id",
  "name",
  "description",
  "logo",
  "version",
  "publisher",
];

interface Config {
  readonly manifest: ConnectorManifest;
  readonly provider: ConnectorProvider;
  readonly client: SaveslotClient;
}

export interface WriteCallOptions {
  /**
   * Names this write: the same records written again under the same key within 24 hours are
   * applied once, and come back counted in `replayed`. Without it, each call is new. Each part
   * of the write sends `<key>.<table>.<n>` as its idempotency key, which must be at most 256
   * characters: keep the key well under that (a UUID, or a short sync-run name).
   *
   * A retry must send the same records in the same order under the same key: fix the records of
   * a run when it starts and keep them, with the key, until the run succeeds. Other records under
   * a key already used reject with `key_reused`, whose `written` says what had been applied.
   */
  readonly key?: string;
  /** `X-Task-Id`: what the write is part of; defaults to the manifest's `id`. */
  readonly task?: string;
}

export class ConnectorClient {
  readonly #manifest: ConnectorManifest;
  readonly #provider: ConnectorProvider;
  readonly #client: SaveslotClient;
  /** The declared tables as the service has them, by lower-case name. */
  readonly #tables = new Map<string, TableInfo>();
  /** The source key of each declared table that has one, as declared, by lower-case name. */
  readonly #keys = new Map<string, readonly string[]>();
  #initialized = false;
  #initializing: Promise<void> | undefined;

  /** Starts setting up the SDK. */
  static builder(): ConnectorClientBuilder {
    return new ConnectorClientBuilder();
  }

  /**
   * The instance `build()` made, from any file: `ConnectorClient.with().write(records)`. Throws
   * `not_built` before `build()`.
   */
  static with(): ConnectorClient {
    if (instance === undefined) {
      throw new SaveslotError(
        "not_built",
        "build the SDK first: ConnectorClient.builder()…build()",
      );
    }
    return instance;
  }

  /** Forgets the instance, so the SDK can be built again (with other settings, or in tests). */
  static reset(): void {
    instance = undefined;
  }

  /** @internal Called by the builder only. */
  static [CREATE](config: Config): ConnectorClient {
    if (instance !== undefined) {
      throw new SaveslotError(
        "already_built",
        "the SDK is built once per process: use ConnectorClient.with(), or ConnectorClient.reset() first",
      );
    }
    instance = new ConnectorClient(CREATE, config);
    return instance;
  }

  private constructor(token: symbol, config: Config) {
    if (token !== CREATE) {
      throw new SaveslotError("invalid_config", "use ConnectorClient.builder()");
    }
    this.#manifest = config.manifest;
    this.#provider = config.provider;
    this.#client = config.client;
  }

  /** The connector's manifest, as set on the builder. */
  get manifest(): ConnectorManifest {
    return this.#manifest;
  }

  /** Whether `init` has succeeded. */
  get initialized(): boolean {
    return this.#initialized;
  }

  /**
   * Gets the connector ready:
   * 1. asks the provider for its slot and tables (`defineSchema`);
   * 2. reads the slot, which also checks that the service answers and accepts the credential;
   * 3. when the slot does not exist, creates it with all its tables in one schema draft (the
   *    credential needs `saveslot.schema` and must not be limited to other slots);
   * 4. checks that every declared table is there with the declared fields and the declared source
   *    key (none when none is declared), and rejects with `schema_mismatch` when not, changing
   *    nothing. It compares names only, not field types or whether a field is required: a field
   *    of another type in an existing slot shows at `write`, as the service's refusal.
   *
   * This version cannot change a slot that exists: the service refuses such a draft
   * (`not_in_this_version`) until P4. A slot that lacks a declared table or field stays as it is;
   * declare what it has, or write to a new slot.
   *
   * A creation that waits for the user's confirmation rejects with `schema_pending`. Every other
   * operation refuses with `not_initialized` until this has succeeded. Calling it again after it
   * succeeded does nothing; after it failed, it starts again.
   */
  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initializing ??= (async () => {
      try {
        const schema = this.#declare();
        await this.#createIfMissing(schema);
        await this.#loadTables(schema);
        this.#initialized = true;
      } finally {
        this.#initializing = undefined;
      }
    })();
    return this.#initializing;
  }

  /**
   * Writes records grouped by table, at most `RECORDS_PER_WRITE` to a write. Before sending
   * anything, rejects with `unknown_table` for a table `defineSchema` did not declare, or
   * `invalid_argument` for a key, task or record that cannot be sent (a record with a value JSON
   * cannot carry, such as a BigInt or a cycle; a record of a table with a source key that lacks a
   * key field or has it null, or has no field besides its key fields; two records of one table
   * with the same source key). Once sending has started, an error carries `written`: what this
   * call had applied before it (`key_reused` when the service refused a part because its key was
   * used with other records), and, when the service's refusal names ops of the part it refused,
   * `records`: the indexes in `records` of the records those ops were made from.
   *
   * A record of a table without a source key is a new row: writing it again adds it again, unless
   * the call is repeated with the same `key` within 24 hours. A record of a table with a source key
   * is written by that key: the first time it adds a row, later it updates that row with what
   * changed since it was last delivered, and writing it again unchanged records nothing. A field
   * the user changed in saveslot since is not overwritten: the source's change to it becomes a
   * candidate for the user to decide. A record none of whose fields took effect, with some of them
   * waiting for the user, is `awaiting`; one with any field in effect is `updated`. A row the user
   * revoked is not written back (`skipped`).
   */
  async write(
    records: readonly SlotRecord[],
    options: WriteCallOptions = {},
  ): Promise<WriteResult> {
    this.#ready();
    /** Per table: its records' fields, and the index of each record in `records`. */
    const byTable = new Map<
      TableInfo,
      { fields: Readonly<Record<string, unknown>>[]; indexes: number[] }
    >();
    /** Per keyed table: each source key seen in this call, and the record that had it first. */
    const seenKeys = new Map<TableInfo, Map<string, number>>();
    for (const [index, record] of records.entries()) {
      const name = record.table();
      const info = this.#tables.get(name.toLowerCase());
      if (info === undefined) {
        throw new SaveslotError("unknown_table", `the connector did not declare a table ${name}`);
      }
      const fields = record.fields();
      checkSerializable(fields, name, index);
      const key = this.#keys.get(name.toLowerCase());
      if (key !== undefined) {
        const seen = seenKeys.get(info) ?? new Map<string, number>();
        const id = keyOf(fields, key, name, index);
        checkHasValueBesidesKey(fields, key, name, index);
        const first = seen.get(id);
        if (first !== undefined) {
          throw new SaveslotError(
            "invalid_argument",
            `records ${first} and ${index} (table ${name}) have the same source key: send each ` +
              "record once in a write",
            { details: { table: name, records: [first, index] } },
          );
        }
        seen.set(id, index);
        seenKeys.set(info, seen);
      }
      const list = byTable.get(info) ?? { fields: [], indexes: [] };
      list.fields.push(fields);
      list.indexes.push(index);
      byTable.set(info, list);
    }
    const task = options.task ?? this.#manifest.id;
    checkHeaderText("X-Task-Id", task);
    // Every part and its key first, every key checked, so nothing is sent when one is unusable.
    const parts: {
      info: TableInfo;
      ops: WriteOp[];
      /** The index in `records` of the record each op was made from. */
      indexes: number[];
      key: string | undefined;
    }[] = [];
    for (const [info, { fields, indexes }] of byTable) {
      const table = `${info.slot}.${info.table}`;
      const key = this.#keys.get(info.table.toLowerCase());
      const ops = key === undefined ? toOps(table, fields) : toKeyedOps(table, key, fields);
      for (let from = 0; from < ops.length; from += RECORDS_PER_WRITE) {
        const key =
          options.key === undefined
            ? undefined
            : `${options.key}.${info.table}.${from / RECORDS_PER_WRITE}`;
        if (key !== undefined) checkHeaderText("Idempotency-Key", key);
        parts.push({
          info,
          ops: ops.slice(from, from + RECORDS_PER_WRITE),
          indexes: indexes.slice(from, from + RECORDS_PER_WRITE),
          key,
        });
      }
    }
    const result = emptyWriteResult();
    result.records = records.length;
    for (const [n, { info, ops, indexes, key }] of parts.entries()) {
      let receipt: Awaited<ReturnType<SaveslotClient["write"]>>;
      try {
        receipt = await this.#client.write(
          { sv: info.sv, ops },
          { task, ...(key === undefined ? {} : { idempotencyKey: key }) },
        );
      } catch (e) {
        throw partError(e, { ...result }, n, parts.length, indexes);
      }
      if (receipt.replayed === true) result.replayed += ops.length;
      else if (receipt.external_key_summary !== undefined) {
        const c = receipt.external_key_summary;
        result.created += c.created;
        result.updated += c.updated;
        result.unchanged += c.unchanged ?? 0;
        result.awaiting += c.pending;
        result.skipped += c.skipped ?? 0;
      } else result.created += ops.length;
      result.pending += receipt.pending.length;
    }
    return result;
  }

  #declare(): DeclaredSchema {
    const builder = this.#provider.defineSchema(new SchemaBuilder());
    if (!(builder instanceof SchemaBuilder)) {
      throw new SaveslotError(
        "invalid_schema",
        "defineSchema must return the SchemaBuilder it got",
      );
    }
    return builder.declared();
  }

  async #createIfMissing(schema: DeclaredSchema): Promise<void> {
    if ((await this.#client.getSlot(schema.slot)) !== undefined) return;
    const receipt = await this.#client.submitDraft(newSlotDocument(schema), {
      task: this.#manifest.id,
    });
    if (receipt.outcome !== "applied") {
      throw new SaveslotError(
        "schema_pending",
        `creating the slot ${schema.slot} waits for the user's confirmation`,
        { details: { draft: receipt.draft } },
      );
    }
  }

  async #loadTables(schema: DeclaredSchema): Promise<void> {
    const slot = await this.#client.getSlot(schema.slot);
    if (slot === undefined) {
      throw new SaveslotError("schema_mismatch", `the slot ${schema.slot} cannot be read`, {
        details: { slot: schema.slot },
      });
    }
    const present = schema.tables.filter((t) => hasTable(slot.tables, t.name));
    const infos = await this.#client.getTables(
      schema.slot,
      present.map((t) => t.name),
    );
    const problems: Record<string, unknown>[] = [];
    for (const declared of schema.tables) {
      const info = infos.find((i) => i.table.toLowerCase() === declared.name.toLowerCase());
      if (info === undefined) {
        problems.push({ table: declared.name, missing: true });
        continue;
      }
      const have = new Set(info.fields.map((f) => f.toLowerCase()));
      const missingFields = declared.fields
        .map((f) => f.name)
        .filter((f) => !have.has(f.toLowerCase()));
      if (missingFields.length > 0) problems.push({ table: declared.name, missingFields });
      if (!sameFields(declared.externalKey, info.externalKey)) {
        problems.push({
          table: declared.name,
          externalKey: { declared: declared.externalKey ?? null, slot: info.externalKey ?? null },
        });
      }
    }
    if (problems.length > 0) {
      throw new SaveslotError(
        "schema_mismatch",
        `the slot ${schema.slot} lacks tables or fields defineSchema declares, or has another ` +
          "source key; this version cannot change an existing slot: declare what the slot has, " +
          "or write to a new slot",
        { details: { tables: problems } },
      );
    }
    this.#tables.clear();
    this.#keys.clear();
    for (const info of infos) this.#tables.set(info.table.toLowerCase(), info);
    for (const declared of schema.tables) {
      if (declared.externalKey !== undefined) {
        this.#keys.set(declared.name.toLowerCase(), declared.externalKey);
      }
    }
  }

  #ready(): void {
    if (!this.#initialized) {
      throw new SaveslotError("not_initialized", "call init() first");
    }
  }
}

/** A record's fields as JSON, or `invalid_argument` naming the record (its table and index). */
function checkSerializable(
  fields: Readonly<Record<string, unknown>>,
  table: string,
  index: number,
): void {
  try {
    JSON.stringify(fields);
  } catch (cause) {
    throw new SaveslotError(
      "invalid_argument",
      `record ${index} (table ${table}) has a value JSON cannot carry (a BigInt, a cycle, …)`,
      { details: { table, record: index }, cause },
    );
  }
}

/** Whether two lists name the same fields, regardless of order and ASCII case; absent is none. */
function sameFields(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const norm = (l: readonly string[] | undefined) =>
    [...(l ?? [])].map((f) => f.toLowerCase()).sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((f, i) => f === y[i]);
}

/**
 * A record's source key, as one text to compare by: its key fields' values in the key's order,
 * text in NFC (the service compares keys as it compares values: text after NFC, code point by
 * code point). `invalid_argument` naming the record when a key field is missing or null.
 */
function keyOf(
  fields: Readonly<Record<string, unknown>>,
  key: readonly string[],
  table: string,
  index: number,
): string {
  const values = key.map((field) => {
    const value = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (value === undefined || value === null) {
      throw new SaveslotError(
        "invalid_argument",
        `record ${index} (table ${table}) has no value for ${field}, a field of the table's ` +
          "source key: every key field needs one",
        { details: { table, record: index, field } },
      );
    }
    return typeof value === "string" ? value.normalize("NFC") : value;
  });
  return JSON.stringify(values);
}

/**
 * A record of a table with a source key must have a field to write besides its key fields: its op
 * would have an empty `set`, which the service refuses (`invalid_argument`, `malformed`) after the
 * parts before it have taken effect. A field whose value is `undefined` is not sent, so it does
 * not count.
 */
function checkHasValueBesidesKey(
  fields: Readonly<Record<string, unknown>>,
  key: readonly string[],
  table: string,
  index: number,
): void {
  const has = Object.entries(fields).some(([f, v]) => !key.includes(f) && v !== undefined);
  if (has) return;
  throw new SaveslotError(
    "invalid_argument",
    `record ${index} (table ${table}) has only its source key fields: give at least one other ` +
      "field to write",
    { details: { table, record: index } },
  );
}

/**
 * The ops a refusal from the service names, by their index in the write (`ops/<i>` in `param`
 * or in a detail's `path`, a detail's `op`, the `ops` of `duplicate_external_key`;
 * 04-contract-types §9).
 */
function namedOps(error: Readonly<Record<string, unknown>> | undefined): number[] {
  if (error === undefined) return [];
  const found: number[] = [];
  const fromPath = (p: unknown) => {
    const m = typeof p === "string" ? /^ops\/(\d+)(?:\/|$)/.exec(p) : null;
    if (m !== null) found.push(Number(m[1]));
  };
  const fromIndex = (i: unknown) => {
    if (Number.isSafeInteger(i)) found.push(i as number);
  };
  fromPath(error["param"]);
  if (Array.isArray(error["ops"])) for (const i of error["ops"]) fromIndex(i);
  if (Array.isArray(error["details"])) {
    for (const d of error["details"]) {
      if (typeof d !== "object" || d === null) continue;
      fromIndex((d as Record<string, unknown>)["op"]);
      fromPath((d as Record<string, unknown>)["path"]);
    }
  }
  return found;
}

/**
 * An error from part `n` of a write, with what the call had applied before it, and the records
 * (by their index in the call) whose ops the refusal names. A part the service refused because
 * its key was used with other records is `key_reused`.
 */
function partError(
  e: unknown,
  written: WriteResult,
  n: number,
  total: number,
  indexes: readonly number[],
): unknown {
  if (!(e instanceof SaveslotError)) return e;
  const named = namedOps(e.details).filter((i) => i < indexes.length);
  const records = [...new Set(named.map((i) => indexes[i] as number))].sort((a, b) => a - b);
  const o = {
    ...(e.status === undefined ? {} : { status: e.status }),
    ...(e.details === undefined ? {} : { details: e.details }),
    written,
    ...(records.length === 0 ? {} : { records }),
  };
  if (e.code === "invalid_argument" && e.details?.["reason"] === "idempotency_key_reuse") {
    return new SaveslotError(
      "key_reused",
      `this key was used before with other records: write ${n + 1} of ${total} was refused, ` +
        `the ${n} before it are applied; retry with the records first sent under this key, in ` +
        "the same order, or write the rest under a new key",
      { ...o, cause: e },
    );
  }
  const which =
    records.length === 0
      ? ""
      : ` (write ${n + 1} of ${total}; record${records.length === 1 ? "" : "s"} ${records.join(", ")})`;
  return new SaveslotError(e.code, `${e.message}${which}`, { ...o, cause: e.cause ?? e });
}

/** Table names are unique in a slot regardless of ASCII case. */
function hasTable(tables: readonly { readonly table: string }[], name: string): boolean {
  return tables.some((t) => t.table.toLowerCase() === name.toLowerCase());
}

/** Sets up a `ConnectorClient`. Each setter returns the builder, so calls can be chained. */
export class ConnectorClientBuilder {
  #manifest: ConnectorManifest | undefined;
  #credential: string | undefined;
  #baseUrl: string | undefined;
  #provider: ConnectorProvider | undefined;
  #headers: Record<string, string> = {};
  #fetch: typeof fetch | undefined;
  #timeoutMs: number | undefined;
  #retries: number | undefined;

  /** The connector's description of itself. Required. */
  setManifest(manifest: ConnectorManifest): this {
    this.#manifest = manifest;
    return this;
  }

  /**
   * The connection credential for this connector. Required. With the local service, issue it with
   * `saveslot connect`; give it `saveslot.schema` when `init` has a slot to create.
   */
  setCredential(credential: string): this {
    this.#credential = credential;
    return this;
  }

  /**
   * The service's base URL. Required. The local service listens on a unix socket only: give any
   * `http://` URL (e.g. `http://saveslot.local`) and a `fetch` that goes over the socket with
   * `setFetch` (the README shows one).
   */
  setBaseUrl(baseUrl: string): this {
    this.#baseUrl = baseUrl;
    return this;
  }

  /** The developer's implementation: the slot and tables the connector writes to. Required. */
  setProvider(provider: ConnectorProvider): this {
    this.#provider = provider;
    return this;
  }

  /**
   * Extra headers on every request, e.g. a tracing header a gateway needs. They cannot name the
   * SDK's own: `Authorization`, `Content-Type`, `Accept`, `User-Agent`, `X-Task-Id`,
   * `Idempotency-Key`, `Prefer`.
   */
  setHeaders(headers: Readonly<Record<string, string>>): this {
    this.#headers = Object.assign(Object.create(null), headers);
    return this;
  }

  /** The `fetch` to call the service with; defaults to the global one. */
  setFetch(fetchFn: typeof fetch): this {
    this.#fetch = fetchFn;
    return this;
  }

  /** Milliseconds for one request: a whole number above 0 (default 30 000). */
  setTimeout(ms: number): this {
    this.#timeoutMs = ms;
    return this;
  }

  /** Tries after no answer, 429 or 503: a whole number from 0 to `MAX_RETRIES` (default 4). */
  setRetries(retries: number): this {
    this.#retries = retries;
    return this;
  }

  /** Checks the settings and makes the SDK. Throws `invalid_config`, naming what is wrong. */
  build(): ConnectorClient {
    const manifest = checkManifest(this.#manifest);
    if (this.#credential === undefined || this.#credential === "") {
      throw invalid("credential", "the credential is not set");
    }
    if (typeof this.#credential !== "string" || !TOKEN.test(this.#credential)) {
      // The message does not quote it: the credential is in no error.
      throw invalid(
        "credential",
        "the credential has characters a token cannot have (white space, a line break, …)",
      );
    }
    if (this.#baseUrl === undefined || this.#baseUrl === "") {
      throw invalid("baseUrl", "the base URL is not set");
    }
    if (this.#provider === undefined || typeof this.#provider.defineSchema !== "function") {
      throw invalid("provider", "the provider is not set");
    }
    if (
      this.#timeoutMs !== undefined &&
      (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0)
    ) {
      throw invalid("timeout", "the timeout must be a whole number of milliseconds above 0");
    }
    if (
      this.#retries !== undefined &&
      (!Number.isSafeInteger(this.#retries) || this.#retries < 0 || this.#retries > MAX_RETRIES)
    ) {
      throw invalid("retries", `retries must be a whole number from 0 to ${MAX_RETRIES}`);
    }
    // No prototype: a header named `__proto__` is an own key like any other.
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(this.#headers)) {
      const lower = name.toLowerCase();
      if (RESERVED_HEADERS.includes(lower)) {
        throw invalid(`headers.${name}`, `the SDK sets ${name} itself`);
      }
      if (typeof value !== "string") throw invalid(`headers.${name}`, `${name} is not text`);
      headers[lower] = value;
    }
    const client = new SaveslotClient({
      baseUrl: this.#baseUrl,
      credential: this.#credential,
      userAgent: `saveslot-connector-ts/${SDK_VERSION} (${manifest.id}/${manifest.version})`,
      headers,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      ...(this.#retries === undefined ? {} : { retries: this.#retries }),
    });
    return ConnectorClient[CREATE]({ manifest, provider: this.#provider, client });
  }
}

/** A frozen copy of the manifest, once its required fields are there and its platform is known. */
function checkManifest(m: ConnectorManifest | undefined): ConnectorManifest {
  if (m === undefined) throw invalid("manifest", "the manifest is not set");
  for (const field of REQUIRED) {
    const value = m[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(`manifest.${field}`, `the manifest has no ${field}`);
    }
  }
  if (m.homepage !== undefined && typeof m.homepage !== "string") {
    throw invalid("manifest.homepage", "the manifest's homepage is not text");
  }
  const platforms = checkPlatforms(m.platforms);
  const packages = checkPackages(platforms, m.packages);
  return Object.freeze({
    ...m,
    platforms: Object.freeze([...platforms]),
    ...(packages === undefined ? {} : { packages: Object.freeze(packages) }),
  });
}

/** At least one platform, each known, none twice. */
function checkPlatforms(platforms: unknown): ConnectorPlatform[] {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw invalid("manifest.platforms", "the manifest needs at least one platform");
  }
  const seen = new Set<ConnectorPlatform>();
  for (const p of platforms) {
    if (!CONNECTOR_PLATFORMS.includes(p)) {
      throw invalid(
        "manifest.platforms",
        `a platform must be one of ${CONNECTOR_PLATFORMS.join(", ")}`,
      );
    }
    if (seen.has(p)) throw invalid("manifest.platforms", `the platform ${p} is listed twice`);
    seen.add(p);
  }
  return [...seen];
}

/** A package address for every platform but `cloud`, and for no platform not listed. */
function checkPackages(
  platforms: readonly ConnectorPlatform[],
  packages: unknown,
): Record<string, string> | undefined {
  if (packages !== undefined && (typeof packages !== "object" || packages === null)) {
    throw invalid("manifest.packages", "packages maps each platform to its package address");
  }
  const given = (packages ?? {}) as Record<string, unknown>;
  for (const p of platforms) {
    if (p === ConnectorPlatform.Cloud) continue;
    const value = given[p];
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(`manifest.packages.${p}`, `the platform ${p} needs its package address`);
    }
  }
  for (const key of Object.keys(given)) {
    if (!platforms.includes(key as ConnectorPlatform) || key === ConnectorPlatform.Cloud) {
      throw invalid(
        `manifest.packages.${key}`,
        `a package address for ${key}, which is not listed`,
      );
    }
  }
  return packages === undefined ? undefined : { ...(given as Record<string, string>) };
}

function invalid(field: string, message: string): SaveslotError {
  return new SaveslotError("invalid_config", message, { details: { field } });
}
