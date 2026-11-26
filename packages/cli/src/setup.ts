// `saveslot setup` (docs/zh-CN/spec/06-cli.md §3.3): first use in one command. It only orchestrates
// what the other commands do, by the same code: `init` and `start` (the service's, handed in), the
// slot a template makes (as `slot create --template`), and per host what `connect --apply` does
// (`issueAndAdd`), with its own rules: the token is never shown, and a host's command that fails
// gets its instance revoked.
//
// - Asked once, before anything is issued; Enter is yes. It asks only with stdin and stderr both
//   terminals (the questions go to stderr); otherwise `--yes` is needed, and every choice comes
//   from the command line: one not given is not made.
// - Run again, it does what is not done yet: a home initialized, a running service, any slot, a
//   host with an entry holding this saveslot's path are each left as they are.
// - One `setup` at a time per home (a lock under `run/`).
// - Stopped (input ended, declined, SIGINT / SIGTERM), it says what it did; a host command running
//   is killed with its group, and the instance it was given revoked.
// - macOS and Linux only in this version.
//
// The token of each new instance is in this process's memory, then in the host command's arguments
// while it runs, then in the host's configuration: never on the terminal, in `--json`, or a file.

import { stat } from "node:fs/promises";
import { type Client, type Connection, SCOPES } from "@fluxvita/saveslot-client";
import {
  APPLIES,
  appliedReason,
  appliedWhy,
  createsSlots,
  DEFAULT_SCOPES,
  entryHolds,
  entryMayGo,
  entryPath,
  HOST_INFO,
  hostEntry,
  hostVersion,
  issueAndAdd,
  mcpUrl,
  onPath,
  parseScopes,
  remoteAddCommand,
  removeCommand,
  revokeQuietly,
  runHostCommand,
  SETUP_HOSTS,
  type SetupHost,
  writes,
} from "./connect.ts";
import { describeError, timezoneHint } from "./errors.ts";
import { hostInstances, lastRead } from "./host-instances.ts";
import { allConnections } from "./pages.ts";
import { appliedLines, connectionLine, setupShowable } from "./render/connections.ts";
import { slotCreated } from "./render/results.ts";
import {
  code,
  id,
  type Line,
  name,
  num,
  shellLine,
  t,
  time,
  untrusted,
  words,
} from "./render/text.ts";
import { TEMPLATES, templateDocument, templateSlot } from "./templates.ts";
import { gap, type Static, TEXTS } from "./texts.ts";
import { Failed, NotDone, UsageError } from "./usage.ts";

/** What the service's side gives `setup` (the `daemon` package's code, handed in by the entry). */
export interface SetupServices {
  readonly initialized: (home: string) => Promise<boolean>;
  /** `saveslot init`: its exit code; what it says, a line at a time. */
  readonly init: (home: string, io: LineIO) => Promise<number>;
  /** `saveslot start`: likewise. */
  readonly start: (
    home: string,
    io: LineIO,
    stop: AbortSignal,
  ) => Promise<{ readonly exit: number; readonly started: boolean }>;
  /** What makes the home unusable as it is (its mode, a link, a file in its way), said as init says it; undefined when nothing does. */
  readonly homeProblem: (home: string) => Promise<string | undefined>;
  /** The lock of `setup`: undefined when another process holds it. */
  readonly lock: (home: string) => Promise<{ readonly release: () => Promise<void> } | undefined>;
}
export interface LineIO {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What `setup` is given by the command line and the process it runs in. */
export interface SetupInput {
  readonly home: string;
  readonly socket: string;
  readonly json: boolean;
  readonly yes: boolean;
  readonly templates: readonly string[];
  readonly timezone: string | undefined;
  readonly hosts: readonly string[];
  readonly scopes: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin, and the stream the questions go to (stderr), are terminals: both, to ask. */
  readonly stdinTerminal: boolean;
  readonly stderrTerminal: boolean;
  readonly ask: ((prompt: string) => Promise<string | undefined>) | undefined;
  readonly entry: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly hostname: string;
  /** How long a host's `--version` may run, and its look-up; each 5 s when not given (tests give them). */
  readonly versionTimeoutMs: number | undefined;
  readonly lookupTimeoutMs: number | undefined;
  readonly hostTimeoutMs: number | undefined;
  /** Writes saveslot's lines: progress on stdout, questions' context on stderr. */
  readonly say: (lines: Line[]) => void;
  readonly sayErr: (lines: Line[]) => void;
  /** Passes on what `init` and `start` say, as they write it themselves (stdout, stderr). */
  readonly passOn: LineIO;
  readonly client: () => Promise<Client>;
  readonly services: SetupServices;
  /** Calls `on` at SIGINT / SIGTERM until the function it gives back is called. */
  readonly watchSignals?: (on: (signal: StopSignal) => void) => () => void;
  /**
   * A server profile (06 §3.3 item 13): its name, its server, and its sign-in; absent, this
   * computer. `signedIn`: whether the profile's sign-in is usable now (its renewal failing: the
   * error, the server's); `signIn`: `saveslot login` for it (`--device` passed on), its exit code
   * and whether the person declined on the authorization page; undefined where login is not
   * available.
   */
  readonly server?: {
    readonly profile: string;
    readonly server: string;
    readonly device: boolean;
    readonly signedIn: () => Promise<boolean>;
    readonly signIn:
      | ((stop: AbortSignal) => Promise<{ readonly exit: number; readonly declined: boolean }>)
      | undefined;
  };
}

/** What `setup` gives back: the result (`--json`), the summary, what goes to stderr, the exit. */
export interface SetupOutput {
  readonly json: unknown;
  readonly lines: Line[];
  readonly errLines: Line[];
  readonly exit: number;
}

/** Where a host ended up (06 §3.3 item 8, §6.1): its row in the summary and in `--json`. */
type HostState = "existing" | "done" | "unconfirmed" | "failed" | "manual" | "not_found";
interface Instance {
  readonly id: Connection["id"];
  readonly name: string;
}
interface HostResult {
  readonly host: SetupHost;
  readonly state: HostState;
  /** A stable code for a failed or unconfirmed host (06 §6.1). */
  readonly reason?: string;
  readonly connection?: Instance & { readonly state: "live" | "revoked" };
  /** An entry there and more than one instance it may hold (existing, or instance_unsure): each, with its last read. */
  readonly connections?: ReadonlyArray<Instance & { readonly last_read: string | null }>;
  readonly why?: Line[];
}

/** What has been done so far: the result, and what is said when `setup` stops early. */
interface Report {
  /** A server profile's sign-in (06 §3.3 item 13, §6.1); failed or needed: nothing after it. */
  signedIn?: "existing" | "done" | "failed" | "needed";
  initialized?: "existing" | "done" | "failed";
  service?: "ready" | "failed";
  /** This run started the service (not one running already). */
  started?: boolean;
  /** The template whose slot could not be made. */
  slotFailed?: string;
  readonly slots: { template: string; slot: string }[];
  readonly hosts: HostResult[];
}

/** `setup` stopped short: its exit code, what to say, and how (`--json`'s `stopped`). */
class Stop extends Error {
  readonly exit: number;
  readonly said: Line[];
  readonly stopped: string | undefined;
  constructor(exit: number, said: Line[], stopped: string | undefined) {
    super("setup stopped");
    this.exit = exit;
    this.said = said;
    this.stopped = stopped;
  }
}

/** The signals `setup` stops cleanly on, and the exit code each gives (128 + its number). */
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 } as const;
export type StopSignal = keyof typeof SIGNAL_EXIT;
export const STOP_SIGNALS = Object.keys(SIGNAL_EXIT) as StopSignal[];
const IN_THE_WAY: ReadonlySet<string> = new Set(["EEXIST", "ENOTDIR", "EACCES", "EPERM"]);

