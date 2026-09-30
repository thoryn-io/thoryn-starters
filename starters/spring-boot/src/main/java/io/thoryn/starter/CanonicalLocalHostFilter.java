package io.thoryn.starter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.Set;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Local development: one canonical host. Sign-in keeps its session cookie on the host the browser used, and
 * Thoryn sends the browser back to the configured base URL, so a sign-in started on
 * {@code http://localhost:8080} while the base URL is {@code http://127.0.0.1:8080} would lose its session.
 * When the base URL is a loopback address and a request arrives on ANOTHER loopback host, a GET is sent to
 * the same path and query on the base URL (other methods get 400), so either address simply works.
 *
 * <p>The redirect target is built ONLY from the configured base URL (plus the request's path and query, which
 * cannot change the host); the Host header is only compared, never echoed. A deployed app (a non-loopback
 * base URL) is never redirected, so a proxy that rewrites the Host header cannot cause a redirect loop.
 * Runs before Spring Security, so the session is never touched on the wrong host.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CanonicalLocalHostFilter extends OncePerRequestFilter {

    private static final Set<String> LOOPBACK = Set.of("localhost", "127.0.0.1", "[::1]", "::1");

    private final boolean active;
    private final String origin;
    private final String host;
    private final int port;

    public CanonicalLocalHostFilter(StarterProperties props) {
        URI base = URI.create(props.baseUrl());
        this.host = base.getHost() == null ? "" : base.getHost().toLowerCase();
        this.port = base.getPort() != -1 ? base.getPort() : ("https".equals(base.getScheme()) ? 443 : 80);
        this.origin = base.getScheme() + "://" + base.getRawAuthority();
        this.active = LOOPBACK.contains(this.host);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!active) return true;
        String requestHost = request.getServerName() == null ? "" : request.getServerName().toLowerCase();
        boolean sameHost = requestHost.equals(host) && request.getServerPort() == port;
        return sameHost || !LOOPBACK.contains(requestHost);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod())) {
            response.sendError(HttpServletResponse.SC_BAD_REQUEST, "Use " + origin + ": this app's base URL.");
            return;
        }
        // getRequestURI() is the path ("/…") and the query is appended as-is: the target stays on the origin.
        String query = request.getQueryString();
        response.setStatus(HttpServletResponse.SC_FOUND);
        response.setHeader("Location", origin + request.getRequestURI() + (query == null ? "" : "?" + query));
    }
}
