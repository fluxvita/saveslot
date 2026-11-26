# saveslot · Specification

English · [简体中文](../zh-CN/spec/README.md)

> Every specification document has a Chinese edition ([`docs/zh-CN/spec/`](../zh-CN/spec/README.md)), aligned in meaning with this one; a difference between them is a defect, to be reported as an issue.

> The complete definition of every rule, to be looked up as needed by those who implement the kernel, write integrators and review the design. Someone meeting saveslot for the first time reads the guide first ([`../guide/`](../guide/README.md)); a one-page overview of the project is in [`README.md`](../../README.md) at the repository root. Where the guide and the specification differ, the specification holds.

The reading order is the numeric order of the file names: **01 → 02 → 03 → … → 10**; 07 (scope of the first version), 08 (open questions) and 11 (claims index) can be consulted at any time.

| File | What to read it for |
|---|---|
| [`01-positioning.md`](01-positioning.md) | Positioning, who it serves, product forms, the scenario test, layers and surfaces, what it handles and what it does not, deployment forms, technology choices, later plans |
| [`02-architecture.md`](02-architecture.md) | Engineering architecture: kernel invariants K1–K14, service-layer policy, modules and dependencies, runtime, storage abstraction and storage format, trust boundaries, code organization and tests |
| [`03-data-model/`](03-data-model/README.md) | The authoritative definition of the data mechanisms and the kernel rules, divided by topic into 11 parts (including the allowlist for restricted SQL); the directory gives a one-sentence description of each |
| [`04-contract.md`](04-contract.md) | The rules of the operation contract: when each operation returns what, and why |
| [`04-contract-types.md`](04-contract-types.md) | The type definitions of the operation contract: the parameters, results, errors and all enumerations of each operation; field names and structure follow this file |
| [`05-surfaces.md`](05-surfaces.md) | The surfaces: the rules of MCP and of HTTP |
| [`06-cli.md`](06-cli.md) | The surfaces: the CLI and the getting-started flow (the command list, interaction for human confirmation, output conventions, security) |
| [`07-scope-v1.md`](07-scope-v1.md) | Scope of the first version |
| [`08-open-questions.md`](08-open-questions.md) | The only list of undecided items, in three groups by "when it must be decided" |
| [`09-event-format.md`](09-event-format.md) | The event format: the event header fields, content blocks and encoding of each kind of event; also the format description of the export file |
| [`10-evals.md`](10-evals.md) | The eval specification: evals in which a real Agent completes tasks through MCP; the acceptance of every phase uses them |
| [`11-claims.md`](11-claims.md) | The claims index: which test guards each universal claim in the specification, which are known not to hold, and which have no test yet |

The specification gives only the design itself. Why a rule was set as it was and what reviews it went through are in [`../zh-CN/process/`](../zh-CN/process/README.md) (Chinese) (decision drafts, scenario walkthroughs); the sources of the research are in [`../zh-CN/research/`](../zh-CN/research/) (Chinese).
