// Paging handles (docs/zh-CN/spec/02-architecture.md §5 «句柄»; 04-contract.md §13, §15): the
// kernel pages by an unsigned position, which binds the query's parameters, the first page's
// operation and the restore count, and checks them itself. The service layer hands it out as
// `cur_…`, signed, bound to the principal it was given to, and valid for one hour; it takes one
// back only with a good signature, from the same principal, before it expires.
//
//   cur_<base64url of {"v":1,"k":<key ID>,"a":<principal>,"p":<position>,"x":<expiry>}>.<base64url of HMAC-SHA256>
//
// The keys are in `control/keys/cursor.json` (a control file: this user's, 0600, in a 0700
// directory), each with an ID. Rotating makes a new current key and retires the old one; a retired
// key still verifies the handles it signed, which expire within the hour, and is deleted once an
// hour has passed since it was retired. So the file holds the current key and the keys retired in
// the last hour, no more.
//
// A handle that does not verify (unknown key, another signature, not of the form) or was given to
// another principal is `invalid_argument` (`malformed`, `param: "cursor"`); one that verifies but
// is past its expiry is `handle_expired` (`expired`). Used on another query, the kernel refuses its
// position.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContractError } from "./contract-error.ts";
import { ensureDir, readPrivate, writePrivate } from "./control-files.ts";
import { controlDir } from "./local-tenant.ts";
import { readSecretFile, SecretFileError } from "./secret-file.ts";

/** How long a paging handle is good for (04-contract §15), and a retired key is kept. */
export const CURSOR_TTL_MS = 60 * 60 * 1000;
const MAX_CURSOR = 16_384;

export const keysDir = (home: string): string => join(controlDir(home), "keys");
export const cursorKeysFile = (home: string): string => join(keysDir(home), "cursor.json");

const KEY_ID = /^k[0-9a-f]{16}$/;
const SECRET = /^[0-9a-f]{64}$/;
const FORM = /^cur_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

/** `control/keys/cursor.json` is not of its form. */
export class CursorKeysCorrupt extends Error {
  override readonly name = "CursorKeysCorrupt";
  readonly code = "cursor_keys_corrupt";
}

/** The server mode's handle key file cannot be used; the message names no path or content. */
export class HandleKeyFileError extends Error {
  override readonly name = "HandleKeyFileError";
  readonly code: "missing" | "not_a_file" | "open_to_others" | "unreadable" | "corrupt";
  constructor(code: HandleKeyFileError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const HANDLE_KEY_FILE_PROBLEM: Readonly<Record<SecretFileError["code"], string>> = {
  missing: "the handle key file is not there",
  not_a_file: "the handle key file is not a file",
  open_to_others: "the handle key file is open to others",
  unreadable: "the handle key file cannot be read",
};

interface Key {
  readonly id: string;
  readonly secret: string;
  /** Retired: when (it verifies until an hour after, then goes). */
  readonly retired_at?: string;
}

const malformed = () =>
  new ContractError("invalid_argument", "the cursor is not one this service gave", {
    reason: "malformed",
    param: "cursor",
  });

const newKey = (): Key => ({
  id: `k${randomBytes(8).toString("hex")}`,
  secret: randomBytes(32).toString("hex"),
});

function parse(text: string): { current: string; keys: Key[] } {
  const bad = () => new CursorKeysCorrupt("the cursor keys are not of their form");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "current,format,keys" || o["format"] !== 1) throw bad();
  const list = o["keys"];
  if (!Array.isArray(list) || list.length === 0) throw bad();
  const keys: Key[] = [];
  const ids = new Set<string>();
  for (const x of list) {
    if (x === null || typeof x !== "object" || Array.isArray(x)) throw bad();
    const e = x as Record<string, unknown>;
    const shape = Object.keys(e).sort().join(",");
    if (shape !== "id,secret" && shape !== "id,retired_at,secret") throw bad();
    const { id, secret, retired_at } = e;
    if (typeof id !== "string" || !KEY_ID.test(id) || ids.has(id)) throw bad();
    if (typeof secret !== "string" || !SECRET.test(secret)) throw bad();
    if (
      retired_at !== undefined &&
      (typeof retired_at !== "string" || Number.isNaN(Date.parse(retired_at)))
    ) {
      throw bad();
    }
    ids.add(id);
    keys.push({ id, secret, ...(retired_at !== undefined ? { retired_at } : {}) });
  }
  const current = o["current"];
  const cur = keys.find((k) => k.id === current);
  if (typeof current !== "string" || cur === undefined || cur.retired_at !== undefined) throw bad();
  return { current, keys };
}

const write = (home: string, current: string, keys: readonly Key[]) =>
  writePrivate(cursorKeysFile(home), `${JSON.stringify({ format: 1, current, keys })}\n`);

export class CursorKeys {
  readonly #current: string;
  readonly #keys: Map<string, Key>;

  private constructor(current: string, keys: readonly Key[]) {
    this.#current = current;
    this.#keys = new Map(keys.map((k) => [k.id, k]));
  }

