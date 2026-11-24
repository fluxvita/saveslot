# @fluxvita/saveslot

saveslot is a shared data layer for all of your agents: it records things that change over time and keeps the
full history, from the original evidence to the current state.

This package is the `saveslot` command: the command line and the saveslot service. It needs Node 24.22.1 or later
on the 24 line, or 26.12.1 or later.

```sh
npm install -g @fluxvita/saveslot
saveslot setup
```

`saveslot setup` creates `~/.saveslot`, starts the service, offers a first slot from a template, and adds saveslot
to the agent hosts it finds. Then ask your agent "what is in saveslot?".

On Linux, when Node is installed under `/usr/local`, `npm install -g` fails with `EACCES` for a normal user. Give
npm a prefix of your own instead of using `sudo`:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
```

Open a new shell, then run `npm install -g` again.

The other `@fluxvita/saveslot-*` packages it installs are internal and are released with it at the same version.
