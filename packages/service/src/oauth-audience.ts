// The audience of a token issued by an authorization (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»;
// RFC 8707): it is good only for the address it was issued for, the external address configured
// then. Checked once a credential is found and not expired, before its tenant is opened.
// Credentials issued without an authorization (static tokens) have no audience to check.

import type { OAuthStore } from "./oauth-store.ts";
import type { CheckCredential } from "./server-auth.ts";

/**
 * The audience check of the server mode: a credential of a grant is `invalid` when the grant is
 * gone, or was issued for another address than `external`.
 */
export function checkAudience(oauth: OAuthStore, external: string): CheckCredential {
  return async (credential) => {
    if (credential.grant === undefined) return "ok";
    const grant = await oauth.grant(credential.grant);
    return grant !== undefined && grant.resource === external ? "ok" : "invalid";
  };
}
