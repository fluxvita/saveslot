// Dependency rules from docs/zh-CN/spec/02-architecture.md: §11 (packages) and §4 (kernel modules).
// The allowed edges below are the whole rule set: anything not listed is forbidden.

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
};

/** Kernel module → kernel modules it may import (§4 table "依赖" column). */
const KERNEL_MODULE_DEPS = {
  store: [],
  log: ["store"],
  audit: ["store"],
  flags: ["store"],
  rules: ["store"],
  time: ["store"],
  judge: ["time"],
  derive: ["rules", "log"],
  apply: ["store", "log", "flags", "rules", "time"],
  schema: ["store", "log", "audit", "rules", "time", "apply", "derive"],
  pending: ["store", "log", "apply"],
  write: [
    "store",
    "log",
    "audit",
    "rules",
    "time",
    "judge",
    "apply",
    "derive",
    "schema",
    "pending",
  ],
  read: ["store", "audit", "flags", "rules", "time", "schema", "pending"],
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
  ],
};

/** Node built-ins that carry a transport; the kernel must not depend on any transport (§11). */
const TRANSPORT_MODULES = ["http", "https", "http2", "net", "tls", "dgram"];

const alt = (names) => names.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");

const packageRules = Object.entries(PACKAGE_DEPS).map(([pkg, allowed]) => ({
  name: `package-${pkg}`,
  comment: `${pkg} may only import workspace packages: ${allowed.join(", ") || "(none)"}`,
  severity: "error",
  from: { path: `^packages/${pkg}/` },
  to: { path: `^packages/(?!(?:${alt([pkg, ...allowed])})/)` },
}));

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
