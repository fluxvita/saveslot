# 12 · Contributing

> Translated from docs/zh-CN/guide/12-contributing.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

This chapter is for people who want to get their hands dirty: what you can do now, how the code is organized, what each kind of test guards against, in what order the first version is built, how to read and change the documents, and where the undecided matters are.

## 0. Where things stand now, and what to do first

**saveslot is in early development: the design is settled, the first implementation step (the P0 scaffolding) is under way, and there is no usable version yet.** The code organization and the tests described in the sections below are designs that have already been decided; follow them when implementing.

What you can take part in now:

| What you can do | Where to start |
|---|---|
| Build the scaffolding (P0 in the implementation steps): create the repository and the packages, wire the dependency rules into the automatic checks, write the event format and the contract as types | The package table in section 1; [`../spec/09-event-format.md`](../spec/09-event-format.md), [`../spec/04-contract-types.md`](../spec/04-contract-types.md) |
| Run experiment 1 (durability of the local database) and experiment 8 (the single-writer lock). They come first; the method and the pass criteria are already written, and they depend on only one file | [`../zh-CN/process/decisions/pre-dev-w0-experiments.md`](../zh-CN/process/decisions/pre-dev-w0-experiments.md) (Chinese); section 3 |
| Write the reference evaluator: write the definition "as if that sentence had never been said" as the most plain-spoken program possible. It does not depend on any code of the kernel | Section 2; chapter 8, section 10 |
| Walk through a new scenario as a walkthrough, or check a rule against its definition | Section 4, "Walkthroughs: a way to test the design" |
| Claim a matter that is not yet decided | Section 5 |

### The repository, the license, how we collaborate

| Item | What it is |
|---|---|
| Repository | `fluxvita/saveslot`. It is made public once it is usable (the threshold is the end of P2 in the implementation steps: writing, reading, deletion and conflicts work end to end, and the evals can run); when it is made public it comes with its full commit history |
| Packages | What is installed from outside is `@fluxvita/saveslot` (the command-line tool and the service); the other packages in the repository are named `@fluxvita/saveslot-<package name>`, with the package names in the package table in section 1 |
| License | Apache-2.0, for code and documents alike. No agreement needs to be signed to contribute: each commit carries one `Signed-off-by` line (`git commit -s`). Use your real name, with the same email as the commit author. A change made with the help of AI is signed off by a person all the same, and the person who signs off is responsible for the change |
| Where to talk | After the repository is made public: file bugs and tasks as Issues, ask questions and hold design discussions in Discussions, and report security issues through the repository's private vulnerability reporting. Before it is made public, use Issues and merge requests on the internal code hosting platform |
| How to submit | Create a branch from the main branch (fork first if you cannot push branches) → open a merge request against `main` using the template (every merge request targets `main`; a fix that has to be in a released version is cherry-picked by a maintainer onto the release branch `release/0.<minor>` after it is merged into `main`) → the quick checks on the merge request pass, `pnpm check` passes on the head to be merged (the author runs it before pushing and pastes the result; the maintainer runs it again before merging, depending on the risk of the change), all review threads are resolved, and one maintainer approves → a maintainer merges it as one commit. Commit messages and merge request titles both use Conventional Commits (the `feat(kernel): …` style), and CI checks the title |
| Language | Commit messages, code comments, identifiers, log and error messages are written in English. The documents are authoritative in Chinese (`docs/zh-CN/`). The specification and the guide also have an English edition at the same path under `docs/` ([`docs/README.md`](../README.md) lists them); the English edition of the decision records, walkthroughs and research notes is pending. When you change a Chinese document that has an English edition, change the English file in the same merge request. |
| Versions | 0.x until 1.0. The event format has its own version number, independent of the package version |

One rule you need to know first: **specification first.** A change in behavior updates the specification in the same merge request; a change that affects how readers understand the system also updates the guide. An incompatible change to the event format, the kernel invariants or the external interface goes further: first write a decision draft explaining why, and only after review passes change the specification and the code (section 4). These three are hard to change once settled, and stating the reasons clearly first is easier than arguing in code review.

The main points of the submission process are also written in `CONTRIBUTING.md` at the root of the repository.

### Toolchain

| Purpose | What is used |
|---|---|
| Runtime and language | Node 24.22.1 or later on the 24 line, or 26.12.1 or later (`.nvmrc` names the version CI uses; the nightly checks also run on the 26 line); TypeScript strict mode; ESM only |
| Package management | pnpm (monorepo) |
| Tests | Vitest; fast-check for property tests (section 2) |
| Formatting and lint | Biome |
| Dependency-direction check | dependency-cruiser (it enforces the three hard rules in section 1) |
| Build | `tsc` for each package; tsup bundles the command-line tool |
| Versions and change log | Changesets |

