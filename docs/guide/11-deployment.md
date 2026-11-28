# 11 · Deployment and integration

English · [简体中文](../zh-CN/guide/11-deployment.md)

This chapter answers the practical questions: where saveslot is installed, how an agent connects to it, how a person operates it, how credentials are managed, how data is taken away, and what to watch for after a backup is restored.

## 1. Two modes of operation

The first version has two modes of operation. Both are **single-node**: one user's data lives in one place only.

| | Local mode | Server mode |
|---|---|---|
| Where it is installed | The user's own computer | One server: the cloud service we operate, or one the user deploys |
| Who can connect | Only the agents and programs on this machine | Agents anywhere, over the network |
| Database | PGlite (embedded in the saveslot process, with the data in a directory on the local machine) | Native PostgreSQL, one separate database per user |
| Number of users | One | Several, isolated from each other |
| Suited to | Use on a single computer only; data that should not leave the machine | Sharing across several devices; connecting cloud agents; staying online all day |

Both modes run the same kernel and the same rules. No core capability exists in only one of them.

### An easily misunderstood point: a single node does not mean "local and cloud cannot be shared"

Once server mode is deployed, a coding agent on the local machine, an agent on another computer and an agent running in the cloud all connect to the same service and read and write the same data. This is how the first version lets several devices share data.

What the first version does not do is something else: **keeping the same data in two places, on the local machine and in the cloud, with the two sides synchronizing with each other.** This has two practical consequences:

- When connected to server mode, nothing works without a network connection.
- Local-mode data can be accessed only from the local machine. Local mode and server mode are two sets of data that are not connected, and the first version does not synchronize between them. To move from the local machine to a server, do a one-time export and then import it into an empty account on the server (section 6).

### How the cloud service differs from self-hosting

The two deployments of server mode use the same code and the same set of configuration items; the only difference is who the deployer is:

| Aspect | Our cloud service | Self-hosted by the user |
|---|---|---|
| People's accounts | Our account system | Built-in local accounts: created by the deployer with an operations command, with no open registration |
| Public address and certificate | Our domain | Provided by the deployer |
| Key custody | Us | The deployer |
| Rate limits and quotas | On | Off by default, configurable |
| Backup and restore | We do it | The deployer does it; after a restore the restore procedure must be run (see section 6) |
| Scale | Several groups of servers | One process and one database cluster are enough |

For what to prepare for self-hosting and how to initialize and create accounts, see chapter 13.

### Platform support

In the first version, local mode supports only macOS and Linux; Windows is later.

On Linux the `saveslot` package needs glibc. musl distributions such as Alpine (`node:alpine` images included) are not supported yet. For server mode in a container, use a Debian-based image, as `deploy/Dockerfile` does.

## 2. How an agent connects

An agent connects to saveslot through **MCP** (introduced in chapter 1: a general protocol by which an agent calls external tools, supported by agents such as Claude Code and Codex). Once connected, the agent's tool list gains a group of tools whose names begin with `saveslot_`.

### The 10 tools open in the first version

| Tool | Read / write | What it does |
| ----------------------- | ----- | -------------------------------------------------- |
| `saveslot_catalog`      | Read  | See which slots, tables, fields and units there are |
| `saveslot_query`        | Read  | Query data by condition, returning the `ver` of each row |
| `saveslot_sql`          | Read  | Read-only SQL, for joins and aggregation |
| `saveslot_history`      | Read  | See how something came to be the way it is now, or how it looked at some past moment |
| `saveslot_sources`      | Read  | List, search and read source data; the impact preview before a deletion is here too (its `deletion_preview` mode) |
| `saveslot_pending`      | Read  | List pending items, and see the details of one |
| `saveslot_write`        | Write | Write: add, change, correct, revoke |
| `saveslot_resolve`      | Write | Resolve one pending item |
| `saveslot_schema_draft` | Write | Submit a schema draft: create a slot, change an existing slot's schema (which changes take effect in 0.2.0: chapter 9) |
| `saveslot_delete`       | Write | Execute a deletion that has been previewed (not provided yet in 0.2.0) |

The complete design has two more tools related to "re-extraction"; they come later, together with that feature.

What an agent receives after calling a tool is a piece of text. What it looks like has three examples earlier: the write receipt in the first step of chapter 2, the receipt for "becoming a candidate" in the third step, and the query result in chapter 6, section 3.

A few design considerations that integrators should know:

- **Designed for the weakest agent.** It depends only on the most basic capability: "call a tool, get text back". If the agent's host does not support confirmation pop-ups or structured results, the flow still works.
- **The tool list is trimmed by permission.** A connection with read permission only has no write tools in its tool list at all. The six read tools are always there, because every connection has read permission. When a connection sees only some of the slots, the tool list does not change, and slots outside its range do not appear in any result or error (section 4).
- **Flags always appear in the text.** Flags such as "disputed" and "has a change awaiting confirmation" are structured fields in the contract; when rendered as text, none of them is left out. Some hosts hand only text to the model, so they cannot be placed only in the structured result.
- **IDs and version marks are always given in full.** The model must pass them back unchanged, so they are not abbreviated in the text.
- **Text read back is wrapped in an untrusted boundary.** See chapter 10, section 6.
- **Results have a length budget.** The text of one tool result is at most 100,000 characters. Results that can be paged (query rows, the item list, history) are cut at the budget, and the cut point is the start of the next page, so no row is lost; a result that cannot be paged and exceeds the budget produces an error with a hint on how to narrow it, and is not silently cut in half.
- **Calling a feature that the first version has not implemented** always gets the error `not_in_this_version`, stating which parameter or operation it is.
- **Management operations are not in MCP.** Issuing credentials, reading the audit, log verification and replay comparison, export and import are for people only, through the command line or HTTP.

