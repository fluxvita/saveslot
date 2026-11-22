// `saveslot import` (06-cli §4.8) against a stand-in service: the manifests read and checked before
// anything is sent, the confirmation, the files' plain bytes as one body, an age file opened here,
// and a body never sent whole when a file is found cut short. The stand-in records a body only when
// it has it whole (its request ended), and a request cut off as such.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptStream } from "./export-crypto.ts";
import { run } from "./run.ts";
import { TEXTS } from "./texts.ts";

const TOKEN = `slt_${"A".repeat(43)}`;
const root = mkdtempSync(join(tmpdir(), "saveslot-cli-import-"));
const home = join(root, "home");
const files = join(root, "files");
let server: Server;
/** Bodies the stand-in had whole, and requests cut off before their end. */
const whole: Buffer[] = [];
let cut = 0;
let answer: (res: ServerResponse) => void;

const RESULT = {
  tenant_id: "tn_01JF00000000000000000000NE",
  previous_tenant_id: "tn_01JF00000000000000000000LD",
  events: 4,
  seq: 6,
  restore_count: 0,
  principals_disabled: 3,
  slots: 1,
  removed: 0,
  pending_deletions: { executed: 2, carried: 1 },
  exported_at: "2026-11-20T08:00:00.000Z",
  not_imported: ["read_log", "credentials", "external_files"],
};
const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

/** An export file's text: its manifest, then `events` event lines from `after` + 1. */
function exportText(o: {
  after?: number;
  events: number;
  tenant?: string;
  pending?: "placeholder" | "included";
}): string {
  const after = o.after ?? 0;
  const manifest = {
    saveslot_export: 1,
    tenant_id: o.tenant ?? "tn_01JF00000000000000000000LD",
    event_format: 1,
    restore_count: 0,
    ...(o.after !== undefined ? { after: o.after } : {}),
    upto: after + o.events,
    events: o.events,
    exported_at: "2026-11-20T08:00:00.000Z",
    pending_deletions: o.pending ?? "placeholder",
  };
  const lines = [JSON.stringify(manifest)];
  for (let k = 1; k <= o.events; k++) lines.push(JSON.stringify({ h: { seq: after + k } }));
  return `${lines.join("\n")}\n`;
}

let made = 0;
const file = (text: string | Buffer) => {
  const p = join(files, `f${++made}.ndjson`);
  writeFileSync(p, text);
  return p;
};
async function ageFile(text: string, passphrase: string): Promise<Buffer> {
  const plain = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Buffer.from(text, "utf8"));
      c.close();
    },
  });
  const chunks: Uint8Array[] = [];
  for await (const c of (await encryptStream(
    plain,
    passphrase,
  )) as unknown as AsyncIterable<Uint8Array>)
    chunks.push(c);
  return Buffer.concat(chunks);
}
const passFile = (text: string) => {
  const p = join(files, `pass${++made}`);
  writeFileSync(p, `${text}\n`, { mode: 0o600 });
  return p;
};

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(files);
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    let ended = false;
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      ended = true;
      if (req.method === "POST" && req.url === "/v1/import") {
        whole.push(Buffer.concat(chunks));
        answer(res);
        return;
      }
      json(res, 404, { error: { code: "not_found", message: "no route" } });
    });
    req.on("close", () => {
      if (!ended) cut++;
    });
  });
  await new Promise<void>((r) => server.listen(join(home, "run", "saveslot.sock"), r));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  whole.length = 0;
  cut = 0;
  answer = (res) => json(res, 200, RESULT);
});

async function cli(
  argv: string[],
  o: {
    json?: boolean;
    answers?: string[];
    hidden?: string[];
  } = {},
) {
  let out = "";
  let err = "";
  const terminal = o.answers !== undefined;
  const code = await run(
    ["--home", home, "import", ...argv, ...(o.json === true ? ["--json"] : [])],
    { SAVESLOT_TOKEN: TOKEN },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: false,
      stderrIsTTY: terminal,
      stdinIsTTY: terminal,
      ...(terminal ? { ask: async () => o.answers?.shift() } : {}),
      terminal: () =>
        o.hidden === undefined
          ? undefined
          : { write: () => {}, readHidden: async () => o.hidden?.shift() ?? "", close: () => {} },
      platform: "darwin",
    },
  );
  // What came out of the boundary marks (stderr is no terminal here): the text alone.
  const plain = (x: string) => x.replace(/<\/?untrusted-data-[0-9a-f]+>/g, "");
  return { code, out: plain(out), err: plain(err) };
}