/** Each value once, in the order first given (`--host` and `--template` given twice). */
const unique = (xs: readonly string[]) => [...new Set(xs)];

/** Checks what the command line gives, before anything is done; usage errors are 2. */
function checkInput(i: SetupInput): void {
  if (i.platform === "win32") throw new Failed(TEXTS.setupNotHere, 2);
  for (const tpl of i.templates) {
    if (!TEMPLATES.has(tpl)) throw new UsageError(TEXTS.templateUnknown);
  }
  if (i.timezone !== undefined && i.templates.length === 0) {
    throw new UsageError(TEXTS.timezoneNeedsTemplate);
  }
  for (const h of i.hosts) {
    // A host without an add command would need its token shown: not where no one may be looking.
    if (!APPLIES.has(h as never) || !(SETUP_HOSTS as readonly string[]).includes(h)) {
      throw new UsageError(TEXTS.setupHostBad);
    }
  }
  parseScopes(i.scopes);
  if (i.server !== undefined) {
    // A host connecting to a server is given its scopes on the authorization page.
    if (i.scopes.length > 0) throw new UsageError(TEXTS.setupScopeOnPage);
    // `--host` is checked above: the hosts with an add command are those with a remote one.
  }
  // Issuing, and making a slot, take the user session: a connection's token cannot.
  if (i.env["SAVESLOT_TOKEN"] !== undefined) throw new Failed(TEXTS.setupNeedsSession, 6);
}

/** The default name of a host's instance (06 §3.3 item 2): "<this computer> · <host>". */
function baseName(hostname: string, host: SetupHost): string {
  // The computer's part: at most 64 code points (a surrogate pair is one); none, the host's alone.
  const machine = Array.from(hostname.trim()).slice(0, 64).join("");
  const display = TEXTS.hostDisplay(host);
  return machine === "" ? display : `${machine} · ${display}`;
}

/** The base name, or with a number after it when an instance (any, revoked too) has that name. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A host found on this computer, with what is shown of it. */
interface Found {
  readonly host: SetupHost;
  /** The executable's absolute path (a host with an add command). */
  readonly exe?: string;
  readonly version?: string;
}

/** Hosts found (06 §3.3 item 1): on PATH and answering `--version`; an app by its directory. */
async function discover(i: SetupInput, stop: AbortSignal): Promise<Found[]> {
  const out: Found[] = [];
  for (const host of SETUP_HOSTS) {
    const info = HOST_INFO[host];
    if (info.exe !== undefined) {
      const exe = await onPath(info.exe, i.env["PATH"]);
      if (exe === undefined) continue;
      const version = await hostVersion(exe, i.env, i.versionTimeoutMs, stop);
      // Asked to stop: what was not probed is not known to be missing; the caller halts.
      if (stop.aborted) return out;
      if (version !== undefined) out.push({ host, exe, version });
      continue;
    }
    const home = i.env["HOME"];
    if (home === undefined || info.dirs === undefined) continue;
    for (const d of info.dirs(home, i.platform)) {
      if ((await stat(d).catch(() => undefined))?.isDirectory() === true) {
        out.push({ host });
        break;
      }
    }
  }
  return out;
}

const SCOPE_SET: ReadonlySet<string> = new Set<string>(SCOPES);
const scopeWords = (scopes: ReturnType<typeof parseScopes>): Line =>
  (scopes ?? DEFAULT_SCOPES).flatMap((x, k) =>
    k === 0 ? [code(x, SCOPE_SET)] : t` ${code(x, SCOPE_SET)}`,
  );

