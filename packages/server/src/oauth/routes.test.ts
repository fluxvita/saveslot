// The authorization server's routes over real HTTP on the loopback, without a database: the two
// metadata documents, and every way the token endpoint refuses a request before or around a
// redemption. Redemption itself is tested in the service (oauth-server.test.ts); here its store is
// a stand-in that knows no code. Fictional addresses.

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

const deps = {
  external: EXT,
  store: {
    takeCodeForGrant: async () => {
      if (failTake) throw new Error("the database is gone");
      return undefined;
    },
    grantOfCode: async () => undefined,
  },
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
const token = (body: string, type = "application/x-www-form-urlencoded") =>
  fetch(`${base}${OAUTH_PATHS.token}`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });

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

  it("authorization server (RFC 8414): code + S256, public clients, CIMD, no registration", async () => {
    const r = await fetch(`${base}${OAUTH_PATHS.authorizationServer}`);
    const m = (await r.json()) as Record<string, unknown>;
    expect(m).toEqual({
      issuer: EXT,
      authorization_endpoint: `${EXT}/oauth/authorize`,
      token_endpoint: `${EXT}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
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
  async function refused(r: Response, status: number, error: string) {
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ error });
  }

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

  it.each(["refresh_token", "client_credentials", "password", "urn:x"])(
    "grant_type %s: unsupported_grant_type in this version",
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
});
