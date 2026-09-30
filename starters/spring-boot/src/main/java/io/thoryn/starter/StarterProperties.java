package io.thoryn.starter;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Everything the app needs from Thoryn, bound from the environment (see application.yml).
 *
 * @param issuer   the sandbox issuer, resolved at run time by {@code .thoryn/app-env.mjs} (OIDC_ISSUER)
 * @param clientId this app's client id (OIDC_CLIENT_ID)
 * @param audience the audience the API requires (OIDC_AUDIENCE); defaults to the issuer, which Thoryn
 *                 lists in every access token's {@code aud} (RFC 9068 §2.2)
 * @param baseUrl  where the app is reachable (APP_BASE_URL). Redirect URIs are built from this configured
 *                 value, never from the request's Host header.
 */
@ConfigurationProperties("starter")
public record StarterProperties(String issuer, String clientId, String audience, String baseUrl) {

    public StarterProperties {
        issuer = trimSlash(require(issuer, "OIDC_ISSUER"));
        clientId = require(clientId, "OIDC_CLIENT_ID");
        audience = audience == null || audience.isBlank() ? issuer : audience.trim();
        baseUrl = trimSlash(require(baseUrl, "APP_BASE_URL"));
    }

    private static String require(String value, String env) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(env + " is not set. Provision the sandbox and write .env first: "
                    + "thoryn provision apply --file .thoryn/provision.yaml && node .thoryn/app-env.mjs --write .env");
        }
        return value.trim();
    }

    private static String trimSlash(String url) {
        return url.replaceAll("/+$", "");
    }
}