All checks are written as scripts in the repository, and the single `pnpm check` you run locally is the same set the automatic checks run: type check, lint, tests, dependency rules, links in the documents, and whether the JSON examples in the documents parse. The automatic checks on a merge request run only a few quick items (title, sign-off, secrets, banned words); the author runs the full set before every push, and the maintainer runs it again before merging, depending on the risk of the change; the automatic checks run it again after merging and every night.

## 1. How the code is split into packages

The whole project lives in one repository and is split into several packages (this way of organizing is called a monorepo; dependencies between packages are managed by the tool pnpm). Each package corresponds to one layer of chapter 4.

| Package | What is in it | Depends on |
|---|---|---|
| `contract-core` | The shape of data: how values are encoded, evidence, flags, intents, domain errors; the types of the event format | Nothing |
| `kernel` | All the kernel's modules and `ops` (chapter 4, section 4); the two interfaces, tenant storage and registry storage; the file implementation of registry storage | `contract-core`; storage depends on the interfaces only |
| `store-pglite`, `store-postgres` | The two storage backends | The storage interfaces in `kernel` |
| `contract` | The external contract: operation definitions, idempotency, paging, handles, credential-related fields and errors; the HTTP and MCP interface descriptions are generated from it | `contract-core` |
| `service` | The service layer: identity, permissions, idempotency waiting, handles, rate limiting, control-database storage (a file implementation and a PostgreSQL implementation) | `kernel`, `contract` |
| `server` | The two adapters, HTTP and MCP, and the renderer that turns results into text | `service`, `contract` |
| `daemon` | The assembly entry point: chooses the backend, wires the service layer and the adapters together, reads the configuration, starts the process; the scheduler for background tasks | `server`, `service`, the two backends |
| `client` | The HTTP client generated from the contract | `contract` |
| `cli` | The command-line tool, which always goes through `client` over HTTP | `client` |
| `saveslot` (entry point) | The executable, which only dispatches: commands that manage the process go to `daemon`, the rest to `cli` | `cli`, `daemon` |

The first version contains no package for a developer SDK, and no sync module or job module in `kernel`.

### Dependency direction

```
contract-core ◀── kernel ◀── service ◀── server ◀── daemon
      ▲                         ▲
      └──── contract ───────────┘
                 ▲
              client ◀── cli
```

An arrow points to the side that is depended on. Three hard rules:

1. **`kernel` does not depend on any transport, and does not depend on `service` or `contract`.** It knows only the data shapes in `contract-core` and the two interfaces (tenant storage, registry storage). This guarantees that the kernel can be taken out on its own and embedded in other programs (a future SDK).
2. **Adapters cannot bypass `service` and call the kernel directly.** This makes it impossible to skip the identity and permission checks.
3. **Splitting the contract into two layers is deliberate.** `contract-core` is the shape of the data itself, and the kernel depends on it; `contract` is the external wrapping (paging parameters, idempotency keys, outer error codes). This way, adding a paging parameter or an error code to the external interface does not touch the kernel.

The dependency rules between packages and between kernel modules are both checked by a tool as part of `pnpm check`; they must pass before merging, and a change that violates them cannot be merged.

### Where to go to change something

| What you want to change | Where to go |
|---|---|
| A judgement rule (how a conflict is judged, whether something counts as high-impact, whether a row exists) | `judge` in `kernel`. It is the only implementation, and it is what both "judge once" at write time and "replay a whole row" at deletion time use (chapter 4, section 4); a change in semantics must raise the rule version; change the specification and the reference evaluator at the same time |
| The flow of a write or a deletion (validate, fetch data, produce events) | `write` and `delete` in `kernel` |
| What one kind of event records | First change the event format specification; the types are in `contract-core`; the module in `kernel` that produces it, and `apply` |
| The parameters or the receipt of an operation | First change the type definitions of the contract; the data shape is in `contract-core`, the external wrapping in `contract`, and the entry point in the kernel is in `ops` of `kernel` |
| The description of an MCP tool, the wording of a receipt's text | The renderer in `server` |
| A command-line command | `cli` |
| Authentication, rate limiting | `service` |
| The behavior of a database backend | `store-pglite` or `store-postgres` |

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §11.

## 2. What each test guards against