/** Runs `setup`: what it did, step by step, and its exit code. */
export async function setup(given: SetupInput): Promise<SetupOutput> {
  const i: SetupInput = {
    ...given,
    templates: unique(given.templates),
    hosts: unique(given.hosts),
  };
  checkInput(i);
  const scopes = parseScopes(i.scopes);

  // Without a terminal and without --yes: the steps it would take, nothing done (06 §3.3 item 6).
  if (!(i.stdinTerminal && i.stderrTerminal) && !i.yes && i.server !== undefined) {
    let signed: boolean;
    try {
      signed = await i.server.signedIn();
    } catch (e) {
      const d = describeError(e, { remote: true });
      return { json: { signed_in: "failed" }, lines: [], errLines: d.lines, exit: d.exit };
    }
    i.sayErr(await serverPlan(i, i.server, signed));
    throw new NotDone(i.stdinTerminal ? TEXTS.setupNoTerminalErr : TEXTS.setupNoTerminal);
  }
  if (!(i.stdinTerminal && i.stderrTerminal) && !i.yes) {
    const initialized = await i.services.initialized(i.home);
    const plan: Line[] = [[words(TEXTS.setupWouldDo)]];
    if (!initialized) plan.push([words(TEXTS.planInit)]);
    plan.push([words(TEXTS.planStart)]);
    for (const tpl of i.templates) plan.push(t`  ${words(TEXTS.planSlot)} ${name(tpl)}`);
    if (i.templates.length === 0) plan.push([words(TEXTS.planNoSlot)]);
    // The host commands as they would run, `<token>` where the token goes: none is issued yet.
    const entry = i.hosts.length > 0 ? await entryPath(i.entry) : "";
    for (const h of i.hosts as SetupHost[]) {
      plan.push(t`  ${words(TEXTS.planHost)} ${words(TEXTS.hostDisplay(h))}`);
      const exe = await onPath(HOST_INFO[h].exe as string, i.env["PATH"]);
      if (exe === undefined) plan.push(t`    ${words(TEXTS.hostNotFound)}`);
      else if (setupShowable(h, entry, i.socket, exe))
        plan.push(
          ...appliedLines(h, "", entry, exe, true)
            .slice(1)
            .map((l) => t`  ${l}`),
        );
    }
    if (i.hosts.length === 0) plan.push([words(TEXTS.planNoHost)]);
    i.sayErr(plan);
    // Said by what is missing: stdin to answer on, or stderr where the questions would be seen.
    throw new NotDone(i.stdinTerminal ? TEXTS.setupNoTerminalErr : TEXTS.setupNoTerminal);
  }

  // The home as it is, before anything is made in it (the lock's directory under run/).
  const problem = await i.services.homeProblem(i.home);
  if (problem !== undefined) {
    i.passOn.err(problem);
    return { json: homeFailed(i), lines: [], errLines: [], exit: 1 };
  }
  // The lock is under the home, made first when missing (run/ was looked at above, so what is
  // left in the way here is run/setup itself): said with its path.
  let lock: Awaited<ReturnType<SetupServices["lock"]>>;
  try {
    lock = await i.services.lock(i.home);
  } catch (e) {
    const x = e as NodeJS.ErrnoException;
    if (x.code === undefined || !["EEXIST", "ENOTDIR", "EACCES", "EPERM"].includes(x.code)) throw e;
    return {
      json: homeFailed(i),
      lines: [],
      errLines: [
        t`${words(TEXTS.setupHomeInTheWay)} ${untrusted(x.path ?? i.home)} (${code(x.code, IN_THE_WAY)})`,
      ],
      exit: 1,
    };
  }
  if (lock === undefined) throw new Failed(TEXTS.setupBusy, 7);
  const report: Report = { slots: [], hosts: [] };
  const stop = new AbortController();
  let caught: StopSignal | undefined;
  const unwatch = i.watchSignals?.((signal) => {
    caught ??= signal;
    stop.abort();
  });
  try {
    const exit =
      i.server !== undefined
        ? await serverSteps(i, i.server, report, stop.signal)
        : await steps(i, scopes, report, stop.signal);
    // A host given an instance that cannot create slots: how to let it (05 §1, 06 §3.2).
    const hint =
      i.server !== undefined
        ? [[words(TEXTS.setupServerAfter(i.server.profile))]]
        : report.hosts.some((h) => h.state === "done") && !createsSlots(scopes)
          ? [[words(TEXTS.noSchemaHint(writes(scopes)))]]
          : [];
    return { json: jsonOf(report), lines: [...summary(report, true), ...hint], errLines: [], exit };
  } catch (e) {
    // Stopped by a signal only where the stop is the signal's; another error says its own cause.
    const s =
      caught !== undefined && e instanceof Stop && e.stopped === "interrupted"
        ? new Stop(SIGNAL_EXIT[caught], [[words(TEXTS.setupInterrupted(caught))]], "interrupted")
        : e;
    if (!(s instanceof Stop)) throw e;
    return {
      json: { ...jsonOf(report), ...(s.stopped !== undefined ? { stopped: s.stopped } : {}) },
      lines: [],
      errLines: [...s.said, ...doneSoFar(report), ...summary(report, false)],
      exit: s.exit,
    };
  } finally {
    unwatch?.();
    await lock.release();
  }
}

/** The answer to a question, or a stop: the input ended, or a signal came while it waited. */
async function asked(i: SetupInput, stop: AbortSignal, prompt: string): Promise<string> {
  const ask = i.ask as NonNullable<SetupInput["ask"]>;
  const stopped = new Promise<undefined>((r) => {
    if (stop.aborted) r(undefined);
    stop.addEventListener("abort", () => r(undefined), { once: true });
  });
  const a = await Promise.race([ask(prompt), stopped]);
  if (stop.aborted) throw new Stop(1, [], "interrupted");
  if (a === undefined) throw new Stop(8, [[words(TEXTS.setupInputEnded)]], "input_ended");
  return a;
}

/**
 * A numbered list to switch items on and off (06 §3.3: text prompts, numbers): each answer of
 * numbers switches those; an empty one ends it. `after`: lines shown below, without numbers.
 */
