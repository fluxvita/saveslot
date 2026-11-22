// What a `saveslot server …` command is given (server-commands.ts, server-restore-command.ts): a
// module of its own, so that the two import it without importing each other.

import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import type { CommandIO } from "./commands.ts";
import type { DatabaseAt } from "./server-config.ts";

export interface ServerCommandIO extends CommandIO {
  /** The process's environment: where the configuration is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Opens the control database (a test gives one of its own backend's). */
  readonly openControl?: (at: DatabaseAt) => Promise<ControlDatabase>;
}
