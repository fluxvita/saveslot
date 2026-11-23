# @fluxvita/saveslot-connector-ts

[中文](README.zh-CN.md)

The TypeScript SDK for writing saveslot **connectors**.

A connector is a program that writes into the user's saveslot as a connection, on their behalf: typically it collects one kind of record from an external system (a mailbox, a fitness service, a bank export) and stores it in a **slot**, where every agent the user works with can read it, with its full history.

With this SDK you write only the business side: how to reach the external system, and how one of its records maps to a row. The SDK does everything that touches saveslot: it creates the slot you declare, checks its tables and fields are there, writes your records in batches with idempotency keys, retries when the service is busy, and sets the request headers.

This is the TypeScript side only. SDKs for other platforms and languages are developed in a separate repository; they talk to the same service in the same way.

## Install

Not published to npm yet: it will be, through CI, once the release process is set up. Until then, use it from this repository (a workspace dependency, or a path to `packages/connector-ts`). Once it is published:

```bash
npm install @fluxvita/saveslot-connector-ts
```

Node.js 24 or later.

## What you need from the service

Today the service runs locally (`saveslot start`), and its HTTP surface listens on a **unix socket** only: `~/.saveslot/run/saveslot.sock`. Server mode (a hosted or self-hosted service over HTTPS, with OAuth) comes later.

- **A credential.** Issue one for your connector:

  ```bash
  saveslot connect http --name "Mail · connector"
  ```

  The default scopes include `saveslot.schema`, which `init` needs to create the slot. In this version a credential sees every slot: `--slots` is refused until server mode (P5). Once the slot exists, you can issue a credential without the schema scope with `--scope -schema`.

- **A way to reach the socket.** Node's `fetch` cannot connect to a unix socket, so give the SDK one that can with `setFetch`, and any `http://` base URL:

  ```ts
  import { request } from "node:http";

  /** A `fetch` that sends every request to the service listening on `socketPath`. */
  export function socketFetch(socketPath: string): typeof fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // A Buffer, not a string: Node writes the head together with a first string chunk in that
      // chunk's encoding, which would turn header values already UTF-8 into UTF-8 twice.
      const body =
        init.body === undefined || init.body === null ? undefined : Buffer.from(String(init.body));
      return await new Promise<Response>((resolve, reject) => {
        const req = request(
          {
            socketPath,
            method: init.method ?? "GET",
            path: url.pathname + url.search,
            headers: Object.fromEntries(new Headers(init.headers)),
            ...(init.signal ? { signal: init.signal } : {}),
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("error", reject);
            res.on("end", () => {
              const headers = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
              }
              const status = res.statusCode ?? 0;
              const empty = status === 204 || status === 304;
              resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    }) as typeof fetch;
  }
  ```

  The SDK's own tests reach the real service with this same function.

## Develop a connector in four steps

The example syncs a mailbox into a slot `mail`, one row per message.

### 1. Describe the connector

```ts
import { type ConnectorManifest, ConnectorPlatform } from "@fluxvita/saveslot-connector-ts";

const manifest: ConnectorManifest = {
  id: "com.example.mail",
  name: "Mail",
  description: "Messages received in a mailbox.",
  logo: "https://example.com/mail.png",
  version: "1.0.0",
  publisher: "Example",
  platforms: [ConnectorPlatform.Cloud],
};
```

| Field | Required | |
|---|---|---|
| `id` | Yes | Unique identifier, e.g. `com.example.mail`. Also the task of its writes, shown in the slot's history |
| `name` | Yes | Display name |
| `description` | Yes | What the connector collects |
| `logo` | Yes | The logo's URL, or a `data:` URI |
| `version` | Yes | Version, e.g. `1.0.0` |
| `publisher` | Yes | Who publishes it |
| `platforms` | Yes | Where it runs: one or more, none twice, from `ConnectorPlatform`: `Cloud` (`cloud`: a server, script or cloud function), `IOS`, `Android`, `Flutter`, `ReactNative`. Only `cloud` works today; a connector on a device needs server mode |
| `packages` | Device platforms | The package address (package name or app-store address) of each platform listed except `cloud` |
| `homepage` | No | Homepage or documentation |

### 2. Declare the slot and the tables

Implement `ConnectorProvider`. The SDK hands you a `SchemaBuilder`; add the slot and its tables and return it.

```ts
import type { ConnectorProvider, SchemaBuilder } from "@fluxvita/saveslot-connector-ts";

class MailProvider implements ConnectorProvider {
  defineSchema(schema: SchemaBuilder): SchemaBuilder {
    return schema.addSlot("mail", "Asia/Shanghai").addTable({
      name: "messages",
      description: "One message received",
      time: { type: "event", field: "received_at" },
      fields: [
        { name: "message_id", type: "text", required: true, description: "The Message-ID header" },
        { name: "received_at", type: "zoned_datetime", required: true, description: "When it arrived" },
        { name: "sender", type: "text", description: "The sender's address" },
        { name: "subject", type: "text", description: "The subject line" },
      ],
    });
  }
}
```

