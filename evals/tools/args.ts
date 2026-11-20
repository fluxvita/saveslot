// The runner's command line (./fixture.ts): `<variant.yaml> <run directory> [--fixture-only]
// [--today YYYY-MM-DD]`, the options anywhere. Only a `--today` given takes the word after it.

export type RunnerArgs =
  | {
      readonly file: string;
      readonly dir: string;
      readonly fixtureOnly: boolean;
      readonly today: string | undefined;
    }
  | { readonly error: string };

export const USAGE =
  "usage: fixture.ts <variant.yaml> <run directory> [--fixture-only] [--today YYYY-MM-DD]";

export function runnerArgs(args: readonly string[]): RunnerArgs {
  const todayAt = args.indexOf("--today");
  const today = todayAt >= 0 ? args[todayAt + 1] : undefined;
  if (todayAt >= 0 && (today === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(today))) {
    return { error: "--today takes a day, YYYY-MM-DD" };
  }
  // The word after `--today` is its value only when `--today` was given.
  const words = args.filter((a, i) => !a.startsWith("--") && !(todayAt >= 0 && i === todayAt + 1));
  const [file, dir, ...extra] = words;
  if (file === undefined || dir === undefined || extra.length > 0) return { error: USAGE };
  return { file, dir, fixtureOnly: args.includes("--fixture-only"), today };
}
