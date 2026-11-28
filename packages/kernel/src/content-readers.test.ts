// A block a deletion in its grace period lists is read no more from the confirmation on (09 §5.9;
// 03-data-model/03-deletion «删除后的样子是一个新版本»). The log's content is read through one
// definition that hides such a block (store/readable-content.ts: `READABLE_CONTENT`, which
// `readEvents` uses too). This scans the kernel's non-test source for SQL reading the `content`
// table itself, and holds each file to the allow-list below: a file that must see pending blocks
// (apply, the delete module, integrity checks, the export with its placeholders), or one that
// reads only metadata blocks, which no deletion lists. Counted, so a new direct read in a listed
// file is not let in with the others. The deletion's external entry is opened only while this
// holds.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".fixture.ts")
      ? [p]
      : [];
  });
}

/** The text without comments, line breaks kept (so line numbers hold). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * The string and template literals of `c` (comments already taken out), each with where it starts.
 * A template's `${…}` parts are kept in its text, nested literals and braces included.
 */
function literals(c: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let i = 0;
  while (i < c.length) {
    const q = c[i];
    if (q !== "`" && q !== '"' && q !== "'") {
      i++;
      continue;
    }
    const at = i;
    i++;
    let depth = 0;
    while (i < c.length) {
      const ch = c[i];
      if (ch === "\\") i += 2;
      else if (q === "`" && ch === "$" && c[i + 1] === "{") {
        depth++;
        i += 2;
      } else if (depth > 0 && ch === "}") {
        depth--;
        i++;
      } else if (depth === 0 && ch === q) break;
      else i++;
    }
    out.push({ at, text: c.slice(at, i + 1) });
    i++;
  }
  return out;
}

/**
 * Readers whose SQL reads `content` and has a `seq IN (…)` that is not a list of events whose
 * blocks it reads, by file and top-level declaration.
 */
const BY_LIST_ALLOWED: readonly string[] = [
  // The events on a row's items: `events.seq IN (SELECT c.seq FROM content c WHERE c.path =
  // 'target' …)`, a search of the target blocks for the items (a scan, its TODO(index)), not
  // blocks read by a list.
  "write/reads.ts rowEvents",
];

/**
 * Whether `sql` has a `seq = ANY (…)` or `seq IN (…)` condition on `content`'s `seq`: unqualified,
 * or qualified by an alias `content` or READABLE_CONTENT is given in the same literal.
 */
function byList(sql: string): boolean {
  const aliases = [
    ...sql.matchAll(
      /\b(?:FROM|JOIN)\s+(?:content|\$\{\s*READABLE_CONTENT\s*\})\s+(?:AS\s+)?(\w+)/gi,
    ),
  ].map((m) => m[1] as string);
  return [...sql.matchAll(/(?:\b(\w+)\.|(?<![\w.]))seq\s*(?:=\s*ANY\b|IN\s*\()/gi)].some(
    (m) => m[1] === undefined || aliases.includes(m[1]),
  );
}

const META = "metadata blocks only, which no deletion lists";

/**
 * The calls passing `includePendingDeletionBlocks: true` (write/reads.ts `rowEvents`), by package
 * file and top-level declaration, one entry a call. Each replays a row as a deletion or a
 * cancellation does: from every contribution, those pending deletions list included.
 */
const PENDING_REPLAYS: readonly string[] = [
  // The deletion fixture's confirmation: its replay of the row, other pending deletions' blocks included.
  "store-pglite/src/testing/deletion.fixture.ts confirmDeletion",
  // Its cancellation: the replay needs the blocks of the deletion it cancels, still pending.
  "store-pglite/src/testing/deletion.fixture.ts cancelDeletion",
  // The session's confirmations and cancellations of several deletions in turn: each replays the
  // row with the others' blocks.
  "store-pglite/src/testing/deletion.fixture.ts DeletionSession",
  // The delete operation's plan: it replays each row it touches as the confirmation will, from
  // every contribution, those earlier pending deletions list included.
  "kernel/src/ops/deletion-plan.ts planDeletionOf",
  // The case that the option reads what the write path does not.
  "store-pglite/src/pending-reads.test.ts the row's log as the write path reads it (rowEvents) has no pending value; a deletion's replay, asking, has it",
];

/**
 * SQL reading the `content` table itself, however it is written: quoted or not, qualified by its
 * schema or not, with ONLY. Deleting from it is not a read.
 */
const RAW_READ =
  /(?<!DELETE\s+)\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?content"?(?!\w)/gi;

/**
 * A use of `rawContentOf` (store/readable-content.ts): `content` itself, limited to some events'
 * blocks. A direct read like the others, written as a call.
 */
const RAW_HELPER = /\brawContentOf\(/g;

/** A top-level declaration: the reader a direct read belongs to is the last one before it. */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|class)\s+(\w+))/gm;