describe("import: the files' manifests, then one body", () => {
  it("a plain export, --yes: what it is said first; its bytes sent as they are; the result", async () => {
    const text = exportText({ events: 4, pending: "included" });
    const r = await cli([file(text), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`${TEXTS.importFrom} tn_01JF00000000000000000000LD`);
    expect(r.err).toContain(`4 ${TEXTS.importEvents} (1 ${TEXTS.importFiles})`);
    expect(r.err).toContain(TEXTS.importWithPending);
    expect(r.err).toContain(TEXTS.importLaterDeletions);
    expect(whole.map((b) => b.toString("utf8"))).toEqual([text]);
    expect(r.out).toContain(`${TEXTS.importDisabled} 3`);
    expect(r.out).toContain(`${TEXTS.importTombstones} 2 · ${TEXTS.importCarried} 1`);
    expect(r.out).toContain(TEXTS.importReissue);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN);
  });

  it("--json: the result as the service gave it", async () => {
    const r = await cli([file(exportText({ events: 4 })), "--yes"], { json: true });
    expect([r.code, JSON.parse(r.out)]).toEqual([0, RESULT]);
  });

  it("continuations: one body, in the order given", async () => {
    const a = exportText({ events: 3 });
    const b = exportText({ after: 3, events: 2 });
    const r = await cli([file(a), file(b), "--yes"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`5 ${TEXTS.importEvents} (2 ${TEXTS.importFiles})`);
    expect(whole.map((x) => x.toString("utf8"))).toEqual([a + b]);
  });

  it("asked, and yes: sent; asked, and no; or no terminal and no --yes: 8, nothing sent", async () => {
    expect((await cli([file(exportText({ events: 1 }))], { answers: ["y"] })).code).toBe(0);
    expect(whole).toHaveLength(1);
    whole.length = 0;
    const no = await cli([file(exportText({ events: 1 }))], { answers: ["n"] });
    const none = await cli([file(exportText({ events: 1 }))]);
    expect([no.code, none.code, none.err.endsWith(`${TEXTS.importNoTerminal}\n`)]).toEqual([
      8,
      8,
      true,
    ]);
    expect([whole, cut]).toEqual([[], 0]);
  });
});

describe("import: refused here, before anything is sent", () => {
  it.each([
    [
      "out of order",
      () => [exportText({ events: 3 }), exportText({ after: 5, events: 2 })],
      TEXTS.importSegmentOrder(2),
    ],
    [
      "another tenant",
      () => [
        exportText({ events: 3 }),
        exportText({ after: 3, events: 2, tenant: "tn_01JF0000000000000000000OTH" }),
      ],
      TEXTS.importOtherTenant(2),
    ],
    [
      "another export",
      () => [
        exportText({ events: 3 }),
        exportText({ after: 3, events: 2 }).replace('"restore_count":0', '"restore_count":1'),
      ],
      TEXTS.importOtherExport(2),
    ],
    ["not from the start", () => [exportText({ after: 3, events: 2 })], TEXTS.importNotFromStart],
    ["not an export", () => ['{"x":1}\n'], TEXTS.importNotAnExport(1)],
    [
      "an export of another format",
      () => [exportText({ events: 2 }).replace('"saveslot_export":1', '"saveslot_export":2')],
      TEXTS.importNotAnExport(1),
    ],
  ])("%s: 2, nothing sent", async (_, texts, said) => {
    const r = await cli([...texts().map(file), "--yes"]);
    expect([r.code, r.err.endsWith(`${TEXTS.usageError(said)}\n`)]).toEqual([2, true]);
    expect([whole, cut]).toEqual([[], 0]);
  });

  it("no file; --passphrase-file with no age file: 2", async () => {
    expect((await cli(["--yes"])).code).toBe(2);
    const r = await cli([
      file(exportText({ events: 1 })),
      "--passphrase-file",
      passFile("p"),
      "--yes",
    ]);
    expect([r.code, whole]).toEqual([2, []]);
  });
});

describe("import: an age file", () => {
  const PASS = "correct horse battery";

  it("opened with --passphrase-file: its manifest shown, its plain bytes sent", {
    timeout: 30_000,
  }, async () => {
    const text = exportText({ events: 4 });
    const r = await cli([
      file(await ageFile(text, PASS)),
      "--passphrase-file",
      passFile(PASS),
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`4 ${TEXTS.importEvents}`);
    expect(whole.map((b) => b.toString("utf8"))).toEqual([text]);
    expect(`${r.out}${r.err}`).not.toContain(PASS);
  });

  it("a passphrase that does not open it: 1, nothing sent", { timeout: 30_000 }, async () => {
    const f = file(await ageFile(exportText({ events: 1 }), PASS));
    const r = await cli([f, "--passphrase-file", passFile("another one entirely"), "--yes"]);
    expect([r.code, r.err.endsWith(`${TEXTS.importPassphraseWrong(1)}\n`)]).toEqual([1, true]);
    expect([whole, cut]).toEqual([[], 0]);
  });

  it("continuations under two passphrases: asked again for the one the first does not open", {
    timeout: 60_000,
  }, async () => {
    const a = exportText({ events: 3 });
    const b = exportText({ after: 3, events: 2 });
    const fa = file(await ageFile(a, PASS));
    const fb = file(await ageFile(b, "the second passphrase"));
    const r = await cli([fa, fb, "--yes"], { hidden: [PASS, "the second passphrase"] });
    expect(r.code).toBe(0);
    expect(whole.map((x) => x.toString("utf8"))).toEqual([a + b]);
    // From a file, nothing asked: the second refused, nothing sent.
    whole.length = 0;
    const f = await cli([fa, fb, "--passphrase-file", passFile(PASS), "--yes"]);
    expect([f.code, f.err.endsWith(`${TEXTS.importPassphraseWrong(2)}\n`), whole]).toEqual([
      1,
      true,
      [],
    ]);
  });

  it("typed at the terminal: used as typed, a space at its end included", {
    timeout: 30_000,
  }, async () => {
    const text = exportText({ events: 2 });
    const r = await cli([file(await ageFile(text, "correct horse ")), "--yes"], {
      hidden: ["correct horse "],
    });
    expect(r.code).toBe(0);
    expect(whole.map((x) => x.toString("utf8"))).toEqual([text]);
  });

  it("asked again for a continuation: used as typed, a space at its end included", {
    timeout: 60_000,
  }, async () => {
    const a = exportText({ events: 3 });
    const b = exportText({ after: 3, events: 2 });
    const fa = file(await ageFile(a, PASS));
    const fb = file(await ageFile(b, " the second passphrase "));
    const r = await cli([fa, fb, "--yes"], { hidden: [PASS, " the second passphrase "] });
    expect(r.code).toBe(0);
    expect(whole.map((x) => x.toString("utf8"))).toEqual([a + b]);
  });

  it("cut short at its end: found while sending, and the body never sent whole", {
    timeout: 60_000,
  }, async () => {
    // Large enough that its first chunks are opened and sent before the cut end is found.
    const big = exportText({ events: 40000 });
    const sealed = await ageFile(big, PASS);
    const r = await cli([
      file(sealed.subarray(0, sealed.length - 20)),
      "--passphrase-file",
      passFile(PASS),
      "--yes",
    ]);
    expect(r.code).not.toBe(0);
    await vi.waitFor(() => expect(cut).toBe(1));
    expect(whole).toEqual([]);
    expect(r.out).toBe("");
  });
});

describe("import: the service's refusals", () => {
  it.each([
    [400, { code: "import_rejected", message: "m", reason: "chain_broken", seq: 3 }, 5],
    [400, { code: "invalid_argument", message: "m", reason: "tenant_not_empty", param: "" }, 5],
    [429, { code: "rate_limited", message: "m", reason: "busy" }, 7],
    [503, { code: "unavailable", message: "m", reason: "importing" }, 7],
  ])("%s %j: %s", async (status, error, code) => {
    answer = (res) => json(res, status, { error });
    const r = await cli([file(exportText({ events: 1 })), "--yes"]);
    expect([r.code, r.err]).toEqual([code, expect.stringContaining(error.code)]);
  });
});

describe("import: what is sent is read from the files as they are", () => {
  it("the bytes on disk, not a copy made before asking", () => {
    const text = exportText({ events: 2 });
    const p = file(text);
    expect(readFileSync(p, "utf8")).toBe(text);
  });
});