### Once connected, how the agent knows when to use saveslot

Having the tools connected does not mean the agent will use them at the right time: when the user says "I ran 5 km today", the agent has to know this should be recorded; when the user asks "how much did I run this month", it has to know to look it up first. MCP itself guarantees only that the agent "can" read and write (chapter 10, section 2). saveslot gives it hints in three places, none of which needs the user to do anything:

| Where | Who sees it | What it says |
|---|---|---|
| The service-level description (called `instructions` in MCP) | The model; obtained when the host connects to saveslot | What saveslot is; when the user asks about their own records, look them up before answering; when the user states a new fact that belongs in some table, or points out that something was recorded wrong, write it, and do not write when asked a question, supposing or chatting; when a receipt says "pending confirmation", tell the user first; finally, it lists this user's slot names and how many tables each slot has |
| The description of each tool | The model | When this tool is to be used, and when to use another instead |
| Shortcuts (called prompts in MCP) | People: the host usually shows them as slash commands, for example the menu in Claude Code shows `/saveslot:overview`, and typed directly it is `/mcp__saveslot__overview` | Three: see what there is (`overview`), handle the pending items one by one (`pending`), start recording a new kind of thing (`track`) |

A few points to know:

- **Generated per credential.** For a read-only connection, the description has no "when to write" and says "this connection is read-only" instead; slots outside the range are not listed; a connection without the schema-change permission does not see `track`.
- **Only slot names and table counts are listed, not table names.** The agent looks up table names with `saveslot_catalog` (for why, see chapter 10, section 6). No separate notification is sent when a new slot is created; `saveslot_catalog` is the reference.
- **It says only "in what situations to use it".** It does not contain unconditional requirements such as "call it first in every conversation", and it states when not to use it. If written too broadly, the agent will record an offhand remark; if too narrowly, things that should be recorded will be missed. How much there is on each side is measured by evals (chapter 12, eval 11).
- **Some hosts do not hand the service-level description to the model, or do not support shortcuts.** Then only the tool descriptions remain; the flow still works, but the agent may use saveslot on its own initiative less often. For more reliability, you can put a suggested piece of text into the host's own instruction file (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex): `saveslot snippet <host>` prints the text and where to put it. This step is optional and you do it yourself; saveslot does not write these files, for the same reason as "not editing the host's configuration files" in section 5.
- **In the first version these texts are in English.** They are written for the model to read, and the model still answers you in your language.

### Connecting in local mode

The local saveslot service does not listen on a network port; it listens only on a socket file on the local machine (a unix socket), whose file permissions allow access only to the current system user. The benefit is that other users cannot connect, people on the network cannot connect, and web pages in a browser cannot reach it.

An agent's host generally does not connect to a socket file directly, so saveslot provides a small forwarding program, `saveslot mcp`: the host starts it as an ordinary MCP server, and it forwards the messages to the local saveslot service.

```
Claude Code ──starts──▶ saveslot mcp ──socket──▶ saveslot service ──▶ data directory
Codex       ──starts──▶ saveslot mcp ──socket──▶   (the same process)
```

Each of the two agents starts its own `saveslot mcp`, but behind them is the same saveslot service process and the same data. If the saveslot service is not running, `saveslot mcp` starts it first.

### Connecting in server mode

The agent's host uses remote MCP directly, with an address of the form `https://<domain>/mcp`. Authorization uses OAuth: the host opens the authorization page, the user confirms on the page the name and permissions of this connection, and clicks "Authorize" once, and this agent becomes a connection.

Every item on the authorization page has a default: the name is the name the host reports for itself, and the permissions are read + write; if nothing is changed, one click is all it takes. A connection authorized this way can see all slots (including ones created later). To get a credential that touches only some slots (for a connector, say), issue a static token on the command line with `saveslot connect http --profile <name> --slots …`. One authorization is one connection; afterwards `saveslot connections list` on the command line shows it, and renaming and revoking work as usual.

The command to add it on the host's side is likewise printed by `saveslot connect <host> --profile cloud` (for self-hosting, use its profile instead). This command contains no token, because the host obtains the credential itself through OAuth, so with `--apply` saveslot runs it on your behalf. Only hosts that have just a web interface (Claude on the web, ChatGPT and the like) have no command to run, and the address has to be entered by hand in their interface: saveslot cannot remove this step.

### Programs without an agent: HTTP

Scripts and programs you write yourself can call the HTTP interface directly; the paths begin with `/v1`, and the requests and receipts are the JSON defined in the contract. HTTP and MCP implement the same contract and can do basically the same things; the differences are mainly that HTTP does no text rendering, does not cut results by length, and opens the management operations.