/** The direct reads in `text`: the top-level declaration each is in, its line (1-based), the line. */
function rawReads(text: string): { reader: string; line: number; text: string }[] {
  const lines = text.split("\n");
  const c = code(text);
  const decls = [...c.matchAll(DECL)].map((m) => ({ at: m.index, name: m[1] ?? m[2] ?? "" }));
  return [...c.matchAll(RAW_READ), ...c.matchAll(RAW_HELPER)].map((m) => {
    const line = c.slice(0, m.index).split("\n").length;
    const reader = decls.filter((d) => d.at < m.index).at(-1)?.name ?? "(top level)";
    return { reader, line, text: (lines[line - 1] ?? "").trim() };
  });
}

/**
 * The direct reads allowed, by file, then by the top-level function or constant they are in, with
 * how many each has; and why the file may read `content` itself.
 */
const ALLOWED: Record<string, { readonly why: string; readonly readers: Record<string, number> }> =
  {
    // Must see pending blocks.
    "store/readable-content.ts": {
      why: "the definition every other reader goes through; rawContentOf, the definition of a direct read limited to some events (each use counted where it is); and which block gave a version cell its value (cellWithheld): a restatement's identity (event, field, k) only, never its value, and whether a block was cleared (removed_by), both of blocks a deletion may list; and where a cell's ends came from (cellEnds): the same restatement's identity, the interval (never the value) of the block giving it, the item's target and the modes its head recorded for its ends, blocks a deletion may list",
      readers: { READABLE_CONTENT: 1, rawContentOf: 1, cellWithheld: 2, cellEnds: 4 },
    },
    "apply/apply.ts": {
      why: "apply: a deletion's and a cancellation's own rows and the content they restore; covered events' paths (whose bodies it does not use); else metadata",
      readers: {
        readInputs: 5,
        readDerived: 1,
        readDeletion: 4,
        readCancellation: 5,
        lastGiven: 1,
        readRow: 1,
      },
    },
    "apply/row-items.ts": {
      why: "apply: a row's items in effect and the content that gives them, as settling them must see it (moved from readRow); a version's compiled definition (metadata)",
      readers: { rowItems: 2, constsOf: 1 },
    },
    "apply/shapes.ts": {
      why: "a slot's versions: their compiled definitions and changes (metadata)",
      readers: { slotVersions: 2 },
    },
    "apply/confirmation.ts": {
      why: "checksums of item entries (confirmation_mismatch): only the hash is used",
      readers: { confirmedChecksums: 2, entryChecksums: 1 },
    },
    "delete/positions.ts": {
      why: "a deletion's positions: pending blocks included, on purpose",
      readers: { tablesOf: 1, readPositionIndex: 5, readDeletionPositions: 1 },
    },
    "delete/taken.ts": {
      why: "what a deletion's sources take away",
      readers: { readCitations: 1 },
    },
    "log/log.ts": { why: "verify: checksums of every block", readers: { verifyLog: 2 } },
    "log/export.ts": {
      why: "export: a pending block as a placeholder unless included (09 §8), by pendingBy; else metadata",
      readers: { pendingDeletions: 1, exportStart: 1, exportBatch: 1 },
    },
    "ops/deletion-plan.ts": {
      why: "the delete operation's plan: the awaiting items whose impact names a row it touches (only open items' current entries: a deletion listing an entry gives the impact again in the same transaction, and reading one only makes the deletion refused, never shows it); else metadata (compiled)",
      readers: { slotVersions: 1, awaitingReferredBy: 1 },
    },
    "pending/pending-targets.ts": {
      why: "the rows pending deletions affect: their own deletion.confirmed blocks (positions, restated/*'s event, results/*/target), read as stored, which a later deletion may list",
      readers: { readPendingTargets: 1 },
    },
    "ops/deletion-row.ts": {
      why: "the slot's earlier deletions: the blocks of their own deletion.confirmed / cancelled / executed events (positions, results, restatements), which no deletion lists, read as stored",
      readers: { priorDeletions: 1 },
    },
    "ops/deletion.ts": {
      why: "a deletion's own event read back: metadata only (target, results/*/target); a replayed receipt's count of items put in effect: the candidate and target blocks the deletion itself lists, read for their event numbers only, so the count is the first receipt's",
      readers: { confirmedAs: 1, replayedItems: 2 },
    },
    "ops/reconcile-log.ts": {
      why: "reconcile against a log file or backup: checksums",
      readers: { batchOf: 1 },
    },
    // Metadata blocks only (target, compiled, changes, draft, policy, ctx, task, principal, name,
    // user, tenant, op_sources, positions, a write head's request, revert): no deletion lists them.
    "log/actors.ts": { why: META, readers: { actorsAsOf: 1 } },
    "ops/import-finish.ts": { why: META, readers: { runImport: 1 } },
    "ops/principals.ts": { why: META, readers: { PRINCIPALS: 1 } },
    "ops/schema-change.ts": {
      why: META,
      readers: { compiledOf: 1, receiptOf: 1, draftChangeInTx: 2 },
    },
    "ops/schema-common.ts": { why: META, readers: { numbering: 1 } },
    "ops/schema-resolve.ts": { why: META, readers: { draftOf: 5, readSchemaResolution: 3 } },
    "ops/schema.ts": { why: META, readers: { replay: 1, schemaDraft: 1 } },
    "ops/slots.ts": { why: META, readers: { assertEmpty: 1, removed: 1 } },
    "pending/closing.ts": { why: META, readers: { closingOf: 1, noteOf: 2 } },
    "pending/detail.ts": { why: META, readers: { itemEntries: 1 } },
    "pending/index.ts": { why: META, readers: { writerHadRead: 1 } },
    "read/catalog.ts": { why: META, readers: { policyOf: 1 } },
    "read/documents.ts": { why: META, readers: { ruleTextsOf: 2, draftDocument: 3 } },
    "read/former.ts": { why: META, readers: { formerVersions: 1 } },
    "read/history.ts": { why: META, readers: { shownAs: 1 } },
    "read/notices.ts": { why: META, readers: { changedBetween: 2 } },
    "read/pending.ts": { why: META, readers: { ITEMS: 1, awaitingOf: 2, schemaChangeOf: 3 } },
    "read/premise-entries.ts": { why: META, readers: { declaringOps: 1 } },
    "read/select.ts": { why: META, readers: { correctSpansOf: 1 } },
    "read/slots.ts": { why: META, readers: { visibleSlots: 1 } },
    "read/sources.ts": { why: META, readers: { corrections: 1 } },
    "read/timeline.ts": { why: META, readers: { timelineInTx: 1 } },
    "schema/changed-since.ts": { why: META, readers: { switchedVersions: 1 } },
    "write/detect-premises.ts": { why: META, readers: { scopeOf: 1 } },
    "write/pipeline.ts": { why: META, readers: { definitionsAt: 1 } },
    "write/premise-affected.ts": { why: META, readers: { inForceAt: 3 } },
    "write/premises.ts": { why: META, readers: { reasonOf: 1 } },
    "write/reads.ts": {
      why: `${META}; and eventsAt's read when a deletion's or a cancellation's replay asks for pending blocks (includePendingDeletionBlocks, its callers listed below)`,
      readers: { readSlots: 1, eventsAt: 1, rowEvents: 1, svFromWrite: 1 },
    },
    "write/receipt.ts": { why: META, readers: { readReceipt: 1 } },
    "write/resolve.ts": {
      why: META,
      readers: { liveIndices: 3, itemEvent: 1, itemVerFromOwn: 1, readResolution: 1 },
    },
  };