| Table | Required | |
|---|---|---|
| `name` | Yes | Letters, digits and underscores, starting with a letter, at most 63 characters; unique in the slot regardless of case |
| `description` | Yes | What one row is |
| `time` | Yes | `{ type: "event", field }`: each row is one thing that happened at `field` (a required `date` or `zoned_datetime`); `{ type: "state", granularity }`: entities whose values change over time; `{ type: "none" }`: no time |
| `fields` | Yes | The fields |
| `entityKey` | State tables | An entity's natural key (required fields) |
| `duplicateKeys` | No | Sets of fields that mark a suspected duplicate: an item for the user, not a refusal |
| `together` | No | Fields that conflict as one unit |

| Field | Required | |
|---|---|---|
| `name` | Yes | As for table names |
| `type` | Yes | `text`, `integer`, `decimal`, `boolean`, `enum`, `date`, `zoned_datetime`, `quantity`, `ref` |
| `description` | Yes | What the field holds |
| `required` | No | Whether every row must have it |
| `unit` | `quantity` | From the unit vocabulary, e.g. `km`, `min`, `CNY` |
| `values` | `enum` | The allowed values |
| `min` / `max` | No | The range |
| `ref` | `ref` | The table pointed at in the same slot: `{ table, target: "row" \| "entity" }` |

Source keys (`external_key`, which make a repeated sync update rows instead of adding them) and aliases come with a later version of the service, which refuses them today; this version of the SDK leaves them out. See [Current limits](#current-limits).

### 3. Map your records

Extend `SlotRecord`: say which table the record goes into and what its fields are.

```ts
import { SlotRecord } from "@fluxvita/saveslot-connector-ts";

interface FetchedMessage {
  messageId: string;
  /** RFC 9557 text, e.g. "2026-11-18T09:00:00+08:00[Asia/Shanghai]". */
  receivedAt: string;
  from: string;
  subject: string;
}

class MailMessage extends SlotRecord {
  readonly #m: FetchedMessage;
  constructor(m: FetchedMessage) {
    super();
    this.#m = m;
  }
  table() {
    return "messages";
  }
  fields() {
    return {
      message_id: this.#m.messageId,
      received_at: this.#m.receivedAt,
      sender: this.#m.from,
      subject: this.#m.subject,
    };
  }
}
```

Values are written as the operation contract writes them: text for `text` and `enum`, `"5 km"` for a `quantity`, RFC 3339 / RFC 9557 text for times.

### 4. Set up the SDK and write

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectorClient } from "@fluxvita/saveslot-connector-ts";

// Once, in the entry file: build() makes the one instance of the process.
const sdk = ConnectorClient.builder()
  .setManifest(manifest)
  .setCredential(process.env.SAVESLOT_CREDENTIAL!)
  .setBaseUrl("http://saveslot.local")
  .setFetch(socketFetch(join(homedir(), ".saveslot/run/saveslot.sock")))
  .setProvider(new MailProvider())
  .build();

// Creates the slot with its tables if it does not exist, and checks its tables and fields are there.
await sdk.init();

// Your business code: the unfinished run's id, or a new one when the last run succeeded,
const runId: string = await currentRunId();
// and the messages of this run, fixed when the run starts (IMAP, Gmail API, …).
// A retry of the run sends these same messages, in the same order, under the same runId.
const messages: FetchedMessage[] = await loadRun(runId);

// Name the run: if it fails halfway and is retried with the same key, nothing is written twice.
const result = await sdk.write(
  messages.map((m) => new MailMessage(m)),
  { key: `mail-${runId}` },
);
console.log(result); // { records, created, replayed, pending }
```

Every record is a new row. Until source keys arrive, a connector keeps its own cursor (the last message it wrote) and writes each record once.

A key names one set of records. A retry with the same key must send the same records in the same order: fix the window of a run when it starts (say, the messages after the cursor, at most 1,000) and keep it, and its `runId`, until the run succeeds; only then move the cursor and start a new run with a new `runId`. Taking "new mail since last time" again on the retry gives other records under the same key: the parts already applied are replayed, then the service refuses the first part that differs, and `write` rejects with `key_reused`, whose `written` says what had been applied.

Other files do not pass `sdk` around; `ConnectorClient.with()` gives them the same instance:

```ts
// sync-job.ts
import { ConnectorClient } from "@fluxvita/saveslot-connector-ts";