One kind of caller deserves its own mention: the **connector**, a program that periodically moves the data of an external system (a wristband, a bookkeeping app) into saveslot. It is not part of saveslot; it is written by the project or by developers on their own. saveslot does not schedule it and does not keep the external system's authorization token for it. It writes over HTTP as a connection and is treated the same as any other integrator. saveslot prepares only three general capabilities for it: a credential can be limited to the one slot it is responsible for (section 4); a table can declare an external key, so that syncing the same record repeatedly does not add it again (chapter 9); and recognition of resent batched writes. The credential is obtained like this:

```
$ saveslot connect http --name "Wristband · Connector" --slots health
```

A collection program on a phone or another device can work only with server mode: local mode is for local access only, and other devices cannot connect. A script or connector that cannot go through OAuth and connects to server mode uses `saveslot connect http --profile cloud` to have a static token issued from the user session, likewise limited by permission and slot range and revocable.

One thing to note when writing scripts: a write returning success does not mean "in effect". The `status` in the receipt may be `saved` (saved), or `pending` (recorded but not in effect, for example because it became a conflict candidate). A script must look at this field.

Specification: [`../spec/05-surfaces.md`](../spec/05-surfaces.md) (`instructions` and the tool descriptions are in section 9, prompts in 10.1, remote authorization in section 15); for credentials and the slot range, see [`../spec/04-contract.md`](../spec/04-contract.md) section 12.

## 3. How people use it: the command line

The first version has no app with a graphical interface. Everything a person needs to do goes through the **command-line tool** `saveslot`, or is left to an agent.

What people do with the command line:

| What to do | Command |
|---|---|
| Get started with one command: initialize, start, create the first slot, attach the agents installed on this machine | `saveslot setup` |
| Step by step: initialize, start and stop the local service, check its status | `saveslot init`, `saveslot start`, `saveslot stop`, `saveslot status` |
| Check item by item (service, permissions, synced folders, entries in each host, data scale) | `saveslot doctor` |
| Create a slot | `saveslot slot create`; or let an agent draft it through `saveslot_schema_draft` and create it once you agree (a connection issued by default can do this) |
| Issue, view and revoke credentials for agents | `saveslot connect`, `saveslot connections list / revoke` |
| Print the text suggested for the host's custom instructions | `saveslot snippet` |
| Handle pending items | `saveslot pending`, `saveslot pending show`, `saveslot pending resolve` |
| Delete and cancel (not provided yet in 0.2.0) | `saveslot delete`, `saveslot delete cancel` |
| Query data, see history | `saveslot query`, `saveslot history`, `saveslot sql`, `saveslot sources` |
| See who read what | `saveslot reads` |
| Verify, replay comparison (the replay comparison is not provided yet in 0.2.0) | `saveslot verify`, `saveslot verify --replay` |
| Export (optionally encrypted with a passphrase), import into an empty account | `saveslot export`, `saveslot import` |

Three design points are worth knowing:

- **The command line does no business writes.** There is no `saveslot write`. A write needs a sentence turned into an intent, rows, values and evidence, and that is the agent's job. A person who wants to change data tells the agent, and that sentence is the evidence.
- **The command line does not touch the data directory directly.** Apart from the one-time initialization, all commands go through the saveslot service. This way the single writer and the recording of reads cannot be bypassed.
- **What is bound at confirmation is the very version the person just saw.** When handling an item, the command line first shows the details, then executes with the item version obtained at display time; for a deletion, it uses the handle of the preview just shown, and confirming requires typing the full word `delete`; pressing `y` is not accepted (deletion is not provided yet in 0.2.0; see the table above).

Specification: [`../spec/06-cli.md`](../spec/06-cli.md).

## 4. Credentials, connections and permissions

### Two kinds of credential

| Credential | Who holds it | What it can do |
|---|---|---|
| **User session** | A person | Everything, including issuing and revoking connections, reading the audit, and exporting |
| **Connection** | An agent, a script or a connector | What the permissions given at issuance allow, within the slot range given at issuance |

Every integration of every agent has its own connection, named by the user; the suggested form is "device · agent", for example "MacBook · Claude Code". This name appears in history, in the initiator of items and in the read audit. A and B in chapter 2 are two connections.

Giving each agent its own credential is the precondition for being able to say "who did it": if two agents share one credential, their reads and writes can no longer be told apart.

### Four permissions

Permissions are chosen when a connection is issued, and come in four kinds by action; the specification calls them scopes:

| Permission | Allows | Default |
|---|---|---|
| `saveslot.read` | All read operations, including the deletion preview | Every connection must have it |
| `saveslot.write` | Writing; handling items related to writing | Given |
| `saveslot.schema` | Submitting schema drafts; handling schema-change items | Given when issued on the command line; on the OAuth consent page it is not ticked in advance, the user ticks it |
| `saveslot.delete` | Executing deletions; cancelling a deletion (not provided yet in 0.2.0) | Not given, must be asked for explicitly |

When issuing on the command line, adjust with `--scope`. There are two forms, which cannot be mixed:

- Add to or remove from the default (read + write + create slots): `--scope +delete`, `--scope -schema`, `--scope -write`. To keep an agent from creating slots, use `--scope -schema`; a read-only connection is `--scope -write,-schema`. The scope is fixed at issuance: for a connection issued earlier to gain the ability to create slots, run `connect` again.
- List in full: `--scope read,write,schema`, where what is listed is everything.

