# Governance

saveslot is developed by FluxVita in the open, under [Apache-2.0](LICENSE). This page says who decides
what, and how someone takes part in deciding.

## Roles

- **Contributors** open issues, discussions and pull requests. Anyone can.
- **Maintainers** ([`MAINTAINERS.md`](MAINTAINERS.md)) review and merge pull requests, triage issues and
  discussions, and publish releases (`RELEASING.md`).
- **Lead maintainer**: one of the maintainers, who decides when the maintainers do not agree.

## How changes are decided

- **Ordinary changes** (fixes, features within the spec, docs, tests) are decided in the pull request.
  One maintainer's approval, every review thread resolved and every check passing are enough
  ([`CONTRIBUTING.md`](CONTRIBUTING.md)). A maintainer does not approve their own pull request.
- **Changes to the spec** (`docs/zh-CN/spec/` and `docs/spec/`) are reviewed like code, in the same pull request as the
  behaviour they change.
- **Incompatible changes** to the event format, the kernel invariants or the operation contract start with
  a decision record in `docs/zh-CN/process/decisions/`: the problem, the options, the choice and why.
  It is reviewed in its own pull request and merged before the spec and the code change. A maintainer
  approves it; when maintainers disagree, the lead maintainer decides and the record says so.
- **Product direction and releases** (what a version contains, when it ships) are decided by the
  maintainers; the scope of a version is written in `07-scope-v1.md` of the
  specification (`docs/spec/` and `docs/zh-CN/spec/`).

## Becoming a maintainer

A contributor whose pull requests and reviews over several months show that they know a part of the
code and follow the project's rules can be nominated by a maintainer. The nomination is made in an
issue; it is accepted when no maintainer objects within a week. A maintainer who stops taking part, or
asks to step down, is moved to the emeritus list in `MAINTAINERS.md`.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Reports go to
[opensource@fluxvita.com](mailto:opensource@fluxvita.com) and are handled by the maintainers.

## Changing this document

This document changes by a pull request approved by the lead maintainer.
