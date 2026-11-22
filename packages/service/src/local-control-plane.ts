// The local mode's control plane (docs/zh-CN/spec/02-architecture.md §5 «控制面存储», «本机控制面用
// 文件»): files under `<home>/control`. `control/tenant.json` is the tenant directory, with its one
// tenant; `control/anchor.json` the anchor store (§8); `control/credentials.json` the credentials,
// held by the `Credentials` the service loads once the tenant is open, and given to this here.
//
// This is the control plane interface over the files the local mode already had; what it reads and
// writes, and when, is unchanged.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AnchorStore, OpenTenantStop } from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import type {
  ConnectionId,
  ControlPlane,
  CredentialEntry,
  PrincipalId,
  TenantEntry,
  TenantId,
  UserId,
} from "./control-plane.ts";
import { sameHash } from "./tokens.ts";

/** 01-objects «标识的写法»: a prefix and 26 Crockford base-32 characters. */
const CROCKFORD_26 = "[0-9A-HJKMNP-TV-Z]{26}";
const TENANT_ID = new RegExp(`^tn_${CROCKFORD_26}$`);
const USER_ID = new RegExp(`^u_${CROCKFORD_26}$`);

/** Paths under the service's home directory (06-cli §3 «分步做»). */
export const controlDir = (home: string): string => join(home, "control");
export const tenantFile = (home: string): string => join(controlDir(home), "tenant.json");
export const anchorFile = (home: string): string => join(controlDir(home), "anchor.json");

/** The local tenant directory: the one user, their tenant, and where its storage is. */
export interface TenantDirectory {
  readonly user: UserId;
  readonly tenant: TenantId;
  /** The tenant's data directory, an absolute path; `<home>/data` when the file names none. */
  readonly dataDir: string;
}

/** Why the local tenant cannot be opened or cannot serve. Stable codes, no paths, no user data. */
export type LocalTenantFailure =
  /** No readable `control/tenant.json`: the home was not initialized. */
  | "not_initialized"
  /** `control/tenant.json` is not of its form. */
  | "tenant_directory_corrupt"
  /** The tenant storage has no events: not created. */
  | "tenant_empty"
  | OpenTenantStop;

export class LocalTenantError extends Error {
  override readonly name = "LocalTenantError";
  readonly code: LocalTenantFailure;
  constructor(code: LocalTenantFailure, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Reads `control/tenant.json`: `{"format": 1, "user": "u_…", "tenant": "tn_…"}` and, when the data
 * directory is not `<home>/data`, `"data_dir"` with its absolute path; no other keys. A relative
 * or non-string `data_dir` is a corrupt directory, not a path to resolve against anything.
 */
export async function readTenantDirectory(home: string): Promise<TenantDirectory> {
  let text: string;
  try {
    text = await readFile(tenantFile(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LocalTenantError("not_initialized", "the home has no tenant directory");
    }
    throw e;
  }
  const corrupt = () =>
    new LocalTenantError("tenant_directory_corrupt", "the tenant directory is not of its form");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw corrupt();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => k !== "data_dir")
    .sort();
  if (keys.join(",") !== "format,tenant,user" || o["format"] !== 1) throw corrupt();
  // The default is resolved, so that a relative `home` gives an absolute path, not "corrupt".
  const dataDir = Object.hasOwn(o, "data_dir") ? o["data_dir"] : resolve(home, "data");
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) throw corrupt();
  const user = o["user"];
  const tenant = o["tenant"];
  if (typeof user !== "string" || !USER_ID.test(user)) throw corrupt();
  if (typeof tenant !== "string" || !TENANT_ID.test(tenant)) throw corrupt();
  return { user: user as UserId, tenant: tenant as TenantId, dataDir };
}

/** The local credentials as this needs them: what `Credentials` (credentials.ts) has. */
export interface LocalCredentials {
  readonly sessionHash: string;
  connection(hash: string): ConnectionId | undefined;
  addConnection(hash: string, principal: ConnectionId): void;
  removePrincipals(principals: ReadonlySet<string>): number;
  setSession(hash: string): void;
}

const CONNECTION = /^ci_/;
const HASH = /^[0-9a-f]{64}$/;

export class LocalControlPlane implements ControlPlane {
  readonly #home: string;
  readonly #credentials: LocalCredentials | undefined;
  #anchors: AnchorStore | undefined;

  /** The control plane of `home`; credentials only once they are loaded (the tenant is open). */
  constructor(home: string, credentials?: LocalCredentials) {
    this.#home = home;
    this.#credentials = credentials;
  }

  /**
   * The anchor store, opened when first used: opening it lists `control/`, which a home not
   * initialized does not have; that home is `not_initialized` (read from the tenant directory), not
   * an error of the listing.
   */
  get anchors(): AnchorStore {
    this.#anchors ??= openFileAnchorStore(anchorFile(this.#home));
    return this.#anchors;
  }

  /** The tenant directory, read again on each call (`readTenantDirectory`). */
  directory(): Promise<TenantDirectory> {
    return readTenantDirectory(this.#home);
  }

  async tenant(id: TenantId): Promise<TenantEntry | undefined> {
    const d = await this.directory();
    return d.tenant === id ? entryOf(d) : undefined;
  }

  async tenantOf(owner: UserId): Promise<TenantEntry | undefined> {
    const d = await this.directory();
    return d.user === owner ? entryOf(d) : undefined;
  }

  /** A session's hash is the one user's, of the one tenant; a connection's is the file's. */
  async credential(hash: string): Promise<CredentialEntry | undefined> {
    // Only a hash as it is computed: anything else is no credential, as in the server mode.
    if (!HASH.test(hash)) return undefined;
    const c = this.#loaded();
    const d = await this.directory();
    if (sameHash(hash, c.sessionHash)) {
      return { hash, kind: "session", principal: d.user, tenant: d.tenant };
    }
    const principal = c.connection(hash);
    return principal === undefined
      ? undefined
      : { hash, kind: "connection", principal, tenant: d.tenant };
  }

  /** A session's hash replaces the one there is; a connection's is added. Local ones never expire. */
  async putCredential(e: CredentialEntry): Promise<void> {
    const c = this.#loaded();
    const d = await this.directory();
    if (e.tenant !== d.tenant) throw new Error("not the local tenant");
    if (e.expiresAt !== undefined) throw new Error("local credentials do not expire");
    if (e.grant !== undefined) throw new Error("local credentials come from no grant");
    if (e.kind === "session") {
      if (e.principal !== d.user) throw new Error("not the local user");
      c.setSession(e.hash);
    } else {
      if (!CONNECTION.test(e.principal)) throw new Error("not a connection instance");
      c.addConnection(e.hash, e.principal as ConnectionId);
    }
  }

  /**
   * The connection tokens of these principals go; the one session is replaced, never removed, so
   * asking for sessions only is refused rather than answered with none gone.
   */
  async removeCredentials(
    tenant: TenantId,
    principals: ReadonlySet<PrincipalId>,
    opts: { readonly kind?: "session" | "connection" } = {},
  ): Promise<number> {
    const c = this.#loaded();
    if (tenant !== (await this.directory()).tenant) throw new Error("not the local tenant");
    if (opts.kind === "session") throw new Error("the local session is replaced, never removed");
    return c.removePrincipals(principals);
  }

  #loaded(): LocalCredentials {
    if (this.#credentials === undefined) throw new Error("the local credentials are not loaded");
    return this.#credentials;
  }
}

function entryOf(d: TenantDirectory): TenantEntry {
  return {
    id: d.tenant,
    owner: d.user,
    ref: { kind: "pglite", dir: d.dataDir },
    state: "active",
  };
}