Removing the read permission is a usage error: a connection without read permission can do nothing, and cannot even read before writing.

### Which slots can be seen

At issuance you can also limit which slots this connection can see. **Authorization = permissions × slot range**: the same set of permissions applies equally to every slot in the range.

```
$ saveslot connect http --name "Wristband · Connector" --slots health
```

- **Not limiting means all slots, including ones created later.** When limited to a list, slots created by someone else afterwards are not included.
- **A slot outside the range is, to the connection, exactly the same as one that does not exist.** It is not in the catalog; referring to it by name reports "no such slot / no such table", the same error as for one that really does not exist; and its name does not appear in hints or candidates either. This way the connection cannot even tell that "there are other slots".
- **A connection with a limited range cannot create slots.** The slot it creates would not be in its own list, so it would not even see it itself. Create the slot yourself first, then issue a credential limited to it.
- **For "A can write, B can only read", issue two connections.**
- The first version can limit down to the slot; showing only some table or field to some agent is for later versions.

The typical use is for connectors: a connector should touch only the slot it is responsible for. The connections issued by `saveslot setup` all have the range of all slots; to limit the range, issue one separately with `saveslot connect --slots`.

Limits to be aware of:

- **Neither the permissions nor the slot range can be changed after issuance.** To change them, revoke and issue again.
- **The token is shown only once.** saveslot stores only its hash. If it is lost, revoke and issue again.
- **Revocation takes effect immediately.** When a token has leaked, this is how to take the permissions back. Revocation only makes the requests that this credential makes afterwards be refused; it deletes nothing: the data it wrote is still there, still recorded under its name, and the name is shown followed by "revoked"; items it initiated that are not yet handled (conflicts, items awaiting confirmation and so on) stay as they are, to be handled by the user or by another connection with permission. After revocation its name is **still occupied**, and no connection with the same name can be issued: in history one name refers to only one principal.

### What only a user session can do

Issuing, renaming and revoking connections; removing an empty slot; viewing the read audit; log verification and replay comparison; export; import.

The reasons are straightforward: an agent that can issue credentials can give itself any permissions; the audit's subjects are precisely the agents, and the party being audited should not be able to read the whole audit; export takes all the data away at once, which is the user's right and not the agent's; import decides what is in this account and whose credentials are still valid.

### A boundary on the local machine

In local mode, the user session's credential is a file in the user's home directory. An agent with shell access (one that can run commands in a terminal) can read it, and can also run `saveslot` commands directly, in which case everything it does is recorded under the user's name and cannot be told apart from a real person's actions. saveslot cannot guard against this kind of program.

If you want an agent with a shell to leave its own trace too, give it a connection token and have it run the command-line tool with that token.

## 5. Getting started (local mode)

### One command

From zero to the first agent being able to use it, once installed, takes just one command:

```
$ npm install -g @fluxvita/saveslot
$ saveslot setup
[1/5] Created ~/.saveslot (0700)
[2/5] The saveslot service has started in the background · pid 4211
[3/5] Which template for the first slot? (space to select, enter to confirm; you may select none)
      [ ] running   running log → slot health
      [x] spending  daily spending → slot ledger
      [ ] budget    budget → slot plan
      Created slot ledger · schema v1 · 2 tables (expenses, monthly_total)
[4/5] Which hosts to attach?
      [x] Claude Code (claude 2.x, /usr/local/bin/claude)
      [x] Codex (codex 0.x, /opt/homebrew/bin/codex)
      [ ] Cursor (no add command; the configuration must be pasted by hand: saveslot connect cursor)
[5/5] A connection will be issued for each host (scope saveslot.read saveslot.write saveslot.schema), and these will be run:
        claude mcp add saveslot --scope user -e SAVESLOT_TOKEN=<token> -- /usr/local/bin/saveslot mcp
        codex mcp add saveslot --env SAVESLOT_TOKEN=<token> -- /usr/local/bin/saveslot mcp
      Run the 2 commands above? [Y/n]
      Claude Code: issued MacBook · Claude Code · self-check passed · attached
      Codex: issued MacBook · Codex · self-check passed · attached
Done. In Claude Code, type /mcp__saveslot__overview (shown in the slash menu as /saveslot:overview); in any host you can also ask "what is in saveslot".
```

All you have to do is make choices and agree once: which template, which hosts, each with a default; then answer once about "the commands that will be run on the host's side". This is a design requirement for integration, and every integration method added later is checked against it: every manual step in connecting filters out some people, and none of these steps needs a person's judgement; the only things a person has to judge are "whether to connect, and with how much permission". What you agree to is a list spelled out word for word, which is also a benefit for security.

A few points to know:

- **Agree first, issue afterwards.** If you refuse at step 5, nothing is issued and no host is touched. The token is not shown in the terminal and does not enter the shell history.
- **One connection per host**, with the default name "hostname · host name". Several hosts are not made to share one connection; otherwise "who read, who wrote" could not be told apart.
- **It can be run repeatedly.** Each step checks the state before deciding whether to act: if already initialized, it is skipped; if a slot already exists, the template is not asked again; if the host already has a saveslot entry, no connection is issued again. So a second run only fills in the steps that were not finished and attaches newly installed hosts.
- **It only orchestrates existing commands**, and does nothing more: what it calls are the commands of the step-by-step procedure below. It does not install start-at-boot (the host starts the service automatically when it starts), and only suggests `saveslot service install` at the end.
- **In a non-interactive environment** (a script, for example), without `--yes` nothing is executed; with `--yes`, any choice not specified in the arguments is treated as "do not": without `--template` no slot is created, and without `--host` no host is attached. When no one is watching, doing less is safer than doing more.
- **The connections it issues can see all slots.** To limit the range, or to give different hosts different permissions, attach them separately with `saveslot connect`.