async function choose(
  i: SetupInput,
  stop: AbortSignal,
  title: Static,
  items: readonly Line[],
  on: boolean[],
  after: readonly Line[] = [],
): Promise<boolean[]> {
  for (;;) {
    i.sayErr([
      [words(title)],
      ...items.map((item, n) =>
        on[n] ? t`  ${num(n + 1)} [x] ${item}` : t`  ${num(n + 1)} [ ] ${item}`,
      ),
      ...after,
    ]);
    const given = (await asked(i, stop, TEXTS.chooseNumbers)).trim();
    if (given === "") return on;
    const picks = given.split(/[\s,]+/);
    if (picks.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) >= 1 && Number(p) <= items.length)) {
      for (const p of picks) on[Number(p) - 1] = !on[Number(p) - 1];
    } else i.sayErr([[words(TEXTS.chooseAgain)]]);
  }
}

async function steps(
  i: SetupInput,
  scopes: ReturnType<typeof parseScopes>,
  report: Report,
  stop: AbortSignal,
): Promise<number> {
  const step = (n: number, what: Line) => {
    if (!i.json) i.say([t`[${num(n)}/5] ${what}`]);
  };
  // What `init` and `start` say is their own text, passed on as they write it (indented here).
  const service: LineIO = {
    out: (l) => {
      if (!i.json) i.passOn.out(l.replace(/^/gm, "      "));
    },
    err: (l) => i.passOn.err(l),
  };
  const halt = () => {
    if (stop.aborted) throw new Stop(1, [], "interrupted");
  };

  // 1. The home.
  if (await i.services.initialized(i.home)) {
    report.initialized = "existing";
    step(1, [words(TEXTS.stepInitialized)]);
  } else {
    step(1, [words(TEXTS.stepInit)]);
    // What went wrong, `init` says itself (the path and the reason).
    if ((await i.services.init(i.home, service)) !== 0) {
      report.initialized = "failed";
      throw new Stop(1, [], undefined);
    }
    report.initialized = "done";
  }
  halt();

  // 2. The service: started, or running at the same version (a different one stops here).
  step(2, [words(TEXTS.stepStart)]);
  const started = await i.services.start(i.home, service, stop);
  halt();
  report.service = started.exit === 0 ? "ready" : "failed";
  report.started = started.started;
  if (started.exit !== 0) throw new Stop(started.exit, [], undefined);
  halt();

  // 3. A slot, when there is none: made as `slot create --template` makes it.
  const session = await i.client();
  await makeSlots(i, session, report, stop, (what) => step(3, what), halt);

  // 4. The hosts: found, and chosen (in the order given, or the list's).
  const found = await discover(i, stop);
  // Stopped while probing: no host is said to be missing for not having been probed.
  halt();
  step(4, [words(found.length === 0 ? TEXTS.stepNoHosts : TEXTS.stepHosts)]);
  const addable = found.filter((f) => f.exe !== undefined);
  const manual = found.filter((f) => f.exe === undefined);
  let chosen: SetupHost[];
  let listed = false;
  if (i.hosts.length > 0 || !(i.stdinTerminal && i.stderrTerminal) || i.yes) {
    chosen = i.hosts as SetupHost[];
  } else if (found.length === 0) {
    chosen = [];
  } else {
    listed = true;
    // A host without an add command is listed, not numbered: setup cannot add it.
    const picked =
      addable.length > 0
        ? await choose(
            i,
            stop,
            TEXTS.chooseHosts,
            addable.map(
              (f) => t`${words(TEXTS.hostDisplay(f.host))} (${untrusted(f.version ?? "")})`,
            ),
            addable.map(() => true),
            manual.map(
              (f) => t`  - ${words(TEXTS.hostDisplay(f.host))}: ${words(TEXTS.hostManual(f.host))}`,
            ),
          )
        : [];
    chosen = addable.filter((_, k) => picked[k]).map((f) => f.host);
  }

  // 5. Per host: an entry there already, or a command to run; asked once, then done in turn.
  const all = chosen.length > 0 ? await allConnections(session) : [];
  const entry = chosen.length > 0 ? await entryPath(i.entry) : "";
  if (chosen.length > 0 && entryMayGo(entry)) i.sayErr([[words(TEXTS.entryMayGo)]]);
  const taken = new Set(all.map((c) => c.name));
  const todo: { host: SetupHost; exe: string; name: string; stale: Connection[] }[] = [];
  const order: SetupHost[] = listed ? found.map((f) => f.host) : chosen;
  const byHost = new Map<SetupHost, HostResult | "todo">();
  for (const host of chosen) {
    const exe = found.find((f) => f.host === host)?.exe;
    if (exe === undefined) {
      byHost.set(host, {
        host,
        state: "not_found",
        why: [[words(TEXTS.hostNotFound)]],
      });
      continue;
    }
    const base = baseName(i.hostname, host);
    const there = await hostEntry(exe, i.env, i.lookupTimeoutMs, stop);
    halt();
    if (there.kind === "unknown") {
      byHost.set(host, {
        host,
        state: "failed",
        reason: "lookup_failed",
        why: [[words(TEXTS.hostLookupFailed)]],
      });
      continue;
    }
    if (there.kind === "yes") {
      byHost.set(
        host,
        await existing(session, host, entry, there.out, hostInstances(all, host, base)),
      );
      continue;
    }
    if (!setupShowable(host, entry, i.socket, exe)) {
      byHost.set(host, {
        host,
        state: "failed",
        reason: "unshowable",
        why: [[words(TEXTS.setupUnshowable)]],
      });
      continue;
    }
    const n = freeName(base, taken);
    taken.add(n);
    const mine = hostInstances(all, host, base);
    todo.push({ host, exe, name: n, stale: [...mine.own, ...mine.like] });
    byHost.set(host, "todo");
  }
  if (listed) for (const f of manual) byHost.set(f.host, { host: f.host, state: "manual" });
  const record = () => {
    report.hosts.length = 0;
    for (const h of order) {
      const r = byHost.get(h);
      if (r !== undefined && r !== "todo") report.hosts.push(r);
    }
  };
  record();

  if (todo.length > 0) {
    // Shown with <token> where the token goes: nothing is issued before the answer (item 3).
    i.sayErr([
      t`${words(TEXTS.planIssue)} ${scopeWords(scopes)}):`,
      ...todo.flatMap((d) => appliedLines(d.host, "", entry, d.exe, true).slice(1)),
    ]);
    if (!i.yes) {
      const a = await asked(i, stop, TEXTS.runThese(todo.length));
      if (!/^(|y|yes)$/i.test(a.trim()))
        throw new Stop(8, [[words(TEXTS.setupDeclined)]], "declined");
    }
  }
  step(5, [words(TEXTS.stepAdd)]);
  for (const d of todo) {
    halt();
    byHost.set(d.host, await addHost(i, session, scopes, entry, d, stop));
    record();
  }
  halt();
  return report.hosts.some((r) => r.state === "failed" || r.state === "not_found") ? 1 : 0;
}

