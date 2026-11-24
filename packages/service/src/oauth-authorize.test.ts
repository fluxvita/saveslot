// Authorization requests without a database: PKCE on RFC 7636's own example, the audience, and
// the fixed order of the checks — refused on a page (never redirected) until the client and its
// redirect URI pass, refused back to the client with `state` after. Fictional clients.

import { describe, expect, it } from "vitest";
import {
  audienceOf,
  checkAuthorizationRequest,
  pkceMatches,
  redirectWith,
} from "./oauth-authorize.ts";
import { ClientError, type OAuthClient } from "./oauth-client.ts";

const EXT = "https://saveslot.example";
const ID = "https://client.example/oauth/client.json";
const CLIENT: OAuthClient = {
  id: ID,
  name: "Example Agent",
  host: "client.example",
  redirectUris: ["https://client.example/callback", "http://127.0.0.1:4000/cb"],
  builtIn: false,
};
// RFC 7636 Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const base = {
  client_id: ID,
  redirect_uri: "https://client.example/callback",
  response_type: "code",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "st-1",
};

async function check(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) query.append(k, x);
  }
  return checkAuthorizationRequest({
    query,
    external: EXT,
    resolveClient: async (id) => {
      if (id === ID) return CLIENT;
      throw new ClientError("fetch_failed", "client: not found");
    },
  });
}

/** The error a refusal sends back, and its state and issuer. */
function sentBack(r: Awaited<ReturnType<typeof check>>) {
  expect(r).toMatchObject({ kind: "redirect" });
  const u = new URL((r as { to: string }).to);
  return {
    at: `${u.origin}${u.pathname}`,
    error: u.searchParams.get("error"),
    state: u.searchParams.get("state"),
    iss: u.searchParams.get("iss"),
  };
}

describe("PKCE", () => {
  it("RFC 7636 Appendix B's verifier matches its challenge", () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
  });

  it("one character off, the verifier as the challenge, or too short: no match", () => {
    expect(pkceMatches(`${VERIFIER.slice(0, -1)}l`, CHALLENGE)).toBe(false);
    expect(pkceMatches(CHALLENGE, CHALLENGE)).toBe(false);
    expect(pkceMatches("short", CHALLENGE)).toBe(false);
    expect(pkceMatches(VERIFIER, "short")).toBe(false);
  });
});

describe("audience", () => {
  it("the external address, its MCP and its HTTP endpoint name it; nothing else does", () => {
    for (const r of [EXT, `${EXT}/mcp`, `${EXT}/v1`]) expect(audienceOf(r, EXT)).toBe(EXT);
    for (const r of [`${EXT}/`, `${EXT}/mcp/`, "https://other.example", `${EXT}.evil`]) {
      expect(audienceOf(r, EXT)).toBeUndefined();
    }
  });
});

