# Development guide

English · [简体中文](zh-CN/development.md)

This page takes you from a fresh clone to a validated change: set up, run the checks, find where a change belongs, rehearse one small fix, debug a failure. It is for people who change this repository. To use saveslot with an agent instead, start from [Get started](../README.md#get-started) in the README.

The rules for submitting a change (branches, pull requests, sign-off, AI-assisted work) are in [`CONTRIBUTING.md`](../CONTRIBUTING.md). This page does not repeat them.

> **Supported for development:** macOS and Linux, with the Node versions in [Set up](#set-up). The setup, the checks, the commands under [Run one test](#run-one-test) and the walkthrough were run on macOS (arm64) with Node 26.13.1 and pnpm 12.14.0, and so were the failures in [Common failures](#common-failures). On Linux, the project's CI runs the same `pnpm check` in the `node:24` and `node:latest` images. Windows has not been tried.

## What runs today

The current version, 0.2, is implemented: the service in local and server mode, its HTTP and MCP interfaces, and the `saveslot` command. What 0.2 does not do yet is listed under [Status](../README.md#status) in the README.

Besides the build, the tests and the repository checks, you can run the service you built: after `pnpm build`, `node packages/saveslot/dist/bin.js setup` sets it up and starts it, as `saveslot setup` does in [Get started](../README.md#get-started) in the README.

| Package | What is in it |
|---|---|
| `contract-core` | The data shapes the kernel and the contract share: value encoding, evidence, flags, intents, domain errors, event format types |
| `kernel` | The log, apply, judging, writes, reads, deletion and the operation layer; the storage ports |
| `store-pglite` | The PGlite storage backend, used in local mode |
| `store-postgres` | The PostgreSQL storage backend, used in server mode |
| `contract` | The operation contract: the operations, the fields only a surface has, the errors |
| `service` | The service layer: identity, permissions, idempotency, handles, rate limits, control plane storage |
| `server` | The HTTP and MCP adapters |
| `daemon` | The service process: backend selection, configuration, the background task scheduler |
| `client` | The HTTP client for the contract |
| `cli` | The `saveslot` command |
| `saveslot` | The package people install, which provides the `saveslot` command |
| `connector-ts` | The TypeScript SDK for writing connectors. Not published |
| `reference` | The reference evaluator, a test oracle. Only test files may import it |
| `test-backend` | The storage backend the tests open: PGlite, or PostgreSQL when the run asks for it. Only tests use it |

`experiments/` holds the harnesses of the pre-development experiments. They are not part of `pnpm check`; their method and results are in [`zh-CN/process/experiments/`](zh-CN/process/experiments/).

What each package is for and which package may depend on which: [guide chapter 12, section 1](guide/12-contributing.md#1-how-the-code-is-split-into-packages) and [spec `02-architecture.md` §11](spec/02-architecture.md#11-code-organization).

## Set up

You need:

- **Git.**
- **Node 24.22.1 or later on the 24 line, or 26.12.1 or later**, as the `engines` field of [`package.json`](../package.json) says. [`.nvmrc`](../.nvmrc) names the version CI uses. The check scripts are TypeScript files that Node runs directly, which older versions cannot do.
- **pnpm 12.14.0**, the version in the `packageManager` field of [`package.json`](../package.json). Install it the way CI does: `npm install --global pnpm@12.14.0`.

For `pnpm check` you do not need a database, a container, a network service, an account or any environment variable. The storage tests run PGlite inside the test process and write only to temporary directories. The same tests on a PostgreSQL server are a separate command, `pnpm test:postgres`, which needs a server and `SAVESLOT_TEST_POSTGRES_URL`; CI runs it after a merge.

You do not need a C compiler either. One dependency of `store-pglite`, `fs-native-extensions`, is a native module, and its package ships prebuilt binaries for macOS, Linux and Windows on x64 and arm64. On another platform it has no binary to load and the `store-pglite` tests cannot run.

```sh
git clone <repository-url> saveslot
cd saveslot
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm install --frozen-lockfile` installs exactly what [`pnpm-lock.yaml`](../pnpm-lock.yaml) records and fails if the lockfile and a manifest disagree. `pnpm build` (`tsc -b`, then `scripts/mark-bins.ts`) prints nothing of its own when it succeeds.

`pnpm check` is the success check for the whole setup. It took about a quarter of an hour on the machine above, most of it in the unit tests. The unit tests print a summary in the same form, counting several thousand tests; the property tests and the remaining steps end like this:

```text
skipped: the tests against PostgreSQL (SAVESLOT_TEST_POSTGRES_URL names no server to run them on)
...
 Test Files  45 passed | 1 skipped (46)
      Tests  246 passed | 8 skipped (254)
...
✔ no dependency violations found (891 modules, 4239 dependencies cruised)
...
Doc links OK: 179 Markdown files checked.
JSON examples OK: 232 blocks parsed.
...
Translations OK: 38 English documents, each naming its Chinese source; not required yet: ...
...
Claims OK: 28 rows, 34 test references (4 to cases that run only under a condition).
```

The counts grow as the code does; what matters is that every step passes and the command exits with 0.

## The checks

`pnpm check` runs eleven steps in order and stops at the first failure. Each is also a script of its own:

| Command | What it verifies |
|---|---|
| `pnpm typecheck` | The packages and the test files compile under TypeScript strict mode |
| `pnpm lint` | Biome formatting and lint rules. `pnpm format` applies the fixes it can |
| `pnpm test:unit` | Every `*.test.ts` except property tests |
| `pnpm test:prop` | The property tests (`*.prop.test.ts`, fast-check) |
| `pnpm deps` | The package and kernel-module dependency rules of spec `02-architecture.md` §4 and §11 |
| `pnpm docs:links` | Every relative link in a Markdown file points to an existing file, and every `#fragment` to a heading |
| `pnpm docs:json` | Every `json` code block in a Markdown file parses |
| `pnpm docs:translations` | Every guide and spec document has its English edition, which names its Chinese source, and an English document links the English edition of a page where one exists. An English edition older than its Chinese source is reported without failing |
| `pnpm docs:claims` | Every row of the claims index (`docs/zh-CN/spec/11-claims.md`) links back to the spec, and every test it names exists and is not skipped |
| `pnpm docs:spec-refs` | Every reference to the specification in a code comment (a file and a title in `«»`, see [`CONTRIBUTING.md`](../CONTRIBUTING.md)) names a file and a title that exist |
| `pnpm conflict-markers` | No tracked text file keeps a line a merge conflict leaves behind (one starting with `<<<<<<< ` or `>>>>>>> `) |

None of them needs a database or the network.

CI runs `pnpm check`, split into three jobs (`check:static`, `test:unit`, `test:prop`), and, on a pull request, three more checks that you can run locally:

| Command | What it verifies |
|---|---|
| `pnpm dco` | Every commit in `origin/main..HEAD` is signed off by its author |
| `pnpm mr-title "<title>"` | The pull request title is a Conventional Commit |
| `pnpm terms` | Code and the spec cite spec sections, not internal ruling numbers. The project's term list is not in the repository, so a local run prints a warning and skips that part |

CI also scans the commits for secrets with gitleaks. After a merge it also runs `pnpm test:postgres`, and `pnpm check` on Node 26.

## Run one test

Tests run from the repository root. Vitest resolves workspace packages to their TypeScript sources, so you do not need to build first.

```sh
# One file
pnpm vitest run packages/contract-core/src/event/values.test.ts

# Every test under a directory (here: one package)
pnpm vitest run packages/kernel

# Tests whose full name matches a pattern
pnpm vitest run packages/contract-core -t "raw but not canonical"

# Watch mode: rerun on save
pnpm vitest packages/contract-core/src/event/values.test.ts
```

The arguments are **path filters**: Vitest runs the test files whose path contains the text. They are not pnpm package selectors. The packages have no `test` script of their own, so `pnpm --filter @fluxvita/saveslot-kernel test` prints nothing, runs nothing and exits with 0. Do not read that as a pass.

A successful run ends with a summary such as `Tests  41 passed (41)`. With `-t`, the tests that did not match are counted as skipped.

Rough timings, to choose what to run while you work: one `contract-core` test file finishes in well under a second. Tests that open a store start real PGlite instances and take seconds each; most of the `store-pglite` and `daemon` tests do, and some of the `kernel` and `service` tests. A whole package of those takes minutes, so while you work, run the file you change, and leave the rest to `pnpm check`.

## Where a change belongs

1. Find the package in [guide chapter 12, "Where to go to change something"](guide/12-contributing.md#where-to-go-to-change-something), and its role in the table in [What runs today](#what-runs-today).
2. Read the spec sections that define the behavior before you change it. The spec is the authority; the guide explains it.

| You change | Read first |
|---|---|
| A value's written form, an identifier, an event type or a block | [`09-event-format.md`](spec/09-event-format.md); for caller-given values also [`04-contract.md`](spec/04-contract.md) section 1 |
| The log: appending, the hash chain, clearing blocks, verification | [`02-architecture.md`](spec/02-architecture.md) §3 and §8 |
| A storage backend or the storage ports | [`02-architecture.md`](spec/02-architecture.md) §7 and §8 |
| Replay, deletion or revert in the reference evaluator | [`03-data-model/03-deletion.md`](spec/03-data-model/03-deletion.md) |
| An operation: its parameters, its result, its errors | [`04-contract.md`](spec/04-contract.md) |
| An HTTP route, an MCP tool or a `saveslot` command | [`05-surfaces.md`](spec/05-surfaces.md), and for the command [`06-cli.md`](spec/06-cli.md) |
| An import between packages or kernel modules | [`02-architecture.md`](spec/02-architecture.md) §4 and §11, then `pnpm deps` |

3. Decide which documents change with the code: [guide chapter 12, "What to update together when changing the design"](guide/12-contributing.md#what-to-update-together-when-changing-the-design). A change in behavior updates the spec in the same pull request. A change to a spec or guide document changes its English edition under `docs/` in the same pull request. An incompatible change to the event format, the kernel invariants or the operation contract needs a reviewed decision record first.

Tests live next to the code they test: `values.ts` has `values.test.ts` and `values.prop.test.ts` in the same directory.

## Rehearse a small fix

This walkthrough replays a real fix, commit `226bdf0` (`fix(contract-core): restrict raw decimals to the JSON number grammar`), on a throwaway branch. The fix is already merged, so step 2 puts the bug back. Nothing here is meant to be committed.

**The report.** `isRawDecimal("007")` returns `true`, so a caller's decimal with leading zeros would be accepted.

**1. Find the rule and the code.** A caller-given decimal is a value's written form, so the table above points to `04-contract.md` section 1. Its item "The encoding of values" says a caller's decimal follows the JSON number grammar and that a leading zero (`01`) is rejected. The report is a bug, not a missing feature. The predicate is in `packages/contract-core/src/event/values.ts`:

```ts
const RAW_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
```

**2. Put the bug back.** Create a branch and replace that line with the one from before the fix:

```sh
git switch -c practice/raw-decimal
```

```ts
const RAW_DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
```

**3. Write the test that reproduces the report.** Append to `packages/contract-core/src/event/values.test.ts`:

```ts
describe("practice: raw decimals", () => {
  it("rejects leading zeros", () => {
    expect(isRawDecimal("007")).toBe(false);
  });
});
```

Run only that test and watch it fail:

```sh
pnpm vitest run packages/contract-core/src/event/values.test.ts -t "practice"
```

```text
 FAIL  packages/contract-core/src/event/values.test.ts > practice: raw decimals > rejects leading zeros
AssertionError: expected true to be false // Object.is equality
...
      Tests  1 failed | 41 skipped (42)
```

A test that fails for the reported reason, before the fix exists, is what shows that the test checks the bug. Because this fix is already merged, the tests that came with it fail too if you drop the `-t` filter; with a new bug, yours would be the only one.

**4. Fix it.** Restore the original line:

```sh
git restore packages/contract-core/src/event/values.ts
```

Run the same command again. It now ends with `Tests  1 passed | 41 skipped (42)`.

**5. Widen the validation.** Run the package, then everything:

```sh
pnpm vitest run packages/contract-core
pnpm check
```

**6. Decide which documents change.** The code now does what the spec already said, so the spec and the guide stay as they are. Had the fix changed what the spec says (for example, accepting a form it rejects), the spec would change in the same pull request, and because a raw value is recorded in events, that change would need a decision record first.

**7. Throw the branch away.**

```sh
git restore .
git switch main
git branch -D practice/raw-decimal
```

For a real change you would instead commit, sign off and open a pull request as [`CONTRIBUTING.md`](../CONTRIBUTING.md) describes.

A documentation change follows the same loop with different checks: edit the page, then run `pnpm docs:links`, `pnpm docs:json` and `pnpm docs:translations`, and `pnpm docs:claims` if you changed the claims index. Add `pnpm terms` if the page is under `docs/zh-CN/spec/` or `docs/zh-CN/guide/`.

## Debugging

**Step through a test.** Start it paused and attach a debugger (Chrome's `chrome://inspect`, or your editor's "attach to Node process"):

```sh
pnpm vitest run --inspect-brk --no-file-parallelism packages/contract-core/src/event/values.test.ts
```

The run prints `Debugger listening on ws://127.0.0.1:9229/...` and waits for the debugger.

**Reproduce a property-test failure.** fast-check prints the seed and path of the failing sample, and the smallest counterexample it found:

```text
Error: Property failed after 4944 tests
{ seed: 1092691537, path: "4943:3", endOnFailure: true }
Counterexample: ["00"]
```

Many property files read the seed from `PROP_SEED`, and some the path from `PROP_PATH` as well; the head of the file says which. For those, replay the sample without editing the test:

```sh
PROP_SEED=<seed> PROP_PATH="<path>" pnpm vitest run <the failing *.prop.test.ts>
```

A file that does not read them needs the edit: pass that object to the failing property's `fc.assert(...)` as its options (next to any `numRuns` already there) and the run goes straight to that sample. Remove it before you commit. Put the seed, the path and the counterexample in the issue or pull request when you report the failure.

**Run more samples.** The property tests read `PROP_RUNS` as their sample count:

```sh
PROP_RUNS=20000 pnpm vitest run packages/reference/src/log.prop.test.ts
```

Use it to raise the count. Many of these properties also require a minimum share of samples that reach the situation it checks, so a small count can fail for that reason alone.

**Logs.** The service that `saveslot setup` starts writes its log to `~/.saveslot/run/saveslot.log`. In the tests, what you can observe is the output of the test run and of the check scripts.

### Common failures

| What you see | Cause and fix |
|---|---|
| `ERR_UNKNOWN_FILE_EXTENSION` for a `scripts/*.ts` file | Node is too old to run TypeScript files directly. Use a version from [Set up](#set-up) (`node -v`) |
| `pnpm install --frozen-lockfile` fails, lists what differs (for example `1 dependency was added: ...`) and suggests regenerating the lockfile | A `package.json` changed without the lockfile. If you changed a dependency on purpose, run `pnpm install` and commit `pnpm-lock.yaml`; otherwise restore the manifest |
| `pnpm lint` prints `Formatter would have printed the following content` | Run `pnpm format` and review the diff |
| `pnpm deps` ends with `x 1 dependency violations` | The line above it names the import. It crosses a package or kernel-module boundary that the spec does not allow; an import of a workspace package that the importing package does not declare shows up as `no-unresolvable`. Move the code or change the design first; do not edit the rule to make it pass |
| `pnpm docs:links` prints `<file>:<line>: <target> (file does not exist)` or `(no heading with this anchor)` | The target file or heading does not exist. Heading fragments follow GitHub's anchor form |
| `pnpm --filter <package> test` exits with 0 and prints nothing | No test ran. Use a path filter (see [Run one test](#run-one-test)) |
| A test and an example in the spec disagree | Find out which one is right before changing either. Do not loosen an assertion or edit the example to get a pass |

### Before you post output

Test data in this repository is fictional, so test output is normally safe to share. Before you paste a log into an issue or a pull request, remove:

- absolute paths that contain your user name or machine name;
- tokens, credentials and values of environment variables;
- internal host names and addresses;
- any real personal data, if you ran the code against data of your own.

Report a suspected security problem privately, as [`SECURITY.md`](../SECURITY.md) describes, not in a public issue.

## Submit the change

[`CONTRIBUTING.md`](../CONTRIBUTING.md) is the single place for the workflow: branch or fork, pull request title and template, the conditions for merging, the sign-off a person makes on every commit, AI-assisted contributions, and what must never be committed. Before you open the pull request, run `pnpm check`, and `pnpm dco` once your commits exist.
