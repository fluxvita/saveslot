# saveslot

English · [简体中文](README.zh-CN.md)

**saveslot is Agent Data Infra: a shared data layer for all of a person's agents.** It tracks things that change over time and keeps the full timeline from the original evidence to the current state. The data belongs to the user and is not tied to any model vendor or agent host.

- **Time is first-class.** A database stores the present; agent memory stores what was said. saveslot stores the timeline of a thing: what it is now, how it got there, and the evidence behind every step.
- **Agents interpret, saveslot enforces.** Understanding intent and turning conversation into structured writes is the agent's job. saveslot only does deterministic checking, recording and execution; its core path does not depend on a model.
- **One append-only log is the single source of truth.** Every piece of state is either a log event or derived from the log deterministically, so an export is the log, and replaying it on any backend yields the same state.

## Status

saveslot is in the **design phase**. There is no code yet; the first implementation milestone (P0) is next.

The design documents are currently written in **Simplified Chinese** under [`docs/zh-CN/`](docs/zh-CN/). An English edition will be added under `docs/` before the project is announced.

| Where | What |
|---|---|
| [`docs/zh-CN/guide/`](docs/zh-CN/guide/README.md) | Guide: a narrative introduction, read in order |
| [`docs/zh-CN/spec/`](docs/zh-CN/spec/README.md) | Specification: the authoritative definition of behavior |
| [`docs/zh-CN/process/`](docs/zh-CN/process/README.md) | Design decision records and scenario walkthroughs |
| [`docs/zh-CN/research/`](docs/zh-CN/research/) | Background research |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
