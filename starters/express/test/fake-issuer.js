// A minimal in-process OpenID provider for the unit tests: discovery, JWKS, authorize bookkeeping and a
// token endpoint that really checks PKCE. Tokens are signed like the platform signs them (ES256, access
// token typ at+jwt with aud = [issuer] and a client_id claim).
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export async function startFakeIssuer({ clientId, envPath = "/dev" } = {}) {
  const ec = await generateKeyPair("ES256", { extractable: true });
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const ecJwk = { ...(await exportJWK(ec.publicKey)), kid: "ec-1", alg: "ES256", use: "sig" };
  // Published too, so a test can prove the app refuses a validly signed RS256 token (algorithm pinning).
  const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: "rsa-1", alg: "RS256", use: "sig" };
  const codes = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === `${envPath}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/oauth2/authorize`,
        token_endpoint: `${fake.issuer}/oauth2/token`,
        jwks_uri: `${fake.issuer}/oauth2/jwks`,
        end_session_endpoint: `${fake.issuer}/connect/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === `${envPath}/oauth2/jwks`) return json(200, { keys: [ecJwk, rsaJwk] });
    if (url.pathname === `${envPath}/oauth2/token` && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!grant || grant.challenge !== challenge || form.get("client_id") !== clientId) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, {
        token_type: "Bearer",
        expires_in: 300,
        id_token: await fake.idToken({ nonce: grant.nonce }),
        access_token: await fake.accessToken(),
      });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const fake = {
    issuer: `http://127.0.0.1:${server.address().port}${envPath}`,
    /** Record what /oauth2/authorize would have seen; returns the code the browser would bring back. */
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const code = randomUUID();
      codes.set(code, { challenge: u.searchParams.get("code_challenge"), nonce: u.searchParams.get("nonce") });
      return { code, state: u.searchParams.get("state") };
    },
    /** Set to "RS256" to make the token endpoint sign ID tokens with the wrong algorithm. */
    idTokenAlg: "ES256",
    async idToken({ nonce, ...extra } = {}) {
      const rs = fake.idTokenAlg === "RS256";
      return new SignJWT({ email: "ada@example.com", nonce, ...extra })
        .setProtectedHeader({ alg: fake.idTokenAlg, kid: rs ? "rsa-1" : "ec-1", typ: "JWT" })
        .setIssuer(fake.issuer).setAudience(clientId).setSubject("user-1")
        .setIssuedAt().setExpirationTime("5m").sign(rs ? rsa.privateKey : ec.privateKey);
    },
    async accessToken({ alg = "ES256", typ = "at+jwt", iss = fake.issuer, aud = [fake.issuer], exp = "5m", claims = {} } = {}) {
      const key = alg === "RS256" ? rsa.privateKey : ec.privateKey;
      return new SignJWT({ client_id: clientId, scope: "openid profile email", ...claims })
        .setProtectedHeader({ alg, kid: alg === "RS256" ? "rsa-1" : "ec-1", typ })
        .setIssuer(iss).setAudience(aud).setSubject("user-1").setJti(randomUUID())
        .setIssuedAt().setExpirationTime(exp).sign(key);
    },
    close: () => new Promise((r) => server.close(r)),
  };
  return fake;
}
