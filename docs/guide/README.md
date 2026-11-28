# saveslot · Guide

English · [简体中文](../zh-CN/guide/README.md)

> For people meeting saveslot for the first time: users, developers on the integrator side, and people who want to contribute.
> Reading straight through, you should be able to say what problem saveslot solves, how data flows inside it, and why each mechanism is designed the way it is.

> Every chapter has a Chinese edition ([`docs/zh-CN/guide/`](../zh-CN/guide/README.md)), aligned in meaning with this one; a difference between them is a defect, to be reported as an issue.

> **The guide describes the complete design.** The current version, 0.2.0, does not provide two parts of it yet: privacy deletion (preview, confirmation, cancellation within 24 hours, physical erasure when it comes due, re-applying deletions after a backup is restored), and schema migrations that need to rebuild a physical table. The chapters that discuss them (mainly chapter 2, step 4; chapter 8; chapter 9, section 5; and the parts of chapters 10 and 11 that concern deletion) are marked at the beginning. What 0.2.0 provides is in section 7 of [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md).

## How the guide and the specification divide the work

saveslot's documents come in two sets, written differently and used for different purposes.

| | The guide (this directory) | The specification ([`../spec/`](../spec/README.md)) |
|---|---|---|
| What it answers | Why it is designed this way, and what the simplest case looks like | The complete definition of every rule, including all the edge cases |
| How to read it | Straight through from the beginning | Look things up as needed |
| Who uses it | People learning about saveslot for the first time | People implementing the kernel, writing integrators, and reviewing the design |

The guide explains each mechanism only to the point where you can understand it, and points edge cases to specific sections of the specification. **Where the two differ, the specification holds.**

## Chapters

| Chapter | Contents |
|---|---|
| [01 What saveslot is](01-what-is-saveslot.md) | The problem it solves, the situations it fits, how it differs from a database and from memory, why not use what already exists, the division of work between the agent and saveslot, where it runs |
| [02 One example from start to finish](02-walkthrough.md) | A ledger: record an expense, a correction, a conflict between two agents, deletion. At each step, the calls, the log, the tables, and the receipt the agent actually receives |
| [03 Core concepts](03-concepts.md) | Tenants, slots, tables; two layers of data; the log, operation numbers and `apply`; event headers and content blocks; provenance; time; pending items |
| [04 Architecture](04-architecture.md) | How the kernel, the service layer, the operation contract and the surface are divided; the kernel invariants K1–K14; modules and dependencies, the two ways of using the judgement module, how background jobs come in; how one write and one read each go; the real shape of an event; how the process runs; the two interfaces, tenant storage and registry storage |
| [05 Writes and conflicts](05-write-and-conflict.md) | The whole course of a write; the four intents; the version mark `ver`, syncing by external key; conflict units, superseding and refreshing of conflict items, rule versions; evidence and fields, no-ops and corroboration, literal match; the premises of a write; the order of judgement and the receipt; idempotency; revert |
| [06 Reads and impact queries](06-read-and-impact.md) | The catalog, simple queries, read-only SQL, history, source data; what a read result carries; the read record; finding out who read the old value after a value changes; premises that have changed compared with impact queries |
| [07 Time](07-time.md) | The one set of rules shared by everything that "changes over time" (the budget is only an example): two timelines; three kinds of table; entities and valid intervals of state tables; defaults for writing state; high-impact writes; one timeline per field, and stop points; periods with no value; correction and restating; keys (including keys written similarly); reading by time; two agents writing at the same time |
| [08 Deletion](08-deletion.md) | Three kinds of deletion request; the definition of privacy deletion, two deviations and two principles; from preview to physical erasure (including rows that take a deleted value as a premise, and source data that no longer supports any data); what remains after a deletion, and what cannot be reached; how the deletion register stays consistent with the log, and what to do on import; how to check that it is right |
| [09 Schema evolution](09-schema.md) | The schema document, units and precision, naming rules, aliases, field groups; commit and compile, and which changes take effect automatically; versions are immutable; three kinds of change, and when a table has never been written; the migration process; extraction jobs (the key points); derivation rules and override columns; the official schema |
| [10 Guarantees and boundaries](10-guarantees.md) | Self-consistency does not depend on the agent, truthfulness does; three consequences of "confirmation"; the trust boundary; the goal of integrity; what is explicitly not guaranteed (including what import cannot carry over, data volume and log size, and who can see the data); prompt injection |
| [11 Deployment and integration](11-deployment.md) | Local mode and server mode; the agent via MCP (and how it knows when to use saveslot), programs and connectors via HTTP, people via the command line; credentials, permissions and slot scope; getting started with one command and step by step; export and passphrase encryption, import into an empty account, backup and the restore procedure, upgrading |
| [12 Contributing](12-contributing.md) | Where things stand now, and what to do first; how the code is split into packages, and the direction of dependencies; what each kind of test guards against, and what the evals are; what the implementation rests on, the implementation order and experiments; how to read the specification, and what to update together when changing the design (including the checks when changing tool descriptions and `instructions`); undecided items |
| [13 Self-hosting](13-self-hosting.md) | Running server mode on your own server: PostgreSQL and the privileges of the database role, configuration, initialization and local accounts, how agents connect, backup and restore |

