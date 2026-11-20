// `saveslot doctor` (docs/zh-CN/spec/06-cli.md §3 step 7, §4.1, §6.2): each check passes, fails
// (with how to fix it), or is a reminder. Reminders do not fail: exit 9 only for a check that
// failed, 0 otherwise.
//
// The checks here: the home, the credentials and the run directory (this user's, 0700 / 0600, no
// links; run/ only once a start made it), the data directory there and out of a synced folder, the service answering and ready,
// its version this saveslot's, the home's single-writer lock held by the process that answers (the
// pid file names it), and a start-at-login job whose program is still there. The reminders: the
// clock behind the log's end, and tables over the comfortable line or the tested one (the
// catalog's `scale`). What the service is not there for is skipped and said so, not passed.
//
// Not in this version: overdue physical deletions (there are no deletions yet; the check is not
// shown at all, rather than always passing).

import { access, constants, readFile } from "node:fs/promises";
import {
  checkMode,
  credentialsDir,
  readTenantDirectory,
  sessionFile,
} from "@fluxvita/saveslot-service";
import { autostartFile, jobProgram, type System } from "./autostart.ts";
import { health } from "./local-request.ts";
import { daemonVersion } from "./main.ts";
import { clockBehind, looksSynced, withSession } from "./probes.ts";
import { pidFile, runDir, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

export type Verdict = "pass" | "fail" | "remind" | "skipped";

/** Where `doctor` writes (the service commands' `CommandIO`). */
export interface DoctorIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface Finding {
  readonly verdict: Verdict;
  /** What was checked, in a word or two. */
  readonly item: string;
  readonly says: string;
  /** For a failure: what to do. */
  readonly fix?: string;
}

/** A path's mode problem as `checkMode` says it; undefined when it is as it should be. */
async function modeProblem(path: string, mode: 0o600 | 0o700): Promise<string | undefined> {
  try {
    await checkMode(path, mode);
    return undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return TEXTS.doctorMissing(path);
    return (e as Error).message;
  }
}

/** Every table of every slot, with its rows' scale when over the comfortable line. */
async function scaled(
  home: string,
): Promise<{ table: string; rows: number; level: string }[] | undefined> {
  const out: { table: string; rows: number; level: string }[] = [];
  const slots: { slot: string; tables: string[] }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const v = (await withSession(
      home,
      `/v1/slots?limit=200${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )) as
      | { slots?: { slot: string; tables: { table: string }[] }[]; next_cursor?: string }
      | undefined;
    if (v === undefined || !Array.isArray(v.slots)) return undefined;
    for (const s of v.slots) slots.push({ slot: s.slot, tables: s.tables.map((t) => t.table) });
    if (typeof v.next_cursor !== "string") break;
    cursor = v.next_cursor;
  }
  for (const s of slots) {
    for (let i = 0; i < s.tables.length; i += 10) {
      const names = s.tables
        .slice(i, i + 10)
        .map(encodeURIComponent)
        .join(",");
      const v = (await withSession(
        home,
        `/v1/slots/${encodeURIComponent(s.slot)}/tables?tables=${names}`,
      )) as
        | { tables?: { table: string; profile?: { rows: number; scale?: { level: string } } }[] }
        | undefined;
      if (v === undefined || !Array.isArray(v.tables)) return undefined;
      for (const t of v.tables) {
        const level = t.profile?.scale?.level;
        if (level !== undefined) out.push({ table: t.table, rows: t.profile?.rows ?? 0, level });
      }
    }
  }
  return out;
}

/** The checks, in order. */
export async function findings(
  home: string,
  sys: System,
  o: { readonly now?: () => number } = {},
): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);

  // The home and its private directories.
  const homeWrong = await modeProblem(home, 0o700);
  if (
    homeWrong !== undefined &&
    (await access(home).then(
      () => false,
      () => true,
    ))
  ) {
    add({
      verdict: "fail",
      item: "home",
      says: TEXTS.notInitialized(home).replace(/^error: /, ""),
      fix: "saveslot init",
    });
    return out;
  }
  add(
    homeWrong === undefined
      ? { verdict: "pass", item: "home", says: home }
      : { verdict: "fail", item: "home", says: homeWrong, fix: TEXTS.doctorChmod(home, "700") },
  );
  const credWrong =
    (await modeProblem(credentialsDir(home), 0o700)) ??
    (await modeProblem(sessionFile(home), 0o600));
  add(
    credWrong === undefined
      ? { verdict: "pass", item: "credentials", says: TEXTS.doctorCredentialsOk }
      : {
          verdict: "fail",
          item: "credentials",
          says: credWrong,
          fix: TEXTS.doctorCredentialsFix(home),
        },
  );
  // Made by the first start: not there yet is nothing wrong.
  const runWrong = (await access(runDir(home)).then(
    () => true,
    () => false,
  ))
    ? await modeProblem(runDir(home), 0o700)
    : undefined;
  add(
    runWrong === undefined
      ? { verdict: "pass", item: "run directory", says: TEXTS.doctorRunOk }
      : {
          verdict: "fail",
          item: "run directory",
          says: runWrong,
          fix: TEXTS.doctorChmod(runDir(home), "700"),
        },
  );

  // The data directory the home records.
  const data = await readTenantDirectory(home).then(
    (d) => d.dataDir,
    () => undefined,
  );
  if (data === undefined) {
    add({
      verdict: "fail",
      item: "data directory",
      says: TEXTS.doctorNoTenantDirectory,
      fix: "saveslot status",
    });
  } else if (
    await access(data).then(
      () => false,
      () => true,
    )
  ) {
    add({
      verdict: "fail",
      item: "data directory",
      says: TEXTS.doctorDataMissing(data),
      fix: TEXTS.doctorDataMissingFix,
    });
  } else if (looksSynced(data)) {
    add({
      verdict: "fail",
      item: "data directory",
      says: TEXTS.doctorSynced(data),
      fix: TEXTS.doctorSyncedFix,
    });
  } else {
    add({ verdict: "pass", item: "data directory", says: data });
  }

  // The service: answering, ready, this version, holding the lock.
  const h = await health(socketFile(home));
  if (h === undefined) {
    add({ verdict: "fail", item: "service", says: TEXTS.doctorNotRunning, fix: "saveslot start" });
  } else {
    add(
      h.state === "ready"
        ? { verdict: "pass", item: "service", says: TEXTS.doctorReady(h.pid) }
        : {
            verdict: "fail",
            item: "service",
            says: TEXTS.doctorNotReady(h.state, h.reason),
            fix: TEXTS.doctorNotReadyFix,
          },
    );
    const mine = daemonVersion();
    add(
      h.version === mine
        ? { verdict: "pass", item: "version", says: mine }
        : {
            verdict: "fail",
            item: "version",
            says: TEXTS.doctorVersion(h.version, mine),
            fix: TEXTS.doctorVersionFix,
          },
    );
    const pid = await readFile(pidFile(home), "utf8").then(
      (t) => t.trim(),
      () => undefined,
    );
    add(
      h.writer_lock === "held" && pid === String(h.pid)
        ? { verdict: "pass", item: "lock", says: TEXTS.doctorLockOk(h.pid) }
        : {
            verdict: "fail",
            item: "lock",
            says: TEXTS.doctorLockWrong(h.pid, pid),
            fix: TEXTS.doctorLockFix,
          },
    );
  }

  // A start-at-login job, when there is one: its program still there.
  const job = await jobProgram(sys);
  if (job !== undefined) {
    const gone: string[] = [];
    // Node must run; the service's entry is a file Node reads.
    for (const [i, p] of job.paths.entries()) {
      if (
        await access(p, i === 0 ? constants.X_OK : constants.R_OK).then(
          () => false,
          () => true,
        )
      )
        gone.push(p);
    }
    add(
      gone.length === 0
        ? { verdict: "pass", item: "start at login", says: job.file }
        : {
            verdict: "fail",
            item: "start at login",
            says: TEXTS.doctorJobGone(job.file, gone),
            fix: "saveslot service install",
          },
    );
  } else if (autostartFile(sys) !== undefined) {
    // No job: nothing to check; said, so that its absence is not read as a pass.
    add({ verdict: "skipped", item: "start at login", says: TEXTS.doctorNoJob });
  }

  // The reminders, from the service when it is ready.
  if (h?.state !== "ready") {
    add({ verdict: "skipped", item: "clock, data scale", says: TEXTS.doctorNeedsService });
    return out;
  }
  const end = (await withSession(home, "/v1/log/end")) as { recorded_at?: unknown } | undefined;
  const logEnd = typeof end?.recorded_at === "string" ? end.recorded_at : undefined;
  const now = h.eval_clock !== undefined ? Date.parse(h.eval_clock.now) : (o.now ?? Date.now)();
  const behind = clockBehind(logEnd, now);
  add(
    behind === undefined
      ? { verdict: "pass", item: "clock", says: TEXTS.doctorClockOk }
      : {
          verdict: "remind",
          item: "clock",
          says: TEXTS.doctorClockBehind(Math.floor(behind / 60_000)),
        },
  );
  const tables = await scaled(home);
  if (tables === undefined) {
    add({ verdict: "skipped", item: "data scale", says: TEXTS.doctorScaleUnread });
  } else if (tables.length === 0) {
    add({ verdict: "pass", item: "data scale", says: TEXTS.doctorScaleOk });
  } else {
    for (const t of tables) {
      add({
        verdict: "remind",
        item: "data scale",
        says: TEXTS.doctorScale(t.table, t.rows, t.level),
      });
    }
  }
  return out;
}

/** `saveslot doctor`: the findings, one a line; 9 when any failed. */
export async function doctor(
  home: string,
  io: DoctorIO,
  sys: System,
  o: { readonly now?: () => number } = {},
): Promise<number> {
  const all = await findings(home, sys, o);
  for (const f of all) {
    io.out(TEXTS.doctorLine(f.verdict, f.item, f.says));
    if (f.fix !== undefined) io.out(TEXTS.doctorFix(f.fix));
  }
  const failed = all.filter((f) => f.verdict === "fail").length;
  const reminders = all.filter((f) => f.verdict === "remind").length;
  io.out(TEXTS.doctorSummary(failed, reminders));
  return failed > 0 ? 9 : 0;
}
