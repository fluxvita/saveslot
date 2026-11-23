// The server mode's configuration (docs/zh-CN/spec/06-cli.md §4.1 «服务器模式的配置», §6.2): read
// from the environment only, never from a config.toml. Every variable is checked and every problem
// is reported at once, in the order of that table; a problem names the variable and what is wrong
// with it, never the value (a connection URL may hold a password). `saveslot server …` refuses
// with exit code 5 when there is any.

import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { normalizeAddress } from "@fluxvita/saveslot-service";
import type { PostgresCell } from "@fluxvita/saveslot-store-postgres";

/** The variables, in the order of 06-cli §4.1's table. */
export const SERVER_VARIABLES = [
  "SAVESLOT_CONTROL_DATABASE_URL",
  "SAVESLOT_CELL_DATABASE_URL",
  "SAVESLOT_PUBLIC_URL",
  "SAVESLOT_HANDLE_KEY_FILE",
  "SAVESLOT_LISTEN",
  "SAVESLOT_TRUSTED_PROXIES",
  "SAVESLOT_RATE_LIMIT",
  "SAVESLOT_RATE_BURST",
  "SAVESLOT_IDENTITY_ISSUER",
  "SAVESLOT_IDENTITY_LOGIN_URL",
  "SAVESLOT_IDENTITY_KEYS_FILE",
] as const;
export type ServerVariable = (typeof SERVER_VARIABLES)[number];

/** A database: how its server is reached, and its name. */
export interface DatabaseAt {
  readonly cell: PostgresCell;
  readonly database: string;
}

export interface ServerConfig {
  readonly control: DatabaseAt;
  /** The one cell; its database is the maintenance database tenants' databases are made from. */
  readonly cell: PostgresCell;
  /** The one cell's name (`SELF_HOSTED_CELL`), as tenants record it. */
  readonly cellName: string;
  /** The public address's origin, no trailing slash: `https://saveslot.example.com`. */
  readonly publicUrl: string;
  readonly handleKeyFile: string;
  readonly listen: { readonly host: string; readonly port: number };
  /** Each as `normalizeAddress` writes it. */
  readonly trustedProxies: readonly string[];
  /** Absent: rate limiting is off. */
  readonly rateLimit?: { readonly perMinute: number; readonly burst: number };
  /**
   * The external login's three settings, all set; absent, the identity provider is the local
   * accounts. The address and the key file are checked when they are read (server-identity.ts).
   */
  readonly identity?: {
    readonly issuer: string;
    readonly loginUrl: string;
    readonly keysFile: string;
  };
}

export type ServerConfigProblem =
  | { readonly kind: "missing"; readonly variable: ServerVariable }
  | {
      readonly kind: "malformed";
      readonly variable: ServerVariable;
      /** What is wrong, in words that hold nothing of the value. */
      readonly what: string;
    };

export class ServerConfigInvalid extends Error {
  override readonly name = "ServerConfigInvalid";
  readonly problems: readonly ServerConfigProblem[];
  constructor(problems: readonly ServerConfigProblem[]) {
    super("the server mode's configuration is not valid");
    this.problems = problems;
  }
}

/**
 * The configuration's default listening address (06-cli §4.1): loopback, since the process speaks
 * plain HTTP; a reverse proxy on the same machine reaches it, anything else is written out.
 */
export const DEFAULT_LISTEN = "127.0.0.1:8080";

/**
 * The name of a self-hosted server's one cell (02-architecture §9: one cell): what the control
 * plane records as each tenant's cell, so it never changes.
 */
export const SELF_HOSTED_CELL = "main";

class Bad extends Error {}

const SSL_MODES: Readonly<Record<string, PostgresCell["ssl"]>> = {
  disable: false,
  require: { rejectUnauthorized: false },
  "verify-full": true,
};

/** `part` of a URL with its percent-escapes decoded; a `%` the URL keeps as it is is refused. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch (e) {
    if (!(e instanceof URIError)) throw e;
    throw new Bad("has a % that is not a percent-escape");
  }
}

/** A `postgres://user[:password]@host[:port]/database[?sslmode=…]` URL. */
function database(text: string): DatabaseAt {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Bad("not a URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Bad("not a postgres:// URL");
  }
  if (u.hash !== "") throw new Bad("has a fragment");
  const host = decoded(u.hostname);
  if (host === "") throw new Bad("no host");
  const user = decoded(u.username);
  if (user === "") throw new Bad("no user");
  const name = decoded(u.pathname.replace(/^\//, ""));
  if (name === "" || name.includes("/")) throw new Bad("no database name");
  let ssl: PostgresCell["ssl"] | undefined;
  for (const [k, v] of u.searchParams) {
    if (k !== "sslmode") throw new Bad("has a parameter other than sslmode");
    if (!Object.hasOwn(SSL_MODES, v)) {
      throw new Bad("sslmode is not one of disable, require, verify-full");
    }
    ssl = SSL_MODES[v];
  }
  const cell: PostgresCell = {
    host: host.startsWith("[") ? host.slice(1, -1) : host,
    user,
    ...(u.port !== "" ? { port: Number(u.port) } : {}),
    ...(u.password !== "" ? { password: decoded(u.password) } : {}),
    ...(ssl !== undefined ? { ssl } : {}),
  };
  return { cell, database: name };
}

/** A loopback host as a URL gives it: 127.0.0.0/8, [::1], or localhost. */
const loopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));