### Why not edit the host's configuration file directly

saveslot only runs the add commands that the host itself provides (`claude mcp add`, `codex mcp add`), never edits files such as `~/.claude.json` or `~/.codex/config.toml` directly, and never writes into `CLAUDE.md` or `AGENTS.md`. There are four reasons:

1. **The format and location belong to the host, and they change.** The host's own commands follow the host; if saveslot wrote the files itself, it would have to chase every change of every host.
2. **Those files hold more than saveslot.** They contain your other MCP servers, other keys and settings. If saveslot got it wrong (rewriting concurrently while the host is running, losing comments, writing half a file), what breaks is something unrelated to it, and it would be hard for you to know who did it. Instruction files are more sensitive still: they are text you wrote by hand that directly decides how the model works.
3. **What you agree to can be shown word for word.** What is shown to you is the command that will be run, which is written in the host's documentation and which you can type yourself; "will modify a certain part of a certain file" cannot be made equally definite.
4. **Undoing is symmetric.** Using the host's remove command undoes it completely, leaving no trace.

The cost is that hosts without an add command (Cursor, the Claude desktop app) can only have the configuration pasted by hand, which is a known exception to the design requirement above.

### Step by step

What `setup` calls is the commands below, and evals and scripts keep using them; to see each step clearly, you can also do them one by one yourself:

```
install → saveslot init → saveslot start → create a slot → saveslot connect → paste the printed command into the terminal (or add --apply) → ask the agent a question → verify with saveslot reads
```

**① Install.** The first version is released as one npm package, `@fluxvita/saveslot`, containing the command-line tool and the saveslot service (`npm install -g @fluxvita/saveslot`). npm is the package manager of the JavaScript ecosystem, and installing this package requires the Node runtime to be on the computer already. No separate database needs to be installed. On Linux, when Node is installed in a system directory, a global install by an ordinary user fails for lack of write permission; in that case set an install directory of the user's own for npm (06-cli section 3, "Prerequisites for installation").

Standalone executables and a desktop installer (which would not require the user to install Node first) await the result of a packaging experiment, and the first version does not guarantee them.

**② Initialize.** `saveslot init` creates a `~/.saveslot/` directory under the user's home directory:

| Subdirectory | What it holds |
|---|---|
| `data/` | The data directory: all of this user's data. The first event of the log is already written at initialization |
| `control/` | The control plane, which is several files: credential hashes, the tenant directory, registry storage (the deletion register, the high-water mark of the highest number, the restore count, and the "restore in progress" and "import in progress" marks), and the handle signing key |
| `credentials/` | The user session's token, readable only by the current system user |

The configuration file `config.toml` is not generated by `init`: without it every item takes its default. To change something, use `saveslot config set <item> <value>`, which takes only the items this version uses (in 0.2.0: `read_log.flush_seconds`, `mcp.autostart`, `upgrade.backup`); use `saveslot config get` to see the value of each item now and where it comes from. Numeric values such as the interval at which read records are flushed to disk are here (for example `read_log.flush_seconds`). If there is a mistake in the file, the service does not start, and says which item it is.

Do not put the data directory in a synced folder such as iCloud Drive or Dropbox: the sync software changes files without saveslot knowing; saveslot warns when it detects this.

**③ Start.** `saveslot start` starts the service in the background. It can also be set to start at boot.

**④ Create the first slot.** A slot needs a schema. The command-line tool comes with a few ready-made templates (running log, budget, daily spending), and choosing one is enough to create the slot:

```
$ saveslot slot create ledger --template spending --timezone Asia/Shanghai
```

The ledger in this guide was created with this template. When creating the slot, saveslot also writes this slot's default policy (chapter 9).

You can also have an agent draft a schema file and create the slot from it, or give an agent the `saveslot.schema` permission so that it creates the slot directly.

**⑤ Issue a credential and attach the agent.**

```
$ saveslot connect claude-code --name "MacBook · Claude Code"
```

This command does three things: it issues a connection; it runs one self-check with the new token, confirming that the slots can be read; and it prints one add command of the host's own. Paste the printed command into the terminal and run it, and the agent side is configured; or run this command again with `--apply`, and saveslot runs that host command on your behalf. Neither way edits the host's configuration file directly. When the self-check does not pass, the connection just issued is revoked immediately and the token is not shown. When `--apply` fails to run the host command, the connection is kept and the command is printed as usual for you to run yourself.

The token is shown only this once, and it will stay in several places: the command pasted into the terminal entered the shell history; while the host command runs, it is in the process arguments, visible to other users of the machine with `ps`; and finally it lives in the host's configuration file. When only the local socket file is used, this does no harm with respect to other system users (they cannot connect). `setup` does not show the token on the terminal, and it does not enter the shell history.

`connect` can also take `--scope` (section 4) and `--slots` (to limit the slot range). To attach another agent, run it once more with a different name. At the end it prints a line, "Optional: saveslot snippet <host>" (section 2).

