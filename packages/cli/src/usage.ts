// A command line a command cannot take (06-cli §6.2: exit 2), with the static text that says why.

import type { Static } from "./texts.ts";

export class UsageError extends Error {
  readonly text: Static;
  constructor(text: Static) {
    super(text);
    this.text = text;
  }
}

/** A command that did not do what it would (06-cli §6.2: exit 8): declined, or no one to ask. */
export class NotDone extends Error {
  readonly text: Static;
  constructor(text: Static) {
    super(text);
    this.text = text;
  }
}

/** A command that ran and did not get done (06-cli §6.2): its exit code, and what to say why. */
export class Failed extends Error {
  readonly text: Static;
  readonly exit: number;
  constructor(text: Static, exit: number) {
    super(text);
    this.text = text;
    this.exit = exit;
  }
}