function publicUrl(text: string): string {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Bad("not a URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Bad("not an https:// URL");
  // The OAuth issuer and resource identifier (06-cli §4.1): plain HTTP only for a local trial.
  if (u.protocol === "http:" && !loopback(u.hostname)) {
    throw new Bad("http:// is taken on a loopback host only; give https://");
  }
  if (u.username !== "" || u.password !== "") throw new Bad("has a user or password");
  // `/mcp`, `/v1` and `/oauth/*` are appended to it: no path, and no trailing slash.
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "" || text.endsWith("/")) {
    throw new Bad("has a path, a trailing /, a query or a fragment: give the origin only");
  }
  return u.origin;
}

function listen(text: string): { host: string; port: number } {
  const i = text.lastIndexOf(":");
  if (i <= 0) throw new Bad("not <address>:<port>");
  const raw = text.slice(0, i);
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (isIP(host) === 0) throw new Bad("the address is not an IP address");
  const port = text.slice(i + 1);
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Bad("the port is not 1 to 65535");
  }
  return { host, port: Number(port) };
}

/**
 * Single addresses only, in the form requests' sources are compared in (02-architecture §5): no
 * range, port or zone, which `normalizeAddress` does not take.
 */
function proxies(text: string): string[] {
  if (text.trim() === "") return [];
  const list = text.split(",").map((s) => normalizeAddress(s));
  if (list.some((a) => a === undefined)) {
    throw new Bad("an entry is not a single IP address (no range, port or zone)");
  }
  return list as string[];
}

const count = (text: string, min: number): number => {
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) < min) {
    throw new Bad(min === 0 ? "not an integer of 0 or more" : "not a positive integer");
  }
  return Number(text);
};

const IDENTITY_VARIABLES = [
  "SAVESLOT_IDENTITY_ISSUER",
  "SAVESLOT_IDENTITY_LOGIN_URL",
  "SAVESLOT_IDENTITY_KEYS_FILE",
] as const;

/** The configuration from the environment; throws `ServerConfigInvalid` with every problem. */
export function readServerConfig(
  given: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const problems: ServerConfigProblem[] = [];
  // An identity setting of spaces only is not set: taken as set, it would choose the external login.
  const env: Readonly<Record<string, string | undefined>> = {
    ...given,
    ...Object.fromEntries(
      IDENTITY_VARIABLES.filter((v) => given[v]?.trim() === "").map((v) => [v, undefined]),
    ),
  };
  const take = <T>(variable: ServerVariable, required: boolean, parse: (s: string) => T) => {
    const text = env[variable];
    if (text === undefined || text === "") {
      if (required) problems.push({ kind: "missing", variable });
      return undefined;
    }
    try {
      return parse(text);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      problems.push({ kind: "malformed", variable, what: e.message });
      return undefined;
    }
  };
  const control = take("SAVESLOT_CONTROL_DATABASE_URL", true, database);
  const cellAt = take("SAVESLOT_CELL_DATABASE_URL", true, database);
  const pub = take("SAVESLOT_PUBLIC_URL", true, publicUrl);
  const keyFile = take("SAVESLOT_HANDLE_KEY_FILE", true, (s) => {
    if (!isAbsolute(s)) throw new Bad("not an absolute path");
    return s;
  });
  const at = take("SAVESLOT_LISTEN", false, listen) ?? listen(DEFAULT_LISTEN);
  const trusted = take("SAVESLOT_TRUSTED_PROXIES", false, proxies) ?? [];
  const perMinute = take("SAVESLOT_RATE_LIMIT", false, (s) => count(s, 0)) ?? 0;
  const burst = take("SAVESLOT_RATE_BURST", false, (s) => count(s, 1));
  // The external login takes all three or none: some set and not the others is a mistake, refused
  // naming the ones missing rather than taken as either identity provider.
  const set = IDENTITY_VARIABLES.filter((v) => (env[v] ?? "") !== "");
  const identity =
    set.length === 0
      ? undefined
      : {
          issuer: take("SAVESLOT_IDENTITY_ISSUER", true, (s) => s),
          loginUrl: take("SAVESLOT_IDENTITY_LOGIN_URL", true, (s) => s),
          keysFile: take("SAVESLOT_IDENTITY_KEYS_FILE", true, (s) => {
            if (!isAbsolute(s)) throw new Bad("not an absolute path");
            return s;
          }),
        };
  if (problems.length > 0) throw new ServerConfigInvalid(problems);
  if (control === undefined || cellAt === undefined || pub === undefined || keyFile === undefined) {
    throw new Error("unreachable: a required variable without a problem");
  }
  return {
    control,
    cell: { ...cellAt.cell, maintenanceDatabase: cellAt.database },
    cellName: SELF_HOSTED_CELL,
    publicUrl: pub,
    handleKeyFile: keyFile,
    listen: at,
    trustedProxies: trusted,
    // The burst means nothing while the limit is off (06-cli §4.1).
    ...(perMinute > 0 ? { rateLimit: { perMinute, burst: burst ?? perMinute } } : {}),
    ...(identity !== undefined
      ? {
          identity: {
            issuer: identity.issuer as string,
            loginUrl: identity.loginUrl as string,
            keysFile: identity.keysFile as string,
          },
        }
      : {}),
  };
}