describe("the kernel reads the log's content through the one definition that hides pending blocks", () => {
  const files = sources(SRC);

  it("scans the kernel's source (a guard against scanning nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => relative(SRC, f) === "store/readable-content.ts")).toBe(true);
  });

  it("reads `content` itself only where the allow-list says, as many times as it says", () => {
    const problems: string[] = [];
    const found: Record<string, Record<string, number>> = {};
    for (const f of files) {
      const file = relative(SRC, f);
      const reads = rawReads(readFileSync(f, "utf8"));
      for (const r of reads) {
        found[file] = { ...found[file], [r.reader]: (found[file]?.[r.reader] ?? 0) + 1 };
      }
      const by = new Map<string, typeof reads>();
      for (const r of reads) by.set(r.reader, [...(by.get(r.reader) ?? []), r]);
      for (const [reader, rs] of by) {
        const allowed = ALLOWED[file]?.readers[reader] ?? 0;
        if (rs.length <= allowed) continue;
        const where = rs.map((r) => `  ${file}:${r.line}: ${r.text}`).join("\n");
        problems.push(
          `New direct read of \`content\` in ${file}, in ${reader} ` +
            `(${rs.length} there, ${allowed} allowed):\n${where}\n` +
            `Read it through READABLE_CONTENT (store/readable-content.ts) or readEvents, which ` +
            `hide a block a pending deletion lists. Only if it must see such a block, or reads ` +
            `metadata blocks only, add it to ALLOWED in content-readers.test.ts with the reason.`,
        );
      }
    }
    for (const [file, { readers }] of Object.entries(ALLOWED)) {
      for (const [reader, n] of Object.entries(readers)) {
        const has = found[file]?.[reader] ?? 0;
        if (has < n) {
          problems.push(
            `${file} ${reader} reads \`content\` directly ${has} times, ${n} allowed: ` +
              "lower it in ALLOWED (content-readers.test.ts), or take it off.",
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("reads some events' blocks by `content`'s key, one event at a time, not by a list of `seq`", () => {
    // `content` is analyzed from a small sample, so the planner's estimate of the blocks a list of
    // events has can be off by orders of magnitude, and with a long list it scans the whole table
    // (store/readable-content.ts `readableContentOf`). An SQL literal reading `content`, itself or
    // through READABLE_CONTENT, with a `seq = ANY (…)` or `seq IN (…)` condition (PostgreSQL turns
    // an IN list into `= ANY`) is such a read, unless BY_LIST_ALLOWED names its reader.
    //
    // One string or template literal at a time: SQL put together from separate literals, or from a
    // variable, is not seen.
    const problems: string[] = [];
    for (const f of files) {
      const file = relative(SRC, f);
      const c = code(readFileSync(f, "utf8"));
      const decls = [...c.matchAll(DECL)].map((m) => ({ at: m.index, name: m[1] ?? m[2] ?? "" }));
      for (const lit of literals(c)) {
        const reads = RAW_READ.test(lit.text) || /\$\{\s*READABLE_CONTENT\s*\}/.test(lit.text);
        RAW_READ.lastIndex = 0;
        if (!reads || !byList(lit.text)) continue;
        const reader = decls.filter((d) => d.at < lit.at).at(-1)?.name ?? "(top level)";
        if (BY_LIST_ALLOWED.includes(`${file} ${reader}`)) continue;
        problems.push(`${file}:${c.slice(0, lit.at).split("\n").length} (${reader})`);
      }
    }
    expect(
      problems,
      "use readableContentOf (or rawContentOf, a direct read) from store/readable-content.ts",
    ).toEqual([]);
  });

  it("only a deletion's or a cancellation's replay asks rowEvents for pending blocks", () => {
    // Every source file of the packages, tests and fixtures included: a call passing the option
    // with `true` is named here, by file and the top-level declaration it is in.
    const ROOT = join(SRC, "..", "..");
    const all = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : all(p);
        return e.name.endsWith(".ts") ? [p] : [];
      });
    const files = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        const src = join(ROOT, e.name, "src");
        return existsSync(src) ? all(src) : [];
      });
    const found: string[] = [];
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"));
      if (f === import.meta.filename) continue;
      // A test case counts as a declaration here, named by its title.
      const decls = [...c.matchAll(DECL), ...c.matchAll(/^\s*it\(\s*"([^"]+)"/gm)]
        .map((m) => ({ at: m.index, name: m[1] ?? m[2] ?? "" }))
        .sort((x, y) => x.at - y.at);
      for (const m of c.matchAll(/\bincludePendingDeletionBlocks\s*:\s*true\b/g)) {
        const reader = decls.filter((d) => d.at < m.index).at(-1)?.name ?? "(top level)";
        const line = c.slice(0, m.index).split("\n").length;
        found.push(`${relative(ROOT, f)} ${reader} (line ${line})`);
      }
    }
    const names = found.map((x) => x.replace(/ \(line \d+\)$/, ""));
    const unlisted = found.filter((_, k) => !PENDING_REPLAYS.includes(names[k] as string));
    expect(
      unlisted,
      "a new call asks for pending blocks: only a deletion's or a cancellation's replay may, " +
        "named in PENDING_REPLAYS with why it must see them",
    ).toEqual([]);
    expect([...names].sort()).toEqual([...PENDING_REPLAYS].sort());
  });

  it("readEvents goes through the same definition", () => {
    const log = code(readFileSync(join(SRC, "log/log.ts"), "utf8"));
    const body = log.slice(log.indexOf("export async function readEvents"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text, not a template
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("${READABLE_CONTENT}");
  });

  it("the pattern sees what it is for", () => {
    const n = (t: string) => rawReads(t).length;
    expect(n("`SELECT body FROM content WHERE seq = $1`")).toBe(1);
    expect(n("`SELECT 1 FROM events e\n JOIN content c ON c.seq = e.seq`")).toBe(1);
    expect(n("`SELECT body FROM\n  content WHERE seq = $1`")).toBe(1);
    expect(n("'select body from content'")).toBe(1);
    // Quoted, qualified by the schema, or both, and with ONLY.
    expect(n('`SELECT body FROM "content" c WHERE seq = $1`')).toBe(1);
    expect(n("`SELECT body FROM public.content WHERE seq = $1`")).toBe(1);
    expect(n('`SELECT body FROM "public"."content" c`')).toBe(1);
    expect(n("`SELECT 1 FROM events e JOIN public . content c ON c.seq = e.seq`")).toBe(1);
    expect(n("`SELECT body FROM ONLY content`")).toBe(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text, not a template
    expect(n("`SELECT body FROM ${READABLE_CONTENT} c`")).toBe(0);
    expect(n("`DELETE FROM content WHERE seq = $1`")).toBe(0);
    expect(n("`SELECT 1 FROM content_index`")).toBe(0);
    expect(n('`SELECT 1 FROM "content_index"`')).toBe(0);
    expect(n("`SELECT 1 FROM public.content_index`")).toBe(0);
    expect(n("// read from content here")).toBe(0);
    expect(
      rawReads("const a = 1;\nexport async function f() {\n  q(`SELECT 1 FROM content`);\n}"),
    ).toEqual([{ reader: "f", line: 3, text: "q(`SELECT 1 FROM content`);" }]);
  });
});
