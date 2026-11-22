// Turns WebAssembly code GC off for the process, as this module is evaluated. A process entry
// imports it first, before any other import: an import evaluates its whole graph first, and that
// graph compiles Wasm (the restricted SQL parser, PGlite); set after that, the flag does not
// cover all the code already there.
//
// Node 24's V8 (13.6) shares Wasm import wrappers across the whole process and can free one twice
// when code GC frees it on one thread while another thread tiers a wrapper up
// (nodejs/node#66366; fixed in V8 9b8ca54d5a). Each store runs PGlite on a worker thread of its
// own (store-pglite's backend.ts), and stores opened and closed in one process (an import's
// staging storage beside the open one, a server's tenants) set it off: the process aborts with
// "Check failed: end > addr" or "jit_page_->allocations_.erase(addr) == 1". With code GC off,
// nothing is freed, so nothing is freed twice; the cost is the memory of Wasm code no longer used.
//
// Remove it, with the same line in vitest.config.ts, once the Node versions supported carry the
// fix (the 24.x backport, nodejs/node#66376).

import { setFlagsFromString } from "node:v8";

setFlagsFromString("--no-wasm-code-gc");
