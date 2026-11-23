# saveslot

English · [简体中文](README.zh-CN.md)

**saveslot is Agent Data Infra: a shared data layer for all of a person's agents.** It tracks things that change over time and keeps the full timeline from the original evidence to the current state. The data belongs to the user and is not tied to any model vendor or agent host.

- **Time is first-class.** A database stores the present; agent memory stores what was said. saveslot stores the timeline of a thing: what it is now, how it got there, and the evidence behind every step.
- **Agents interpret, saveslot enforces.** Understanding intent and turning conversation into structured writes is the agent's job. saveslot only does deterministic checking, recording and execution; its core path does not depend on a model.
- **All state comes from one append-only log.** Every piece of state is either a log event or derived from the log deterministically, so an export is the log, and replaying it on any backend yields the same state.

## Status

saveslot is in **early development**. Local mode (the saveslot service on your own computer, shared by the agents on it) runs end to end from a source checkout. It is not published to npm yet; server mode is under way.

The design documents are currently written in **Simplified Chinese** under [`docs/zh-CN/`](docs/zh-CN/). An English edition will be added under `docs/` before the project is announced.

| Where | What |
|---|---|
| [`docs/zh-CN/guide/`](docs/zh-CN/guide/README.md) | Guide: a narrative introduction, read in order |
| [`docs/zh-CN/spec/`](docs/zh-CN/spec/README.md) | Specification: the authoritative definition of behavior |
| [`docs/zh-CN/process/`](docs/zh-CN/process/README.md) | Design decision records and scenario walkthroughs |
| [`docs/zh-CN/research/`](docs/zh-CN/research/) | Background research |

## Try it (local mode)

You need Node 24.22.1 or later on the 24 line, or 26.12.1 or later.

From a source checkout, until the package is on npm:

```sh
pnpm install && pnpm build
node packages/saveslot/dist/bin.js setup
```

Once it is published:

```sh
npm install -g @fluxvita/saveslot
saveslot setup
```

`saveslot setup` creates `~/.saveslot`, starts the service, offers a first slot from a template, and adds saveslot to the agent hosts it finds (Claude Code, Codex; Cursor and Claude Desktop by a snippet you paste). Then ask your agent "what is in saveslot?".

On Linux, when Node is installed under `/usr/local`, `npm install -g` fails with `EACCES` for a normal user. Give npm a prefix of your own instead of using `sudo`:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
```

Open a new shell, then run `npm install -g` again. The steps in detail: [`docs/zh-CN/spec/06-cli.md`](docs/zh-CN/spec/06-cli.md) §3.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). The name and logo are covered by the [trademark policy](TRADEMARKS.md).
