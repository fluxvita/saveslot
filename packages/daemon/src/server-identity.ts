// The server's identity provider (docs/zh-CN/spec/06-cli.md §4.1 «服务器模式的配置»; 02-architecture
// §12 «身份提供者»): the external login when its three settings are given, the built-in local
// accounts when none is. `server init` makes the chosen provider's tables in the control database
// and only those; `server start` opens them and makes none, so a provider changed afterwards needs
// `server init` run again with the new settings.

import {
  ExternalIdentity,
  type ExternalLoginConfig,
  ExternalLoginError,
  type IdentityProvider,
  initExternalLogin,
  initLocalAccounts,
  LocalAccountsError,
  LocalIdentity,
  openExternalLogin,
  openLocalAccounts,
  readExternalLoginConfig,
  type ServerControlPlane,
  type TenantPoolOptions,
} from "@fluxvita/saveslot-service";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import type { ServerConfig } from "./server-config.ts";

/** How long a login of a local account lasts (05-surfaces §15 «本地账户的登录页»). */
export const LOCAL_LOGIN_MS = 12 * 60 * 60 * 1000;

/** The external login's settings refused: a login address or key file it cannot use. */
export class ServerIdentityRefused extends Error {
  override readonly name = "ServerIdentityRefused";
}

/** The provider's tables in the control database are not there or of another format. */
export class IdentityTablesRefused extends Error {
  override readonly name = "IdentityTablesRefused";
  readonly set: "accounts" | "external";
  readonly reason: "not_initialized" | "format";
  constructor(set: IdentityTablesRefused["set"], reason: IdentityTablesRefused["reason"]) {
    super(`the ${set} tables are ${reason === "format" ? "of another format" : "not there"}`);
    this.set = set;
    this.reason = reason;
  }
}

/**
 * The external login's configuration when its settings are given, read before the control
 * database is opened: a key file it cannot use refuses with nothing done (the message names the
 * variable and what is wrong, never a key). Undefined: the local accounts.
 */
export async function readIdentity(config: ServerConfig): Promise<ExternalLoginConfig | undefined> {
  if (config.identity === undefined) return undefined;
  try {
    return await readExternalLoginConfig({ ...config.identity, audience: config.publicUrl });
  } catch (e) {
    if (e instanceof ExternalLoginError) throw new ServerIdentityRefused(e.message);
    throw e;
  }
}

/** Makes the provider's tables when they are missing, checks their format when they are not. */
export async function initIdentityTables(
  db: ControlDatabase,
  external: ExternalLoginConfig | undefined,
): Promise<void> {
  try {
    if (external !== undefined) await initExternalLogin(db);
    else await initLocalAccounts(db);
  } catch (e) {
    throw refusal(e) ?? e;
  }
}

/** The provider, over the tables `server init` made; none are made here. */
export async function openIdentity(o: {
  readonly db: ControlDatabase;
  readonly config: ServerConfig;
  readonly external: ExternalLoginConfig | undefined;
  readonly control: ServerControlPlane;
  readonly backend: TenantPoolOptions["backend"];
  readonly now: () => string;
}): Promise<IdentityProvider> {
  try {
    if (o.external !== undefined) {
      return new ExternalIdentity({
        logins: await openExternalLogin(o.db),
        config: o.external,
        control: o.control,
        backend: o.backend,
        cell: o.config.cellName,
        cells: new Set([o.config.cellName]),
        now: () => Date.parse(o.now()),
      });
    }
    return new LocalIdentity({
      accounts: await openLocalAccounts(o.db),
      loginMs: LOCAL_LOGIN_MS,
      origin: o.config.publicUrl,
      now: () => Date.parse(o.now()),
    });
  } catch (e) {
    throw refusal(e) ?? e;
  }
}

function refusal(e: unknown): IdentityTablesRefused | undefined {
  if (!(e instanceof LocalAccountsError) && !(e instanceof ExternalLoginError)) return undefined;
  switch (e.code) {
    case "accounts_not_initialized":
      return new IdentityTablesRefused("accounts", "not_initialized");
    case "accounts_format_mismatch":
      return new IdentityTablesRefused("accounts", "format");
    case "external_not_initialized":
      return new IdentityTablesRefused("external", "not_initialized");
    case "external_format_mismatch":
      return new IdentityTablesRefused("external", "format");
    default:
      return undefined;
  }
}
