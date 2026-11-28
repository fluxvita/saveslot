# Integration guide

English · [简体中文](../zh-CN/integration/README.md)

There are two ways to connect to saveslot. Choose by what you are connecting:

| You are connecting | Use | Section |
|---|---|---|
| An agent (a host that supports MCP, such as Claude Code or Codex) | MCP | [1. Connect through MCP](#1-connect-through-mcp) |
| A script, a program, or a connector (a program that copies data from another system on a schedule) | HTTP | [2. Connect a program or a connector](#2-connect-a-program-or-a-connector) |

Both reach the same saveslot service and the same data. Three later sections apply to both: [Credentials and permissions](#3-credentials-and-permissions), [Results and errors](#4-results-and-errors), [Data and upgrades](#5-data-and-upgrades).

## What 0.2.0 has and does not have yet

0.2.0 is the current public release (the first was 0.1.0), with both local mode and server mode. The full list is in [spec `07-scope-v1.md` §7](../spec/07-scope-v1.md#7-what-020-provides).

**It has:**

- Local mode: install, start, stop; MCP (the nine `saveslot_` tools) and HTTP on the local machine.
- Server mode: accounts and sign-in, OAuth authorization, remote MCP, HTTP over the network, self-hosting.
- Credentials: one for each agent and each program, issued with permissions and a slot scope, and revocable.
- Writing (including writes by external key, which connectors use), reading, history, viewing and resolving pending items.
- The log: export (optionally with a passphrase), `saveslot import` into an empty tenant (the way from local mode to a server), and `saveslot verify`.

**It does not have yet:**

- **Privacy deletion:** there is no delete command, MCP has no delete tool, and `POST /v1/deletions/preview` and `POST /v1/deletions` return `not_in_this_version`. The `saveslot.delete` permission can be issued, but no operation uses it yet. Data written by mistake can be **undone** (an ordinary write that keeps the history and can itself be reverted); making content disappear for good is not possible in 0.2.0.
- **Structure changes on a table that has been written to** (adding or removing a field, tightening a constraint, changing precision or unit): such a draft can be submitted and previewed, and then returns `not_in_this_version`: at submission when it would take effect by itself, at confirmation when it needs confirming (it is accepted as a pending item first). A table never written to can still be changed.
- **The recovery flow after restoring from a backup, in local mode:** server mode has it (`saveslot server restore --tenant <id>`); local mode does not have `saveslot start --restored` yet (see [Data and upgrades](#5-data-and-upgrades)).
- **Hosts that can register only by dynamic client registration** cannot connect to server mode: 0.2.0 identifies a client by a client ID metadata document only.
- Also not connected yet: the replay comparison (`saveslot verify --replay`; `POST /v1/log/reconcile` returns `not_in_this_version`) and changing a slot's policy (`PUT /v1/slots/{slot}/policy` returns it too). Read records are not pruned in 0.2.0; they only grow.

An operation or parameter this version does not have returns `not_in_this_version` (status 501).

Known limitations:

- Local mode supports macOS and Linux and needs Node 24.22.1 or later on the 24 line, or 26.12.1 or later.
- On Linux the package needs glibc: musl distributions such as Alpine are not supported yet.
- Local-mode data can be reached from that machine only; local mode and server mode do not synchronize.
- There is no graphical interface; people use the command line.
- The rest is in [guide chapter 11, section 7](../guide/11-deployment.md#7-what-the-first-version-does-not-do).

## 1. Connect through MCP


### 1.1 Install

```sh
npm install -g @fluxvita/saveslot
```

### 1.2 Connect with one command

```sh
saveslot setup
```

Follow the prompts: choose a template for the first slot, choose the hosts to connect, and confirm once. The host's tool list then shows a set of tools whose names start with `saveslot_`.

### 1.3 Or connect step by step

```sh
saveslot init
saveslot start
saveslot slot create ledger --template spending --timezone Asia/Shanghai
saveslot connect claude-code --name "MacBook · Claude Code"
```

`saveslot slot create` creates a slot and its tables from a bundled template; the `spending` template here creates `ledger.expenses`, one row per expense. `saveslot connect` prints the host's own add command. Paste it into the terminal, or add `--apply` to have saveslot run it.

To connect another agent, run the command again with another name:

```sh
saveslot connect codex --name "MacBook · Codex"
```

For hosts without an add command (Cursor, Claude Desktop), `saveslot connect cursor --name "MacBook · Cursor"` prints a configuration snippet to paste into the host's configuration.

### 1.4 Write one record and read it back

Say to the agent:

```
Lunch today was 45 yuan
```

The agent calls `saveslot_write`. The receipt is English text: its first line says that the marked parts are stored data, not instructions to the agent, and the next line starts with `Saved · `, meaning the write is saved. Then ask:

```
How much have I spent this month?
```

The agent calls `saveslot_query` or `saveslot_sql` and answers 45 yuan.

### 1.5 Verify

```sh
saveslot reads --connection "MacBook · Claude Code" --since 10m
```

Success check: the list has a read other than the self-check. If it does not, run `saveslot doctor`.

### 1.6 Stop and clean up

```sh
saveslot connections revoke "MacBook · Claude Code"
saveslot stop
```

Then remove the saveslot entry with the host's own remove command (for example `claude mcp remove saveslot --scope user`). If the entry stays, the host starts the saveslot service again the next time it starts.

### 1.7 Connect to server mode


```sh
saveslot login
saveslot connect claude-code --profile cloud --apply
```

`saveslot login` with nothing else signs in to the built-in `cloud` profile, which is the hosted service. For a server of your own, sign in with `saveslot login --server https://<domain> --profile <name>`, and use that profile name in place of `cloud` in the commands on this page.

The host opens the authorization page: the name is filled in, the page lists the permissions the host requested (read and write when it requested none), and read and write are preselected; authorize once. `saveslot.schema` can be ticked only when the host requested it. The page does not choose slots: a credential got this way reaches every slot, including those created later. For a credential limited to some slots, issue one with `saveslot connect http --profile cloud --name "<name>" --slots …` (see [Credentials and permissions](#3-credentials-and-permissions)). For a host that only has a web interface, enter the address `https://<domain>/mcp` in its interface; a host that can register only by dynamic client registration cannot connect in this version.

Sources: [guide chapter 11, sections 2 and 5](../guide/11-deployment.md#2-how-an-agent-connects); [spec `06-cli.md` §3](../spec/06-cli.md#3-the-getting-started-flow-local-from-zero-to-the-first-working-agent); [spec `05-surfaces.md` §1](../spec/05-surfaces.md#1-tools-and-the-operations-they-map-to).

## 2. Connect a program or a connector


### 2.1 Get a token

Install, then run `saveslot init`, `saveslot start` and create a slot as above. Then:

```sh
saveslot connect http --name "ledger sync script" --slots ledger
```

The command prints the token and the socket path. The token is shown only once; keep it in an environment variable:

```sh
export SAVESLOT_TOKEN=<token>
```

### 2.2 Call

In local mode, call through the socket. Paths start with `/v1`:

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  http://localhost/v1/slots
```

Success check: status code 200, and the result contains `ledger`.

In server mode, get the token with `saveslot connect http --profile cloud --name "ledger sync script"` (for a server of your own, the profile you signed in to it with, see [1.7](#17-connect-to-server-mode)), use `https://<domain>/v1` as the address, and drop `--unix-socket`. The name is required: without `--name` the command is refused.

### 2.3 Write

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: lunch-2026-11-10" \
  -d @write.json \
  http://localhost/v1/writes
```

`write.json`:

```json
{
  "sv": 1,
  "evidence": [{ "kind": "user_message", "text": "Lunch today was 45 yuan" }],
  "ops": [{
    "intent": "insert",
    "table": "expenses",
    "set": { "date": "2026-11-10", "category": "dining", "amount": { "value": "45", "unit": "CNY" } }
  }]
}
```

`sv` is the version of the slot's structure. A slot just created has `sv` 1; after that, send back the `sv` you last read.

### 2.4 Check the receipt

An excerpt; a real receipt has more fields, such as `derived` and `pending`:

```json
{
  "status": "saved",
  "sv": 1,
  "seq": 21,
  "ops": [{
    "target": { "table": "ledger.expenses", "row": "r_01JC8Z…" },
    "intent": "insert",
    "ver": "v21.0"
  }]
}
```

Success check: `status` is `saved`. Status code 200 is not enough: `pending` also returns 200 (see [Results and errors](#4-results-and-errors)).

### 2.5 Read

```sh
curl --unix-socket ~/.saveslot/run/saveslot.sock \
  -H "Authorization: Bearer $SAVESLOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "table": "expenses", "where": [{ "field": "date", "op": "=", "value": "2026-11-10" }] }' \
  http://localhost/v1/query
```

Success check: `rows` contains the row just written, with a `ver`. Send the `ver` back unchanged when you change that row.

### 2.6 Stop and clean up

```sh
saveslot connections revoke "ledger sync script"
saveslot stop
```

Revocation takes effect at once. Data already written stays.

Sources: [guide chapter 11, section 2](../guide/11-deployment.md#programs-without-an-agent-http); [spec `05-surfaces.md` §13–§14](../spec/05-surfaces.md#13-basic-conventions); request and receipt types in [spec `04-contract-types.md`](../spec/04-contract-types.md).

## 3. Credentials and permissions


Give every agent and every program its own credential (a connection), so that who read and who wrote can be told apart.

**Permissions** are chosen when the credential is issued and cannot be changed afterwards:

| Permission | Allows | Default from `setup` and `connect` | Default on the authorization page |
|---|---|---|---|
| `saveslot.read` | Every read operation | Required | Required |
| `saveslot.write` | Writing, and resolving items that concern writes | Given | Preselected |
| `saveslot.schema` | Creating slots, changing table structure | Given | Listed only when the host requested it; not preselected |
| `saveslot.delete` | Deleting (0.2.0 has no deletion yet, so this permission has no use for now) | Not given | Listed only when the host requested it; not preselected |

The authorization page lists what the host requested, and read and write when it requested none.

`--scope` adds to or removes from the default:

```sh
saveslot connect http --name "read-only report" --scope -write,-schema
saveslot connect claude-code --name "iMac · Claude Code" --scope -schema
```

The first is read-only: removing `write` alone is not enough, since the `schema` left can still create slots. The second lets the agent read and write but not create slots.

**Slot scope** is set with `--slots` and cannot be changed afterwards either. A slot outside the scope looks to that credential as if it did not exist. To change permissions or scope, revoke the credential and issue a new one under another name: the name of a revoked connection stays taken, so that in the history one name means one caller.

**Keeping the token:**

- The token is shown once; saveslot stores only its hash. If you lose it, revoke and issue again, under another name.
- A command pasted into the terminal goes into the shell history; while the host's add command runs, the token is in the process arguments; in the end it is stored in the host's configuration file. `saveslot setup` does not show the token on the terminal.
- Do not put a token in code, commit history or logs. The examples on this page use the placeholder `<token>` only.

**Revoking:**

```sh
saveslot connections list
saveslot connections revoke "ledger sync script"
```

Revocation takes effect at once. It only makes later requests with that credential fail; it deletes no data.

**What is logged:** saveslot records which version of which rows each credential read, not the values. `saveslot reads` shows the record, to the person's own session only.

Rules: [spec `04-contract.md` §12](../spec/04-contract.md#12-callers-credentials-and-scope); [guide chapter 11, section 4](../guide/11-deployment.md#4-credentials-connections-and-permissions).

## 4. Results and errors


**An accepted request is not the same as a change in effect.** Check `status` in the receipt after every write:

| `status` | Meaning | What to do |
|---|---|---|
| `saved` | The write is in effect | Continue |
| `pending` | The write is recorded but not in effect: it became a conflict candidate, or it waits for confirmation | Read `pending` in the receipt; a person (`saveslot pending`), an agent (`saveslot_resolve`) or a program (`POST /v1/pending/{id}/resolution`) resolves it |

**`ver`:** a read returns a `ver` for every row; send it back unchanged when you change that row. If the `ver` is out of date and someone else has changed the same field, the write is not an error: it becomes a candidate and `status` is `pending`.

**A rejected write** returns `{error}` with a status code, and nothing in the request takes effect:

| Status code | Common `code` | What to do |
|---|---|---|
| 400 | `invalid_argument` | Fix the request using `reason` and `param` |
| 401 | `unauthenticated` | The token is missing, invalid or revoked |
| 403 | `insufficient_scope` | The credential lacks the permission; issue a new one that has it. Two cases are not cured by another credential of the same kind: an endpoint only the person's own session may call (`/v1/export`, `/v1/reads`), and a slot-limited credential creating a slot (the person, or a credential that reaches all slots, creates it) |
| 404 | `unknown_table`, `not_found` | The name or ID does not exist, or is outside this credential's scope |
| 409 | `read_first` | Read once, then write |
| 410 | `handle_expired` | The cursor is over an hour old, or was issued before a restore or an import; run the query again from the first page |
| 413 | `too_large` | The request body is over 1 MiB, or the write carries more than a limit allows (`reason` says which); split the request |
| 422 | `validation_failed` | Fix each entry in `details` |
| 429, 503 | `rate_limited`, `unavailable` | Wait for `Retry-After`, then retry |
| 501 | `not_in_this_version` | This version does not have the operation or parameter yet (deletion, for example); see [What 0.2.0 has and does not have yet](#what-020-has-and-does-not-have-yet) |

**Retries:** a write with an `Idempotency-Key` header is safe to send again: the same key runs only once within 24 hours, and a repeat returns the original result with `replayed: true`. Without a key, the server derives a request key from the content, valid for 10 minutes only: the same request sent again within 10 minutes is not written twice, and after that it is a new write. The same key with different content returns `invalid_argument`. Rejected requests are not deduplicated, so a corrected request can reuse the key. A request made only of writes by external key gets no server request key: the external key is what makes it safe to repeat, at any time, and the same content sent again returns `unchanged`.

**Paging:** `limit` defaults to 20 (50 for the list of slots, `GET /v1/slots`) and is at most 200. When the result has `next_cursor`, pass it as `cursor` to get the next page. A cursor is valid for one hour; after that, or after a restore or an import, it returns `handle_expired` (410).

Rules: receipts in [spec `04-contract.md` §5.4](../spec/04-contract.md#54-judgement-and-the-receipt); `ver` in [§2](../spec/04-contract.md#2-version-tokens-ver-sv-item_ver); conflicts and pending items in [§6](../spec/04-contract.md#6-pending-items-kind--decision--effect--scope); errors in [§11](../spec/04-contract.md#11-domain-errors) and [§16](../spec/04-contract.md#16-outer-errors); idempotency in [§14](../spec/04-contract.md#14-idempotency); paging in [§13](../spec/04-contract.md#13-tasks-paging-and-accompanying-information).

## 5. Data and upgrades


**Where the data is:** in local mode, everything is under `~/.saveslot/`. `saveslot init --data-dir <path>` puts the data directory elsewhere. Do not put it in a synchronized folder such as iCloud Drive or Dropbox.

**Export:** an export is the whole log, one JSON object per line, readable without saveslot.

```sh
saveslot export -o saveslot-export.ndjson
saveslot export --encrypt -o saveslot-export.ndjson.age
```

Only the person's own session can export; a connection token cannot. The HTTP endpoint is `GET /v1/export`.

**Backup and recovery:** in local mode saveslot makes no backups itself; system-level backups cover the data directory. After a store is put back from a backup, a recovery flow has to run before it serves again. In 0.2.0 server mode has it (`saveslot server restore --tenant <id>`); local mode does not (`saveslot start --restored` is not in 0.2.0). The part of the flow that deletes again what had been deleted has nothing to do in 0.2.0, which has no deletion, so restoring a backup brings no deleted content back.

What 0.2.0 notices by itself is a store put back to an older copy, when the end of the log is below the highest operation number saveslot recorded outside the log. In local mode `saveslot start` then fails with the reason `log_behind_high_water`, and 0.2.0 has no command to go past it; in server mode that tenant is not served until `saveslot server restore --tenant <id>` has run. It does not notice when that record went back together with the data: in the default local layout both are under `~/.saveslot/`, so after a restore of the whole directory the service starts as if nothing had happened, and a `ver` or a cursor read before the restore is not known to be stale. The design is in [guide chapter 11, section 6](../guide/11-deployment.md#6-export-backup-and-restore); it says local mode recovers by itself, which 0.2.0 does not do.

**Upgrades:** a newer version reads data written by an older one. After a newer version has written the data, an older version refuses to open it. Data from development before 0.1.0 is outside this promise and needs a fresh `saveslot init`.

Sources: [guide chapter 11, section 6](../guide/11-deployment.md#6-export-backup-and-restore); [spec `06-cli.md` §4](../spec/06-cli.md#4-the-command-list). What saveslot guarantees and what it does not: [guide chapter 10](../guide/10-guarantees.md).

## Operating saveslot yourself

Resolving pending items and reading history are done by a person on the command line, which is a separate path (deletion is not in 0.2.0 yet): [guide chapter 11, section 3](../guide/11-deployment.md#3-how-people-use-it-the-command-line).