export async function syncInbox(runId: string) {
  const messages = await loadRun(runId); // the same messages on every try of this run
  return ConnectorClient.with().write(messages.map((m) => new MailMessage(m)), { key: runId });
}
```

Keep the mailbox's own credentials in your secret store, never in the slot.

## API

### `ConnectorClient.builder()`

| Setter | |
|---|---|
| `setManifest(manifest)` | Required. |
| `setCredential(credential)` | Required. Sent only in `Authorization`; never in an error message. `build()` refuses one with characters a token cannot have (white space, a line break). |
| `setBaseUrl(url)` | Required. With the local service, any `http://` URL together with `setFetch`. |
| `setProvider(provider)` | Required. Your `ConnectorProvider`. |
| `setHeaders(headers)` | Extra headers on every request, e.g. tracing. They cannot replace the SDK's own. |
| `setFetch(fetch)` | The transport; the global `fetch` by default. |
| `setTimeout(ms)` | Request timeout: a whole number above 0 (30 000). |
| `setRetries(n)` | Tries after no answer, 429 or 503: 0 to `MAX_RETRIES` (10); 4 by default. |

`build()` checks the settings and throws `invalid_config`, naming the setting in `details.field`. It makes the one instance of the process and returns it; building again throws `already_built`.

### `ConnectorClient.with()` and `ConnectorClient.reset()`

- `with()`: the instance `build()` made, from any file. Throws `not_built` before `build()`.
- `reset()`: forgets the instance, so it can be built again with other settings; also for tests.

### `init()`

1. Calls `defineSchema`.
2. Reads the slot; this also checks the service accepts the credential.
3. If the slot does not exist, creates it with all its tables in one schema draft.
4. Checks each declared table is there with its declared fields; if not, rejects with `schema_mismatch` listing what is missing, and changes nothing. It compares table and field names only, not field types or whether a field is required: a field of another type in an existing slot shows at `write`, as the service's refusal.

This version cannot change a slot that exists (add a table or a field): the service refuses that until a later version. Declare what the slot has, or write to a new slot.

Every other method rejects with `not_initialized` until `init` has succeeded.

### `write(records, { key?, task? })`

Groups the records by table and writes them as inserts, at most 100 to a write. `key` names the call: the same call sent again with the same key within 24 hours is applied once, and its records come back in `replayed` instead of `created`. Each write sends `<key>.<table>.<n>` as its idempotency key, at most 256 characters; every key, the task and every record are checked before anything is sent, so keep `key` short (a UUID, or a run name).

A retry with the same `key` must send the same records in the same order (see the example above). Other records under a key already used reject with `key_reused`. Any error after sending has started carries `written`, with the same fields as the result: what the call had applied before the error.

| Result | |
|---|---|
| `records` | Records given |
| `created` | Records in writes applied by this call |
| `replayed` | Records in writes the service had already applied under the same key: not written again |
| `pending` | Items left for the user to resolve (suspected duplicates, conflicts) |

### Request headers

| Header | Set by |
|---|---|
| `Authorization: Bearer …` | The credential |
| `User-Agent` | `saveslot-connector-ts/<SDK version> (<manifest id>/<manifest version>)` |
| `X-Task-Id` | The manifest's `id`, or the `task` of a call; shown in the slot's history |
| `Idempotency-Key` | Generated per write, or derived from the `key` of a call |
| `Content-Type`, `Accept` | `application/json` |

Header values go out as UTF-8 bytes: a task such as `整理账单` is sent as it is. `Retry-After` is followed up to `MAX_WAIT_MS` (60 s).

### Errors

Everything throws or rejects with `SaveslotError`. `code` is the service's error code (`unauthenticated`, `insufficient_scope`, `validation_failed`, `not_in_this_version`, …) or one of the SDK's own:

| Code | |
|---|---|
| `invalid_config` | The builder was set up wrong |
| `invalid_schema` | `defineSchema` declared something unusable |
| `schema_mismatch` | The slot lacks a declared table or field |
| `schema_pending` | Creating the slot waits for the user's confirmation |
| `not_built` | `ConnectorClient.with()` before `build()` |
| `already_built` | `build()` a second time; call `ConnectorClient.reset()` first to change settings |
| `not_initialized` | `init` has not succeeded |
| `unknown_table` | A record for a table not declared |
| `invalid_argument` | Without a `status`: a `task`, `key`, header value or record (a BigInt, a cycle) the SDK cannot send; nothing was sent. With a `status`, the service refused the request |
| `key_reused` | `write` with a `key` already used with other records; `written` says what this call had applied before |
| `unreachable`, `bad_reply` | No answer, or an answer that is not the service's |

## Current limits

Limits of today's service (07-scope-v1), and so of this version of the SDK:

- **No source keys** (P2): every write adds rows; the SDK has no `externalKey`.
- **No aliases** (P2) on tables or fields.
- **An existing slot cannot be changed** (P4): no table or field can be added to it, none changed.
- **Local only**: the service listens on a unix socket; server mode, OAuth and connectors on devices (iOS, Android, Flutter, React Native) come with P5.
- Creating a slot needs a credential with `saveslot.schema`. A credential sees every slot: `--slots` comes with P5.
