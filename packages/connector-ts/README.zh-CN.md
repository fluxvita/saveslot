# @fluxvita/saveslot-connector-ts

[English](README.md)

编写 saveslot **连接器**的 TypeScript SDK。

连接器是以一个连接实例的身份、代用户写入 saveslot 的程序：通常是从某个外部系统（邮箱、运动服务、银行导出）收集一类记录，存进用户 saveslot 的一个 **slot**，用户使用的每个 Agent 都能读到它，连同完整的历史。

用这个 SDK，你只写业务这一侧：怎么连上外部系统，它的一条记录怎么对应成一行。凡是碰到 saveslot 的事都由 SDK 来做：建你声明的 slot、核对声明的表和字段都在、带幂等键分批写入记录、服务繁忙时重试、设置请求头。

这里只有 TypeScript 这一侧。其他平台与语言的 SDK 在另一个仓库开发，它们以同样的方式与同一个服务通信。

## 安装

还没有发布到 npm：目前是本仓库的私有包，以后单独发布。从本仓库使用（workspace 依赖，或指向 `packages/connector-ts` 的路径）。

需要 Node.js 24 或更高版本。

## 需要从服务拿到什么

目前服务在本机运行（`saveslot start`），HTTP 接口**只监听 unix socket**：`~/.saveslot/run/saveslot.sock`。服务器模式（托管或自部署、经 HTTPS、带 OAuth）在后续版本。

- **凭证**。为你的连接器签发一个：

  ```bash
  saveslot connect http --name "邮件 · 连接器"
  ```

  默认 scope 含 `saveslot.schema`，`init` 建 slot 时需要它。这个版本里凭证能看到所有 slot：`--slots` 在服务器模式（P5）之前会被拒绝。slot 建好之后，可以用 `--scope -schema` 签发一个不带 schema 权限的凭证。

- **连上 socket 的方式**。Node 自带的 `fetch` 连不了 unix socket，所以用 `setFetch` 给 SDK 一个能连的，基础地址随便给一个 `http://`：

  ```ts
  import { request } from "node:http";

  /** 把每个请求发给监听在 `socketPath` 上的服务的 `fetch`。 */
  export function socketFetch(socketPath: string): typeof fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // 用 Buffer 而不是字符串：Node 会把请求头和第一段字符串数据按那段数据的编码一起写出，
      // 已经是 UTF-8 字节的头的值会被再编码一次。
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

  SDK 自己的测试就是用这同一个函数连真实服务的。

## 四步写一个连接器

示例把一个邮箱同步到 slot `mail`，每封邮件一行。

### 1. 描述连接器

```ts
import { type ConnectorManifest, ConnectorPlatform } from "@fluxvita/saveslot-connector-ts";

const manifest: ConnectorManifest = {
  id: "com.example.mail",
  name: "邮件",
  description: "邮箱里收到的邮件。",
  logo: "https://example.com/mail.png",
  version: "1.0.0",
  publisher: "Example",
  platforms: [ConnectorPlatform.Cloud],
};
```

| 字段 | 必填 | |
|---|---|---|
| `id` | 是 | 唯一标识，如 `com.example.mail`。也是它写入的任务标识，显示在 slot 的历史里 |
| `name` | 是 | 显示名称 |
| `description` | 是 | 收集什么 |
| `logo` | 是 | logo 的 URL，或 `data:` URI |
| `version` | 是 | 版本，如 `1.0.0` |
| `publisher` | 是 | 发布者 |
| `platforms` | 是 | 运行在哪里：一个或多个、不重复，取自 `ConnectorPlatform`：`Cloud`（`cloud`：服务器、脚本或云函数）、`IOS`、`Android`、`Flutter`、`ReactNative`。目前只有 `cloud` 可用；设备上的连接器需要服务器模式 |
| `packages` | 设备平台 | 除 `cloud` 外每个所列平台的包地址（包名或应用商店地址） |
| `homepage` | 否 | 主页或文档 |

### 2. 声明 slot 和表

实现 `ConnectorProvider`。SDK 交给你一个 `SchemaBuilder`，加上 slot 和它的表，再返回它。

```ts
import type { ConnectorProvider, SchemaBuilder } from "@fluxvita/saveslot-connector-ts";

