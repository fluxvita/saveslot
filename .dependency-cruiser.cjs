// Dependency rules from docs/zh-CN/spec/02-architecture.md: §11 (packages) and §4 (kernel modules).
// The allowed edges below are the whole rule set: anything not listed is forbidden.
//
// `reference` is the reference evaluator (§11 «测试矩阵»): a test oracle that must not depend on
// the kernel's judging code. It may import only contract-core, and only test files may import it.

/** Package → workspace packages it may import (§11 table "依赖" column). */
const PACKAGE_DEPS = {
  "contract-core": [],
  kernel: ["contract-core"],
  "store-pglite": ["kernel"],
  "store-postgres": ["kernel"],
  contract: ["contract-core"],
  service: ["kernel", "contract"],
  server: ["service", "contract"],
  daemon: ["server", "service", "store-pglite", "store-postgres"],
  client: ["contract"],
  cli: ["client"],
  saveslot: ["cli", "daemon"],
  reference: ["contract-core"],
  // The backend tests open their stores with: either of the two (§11 «测试矩阵»).
  "test-backend": ["kernel", "store-pglite", "store-postgres"],
  // The TypeScript connector SDK is a caller of the service over HTTP, like a script: it imports no package.
  "connector-ts": [],
};

/**
 * Package → workspace packages its test files may import besides: the connector SDK's tests start
 * the real local service and call it over its socket.
 */
const TEST_DEPS = {
  "connector-ts": ["daemon", "service", "store-pglite"],
};

/** Test-only packages: any test file may import them, no other file may. */
const TEST_ONLY_PACKAGES = ["reference", "test-backend"];
/** Test files, and the fixtures only tests import. */
const TEST_FILE = "\\.(test|fixture)\\.ts$";

/** Kernel module → kernel modules it may import (§4 table "依赖" column). */
const KERNEL_MODULE_DEPS = {
  store: [],
  values: [],
  log: ["store"],
  audit: ["store"],
  flags: ["store"],
  rules: ["store"],
  request: ["schema", "time", "values"],
  time: ["store"],
  delta: ["store"],
  judge: ["time", "delta"],
  derive: ["rules", "log", "delta"],
  apply: ["store", "log", "flags", "rules", "time", "values"],
  schema: ["store", "log", "audit", "rules", "time", "apply", "derive", "values"],
  pending: ["store", "log", "apply"],
  write: [
    "request",
    "store",
    "log",
    "audit",
    "rules",
    "time",
    "judge",
    "delta",
    "apply",
    "derive",
    "schema",
    "pending",
  ],
  read: ["store", "audit", "flags", "rules", "time", "schema", "pending", "request", "delta"],
  delete: ["store", "log", "rules", "time", "judge", "apply", "derive", "schema", "pending"],
  jobs: ["write", "schema", "pending", "apply"],
  sync: ["log", "write", "apply"],
  maintenance: ["store", "log", "audit", "schema", "delete"],
  ops: [
    "store",
    "log",
    "audit",
    "flags",
    "rules",
    "time",
    "judge",
    "derive",
    "apply",
    "schema",
    "pending",
    "write",
    "read",
    "delete",
    "jobs",
    "sync",
    "maintenance",
    "values",
  ],
};

/** Node built-ins that carry a transport; the kernel must not depend on any transport (§11). */
const TRANSPORT_MODULES = ["http", "https", "http2", "net", "tls", "dgram"];

const alt = (names) => names.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");

const packageRule = (name, pkg, allowed, from) => ({
  name,
  comment: `${pkg} may only import workspace packages: ${allowed.join(", ") || "(none)"}`,
  severity: "error",
  from,
  to: {
    path: `^packages/(?!(?:${alt([pkg, ...allowed])})/)`,
    // Test-only packages are covered by the "test-only-package" rule instead.
    pathNot: `^packages/(?:${alt(TEST_ONLY_PACKAGES)})/`,
  },
});

const packageRules = Object.entries(PACKAGE_DEPS).flatMap(([pkg, allowed]) => {
  const tests = TEST_DEPS[pkg];
  if (tests === undefined) {
    return [packageRule(`package-${pkg}`, pkg, allowed, { path: `^packages/${pkg}/` })];
  }
  return [
    packageRule(`package-${pkg}`, pkg, allowed, { path: `^packages/${pkg}/`, pathNot: TEST_FILE }),
    packageRule(`package-${pkg}-tests`, pkg, [...allowed, ...tests], {
      path: `^packages/${pkg}/.*${TEST_FILE}`,
    }),
  ];
});

const kernelModuleRules = Object.entries(KERNEL_MODULE_DEPS).map(([mod, allowed]) => ({
  name: `kernel-module-${mod}`,
  comment: `kernel/${mod} may only import kernel modules: ${allowed.join(", ") || "(none)"}`,
  severity: "error",
  from: { path: `^packages/kernel/src/${mod}/` },
  to: {
    path: "^packages/kernel/src/[^/]+/",
    pathNot: `^packages/kernel/src/(?:${alt([mod, ...allowed])})/`,
  },
}));

module.exports = {
  forbidden: [
    ...packageRules,
    ...kernelModuleRules,
    {
      name: "test-only-package",
      comment: `Only test files may import ${TEST_ONLY_PACKAGES.join(", ")} (§11 «测试矩阵»)`,
      severity: "error",
      from: {
        path: "^packages/",
        pathNot: [`^packages/(?:${alt(TEST_ONLY_PACKAGES)})/`, TEST_FILE],
      },
      to: { path: `^packages/(?:${alt(TEST_ONLY_PACKAGES)})/` },
    },
    {
      name: "fixture-only-in-tests",
      comment: "A fixture (*.fixture.ts) serves tests: only test files and fixtures may import it",
      severity: "error",
      from: { path: "^packages/", pathNot: [TEST_FILE] },
      to: { path: "\\.fixture\\.ts$" },
    },
    {
      name: "kernel-unknown-module",
      comment:
        "Every directory under kernel/src must be a module listed in §4, so that the module rules cover it",
      severity: "error",
      from: { path: "^packages/kernel/src/" },
      to: {
        path: "^packages/kernel/src/[^/]+/",
        pathNot: `^packages/kernel/src/(?:${alt(Object.keys(KERNEL_MODULE_DEPS))})/`,
      },
    },
    {
      name: "kernel-module-no-root",
      comment:
        "Files in a kernel module must not import files at the kernel/src root (including the package entry, by path or by package name): a root file could forward to any module and bypass the module rules",
      severity: "error",
      from: { path: "^packages/kernel/src/[^/]+/" },
      to: { path: "^packages/kernel/src/[^/]+$" },
    },
    {
      name: "kernel-no-transport",
      comment: "The kernel does not depend on any transport (§11)",
      severity: "error",
      from: { path: "^packages/kernel/" },
      to: { dependencyTypes: ["core"], path: `^(?:node:)?(?:${alt(TRANSPORT_MODULES)})$` },
    },
    {
      name: "no-undeclared-dependency",
      comment: "Imports of packages must be declared in the importing package's package.json",
      severity: "error",
      from: { path: "^packages/" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)dist/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      // Resolve workspace packages to their sources so the rules see real package paths.
      conditionNames: ["source", "import", "default"],
      exportsFields: ["exports"],
      mainFields: ["module", "main", "types"],
      extensions: [".ts", ".js"],
    },
  },
};
