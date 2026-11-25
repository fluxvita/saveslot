# Security policy

English · [简体中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

Report security issues privately through the repository's private vulnerability reporting (on GitHub: the **Security** tab, then **Report a vulnerability**). Do not open a public issue, discussion or pull request for a vulnerability.

Include what you found, how to reproduce it, the affected version or commit, and the impact you expect. We will acknowledge the report, keep you informed while we work on a fix, and credit you in the advisory unless you prefer not to be named.

## Supported versions

saveslot is before 1.0. Security fixes go into a new release of the latest minor version only; upgrade to get them.

| Version | Security fixes |
| --- | --- |
| 0.1.x (latest) | Yes |
| Prereleases (`0.1.0-rc.*`) | No: upgrade to the release |

All `@fluxvita/saveslot-*` packages are released together at the same version as `@fluxvita/saveslot`; the version that counts is that of `@fluxvita/saveslot` (`saveslot --version`).

## Scope

The trust boundaries saveslot does and does not defend are described in [`docs/zh-CN/spec/02-architecture.md`](docs/zh-CN/spec/02-architecture.md) section 10. For example, a program that can read and write the data directory directly is outside the boundary in local mode; that is documented behavior, not a vulnerability.