## Suggested reading order

- **Only want to know what it is**: read 01.
- **Want to understand the design**: 01 → 02 → 03. 02 is one complete example, and 03 explains the concepts that appear in the example one by one; when you reach something abstract in 03, go back to 02 and find the corresponding step. After that, 05–09 each cover one block of mechanisms, and you can pick among them by interest; 07 has the most new concepts, and its opening says which sections to read first.
- **Want to know whether you can use it with confidence**: read 10 (what is guaranteed, what is not).
- **Need to install it and connect an agent**: read 11; to deploy on your own server, read 13 as well.
- **Want to take part in the implementation**: after 01–03, first read the first half of 05 and of 08 (each up to section 4), then 04 (architecture) and 12 (code organization, tests, implementation order), then move on to the specification, entering from the table of contents in [`../spec/README.md`](../spec/README.md). The invariant table and the event shapes in 04 use concepts from 05 and 08, so it reads more smoothly after them.

## The example used throughout

The whole guide uses the same ledger. A few conventions:

- **Numbers.** `#27` or "event #27" means the 27th event in the log; "write #25" means the write whose write number is 25 (in the log it is events #25–#28). At the end of 02 there is an overview table that lists, from #1 to #57, what every event of this ledger is and when it was recorded; the three budget writes used in chapters 7 and 8 (#49, #52, #55) are also there.
- **The time of the main line.** The expense happened on 2026-11-10; the budget table was added on November 11, and of the three budget writes, the first two were recorded on the 11th, and the last was said on November 12.
- **Where the premise changes, it says so.** To explain a rule, a few subsections start from a simpler state (for example "suppose write #55 does not exist yet"). Every place that does this states "a different premise" or "suppose".

## Where the specification is

| What you want to look up | Where to go |
|---|---|
| Positioning, product forms, deployment forms | [`../spec/01-positioning.md`](../spec/01-positioning.md) |
| Kernel invariants, modules, runtime, storage, the test matrix | [`../spec/02-architecture.md`](../spec/02-architecture.md) |
| The authoritative definition of the data mechanisms (including field types, units and precision) | [`../spec/03-data-model/`](../spec/03-data-model/README.md) |
| The rules of each operation | [`../spec/04-contract.md`](../spec/04-contract.md) |
| The type definitions and examples of each operation's parameters, results and errors | [`../spec/04-contract-types.md`](../spec/04-contract-types.md) |
| MCP, HTTP, CLI | [`../spec/05-surfaces.md`](../spec/05-surfaces.md), [`../spec/06-cli.md`](../spec/06-cli.md) |
| What the first version does, what it does not do, and in what order | [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md) |
| Things not yet decided | [`../spec/08-open-questions.md`](../spec/08-open-questions.md) |
| The field-level definition of every kind of event in the log, the format of the export file, what is left after a deletion | [`../spec/09-event-format.md`](../spec/09-event-format.md) |
| Evaluation tasks | [`../spec/10-evals.md`](../spec/10-evals.md) |
| Why a given rule was set this way | [`../process/decisions/`](../zh-CN/process/decisions/) (Chinese) (decision drafts), [`../process/walkthroughs/`](../zh-CN/process/walkthroughs/) (Chinese) (scenario walkthroughs) |
| The research and trade-offs behind each technical choice | [`../research/`](../zh-CN/research/) (Chinese) |
