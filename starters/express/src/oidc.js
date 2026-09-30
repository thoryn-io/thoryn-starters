// OpenID Connect relying party: authorization code + PKCE (S256) with state and nonce, ID token validated
// by openid-client (signature pinned to ES256, iss, aud, exp, nonce). Public client: no secret.
import * as oidc from "openid-client";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Discovery happens once, on first use, so the app starts even while the issuer is unreachable. */
export function createOidc(config) {
  let pending = null;
  const discover = () => {
    pending ??= (async () => {
      const issuerUrl = new URL(config.issuer);
      const options = {};
      // http is refused except for a loopback issuer (a platform running on your own machine, or a test).
      if (issuerUrl.protocol === "http:" && LOOPBACK.has(issuerUrl.hostname)) options.execute = [oidc.allowInsecureRequests];
      return oidc.discovery(issuerUrl, config.clientId, { id_token_signed_response_alg: "ES256" }, oidc.None(), options);
    })().catch((e) => {
      pending = null; // retry on the next request
      throw e;
    });
    return pending;
  };

  const redirectUri = `${config.baseUrl}/callback`;
  const postLogoutRedirectUri = `${config.baseUrl}/signed-out`;

  return {
    discover,
    redirectUri,

    async authorizationRequest() {
      const client = await discover();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: redirectUri,
        scope: config.scope,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { url: url.href, codeVerifier, state, nonce };
    },

    async completeAuthorization(currentUrl, { codeVerifier, state, nonce }) {
      const client = await discover();
      const tokens = await oidc.authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      return { claims: tokens.claims(), idToken: tokens.id_token, accessToken: tokens.access_token };
    },

    async endSessionUrl(idToken) {
      const client = await discover();
      if (!client.serverMetadata().end_session_endpoint) return null;
      return oidc.buildEndSessionUrl(client, { id_token_hint: idToken, post_logout_redirect_uri: postLogoutRedirectUri }).href;
    },

    async jwksUri() {
      const uri = (await discover()).serverMetadata().jwks_uri;
      if (!uri) throw new Error("the issuer's discovery document has no jwks_uri");
      return uri;
    },
  };
}
