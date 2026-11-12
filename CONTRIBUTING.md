# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

The full contributor guide is currently in Chinese: [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md). This page lists the essentials.

## Workflow

1. Create a branch from `main`. If you cannot push branches to the repository, fork it and create the branch in your fork.
2. Open a merge request against `main` (from your fork, if you used one) and fill in the template. Its title is a Conventional Commit and becomes the squash commit's subject; CI checks the title (`feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `perf`, `revert`, `style`; scope in lower case).
3. To be merged, CI must pass, every review thread must be resolved, and a maintainer must approve it.
4. A maintainer merges it with squash.

## Conventions

- **Language.** Commit messages, code comments, identifiers, log and error messages are written in English. The design documents are currently authoritative in Chinese (`docs/zh-CN/`); an English edition will be added under `docs/` before the project goes public.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- **Sign off every commit** (`git commit -s`). This is the [Developer Certificate of Origin](https://developercertificate.org/) (DCO): it certifies that you have the right to submit the change under the project license. There is no CLA. Sign off with your real name and the same email as the commit author; CI checks that the sign-off matches the author.
- **AI-assisted contributions.** You may use AI tools. The sign-off is always made by a person, never by a tool, and that person is responsible for the change as if they had written it: they have reviewed it, understand it, and have the right to submit it under the project license. Do not add trailers that attribute the change to an AI tool; the sign-off says who is responsible.
- **Spec first.** A change in behavior updates the spec (`docs/zh-CN/spec/`) in the same merge request; changes that affect how readers understand the system also update the guide (`docs/zh-CN/guide/`). Incompatible changes to the event format, the kernel invariants or the operation contract start with a decision record in `docs/zh-CN/process/decisions/` that is reviewed before the spec and code change.
- **Research ownership.** Technical research belongs in `docs/zh-CN/research/`. Competitor analysis, market and product snapshots, product positioning, pricing and commercial strategy belong in the internal repository, not here. Split mixed reports without maintaining synchronized copies; public design conclusions must be independently supported in this repository, not by internal research. Keep existing technical reports in place and annotate superseded advice or unverified claims during the pre-publication review, without rewriting their conclusions or deleting history.
- **Never commit** secrets, internal addresses, or personal information unrelated to the project.
- Run `pnpm check` locally (type check, lint, tests, dependency rules, doc links, JSON examples). CI runs the same scripts.

## Where to talk

- Bugs, tasks and research: Issues, using the matching template.
- Questions and design discussion: Discussions.
- Security issues: see [`SECURITY.md`](SECURITY.md). Do not open a public issue.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
