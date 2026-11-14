// Process entry for the foreground service (see ./main.ts).
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
