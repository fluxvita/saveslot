// The bridge as an MCP host starts it, for the tests that spawn it: `saveslot mcp`'s own code path
// (`serviceCommand("mcp", …)`), run from the sources. The `saveslot` entry package dispatches to
// the same function.
import { serviceCommand } from "./commands.ts";

const line = (l: string) => {
  process.stderr.write(`${l}\n`);
};
process.exitCode = await serviceCommand("mcp", process.argv.slice(2), { out: line, err: line });