**⑥ Verify.** Ask the agent "which slots are in saveslot", and then:

```
$ saveslot reads --connection "MacBook · Claude Code" --since 10m
```

Seeing one read record other than the self-check shows that the agent really did connect through this connection. Typing `/mcp__saveslot__overview` in Claude Code works the same way: it makes the agent read the catalog, producing one such read.

When something goes wrong, run `saveslot doctor` first. It checks item by item: the service is running, the permissions of the socket and credential files, the data directory is not in a synced folder, the single-writer lock, version consistency, the start-at-login job (the programs it runs are still there, and the Node it uses is a supported version), and the saveslot entries in each host (using the host's own view command, without reading its configuration file). The design has one more item, "whether any deletion is overdue for physical erasure"; 0.2.0 has no privacy deletion yet and does not list it. Each item's result is "pass / fail / warning". The following give only a warning and do not count as a failure: the system clock being more than 5 minutes behind the end of the log; a host's saveslot entry not showing the path of this saveslot (the host may write it another way; the warning gives the command to remove that entry); the agent in a host not having read anything through saveslot yet (if you have asked it to record something and nothing was recorded, the host has most likely not allowed it to use saveslot's tools, and the warning says how to allow them; it also appears for a host just connected and not yet used, and goes away after the first use); and the **data scale**, which lists the tables whose row count exceeds the comfort line or the measured line, along with the total number of events, the size of the data directory and the time of the most recent opening of the data, compared against the measured range (chapter 10, section 5, "About data volume and log size").

**Getting started in server mode**: `saveslot setup --profile <name>` follows the same line, with the steps changed to: if not logged in, `saveslot login` first (add `--device` when there is no browser over SSH); if there is no slot, create one from a template; for the selected hosts, run the add command in its remote form. There is no token on this path: the host obtains the credential itself through OAuth, and the one "Authorize" on the authorization page is that one agreement (section 2), so no permissions are selected here. Only Claude Code and Codex can be attached automatically; for the other hosts use `saveslot connect <host> --profile <name>`. When the host already has a `saveslot` entry (the local one, say), it is not overwritten, and setup gives the command to remove it. It does not switch the profile currently in use, and at the end it suggests `saveslot profile use <name>`. For self-hosting, you also need to initialize on the server first with `saveslot server init` and create an account with `saveslot server user add`.

Specification: [`../spec/06-cli.md`](../spec/06-cli.md) section 3.

## 6. Export, backup and restore

### Export: taking your data with you

What `saveslot export` exports is **this user's entire log**. It is not a database file and not a snapshot of the tables.

The shape of the file is simple: one JSON object per line. The first line is a manifest (which tenant, the version of the event format, up to which event number the export goes, how many events in all); after that, each line is one event, containing the event header and its content blocks. Each content block is in one of three states: present (the content plus a checksum), removed (only which tombstone removed it is recorded), or pending deletion (a placeholder). The complete definition of the format is in the event format specification, and it can be understood without depending on saveslot's code: by checking the hash chain of the event headers line by line and checking each block's checksum, you can verify that the export is complete.

Because the log is the single source of truth, with this export, replaying from the beginning on any backend gives the same tables. This is the technical meaning of "the data is the user's and can be taken away".

Three details:

- **Read records are not in the export.** They are not part of the log.
- **Content pending deletion within the grace period is by default not exported.** A placeholder takes its place. Otherwise what the user has just asked to delete would remain in the export file. When it is really needed it can be explicitly requested to be included, and the command line asks once more for confirmation.
- **Only a user session can export.**

The promise that "an export can really be replayed" is checked by tests: export, replay into an empty database, compare row by row with the original tables, done crosswise for the two database backends (chapter 12).

### Protecting an export file with a passphrase

As soon as an export file leaves saveslot, it has no protection of any kind: it may be put on a cloud drive, copied to an external disk, carried along with a backup, or forwarded. So a passphrase can be added at export:

```
$ saveslot export --encrypt -o saveslot-2026-11.ndjson.age
The passphrase is not stored; if you forget it, this export cannot be opened.
Enter passphrase:
Enter it again:
Exported 1284 events, ending at seq 1311, without content pending deletion; encrypted with a passphrase (age v1)
To resume next time use --after-seq 1311; to decrypt: age -d -o export.ndjson saveslot-2026-11.ndjson.age
```

- **It uses a public format.** The encryption is age, a public file encryption format; any age tool can decrypt, and saveslot is not needed. No format is invented: the project is open source, a private format hides nothing, and only adds a file that nobody else recognizes. The format of the export file itself does not change; encryption only wraps one more layer around it.
- **How the passphrase is given.** By default it is read from the terminal, without echo, entered twice. Scripts use `--passphrase-file` (the file permissions must be 0600); a password manager hands it over through shell process substitution: `--passphrase-file <(pass show saveslot)`. There is no way to write the passphrase directly in the command-line arguments, and environment variables are not read either: arguments enter the shell history and are visible to other users with `ps` while the command runs.
- **saveslot does not store the passphrase; if you forget it, it cannot be opened.** A warning is given once if it is shorter than 12 characters.
- **What it protects against, and what it does not.** It protects against someone else getting the export file after it leaves this machine. It does not protect against programs on this machine with the same permissions as you at the moment of export (they can read the data directory anyway), and it cannot help with a passphrase that is too weak or forgotten. It is not storage encryption: saveslot's storage itself does no application-layer encryption (chapter 10, section 5).
- **Only on the command line.** The HTTP export endpoint does not encrypt: passing the passphrase in the request would be handing it to a server that can see the plaintext anyway. Someone calling HTTP directly just pipes the response into any age tool.

