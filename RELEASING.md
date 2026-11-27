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

The server mode is also published as a container image, `ghcr.io/fluxvita/saveslot:<version>` (see
"Container image").

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
  `pnpm changesets:check` checks a pull request for it: a `fix`, `feat` or `perf` that changes a
  file under `src/` of a published package, other than a test, adds a changeset, or its description
  has a line `No changeset: <reason>`. It reads the pull request from `SAVESLOT_CI_BASE`,
  `SAVESLOT_CI_TITLE` and `SAVESLOT_CI_BODY`.
- A release's git tags are on the commit that was published, a commit of the release branch (see
  "Branches"): one per package, as `changeset tag` / `changeset publish` make them
  (`@fluxvita/saveslot@<version>`, `@fluxvita/saveslot-kernel@<version>`, …), and one for the whole
  release, `v<version>` (`v0.1.0-rc.0`, `v0.1.0`).

## Branches

- `main` is the development line of the next version. Every pull request targets `main`, those of
  outside contributors too.
- `release/0.<minor>` is the release branch of a minor version. It is made from `main` when that
  minor version enters the last stretch before its release, and from then on takes only fixes and the
  documentation and CI changes the release needs, no new features.
- `main` first, then the release branch: a change that has to be in a release branch is merged into
  `main` as usual, and a maintainer cherry-picks that squash commit onto the release branch
  (`git cherry-pick -x`, so that the message names the original commit). No pull request targets a
  release branch, and nothing is developed on one.
- Versions are released from the release branch: `v0.<minor>.0`, its patch versions and its
  prereleases (rc). Their tags are on commits of that branch.
- Release branches are protected: only maintainers merge into them or cherry-pick onto them, force
  pushes are refused, and they are not deleted.

## A release

1. The two editions of the documents are brought in line first. `pnpm docs:translations` lists
   the documents whose other edition changed after them (a warning, not a failure), and
   `git grep -l -e "The Chinese edition has changed since" -e "英文版此后有改动" -- docs` the ones
   marked as behind. Each is brought in line in a pull request to `main`, with that line removed,
   and cherry-picked onto the release branch, until both lists are empty on the release branch.
2. The version is set on the release branch. First, `pnpm exec changeset status --verbose` there
   must compute every package's next version from the last version released: if it starts from an
   older one, the previous release was not brought back to `main` (step 5), and that is done first.
   Then a maintainer adds the commit `chore(release): <version>` there, which runs
   `pnpm changeset version`: the versions and the changelogs. Before the first release of a minor
   version it also leaves Changesets pre mode (`changeset pre exit`). This commit is the one made on
   the release branch itself: until the release there is nothing in it for `main`.
3. On that push to the release branch, the release workflow builds, runs `pnpm smoke:install` (a
   throwaway local registry, an install from it, the installed `saveslot` run), and publishes the
   versions that are not on npm yet with `changeset publish`, as `latest`, with provenance. Then it
   tags the commit `v<version>` and pushes the tags, and has the container image of that commit
   built and pushed as `<version>` and `latest` (see "Container image").
4. Only a commit whose `ci` passed on the release branch is released: the release workflow runs after
   `ci` on the same push and stops if it failed. The property soak is not part of `ci`: it is a
   search, run nightly on `main` and by hand (`.github/workflows/soak.yml`), and what it finds is
   opened as issues labelled `soak`. Before the version commit (step 2) the maintainer runs the soak
   by hand on the release branch, reads its result and the open `soak` issues, and the release notes
   list the ones still open.
5. After the release the maintainer brings the release commit to `main` in a pull request (the
   versions, the changelogs, and the changesets it used up), so that the next version on `main` starts
   from the released one. The same pull request moves the default image version in
   `deploy/compose.yaml` (`SAVESLOT_VERSION`) to the released one. A release is not finished until
   this pull request is merged.
6. Once the versions are published (the same condition as for the container image), the release
   workflow points `next` at the release for every published package (`changeset publish` moves
   only `latest`, so `next` would stay on the last prerelease and `@next` would be older than
   `@latest`), and creates the GitHub Release for `v<version>`, its notes gathered from the
   version's section of the packages' changelogs.
7. The maintainer checks both: `npm dist-tag ls @fluxvita/saveslot` shows `next` and `latest` on
   the version, and the Release is there. What the workflow did not do, the maintainer does by hand:

   ```sh
   v=<version>
   for p in saveslot saveslot-cli saveslot-client saveslot-contract saveslot-contract-core \
            saveslot-daemon saveslot-kernel saveslot-server saveslot-service \
            saveslot-store-pglite saveslot-store-postgres; do
     npm dist-tag add "@fluxvita/$p@$v" next
   done
   gh release create "v$v" --verify-tag --title "v$v" --notes-file <notes> --latest
   ```

Nothing is published from a laptop, except the prerelease below. npm provenance needs a public
repository and a GitHub-hosted runner, so it starts with the first release from the public repository.

## Container image

The server mode's image is built from `deploy/Dockerfile` with the repository root as the context
(as `deploy/build-image.sh` does) and published to the GitHub container registry:
`ghcr.io/fluxvita/saveslot:<version>`, one tag for `linux/amd64` and `linux/arm64`, with a provenance
attestation. `<version>` is the entry package's version at the commit built. The image workflow
(`.github/workflows/image.yml`) does it:

- On pull requests and on pushes to `main` and release branches it builds both platforms and pushes
  nothing.
- After the release workflow has published a release to npm, it builds the published commit and
  pushes it as `<version>` and `latest`.
- By hand (`workflow_dispatch`), for a git tag `v<version>`: to publish a prerelease's image, or to
  retry a release's. The tag must name the entry package's version at that commit. `latest` is added
  only when asked, and never to a prerelease.

The image holds no credential; the workflow pushes with its own token, scoped to the job
(`packages: write`).

## Prereleases

- A prerelease is `<version>-rc.<n>` (Changesets pre mode, `changeset pre enter rc`). It is published
  with the dist-tag `next`, never `latest`, and is not supported (see `SECURITY.md`). Like a release,
  it is made from the release branch and tagged there.
- While `.changeset/pre.json` exists the release workflow publishes nothing.
- `0.1.0-rc.0` is published by a maintainer from their own machine, from the commit whose full check
  passed, before the repository is public; it carries no provenance. Afterwards the maintainer tags
  that commit (`pnpm changeset tag`, and `v0.1.0-rc.0`) and checks every package's `next` and `latest`
  (`npm dist-tag ls`). Its container image is pushed by hand from that tag (see "Container image"),
  without `latest`.

## Credentials

- Until the first release from the public repository, publishing uses an npm granular access token
  limited to the `@fluxvita` scope, with an expiry of 30 days, held by the maintainers and stored as
  the repository's Actions secret `NPM_TOKEN`, used only by the release workflow.
- After that release, publishing moves to npm trusted publishing (OIDC from the release workflow) and
  the token is revoked.
