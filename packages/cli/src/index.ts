// The saveslot command line (docs/zh-CN/spec/06-cli.md): the commands other than the service
// ones, which the `daemon` package has; the `saveslot` entry package dispatches between the two.

export { type CliIO, run } from "./run.ts";
