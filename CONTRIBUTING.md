# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

The full contributor guide is [`docs/guide/12-contributing.md`](docs/guide/12-contributing.md) ([中文](docs/zh-CN/guide/12-contributing.md)). This page lists the essentials.

## Workflow

1. Create a branch from `main`. If you cannot push branches to the repository, fork it and create the branch in your fork.
2. Open a pull request against `main` (from your fork, if you used one) and fill in the template. Every pull request targets `main`, also a fix for a version already released: a maintainer cherry-picks it onto that version's release branch (`release/0.<minor>`) once it is merged. Its title is a Conventional Commit and becomes the squash commit's subject; CI checks the title (`feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `perf`, `revert`, `style`; scope in lower case). In the description, say what changes and why, what is left out on purpose, and what you ran; when it settles an issue, write `Closes #<number>` there (not in the title, the branch name or a commit message). Assign the pull request to yourself and give it the labels that fit (`bug`, `enhancement`, `documentation`, `spec`, `research`). Open it as a draft while it is not ready to be reviewed, and mark it ready when it is.
3. Once the branch is pushed, add commits at its end, so that what was reviewed stays as it was. Keep the branch linear, without merge commits. A branch that is only behind `main` needs nothing from you: it is squashed onto `main` as it is. When it conflicts with `main`, or `pnpm check` no longer passes on top of the latest `main`, rebase it onto the latest `main` yourself, run `pnpm check` on that head, push it with `git push --force-with-lease`, and say so in the pull request (the old head, the new head, and how each conflict was resolved). That is the one case in which a pushed branch is rewritten. The maintainer does not resolve conflicts on your branch.
4. Answer every review thread: say in which commit a point was addressed, or why you see it otherwise. The reviewer who opened a thread resolves it, not the author. After each push, say in a line or two on the pull request what changed. A push after an approval withdraws the approval, and the pull request is reviewed again.
5. A check that fails is read, not run again until it passes: fix it when it is your change; when you take it to be unrelated, say so on the pull request with the failing test, its seed and its assertion as printed.
6. To be merged, every check CI runs on the pull request must pass (the title, sign-off, secrets and forbidden terms, and `pnpm check`), every review thread must be resolved, and a maintainer other than the author must approve it.
7. A maintainer merges it with squash; the commit on `main` carries the pull request's title and its number. Do not merge your own pull request, and do not push to `main` or to a release branch: both are refused.

## Conventions

- **Language.** Commit messages, code comments, identifiers, log and error messages are written in English. The design documents are authoritative in Chinese (`docs/zh-CN/`). The specification and the guide also have an English edition at the same path under `docs/` ([`docs/README.md`](docs/README.md) lists them); the English edition of `docs/zh-CN/process/` and `docs/zh-CN/research/` is pending. When you change a Chinese document that has an English edition, change the English file in the same pull request. Each English file says near its top `Translated from docs/zh-CN/<same path>, updated in the same commit as this file.`; `pnpm docs:translations` checks it. When the Chinese file changes later and the English one does not follow, add a line under it: `The Chinese edition has changed since: …`. In an English document, link the English edition of a page that has one; the same check fails on a link to its Chinese edition.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(kernel): …`, `fix(cli): …`, `docs(spec): …`.
- **Sign off every commit** (`git commit -s`). This is the [Developer Certificate of Origin](https://developercertificate.org/) (DCO): it certifies that you have the right to submit the change under the project license. There is no CLA. Sign off with your real name and the same email as the commit author; CI checks that the sign-off matches the author.
- **AI-assisted contributions.** You may use AI tools. The sign-off is always made by a person, never by a tool, and that person is responsible for the change as if they had written it: they have reviewed it, understand it, and have the right to submit it under the project license. Do not add trailers that attribute the change to an AI tool; the sign-off says who is responsible.
- **Spec first.** A change in behavior updates the spec (`docs/zh-CN/spec/`) in the same pull request; changes that affect how readers understand the system also update the guide (`docs/zh-CN/guide/`). Incompatible changes to the event format, the kernel invariants or the operation contract start with a decision record in `docs/zh-CN/process/decisions/` that is reviewed before the spec and code change.
- **Spec references.** Code comments refer to the specification by a file and a title in `«»`, as the Chinese edition has it: `05-time «挡点»`. A title is a heading, a bold item or a table row's name of that file. Quote running text in plain quotation marks, not `«»`, and only words the named file has. `pnpm docs:spec-refs` checks every reference; it does not check quotations.
- **Research ownership.** Technical research belongs in `docs/zh-CN/research/`. Competitor analysis, market and product snapshots, product positioning, pricing and commercial strategy belong in the internal repository, not here. Split mixed reports without maintaining synchronized copies; public design conclusions must be independently supported in this repository, not by internal research. Keep existing technical reports in place and annotate superseded advice or unverified claims during the pre-publication review, without rewriting their conclusions or deleting history.
- **Never commit** secrets, internal addresses, or personal information unrelated to the project.
- **Golden files.** Some texts a model reads (the MCP server's `instructions`, the prompts) are pinned in files under a `__golden__/` directory beside their tests. When you change such a text on purpose, update them with `pnpm exec vitest run <test file> -u` and commit the changed files with the change; reviewers read their diff as the change in wording. With `CI` set (as in CI), a golden file that differs or is missing fails the test; none is written.
- Run `pnpm check` locally before you push (type check, lint, tests, dependency rules, doc links, JSON examples, the English documents' source lines, the claims index, the code's references to the specification, merge conflict markers). CI runs the same scripts on every pull request, and on `main` after merges and nightly, with Node 26 LTS and the PostgreSQL tests in addition. The property soak runs nightly on its own and opens an issue for each test it finds failing. A failure on `main` is fixed with priority.

## Running the tests

- **A run's temporary directory.** Each run of the tests (`pnpm test`, `pnpm check`, `pnpm exec vitest run …`) makes a directory `/tmp/sst-XXXXXX` and points `TMPDIR` into it; the tests make their homes and stores there. When the run ends the directory is removed, whatever the tests left in it is listed, and a process a test left running is stopped and fails the run. What a killed run left is cleared by the next run. To look at what a failed test left, set `SAVESLOT_TEST_KEEP_TMP=1`: the directory is kept and its path printed (the processes are stopped all the same); remove it yourself afterwards.
- **The tests on PostgreSQL.** `pnpm check` runs the tests on PGlite. `pnpm test:postgres` runs the kernel's tests on a real store, and the PostgreSQL backend's own, on a PostgreSQL server; without one, the backend's own tests are skipped in `pnpm check`. Run it when a change touches the storage port, a backend, or SQL the kernel sends:

  ```sh
  SAVESLOT_TEST_POSTGRES_URL=postgres://user[:password]@host[:port]/postgres pnpm test:postgres
  ```

  It fails at once when the variable is not set. Arguments after the script's name go to Vitest (a file, `-t <name>`).
- **Preparing a local PostgreSQL.** The server must be PostgreSQL 18, and the user in the URL must be allowed to create databases. Any installation does, for example Homebrew (`brew install postgresql@18 && brew services start postgresql@18`, then `postgres://$USER@localhost/postgres`) or a container (`docker run -d -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:18`, then `postgres://postgres:test@localhost/postgres`). Each store a test opens is a database of its own, named `sst_h<machine>_r<run>_…`; a run drops its databases when it ends, and those a killed run left on the same machine are dropped by the next run. `<machine>` is a mark made the first time the tests run on a machine and kept in `~/.local/state/saveslot-tests/machine` (under `$XDG_STATE_HOME` when that is set); it is what tells two machines' databases apart on a shared server, so do not copy that file to another machine. Use a server you can afford to fill with such databases, not one that holds data.

## Where to talk

- Bugs, tasks and research: Issues, using the matching template. Search for an open one on the same matter first.
- Questions and design discussion: Discussions.
- Security issues: see [`SECURITY.md`](SECURITY.md). Do not open a public issue.

Before the project went public, its issues and changes were tracked on an internal server. Since the move to GitHub (2026-11-26) that tracker is read-only: issues, discussion and patches all come here, a patch as a pull request against `main`.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
