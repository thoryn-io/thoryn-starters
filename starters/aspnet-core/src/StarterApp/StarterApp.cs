using System.Net.Http.Headers;
using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Authorization;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace ThorynStarter;

public static class StarterApp
{
    public const string ApiScheme = JwtBearerDefaults.AuthenticationScheme;

    /// <param name="overrides">Extra configuration (tests); real deployments use the environment.</param>
    public static WebApplication Build(string[] args, IDictionary<string, string?>? overrides = null)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.Configuration.AddInMemoryCollection(DotEnv.Read(DotEnv.Find(builder.Environment.ContentRootPath)));
        if (overrides is not null) builder.Configuration.AddInMemoryCollection(overrides);
        var settings = StarterSettings.From(builder.Configuration);
        builder.WebHost.UseUrls(settings.ListenUrl);
        builder.Services.AddSingleton(settings);

        var httpsIssuer = settings.Issuer.StartsWith("https://", StringComparison.Ordinal);
        var cookiePolicy = settings.CookieSecure ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;

        builder.Services.AddMemoryCache();
        builder.Services.AddSingleton<MemoryTicketStore>();
        builder.Services
            .AddAuthentication(o =>
            {
                o.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                o.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            })
            .AddCookie(o =>
            {
                o.Cookie.Name = "starter.session";
                o.Cookie.HttpOnly = true;
                o.Cookie.SameSite = SameSiteMode.Lax;
                o.Cookie.SecurePolicy = cookiePolicy;
                o.LoginPath = "/login";
                o.ExpireTimeSpan = TimeSpan.FromHours(8);
            })
            .AddOpenIdConnect(o =>
            {
                o.Authority = settings.Issuer;
                o.RequireHttpsMetadata = httpsIssuer;
                o.ClientId = settings.ClientId; // public client: no secret, PKCE proves the client
                o.ResponseType = OpenIdConnectResponseType.Code;
                o.ResponseMode = OpenIdConnectResponseMode.Query;
                o.UsePkce = true;
                o.Scope.Clear();
                foreach (var scope in (builder.Configuration["OIDC_SCOPE"] ?? "openid profile email").Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    o.Scope.Add(scope);
                o.CallbackPath = "/callback";
                o.SignedOutCallbackPath = "/signed-out";
                o.SignedOutRedirectUri = "/";
                o.SaveTokens = true; // kept server-side: see MemoryTicketStore
                o.MapInboundClaims = false;
                o.GetClaimsFromUserInfoEndpoint = false;
                o.TokenValidationParameters.NameClaimType = "email";
                o.TokenValidationParameters.ValidAlgorithms = ["ES256"];
                // The correlation and nonce cookies ride the top-level GET back from the issuer (query response mode).
                o.CorrelationCookie.SameSite = SameSiteMode.Lax;
                o.CorrelationCookie.SecurePolicy = cookiePolicy;
                o.NonceCookie.SameSite = SameSiteMode.Lax;
                o.NonceCookie.SecurePolicy = cookiePolicy;
                o.Events.OnRedirectToIdentityProvider = ctx =>
                {
                    // Build the redirect URI from configuration, never from the request's Host header. The
                    // handler records this value for the code redemption after the event.
                    ctx.ProtocolMessage.RedirectUri = settings.BaseUrl + "/callback";
                    return Task.CompletedTask;
                };
                o.Events.OnRedirectToIdentityProviderForSignOut = ctx =>
                {
                    ctx.ProtocolMessage.PostLogoutRedirectUri = settings.BaseUrl + "/signed-out";
                    return Task.CompletedTask;
                };
            })
            // The protected API: OAuth 2.0 JWT access tokens (RFC 9068) issued to this app only.
            .AddJwtBearer(ApiScheme, o =>
            {
                o.Authority = settings.Issuer;
                o.RequireHttpsMetadata = httpsIssuer;
                o.MapInboundClaims = false;
                o.TokenValidationParameters.ValidIssuer = settings.Issuer;
                o.TokenValidationParameters.ValidAudience = settings.Audience;
                o.TokenValidationParameters.ValidAlgorithms = ["ES256"];
                o.TokenValidationParameters.ValidTypes = ["at+jwt"]; // an ID token (typ JWT) is refused
                o.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
                o.Events = new JwtBearerEvents
                {
                    OnTokenValidated = ctx =>
                    {
                        if (ctx.Principal?.FindFirstValue("client_id") != settings.ClientId)
                            ctx.Fail("token was issued to another client");
                        return Task.CompletedTask;
                    },
                };
            });

        builder.Services.AddOptions<CookieAuthenticationOptions>(CookieAuthenticationDefaults.AuthenticationScheme)
            .Configure<MemoryTicketStore>((o, store) => o.SessionStore = store);
        builder.Services.AddAuthorization(o =>
            o.AddPolicy("api", p => p.AddAuthenticationSchemes(ApiScheme).RequireAuthenticatedUser()));
        builder.Services.AddAntiforgery(o =>
        {
            o.Cookie.Name = "starter.af";
            o.Cookie.SameSite = SameSiteMode.Lax;
            o.Cookie.SecurePolicy = cookiePolicy;
        });
        builder.Services.AddHttpClient();

        var app = builder.Build();
        app.UseStaticFiles();
        app.UseAuthentication();
        app.UseAuthorization();

        app.MapGet("/health", () => Results.Text("ok"));

        app.MapGet("/api/me", (ClaimsPrincipal user) => Results.Json(new
        {
            sub = user.FindFirstValue("sub"),
            client_id = user.FindFirstValue("client_id"),
            scope = user.FindFirstValue("scope"),
            iss = user.FindFirstValue("iss"),
            exp = user.FindFirstValue("exp"),
        })).RequireAuthorization("api");

        app.MapGet("/", (ClaimsPrincipal user) => Html(Pages.Home(user.Identity?.IsAuthenticated == true ? Pages.Name(user) : null)));

        app.MapGet("/login", () => Results.Challenge(
            new AuthenticationProperties { RedirectUri = "/profile" },
            [OpenIdConnectDefaults.AuthenticationScheme]));

        app.MapGet("/profile", async (HttpContext ctx, IHttpClientFactory http, IAntiforgery antiforgery) =>
        {
            var accessToken = await ctx.GetTokenAsync("access_token");
            string apiResult;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, settings.BaseUrl + "/api/me");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                using var response = await http.CreateClient().SendAsync(request);
                apiResult = response.IsSuccessStatusCode ? await response.Content.ReadAsStringAsync() : $"HTTP {(int)response.StatusCode}";
            }
            catch (HttpRequestException e)
            {
                apiResult = "the API call failed: " + e.GetType().Name;
            }
            var tokens = antiforgery.GetAndStoreTokens(ctx);
            return Html(Pages.Profile(ctx.User, apiResult, tokens.FormFieldName, tokens.RequestToken!));
        }).RequireAuthorization();

        // RP-initiated logout: end the local session and the session at the issuer. POST + antiforgery token.
        app.MapPost("/logout", async (HttpContext ctx, IAntiforgery antiforgery) =>
        {
            try
            {
                await antiforgery.ValidateRequestAsync(ctx);
            }
            catch (AntiforgeryValidationException)
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }
            // The OpenID Connect handler goes first: it reads the id_token (id_token_hint) from the session
            // before the cookie handler removes that session.
            return Results.SignOut(new AuthenticationProperties { RedirectUri = "/" },
                [OpenIdConnectDefaults.AuthenticationScheme, CookieAuthenticationDefaults.AuthenticationScheme]);
        }).DisableAntiforgery();

        return app;
    }

    private static IResult Html(string html) => Results.Content(html, "text/html; charset=utf-8");
}