class MailProvider implements ConnectorProvider {
  defineSchema(schema: SchemaBuilder): SchemaBuilder {
    return schema.addSlot("mail", "Asia/Shanghai").addTable({
      name: "messages",
      description: "收到的一封邮件",
      time: { type: "event", field: "received_at" },
      fields: [
        { name: "message_id", type: "text", required: true, description: "Message-ID 头" },
        { name: "received_at", type: "zoned_datetime", required: true, description: "收到的时间" },
        { name: "sender", type: "text", description: "发件人地址" },
        { name: "subject", type: "text", description: "主题" },
      ],
    });
  }
}
```

| 表 | 必填 | |
|---|---|---|
| `name` | 是 | 字母、数字、下划线，字母开头，最多 63 个字符；在 slot 内不区分大小写地唯一 |
| `description` | 是 | 一行是什么 |
| `time` | 是 | `{ type: "event", field }`：每行是在 `field`（必填的 `date` 或 `zoned_datetime`）发生的一件事；`{ type: "state", granularity }`：取值随时间变化的实体；`{ type: "none" }`：没有时间 |
| `fields` | 是 | 字段 |
| `entityKey` | 状态类表 | 实体的自然键（必填字段） |
| `duplicateKeys` | 否 | 标记疑似重复的字段组：给用户一个待确认事项，不是拒绝 |
| `together` | 否 | 作为一个冲突单元的字段 |
| `externalKey` | 否 | 事件类表与无时间表：记录在来源系统里的标识字段，如 `["origin", "external_id"]`（1–4 个 `text`、`enum` 或 `integer` 字段，不能在 `together` 里）。声明后这张表的记录按来源键写入，见[按来源键写入](#按来源键写入) |

| 字段 | 必填 | |
|---|---|---|
| `name` | 是 | 同表名 |
| `type` | 是 | `text`、`integer`、`decimal`、`boolean`、`enum`、`date`、`zoned_datetime`、`quantity`、`ref` |
| `description` | 是 | 字段装的是什么 |
| `required` | 否 | 是否每行都必须有 |
| `unit` | `quantity` | 取自单位词表，如 `km`、`min`、`CNY` |
| `values` | `enum` | 允许的取值 |
| `min` / `max` | 否 | 范围 |
| `ref` | `ref` | 同一 slot 里指向的表：`{ table, target: "row" \| "entity" }` |

别名在服务的后续版本才有，现在的服务会拒绝它，所以这个版本的 SDK 不提供。见[当前限制](#当前限制)。

### 3. 把记录对应成行

继承 `SlotRecord`：说明这条记录写进哪张表、各字段是什么。

```ts
import { SlotRecord } from "@fluxvita/saveslot-connector-ts";

interface FetchedMessage {
  messageId: string;
  /** RFC 9557 文本，如 "2026-11-18T09:00:00+08:00[Asia/Shanghai]"。 */
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

取值按操作契约的写法：`text` 与 `enum` 写文本，`quantity` 写 `"5 km"`，时间写 RFC 3339 / RFC 9557 文本。

### 4. 设置 SDK 并写入

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectorClient } from "@fluxvita/saveslot-connector-ts";

// 在入口文件里做一次：build() 生成进程内唯一的实例。
const sdk = ConnectorClient.builder()
  .setManifest(manifest)
  .setCredential(process.env.SAVESLOT_CREDENTIAL!)
  .setBaseUrl("http://saveslot.local")
  .setFetch(socketFetch(join(homedir(), ".saveslot/run/saveslot.sock")))
  .setProvider(new MailProvider())
  .build();

// slot 不存在时连同表一起建好，并核对声明的表和字段都在。
await sdk.init();

// 你的业务代码：没完成的那次运行的 id，上次已成功时是一个新的 id，
const runId: string = await currentRunId();
// 以及这次运行的邮件，在运行开始时定下来（IMAP、Gmail API……）。
// 重试这次运行时，按同样的顺序、用同一个 runId 发送这些邮件。
const messages: FetchedMessage[] = await loadRun(runId);

// 给这次运行起个名字：中途失败、用同一个 key 重试时，不会写两遍。
const result = await sdk.write(
  messages.map((m) => new MailMessage(m)),
  { key: `mail-${runId}` },
);
console.log(result); // { records, created, updated, unchanged, awaiting, skipped, replayed, pending }
```

没有来源键的表（比如这里的 `messages`）每条记录都是新的一行：连接器自己记一个游标（写到的最后一封邮件），每条记录只写一次。有来源键的表每次同步都可以把同一批记录再交一遍，见[按来源键写入](#按来源键写入)。

一个 key 对应一组记录。用同一个 key 重试，必须按同样的顺序发送同样的记录：在一次运行开始时定下它的范围（比如游标之后的邮件，最多 1000 封），连同它的 `runId` 一直保留到这次运行成功；成功之后才移动游标，用新的 `runId` 开始下一次运行。如果重试时重新去取"上次之后的新邮件"，同一个 key 下就是另一组记录：已生效的批次会重放，然后服务拒绝第一个不同的批次，`write` 以 `key_reused` 拒绝，它的 `written` 说明此前已经生效了什么。

其他文件不用传递 `sdk`，`ConnectorClient.with()` 给它们同一个实例：

```ts
// sync-job.ts
import { ConnectorClient } from "@fluxvita/saveslot-connector-ts";

