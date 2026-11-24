// Test helpers of the daemon for other packages' tests (saveslot's setup tests): what `init`
// makes a home's tenant storage with. The entry names the source only, and fixture files are
// left out of the published package (package.json `files`); only tests may import it.

export { useInitBackendForTests } from "./init-backend.ts";
