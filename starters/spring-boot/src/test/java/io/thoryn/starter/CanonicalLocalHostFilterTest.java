package io.thoryn.starter;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class CanonicalLocalHostFilterTest {

    private static MockHttpServletResponse run(String baseUrl, String method, String host, int port, String uri, String query)
            throws Exception {
        var filter = new CanonicalLocalHostFilter(new StarterProperties("http://issuer.test", "client", "", baseUrl));
        var req = new MockHttpServletRequest(method, uri);
        req.setServerName(host);
        req.setServerPort(port);
        req.setQueryString(query);
        var res = new MockHttpServletResponse();
        var chain = new MockFilterChain();
        filter.doFilter(req, res, chain);
        if (chain.getRequest() != null) res.setHeader("X-Passed", "true");
        return res;
    }

    @Test
    void anotherLoopbackHostIsRedirectedToTheSamePathAndQueryOnTheBaseUrl() throws Exception {
        var res = run("http://127.0.0.1:8080", "GET", "localhost", 8080, "/profile", "tab=api");
        assertThat(res.getStatus()).isEqualTo(302);
        assertThat(res.getHeader("Location")).isEqualTo("http://127.0.0.1:8080/profile?tab=api");
        // A path that looks like a host stays on the base URL's origin.
        assertThat(run("http://127.0.0.1:8080", "GET", "localhost", 8080, "//evil.example/x", null).getHeader("Location"))
                .startsWith("http://127.0.0.1:8080/");
        // Another port on the same name is another host.
        assertThat(run("http://127.0.0.1:8080", "GET", "127.0.0.1", 9090, "/", null).getHeader("Location"))
                .isEqualTo("http://127.0.0.1:8080/");
    }

    @Test
    void theBaseHostOtherMethodsAndDeployedAppsAreLeftAlone() throws Exception {
        assertThat(run("http://127.0.0.1:8080", "GET", "127.0.0.1", 8080, "/", null).getHeader("X-Passed")).isEqualTo("true");
        assertThat(run("http://127.0.0.1:8080", "POST", "localhost", 8080, "/logout", null).getStatus()).isEqualTo(400);
        assertThat(run("http://127.0.0.1:8080", "GET", "evil.example", 80, "/", null).getHeader("X-Passed")).isEqualTo("true");
        // A non-loopback base URL (a deployment behind a proxy) never redirects, whatever the Host says.
        assertThat(run("https://app.example.com", "GET", "localhost", 8080, "/", null).getHeader("X-Passed")).isEqualTo("true");
    }
}
