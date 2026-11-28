// The service process's low-memory setting, `service.low_memory` (docs/zh-CN/spec/06-cli.md §4.2;
// 02-architecture «容量边界与实测数值»), on by default.
//
// Most of the local service's resident memory is not data: it is the machine code V8 compiles from
// PGlite's WebAssembly with its optimizing compiler, about 600 MB. Node's `--liftoff-only` keeps V8
// to its baseline compiler: the process takes about half the memory (idle after a load of 34k rows,
// 960 MB down to 413 MB), and SQL runs 1.3 to 2 times slower (#59 has the figures).
//
// V8 takes the flag only on Node's command line: not in NODE_OPTIONS, and not from
// `v8.setFlagsFromString` once the process runs (measured: no effect, in the main thread or a
// worker). So it is given where a service process is started from this package (`saveslot start`,
// and the start-at-login job `service install` writes), not by an SDK embedding the kernel.

/** The Node option the setting adds to the service's command line. */
export const LOW_MEMORY_FLAG = "--liftoff-only";

/** The Node options a service process is started with, for the setting's value. */
export const nodeOptions = (lowMemory: boolean): string[] => (lowMemory ? [LOW_MEMORY_FLAG] : []);

/** Whether this process runs with the setting on: its own Node options say. */
export const runsLowMemory = (execArgv: readonly string[] = process.execArgv): boolean =>
  execArgv.includes(LOW_MEMORY_FLAG);
