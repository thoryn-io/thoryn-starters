package io.thoryn.starter;

import static org.springframework.web.util.HtmlUtils.htmlEscape;

import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClient;
import org.springframework.security.oauth2.client.annotation.RegisteredOAuth2AuthorizedClient;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/** Tiny server-rendered pages. Every value is HTML-escaped; tokens stay in the server-side session. */
@RestController
public class PageController {

    private static final Set<String> HIDDEN_CLAIMS = Set.of("nonce", "at_hash", "c_hash", "sid");

    private final RestClient api;

    public PageController(StarterProperties props) {
        this.api = RestClient.builder().baseUrl(props.baseUrl()).build();
    }

    @GetMapping(value = "/", produces = MediaType.TEXT_HTML_VALUE)
    public String home(@AuthenticationPrincipal OidcUser user) {
        if (user != null) {
            return layout("Thoryn starter", "<p>Signed in as <strong>" + htmlEscape(name(user))
                    + "</strong>.</p>\n<p><a href=\"/profile\">Your profile</a></p>");
        }
        return layout("Thoryn starter",
                "<p>A Spring Boot app that signs users in with Thoryn and protects its own API.</p>\n"
                        + "<p><a class=\"button\" href=\"/login\">Sign in with Thoryn</a></p>");
    }

    @GetMapping(value = "/profile", produces = MediaType.TEXT_HTML_VALUE)
    public String profile(@AuthenticationPrincipal OidcUser user,
                          @RegisteredOAuth2AuthorizedClient(SecurityConfig.REGISTRATION_ID) OAuth2AuthorizedClient client,
                          CsrfToken csrf) {
        String claims = new TreeMap<>(user.getClaims()).entrySet().stream()
                .filter(e -> !HIDDEN_CLAIMS.contains(e.getKey()))
                .map(e -> "<tr><th>" + htmlEscape(e.getKey()) + "</th><td>" + htmlEscape(String.valueOf(e.getValue())) + "</td></tr>")
                .collect(Collectors.joining("\n"));
        return layout("Profile",
                "<p class=\"ok\">You are signed in as <strong>" + htmlEscape(name(user)) + "</strong>.</p>\n"
                        + "<h2>ID token claims</h2>\n<table>" + claims + "</table>\n"
                        + "<h2>Protected API</h2>\n<p>The server called <code>GET /api/me</code> with your access token:</p>\n"
                        + "<pre id=\"api-result\">" + htmlEscape(callApi(client)) + "</pre>\n"
                        + "<form method=\"post\" action=\"/logout\">"
                        + "<input type=\"hidden\" name=\"" + htmlEscape(csrf.getParameterName()) + "\" value=\"" + htmlEscape(csrf.getToken()) + "\">"
                        + "<button type=\"submit\">Sign out</button></form>");
    }

    @GetMapping("/signed-out")
    public ResponseEntity<Void> signedOut() {
        return ResponseEntity.status(302).header("Location", "/").build();
    }

    @GetMapping(value = "/health", produces = MediaType.TEXT_PLAIN_VALUE)
    public String health() {
        return "ok";
    }

    /** Call this app's own protected API with the session's access token, as any backend would. */
    private String callApi(OAuth2AuthorizedClient client) {
        try {
            return api.get().uri("/api/me")
                    .headers(h -> h.setBearerAuth(client.getAccessToken().getTokenValue()))
                    .retrieve()
                    .body(String.class);
        } catch (RestClientException e) {
            return "the API call failed: " + e.getClass().getSimpleName();
        }
    }

    private static String name(OidcUser user) {
        return user.getEmail() != null ? user.getEmail() : user.getSubject();
    }

    private static String layout(String title, String body) {
        return """
                <!doctype html>
                <html lang="en">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>%s</title>
                <link rel="stylesheet" href="/style.css">
                </head>
                <body>
                <main>
                <h1>%s</h1>
                %s
                </main>
                </body>
                </html>
                """.formatted(htmlEscape(title), htmlEscape(title), body);
    }
}