Many of saveslot's promises are of the kind "holds no matter what", and such promises can only be kept by specially designed tests. Each kind of test below corresponds to a specific class of mistake.

### Running everything on both backends

The kernel's tests run once on PGlite and once on PostgreSQL.

**What it guards against:** logic that is correct on only one backend. Both backends are PostgreSQL, but their versions and ways of running differ, so their behavior may differ in small ways.

### Replay comparison

Hand the same log, from the beginning, to `apply` on each of the two backends to replay, then compare the resulting tables row by row. There is one more kind: the tables obtained by "replaying from an empty database" must match, row by row, the tables the live system has been running with.

**What it guards against:**

- A replay result that depends on something outside the log, such as the current time, the database's default time zone or the collation. Mistakes of this kind are not visible normally and show up only when the log is replayed in another environment.
- Tables changed anywhere other than `apply`.
- The two backends computing different numbers for the same derivation rule.

This is the direct test of the statement "the log is the only source of truth". Which tables take part in the comparison is marked table by table in the table list of the storage format; the full-text index and the profile statistics in the catalog can be rebuilt, but are not required to match row by row.

### Export replay

Export → replay into an empty database → compare row by row with the original tables. Do both backends crosswise: an export made on PGlite is replayed into PostgreSQL, and the reverse as well. An export with "pending deletion" placeholders is also tested: after the replay, the current business state matches the live one.

**What it guards against:** "your data can be taken away" turning into an empty phrase. The first version has no user command to load an export back in, so this promise is tested only here.

### Kernel-only consistency tests

Give the kernel an "empty service layer" (everyone can see all the data, no idempotency waiting) and a file implementation of registry storage, then write **counterexamples** for each kernel invariant (K1–K14): deliberately do something that violates it, and assert that it must fail or must be detected. For example:

| What is done deliberately | What must happen |
|---|---|
| Resolve a pending item without a matching item version | Fails |
| Change a business table directly, bypassing `apply` | The replay comparison finds an inconsistency |
| Send the same request key twice | Applied only once |
| Change some content without changing the checksum | The log verification reports a mismatch |
| Delete or swap an event | The event header chain breaks |
| After a privacy deletion falls due, search the whole store for the deleted original text or for values computed from it | Found nowhere: event headers, content, the tables of every version, items, the catalog, indexes, read records |
| Confirm a deletion, copy the tenant's data as a backup, wait until the physical erasure at the due time, then overwrite with the backup (the register untouched), then open it | The deleted content still cannot be found |
| After restoring a backup, use the version marks, item versions and handles obtained before the restore | None is accepted as the current version |
| During the restore flow, kill the process hard after each step and start it again | Nothing is served externally until the re-applied deletions are complete |

**What it guards against:** two things. One is that an invariant itself was implemented wrongly. The other is that an invariant quietly depends on the service layer: since the service layer in the test is empty, if the invariant still holds, it really relies only on the kernel and the two interfaces. The latter is the guarantee that "the kernel does not need to change" when an SDK is built in the future.

### The reference evaluator and property tests

Chapter 8 explained that the result of a privacy deletion is computed from one sentence of definition. The code that actually runs, for efficiency, recomputes only the affected rows, and its logic is quite complicated. So a separate **reference evaluator** is written: a pure function whose input is "all the write events of one row + the set of deleted source data" and whose output is what that row should look like. It treats the state as "the value of each field at each valid time", implements it in the plainest way according to the definition, does not pursue efficiency, **does not use any judgement code in the kernel** (including `judge`), and lives in the test package.

When the deleted set is empty, what it computes is "what things should look like after a series of writes". So it checks not only deletion but also the rules for writes, time and conflicts.

The most convoluted part of the rules is how "undoing a write, taking the previous value" is computed when it meets a privacy deletion. This part is given in the specification directly as the pseudocode of the reference evaluator, as the authoritative definition ([`../spec/03-data-model/03-deletion.md`](../spec/03-data-model/03-deletion.md), "Replay rules · The authoritative definition of reverting"). When implementing, first write the reference evaluator according to it, then make the live implementation go through the replay comparison against it. The scenarios worked out by hand during the design phase are recorded in the appendices of [`../zh-CN/process/decisions/pre-dev-w6-final-fixes.md`](../zh-CN/process/decisions/pre-dev-w6-final-fixes.md) (Chinese), and each of them should be turned into a test case.

The way of property testing is: instead of writing a few fixed examples, let the program generate a large number of random sequences of writes and deletions, and check whether a set of properties holds every time. The properties fall into three groups, and the full table is in [`../spec/02-architecture.md`](../spec/02-architecture.md) §11:

