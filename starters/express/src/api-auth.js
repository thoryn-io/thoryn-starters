// The protected API accepts only an OAuth 2.0 JWT access token (RFC 9068) issued by this app's sandbox to
// this app: ES256 signature from the issuer's JWKS, `typ` at+jwt (so an ID token is refused), `iss`, `aud`,
// `exp`/`nbf`, and `client_id`. Anything else is 401 with a Bearer challenge (RFC 6750 §3).
import { createRemoteJWKSet, jwtVerify } from "jose";

export function createAccessTokenVerifier({ issuer, audience, clientId, jwksUri }) {
  let jwks = null;
  const keys = async () => (jwks ??= createRemoteJWKSet(new URL(await jwksUri())));

  return async function verify(token) {
    const { payload } = await jwtVerify(token, await keys(), {
      algorithms: ["ES256"],
      typ: "at+jwt",
      issuer,
      audience,
      clockTolerance: 30,
      requiredClaims: ["sub", "exp", "client_id"],
    });
    if (payload.client_id !== clientId) throw new Error("token was issued to another client");
    return payload;
  };
}

export function requireBearer(verify) {
  return async (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
    if (!match) {
      res.set("WWW-Authenticate", 'Bearer realm="api"');
      return res.status(401).json({ error: "invalid_request", error_description: "Bearer access token required" });
    }
    try {
      req.accessToken = await verify(match[1]);
      return next();
    } catch {
      // Never echo the token or the failure detail back to the caller.
      res.set("WWW-Authenticate", 'Bearer realm="api", error="invalid_token"');
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}
