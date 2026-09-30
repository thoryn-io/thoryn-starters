package io.thoryn.starter;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.client.oidc.authentication.OidcIdTokenDecoderFactory;
import org.springframework.security.oauth2.client.oidc.web.logout.OidcClientInitiatedLogoutSuccessHandler;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtDecoderFactory;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import jakarta.servlet.http.HttpServletRequest;

@Configuration
public class SecurityConfig {

    static final String REGISTRATION_ID = "thoryn";

    /** The protected API: Bearer access tokens only, no session, no cookies, so no CSRF surface. */
    @Bean
    @Order(1)
    SecurityFilterChain api(HttpSecurity http, JwtDecoder accessTokenDecoder) throws Exception {
        http.securityMatcher("/api/**")
                .authorizeHttpRequests(a -> a.anyRequest().authenticated())
                .oauth2ResourceServer(rs -> rs.jwt(jwt -> jwt.decoder(accessTokenDecoder)))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .csrf(c -> c.disable());
        return http.build();
    }

    /** The web app: server-side session, sign-in with authorization code + PKCE, RP-initiated logout. */
    @Bean
    @Order(2)
    SecurityFilterChain web(HttpSecurity http, ClientRegistrationRepository registrations, StarterProperties props)
            throws Exception {
        var logout = new OidcClientInitiatedLogoutSuccessHandler(registrations);
        logout.setPostLogoutRedirectUri(props.baseUrl() + "/signed-out");

        http.authorizeHttpRequests(a -> a
                        .requestMatchers("/", "/health", "/signed-out", "/style.css", "/error").permitAll()
                        .anyRequest().authenticated())
                .oauth2Login(o -> o
                        .loginPage("/login")
                        .authorizationEndpoint(e -> e.authorizationRequestResolver(loginResolver(registrations)))
                        .loginProcessingUrl("/callback")
                        .defaultSuccessUrl("/profile", true))
                // POST /logout with the CSRF token (the page's "Sign out" form).
                .logout(l -> l.logoutUrl("/logout").logoutSuccessHandler(logout));
        return http.build();
    }

    /**
     * GET /login starts the authorization request for the single Thoryn registration: PKCE (S256) on top of
     * the state and nonce Spring Security always sends.
     */
    private static OAuth2AuthorizationRequestResolver loginResolver(ClientRegistrationRepository registrations) {
        var delegate = new DefaultOAuth2AuthorizationRequestResolver(registrations, "/oauth2/authorization");
        delegate.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
        return new OAuth2AuthorizationRequestResolver() {
            @Override
            public OAuth2AuthorizationRequest resolve(HttpServletRequest request) {
                return "/login".equals(request.getServletPath()) && "GET".equals(request.getMethod())
                        ? delegate.resolve(request, REGISTRATION_ID)
                        : null;
            }

            @Override
            public OAuth2AuthorizationRequest resolve(HttpServletRequest request, String registrationId) {
                return delegate.resolve(request, registrationId);
            }
        };
    }

    /** ID tokens: the signature must be ES256 (Spring Security's default would expect RS256). */
    @Bean
    JwtDecoderFactory<ClientRegistration> idTokenDecoderFactory() {
        var factory = new OidcIdTokenDecoderFactory();
        factory.setJwsAlgorithmResolver(registration -> SignatureAlgorithm.ES256);
        return factory;
    }

    /**
     * Access tokens for the API (RFC 9068): signature ES256 from the issuer's JWKS, then Spring Security's
     * RFC 9068 validator: header typ {@code at+jwt} (so an ID token is refused), iss, aud, client_id and the
     * exp / iat / sub / jti claims.
     */
    @Bean
    JwtDecoder accessTokenDecoder(StarterProperties props) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withIssuerLocation(props.issuer())
                .jwsAlgorithm(SignatureAlgorithm.ES256)
                .build();
        decoder.setJwtValidator(JwtValidators.createAtJwtValidator()
                .issuer(props.issuer())
                .audience(props.audience())
                .clientId(props.clientId())
                .build());
        return decoder;
    }
}
