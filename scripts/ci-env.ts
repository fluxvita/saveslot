// What a check script needs to know about the CI run it is in. The checks are package.json scripts
// and do not depend on the CI platform: the workflow (.github/workflows/ci.yml) hands them the
// pull request's base commit and title, and whether the forbidden-terms list must be there, as
// SAVESLOT_CI_BASE, SAVESLOT_CI_TITLE and SAVESLOT_CI_TERMS_REQUIRED.

export interface CiEnv {
  /** The commit a pull request is based on: its commits are base..HEAD. */
  readonly base: string | undefined;
  /** The pull request's title. */
  readonly title: string | undefined;
  /**
   * The forbidden-terms list must be there: the project's own runs. A fork's pull request runs
   * without the repository's secrets, so the workflow says false there.
   */
  readonly termsRequired: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

export function ciEnv(env: Env): CiEnv {
  const base = env["SAVESLOT_CI_BASE"];
  const required = env["SAVESLOT_CI_TERMS_REQUIRED"];
  return {
    base: base === "" ? undefined : base,
    // A title may be empty and still be a title to check (and refuse).
    title: env["SAVESLOT_CI_TITLE"],
    termsRequired: required === "true" || required === "1",
  };
}