  /**
   * The home's keys: a first key made when there are none; keys retired more than an hour before
   * `now` deleted.
   */
  static async open(home: string, now: string = new Date().toISOString()): Promise<CursorKeys> {
    await ensureDir(keysDir(home));
    const text = await readPrivate(cursorKeysFile(home));
    if (text === undefined) {
      const k = newKey();
      write(home, k.id, [k]);
      return new CursorKeys(k.id, [k]);
    }
    const { current, keys } = parse(text);
    const kept = keys.filter(
      (k) =>
        k.retired_at === undefined || Date.parse(now) - Date.parse(k.retired_at) < CURSOR_TTL_MS,
    );
    if (kept.length !== keys.length) write(home, current, kept);
    return new CursorKeys(current, kept);
  }

  /**
   * Makes a new current key, retiring the current one at `now`, and deletes keys retired more than
   * an hour before. The service holds the home's lock while it runs, so only it calls this.
   */
  static async rotate(home: string, now: string): Promise<CursorKeys> {
    const old = await CursorKeys.open(home, now);
    const k = newKey();
    const keys = [
      ...[...old.#keys.values()].map((x) =>
        x.id === old.#current ? { ...x, retired_at: now } : x,
      ),
      k,
    ];
    write(home, k.id, keys);
    return new CursorKeys(k.id, keys);
  }

  /**
   * The server mode's keys, from the file the deployer keeps (06-cli §4.1
   * `SAVESLOT_HANDLE_KEY_FILE`): read, never written, checked as every secret file is
   * (./secret-file.ts). Its retired keys are kept as they are: rotating is the deployer's, by
   * replacing the file.
   */
  static async fromFile(path: string): Promise<CursorKeys> {
    let text: string;
    try {
      text = await readSecretFile(path);
    } catch (e) {
      if (!(e instanceof SecretFileError)) throw e;
      throw new HandleKeyFileError(e.code, HANDLE_KEY_FILE_PROBLEM[e.code]);
    }
    let parsed: { current: string; keys: Key[] };
    try {
      parsed = parse(text);
    } catch (e) {
      if (!(e instanceof CursorKeysCorrupt)) throw e;
      throw new HandleKeyFileError("corrupt", "the handle key file is not of its form");
    }
    return new CursorKeys(parsed.current, parsed.keys);
  }

  /**
   * Makes the server mode's key file with a first key (0600, durably), its directory being
   * there; a file already there is checked as `fromFile` checks it and left as it is.
   */
  static async createFile(path: string): Promise<{ readonly created: boolean }> {
    const k = newKey();
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await CursorKeys.fromFile(path);
      return { created: false };
    }
    try {
      writeSync(fd, `${JSON.stringify({ format: 1, current: k.id, keys: [k] })}\n`);
      fsyncSync(fd);
    } catch (e) {
      // An empty or partial file would be refused as corrupt by every later run.
      closeSync(fd);
      rmSync(path, { force: true });
      throw e;
    }
    closeSync(fd);
    const d = openSync(dirname(path), "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    return { created: true };
  }

  /** The key IDs held: the current one and those retired in the last hour. */
  keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  /** The handle of a kernel position for `principal`, good for an hour from `now`. */
  sign(position: string, principal: string, now: string): string {
    const expiry = new Date(Date.parse(now) + CURSOR_TTL_MS).toISOString();
    const payload = Buffer.from(
      JSON.stringify({ v: 1, k: this.#current, a: principal, p: position, x: expiry }),
      "utf8",
    ).toString("base64url");
    return `cur_${payload}.${this.#mac(this.#current, payload).toString("base64url")}`;
  }

  /**
   * The kernel position of a handle this service gave `principal`, if it verifies and has not
   * expired.
   */
  verify(cursor: unknown, principal: string, now: string): string {
    if (typeof cursor !== "string" || cursor.length > MAX_CURSOR) throw malformed();
    const m = FORM.exec(cursor);
    if (m === null) throw malformed();
    const payload = m[1] as string;
    let o: Record<string, unknown>;
    try {
      const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw malformed();
      o = v as Record<string, unknown>;
    } catch {
      throw malformed();
    }
    if (Object.keys(o).sort().join(",") !== "a,k,p,v,x" || o["v"] !== 1) throw malformed();
    const id = o["k"];
    if (typeof id !== "string" || !this.#keys.has(id)) throw malformed();
    const given = Buffer.from(m[2] as string, "base64url");
    // Only the one canonical spelling: the last character's spare bits make others decode alike.
    if (given.toString("base64url") !== m[2]) throw malformed();
    const want = this.#mac(id, payload);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw malformed();
    const { a, p, x } = o;
    // Given to another principal: as if it were not this service's (who holds it is no one's
    // business but the holder's).
    if (a !== principal) throw malformed();
    if (typeof p !== "string" || typeof x !== "string") throw malformed();
    const at = Date.parse(x);
    if (Number.isNaN(at)) throw malformed();
    if (Date.parse(now) >= at) {
      throw new ContractError("handle_expired", "the cursor has expired; query again", {
        reason: "expired",
        param: "cursor",
      });
    }
    return p;
  }

  #mac(id: string, payload: string): Buffer {
    const k = this.#keys.get(id) as Key;
    return createHmac("sha256", Buffer.from(k.secret, "hex"))
      .update(`cur_v1.${payload}`, "utf8")
      .digest();
  }
}
