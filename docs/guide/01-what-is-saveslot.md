# 01 · What saveslot is

English · [简体中文](../zh-CN/guide/01-what-is-saveslot.md)

## In one sentence

saveslot is a data layer for agents. It tracks things that change over time and keeps, for each of them, the full timeline from the original evidence to the current state. The data belongs to the user and is not tied to any model vendor or agent product.

## The problem it solves

A person today uses several agents at once: a coding agent on the computer, an assistant on the phone, automations that run in the cloud. Much of what they tell these agents updates the same long-lived things: how much was spent this month, how far a training plan has got, where a project stands now.

Three things make this hard:

1. **It is scattered.** Each agent keeps its own notes, and with a new agent the user explains everything again.
2. **It changes, and it gets changed wrongly.** The user corrects and adds; two agents may change the same place at the same time. With only the current value stored, nobody can say how it came to be that value.
3. **Nobody can say on what grounds.** A number is there: did the user say it, did an agent infer it, was it imported from a file? When it is wrong there is nothing to trace, and when the user wants a sentence forgotten, nobody knows which data it affected.

saveslot keeps this data in one place, shared by all of the user's agents, and answers three questions for every value: **what it is now, how it got there, and on what grounds at every step.**

## What data belongs here

Data that meets all three conditions is a case for saveslot:

1. **It has a stable identity.** It is one particular thing: this project, my running log, this set of accounts. It is not a stray sentence.
2. **It changes or accumulates.** Values are revised, records are added, a state moves forward.
3. **Something later depends on it.** A later session or another agent needs its current state or its history.

Examples: every expense and the monthly budget, every run and the weekly distance, a project's milestones and status, the user's preferences, a decision with its reasons.

Counter-examples: a passing chat, a temporary draft, an intermediate result that only matters in the current conversation. These do not need saveslot.

## How it differs from a database and from memory

saveslot is not another database, and not another memory. The difference is that **time is first-class**.

| | What it stores | After a value is changed | Asked "why is it this value" |
|---|---|---|---|
| Database | The present state | The old value is overwritten, unless the application keeps a history of its own | Does not know, unless the application records it |
| Memory | What was said | Old and new statements sit side by side; which one counts is left to retrieval and the model | Can find the words, but has no structured value |
| saveslot | The timeline of a thing | The new value takes effect; the old one stays in the history and can be read at any time | Every field records the piece of original evidence it came from |

Take one expense. A database tells you "54 yuan". Memory tells you "the user said lunch was 45 yuan, and later said 54". saveslot tells you "it is 54 yuan now; it was first 45 (from this sentence) and was then corrected to 54 (from that sentence); the monthly total went from 45 to 54 because of it; these tasks read 45 before the correction".

This is also why saveslot can do a few things that are hard to do elsewhere:

- **After a correction, it knows who was affected.** saveslot records who read which version, so when a value is corrected it can find the tasks that read the old one.
- **Delete a sentence, and it is really gone.** Every value records its sources, so when the user asks for a sentence to be forgotten, the values derived from it are dealt with too. (0.1.0 does not provide this yet; see the end of "Agents interpret, saveslot enforces" below.)
- **The data can be taken away whole.** An export is the full timeline; replayed on another backend it yields the same state. It can also be imported into another saveslot that holds no data yet (chapter 11).

## Agents interpret, saveslot enforces

saveslot's core path does not call a model. The work is divided between it and the agent:

| Task | Who does it |
|---|---|
| Understand what the user said, and whether to record it | Agent |
| Find the row to change | Agent (query first, then write) |
| Turn the words into structured values, with units | Agent |
| Judge whether this is "it was recorded wrongly" or "things have changed" | Agent |
| Excerpt the words that serve as evidence | Agent |
| Check types, units, ranges and versions | saveslot |
| Record every write, and the source of every value | saveslot |
| Detect concurrent changes and handle them by fixed rules | saveslot |
| Keep the history, read as of a moment, recompute derived data (numbers computed from other values, such as a monthly total) | saveslot |

The reason for this division: the agent is already running a model and knows best what the user means at this moment, so interpreting falls to it naturally. A layer that answers for the data cannot rest its guarantees on a model's output, so saveslot only does deterministic checking, recording and execution.

One boundary follows from this and should be known in advance: **saveslot does not judge whether what is written is true.** When an agent says "the user said lunch was 54 yuan", saveslot records exactly that and keeps the evidence for later inspection. Whether the data is true, and whether a confirmation really had the user's consent, is the responsibility of the agent that calls it. saveslot guarantees three things: every write leaves a trace; for any operation that needs confirmation, what is executed is the content that was confirmed; a deletion can be cancelled within 24 hours. Chapter 2 shows the last two. (Of these, deletion is not provided in 0.1.0 yet: privacy deletion comes in a following version; see section 7 of [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md).)

## Products built on saveslot

saveslot is a foundation, not the backend of one product. Products for end users are built on top of it.

Take a few familiar kinds of product: an expense tracker, a workout log like Strava, a project tracker like Linear. If they were built so that an agent does the recording and the looking up, they would face the same problems at the data level: values get corrected, their origin must be known, several agents write at once, the user must be able to delete, and to take the data away. saveslot provides these common parts; the product brings the domain knowledge (what counts as an expense, how the weekly distance is computed) and the user experience.

Domain knowledge is handed to saveslot as a **schema**: which tables there are, the type and unit of each field, and the rules by which derived data is computed. A schema can be the user's own, or one provided by the project or the community. A group of related tables, together with the original evidence written into them, is called a **slot** (expenses and running are a slot each); which agent is granted access, and which version the schema is at, are both decided per slot (chapter 3).

### Connectors: bringing in data from other systems

