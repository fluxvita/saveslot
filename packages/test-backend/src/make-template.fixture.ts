// Run as a separate process by store-template.test.ts: makes (or finds) the template for a
// durability under a templates directory, and reports when it started and ended and where the
// template is, as one JSON line on stdout. Two of these at once race to make one template.
//   node --conditions=source make-template.fixture.ts <templates> <durability>

import type { Durability } from "@fluxvita/saveslot-store-pglite";
import { templateFor } from "./store-template.fixture.ts";

const [root, durability] = process.argv.slice(2);
if (!root || !durability)
  throw new Error("usage: make-template.fixture.ts <templates> <durability>");

const started = Date.now();
const at = await templateFor(root, durability as Durability);
process.stdout.write(`${JSON.stringify({ at, started, ended: Date.now() })}\n`);