/** `--json` when the home cannot be used: no `initialized` on a server's branch (06 §3.3 item 13). */
const homeFailed = (i: SetupInput) => (i.server !== undefined ? {} : { initialized: "failed" });

/** The hosts setup can add to a server profile: those with a remote add command (06 §3.2). */
const remoteAddable = (h: SetupHost) => remoteAddCommand(h, "") !== undefined;

/** A host's remote add command as it runs: the host's executable by its path on PATH. */
const remoteRun = (host: SetupHost, exe: string, url: string) => [
  exe,
  ...(remoteAddCommand(host, url) as string[]).slice(1),
];

/** What `setup --profile` would do, said where nothing is done (06 §3.3 items 6, 13). */
async function serverPlan(
  i: SetupInput,
  server: NonNullable<SetupInput["server"]>,
  signedIn: boolean,
): Promise<Line[]> {
  const url = mcpUrl(server.server);
  const plan: Line[] = [[words(TEXTS.setupWouldDo)]];
  if (!signedIn) plan.push([words(TEXTS.planSignIn(server.profile))]);
  for (const tpl of i.templates) plan.push(t`  ${words(TEXTS.planSlot)} ${name(tpl)}`);
  if (i.templates.length === 0) plan.push([words(TEXTS.planNoSlot)]);
  for (const h of i.hosts as SetupHost[]) {
    plan.push(t`  ${words(TEXTS.planHost)} ${words(TEXTS.hostDisplay(h))}`);
    const exe = await onPath(HOST_INFO[h].exe as string, i.env["PATH"]);
    if (exe === undefined) plan.push(t`    ${words(TEXTS.hostNotFound)}`);
    else plan.push(t`    ${shellLine(remoteRun(h, exe, url))}`);
  }
  if (i.hosts.length === 0) plan.push([words(TEXTS.planNoHost)]);
  return plan;
}

/**
 * `setup --profile <server profile>` (06 §3.3 item 13): signed in first (`saveslot login`), a slot
 * made on the server when it has none, and the chosen hosts given the remote add command. Nothing
 * is issued: each host signs in itself, and the authorization page is the one consent; so nothing
 * is revoked when a host's command fails.
 */