### Import: loading into an empty account

`saveslot import` loads an export into an **empty tenant**: one whose log has only the first event written at initialization and no data at all. The typical use is moving from local mode to server mode:

```
stop writing at the source → saveslot export → saveslot import at the target → reattach each agent at the target → retire the source
```

- **Loaded unchanged, not executed again.** Import appends the events of the export one by one, unchanged, and hands them to `apply` to replay; what results is the same log, and `verify` still matches the original chain. The writes are not executed again one by one: that would judge again and assign numbers and IDs again, and the result would not be the same log.
- **As a whole it either completes or the target is still empty.** If it is interrupted or crashes midway, retrying is safe. During the import this tenant cannot be read or written.
- **All the original credentials are retired.** The users and still-valid connections from before the import are all deactivated (revoked ones stay revoked); history still shows their names, marked "deactivated" or "revoked"; every integration has to be issued again at the target. At the end of the import a hint says to reattach with `saveslot connect`.
- **An export with a passphrase is decrypted on the local machine by the command line and then uploaded** (the passphrase is given as for export); the server does not accept a passphrase.
- **Before confirmation it shows** the original tenant, the number of events, the moment of the export, and "deletions made at the original place after this export are not in it". At the end it lists how many principals were deactivated, how many deletions within the grace period were executed immediately, and what cannot be brought over: read records, credentials, external files (chapter 10, section 5, "About import").
- **Old version marks still work in part.** When a `ver` that the agent read before the import is passed back, the part at or before the export point is judged for conflicts by its own number, and the part after it is handled conservatively (the rule is the same as for restore below).

Import is possible only into an empty tenant, and cannot be merged with existing data: merging would have to answer how the numbers of two logs interleave, what to do with slots of the same name, and how to combine the deletion registers of the two sides; that is a multi-node problem and is left for later.

### Backup

Backup and export are two different things: export is the way for a user to take data away, while backup is an operational measure against data loss, and what is backed up is the database itself.

- Server mode: for the cloud service we do it; for self-hosting the deployer does it.
- Local mode: saveslot does no backup itself. The data directory is picked up by system-level backups such as Time Machine.

### Why you must go through the restore procedure after a restore

Restoring from a backup amounts to winding the database back to some moment in the past. For saveslot this raises two problems.

**Problem one: deletions come back to life.** On Monday the user confirms the deletion of a sentence, and on Tuesday it is physically erased when the grace period ends. On Wednesday the database breaks and is restored from last Sunday's backup. In last Sunday's data that sentence is still there, and the log has no record of Monday's deletion either.

The solution is the **deletion register**: at each deletion confirmation, besides recording an event in the tenant's log, an entry is also made in the control plane (stored separately from the tenant data), recording only which positions were deleted, not the content. After a restore, saveslot first deletes again what this register says should be deleted, and only then serves outside requests. How the register and the log are kept consistent and how they are reconciled at every crash timing is in chapter 8, section 9.

**Problem two: numbers get reused, and old version marks get misrecognized.** After the backup, #501 through #600 were written, and after the restore the log goes only up to #500. If numbering continues from #501, the new #501 and the original #501 are two different things with the same number; an agent still holding a `ver` read before the restore would be mistaken for having the current version.

There are two solutions:

- After a restore, a "restore" event is appended, and subsequent numbers continue after the highest number recorded in the control plane; the gap left is explained by this event. The highest number is advanced only every so often (not recorded at every write), so a small number of numbers between two advances may still be reused once; the next point exists precisely to catch this case.
- The control plane records how many times this tenant has been restored, and this count is built into `ver`, item versions and handles. This is the number after the decimal point in `v21.0`. Item versions and handles obtained before the restore are all refused. A `ver` obtained before the restore falls into two kinds: when it points to a position at or before the restore point, that stretch of the log is identical in both timelines, so conflicts are judged by its own number; when it points to a position after the restore point, that stretch may already be lost and the same number may be a different write, so it is treated as having read the restore point and judged conservatively. After two or more restores, an old `ver` from before one restore is always handled in the latter way.

So a restore is not "just swap the database back"; the restore procedure must be run:

| Mode | How it is triggered |
|---|---|
| Server mode | The operations command `saveslot server restore --tenant <tenant>` (or `--user <account name>`) |
| Local mode | `saveslot start --restored` (not provided yet in 0.2.0; see the end of this subsection) |

What the restore procedure does, in order: set a "restore in progress" mark in the control plane and add one to the restore count; open the tenant; append a "restore" event; re-apply deletions according to the deletion register; carry out the physical erasures that have already come due; check; clear the mark; serve outside requests.

**It does not matter if the restore procedure is interrupted midway.** The "restore in progress" mark is cleared only after everything is done. After that, every startup looks at it first: if the mark is still there, the procedure is completed first and then outside requests are served, whether or not this startup carried the restore argument. Every step gives the same result when done again. Before the re-applied deletions are finished, the deleted content can be read, so no outside service is given during this time.

