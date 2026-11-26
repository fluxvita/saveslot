// The server mode's configuration from the environment (06-cli §4.1 «服务器模式的配置», §6.2).

import { describe, expect, it } from "vitest";
import {
  readServerConfig,
  SERVER_VARIABLES,
  ServerConfigInvalid,
  type ServerConfigProblem,
} from "./server-config.ts";

/** A password no output may hold. */
const SECRET = "pw-7f3a-must-not-show";

const GOOD = {
  SAVESLOT_CONTROL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal:5433/saveslot_control`,
  SAVESLOT_CELL_DATABASE_URL: "postgresql://saveslot@db.internal/postgres?sslmode=require",
  SAVESLOT_PUBLIC_URL: "https://saveslot.example.com",
  SAVESLOT_HANDLE_KEY_FILE: "/run/secrets/saveslot-handle-key",
};

function problems(env: Record<string, string | undefined>): readonly ServerConfigProblem[] {
  try {
    readServerConfig(env);
  } catch (e) {
    if (e instanceof ServerConfigInvalid) return e.problems;
    throw e;
  }
  throw new Error("the configuration was taken");
}

describe("the server mode's configuration", () => {
  it("the four required variables give the configuration; the rest take their defaults", () => {
    expect(readServerConfig(GOOD)).toEqual({
      control: {
        cell: { host: "db.internal", port: 5433, user: "saveslot", password: SECRET },
        database: "saveslot_control",
      },
      cell: {
        host: "db.internal",
        user: "saveslot",
        ssl: { rejectUnauthorized: false },
        maintenanceDatabase: "postgres",
      },
      cellName: "main",
      publicUrl: "https://saveslot.example.com",
      handleKeyFile: "/run/secrets/saveslot-handle-key",
      listen: { host: "127.0.0.1", port: 8080 },
      trustedProxies: [],
      allowedOrigins: [],
      shutdown: { drainSeconds: 10, timeoutSeconds: 30 },
      tenants: { maxOpen: 50, idleSeconds: 300 },
    });
  });

  it("each required variable missing or empty is named, all of them at once, in the table's order", () => {
    expect(problems({})).toEqual(
      SERVER_VARIABLES.slice(0, 4).map((variable) => ({ kind: "missing", variable })),
    );
    expect(problems({ ...GOOD, SAVESLOT_PUBLIC_URL: "" })).toEqual([
      { kind: "missing", variable: "SAVESLOT_PUBLIC_URL" },
    ]);
  });

  it.each([
    ["SAVESLOT_CONTROL_DATABASE_URL", "mysql://saveslot@db/x", "not a postgres:// URL"],
    ["SAVESLOT_CONTROL_DATABASE_URL", "postgres://db.internal/x", "no user"],
    ["SAVESLOT_CONTROL_DATABASE_URL", "postgres://saveslot@db.internal/", "no database name"],
    [
      "SAVESLOT_CONTROL_DATABASE_URL",
      "postgres://saveslot@db.internal/x?sslrootcert=/a",
      "has a parameter other than sslmode",
    ],
    [
      "SAVESLOT_CELL_DATABASE_URL",
      "postgres://saveslot@db.internal/postgres?sslmode=prefer",
      "sslmode is not one of disable, require, verify-full",
    ],
    ["SAVESLOT_PUBLIC_URL", "ftp://saveslot.example.com", "not an https:// URL"],
    [
      "SAVESLOT_PUBLIC_URL",
      "http://saveslot.example.com",
      "http:// is taken on a loopback host only; give https://",
    ],
    [
      "SAVESLOT_PUBLIC_URL",
      "http://10.0.0.5:8080",
      "http:// is taken on a loopback host only; give https://",
    ],
    [
      "SAVESLOT_PUBLIC_URL",
      "https://saveslot.example.com/",
      "has a path, a trailing /, a query or a fragment: give the origin only",
    ],
    [
      "SAVESLOT_PUBLIC_URL",
      "https://saveslot.example.com/base",
      "has a path, a trailing /, a query or a fragment: give the origin only",
    ],
    ["SAVESLOT_HANDLE_KEY_FILE", "keys/handle", "not an absolute path"],
    ["SAVESLOT_LISTEN", "8080", "not <address>:<port>"],
    ["SAVESLOT_LISTEN", "localhost:8080", "the address is not an IP address"],
    ["SAVESLOT_LISTEN", "0.0.0.0:0", "the port is not 1 to 65535"],
    ["SAVESLOT_RATE_LIMIT", "-1", "not an integer of 0 or more"],
    ["SAVESLOT_RATE_BURST", "0", "not a positive integer"],
    ["SAVESLOT_SHUTDOWN_DRAIN", "-1", "not an integer of 0 to 3600"],
    ["SAVESLOT_SHUTDOWN_DRAIN", "1.5", "not an integer of 0 to 3600"],
    ["SAVESLOT_SHUTDOWN_DRAIN", "10s", "not an integer of 0 to 3600"],
    ["SAVESLOT_SHUTDOWN_TIMEOUT", "3601", "not an integer of 0 to 3600"],
    ["SAVESLOT_TENANT_CONNECTIONS", "0", "not an integer of 1 to 10000"],
    ["SAVESLOT_TENANT_CONNECTIONS", "10001", "not an integer of 1 to 10000"],
    ["SAVESLOT_TENANT_IDLE", "0", "not an integer of 1 to 86400"],
    ["SAVESLOT_TENANT_IDLE", "5m", "not an integer of 1 to 86400"],
  ] as const)("%s = %s: %s", (variable, value, what) => {
    expect(problems({ ...GOOD, [variable]: value })).toEqual([
      { kind: "malformed", variable, what },
    ]);
  });

  it("the external login: all three of its variables, or none; some of them names the others missing", () => {
    const external = {
      SAVESLOT_IDENTITY_ISSUER: "https://platform.example",
      SAVESLOT_IDENTITY_LOGIN_URL: "https://platform.example/login",
      SAVESLOT_IDENTITY_KEYS_FILE: "/run/secrets/platform-keys.json",
    };
    expect(readServerConfig({ ...GOOD, ...external }).identity).toEqual({
      issuer: "https://platform.example",
      loginUrl: "https://platform.example/login",
      keysFile: "/run/secrets/platform-keys.json",
    });
    expect(readServerConfig(GOOD).identity).toBeUndefined();
    expect(
      problems({ ...GOOD, SAVESLOT_IDENTITY_ISSUER: external.SAVESLOT_IDENTITY_ISSUER }),
    ).toEqual([
      { kind: "missing", variable: "SAVESLOT_IDENTITY_LOGIN_URL" },
      { kind: "missing", variable: "SAVESLOT_IDENTITY_KEYS_FILE" },
    ]);
    expect(problems({ ...GOOD, ...external, SAVESLOT_IDENTITY_LOGIN_URL: "" })).toEqual([
      { kind: "missing", variable: "SAVESLOT_IDENTITY_LOGIN_URL" },
    ]);
    // Spaces only are not set: alone, the local accounts; with the others, that one is missing.
    expect(readServerConfig({ ...GOOD, SAVESLOT_IDENTITY_ISSUER: "   " }).identity).toBeUndefined();
    expect(problems({ ...GOOD, ...external, SAVESLOT_IDENTITY_ISSUER: " \t " })).toEqual([
      { kind: "missing", variable: "SAVESLOT_IDENTITY_ISSUER" },
    ]);
    expect(
      problems({ ...GOOD, ...external, SAVESLOT_IDENTITY_KEYS_FILE: "keys/platform.json" }),
    ).toEqual([
      {
        kind: "malformed",
        variable: "SAVESLOT_IDENTITY_KEYS_FILE",
        what: "not an absolute path",
      },
    ]);
  });

  it("a problem never holds the value: a password in a URL that is refused does not show", () => {
    const found = problems({
      ...GOOD,
      SAVESLOT_CONTROL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal/x?${SECRET}=1`,
      SAVESLOT_CELL_DATABASE_URL: `mysql://saveslot:${SECRET}@db.internal/postgres`,
    });
    expect(found.map((p) => p.variable)).toEqual([
      "SAVESLOT_CONTROL_DATABASE_URL",
      "SAVESLOT_CELL_DATABASE_URL",
    ]);
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  it("listening on IPv6, trusted proxies, and rate limiting with its burst", () => {
    const c = readServerConfig({
      ...GOOD,
      SAVESLOT_LISTEN: "[::1]:9000",
      SAVESLOT_TRUSTED_PROXIES: " 127.0.0.1 , ::1",
      SAVESLOT_RATE_LIMIT: "120",
    });
    expect(c.listen).toEqual({ host: "::1", port: 9000 });
    expect(c.trustedProxies).toEqual(["127.0.0.1", "::1"]);
    // In the form requests' sources are compared in.
    expect(
      readServerConfig({ ...GOOD, SAVESLOT_TRUSTED_PROXIES: "::FFFF:10.0.0.7,2001:DB8:0:0::1" })
        .trustedProxies,
    ).toEqual(["10.0.0.7", "2001:db8::1"]);
    expect(c.rateLimit).toEqual({ perMinute: 120, burst: 120 });
    expect(
      readServerConfig({ ...GOOD, SAVESLOT_RATE_LIMIT: "60", SAVESLOT_RATE_BURST: "10" }),
    ).toMatchObject({ rateLimit: { perMinute: 60, burst: 10 } });
  });

  it("the shutdown's drain and timeout: seconds, 0 to 3600, 0 meaning no wait", () => {
    expect(
      readServerConfig({ ...GOOD, SAVESLOT_SHUTDOWN_DRAIN: "0", SAVESLOT_SHUTDOWN_TIMEOUT: "3600" })
        .shutdown,
    ).toEqual({ drainSeconds: 0, timeoutSeconds: 3600 });
    expect(readServerConfig({ ...GOOD, SAVESLOT_SHUTDOWN_TIMEOUT: "0" }).shutdown).toEqual({
      drainSeconds: 10,
      timeoutSeconds: 0,
    });
  });

  it("the open tenants: at most SAVESLOT_TENANT_CONNECTIONS at once, closed after SAVESLOT_TENANT_IDLE seconds unused", () => {
    expect(
      readServerConfig({ ...GOOD, SAVESLOT_TENANT_CONNECTIONS: "200", SAVESLOT_TENANT_IDLE: "60" })
        .tenants,
    ).toEqual({ maxOpen: 200, idleSeconds: 60 });
  });

  it("trusted proxies: single addresses and CIDR ranges, each in one written form", () => {
    expect(
      readServerConfig({
        ...GOOD,
        SAVESLOT_TRUSTED_PROXIES:
          " 10.0.0.0/8 , 192.0.2.7/32,2001:DB8::/32, 2001:db8:1::7/128,::ffff:198.51.100.0/120,3fff::/20",
      }).trustedProxies,
    ).toEqual([
      "10.0.0.0/8",
      "192.0.2.7",
      "2001:db8::/32",
      "2001:db8:1::7",
      "198.51.100.0/24",
      "3fff::/20",
    ]);
  });

  const NOT_ADDRESS = "is not an IP address or address/prefix (no port, zone or name)";
  const PREFIX = "has a prefix length that is not a decimal within 0-32 (IPv4) or 0-128 (IPv6)";
  const HOST_BITS = "has bits set past its prefix: write the range's first address";
  const EVERYTHING = "holds every address, so any client could write its own source";
  it.each([
    ["10.0.0.1,,10.0.0.2", "", NOT_ADDRESS],
    ["fe80::1%lo0", "fe80::1%lo0", NOT_ADDRESS],
    ["10.0.0.1:80", "10.0.0.1:80", NOT_ADDRESS],
    ["[::1]", "[::1]", NOT_ADDRESS],
    ["proxy.internal", "proxy.internal", NOT_ADDRESS],
    ["fe80::%en0/64", "fe80::%en0/64", NOT_ADDRESS],
    ["192.0.2.0 /24", "192.0.2.0 /24", NOT_ADDRESS],
    ["192.0.2.0/ 24", "192.0.2.0/ 24", PREFIX],
    ["192.0.2.0/33", "192.0.2.0/33", PREFIX],
    ["2001:db8::/129", "2001:db8::/129", PREFIX],
    ["192.0.2.0/-1", "192.0.2.0/-1", PREFIX],
    ["192.0.2.0/", "192.0.2.0/", PREFIX],
    ["192.0.2.0/08", "192.0.2.0/08", PREFIX],
    ["192.0.2.0/24/24", "192.0.2.0/24/24", PREFIX],
    ["192.0.2.0/+24", "192.0.2.0/+24", PREFIX],
    ["192.0.2.1/24", "192.0.2.1/24", HOST_BITS],
    ["2001:db8::1/64", "2001:db8::1/64", HOST_BITS],
    ["::ffff:192.0.2.0/88", "::ffff:192.0.2.0/88", HOST_BITS],
    ["0.0.0.0/0", "0.0.0.0/0", EVERYTHING],
    ["::/0", "::/0", EVERYTHING],
    ["::ffff:0:0/96", "::ffff:0:0/96", EVERYTHING],
    ["::/80", "::/80", EVERYTHING],
    ["::ff00:0:0/88", "::ff00:0:0/88", EVERYTHING],
    ["::fffe:0:0/95", "::fffe:0:0/95", EVERYTHING],
  ] as const)(
    "SAVESLOT_TRUSTED_PROXIES = %j: refused, naming the entry %j",
    (value, entry, why) => {
      expect(problems({ ...GOOD, SAVESLOT_TRUSTED_PROXIES: value })).toEqual([
        {
          kind: "malformed",
          variable: "SAVESLOT_TRUSTED_PROXIES",
          what: `the entry ${JSON.stringify(entry)} ${why}`,
        },
      ]);
    },
  );

  it("trusted proxies: every entry not taken is named, in order, the good ones not", () => {
    expect(problems({ ...GOOD, SAVESLOT_TRUSTED_PROXIES: "192.0.2.1/24, 10.0.0.1, ::/0" })).toEqual(
      [
        {
          kind: "malformed",
          variable: "SAVESLOT_TRUSTED_PROXIES",
          what: `the entry "192.0.2.1/24" ${HOST_BITS}; the entry "::/0" ${EVERYTHING}`,
        },
      ],
    );
  });

  it("allowed origins: comma-separated, each kept as written; spaces only is none", () => {
    expect(
      readServerConfig({
        ...GOOD,
        SAVESLOT_ALLOWED_ORIGINS: " https://app.example , http://localhost:5173,https://[::1]:8443",
      }).allowedOrigins,
    ).toEqual(["https://app.example", "http://localhost:5173", "https://[::1]:8443"]);
    expect(readServerConfig({ ...GOOD, SAVESLOT_ALLOWED_ORIGINS: "  " }).allowedOrigins).toEqual(
      [],
    );
  });

  it.each([
    ["https://app.example/", "https://app.example/"],
    ["https://app.example/console", "https://app.example/console"],
    ["https://app.example,", ""],
    ["https://app.example,,https://b.example", ""],
    ["https://App.example", "https://App.example"],
    ["https://app.example:443", "https://app.example:443"],
    ["https://app.example:0", "https://app.example:0"],
    ["https://app.example.", "https://app.example."],
    ["https://app.example?x=1", "https://app.example?x=1"],
    ["https://user@app.example", "https://user@app.example"],
    ["https://*.example", "https://*.example"],
    ["app.example", "app.example"],
    ["http://app.example", "http://app.example"],
    ["https://ok.example,null", "null"],
  ])("SAVESLOT_ALLOWED_ORIGINS = %j: refused, naming the entry %j", (value, entry) => {
    expect(problems({ ...GOOD, SAVESLOT_ALLOWED_ORIGINS: value })).toEqual([
      {
        kind: "malformed",
        variable: "SAVESLOT_ALLOWED_ORIGINS",
        what: `the entry ${JSON.stringify(entry)} is not an origin as a browser sends it: https://host[:port] in lower case, no default port, no path or trailing / (http:// on a loopback host only)`,
      },
    ]);
  });

  it("rate limiting at 0 is off, and a burst then means nothing", () => {
    const c = readServerConfig({ ...GOOD, SAVESLOT_RATE_LIMIT: "0", SAVESLOT_RATE_BURST: "5" });
    expect(c).not.toHaveProperty("rateLimit");
  });

  it("a user and password written percent-encoded are taken decoded", () => {
    const c = readServerConfig({
      ...GOOD,
      SAVESLOT_CONTROL_DATABASE_URL: "postgres://save%40slot:p%2Fw%3A1@[::1]:5432/control",
    });
    expect(c.control).toEqual({
      cell: { host: "::1", port: 5432, user: "save@slot", password: "p/w:1" },
      database: "control",
    });
  });

  it.each([
    ["the user", "postgres://save%zz@db.internal/control"],
    ["the password", "postgres://saveslot:p%zz@db.internal/control"],
    ["the database name", "postgres://saveslot@db.internal/con%zz"],
  ])(
    "in %s, a percent sign that is not a percent-escape: refused, naming the variable",
    (_, url) => {
      expect(problems({ ...GOOD, SAVESLOT_CONTROL_DATABASE_URL: url })).toEqual([
        {
          kind: "malformed",
          variable: "SAVESLOT_CONTROL_DATABASE_URL",
          what: "has a % that is not a percent-escape",
        },
      ]);
    },
  );

  it.each([
    "http://127.0.0.1:8080",
    "http://127.8.9.10",
    "http://[::1]:8080",
    "http://localhost:8080",
  ])("%s: http:// on a loopback host is taken, for a local trial", (url) => {
    expect(readServerConfig({ ...GOOD, SAVESLOT_PUBLIC_URL: url }).publicUrl).toBe(url);
  });
});
