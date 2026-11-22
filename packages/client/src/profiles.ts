// The profiles a CLI connects with (06-cli §2 «profile»): `local`, the local saveslot service;
// `cloud`, the hosted service at CLOUD_SERVER; and the self-hosted servers registered by
// `saveslot login --server <URL> --profile <name>`. `~/.saveslot/profiles.json` holds the
// registered ones and the profile in use; it is the CLI's own file, not the service's
// configuration. Without the file the profile in use is `local` and none is registered.
//
// {"format": 1, "current": "<name>", "servers": {"<name>": "<origin>"}}
//
// Parsed strictly: those three keys and no other; `current` built in or registered; each
// registered name of the profiles' form and not built in, its server an origin as `serverOrigin`
// takes it, written as that origin. The file is private and written atomically (./private-files.ts).

import { join } from "node:path";
import { CredentialError } from "./credentials.ts";
import { readPrivateFile, writePrivateFile } from "./private-files.ts";
import { ClientUsageError, serverOrigin } from "./transport.ts";

/** The hosted service's external address: the `cloud` profile's server. */
export const CLOUD_SERVER = "https://api.saveslot.ai";

/** The profiles every CLI has; neither can be registered. */
export const BUILT_IN_PROFILES = ["local", "cloud"] as const;

/** A profile's name: also a file name under `credentials/`, so checked before any path is made. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Profiles {
  /** The profile in use. */
  readonly current: string;
  /** The registered profiles' servers, by name. */
  readonly servers: ReadonlyMap<string, string>;
}

/** `profiles.json` under a home. */
export const profilesFile = (home: string): string => join(home, "profiles.json");

const MAX_FILE_BYTES = 64 * 1024;

const builtIn = (name: string) => (BUILT_IN_PROFILES as readonly string[]).includes(name);

/** The origin a server is registered as, or undefined when it is none. */
function originOf(server: unknown): string | undefined {
  try {
    return serverOrigin(server).origin;
  } catch {
    return undefined;
  }
}

/** Reads `profiles.json`; without it, `local` in use and nothing registered. */
export async function readProfiles(home: string): Promise<Profiles> {
  const file = profilesFile(home);
  const text = await readPrivateFile([home], file, MAX_FILE_BYTES);
  if (text === undefined) return { current: "local", servers: new Map() };
  const bad = () => new CredentialError("malformed", `${file} is not a profiles file`, file);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(",") !== "current,format,servers" || o["format"] !== 1) throw bad();
  const s = o["servers"];
  if (s === null || typeof s !== "object" || Array.isArray(s)) throw bad();
  const servers = new Map<string, string>();
  for (const name of Object.keys(s)) {
    const server = (s as Record<string, unknown>)[name];
    if (!PROFILE_NAME.test(name) || builtIn(name) || originOf(server) !== server) throw bad();
    servers.set(name, server as string);
  }
  const current = o["current"];
  if (typeof current !== "string" || !(builtIn(current) || servers.has(current))) throw bad();
  return { current, servers };
}

async function writeProfiles(home: string, p: Profiles): Promise<void> {
  const servers: Record<string, string> = Object.create(null);
  for (const [name, server] of [...p.servers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    servers[name] = server;
  }
  const text = `${JSON.stringify({ format: 1, current: p.current, servers }, null, 2)}\n`;
  await writePrivateFile([home], "profiles.json", text);
}

/**
 * The server of profile `name`: undefined for `local` (the local service's socket), CLOUD_SERVER
 * for `cloud`, the registered origin for another; `unknown_profile` for a name none of these.
 */
export async function profileServer(home: string, name: string): Promise<string | undefined> {
  if (name === "local") return undefined;
  if (name === "cloud") return CLOUD_SERVER;
  const server = (await readProfiles(home)).servers.get(name);
  if (server === undefined) {
    throw new CredentialError("unknown_profile", `no profile ${name}: see saveslot profile list`);
  }
  return server;
}

/**
 * Registers profile `name` at `server` (`saveslot login --server`), or moves a registered one to
 * another server; the profile in use stays as it is. A built-in name, a name not of the form, or
 * a server that is no origin: a usage error, nothing written.
 */
export async function addProfile(home: string, name: string, server: string): Promise<void> {
  if (!PROFILE_NAME.test(name)) {
    throw new ClientUsageError("a profile's name is 1 to 32 of a-z, 0-9 and -, starting with no -");
  }
  if (builtIn(name)) throw new ClientUsageError(`${name} is a built-in profile`);
  const origin = serverOrigin(server).origin;
  const p = await readProfiles(home);
  await writeProfiles(home, { current: p.current, servers: new Map(p.servers).set(name, origin) });
}

/** Puts profile `name` in use (`saveslot profile use`): built in or registered. */
export async function useProfile(home: string, name: string): Promise<void> {
  const p = await readProfiles(home);
  if (!builtIn(name) && !p.servers.has(name)) {
    throw new CredentialError("unknown_profile", `no profile ${name}: see saveslot profile list`);
  }
  await writeProfiles(home, { current: name, servers: p.servers });
}