Moving data in from other systems on a schedule is also the job of the layer above. Data such as the meal records in a fitness band's app, or bank statements, is moved into saveslot on a schedule by a program called a **connector**. A connector is written by the project or by a developer for one source system, and is not part of saveslot: saveslot does not schedule it, does not retry for it, and does not keep the token it uses to sign in to that external system. To saveslot it is, like any other client, a **connection** (one registered attachment of an agent or a program to saveslot, with a credential of its own) that writes over HTTP. What saveslot gives it is only the general ability to write: a credential can be limited to certain slots (chapter 11), and a record can be synchronized again and again by its identifier in the source system without being added twice (chapter 5). A collector on a phone cannot reach a saveslot in local mode (local mode serves that computer only); it works only with server mode.

## Two product forms

The part of saveslot that does the checking, recording and execution is called the **kernel**. The same kernel is offered in two ways.

| | The saveslot service | Developer SDK |
|---|---|---|
| For whom | Users: one person's data layer, shared by all the agents they use | Agent developers: embedded in their own agent, to maintain data for it over time |
| How it is reached | HTTP, MCP, command line | An in-process library interface |
| When | The first version | Later versions |

**MCP** in the table is a general protocol by which agents call external tools; agents such as Claude Code and Codex support it. Once connected, saveslot's operations appear on the agent's side as a few tools it can call. When later chapters say "the agent calls `write`", this is the path it takes.

The first version provides only the saveslot service. The architecture requires, however, that an SDK can be built later without changing the kernel.

## Where it runs

The first version has two modes: **local mode** (the saveslot service runs on the user's own computer and serves only the agents on that machine) and **server mode** (it runs on a server, which may be the cloud service we operate or the same code deployed by the user, and agents anywhere can connect to it remotely).

Two points are easily misunderstood:

- **Both modes are "single node": one user's data is in one place only.** This does not stop several agents from sharing it: as long as they connect to the same saveslot in server mode, a coding agent on the computer and an agent in the cloud read and write the same data. What the first version does not do is keep the same data on the computer and in the cloud at once with the two synchronizing, nor the offline writes that would follow from it.
- **An agent does not need to know what technology saveslot uses inside, and the user does not need to install a database.** saveslot is a service process of its own with the database inside it: local mode uses an embedded PostgreSQL (PGlite, a library embedded in saveslot's service process), and server mode uses native PostgreSQL. The agent only connects to this process over MCP or HTTP.

How to install it, how agents connect, how credentials are managed and how data is taken away are in [chapter 11](11-deployment.md); deploying server mode yourself is in [chapter 13](13-self-hosting.md); the specification is "Deployment forms and synchronization" in [`../spec/01-positioning.md`](../spec/01-positioning.md).

## Why not use what already exists

This section is for readers who know the field; it can be skipped on a first read. Each of the problems above has mature solutions of its own, so why build another? The four kinds below are the closest, and the conclusion for each is "borrow the idea, do not use it as a component".

**Event stores for event sourcing** (EventStoreDB / KurrentDB, Kafka and the like). saveslot's kernel is itself event-sourced: one append-only log, with the tables computed from it. An existing event store was not used because of complete deletion. In these systems events are immutable: deletion is either a whole stream marked as deleted and really removed only when a background process compacts it (for a while the data "cannot be read but is still there", and every replica compacts separately), or encrypting the content and destroying the key. Kafka's deletion markers also expire, so a replica that was offline too long writes the old data back when it returns. saveslot needs deletion that is exact to a field and to a sentence, a log whose chain is unbroken afterwards, and deletion markers that never expire. So it builds the log itself on PostgreSQL and splits every event into a header that is never deleted and content that can be (chapter 3).

**CRDTs** (Automerge, cr-sqlite and the like, which let several replicas change data separately and merge automatically). A CRDT picks a winner per field automatically and does not stop to wait for a person (in some implementations the losing value can still be read afterwards, but the system has already chosen for you). The conflicts saveslot cares about are exactly the ones that must not be resolved silently: whose evidence is more reliable, whether this is a correction or a change in circumstances, whether the user should confirm. These are questions of meaning. saveslot makes a conflict a durable state that can be read, and waits for a person to decide (chapter 2, step three). Besides, a CRDT must keep the full history of changes in order to merge, which is in direct conflict with complete deletion.

**Temporal tables built into databases, and bitemporal databases** (temporal tables in the SQL standard, XTDB, Datomic). They answer "what was the value at a given moment", and saveslot's model of time borrows from them. They were not used directly because PostgreSQL, which saveslot chose, still has no built-in system-versioned tables, and the syntax for changing the value over a span of time has not reached a released version either, so this logic has to be written in any case. XTDB is the closest, but it is a separate engine on another technology stack, without schemas and constraints. Datomic has only one time axis, the recorded time. More importantly, they deal only with time, not with which sentence each value came from, and so have no deletion that cascades along sources.

**Knowledge-graph memory for agents** (Graphiti and the like). In its ideas this is the closest to saveslot: it also keeps the original fragments, its facts also carry a validity period, and it also separates the time something happened from the time it was recorded. The difference is who enforces the rules: its ingestion, deduplication and the judgement of whether two facts contradict each other all rely on a model; it has no derived data such as aggregates, and no governance of auditing and deletion. saveslot leaves what needs interpreting to the agent, and its own side is deterministic rules throughout: the same input always gives the same result.

The research behind these comparisons is under [`../zh-CN/research/`](../zh-CN/research/) (Chinese) in the repository: one document each on temporal data, synchronization, and logs and deletion.

## Next

The next chapter ties these together with one set of accounts: recording an expense, correcting it, two agents changing it at once, deleting a sentence. At each step it shows what the agent called, what saveslot recorded, and what the tables became.