async function serverSteps(
  i: SetupInput,
  server: NonNullable<SetupInput["server"]>,
  report: Report,
  stop: AbortSignal,
): Promise<number> {
  const step = (n: number, what: Line) => {
    if (!i.json) i.say([t`[${num(n)}/4] ${what}`]);
  };
  const halt = () => {
    if (stop.aborted) throw new Stop(1, [], "interrupted");
  };
  const asking = i.stdinTerminal && i.stderrTerminal && !i.yes;
  const url = mcpUrl(server.server);

  // 1. Signed in to the profile, or signed in now. A renewal that fails is the server's failure.
  let signed: boolean;
  try {
    signed = await server.signedIn();
  } catch (e) {
    report.signedIn = "failed";
    const d = describeError(e, { remote: true });
    throw new Stop(d.exit, d.lines, undefined);
  }
  if (signed) {
    report.signedIn = "existing";
    step(1, t`${words(TEXTS.stepSignedIn)} ${name(server.profile)}`);
  } else if (!asking || server.signIn === undefined) {
    // No one to sign in: said, nothing done (06 §3.3 item 6).
    report.signedIn = "needed";
    throw new Stop(8, [[words(TEXTS.setupSignInFirst(server.profile))]], undefined);
  } else {
    step(1, t`${words(TEXTS.stepSignIn)} ${name(server.profile)}`);
    const signIn = await server.signIn(stop);
    halt();
    if (signIn.exit !== 0) {
      // Login has said why. Declined on the authorization page: a person's no, as at step 5.
      report.signedIn = "failed";
      throw signIn.declined ? new Stop(8, [], "declined") : new Stop(signIn.exit, [], undefined);
    }
    report.signedIn = "done";
  }
  halt();

  // 2. A slot on the server, when it has none.
  const session = await i.client();
  await makeSlots(i, session, report, stop, (what) => step(2, what), halt);

  // 3. The hosts: found, and chosen; only those with a remote add command can be added here.
  const found = await discover(i, stop);
  halt();
  step(3, [words(found.length === 0 ? TEXTS.stepNoHosts : TEXTS.stepHosts)]);
  const addable = found.filter((f) => f.exe !== undefined && remoteAddable(f.host));
  const manual = found.filter((f) => !(f.exe !== undefined && remoteAddable(f.host)));
  let chosen: SetupHost[];
  let listed = false;
  if (i.hosts.length > 0 || !asking) chosen = i.hosts as SetupHost[];
  else if (found.length === 0) chosen = [];
  else {
    listed = true;
    const picked =
      addable.length > 0
        ? await choose(
            i,
            stop,
            TEXTS.chooseHosts,
            addable.map(
              (f) => t`${words(TEXTS.hostDisplay(f.host))} (${untrusted(f.version ?? "")})`,
            ),
            addable.map(() => true),
            manual.map(
              (f) =>
                t`  - ${words(TEXTS.hostDisplay(f.host))}: ${words(TEXTS.hostManualServer(f.host, server.profile))}`,
            ),
          )
        : [];
    chosen = addable.filter((_, k) => picked[k]).map((f) => f.host);
  }

  // 4. Per host: an entry already there (for this server, or another), or the command to run.
  const order: SetupHost[] = listed ? found.map((f) => f.host) : chosen;
  const byHost = new Map<SetupHost, HostResult | "todo">();
  const todo: { host: SetupHost; exe: string }[] = [];
  for (const host of chosen) {
    const exe = found.find((f) => f.host === host)?.exe;
    if (exe === undefined) {
      byHost.set(host, { host, state: "not_found", why: [[words(TEXTS.hostNotFound)]] });
      continue;
    }
    const there = await hostEntry(exe, i.env, i.lookupTimeoutMs, stop);
    halt();
    if (there.kind === "unknown") {
      byHost.set(host, {
        host,
        state: "failed",
        reason: "lookup_failed",
        why: [[words(TEXTS.hostLookupFailed)]],
      });
    } else if (there.kind === "yes") {
      // An entry named saveslot: this server's (its address seen in it), or another's (the local
      // service, or another server): not replaced; how to remove it is said.
      byHost.set(
        host,
        entryHolds(there.out, url)
          ? { host, state: "existing" }
          : {
              host,
              state: "unconfirmed",
              reason: "other_entry",
              why: [
                [words(TEXTS.unconfirmedOtherEntry)],
                t`  ${shellLine(removeCommand(host) as string[])}`,
              ],
            },
      );
    } else {
      todo.push({ host, exe });
      byHost.set(host, "todo");
    }
  }
  if (listed) for (const f of manual) byHost.set(f.host, { host: f.host, state: "manual" });
  const record = () => {
    report.hosts.length = 0;
    for (const h of order) {
      const r = byHost.get(h);
      if (r !== undefined && r !== "todo") report.hosts.push(r);
    }
  };
  record();

  if (todo.length > 0) {
    // No token in them: each host signs in itself when first used.
    i.sayErr([
      [words(TEXTS.remoteSignsIn)],
      ...todo.map((d) => t`  ${shellLine(remoteRun(d.host, d.exe, url))}`),
    ]);
    if (!i.yes) {
      const a = await asked(i, stop, TEXTS.runThese(todo.length));
      if (!/^(|y|yes)$/i.test(a.trim()))
        throw new Stop(8, [[words(TEXTS.setupDeclined)]], "declined");
    }
  }
  step(4, [words(TEXTS.stepAdd)]);
  for (const d of todo) {
    halt();
    byHost.set(d.host, await addRemote(i, d.host, d.exe, url, stop));
    record();
  }
  halt();
  return report.hosts.some((r) => r.state === "failed" || r.state === "not_found") ? 1 : 0;
}

/** One host given the server's remote add command, and looked up again. */
async function addRemote(
  i: SetupInput,
  host: SetupHost,
  exe: string,
  url: string,
  stop: AbortSignal,
): Promise<HostResult> {
  const display = TEXTS.hostDisplay(host);
  const ran = await runHostCommand(
    remoteRun(host, exe, url),
    i.env,
    i.hostTimeoutMs,
    () => {},
    stop,
  );
  if (ran.kind !== "done") {
    // Nothing was issued, so nothing is revoked; the host's status goes to stderr (item 8).
    i.sayErr([t`${words(display as Static)}: ${words(appliedWhy(ran))}`]);
    return { host, state: "failed", reason: appliedReason(ran), why: [[words(appliedWhy(ran))]] };
  }
  const after = await hostEntry(exe, i.env, i.lookupTimeoutMs, stop);
  if (after.kind !== "yes") {
    return {
      host,
      state: "failed",
      reason: stop.aborted ? "interrupted" : after.kind === "no" ? "no_entry" : "lookup_failed",
      why: [[words(TEXTS.entryNotSeen)], t`  ${shellLine(removeCommand(host) as string[])}`],
    };
  }
  return {
    host,
    state: "done",
    ...(entryHolds(after.out, url) ? {} : { why: [[words(TEXTS.addressNotSeenAfter)]] }),
  };
}

/**
 * A slot, when there is none (06 §3.3 step 3, item 13): made as `slot create --template` makes
 * it, on the local service or on a server profile's.
 */
async function makeSlots(
  i: SetupInput,
  session: Client,
  report: Report,
  stop: AbortSignal,
  say: (what: Line) => void,
  halt: () => void,
): Promise<void> {
  const list = await session.catalog({ level: "list", limit: 1 });
  if (list.slots.length > 0) say([words(TEXTS.stepSlotsThere)]);
  else {
    let chosen = [...i.templates];
    if (chosen.length === 0 && i.stdinTerminal && i.stderrTerminal && !i.yes) {
      const names = [...TEMPLATES.keys()];
      const width = Math.max(...names.map((n) => n.length));
      const picked = await choose(
        i,
        stop,
        TEXTS.chooseTemplates,
        names.map(
          (n) =>
            t`${name(n)}${words(gap(width - n.length + 2))}${words(TEXTS.templates.get(n) as Static)}`,
        ),
        names.map((_, k) => k === 0),
      );
      chosen = names.filter((_, k) => picked[k]);
    }
    if (chosen.length === 0)
      say([words(i.yes ? TEXTS.stepNoSlotYes([...TEMPLATES.keys()]) : TEXTS.stepNoSlot)]);
    for (const tpl of chosen) {
      const slot = templateSlot(tpl) as string;
      const made = templateDocument(tpl, slot, i.timezone);
      let r: Awaited<ReturnType<Client["schemaDraft"]>>;
      try {
        r = await session.schemaDraft({ document: made?.doc ?? {} });
      } catch (e) {
        // As `slot create` says it: the error, and what a refused time zone takes.
        report.slotFailed = tpl;
        const d = describeError(e, { remote: i.server !== undefined });
        const hint = timezoneHint(e, i.timezone !== undefined);
        throw new Stop(
          d.exit,
          [...d.lines, ...(hint !== undefined ? [t`  ${words(hint)}`] : [])],
          undefined,
        );
      }
      if (!i.json) {
        say(t`${words(TEXTS.stepSlotMade)} ${name(tpl)}`);
        i.say(slotCreated(r, made?.chosen).map((l) => t`      ${l}`));
      }
      report.slots.push({ template: tpl, slot });
      halt();
    }
  }
}

