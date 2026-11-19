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
| `docs/zh-CN/research/` | Public technical research: data models, storage, protocols, evaluation methods and related design evidence. |

Competitor analysis, market and product snapshots, product positioning, pricing and commercial strategy belong in the internal repository, not here. Split mixed reports into distinct technical and commercial documents; do not maintain synchronized copies. Conclusions needed by the public design must stand on their own in this repository, without depending on internal research. Existing technical research stays in place; mark superseded advice and unverified claims during the pre-publication review rather than rewriting conclusions or deleting history.

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
- pnpm workspace; Vitest for tests, fast-check for property tests; Biome for formatting and lint; Changesets for versioning.
- Run `pnpm check` on the head before every push (type check, lint, tests, dependency rules, doc links, JSON examples) and put the result in the merge request; do not bypass it. The merge request's pipeline runs quick checks only; CI runs the full check after merges and nightly, and a maintainer runs it again before merging when the change is risky. A failure on the default branch is fixed with priority.

## Commits

- Conventional Commits, scoped by package or doc area: `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- Every commit needs a `Signed-off-by` from a person (DCO). The sign-off is that person's certification, not yours: add it (`git commit -s`, with their name and email as the commit author) only when the person you work for has asked you to commit the change on their behalf. Never sign off on your own, and never sign off as a tool.
- Do not add trailers that attribute a commit to an AI tool (such as `Co-authored-by` for an assistant).
- Changes reach `main` only through merge requests, which a maintainer squash-merges. Once a branch is pushed, add commits at its end; do not rebase or force-push it: the maintainer rebases it when merging.
- Before pushing to a branch you pushed earlier, check that it still exists on the remote (`git ls-remote origin refs/heads/<branch>`): its merge request may have been merged and the branch deleted, and a push would create it again.
- Split unrelated changes into separate commits. Commit only when asked.

## Tests

- To fix a bug, first write a test that reproduces it.
- Changes touching replay, deletion or revert must also pass the comparison tests against the reference evaluator (the authoritative definition is in [`docs/zh-CN/spec/03-data-model/03-deletion.md`](docs/zh-CN/spec/03-data-model/03-deletion.md)).
- Do not loosen assertions or change examples in the spec to make tests pass. When an example and the implementation disagree, find out which one is right first.
- Cases a property test must cover are built deterministically; a minimum hit rate only guards against the generator degrading as a whole. Turn every counterexample into a fixed case.
- Save the full output of a test run to a file before filtering it. Report a failure, even one that did not repeat, with its seed, path and counterexample; do not rerun until green.
