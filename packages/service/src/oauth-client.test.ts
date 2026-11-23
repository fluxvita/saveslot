// Client documents (CIMD) and the built-in CLI client, without a database: the client ID's form,
// every way a document is refused, and how long one is cached. Fictional clients.

import { describe, expect, it } from "vitest";
import {
  CLIENT_CACHE_MAX_SECONDS,
  CLIENT_CACHE_MIN_SECONDS,
  CLIENT_DOCUMENT_MAX_BYTES,
  ClientError,
  clientCacheSeconds,
  clientFromDocument,
  clientIdUrl,
} from "./oauth-client.ts";

const ID = "https://client.example/oauth/client.json";
const doc = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));
const good = {
  client_id: ID,
  client_name: "Example Agent",
  redirect_uris: ["https://client.example/callback"],
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ClientError) return e.code;
    throw e;
  }
  return undefined;
}

describe("client ID", () => {
  it("an HTTPS URL with a host and a path", () => {
    expect(clientIdUrl(ID).hostname).toBe("client.example");
  });

  it.each([
    ["http", "http://client.example/c.json"],
    ["no path", "https://client.example"],
    ["root path", "https://client.example/"],
    ["fragment", "https://client.example/c.json#x"],
    ["empty fragment", "https://client.example/c.json#"],
    ["user information", "https://u:p@client.example/c.json"],
    ["dot segment", "https://client.example/a/../c.json"],
    ["not as written (normalised)", "https://CLIENT.example/c.json"],
    ["not a URL", "client.example/c.json"],
    ["control character", "https://client.example/c\u0007.json"],
    ["too long", `https://client.example/${"a".repeat(2048)}`],
    ["empty", ""],
  ])("refused: %s", (_, id) => {
    expect(code(() => clientIdUrl(id))).toBe("client_id_malformed");
  });
});