| Group | Examples | What mistakes it catches |
|---|---|---|
| Deletion (chapter 8, section 10 lists all of them) | Consistent with the reference; independent of order; nothing missed; nothing over-deleted; what already took effect stays in effect; a no-op stays a no-op; a revert does not fall back to an undone value; after a restatement the live state and the reference agree; the record agrees with recomputation | The deletion rules implemented off; privacy leaks that slip through; deleting too much |
| Time | A write with the default end is equivalent to a write with an explicit end at "the next stop point of that field"; splitting a stretch of data internally into two does not change the conclusion of any judgement; `as_of` never reads the intermediate state of a write; the version table uses the right sequence number | The end resolved wrongly or not resolved per field; a judgement peeking at how things are split internally; the version table using the wrong sequence number |
| Conflict | Within the range stated in the specification (both writes carry the same version, neither passes an end, neither points to evidence, neither erases a change point it read): A then B is judged a conflict if and only if B then A is also judged a conflict; for those that do not conflict, the two orders give the same result. The three known cases outside the range each have one fixed case; every accepted write has a destination, and a candidate does not disappear silently | A judgement that depends on arrival order; a merge result that depends on order; an item closed by a write that never saw it |

One thing in there is worth saying more about: "the record agrees with recomputation". The test "replay from an empty database = live state" cannot catch a deletion that was computed wrongly, because the replay uses exactly the result recorded in the event, and a wrong result is faithfully replayed. So an independent implementation is needed to check against.

The specification has two scenario walkthroughs (one for deletion, one for concurrent writes to state tables, both under `docs/zh-CN/process/walkthroughs/`), and every example in them will be written as a "consistent with the reference" case.

### Contract tests and renderer tests

- **Contract tests:** the same set of cases runs once against HTTP and once against MCP; the self-hosted form of server mode gets one more run of its own. They guard against the same operation behaving differently through different ways of connecting.
- **Renderer tests:** check that every kind of flag in the contract appears in the rendered text. They guard against a flag such as "disputed" being present in the structured result but missing from the text, when some agents can see only the text.

### Evals: whether a real agent can understand it

The tests above check whether saveslot itself is right. Evals check another thing: **have a real agent get something done through MCP, relying only on the tool descriptions and the receipt text, and see whether it does it right.**

For example: with no context at all, does the agent know to look at the catalog first; when correcting, does it use `correct`; when a write became a conflict candidate, does it understand that it "did not take effect" and tell the user; before a deletion, does it preview first, relay "the whole row will be deleted" to the user, and then execute.

The eval spec is in [`../spec/10-evals.md`](../spec/10-evals.md). It has 11 groups of tasks, and each task states which data to use, the user's exact words in each turn, what must and must not appear in the calls, the checks on saveslot's state after the run, the requirements on the agent's reply, and the pass line. The checks come in three levels:

| Level | What is checked | How it is counted |
|---|---|---|
| Safety | Unacceptable things did not happen: executing a deletion without asking the user, confirming an overwrite without asking the user, acting on instructions hidden in the data | One violation and the task fails |
| State | The task was completed and the state in saveslot is correct | Judged by machine, counted toward the pass line |
| Reply | The agent said to the user what it should have said | First judged by rules; what rules cannot judge is judged by another model, and a share is spot-checked by people |

The last two groups deserve separate mention:

- **eval 10, premises of a write**: the agent looks at the release date in the store before scheduling tasks; when writing, whether it carries premises, and whether it lists only the records it really used; after another connection changes the release date, whether an agent that reads "premise has changed" first tells the user and gets agreement before changing; for rows that need no change, whether it restates the premise or rewrites them unchanged.
- **eval 11, record quality**: evals 1–10 each give the agent one explicit sentence and check whether it calls correctly; they cannot answer the earlier questions: when something worth recording comes up in a conversation, does the agent record it; before answering a question, does it read first. Eval 11 uses multi-turn conversations mixed with small talk, hypotheticals and other people's affairs, and measures the capture rate, the missed-write rate, the wrong-write rate, and the share of answers that used an old value that had already been changed. It produces numbers only and sets no pass line.

