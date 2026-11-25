# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

The full contributor guide is [`docs/guide/12-contributing.md`](docs/guide/12-contributing.md) ([中文](docs/zh-CN/guide/12-contributing.md)). This page lists the essentials.

## Workflow

1. Create a branch from `main`. If you cannot push branches to the repository, fork it and create the branch in your fork.
2. Open a merge request against `main` (from your fork, if you used one) and fill in the template. Every merge request targets `main`, also a fix for a version already released: a maintainer cherry-picks it onto that version's release branch (`release/0.<minor>`) once it is merged. Its title is a Conventional Commit and becomes the squash commit's subject; CI checks the title (`feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `perf`, `revert`, `style`; scope in lower case).
3. Once the branch is pushed, add commits at its end, so that what was reviewed stays as it was. Keep the branch linear, without merge commits: merge requests are squashed onto `main` by fast-forward, and a branch with a merge commit cannot be rebased at merge time. A branch that is only behind `main` needs nothing from you: the maintainer rebases it when merging. When it conflicts with `main`, or `pnpm check` no longer passes on top of the latest `main`, rebase it onto the latest `main` yourself, run `pnpm check` on that head, push it with `git push --force-with-lease`, and say so in the merge request (the old head, the new head, and how each conflict was resolved). That is the one case in which a pushed branch is rewritten. The maintainer does not resolve conflicts on your branch.
4. To be merged, the merge request's pipeline (quick checks: title, sign-off, secrets, forbidden terms) must pass, `pnpm check` must pass on the head (you run it before pushing and paste the result in the description; the maintainer may run it again on the head to be merged, depending on the risk of the change), every review thread must be resolved, and a maintainer must approve it.
5. A maintainer merges it with squash.

## Conventions

- **Language.** Commit messages, code comments, identifiers, log and error messages are written in English. The design documents are authoritative in Chinese (`docs/zh-CN/`). The specification and the guide also have an English edition at the same path under `docs/` ([`docs/README.md`](docs/README.md) lists them); the English edition of `docs/zh-CN/process/` and `docs/zh-CN/research/` is pending. When you change a Chinese document that has an English edition, change the English file in the same merge request. Each English file says near its top `Translated from docs/zh-CN/<same path>, updated in the same commit as this file.`; `pnpm docs:translations` checks it. When the Chinese file changes later and the English one does not follow, add a line under it: `The Chinese edition has changed since: …`.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- **Sign off every commit** (`git commit -s`). This is the [Developer Certificate of Origin](https://developercertificate.org/) (DCO): it certifies that you have the right to submit the change under the project license. There is no CLA. Sign off with your real name and the same email as the commit author; CI checks that the sign-off matches the author.
- **AI-assisted contributions.** You may use AI tools. The sign-off is always made by a person, never by a tool, and that person is responsible for the change as if they had written it: they have reviewed it, understand it, and have the right to submit it under the project license. Do not add trailers that attribute the change to an AI tool; the sign-off says who is responsible.
- **Spec first.** A change in behavior updates the spec (`docs/zh-CN/spec/`) in the same merge request; changes that affect how readers understand the system also update the guide (`docs/zh-CN/guide/`). Incompatible changes to the event format, the kernel invariants or the operation contract start with a decision record in `docs/zh-CN/process/decisions/` that is reviewed before the spec and code change.
- **Research ownership.** Technical research belongs in `docs/zh-CN/research/`. Competitor analysis, market and product snapshots, product positioning, pricing and commercial strategy belong in the internal repository, not here. Split mixed reports without maintaining synchronized copies; public design conclusions must be independently supported in this repository, not by internal research. Keep existing technical reports in place and annotate superseded advice or unverified claims during the pre-publication review, without rewriting their conclusions or deleting history.
- **Never commit** secrets, internal addresses, or personal information unrelated to the project.
- **Golden files.** Some texts a model reads (the MCP server's `instructions`, the prompts) are pinned in files under a `__golden__/` directory beside their tests. When you change such a text on purpose, update them with `pnpm exec vitest run <test file> -u` and commit the changed files with the change; reviewers read their diff as the change in wording. With `CI` set (as in CI), a golden file that differs or is missing fails the test; none is written.
- Run `pnpm check` locally on the head you push (type check, lint, tests, dependency rules, doc links, JSON examples) and paste the result in the merge request. CI runs the same scripts after merges and nightly, not on merge requests. A failure on the default branch is fixed with priority.

## Running the tests

- **A run's temporary directory.** Each run of the tests (`pnpm test`, `pnpm check`, `pnpm exec vitest run …`) makes a directory `/tmp/sst-XXXXXX` and points `TMPDIR` into it; the tests make their homes and stores there. When the run ends the directory is removed, whatever the tests left in it is listed, and a process a test left running is stopped and fails the run. What a killed run left is cleared by the next run. To look at what a failed test left, set `SAVESLOT_TEST_KEEP_TMP=1`: the directory is kept and its path printed (the processes are stopped all the same); remove it yourself afterwards.
- **The tests on PostgreSQL.** `pnpm check` runs the tests on PGlite. `pnpm test:postgres` runs the kernel's tests on a real store, and the PostgreSQL backend's own, on a PostgreSQL server; without one, the backend's own tests are skipped in `pnpm check`. Run it when a change touches the storage port, a backend, or SQL the kernel sends:

  ```sh
  SAVESLOT_TEST_POSTGRES_URL=postgres://user[:password]@host[:port]/postgres pnpm test:postgres
  ```

  It fails at once when the variable is not set. Arguments after the script's name go to Vitest (a file, `-t <name>`).
- **Preparing a local PostgreSQL.** The server must be PostgreSQL 18, and the user in the URL must be allowed to create databases. Any installation does, for example Homebrew (`brew install postgresql@18 && brew services start postgresql@18`, then `postgres://$USER@localhost/postgres`) or a container (`docker run -d -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:18`, then `postgres://postgres:test@localhost/postgres`). Each store a test opens is a database of its own, named `sst_h<machine>_r<run>_…`; a run drops its databases when it ends, and those a killed run left on the same machine are dropped by the next run. `<machine>` is a mark made the first time the tests run on a machine and kept in `~/.local/state/saveslot-tests/machine` (under `$XDG_STATE_HOME` when that is set); it is what tells two machines' databases apart on a shared server, so do not copy that file to another machine. Use a server you can afford to fill with such databases, not one that holds data.

## Where to talk

- Bugs, tasks and research: Issues, using the matching template.
- Questions and design discussion: Discussions.
- Security issues: see [`SECURITY.md`](SECURITY.md). Do not open a public issue.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