describe("client document", () => {
  it("a good one gives the client, its name and its host", () => {
    expect(clientFromDocument(ID, doc(good))).toEqual({
      id: ID,
      name: "Example Agent",
      host: "client.example",
      redirectUris: ["https://client.example/callback"],
      builtIn: false,
    });
  });

  it("no usable client_name: the host stands for it", () => {
    for (const client_name of [undefined, "", "  ", "a\nb", "x".repeat(201), 7]) {
      expect(clientFromDocument(ID, doc({ ...good, client_name })).name).toBe("client.example");
    }
  });

  it("a client is public when it prefers none or lists none among its methods", () => {
    // The shape a hosted chat product's document has: the singular field is only a preference.
    const signs = {
      ...good,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ],
      response_types: ["code"],
      jwks_uri: "https://client.example/oauth/jwks.json",
    };
    expect(clientFromDocument(ID, doc(signs)).id).toBe(ID);
    // Either one is enough: none preferred, or none in the list.
    for (const either of [
      { token_endpoint_auth_method: "none" },
      {
        token_endpoint_auth_method: "none",
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
      },
      { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { token_endpoint_auth_methods_supported: [] },
    ]) {
      expect(clientFromDocument(ID, doc({ ...good, ...either })).id).toBe(ID);
    }
  });

  it("native redirects: loopback, localhost and a reverse-domain scheme are taken", () => {
    const uris = [
      "http://127.0.0.1:33418/callback",
      "http://[::1]/cb",
      "http://localhost:8080/callback",
      "com.example.agent:/oauth/callback",
    ];
    expect(clientFromDocument(ID, doc({ ...good, redirect_uris: uris })).redirectUris).toEqual(
      uris,
    );
  });

  it.each<[string, Record<string, unknown> | Uint8Array, string]>([
    ["not JSON", new TextEncoder().encode("{"), "document_malformed"],
    ["not UTF-8", new Uint8Array([0x7b, 0xff, 0x7d]), "document_malformed"],
    ["not an object", doc([good] as never), "document_malformed"],
    ["too large", new Uint8Array(CLIENT_DOCUMENT_MAX_BYTES + 1).fill(0x20), "document_too_large"],
    ["client_id one character off", { ...good, client_id: `${ID}x` }, "client_id_mismatch"],
    ["client_id missing", { ...good, client_id: undefined }, "client_id_mismatch"],
    ["no redirect_uris", { ...good, redirect_uris: undefined }, "redirect_uris_missing"],
    ["empty redirect_uris", { ...good, redirect_uris: [] }, "redirect_uris_missing"],
    ["a redirect URI not a string", { ...good, redirect_uris: [7] }, "redirect_uri_malformed"],
    [
      "a redirect URI with a fragment",
      { ...good, redirect_uris: ["https://client.example/cb#x"] },
      "redirect_uri_malformed",
    ],
    [
      "plain HTTP off the loopback",
      { ...good, redirect_uris: ["http://client.example/cb"] },
      "redirect_uri_malformed",
    ],
    ["javascript:", { ...good, redirect_uris: ["javascript:alert(1)"] }, "redirect_uri_malformed"],
    [
      "a scheme without a dot",
      { ...good, redirect_uris: ["agent:/callback"] },
      "redirect_uri_malformed",
    ],
    [
      "21 redirect URIs",
      { ...good, redirect_uris: Array.from({ length: 21 }, (_, i) => `https://c.example/${i}`) },
      "redirect_uri_malformed",
    ],
    [
      "a confidential client",
      { ...good, token_endpoint_auth_method: "client_secret_basic" },
      "auth_method_unsupported",
    ],
    [
      "a client that can only sign a JWT",
      {
        ...good,
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
      },
      "auth_method_unsupported",
    ],
    [
      "a client that prefers a signed JWT and lists nothing",
      { ...good, token_endpoint_auth_method: "private_key_jwt" },
      "auth_method_unsupported",
    ],
    [
      "the methods not a list",
      { ...good, token_endpoint_auth_methods_supported: "none" },
      "document_malformed",
    ],
    [
      "the methods a list with something not a string",
      { ...good, token_endpoint_auth_methods_supported: ["none", 7] },
      "document_malformed",
    ],
    [
      "the methods null",
      { ...good, token_endpoint_auth_methods_supported: null },
      "document_malformed",
    ],
    [
      "no authorization code grant",
      { ...good, grant_types: ["client_credentials"] },
      "grant_type_unsupported",
    ],
    ["no code response", { ...good, response_types: ["token"] }, "grant_type_unsupported"],
  ])("refused: %s", (_, body, expected) => {
    expect(code(() => clientFromDocument(ID, body instanceof Uint8Array ? body : doc(body)))).toBe(
      expected,
    );
  });

  it("a client ID that is not a document URL is refused before the document is read", () => {
    expect(code(() => clientFromDocument("http://client.example/c.json", doc(good)))).toBe(
      "client_id_malformed",
    );
  });
});

describe("cache lifetime", () => {
  it.each<[string | undefined, number]>([
    [undefined, CLIENT_CACHE_MIN_SECONDS],
    ["", CLIENT_CACHE_MIN_SECONDS],
    ["public", CLIENT_CACHE_MIN_SECONDS],
    ["max-age=1", CLIENT_CACHE_MIN_SECONDS],
    ["max-age=3600", 3600],
    ["public, Max-Age=7200", 7200],
    ["max-age=10000000", CLIENT_CACHE_MAX_SECONDS],
    ["max-age=3600, no-store", CLIENT_CACHE_MIN_SECONDS],
    ["no-cache", CLIENT_CACHE_MIN_SECONDS],
    ["max-age=-5", CLIENT_CACHE_MIN_SECONDS],
    ["max-age=abc", CLIENT_CACHE_MIN_SECONDS],
  ])("Cache-Control %j: %i seconds", (header, seconds) => {
    expect(clientCacheSeconds(header)).toBe(seconds);
  });
});
