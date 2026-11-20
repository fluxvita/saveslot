// The lowest Node this saveslot runs on, as `engines` says it in every package.json
// (`>=24.22.1 <25 || >=26.12.1`). Below it, V8's JSON.parse can misread a one-escape object key
// once a key of one backslash has been parsed in the same process (fixed by V8 commit
// 93cd21e8254b, backported in Node 24.22.1 and 26.12.1). `saveslot doctor` fails such a runtime;
// the service still starts on one, and says so in its log.

/** What `engines` says, written for a person. */
export const NODE_FLOOR_TEXT = "24.22.1 or later on the 24 line, or 26.12.1 or later";

/** Whether Node `version` (`process.versions.node`, as `24.22.3`) is one `engines` allows. */
export function nodeSupported(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  /** This version at or after `minor.patch` of its own line. */
  const from = (lowMinor: number, lowPatch: number) =>
    minor > lowMinor || (minor === lowMinor && patch >= lowPatch);
  if (major === 24) return from(22, 1);
  if (major === 26) return from(12, 1);
  return major > 26;
}
