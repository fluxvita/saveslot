// Which judged steps give a row a new version: kernel's (judge/versions.fixture.ts), the rule the
// scenarios mark `ver.current` by too, so that the two never disagree.

export {
  cellsOf,
  givesVersion,
  seenAsVersions,
  versionsOf,
} from "@fluxvita/saveslot-kernel/testing";
