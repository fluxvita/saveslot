# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

The full contributor guide is currently in Chinese: [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md). This page lists the essentials.

## Workflow

1. Create a branch from `main`.
2. Open a merge request. CI must pass and one reviewer must approve.
3. Merge with squash.

## Conventions

- **Language.** Commit messages, code comments, identifiers, log and error messages are written in English. The design documents are currently authoritative in Chinese (`docs/zh-CN/`); an English edition will be added under `docs/` before the project goes public.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- **Sign off every commit** (`git commit -s`). This is the [Developer Certificate of Origin](https://developercertificate.org/) (DCO): it certifies that you have the right to submit the change under the project license. There is no CLA.
- **Spec first.** A change in behavior updates the spec (`docs/zh-CN/spec/`) in the same merge request; changes that affect how readers understand the system also update the guide (`docs/zh-CN/guide/`). Incompatible changes to the event format, the kernel invariants or the operation contract start with a decision record in `docs/zh-CN/process/decisions/` that is reviewed before the spec and code change.
- **Never commit** secrets, internal addresses, or personal information unrelated to the project.
- Run `pnpm check` locally (type check, lint, tests, dependency rules, doc links, JSON examples). CI runs the same scripts.

## Where to talk

- Bugs and tasks: Issues.
- Questions and design discussion: Discussions.
- Security issues: use the repository's private vulnerability reporting. Do not open a public issue.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
