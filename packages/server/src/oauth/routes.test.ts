// The authorization server's routes over real HTTP on the loopback, without a database: the two
// metadata documents, every way the token endpoint refuses a request before or around a redemption
// or an exchange, and the revocation endpoint's answers. Redemption, exchange and revocation
// themselves are tested in the service (oauth-server.test.ts, oauth-refresh.test.ts); here the
// store is a stand-in that knows no code and no token. Fictional addresses.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthDeps } from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleOAuth, OAUTH_PATHS, TOKEN_BODY_MAX_BYTES } from "./routes.ts";

const EXT = "https://saveslot.example";
let server: Server;
let base: string;
const logged: Record<string, string | number>[] = [];
const warned: string[] = [];
let failTake = false;
let failRefresh = false;

const deps = {
  external: EXT,
  store: {
    takeCodeForGrant: async () => {
      if (failTake) throw new Error("the database is gone");
      return undefined;
    },
    grantOfCode: async () => undefined,
    pollDeviceCode: async () => undefined,
    refreshToken: async () => {
      if (failRefresh) throw new Error("the database is gone");
      return undefined;
    },
  },
  control: { credential: async () => undefined },
} as unknown as OAuthDeps;

beforeAll(async () => {
  server = createServer((req, res) => {
    handleOAuth(req, res, {
      deps,
      identity: {
        currentUser: async () => undefined,
        beginLogin: async () => ({ kind: "redirect", location: "/account/login" }),
        userState: async () => "active",
        paths: new Set<string>(),
        handle: async () => undefined,
        issueUserSession: async () => {
          throw new Error("the page issues no session");
        },
      },
      remote: () => "127.0.0.1",
      now: () => "2026-11-21T08:00:00.000Z",
      log: (f) => logged.push({ ...f }),
      warn: (event) => warned.push(event),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const form = (o: Record<string, string | string[]>) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
  return f.toString();
};
const post =
  (path: string) =>
  (body: string, type = "application/x-www-form-urlencoded") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
const token = post(OAUTH_PATHS.token);
const revoke = post(OAUTH_PATHS.revoke);
const REFRESH = `slr_${"R".repeat(43)}`;

async function refused(r: Response, status: number, error: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(await r.json()).toMatchObject({ error });
}

describe("metadata", () => {
  it("protected resource (RFC 9728): the external address, the issuer, the four scopes", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.protectedResource}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({
      resource: EXT,
      authorization_servers: [EXT],
      scopes_supported: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
      bearer_methods_supported: ["header"],
    });
  });

  it("under the MCP endpoint's path: the MCP endpoint as the resource", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.protectedResourceMcp}`);
    expect(await r.json()).toMatchObject({ resource: `${EXT}/mcp`, authorization_servers: [EXT] });
  });

  it("authorization server (RFC 8414): code + S256, refresh, revocation, public clients, CIMD, no registration", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.authorizationServer}`);
    const m = (await r.json()) as Record<string, unknown>;
    expect(m).toEqual({
      issuer: EXT,
      authorization_endpoint: `${EXT}/oauth/authorize`,
      token_endpoint: `${EXT}/oauth/token`,
      revocation_endpoint: `${EXT}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      device_authorization_endpoint: `${EXT}/oauth/device`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(m).not.toHaveProperty("registration_endpoint");
  });

  it("only GET and HEAD", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.authorizationServer}`, { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("token endpoint", () => {
  it("only POST", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.token}`);
    expect(r.status).toBe(405);
  });

  it("a body that is not a form: invalid_request", async () => {
    await refused(
      await token(JSON.stringify({ grant_type: "authorization_code" }), "application/json"),
      400,
      "invalid_request",
    );
  });

  it("no grant_type, or two: invalid_request", async () => {
    await refused(await token(form({ code: "x" })), 400, "invalid_request");
    await refused(
      await token(form({ grant_type: ["authorization_code", "authorization_code"] })),
      400,
      "invalid_request",
    );
  });

  it.each(["client_credentials", "password", "urn:x"])(
    "grant_type %s: unsupported_grant_type",
    async (grant_type) => {
      await refused(await token(form({ grant_type })), 400, "unsupported_grant_type");
    },
  );

  it("a body past the limit: invalid_request", async () => {
    const big = form({ grant_type: "authorization_code", code: "x".repeat(TOKEN_BODY_MAX_BYTES) });
    await refused(await token(big), 400, "invalid_request");
  });

  it("a code no one issued: invalid_grant", async () => {
    await refused(
      await token(
        form({
          grant_type: "authorization_code",
          code: "nope",
          code_verifier: "v".repeat(43),
          client_id: "https://client.example/c.json",
          redirect_uri: "https://client.example/cb",
        }),
      ),
      400,
      "invalid_grant",
    );
  });

  it("a refresh token no one issued: invalid_grant; none given: invalid_request", async () => {
    await refused(
      await token(form({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "c" })),
      400,
      "invalid_grant",
    );
    await refused(
      await token(form({ grant_type: "refresh_token", client_id: "c" })),
      400,
      "invalid_request",
    );
  });

  it("a device code no one issued: invalid_grant; another client's poll: invalid_client", async () => {
    const grant_type = "urn:ietf:params:oauth:grant-type:device_code";
    await refused(
      await token(form({ grant_type, device_code: "d".repeat(43), client_id: "saveslot-cli" })),
      400,
      "invalid_grant",
    );
    await refused(
      await token(form({ grant_type, device_code: "d".repeat(43), client_id: "c" })),
      401,
      "invalid_client",
    );
  });

  it("a form field named __proto__ is a field like any other", async () => {
    await refused(
      await token(`grant_type=authorization_code&__proto__=x&constructor=y`),
      400,
      "invalid_request",
    );
  });

  it("an internal error: server_error, nothing of it in the answer", async () => {
    failTake = true;
    try {
      const r = await token(
        form({
          grant_type: "authorization_code",
          code: "c",
          code_verifier: "v".repeat(43),
          client_id: "https://client.example/c.json",
          redirect_uri: "https://client.example/cb",
        }),
      );
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ error: "server_error" });
      expect(text).not.toContain("database");
      expect(warned).toContain("oauth.token_failed");
    } finally {
      failTake = false;
    }
  });
});

describe("revocation endpoint (RFC 7009)", () => {
  it("only POST", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.revoke}`);
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });

  it("a body that is not a form, or past the limit: invalid_request", async () => {
    await refused(
      await revoke(JSON.stringify({ token: REFRESH }), "application/json"),
      400,
      "invalid_request",
    );
    await refused(
      await revoke(form({ token: "x".repeat(TOKEN_BODY_MAX_BYTES), client_id: "c" })),
      400,
      "invalid_request",
    );
  });

  it("no token, or no client_id, or either twice: invalid_request", async () => {
    await refused(await revoke(form({ client_id: "c" })), 400, "invalid_request");
    await refused(await revoke(form({ token: REFRESH })), 400, "invalid_request");
    await refused(
      await revoke(form({ token: [REFRESH, REFRESH], client_id: "c" })),
      400,
      "invalid_request",
    );
  });

  it.each([REFRESH, `slt_${"T".repeat(43)}`, "not a token"])(
    "a token no one issued (%s): 200, an empty body, not stored",
    async (t) => {
      const r = await revoke(form({ token: t, client_id: "c", token_type_hint: "refresh_token" }));
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).toBe("");
    },
  );

  it("an internal error: server_error, nothing of it in the answer", async () => {
    failRefresh = true;
    try {
      const r = await revoke(form({ token: REFRESH, client_id: "c" }));
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ error: "server_error" });
      expect(text).not.toContain("database");
      expect(warned).toContain("oauth.revoke_failed");
    } finally {
      failRefresh = false;
    }
  });
});

describe("device authorization endpoint (RFC 8628)", () => {
  const device = post(OAUTH_PATHS.device);

  it("only POST, a form", async () => {
    expect((await fetch(`${base}${OAUTH_PATHS.device}`)).status).toBe(405);
    await refused(await device("{}", "application/json"), 400, "invalid_request");
  });

  it("the CLI's only: another client is invalid_client; none, or twice, invalid_request", async () => {
    await refused(
      await device(form({ client_id: "https://client.example/c.json" })),
      401,
      "invalid_client",
    );
    await refused(await device(form({})), 400, "invalid_request");
    await refused(
      await device(form({ client_id: ["saveslot-cli", "saveslot-cli"] })),
      400,
      "invalid_request",
    );
  });
});

describe("routing", () => {
  it.each([
    "/oauth/identity/callback",
    "/oauth/other",
    "/.well-known/openid-configuration",
    "/v1/slots",
  ])("%s is not the authorization server's", async (path) => {
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  it("the log has the route, the status and the time, never the form", async () => {
    logged.length = 0;
    await token(form({ grant_type: "authorization_code", code: "secret-code" }));
    expect(logged).toEqual([
      { method: "POST", route: "oauth.token", status: 400, ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(logged)).not.toContain("secret-code");
  });

  it("a revocation is logged by its route, never its token", async () => {
    logged.length = 0;
    await revoke(form({ token: REFRESH, client_id: "c" }));
    expect(logged).toEqual([
      { method: "POST", route: "oauth.revoke", status: 200, ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(logged)).not.toContain(REFRESH);
  });
});
