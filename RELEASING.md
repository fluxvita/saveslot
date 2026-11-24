# Releasing

How saveslot is versioned and published (docs/zh-CN/spec/02-architecture.md §11 «发布»). Rules only; the
commands are the release workflow (`.github/workflows/release.yml`) and the scripts it calls.

## What is published

`npm install -g @fluxvita/saveslot` installs saveslot. That package and every package it needs at run
time are published to npm under the `@fluxvita` scope: 11 packages, one [Changesets](https://github.com/changesets/changesets)
fixed group (`.changeset/config.json`), always at the same version.

| Package | Published | Why |
| --- | --- | --- |
| `@fluxvita/saveslot` | Yes | The entry: the `saveslot` command. The only package whose interface is promised. |
| `cli`, `daemon` | Yes | The entry depends on them: the command line and the service. |
| `client`, `contract`, `contract-core`, `server`, `service`, `kernel`, `store-pglite`, `store-postgres` | Yes | The command line and the service depend on them. |
| `connector-ts` | No | The connector SDK; nothing the entry needs. Released on its own later. |
| `reference`, `test-backend` | No | Test-only: the reference evaluator and the tests' storage backend. |

Every package but the entry is internal: its README opens by saying so, and its interface may change in
any release. Each package ships only `dist`, without test fixtures and build caches. Dependencies
between them are `workspace:*` in the repository and the exact version when published.
`pnpm check` checks all of this (`releaseProblems` in `scripts/smoke-install.ts`): the fixed group, the
`files`, public access, `repository`, `homepage`, `bugs`, the Node range and the READMEs.

## Versions

- Before 1.0 the version is 0.x. A minor version may change interfaces; it does not make existing data
  unreadable. The event format has a version of its own, independent of the package version
  ([`02-architecture.md` «格式版本、导出、导入与恢复»](docs/zh-CN/spec/02-architecture.md#格式版本导出导入与恢复)).
- Every change a user can notice comes with a changeset (`pnpm changeset`) in the same pull request.
  The changelogs (`packages/*/CHANGELOG.md`) are written by `changeset version` from them, never by hand.
- A release's git tags are on the commit that was published: one per package, as `changeset tag` /
  `changeset publish` make them (`@fluxvita/saveslot@<version>`, `@fluxvita/saveslot-kernel@<version>`,
  …), and one for the whole release, `v<version>` (`v0.1.0-rc.0`, `v0.1.0`).
- Fixes to a minor version that is no longer the latest go on a branch `release/0.<minor>`, made from
  the tag `v0.<minor>.0` when the first such fix is needed. Pull requests still target `main`; a
  maintainer ports a fix to the release branch.

## A release

1. A maintainer opens a pull request `chore(release): <version>` that runs `pnpm changeset version`:
   the versions and the changelogs. It is reviewed and merged like any other.
2. On that push to `main`, the release workflow builds, runs `pnpm smoke:install` (a throwaway local
   registry, an install from it, the installed `saveslot` run), and publishes the versions that are
   not on npm yet with `changeset publish`, as `latest`, with provenance. Then it tags the commit
   `v<version>` and pushes the tags.
3. Only a commit whose full check passed on `main` is released: the release workflow runs after `ci`
   on the same push and stops if it failed.

Nothing is published from a laptop, except the prerelease below. npm provenance needs a public
repository and a GitHub-hosted runner, so it starts with the first release from the public repository.

## Prereleases

- A prerelease is `<version>-rc.<n>` (Changesets pre mode, `changeset pre enter rc`). It is published
  with the dist-tag `next`, never `latest`, and is not supported (see `SECURITY.md`).
- While `.changeset/pre.json` exists the release workflow publishes nothing.
- `0.1.0-rc.0` is published by a maintainer from their own machine, from the commit whose full check
  passed, before the repository is public; it carries no provenance. Afterwards the maintainer tags
  that commit (`pnpm changeset tag`, and `v0.1.0-rc.0`) and checks every package's `next` and `latest`
  (`npm dist-tag ls`).

## Credentials

- Until the first release from the public repository, publishing uses an npm granular access token
  limited to the `@fluxvita` scope, with an expiry of 30 days, held by the maintainers and stored as
  the repository's Actions secret `NPM_TOKEN`, used only by the release workflow.
- After that release, publishing moves to npm trusted publishing (OIDC from the release workflow) and
  the token is revoked.
