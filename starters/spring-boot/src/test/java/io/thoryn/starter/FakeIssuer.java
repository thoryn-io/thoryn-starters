package io.thoryn.starter;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * A minimal in-process OpenID provider for the tests: discovery, JWKS, authorize bookkeeping and a token
 * endpoint that really checks PKCE. Tokens are signed the way the platform signs them (ES256; access token
 * typ at+jwt with aud = [issuer] and a client_id claim). An RSA key is published too, so a test can prove
 * that a validly signed RS256 token is still refused.
 */
final class FakeIssuer implements AutoCloseable {

    record Grant(String challenge, String nonce) {}

    private final HttpServer server;
    private final ECKey ec;
    private final RSAKey rsa;
    private final String clientId;
    private final Map<String, Grant> codes = new ConcurrentHashMap<>();
    final String issuer;

    FakeIssuer(String clientId) throws Exception {
        this.clientId = clientId;
        this.ec = new ECKeyGenerator(Curve.P_256).keyID("ec-1").generate();
        this.rsa = new RSAKeyGenerator(2048).keyID("rsa-1").generate();
        this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        this.issuer = "http://127.0.0.1:" + server.getAddress().getPort() + "/dev";
        server.createContext("/dev/.well-known/openid-configuration", ex -> json(ex, 200, """
                {"issuer":"%1$s","authorization_endpoint":"%1$s/oauth2/authorize","token_endpoint":"%1$s/oauth2/token",
                 "jwks_uri":"%1$s/oauth2/jwks","end_session_endpoint":"%1$s/connect/logout",
                 "response_types_supported":["code"],"subject_types_supported":["public"],
                 "id_token_signing_alg_values_supported":["ES256"],"code_challenge_methods_supported":["S256"]}
                """.formatted(issuer)));
        server.createContext("/dev/oauth2/jwks", ex -> json(ex, 200,
                new JWKSet(List.of(ec.toPublicJWK(), rsa.toPublicJWK())).toString()));
        server.createContext("/dev/oauth2/token", this::token);
        server.start();
    }

    /** Record what /oauth2/authorize would have seen; returns {code, state} for the callback. */
    String[] authorize(String authorizeUrl) {
        var params = UriComponentsBuilder.fromUriString(authorizeUrl).build().getQueryParams();
        String code = UUID.randomUUID().toString();
        codes.put(code, new Grant(decode(params.getFirst("code_challenge")), decode(params.getFirst("nonce"))));
        return new String[] {code, decode(params.getFirst("state"))};
    }

    String idToken(String nonce, JWSAlgorithm alg) throws Exception {
        var claims = new JWTClaimsSet.Builder().issuer(issuer).audience(clientId).subject("user-1")
                .claim("email", "ada@example.com").claim("nonce", nonce)
                .issueTime(new Date()).expirationTime(Date.from(Instant.now().plusSeconds(300))).build();
        return sign(claims, alg, JOSEObjectType.JWT);
    }

    String accessToken(JWSAlgorithm alg, JOSEObjectType typ, String iss, List<String> aud, Instant exp, String client)
            throws Exception {
        var claims = new JWTClaimsSet.Builder().issuer(iss).audience(aud).subject("user-1")
                .claim("client_id", client).claim("scope", "openid profile email").jwtID(UUID.randomUUID().toString())
                .issueTime(new Date()).expirationTime(Date.from(exp)).build();
        return sign(claims, alg, typ);
    }

    String validAccessToken() throws Exception {
        return accessToken(JWSAlgorithm.ES256, new JOSEObjectType("at+jwt"), issuer, List.of(issuer),
                Instant.now().plusSeconds(300), clientId);
    }

    private String sign(JWTClaimsSet claims, JWSAlgorithm alg, JOSEObjectType typ) throws Exception {
        boolean rs = JWSAlgorithm.RS256.equals(alg);
        var jwt = new SignedJWT(new JWSHeader.Builder(alg).keyID(rs ? "rsa-1" : "ec-1").type(typ).build(), claims);
        jwt.sign(rs ? new RSASSASigner(rsa) : new ECDSASigner(ec));
        return jwt.serialize();
    }

    /** Set to RS256 to make the token endpoint sign ID tokens with the wrong algorithm. */
    volatile JWSAlgorithm idTokenAlg = JWSAlgorithm.ES256;

    private void token(HttpExchange ex) throws IOException {
        Map<String, String> form = Arrays.stream(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8).split("&"))
                .map(kv -> kv.split("=", 2))
                .collect(Collectors.toMap(kv -> decode(kv[0]), kv -> kv.length > 1 ? decode(kv[1]) : ""));
        Grant grant = codes.remove(form.getOrDefault("code", ""));
        try {
            String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(form.getOrDefault("code_verifier", "").getBytes(StandardCharsets.US_ASCII)));
            if (grant == null || !grant.challenge().equals(challenge) || !clientId.equals(form.get("client_id"))) {
                json(ex, 400, "{\"error\":\"invalid_grant\"}");
                return;
            }
            json(ex, 200, "{\"token_type\":\"Bearer\",\"expires_in\":300,\"scope\":\"openid profile email\",\"id_token\":\""
                    + idToken(grant.nonce(), idTokenAlg) + "\",\"access_token\":\"" + validAccessToken() + "\"}");
        } catch (Exception e) {
            json(ex, 500, "{\"error\":\"server_error\"}");
        }
    }

    private static void json(HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        ex.getResponseBody().write(bytes);
        ex.close();
    }

    private static String decode(String s) {
        return s == null ? null : URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
