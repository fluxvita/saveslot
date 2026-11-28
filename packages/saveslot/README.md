# @fluxvita/saveslot

saveslot is the open-source database all your AI tools share. Tell one agent you ran 5 km; ask another how far
you ran this week. Every value keeps its sources and its history, and the data stays yours.

This package is the `saveslot` command: the command line and the saveslot service. It needs macOS or a Linux with
glibc, and Node 24.22.1 or later on the 24 line, or 26.12.1 or later. musl distributions such as Alpine, `node:alpine`
images included, are not supported yet.

```sh
npm install -g @fluxvita/saveslot
saveslot setup
```

`saveslot setup` creates `~/.saveslot`, starts the service, offers a first slot from a template, and adds saveslot
to the agent hosts it finds. Then ask your agent "what is in saveslot?". The first time, Claude Code asks whether the
agent may use saveslot's tools; allow it. The service writes its log to `~/.saveslot/run/saveslot.log`.

Without a terminal, in a script, nothing can answer the questions: `saveslot setup` asks them only in a terminal, so
give the answers as options, `saveslot setup --yes --template running --host claude-code`. Likewise `claude -p`
cannot ask for the tools, so allow them up front: `claude -p "…" --allowedTools "mcp__saveslot"`.

On Linux, when Node is installed under `/usr/local`, `npm install -g` fails with `EACCES` for a normal user. Give
npm a prefix of your own instead of using `sudo`:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
```

Open a new shell, then run `npm install -g` again.

Install it globally rather than running it with `npx`: `saveslot setup` gives the agent hosts the path of the
installed command, and a path in npx's cache can be removed at any time.

The other `@fluxvita/saveslot-*` packages it installs are internal and are released with it at the same version.
