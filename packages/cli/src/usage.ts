// A command line a command cannot take (06-cli §6.2: exit 2), with the static text that says why.

import type { Static } from "./texts.ts";

export class UsageError extends Error {
  readonly text: Static;
  constructor(text: Static) {
    super(text);
    this.text = text;
  }
}