/**
 * A host with an entry named saveslot (06 §3.3 item 7): the entry must hold this saveslot's path
 * (the same check as after adding); and the instance it holds cannot be told from the entry (the
 * token is not kept, nor read back): with one live instance of its name, that one; with more,
 * none is picked, each listed.
 */
async function existing(
  session: Client,
  host: SetupHost,
  entry: string,
  lookedUp: string,
  live: { readonly own: readonly Connection[]; readonly like: readonly Connection[] },
): Promise<HostResult> {
  const remove = removeCommand(host) as string[];
  if (!entryHolds(lookedUp, entry)) {
    return {
      host,
      state: "unconfirmed",
      reason: "path_not_seen",
      why: [[words(TEXTS.unconfirmedPathNotSeen)], t`  ${shellLine(remove)}`],
    };
  }
  if (live.own.length === 0 && live.like.length > 0) {
    // Only instances named like the host's, not as setup names them here: none is taken to be
    // the one in the host, each listed; nothing issued.
    const listed = await listInstances(session, live.like);
    return {
      host,
      state: "unconfirmed",
      reason: "instance_unsure",
      connections: listed.connections,
      why: [[words(TEXTS.unconfirmedInstanceUnsure)], ...listed.lines, t`  ${shellLine(remove)}`],
    };
  }
  if (live.own.length === 0) {
    return {
      host,
      state: "unconfirmed",
      reason: "no_instance",
      why: [
        [words(TEXTS.unconfirmedNoInstance)],
        [words(TEXTS.replaceEntry)],
        t`  ${shellLine(remove)}`,
      ],
    };
  }
  const only = live.own.length === 1 ? live.own[0] : undefined;
  if (only !== undefined) {
    return { host, state: "existing", connection: { id: only.id, name: only.name, state: "live" } };
  }
  const listed = await listInstances(session, live.own);
  return {
    host,
    state: "existing",
    connections: listed.connections,
    why: [[words(TEXTS.existingSeveral)], ...listed.lines],
  };
}

/** Instances listed with their last read besides the self-check: for --json, and a line each. */
async function listInstances(
  session: Client,
  list: readonly Connection[],
): Promise<{
  connections: { id: Connection["id"]; name: string; last_read: string | null }[];
  lines: Line[];
}> {
  const connections: { id: Connection["id"]; name: string; last_read: string | null }[] = [];
  const lines: Line[] = [];
  for (const c of list) {
    const last = (await lastRead(session, c)) ?? null;
    connections.push({ id: c.id, name: c.name, last_read: last });
    lines.push(
      t`  ${connectionLine(c)} · ${last !== null ? t`${words(TEXTS.lastRead)} ${time(last)}` : [words(TEXTS.noReads)]}`,
    );
  }
  return { connections, lines };
}

/** One host's instance: issued, self-checked, added by the host's command, and looked up again. */
async function addHost(
  i: SetupInput,
  session: Client,
  scopes: ReturnType<typeof parseScopes>,
  entry: string,
  d: { host: SetupHost; exe: string; name: string; stale: Connection[] },
  stop: AbortSignal,
): Promise<HostResult> {
  const { host, exe } = d;
  const display = TEXTS.hostDisplay(host);
  // Old instances of this name that nothing read with besides the self-check: said, not revoked
  // (one may be the user's own, in use elsewhere).
  const stale: Line[] = [];
  for (const c of d.stale) {
    if ((await lastRead(session, c)) === null) {
      stale.push(t`  ${words(TEXTS.staleInstance)} ${connectionLine(c)}`);
    }
  }
  let added: Awaited<ReturnType<typeof issueAndAdd>>;
  try {
    added = await issueAndAdd({
      session,
      socketPath: i.socket,
      params: { name: d.name, ...(scopes !== undefined ? { scopes } : {}) },
      host,
      exe,
      entry,
      env: i.env,
      timeoutMs: i.hostTimeoutMs,
      stop,
    });
  } catch (e) {
    return {
      host,
      state: "failed",
      reason: "issue_failed",
      why: [[words(TEXTS.issueFailed)], ...describeError(e).lines, ...stale],
    };
  }
  const { checked } = added;
  const instance = { id: checked.connection.id, name: checked.connection.name };
  if (added.kind === "not_ready") {
    const c = added.checked;
    return {
      host,
      state: "failed",
      reason: "self_check_failed",
      connection: { ...instance, state: c.revoked ? "revoked" : "live" },
      why: [
        [words(c.kind === "malformed" ? TEXTS.tokenMalformed : TEXTS.selfcheckFailed)],
        ...(c.kind === "refused" ? describeError(c.error, { nextStep: false }).lines : []),
        [words(c.revoked ? TEXTS.setupRevoked : TEXTS.selfcheckNotRevoked)],
        ...stale,
      ],
    };
  }
  const { ran } = added;
  if (ran.kind !== "done") {
    // No one has the token: unlike `connect --apply`, the instance is revoked (06 §3.3 item 8).
    const revoked = await revokeQuietly(session, checked.connection.id);
    // The host command's status goes to stderr in both forms of output (item 8).
    i.sayErr([t`${words(display as Static)}: ${words(appliedWhy(ran))}`]);
    const result: HostResult = {
      host,
      state: "failed",
      reason: appliedReason(ran),
      connection: { ...instance, state: revoked ? "revoked" : "live" },
      why: [
        [words(appliedWhy(ran))],
        [words(revoked ? TEXTS.setupRevoked : TEXTS.selfcheckNotRevoked)],
        ...stale,
      ],
    };
    // Interrupted: given back like any failure, recorded, and then the loop stops.
    return result;
  }
  // Looked up again: no entry before, the command done, an entry now: added. Its output is never
  // shown; the path in it only adds a line when it is not seen (hosts write it their own ways).
  const after = await hostEntry(exe, i.env, i.lookupTimeoutMs, stop);
  if (after.kind !== "yes" && stop.aborted) {
    // Asked to stop while it looked: the command did succeed, so the instance is kept (the host
    // may be using it); only the entry was not checked.
    return {
      host,
      state: "failed",
      reason: "interrupted",
      connection: { ...instance, state: "live" },
      why: [
        [words(TEXTS.entryNotChecked)],
        t`  ${shellLine(removeCommand(host) as string[])}`,
        t`  ${shellLine(["saveslot", "connections", "revoke", checked.connection.id])}`,
        ...stale,
      ],
    };
  }
  if (after.kind !== "yes") {
    return {
      host,
      state: "failed",
      reason: after.kind === "no" ? "no_entry" : "lookup_failed",
      connection: { ...instance, state: "live" },
      why: [
        [words(TEXTS.entryNotSeen)],
        t`  ${shellLine(removeCommand(host) as string[])}`,
        t`  ${shellLine(["saveslot", "connections", "revoke", checked.connection.id])}`,
        ...stale,
      ],
    };
  }
  const note = entryHolds(after.out, entry) ? [] : [[words(TEXTS.pathNotSeenAfter)]];
  const why = [...note, ...stale];
  return {
    host,
    state: "done",
    connection: { ...instance, state: "live" },
    ...(why.length > 0 ? { why } : {}),
  };
}

