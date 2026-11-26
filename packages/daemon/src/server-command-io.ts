// What a `saveslot server …` command is given (server-commands.ts, server-restore-command.ts,
// server-user-command.ts): a module of its own, so that they import it without importing each other.

import type { restoreTenantFromBackup } from "@fluxvita/saveslot-service";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import type { CommandIO } from "./commands.ts";
import type { DatabaseAt } from "./server-config.ts";
import type { PasswordTerminal } from "./server-password.ts";

export interface ServerCommandIO extends CommandIO {
  /** The process's environment: where the configuration is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Opens the control database (a test gives one of its own backend's). */
  readonly openControl?: (at: DatabaseAt) => Promise<ControlDatabase>;
  /** `server start`: resolves when the server is to stop (default: SIGTERM or SIGINT). */
  readonly stopped?: () => Promise<void>;
  /**
   * `server start`, once closing: resolves at a stop signal that is to cut the closing short (default:
   * SIGTERM or SIGINT again).
   */
  readonly stoppedAgain?: () => Promise<void>;
  /**
   * The terminal a password is asked on (default: the controlling terminal); undefined when there
   * is none.
   */
  readonly terminal?: () => PasswordTerminal | undefined;
}

/** What `restore` and the commands that make tenants are given besides (a test gives its own). */
export interface ServerRestoreIO extends ServerCommandIO {
  /** Opens the tenants' databases (a test gives its own backend). */
  readonly backend?: Parameters<typeof restoreTenantFromBackup>[0]["backend"];
  /** The clock, in `toISOString` form. */
  readonly now?: () => string;
}