describe("authorization request", () => {
  it("a good request passes, with no scopes when none were asked for", async () => {
    expect(await check(base)).toEqual({
      client: CLIENT,
      redirectUri: base.redirect_uri,
      state: "st-1",
      codeChallenge: CHALLENGE,
      resource: EXT,
    });
  });

  it("scopes asked for come in the contract's order; a resource naming the MCP endpoint", async () => {
    expect(
      await check({ ...base, scope: "saveslot.write saveslot.read", resource: `${EXT}/mcp` }),
    ).toMatchObject({ scopes: ["saveslot.read", "saveslot.write"], resource: EXT });
  });

  describe("refused on a page, never redirected", () => {
    it.each<[string, Record<string, string | string[] | undefined>, unknown]>([
      ["no client_id", { ...base, client_id: undefined }, { reason: "client" }],
      ["client_id twice", { ...base, client_id: [ID, ID] }, { reason: "client" }],
      [
        "a client whose document fails",
        { ...base, client_id: "https://other.example/c.json" },
        { reason: "client", client: "fetch_failed" },
      ],
      ["no redirect_uri", { ...base, redirect_uri: undefined }, { reason: "redirect_uri" }],
      [
        "redirect_uri one character off",
        { ...base, redirect_uri: "https://client.example/callbacK" },
        { reason: "redirect_uri" },
      ],
      [
        "redirect_uri with a query added",
        { ...base, redirect_uri: "https://client.example/callback?x=1" },
        { reason: "redirect_uri" },
      ],
      [
        "redirect_uri twice",
        { ...base, redirect_uri: [base.redirect_uri, base.redirect_uri] },
        { reason: "redirect_uri" },
      ],
      // The redirect check comes first: a bad response type is not sent to an unchecked URI.
      [
        "a bad redirect_uri and a bad response_type",
        { ...base, redirect_uri: "https://evil.example/cb", response_type: "token" },
        { reason: "redirect_uri" },
      ],
    ])("%s", async (_, params, refusal) => {
      expect(await check(params)).toEqual({ kind: "page", ...(refusal as object) });
    });
  });

  it("a listed loopback IP redirect: any port", async () => {
    expect(await check({ ...base, redirect_uri: "http://127.0.0.1:51234/cb" })).toMatchObject({
      redirectUri: "http://127.0.0.1:51234/cb",
    });
    expect(await check({ ...base, redirect_uri: "http://127.0.0.1:51234/other" })).toEqual({
      kind: "page",
      reason: "redirect_uri",
    });
    // With user information: not the listed one, though it would end up at the loopback.
    for (const uri of ["http://user:pw@127.0.0.1:9/cb", "http://user@127.0.0.1:4000/cb"]) {
      expect(await check({ ...base, redirect_uri: uri })).toEqual({
        kind: "page",
        reason: "redirect_uri",
      });
    }
  });

  describe("a listed localhost redirect: any port, as a loopback IP literal's", () => {
    const LOCAL: OAuthClient = {
      ...CLIENT,
      id: "https://local.example/client.json",
      redirectUris: ["http://localhost/callback"],
    };
    const local = (redirect_uri: string) =>
      checkAuthorizationRequest({
        query: new URLSearchParams({ ...base, client_id: LOCAL.id, redirect_uri }),
        external: EXT,
        resolveClient: async () => LOCAL,
      });
    it.each(["http://localhost:58520/callback", "http://LOCALHOST:1/callback"])(
      "taken: %s",
      async (redirect_uri) => {
        expect(await local(redirect_uri)).toMatchObject({ redirectUri: redirect_uri });
      },
    );
    it.each([
      // localhost and an IP literal do not stand for each other, either way.
      "http://127.0.0.1:58520/callback",
      "http://foo.localhost:58520/callback",
      "http://localhost.:58520/callback",
      "http://a@localhost:1/callback",
      "https://localhost:58520/callback",
      "http://localhost:58520/other",
      "http://localhost:58520/callback?x=1",
    ])("refused without a redirect: %s", async (redirect_uri) => {
      expect(await local(redirect_uri)).toEqual({ kind: "page", reason: "redirect_uri" });
    });
    it("a listed IP literal does not take localhost", async () => {
      expect(await check({ ...base, redirect_uri: "http://localhost:4000/cb" })).toEqual({
        kind: "page",
        reason: "redirect_uri",
      });
    });
  });

  describe("the CLI: a loopback IP literal at /callback, any port", () => {
    const cli = { ...base, client_id: "saveslot-cli" };
    it.each(["http://127.0.0.1:49152/callback", "http://[::1]:8000/callback"])(
      "taken: %s",
      async (redirect_uri) => {
        expect(await check({ ...cli, redirect_uri })).toMatchObject({
          client: { id: "saveslot-cli", builtIn: true },
          redirectUri: redirect_uri,
        });
      },
    );
    it.each([
      // RFC 8252 §8.3: `localhost` may resolve elsewhere.
      "http://localhost:49152/callback",
      "https://127.0.0.1:49152/callback",
      "http://127.0.0.1:49152/other",
      "http://127.0.0.1:49152/callback?x=1",
      "http://192.168.1.2:49152/callback",
    ])("refused without a redirect: %s", async (redirect_uri) => {
      expect(await check({ ...cli, redirect_uri })).toEqual({
        kind: "page",
        reason: "redirect_uri",
      });
    });
    it("asks for no scopes: whatever it sends, a user session has them all", async () => {
      const r = await check({ ...cli, redirect_uri: "http://127.0.0.1:1/callback", scope: "x" });
      expect(r).not.toHaveProperty("scopes");
      expect(r).not.toHaveProperty("kind");
    });
  });

  describe("refused back to the client, with state and issuer", () => {
    it.each<[string, Record<string, string | string[] | undefined>, string]>([
      ["no response_type", { ...base, response_type: undefined }, "invalid_request"],
      ["response_type token", { ...base, response_type: "token" }, "unsupported_response_type"],
      ["no code_challenge", { ...base, code_challenge: undefined }, "invalid_request"],
      ["no method (plain)", { ...base, code_challenge_method: undefined }, "invalid_request"],
      ["method plain", { ...base, code_challenge_method: "plain" }, "invalid_request"],
      ["a challenge too short", { ...base, code_challenge: "abc" }, "invalid_request"],
      ["an unknown scope", { ...base, scope: "saveslot.read saveslot.admin" }, "invalid_scope"],
      ["an empty scope", { ...base, scope: " " }, "invalid_scope"],
      ["scope twice", { ...base, scope: ["saveslot.read", "saveslot.read"] }, "invalid_scope"],
      ["another resource", { ...base, resource: "https://other.example" }, "invalid_target"],
      ["resource twice", { ...base, resource: [EXT, EXT] }, "invalid_target"],
    ])("%s", async (_, params, error) => {
      expect(sentBack(await check(params))).toEqual({
        at: "https://client.example/callback",
        error,
        state: "st-1",
        iss: EXT,
      });
    });

    it("state twice: invalid_request, sent back without a state", async () => {
      expect(sentBack(await check({ ...base, state: ["a", "b"] }))).toMatchObject({
        error: "invalid_request",
        state: null,
      });
    });
  });

  it("a redirect keeps the query the redirect URI had", () => {
    expect(redirectWith("https://c.example/cb?x=1", { code: "c", state: undefined })).toBe(
      "https://c.example/cb?x=1&code=c",
    );
  });
});