export async function syncInbox(runId: string) {
  const messages = await loadRun(runId); // 这次运行每次尝试都是同样的邮件
  return ConnectorClient.with().write(messages.map((m) => new MailMessage(m)), { key: runId });
}
```

邮箱自己的凭证放在你的密钥存储里，不要放进 slot。

### 按来源键写入

连接器读的系统给每条记录一个稳定的 ID 时，把它声明为这张表的来源键（只限事件类表与无时间表）：

```ts
schema.addSlot("rides", "Asia/Shanghai").addTable({
  name: "rides",
  description: "一次乘车",
  time: { type: "none" },
  externalKey: ["origin", "ride_id"],
  fields: [
    { name: "origin", type: "text", required: true, description: "来自哪个应用" },
    { name: "ride_id", type: "text", required: true, description: "这次乘车在那个应用里的 ID" },
    { name: "fare", type: "quantity", unit: "CNY", description: "花了多少" },
  ],
});
```

这张表的记录按来源键写入，每次同步都可以把整个范围再交一遍：

- 一个键第一次写入，新增一行（`created`）。
- 与上次交来的一样，什么都不记（`unchanged`）：不产生事件，slot 的历史里也没有。
- 来源里改了某个字段，更新那个字段（`updated`）。
- 用户在 saveslot 里改过的字段（上次交来之后）不会被覆盖：来源对它的改动成为候选，生成事项等用户处理（计入 `pending`）；来源没改的字段保持用户改的值。这条记录另有字段生效时计为 `updated`，没有字段生效时计为 `awaiting`。
- 用户撤销了的行不会被写回（`skipped`）；键被一项仍可撤回的删除占着时也一样。

每条记录都要给全部键字段的值，并且至少还有一个别的字段；一次调用里同一张表不能有两条同键的记录；`write` 在发送任何东西之前检查这几点。不止一个来源系统写这张表时，在键里放一个说明来源系统的字段（这里的 `origin`）：不同系统的 ID 可能相同。键值与任何一行都不同的记录会新增一行：来源给一条记录换了 ID 时，旧 ID 的那一行仍然留着。

调用上的 `key` 仍然让同一批记录的重试安全，但在这里不需要靠它避免重复行：来源键已经做到了。

## API

### `ConnectorClient.builder()`

| 设置 | |
|---|---|
| `setManifest(manifest)` | 必填。 |
| `setCredential(credential)` | 必填。只放在 `Authorization` 里发送，不会出现在任何报错信息里。含有令牌不可能有的字符（空白、换行）时，`build()` 拒绝。 |
| `setBaseUrl(url)` | 必填。本机服务时随便给一个 `http://` 地址，再配合 `setFetch`。 |
| `setProvider(provider)` | 必填。你的 `ConnectorProvider`。 |
| `setHeaders(headers)` | 每个请求附加的头，如链路追踪。不能替换 SDK 自己的头。 |
| `setFetch(fetch)` | 传输方式，默认用全局 `fetch`。 |
| `setTimeout(ms)` | 请求超时：大于 0 的整数（30 000）。 |
| `setRetries(n)` | 没有应答、429 或 503 之后重试几次：0 到 `MAX_RETRIES`（10），默认 4。 |

`build()` 检查设置，有误时抛出 `invalid_config`，`details.field` 写明是哪一项。它生成进程内唯一的实例并返回；再次 build 抛出 `already_built`。

### `ConnectorClient.with()` 与 `ConnectorClient.reset()`

- `with()`：从任何文件拿到 `build()` 生成的实例。`build()` 之前调用抛出 `not_built`。
- `reset()`：忘掉这个实例，可以换设置重新 build；测试里也用它。

### `init()`

1. 调用 `defineSchema`。
2. 读这个 slot；同时也检查了服务是否接受这个凭证。
3. slot 不存在时，用一份 schema 草稿把它连同所有表一起建好。
4. 核对每张声明的表都在、声明的字段都有、来源键与声明的相同（没声明就是没有）；否则以 `schema_mismatch` 拒绝，列出哪里不同，什么都不改。只比较名字，不比较字段类型或是否必填：已有 slot 里类型不同的字段，到 `write` 时由服务拒绝。

