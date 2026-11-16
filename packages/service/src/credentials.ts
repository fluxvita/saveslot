// The local credentials (docs/zh-CN/spec/02-architecture.md §5 «控制面存储»; 06-cli.md §2
// «用户会话凭证», §3.2): `control/credentials.json` holds the hash of the user session token and,
// for each connection instance token, its hash and the principal it stands for — nothing else (the
// scopes and slot ranges are the tenant log's). The session token itself is in
// `credentials/session`, for the CLI.
//
//   {"format": 1, "session": {"hash": "<hex>"}, "connections": [{"hash": "<hex>", "principal": "ci_…"}]}
//
// In memory the connections are a Map from hash to principal: a hash is computed from what a caller
// sent, and is never used as a property name.

import { join } from "node:path";
import { ControlFileError, readPrivate, writePrivate } from "./control-files.ts";
import { controlDir } from "./local-tenant.ts";

type ConnectionId = `ci_${string}`;

export const credentialsFile = (home: string): string => join(controlDir(home), "credentials.json");
export const credentialsDir = (home: string): string => join(home, "credentials");
export const sessionFile = (home: string): string => join(credentialsDir(home), "session");

const HASH = /^[0-9a-f]{64}$/;
/** 01-objects «标识的写法»: `ci_` and 26 Crockford base-32 characters. */
const CONNECTION_ID = /^ci_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `control/credentials.json` is not of its form. */
export class CredentialsCorrupt extends Error {
  override readonly name = "CredentialsCorrupt";
  readonly code = "credentials_corrupt";
}

export class Credentials {
  readonly #path: string;
  #session: string;
  readonly #connections: Map<string, ConnectionId>;

  private constructor(path: string, session: string, connections: Map<string, ConnectionId>) {
    this.#path = path;
    this.#session = session;
    this.#connections = connections;
  }

  /** A new set of credentials with the session's hash, written to `home`. */
  static create(home: string, sessionHash: string): Credentials {
    const c = new Credentials(credentialsFile(home), sessionHash, new Map());
    c.save();
    return c;
  }

  /** Reads `home`'s credentials, checking the file's and its directory's owner and mode. */
  static async load(home: string): Promise<Credentials> {
    const path = credentialsFile(home);
    const text = await readPrivate(path);
    if (text === undefined) throw new CredentialsCorrupt("the home has no credentials");
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new CredentialsCorrupt("the credentials are not JSON");
    }
    const bad = () => new CredentialsCorrupt("the credentials are not of their form");
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad();
    const o = v as Record<string, unknown>;
    if (Object.keys(o).sort().join(",") !== "connections,format,session" || o["format"] !== 1) {
      throw bad();
    }
    const s = o["session"] as Record<string, unknown> | null;
    if (s === null || typeof s !== "object" || Array.isArray(s)) throw bad();
    if (Object.keys(s).join(",") !== "hash" || typeof s["hash"] !== "string") throw bad();
    if (!HASH.test(s["hash"])) throw bad();
    const list = o["connections"];
    if (!Array.isArray(list)) throw bad();
    const connections = new Map<string, ConnectionId>();
    for (const x of list) {
      if (x === null || typeof x !== "object" || Array.isArray(x)) throw bad();
      const e = x as Record<string, unknown>;
      const hash = e["hash"];
      const principal = e["principal"];
      if (Object.keys(e).sort().join(",") !== "hash,principal") throw bad();
      if (typeof hash !== "string" || !HASH.test(hash)) throw bad();
      if (typeof principal !== "string" || !CONNECTION_ID.test(principal)) throw bad();
      if (connections.has(hash)) throw bad();
      connections.set(hash, principal as ConnectionId);
    }
    return new Credentials(path, s["hash"], connections);
  }

  get sessionHash(): string {
    return this.#session;
  }

  /** The principal a connection token's hash stands for. */
  connection(hash: string): ConnectionId | undefined {
    return this.#connections.get(hash);
  }

  /** The connection principals with a token here. */
  principals(): ConnectionId[] {
    return [...new Set(this.#connections.values())];
  }

  /** Records a connection token's hash, durably. */
  addConnection(hash: string, principal: ConnectionId): void {
    if (!HASH.test(hash)) throw new Error("not a token hash");
    this.#connections.set(hash, principal);
    this.save();
  }

  /** Forgets every token of these principals, durably; how many hashes went. */
  removePrincipals(principals: ReadonlySet<string>): number {
    let n = 0;
    for (const [hash, p] of [...this.#connections]) {
      if (principals.has(p)) {
        this.#connections.delete(hash);
        n++;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /** Replaces the session's hash, durably. */
  setSession(hash: string): void {
    if (!HASH.test(hash)) throw new Error("not a token hash");
    this.#session = hash;
    this.save();
  }

  save(): void {
    const connections = [...this.#connections].map(([hash, principal]) => ({ hash, principal }));
    writePrivate(
      this.#path,
      `${JSON.stringify({ format: 1, session: { hash: this.#session }, connections })}\n`,
    );
  }
}

export { ControlFileError };
