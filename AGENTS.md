# AGENTS.md

Instructions for coding agents working in this repository. The human-facing versions are [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md); the rules are the same. This file lists what you must know before making changes.

## What the project is

saveslot is a shared data layer for all of a person's agents: it records things that change over time and keeps the full history from the original evidence to the current state. For more, see [`docs/zh-CN/guide/01-what-is-saveslot.md`](docs/zh-CN/guide/01-what-is-saveslot.md).

## Language

- **Write everything in the repository in English**: commit messages, merge request titles, code comments, identifiers, log and error messages, test names.
- **The design documents are currently in Chinese** under `docs/zh-CN/` and are authoritative until an English edition is added under `docs/`. Edit the Chinese documents when the spec or guide must change; do not start an English edition unless asked.

## Where the docs are, and which one wins

| Directory | Contents |
|---|---|
| `docs/zh-CN/spec/` | Specification. **Behavior is defined here.** |
| `docs/zh-CN/guide/` | Guide for first-time readers. If it disagrees with the spec, the spec wins; fix the guide. |
| `docs/zh-CN/process/decisions/` | Decision records: why a design is the way it is. |
| `docs/zh-CN/process/walkthroughs/` | Step-by-step walkthroughs of the spec on concrete scenarios. |
| `docs/zh-CN/research/` | Background research only. |

Read the spec sections relevant to the task before implementing. Do not implement from the guide or from memory alone.

## Rules

- **Spec first.** A change in behavior updates `docs/zh-CN/spec/` in the same merge request; changes that affect reader understanding also update `docs/zh-CN/guide/`.
- **Incompatible changes to the event format, the kernel invariants (K1–K14) or the operation contract** start with a decision record in `docs/zh-CN/process/decisions/` that is reviewed before the spec and code change. Do not change them directly.
- **`docs/zh-CN/spec/` and `docs/zh-CN/guide/` describe the design only.** Process information (dates, revision rounds, "it used to be X, now Y", review sources) belongs in `docs/zh-CN/process/`.
- **Use the spec's terms** (slot, source data, table data, conflict unit, `ver`, …). Do not invent synonyms.
- **Package dependency direction** follows [`docs/zh-CN/spec/02-architecture.md`](docs/zh-CN/spec/02-architecture.md) §11: the kernel does not depend on outer layers. The check scripts enforce it.
- **Never commit** secrets, internal addresses, or unrelated personal information. Test data is fictional.

## Toolchain

- Node ≥ 24, TypeScript strict mode, ESM only.
- pnpm workspace; Vitest for tests, fast-check for property tests; Biome for formatting and lint; tsup for bundling; Changesets for versioning.
- Run `pnpm check` before committing (type check, lint, tests, dependency rules, doc links, JSON examples). CI runs the same scripts; do not bypass them.

## Commits

- Conventional Commits, scoped by package or doc area: `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- Sign off every commit (`git commit -s`).
- Follow the maintainers' current workflow for reaching `main`. Once merge requests are required, changes reach `main` only through them.
- Split unrelated changes into separate commits. Commit only when asked.

## Tests

- To fix a bug, first write a test that reproduces it.
- Changes touching replay, deletion or revert must also pass the comparison tests against the reference evaluator (the authoritative definition is in [`docs/zh-CN/spec/03-data-model/03-deletion.md`](docs/zh-CN/spec/03-data-model/03-deletion.md)).
- Do not loosen assertions or change examples in the spec to make tests pass. When an example and the implementation disagree, find out which one is right first.