/** `--json` (06 §6.1): each step's result, each host in order; never a token. */
function jsonOf(r: Report): Record<string, unknown> {
  if (r.signedIn !== undefined) {
    // Not signed in: the object ends there (06 §6.1).
    const on = r.signedIn === "existing" || r.signedIn === "done";
    return {
      signed_in: r.signedIn,
      ...(on ? { slots: r.slots } : {}),
      ...(r.slotFailed !== undefined ? { slot_failed: r.slotFailed } : {}),
      ...(on
        ? {
            hosts: r.hosts.map((h) => ({
              host: h.host,
              state: h.state,
              ...(h.reason !== undefined ? { reason: h.reason } : {}),
            })),
          }
        : {}),
    };
  }
  return {
    ...(r.initialized !== undefined ? { initialized: r.initialized } : {}),
    ...(r.service !== undefined ? { service: r.service } : {}),
    ...(r.service === "ready" ? { slots: r.slots } : {}),
    ...(r.slotFailed !== undefined ? { slot_failed: r.slotFailed } : {}),
    ...(r.service === "ready"
      ? {
          hosts: r.hosts.map((h) => ({
            host: h.host,
            state: h.state,
            ...(h.reason !== undefined ? { reason: h.reason } : {}),
            ...(h.connection !== undefined ? { connection: h.connection } : {}),
            ...(h.connections !== undefined ? { connections: h.connections } : {}),
          })),
        }
      : {}),
  };
}

/** What was done before `setup` stopped short. */
function doneSoFar(r: Report): Line[] {
  const out: Line[] = [];
  if (r.signedIn === "done") out.push([words(TEXTS.doneSignedIn)]);
  if (r.initialized === "done") out.push([words(TEXTS.doneInitialized)]);
  // The service only when this run started it.
  if (r.service === "ready" && r.started === true) out.push([words(TEXTS.doneService)]);
  for (const s of r.slots) out.push(t`${words(TEXTS.doneSlot)} ${name(s.template)}`);
  for (const h of r.hosts) {
    if (h.state === "done")
      out.push(t`${words(TEXTS.doneHost)} ${words(TEXTS.hostDisplay(h.host) as Static)}`);
  }
  return [[words(TEXTS.doneSoFar)], ...(out.length > 0 ? out : [[words(TEXTS.doneNothing)]])];
}

/** The summary: each host, how it ended, and why when it did not end well (06 §3.3 item 8). */
function summary(r: Report, finished: boolean): Line[] {
  const out: Line[] = [];
  for (const h of r.hosts) {
    out.push([
      ...t`${words(TEXTS.hostDisplay(h.host) as Static)}: ${words(TEXTS.hostState(h.state))}`,
      ...(h.connection !== undefined
        ? t` · ${untrusted(h.connection.name)} (${id(h.connection.id)})`
        : []),
    ]);
    for (const w of h.why ?? []) out.push(t`  ${w}`);
  }
  for (const h of r.hosts) {
    if (h.state === "done" || h.state === "existing") out.push([words(TEXTS.snippetHint(h.host))]);
  }
  // Setup does not install the start at login: the MCP bridge starts the service (06 §3.3 item 11).
  if (finished && r.service === "ready") out.push([words(TEXTS.autostartHint)]);
  // "Done." only when setup ran to its end.
  if (
    finished &&
    r.hosts.some((h) => h.state === "done") &&
    !r.hosts.some((h) => h.state === "failed")
  ) {
    const claudeCode = r.hosts.some(
      (h) => h.host === "claude-code" && (h.state === "done" || h.state === "existing"),
    );
    out.push([words(TEXTS.setupDone(claudeCode))]);
  }
  return out;
}
