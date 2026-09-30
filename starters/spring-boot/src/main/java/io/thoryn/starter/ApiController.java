package io.thoryn.starter;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The protected API. Only reached with a valid access token (see SecurityConfig#accessTokenDecoder). */
@RestController
public class ApiController {

    @GetMapping("/api/me")
    public Map<String, Object> me(@AuthenticationPrincipal Jwt token) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sub", token.getSubject());
        body.put("client_id", token.getClaimAsString("client_id"));
        body.put("scope", token.getClaimAsString("scope"));
        body.put("iss", token.getIssuer() == null ? null : token.getIssuer().toString());
        body.put("exp", token.getExpiresAt());
        return body;
    }
}
