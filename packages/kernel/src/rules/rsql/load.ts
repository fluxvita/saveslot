// Loading the parser of restricted SQL (docs/zh-CN/spec/03-data-model/11-restricted-sql.md
// «处理步骤»): libpg_query's PostgreSQL 18 parser, compiled to WASM (the npm package libpg-query,
// pinned to one patch version). `rsql@1` is the whitelist of ./whitelist.ts together with this
// pinned grammar.
//
// The package is imported dynamically, in loadRsql(), so that importing the kernel neither loads
// the WASM module nor `node:fs` (its Node glue reads the .wasm file). Call loadRsql() once before
// compiling or checking restricted SQL; nothing loads it implicitly.

export interface RsqlParser {
  /** The raw parse tree, or a thrown error with `sqlDetails.cursorPosition` (a character offset) for syntax errors. */
  parse(sql: string): unknown;
  scan(sql: string): ReturnType<typeof import("libpg-query").scanSync>;
}

let parser: RsqlParser | undefined;
let loading: Promise<void> | undefined;

/** Loads the parser; resolves once it is ready. Safe to call again. */
export function loadRsql(): Promise<void> {
  loading ??= import("libpg-query")
    .then(async (m) => {
      await m.loadModule();
      parser = { parse: (sql) => m.parseSync(sql), scan: (sql) => m.scanSync(sql) };
    })
    .catch((e: unknown) => {
      // A failed load is not remembered: the next call tries again.
      loading = undefined;
      throw e;
    });
  return loading;
}

/** The loaded parser. Throws when loadRsql() has not completed. */
export function rsqlParser(): RsqlParser {
  if (parser === undefined) {
    throw new Error("restricted SQL is not loaded: await loadRsql() first");
  }
  return parser;
}
