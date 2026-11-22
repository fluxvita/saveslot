// Process entry for the foreground service (see ./main.ts).
// First, before anything compiles WebAssembly: see ./wasm-code-gc.ts.
import "./wasm-code-gc.ts";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
