# saveslot

English · [简体中文](README.zh-CN.md)

[![ci](https://github.com/fluxvita/saveslot/actions/workflows/ci.yml/badge.svg)](https://github.com/fluxvita/saveslot/actions/workflows/ci.yml)

**saveslot is Agent Data Infra: a shared data layer for all of a person's agents.** It tracks things that change over time and keeps the full timeline from the original evidence to the current state. The data belongs to the user and is not tied to any model vendor or agent host.

- **Time is first-class.** A database stores the present; agent memory stores what was said. saveslot stores the timeline of a thing: what it is now, how it got there, and the evidence behind every step.
- **Agents interpret, saveslot enforces.** Understanding intent and turning conversation into structured writes is the agent's job. saveslot only does deterministic checking, recording and execution; its core path does not depend on a model.
- **All state comes from one append-only log.** Every piece of state is either a log event or derived from the log deterministically, so an export is the log, and replaying it on any backend yields the same state.

## Status

The first release, **0.1**, has both modes. In **local mode** the saveslot service runs on your own computer, and the agents on it share it. In **server mode** one saveslot serves all of your devices, hosted or self-hosted, with accounts and sign-in, OAuth authorization, remote MCP, import, and the `saveslot server` operations commands. It writes (add, change, correct, revoke, with conflicts and confirmations), reads (catalog, query, SQL, history, sources), handles pending items, creates slots and changes their schema where no table has to be rebuilt, and exports, imports and verifies the log. Agents reach it through MCP; people through the `saveslot` command.

Not in 0.1 yet, in either mode, coming in later releases: privacy deletion (preview, confirm, undo within 24 hours, physical deletion when due; to undo a wrong value now, revoke it, and the history stays), and schema changes that rebuild a table that has been written to (adding or dropping a field, tightening a constraint, changing precision or unit). Also not wired up yet: `saveslot verify --replay`, changing a slot's policy, and detailed query output. The details: [`docs/spec/07-scope-v1.md`](docs/spec/07-scope-v1.md) section 7.

saveslot is before 1.0: interfaces may change between minor versions.

The guide and the specification are kept in two editions, English under [`docs/`](docs/README.md) and Chinese under [`docs/zh-CN/`](docs/zh-CN/), aligned in meaning: a change to one changes the other in the same pull request, and a difference between them is a defect, to be reported as an issue. The decision records, walkthroughs and research notes are in Chinese only for now; the index lists them.

| Where | What |
|---|---|
| [`docs/guide/`](docs/guide/README.md) | Guide: a narrative introduction, read in order |
| [`docs/spec/`](docs/spec/README.md) | Specification: the authoritative definition of behavior |
| [`docs/`](docs/README.md) | Index of every document in both editions |

## Try it (local mode)

You need Node 24.22.1 or later on the 24 line, or 26.12.1 or later.

```sh
npm install -g @fluxvita/saveslot      # until 0.1.0 is out: @fluxvita/saveslot@next
saveslot setup
```

`saveslot setup` creates `~/.saveslot`, starts the service, offers a first slot from a template, and adds saveslot to the agent hosts it finds (Claude Code, Codex; Cursor and Claude Desktop by a snippet you paste). Pick the `running` template, then tell your agent:

> I ran 5 km this morning in 28 minutes, felt easy.

The first time, Claude Code asks whether the agent may use saveslot's tools; allow it. The agent writes it with the evidence of what you said, and the row is there:

```sh
saveslot query health.runs
saveslot history health.runs r_… --sources    # the row's id from the query: how it got there, with your words as the evidence
```

The service writes its log to `~/.saveslot/run/saveslot.log`.

Without a terminal, in a script, nothing can answer the questions: `saveslot setup` asks them only in a terminal, so give the answers as options, `saveslot setup --yes --template running --host claude-code`. Likewise `claude -p` cannot ask for the tools, so allow them up front: `claude -p "…" --allowedTools "mcp__saveslot"`.

From a source checkout instead: `pnpm install && pnpm build`, then `node packages/saveslot/dist/bin.js setup`.

On Linux, when Node is installed under `/usr/local`, `npm install -g` fails with `EACCES` for a normal user. Give npm a prefix of your own instead of using `sudo`:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
```

Open a new shell, then run `npm install -g` again. The steps in detail: [`docs/spec/06-cli.md`](docs/spec/06-cli.md) §3.

## Getting help and contributing

- Questions: [Discussions](https://github.com/fluxvita/saveslot/discussions); bugs and tasks: [Issues](https://github.com/fluxvita/saveslot/issues). See [`SUPPORT.md`](SUPPORT.md).
- Security issues: privately, as [`SECURITY.md`](SECURITY.md) says.
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Who decides what: [`GOVERNANCE.md`](GOVERNANCE.md). Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). The name and logo are covered by the [trademark policy](TRADEMARKS.md).
