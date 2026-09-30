package io.thoryn.starter;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * The whole app against an in-process fake issuer: the code flow with PKCE, the profile page's call to the
 * protected API, logout, and every way the API must refuse a token.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT)
class StarterApplicationTests {

    static final String CLIENT_ID = "app-starter-test";
    static final FakeIssuer FAKE;
    static final int PORT;
    static final String BASE;

    static {
        try {
            FAKE = new FakeIssuer(CLIENT_ID);
            try (var socket = new ServerSocket(0)) {
                PORT = socket.getLocalPort();
            }
            BASE = "http://127.0.0.1:" + PORT;
        } catch (Exception e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("OIDC_ISSUER", () -> FAKE.issuer);
        r.add("OIDC_CLIENT_ID", () -> CLIENT_ID);
        r.add("server.port", () -> PORT);
        r.add("APP_BASE_URL", () -> BASE);
    }

    @AfterAll
    static void stop() {
        FAKE.close();
    }

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    private HttpResponse<String> get(String path, String cookie, String bearer) throws Exception {
        var req = HttpRequest.newBuilder(URI.create(path.startsWith("http") ? path : BASE + path)).GET();
        if (cookie != null) req.header("Cookie", cookie);
        if (bearer != null) req.header("Authorization", "Bearer " + bearer);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String cookies(HttpResponse<?> resp) {
        return resp.headers().allValues("set-cookie").stream().map(c -> c.split(";", 2)[0]).collect(Collectors.joining("; "));
    }

    private static String location(HttpResponse<?> resp) {
        return resp.headers().firstValue("location").orElse("");
    }

    /** Drive the code flow like a browser; returns the signed-in session cookie. */
    private String signIn() throws Exception {
        var login = get("/login", null, null);
        assertThat(login.statusCode()).isEqualTo(302);
        String[] codeAndState = FAKE.authorize(location(login));
        var cb = get("/callback?code=" + codeAndState[0] + "&state=" + codeAndState[1], cookies(login), null);
        assertThat(cb.statusCode()).as("the callback completes the code exchange").isEqualTo(302);
        assertThat(location(cb)).endsWith("/profile");
        return cookies(cb);
    }

    @Test
    void loginRedirectsToAuthorizeWithPkceStateAndNonce() throws Exception {
        var resp = get("/login", null, null);
        assertThat(resp.statusCode()).isEqualTo(302);
        var uri = UriComponentsBuilder.fromUriString(location(resp)).build();
        var q = uri.getQueryParams();
        assertThat(uri.getScheme() + "://" + uri.getHost() + ":" + uri.getPort() + uri.getPath())
                .isEqualTo(FAKE.issuer + "/oauth2/authorize");
        assertThat(q.getFirst("response_type")).isEqualTo("code");
        assertThat(q.getFirst("client_id")).isEqualTo(CLIENT_ID);
        assertThat(java.net.URLDecoder.decode(q.getFirst("redirect_uri"), "UTF-8")).isEqualTo(BASE + "/callback");
        assertThat(q.getFirst("code_challenge_method")).isEqualTo("S256");
        assertThat(q.getFirst("code_challenge")).matches("[A-Za-z0-9_-]{43}");
        assertThat(q.getFirst("state")).isNotBlank();
        assertThat(q.getFirst("nonce")).isNotBlank();
        assertThat(resp.headers().allValues("set-cookie")).anySatisfy(c ->
                assertThat(c).containsIgnoringCase("HttpOnly").containsIgnoringCase("SameSite=Lax"));
    }

    @Test
    void theCodeFlowSignsInAndTheProfileShowsTheProtectedApiResult() throws Exception {
        var profile = get("/profile", signIn(), null);
        assertThat(profile.statusCode()).isEqualTo(200);
        assertThat(profile.body()).contains("You are signed in as <strong>ada@example.com</strong>");
        assertThat(profile.body()).containsPattern("id=\"api-result\">[^<]*&quot;client_id&quot;:&quot;" + CLIENT_ID + "&quot;");
    }

    @Test
    void anIdTokenSignedWithRs256IsRefusedAtTheCallback() throws Exception {
        FAKE.idTokenAlg = JWSAlgorithm.RS256;
        try {
            var login = get("/login", null, null);
            String[] codeAndState = FAKE.authorize(location(login));
            var cb = get("/callback?code=" + codeAndState[0] + "&state=" + codeAndState[1], cookies(login), null);
            assertThat(location(cb)).as("sign-in fails back to the login page").contains("/login?error");
        } finally {
            FAKE.idTokenAlg = JWSAlgorithm.ES256;
        }
    }

    @Test
    void aCallbackWithAForeignStateIsRefused() throws Exception {
        var login = get("/login", null, null);
        String[] codeAndState = FAKE.authorize(location(login));
        var cb = get("/callback?code=" + codeAndState[0] + "&state=forged", cookies(login), null);
        assertThat(location(cb)).contains("/login?error");
    }

    @Test
    void theProfileWithoutASessionRedirectsToLogin() throws Exception {
        var resp = get("/profile", null, null);
        assertThat(resp.statusCode()).isEqualTo(302);
        assertThat(location(resp)).endsWith("/login");
    }

    @Test
    void logoutEndsTheSessionThroughTheEndSessionEndpoint() throws Exception {
        String cookie = signIn();
        var profile = get("/profile", cookie, null);
        Matcher m = Pattern.compile("name=\"_csrf\" value=\"([^\"]+)\"").matcher(profile.body());
        assertThat(m.find()).as("the sign-out form carries a CSRF token").isTrue();
        var logout = http.send(HttpRequest.newBuilder(URI.create(BASE + "/logout"))
                .header("Cookie", cookie).header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString("_csrf=" + m.group(1))).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(logout.statusCode()).isEqualTo(302);
        var q = UriComponentsBuilder.fromUriString(location(logout)).build().getQueryParams();
        assertThat(location(logout)).startsWith(FAKE.issuer + "/connect/logout");
        assertThat(q.getFirst("id_token_hint")).isNotBlank();
        assertThat(java.net.URLDecoder.decode(q.getFirst("post_logout_redirect_uri"), "UTF-8")).isEqualTo(BASE + "/signed-out");
        assertThat(get("/profile", cookie, null).statusCode()).as("the old session no longer signs in").isEqualTo(302);
    }

    @Test
    void logoutWithoutTheCsrfTokenIsRefused() throws Exception {
        String cookie = signIn();
        var logout = http.send(HttpRequest.newBuilder(URI.create(BASE + "/logout")).header("Cookie", cookie)
                .POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(logout.statusCode()).isEqualTo(403);
    }

    @Test
    void theApiAcceptsAValidAccessToken() throws Exception {
        var resp = get("/api/me", null, FAKE.validAccessToken());
        assertThat(resp.statusCode()).isEqualTo(200);
        assertThat(resp.body()).contains("\"sub\":\"user-1\"").contains("\"client_id\":\"" + CLIENT_ID + "\"");
    }

    @Test
    void theApiRefusesEveryBadToken() throws Exception {
        var at = new JOSEObjectType("at+jwt");
        var soon = Instant.now().plusSeconds(300);
        var cases = new java.util.LinkedHashMap<String, String>();
        cases.put("no token", null);
        cases.put("RS256", FAKE.accessToken(JWSAlgorithm.RS256, at, FAKE.issuer, List.of(FAKE.issuer), soon, CLIENT_ID));
        cases.put("typ JWT (an ID token)", FAKE.accessToken(JWSAlgorithm.ES256, JOSEObjectType.JWT, FAKE.issuer, List.of(FAKE.issuer), soon, CLIENT_ID));
        cases.put("foreign issuer", FAKE.accessToken(JWSAlgorithm.ES256, at, "https://evil.example", List.of(FAKE.issuer), soon, CLIENT_ID));
        cases.put("foreign audience", FAKE.accessToken(JWSAlgorithm.ES256, at, FAKE.issuer, List.of("https://other.example"), soon, CLIENT_ID));
        cases.put("expired", FAKE.accessToken(JWSAlgorithm.ES256, at, FAKE.issuer, List.of(FAKE.issuer), Instant.now().minusSeconds(600), CLIENT_ID));
        cases.put("another client", FAKE.accessToken(JWSAlgorithm.ES256, at, FAKE.issuer, List.of(FAKE.issuer), soon, "someone-else"));
        cases.put("garbage", "not.a.jwt");
        for (var c : cases.entrySet()) {
            var resp = get("/api/me", null, c.getValue());
            assertThat(resp.statusCode()).as(c.getKey()).isEqualTo(401);
            assertThat(resp.headers().firstValue("www-authenticate").orElse("")).as(c.getKey()).startsWith("Bearer");
        }
    }

    @Test
    void healthAnswersOk() throws Exception {
        assertThat(get("/health", null, null).body()).isEqualTo("ok");
    }
}