Each group of evals runs in three configurations: the main configuration (tool descriptions plus the service-level instructions `instructions`), the control configuration (tool descriptions only), and an additional variant (also putting the suggested text of `saveslot snippet` into the host's instruction file). The pass lines of evals 1–10 are computed on the main configuration; the differences among the three show how much `instructions` and the host-side instructions each contribute. Whether the host actually received `instructions` must also be recorded, or a failure cannot be attributed.

Evals do not verify the kernel's correctness; that is the job of the kinds of tests before. A failed eval has three possible causes: a problem in the tool descriptions, a problem in the receipt wording, or a problem in the rules themselves. For the first two, change the wording; the third has to go back to the specification for a new discussion, and is not covered up by changing wording.

### Checks reserved for a future SDK

The first version does not build an SDK, but several checks must pass in the first version, to guarantee that the kernel need not change when it is built later: the kernel can start on its own in several JavaScript runtimes (and computes the same hashes); two processes opening one data directory at the same time must produce an error; the call context can be fully serialized and restored; after being closed for 25 hours and opened again, deletions that are past the grace period must be completed first.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §11 "The test matrix", §13; [`../spec/10-evals.md`](../spec/10-evals.md).

## 3. The order of work for the first version

### What you need before starting

These are design work, not code, and must be settled before kernel development:

| Deliverable | Where |
|---|---|
| The first version of the event format: the event header fields, content blocks and enums of each kind of event | [`../spec/09-event-format.md`](../spec/09-event-format.md) |
| The interface of registry storage, the list of the kernel's own tables | [`../spec/02-architecture.md`](../spec/02-architecture.md) §8 |
| The type definitions of the contract | [`../spec/04-contract-types.md`](../spec/04-contract-types.md) |
| The unit vocabulary, default precision, default slot policy | [`../spec/03-data-model/10-types-and-units.md`](../spec/03-data-model/10-types-and-units.md), [`../spec/03-data-model/01-objects.md`](../spec/03-data-model/01-objects.md) |
| The pass criteria of each experiment | [`../zh-CN/process/decisions/pre-dev-w0-experiments.md`](../zh-CN/process/decisions/pre-dev-w0-experiments.md) (Chinese) |
| The eval spec | [`../spec/10-evals.md`](../spec/10-evals.md) |

**When the event format is frozen.** It is frozen before the first external release of local mode, and after that it only grows and is never changed. Before that, logs produced during development are not promised to be compatible, which leaves the implementation room to adjust.

### Implementation steps

The implementation is divided into steps; each step adds to the one before, and is accepted by "which eval tasks can run through".

| Step | What is done | What can be verified when done |
|---|---|---|
| P0 Scaffolding | The repository and packages, dependency checks in CI, the types of the event format, the two storage interfaces, creating the kernel tables, the worker skeleton for PGlite | — |
| P1 Minimum usable · kernel | The PGlite backend; the log, `apply`, marks; the structure of `judge` and `derive`; the entry point and scheduler for background tasks | — |
| P1 · reading and writing | Writing: the four intents, `ver` and conflicts, state tables, high-impact, revert, exactly once, field-level provenance, rule versions. Reading: queries, history, read records. One derivation rule | — |
| P1 · local connection | Local HTTP and MCP; two connections; tool descriptions and the per-credential `instructions`, three prompts; `saveslot setup` and the most basic commands | Discovering data, correction, conflicts, state-table writes; from this step on, record quality produces numbers at every step |
| P1 · a small prototype midway | A prototype of deletion replay, to verify that `judge` can both judge one write and replay a whole row, and that the two uses give the same result | One of the biggest uncertainties in the implementation |
| P2 Reading and writing completed + the second backend | All the ways of writing evidence, source level and literal match, suspected duplicates, queries on source data, read-only SQL, impact queries, reference fields, writing by external key, premises of a write, aliases and keys of similar spelling, the PostgreSQL backend, the replay comparison on both backends, the export replay test | Evidence mapping; the full correction flow; premises of a write |
| P3 Deletion and restore | Privacy deletion, previews and handles, the grace period and cancelling a deletion, the deletion register and reconciliation, physical erasure at the due time and residue cleanup, the **restore flow**, export (including passphrase encryption), the reference evaluator and all the property tests | Deletion; undo after a prompt injection |
| P4 Schema changes | Drafts, change items, the migration flow, building tables by version and switching, rebuilding the new table when a deletion happens during a migration (excluding changes that need re-extraction) | The first half of schema changes |
| P5 Server mode | The rest of the service layer, the control database, one database per user, OAuth, remote MCP, operations commands, deployment documents and container images; credentials limited to a slot; import into an empty tenant | Rerun all the evals on a server |
| P6 Wrap-up | Completing the command line (including the data-size warning of `saveslot doctor`), start at boot, tuning the tool descriptions, `instructions`, the suggested text and the various values according to the eval results | — |
| P4b (not part of the first version) | Extraction jobs: the full flow for when a schema change needs re-extraction from the original words | The second half of schema changes |

The release order is local mode first (P1–P4, P6), then server mode (P5). Before server mode goes online, privacy deletion must already be complete, and the legal conclusion on "metadata kept after deletion" must already be in hand.

The restore flow is placed in P3 rather than P5: the acceptance tests of deletion need it, and local mode, which is released first, needs it too.

The person-week estimates for each step in the specification are rough figures from before the phases were adjusted and have not been re-estimated; they are not quoted here.

### Principles for trade-offs

These are what decide whether a feature goes into the first version. When you want to propose adding to or cutting the scope, argue by them:

1. **Whatever changes the event format must be done in the first version, or at least have its place reserved.** The test is: when it is added back later, can the information missing from the old events still be filled in. For example field-level provenance, literal match and rule versions cannot be filled in afterwards, so the first version has to record them, even if the features that use them are not in the first version.
2. **Whatever would loosen a kernel invariant must be done in the first version.** Only "the scope of application becomes smaller" is allowed (the feature is off, so the rule naturally does not fire); no discount is allowed.
3. **Whatever affects only the surface, or can be added back purely incrementally, is cut first.** Purely incremental means: adding a kind of event, a tool or an endpoint, with no migration of old data.
4. **Being able to run the evals comes before feature completeness.**
5. **The legal floor of the cloud service cannot be cut.** This is why privacy deletion and export are not moved later.

### Required experiments

Some things cannot be settled on paper and need experiments. Each experiment has objective pass criteria and "what to do if it does not pass"; the criteria may be adjusted before the experiment starts, and are not changed after seeing the results.

| Experiment | What it asks | What the conclusion affects |
|---|---|---|
| 1 PGlite durability | After the process is killed hard or power is cut, are confirmed writes lost | **Done first.** If it falls short, replace the local backend with a bundled native PostgreSQL |
| 8 Single-writer lock | When two processes open one data directory at the same time, exactly one succeeds | How the lock is implemented |
| 2 PGlite sandbox | How costly it is to terminate the worker; whether the SQL allowlist stops all kinds of bypasses | The timeout policy for slow queries |
| 4 Latency of derivation refresh | How long recomputing the derived tables in the same transaction at write time takes at typical data sizes | The threshold for admitting a write |
| 9 Capacity limits | Three data shapes (10 thousand to 1 million events at a human pace, ten years of summarized health data, minute-level series readings) on both backends: write latency, size of the log and storage, how long opening the data and replaying from the beginning take, time for export and deletion, memory. It produces numbers only, and goes up scale point by scale point until "it does not work from here" | The two size lines of the data directory and `saveslot doctor`; whether to do snapshots early; whether high-frequency readings need a kind of table of their own |
| 5 Replay consistency | Whether replaying the same log on PGlite and on PostgreSQL (including different major versions) gives results that match row by row | Whether server mode can go online |
| 7 Residue after physical erasure | After deleting and cleaning up, whether searching the files of the data directory byte by byte for the deleted original text finds it | How residue cleanup is done |
| 6 Desktop packaging | The start-up time and memory of PGlite; whether bundling a native PostgreSQL is feasible | How local mode is installed |
| 3 Capacity of one database per user | How many user databases are safe to put in one database cluster | How many users the cloud service puts on each group of servers; does not block the first version going online |

One point in the design of experiment 1 is worth knowing: a test that only "kills the process" is not enough. When a process is killed, data already handed to the operating system is still in the memory cache and is not lost, so the test can pass even if nothing at all reached the disk. The experiment therefore has to observe the system calls that reach the disk directly, and do a real power cut; it also requires that the default configuration must lose data in the same test, otherwise the test method did not produce a real power cut.

The two biggest uncertainties at present: the result of experiment 1; and the difficulty of implementing "replay the affected rows by definition" for deletion, which the small prototype midway in P1 probes first.

Specification: [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md). Its section 3 is the item-by-item list of mechanisms (more than ninety items, each marked Yes, Simplified or Later, in which phase, and what effect it has on which invariant); to find out whether the first version has a given feature, look there.

## 4. How to read and change the documents

### Two sets of documents

| | The guide (this directory) | The specification (`../spec/`) |
|---|---|---|
| Purpose | To help people understand | To serve as the basis for implementation |
| Style | The simplest case plus examples | Complete rules, with all the boundaries |
| When they disagree | | The specification holds |

### The structure of the specification

| File | Content | When to read it |
|---|---|---|
| `01-positioning.md` | Positioning, product forms, deployment forms, technology choices, later plans | When you want to know "why this direction" |
| `02-architecture.md` | Kernel invariants, modules, runtime, the two storage interfaces and the list of the kernel's tables, trust boundaries, code organization, the test matrix | Before touching the kernel |
| `03-data-model/` | The authoritative definitions of the data mechanisms, in 11 files (the 11th is the allowlist of restricted SQL) | Before changing any data rule. This is the most central group |
| `04-contract.md` | The rules and explanations of each operation | When changing the interface, or writing an integrator |
| `04-contract-types.md` | The type definitions and examples of the parameters, results and errors of each operation | When writing code that calls it, or generating the interface descriptions |
| `05-surfaces.md` | The rules of MCP and HTTP each, how text is rendered | When changing tool descriptions and receipt wording |
| `06-cli.md` | The command line | When changing commands |
| `07-scope-v1.md` | The scope of the first version and the implementation order | Look it up any time |
| `08-open-questions.md` | All the undecided items | Look it up any time |
| `09-event-format.md` | The field-level definition of each kind of event in the log, the format of the export file | When touching `log` and `apply`, or when you need to read an exported log yourself |
| `10-evals.md` | The executable specification of the eval tasks | After changing tool descriptions or receipt wording; when accepting a phase |

The documents are all under `docs/zh-CN/` in the repository: the guide in `docs/zh-CN/guide/`, the specification in `docs/zh-CN/spec/`. There are two more directories: `docs/zh-CN/research/` is public technical research (technical choices and trade-offs on data models, storage, protocols, evaluation methods and so on); `docs/zh-CN/process/` is process material, including scenario walkthroughs (`walkthroughs/`) and the decision drafts for the design choices made before development started (`decisions/`, each stating what was chosen, why, and a minimal example).

Competitor analysis, market and product snapshots, product positioning, pricing and commercial strategy research go in the internal repository, not in this one. When a piece of research has both kinds of content, the technical part and the commercial part are written as separate documents and maintained separately; two synchronized copies of the text are not kept. A conclusion the public design depends on must stand on its own in the specification, decision drafts or technical research of this repository, and cannot rest on internal research.

Existing technical research stays where it is. Before the repository is made public it is read through by the public standard; superseded advice and unverified judgements are marked in the original text, without rewriting the original conclusions or deleting history.

### A few tips for reading the specification

- **A rule has only one authoritative place.** Data rules are in `03-data-model/`; what an event records is in `09-event-format.md`; the external shape is in `04-contract-types.md`. Other documents that mention the same thing are only quoting it. When several statements disagree, the authoritative place holds, and that in itself is a problem worth reporting.
- **The contract and the surface describe the complete design.** Some of the operations and fields in them are not implemented in the first version: the type file opens with a list of "not implemented in the first version", they are marked uniformly in the text, and the scope follows `07-scope-v1.md`.
- **The long tables in the specification are lists for implementers.** For example, the replay rules table in the deletion document and the change classification table in the schema document. On a first reading, read the sentence of definition before the table first, and look up the table itself when you need it.
- **When you cannot understand a rule, look for the walkthroughs and the decision drafts.** `docs/zh-CN/process/walkthroughs/` has step-by-step walkthroughs of five scenarios: running, budget, deletion, concurrent state tables and nutrition records; in `docs/zh-CN/process/decisions/` you can look up why a rule was decided this way and what another approach would have done.

### What to update together when changing the design

A design change is not a change in only one place. Below is a checklist:

| What was changed | What else to look at |
|---|---|
| A data rule | The authoritative definition in `03-data-model/`; the kernel invariant it corresponds to (`02-architecture.md` §3); if the semantics of a judgement changed, the rule version must be raised by 1; the affected fields in the event format; the affected parameters, results and error codes in the contract; the text of the surface; the corresponding line in the scope of the first version; the reference evaluator and the property tests |
| What an event records | `09-event-format.md` (grow only, never change); whether it is a metadata block or a data block, what the source of the data block is, how it cascades on deletion (`03-data-model/03-deletion.md`, "Content derived from source data"); which tables `apply` changes accordingly |
| A new kind of stored state | Put it into one of the three classes, add it to the table list in `02-architecture.md` §8; if it is class (c), state "what happens if it is lost" |
| The shape of an operation | `04-contract-types.md`; the rules in `04-contract.md`; the matching MCP and HTTP (`05-surfaces.md`); the command line (`06-cli.md`); enums shared with the event format, which must have the same names on both sides |
| Tool descriptions, parameter descriptions, the service-level instructions `instructions`, prompts or receipt wording | `05-surfaces.md`; go through the checks below; rerun the related evals (`10-evals.md`), and when `instructions` changed, look at the difference between the main and control configurations of eval 11 |
| Whether the first version does a given item | The mechanism list of `07-scope-v1.md`, and state the effect on the invariants |
| An undecided matter was left behind | Record it in `08-open-questions.md`. It is the only list of undecided matters; other documents only point to it |
| Content that the guide covers | The corresponding chapter in this directory |

**The checks to go through when changing tool descriptions, parameter descriptions, `instructions` and prompts.** These are "static text": only the publisher of saveslot can write them, and they go through review, so they may say "when to use". Receipts, errors and hints are "dynamic text" that sits right next to stored untrusted data; they state only facts and the next steps available, and do not direct the model (except the few places that require getting the user's consent first). When changing static text, check item by item (the full list is in section 4.3 of `05-surfaces.md`):

1. Condition on the user's intent ("when the user asks about their own records"); do not write unconditional requirements ("call this at the start of every conversation").
2. State clearly when not to use it: do not write for small talk, hypotheticals, or when there is no matching table.
3. Talk only about saveslot's own tools: do not mention the tools of other services, do not ask to take priority over other tools, do not rewrite the instructions the host or the user gave the model, do not ask the model to hide anything from the user.
4. Mention only tools that this credential can use: a sentence pointing to another tool appears only when that tool is also in the list.
5. Contain no stored user content: descriptions of tables or fields, aliases, values and original text do not come in; the one exception is the slot names in `instructions`.
6. Write order dependencies as conditional sentences ("read an existing record before changing it"), not as "must call X first".
7. Put the important words at the beginning: the first 512 characters of `instructions` are self-contained, and neither the whole text nor any tool description exceeds 4,096 characters.

Text the model can see is always in plain language, with identifiers written as in the specification; the first version is in English, and the Chinese in the specification is the authoritative version of the content.

Two writing conventions:

- **A design document says only the design.** Dates, which round of revision, who raised it in which review: such process information goes into `docs/zh-CN/process/`, not into design documents.
- **For changes involving deletion, check examples against the definition.** Each example gives side by side "what it should be by the definition" and "what it comes out as by the rules"; if the two differ, the rule is wrong.

### Walkthroughs: a way to test the design

When you propose a new scenario or a new rule, the most effective test is to walk through a walkthrough: choose a concrete scenario, and for each step write what call the agent sent, which events were appended to the log, which tables changed, what changed in the local runtime state, and what the next session reads, then check against K1–K14 one by one. Wherever "two agents should get the same result whichever arrives first", walk through both orders. Chapter 2 is a simplified walkthrough.

## 5. What is not yet decided

All the undecided matters are collected in [`../spec/08-open-questions.md`](../spec/08-open-questions.md). When you see "undecided" while reading the specification, it always means that file. It is divided into three groups by "when it must be decided":

| Group | Meaning | Examples |
|---|---|---|
| Must be decided before development | Those that will be written into log events and are hard to change once decided. This group should be emptied before kernel development starts | None at present: all are decided, and the first version of the event format can be frozen |
| Decided before a given phase starts | States which phase | The thresholds and the various timeouts for admitting a write, the values of the two size lines (waiting for experiment results); the batch size and threshold of the switch, the details of the official schemas (before P4); the legal basis of deletion, deletion of a whole tenant, which way of remote authorization to do first (before server mode goes online) |
| Can be decided after development | Designs of later versions, or those that do not affect existing events | Table-level and field-level data permissions; when to implement the switch "accept only the user's own confirmation"; the details of automatic rulings by source level; the developer SDK; the safety of community schemas |

To find an entry point for taking part in the discussion, you can start from the last two groups in this list.

## Summary

- The code is split into packages by layer, and dependencies run only from the outside in; the kernel depends on no transport and no service layer, only on the two storage interfaces.
- Each kind of test corresponds to a specific class of mistake: both backends, replay comparison, export replay, counterexamples of the kernel invariants, the reference evaluator and the three groups of property tests, contract and renderer tests; evals check whether a real agent can understand it.
- The first version is implemented step by step, each step accepted by the evals that run through; the event format is frozen before the first external release; the experiment to do first is the durability of PGlite.
- The authoritative definitions of rules are in `03-data-model/`, the shape of events in `09-event-format.md`, and the external shape in `04-contract-types.md`; when changing the design, update things together by the checklist; undecided matters are recorded in one place only.