这个版本不能改已有的 slot（加表、加字段或加来源键）：服务在后续版本之前会拒绝。按 slot 现有的样子声明，或者写到一个新的 slot。

`init` 成功之前，其他方法都以 `not_initialized` 拒绝。

### `write(records, { key?, task? })`

把记录按表分组写入，每次写入最多 100 条：作为新增，或者在声明了来源键的表上按来源键写入。`key` 给这次调用命名：24 小时内用同一个 key 再发同一次调用只生效一次，它的记录计入 `replayed` 而不是 `created`。每次写入以 `<key>.<表>.<n>` 作为幂等键，最多 256 个字符；所有键、task 和每条记录都在发送任何东西之前检查，所以 `key` 要短（一个 UUID，或一次运行的名字）。

用同一个 `key` 重试，必须按同样的顺序发送同样的记录（见上面的例子）。在用过的 key 下发送别的记录，以 `key_reused` 拒绝。开始发送之后出的任何错误都带 `written`，字段与结果相同：出错之前这次调用已经生效了什么。服务拒绝其中一次写入、并指出了其中某些记录时，错误的 `records` 给出它们在传给 `write` 的数组里的下标（`details` 保留服务自己的下标，那是在这一次写入里数的），错误消息里也会写出。

| 结果 | |
|---|---|
| `records` | 给了多少条记录。每条在下面恰好计一次：`created`、`updated`、`unchanged`、`awaiting`、`skipped` 或 `replayed` |
| `created` | 这次调用新增的行数 |
| `updated` | 按来源键：改了键找到的那一行的记录数 |
| `unchanged` | 按来源键：没有带来任何新东西的记录数；没为它们记任何东西 |
| `awaiting` | 按来源键：没有字段生效、有字段等用户处理（成了候选，或改动要确认）的记录数；事项计入 `pending` |
| `skipped` | 按来源键：没有写的记录数，因为用户撤销了那一行，或键被一项仍可撤回的删除占着 |
| `replayed` | 服务按同一个 key 已经生效过的写入里的记录数：没有再写 |
| `pending` | 留给用户处理的事项（疑似重复、冲突） |

### 请求头

| 头 | 来自 |
|---|---|
| `Authorization: Bearer …` | 凭证 |
| `User-Agent` | `saveslot-connector-ts/<SDK 版本> (<manifest id>/<manifest version>)` |
| `X-Task-Id` | manifest 的 `id`，或调用时给的 `task`；显示在 slot 的历史里 |
| `Idempotency-Key` | 每次写入生成一个，或由调用时给的 `key` 派生 |
| `Content-Type`、`Accept` | `application/json` |

头的值按 UTF-8 字节发送：`整理账单` 这样的 task 原样发出。`Retry-After` 最多等 `MAX_WAIT_MS`（60 秒）。

### 报错

所有错误都以 `SaveslotError` 抛出或拒绝。`code` 是服务的错误码（`unauthenticated`、`insufficient_scope`、`validation_failed`、`not_in_this_version`……），或 SDK 自己的：

| 错误码 | |
|---|---|
| `invalid_config` | builder 设置有误 |
| `invalid_schema` | `defineSchema` 声明了用不了的东西 |
| `schema_mismatch` | slot 缺少声明的表或字段，或表的来源键与声明的不同 |
| `schema_pending` | 建 slot 要等用户确认 |
| `not_built` | `build()` 之前调用了 `ConnectorClient.with()` |
| `already_built` | 第二次 `build()`；要换设置先调用 `ConnectorClient.reset()` |
| `not_initialized` | `init` 还没成功 |
| `unknown_table` | 记录指向没有声明的表 |
| `invalid_argument` | 没有 `status` 时：SDK 发不出去的 `task`、`key`、头的值或记录（BigInt、循环引用；缺了键字段或键字段为空；只有键字段；两条记录来源键相同）；什么都没发送。有 `status` 时，是服务拒绝了请求 |
| `key_reused` | `write` 用了一个已经配别的记录用过的 `key`；`written` 说明此前这次调用已经生效了什么 |
| `unreachable`、`bad_reply` | 没有应答，或应答不是服务的格式 |

## 当前限制

当前服务的限制（07-scope-v1），也就是这个版本 SDK 的限制：

- **没有别名**（P2），表和字段都没有。
- **不能改已有的 slot**（P4）：不能给它加表、加字段，也不能改。
- **只在本机**：服务只监听 unix socket；服务器模式、OAuth 和设备上的连接器（iOS、Android、Flutter、React Native）随 P5 到来。
- 建 slot 需要带 `saveslot.schema` 的凭证。凭证能看到所有 slot：`--slots` 随 P5 到来。