If the database was swapped directly without going through the procedure, saveslot has two fallbacks:

- On opening, finding that the number at the end of the log is lower than the highest number recorded in the control plane shows that it has been wound back.
- Comparing the deletion register with the log and finding a combination that cannot occur in normal operation (for example, the register says a deletion is pending, but the log has no trace of it at all).

After detection, in server mode it refuses to serve outside requests and prompts to go through the restore procedure; in local mode it goes through the restore procedure automatically (local mode has only one user and no operator, so refusing service would be pointless). The fallbacks cannot detect every case: when the rollback is very small and there were no deletions in the period, it cannot be seen. So a restore should always be triggered explicitly.

> How it is in 0.2.0: local mode has no restore procedure yet, and `saveslot start` does not accept `--restored`; on opening, finding the "restore in progress" mark, or the number at the end of the log below the highest number, it stops and does not serve, nor does it go through the restore procedure automatically. The highest number is advanced only when the tenant is closed, so the first fallback sees only a log wound back to before where it ended at the last close. The second fallback (comparing the deletion register) comes with privacy deletion. In server mode, a log found behind makes the requests to this tenant be answered `internal`, and the answer does not mention `saveslot server restore`.

### Cases the restore procedure cannot cover

For the deletion register to work, it must not have been wound back together with the data.

- **In local mode's default layout, the data directory and the control plane are both in `~/.saveslot/`.** A system-level backup usually restores the two together, and the register goes back into the past too. In that case saveslot cannot re-apply the deletions and cannot detect it. Re-applying deletions works only when the data directory is placed elsewhere and only the data directory is restored. The way to place it elsewhere is to specify it at initialization: `saveslot init --data-dir <path>`.
- **In server mode, if the control plane's database and the tenant's database are restored together**, this likewise cannot be detected.
- **In a very narrow window, a cancellation may be lost.** If the process crashes after the transaction that cancels a deletion has committed but before the register has been changed to "cancelled", and the restore then happens to be to a backup from before the cancellation: that cancellation is lost and the deletion is carried out as usual. This is the same kind of loss as "any write after the backup is lost with the restore", and its direction is deleting too much.

Chapter 10 lists these together with the other "things not guaranteed".

### Upgrading the saveslot version

**From 0.1.0 on, upgrading saveslot does not make existing data unopenable**: a new version can open data written by any earlier release, with no need for you to export and then import first; configuration files and credentials already issued keep working too. This is about data, not interfaces: before 1.0, commands and interfaces may change incompatibly between minor versions, and the release notes will say so.

The first time data is opened after installing a new version, saveslot checks the storage format version: if it is lower than the program knows, it upgrades it to the current format automatically; if it is higher than the program knows (written with a newer version and then switched back to an older program), it refuses to open and prompts to upgrade, and does not risk writing. (There is only one format version so far. The in-place upgrade mechanism is there from 0.2.0, but it has no step yet: the version that first changes the format ships with that step. Development-period data from before 0.1.0 is not covered by the commitment and needs to be initialized again.) The log itself needs no conversion: the new version's kernel must be able to replay events of all older formats, which is what "only add, never change" means for the event format.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §8 "Format versions, export, import and restore"; [`../spec/03-data-model/03-deletion.md`](../spec/03-data-model/03-deletion.md) "After deletion"; for the commands of export encryption and import see [`../spec/06-cli.md`](../spec/06-cli.md) 4.8; for the rules of import see [`../spec/04-contract.md`](../spec/04-contract.md) section 17.

## 7. What the first version does not do

Related to deployment and integration:

| Not done | The first version's substitute |
|---|---|
| Storing one copy locally and one in the cloud and synchronizing them; multi-device sync; offline writes | For several devices to share, all connect to the same server-mode saveslot |
| Merge import (loading an export into an account that already has data), continuous sync between local and server | Import only into an empty tenant: a one-time move from one place to another (section 6) |
| An app with a graphical interface | The command line, or leave it to an agent |
| A developer SDK (embedding saveslot in someone else's agent) | There is only one form, the saveslot service |
| Table-level and field-level data permissions | Four action permissions × slot range |
| Slots shared by several people | One tenant is one user |
| Encryption | saveslot does no application-layer encryption; the cloud service's storage is encrypted at the infrastructure layer, and the operator can read it; for self-hosting and local mode it is determined by disk encryption. Deletion relies on physical erasure. An export file can be encrypted with a passphrase (section 6) |
| Confirmation pop-ups (MCP elicitation) | The agent obtains the user's agreement in the conversation before calling |
| Deleting a whole account or a whole slot | Privacy deletion one item at a time; in local mode, delete the data directory and the configuration directory (chapter 8, section 8) |
| Connectors (programs that periodically sync external systems) | Not part of saveslot; the first version provides the credential range, external keys and resend recognition that they need (section 2) |
| Windows support for local mode | macOS, Linux |
| saveslot calling a model itself | Understanding and extraction are both done by the user's agent |

0.2.0 provides both modes; what it provides and what it does not yet, see [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md), section 7.

For the complete scope see [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md); for later plans see [`../spec/01-positioning.md`](../spec/01-positioning.md) "Later plans (not in the first version)".
