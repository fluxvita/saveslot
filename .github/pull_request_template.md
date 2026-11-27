<!--
Title: a Conventional Commit, e.g. `feat(kernel): add the write path`. It becomes the squash commit's subject.
See CONTRIBUTING.md before opening. Delete the hints you do not need.
-->

## Summary

<!-- What changes and why, in a few bullets. Link the issue: "Closes #123". -->

Closes #

## Scope

<!-- What is in this request and what is deliberately left out (follow-ups). -->

## Spec and docs

<!-- Behaviour changes update the spec (docs/zh-CN/spec/ and docs/spec/) in this request; reader-facing changes update the guide (docs/zh-CN/guide/ and docs/guide/). Incompatible changes to the event format, the kernel invariants or the operation contract need an approved decision record first. -->

- [ ] No behaviour change, or the spec is updated in this request
- [ ] The guide is updated where readers' understanding changes
- [ ] A change users, integrators or operators can notice adds a changeset (`pnpm changeset`), or the description has a line `No changeset: <reason>`

## Validation

<!-- Paste the tail of the output. Say plainly what was not actually run (for example steps that need root or another machine). -->

- [ ] `pnpm check` passes locally on the head of this pull request (CI runs it again)
- [ ] Every commit is signed off by its author (`pnpm dco`)

## Review focus

<!-- Where reviewers should look hardest; questions you want answered. -->
